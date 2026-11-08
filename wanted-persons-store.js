'use strict';

const crypto = require('node:crypto');

const SEVERITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const STATUSES = Object.freeze(['WANTED', 'UNDER_INVESTIGATION', 'DETAINED', 'CLOSED']);
const SELECT_COLUMNS = 'id, file_number, full_name, aliases, image_url, severity, status, case_ids, notes, details, created_by_user_id, updated_by_user_id, created_at, updated_at';

const SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS blackridge_wanted_persons (id TEXT PRIMARY KEY, file_number TEXT NOT NULL, full_name TEXT NOT NULL, aliases JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(aliases) = 'array'), image_url TEXT NOT NULL DEFAULT '', severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')), status TEXT NOT NULL CHECK (status IN ('WANTED', 'UNDER_INVESTIGATION', 'DETAINED', 'CLOSED')), case_ids TEXT[] NOT NULL DEFAULT '{}'::text[], notes TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', created_by_user_id TEXT NOT NULL, updated_by_user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_blackridge_wanted_persons_file_number ON blackridge_wanted_persons (LOWER(file_number))',
  'CREATE INDEX IF NOT EXISTS idx_blackridge_wanted_persons_status_severity_updated ON blackridge_wanted_persons (status, severity, updated_at DESC)',
  "CREATE TABLE IF NOT EXISTS blackridge_wanted_persons_audit (id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES blackridge_wanted_persons(id) ON DELETE RESTRICT, actor_user_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('CREATED', 'UPDATED')), changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changed_fields) = 'array'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  'CREATE INDEX IF NOT EXISTS idx_blackridge_wanted_persons_audit_person_created ON blackridge_wanted_persons_audit (person_id, created_at DESC)'
];

function clean(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function safeImageUrl(value) {
  const input = clean(value, 700);
  if (!input) return '';
  if (input.startsWith('/') && !input.startsWith('//')) return input;
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch (_error) {
    return '';
  }
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    fileNumber: row.file_number,
    fullName: row.full_name,
    aliases: parseArray(row.aliases),
    imageUrl: row.image_url || '',
    severity: row.severity,
    status: row.status,
    caseIds: Array.isArray(row.case_ids) ? row.case_ids : parseArray(row.case_ids),
    notes: row.notes || '',
    details: row.details || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function buildListFilters(filters = {}) {
  const clauses = [];
  const values = [];
  const name = clean(filters.name, 120).toLocaleLowerCase();
  const fileNumber = clean(filters.fileNumber, 64).toLocaleLowerCase();
  const severity = clean(filters.severity, 40).toUpperCase();
  const status = clean(filters.status, 40).toUpperCase();
  if (name) {
    values.push(name);
    clauses.push('POSITION($' + values.length + ' IN LOWER(full_name)) > 0');
  }
  if (fileNumber) {
    values.push(fileNumber);
    clauses.push('POSITION($' + values.length + ' IN LOWER(file_number)) > 0');
  }
  if (severity && SEVERITIES.includes(severity)) {
    values.push(severity);
    clauses.push('severity = $' + values.length);
  }
  if (status && STATUSES.includes(status)) {
    values.push(status);
    clauses.push('status = $' + values.length);
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', values };
}

class WantedPersonsStore {
  constructor(pool, options = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('A PostgreSQL pool with query() and connect() is required.');
    }
    this.pool = pool;
    this.makeId = typeof options.makeId === 'function'
      ? options.makeId
      : (prefix) => prefix + '-' + crypto.randomUUID();
  }

  async initialize() {
    for (const sql of SCHEMA_SQL) await this.pool.query(sql);
  }

  async withTransaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  }

  async list(filters = {}) {
    const filter = buildListFilters(filters);
    const limit = Math.max(1, Math.min(100, Number.isInteger(filters.limit) ? filters.limit : 50));
    const offset = Math.max(0, Math.min(100000, Number.isInteger(filters.offset) ? filters.offset : 0));
    const count = await this.pool.query(
      'SELECT COUNT(*)::INT AS total FROM blackridge_wanted_persons ' + filter.where,
      filter.values
    );
    const result = await this.pool.query(
      'SELECT ' + SELECT_COLUMNS + ' FROM blackridge_wanted_persons ' + filter.where + ' ORDER BY updated_at DESC, file_number ASC LIMIT $' + (filter.values.length + 1) + ' OFFSET $' + (filter.values.length + 2),
      [...filter.values, limit, offset]
    );
    return {
      items: (result.rows || []).map(normalizeRow),
      total: Number(count.rows?.[0]?.total) || 0,
      limit,
      offset
    };
  }

  async get(id) {
    const key = clean(id, 120);
    if (!key) return null;
    const result = await this.pool.query(
      'SELECT ' + SELECT_COLUMNS + ' FROM blackridge_wanted_persons WHERE id = $1',
      [key]
    );
    return normalizeRow(result.rows?.[0]);
  }

  async save({ person = {}, actor = {} } = {}) {
    const actorId = clean(actor.id, 120);
    const id = clean(person.id, 120);
    const fullName = clean(person.fullName, 160);
    const fileNumber = clean(person.fileNumber, 64).toLocaleUpperCase();
    const severity = clean(person.severity, 40).toUpperCase();
    const status = clean(person.status, 40).toUpperCase();
    const originalImage = clean(person.imageUrl, 700);
    const imageUrl = safeImageUrl(originalImage);
    const aliases = Array.isArray(person.aliases)
      ? [...new Set(person.aliases.map((item) => clean(item, 100)).filter(Boolean))]
      : null;
    const caseIds = Array.isArray(person.caseIds)
      ? [...new Set(person.caseIds.map((item) => clean(item, 120)).filter(Boolean))]
      : null;
    const notes = clean(person.notes, 5000);
    const details = clean(person.details, 10000);
    const filePattern = /^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,63}$/u;

    if (!actorId) return { ok: false, message: 'يلزم تسجيل الدخول.' };
    if (id && !/^[A-Za-z0-9._:-]{1,120}$/.test(id)) return { ok: false, message: 'معرّف الملف غير صالح.' };
    if (fullName.length < 2 || String(person.fullName || '').trim().length > 160) return { ok: false, message: 'أدخل اسمًا صحيحًا بحد أقصى 160 حرفًا.' };
    if (!filePattern.test(fileNumber)) return { ok: false, message: 'رقم الملف مطلوب ويجب ألا يتجاوز 64 حرفًا.' };
    if (!aliases || aliases.length > 20 || (Array.isArray(person.aliases) && person.aliases.some((item) => String(item || '').length > 100))) return { ok: false, message: 'تحقق من الأسماء المستعارة (20 اسمًا كحد أقصى).'};
    if (!caseIds || caseIds.length > 1000) return { ok: false, message: 'قائمة القضايا غير صالحة.' };
    if (!SEVERITIES.includes(severity)) return { ok: false, message: 'درجة الخطورة غير صالحة.' };
    if (!STATUSES.includes(status)) return { ok: false, message: 'حالة الملف غير صالحة.' };
    if (originalImage && !imageUrl) return { ok: false, message: 'رابط الصورة يجب أن يكون HTTPS أو مسارًا محليًا آمنًا.' };
    if (String(person.notes || '').length > 5000 || String(person.details || '').length > 10000) return { ok: false, message: 'تجاوزت الملاحظات أو التفاصيل الحد المسموح.' };

    const recordId = id || this.makeId('WANTED');
    const changedFields = ['fileNumber', 'fullName', 'aliases', 'imageUrl', 'severity', 'status', 'caseIds', 'notes', 'details'];
    try {
      return await this.withTransaction(async (client) => {
        let action = 'CREATED';
        let result;
        if (id) {
          const existing = await client.query('SELECT id FROM blackridge_wanted_persons WHERE id = $1 FOR UPDATE', [id]);
          if (!existing.rows?.length) return { ok: false, message: 'ملف المطلوب غير موجود.' };
          action = 'UPDATED';
          result = await client.query(
            'UPDATE blackridge_wanted_persons SET file_number = $2, full_name = $3, aliases = $4::jsonb, image_url = $5, severity = $6, status = $7, case_ids = $8::text[], notes = $9, details = $10, updated_by_user_id = $11, updated_at = NOW() WHERE id = $1 RETURNING ' + SELECT_COLUMNS,
            [id, fileNumber, fullName, JSON.stringify(aliases), imageUrl, severity, status, caseIds, notes, details, actorId]
          );
        } else {
          result = await client.query(
            'INSERT INTO blackridge_wanted_persons (id, file_number, full_name, aliases, image_url, severity, status, case_ids, notes, details, created_by_user_id, updated_by_user_id) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::text[], $9, $10, $11, $11) RETURNING ' + SELECT_COLUMNS,
            [recordId, fileNumber, fullName, JSON.stringify(aliases), imageUrl, severity, status, caseIds, notes, details, actorId]
          );
        }
        await client.query(
          'INSERT INTO blackridge_wanted_persons_audit (id, person_id, actor_user_id, action, changed_fields) VALUES ($1, $2, $3, $4, $5::jsonb)',
          [this.makeId('WPAUDIT'), recordId, actorId, action, JSON.stringify(changedFields)]
        );
        return { ok: true, action, person: normalizeRow(result.rows?.[0]) };
      });
    } catch (error) {
      if (error && error.code === '23505') return { ok: false, message: 'رقم الملف مستخدم بالفعل.' };
      throw error;
    }
  }
}

module.exports = { SCHEMA_SQL, SEVERITIES, STATUSES, WantedPersonsStore, buildListFilters, normalizeRow, safeImageUrl };
