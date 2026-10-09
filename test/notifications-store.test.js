'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NotificationsStore,
  CREATE_TABLE_SQL,
  INDEX_SQL,
  OFFICIAL_WARNING_SCHEMA_SQL,
  BACKFILL_OFFICIAL_WARNINGS_SQL,
  BACKFILL_OFFICIAL_WARNING_RESPONSES_SQL
} = require('../notifications-store');

function makeStore() {
  let rows = [];
  const store = new NotificationsStore(null, {
    getRows: () => rows,
    setRows: (next) => { rows = next; }
  });
  return { store, getRows: () => rows };
}

function notification(id, userId, priority = 'NOTICE', type = 'MESSAGE') {
  return {
    id,
    userId,
    type,
    title: `Alert ${id}`,
    message: 'Test event',
    priority,
    status: 'SENT',
    metadata: { source: 'unit-test' }
  };
}

test('creates a durable notifications table and the requested lookup indexes', () => {
  assert.match(CREATE_TABLE_SQL, /CREATE TABLE IF NOT EXISTS notifications/);
  for (const column of ['user_id', 'created_at', 'read_at', 'priority', 'type']) {
    assert.ok(INDEX_SQL.some((sql) => sql.includes(`(${column}`) || sql.includes(`(${column},`)), `missing index on ${column}`);
  }
});

test('creates independent warning and reply tables and idempotently backfills existing notification records', () => {
  assert.match(OFFICIAL_WARNING_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS official_warnings/);
  assert.match(OFFICIAL_WARNING_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS official_warning_responses/);
  assert.match(OFFICIAL_WARNING_SCHEMA_SQL, /warning_id TEXT PRIMARY KEY REFERENCES official_warnings/);
  assert.match(OFFICIAL_WARNING_SCHEMA_SQL, /notification_id TEXT NOT NULL UNIQUE REFERENCES notifications/);
  assert.match(BACKFILL_OFFICIAL_WARNINGS_SQL, /ON CONFLICT \(warning_id\) DO NOTHING/);
  assert.match(BACKFILL_OFFICIAL_WARNING_RESPONSES_SQL, /ON CONFLICT \(warning_id\) DO NOTHING/);
  assert.match(BACKFILL_OFFICIAL_WARNINGS_SQL, /FROM notifications n\s+WHERE n\.type = 'WARNING'/);
  assert.match(BACKFILL_OFFICIAL_WARNING_RESPONSES_SQL, /WHERE n\.type = 'WARNING_RESPONSE'/);
});

test('notification pages, counts, and summaries are isolated to the authenticated user id', async () => {
  const { store } = makeStore();
  await store.createMany([
    notification('n-1', 'agent-a', 'CRITICAL', 'SOS'),
    notification('n-2', 'agent-a', 'NOTICE', 'MESSAGE'),
    notification('n-3', 'agent-b', 'CRITICAL', 'SECURITY')
  ]);

  const page = await store.listForUser({ userId: 'agent-a', limit: 1 });
  assert.equal(page.rows.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.rows[0].userId, 'agent-a');
  assert.deepEqual(await store.countsForUser('agent-a'), {
    all: 2, critical: 1, messages: 1, sos: 1, operations: 0, finance: 0, system: 0, unread: 2, unreadCritical: 1, unreadSecurity: 0
  });
  const summary = await store.summarySince('agent-a', new Date(Date.now() - 60000).toISOString());
  assert.equal(summary.total, 2);
  assert.equal(summary.attention, 1);
  assert.equal(summary.byType.SOS, 1);
});

test('counts unread security alerts separately and only for their owner', async () => {
  const { store } = makeStore();
  await store.createMany([
    notification('security-unread', 'chief-a', 'HIGH', 'SECURITY'),
    notification('security-read', 'chief-a', 'NOTICE', 'SECURITY'),
    notification('security-other', 'chief-b', 'HIGH', 'SECURITY')
  ]);
  await store.markRead('chief-a', 'security-read');
  assert.equal((await store.countsForUser('chief-a')).unreadSecurity, 1);
  assert.equal((await store.countsForUser('chief-b')).unreadSecurity, 1);
});

test('read and acknowledge mutations cannot cross users; reading does not acknowledge critical alerts', async () => {
  const { store, getRows } = makeStore();
  await store.createMany([
    notification('critical-a', 'agent-a', 'CRITICAL', 'SOS'),
    notification('notice-a', 'agent-a', 'NOTICE', 'MESSAGE'),
    notification('critical-b', 'agent-b', 'CRITICAL', 'SECURITY')
  ]);

  assert.equal(await store.markRead('agent-b', 'critical-a'), null);
  assert.equal(await store.acknowledge('agent-a', 'critical-b'), null);
  const read = await store.markRead('agent-a', 'critical-a');
  assert.equal(read.status, 'SEEN');
  assert.equal(read.acknowledgedAt, null);
  const acknowledged = await store.acknowledge('agent-a', 'critical-a');
  assert.equal(acknowledged.status, 'ACKNOWLEDGED');
  assert.ok(acknowledged.acknowledgedAt);

  assert.equal(await store.markAllRead('agent-a'), 1);
  const rows = getRows();
  assert.ok(rows.find((row) => row.id === 'critical-a').acknowledgedAt);
  assert.equal(rows.find((row) => row.id === 'notice-a').status, 'SEEN');
  assert.equal(rows.find((row) => row.id === 'critical-b').readAt, null);
});

test('offline notifications become delivered only when their own user reconnects', async () => {
  const { store, getRows } = makeStore();
  await store.createMany([
    notification('offline-a', 'agent-a'),
    notification('offline-b', 'agent-b')
  ]);
  assert.equal(await store.markDelivered('agent-a'), 1);
  const rows = getRows();
  assert.equal(rows.find((row) => row.id === 'offline-a').status, 'DELIVERED');
  assert.ok(rows.find((row) => row.id === 'offline-a').deliveredAt);
  assert.equal(rows.find((row) => row.id === 'offline-b').status, 'SENT');
});

test('search and category filters are bounded and do not return another user’s rows', async () => {
  const { store } = makeStore();
  await store.createMany([
    { ...notification('sos-a', 'agent-a', 'CRITICAL', 'SOS'), message: 'Agent AG-104 in Los Santos' },
    { ...notification('ops-a', 'agent-a', 'HIGH', 'OPERATION'), title: 'OP-211 operation' },
    notification('sos-b', 'agent-b', 'CRITICAL', 'SOS')
  ]);

  const filtered = await store.listForUser({ userId: 'agent-a', category: 'sos', search: 'AG-104', limit: 999 });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].id, 'sos-a');
  assert.deepEqual((await store.listForUser({ userId: 'agent-a', category: 'invalid' })).rows, []);
});

test('official warnings and replies retain up to 3000 characters without changing other notification limits', async () => {
  const { store } = makeStore();
  const longText = 'x'.repeat(3000);
  const created = await store.createMany([
    { ...notification('warning-long', 'agent-a', 'CRITICAL', 'WARNING'), message: longText },
    { ...notification('reply-long', 'chief-a', 'HIGH', 'WARNING_RESPONSE'), message: longText },
    { ...notification('message-long', 'agent-a', 'NOTICE', 'MESSAGE'), message: longText }
  ]);
  assert.equal(created.find((row) => row.id === 'warning-long').message.length, 3000);
  assert.equal(created.find((row) => row.id === 'reply-long').message.length, 3000);
  assert.equal(created.find((row) => row.id === 'message-long').message.length, 1000);
});

test('CIA CHIEF warning history and justification updates preserve notification delivery rows', async () => {
  const { store, getRows } = makeStore();
  await store.createMany([
    { ...notification('warning-a', 'agent-a', 'CRITICAL', 'WARNING'), relatedId: 'wrn-a', metadata: { allowJustification: false } },
    { ...notification('warning-b', 'agent-b', 'CRITICAL', 'WARNING'), relatedId: 'wrn-b', metadata: { allowJustification: true } },
    notification('other', 'agent-a', 'NOTICE', 'MESSAGE')
  ]);

  const page = await store.listOfficialWarnings({ limit: 1 });
  assert.equal(page.rows.length, 1);
  assert.equal(page.hasMore, true);
  const updated = await store.setOfficialWarningJustification('wrn-a', true);
  assert.equal(updated.userId, 'agent-a');
  assert.equal(updated.metadata.allowJustification, true);
  assert.equal(getRows().find((row) => row.relatedId === 'wrn-b').metadata.allowJustification, true);
  assert.equal(await store.setOfficialWarningJustification('missing', true), null);
});

test('PostgreSQL warning history and permission changes target only warning notification rows', async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT notification_id FROM official_warnings')) {
        return { rows: [{ notification_id: 'warning-db' }] };
      }
      if (sql.includes('UPDATE notifications')) {
        return {
          rows: [{
            id: 'warning-db',
            user_id: 'agent-db',
            type: 'WARNING',
            title: 'تحذير رسمي',
            message: 'محتوى التحذير',
            priority: 'CRITICAL',
            status: 'SENT',
            created_at: new Date().toISOString(),
            related_id: 'warning-id-db',
            metadata: { warningId: 'warning-id-db', allowJustification: true }
          }]
        };
      }
      return { rows: [] };
    }
  };
  const store = new NotificationsStore(pool);
  const page = await store.listOfficialWarnings({ limit: 20, offset: 0 });
  assert.deepEqual(page.rows, []);
  const updated = await store.setOfficialWarningJustification('warning-id-db', true);
  assert.equal(updated.userId, 'agent-db');
  assert.equal(updated.metadata.allowJustification, true);
  assert.match(calls[0].sql, /FROM official_warnings w/);
  assert.deepEqual(calls[0].params, [21, 0]);
  assert.match(calls[1].sql, /SELECT notification_id FROM official_warnings WHERE warning_id = \$1 FOR UPDATE/);
  assert.deepEqual(calls[1].params, ['warning-id-db']);
  assert.match(calls[2].sql, /UPDATE official_warnings SET allow_justification = \$2 WHERE warning_id = \$1/);
  assert.deepEqual(calls[2].params, ['warning-id-db', true]);
  assert.match(calls[3].sql, /WHERE id = \$1 AND type = 'WARNING'/);
  assert.deepEqual(calls[3].params, ['warning-db', true]);
});

test('PostgreSQL warning responses are persisted once in the canonical table and duplicates roll back', async () => {
  const warnings = new Map();
  const responses = new Set();
  const notifications = [];
  const pool = {
    async query() { return { rows: [] }; },
    async connect() {
      const pendingWarnings = [];
      const pendingResponses = [];
      const pendingNotifications = [];
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT') {
            if (sql === 'COMMIT') {
              for (const item of pendingWarnings) warnings.set(item.warning_id, item);
              for (const item of pendingResponses) responses.add(item);
              notifications.push(...pendingNotifications);
            }
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('INSERT INTO notifications')) {
            const entries = JSON.parse(params[0]);
            const rows = entries.map((entry) => ({
              id: entry.id,
              user_id: entry.user_id,
              type: entry.type,
              title: entry.title,
              message: entry.message,
              priority: entry.priority,
              status: entry.status,
              created_at: new Date().toISOString(),
              delivered_at: null,
              read_at: null,
              acknowledged_at: null,
              source_user_id: entry.source_user_id,
              source_code: entry.source_code,
              related_id: entry.related_id,
              metadata: entry.metadata
            }));
            pendingNotifications.push(...rows);
            return { rows };
          }
          if (sql.includes('INSERT INTO official_warnings')) {
            const [warningId, notificationId, recipientId, issuerId, warningType, content, allow] = params;
            if (warnings.has(warningId)) return { rows: [] };
            const record = {
              warning_id: warningId,
              notification_id: notificationId,
              recipient_user_id: recipientId,
              issuer_user_id: issuerId,
              warning_type: warningType,
              content,
              allow_justification: allow
            };
            pendingWarnings.push(record);
            return { rows: [{ warning_id: warningId }] };
          }
          if (sql.includes('SELECT warning_id, recipient_user_id, issuer_user_id, allow_justification')) {
            const warningId = params[0];
            return { rows: warnings.has(warningId) ? [warnings.get(warningId)] : [] };
          }
          if (sql.includes('INSERT INTO official_warning_responses')) {
            const warningId = params[0];
            if (responses.has(warningId) || pendingResponses.includes(warningId)) return { rows: [] };
            pendingResponses.push(warningId);
            return { rows: [{ warning_id: warningId }] };
          }
          return { rows: [] };
        },
        release() {}
      };
    }
  };
  const store = new NotificationsStore(pool);
  const warning = await store.createMany([{
    ...notification('warning-db-1', 'agent-db', 'CRITICAL', 'WARNING'),
    sourceUserId: 'chief-db',
    relatedId: 'wrn-db-1',
    metadata: { warningId: 'wrn-db-1', warningType: 'أمني', warningContent: 'تفاصيل التحذير', issuerId: 'chief-db', allowJustification: true }
  }]);
  assert.equal(warning.length, 1);
  assert.equal(warnings.get('wrn-db-1').recipient_user_id, 'agent-db');

  const response = {
    ...notification('response-db-1', 'chief-db', 'HIGH', 'WARNING_RESPONSE'),
    sourceUserId: 'agent-db',
    relatedId: 'wrn-db-1',
    metadata: { warningId: 'wrn-db-1', responseText: 'التبرير المسجل' }
  };
  assert.equal((await store.createMany([response])).length, 1);
  assert.equal((await store.createMany([{ ...response, id: 'response-db-2' }])).length, 0);
  assert.deepEqual([...responses], ['wrn-db-1']);
  assert.equal(notifications.filter((row) => row.type === 'WARNING_RESPONSE').length, 1);
});

test('PostgreSQL queries initialize the schema and scope reads and mutations to the owning user', async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*) FILTER')) {
         return { rows: [{ all: '1', critical: '1', messages: '0', sos: '1', operations: '0', finance: '0', system: '0', unread: '1', unreadCritical: '1', unreadSecurity: '0' }] };
      }
      return { rows: [] };
    }
  };
  const store = new NotificationsStore(pool);
  await store.initialize();
  await store.countsForUser('agent-a');
  await store.listForUser({ userId: 'agent-a', category: 'sos', search: 'CASE-204' });
  await store.markDelivered('agent-a');
  await store.markRead('agent-a', 'notice-a');
  await store.markAllRead('agent-a');
  await store.acknowledge('agent-a', 'critical-a');

  const selects = calls.filter(({ sql }) => sql.startsWith('SELECT * FROM notifications') || sql.includes('COUNT(*) FILTER'));
  for (const { sql, params } of selects) {
    assert.match(sql, /user_id = \$1/);
    assert.equal(params[0], 'agent-a');
  }
  const updates = calls.filter(({ sql }) => sql.startsWith('UPDATE notifications'));
  assert.equal(updates.length, 4);
  for (const { sql, params } of updates) {
    assert.match(sql, /WHERE user_id = \$1/);
    assert.equal(params[0], 'agent-a');
  }
  assert.match(updates[3].sql, /priority = 'CRITICAL'/);
  assert.ok(calls.some(({ sql }) => sql.includes('CREATE TABLE IF NOT EXISTS notifications')));
  assert.equal(calls.filter(({ sql }) => sql.includes('CREATE INDEX IF NOT EXISTS')).length, INDEX_SQL.length + 1);
  assert.ok(calls.some(({ sql }) => sql.includes('CREATE TABLE IF NOT EXISTS official_warnings')));
  assert.ok(calls.some(({ sql }) => sql.includes('CREATE TABLE IF NOT EXISTS official_warning_responses')));
  assert.ok(calls.some(({ sql }) => sql.includes('INSERT INTO official_warnings')));
  assert.ok(calls.some(({ sql }) => sql.includes('INSERT INTO official_warning_responses')));
});