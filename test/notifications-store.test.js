'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationsStore, CREATE_TABLE_SQL, INDEX_SQL } = require('../notifications-store');

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

test('CIA CHIEF warning history and justification updates use the existing notifications store', async () => {
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
  assert.match(calls[0].sql, /WHERE type = 'WARNING'/);
  assert.deepEqual(calls[0].params, [21, 0]);
  assert.match(calls[1].sql, /WHERE type = 'WARNING' AND related_id = \$1/);
  assert.equal(calls[1].params[0], 'warning-id-db');
  assert.equal(calls[1].params[1], true);
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
  assert.equal(calls.filter(({ sql }) => sql.includes('CREATE INDEX IF NOT EXISTS')).length, INDEX_SQL.length);
});