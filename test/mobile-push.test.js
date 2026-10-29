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
const { NotificationsStore } = require('../notifications-store');
const {
  BROADCAST_INTERVAL_MS,
  OFFICIAL_SUMMON_TYPE,
  SECURITY_ALERT_TYPE,
  createWebPushTransport,
  injectMobilePushMarkup,
  registerMobilePushSocket,
  sectorMembers,
  sectorMemberOptions,
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

test('mobile push form offers sector-wide and single-member targeting with an empty-sector explanation', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'mobile-push-client.js'), 'utf8');
  assert.match(source, /name="audience"/);
  assert.match(source, /value="SECTOR">كل أفراد القطاع/);
  assert.match(source, /value="MEMBER">شخص معين/);
  assert.match(source, /name="memberId"/);
  assert.match(source, /name="notificationType"/);
  assert.match(source, /value="OFFICIAL_SUMMON">استدعاء رسمي/);
  assert.match(source, /value="SECURITY_ALERT">تحذير أمني/);
  assert.match(source, /function handleNotificationTypeChange/);
  assert.match(source, /مستوى التحذير/);
  assert.match(source, /name="subject"/);
  assert.match(source, /نص الاستدعاء/);
  assert.match(source, /لا توجد قطاعات مؤهلة للإرسال بعد/);
  assert.match(source, /mobile-push:members/);

  const inboxClient = fs.readFileSync(path.join(projectRoot, 'notifications-client.js'), 'utf8');
  const inboxStyles = fs.readFileSync(path.join(projectRoot, 'notifications.css'), 'utf8');
  assert.match(inboxClient, /notification-card--summons/);
  assert.match(inboxClient, /عرض تفاصيل الاستدعاء/);
  assert.match(inboxClient, /openDeepLinkedNotification/);
  assert.match(inboxStyles, /\.notification-detail-dialog/);
  assert.match(inboxStyles, /@media \(max-width: 700px\)/);
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
  assert.deepEqual(sectorMemberOptions(users, units, 'LOS SANTOS'), [
    { id: 'agent-a', name: 'AG-101', publicCode: 'AG-101' },
    { id: 'agent-b', name: 'AG-102', publicCode: 'AG-102' }
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
  const members = await socket.call('mobile-push:members', { sector: 'LOS SANTOS' });
  assert.deepEqual(members, {
    ok: true,
    sector: 'Los Santos',
    members: [
      { id: 'agent-a', name: 'AG-101', publicCode: 'AG-101' },
      { id: 'agent-b', name: 'AG-102', publicCode: 'AG-102' }
    ]
  });
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

test('official summons persist in the existing private inbox and push links open each recipient record', async () => {
  const socket = mockSocket();
  const sent = [];
  let id = 0;
  const users = [
    person('summons-chief', 'CHIEF-900', {
      rank: 'CIA CHIEF',
      name: 'Chief Account',
      identity: { fullName: 'قائد الاختبار' }
    }),
    person('summons-member-a', 'AG-901', {
      name: 'Member A',
      identity: { fullName: 'المستلم الأول' }
    }),
    person('summons-member-b', 'AG-902', {
      name: 'Member B',
      identity: { fullName: 'المستلم الثاني' }
    })
  ];
  const subscriptions = [
    { userId: 'summons-member-a', subscription: { endpoint: 'https://fcm.googleapis.com/push/send/a1', keys: { p256dh: 'a', auth: 'a' } } },
    { userId: 'summons-member-b', subscription: { endpoint: 'https://fcm.googleapis.com/push/send/b1', keys: { p256dh: 'b', auth: 'b' } } },
    { userId: 'summons-member-b', subscription: { endpoint: 'https://fcm.googleapis.com/push/send/b2', keys: { p256dh: 'b', auth: 'b' } } }
  ];
  let storedNotifications = [];
  const inbox = new NotificationsStore(null, {
    getRows: () => storedNotifications,
    setRows: (rows) => { storedNotifications = rows; }
  });
  const units = [{ id: 'summons-unit', sector: 'North Ridge', status: 'ACTIVE', memberCodes: ['AG-901', 'AG-902'] }];
  registerMobilePushSocket(socket, {
    requireSocketUser: () => users[0],
    isLeadership: (actor) => actor.rank === 'CIA CHIEF' || actor.rank === 'SUPREME COMMANDER',
    getUsers: () => users,
    getUnits: () => units,
    store: {
      async listForUsers(ids) { return subscriptions.filter((item) => ids.includes(item.userId)); },
      async removeExpiredSubscription() {}
    },
    transport: {
      configured: true,
      async sendNotification(subscriptionValue, payload, options) {
        sent.push({ endpoint: subscriptionValue.endpoint, payload: JSON.parse(payload), options });
      }
    },
    makeId: (prefix) => `${prefix}-test-${++id}`,
    persistNotifications: (records) => inbox.createMany(records),
    addAuditLog() {},
    async saveState() {}
  });

  const result = await socket.call('mobile-push:send-sector', {
    notificationType: OFFICIAL_SUMMON_TYPE,
    sector: 'North Ridge',
    audience: 'SECTOR',
    subject: 'مراجعة ملف المهمة',
    message: 'يرجى الحضور إلى مقر القيادة في الموعد المحدد.',
    priority: 'NORMAL'
  });
  assert.equal(result.ok, true);
  assert.equal(result.notificationType, OFFICIAL_SUMMON_TYPE);
  assert.equal(result.recipientCount, 2);
  assert.equal(result.savedNotificationCount, 2);
  assert.equal(result.deviceCount, 3);

  const firstInbox = await inbox.listForUser({ userId: 'summons-member-a' });
  const secondInbox = await inbox.listForUser({ userId: 'summons-member-b' });
  assert.equal(firstInbox.rows.length, 1);
  assert.equal(secondInbox.rows.length, 1);
  assert.equal((await inbox.listForUser({ userId: 'unrelated-member' })).rows.length, 0);
  for (const row of [...firstInbox.rows, ...secondInbox.rows]) {
    assert.equal(row.type, OFFICIAL_SUMMON_TYPE);
    assert.equal(row.title, 'استدعاء رسمي');
    assert.equal(row.message, 'يرجى الحضور إلى مقر القيادة في الموعد المحدد.');
    assert.equal(row.priority, 'NOTICE');
    assert.equal(row.metadata.subject, 'مراجعة ملف المهمة');
    assert.equal(row.metadata.issuerName, 'قائد الاختبار');
    assert.equal(row.metadata.issuerOrganization, 'BLACK RIDGE CIA');
    assert.equal(row.metadata.summonsNumber, result.summonsNumber);
    assert.ok(row.metadata.issuedAt);
  }
  assert.equal(firstInbox.rows[0].metadata.recipientName, 'المستلم الأول');
  assert.equal(secondInbox.rows[0].metadata.recipientName, 'المستلم الثاني');
  assert.equal(sent.length, 3);
  const firstPush = sent.find((entry) => entry.endpoint.endsWith('/a1'));
  const secondPushes = sent.filter((entry) => entry.endpoint.endsWith('/b1') || entry.endpoint.endsWith('/b2'));
  assert.equal(firstPush.payload.title, 'استدعاء رسمي');
  assert.match(firstPush.payload.body, /مراجعة ملف المهمة/);
  assert.equal(firstPush.payload.notificationType, OFFICIAL_SUMMON_TYPE);
  assert.match(firstPush.payload.url, /notificationId=NTF-test-/);
  assert.equal(firstPush.payload.summonsCard.issuer, 'قائد الاختبار');
  assert.equal(firstPush.payload.summonsCard.issuerRank, 'CIA CHIEF');
  assert.equal(firstPush.payload.summonsCard.recipient, 'المستلم الأول');
  assert.equal(firstPush.payload.summonsCard.subject, 'مراجعة ملف المهمة');
  assert.equal(firstPush.payload.summonsCard.message, 'يرجى الحضور إلى مقر القيادة في الموعد المحدد.');
  assert.equal(firstPush.payload.summonsCard.summonsNumber, result.summonsNumber);
  assert.equal(firstPush.payload.summonsCard.issuedAt, firstInbox.rows[0].metadata.issuedAt);
  assert.equal(secondPushes[0].payload.summonsCard.recipient, 'المستلم الثاني');
  assert.equal(secondPushes[0].payload.notificationId, secondPushes[1].payload.notificationId);
  assert.notEqual(firstPush.payload.notificationId, secondPushes[0].payload.notificationId);
});

test('security alerts use the existing private inbox and retain sector/member authorization and live push fields', async () => {
  const socket = mockSocket();
  const sent = [];
  let id = 0;
  let storedNotifications = [];
  const inbox = new NotificationsStore(null, {
    getRows: () => storedNotifications,
    setRows: (rows) => { storedNotifications = rows; }
  });
  const users = [
    person('alert-chief', 'CHIEF-910', {
      rank: 'CIA CHIEF',
      identity: { fullName: 'قائد التنبيه' }
    }),
    person('alert-member-a', 'AG-911', {
      identity: { fullName: 'المستلم المقصود' }
    }),
    person('alert-member-b', 'AG-912', {
      identity: { fullName: 'عضو آخر' }
    })
  ];
  const subscriptions = [
    { userId: 'alert-member-a', subscription: { endpoint: 'https://fcm.googleapis.com/push/send/alert-a', keys: { p256dh: 'a', auth: 'a' } } },
    { userId: 'alert-member-b', subscription: { endpoint: 'https://fcm.googleapis.com/push/send/alert-b', keys: { p256dh: 'b', auth: 'b' } } }
  ];
  registerMobilePushSocket(socket, {
    requireSocketUser: () => users[0],
    isLeadership: (actor) => actor.rank === 'CIA CHIEF' || actor.rank === 'SUPREME COMMANDER',
    getUsers: () => users,
    getUnits: () => [{ id: 'alert-unit', sector: 'South Ridge', status: 'ACTIVE', memberCodes: ['AG-911', 'AG-912'] }],
    store: {
      async listForUsers(ids) { return subscriptions.filter((item) => ids.includes(item.userId)); },
      async removeExpiredSubscription() {}
    },
    transport: {
      configured: true,
      async sendNotification(subscriptionValue, payload, options) {
        sent.push({ endpoint: subscriptionValue.endpoint, payload: JSON.parse(payload), options });
      }
    },
    makeId: (prefix) => `${prefix}-alert-${++id}`,
    persistNotifications: (records) => inbox.createMany(records),
    addAuditLog() {},
    async saveState() {}
  });

  const result = await socket.call('mobile-push:send-sector', {
    notificationType: SECURITY_ALERT_TYPE,
    sector: 'South Ridge',
    audience: 'MEMBER',
    memberId: 'alert-member-a',
    subject: 'نشاط أمني غير معتاد',
    message: 'تم رصد حركة غير معتادة قرب الموقع؛ يرجى التحقق والإبلاغ.',
    priority: 'CRITICAL'
  });

  assert.equal(result.ok, true);
  assert.equal(result.notificationType, SECURITY_ALERT_TYPE);
  assert.equal(result.recipientCount, 1);
  assert.equal(result.targetMemberName, 'المستلم المقصود');
  assert.equal(result.savedNotificationCount, 1);
  assert.equal(result.deviceCount, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].endpoint, /alert-a$/);
  const page = await inbox.listForUser({ userId: 'alert-member-a' });
  assert.equal(page.rows.length, 1);
  const row = page.rows[0];
  assert.equal(row.type, SECURITY_ALERT_TYPE);
  assert.equal(row.title, 'تحذير أمني');
  assert.equal(row.priority, 'CRITICAL');
  assert.equal(row.message, 'تم رصد حركة غير معتادة قرب الموقع؛ يرجى التحقق والإبلاغ.');
  assert.equal(row.metadata.issuerName, 'قائد التنبيه');
  assert.equal(row.metadata.issuerOrganization, 'BLACK RIDGE CIA');
  assert.equal(row.metadata.recipientName, 'المستلم المقصود');
  assert.equal(row.metadata.subject, 'نشاط أمني غير معتاد');
  assert.equal(row.metadata.warningLevel, 'CRITICAL');
  assert.equal(row.metadata.sector, 'South Ridge');
  assert.ok(row.metadata.issuedAt);
  assert.equal((await inbox.listForUser({ userId: 'alert-member-b' })).rows.length, 0);
  assert.equal(sent[0].payload.notificationType, SECURITY_ALERT_TYPE);
  assert.equal(sent[0].payload.notificationId, row.id);
  assert.equal(sent[0].payload.title, 'تحذير أمني');
  assert.equal(sent[0].payload.priority, 'CRITICAL');
  assert.equal(sent[0].payload.securityAlertCard.issuer, 'قائد التنبيه');
  assert.equal(sent[0].payload.securityAlertCard.recipient, 'المستلم المقصود');
  assert.equal(sent[0].payload.securityAlertCard.subject, 'نشاط أمني غير معتاد');
  assert.equal(sent[0].payload.securityAlertCard.priority, 'CRITICAL');
  assert.equal(sent[0].payload.securityAlertCard.message, row.message);
  assert.match(sent[0].payload.url, new RegExp(`notificationId=${row.id}`));
});

test('security alerts remain saved in the inbox when the selected recipient has no phone subscription', async () => {
  const socket = mockSocket();
  let id = 0;
  let storedNotifications = [];
  const inbox = new NotificationsStore(null, {
    getRows: () => storedNotifications,
    setRows: (rows) => { storedNotifications = rows; }
  });
  const users = [
    person('alert-offline-chief', 'CHIEF-920', { rank: 'CIA CHIEF' }),
    person('alert-offline-member', 'AG-921', { identity: { fullName: 'مستلم بلا جهاز' } })
  ];
  registerMobilePushSocket(socket, {
    requireSocketUser: () => users[0],
    isLeadership: (actor) => actor.rank === 'CIA CHIEF',
    getUsers: () => users,
    getUnits: () => [{ id: 'alert-offline-unit', sector: 'West Ridge', status: 'ACTIVE', memberCodes: ['AG-921'] }],
    store: { async listForUsers() { return []; } },
    transport: { configured: true, async sendNotification() { assert.fail('there are no subscriptions to send to'); } },
    makeId: (prefix) => `${prefix}-offline-alert-${++id}`,
    persistNotifications: (records) => inbox.createMany(records)
  });

  const result = await socket.call('mobile-push:send-sector', {
    notificationType: SECURITY_ALERT_TYPE,
    sector: 'West Ridge',
    audience: 'MEMBER',
    memberId: 'alert-offline-member',
    subject: 'تحقق أمني',
    message: 'يرجى مراجعة التنبيه عند تسجيل الدخول.',
    priority: 'NORMAL'
  });
  assert.equal(result.ok, true);
  assert.equal(result.savedNotificationCount, 1);
  assert.equal(result.deviceCount, 0);
  assert.equal(result.noSubscriptionMembers, 1);
  const page = await inbox.listForUser({ userId: 'alert-offline-member' });
  assert.equal(page.rows[0].type, SECURITY_ALERT_TYPE);
  assert.equal(page.rows[0].metadata.warningLevel, 'NORMAL');
});

test('mobile push can target one eligible member and only that member’s devices', async () => {
  const socket = mockSocket();
  const sent = [];
  const users = [
    person('chief-target-test', 'CHIEF-301', { rank: 'CIA CHIEF' }),
    person('member-a', 'AG-301', { name: 'Member A' }),
    person('member-b', 'AG-302', { name: 'Member B' }),
    person('member-unapproved', 'AG-303', { name: 'Not eligible', serviceApproved: false }),
    person('member-other-sector', 'AG-401', { name: 'Other sector' })
  ];
  const units = [
    { id: 'unit-east', sector: 'East', status: 'ACTIVE', memberCodes: ['AG-301', 'AG-302', 'AG-303'] },
    { id: 'unit-west', sector: 'West', status: 'ACTIVE', memberCodes: ['AG-401'] }
  ];
  const savedSubscriptions = [
    { userId: 'member-a', subscription: { endpoint: 'https://fcm.googleapis.com/push/send/a', keys: { p256dh: 'a', auth: 'a' } } },
    { userId: 'member-b', subscription: { endpoint: 'https://fcm.googleapis.com/push/send/b', keys: { p256dh: 'b', auth: 'b' } } }
  ];
  registerMobilePushSocket(socket, {
    requireSocketUser: () => users[0],
    isLeadership: (actor) => actor.rank === 'CIA CHIEF',
    getUsers: () => users,
    getUnits: () => units,
    store: {
      async listForUsers(ids) { return savedSubscriptions.filter((item) => ids.includes(item.userId)); },
      async removeExpiredSubscription() {}
    },
    transport: {
      configured: true,
      publicKey: 'A'.repeat(87),
      async sendNotification(subscriptionValue, payload) {
        sent.push({ endpoint: subscriptionValue.endpoint, payload: JSON.parse(payload) });
      }
    },
    makeId: () => 'PUSH-target-test',
    addAuditLog() {},
    async saveState() {}
  });

  const result = await socket.call('mobile-push:send-sector', {
    sector: 'East',
    audience: 'MEMBER',
    memberId: 'member-b',
    title: 'اختبار فردي',
    message: 'رسالة إلى عضو واحد.',
    priority: 'NORMAL'
  });
  assert.equal(result.ok, true);
  assert.equal(result.audience, 'MEMBER');
  assert.equal(result.targetMemberName, 'Member B');
  assert.equal(result.recipientCount, 1);
  assert.equal(result.deviceCount, 1);
  assert.equal(result.acceptedByPushService, 1);
  assert.deepEqual(sent.map((item) => item.endpoint), ['https://fcm.googleapis.com/push/send/b']);
  assert.equal(sent[0].payload.sector, 'East');
});

test('targeted mobile push rejects a member outside the selected sector', async () => {
  const socket = mockSocket();
  let sends = 0;
  const users = [
    person('chief-target-boundary-test', 'CHIEF-401', { rank: 'CIA CHIEF' }),
    person('east-member', 'AG-401'),
    person('west-member', 'AG-402')
  ];
  registerMobilePushSocket(socket, {
    requireSocketUser: () => users[0],
    isLeadership: (actor) => actor.rank === 'CIA CHIEF',
    getUsers: () => users,
    getUnits: () => [
      { id: 'east-unit', sector: 'East', status: 'ACTIVE', memberCodes: ['AG-401'] },
      { id: 'west-unit', sector: 'West', status: 'ACTIVE', memberCodes: ['AG-402'] }
    ],
    store: { async listForUsers() { return []; } },
    transport: {
      configured: true,
      publicKey: 'A'.repeat(87),
      async sendNotification() { sends += 1; }
    }
  });

  const result = await socket.call('mobile-push:send-sector', {
    sector: 'East',
    audience: 'MEMBER',
    memberId: 'west-member',
    title: 'Test',
    message: 'Test',
    priority: 'NORMAL'
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /لا ينتمي إلى القطاع/);
  assert.equal(sends, 0);
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
  for (const notificationType of [OFFICIAL_SUMMON_TYPE, SECURITY_ALERT_TYPE]) {
    const result = await socket.call('mobile-push:send-sector', {
      sector: 'Los Santos',
      notificationType,
      subject: 'Unauthorized',
      message: 'Test',
      priority: 'NORMAL'
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /CIA CHIEF/);
  }
  assert.equal(sends, 0);
  const memberList = await socket.call('mobile-push:members', { sector: 'Any' });
  assert.equal(memberList.ok, false);
  assert.match(memberList.message, /متاحة/);
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

test('official summons are still saved in the existing inbox when recipients have no push subscription', async () => {
  const socket = mockSocket();
  let savedRows = [];
  let id = 0;
  let sends = 0;
  const inbox = new NotificationsStore(null, {
    getRows: () => savedRows,
    setRows: (rows) => { savedRows = rows; }
  });
  const users = [
    person('chief-no-summons-device', 'CHIEF-600', { rank: 'CIA CHIEF' }),
    person('member-no-summons-device', 'AG-601', { identity: { fullName: 'مستلم بلا جهاز' } })
  ];
  registerMobilePushSocket(socket, {
    requireSocketUser: () => users[0],
    isLeadership: (actor) => actor.rank === 'CIA CHIEF',
    getUsers: () => users,
    getUnits: () => [{ id: 'no-device-unit', sector: 'South', status: 'ACTIVE', memberCodes: ['AG-601'] }],
    store: { async listForUsers() { return []; } },
    transport: { configured: true, async sendNotification() { sends += 1; } },
    makeId: (prefix) => `${prefix}-offline-${++id}`,
    persistNotifications: (records) => inbox.createMany(records)
  });

  const result = await socket.call('mobile-push:send-sector', {
    notificationType: OFFICIAL_SUMMON_TYPE,
    sector: 'South',
    subject: 'مراجعة حضور',
    message: 'يرجى مراجعة مكتب القيادة.',
    priority: 'NORMAL'
  });
  assert.equal(result.ok, true);
  assert.equal(result.savedNotificationCount, 1);
  assert.equal(result.deviceCount, 0);
  assert.equal(result.noSubscriptionMembers, 1);
  assert.equal(sends, 0);
  const page = await inbox.listForUser({ userId: 'member-no-summons-device' });
  assert.equal(page.rows[0].metadata.subject, 'مراجعة حضور');
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
  vm.runInNewContext(source, { self, URL, String, Promise, Date, Intl, encodeURIComponent });

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
  listeners.get('push')({
    data: {
      json: () => ({
        id: 'NTF-summons-a',
        notificationId: 'NTF-summons-a',
        notificationType: OFFICIAL_SUMMON_TYPE,
        title: 'استدعاء رسمي',
        body: 'الجهة: قيادة الاختبار · الموضوع: مراجعة الملف',
        priority: 'NORMAL',
        url: '/?notificationId=NTF-summons-a',
        summonsCard: {
          issuer: 'قيادة الاختبار',
          issuerRank: 'CIA CHIEF',
          recipient: 'المستلم الفعلي',
          subject: 'مراجعة <ملف> & تدقيق',
          message: 'يرجى الحضور إلى مقر القيادة.',
          summonsNumber: 'SUM-TEST-001',
          issuedAt: '2026-10-29T09:20:00.000Z'
        }
      })
    },
    waitUntil(value) { pushPromise = value; }
  });
  await pushPromise;
  assert.equal(shown[1].title, 'استدعاء رسمي');
  assert.equal(shown[1].options.dir, 'rtl');
  assert.equal(shown[1].options.lang, 'ar');
  assert.equal(shown[1].options.actions[0].title, 'عرض تفاصيل الاستدعاء');
  assert.equal(shown[1].options.data.notificationId, 'NTF-summons-a');
  assert.equal(shown[1].options.data.notificationType, OFFICIAL_SUMMON_TYPE);
  assert.match(shown[1].options.image, /^data:image\/svg\+xml;charset=utf-8,/);
  const summonsImageSvg = decodeURIComponent(shown[1].options.image.split(',')[1]);
  assert.match(summonsImageSvg, /BLACK RIDGE CIA/);
  assert.match(summonsImageSvg, /قيادة الاختبار/);
  assert.match(summonsImageSvg, /المستلم الفعلي/);
  assert.match(summonsImageSvg, /مراجعة &lt;ملف&gt; &amp; تدقيق/);
  assert.match(summonsImageSvg, /عرض تفاصيل الاستدعاء/);
  assert.doesNotMatch(summonsImageSvg, /<script|onload=/i);

  const securityAlertId = 'NTF-security-alert-a';
  listeners.get('push')({
    data: {
      json: () => ({
        id: securityAlertId,
        notificationId: securityAlertId,
        notificationType: SECURITY_ALERT_TYPE,
        title: 'تحذير أمني',
        body: 'تنبيه عاجل صادر عن القيادة.',
        priority: 'CRITICAL',
        url: `/?notificationId=${securityAlertId}`,
        securityAlertCard: {
          issuer: 'القيادة الفعلية',
          issuerRank: 'CIA CHIEF',
          recipient: 'المستلم الفعلي',
          subject: 'نشاط <مريب> & متابعة',
          message: 'تم رصد حركة غير معتادة؛ يرجى التحقق فورًا.',
          priority: 'CRITICAL',
          sector: 'South Ridge',
          issuedAt: '2026-10-29T09:20:00.000Z'
        }
      })
    },
    waitUntil(value) { pushPromise = value; }
  });
  await pushPromise;
  assert.equal(shown[2].title, 'تحذير أمني');
  assert.equal(shown[2].options.dir, 'rtl');
  assert.equal(shown[2].options.requireInteraction, true);
  assert.equal(shown[2].options.actions[0].title, 'عرض التحذير');
  assert.equal(shown[2].options.data.notificationId, securityAlertId);
  assert.equal(shown[2].options.data.notificationType, SECURITY_ALERT_TYPE);
  assert.match(shown[2].options.image, /^data:image\/svg\+xml;charset=utf-8,/);
  const securityAlertSvg = decodeURIComponent(shown[2].options.image.split(',')[1]);
  assert.match(securityAlertSvg, /تحذير أمني/);
  assert.match(securityAlertSvg, /مستوى عاجل/);
  assert.match(securityAlertSvg, /القيادة الفعلية/);
  assert.match(securityAlertSvg, /نشاط &lt;مريب&gt; &amp; متابعة/);
  assert.match(securityAlertSvg, /عرض التحذير/);
  assert.doesNotMatch(securityAlertSvg, /<script|onload=/i);

  listeners.get('push')({
    data: {
      json: () => ({
        id: 'NTF-security-alert-normal',
        notificationId: 'NTF-security-alert-normal',
        notificationType: SECURITY_ALERT_TYPE,
        title: 'تحذير أمني',
        body: 'تنبيه اعتيادي.',
        priority: 'NORMAL',
        securityAlertCard: {
          issuer: 'القيادة',
          subject: 'مراجعة دورية',
          message: 'يرجى الاطلاع على التنبيه.',
          priority: 'NORMAL',
          sector: 'North Ridge',
          issuedAt: '2026-10-29T09:20:00.000Z'
        }
      })
    },
    waitUntil(value) { pushPromise = value; }
  });
  await pushPromise;
  assert.equal(shown[3].options.requireInteraction, false);
  const normalAlertSvg = decodeURIComponent(shown[3].options.image.split(',')[1]);
  assert.match(normalAlertSvg, /مستوى عادي/);

  listeners.get('notificationclick')({
    notification: { data: shown[1].options.data, close() {} },
    waitUntil(value) { clickPromise = value; }
  });
  await clickPromise;
  assert.deepEqual(opened, ['https://blackridge.example/?notificationId=NTF-summons-a']);

  listeners.get('notificationclick')({
    notification: { data: shown[2].options.data, close() {} },
    waitUntil(value) { clickPromise = value; }
  });
  await clickPromise;
  assert.deepEqual(opened, [
    'https://blackridge.example/?notificationId=NTF-summons-a',
    `https://blackridge.example/?notificationId=${securityAlertId}`
  ]);

  listeners.get('notificationclick')({
    notification: { data: { url: 'https://attacker.example/path' }, close() {} },
    waitUntil(value) { clickPromise = value; }
  });
  await clickPromise;
  assert.deepEqual(opened, [
    'https://blackridge.example/?notificationId=NTF-summons-a',
    `https://blackridge.example/?notificationId=${securityAlertId}`,
    'https://blackridge.example/'
  ]);
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

  for (const route of [
    '/mobile-push-client.js',
    '/notifications-client.js',
    '/brand-seal.jpg',
    '/blackridge-push-icon-192.png',
    '/blackridge-push-icon-512.png'
  ]) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 200, `missing ${route}`);
  }
});
