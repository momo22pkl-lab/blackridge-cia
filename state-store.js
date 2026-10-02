'use strict';

const CREATE_TABLE_SQL = 'CREATE TABLE IF NOT EXISTS blackridge_app_state (id SMALLINT PRIMARY KEY CHECK (id = 1), data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())';
const SELECT_STATE_SQL = 'SELECT data FROM blackridge_app_state WHERE id = 1';
const SEED_STATE_SQL = 'INSERT INTO blackridge_app_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO NOTHING';
const UPSERT_STATE_SQL = 'INSERT INTO blackridge_app_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at';

class PostgresStateStore {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required.');
    this.pool = pool;
    this.writeQueue = Promise.resolve();
    this.lastWriteError = null;
  }

  async load(options) {
    const { initialState, getLegacyState, normalizeState } = options || {};
    if (typeof normalizeState !== 'function') throw new TypeError('normalizeState must be a function.');

    await this.pool.query(CREATE_TABLE_SQL);
    let result = await this.pool.query(SELECT_STATE_SQL);
    if (result.rows && result.rows.length) return normalizeState(this.decode(result.rows[0].data));

    const legacyState = typeof getLegacyState === 'function' ? await getLegacyState() : null;
    const seed = normalizeState(legacyState === null || legacyState === undefined ? initialState : legacyState);
    const serialized = JSON.stringify(seed);
    if (typeof serialized !== 'string') throw new Error('Initial state is not JSON serializable.');
    await this.pool.query(SEED_STATE_SQL, [serialized]);

    result = await this.pool.query(SELECT_STATE_SQL);
    if (!result.rows || !result.rows.length) throw new Error('PostgreSQL state row could not be initialized.');
    return normalizeState(this.decode(result.rows[0].data));
  }

  decode(value) {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  save(state) {
    const serialized = JSON.stringify(state);
    if (typeof serialized !== 'string') return Promise.reject(new Error('Application state is not JSON serializable.'));

    const write = this.writeQueue.catch(() => undefined).then(() => this.pool.query(UPSERT_STATE_SQL, [serialized]));
    this.writeQueue = write;
    write.then(
      () => { this.lastWriteError = null; },
      (error) => { this.lastWriteError = error; }
    );
    write.catch(() => undefined);
    return write;
  }

  async flush() {
    await this.writeQueue;
    if (this.lastWriteError) throw this.lastWriteError;
  }
}

module.exports = { PostgresStateStore };
