'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const {
  CREATE_TABLE_SQL,
  INDEX_SQL,
  normalizePushEndpoint,
  normalizePushSubscription,
  WebPushStore
} = require('../mobile-push-store');
const {
  BROADCAST_INTERVAL_MS,
  createWebPushTransport,
  injectMobilePushMarkup,
  registerMobilePushSocket,
  sectorMembers,
  sectorOptions,
  sendBatched
} = require('../mobile-push');

const projectRoot = path.resolve(__dirname, '..');
const serverPath = path.join(projectRoot, 'server.js');

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

function subscription(endpoint = 'https://fcm.googleapis.com/push/send/device-a', overrides = {}) {
  return {
    endpoint,
    expirationTime: 1900000000000,
    keys: { p256dh: 'valid-public-key_123', auth: 'valid-auth-key_123' },
    ...overrides
  };
}

function person(id, publicCode, extra = {}) {
  return {
    id,
    publicCode,
    approved: true,
    serviceApproved: true,
    suspended: false,
    securityStatus: 'ACTIVE',
    ...extra
  };
}

function mockSocket() {
  const handlers = new Map();
  return {
    handlers,
    on(name, handler) { handlers.set(name, handler); },
    async call(name, payload = {}) {
      const handler = handlers.get(name);
      assert.equal(typeof handler, 'function', `missing ${name} handler`);
      return new Promise((resolve) => handler(payload, resolve));
    }
  };
}

test('push manifest metadata is injected once without changing the underlying app HTML', () => {
  const source = '<!doctype html><html><head><title>Test</title></head><body><main>App</main></body></html>';
  const injected = injectMobilePushMarkup(source);
  assert.match(injected, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(injected, /apple-mobile-web-app-capable/);
  assert.match(injected, /src="\/mobile-push-client\.js"/);
  assert.equal(injectMobilePushMarkup(injected), injected);
  assert.equal(injectMobilePushMarkup('<html>incomplete</html>'), '<html>incomplete</html>');
});

test('push endpoints are HTTPS push-service URLs and invalid subscriptions are rejected', () => {
  assert.equal(normalizePushEndpoint('https://fcm.googleapis.com/push/send/device-a'), 'https://fcm.googleapis.com/push/send/device-a');
  assert.equal(normalizePushEndpoint('http://fcm.googleapis.com/push/send/device-a'), '');
  assert.equal(normalizePushEndpoint('https://127.0.0.1/push'), '');
  assert.equal(normalizePushEndpoint('https://attacker.example/fetch'), '');
  assert.equal(normalizePushEndpoint('https://user:pass@fcm.googleapis.com/push/send/a'), '');
  assert.ok(normalizePushSubscription(subscription()));
  assert.equal(normalizePushSubscription(subscription('https://attacker.example/steal')), null);
  assert.equal(normalizePushSubscription(subscription(undefined, { keys: { p256dh: '', auth: '' } })), null);
});

test('memory subscriptions stay private to their user and the same browser endpoint has one owner', async () => {
  let rows = [];
  const store = new WebPushStore(null, {
    getRows: () => rows,
    setRows: async (next) => { rows = next; }
  });
  await store.saveSubscription('member-a', subscription());
  await store.saveSubscription('member-b', subscription());

  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, 'member-b');
  assert.deepEqual((await store.listForUsers(['member-a'])), []);
  const memberB = await store.listForUsers(['member-b']);
  assert.equal(memberB.length, 1);
  assert.equal(memberB[0].subscription.keys.auth, 'valid-auth-key_123');
  assert.equal(await store.removeSubscription('member-a', subscription().endpoint), false);
  assert.equal(await store.removeSubscription('member-b', subscription().endpoint), true);
  assert.deepEqual(rows, []);
});

test('PostgreSQL subscriptions use a separate table and owner-scoped delete and lookup queries', async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT user_id')) {
        return { rows: [{
          user_id: 'member-a',
          endpoint: 'https://fcm.googleapis.com/push/send/device-a',
          p256dh: 'valid-public-key_123',
          auth_key: 'valid-auth-key_123',
          expiration_time: '1900000000000'
        }] };
      }
      if (sql.startsWith('DELETE')) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    }
  };
  const store = new WebPushStore(pool);
  await store.initialize();
  await store.saveSubscription('member-a', subscription());
  const result = await store.listForUsers(['member-a']);
  assert.equal(result.length, 1);
  assert.equal(result[0].userId, 'member-a');
  assert.equal(await store.removeSubscription('member-a', subscription().endpoint), true);
  assert.match(CREATE_TABLE_SQL, /CREATE TABLE IF NOT EXISTS web_push_subscriptions/);
  assert.ok(INDEX_SQL[0].includes('user_id'));
  assert.match(calls[3].sql, /user_id = ANY\(\$1::text\[\]\)/);
  assert.match(calls[4].sql, /WHERE user_id = \$1 AND endpoint = \$2/);
  assert.deepEqual(calls[4].params, ['member-a', subscription().endpoint]);
});

test('VAPID configuration is optional and only returns the public key to configured clients', () => {
  let details;
  const webPush = {
    setVapidDetails(...args) { details = args; },
    sendNotification() {}
  };
  assert.deepEqual(createWebPushTransport({ env: {}, webPush }), {
    configured: false,
    publicKey: '',
    sendNotification: null
  });
  const publicKey = 'A'.repeat(87);
  const configured = createWebPushTransport({
    env: { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: 'private-value', VAPID_SUBJECT: 'mailto:operator@example.com' },
    webPush
  });
  assert.equal(configured.configured, true);
  assert.equal(configured.publicKey, publicKey);
  assert.deepEqual(details, ['mailto:operator@example.com', publicKey, 'private-value']);
});

test('sector audience deduplicates members across active battalions and excludes ineligible users', () => {
  const users = [
    person('agent-a', 'AG-101'),
    person('agent-b', 'AG-102'),
    person('agent-c', 'AG-103', { serviceApproved: false }),
    person('agent-d', 'AG-104', { suspended: true }),
    person('agent-e', 'AG-105', { securityStatus: 'SECURITY_RESTRICTED' }),
    person('agent-f', 'AG-106')
  ];
  const units = [
    { id: 'unit-a', sector: 'Los Santos', status: 'ACTIVE', commanderCode: 'AG-101', memberCodes: ['AG-101', 'AG-102'] },
    { id: 'unit-b', sector: 'LOS SANTOS', status: 'ALERT', deputyCode: 'AG-102', memberCodes: ['AG-103', 'AG-104', 'AG-105'] },
    { id: 'unit-c', sector: 'North', status: 'ACTIVE', memberCodes: ['AG-106'] },
    { id: 'unit-archived', sector: 'Los Santos', status: 'ARCHIVED', memberCodes: ['AG-106'] }
  ];
  assert.deepEqual(sectorMembers(users, units, 'LOS SANTOS').map((item) => item.id), ['agent-a', 'agent-b']);
  assert.deepEqual(sectorOptions(units, users), [
    { name: 'Los Santos', memberCount: 2 },
    { name: 'North', memberCount: 1 }
  ]);
});

test('mobile push sends only to subscribed sector members and does not enter the in-app notification store', async () => {
  const socket = mockSocket();
  const sent = [];
  const savedSubscriptions = [
    { userId: 'agent-a', subscription: { endpoint: 'https://fcm.googleapis.com/push/send/a', keys: { p256dh: 'a', auth: 'a' } } },
    { userId: 'agent-b', subscription: { endpoint: 'https://fcm.googleapis.com/push/send/b1', keys: { p256dh: 'b', auth: 'b' } } },
    { userId: 'agent-b', subscription: { endpoint: 'https://fcm.googleapis.com/push/send/b2', keys: { p256dh: 'b', auth: 'b' } } }
  ];
  const users = [
    person('chief-mobile-test', 'CHIEF-100', { rank: 'CIA CHIEF' }),
    person('agent-a', 'AG-101'),
    person('agent-b', 'AG-102'),
    person('other-sector', 'AG-201')
  ];
  const units = [
    { id: 'unit-la', sector: 'Los Santos', status: 'ACTIVE', memberCodes: ['AG-101', 'AG-102'] },
    { id: 'unit-other', sector: 'Vespucci', status: 'ACTIVE', memberCodes: ['AG-201'] }
  ];
  const context = {
    requireSocketUser: () => users[0],
    isLeadership: (actor) => actor.rank === 'CIA CHIEF' || actor.rank === 'SUPREME COMMANDER',
    getUsers: () => users,
    getUnits: () => units,
    store: {
      async saveSubscription() {},
      async removeSubscription() { return true; },
      async listForUsers(ids) { return savedSubscriptions.filter((item) => ids.includes(item.userId)); },
      async removeExpiredSubscription() {}
    },
    transport: {
      configured: true,
      publicKey: 'A'.repeat(87),
      async sendNotification(subscriptionValue, payload, options) {
        sent.push({ subscription: subscriptionValue, payload: JSON.parse(payload), options });
      }
    },
    makeId: () => 'PUSH-test',
    addAuditLog() {},
    async saveState() {}
  };
  registerMobilePushSocket(socket, context);

  const info = await socket.call('mobile-push:info');
  assert.equal(info.ok, true);
  assert.equal(info.canSend, true);
  assert.deepEqual(info.sectors, [{ name: 'Los Santos', memberCount: 2 }, { name: 'Vespucci', memberCount: 1 }]);
  const result = await socket.call('mobile-push:send-sector', {
    sector: 'LOS SANTOS',
    title: 'تنبيه القطاع',
    message: 'يرجى تشغيل الراديو فوراً.',
    priority: 'CRITICAL'
  });
  assert.equal(result.ok, true);
  assert.equal(result.recipientCount, 2);
  assert.equal(result.subscribedMembers, 2);
  assert.equal(result.noSubscriptionMembers, 0);
  assert.equal(result.deviceCount, 3);
  assert.equal(result.acceptedByPushService, 3);
  assert.equal(sent.length, 3);
  assert.ok(sent.every((entry) => entry.options.urgency === 'high' && entry.options.TTL === 900));
  assert.ok(sent.every((entry) => entry.payload.priority === 'CRITICAL'));
  const implementation = fs.readFileSync(path.join(projectRoot, 'mobile-push.js'), 'utf8');
  assert.doesNotMatch(implementation, /publishNotifications|notificationsStore|notification:new/);
});

test('non-leaders cannot send a sector push even when the browser asks directly', async () => {
  const socket = mockSocket();
  let sends = 0;
  registerMobilePushSocket(socket, {
    requireSocketUser: () => person('agent-user', 'AG-001', { rank: 'AGENT' }),
    isLeadership: () => false,
    getUsers: () => [],
    getUnits: () => [],
    store: { async listForUsers() { return []; } },
    transport: { configured: true, publicKey: 'A'.repeat(87), async sendNotification() { sends += 1; } },
    makeId: () => 'PUSH-test'
  });
  const result = await socket.call('mobile-push:send-sector', {
    sector: 'Los Santos',
    title: 'Test',
    message: 'Test',
    priority: 'NORMAL'
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /CIA CHIEF/);
  assert.equal(sends, 0);
});

test('sending to a sector with no opted-in phones is reported as not sent', async () => {
  const socket = mockSocket();
  let sends = 0;
  registerMobilePushSocket(socket, {
    requireSocketUser: () => person('chief-no-device-test', 'CHIEF-200', { rank: 'CIA CHIEF' }),
    isLeadership: (actor) => actor.rank === 'CIA CHIEF',
    getUsers: () => [person('agent-no-device', 'AG-200')],
    getUnits: () => [{ id: 'unit-no-device', sector: 'East', status: 'ACTIVE', memberCodes: ['AG-200'] }],
    store: { async listForUsers() { return []; } },
    transport: {
      configured: true,
      publicKey: 'A'.repeat(87),
      async sendNotification() { sends += 1; }
    },
    makeId: () => 'PUSH-no-device'
  });
  const result = await socket.call('mobile-push:send-sector', {
    sector: 'East',
    title: 'Test',
    message: 'Test',
    priority: 'NORMAL'
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /لا يملك أي فرد/);
  assert.equal(sends, 0);
});

test('expired Web Push subscriptions are removed while other failures remain registered', async () => {
  const removed = [];
  const results = await sendBatched([
    { userId: 'member-a', subscription: { endpoint: 'https://fcm.googleapis.com/a' } },
    { userId: 'member-b', subscription: { endpoint: 'https://fcm.googleapis.com/b' } }
  ], async (subscriptionValue) => {
    if (subscriptionValue.endpoint.endsWith('/a')) {
      const error = new Error('expired');
      error.statusCode = 410;
      throw error;
    }
  }, { title: 'Test' }, 'HIGH', async (userId, endpoint) => removed.push([userId, endpoint]));
  assert.deepEqual(results, { accepted: 1, failed: 1 });
  assert.deepEqual(removed, [['member-a', 'https://fcm.googleapis.com/a']]);
  assert.equal(BROADCAST_INTERVAL_MS, 15000);
});

test('service worker displays OS notifications and opens only the same-origin app on tap', async () => {
  const source = fs.readFileSync(path.join(projectRoot, 'service-worker.js'), 'utf8');
  const listeners = new Map();
  const shown = [];
  const opened = [];
  const self = {
    location: { origin: 'https://blackridge.example' },
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
    clients: {
      async matchAll() { return []; },
      async openWindow(url) { opened.push(url); }
    },
    addEventListener(name, handler) { listeners.set(name, handler); }
  };
  vm.runInNewContext(source, { self, URL, String, Promise });

  let pushPromise;
  listeners.get('push')({
    data: { json: () => ({ id: 'push-1', title: 'إلى جميع أفراد القطاع', body: 'شغّل الراديو', priority: 'CRITICAL' }) },
    waitUntil(value) { pushPromise = value; }
  });
  await pushPromise;
  assert.equal(shown[0].title, 'إلى جميع أفراد القطاع');
  assert.equal(shown[0].options.requireInteraction, true);
  assert.equal(shown[0].options.icon, '/blackridge-push-icon-192.png');

  let clickPromise;
  listeners.get('notificationclick')({
    notification: { data: { url: 'https://attacker.example/path' }, close() {} },
    waitUntil(value) { clickPromise = value; }
  });
  await clickPromise;
  assert.deepEqual(opened, ['https://blackridge.example/']);
});

test('local app routes serve mobile metadata, root-scope worker, client, and icons', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackridge-mobile-push-'));
  const stateFile = path.join(tempDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ cia_users: [] }), 'utf8');
  const port = await freePort();
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      CIA_DATA_FILE: stateFile,
      RENDER: 'false',
      RENDER_SERVICE_ID: '',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      VAPID_SUBJECT: ''
    },
    stdio: 'ignore'
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 2000).unref();
      });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${port}`;
  let health;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      health = await fetch(`${origin}/health`);
      if (health.ok) break;
    } catch (_error) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(health?.ok, true, 'server did not become ready');

  const html = await fetch(`${origin}/`);
  const body = await html.text();
  assert.match(body, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(body, /apple-mobile-web-app-capable/);
  assert.match(body, /src="\/mobile-push-client\.js"/);

  const worker = await fetch(`${origin}/service-worker.js`);
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get('service-worker-allowed'), '/');
  assert.match(worker.headers.get('cache-control') || '', /no-cache/);

  const manifestResponse = await fetch(`${origin}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.icons.length, 2);

  for (const route of ['/mobile-push-client.js', '/blackridge-push-icon-192.png', '/blackridge-push-icon-512.png']) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 200, `missing ${route}`);
  }
});
