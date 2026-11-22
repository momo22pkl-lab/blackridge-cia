'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { checkReadiness } = require('../state-store');

const readyState = { cia_users: [] };

test('readiness stays false until application state is initialized', async () => {
  assert.deepEqual(await checkReadiness({ state: null }), {
    ready: false,
    reason: 'state_unavailable'
  });
});

test('Render readiness requires PostgreSQL instead of silently accepting file storage', async () => {
  assert.deepEqual(await checkReadiness({
    state: readyState,
    postgresPool: null,
    requirePostgres: true
  }), {
    ready: false,
    reason: 'database_not_configured'
  });
});

test('local file-backed mode remains ready when initialized', async () => {
  assert.deepEqual(await checkReadiness({
    state: readyState,
    postgresPool: null,
    requirePostgres: false
  }), {
    ready: true,
    storage: 'file'
  });
});

test('PostgreSQL readiness performs a read-only connection check', async () => {
  let query;
  const result = await checkReadiness({
    state: readyState,
    postgresPool: {
      query: async (value) => {
        query = value;
        return { rows: [{ '?column?': 1 }] };
      }
    }
  });
  assert.deepEqual(result, { ready: true, storage: 'postgres' });
  assert.deepEqual(query, { text: 'SELECT 1', query_timeout: 3000 });
});

test('a failed PostgreSQL check marks readiness false without exposing the database error', async () => {
  const result = await checkReadiness({
    state: readyState,
    postgresPool: { query: async () => { throw new Error('private connection detail'); } }
  });
  assert.deepEqual(result, {
    ready: false,
    reason: 'database_unavailable'
  });
  assert.ok(!JSON.stringify(result).includes('private connection detail'));
});

test('a failed persisted write marks readiness false before another database query', async () => {
  let queries = 0;
  const result = await checkReadiness({
    state: readyState,
    postgresPool: { query: async () => { queries += 1; return { rows: [] }; } },
    stateStore: { lastWriteError: new Error('test-only write failure') }
  });
  assert.deepEqual(result, {
    ready: false,
    reason: 'persistence_write_failed'
  });
  assert.equal(queries, 0);
});
