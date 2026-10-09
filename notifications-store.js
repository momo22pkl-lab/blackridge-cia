'use strict';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'NOTICE',
    status TEXT NOT NULL DEFAULT 'SENT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    source_user_id TEXT,
    source_code TEXT,
    related_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  )
`;

const INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications (user_id)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications (read_at)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_priority ON notifications (priority)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications (type)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL'
];

const OFFICIAL_WARNING_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS official_warnings (
    warning_id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL UNIQUE REFERENCES notifications(id) ON DELETE RESTRICT,
    recipient_user_id TEXT NOT NULL,
    issuer_user_id TEXT NOT NULL,
    warning_type TEXT NOT NULL,
    content TEXT NOT NULL,
    allow_justification BOOLEAN NOT NULL DEFAULT FALSE,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_official_warnings_recipient_issued
    ON official_warnings (recipient_user_id, issued_at DESC, warning_id DESC);
  CREATE INDEX IF NOT EXISTS idx_official_warnings_issuer_issued
    ON official_warnings (issuer_user_id, issued_at DESC, warning_id DESC);
  CREATE TABLE IF NOT EXISTS official_warning_responses (
    warning_id TEXT PRIMARY KEY REFERENCES official_warnings(warning_id) ON DELETE RESTRICT,
    notification_id TEXT NOT NULL UNIQUE REFERENCES notifications(id) ON DELETE RESTRICT,
    responder_user_id TEXT NOT NULL,
    issuer_user_id TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_official_warning_responses_issuer_created
    ON official_warning_responses (issuer_user_id, created_at DESC, warning_id DESC)
`;

const BACKFILL_OFFICIAL_WARNINGS_SQL = `
  INSERT INTO official_warnings
    (warning_id, notification_id, recipient_user_id, issuer_user_id, warning_type, content, allow_justification, issued_at, read_at)
  SELECT warning_id, notification_id, recipient_user_id, issuer_user_id, warning_type, content, allow_justification, issued_at, read_at
  FROM (
    SELECT DISTINCT ON (warning_id)
      COALESCE(NULLIF(n.metadata->>'warningId', ''), NULLIF(n.related_id, ''), n.id) AS warning_id,
      n.id AS notification_id,
      n.user_id AS recipient_user_id,
      COALESCE(NULLIF(n.metadata->>'issuerId', ''), NULLIF(n.source_user_id, ''), 'legacy-unknown') AS issuer_user_id,
      COALESCE(NULLIF(n.metadata->>'warningType', ''), 'أخرى') AS warning_type,
      COALESCE(NULLIF(n.metadata->>'warningContent', ''), n.message, '') AS content,
      lower(COALESCE(n.metadata->>'allowJustification', 'false')) = 'true' AS allow_justification,
      n.created_at AS issued_at,
      n.read_at
    FROM notifications n
    WHERE n.type = 'WARNING'
    ORDER BY warning_id, n.created_at ASC, n.id ASC
  ) legacy_warnings
  ON CONFLICT (warning_id) DO NOTHING
`;

const BACKFILL_OFFICIAL_WARNING_RESPONSES_SQL = `
  INSERT INTO official_warning_responses
    (warning_id, notification_id, responder_user_id, issuer_user_id, response, created_at)
  SELECT warning_id, notification_id, responder_user_id, issuer_user_id, response, created_at
  FROM (
    SELECT DISTINCT ON (w.warning_id)
      w.warning_id,
      n.id AS notification_id,
      COALESCE(NULLIF(n.source_user_id, ''), 'legacy-unknown') AS responder_user_id,
      n.user_id AS issuer_user_id,
      COALESCE(NULLIF(n.metadata->>'responseText', ''), n.message, '') AS response,
      n.created_at
    FROM notifications n
    JOIN official_warnings w
      ON w.warning_id = COALESCE(NULLIF(n.metadata->>'warningId', ''), NULLIF(n.related_id, ''))
    WHERE n.type = 'WARNING_RESPONSE'
    ORDER BY w.warning_id, n.created_at ASC, n.id ASC
  ) legacy_responses
  ON CONFLICT (warning_id) DO NOTHING
`;

function warningConflict(message) {
  const error = new Error(message);
  error.code = 'BLACKRIDGE_WARNING_CONFLICT';
  return error;
}

const CATEGORY_SQL = Object.freeze({
  all: '',
  critical: " AND priority = 'CRITICAL'",
  messages: " AND type = 'MESSAGE'",
  sos: " AND type = 'SOS'",
  operations: " AND type = 'OPERATION'",
  finance: " AND type IN ('SALARY', 'TRANSACTION', 'FINANCE')",
  system: " AND type IN ('CASE', 'REPORT', 'PROFILE', 'RANK', 'PERMISSION', 'REQUEST', 'LOGIN', 'SECURITY', 'SYSTEM', 'WARNING', 'WARNING_RESPONSE')"
});

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toClientRow(row) {
  if (!row) return null;
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    message: row.message,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    acknowledgedAt: row.acknowledged_at,
    sourceUserId: row.source_user_id,
    sourceCode: row.source_code,
    sourceUser: row.source_user_id
      ? { id: row.source_user_id, code: row.source_code, name: metadata.sourceName || null }
      : null,
    relatedId: row.related_id,
    metadata
  };
}

function boundedLimit(value) {
  return Math.max(1, Math.min(50, Math.floor(number(value) || 20)));
}

function boundedOffset(value) {
  return Math.max(0, Math.min(1000000, Math.floor(number(value) || 0)));
}

function cleanRecord(record) {
  const type = String(record.type || 'SYSTEM').toUpperCase().slice(0, 40);
  return {
    id: String(record.id || ''),
    user_id: String(record.userId || ''),
    type,
    title: String(record.title || '').slice(0, 180),
    message: String(record.message || '').slice(0, ['WARNING', 'WARNING_RESPONSE'].includes(type) ? 3000 : 1000),
    priority: ['CRITICAL', 'HIGH', 'NOTICE', 'SYSTEM'].includes(String(record.priority || '').toUpperCase())
      ? String(record.priority).toUpperCase()
      : 'NOTICE',
    status: record.status === 'DELIVERED' ? 'DELIVERED' : 'SENT',
    source_user_id: record.sourceUserId ? String(record.sourceUserId).slice(0, 120) : null,
    source_code: record.sourceCode ? String(record.sourceCode).slice(0, 100) : null,
    related_id: record.relatedId ? String(record.relatedId).slice(0, 200) : null,
    metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata
      : {}
  };
}

class NotificationsStore {
  constructor(pool, fallback = {}) {
    this.pool = pool || null;
    this.getFallbackRows = typeof fallback.getRows === 'function' ? fallback.getRows : () => [];
    this.setFallbackRows = typeof fallback.setRows === 'function' ? fallback.setRows : () => {};
  }

  async initialize() {
    if (!this.pool) return;
    await this.pool.query(CREATE_TABLE_SQL);
    for (const sql of INDEX_SQL) await this.pool.query(sql);
    await this.pool.query(OFFICIAL_WARNING_SCHEMA_SQL);
    await this.pool.query(BACKFILL_OFFICIAL_WARNINGS_SQL);
    await this.pool.query(BACKFILL_OFFICIAL_WARNING_RESPONSES_SQL);
  }

  async withTransaction(callback) {
    const client = typeof this.pool.connect === 'function' ? await this.pool.connect() : this.pool;
    const transactional = client !== this.pool;
    try {
      if (transactional) await client.query('BEGIN');
      const result = await callback(client);
      if (transactional) await client.query('COMMIT');
      return result;
    } catch (error) {
      if (transactional) {
        try { await client.query('ROLLBACK'); } catch (_rollbackError) {}
      }
      throw error;
    } finally {
      if (transactional && typeof client.release === 'function') client.release();
    }
  }

  async persistOfficialWarningRecord(client, row) {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const warningId = String(metadata.warningId || row.related_id || '');
    const issuerId = String(metadata.issuerId || row.source_user_id || '');
    if (!warningId || !row.user_id || !issuerId) {
      throw warningConflict('Official warning is missing its recipient, issuer, or identifier.');
    }
    const result = await client.query(
      `INSERT INTO official_warnings
        (warning_id, notification_id, recipient_user_id, issuer_user_id, warning_type, content, allow_justification, issued_at, read_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (warning_id) DO NOTHING
       RETURNING warning_id`,
      [
        warningId,
        row.id,
        row.user_id,
        issuerId,
        String(metadata.warningType || 'أخرى').slice(0, 40),
        String(metadata.warningContent || row.message || '').slice(0, 3000),
        metadata.allowJustification === true,
        row.created_at,
        row.read_at || null
      ]
    );
    if (!result.rows?.length) throw warningConflict('This official warning already exists.');
  }

  async persistOfficialWarningResponse(client, row) {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const warningId = String(metadata.warningId || row.related_id || '');
    if (!warningId || !row.user_id || !row.source_user_id) {
      throw warningConflict('Official warning response is missing its warning, recipient, or sender.');
    }

    const warningResult = await client.query(
      `SELECT warning_id, recipient_user_id, issuer_user_id, allow_justification
       FROM official_warnings WHERE warning_id = $1 FOR UPDATE`,
      [warningId]
    );
    const warning = warningResult.rows?.[0];
    if (!warning ||
        warning.recipient_user_id !== row.source_user_id ||
        warning.issuer_user_id !== row.user_id ||
        warning.allow_justification !== true) {
      throw warningConflict('The official warning does not permit this response.');
    }

    const inserted = await client.query(
      `INSERT INTO official_warning_responses
        (warning_id, notification_id, responder_user_id, issuer_user_id, response, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (warning_id) DO NOTHING
       RETURNING warning_id`,
      [
        warningId,
        row.id,
        row.source_user_id,
        row.user_id,
        String(metadata.responseText || row.message || '').slice(0, 3000),
        row.created_at
      ]
    );
    if (!inserted.rows?.length) throw warningConflict('A response has already been recorded for this official warning.');
  }

  async createMany(records) {
    const safeRecords = (Array.isArray(records) ? records : [])
      .map(cleanRecord)
      .filter((record) => record.id && record.user_id && record.title);
    if (!safeRecords.length) return [];

    if (this.pool) {
      try {
        return await this.withTransaction(async (client) => {
          const result = await client.query(
            `INSERT INTO notifications
              (id, user_id, type, title, message, priority, status, created_at, delivered_at,
               source_user_id, source_code, related_id, metadata)
             SELECT n.id, n.user_id, n.type, n.title, n.message, n.priority, n.status, NOW(),
                    CASE WHEN n.status = 'DELIVERED' THEN NOW() ELSE NULL END,
                    n.source_user_id, n.source_code, n.related_id, COALESCE(n.metadata, '{}'::jsonb)
             FROM jsonb_to_recordset($1::jsonb) AS n(
               id TEXT, user_id TEXT, type TEXT, title TEXT, message TEXT, priority TEXT, status TEXT,
               source_user_id TEXT, source_code TEXT, related_id TEXT, metadata JSONB
             )
             RETURNING *`,
            [JSON.stringify(safeRecords)]
          );
          for (const row of result.rows || []) {
            if (row.type === 'WARNING') await this.persistOfficialWarningRecord(client, row);
            if (row.type === 'WARNING_RESPONSE') await this.persistOfficialWarningResponse(client, row);
          }
          return (result.rows || []).map(toClientRow);
        });
      } catch (error) {
        if (error.code === 'BLACKRIDGE_WARNING_CONFLICT') return [];
        throw error;
      }
    }

    const stamp = new Date().toISOString();
    const additions = safeRecords.map((record) => ({
      id: record.id,
      userId: record.user_id,
      type: record.type,
      title: record.title,
      message: record.message,
      priority: record.priority,
      status: record.status,
      createdAt: stamp,
      deliveredAt: record.status === 'DELIVERED' ? stamp : null,
      readAt: null,
      acknowledgedAt: null,
      sourceUserId: record.source_user_id,
      sourceCode: record.source_code,
      sourceUser: record.source_user_id
        ? { id: record.source_user_id, code: record.source_code, name: record.metadata.sourceName || null }
        : null,
      relatedId: record.related_id,
      metadata: record.metadata
    }));
    const rows = [...additions, ...(this.getFallbackRows() || [])].slice(0, 10000);
    this.setFallbackRows(rows);
    return additions;
  }

  async listForUser(options = {}) {
    const userId = String(options.userId || '');
    if (!userId) return { rows: [], hasMore: false };
    const limit = boundedLimit(options.limit);
    const offset = boundedOffset(options.offset);
    const category = String(options.category || 'all').toLowerCase();
    const search = String(options.search || '').trim().slice(0, 120);
    const priority = String(options.priority || '').toUpperCase();
    const type = String(options.type || '').toUpperCase();
    const since = options.since ? new Date(options.since) : null;

    if (this.pool) {
      const values = [userId];
      let where = 'user_id = $1';
      if (CATEGORY_SQL[category]) where += CATEGORY_SQL[category];
      if (category !== 'all' && !Object.prototype.hasOwnProperty.call(CATEGORY_SQL, category)) {
        return { rows: [], hasMore: false };
      }
      if (priority) {
        values.push(priority);
        where += ` AND priority = $${values.length}`;
      }
      if (type) {
        values.push(type);
        where += ` AND type = $${values.length}`;
      }
      if (search) {
        values.push(`%${search}%`);
        const index = values.length;
        where += ` AND (title ILIKE $${index} OR message ILIKE $${index} OR type ILIKE $${index} OR COALESCE(source_code, '') ILIKE $${index} OR COALESCE(related_id, '') ILIKE $${index} OR COALESCE(metadata::text, '') ILIKE $${index} OR created_at::text ILIKE $${index})`;
      }
      if (since && Number.isFinite(since.getTime())) {
        values.push(since.toISOString());
        where += ` AND created_at >= $${values.length}`;
      }
      values.push(limit + 1, offset);
      const result = await this.pool.query(
        `SELECT * FROM notifications WHERE ${where}
         ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
      );
      const mapped = (result.rows || []).map(toClientRow);
      return { rows: mapped.slice(0, limit), hasMore: mapped.length > limit };
    }

    const allRows = (this.getFallbackRows() || [])
      .filter((row) => row.userId === userId)
      .filter((row) => category === 'all' || this.fallbackMatchesCategory(row, category))
      .filter((row) => !priority || row.priority === priority)
      .filter((row) => !type || row.type === type)
      .filter((row) => !search || [row.title, row.message, row.type, row.sourceCode, row.relatedId, JSON.stringify(row.metadata || {}), row.createdAt]
        .some((value) => String(value || '').toLowerCase().includes(search.toLowerCase())))
      .filter((row) => !since || !Number.isFinite(since.getTime()) || new Date(row.createdAt).getTime() >= since.getTime())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const page = allRows.slice(offset, offset + limit + 1);
    return { rows: page.slice(0, limit), hasMore: page.length > limit };
  }

  async listWarningsForUser(options = {}) {
    const userId = String(options.userId || '');
    if (!userId) return { rows: [], hasMore: false };
    const limit = boundedLimit(options.limit);
    const offset = boundedOffset(options.offset);
    if (this.pool) {
      const result = await this.pool.query(
        `SELECT n.* FROM official_warnings w
         JOIN notifications n ON n.id = w.notification_id
         WHERE w.recipient_user_id = $1 AND n.user_id = $1 AND n.type = 'WARNING'
         ORDER BY w.issued_at DESC, w.warning_id DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset]
      );
      const mapped = (result.rows || []).map(toClientRow);
      return { rows: mapped.slice(0, limit), hasMore: mapped.length > limit };
    }
    return this.listForUser({ ...options, type: 'WARNING' });
  }

  async listWarningResponsesForIssuer(options = {}) {
    const userId = String(options.userId || '');
    if (!userId) return { rows: [], hasMore: false };
    const limit = boundedLimit(options.limit);
    const offset = boundedOffset(options.offset);
    if (this.pool) {
      const result = await this.pool.query(
        `SELECT n.* FROM official_warning_responses r
         JOIN notifications n ON n.id = r.notification_id
         WHERE r.issuer_user_id = $1 AND n.user_id = $1 AND n.type = 'WARNING_RESPONSE'
         ORDER BY r.created_at DESC, r.warning_id DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset]
      );
      const mapped = (result.rows || []).map(toClientRow);
      return { rows: mapped.slice(0, limit), hasMore: mapped.length > limit };
    }
    return this.listForUser({ userId, type: 'WARNING_RESPONSE', limit, offset });
  }

  async listOfficialWarnings(options = {}) {
    const limit = boundedLimit(options.limit);
    const offset = boundedOffset(options.offset);
    if (this.pool) {
      const result = await this.pool.query(
        `SELECT n.* FROM official_warnings w
         JOIN notifications n ON n.id = w.notification_id
         WHERE n.type = 'WARNING'
         ORDER BY w.issued_at DESC, w.warning_id DESC
         LIMIT $1 OFFSET $2`,
        [limit + 1, offset]
      );
      const mapped = (result.rows || []).map(toClientRow);
      return { rows: mapped.slice(0, limit), hasMore: mapped.length > limit };
    }
    const allRows = (this.getFallbackRows() || [])
      .filter((row) => row.type === 'WARNING')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const page = allRows.slice(offset, offset + limit + 1);
    return { rows: page.slice(0, limit), hasMore: page.length > limit };
  }

  async setOfficialWarningJustification(warningId, allowJustification) {
    const id = String(warningId || '');
    if (!id) return null;
    if (this.pool) {
      return this.withTransaction(async (client) => {
        const warning = await client.query(
          'SELECT notification_id FROM official_warnings WHERE warning_id = $1 FOR UPDATE',
          [id]
        );
        if (!warning.rows?.length) return null;
        await client.query(
          'UPDATE official_warnings SET allow_justification = $2 WHERE warning_id = $1',
          [id, allowJustification === true]
        );
        const result = await client.query(
          `UPDATE notifications
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{allowJustification}', to_jsonb($2::boolean), true)
           WHERE id = $1 AND type = 'WARNING'
           RETURNING *`,
          [warning.rows[0].notification_id, allowJustification === true]
        );
        return toClientRow(result.rows?.[0]);
      });
    }
    let updated = null;
    const rows = (this.getFallbackRows() || []).map((row) => {
      if (row.type !== 'WARNING' || row.relatedId !== id) return row;
      updated = {
        ...row,
        metadata: { ...(row.metadata || {}), allowJustification: allowJustification === true }
      };
      return updated;
    });
    if (updated) this.setFallbackRows(rows);
    return updated;
  }

  fallbackMatchesCategory(row, category) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORY_SQL, category)) return false;
    if (category === 'critical') return row.priority === 'CRITICAL';
    if (category === 'messages') return row.type === 'MESSAGE';
    if (category === 'sos') return row.type === 'SOS';
    if (category === 'operations') return row.type === 'OPERATION';
    if (category === 'finance') return ['SALARY', 'TRANSACTION', 'FINANCE'].includes(row.type);
    if (category === 'system') return ['CASE', 'REPORT', 'PROFILE', 'RANK', 'PERMISSION', 'REQUEST', 'LOGIN', 'SECURITY', 'SYSTEM', 'WARNING', 'WARNING_RESPONSE'].includes(row.type);
    return category === 'all';
  }

  async countsForUser(userId) {
    const ownId = String(userId || '');
    const empty = { all: 0, critical: 0, messages: 0, sos: 0, operations: 0, finance: 0, system: 0, unread: 0, unreadCritical: 0, unreadSecurity: 0 };
    if (!ownId) return empty;

    if (this.pool) {
      const result = await this.pool.query(
        `SELECT
           COUNT(*)::int AS "all",
           COUNT(*) FILTER (WHERE priority = 'CRITICAL')::int AS critical,
           COUNT(*) FILTER (WHERE type = 'MESSAGE')::int AS messages,
           COUNT(*) FILTER (WHERE type = 'SOS')::int AS sos,
           COUNT(*) FILTER (WHERE type = 'OPERATION')::int AS operations,
           COUNT(*) FILTER (WHERE type IN ('SALARY', 'TRANSACTION', 'FINANCE'))::int AS finance,
           COUNT(*) FILTER (WHERE type IN ('CASE', 'REPORT', 'PROFILE', 'RANK', 'PERMISSION', 'REQUEST', 'LOGIN', 'SECURITY', 'SYSTEM', 'WARNING', 'WARNING_RESPONSE'))::int AS system,
           COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread,
            COUNT(*) FILTER (WHERE read_at IS NULL AND priority = 'CRITICAL')::int AS "unreadCritical",
            COUNT(*) FILTER (WHERE read_at IS NULL AND type = 'SECURITY')::int AS "unreadSecurity"
         FROM notifications WHERE user_id = $1`,
        [ownId]
      );
      const row = result.rows?.[0] || {};
      return Object.fromEntries(Object.keys(empty).map((key) => [key, number(row[key])]));
    }

    const rows = (this.getFallbackRows() || []).filter((row) => row.userId === ownId);
    return {
      all: rows.length,
      critical: rows.filter((row) => row.priority === 'CRITICAL').length,
      messages: rows.filter((row) => row.type === 'MESSAGE').length,
      sos: rows.filter((row) => row.type === 'SOS').length,
      operations: rows.filter((row) => row.type === 'OPERATION').length,
      finance: rows.filter((row) => ['SALARY', 'TRANSACTION', 'FINANCE'].includes(row.type)).length,
      system: rows.filter((row) => this.fallbackMatchesCategory(row, 'system')).length,
      unread: rows.filter((row) => !row.readAt).length,
      unreadCritical: rows.filter((row) => !row.readAt && row.priority === 'CRITICAL').length,
      unreadSecurity: rows.filter((row) => !row.readAt && row.type === 'SECURITY').length
    };
  }

  async summarySince(userId, since) {
    const ownId = String(userId || '');
    const start = since ? new Date(since) : null;
    if (!ownId || !start || !Number.isFinite(start.getTime())) {
      return { since: start && Number.isFinite(start.getTime()) ? start.toISOString() : null, total: 0, attention: 0, byType: {} };
    }

    if (this.pool) {
      const result = await this.pool.query(
        `SELECT type, COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE priority IN ('CRITICAL', 'HIGH') AND acknowledged_at IS NULL)::int AS attention
         FROM notifications WHERE user_id = $1 AND created_at >= $2
         GROUP BY type`,
        [ownId, start.toISOString()]
      );
      const byType = {};
      let total = 0;
      let attention = 0;
      for (const row of result.rows || []) {
        const count = number(row.total);
        byType[row.type] = count;
        total += count;
        attention += number(row.attention);
      }
      return { since: start.toISOString(), total, attention, byType };
    }

    const rows = (this.getFallbackRows() || []).filter((row) =>
      row.userId === ownId && new Date(row.createdAt).getTime() >= start.getTime()
    );
    const byType = {};
    for (const row of rows) byType[row.type] = (byType[row.type] || 0) + 1;
    return {
      since: start.toISOString(),
      total: rows.length,
      attention: rows.filter((row) => ['CRITICAL', 'HIGH'].includes(row.priority) && !row.acknowledgedAt).length,
      byType
    };
  }

  async markDelivered(userId) {
    const ownId = String(userId || '');
    if (!ownId) return 0;
    if (this.pool) {
      const result = await this.pool.query(
        `UPDATE notifications
         SET status = 'DELIVERED', delivered_at = COALESCE(delivered_at, NOW())
         WHERE user_id = $1 AND status = 'SENT'
         RETURNING id`,
        [ownId]
      );
      return (result.rows || []).length;
    }
    const stamp = new Date().toISOString();
    let changed = 0;
    const rows = (this.getFallbackRows() || []).map((row) => {
      if (row.userId !== ownId || row.status !== 'SENT') return row;
      changed += 1;
      return { ...row, status: 'DELIVERED', deliveredAt: row.deliveredAt || stamp };
    });
    if (changed) this.setFallbackRows(rows);
    return changed;
  }

  async markRead(userId, id) {
    if (this.pool) {
      return this.withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE notifications
           SET read_at = COALESCE(read_at, NOW()),
               status = CASE WHEN status = 'ACKNOWLEDGED' THEN status ELSE 'SEEN' END
           WHERE user_id = $1 AND id = $2
           RETURNING *`,
          [String(userId || ''), String(id || '')]
        );
        const row = result.rows?.[0];
        if (row?.type === 'WARNING') {
          await client.query(
            'UPDATE official_warnings SET read_at = COALESCE(read_at, $2) WHERE notification_id = $1',
            [row.id, row.read_at]
          );
        }
        return toClientRow(row);
      });
    }
    return this.updateFallback(userId, (row) => row.id === String(id || ''), (row, stamp) => {
      row.readAt = row.readAt || stamp;
      if (row.status !== 'ACKNOWLEDGED') row.status = 'SEEN';
    });
  }

  async markAllRead(userId) {
    if (this.pool) {
      return this.withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE notifications
           SET read_at = COALESCE(read_at, NOW()),
               status = CASE WHEN status = 'ACKNOWLEDGED' THEN status ELSE 'SEEN' END
           WHERE user_id = $1 AND read_at IS NULL
           RETURNING id`,
          [String(userId || '')]
        );
        if (result.rows?.length) {
          await client.query(
            `UPDATE official_warnings w
             SET read_at = COALESCE(w.read_at, n.read_at)
             FROM notifications n
             WHERE n.id = w.notification_id AND n.user_id = $1 AND n.read_at IS NOT NULL`,
            [String(userId || '')]
          );
        }
        return (result.rows || []).length;
      });
    }
    const ownId = String(userId || '');
    const stamp = new Date().toISOString();
    let changed = 0;
    const rows = (this.getFallbackRows() || []).map((row) => {
      if (row.userId !== ownId || row.readAt) return row;
      changed += 1;
      return { ...row, readAt: stamp, status: row.status === 'ACKNOWLEDGED' ? row.status : 'SEEN' };
    });
    this.setFallbackRows(rows);
    return changed;
  }

  async acknowledge(userId, id) {
    if (this.pool) {
      const result = await this.pool.query(
        `UPDATE notifications
         SET acknowledged_at = COALESCE(acknowledged_at, NOW()),
             read_at = COALESCE(read_at, NOW()),
             status = 'ACKNOWLEDGED'
         WHERE user_id = $1 AND id = $2 AND priority = 'CRITICAL'
         RETURNING *`,
        [String(userId || ''), String(id || '')]
      );
      return toClientRow(result.rows?.[0]);
    }
    return this.updateFallback(userId, (row) => row.id === String(id || '') && row.priority === 'CRITICAL', (row, stamp) => {
      row.acknowledgedAt = row.acknowledgedAt || stamp;
      row.readAt = row.readAt || stamp;
      row.status = 'ACKNOWLEDGED';
    });
  }

  updateFallback(userId, predicate, update) {
    const ownId = String(userId || '');
    const stamp = new Date().toISOString();
    let updated = null;
    const rows = (this.getFallbackRows() || []).map((item) => {
      if (item.userId !== ownId || !predicate(item)) return item;
      const row = { ...item };
      update(row, stamp);
      updated = row;
      return row;
    });
    if (updated) this.setFallbackRows(rows);
    return updated;
  }
}

module.exports = {
  NotificationsStore,
  CREATE_TABLE_SQL,
  INDEX_SQL,
  OFFICIAL_WARNING_SCHEMA_SQL,
  BACKFILL_OFFICIAL_WARNINGS_SQL,
  BACKFILL_OFFICIAL_WARNING_RESPONSES_SQL
};