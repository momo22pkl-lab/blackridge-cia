'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const {
  normalizeSocialAccounts,
  normalizeSocialContactName,
  createManualSocialAccount,
  createDiscordSocialAccount,
  upsertSocialAccount,
  findDuplicateSocialAccountOwner
} = require('../social-accounts');

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

function seedState() {
  return {
    cia_users: [
      makeUser('chief-1', 'Chief Test', 'CIA CHIEF', 'CHIEF-001', '1101'),
      makeUser('senior-1', 'Senior Test', 'SUPREME COMMANDER', 'SC-001', '1102', {
        socialAccounts: [{
          id: 'manual-senior-profile',
          provider: 'manual',
          platform: 'Telegram',
          username: 'senior_test',
          profileUrl: 'https://t.me/senior_test',
          verified: false,
          verificationMethod: 'manual',
          linkedAt: '2026-10-22T12:00:00.000Z'
        }]
      }),
      makeUser('high-1', 'High Test', 'HIGH COMMANDER', 'HC-001', '1103'),
      makeUser('member-1', 'Member One', 'AGENT', 'AG-101', '1104'),
      makeUser('member-2', 'Member Two', 'AGENT', 'AG-102', '1105')
    ]
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

function parseSocketEvent(packet) {
  if (!String(packet).startsWith('42')) return null;
  try {
    const payload = JSON.parse(String(packet).slice(2));
    if (!Array.isArray(payload) || typeof payload[0] !== 'string') return null;
    return { name: payload[0], data: payload[1] };
  } catch (_error) {
    return null;
  }
}

async function pollUntil(baseUrl, sid, predicate, captureEvent, timeoutMs = 6000) {
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
      const event = parseSocketEvent(packet);
      if (event && captureEvent) captureEvent(event);
      const match = predicate(packet, event);
      if (match) return match;
    }
  }
  throw new Error('Timed out while waiting for a Socket.IO response.');
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
  const events = [];
  const captureEvent = (event) => events.push(event);
  await pollUntil(baseUrl, sid, (packet) => packet.startsWith('40') ? packet : null, captureEvent);

  let nextAckId = 0;
  return {
    events,
    async emit(event, payload = {}) {
      const ackId = nextAckId++;
      const sent = await post('42' + ackId + JSON.stringify([event, payload]));
      assert.equal(sent.ok, true, 'Socket.IO event POST failed');
      const packet = await pollUntil(baseUrl, sid, (frame) => frame.startsWith('43' + ackId) ? frame : null, captureEvent);
      const parsed = JSON.parse(packet.slice(('43' + ackId).length));
      return Array.isArray(parsed) ? parsed[0] : parsed;
    },
    async waitForEvent(name, timeoutMs = 6000) {
      const existingIndex = events.findIndex((event) => event.name === name);
      if (existingIndex >= 0) return events.splice(existingIndex, 1)[0].data;
      return pollUntil(baseUrl, sid, (_packet, event) => {
        const index = events.findIndex((queued) => queued.name === name);
        return index >= 0 ? events.splice(index, 1)[0].data : null;
      }, captureEvent, timeoutMs);
    },
    async close() {
      try { await post('41'); } catch (_error) {}
    }
  };
}

async function startTestServer(t, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackridge-social-'));
  const stateFile = path.join(tempDir, 'state.json');
  const port = await freePort();
  fs.writeFileSync(stateFile, JSON.stringify(options.state || seedState()), 'utf8');

  const env = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: '',
    CIA_DATA_FILE: stateFile,
    RENDER: 'false',
    RENDER_SERVICE_ID: '',
    DISCORD_CLIENT_ID: '',
    DISCORD_CLIENT_SECRET: '',
    DISCORD_REDIRECT_URI: '',
    ...(options.env || {})
  };

  if (options.mockDiscord) {
    const mockFetchPath = path.join(tempDir, 'mock-discord-fetch.cjs');
    fs.writeFileSync(mockFetchPath, [
      "'use strict';",
      'const originalFetch = globalThis.fetch;',
      'globalThis.fetch = async function(input, init) {',
      '  const url = typeof input === "string" ? input : input && input.url;',
      '  if (url === "https://discord.com/api/oauth2/token") {',
      '    return new Response(JSON.stringify({ access_token: "test-only-access-token", token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });',
      '  }',
      '  if (url === "https://discord.com/api/users/@me") {',
      '    return new Response(JSON.stringify({ id: "123456789012345678", username: "raven_test", global_name: "Raven Test", avatar: "avatar_hash_1" }), { status: 200, headers: { "content-type": "application/json" } });',
      '  }',
      '  return originalFetch(input, init);',
      '};'
    ].join('\n'), 'utf8');
    env.NODE_OPTIONS = '--require=' + mockFetchPath;
    env.DISCORD_CLIENT_ID = 'test-discord-client-id';
    env.DISCORD_CLIENT_SECRET = 'test-only-oauth-client-secret';
    env.DISCORD_REDIRECT_URI = `http://127.0.0.1:${port}/auth/discord/callback`;
  }

  let serverOutput = '';
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env,
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

  const baseUrl = `http://127.0.0.1:${port}`;
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
  return { baseUrl, stateFile, child };
}

async function login(socket, name, code) {
  const result = await socket.emit('auth:login', { name, code });
  assert.equal(result.ok, true, 'test login failed: ' + JSON.stringify(result));
  return result.user;
}

test('social account normalization preserves only safe, unverified manual metadata', () => {
  const manual = createManualSocialAccount({
    platform: 'X',
    username: 'sample_member',
    profileUrl: 'https://x.com/sample_member?utm_source=test#profile'
  }, '2026-10-22T12:00:00.000Z');
  const normalized = normalizeSocialAccounts([{
    ...manual,
    verified: true,
    accessToken: 'must-not-survive'
  }, {
    provider: 'manual',
    platform: 'Discord',
    username: 'fake',
    profileUrl: 'https://discord.com/users/123456789012345678',
    verified: true
  }, {
    provider: 'unknown',
    platform: 'Example',
    username: 'x',
    profileUrl: 'https://example.com/x'
  }]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].verified, false);
  assert.equal(normalized[0].verificationMethod, 'manual');
  assert.equal(normalized[0].profileUrl, 'https://x.com/sample_member?utm_source=test');
  assert.equal(Object.hasOwn(normalized[0], 'accessToken'), false);
  assert.throws(() => createManualSocialAccount({
    platform: 'Discord',
    username: 'fake',
    profileUrl: 'https://discord.com/users/123456789012345678'
  }), /Discord/);
  assert.throws(() => createManualSocialAccount({
    platform: 'Example',
    username: 'x',
    profileUrl: 'javascript:alert(1)'
  }), /رابط/);
});

test('social contact names are trimmed, normalized, and length-limited', () => {
  assert.equal(normalizeSocialContactName('  Raven   North  '), 'Raven North');
  assert.equal(normalizeSocialContactName('  '), '');
  assert.equal(normalizeSocialContactName('x'.repeat(120)).length, 100);
});

test('Discord and manual external account identities are unique across member records', () => {
  const discord = createDiscordSocialAccount({
    id: '123456789012345678',
    username: 'raven',
    global_name: 'Raven',
    avatar: 'avatar_hash'
  }, '2026-10-22T12:00:00.000Z');
  const discordOwner = { id: 'member-1', socialAccounts: [discord] };
  assert.equal(findDuplicateSocialAccountOwner([discordOwner], discord, 'member-2')?.id, 'member-1');
  assert.equal(findDuplicateSocialAccountOwner([discordOwner], discord, 'member-1'), null);

  const manual = createManualSocialAccount({
    platform: 'Instagram',
    username: 'raven',
    profileUrl: 'https://www.instagram.com/raven/'
  });
  const manualOwner = { id: 'member-1', socialAccounts: [manual] };
  const sameManualIdentity = createManualSocialAccount({
    platform: 'Other label',
    username: 'raven',
    profileUrl: 'https://www.instagram.com/raven'
  });
  assert.equal(findDuplicateSocialAccountOwner([manualOwner], sameManualIdentity, 'member-2')?.id, 'member-1');
});

test('existing members link and unlink manual accounts without changing membership identity or leaking to peers', async (t) => {
  const { baseUrl, stateFile } = await startTestServer(t);
  const member = await connectPollingSocket(baseUrl);
  const loginUser = await login(member, 'Member One', '1104');
  assert.deepEqual(loginUser.socialAccounts, []);
  assert.equal(loginUser.socialContactName, '', 'legacy member records default to an empty optional contact name');
  const original = JSON.parse(fs.readFileSync(stateFile, 'utf8')).cia_users.find((user) => user.id === 'member-1');

  const manual = await member.emit('social:accounts:manual', {
    platform: 'Instagram',
    username: 'member_one',
    profileUrl: 'https://www.instagram.com/member_one/'
  });
  assert.equal(manual.ok, true);
  assert.equal(manual.socialAccounts[0].verified, false);
  assert.equal(manual.socialAccounts[0].verificationMethod, 'manual');

  const savedContactName = await member.emit('social:contact-name:save', {
    socialContactName: '  Raven   Member  '
  });
  assert.equal(savedContactName.ok, true);
  assert.equal(savedContactName.socialContactName, 'Raven Member');
  const memberProfileAfterSave = await member.emit('auth:me', {});
  assert.equal(memberProfileAfterSave.user.socialContactName, 'Raven Member', 'the member profile returns the saved value to its owner');

  let saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const updated = saved.cia_users.find((user) => user.id === 'member-1');
  assert.equal(saved.cia_users.length, 5, 'linking must not create another member account');
  assert.equal(updated.id, original.id);
  assert.equal(updated.publicCode, original.publicCode);
  assert.equal(updated.rank, original.rank);
  assert.equal(updated.secretCode, original.secretCode);
  assert.equal(updated.socialAccounts.length, 1);
  assert.equal(updated.socialContactName, 'Raven Member', 'contact name is persisted on the existing member record');

  const peer = await connectPollingSocket(baseUrl);
  await login(peer, 'Member Two', '1105');
  const peerSnapshot = await peer.waitForEvent('state:update');
  const peerViewOfMember = peerSnapshot.cia_users.find((user) => user.id === 'member-1');
  assert.equal(Object.hasOwn(peerViewOfMember, 'socialAccounts'), false, 'unauthorized member snapshots must omit contact details');
  assert.equal(Object.hasOwn(peerViewOfMember, 'socialContactName'), false, 'unauthorized member snapshots must omit the fallback contact name');

  const attemptedTargetWrite = await peer.emit('social:contact-name:save', {
    memberId: 'member-1',
    socialContactName: 'Impersonated'
  });
  assert.equal(attemptedTargetWrite.ok, true, 'the save endpoint accepts only the authenticated member and ignores target IDs');
  saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.cia_users.find((user) => user.id === 'member-1').socialContactName, 'Raven Member');
  assert.equal(saved.cia_users.find((user) => user.id === 'member-2').socialContactName, 'Impersonated');

  const duplicate = await peer.emit('social:accounts:manual', {
    platform: 'Instagram',
    username: 'member_one',
    profileUrl: 'https://www.instagram.com/member_one'
  });
  assert.equal(duplicate.ok, false, 'one external profile URL cannot be assigned to multiple members');
  const unauthorizedRemove = await peer.emit('social:accounts:remove', { accountId: manual.socialAccounts[0].id });
  assert.equal(unauthorizedRemove.ok, false, 'a member cannot unlink another member account');

  const highCommander = await connectPollingSocket(baseUrl);
  await login(highCommander, 'High Test', '1103');
  const highSnapshot = await highCommander.waitForEvent('state:update');
  const scopedAgent = highSnapshot.cia_users.find((user) => user.id === 'member-1');
  assert.equal(scopedAgent.socialAccounts[0].username, 'member_one', 'authorized high commander sees an Agent account');
  assert.equal(scopedAgent.socialContactName, 'Raven Member', 'authorized high commander sees the fallback contact name');
  const protectedSenior = highSnapshot.cia_users.find((user) => user.id === 'senior-1');
  assert.equal(Object.hasOwn(protectedSenior, 'socialAccounts'), false, 'high commander must not see accounts outside management scope');
  assert.equal(Object.hasOwn(protectedSenior, 'socialContactName'), false, 'high commander must not see names outside management scope');

  const chief = await connectPollingSocket(baseUrl);
  await login(chief, 'Chief Test', '1101');
  const chiefSnapshot = await chief.waitForEvent('state:update');
  assert.equal(chiefSnapshot.cia_users.find((user) => user.id === 'member-1').socialAccounts[0].platform, 'Instagram');
  assert.equal(chiefSnapshot.cia_users.find((user) => user.id === 'member-1').socialContactName, 'Raven Member');

  const removed = await member.emit('social:accounts:remove', { accountId: manual.socialAccounts[0].id });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.socialAccounts, []);
  saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(saved.cia_users.find((user) => user.id === 'member-1').socialAccounts, []);
  assert.equal(saved.cia_users.find((user) => user.id === 'member-1').socialContactName, 'Raven Member', 'contact name remains independent from optional social account links');

  await Promise.all([member.close(), peer.close(), highCommander.close(), chief.close()]);
});

test('Discord OAuth2 links only the verified provider identity and never persists bearer tokens', async (t) => {
  const { baseUrl, stateFile } = await startTestServer(t, { mockDiscord: true });
  const member = await connectPollingSocket(baseUrl);
  await login(member, 'Member One', '1104');

  const started = await member.emit('social:discord:start', {});
  assert.equal(started.ok, true);
  const authorizationUrl = new URL(started.authorizationUrl);
  assert.equal(authorizationUrl.origin, 'https://discord.com');
  assert.equal(authorizationUrl.pathname, '/oauth2/authorize');
  assert.equal(authorizationUrl.searchParams.get('scope'), 'identify');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorizationUrl.searchParams.get('state'));
  assert.equal(authorizationUrl.searchParams.has('code_verifier'), false);

  const callbackUrl = new URL('/auth/discord/callback', baseUrl);
  callbackUrl.searchParams.set('code', 'mock-code');
  callbackUrl.searchParams.set('state', authorizationUrl.searchParams.get('state'));
  const callback = await fetch(callbackUrl);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /تم ربط حساب Discord بنجاح/);

  const linked = await member.emit('auth:me', {});
  assert.equal(linked.ok, true);
  assert.equal(linked.user.socialAccounts.length, 1);
  assert.equal(linked.user.socialAccounts[0].provider, 'discord');
  assert.equal(linked.user.socialAccounts[0].username, 'Raven Test');
  assert.equal(linked.user.socialAccounts[0].verified, true);
  assert.equal(linked.user.socialAccounts[0].profileUrl, 'https://discord.com/users/123456789012345678');
  assert.match(linked.user.socialAccounts[0].avatarUrl, /^https:\/\/cdn\.discordapp\.com\/avatars\//);
  assert.doesNotMatch(fs.readFileSync(stateFile, 'utf8'), /test-only-access-token/);
  assert.doesNotMatch(fs.readFileSync(stateFile, 'utf8'), /test-only-oauth-client-secret/);

  const secondMember = await connectPollingSocket(baseUrl);
  await login(secondMember, 'Member Two', '1105');
  const secondStart = await secondMember.emit('social:discord:start', {});
  assert.equal(secondStart.ok, true);
  const secondState = new URL(secondStart.authorizationUrl).searchParams.get('state');
  const duplicateCallbackUrl = new URL('/auth/discord/callback', baseUrl);
  duplicateCallbackUrl.searchParams.set('code', 'mock-code');
  duplicateCallbackUrl.searchParams.set('state', secondState);
  const duplicateCallback = await fetch(duplicateCallbackUrl);
  assert.equal(duplicateCallback.status, 200);
  assert.match(await duplicateCallback.text(), /مرتبط بعضوية أخرى بالفعل/);

  const secondProfile = await secondMember.emit('auth:me', {});
  assert.deepEqual(secondProfile.user.socialAccounts, []);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.cia_users.filter((user) => user.socialAccounts?.some((account) => account.provider === 'discord')).length, 1);
  await Promise.all([member.close(), secondMember.close()]);
});

test('Discord linking returns a clear setup message when server OAuth settings are absent', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const member = await connectPollingSocket(baseUrl);
  await login(member, 'Member One', '1104');
  const result = await member.emit('social:discord:start', {});
  assert.equal(result.ok, false);
  assert.match(result.message, /DISCORD_CLIENT_ID/);
  await member.close();
});
