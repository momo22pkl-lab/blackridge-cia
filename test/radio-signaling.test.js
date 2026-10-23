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

function makeUser(id, name, publicCode, secretCode) {
  return {
    id,
    name,
    rank: 'AGENT',
    publicCode,
    secretCode,
    approved: true,
    activeService: true,
    serviceApproved: true,
    identityRequired: false,
    identityApproved: true,
    identity: { fullName: name },
    suspended: false,
    securityStatus: 'ACTIVE',
    online: false,
    radioOnline: false,
    status: 'في الخدمة'
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

async function pollUntil(client, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(client.sessionUrl);
    assert.equal(response.ok, true, 'Socket.IO polling request failed');
    for (const packet of splitPackets(await response.text())) {
      if (packet === '2') {
        await fetch(client.sessionUrl, {
          method: 'POST',
          headers: { 'content-type': 'text/plain;charset=UTF-8' },
          body: '3'
        });
      }
      const match = predicate(packet);
      if (match) return match;
    }
  }
  throw new Error('Timed out waiting for a Socket.IO packet.');
}

async function connectSocket(baseUrl) {
  const handshakeUrl = new URL('/socket.io/', baseUrl);
  handshakeUrl.searchParams.set('EIO', '4');
  handshakeUrl.searchParams.set('transport', 'polling');
  handshakeUrl.searchParams.set('t', String(Date.now()));
  const handshake = await fetch(handshakeUrl);
  assert.equal(handshake.ok, true, 'Socket.IO handshake failed');
  const openPacket = splitPackets(await handshake.text()).find((packet) => packet.startsWith('0'));
  assert.ok(openPacket, 'Socket.IO open packet was missing');
  const engineSid = JSON.parse(openPacket.slice(1)).sid;
  const sessionUrl = new URL('/socket.io/', baseUrl);
  sessionUrl.searchParams.set('EIO', '4');
  sessionUrl.searchParams.set('transport', 'polling');
  sessionUrl.searchParams.set('sid', engineSid);
  const post = (packet) => fetch(sessionUrl, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: packet
  });
  assert.equal((await post('40')).ok, true, 'Socket.IO namespace connect failed');
  const namespacePacket = await pollUntil({ sessionUrl }, (packet) => packet.startsWith('40') ? packet : null);
  const socketId = JSON.parse(namespacePacket.slice(2)).sid;
  let nextAckId = 0;
  const eventQueue = [];

  function rememberEvent(packet) {
    if (!packet.startsWith('42')) return false;
    try {
      eventQueue.push(JSON.parse(packet.slice(2)));
      if (eventQueue.length > 100) eventQueue.shift();
    } catch (_error) {}
    return true;
  }

  return {
    id: socketId,
    sessionUrl,
    async emit(event, payload = {}) {
      const ackId = nextAckId++;
      const sent = await post('42' + ackId + JSON.stringify([event, payload]));
      assert.equal(sent.ok, true, 'Socket.IO event POST failed');
      const packet = await pollUntil(this, (frame) => {
        if (frame.startsWith('42')) { rememberEvent(frame); return null; }
        return frame.startsWith('43' + ackId) ? frame : null;
      });
      const parsed = JSON.parse(packet.slice(('43' + ackId).length));
      return Array.isArray(parsed) ? parsed[0] : parsed;
    },
    async waitFor(event, predicate = () => true, timeoutMs = 6000) {
      const queuedIndex = eventQueue.findIndex((message) => message[0] === event && predicate(message[1]));
      if (queuedIndex >= 0) return eventQueue.splice(queuedIndex, 1)[0][1];
      const packet = await pollUntil(this, (frame) => {
        if (!frame.startsWith('42')) return null;
        const message = JSON.parse(frame.slice(2));
        if (message[0] === event && predicate(message[1])) return message[1];
        eventQueue.push(message);
        if (eventQueue.length > 100) eventQueue.shift();
        return null;
      }, timeoutMs);
      return packet;
    },
    async close() {
      try { await post('41'); } catch (_error) {}
    }
  };
}

test('radio signaling relays to every same-channel listener and survives channel switch/rejoin', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackridge-radio-signaling-'));
  const stateFile = path.join(tempDir, 'state.json');
  const port = await freePort();
  const testUsers = [
    makeUser('radio-speaker', 'Radio Speaker', 'RAD-101', '8101'),
    makeUser('radio-listener-a', 'Listener Alpha', 'RAD-102', '8102'),
    makeUser('radio-listener-b', 'Listener Bravo', 'RAD-103', '8103'),
    makeUser('radio-switcher', 'Channel Switcher', 'RAD-201', '8201')
  ];
  fs.writeFileSync(stateFile, JSON.stringify({ cia_users: testUsers }), 'utf8');

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
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
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
  const policyResponse = await fetch(baseUrl + '/radio-signal-policy.js');
  assert.equal(policyResponse.ok, true, 'the browser signal policy must be served by the explicit public-asset route');
  assert.match(await policyResponse.text(), /canHandleSignalWithoutPeer/);
  const audioHealthResponse = await fetch(baseUrl + '/radio-audio-health.js');
  assert.equal(audioHealthResponse.ok, true, 'the browser audio-health helper must be served by the explicit public-asset route');
  assert.match(await audioHealthResponse.text(), /NO_MEDIA_SAMPLE_LIMIT/);

  async function login(name, code, resumeService = false) {
    const client = await connectSocket(baseUrl);
    clients.push(client);
    const result = await client.emit('auth:login', { name, code, resumeService });
    assert.equal(result.ok, true, 'local radio test login failed: ' + JSON.stringify(result));
    const duty = await client.emit('duty:start', {});
    assert.equal(duty.ok, true, 'local radio test could not start service: ' + JSON.stringify(duty));
    return client;
  }

  const speaker = await login('Radio Speaker', '8101');
  const listenerA = await login('Listener Alpha', '8102');
  const listenerB = await login('Listener Bravo', '8103');
  const switcher = await login('Channel Switcher', '8201');

  for (const client of [speaker, listenerA, listenerB]) {
    const joined = await client.emit('radio:join', { channel: 'CH-1' });
    assert.equal(joined.ok, true);
  }
  assert.equal((await switcher.emit('radio:join', { channel: 'CH-2' })).ok, true);

  const started = await speaker.emit('radio:ptt:start', { channel: 'CH-1' });
  assert.equal(started.ok, true, 'same-channel speaker was not granted PTT: ' + JSON.stringify(started));
  assert.deepEqual(new Set(started.peers), new Set([listenerA.id, listenerB.id]));
  assert.equal(started.peers.includes(switcher.id), false, 'another channel was included in the listener list');
  await listenerA.waitFor('radio:state', (event) => event.channel === 'CH-1' && event.ptt === true && event.socketId === speaker.id);
  await listenerB.waitFor('radio:state', (event) => event.channel === 'CH-1' && event.ptt === true && event.socketId === speaker.id);

  const offer = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
  const candidate = { candidate: 'candidate:1 1 UDP 2122260223 192.0.2.10 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  for (const listener of [listenerA, listenerB]) {
    assert.equal((await speaker.emit('radio:voice:signal', {
      channel: 'CH-1', to: listener.id, type: 'ice', candidate
    })).ok, true);
    const relayedCandidate = await listener.waitFor('radio:voice:signal', (event) => event.from === speaker.id && event.type === 'ice');
    assert.equal(relayedCandidate.channel, 'CH-1');
    assert.equal((await speaker.emit('radio:voice:signal', {
      channel: 'CH-1', to: listener.id, type: 'offer', sdp: offer
    })).ok, true);
    const relayedOffer = await listener.waitFor('radio:voice:signal', (event) => event.from === speaker.id && event.type === 'offer');
    assert.equal(relayedOffer.sdp.type, 'offer');
  }

  const deniedCrossChannelSignal = await switcher.emit('radio:voice:signal', {
    channel: 'CH-1', to: listenerA.id, type: 'ice', candidate
  });
  assert.equal(deniedCrossChannelSignal.ok, false, 'server accepted a signal from a different channel');

  assert.equal((await switcher.emit('radio:setChannel', { channel: 'CH-1' })).ok, true);
  const peerAnnouncement = await speaker.waitFor('radio:voice:peer', (event) => event.channel === 'CH-1' && event.peerId === switcher.id);
  assert.equal(peerAnnouncement.peerId, switcher.id, 'active speaker was not notified when a same-channel listener joined');
  assert.equal((await speaker.emit('radio:voice:signal', {
    channel: 'CH-1', to: switcher.id, type: 'offer', sdp: offer
  })).ok, true);
  await switcher.waitFor('radio:voice:signal', (event) => event.from === speaker.id && event.type === 'offer');

  assert.equal((await speaker.emit('radio:ptt:stop', { channel: 'CH-1' })).ok, true);
  await listenerA.waitFor('radio:state', (event) => event.channel === 'CH-1' && event.ptt === false && event.socketId === speaker.id);

  const restarted = await speaker.emit('radio:ptt:start', { channel: 'CH-1' });
  assert.equal(restarted.ok, true, 'speaker could not start a second transmission');
  assert.equal(restarted.peers.length, 3, 'second transmission did not include every eligible listener');
  assert.equal((await speaker.emit('radio:ptt:stop', { channel: 'CH-1' })).ok, true);

  await listenerA.close();
  await speaker.waitFor('radio:voice:peer-left', (event) => event.socketId === listenerA.id);
  const reconnected = await login('Listener Alpha', '8102', true);
  assert.equal((await reconnected.emit('radio:join', { channel: 'CH-1' })).ok, true);
  const persistedReconnected = JSON.parse(fs.readFileSync(stateFile, 'utf8')).cia_users.find((user) => user.id === 'radio-listener-a');
  assert.equal(persistedReconnected.activeService, true);
  assert.equal(persistedReconnected.radioOnline, true);
  assert.equal(persistedReconnected.radioChannel, 'CH-1');
  const afterReconnect = await speaker.emit('radio:ptt:start', { channel: 'CH-1' });
  assert.equal(afterReconnect.ok, true, 'radio did not recover after a listener reconnected');
  assert.ok(afterReconnect.peers.includes(reconnected.id), 'reconnected user was not included as a same-channel listener: ' + JSON.stringify({ expected: reconnected.id, peers: afterReconnect.peers }));
  assert.equal(afterReconnect.peers.includes(listenerA.id), false, 'the disconnected phone remained in the listener list');
  assert.equal((await speaker.emit('radio:ptt:stop', { channel: 'CH-1' })).ok, true);

  const secondDevice = await login('Listener Alpha', '8102', true);
  assert.equal((await secondDevice.emit('radio:join', { channel: 'TAC-1' })).ok, true);
  assert.equal((await secondDevice.emit('radio:text', { channel: 'CH-1', text: 'cross-channel test' })).ok, false);
  assert.equal((await secondDevice.emit('radio:code', { channel: 'CH-1', code: '10-4', meaning: 'cross-channel test' })).ok, false);
  const separateChannelTransmission = await speaker.emit('radio:ptt:start', { channel: 'CH-1' });
  assert.equal(separateChannelTransmission.ok, true);
  assert.ok(separateChannelTransmission.peers.includes(reconnected.id), 'first phone lost its independent channel membership');
  assert.equal(separateChannelTransmission.peers.includes(secondDevice.id), false, 'same account on another channel received cross-channel radio');
  assert.equal((await speaker.emit('radio:ptt:stop', { channel: 'CH-1' })).ok, true);

  assert.equal((await reconnected.emit('radio:leave', { channel: 'CH-1' })).ok, true);
  const afterSingleDeviceLeave = JSON.parse(fs.readFileSync(stateFile, 'utf8')).cia_users.find((user) => user.id === 'radio-listener-a');
  assert.equal(afterSingleDeviceLeave.activeService, true, 'turning off one radio changed the account service state');
  assert.equal(afterSingleDeviceLeave.radioOnline, true, 'turning off one radio marked the other phone offline');
  assert.equal(afterSingleDeviceLeave.radioChannel, 'TAC-1');

  assert.equal((await switcher.emit('radio:setChannel', { channel: 'TAC-1' })).ok, true);
  const secondPhoneTransmission = await switcher.emit('radio:ptt:start', { channel: 'TAC-1' });
  assert.equal(secondPhoneTransmission.ok, true);
  assert.ok(secondPhoneTransmission.peers.includes(secondDevice.id), 'the second phone could not receive after the first phone turned its radio off');
  assert.equal(secondPhoneTransmission.peers.includes(reconnected.id), false);
  assert.equal((await switcher.emit('radio:ptt:stop', { channel: 'TAC-1' })).ok, true);

  assert.equal((await reconnected.emit('duty:end', {})).ok, true);
  await secondDevice.waitFor('radio:service-ended');
  const afterServiceEnd = JSON.parse(fs.readFileSync(stateFile, 'utf8')).cia_users.find((user) => user.id === 'radio-listener-a');
  assert.equal(afterServiceEnd.activeService, false);
  assert.equal(afterServiceEnd.radioOnline, false);
  assert.equal((await secondDevice.emit('radio:leave', { channel: 'TAC-1' })).ok, true, 'ending service disconnected the other phone instead of stopping its radio');
  const unaffectedUserTransmission = await switcher.emit('radio:ptt:start', { channel: 'TAC-1' });
  assert.equal(unaffectedUserTransmission.ok, true, 'ending one account service disconnected a different user on that channel');
  assert.equal(unaffectedUserTransmission.peers.includes(secondDevice.id), false, 'service-ended phone remained in the channel');
  assert.equal((await switcher.emit('radio:ptt:stop', { channel: 'TAC-1' })).ok, true);
});
