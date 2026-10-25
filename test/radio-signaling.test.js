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

function makeUser(id, name, publicCode, secretCode, rank = 'AGENT') {
  return {
    id,
    name,
    rank,
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

test('radio signaling supports concurrent talkers, resumes an open duty record, and reconnects', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackridge-radio-signaling-'));
  const stateFile = path.join(tempDir, 'state.json');
  const port = await freePort();
  const testUsers = [
    makeUser('radio-speaker', 'Radio Speaker', 'RAD-101', '8101'),
    makeUser('radio-listener-a', 'Listener Alpha', 'RAD-102', '8102'),
    makeUser('radio-listener-b', 'Listener Bravo', 'RAD-103', '8103'),
    makeUser('radio-switcher', 'Channel Switcher', 'RAD-201', '8201'),
    makeUser('radio-chief', 'Radio Chief', 'CHIEF-001', '8401', 'CIA CHIEF')
  ];
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(stateFile, JSON.stringify({
    cia_users: testUsers,
    cia_custom_radio_channels: [
      { id: 'CUSTOM:103.6', label: '103.6', createdAt: new Date().toISOString() }
    ],
    cia_attendance: [{
      id: 'DUTY-EXISTING-SPEAKER',
      userId: 'radio-speaker',
      userCode: 'RAD-101',
      userName: 'Radio Speaker',
      dayKey: today,
      startedAt: new Date().toISOString(),
      endedAt: null,
      salaryPaid: false
    }]
  }), 'utf8');

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
    if (!resumeService) {
      const offDutyJoin = await client.emit('radio:join', { channel: 'CH-1' });
      assert.equal(offDutyJoin.ok, false, 'radio join must remain blocked before duty starts');
      assert.match(offDutyJoin.message, /يجب بدء المناوبة قبل تشغيل الراديو/);
      const offDutyPtt = await client.emit('radio:ptt:start', { channel: 'CH-1' });
      assert.equal(offDutyPtt.ok, false, 'PTT must remain blocked before duty starts');
      assert.match(offDutyPtt.message, /يجب بدء المناوبة قبل إرسال الصوت/);
    }
    const duty = await client.emit('duty:start', {});
    assert.equal(duty.ok, true, 'local radio test could not start service: ' + JSON.stringify(duty));
    assert.equal(duty.user?.activeService, true, 'duty start did not return authoritative active-service state');
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

  const secondTalker = await listenerA.emit('radio:ptt:start', { channel: 'CH-1' });
  assert.equal(secondTalker.ok, true, 'a second same-channel participant was denied simultaneous PTT');
  assert.deepEqual(new Set(secondTalker.peers), new Set([speaker.id, listenerB.id, switcher.id]));
  await speaker.waitFor('radio:state', (event) => event.channel === 'CH-1' && event.ptt === true && event.socketId === listenerA.id);
  await listenerB.waitFor('radio:state', (event) => event.channel === 'CH-1' && event.ptt === true && event.socketId === listenerA.id);

  const secondTalkerOffer = await listenerA.emit('radio:voice:signal', {
    channel: 'CH-1', to: speaker.id, type: 'offer', sdp: offer
  });
  assert.equal(secondTalkerOffer.ok, true, 'the second talker could not send audio signaling to the first talker');
  await speaker.waitFor('radio:voice:signal', (event) => event.from === listenerA.id && event.type === 'offer');

  const simultaneousOffer = await speaker.emit('radio:voice:signal', {
    channel: 'CH-1', to: listenerA.id, type: 'offer', sdp: offer
  });
  assert.equal(simultaneousOffer.ok, true, 'the first talker could not signal back while the second was transmitting');
  await listenerA.waitFor('radio:voice:signal', (event) => event.from === speaker.id && event.type === 'offer');
  const simultaneousAnswer = await speaker.emit('radio:voice:signal', {
    channel: 'CH-1', to: listenerA.id, type: 'answer', sdp: { ...offer, type: 'answer' }
  });
  assert.equal(simultaneousAnswer.ok, true, 'a peer could not send the WebRTC answer while both participants were active');
  await listenerA.waitFor('radio:voice:signal', (event) => event.from === speaker.id && event.type === 'answer');

  const thirdTalker = await listenerB.emit('radio:ptt:start', { channel: 'CH-1' });
  assert.equal(thirdTalker.ok, true, 'a third same-channel participant was denied PTT');
  assert.deepEqual(new Set(thirdTalker.peers), new Set([speaker.id, listenerA.id, switcher.id]));
  await speaker.waitFor('radio:state', (event) => event.channel === 'CH-1' && event.ptt === true && event.socketId === listenerB.id);
  await listenerA.waitFor('radio:state', (event) => event.channel === 'CH-1' && event.ptt === true && event.socketId === listenerB.id);

  assert.equal((await speaker.emit('radio:ptt:stop', { channel: 'CH-1' })).ok, true);
  await listenerA.waitFor('radio:state', (event) => event.channel === 'CH-1' && event.ptt === false && event.socketId === speaker.id);
  await listenerB.waitFor('radio:state', (event) => event.channel === 'CH-1' && event.ptt === false && event.socketId === speaker.id);
  const remainingTalkersSignal = await listenerA.emit('radio:voice:signal', {
    channel: 'CH-1', to: listenerB.id, type: 'offer', sdp: offer
  });
  assert.equal(remainingTalkersSignal.ok, true, 'one participant stopping PTT interrupted signaling between the other talkers');
  await listenerB.waitFor('radio:voice:signal', (event) => event.from === listenerA.id && event.type === 'offer');

  assert.equal((await listenerA.emit('radio:ptt:stop', { channel: 'CH-1' })).ok, true);
  await listenerB.waitFor('radio:state', (event) => event.channel === 'CH-1' && event.ptt === false && event.socketId === listenerA.id);
  const thirdTalkerContinues = await listenerB.emit('radio:voice:signal', {
    channel: 'CH-1', to: speaker.id, type: 'offer', sdp: offer
  });
  assert.equal(thirdTalkerContinues.ok, true, 'stopping the second talker interrupted the third talker');
  await speaker.waitFor('radio:voice:signal', (event) => event.from === listenerB.id && event.type === 'offer');
  assert.equal((await listenerB.emit('radio:ptt:stop', { channel: 'CH-1' })).ok, true);

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

  const chief = await login('Radio Chief', '8401');
  const initialAdminList = await chief.emit('radio:admin:subscribe', {});
  assert.equal(initialAdminList.ok, true, 'CIA CHIEF must be able to subscribe to the radio monitor');
  assert.deepEqual(
    initialAdminList.channels.filter((channel) => channel.type === 'main').map((channel) => channel.id).sort(),
    ['CH-1', 'CH-3', 'TAC-1']
  );
  assert.equal(initialAdminList.channels.find((channel) => channel.name === '103.6').accessMode, 'open', 'legacy custom waves must stay open when no access mode was saved');
  const deniedAdminList = await speaker.emit('radio:admin:subscribe', {});
  assert.equal(deniedAdminList.ok, false, 'ordinary members must not access the server-authorized monitor');
  assert.equal(deniedAdminList.channels, undefined, 'denied monitor requests must not return channel data');

  const privateJoinA = await speaker.emit('radio:join', { channel: '103.6' });
  assert.equal(privateJoinA.ok, true);
  assert.equal(privateJoinA.channel, 'CUSTOM:103.6');
  assert.equal(privateJoinA.channelLabel, '103.6');
  await chief.waitFor('radio:admin:state', (payload) =>
    payload.channels.some((channel) => channel.name === '103.6' && channel.memberCount === 1)
  );

  const privateJoinB = await listenerB.emit('radio:join', { channel: '103.6' });
  assert.equal(privateJoinB.ok, true);
  assert.equal(privateJoinB.channel, privateJoinA.channel, 'the same private value must resolve to the same channel');
  const privateAdminState = await chief.waitFor('radio:admin:state', (payload) =>
    payload.channels.some((channel) => channel.name === '103.6' && channel.memberCount === 2)
  );
  const privateAdminWave = privateAdminState.channels.find((channel) => channel.name === '103.6');
  assert.equal(privateAdminWave.type, 'custom');
  assert.equal(privateAdminWave.accessMode, 'open', 'new custom waves must be open by default');
  assert.ok(privateAdminWave.eligibleMembers.some((member) => member.id === 'radio-listener-b'));
  assert.deepEqual(new Set(privateAdminWave.members.map((member) => member.publicCode)), new Set(['RAD-101', 'RAD-103']));
  assert.ok(privateAdminWave.members.every((member) => member.name && member.connectionStatus === 'متصل'));
  const persistedCustomChannels = JSON.parse(fs.readFileSync(stateFile, 'utf8')).cia_custom_radio_channels;
  assert.ok(persistedCustomChannels.some((channel) => channel.id === privateJoinA.channel && channel.label === '103.6'));

  const ordinarySnapshot = await listenerB.waitFor('state:update', (snapshot) =>
    Array.isArray(snapshot.cia_users) && snapshot.cia_users.some((user) =>
      user.id === 'radio-speaker' && user.radioChannel === null && user.radioOnline === false
    )
  );
  const hiddenPeer = ordinarySnapshot.cia_users.find((user) => user.id === 'radio-speaker');
  assert.equal(hiddenPeer.radioChannel, null, 'ordinary state snapshots must not reveal a custom channel name');
  assert.equal(hiddenPeer.radioOnline, false, 'ordinary state snapshots must not reveal custom-wave presence');
  assert.equal(Object.hasOwn(ordinarySnapshot, 'cia_custom_radio_channels'), false, 'ordinary snapshots must not include the custom channel registry');

  const separatePrivateJoin = await switcher.emit('radio:join', { channel: '111' });
  assert.equal(separatePrivateJoin.ok, true);
  assert.equal(separatePrivateJoin.channel, 'CUSTOM:111');
  const newlyCreatedWave = await chief.waitFor('radio:admin:state', (payload) =>
    payload.channels.some((channel) => channel.name === '111' && channel.memberCount === 1)
  );
  assert.equal(newlyCreatedWave.channels.find((channel) => channel.name === '111').accessMode, 'open');
  const sameWaveTransmission = await speaker.emit('radio:ptt:start', { channel: privateJoinA.channel });
  assert.equal(sameWaveTransmission.ok, true);
  assert.deepEqual(sameWaveTransmission.peers, [listenerB.id]);
  const customOffer = { type: 'offer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
  assert.equal((await speaker.emit('radio:voice:signal', {
    channel: privateJoinA.channel, to: listenerB.id, type: 'offer', sdp: customOffer
  })).ok, true);
  await listenerB.waitFor('radio:voice:signal', (event) => event.from === speaker.id && event.channel === privateJoinA.channel);
  assert.equal((await switcher.emit('radio:voice:signal', {
    channel: privateJoinA.channel, to: listenerB.id, type: 'offer', sdp: customOffer
  })).ok, false, 'a member on a different wave must not signal into the private wave');
  assert.equal((await speaker.emit('radio:text', {
    channel: privateJoinA.channel, text: 'Private wave test'
  })).ok, true);
  await listenerB.waitFor('radio:text', (event) => event.channel === privateJoinA.channel && event.text === 'Private wave test');
  await assert.rejects(
    switcher.waitFor('radio:text', (event) => event.channel === privateJoinA.channel, 200),
    /Timed out waiting/
  );
  assert.equal((await speaker.emit('radio:ptt:stop', { channel: privateJoinA.channel })).ok, true);

  assert.equal((await speaker.emit('radio:join', { channel: '' })).ok, false, 'empty channel values must be rejected');
  assert.equal((await speaker.emit('radio:join', { channel: 'x'.repeat(44) })).ok, false, 'overlong channel values must be rejected');
  assert.equal((await speaker.emit('radio:join', { channel: 'bad\u0000name' })).ok, false, 'control characters must be rejected');
  assert.equal((await speaker.emit('radio:join', { channel: 'bad\nname' })).ok, false, 'line breaks must not be normalized into a wave name');

  assert.equal((await listenerB.emit('radio:leave', { channel: privateJoinA.channel })).ok, true);
  const oneMemberState = await chief.waitFor('radio:admin:state', (payload) =>
    payload.channels.some((channel) => channel.name === '103.6' && channel.memberCount === 1)
  );
  assert.equal(oneMemberState.channels.find((channel) => channel.name === '103.6').members[0].publicCode, 'RAD-101');

  await listenerB.close();
  const reconnectedPrivateMember = await login('Listener Bravo', '8103', true);
  const privateReconnect = await reconnectedPrivateMember.emit('radio:join', {});
  assert.equal(privateReconnect.ok, true, 'a disconnected member must be able to rejoin the saved private wave');
  assert.equal(privateReconnect.channel, privateJoinA.channel);
  await chief.waitFor('radio:admin:state', (payload) =>
    payload.channels.some((channel) => channel.name === '103.6' && channel.memberCount === 2)
  );
  await reconnectedPrivateMember.close();
  const disconnectedAdminState = await chief.waitFor('radio:admin:state', (payload) =>
    payload.channels.some((channel) => channel.name === '103.6' && channel.memberCount === 1)
  );
  assert.equal(disconnectedAdminState.channels.find((channel) => channel.name === '103.6').members[0].publicCode, 'RAD-101');

  const deniedAllowlistUpdate = await speaker.emit('radio:admin:update-allowlist', {
    channel: privateJoinA.channel, userId: 'radio-listener-b', action: 'add'
  });
  assert.equal(deniedAllowlistUpdate.ok, false, 'ordinary members must not edit a custom-wave allowlist');
  assert.equal((await speaker.emit('radio:admin:set-access-mode', {
    channel: privateJoinA.channel, mode: 'restricted'
  })).ok, false, 'ordinary members must not change custom-wave access mode');

  const addAllowedMember = await chief.emit('radio:admin:update-allowlist', {
    channel: privateJoinA.channel, userId: 'radio-listener-b', action: 'add'
  });
  assert.equal(addAllowedMember.ok, true);
  assert.equal(addAllowedMember.accessMode, 'restricted', 'adding a member must enable allowlist enforcement');
  const restrictedAfterAdd = await chief.waitFor('radio:admin:state', (payload) =>
    payload.channels.some((channel) => channel.name === '103.6' && channel.accessMode === 'restricted' && channel.memberCount === 0)
  );
  assert.deepEqual(restrictedAfterAdd.channels.find((channel) => channel.name === '103.6').allowedMembers.map((member) => member.id), ['radio-listener-b']);

  assert.equal((await speaker.emit('radio:join', { channel: privateJoinA.channel })).ok, false, 'unlisted users must be denied by radio:join');
  assert.equal((await speaker.emit('radio:setChannel', { channel: privateJoinA.channel })).ok, false, 'radio:setChannel must enforce the same allowlist');
  const rejoinedAllowedMember = await login('Listener Bravo', '8103', true);
  assert.equal((await rejoinedAllowedMember.emit('radio:join', { channel: privateJoinA.channel })).ok, true, 'an allowed user must be able to join');
  assert.equal((await switcher.emit('radio:join', { channel: privateJoinA.channel })).ok, false, 'a different member must not enter a restricted wave');
  assert.equal((await speaker.emit('radio:ptt:start', { channel: privateJoinA.channel })).ok, false, 'an ejected user must not start PTT');
  assert.equal((await speaker.emit('radio:voice:signal', {
    channel: privateJoinA.channel, to: rejoinedAllowedMember.id, type: 'offer', sdp: customOffer
  })).ok, false, 'an ejected user must not signal into the restricted wave');

  const removeAllowedMember = await chief.emit('radio:admin:update-allowlist', {
    channel: privateJoinA.channel, userId: 'radio-listener-b', action: 'remove'
  });
  assert.equal(removeAllowedMember.ok, true);
  const restrictedAfterRemove = await chief.waitFor('radio:admin:state', (payload) =>
    payload.channels.some((channel) => channel.name === '103.6' && channel.accessMode === 'restricted' && channel.memberCount === 0)
  );
  assert.deepEqual(restrictedAfterRemove.channels.find((channel) => channel.name === '103.6').allowedMembers, []);
  assert.equal((await rejoinedAllowedMember.emit('radio:join', { channel: privateJoinA.channel })).ok, false, 'removing an allowed member must revoke existing access');
  assert.equal((await rejoinedAllowedMember.emit('radio:text', { channel: privateJoinA.channel, text: 'should be blocked' })).ok, false);

  const reopenWave = await chief.emit('radio:admin:set-access-mode', {
    channel: privateJoinA.channel, mode: 'open'
  });
  assert.equal(reopenWave.ok, true);
  assert.equal(reopenWave.accessMode, 'open');
  assert.equal((await speaker.emit('radio:join', { channel: privateJoinA.channel })).ok, true, 'an open wave must accept members again');
});
