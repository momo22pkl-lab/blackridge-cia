'use strict';

const crypto = require('node:crypto');

const SEVERITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const STATUSES = Object.freeze(['WANTED', 'UNDER_INVESTIGATION', 'DETAINED', 'CLOSED']);
const EVIDENCE_CATEGORIES = Object.freeze(['IMAGE', 'VEHICLE', 'LOCATION', 'PERSON', 'DOCUMENT', 'OTHER']);
const EVIDENCE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain']);
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const SELECT_COLUMNS = 'id, file_number, full_name, aliases, image_url, severity, status, case_ids, notes, details, created_by_user_id, updated_by_user_id, created_at, updated_at';

const SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS blackridge_wanted_persons (id TEXT PRIMARY KEY, file_number TEXT NOT NULL, full_name TEXT NOT NULL, aliases JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(aliases) = 'array'), image_url TEXT NOT NULL DEFAULT '', severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')), status TEXT NOT NULL CHECK (status IN ('WANTED', 'UNDER_INVESTIGATION', 'DETAINED', 'CLOSED')), case_ids TEXT[] NOT NULL DEFAULT '{}'::text[], notes TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', created_by_user_id TEXT NOT NULL, updated_by_user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_blackridge_wanted_persons_file_number ON blackridge_wanted_persons (LOWER(file_number))',
  'CREATE INDEX IF NOT EXISTS idx_blackridge_wanted_persons_status_severity_updated ON blackridge_wanted_persons (status, severity, updated_at DESC)',
  "CREATE TABLE IF NOT EXISTS blackridge_wanted_persons_audit (id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES blackridge_wanted_persons(id) ON DELETE RESTRICT, actor_user_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('CREATED', 'UPDATED')), changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changed_fields) = 'array'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  'ALTER TABLE blackridge_wanted_persons_audit ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT \'PERSON\'',
  'ALTER TABLE blackridge_wanted_persons_audit ADD COLUMN IF NOT EXISTS entity_id TEXT NOT NULL DEFAULT \'\'',
  "ALTER TABLE blackridge_wanted_persons_audit ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
  "DO $$ DECLARE current_definition TEXT; BEGIN LOCK TABLE blackridge_wanted_persons_audit IN SHARE ROW EXCLUSIVE MODE; SELECT pg_get_constraintdef(oid) INTO current_definition FROM pg_constraint WHERE conrelid = 'blackridge_wanted_persons_audit'::regclass AND conname = 'blackridge_wanted_persons_audit_action_check'; IF current_definition IS NULL THEN ALTER TABLE blackridge_wanted_persons_audit ADD CONSTRAINT blackridge_wanted_persons_audit_action_check CHECK (action IN ('CREATED', 'UPDATED', 'EVIDENCE_CREATED', 'EVIDENCE_UPDATED', 'EVIDENCE_DELETED', 'EVIDENCE_LINKED', 'EVIDENCE_UNLINKED', 'NOTE_CREATED', 'NOTE_UPDATED', 'NOTE_DELETED', 'TIMELINE_CREATED')); ELSIF POSITION('EVIDENCE_CREATED' IN current_definition) = 0 THEN ALTER TABLE blackridge_wanted_persons_audit DROP CONSTRAINT blackridge_wanted_persons_audit_action_check; ALTER TABLE blackridge_wanted_persons_audit ADD CONSTRAINT blackridge_wanted_persons_audit_action_check CHECK (action IN ('CREATED', 'UPDATED', 'EVIDENCE_CREATED', 'EVIDENCE_UPDATED', 'EVIDENCE_DELETED', 'EVIDENCE_LINKED', 'EVIDENCE_UNLINKED', 'NOTE_CREATED', 'NOTE_UPDATED', 'NOTE_DELETED', 'TIMELINE_CREATED')); END IF; END $$",
  'CREATE INDEX IF NOT EXISTS idx_blackridge_wanted_persons_audit_person_created ON blackridge_wanted_persons_audit (person_id, created_at DESC)',
  "CREATE TABLE IF NOT EXISTS blackridge_wanted_evidence (id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES blackridge_wanted_persons(id) ON DELETE RESTRICT, category TEXT NOT NULL CHECK (category IN ('IMAGE', 'VEHICLE', 'LOCATION', 'PERSON', 'DOCUMENT', 'OTHER')), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', recorded_at TIMESTAMPTZ NOT NULL, case_ids TEXT[] NOT NULL DEFAULT '{}'::text[], content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain')), file_name TEXT NOT NULL, file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 2097152), file_sha256 TEXT NOT NULL, file_data BYTEA NOT NULL, thumbnail_data BYTEA, created_by_user_id TEXT NOT NULL, updated_by_user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  'CREATE INDEX IF NOT EXISTS idx_blackridge_wanted_evidence_person_created ON blackridge_wanted_evidence (person_id, created_at DESC)',
  "CREATE TABLE IF NOT EXISTS blackridge_wanted_notes (id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES blackridge_wanted_persons(id) ON DELETE RESTRICT, case_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, body TEXT NOT NULL, created_by_user_id TEXT NOT NULL, updated_by_user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  'CREATE INDEX IF NOT EXISTS idx_blackridge_wanted_notes_person_created ON blackridge_wanted_notes (person_id, created_at DESC)',
  "CREATE TABLE IF NOT EXISTS blackridge_wanted_timeline (id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES blackridge_wanted_persons(id) ON DELETE RESTRICT, case_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', occurred_at TIMESTAMPTZ NOT NULL, actor_user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  'CREATE INDEX IF NOT EXISTS idx_blackridge_wanted_timeline_person_occurred ON blackridge_wanted_timeline (person_id, occurred_at DESC)'
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

function decodeBase64(value, maxBytes) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes / 3) * 4 + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.length > maxBytes || buffer.toString('base64') !== value) return null;
  return buffer;
}

function matchesMimeSignature(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  if (mimeType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'text/plain') return !buffer.includes(0) && !buffer.toString('utf8').includes('\ufffd');
  return false;
}

function safeFileName(value) {
  return clean(value, 240).replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180) || 'evidence';
}

function normalizeEvidence(row) {
  if (!row) return null;
  const thumbnail = row.thumbnail_data ? Buffer.from(row.thumbnail_data).toString('base64') : '';
  return {
    id: row.id,
    personId: row.person_id,
    category: row.category,
    title: row.title,
    description: row.description || '',
    source: row.source || '',
    recordedAt: row.recorded_at,
    caseIds: Array.isArray(row.case_ids) ? row.case_ids : parseArray(row.case_ids),
    contentType: row.content_type,
    fileName: row.file_name,
    fileSize: Number(row.file_size) || 0,
    sha256: row.file_sha256,
    thumbnailData: thumbnail ? 'data:image/jpeg;base64,' + thumbnail : '',
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeNote(row) {
  if (!row) return null;
  return {
    id: row.id,
    personId: row.person_id,
    caseId: row.case_id || '',
    title: row.title,
    body: row.body,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeTimelineEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    personId: row.person_id,
    caseId: row.case_id || '',
    title: row.title,
    body: row.body || '',
    occurredAt: row.occurred_at,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at
  };
}

function normalizeAudit(row) {
  if (!row) return null;
  return {
    id: row.id,
    personId: row.person_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    entityType: row.entity_type || 'PERSON',
    entityId: row.entity_id || '',
    changedFields: parseArray(row.changed_fields),
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdAt: row.created_at
  };
}

async function insertAudit(client, { makeId, personId, actorId, action, entityType, entityId, changedFields = [], metadata = {} }) {
  await client.query(
    'INSERT INTO blackridge_wanted_persons_audit (id, person_id, actor_user_id, action, changed_fields, entity_type, entity_id, metadata) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)',
    [makeId('WPAUDIT'), personId, actorId, action, JSON.stringify(changedFields), entityType, entityId, JSON.stringify(metadata)]
  );
}

const EVIDENCE_SELECT = 'id, person_id, category, title, description, source, recorded_at, case_ids, content_type, file_name, file_size, file_sha256, thumbnail_data, created_by_user_id, updated_by_user_id, created_at, updated_at';
const NOTE_SELECT = 'id, person_id, case_id, title, body, created_by_user_id, updated_by_user_id, created_at, updated_at';
const TIMELINE_SELECT = 'id, person_id, case_id, title, body, occurred_at, actor_user_id, created_at';
const AUDIT_SELECT = 'id, person_id, actor_user_id, action, entity_type, entity_id, changed_fields, metadata, created_at';

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

  async board(personId) {
    const key = clean(personId, 120);
    if (!key) return null;
    const exists = await this.pool.query('SELECT id FROM blackridge_wanted_persons WHERE id = $1', [key]);
    if (!exists.rows?.length) return null;
    const [evidence, notes, timeline, audit] = await Promise.all([
      this.pool.query('SELECT ' + EVIDENCE_SELECT + ' FROM blackridge_wanted_evidence WHERE person_id = $1 ORDER BY recorded_at DESC, created_at DESC LIMIT 60', [key]),
      this.pool.query('SELECT ' + NOTE_SELECT + ' FROM blackridge_wanted_notes WHERE person_id = $1 ORDER BY updated_at DESC LIMIT 100', [key]),
      this.pool.query('SELECT ' + TIMELINE_SELECT + ' FROM blackridge_wanted_timeline WHERE person_id = $1 ORDER BY occurred_at DESC, created_at DESC LIMIT 100', [key]),
      this.pool.query('SELECT ' + AUDIT_SELECT + ' FROM blackridge_wanted_persons_audit WHERE person_id = $1 ORDER BY created_at DESC LIMIT 200', [key])
    ]);
    return {
      evidence: (evidence.rows || []).map(normalizeEvidence),
      notes: (notes.rows || []).map(normalizeNote),
      timeline: (timeline.rows || []).map(normalizeTimelineEvent),
      audit: (audit.rows || []).map(normalizeAudit)
    };
  }

  async evidenceFile({ personId, evidenceId } = {}) {
    const personKey = clean(personId, 120);
    const evidenceKey = clean(evidenceId, 120);
    if (!personKey || !evidenceKey) return null;
    const result = await this.pool.query(
      'SELECT content_type, file_name, file_size, file_sha256, file_data FROM blackridge_wanted_evidence WHERE id = $1 AND person_id = $2',
      [evidenceKey, personKey]
    );
    const row = result.rows?.[0];
    if (!row) return null;
    return {
      contentType: row.content_type,
      fileName: row.file_name,
      fileSize: Number(row.file_size) || 0,
      sha256: row.file_sha256,
      data: Buffer.from(row.file_data).toString('base64')
    };
  }

  async saveEvidence({ personId, evidence = {}, actor = {} } = {}) {
    const personKey = clean(personId, 120);
    const actorId = clean(actor.id, 120);
    const id = clean(evidence.id, 120);
    const category = clean(evidence.category, 30).toUpperCase();
    const title = clean(evidence.title, 200);
    const description = clean(evidence.description, 3000);
    const source = clean(evidence.source, 500);
    const caseIds = Array.isArray(evidence.caseIds)
      ? [...new Set(evidence.caseIds.map((item) => clean(item, 120)).filter(Boolean))]
      : null;
    const fileName = safeFileName(evidence.fileName);
    const contentType = clean(evidence.contentType, 80).toLowerCase();
    const fileData = evidence.fileData == null || evidence.fileData === '' ? null : decodeBase64(evidence.fileData, MAX_EVIDENCE_BYTES);
    const thumbnailData = evidence.thumbnailData == null || evidence.thumbnailData === '' ? null : decodeBase64(evidence.thumbnailData, 48 * 1024);
    const recorded = evidence.recordedAt ? new Date(evidence.recordedAt) : new Date();
    const recordedAt = Number.isNaN(recorded.getTime()) ? '' : recorded.toISOString();
    if (!actorId) return { ok: false, message: 'يلزم تسجيل الدخول.' };
    if (!personKey || !/^[A-Za-z0-9._:-]{1,120}$/.test(personKey)) return { ok: false, message: 'ملف المطلوب غير صالح.' };
    if (id && !/^[A-Za-z0-9._:-]{1,120}$/.test(id)) return { ok: false, message: 'معرّف الدليل غير صالح.' };
    if (!EVIDENCE_CATEGORIES.includes(category)) return { ok: false, message: 'نوع الدليل غير صالح.' };
    if (title.length < 2 || String(evidence.title || '').trim().length > 200) return { ok: false, message: 'عنوان الدليل مطلوب (200 حرف كحد أقصى).' };
    if (String(evidence.description || '').length > 3000 || String(evidence.source || '').length > 500) return { ok: false, message: 'تجاوز وصف الدليل أو مصدره الحد المسموح.' };
    if (!caseIds || caseIds.length > 100) return { ok: false, message: 'قائمة القضايا المرتبطة غير صالحة.' };
    if (!recordedAt) return { ok: false, message: 'تاريخ الدليل غير صالح.' };
    if ((!id || fileData) && !EVIDENCE_MIME_TYPES.includes(contentType)) return { ok: false, message: 'صيغة الملف غير مسموح بها.' };
    if (fileData && !matchesMimeSignature(fileData, contentType)) return { ok: false, message: 'محتوى الملف لا يطابق صيغته المسموح بها.' };
    if (!id && !fileData) return { ok: false, message: 'اختر ملف الدليل أولاً.' };
    if (evidence.fileData && !fileData) return { ok: false, message: 'تعذر قراءة الملف أو تجاوز الحد الأقصى البالغ 2 ميغابايت.' };
    if (thumbnailData && (!contentType.startsWith('image/') || !matchesMimeSignature(thumbnailData, 'image/jpeg'))) return { ok: false, message: 'معاينة الصورة غير صالحة.' };
    if (evidence.thumbnailData && !thumbnailData) return { ok: false, message: 'معاينة الصورة أكبر من الحد المسموح أو غير صالحة.' };
    if (fileData && !safeFileName(evidence.fileName)) return { ok: false, message: 'اسم الملف غير صالح.' };
    const recordId = id || this.makeId('EVIDENCE');

    try {
      return await this.withTransaction(async (client) => {
        const owner = await client.query('SELECT id FROM blackridge_wanted_persons WHERE id = $1 FOR UPDATE', [personKey]);
        if (!owner.rows?.length) return { ok: false, message: 'ملف المطلوب غير موجود.' };
        let previous = null;
        if (id) {
          const existing = await client.query(
            'SELECT id, category, title, description, source, recorded_at, case_ids, content_type, file_name, file_size, file_sha256, thumbnail_data FROM blackridge_wanted_evidence WHERE id = $1 AND person_id = $2 FOR UPDATE',
            [id, personKey]
          );
          previous = existing.rows?.[0] || null;
          if (!previous) return { ok: false, message: 'الدليل غير موجود في هذا الملف.' };
        }

        const digest = fileData ? crypto.createHash('sha256').update(fileData).digest('hex') : '';
        let result;
        if (!id) {
          result = await client.query(
            'INSERT INTO blackridge_wanted_evidence (id, person_id, category, title, description, source, recorded_at, case_ids, content_type, file_name, file_size, file_sha256, file_data, thumbnail_data, created_by_user_id, updated_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::text[], $9, $10, $11, $12, $13, $14, $15, $15) RETURNING ' + EVIDENCE_SELECT,
            [recordId, personKey, category, title, description, source, recordedAt, caseIds, contentType, fileName, fileData.length, digest, fileData, thumbnailData, actorId]
          );
          await insertAudit(client, {
            makeId: this.makeId, personId: personKey, actorId, action: 'EVIDENCE_CREATED',
            entityType: 'EVIDENCE', entityId: recordId,
            changedFields: ['category', 'title', 'description', 'source', 'recordedAt', 'caseIds', 'contentType', 'fileName']
          });
          if (caseIds.length) await insertAudit(client, {
            makeId: this.makeId, personId: personKey, actorId, action: 'EVIDENCE_LINKED',
            entityType: 'EVIDENCE', entityId: recordId, changedFields: ['caseIds'], metadata: { linkedCaseIds: caseIds }
          });
        } else {
          const oldCaseIds = Array.isArray(previous.case_ids) ? previous.case_ids : parseArray(previous.case_ids);
          const changedFields = [];
          const nextValues = { category, title, description, source, recorded_at: recordedAt, case_ids: caseIds };
          for (const [field, oldValue] of [
            ['category', previous.category], ['title', previous.title], ['description', previous.description],
            ['source', previous.source], ['recordedAt', previous.recorded_at ? new Date(previous.recorded_at).toISOString() : ''],
            ['caseIds', oldCaseIds]
          ]) {
            const nextValue = field === 'recordedAt' ? recordedAt : field === 'caseIds' ? caseIds : nextValues[field];
            if (JSON.stringify(oldValue) !== JSON.stringify(nextValue)) changedFields.push(field);
          }
          if (fileData) changedFields.push('file');
          result = await client.query(
            'UPDATE blackridge_wanted_evidence SET category = $3, title = $4, description = $5, source = $6, recorded_at = $7::timestamptz, case_ids = $8::text[], content_type = CASE WHEN $9 THEN $10 ELSE content_type END, file_name = CASE WHEN $9 THEN $11 ELSE file_name END, file_size = CASE WHEN $9 THEN $12 ELSE file_size END, file_sha256 = CASE WHEN $9 THEN $13 ELSE file_sha256 END, file_data = CASE WHEN $9 THEN $14 ELSE file_data END, thumbnail_data = CASE WHEN $9 THEN $15 ELSE thumbnail_data END, updated_by_user_id = $16, updated_at = NOW() WHERE id = $1 AND person_id = $2 RETURNING ' + EVIDENCE_SELECT,
            [id, personKey, category, title, description, source, recordedAt, caseIds, Boolean(fileData), fileData ? contentType : '', fileData ? fileName : '', fileData ? fileData.length : 0, fileData ? digest : '', fileData, thumbnailData, actorId]
          );
          await insertAudit(client, {
            makeId: this.makeId, personId: personKey, actorId, action: 'EVIDENCE_UPDATED',
            entityType: 'EVIDENCE', entityId: id, changedFields
          });
          const added = caseIds.filter((caseId) => !oldCaseIds.includes(caseId));
          const removed = oldCaseIds.filter((caseId) => !caseIds.includes(caseId));
          if (added.length) await insertAudit(client, {
            makeId: this.makeId, personId: personKey, actorId, action: 'EVIDENCE_LINKED',
            entityType: 'EVIDENCE', entityId: id, changedFields: ['caseIds'], metadata: { linkedCaseIds: added }
          });
          if (removed.length) await insertAudit(client, {
            makeId: this.makeId, personId: personKey, actorId, action: 'EVIDENCE_UNLINKED',
            entityType: 'EVIDENCE', entityId: id, changedFields: ['caseIds'], metadata: { unlinkedCaseIds: removed }
          });
        }
        return { ok: true, action: id ? 'UPDATED' : 'CREATED', evidence: normalizeEvidence(result.rows?.[0]) };
      });
    } catch (error) {
      if (error && error.code === '23503') return { ok: false, message: 'ملف المطلوب غير موجود.' };
      throw error;
    }
  }

  async deleteEvidence({ personId, evidenceId, actor = {} } = {}) {
    const personKey = clean(personId, 120);
    const id = clean(evidenceId, 120);
    const actorId = clean(actor.id, 120);
    if (!actorId) return { ok: false, message: 'يلزم تسجيل الدخول.' };
    if (!personKey || !id) return { ok: false, message: 'معرّف الدليل غير صالح.' };
    return this.withTransaction(async (client) => {
      const existing = await client.query(
        'SELECT id, case_ids FROM blackridge_wanted_evidence WHERE id = $1 AND person_id = $2 FOR UPDATE',
        [id, personKey]
      );
      if (!existing.rows?.length) return { ok: false, message: 'الدليل غير موجود في هذا الملف.' };
      const caseIds = Array.isArray(existing.rows[0].case_ids) ? existing.rows[0].case_ids : parseArray(existing.rows[0].case_ids);
      await client.query('DELETE FROM blackridge_wanted_evidence WHERE id = $1 AND person_id = $2', [id, personKey]);
      await insertAudit(client, {
        makeId: this.makeId, personId: personKey, actorId, action: 'EVIDENCE_DELETED',
        entityType: 'EVIDENCE', entityId: id, changedFields: ['record']
      });
      if (caseIds.length) await insertAudit(client, {
        makeId: this.makeId, personId: personKey, actorId, action: 'EVIDENCE_UNLINKED',
        entityType: 'EVIDENCE', entityId: id, changedFields: ['caseIds'], metadata: { unlinkedCaseIds: caseIds, deleted: true }
      });
      return { ok: true, id };
    });
  }

  async saveNote({ personId, note = {}, actor = {} } = {}) {
    const personKey = clean(personId, 120);
    const actorId = clean(actor.id, 120);
    const id = clean(note.id, 120);
    const caseId = clean(note.caseId, 120);
    const title = clean(note.title, 200);
    const body = clean(note.body, 10000);
    if (!actorId) return { ok: false, message: 'يلزم تسجيل الدخول.' };
    if (!personKey || (id && !/^[A-Za-z0-9._:-]{1,120}$/.test(id))) return { ok: false, message: 'معرّف الملاحظة غير صالح.' };
    if (title.length < 2 || !body || String(note.body || '').length > 10000) return { ok: false, message: 'العنوان والمحتوى مطلوبان؛ الحد الأقصى 10,000 حرف.' };
    const recordId = id || this.makeId('WNOTE');
    return this.withTransaction(async (client) => {
      const owner = await client.query('SELECT id FROM blackridge_wanted_persons WHERE id = $1 FOR UPDATE', [personKey]);
      if (!owner.rows?.length) return { ok: false, message: 'ملف المطلوب غير موجود.' };
      let result;
      let changedFields = ['title', 'body', 'caseId'];
      if (id) {
        const existing = await client.query('SELECT id, case_id, title, body FROM blackridge_wanted_notes WHERE id = $1 AND person_id = $2 FOR UPDATE', [id, personKey]);
        if (!existing.rows?.length) return { ok: false, message: 'الملاحظة غير موجودة في هذا الملف.' };
        const old = existing.rows[0];
        changedFields = [];
        if (old.title !== title) changedFields.push('title');
        if (old.body !== body) changedFields.push('body');
        if (old.case_id !== caseId) changedFields.push('caseId');
        result = await client.query(
          'UPDATE blackridge_wanted_notes SET case_id = $3, title = $4, body = $5, updated_by_user_id = $6, updated_at = NOW() WHERE id = $1 AND person_id = $2 RETURNING ' + NOTE_SELECT,
          [id, personKey, caseId, title, body, actorId]
        );
      } else {
        result = await client.query(
          'INSERT INTO blackridge_wanted_notes (id, person_id, case_id, title, body, created_by_user_id, updated_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING ' + NOTE_SELECT,
          [recordId, personKey, caseId, title, body, actorId]
        );
      }
      await insertAudit(client, {
        makeId: this.makeId, personId: personKey, actorId, action: id ? 'NOTE_UPDATED' : 'NOTE_CREATED',
        entityType: 'NOTE', entityId: recordId, changedFields
      });
      return { ok: true, note: normalizeNote(result.rows?.[0]) };
    });
  }

  async deleteNote({ personId, noteId, actor = {} } = {}) {
    const personKey = clean(personId, 120);
    const id = clean(noteId, 120);
    const actorId = clean(actor.id, 120);
    if (!actorId) return { ok: false, message: 'يلزم تسجيل الدخول.' };
    if (!personKey || !id) return { ok: false, message: 'معرّف الملاحظة غير صالح.' };
    return this.withTransaction(async (client) => {
      const existing = await client.query('SELECT id FROM blackridge_wanted_notes WHERE id = $1 AND person_id = $2 FOR UPDATE', [id, personKey]);
      if (!existing.rows?.length) return { ok: false, message: 'الملاحظة غير موجودة في هذا الملف.' };
      await client.query('DELETE FROM blackridge_wanted_notes WHERE id = $1 AND person_id = $2', [id, personKey]);
      await insertAudit(client, {
        makeId: this.makeId, personId: personKey, actorId, action: 'NOTE_DELETED',
        entityType: 'NOTE', entityId: id, changedFields: ['record']
      });
      return { ok: true, id };
    });
  }

  async addTimelineEvent({ personId, event = {}, actor = {} } = {}) {
    const personKey = clean(personId, 120);
    const actorId = clean(actor.id, 120);
    const caseId = clean(event.caseId, 120);
    const title = clean(event.title, 200);
    const body = clean(event.body, 4000);
    const occurred = event.occurredAt ? new Date(event.occurredAt) : new Date();
    const occurredAt = Number.isNaN(occurred.getTime()) ? '' : occurred.toISOString();
    if (!actorId) return { ok: false, message: 'يلزم تسجيل الدخول.' };
    if (!personKey || title.length < 2 || String(event.title || '').length > 200 || String(event.body || '').length > 4000) return { ok: false, message: 'تحقق من عنوان الحدث وتفاصيله.' };
    if (!occurredAt) return { ok: false, message: 'تاريخ الحدث غير صالح.' };
    const id = this.makeId('WTIME');
    return this.withTransaction(async (client) => {
      const owner = await client.query('SELECT id FROM blackridge_wanted_persons WHERE id = $1 FOR UPDATE', [personKey]);
      if (!owner.rows?.length) return { ok: false, message: 'ملف المطلوب غير موجود.' };
      const result = await client.query(
        'INSERT INTO blackridge_wanted_timeline (id, person_id, case_id, title, body, occurred_at, actor_user_id) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7) RETURNING ' + TIMELINE_SELECT,
        [id, personKey, caseId, title, body, occurredAt, actorId]
      );
      await insertAudit(client, {
        makeId: this.makeId, personId: personKey, actorId, action: 'TIMELINE_CREATED',
        entityType: 'TIMELINE', entityId: id, changedFields: ['title', 'body', 'caseId', 'occurredAt']
      });
      return { ok: true, event: normalizeTimelineEvent(result.rows?.[0]) };
    });
  }
}

module.exports = {
  EVIDENCE_CATEGORIES, EVIDENCE_MIME_TYPES, MAX_EVIDENCE_BYTES, SCHEMA_SQL, SEVERITIES, STATUSES,
  WantedPersonsStore, buildListFilters, matchesMimeSignature, normalizeRow, safeImageUrl
};
