'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

const projectRoot = path.resolve(__dirname, '..');
const serverPath = path.join(projectRoot, 'server.js');

function makeUser(id, name, rank, publicCode, secretCode, extra = {}) {
  return {
    id,
    name,
    rank,
    publicCode,
    secretCode,
    approved: true,
    activeService: false,
    serviceApproved: true,
    identityRequired: false,
    identityApproved: true,
    identity: { fullName: name },
    suspended: false,
    securityStatus: 'ACTIVE',
    online: false,
    status: 'خارج الخدمة',
    ...extra
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function splitPackets(body) {
  return String(body || '').split('\x1e').filter(Boolean);
}

async function pollUntil(baseUrl, sid, predicate, timeoutMs = 6000) {
  const url = new URL('/socket.io/', baseUrl);
  url.searchParams.set('EIO', '4');
  url.searchParams.set('transport', 'polling');
  url.searchParams.set('sid', sid);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    assert.equal(response.ok, true, 'Socket.IO polling request failed');
    const packets = splitPackets(await response.text());
    for (const packet of packets) {
      if (packet === '2') {
        await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: '3' });
      }
      const match = predicate(packet);
      if (match) return match;
    }
  }
  throw new Error('Timed out while waiting for a Socket.IO acknowledgement.');
}

async function connectPollingSocket(baseUrl) {
  const handshakeUrl = new URL('/socket.io/', baseUrl);
  handshakeUrl.searchParams.set('EIO', '4');
  handshakeUrl.searchParams.set('transport', 'polling');
  handshakeUrl.searchParams.set('t', String(Date.now()));
  const handshake = await fetch(handshakeUrl);
  assert.equal(handshake.ok, true, 'Socket.IO handshake failed');
  const openPacket = splitPackets(await handshake.text()).find((packet) => packet.startsWith('0'));
  assert.ok(openPacket, 'Socket.IO open packet was missing');
  const sid = JSON.parse(openPacket.slice(1)).sid;
  assert.ok(sid, 'Socket.IO session id was missing');

  const sessionUrl = new URL('/socket.io/', baseUrl);
  sessionUrl.searchParams.set('EIO', '4');
  sessionUrl.searchParams.set('transport', 'polling');
  sessionUrl.searchParams.set('sid', sid);
  const post = (packet) => fetch(sessionUrl, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: packet
  });
  const namespaceConnect = await post('40');
  assert.equal(namespaceConnect.ok, true, 'Socket.IO namespace connect failed');
  await pollUntil(baseUrl, sid, (packet) => packet.startsWith('40') ? packet : null);

  let nextAckId = 0;
  return {
    async emit(event, payload = {}) {
      const ackId = nextAckId++;
      const sent = await post('42' + ackId + JSON.stringify([event, payload]));
      assert.equal(sent.ok, true, 'Socket.IO event POST failed');
      const packet = await pollUntil(baseUrl, sid, (frame) => frame.startsWith('43' + ackId) ? frame : null);
      const parsed = JSON.parse(packet.slice(('43' + ackId).length));
      return Array.isArray(parsed) ? parsed[0] : parsed;
    },
    async close() {
      try { await post('41'); } catch (_error) {}
    }
  };
}

test('personnel directory enforces server scope, persists create/edit, and keeps linked records intact', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackridge-personnel-'));
  const stateFile = path.join(tempDir, 'state.json');
  const port = await freePort();
  const seedState = {
    cia_users: [
      makeUser('chief-1', 'Chief Test', 'CIA CHIEF', 'CHIEF-001', '1101'),
      makeUser('senior-1', 'Senior Test', 'SUPREME COMMANDER', 'SEN-001', '1105'),
      makeUser('alpha-1', 'Alpha Member', 'AGENT', 'AG-101', '1102', { bank: { balance: 70, militaryCodeLinked: true }, bankAccount: 'AG-101' }),
      makeUser('alpha-2', 'Second Alpha', 'AGENT', 'AG-102', '1103', { bank: { balance: 25, militaryCodeLinked: true }, bankAccount: 'AG-102' }),
      makeUser('bravo-1', 'Bravo Member', 'AGENT', 'AG-201', '1104')
    ],
    cia_battalions: [
      { id: 'unit-alpha', code: 'ALPHA', nameAr: 'Alpha Battalion', nameEn: 'Alpha Battalion', status: 'ACTIVE', commanderCode: 'AG-101', memberCodes: ['AG-101', 'AG-102'] },
      { id: 'unit-bravo', code: 'BRAVO', nameAr: 'Bravo Battalion', nameEn: 'Bravo Battalion', status: 'ACTIVE', commanderCode: 'AG-201', memberCodes: ['AG-201'] },
      { id: 'unit-archive', code: 'ARCHIVE', nameAr: 'Archived Alpha', status: 'ARCHIVED', memberCodes: ['AG-102'] }
    ],
    ibp_operations: [
      { id: 'op-alpha', status: 'ACTIVE', commanderCode: 'AG-101', memberCodes: ['AG-102'] },
      { id: 'op-closed', status: 'COMPLETE', memberCodes: ['AG-102'] }
    ],
    ibp_deployments: [
      { id: 'deployment-alpha', status: 'ACTIVE', assignedCodes: ['AG-102'] },
      { id: 'deployment-closed', status: 'ARCHIVED', assignedCodes: ['AG-102'] }
    ],
    cia_cases: [{ id: 'case-alpha', assignedCode: 'AG-102' }],
    cia_map_locations: { 'AG-102': { x: 22, y: 31 } }
  };
  fs.writeFileSync(stateFile, JSON.stringify(seedState), 'utf8');

  let serverOutput = '';
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      CIA_DATA_FILE: stateFile,
      RENDER: 'false',
      RENDER_SERVICE_ID: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2500).unref();
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('BLACK RIDGE server exited early:\n' + serverOutput);
    try {
      const response = await fetch(baseUrl + '/');
      if (response.ok) { ready = true; break; }
    } catch (_error) {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.equal(ready, true, 'BLACK RIDGE server did not start:\n' + serverOutput);

  const chief = await connectPollingSocket(baseUrl);
  const login = await chief.emit('auth:login', { name: 'Chief Test', code: '1101' });
  assert.equal(login.ok, true, 'leadership test login failed: ' + JSON.stringify(login));

  const leaderList = await chief.emit('ibp:directory:list', {});
  assert.equal(leaderList.ok, true);
  assert.equal(leaderList.people.length, 5);
  assert.equal(leaderList.people.find((person) => person.publicCode === 'AG-101').name, 'Alpha Member');
  assert.equal(leaderList.viewer.name, 'Chief Test');
  assert.equal(leaderList.permissions.canAdd, true);
  assert.deepEqual(leaderList.rankOptions, ['AGENT', 'HIGH COMMANDER', 'SUPREME COMMANDER']);
  assert.equal(leaderList.people.find((person) => person.publicCode === 'AG-102').canEditSalary, true);

  const chiefDetail = await chief.emit('ibp:directory:detail', { id: 'chief-1' });
  assert.equal(chiefDetail.ok, true);
  assert.equal(chiefDetail.person.canViewSalary, true);
  assert.equal(chiefDetail.person.canEditSalary, false, 'a user cannot edit their own personnel record');
  assert.equal(chiefDetail.person.canEditBattalion, false, 'self-assignment is managed through battalion command, not the personnel editor');

  const bankSalaryUpdate = await chief.emit('bank:setSalary', { publicCode: 'AG-102', salary: 725 });
  assert.equal(bankSalaryUpdate.ok, true, 'CIA Chief should be able to set an individual salary');
  assert.equal(bankSalaryUpdate.salary, 725);

  const createResponse = await chief.emit('ibp:directory:save', {
    mode: 'create',
    name: 'New Recruit',
    rank: 'AGENT',
    battalionId: 'unit-alpha'
  });
  assert.equal(createResponse.ok, true, 'authorized personnel creation failed: ' + JSON.stringify(createResponse));
  assert.match(createResponse.person.publicCode, /^AG-\d{3}$/);
  assert.match(createResponse.temporarySecretCode, /^\d{4}$/);
  assert.equal(Object.hasOwn(createResponse.person, 'secretCode'), false, 'the roster response must not expose a stored login secret');
  assert.equal(createResponse.person.statusLabel, 'PENDING APPROVAL');

  let savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const createdUser = savedState.cia_users.find((person) => person.publicCode === createResponse.person.publicCode);
  assert.ok(createdUser, 'new personnel record was not persisted');
  assert.equal(createdUser.secretCode, createResponse.temporarySecretCode);
  assert.ok(savedState.cia_battalions[0].memberCodes.includes(createResponse.person.publicCode));

  const member = await connectPollingSocket(baseUrl);
  const memberLogin = await member.emit('auth:login', { name: 'Alpha Member', code: '1102' });
  assert.equal(memberLogin.ok, true);
  const memberList = await member.emit('ibp:directory:list', {});
  assert.equal(memberList.ok, true);
  assert.deepEqual(memberList.people.map((person) => person.publicCode).sort(), ['AG-101', 'AG-102', createResponse.person.publicCode].sort());
  assert.equal(memberList.people.find((person) => person.publicCode === 'AG-102').name, '');
  assert.equal(memberList.people.find((person) => person.publicCode === 'AG-102').salary, null);
  assert.equal(memberList.people.find((person) => person.publicCode === 'AG-102').canEditSalary, false);
  assert.equal(memberList.viewer.name, '', 'non-leaders must not receive a name in viewer metadata');
  assert.equal(memberList.people.find((person) => person.publicCode === 'AG-101').name, '', 'a member must not see their own name in the personnel directory');
  const selfDetail = await member.emit('ibp:directory:detail', { id: 'alpha-1' });
  assert.equal(selfDetail.ok, true);
  assert.equal(selfDetail.person.name, '', 'self-detail must keep the name private outside CIA Chief');
  const forbiddenDetail = await member.emit('ibp:directory:detail', { id: 'bravo-1' });
  assert.equal(forbiddenDetail.ok, false);
  const forbiddenCreate = await member.emit('ibp:directory:save', { mode: 'create', name: 'Unauthorized Recruit', rank: 'AGENT' });
  assert.equal(forbiddenCreate.ok, false);
  const forbiddenEdit = await member.emit('ibp:directory:save', { id: 'alpha-2', rank: 'HIGH COMMANDER' });
  assert.equal(forbiddenEdit.ok, false);

  const senior = await connectPollingSocket(baseUrl);
  const seniorLogin = await senior.emit('auth:login', { name: 'Senior Test', code: '1105' });
  assert.equal(seniorLogin.ok, true);
  const seniorSalaryEdit = await senior.emit('bank:setSalary', { publicCode: 'AG-102', salary: 9999 });
  assert.equal(seniorSalaryEdit.ok, false, 'non-chief command must not set an individual salary');
  const seniorDirectorySalaryEdit = await senior.emit('ibp:directory:save', { id: 'alpha-2', salary: 9999 });
  assert.equal(seniorDirectorySalaryEdit.ok, false);
  assert.match(seniorDirectorySalaryEdit.message, /CIA CHIEF/);
  const seniorList = await senior.emit('ibp:directory:list', {});
  assert.equal(seniorList.people.find((person) => person.publicCode === 'AG-102').salary, null);

  const detailResponse = await chief.emit('ibp:directory:detail', { id: 'alpha-2' });
  assert.equal(detailResponse.ok, true);
  assert.equal(detailResponse.person.name, 'Second Alpha');
  assert.equal(detailResponse.person.canEditCode, true);
  assert.equal(detailResponse.person.salary, 725);
  assert.equal(detailResponse.person.canEditSalary, true);

  const invalidEdit = await chief.emit('ibp:directory:save', {
    mode: 'edit',
    id: 'alpha-2',
    name: 'Must Roll Back',
    rank: 'HIGH COMMANDER',
    publicCode: 'BAD CODE'
  });
  assert.equal(invalidEdit.ok, false);
  savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(savedState.cia_users.find((person) => person.id === 'alpha-2').name, 'Second Alpha');
  assert.equal(savedState.cia_users.find((person) => person.id === 'alpha-2').rank, 'AGENT');

  const editResponse = await chief.emit('ibp:directory:save', {
    mode: 'edit',
    id: 'alpha-2',
    name: 'Second Alpha Updated',
    rank: 'HIGH COMMANDER',
    publicCode: 'AG-777',
    battalionId: 'unit-bravo',
    salary: 810
  });
  assert.equal(editResponse.ok, true, 'authorized personnel edit failed: ' + JSON.stringify(editResponse));
  assert.equal(editResponse.person.publicCode, 'AG-777');
  assert.equal(editResponse.person.rank, 'HIGH COMMANDER');
  assert.equal(editResponse.person.salary, 810);
  savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const updatedUser = savedState.cia_users.find((person) => person.id === 'alpha-2');
  assert.equal(updatedUser.name, 'Second Alpha Updated');
  assert.equal(updatedUser.bankAccount, 'AG-777');
  assert.equal(updatedUser.bank.salary, 810);
  assert.equal(savedState.cia_battalions[0].memberCodes.includes('AG-777'), false);
  assert.ok(savedState.cia_battalions[1].memberCodes.includes('AG-777'));
  assert.equal(savedState.cia_battalions[0].memberCodes.includes('AG-102'), false);
  assert.deepEqual(savedState.cia_battalions[2].memberCodes, ['AG-102'], 'archived battalion membership remains historical');
  assert.deepEqual(savedState.ibp_operations[0].memberCodes, ['AG-777']);
  assert.deepEqual(savedState.ibp_operations[1].memberCodes, ['AG-102'], 'completed operation membership remains historical');
  assert.deepEqual(savedState.ibp_deployments[0].assignedCodes, ['AG-777']);
  assert.deepEqual(savedState.ibp_deployments[1].assignedCodes, ['AG-102'], 'archived deployment assignments remain historical');
  assert.equal(savedState.cia_cases[0].assignedCode, 'AG-777');
  assert.equal(savedState.cia_map_locations['AG-777'].x, 22);
  assert.equal(Object.hasOwn(savedState.cia_map_locations, 'AG-102'), false);

  await member.close();
  await senior.close();
  await chief.close();
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /ibp:directory:list/);
  assert.match(html, /ibp:directory:detail/);
  assert.match(html, /ibp:directory:save/);
  assert.match(html, /name="salary"/);
  assert.doesNotMatch(html, /AG-217|AG-104|AG-332|AG-276/);
});
