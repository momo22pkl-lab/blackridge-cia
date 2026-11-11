'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresStateStore, UPSERT_PRIMARY_CHIEF_HANDOVER_SQL } = require('../state-store');
const { restorePrimaryChiefInState } = require('../primary-chief-protection');

class MemoryPool {
  constructor() { this.row = null; this.failNextWrite = false; this.lastQuery = ''; this.lastHandoverFrom = null; }
  async query(sql, params = []) {
    this.lastQuery = sql;
    const query = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (query.startsWith('create table')) return { rows: [], rowCount: 0 };
    if (query.includes('blackridge_protect_primary_chief_state') && query.includes('update blackridge_app_state as app_state')) {
      if (this.row) restorePrimaryChiefInState(this.row);
      return { rows: [], rowCount: 0 };
    }
    if (query.startsWith('select data')) return { rows: this.row ? [{ data: structuredClone(this.row) }] : [], rowCount: this.row ? 1 : 0 };
    if (query.startsWith('with handover_context as materialized')) {
      this.row = JSON.parse(params[0]);
      this.lastHandoverFrom = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (query.startsWith('insert into blackridge_app_state')) {
      if (!query.includes('do nothing') && this.failNextWrite) {
        this.failNextWrite = false;
        throw new Error('simulated database outage');
      }
      const incoming = JSON.parse(params[0]);
      if (query.includes('do nothing')) {
        if (!this.row) this.row = incoming;
      } else {
        this.row = incoming;
      }
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Unexpected SQL: ' + sql);
  }
}

const normalize = (value) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.cia_users)) throw new Error('invalid app state');
  return structuredClone(value);
};

test('initializes an empty database and restores the saved state on restart', async () => {
  const pool = new MemoryPool();
  const store = new PostgresStateStore(pool);
  const initialState = { cia_users: [], settings: { salary: 580 } };
  const loaded = await store.load({ initialState, getLegacyState: () => null, normalizeState: normalize });
  assert.deepEqual(loaded, initialState);

  const linkedDiscordAccount = {
    id: 'discord:123456789012345678',
    provider: 'discord',
    platform: 'Discord',
    externalId: '123456789012345678',
    username: 'raven_test',
    globalName: 'Raven Member',
    linkedAt: '2026-10-22T12:00:00.000Z'
  };
  await store.save({
    cia_users: [{
      id: 'u-1',
      name: 'Agent',
      socialContactName: 'Raven Member',
      socialAccounts: [linkedDiscordAccount]
    }],
    settings: { salary: 620 }
  });
  await store.flush();

  const reopened = await new PostgresStateStore(pool).load({
    initialState,
    getLegacyState: () => { throw new Error('legacy data must not override an existing database row'); },
    normalizeState: normalize
  });
  assert.equal(reopened.cia_users[0].id, 'u-1');
  assert.equal(reopened.cia_users[0].socialContactName, 'Raven Member', 'the JSONB state store preserves the optional member contact name');
  assert.deepEqual(reopened.cia_users[0].socialAccounts, [linkedDiscordAccount], 'Discord identity and link date survive loading from the state store after restart');
  assert.equal(reopened.settings.salary, 620);
});

test('imports legacy JSON state only when the database has no state row', async () => {
  const pool = new MemoryPool();
  const store = new PostgresStateStore(pool);
  const initialState = { cia_users: [], settings: {} };
  const legacyState = { cia_users: [{ id: 'legacy-1' }], settings: { salary: 700 } };
  const loaded = await store.load({ initialState, getLegacyState: () => legacyState, normalizeState: normalize });
  assert.deepEqual(loaded, legacyState);

  const next = await new PostgresStateStore(pool).load({
    initialState,
    getLegacyState: () => ({ cia_users: [{ id: 'must-not-overwrite' }] }),
    normalizeState: normalize
  });
  assert.equal(next.cia_users[0].id, 'legacy-1');
});

test('serializes rapid state snapshots and retains the latest one', async () => {
  const pool = new MemoryPool();
  const store = new PostgresStateStore(pool);
  await store.load({ initialState: { cia_users: [] }, normalizeState: normalize });
  const first = store.save({ cia_users: [{ id: 'first' }] });
  const second = store.save({ cia_users: [{ id: 'latest' }] });
  await Promise.all([first, second]);
  await store.flush();
  assert.equal(pool.row.cia_users[0].id, 'latest');
});


test('recovers the write queue after a temporary database failure', async () => {
  const pool = new MemoryPool();
  const store = new PostgresStateStore(pool);
  const initialState = { cia_users: [] };
  await store.load({ initialState, normalizeState: normalize });

  pool.failNextWrite = true;
  await assert.rejects(store.save({ cia_users: [{ id: 'failed' }] }), /simulated database outage/);
  await store.save({ cia_users: [{ id: 'recovered' }] });
  await store.flush();
  assert.equal(pool.row.cia_users[0].id, 'recovered');
});


test('restores only the existing Primary Chief access flags during database load', async () => {
  const pool = new MemoryPool();
  const chief = {
    id: 'chief-existing', rank: 'CIA CHIEF', publicCode: 'CHIEF-KEEP', secretCode: 'fixture-only',
    militaryCode: 'MIL-KEEP', approved: false, suspended: true, securityStatus: 'SUSPENDED',
    serviceApproved: true, permissions: ['command'], suspensionReason: 'keep the record', profanityStrikes: 3
  };
  const other = { id: 'member-1', rank: 'AGENT', approved: false, suspended: true, securityStatus: 'SUSPENDED' };
  pool.row = { cia_users: [chief, other], cia_security_incidents: [{ id: 'incident-keep' }], cia_audit_logs: [{ id: 'audit-keep' }] };
  const original = structuredClone(pool.row);
  const store = new PostgresStateStore(pool);
  const loaded = await store.load({
    initialState: { cia_users: [] },
    normalizeState: normalize
  });

  const expected = structuredClone(original);
  expected.cia_users[0].approved = true;
  expected.cia_users[0].suspended = false;
  expected.cia_users[0].securityStatus = 'ACTIVE';
  assert.deepEqual(pool.row, expected);
  assert.deepEqual(loaded, expected);
});


test('uses an explicit database handover context only for the chief handover save', async () => {
  const pool = new MemoryPool();
  pool.row = { cia_users: [
    { id: 'chief-old', rank: 'CIA CHIEF', approved: true, suspended: false, securityStatus: 'ACTIVE' },
    { id: 'chief-next', rank: 'SUPREME COMMANDER', approved: true, suspended: false, securityStatus: 'ACTIVE' }
  ] };
  const store = new PostgresStateStore(pool);
  const state = await store.load({ initialState: { cia_users: [] }, normalizeState: normalize });
  state.cia_users[0].rank = 'SUPREME COMMANDER';
  state.cia_users[1].rank = 'CIA CHIEF';
  await store.save(state, { primaryChiefHandoverFrom: 'chief-old' });
  await store.flush();
  assert.match(UPSERT_PRIMARY_CHIEF_HANDOVER_SQL, /set_config/);
  assert.equal(pool.lastHandoverFrom, 'chief-old');
  assert.deepEqual(pool.row.cia_users.map((person) => person.rank), ['SUPREME COMMANDER', 'CIA CHIEF']);
});
