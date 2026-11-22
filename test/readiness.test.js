'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { checkReadiness, createReadinessReporter } = require('../state-store');

const readyState = { cia_users: [] };

test('readiness stays false until application state is initialized', async () => {
  assert.deepEqual(await checkReadiness({ state: null }), {
    ready: false,
    system: 'application-state',
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
    system: 'postgresql',
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

test('a failed PostgreSQL check identifies the system and safe error code only', async () => {
  const result = await checkReadiness({
    state: readyState,
    postgresPool: {
      query: async () => {
        const error = new Error('private connection detail');
        error.code = 'ECONNREFUSED';
        throw error;
      }
    }
  });
  assert.deepEqual(result, {
    ready: false,
    system: 'postgresql',
    reason: 'database_unavailable',
    code: 'ECONNREFUSED'
  });
  assert.ok(!JSON.stringify(result).includes('private connection detail'));
});

test('a failed persisted write remains unready after a successful connection probe', async () => {
  let queries = 0;
  const result = await checkReadiness({
    state: readyState,
    postgresPool: { query: async () => { queries += 1; return { rows: [] }; } },
    stateStore: { lastWriteError: Object.assign(new Error('test-only write failure'), { code: '40001' }) }
  });
  assert.deepEqual(result, {
    ready: false,
    system: 'postgresql-persistence',
    reason: 'persistence_write_failed',
    code: '40001'
  });
  assert.equal(queries, 1);
});

test('readiness logs one failure and a recovery transition without repeating probe noise', () => {
  const entries = [];
  const report = createReadinessReporter({
    logger: {
      error: (message) => entries.push(['error', message]),
      info: (message) => entries.push(['info', message])
    }
  });

  const failed = {
    ready: false,
    system: 'postgresql',
    reason: 'database_unavailable',
    code: 'ECONNREFUSED'
  };
  report(failed);
  report(failed);
  report({ ready: true, storage: 'postgres' });

  assert.deepEqual(entries.map(([level]) => level), ['error', 'info']);
  assert.match(entries[0][1], /system=postgresql reason=database_unavailable code=ECONNREFUSED/);
  assert.match(entries[1][1], /Readiness recovered: system=application storage=postgres/);
  assert.ok(!entries.some(([, message]) => message.includes('private connection detail')));
});

test('both public health routes use the same readiness response handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /app\.get\('\/health',\s*healthHandler\)/);
  assert.match(source, /app\.get\('\/api\/health',\s*healthHandler\)/);
  assert.match(source, /res\.status\(ready \? 200 : 503\)\.json/);
});

test('Render does not start core services without durable PostgreSQL state', async (t) => {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '0',
      DATABASE_URL: '',
      RENDER: 'true',
      RENDER_SERVICE_ID: 'readiness-test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Render startup did not fail closed in time.')), 5000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  assert.equal(exit.code, 1);
  assert.match(output, /DATABASE_URL_REQUIRED|requires DATABASE_URL/);
  assert.doesNotMatch(output, /STATUS: ONLINE|LOGIN \/ LEADERSHIP \/ RADIO \/ SOS: READY/);
});
