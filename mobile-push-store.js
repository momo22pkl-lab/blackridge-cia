'use strict';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth_key TEXT NOT NULL,
    expiration_time BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user ON web_push_subscriptions (user_id)'
];

const PUSH_ENDPOINT_HOSTS = Object.freeze([
  'fcm.googleapis.com',
  'push.apple.com',
  'push.services.mozilla.com',
  'wns.windows.com'
]);

function normalizePushEndpoint(value) {
  const endpoint = String(value == null ? '' : value).trim();
  if (!endpoint || endpoint.length > 2048) return '';
  try {
    const parsed = new URL(endpoint);
    const host = parsed.hostname.toLowerCase();
    const allowedHost = PUSH_ENDPOINT_HOSTS.some((domain) => host === domain || host.endsWith('.' + domain));
    if (parsed.protocol !== 'https:' || !allowedHost || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch (_error) {
    return '';
  }
}

function normalizePushSubscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const endpoint = normalizePushEndpoint(value.endpoint);
  const p256dh = String(value.keys?.p256dh || '').trim();
  const auth = String(value.keys?.auth || '').trim();
  if (!endpoint || !/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || p256dh.length > 256 ||
      !/^[A-Za-z0-9_-]+={0,2}$/.test(auth) || auth.length > 128) {
    return null;
  }
  const expirationTime = value.expirationTime == null
    ? null
    : Number.isFinite(Number(value.expirationTime)) && Number(value.expirationTime) > 0
      ? Math.floor(Number(value.expirationTime))
      : null;
  return { endpoint, p256dh, auth, expirationTime };
}

function rowToRecord(row) {
  const subscription = normalizePushSubscription({
    endpoint: row.endpoint,
    expirationTime: row.expiration_time ?? row.expirationTime ?? null,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth_key ?? row.auth
    }
  });
  if (!subscription) return null;
  return {
    userId: String(row.user_id ?? row.userId ?? ''),
    subscription: {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth }
    }
  };
}

class WebPushStore {
  constructor(pool = null, fallback = {}) {
    this.pool = pool;
    this.getRows = typeof fallback.getRows === 'function' ? fallback.getRows : () => [];
    this.setRows = typeof fallback.setRows === 'function' ? fallback.setRows : () => {};
  }

  async initialize() {
    if (!this.pool) return;
    await this.pool.query(CREATE_TABLE_SQL);
    for (const sql of INDEX_SQL) await this.pool.query(sql);
  }

  async saveSubscription(userId, value) {
    const id = String(userId == null ? '' : userId).trim();
    const subscription = normalizePushSubscription(value);
    if (!id || !subscription) throw new Error('A valid user and push subscription are required.');

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO web_push_subscriptions (endpoint, user_id, p256dh, auth_key, expiration_time)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth_key = EXCLUDED.auth_key,
           expiration_time = EXCLUDED.expiration_time,
           updated_at = NOW()`,
        [subscription.endpoint, id, subscription.p256dh, subscription.auth, subscription.expirationTime]
      );
      return true;
    }

    const rows = Array.isArray(this.getRows()) ? this.getRows().slice() : [];
    const next = {
      userId: id,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      expirationTime: subscription.expirationTime,
      updatedAt: new Date().toISOString()
    };
    const index = rows.findIndex((row) => row && row.endpoint === subscription.endpoint);
    if (index >= 0) rows[index] = { ...rows[index], ...next };
    else rows.push(next);
    await this.setRows(rows);
    return true;
  }

  async removeSubscription(userId, endpointValue) {
    const id = String(userId == null ? '' : userId).trim();
    const endpoint = normalizePushEndpoint(endpointValue);
    if (!id || !endpoint) return false;

    if (this.pool) {
      const result = await this.pool.query(
        'DELETE FROM web_push_subscriptions WHERE user_id = $1 AND endpoint = $2',
        [id, endpoint]
      );
      return Number(result.rowCount || 0) > 0;
    }

    const rows = Array.isArray(this.getRows()) ? this.getRows() : [];
    const next = rows.filter((row) => !(row && row.userId === id && row.endpoint === endpoint));
    if (next.length === rows.length) return false;
    await this.setRows(next);
    return true;
  }

  async removeExpiredSubscription(userId, endpointValue) {
    return this.removeSubscription(userId, endpointValue);
  }

  async listForUsers(userIds) {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : [])
      .map((value) => String(value == null ? '' : value).trim())
      .filter(Boolean))];
    if (!ids.length) return [];

    let rows;
    if (this.pool) {
      const result = await this.pool.query(
        `SELECT user_id, endpoint, p256dh, auth_key, expiration_time
         FROM web_push_subscriptions
         WHERE user_id = ANY($1::text[])`,
        [ids]
      );
      rows = result.rows || [];
    } else {
      const wanted = new Set(ids);
      rows = (Array.isArray(this.getRows()) ? this.getRows() : [])
        .filter((row) => row && wanted.has(String(row.userId || '')))
        .map((row) => ({
          user_id: row.userId,
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth_key: row.auth,
          expiration_time: row.expirationTime
        }));
    }

    return rows.map(rowToRecord).filter(Boolean);
  }
}

module.exports = {
  CREATE_TABLE_SQL,
  INDEX_SQL,
  PUSH_ENDPOINT_HOSTS,
  normalizePushEndpoint,
  normalizePushSubscription,
  WebPushStore
};
