'use strict';

const crypto = require('node:crypto');

const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET'];
const STATUSES = ['DRAFT', 'PENDING APPROVAL', 'APPROVED', 'ISSUED', 'REVOKED', 'EXPIRED', 'ARCHIVED'];
const DOCUMENT_TYPES = [
  'OFFICIAL DIRECTIVE', 'COMMAND ORDER', 'SECTOR NOTICE', 'ADMINISTRATIVE DOCUMENT',
  'OPERATIONAL REPORT', 'AUTHORIZATION DOCUMENT', 'OFFICIAL MEMORANDUM',
  'SECURITY NOTICE', 'CLASSIFIED REPORT', 'SECTOR BRIEFING', 'OPERATION ORDER',
  'INTELLIGENCE REPORT', 'ADMINISTRATIVE ORDER', 'OFFICIAL LETTER'
];
const ALL_PERMISSIONS = [
  'VIEW_DOCUMENTS', 'CREATE_DOCUMENTS', 'EDIT_DRAFTS', 'SUBMIT_FOR_APPROVAL',
  'APPROVE_DOCUMENTS', 'SIGN_DOCUMENTS', 'ISSUE_DOCUMENTS', 'REVOKE_DOCUMENTS',
  'ARCHIVE_DOCUMENTS', 'DOWNLOAD_DOCUMENTS', 'SHARE_DOCUMENTS', 'VIEW_AUDIT_TRAIL',
  'MANAGE_USERS', 'VIEW_SIGNER_ROLE', 'VIEW_SIGNER_IDENTITY', 'VIEW_REAL_SIGNER_IDENTITY'
];
const ROLE_DEFAULTS = Object.freeze({
  AGENT: {
    clearance: 'INTERNAL',
    permissions: ['VIEW_DOCUMENTS', 'CREATE_DOCUMENTS', 'EDIT_DRAFTS', 'SUBMIT_FOR_APPROVAL', 'DOWNLOAD_DOCUMENTS', 'SHARE_DOCUMENTS']
  },
  SENIOR: {
    clearance: 'SECRET',
    permissions: ['VIEW_DOCUMENTS', 'CREATE_DOCUMENTS', 'EDIT_DRAFTS', 'SUBMIT_FOR_APPROVAL', 'APPROVE_DOCUMENTS', 'DOWNLOAD_DOCUMENTS', 'SHARE_DOCUMENTS', 'VIEW_AUDIT_TRAIL', 'VIEW_SIGNER_ROLE']
  },
  COMMANDER: {
    clearance: 'TOP SECRET',
    permissions: [...ALL_PERMISSIONS.filter((permission) => permission !== 'MANAGE_USERS' && permission !== 'VIEW_REAL_SIGNER_IDENTITY'), 'MANAGE_USERS']
  },
  ADMIN: {
    clearance: 'TOP SECRET',
    permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'VIEW_REAL_SIGNER_IDENTITY')
  }
});
const SESSION_HOURS = 8;
const MAX_BODY_LENGTH = 30000;
const loginAttempts = new Map();

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS osd_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('AGENT','SENIOR','COMMANDER','ADMIN')),
  clearance TEXT NOT NULL CHECK (clearance IN ('PUBLIC','INTERNAL','CONFIDENTIAL','SECRET','TOP SECRET')),
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS osd_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES osd_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS osd_sessions_expiry_idx ON osd_sessions(expires_at);
CREATE TABLE IF NOT EXISTS osd_counters (
  sector_code TEXT NOT NULL,
  issue_year INTEGER NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (sector_code, issue_year)
);
CREATE TABLE IF NOT EXISTS osd_documents (
  id TEXT PRIMARY KEY,
  amends_document_id TEXT REFERENCES osd_documents(id),
  document_number TEXT NOT NULL UNIQUE,
  verification_code TEXT NOT NULL UNIQUE,
  document_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body JSONB NOT NULL,
  sector TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','SECRET','TOP SECRET')),
  recipient TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING APPROVAL','APPROVED','ISSUED','REVOKED','EXPIRED','ARCHIVED')),
  version TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES osd_users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  signature JSONB,
  integrity_hash TEXT,
  issued_snapshot JSONB
);
CREATE INDEX IF NOT EXISTS osd_documents_status_idx ON osd_documents(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS osd_documents_sector_idx ON osd_documents(sector);
ALTER TABLE osd_documents ADD COLUMN IF NOT EXISTS amends_document_id TEXT REFERENCES osd_documents(id);
CREATE TABLE IF NOT EXISTS osd_document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES osd_documents(id),
  version TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES osd_users(id),
  change_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(document_id, version)
);
CREATE INDEX IF NOT EXISTS osd_versions_document_idx ON osd_document_versions(document_id, created_at DESC);
CREATE TABLE IF NOT EXISTS osd_audit_events (
  id BIGSERIAL PRIMARY KEY,
  document_id TEXT REFERENCES osd_documents(id),
  actor_id TEXT REFERENCES osd_users(id),
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash TEXT NOT NULL DEFAULT '',
  event_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS osd_audit_document_idx ON osd_audit_events(document_id, id DESC);
CREATE TABLE IF NOT EXISTS osd_document_shares (
  token_hash TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES osd_documents(id),
  permissions JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  created_by TEXT NOT NULL REFERENCES osd_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION osd_reject_immutable_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'OSD immutable records cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'osd_versions_immutable') THEN
    CREATE TRIGGER osd_versions_immutable BEFORE UPDATE OR DELETE ON osd_document_versions
      FOR EACH ROW EXECUTE FUNCTION osd_reject_immutable_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'osd_audit_immutable') THEN
    CREATE TRIGGER osd_audit_immutable BEFORE UPDATE OR DELETE ON osd_audit_events
      FOR EACH ROW EXECUTE FUNCTION osd_reject_immutable_mutation();
  END IF;
END;
$$;
`;

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

const MAX_SIGNATURE_IMAGE_BYTES = 256 * 1024;

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeSignatureImage(value) {
  const match = typeof value === 'string' && /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw Object.assign(new Error('A drawn PNG signature is required.'), { status: 400 });
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > MAX_SIGNATURE_IMAGE_BYTES || bytes.length < 64 || bytes.toString('base64') !== match[1]) {
    throw Object.assign(new Error('The signature image is invalid or too large.'), { status: 400 });
  }
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(pngHeader)) {
    throw Object.assign(new Error('The signature must be a valid PNG image.'), { status: 400 });
  }
  let offset = 8;
  let hasHeader = false;
  let hasImageData = false;
  let hasEnd = false;
  let width = 0;
  let height = 0;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) {
      throw Object.assign(new Error('The signature image is truncated.'), { status: 400 });
    }
    const actualCrc = bytes.readUInt32BE(offset + 8 + length);
    const expectedCrc = pngCrc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (actualCrc !== expectedCrc) {
      throw Object.assign(new Error('The signature image failed its PNG integrity check.'), { status: 400 });
    }
    if (!hasHeader) {
      if (type !== 'IHDR' || length !== 13) {
        throw Object.assign(new Error('The signature image is invalid.'), { status: 400 });
      }
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      hasHeader = true;
    }
    if (type === 'IDAT') hasImageData = true;
    offset = chunkEnd;
    if (type === 'IEND') {
      hasEnd = length === 0;
      break;
    }
  }
  if (!hasHeader || !hasImageData || !hasEnd || offset !== bytes.length ||
      width < 300 || width > 2400 || height < 100 || height > 900) {
    throw Object.assign(new Error('The signature image has invalid dimensions or content.'), { status: 400 });
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signingSecretReady(secret) {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32;
}

function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function passwordHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => {
      if (error) return reject(error);
      resolve(key.toString('hex'));
    });
  });
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 200;
}

function allowedPermissions(value) {
  return Array.isArray(value) && value.every((permission) => ALL_PERMISSIONS.includes(permission))
    ? [...new Set(value)]
    : null;
}

function hasPermission(user, permission) {
  return !!user && Array.isArray(user.permissions) && user.permissions.includes(permission);
}

function canReadClassification(user, classification) {
  return CLASSIFICATIONS.indexOf(classification) <= CLASSIFICATIONS.indexOf(user.clearance);
}

function safeDocument(row, user, options = {}) {
  const signature = row.signature && typeof row.signature === 'object' ? row.signature : null;
  const seeIdentity = hasPermission(user, 'VIEW_SIGNER_IDENTITY') || hasPermission(user, 'VIEW_REAL_SIGNER_IDENTITY');
  const seeRole = hasPermission(user, 'VIEW_SIGNER_ROLE');
  const seeSignatureImage = hasPermission(user, 'DOWNLOAD_DOCUMENTS') || seeIdentity;
  const revoked = row.status === 'REVOKED' || !!row.revoked_at;
  const expired = row.status === 'ISSUED' && row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
  const result = {
    id: row.id,
    documentNumber: row.document_number,
    verificationCode: row.verification_code,
    type: row.document_type,
    title: row.title,
    sector: row.sector,
    classification: row.classification,
    recipient: row.recipient,
    status: revoked ? 'REVOKED' : expired ? 'EXPIRED' : row.status,
    amendsDocumentId: row.amends_document_id || null,
    version: row.version,
    createdBy: options.public ? null : row.created_by,
    updatedAt: row.updated_at,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: options.public ? null : row.revoked_reason,
    body: row.body,
    signature: signature ? {
      display: seeIdentity ? signature.signerName : seeRole ? 'COMMANDER / AUTHORIZED SIGNATURE' : 'AUTHORIZED COMMAND',
      signedAt: signature.signedAt,
      role: seeIdentity || seeRole ? signature.signerRole : undefined,
      authorizationLevel: signature.authorizationLevel,
      signatureImage: seeSignatureImage ? signature.signatureImage : undefined,
      identityVisible: seeIdentity
    } : null,
    integrityHash: row.integrity_hash || null
  };
  if (options.public) {
    delete result.body;
    delete result.createdBy;
    delete result.recipient;
    delete result.revokedReason;
    delete result.integrityHash;
    if (result.signature) {
      result.signature = { display: 'AUTHORIZED COMMAND', signedAt: result.signature.signedAt };
    }
  }
  return result;
}

function sectorCode(sector) {
  const words = cleanText(sector, 100).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().match(/[A-Z0-9]+/g) || [];
  if (!words.length) return 'SE';
  const initials = words.map((word) => word[0]).join('').slice(0, 4);
  return initials || 'SE';
}

function nextMinorVersion(current) {
  const match = /^(\d+)\.(\d+)$/.exec(String(current || '1.0'));
  if (!match) return '1.1';
  const major = Number(match[1]);
  const minor = Number(match[2]) + 1;
  return minor >= 10 ? `${major + 1}.0` : `${major}.${minor}`;
}

function normalizeDocument(input) {
  const documentType = cleanText(input?.type, 80).toUpperCase();
  const title = cleanText(input?.title, 180);
  const sector = cleanText(input?.sector, 120);
  const classification = cleanText(input?.classification, 40).toUpperCase();
  const recipient = cleanText(input?.recipient, 200);
  const bodyText = cleanText(input?.body, MAX_BODY_LENGTH);
  const notes = cleanText(input?.notes, 3000);
  const references = Array.isArray(input?.references)
    ? input.references.slice(0, 20).map((item) => cleanText(item, 300)).filter(Boolean)
    : [];
  const expiresAt = input?.expiresAt ? new Date(input.expiresAt) : null;

  if (!DOCUMENT_TYPES.includes(documentType)) throw Object.assign(new Error('Choose a valid document type.'), { status: 400 });
  if (!title) throw Object.assign(new Error('Document title is required.'), { status: 400 });
  if (!sector) throw Object.assign(new Error('Sector is required.'), { status: 400 });
  if (!CLASSIFICATIONS.includes(classification)) throw Object.assign(new Error('Choose a valid classification.'), { status: 400 });
  if (!bodyText) throw Object.assign(new Error('Document content is required.'), { status: 400 });
  if (input?.expiresAt && Number.isNaN(expiresAt.getTime())) throw Object.assign(new Error('Expiration date is invalid.'), { status: 400 });
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw Object.assign(new Error('Expiration must be in the future.'), { status: 400 });
  return {
    type: documentType,
    title,
    sector,
    classification,
    recipient,
    body: { text: bodyText, notes, references },
    expiresAt: expiresAt ? expiresAt.toISOString() : null
  };
}

async function appendAudit(client, { documentId = null, actorId = null, actorLabel, action, version = '', metadata = {} }) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [documentId || 'osd-global-audit']);
  const previous = documentId
    ? await client.query('SELECT event_hash FROM osd_audit_events WHERE document_id = $1 ORDER BY id DESC LIMIT 1', [documentId])
    : await client.query('SELECT event_hash FROM osd_audit_events WHERE document_id IS NULL ORDER BY id DESC LIMIT 1');
  const previousHash = previous.rows[0]?.event_hash || '';
  const createdAt = new Date().toISOString();
  const payload = { documentId, actorId, actorLabel, action, version, metadata, previousHash, createdAt };
  const eventHash = sha256(canonicalJson(payload));
  await client.query(
    `INSERT INTO osd_audit_events (document_id, actor_id, actor_label, action, version, metadata, previous_hash, event_hash, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
    [documentId, actorId, actorLabel, action, version, JSON.stringify(metadata), previousHash, eventHash, createdAt]
  );
}

function createOsdRouter({ getPool, env = process.env } = {}) {
  const express = require('express');
  const router = express.Router();
  let schemaPromise = null;

  async function initialize() {
    if (schemaPromise) return schemaPromise;
    const pool = typeof getPool === 'function' ? getPool() : null;
    if (!pool) return false;
    schemaPromise = pool.query(SCHEMA_SQL).then(() => true).catch((error) => {
      schemaPromise = null;
      throw error;
    });
    return schemaPromise;
  }

  async function poolOr503(res) {
    const pool = typeof getPool === 'function' ? getPool() : null;
    if (!pool) {
      res.status(503).json({ error: 'OSD requires PostgreSQL. Configure DATABASE_URL before using the document system.' });
      return null;
    }
    try {
      await initialize();
    } catch (error) {
      console.error('[OSD] Schema initialization failed:', error.message);
      res.status(503).json({ error: 'OSD storage is unavailable.' });
      return null;
    }
    return pool;
  }

  function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  }

  function sameOrigin(req, res, next) {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next();
    const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol;
    const expected = `${protocol}://${req.get('host')}`;
    if (origin !== expected) return res.status(403).json({ error: 'Cross-origin request blocked.' });
    next();
  }

  router.use(sameOrigin);

  function currentUser(req, res, next) {
    Promise.resolve().then(async () => {
      const pool = await poolOr503(res);
      if (!pool) return;
      const cookie = String(req.headers.cookie || '').split(';').map((item) => item.trim())
        .find((item) => item.startsWith('osd_session='));
      let token = '';
      try {
        token = cookie ? decodeURIComponent(cookie.slice('osd_session='.length)) : '';
      } catch {
        token = '';
      }
      if (!token || token.length > 200) return res.status(401).json({ error: 'Authentication required.' });
      const tokenHash = sha256(token);
      const result = await pool.query(
        `SELECT u.id, u.username, u.display_name, u.role, u.clearance, u.permissions
         FROM osd_sessions s JOIN osd_users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.enabled = TRUE`,
        [tokenHash]
      );
      if (!result.rows.length) {
        res.setHeader('Set-Cookie', clearSessionCookie(req));
        return res.status(401).json({ error: 'Session expired. Sign in again.' });
      }
      req.osdUser = {
        id: result.rows[0].id,
        username: result.rows[0].username,
        displayName: result.rows[0].display_name,
        role: result.rows[0].role,
        clearance: result.rows[0].clearance,
        permissions: Array.isArray(result.rows[0].permissions) ? result.rows[0].permissions : []
      };
      req.osdPool = pool;
      next();
    }).catch(next);
  }

  function requirePermission(permission) {
    return (req, res, next) => {
      if (!hasPermission(req.osdUser, permission)) return res.status(403).json({ error: 'You are not authorized to perform this action.' });
      next();
    };
  }

  function sessionCookie(token, req) {
    const secure = req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https' || env.NODE_ENV === 'production';
    return `osd_session=${encodeURIComponent(token)}; Path=/api/osd; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`;
  }

  function clearSessionCookie(req) {
    const secure = req?.secure || String(req?.get?.('x-forwarded-proto') || '').split(',')[0].trim() === 'https' || env.NODE_ENV === 'production';
    return `osd_session=; Path=/api/osd; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  function loginRateLimited(req) {
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    const current = loginAttempts.get(key);
    if (!current || now - current.since > 15 * 60 * 1000) {
      loginAttempts.set(key, { count: 1, since: now });
      return false;
    }
    current.count += 1;
    return current.count > 8;
  }

  async function getDocument(client, id, lock = false) {
    const result = await client.query(`SELECT * FROM osd_documents WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return result.rows[0] || null;
  }

  function checkDocumentVisibility(user, document, res) {
    if (!document) {
      res.status(404).json({ error: 'Document not found.' });
      return false;
    }
    if (!hasPermission(user, 'VIEW_DOCUMENTS') || !canReadClassification(user, document.classification)) {
      res.status(404).json({ error: 'Document not found.' });
      return false;
    }
    return true;
  }

  async function writeVersion(client, document, snapshot, actor, note) {
    const version = nextMinorVersion(document.version);
    const snapshotForVersion = {
      id: document.id,
      documentNumber: document.document_number,
      verificationCode: document.verification_code,
      type: snapshot.type,
      title: snapshot.title,
      sector: snapshot.sector,
      classification: snapshot.classification,
      recipient: snapshot.recipient,
      body: snapshot.body,
      version,
      updatedAt: new Date().toISOString(),
      expiresAt: snapshot.expiresAt
    };
    const contentHash = sha256(canonicalJson(snapshotForVersion));
    await client.query(
      `INSERT INTO osd_document_versions (id, document_id, version, snapshot, content_hash, actor_id, change_note)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
      [crypto.randomUUID(), document.id, version, JSON.stringify(snapshotForVersion), contentHash, actor.id, cleanText(note, 500)]
    );
    await client.query(
      `UPDATE osd_documents SET document_type=$2,title=$3,body=$4::jsonb,sector=$5,classification=$6,
       recipient=$7,version=$8,updated_at=NOW(),expires_at=$9 WHERE id=$1`,
      [document.id, snapshot.type, snapshot.title, JSON.stringify(snapshot.body), snapshot.sector, snapshot.classification, snapshot.recipient, version, snapshot.expiresAt]
    );
    return { version, snapshot: snapshotForVersion, contentHash };
  }

  router.get('/health', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    await pool.query('SELECT 1');
    res.json({ status: 'online', storage: 'postgresql', system: 'OSD' });
  }));

  router.get('/bootstrap/status', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    const result = await pool.query('SELECT EXISTS(SELECT 1 FROM osd_users) AS initialized');
    res.json({ needed: !result.rows[0].initialized, configured: !!cleanText(env.OSD_BOOTSTRAP_CODE, 300) });
  }));

  router.post('/bootstrap', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    const configuredCode = cleanText(env.OSD_BOOTSTRAP_CODE, 300);
    if (configuredCode.length < 24) return res.status(503).json({ error: 'Set OSD_BOOTSTRAP_CODE to a random value of at least 24 characters before initial setup.' });
    if (!safeEqual(cleanText(req.body?.bootstrapCode, 300), configuredCode)) return res.status(403).json({ error: 'Invalid setup code.' });
    const username = cleanText(req.body?.username, 60).toLowerCase();
    const displayName = cleanText(req.body?.displayName, 120);
    const password = req.body?.password;
    if (!/^[a-z0-9][a-z0-9._-]{2,59}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–60 letters, numbers, dots, underscores or hyphens.' });
    if (!displayName || !validPassword(password)) return res.status(400).json({ error: 'Display name is required; password must be at least 12 characters.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await passwordHash(password, salt);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('osd-bootstrap'))");
      const existing = await client.query('SELECT 1 FROM osd_users LIMIT 1');
      if (existing.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'OSD is already initialized.' });
      }
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO osd_users (id,username,display_name,password_salt,password_hash,role,clearance,permissions)
         VALUES ($1,$2,$3,$4,$5,'COMMANDER','TOP SECRET',$6::jsonb)`,
        [id, username, displayName, salt, hash, JSON.stringify(ROLE_DEFAULTS.COMMANDER.permissions)]
      );
      await appendAudit(client, { actorId: id, actorLabel: 'COMMANDER', action: 'OSD COMMANDER ACCOUNT CREATED', metadata: { username } });
      await client.query('COMMIT');
      res.status(201).json({ created: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error.code === '23505') return res.status(409).json({ error: 'Username is already in use.' });
      throw error;
    } finally {
      client.release();
    }
  }));

  router.post('/auth/login', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    if (loginRateLimited(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    const username = cleanText(req.body?.username, 60).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
    const result = await pool.query('SELECT * FROM osd_users WHERE username = $1 AND enabled = TRUE', [username]);
    const user = result.rows[0];
    const supplied = user ? await passwordHash(password, user.password_salt) : await passwordHash(password, 'osd-static-user-not-found');
    if (!user || !safeEqual(supplied, user.password_hash)) return res.status(401).json({ error: 'Username or password is incorrect.' });
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    await pool.query('DELETE FROM osd_sessions WHERE expires_at < NOW()');
    await pool.query(
      `INSERT INTO osd_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,NOW() + INTERVAL '${SESSION_HOURS} hours')`,
      [tokenHash, user.id]
    );
    loginAttempts.delete(String(req.ip || req.socket?.remoteAddress || 'unknown'));
    res.setHeader('Set-Cookie', sessionCookie(token, req));
    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        clearance: user.clearance,
        permissions: user.permissions
      }
    });
  }));

  router.get('/auth/me', currentUser, (req, res) => {
    res.json({ user: req.osdUser });
  });

  router.post('/auth/logout', currentUser, asyncRoute(async (req, res) => {
    const cookie = String(req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('osd_session='));
    const token = cookie ? decodeURIComponent(cookie.slice('osd_session='.length)) : '';
    if (token) await req.osdPool.query('DELETE FROM osd_sessions WHERE token_hash=$1', [sha256(token)]);
    res.setHeader('Set-Cookie', clearSessionCookie(req));
    res.json({ loggedOut: true });
  }));

  router.get('/documents', currentUser, requirePermission('VIEW_DOCUMENTS'), asyncRoute(async (req, res) => {
    const result = await req.osdPool.query(
      `SELECT * FROM osd_documents
       WHERE classification = ANY($1::text[])
       ORDER BY updated_at DESC LIMIT 200`,
      [CLASSIFICATIONS.slice(0, CLASSIFICATIONS.indexOf(req.osdUser.clearance) + 1)]
    );
    let documents = result.rows.map((row) => safeDocument(row, req.osdUser));
    const status = cleanText(req.query.status, 40).toUpperCase();
    const type = cleanText(req.query.type, 80).toUpperCase();
    const sector = cleanText(req.query.sector, 120).toLowerCase();
    const search = cleanText(req.query.search, 160).toLowerCase();
    if (STATUSES.includes(status)) documents = documents.filter((document) => document.status === status);
    if (DOCUMENT_TYPES.includes(type)) documents = documents.filter((document) => document.type === type);
    if (sector) documents = documents.filter((document) => document.sector.toLowerCase().includes(sector));
    if (search) documents = documents.filter((document) => [document.documentNumber, document.title, document.verificationCode].some((value) => String(value).toLowerCase().includes(search)));
    res.json({ documents });
  }));

  router.post('/documents', currentUser, requirePermission('CREATE_DOCUMENTS'), asyncRoute(async (req, res) => {
    const pool = req.osdPool;
    const snapshot = normalizeDocument(req.body);
    if (!canReadClassification(req.osdUser, snapshot.classification)) return res.status(403).json({ error: 'Your clearance does not allow this classification.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const documentId = crypto.randomUUID();
      const year = new Date().getUTCFullYear();
      const code = sectorCode(snapshot.sector);
      const counter = await client.query(
        `INSERT INTO osd_counters (sector_code,issue_year,value) VALUES ($1,$2,1)
         ON CONFLICT (sector_code,issue_year) DO UPDATE SET value=osd_counters.value+1 RETURNING value`,
        [code, year]
      );
      const documentNumber = `OSD-${code}-${year}-${String(counter.rows[0].value).padStart(5, '0')}`;
      const verificationCode = crypto.randomBytes(8).toString('hex').toUpperCase();
      const draft = { ...snapshot, version: '1.0', id: documentId, documentNumber, verificationCode, createdAt: new Date().toISOString() };
      await client.query(
        `INSERT INTO osd_documents
         (id,document_number,verification_code,document_type,title,body,sector,classification,recipient,status,version,created_by,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'DRAFT','1.0',$10,$11)`,
        [documentId, documentNumber, verificationCode, snapshot.type, snapshot.title, JSON.stringify(snapshot.body), snapshot.sector, snapshot.classification, snapshot.recipient, req.osdUser.id, snapshot.expiresAt]
      );
      const contentHash = sha256(canonicalJson(draft));
      await client.query(
        `INSERT INTO osd_document_versions (id,document_id,version,snapshot,content_hash,actor_id,change_note)
         VALUES ($1,$2,'1.0',$3::jsonb,$4,$5,'Initial draft')`,
        [crypto.randomUUID(), documentId, JSON.stringify(draft), contentHash, req.osdUser.id]
      );
      await appendAudit(client, { documentId, actorId: req.osdUser.id, actorLabel: req.osdUser.role, action: 'DOCUMENT CREATED', version: '1.0', metadata: { documentNumber } });
      await client.query('COMMIT');
      const created = await pool.query('SELECT * FROM osd_documents WHERE id=$1', [documentId]);
      res.status(201).json({ document: safeDocument(created.rows[0], req.osdUser) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  router.post('/documents/:id/amend', currentUser, requirePermission('CREATE_DOCUMENTS'), asyncRoute(async (req, res) => {
    const client = await req.osdPool.connect();
    try {
      await client.query('BEGIN');
      const previous = await getDocument(client, cleanText(req.params.id, 100), true);
      if (!checkDocumentVisibility(req.osdUser, previous, res)) {
        await client.query('ROLLBACK');
        return;
      }
      if (!['ISSUED', 'ARCHIVED'].includes(previous.status) || previous.revoked_at ||
          (previous.expires_at && new Date(previous.expires_at).getTime() <= Date.now())) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Only active issued documents can be amended.' });
      }
      const prior = previous.issued_snapshot;
      const snapshot = normalizeDocument({
        type: prior.type, title: prior.title, sector: prior.sector,
        classification: prior.classification, recipient: prior.recipient,
        body: prior.body?.text, notes: prior.body?.notes,
        references: prior.body?.references, expiresAt: prior.expiresAt
      });
      if (!canReadClassification(req.osdUser, snapshot.classification)) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Document not found.' });
      }
      const documentId = crypto.randomUUID();
      const year = new Date().getUTCFullYear();
      const code = sectorCode(snapshot.sector);
      const counter = await client.query(
        `INSERT INTO osd_counters (sector_code,issue_year,value) VALUES ($1,$2,1)
         ON CONFLICT (sector_code,issue_year) DO UPDATE SET value=osd_counters.value+1 RETURNING value`,
        [code, year]
      );
      const documentNumber = `OSD-${code}-${year}-${String(counter.rows[0].value).padStart(5, '0')}`;
      const verificationCode = crypto.randomBytes(8).toString('hex').toUpperCase();
      const version = `${Number.parseInt(previous.version.split('.')[0], 10) + 1}.0`;
      const draft = {
        ...snapshot, version, id: documentId, documentNumber, verificationCode,
        amendsDocumentId: previous.id, createdAt: new Date().toISOString()
      };
      await client.query(
        `INSERT INTO osd_documents
         (id,amends_document_id,document_number,verification_code,document_type,title,body,sector,classification,recipient,status,version,created_by,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'DRAFT',$11,$12,$13)`,
        [documentId, previous.id, documentNumber, verificationCode, snapshot.type, snapshot.title, JSON.stringify(snapshot.body), snapshot.sector, snapshot.classification, snapshot.recipient, version, req.osdUser.id, snapshot.expiresAt]
      );
      const contentHash = sha256(canonicalJson(draft));
      await client.query(
        `INSERT INTO osd_document_versions (id,document_id,version,snapshot,content_hash,actor_id,change_note)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
        [crypto.randomUUID(), documentId, version, JSON.stringify(draft), contentHash, req.osdUser.id, `Amends ${previous.document_number}`]
      );
      await appendAudit(client, { documentId, actorId: req.osdUser.id, actorLabel: req.osdUser.role, action: 'AMENDMENT DRAFT CREATED', version, metadata: { amends: previous.document_number } });
      await appendAudit(client, { documentId: previous.id, actorId: req.osdUser.id, actorLabel: req.osdUser.role, action: 'AMENDMENT CREATED', version: previous.version, metadata: { amendmentDocument: documentNumber } });
      await client.query('COMMIT');
      const created = await req.osdPool.query('SELECT * FROM osd_documents WHERE id=$1', [documentId]);
      res.status(201).json({ document: safeDocument(created.rows[0], req.osdUser) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  router.get('/documents/:id', currentUser, requirePermission('VIEW_DOCUMENTS'), asyncRoute(async (req, res) => {
    const client = await req.osdPool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM osd_documents WHERE id=$1 OR document_number=$1', [cleanText(req.params.id, 100)]);
      const document = result.rows[0];
      if (!checkDocumentVisibility(req.osdUser, document, res)) {
        await client.query('ROLLBACK');
        return;
      }
      await appendAudit(client, { documentId: document.id, actorId: req.osdUser.id, actorLabel: req.osdUser.role, action: 'DOCUMENT VIEWED', version: document.version, metadata: {} });
      await client.query('COMMIT');
      res.json({ document: safeDocument(document, req.osdUser) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  router.post('/documents/:id/download', currentUser, requirePermission('DOWNLOAD_DOCUMENTS'), asyncRoute(async (req, res) => {
    const client = await req.osdPool.connect();
    try {
      await client.query('BEGIN');
      const document = await getDocument(client, cleanText(req.params.id, 100), true);
      if (!checkDocumentVisibility(req.osdUser, document, res)) {
        await client.query('ROLLBACK');
        return;
      }
      if (!['ISSUED', 'ARCHIVED'].includes(document.status) || document.revoked_at ||
          (document.expires_at && new Date(document.expires_at).getTime() <= Date.now())) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Only active issued documents can be downloaded.' });
      }
      await appendAudit(client, { documentId: document.id, actorId: req.osdUser.id, actorLabel: req.osdUser.role, action: 'DOCUMENT DOWNLOAD REQUESTED', version: document.version, metadata: {} });
      await client.query('COMMIT');
      res.json({ document: safeDocument(document, req.osdUser) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  router.patch('/documents/:id', currentUser, requirePermission('EDIT_DRAFTS'), asyncRoute(async (req, res) => {
    const snapshot = normalizeDocument(req.body);
    if (!canReadClassification(req.osdUser, snapshot.classification)) return res.status(403).json({ error: 'Your clearance does not allow this classification.' });
    const client = await req.osdPool.connect();
    try {
      await client.query('BEGIN');
      const document = await getDocument(client, cleanText(req.params.id, 100), true);
      if (!document) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Document not found.' });
      }
      if (document.status !== 'DRAFT') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Only drafts can be edited. Issued documents must be amended as a new version.' });
      }
      if (document.created_by !== req.osdUser.id && !hasPermission(req.osdUser, 'APPROVE_DOCUMENTS')) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the draft author or an approver may edit this draft.' });
      }
      const saved = await writeVersion(client, document, snapshot, req.osdUser, cleanText(req.body?.changeNote, 500) || 'Draft updated');
      await appendAudit(client, { documentId: document.id, actorId: req.osdUser.id, actorLabel: req.osdUser.role, action: 'DRAFT VERSION UPDATED', version: saved.version, metadata: { changeNote: cleanText(req.body?.changeNote, 500) } });
      await client.query('COMMIT');
      const result = await req.osdPool.query('SELECT * FROM osd_documents WHERE id=$1', [document.id]);
      res.json({ document: safeDocument(result.rows[0], req.osdUser) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  async function transition(req, res, action, permission, from, to, options = {}) {
    const permissions = Array.isArray(permission) ? permission : [permission];
    if (!permissions.every((item) => hasPermission(req.osdUser, item))) return res.status(403).json({ error: 'You are not authorized to perform this action.' });
    const client = await req.osdPool.connect();
    try {
      await client.query('BEGIN');
      const document = await getDocument(client, cleanText(req.params.id, 100), true);
      if (!checkDocumentVisibility(req.osdUser, document, res)) {
        await client.query('ROLLBACK');
        return;
      }
      if (!from.includes(document.status)) {
        const expiredIssued = to === 'ARCHIVED' && document.status === 'ISSUED' && document.expires_at && new Date(document.expires_at).getTime() <= Date.now();
        if (expiredIssued) {
          // Expired documents may be archived without rewriting their issue record.
        } else {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Cannot ${action.toLowerCase()} a document in ${document.status} status.` });
        }
      }
      if (options.issue && !signingSecretReady(env.OSD_SIGNING_SECRET)) {
        await client.query('ROLLBACK');
        return res.status(503).json({ error: 'Set OSD_SIGNING_SECRET to at least 32 random bytes before issuing signed documents.' });
      }
      let signatureImage = null;
      if (options.issue) {
        try {
          signatureImage = normalizeSignatureImage(req.body?.signatureImage);
        } catch (error) {
          await client.query('ROLLBACK');
          return res.status(error.status || 400).json({ error: error.message });
        }
      }
      const fields = ['status=$2', 'updated_at=NOW()'];
      const params = [document.id, to];
      if (options.issue) {
        const signedAt = new Date().toISOString();
        const issuedSnapshot = {
          id: document.id,
          documentNumber: document.document_number,
          verificationCode: document.verification_code,
          type: document.document_type,
          title: document.title,
          body: document.body,
          sector: document.sector,
          classification: document.classification,
          recipient: document.recipient,
          version: document.version,
          issuedAt: signedAt,
          expiresAt: document.expires_at ? new Date(document.expires_at).toISOString() : null,
          authorizationLevel: req.osdUser.clearance,
          timeZone: 'UTC',
          signatureImage
        };
        const signaturePayload = { snapshot: issuedSnapshot, signerId: req.osdUser.id, signedAt };
        const signature = signPayload(signaturePayload, env.OSD_SIGNING_SECRET);
        const signerRecord = {
          signerId: req.osdUser.id,
          signerName: req.osdUser.displayName,
          signerRole: req.osdUser.role,
          authorizationLevel: req.osdUser.clearance,
          signedAt,
          signatureImage,
          signature,
          signaturePayload
        };
        params.push(signedAt, JSON.stringify(signerRecord), signature, JSON.stringify(issuedSnapshot));
        fields.push('issued_at=$3', 'signature=$4::jsonb', 'integrity_hash=$5', 'issued_snapshot=$6::jsonb');
      }
      if (options.revoke) {
        const reason = cleanText(req.body?.reason, 1000);
        if (!reason) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'A revocation reason is required.' });
        }
        params.push(reason);
        fields.push('revoked_at=NOW()', 'revoked_reason=$' + params.length);
      }
      await client.query(`UPDATE osd_documents SET ${fields.join(',')} WHERE id=$1`, params);
      await appendAudit(client, {
        documentId: document.id,
        actorId: req.osdUser.id,
        actorLabel: req.osdUser.role,
        action,
        version: document.version,
        metadata: options.revoke
          ? { reason: cleanText(req.body?.reason, 1000) }
          : options.issue ? { signatureImageHash: sha256(signatureImage.slice(signatureImage.indexOf(',') + 1)) } : {}
      });
      await client.query('COMMIT');
      const result = await req.osdPool.query('SELECT * FROM osd_documents WHERE id=$1', [document.id]);
      res.json({ document: safeDocument(result.rows[0], req.osdUser) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  router.post('/documents/:id/submit', currentUser, asyncRoute((req, res) =>
    transition(req, res, 'SUBMITTED FOR APPROVAL', 'SUBMIT_FOR_APPROVAL', ['DRAFT'], 'PENDING APPROVAL')));
  router.post('/documents/:id/approve', currentUser, asyncRoute((req, res) =>
    transition(req, res, 'DOCUMENT APPROVED', 'APPROVE_DOCUMENTS', ['PENDING APPROVAL'], 'APPROVED')));
  router.post('/documents/:id/issue', currentUser, asyncRoute((req, res) =>
    transition(req, res, 'DOCUMENT SIGNED AND ISSUED', ['SIGN_DOCUMENTS', 'ISSUE_DOCUMENTS'], ['APPROVED'], 'ISSUED', { issue: true })));
  router.post('/documents/:id/revoke', currentUser, asyncRoute((req, res) =>
    transition(req, res, 'DOCUMENT REVOKED', 'REVOKE_DOCUMENTS', ['ISSUED'], 'REVOKED', { revoke: true })));
  router.post('/documents/:id/archive', currentUser, asyncRoute((req, res) =>
    transition(req, res, 'DOCUMENT ARCHIVED', 'ARCHIVE_DOCUMENTS', ['ISSUED', 'REVOKED', 'EXPIRED'], 'ARCHIVED')));

  router.get('/documents/:id/versions', currentUser, requirePermission('VIEW_DOCUMENTS'), asyncRoute(async (req, res) => {
    const document = await getDocument(req.osdPool, cleanText(req.params.id, 100));
    if (!checkDocumentVisibility(req.osdUser, document, res)) return;
    const result = await req.osdPool.query(
      `SELECT version,snapshot,content_hash,actor_id,change_note,created_at
       FROM osd_document_versions WHERE document_id=$1 ORDER BY created_at DESC`,
      [document.id]
    );
    res.json({ versions: result.rows });
  }));

  router.get('/documents/:id/audit', currentUser, requirePermission('VIEW_AUDIT_TRAIL'), asyncRoute(async (req, res) => {
    const document = await getDocument(req.osdPool, cleanText(req.params.id, 100));
    if (!checkDocumentVisibility(req.osdUser, document, res)) return;
    const result = await req.osdPool.query(
      `SELECT id,actor_label,action,version,metadata,previous_hash,event_hash,created_at
       FROM osd_audit_events WHERE document_id=$1 ORDER BY id DESC LIMIT 200`,
      [document.id]
    );
    res.json({ events: result.rows });
  }));

  router.get('/verify/:identifier', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    const identifier = cleanText(req.params.identifier, 120);
    const result = await pool.query(
      `SELECT * FROM osd_documents WHERE id=$1 OR document_number=$1 OR verification_code=$1 LIMIT 1`,
      [identifier]
    );
    const document = result.rows[0];
    if (!document) return res.json({ status: 'DOCUMENT NOT FOUND' });
    if (document.status === 'REVOKED' || document.revoked_at) return res.json({ status: 'DOCUMENT REVOKED', documentNumber: document.document_number });
    if (!document.issued_snapshot || !document.signature || !signingSecretReady(env.OSD_SIGNING_SECRET)) {
      return res.json({ status: 'DOCUMENT NOT VERIFIED', documentNumber: document.document_number });
    }
    if (!['ISSUED', 'ARCHIVED'].includes(document.status)) {
      return res.json({ status: 'DOCUMENT NOT VERIFIED', documentNumber: document.document_number });
    }
    const snapshot = document.issued_snapshot;
    const currentSnapshot = {
      id: document.id,
      documentNumber: document.document_number,
      verificationCode: document.verification_code,
      type: document.document_type,
      title: document.title,
      body: document.body,
      sector: document.sector,
      classification: document.classification,
      recipient: document.recipient,
      version: document.version,
      issuedAt: document.issued_at ? new Date(document.issued_at).toISOString() : null,
      expiresAt: document.expires_at ? new Date(document.expires_at).toISOString() : null
    };
    if (Object.hasOwn(snapshot, 'authorizationLevel')) currentSnapshot.authorizationLevel = document.signature.authorizationLevel;
    if (Object.hasOwn(snapshot, 'timeZone')) currentSnapshot.timeZone = snapshot.timeZone;
    if (Object.hasOwn(snapshot, 'signatureImage')) currentSnapshot.signatureImage = document.signature.signatureImage;
    const payload = document.signature.signaturePayload;
    const expected = payload ? signPayload(payload, env.OSD_SIGNING_SECRET) : '';
    if (!payload || canonicalJson(snapshot) !== canonicalJson(payload.snapshot) ||
        canonicalJson(snapshot) !== canonicalJson(currentSnapshot) ||
        !safeEqual(expected, document.integrity_hash) || !safeEqual(expected, document.signature.signature)) {
      return res.json({ status: 'DOCUMENT INTEGRITY CHECK FAILED', documentNumber: document.document_number });
    }
    if (document.status === 'EXPIRED' || (document.expires_at && new Date(document.expires_at).getTime() <= Date.now())) {
      return res.json({ status: 'DOCUMENT EXPIRED', documentNumber: document.document_number });
    }
    res.json({
      status: 'DOCUMENT VALID',
      documentNumber: document.document_number,
      type: document.document_type,
      classification: document.classification,
      version: document.version,
      issuedAt: document.issued_at,
      verificationCode: document.verification_code
    });
  }));

  router.post('/documents/:id/share', currentUser, requirePermission('SHARE_DOCUMENTS'), asyncRoute(async (req, res) => {
    const document = await getDocument(req.osdPool, cleanText(req.params.id, 100));
    if (!checkDocumentVisibility(req.osdUser, document, res)) return;
    if (!['ISSUED', 'ARCHIVED'].includes(document.status) || document.revoked_at ||
        (document.expires_at && new Date(document.expires_at).getTime() <= Date.now())) {
      return res.status(409).json({ error: 'Only active issued documents can be shared.' });
    }
    const requested = Array.isArray(req.body?.permissions) ? req.body.permissions : ['VIEW', 'VERIFY'];
    const permissions = [...new Set(requested.filter((permission) => ['VIEW', 'DOWNLOAD', 'VERIFY'].includes(permission)))];
    if (!permissions.length) return res.status(400).json({ error: 'Select at least one share permission.' });
    const token = crypto.randomBytes(32).toString('base64url');
    const ttlDays = Math.max(1, Math.min(90, Number(req.body?.expiresInDays) || 14));
    const client = await req.osdPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO osd_document_shares (token_hash,document_id,permissions,expires_at,created_by)
         VALUES ($1,$2,$3::jsonb,NOW()+($4::text||' days')::interval,$5)`,
        [sha256(token), document.id, JSON.stringify(permissions), ttlDays, req.osdUser.id]
      );
      await appendAudit(client, { documentId: document.id, actorId: req.osdUser.id, actorLabel: req.osdUser.role, action: 'SECURE SHARE LINK CREATED', version: document.version, metadata: { permissions, expiresInDays: ttlDays } });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const origin = `${req.protocol === 'https' || String(req.get('x-forwarded-proto') || '').includes('https') ? 'https' : 'http'}://${req.get('host')}`;
    res.status(201).json({ url: `${origin}/osd/?share=${encodeURIComponent(token)}`, permissions, expiresInDays: ttlDays });
  }));

  router.get('/share/:token', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    const token = cleanText(req.params.token, 200);
    const result = await pool.query(
      `SELECT d.*,s.permissions AS share_permissions
       FROM osd_document_shares s JOIN osd_documents d ON d.id=s.document_id
       WHERE s.token_hash=$1 AND (s.expires_at IS NULL OR s.expires_at>NOW())`,
      [sha256(token)]
    );
    const document = result.rows[0];
    if (!document) return res.status(404).json({ error: 'Share link is invalid or expired.' });
    if (!['ISSUED', 'ARCHIVED'].includes(document.status) || document.revoked_at ||
        (document.expires_at && new Date(document.expires_at).getTime() <= Date.now())) {
      return res.status(410).json({ error: 'This document is no longer available.' });
    }
    const auditClient = await pool.connect();
    try {
      await auditClient.query('BEGIN');
      await appendAudit(auditClient, { documentId: document.id, actorLabel: 'SECURE LINK', action: 'SECURE SHARE LINK ACCESSED', version: document.version, metadata: { permissions: document.share_permissions } });
      await auditClient.query('COMMIT');
    } catch (error) {
      await auditClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      auditClient.release();
    }
    res.json({
      document: {
        id: document.id,
        documentNumber: document.document_number,
        verificationCode: document.verification_code,
        type: document.document_type,
        title: document.title,
        sector: document.sector,
        classification: document.classification,
        recipient: document.recipient,
        status: document.status,
        version: document.version,
        issuedAt: document.issued_at,
        expiresAt: document.expires_at,
        body: document.share_permissions.some((permission) => ['VIEW', 'DOWNLOAD'].includes(permission)) ? {
          text: document.issued_snapshot?.body?.text || '',
          references: document.issued_snapshot?.body?.references || []
        } : undefined,
        signer: 'AUTHORIZED COMMAND',
        signature: document.share_permissions.includes('DOWNLOAD') ? {
          display: 'AUTHORIZED COMMAND',
          signedAt: document.signature?.signedAt,
          authorizationLevel: document.signature?.authorizationLevel,
          signatureImage: document.signature?.signatureImage
        } : undefined
      },
      permissions: document.share_permissions
    });
  }));

  router.get('/users', currentUser, requirePermission('MANAGE_USERS'), asyncRoute(async (req, res) => {
    const result = await req.osdPool.query(
      `SELECT id,username,display_name,role,clearance,permissions,enabled,created_at
       FROM osd_users ORDER BY created_at`
    );
    res.json({ users: result.rows });
  }));

  router.post('/users', currentUser, requirePermission('MANAGE_USERS'), asyncRoute(async (req, res) => {
    const username = cleanText(req.body?.username, 60).toLowerCase();
    const displayName = cleanText(req.body?.displayName, 120);
    const role = cleanText(req.body?.role, 20).toUpperCase();
    const password = req.body?.password;
    if (!ROLE_DEFAULTS[role]) return res.status(400).json({ error: 'Choose a valid role.' });
    if (!/^[a-z0-9][a-z0-9._-]{2,59}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–60 letters, numbers, dots, underscores or hyphens.' });
    if (!displayName || !validPassword(password)) return res.status(400).json({ error: 'Display name is required; password must be at least 12 characters.' });
    let permissions = ROLE_DEFAULTS[role].permissions;
    if (req.body?.permissions !== undefined) {
      permissions = allowedPermissions(req.body.permissions);
      if (!permissions) return res.status(400).json({ error: 'One or more permissions are invalid.' });
    }
    const clearance = cleanText(req.body?.clearance, 40).toUpperCase();
    if (!CLASSIFICATIONS.includes(clearance)) return res.status(400).json({ error: 'Choose a valid clearance.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await passwordHash(password, salt);
    const id = crypto.randomUUID();
    const client = await req.osdPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO osd_users (id,username,display_name,password_salt,password_hash,role,clearance,permissions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [id, username, displayName, salt, hash, role, clearance, JSON.stringify(permissions)]
      );
      await appendAudit(client, {
        actorId: req.osdUser.id, actorLabel: req.osdUser.role, action: 'OSD USER CREATED',
        metadata: { username, role }
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error.code === '23505') return res.status(409).json({ error: 'Username is already in use.' });
      throw error;
    } finally {
      client.release();
    }
    res.status(201).json({ user: { id, username, displayName, role, clearance, permissions, enabled: true } });
  }));

  router.patch('/users/:id', currentUser, requirePermission('MANAGE_USERS'), asyncRoute(async (req, res) => {
    if (req.params.id === req.osdUser.id && req.body?.enabled === false) return res.status(400).json({ error: 'You cannot disable your own account.' });
    const fields = [];
    const values = [cleanText(req.params.id, 100)];
    let nextPermissions = null;
    if (typeof req.body?.enabled === 'boolean') {
      values.push(req.body.enabled);
      fields.push(`enabled=$${values.length}`);
    }
    if (req.body?.role !== undefined) {
      const role = cleanText(req.body.role, 20).toUpperCase();
      if (!ROLE_DEFAULTS[role]) return res.status(400).json({ error: 'Choose a valid role.' });
      values.push(role);
      fields.push(`role=$${values.length}`);
      values.push(JSON.stringify(ROLE_DEFAULTS[role].permissions));
      fields.push(`permissions=$${values.length}::jsonb`);
      nextPermissions = ROLE_DEFAULTS[role].permissions;
      values.push(ROLE_DEFAULTS[role].clearance);
      fields.push(`clearance=$${values.length}`);
    }
    if (req.body?.permissions !== undefined) {
      const permissions = allowedPermissions(req.body.permissions);
      if (!permissions) return res.status(400).json({ error: 'One or more permissions are invalid.' });
      values.push(JSON.stringify(permissions));
      fields.push(`permissions=$${values.length}::jsonb`);
      nextPermissions = permissions;
    }
    if (req.body?.clearance !== undefined) {
      const clearance = cleanText(req.body.clearance, 40).toUpperCase();
      if (!CLASSIFICATIONS.includes(clearance)) return res.status(400).json({ error: 'Choose a valid clearance.' });
      values.push(clearance);
      fields.push(`clearance=$${values.length}`);
    }
    if (!fields.length) return res.status(400).json({ error: 'No supported user fields provided.' });
    if (req.params.id === req.osdUser.id && nextPermissions && !nextPermissions.includes('MANAGE_USERS')) {
      return res.status(400).json({ error: 'You cannot remove your own user-management permission.' });
    }
    values.push(new Date().toISOString());
    fields.push(`updated_at=$${values.length}`);
    const client = await req.osdPool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE osd_users SET ${fields.join(',')} WHERE id=$1 RETURNING id,username,display_name,role,clearance,permissions,enabled,created_at`,
        values
      );
      if (!result.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found.' });
      }
      const managers = await client.query(
        `SELECT COUNT(*)::int AS count FROM osd_users
         WHERE enabled=TRUE AND permissions @> $1::jsonb`,
        [JSON.stringify(['MANAGE_USERS'])]
      );
      if (!managers.rows[0]?.count) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'At least one enabled user must retain user-management permission.' });
      }
      await appendAudit(client, {
        actorId: req.osdUser.id, actorLabel: req.osdUser.role, action: 'OSD USER UPDATED',
        metadata: { userId: req.params.id, changedFields: Object.keys(req.body || {}).filter((key) => ['enabled', 'role', 'permissions', 'clearance'].includes(key)) }
      });
      await client.query('COMMIT');
      res.json({ user: result.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  router.get('/audit', currentUser, requirePermission('VIEW_AUDIT_TRAIL'), asyncRoute(async (req, res) => {
    const result = await req.osdPool.query(
      `SELECT id,document_id,actor_label,action,version,metadata,event_hash,created_at
       FROM osd_audit_events ORDER BY id DESC LIMIT 100`
    );
    res.json({ events: result.rows });
  }));

  router.use((error, req, res, next) => {
    console.error('[OSD] Request failed:', error.message);
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'OSD could not complete the request.' });
  });

  router.initialize = initialize;
  return router;
}

module.exports = {
  ALL_PERMISSIONS,
  CLASSIFICATIONS,
  DOCUMENT_TYPES,
  ROLE_DEFAULTS,
  STATUSES,
  allowedPermissions,
  canReadClassification,
  canonicalJson,
  createOsdRouter,
  nextMinorVersion,
  normalizeDocument,
  normalizeSignatureImage,
  safeEqual,
  safeDocument,
  sectorCode,
  sha256,
  signPayload,
  signingSecretReady
};