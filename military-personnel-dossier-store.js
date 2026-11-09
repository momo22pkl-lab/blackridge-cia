'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const NOTE_LIMIT = 5000;
const CASE_TITLE_LIMIT = 160;
const CASE_DETAILS_LIMIT = 10000;
const CASE_EVIDENCE_LIMIT = 10000;
const CASE_DECISION_LIMIT = 5000;
const TIMELINE_LIMIT = 5000;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const CASE_STATUSES = Object.freeze(['OPEN', 'UNDER_REVIEW', 'CLOSED', 'DISMISSED']);
const TIMELINE_TYPES = Object.freeze(['PROMOTION', 'TRANSFER', 'POSITION', 'SECTOR', 'ADMIN_ACTION']);
const ALLOWED_FILE_TYPES = Object.freeze({
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']
});

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS blackridge_mpd_notes (
    id TEXT PRIMARY KEY,
    personnel_id TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    author_code TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_blackridge_mpd_notes_person_created ON blackridge_mpd_notes (personnel_id, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS blackridge_mpd_cases (
    id TEXT PRIMARY KEY,
    personnel_id TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'CLOSED', 'DISMISSED')),
    final_decision TEXT NOT NULL DEFAULT '',
    created_by_user_id TEXT NOT NULL,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_by_code TEXT NOT NULL DEFAULT '',
    updated_by_user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_blackridge_mpd_cases_person_updated ON blackridge_mpd_cases (personnel_id, updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS blackridge_mpd_timeline (
    id TEXT PRIMARY KEY,
    personnel_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('PROMOTION', 'TRANSFER', 'POSITION', 'SECTOR', 'ADMIN_ACTION')),
    description TEXT NOT NULL,
    event_at TIMESTAMPTZ NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_name TEXT NOT NULL DEFAULT '',
    actor_code TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_blackridge_mpd_timeline_person_event ON blackridge_mpd_timeline (personnel_id, event_at DESC)',
  `CREATE TABLE IF NOT EXISTS blackridge_mpd_attachments (
    id TEXT PRIMARY KEY,
    personnel_id TEXT NOT NULL,
    case_id TEXT REFERENCES blackridge_mpd_cases(id) ON DELETE SET NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 4194304),
    sha256 TEXT NOT NULL,
    file_data BYTEA NOT NULL,
    uploaded_by_user_id TEXT NOT NULL,
    uploaded_by_name TEXT NOT NULL DEFAULT '',
    uploaded_by_code TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_blackridge_mpd_attachments_person_created ON blackridge_mpd_attachments (personnel_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_blackridge_mpd_attachments_case ON blackridge_mpd_attachments (case_id)',
  `CREATE TABLE IF NOT EXISTS blackridge_mpd_audit (
    id TEXT PRIMARY KEY,
    personnel_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_code TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_blackridge_mpd_audit_person_created ON blackridge_mpd_audit (personnel_id, created_at DESC)'
];

const LIST_SQL = Object.freeze({
  notes: `SELECT id, personnel_id, author_user_id, author_name, author_code, body, created_at, updated_at
    FROM blackridge_mpd_notes WHERE personnel_id = $1 ORDER BY created_at DESC LIMIT 200`,
  cases: `SELECT id, personnel_id, title, details, evidence, status, final_decision,
    created_by_user_id, created_by_name, created_by_code, updated_by_user_id, created_at, updated_at
    FROM blackridge_mpd_cases WHERE personnel_id = $1 ORDER BY updated_at DESC LIMIT 200`,
  timeline: `SELECT id, personnel_id, event_type, description, event_at, actor_user_id, actor_name, actor_code, created_at
    FROM blackridge_mpd_timeline WHERE personnel_id = $1 ORDER BY event_at DESC, created_at DESC LIMIT 300`,
  attachments: `SELECT id, personnel_id, case_id, file_name, mime_type, file_size, sha256,
    uploaded_by_user_id, uploaded_by_name, uploaded_by_code, created_at
    FROM blackridge_mpd_attachments WHERE personnel_id = $1 ORDER BY created_at DESC LIMIT 200`
});

function clean(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function validId(value) {
  return /^[A-Za-z0-9._:-]{1,120}$/.test(clean(value, 120));
}

function validText(value, limit, minLength = 0) {
  return typeof value === 'string' &&
    value.trim().length >= minLength &&
    value.length <= limit &&
    value.trim().length > 0;
}

function validDate(value) {
  const input = clean(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(input)) return null;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeFileName(value) {
  const basename = path.basename(String(value || '').replace(/\\/g, '/'));
  const normalized = basename
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._() -]/gu, '_')
    .trim()
    .slice(0, 160);
  return normalized && normalized !== '.' && normalized !== '..' ? normalized : '';
}

function hasAllowedSignature(mimeType, bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return false;
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  if (mimeType === 'application/pdf') return bytes.toString('ascii', 0, 5) === '%PDF-';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }
  if (mimeType === 'text/plain' || mimeType === 'text/csv') {
    return !bytes.includes(0) && !bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0);
  }
  return false;
}

function normalizeNote(row) {
  return row && {
    id: row.id,
    personnelId: row.personnel_id,
    authorUserId: row.author_user_id,
    authorName: row.author_name || '',
    authorCode: row.author_code || '',
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeCase(row) {
  return row && {
    id: row.id,
    personnelId: row.personnel_id,
    title: row.title,
    details: row.details || '',
    evidence: row.evidence || '',
    status: row.status,
    finalDecision: row.final_decision || '',
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name || '',
    createdByCode: row.created_by_code || '',
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeTimeline(row) {
  return row && {
    id: row.id,
    personnelId: row.personnel_id,
    type: row.event_type,
    description: row.description,
    eventAt: row.event_at,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name || '',
    actorCode: row.actor_code || '',
    createdAt: row.created_at
  };
}

function normalizeAttachment(row) {
  return row && {
    id: row.id,
    personnelId: row.personnel_id,
    caseId: row.case_id || '',
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: Number(row.file_size) || 0,
    sha256: row.sha256,
    uploadedByUserId: row.uploaded_by_user_id,
    uploadedByName: row.uploaded_by_name || '',
    uploadedByCode: row.uploaded_by_code || '',
    createdAt: row.created_at
  };
}

class MilitaryPersonnelDossierStore {
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

  async writeAudit(client, { personId, actor, action, entityType, entityId, metadata = {} }) {
    await client.query(
      `INSERT INTO blackridge_mpd_audit
        (id, personnel_id, actor_user_id, actor_code, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        this.makeId('MPDAUDIT'),
        personId,
        clean(actor.id, 120),
        clean(actor.publicCode, 100),
        action,
        entityType,
        entityId,
        JSON.stringify(metadata)
      ]
    );
  }

  async getDossier(personId) {
    const key = clean(personId, 120);
    if (!validId(key)) return null;
    const [notes, cases, timeline, attachments] = await Promise.all(
      Object.values(LIST_SQL).map((sql) => this.pool.query(sql, [key]))
    );
    return {
      notes: (notes.rows || []).map(normalizeNote),
      cases: (cases.rows || []).map(normalizeCase),
      timeline: (timeline.rows || []).map(normalizeTimeline),
      attachments: (attachments.rows || []).map(normalizeAttachment)
    };
  }

  async createNote({ personId, actor, body }) {
    const person = clean(personId, 120);
    const text = clean(body, NOTE_LIMIT);
    if (!validId(person) || !validText(body, NOTE_LIMIT, 1)) return { ok: false, message: 'نص الملاحظة أو سجل العسكري غير صالح.' };
    const id = this.makeId('MPDNOTE');
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO blackridge_mpd_notes (id, personnel_id, author_user_id, author_name, author_code, body)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, personnel_id, author_user_id, author_name, author_code, body, created_at, updated_at`,
        [id, person, clean(actor.id, 120), clean(actor.name, 120), clean(actor.publicCode, 100), text]
      );
      await this.writeAudit(client, { personId: person, actor, action: 'NOTE_CREATED', entityType: 'NOTE', entityId: id });
      return { ok: true, note: normalizeNote(result.rows?.[0]) };
    });
  }

  async updateNote({ personId, noteId, actor, body }) {
    const person = clean(personId, 120);
    const id = clean(noteId, 120);
    const text = clean(body, NOTE_LIMIT);
    if (!validId(person) || !validId(id) || !validText(body, NOTE_LIMIT, 1)) return { ok: false, message: 'نص الملاحظة أو معرّفها غير صالح.' };
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE blackridge_mpd_notes SET body = $3, updated_at = NOW()
         WHERE personnel_id = $1 AND id = $2
         RETURNING id, personnel_id, author_user_id, author_name, author_code, body, created_at, updated_at`,
        [person, id, text]
      );
      if (!result.rows?.length) return { ok: false, message: 'الملاحظة غير موجودة ضمن هذا الملف.' };
      await this.writeAudit(client, { personId: person, actor, action: 'NOTE_UPDATED', entityType: 'NOTE', entityId: id });
      return { ok: true, note: normalizeNote(result.rows[0]) };
    });
  }

  async deleteNote({ personId, noteId, actor }) {
    const person = clean(personId, 120);
    const id = clean(noteId, 120);
    if (!validId(person) || !validId(id)) return { ok: false, message: 'معرّف الملاحظة غير صالح.' };
    return this.withTransaction(async (client) => {
      const result = await client.query(
        'DELETE FROM blackridge_mpd_notes WHERE personnel_id = $1 AND id = $2 RETURNING id',
        [person, id]
      );
      if (!result.rows?.length) return { ok: false, message: 'الملاحظة غير موجودة ضمن هذا الملف.' };
      await this.writeAudit(client, { personId: person, actor, action: 'NOTE_DELETED', entityType: 'NOTE', entityId: id });
      return { ok: true };
    });
  }

  validateCase({ title, details = '', evidence = '', status = 'OPEN', finalDecision = '' }) {
    const normalizedStatus = clean(status, 30).toUpperCase();
    if (!validText(title, CASE_TITLE_LIMIT, 2)) return 'أدخل عنوانًا صحيحًا للقضية.';
    if (typeof details !== 'string' || details.length > CASE_DETAILS_LIMIT) return 'تفاصيل القضية تجاوزت الحد المسموح.';
    if (typeof evidence !== 'string' || evidence.length > CASE_EVIDENCE_LIMIT) return 'تفاصيل الأدلة تجاوزت الحد المسموح.';
    if (!CASE_STATUSES.includes(normalizedStatus)) return 'حالة القضية غير صالحة.';
    if (typeof finalDecision !== 'string' || finalDecision.length > CASE_DECISION_LIMIT) return 'القرار النهائي تجاوز الحد المسموح.';
    if (normalizedStatus === 'CLOSED' && !finalDecision.trim()) return 'أدخل القرار النهائي قبل إغلاق القضية.';
    return '';
  }

  async createCase({ personId, actor, input = {} }) {
    const person = clean(personId, 120);
    const error = this.validateCase(input);
    if (!validId(person)) return { ok: false, message: 'سجل العسكري غير صالح.' };
    if (error) return { ok: false, message: error };
    const id = this.makeId('MPDCASE');
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO blackridge_mpd_cases
          (id, personnel_id, title, details, evidence, status, final_decision, created_by_user_id, created_by_name, created_by_code, updated_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $8)
         RETURNING id, personnel_id, title, details, evidence, status, final_decision, created_by_user_id,
           created_by_name, created_by_code, updated_by_user_id, created_at, updated_at`,
        [
          id, person, clean(input.title, CASE_TITLE_LIMIT), clean(input.details, CASE_DETAILS_LIMIT),
          clean(input.evidence, CASE_EVIDENCE_LIMIT), clean(input.status || 'OPEN', 30).toUpperCase(),
          clean(input.finalDecision, CASE_DECISION_LIMIT), clean(actor.id, 120),
          clean(actor.name, 120), clean(actor.publicCode, 100)
        ]
      );
      await this.writeAudit(client, { personId: person, actor, action: 'CASE_CREATED', entityType: 'CASE', entityId: id });
      return { ok: true, case: normalizeCase(result.rows?.[0]) };
    });
  }

  async updateCase({ personId, caseId, actor, input = {} }) {
    const person = clean(personId, 120);
    const id = clean(caseId, 120);
    if (!validId(person) || !validId(id)) return { ok: false, message: 'معرّف القضية غير صالح.' };
    return this.withTransaction(async (client) => {
      const current = await client.query(
        `SELECT title, details, evidence, status, final_decision FROM blackridge_mpd_cases
         WHERE personnel_id = $1 AND id = $2 FOR UPDATE`,
        [person, id]
      );
      if (!current.rows?.length) return { ok: false, message: 'القضية غير موجودة ضمن هذا الملف.' };
      const value = {
        title: input.title === undefined ? current.rows[0].title : input.title,
        details: input.details === undefined ? current.rows[0].details : input.details,
        evidence: input.evidence === undefined ? current.rows[0].evidence : input.evidence,
        status: input.status === undefined ? current.rows[0].status : input.status,
        finalDecision: input.finalDecision === undefined ? current.rows[0].final_decision : input.finalDecision
      };
      const error = this.validateCase(value);
      if (error) return { ok: false, message: error };
      const updated = await client.query(
        `UPDATE blackridge_mpd_cases
         SET title = $3, details = $4, evidence = $5, status = $6, final_decision = $7,
           updated_by_user_id = $8, updated_at = NOW()
         WHERE personnel_id = $1 AND id = $2
         RETURNING id, personnel_id, title, details, evidence, status, final_decision, created_by_user_id,
           created_by_name, created_by_code, updated_by_user_id, created_at, updated_at`,
        [
          person, id, clean(value.title, CASE_TITLE_LIMIT), clean(value.details, CASE_DETAILS_LIMIT),
          clean(value.evidence, CASE_EVIDENCE_LIMIT), clean(value.status, 30).toUpperCase(),
          clean(value.finalDecision, CASE_DECISION_LIMIT), clean(actor.id, 120)
        ]
      );
      await this.writeAudit(client, {
        personId: person, actor, action: 'CASE_UPDATED', entityType: 'CASE', entityId: id,
        metadata: { status: clean(value.status, 30).toUpperCase() }
      });
      return { ok: true, case: normalizeCase(updated.rows?.[0]) };
    });
  }

  async createTimelineEntry({ personId, actor, type, description, eventAt }) {
    const person = clean(personId, 120);
    const eventType = clean(type, 40).toUpperCase();
    const text = clean(description, TIMELINE_LIMIT);
    const date = validDate(eventAt);
    if (!validId(person) || !TIMELINE_TYPES.includes(eventType) || !validText(description, TIMELINE_LIMIT, 2) || !date) {
      return { ok: false, message: 'تحقق من نوع الإجراء ووصفه وتاريخه.' };
    }
    const id = this.makeId('MPDTIME');
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO blackridge_mpd_timeline
          (id, personnel_id, event_type, description, event_at, actor_user_id, actor_name, actor_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, personnel_id, event_type, description, event_at, actor_user_id, actor_name, actor_code, created_at`,
        [id, person, eventType, text, date.toISOString(), clean(actor.id, 120), clean(actor.name, 120), clean(actor.publicCode, 100)]
      );
      await this.writeAudit(client, { personId: person, actor, action: 'TIMELINE_CREATED', entityType: 'TIMELINE', entityId: id, metadata: { type: eventType } });
      return { ok: true, entry: normalizeTimeline(result.rows?.[0]) };
    });
  }

  validateAttachment({ fileName, mimeType, bytes }) {
    const name = safeFileName(fileName);
    const type = clean(mimeType, 120).toLowerCase();
    const extensions = ALLOWED_FILE_TYPES[type];
    const extension = path.extname(name).toLowerCase();
    const buffer = Buffer.isBuffer(bytes)
      ? bytes
      : bytes instanceof Uint8Array ? Buffer.from(bytes) : null;
    if (!name || !extensions || !extensions.includes(extension)) return { ok: false, message: 'نوع الملف أو امتداده غير مسموح.' };
    if (!buffer || !buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) return { ok: false, message: 'حجم الملف يجب أن يكون بين بايت واحد و4 ميغابايت.' };
    if (!hasAllowedSignature(type, buffer)) return { ok: false, message: 'محتوى الملف لا يطابق نوعه المعلن.' };
    return { ok: true, fileName: name, mimeType: type, bytes: buffer };
  }

  async uploadAttachment({ personId, caseId = '', actor, fileName, mimeType, bytes }) {
    const person = clean(personId, 120);
    const linkedCaseId = clean(caseId, 120);
    const file = this.validateAttachment({ fileName, mimeType, bytes });
    if (!validId(person)) return { ok: false, message: 'سجل العسكري غير صالح.' };
    if (!file.ok) return file;
    if (linkedCaseId && !validId(linkedCaseId)) return { ok: false, message: 'معرّف القضية غير صالح.' };
    const id = this.makeId('MPDFILE');
    const digest = crypto.createHash('sha256').update(file.bytes).digest('hex');
    return this.withTransaction(async (client) => {
      if (linkedCaseId) {
        const linkedCase = await client.query(
          'SELECT id FROM blackridge_mpd_cases WHERE personnel_id = $1 AND id = $2 FOR UPDATE',
          [person, linkedCaseId]
        );
        if (!linkedCase.rows?.length) return { ok: false, message: 'القضية المحددة غير موجودة ضمن ملف هذا العسكري.' };
      }
      const result = await client.query(
        `INSERT INTO blackridge_mpd_attachments
          (id, personnel_id, case_id, file_name, mime_type, file_size, sha256, file_data, uploaded_by_user_id, uploaded_by_name, uploaded_by_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, personnel_id, case_id, file_name, mime_type, file_size, sha256,
           uploaded_by_user_id, uploaded_by_name, uploaded_by_code, created_at`,
        [
          id, person, linkedCaseId || null, file.fileName, file.mimeType, file.bytes.length, digest, file.bytes,
          clean(actor.id, 120), clean(actor.name, 120), clean(actor.publicCode, 100)
        ]
      );
      await this.writeAudit(client, {
        personId: person, actor, action: 'ATTACHMENT_UPLOADED', entityType: 'ATTACHMENT', entityId: id,
        metadata: { fileName: file.fileName, mimeType: file.mimeType, size: file.bytes.length, caseId: linkedCaseId }
      });
      return { ok: true, attachment: normalizeAttachment(result.rows?.[0]) };
    });
  }

  async getAttachmentAccess(id) {
    const key = clean(id, 120);
    if (!validId(key)) return null;
    const result = await this.pool.query(
      'SELECT id, personnel_id, case_id FROM blackridge_mpd_attachments WHERE id = $1',
      [key]
    );
    return result.rows?.[0] ? { id: result.rows[0].id, personnelId: result.rows[0].personnel_id, caseId: result.rows[0].case_id || '' } : null;
  }

  async downloadAttachment({ attachmentId, actor }) {
    const id = clean(attachmentId, 120);
    if (!validId(id)) return { ok: false, message: 'معرّف المرفق غير صالح.' };
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `SELECT id, personnel_id, case_id, file_name, mime_type, file_size, sha256,
          file_data, uploaded_by_user_id, uploaded_by_name, uploaded_by_code, created_at
         FROM blackridge_mpd_attachments WHERE id = $1 FOR SHARE`,
        [id]
      );
      const row = result.rows?.[0];
      if (!row) return { ok: false, message: 'المرفق غير موجود.' };
      await this.writeAudit(client, {
        personId: row.personnel_id, actor, action: 'ATTACHMENT_DOWNLOADED', entityType: 'ATTACHMENT', entityId: id
      });
      const bytes = Buffer.isBuffer(row.file_data) ? row.file_data : Buffer.from(row.file_data || []);
      return { ok: true, attachment: normalizeAttachment(row), bytes };
    });
  }

  async deleteAttachment({ attachmentId, actor }) {
    const id = clean(attachmentId, 120);
    if (!validId(id)) return { ok: false, message: 'معرّف المرفق غير صالح.' };
    return this.withTransaction(async (client) => {
      const result = await client.query(
        'DELETE FROM blackridge_mpd_attachments WHERE id = $1 RETURNING id, personnel_id, case_id, file_name, file_size',
        [id]
      );
      const row = result.rows?.[0];
      if (!row) return { ok: false, message: 'المرفق غير موجود.' };
      await this.writeAudit(client, {
        personId: row.personnel_id, actor, action: 'ATTACHMENT_DELETED', entityType: 'ATTACHMENT', entityId: id,
        metadata: { fileName: row.file_name, size: Number(row.file_size) || 0, caseId: row.case_id || '' }
      });
      return { ok: true, personnelId: row.personnel_id, caseId: row.case_id || '' };
    });
  }
}

module.exports = {
  ALLOWED_FILE_TYPES,
  CASE_STATUSES,
  LIST_SQL,
  MAX_ATTACHMENT_BYTES,
  SCHEMA_SQL,
  TIMELINE_TYPES,
  MilitaryPersonnelDossierStore,
  hasAllowedSignature,
  safeFileName,
  validDate
};
