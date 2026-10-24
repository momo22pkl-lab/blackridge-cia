'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const chromiumPath = process.env.CHROMIUM_PATH || [
  '/repl/tools/bin/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome'
].find((candidate) => fs.existsSync(candidate));
const skipReason = process.env.BLACKRIDGE_BROWSER_E2E !== '1'
  ? 'Set BLACKRIDGE_BROWSER_E2E=1 to run the resource-intensive real-browser WebRTC test.'
  : !chromiumPath
  ? 'Chromium is not installed; set CHROMIUM_PATH to run the browser WebRTC test.'
  : typeof WebSocket !== 'function'
    ? 'This Node.js runtime does not provide the WebSocket API required for CDP.'
    : false;

function makeUser(id, name, publicCode, secretCode) {
  return {
    id,
    name,
    rank: 'AGENT',
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
    radioOnline: false,
    status: 'خارج الخدمة'
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

class DevToolsPage {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (_error) {
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await this.command('Page.enable');
    await this.command('Runtime.enable');
    return this;
  }

  command(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, 15000);
      timeout.unref();
    });
  }

  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  close() {
    try { this.socket.close(); } catch (_error) {}
  }
}

async function waitFor(page, expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await page.evaluate(expression);
      if (lastValue) return lastValue;
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

async function launchBrowser(debugPort, appUrl, profilePath) {
  const process = spawn(chromiumPath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profilePath}`,
    'about:blank'
  ], { stdio: 'ignore' });

  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error('Chromium exited before opening its DevTools endpoint.');
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch (_error) {}
    await sleep(200);
  }
  if (!ready) throw new Error('Chromium DevTools endpoint did not become ready.');

  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
  if (!response.ok) throw new Error(`Could not create a Chromium page (${response.status}).`);
  const target = await response.json();
  const page = new DevToolsPage(target.webSocketDebuggerUrl);
  await page.connect();
  await page.command('Page.navigate', { url: appUrl });
  await waitFor(page, 'typeof ciaSocket !== "undefined" && ciaSocket && ciaSocket.connected', 'Socket.IO connection', 25000);
  return { page, process };
}

async function authenticateAndJoin(page, name, code) {
  const result = await page.evaluate(
    `new Promise(resolve => ciaSocket.emit('auth:login', { name: ${JSON.stringify(name)}, code: ${JSON.stringify(code)} }, resolve))`
  );
  assert.equal(result && result.ok, true, `local test login failed for ${name}`);
  await waitFor(page, `currentUser && currentUser.name === ${JSON.stringify(name)}`, `authenticated user ${name}`);
  await page.evaluate('startDuty(); true');
  await waitFor(page, 'currentUser && currentUser.activeService === true', `duty start for ${name}`);
  await page.evaluate('toggleRadioPower(); true');
  await waitFor(page, 'radioJoinConfirmed === true', `confirmed radio join for ${name}`);
}

async function getAudioStats(page) {
  return page.evaluate(`(async () => {
    const rows = [];
    for (const [peerId, peer] of radioVoicePeers) {
      const reports = await peer.pc.getStats();
      const row = { peerId, connectionState: peer.pc.connectionState, signalingState: peer.pc.signalingState,
        inboundPackets: 0, inboundBytes: 0, outboundPackets: 0, outboundBytes: 0 };
      for (const report of reports.values()) {
        if ((report.kind || report.mediaType) !== 'audio') continue;
        if (report.type === 'inbound-rtp') {
          row.inboundPackets += report.packetsReceived || 0;
          row.inboundBytes += report.bytesReceived || 0;
        } else if (report.type === 'outbound-rtp') {
          row.outboundPackets += report.packetsSent || 0;
          row.outboundBytes += report.bytesSent || 0;
        }
      }
      rows.push(row);
    }
    return { active: radioPTTActive, peers: rows };
  })()`);
}

function sum(stats, key) {
  return stats.peers.reduce((total, peer) => total + peer[key], 0);
}

async function measureRtp(pageA, pageB, label) {
  const beforeA = await getAudioStats(pageA);
  const beforeB = await getAudioStats(pageB);
  await sleep(1500);
  const afterA = await getAudioStats(pageA);
  const afterB = await getAudioStats(pageB);
  return {
    label,
    a: {
      active: afterA.active,
      peers: afterA.peers,
      inboundDelta: sum(afterA, 'inboundPackets') - sum(beforeA, 'inboundPackets'),
      outboundDelta: sum(afterA, 'outboundPackets') - sum(beforeA, 'outboundPackets')
    },
    b: {
      active: afterB.active,
      peers: afterB.peers,
      inboundDelta: sum(afterB, 'inboundPackets') - sum(beforeB, 'inboundPackets'),
      outboundDelta: sum(afterB, 'outboundPackets') - sum(beforeB, 'outboundPackets')
    }
  };
}

test('real browser WebRTC keeps both radio talkers transmitting through overlap, release, and rapid PTT', {
  skip: skipReason
}, async (t) => {
  const projectRoot = path.resolve(__dirname, '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackridge-radio-webrtc-'));
  const stateFile = path.join(tempDir, 'state.json');
  const port = await freePort();
  const users = [
    makeUser('browser-radio-a', 'Browser Radio Alpha', 'BRT-A', 'browser-test-a'),
    makeUser('browser-radio-b', 'Browser Radio Bravo', 'BRT-B', 'browser-test-b')
  ];
  fs.writeFileSync(stateFile, JSON.stringify({ cia_users: users }), 'utf8');

  let serverOutput = '';
  const server = spawn(process.execPath, [path.join(projectRoot, 'server.js')], {
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
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

  const browsers = [];
  const pages = [];
  t.after(async () => {
    pages.forEach((page) => page.close());
    browsers.forEach((browser) => {
      try { browser.kill('SIGTERM'); } catch (_error) {}
    });
    try { server.kill('SIGTERM'); } catch (_error) {}
    await new Promise((resolve) => {
      if (server.exitCode !== null) return resolve();
      server.once('exit', resolve);
      setTimeout(resolve, 2500).unref();
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const appUrl = `http://127.0.0.1:${port}/`;
  const serverDeadline = Date.now() + 20000;
  let serverReady = false;
  while (Date.now() < serverDeadline) {
    if (server.exitCode !== null) throw new Error(`Local server exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        serverReady = true;
        break;
      }
    } catch (_error) {}
    await sleep(100);
  }
  assert.equal(serverReady, true, `Local server did not start:\n${serverOutput}`);

  const a = await launchBrowser(await freePort(), appUrl, path.join(tempDir, 'chrome-a'));
  const b = await launchBrowser(await freePort(), appUrl, path.join(tempDir, 'chrome-b'));
  browsers.push(a.process, b.process);
  pages.push(a.page, b.page);
  await authenticateAndJoin(a.page, 'Browser Radio Alpha', 'browser-test-a');
  await authenticateAndJoin(b.page, 'Browser Radio Bravo', 'browser-test-b');

  await a.page.evaluate('startPTT(); true');
  await waitFor(a.page, 'radioPTTActive === true', 'A starting PTT');
  await sleep(1000);
  await b.page.evaluate('startPTT(); true');
  await waitFor(b.page, 'radioPTTActive === true', 'B starting simultaneous PTT');
  await sleep(1000);

  const simultaneous = await measureRtp(a.page, b.page, 'both-talk');
  assert.ok(simultaneous.a.outboundDelta > 0, 'A sent no outbound audio RTP while both users talked');
  assert.ok(simultaneous.b.inboundDelta > 0, 'B received no audio RTP from A while both users talked');
  assert.ok(simultaneous.b.outboundDelta > 0, 'B sent no outbound audio RTP while both users talked');
  assert.ok(simultaneous.a.inboundDelta > 0, 'A received no audio RTP from B while both users talked');

  await a.page.evaluate('stopPTT(); true');
  await waitFor(a.page, 'radioPTTActive === false', 'A releasing PTT');
  const bContinues = await measureRtp(a.page, b.page, 'A-stopped-B-continues');
  assert.ok(bContinues.b.outboundDelta > 0, 'B transmit stopped when A released PTT');
  assert.ok(bContinues.a.inboundDelta > 0, 'A stopped receiving B after releasing local PTT');

  await a.page.evaluate('startPTT(); true');
  await waitFor(a.page, 'radioPTTActive === true', 'A immediate PTT restart');
  const restarted = await measureRtp(a.page, b.page, 'A-immediate-restart');
  assert.ok(restarted.a.outboundDelta > 0 && restarted.b.inboundDelta > 0, 'A did not resume sending after release');
  assert.ok(restarted.b.outboundDelta > 0 && restarted.a.inboundDelta > 0, 'B audio stopped after A resumed sending');

  await a.page.evaluate('stopPTT(); startPTT(); stopPTT(); startPTT(); true');
  await waitFor(a.page, 'radioPTTActive === true', 'rapid PTT sequence settling', 20000);
  const rapid = await measureRtp(a.page, b.page, 'rapid-toggle');
  assert.ok(rapid.a.outboundDelta > 0 && rapid.b.inboundDelta > 0, 'A could not transmit after rapid PTT toggles');
  assert.ok(rapid.b.outboundDelta > 0 && rapid.a.inboundDelta > 0, 'B could not transmit after rapid PTT toggles');
});
