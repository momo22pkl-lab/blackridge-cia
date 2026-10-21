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
    permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'MANAGE_USERS' && permission !== 'VIEW_REAL_SIGNER_IDENTITY')
  },
  ADMIN: {
    clearance: 'TOP SECRET',
    permissions: [...ALL_PERMISSIONS]
  }
});
const SESSION_HOURS = 8;
const MFA_CHALLENGE_MINUTES = 5;
const MFA_ENROLLMENT_MINUTES = 15;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const RECOVERY_CODE_COUNT = 10;
const MAX_BODY_LENGTH = 30000;
const DEFAULT_REPORT_COLOR = '#34332e';
const REPORT_FONT_FAMILIES = new Set(['IBM Plex Sans Arabic', 'IBM Plex Mono', 'Inter', 'Arial', 'Georgia', 'Tahoma']);
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
  military_code TEXT,
  personnel_id TEXT,
  is_primary_chief BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE osd_users ADD COLUMN IF NOT EXISTS military_code TEXT;
ALTER TABLE osd_users ADD COLUMN IF NOT EXISTS personnel_id TEXT;
ALTER TABLE osd_users ADD COLUMN IF NOT EXISTS is_primary_chief BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE osd_users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
ALTER TABLE osd_users ADD COLUMN IF NOT EXISTS recovery_code_hashes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE osd_users ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ;
ALTER TABLE osd_users ALTER COLUMN password_salt DROP NOT NULL;
ALTER TABLE osd_users ALTER COLUMN password_hash DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS osd_users_military_code_idx
  ON osd_users(military_code) WHERE military_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS osd_users_personnel_id_idx
  ON osd_users(personnel_id) WHERE personnel_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS osd_users_primary_chief_idx
  ON osd_users(is_primary_chief) WHERE is_primary_chief = TRUE;
CREATE TABLE IF NOT EXISTS osd_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES osd_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS osd_sessions_expiry_idx ON osd_sessions(expires_at);
-- Do not let sessions created before MFA enforcement survive a server restart.
DELETE FROM osd_sessions s USING osd_users u
  WHERE s.user_id = u.id AND u.is_primary_chief = TRUE;
CREATE TABLE IF NOT EXISTS osd_login_challenges (
  challenge_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES osd_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS osd_login_challenges_expiry_idx ON osd_login_challenges(expires_at);
CREATE TABLE IF NOT EXISTS osd_mfa_enrollments (
  enrollment_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES osd_users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  recovery_code_hashes JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);
CREATE INDEX IF NOT EXISTS osd_mfa_enrollments_expiry_idx ON osd_mfa_enrollments(expires_at);
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
  share_id TEXT,
  document_id TEXT NOT NULL REFERENCES osd_documents(id),
  permissions JSONB NOT NULL,
  share_mode TEXT NOT NULL DEFAULT 'PUBLIC',
  protected_view BOOLEAN NOT NULL DEFAULT TRUE,
  watermark TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT REFERENCES osd_users(id),
  created_by TEXT NOT NULL REFERENCES osd_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE osd_document_shares ADD COLUMN IF NOT EXISTS share_id TEXT;
ALTER TABLE osd_document_shares ADD COLUMN IF NOT EXISTS share_mode TEXT NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE osd_document_shares ADD COLUMN IF NOT EXISTS protected_view BOOLEAN;
ALTER TABLE osd_document_shares ADD COLUMN IF NOT EXISTS watermark TEXT NOT NULL DEFAULT '';
ALTER TABLE osd_document_shares ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE osd_document_shares ADD COLUMN IF NOT EXISTS revoked_by TEXT REFERENCES osd_users(id);
UPDATE osd_document_shares
  SET share_id = md5(token_hash || clock_timestamp()::text || random()::text)
  WHERE share_id IS NULL;
UPDATE osd_document_shares SET protected_view = FALSE WHERE protected_view IS NULL;
ALTER TABLE osd_document_shares ALTER COLUMN share_id SET NOT NULL;
ALTER TABLE osd_document_shares ALTER COLUMN protected_view SET DEFAULT TRUE;
ALTER TABLE osd_document_shares ALTER COLUMN protected_view SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS osd_document_shares_share_id_idx ON osd_document_shares(share_id);
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

function hasTotpEncryptionKey(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 32;
}

function totpEncryptionKey(value) {
  if (!hasTotpEncryptionKey(value)) {
    throw Object.assign(new Error('OSD_TOTP_ENCRYPTION_KEY is not configured.'), { status: 503 });
  }
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function encryptTotpSecret(secret, encryptionKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', totpEncryptionKey(encryptionKey), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptTotpSecret(encryptedSecret, encryptionKey) {
  const [version, iv, tag, ciphertext] = String(encryptedSecret || '').split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) {
    throw Object.assign(new Error('The stored authenticator secret is invalid.'), { status: 503 });
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', totpEncryptionKey(encryptionKey), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw Object.assign(new Error('The stored authenticator secret cannot be decrypted.'), { status: 503 });
  }
}

function encodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  let output = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(value || '').replace(/=+$/g, '').toUpperCase();
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error('The authenticator secret is invalid.');
  }
  let buffer = 0;
  let bits = 0;
  const output = [];
  for (const char of normalized) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  return Buffer.from(output);
}

function generateTotpSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

function totpCode(secret, time = Date.now()) {
  const counter = BigInt(Math.floor(time / 1000 / TOTP_PERIOD_SECONDS));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

function verifyTotp(secret, code, time = Date.now()) {
  const supplied = String(code || '').trim();
  if (!/^\d{6}$/.test(supplied)) return false;
  for (const offset of [-1, 0, 1]) {
    if (safeEqual(totpCode(secret, time + offset * TOTP_PERIOD_SECONDS * 1000), supplied)) return true;
  }
  return false;
}

function normalizeRecoveryCode(value) {
  const normalized = String(value || '').replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
  return /^[A-F0-9]{20}$/.test(normalized) ? normalized : '';
}

function recoveryCodeHash(value) {
  const normalized = normalizeRecoveryCode(value);
  return normalized ? sha256(normalized) : '';
}

function generateRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const value = crypto.randomBytes(10).toString('hex').toUpperCase();
    return value.match(/.{1,5}/g).join('-');
  });
}

function recoveryCodeIndex(hashes, code) {
  const digest = recoveryCodeHash(code);
  if (!digest || !Array.isArray(hashes)) return -1;
  return hashes.findIndex((hash) => safeEqual(hash, digest));
}

function authenticatorUri(secret, accountLabel = 'Primary Chief') {
  const issuer = 'BLACK RIDGE CIA';
  const label = `${issuer}:${accountLabel}`;
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${parameters.toString()}`;
}

function makeMfaEnrollment(secretKey, accountLabel = 'Primary Chief') {
  const secret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();
  return {
    secret,
    secretEncrypted: encryptTotpSecret(secret, secretKey),
    recoveryCodes,
    recoveryCodeHashes: recoveryCodes.map(recoveryCodeHash),
    otpauthUrl: authenticatorUri(secret, accountLabel),
    enrollmentToken: crypto.randomBytes(32).toString('base64url')
  };
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 200;
}

function normalizeMilitaryCode(value) {
  return cleanText(value, 100).toUpperCase();
}

function isEligiblePersonnel(person) {
  return !!person &&
    person.active !== false &&
    person.approved !== false &&
    person.serviceApproved !== false &&
    person.suspended !== true &&
    person.securityStatus !== 'SUSPENDED' &&
    person.securityStatus !== 'SECURITY_RESTRICTED' &&
    person.dismissed !== true;
}

function findPersonnelByCode(people, value) {
  const wanted = normalizeMilitaryCode(value);
  if (!wanted || wanted === 'PENDING' || !Array.isArray(people)) return null;
  const matches = people.filter((person) =>
    normalizeMilitaryCode(person.militaryCode || person.publicCode || person.code) === wanted);
  return matches.length === 1 && isEligiblePersonnel(matches[0]) ? matches[0] : null;
}

function roleProfileForPersonnel(person, isPrimaryChief = false) {
  const rank = cleanText(person?.rank, 100).toUpperCase();
  let role = 'AGENT';
  if (rank === 'CIA CHIEF') role = isPrimaryChief ? 'ADMIN' : 'COMMANDER';
  else if (rank === 'SUPREME COMMANDER' || rank === 'SENIOR COMMANDER CIA') role = 'COMMANDER';
  else if (rank === 'HIGH COMMANDER') role = 'SENIOR';
  const profile = ROLE_DEFAULTS[role];
  return { role, clearance: profile.clearance, permissions: [...profile.permissions] };
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

function normalizeShareOptions(input, classification, user) {
  const mode = cleanText(input?.mode || (classification === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL'), 20).toUpperCase();
  if (!['PUBLIC', 'INTERNAL'].includes(mode)) {
    throw Object.assign(new Error('Choose a valid share access mode.'), { status: 400 });
  }
  if (mode === 'PUBLIC' && classification !== 'PUBLIC') {
    throw Object.assign(new Error('Only PUBLIC documents may use a link that does not require sign-in.'), { status: 403 });
  }
  const rawDays = input?.expiresInDays === undefined ? 14 : Number(input.expiresInDays);
  if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > 90) {
    throw Object.assign(new Error('Share-link expiry must be between 1 and 90 days.'), { status: 400 });
  }
  const protectedView = input?.protectedView !== false;
  const requested = Array.isArray(input?.permissions) ? input.permissions : ['VIEW', 'VERIFY'];
  const permissions = [...new Set(requested.filter((permission) => ['VIEW', 'DOWNLOAD', 'VERIFY'].includes(permission)))];
  if (!permissions.includes('VIEW')) permissions.unshift('VIEW');
  if (protectedView && permissions.includes('DOWNLOAD')) {
    throw Object.assign(new Error('Protected viewing cannot include print or download access.'), { status: 400 });
  }
  if (permissions.includes('DOWNLOAD') && !hasPermission(user, 'DOWNLOAD_DOCUMENTS')) {
    throw Object.assign(new Error('Your account does not have permission to share document downloads.'), { status: 403 });
  }
  return {
    mode,
    protectedView,
    watermark: cleanText(input?.watermark, 100),
    expiresInDays: rawDays,
    permissions
  };
}

function shareAccessDecision({ mode, classification, permissions = [], revokedAt, shareExpiresAt, documentStatus, documentRevokedAt, documentExpiresAt, user }) {
  if (revokedAt) return 'LINK_REVOKED';
  if (shareExpiresAt && new Date(shareExpiresAt).getTime() <= Date.now()) return 'LINK_EXPIRED';
  if (!['ISSUED', 'ARCHIVED'].includes(documentStatus) || documentRevokedAt ||
      (documentExpiresAt && new Date(documentExpiresAt).getTime() <= Date.now())) return 'DOCUMENT_UNAVAILABLE';
  if (mode === 'PUBLIC') return classification === 'PUBLIC' ? 'ALLOW' : 'DOCUMENT_UNAVAILABLE';
  if (mode !== 'INTERNAL') return 'DOCUMENT_UNAVAILABLE';
  if (!user) return 'SIGN_IN_REQUIRED';
  if (!hasPermission(user, 'VIEW_DOCUMENTS') || !canReadClassification(user, classification)) return 'NOT_AUTHORIZED';
  if (!permissions.includes('VIEW') && !permissions.includes('DOWNLOAD')) return 'NOT_AUTHORIZED';
  return 'ALLOW';
}

function verificationResult(status, document) {
  const result = { status };
  if (!document) return result;
  if (document.classification !== 'PUBLIC' && document.verification_code) {
    result.documentNumber = document.document_number;
    return result;
  }
  result.documentNumber = document.document_number;
  if (status === 'DOCUMENT VALID' && document.classification === 'PUBLIC') {
    result.type = document.document_type;
    result.classification = document.classification;
    result.version = document.version;
    result.issuedAt = document.issued_at;
  }
  return result;
}

function verifyIssuedDocument(document, secret) {
  if (!document || !document.issued_snapshot || !document.signature || !signingSecretReady(secret)) return false;
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
  if (!payload) return false;
  const expected = signPayload(payload, secret);
  return canonicalJson(snapshot) === canonicalJson(payload.snapshot) &&
    canonicalJson(snapshot) === canonicalJson(currentSnapshot) &&
    safeEqual(expected, document.integrity_hash) &&
    safeEqual(expected, document.signature.signature);
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
  const bodyInput = input?.body;
  const bodyText = cleanText(typeof bodyInput === 'string' ? bodyInput : bodyInput?.text, MAX_BODY_LENGTH);
  const notes = cleanText(input?.notes ?? bodyInput?.notes, 3000);
  const referenceInput = Array.isArray(input?.references) ? input.references : bodyInput?.references;
  const references = Array.isArray(referenceInput)
    ? referenceInput.slice(0, 20).map((item) => cleanText(item, 300)).filter(Boolean)
    : [];
  const sectionInput = Array.isArray(input?.sections) ? input.sections : bodyInput?.sections;
  let remainingSectionText = MAX_BODY_LENGTH;
  const sections = Array.isArray(sectionInput)
    ? sectionInput.slice(0, 40).map((section) => {
      const text = cleanText(typeof section?.text === 'string' ? section.text : '', Math.max(0, remainingSectionText));
      remainingSectionText -= text.length;
      const color = cleanText(section?.color, 16);
      const fontFamily = cleanText(section?.fontFamily, 80);
      return {
        text,
        color: /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_REPORT_COLOR,
        fontFamily: REPORT_FONT_FAMILIES.has(fontFamily) ? fontFamily : 'IBM Plex Sans Arabic'
      };
    }).filter((section) => section.text)
    : [];
  const expiresAt = input?.expiresAt ? new Date(input.expiresAt) : null;

  if (!DOCUMENT_TYPES.includes(documentType)) throw Object.assign(new Error('Choose a valid document type.'), { status: 400 });
  if (!title) throw Object.assign(new Error('Document title is required.'), { status: 400 });
  if (!sector) throw Object.assign(new Error('Sector is required.'), { status: 400 });
  if (!CLASSIFICATIONS.includes(classification)) throw Object.assign(new Error('Choose a valid classification.'), { status: 400 });
  if (!bodyText) throw Object.assign(new Error('Document content is required.'), { status: 400 });
  if (input?.expiresAt && Number.isNaN(expiresAt.getTime())) throw Object.assign(new Error('Expiration date is invalid.'), { status: 400 });
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw Object.assign(new Error('Expiration must be in the future.'), { status: 400 });
  const body = { text: bodyText, notes, references };
  if (sections.length) body.sections = sections;
  return {
    type: documentType,
    title,
    sector,
    classification,
    recipient,
    body,
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

function createOsdRouter({ getPool, getPersonnel = () => [], env = process.env } = {}) {
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

  function personnelRoster() {
    const people = typeof getPersonnel === 'function' ? getPersonnel() : [];
    return Array.isArray(people) ? people : [];
  }

  function personnelForAccount(account) {
    const people = personnelRoster();
    const byId = account?.personnel_id
      ? people.find((person) => String(person.id || '') === String(account.personnel_id))
      : null;
    if (account?.personnel_id) return isEligiblePersonnel(byId) ? byId : null;
    return findPersonnelByCode(people, account?.military_code);
  }

  function publicUser(account, person) {
    const militaryCode = normalizeMilitaryCode(person?.militaryCode || person?.publicCode || person?.code);
    const profile = roleProfileForPersonnel(person, account?.is_primary_chief === true);
    return {
      id: account.id,
      username: account.username,
      militaryCode,
      displayName: cleanText(person?.displayName || person?.name || account.display_name, 120),
      rank: cleanText(person?.rank, 100).toUpperCase(),
      role: profile.role,
      clearance: profile.clearance,
      permissions: profile.permissions,
      enabled: account.enabled === true
    };
  }

  async function findAccountForPersonnel(client, person) {
    const personnelId = String(person.id || '');
    const militaryCode = normalizeMilitaryCode(person.militaryCode || person.publicCode || person.code);
    const linked = await client.query(
      `SELECT * FROM osd_users
       WHERE personnel_id = $1 OR military_code = $2
       ORDER BY CASE WHEN personnel_id = $1 THEN 0 ELSE 1 END LIMIT 2`,
      [personnelId, militaryCode]
    );
    if (linked.rows.length > 1) {
      throw Object.assign(new Error('This military code is linked to conflicting document accounts.'), { status: 409 });
    }
    if (linked.rows.length) {
      const account = linked.rows[0];
      if (account.personnel_id && String(account.personnel_id) !== personnelId) {
        throw Object.assign(new Error('This military code is already linked to a different personnel record.'), { status: 409 });
      }
      return account;
    }
    const legacy = await client.query(
      `SELECT * FROM osd_users
       WHERE LOWER(username) = LOWER($1) AND military_code IS NULL AND personnel_id IS NULL LIMIT 1`,
      [militaryCode]
    );
    return legacy.rows[0] || null;
  }

  async function linkPersonnelAccount(pool, person, options = {}) {
    const personnelId = String(person?.id || '');
    const militaryCode = normalizeMilitaryCode(person?.militaryCode || person?.publicCode || person?.code);
    if (!personnelId || !militaryCode || !isEligiblePersonnel(person)) {
      throw Object.assign(new Error('This military code is not attached to an active personnel account.'), { status: 401 });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (options.initializeChief) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('osd-chief-bootstrap'))");
        const existingChief = await client.query('SELECT id FROM osd_users WHERE is_primary_chief = TRUE LIMIT 1');
        if (existingChief.rows.length) {
          throw Object.assign(new Error('The primary chief account has already been initialized.'), { status: 409 });
        }
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`osd-personnel:${personnelId}`]);
      const account = await findAccountForPersonnel(client, person);
      const isPrimaryChief = options.initializeChief === true || account?.is_primary_chief === true;
      const profile = roleProfileForPersonnel(person, isPrimaryChief);
      let saved;
      if (account) {
        const result = await client.query(
          `UPDATE osd_users SET military_code=$2,personnel_id=$3,display_name=$4,role=$5,
           clearance=$6,permissions=$7::jsonb,is_primary_chief=$8,
           password_salt=COALESCE($9,password_salt),password_hash=COALESCE($10,password_hash),
           enabled=CASE WHEN $11 THEN TRUE ELSE enabled END,updated_at=NOW()
           WHERE id=$1 RETURNING *`,
          [
            account.id, militaryCode, personnelId,
            cleanText(person.displayName || person.name || account.display_name, 120),
            profile.role, profile.clearance, JSON.stringify(profile.permissions), isPrimaryChief,
            options.passwordSalt || null, options.passwordHash || null, options.initializeChief === true
          ]
        );
        saved = result.rows[0];
      } else {
        const id = crypto.randomUUID();
        const username = `cia-${sha256(personnelId).slice(0, 32)}`;
        const result = await client.query(
          `INSERT INTO osd_users
           (id,username,display_name,password_salt,password_hash,role,clearance,permissions,
            military_code,personnel_id,is_primary_chief,enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,TRUE) RETURNING *`,
          [
            id, username, cleanText(person.displayName || person.name || militaryCode, 120),
            options.passwordSalt || null, options.passwordHash || null, profile.role,
            profile.clearance, JSON.stringify(profile.permissions), militaryCode, personnelId, isPrimaryChief
          ]
        );
        saved = result.rows[0];
        await appendAudit(client, {
          actorId: id,
          actorLabel: profile.role,
          action: options.initializeChief ? 'OSD PRIMARY CHIEF ACCOUNT INITIALIZED' : 'OSD PERSONNEL ACCOUNT LINKED',
          metadata: { militaryCode, rank: cleanText(person.rank, 100).toUpperCase() }
        });
      }
      if (!saved) throw new Error('The OSD personnel account could not be saved.');
      if (options.initializeChief && account) {
        await appendAudit(client, {
          actorId: saved.id,
          actorLabel: 'ADMIN',
          action: 'OSD PRIMARY CHIEF ACCOUNT INITIALIZED',
          metadata: { militaryCode }
        });
      }
      if (options.mfaEnrollment) {
        await client.query('DELETE FROM osd_mfa_enrollments WHERE user_id=$1', [saved.id]);
        await client.query(
          `INSERT INTO osd_mfa_enrollments
           (enrollment_hash,user_id,secret_enc,recovery_code_hashes,expires_at)
           VALUES ($1,$2,$3,$4::jsonb,NOW() + INTERVAL '${MFA_ENROLLMENT_MINUTES} minutes')`,
          [
            sha256(options.mfaEnrollment.enrollmentToken),
            saved.id,
            options.mfaEnrollment.secretEncrypted,
            JSON.stringify(options.mfaEnrollment.recoveryCodeHashes)
          ]
        );
      }
      await client.query('COMMIT');
      return saved;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error.code === '23505') {
        throw Object.assign(new Error('This military code or personnel account is already linked.'), { status: 409 });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadUser(req, pool) {
    const cookie = String(req.headers.cookie || '').split(';').map((item) => item.trim())
      .find((item) => item.startsWith('osd_session='));
    let token = '';
    try {
      token = cookie ? decodeURIComponent(cookie.slice('osd_session='.length)) : '';
    } catch {
      token = '';
    }
    if (!token || token.length > 200) return null;
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.role, u.clearance, u.permissions,
              u.military_code, u.personnel_id, u.is_primary_chief, u.enabled
       FROM osd_sessions s JOIN osd_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.enabled = TRUE`,
      [sha256(token)]
    );
    if (!result.rows.length) return null;
    const account = result.rows[0];
    const person = personnelForAccount(account);
    const currentMilitaryCode = normalizeMilitaryCode(person?.militaryCode || person?.publicCode || person?.code);
    if (!person || !account.military_code || !account.personnel_id ||
        normalizeMilitaryCode(account.military_code) !== currentMilitaryCode) return null;
    return publicUser(account, person);
  }

  function currentUser(req, res, next) {
    Promise.resolve().then(async () => {
      const pool = await poolOr503(res);
      if (!pool) return;
      req.osdUser = await loadUser(req, pool);
      if (!req.osdUser) {
        res.setHeader('Set-Cookie', clearSessionCookie(req));
        return res.status(401).json({ error: 'Authentication required. Sign in with an active OSD account.' });
      }
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

  function mfaChallengeCookie(token, req) {
    const secure = req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https' || env.NODE_ENV === 'production';
    return `osd_mfa_challenge=${encodeURIComponent(token)}; Path=/api/osd/auth; HttpOnly; SameSite=Strict; Max-Age=${MFA_CHALLENGE_MINUTES * 60}${secure ? '; Secure' : ''}`;
  }

  function clearMfaChallengeCookie(req) {
    const secure = req?.secure || String(req?.get?.('x-forwarded-proto') || '').split(',')[0].trim() === 'https' || env.NODE_ENV === 'production';
    return `osd_mfa_challenge=; Path=/api/osd/auth; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  function requestCookie(req, name) {
    const cookie = String(req.headers.cookie || '').split(';')
      .map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
    try {
      return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : '';
    } catch {
      return '';
    }
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
    const result = await pool.query('SELECT EXISTS(SELECT 1 FROM osd_users WHERE is_primary_chief = TRUE) AS initialized');
    const bootstrapCode = cleanText(env.OSD_BOOTSTRAP_CODE, 300);
    const enrollmentCode = cleanText(env.OSD_CHIEF_TOTP_ENROLLMENT_CODE, 300);
    res.json({
      needed: !result.rows[0].initialized,
      configured: bootstrapCode.length >= 24 &&
        enrollmentCode.length >= 24 &&
        !safeEqual(bootstrapCode, enrollmentCode) &&
        hasTotpEncryptionKey(env.OSD_TOTP_ENCRYPTION_KEY)
    });
  }));

  router.post('/bootstrap', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    if (loginRateLimited(req)) return res.status(429).json({ error: 'تجاوزت عدد المحاولات. انتظر 15 دقيقة ثم أعد المحاولة.' });
    const configuredCode = cleanText(env.OSD_BOOTSTRAP_CODE, 300);
    if (configuredCode.length < 24) return res.status(503).json({ error: 'إعداد القائد الأول غير متاح؛ يجب تهيئة OSD_BOOTSTRAP_CODE على الخادم.' });
    const enrollmentCode = cleanText(env.OSD_CHIEF_TOTP_ENROLLMENT_CODE, 300);
    if (enrollmentCode.length < 24 || safeEqual(configuredCode, enrollmentCode)) {
      return res.status(503).json({ error: 'إعداد رمز مستقل لإعادة بدء تهيئة مصادقة القائد مطلوب على الخادم.' });
    }
    if (!hasTotpEncryptionKey(env.OSD_TOTP_ENCRYPTION_KEY)) {
      return res.status(503).json({ error: 'إعداد المصادقة غير متاح؛ يجب تهيئة OSD_TOTP_ENCRYPTION_KEY على الخادم.' });
    }
    if (!safeEqual(cleanText(req.body?.bootstrapCode, 300), configuredCode)) return res.status(403).json({ error: 'رمز التأسيس غير صحيح.' });
    const militaryCode = normalizeMilitaryCode(req.body?.militaryCode);
    const person = findPersonnelByCode(personnelRoster(), militaryCode);
    if (!person || cleanText(person.rank, 100).toUpperCase() !== 'CIA CHIEF') {
      return res.status(403).json({ error: 'لا يمكن تأسيس القيادة إلا بكود القائد المعتمد والمسجل في النظام.' });
    }
    const password = req.body?.masterPassword;
    const confirmPassword = req.body?.confirmPassword;
    if (!validPassword(password)) return res.status(400).json({ error: 'يجب أن تتكون كلمة السر الرئيسية من 12 إلى 200 حرف.' });
    if (password !== confirmPassword) return res.status(400).json({ error: 'تأكيد كلمة السر غير مطابق.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await passwordHash(password, salt);
    const mfaEnrollment = makeMfaEnrollment(env.OSD_TOTP_ENCRYPTION_KEY);
    try {
      const account = await linkPersonnelAccount(pool, person, {
        initializeChief: true,
        passwordSalt: salt,
        passwordHash: hash,
        mfaEnrollment
      });
      res.status(201).json({
        created: true,
        militaryCode: account.military_code,
        mfaEnrollment: {
          enrollmentToken: mfaEnrollment.enrollmentToken,
          secret: mfaEnrollment.secret,
          otpauthUrl: mfaEnrollment.otpauthUrl,
          recoveryCodes: mfaEnrollment.recoveryCodes
        }
      });
    } catch (error) {
      if (error.status === 409) return res.status(409).json({ error: error.message });
      throw error;
    }
  }));

  router.post('/auth/mfa/enroll/start', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    if (loginRateLimited(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    if (!hasTotpEncryptionKey(env.OSD_TOTP_ENCRYPTION_KEY)) {
      return res.status(503).json({ error: 'Authenticator enrollment is unavailable. Check server configuration.' });
    }
    const enrollmentCode = cleanText(env.OSD_CHIEF_TOTP_ENROLLMENT_CODE, 300);
    if (enrollmentCode.length < 24 || safeEqual(enrollmentCode, cleanText(env.OSD_BOOTSTRAP_CODE, 300))) {
      return res.status(503).json({ error: 'Existing-chief authenticator enrollment is not configured on the server.' });
    }
    if (!safeEqual(cleanText(req.body?.enrollmentCode, 300), enrollmentCode)) {
      return res.status(403).json({ error: 'The separate enrollment code is incorrect.' });
    }
    const militaryCode = normalizeMilitaryCode(req.body?.militaryCode);
    const person = findPersonnelByCode(personnelRoster(), militaryCode);
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 201) : '';
    if (!person || cleanText(person.rank, 100).toUpperCase() !== 'CIA CHIEF' || !validPassword(password)) {
      return res.status(401).json({ error: 'The primary leader credentials are not valid.' });
    }
    const result = await pool.query(
      `SELECT * FROM osd_users
       WHERE personnel_id = $1 OR military_code = $2
       ORDER BY CASE WHEN personnel_id = $1 THEN 0 ELSE 1 END LIMIT 2`,
      [String(person.id), militaryCode]
    );
    const account = result.rows.length === 1 && result.rows[0].is_primary_chief === true &&
      String(result.rows[0].personnel_id || '') === String(person.id || '') &&
      normalizeMilitaryCode(result.rows[0].military_code) === militaryCode &&
      result.rows[0].enabled === true
      ? result.rows[0]
      : null;
    const supplied = await passwordHash(password, account?.password_salt || 'osd-static-chief-not-found');
    if (!account || !safeEqual(supplied, account.password_hash)) {
      return res.status(401).json({ error: 'The primary leader credentials are not valid.' });
    }
    if (account.mfa_enabled_at || account.totp_secret_enc) {
      return res.status(409).json({ error: 'Authenticator protection is already enabled and cannot be reset here.' });
    }

    const enrollment = makeMfaEnrollment(env.OSD_TOTP_ENCRYPTION_KEY);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT id,totp_secret_enc,mfa_enabled_at FROM osd_users WHERE id=$1 AND is_primary_chief=TRUE AND enabled=TRUE FOR UPDATE',
        [account.id]
      );
      if (!locked.rows.length || locked.rows[0].mfa_enabled_at || locked.rows[0].totp_secret_enc) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Authenticator protection is already enabled and cannot be reset here.' });
      }
      await client.query('DELETE FROM osd_mfa_enrollments WHERE user_id=$1', [account.id]);
      await client.query(
        `INSERT INTO osd_mfa_enrollments
         (enrollment_hash,user_id,secret_enc,recovery_code_hashes,expires_at)
         VALUES ($1,$2,$3,$4::jsonb,NOW() + INTERVAL '${MFA_ENROLLMENT_MINUTES} minutes')`,
        [
          sha256(enrollment.enrollmentToken),
          account.id,
          enrollment.secretEncrypted,
          JSON.stringify(enrollment.recoveryCodeHashes)
        ]
      );
      await client.query('COMMIT');
      res.status(201).json({
        mfaEnrollment: {
          enrollmentToken: enrollment.enrollmentToken,
          secret: enrollment.secret,
          otpauthUrl: enrollment.otpauthUrl,
          recoveryCodes: enrollment.recoveryCodes
        }
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  router.post('/auth/mfa/enroll/confirm', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    if (loginRateLimited(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    if (!hasTotpEncryptionKey(env.OSD_TOTP_ENCRYPTION_KEY)) {
      return res.status(503).json({ error: 'Authenticator verification is unavailable. Check server configuration.' });
    }
    const enrollmentToken = typeof req.body?.enrollmentToken === 'string' ? req.body.enrollmentToken.slice(0, 200) : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.slice(0, 100) : '';
    if (!enrollmentToken) return res.status(401).json({ error: 'Authenticator setup expired. Start setup again.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT e.enrollment_hash,e.user_id,e.secret_enc,e.recovery_code_hashes,e.failed_attempts,
                u.is_primary_chief,u.enabled,u.military_code,u.personnel_id
         FROM osd_mfa_enrollments e JOIN osd_users u ON u.id=e.user_id
         WHERE e.enrollment_hash=$1 AND e.expires_at>NOW()
         FOR UPDATE OF e`,
        [sha256(enrollmentToken)]
      );
      const enrollment = result.rows[0];
      const account = enrollment && {
        id: enrollment.user_id,
        is_primary_chief: enrollment.is_primary_chief,
        enabled: enrollment.enabled,
        military_code: enrollment.military_code,
        personnel_id: enrollment.personnel_id
      };
      const person = account && personnelForAccount(account);
      if (!enrollment || !account.is_primary_chief || !account.enabled || !person ||
          cleanText(person.rank, 100).toUpperCase() !== 'CIA CHIEF') {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Authenticator setup expired or is not authorized.' });
      }
      const secret = decryptTotpSecret(enrollment.secret_enc, env.OSD_TOTP_ENCRYPTION_KEY);
      if (!verifyTotp(secret, code)) {
        if (Number(enrollment.failed_attempts || 0) + 1 >= 5) {
          await client.query('DELETE FROM osd_mfa_enrollments WHERE enrollment_hash=$1', [enrollment.enrollment_hash]);
        } else {
          await client.query(
            'UPDATE osd_mfa_enrollments SET failed_attempts=failed_attempts+1 WHERE enrollment_hash=$1',
            [enrollment.enrollment_hash]
          );
        }
        await client.query('COMMIT');
        return res.status(401).json({ error: 'The authenticator code is incorrect or expired.' });
      }
      const updated = await client.query(
        `UPDATE osd_users
         SET totp_secret_enc=$2,recovery_code_hashes=$3::jsonb,mfa_enabled_at=NOW(),updated_at=NOW()
         WHERE id=$1 AND is_primary_chief=TRUE AND enabled=TRUE
           AND totp_secret_enc IS NULL AND mfa_enabled_at IS NULL
         RETURNING id`,
        [account.id, enrollment.secret_enc, JSON.stringify(enrollment.recovery_code_hashes)]
      );
      if (!updated.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Authenticator protection is already enabled and cannot be reset here.' });
      }
      await client.query('DELETE FROM osd_sessions WHERE user_id=$1', [account.id]);
      await client.query('DELETE FROM osd_mfa_enrollments WHERE enrollment_hash=$1', [enrollment.enrollment_hash]);
      await client.query('COMMIT');
      loginAttempts.delete(String(req.ip || req.socket?.remoteAddress || 'unknown'));
      res.json({ enabled: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  router.post('/auth/login', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    if (loginRateLimited(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    const mode = cleanText(req.body?.mode, 20).toLowerCase();
    if (!['leader', 'member'].includes(mode)) return res.status(400).json({ error: 'اختر نوع الدخول.' });
    const militaryCode = normalizeMilitaryCode(req.body?.militaryCode);
    const person = findPersonnelByCode(personnelRoster(), militaryCode);
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 201) : '';
    let account = null;

    if (mode === 'leader') {
      const isRegisteredChief = person && cleanText(person.rank, 100).toUpperCase() === 'CIA CHIEF';
      const result = isRegisteredChief
        ? await pool.query(
          `SELECT * FROM osd_users WHERE personnel_id = $1 OR military_code = $2 ORDER BY CASE WHEN personnel_id = $1 THEN 0 ELSE 1 END LIMIT 2`,
          [String(person.id), militaryCode]
        )
        : { rows: [] };
      account = result.rows.length === 1 && result.rows[0].is_primary_chief === true &&
        String(result.rows[0].personnel_id || '') === String(person?.id || '') &&
        normalizeMilitaryCode(result.rows[0].military_code) === militaryCode
        ? result.rows[0]
        : null;
      const supplied = await passwordHash(password, account?.password_salt || 'osd-static-chief-not-found');
      if (!isRegisteredChief || !account || account.enabled !== true ||
          !validPassword(password) || !safeEqual(supplied, account.password_hash)) {
        return res.status(401).json({ error: 'بيانات القائد غير صحيحة أو لا تطابق الحساب المعتمد.' });
      }
      if (!account.mfa_enabled_at || !account.totp_secret_enc) {
        return res.status(428).json({
          code: 'MFA_SETUP_REQUIRED',
          error: 'يجب إعداد تطبيق المصادقة للقائد قبل تسجيل الدخول.'
        });
      }
      if (!hasTotpEncryptionKey(env.OSD_TOTP_ENCRYPTION_KEY)) {
        return res.status(503).json({ error: 'Authenticator sign-in is unavailable. Check server configuration.' });
      }
      const challengeToken = crypto.randomBytes(32).toString('base64url');
      await pool.query('DELETE FROM osd_login_challenges WHERE expires_at<=NOW()');
      await pool.query(
        `INSERT INTO osd_login_challenges (challenge_hash,user_id,expires_at)
         VALUES ($1,$2,NOW() + INTERVAL '${MFA_CHALLENGE_MINUTES} minutes')`,
        [sha256(challengeToken), account.id]
      );
      res.setHeader('Set-Cookie', [
        clearSessionCookie(req),
        mfaChallengeCookie(challengeToken, req)
      ]);
      return res.status(202).json({ mfaRequired: true });
    } else {
      const isChiefCode = person && cleanText(person.rank, 100).toUpperCase() === 'CIA CHIEF';
      if (!person || isChiefCode) {
        return res.status(401).json({ error: 'الكود العسكري غير صحيح أو غير مسجل لحساب فرد أو قيادة.' });
      }
      account = await linkPersonnelAccount(pool, person);
      if (account.enabled !== true) {
        return res.status(403).json({ error: 'هذا الحساب موقوف؛ راجع القائد المعتمد.' });
      }
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    await pool.query('DELETE FROM osd_sessions WHERE expires_at < NOW()');
    await pool.query(
      `INSERT INTO osd_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,NOW() + INTERVAL '${SESSION_HOURS} hours')`,
      [tokenHash, account.id]
    );
    loginAttempts.delete(String(req.ip || req.socket?.remoteAddress || 'unknown'));
    res.setHeader('Set-Cookie', [sessionCookie(token, req), clearMfaChallengeCookie(req)]);
    res.json({ user: publicUser(account, person) });
  }));

  router.post('/auth/mfa/verify', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    if (loginRateLimited(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    if (!hasTotpEncryptionKey(env.OSD_TOTP_ENCRYPTION_KEY)) {
      return res.status(503).json({ error: 'Authenticator sign-in is unavailable. Check server configuration.' });
    }
    const challengeToken = requestCookie(req, 'osd_mfa_challenge');
    const code = typeof req.body?.code === 'string' ? req.body.code.slice(0, 100) : '';
    if (!challengeToken || challengeToken.length > 200) {
      res.setHeader('Set-Cookie', clearMfaChallengeCookie(req));
      return res.status(401).json({ error: 'The sign-in challenge expired. Enter your password again.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT c.challenge_hash,c.user_id,c.failed_attempts,
                u.id,u.username,u.display_name,u.role,u.clearance,u.permissions,
                u.military_code,u.personnel_id,u.is_primary_chief,u.enabled,
                u.totp_secret_enc,u.recovery_code_hashes,u.mfa_enabled_at
         FROM osd_login_challenges c JOIN osd_users u ON u.id=c.user_id
         WHERE c.challenge_hash=$1 AND c.expires_at>NOW()
         FOR UPDATE OF c,u`,
        [sha256(challengeToken)]
      );
      const account = result.rows[0];
      const person = account && personnelForAccount(account);
      if (!account || !account.is_primary_chief || !account.enabled ||
          !account.mfa_enabled_at || !account.totp_secret_enc || !person ||
          cleanText(person.rank, 100).toUpperCase() !== 'CIA CHIEF') {
        await client.query('ROLLBACK');
        res.setHeader('Set-Cookie', clearMfaChallengeCookie(req));
        return res.status(401).json({ error: 'The sign-in challenge expired. Enter your password again.' });
      }

      const secret = decryptTotpSecret(account.totp_secret_enc, env.OSD_TOTP_ENCRYPTION_KEY);
      const validTotp = verifyTotp(secret, code);
      const hashes = Array.isArray(account.recovery_code_hashes) ? account.recovery_code_hashes : [];
      const recoveryIndex = validTotp ? -1 : recoveryCodeIndex(hashes, code);
      if (!validTotp && recoveryIndex < 0) {
        if (Number(account.failed_attempts || 0) + 1 >= 5) {
          await client.query('DELETE FROM osd_login_challenges WHERE challenge_hash=$1', [account.challenge_hash]);
        } else {
          await client.query(
            'UPDATE osd_login_challenges SET failed_attempts=failed_attempts+1 WHERE challenge_hash=$1',
            [account.challenge_hash]
          );
        }
        await client.query('COMMIT');
        return res.status(401).json({ error: 'The authenticator or recovery code is incorrect or expired.' });
      }
      if (recoveryIndex >= 0) {
        const remainingCodes = hashes.filter((_, index) => index !== recoveryIndex);
        await client.query(
          'UPDATE osd_users SET recovery_code_hashes=$2::jsonb,updated_at=NOW() WHERE id=$1',
          [account.id, JSON.stringify(remainingCodes)]
        );
      }

      const token = crypto.randomBytes(32).toString('base64url');
      await client.query('DELETE FROM osd_sessions WHERE expires_at<NOW()');
      await client.query(
        `INSERT INTO osd_sessions (token_hash,user_id,expires_at)
         VALUES ($1,$2,NOW() + INTERVAL '${SESSION_HOURS} hours')`,
        [sha256(token), account.id]
      );
      await client.query('DELETE FROM osd_login_challenges WHERE challenge_hash=$1', [account.challenge_hash]);
      await client.query('COMMIT');
      loginAttempts.delete(String(req.ip || req.socket?.remoteAddress || 'unknown'));
      res.setHeader('Set-Cookie', [sessionCookie(token, req), clearMfaChallengeCookie(req)]);
      res.json({ user: publicUser(account, person) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  router.post('/auth/mfa/cancel', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    const challengeToken = requestCookie(req, 'osd_mfa_challenge');
    if (challengeToken && challengeToken.length <= 200) {
      await pool.query('DELETE FROM osd_login_challenges WHERE challenge_hash=$1', [sha256(challengeToken)]);
    }
    res.setHeader('Set-Cookie', clearMfaChallengeCookie(req));
    res.json({ cancelled: true });
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
        references: prior.body?.references, sections: prior.body?.sections, expiresAt: prior.expiresAt
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
    if (!document) return res.json(verificationResult('DOCUMENT NOT FOUND'));
    if (document.classification !== 'PUBLIC' && document.verification_code !== identifier) {
      return res.json(verificationResult('DOCUMENT NOT VERIFIED'));
    }
    if (document.status === 'REVOKED' || document.revoked_at) return res.json(verificationResult('DOCUMENT REVOKED', document));
    if (!document.issued_snapshot || !document.signature || !signingSecretReady(env.OSD_SIGNING_SECRET)) {
      return res.json(verificationResult('DOCUMENT NOT VERIFIED', document));
    }
    if (!['ISSUED', 'ARCHIVED'].includes(document.status)) {
      return res.json(verificationResult('DOCUMENT NOT VERIFIED', document));
    }
    if (!verifyIssuedDocument(document, env.OSD_SIGNING_SECRET)) {
      return res.json(verificationResult('DOCUMENT INTEGRITY CHECK FAILED', document));
    }
    if (document.status === 'EXPIRED' || (document.expires_at && new Date(document.expires_at).getTime() <= Date.now())) {
      return res.json(verificationResult('DOCUMENT EXPIRED', document));
    }
    res.json(verificationResult('DOCUMENT VALID', document));
  }));

  router.post('/documents/:id/share', currentUser, requirePermission('SHARE_DOCUMENTS'), asyncRoute(async (req, res) => {
    const document = await getDocument(req.osdPool, cleanText(req.params.id, 100));
    if (!checkDocumentVisibility(req.osdUser, document, res)) return;
    if (!['ISSUED', 'ARCHIVED'].includes(document.status) || document.revoked_at ||
        (document.expires_at && new Date(document.expires_at).getTime() <= Date.now())) {
      return res.status(409).json({ error: 'Only active issued documents can be shared.' });
    }
    if (!signingSecretReady(env.OSD_SIGNING_SECRET)) {
      return res.status(503).json({ error: 'Document integrity verification is temporarily unavailable.' });
    }
    if (!verifyIssuedDocument(document, env.OSD_SIGNING_SECRET)) {
      return res.status(409).json({ error: 'Document integrity verification failed; a share link was not created.' });
    }
    let settings;
    try {
      settings = normalizeShareOptions(req.body, document.classification, req.osdUser);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const shareId = crypto.randomUUID();
    const client = await req.osdPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO osd_document_shares
         (token_hash,share_id,document_id,permissions,share_mode,protected_view,watermark,expires_at,created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,NOW()+($8::text||' days')::interval,$9)`,
        [sha256(token), shareId, document.id, JSON.stringify(settings.permissions), settings.mode,
          settings.protectedView, settings.watermark, settings.expiresInDays, req.osdUser.id]
      );
      await appendAudit(client, {
        documentId: document.id,
        actorId: req.osdUser.id,
        actorLabel: req.osdUser.role,
        action: 'SECURE SHARE LINK CREATED',
        version: document.version,
        metadata: { shareId, mode: settings.mode, protectedView: settings.protectedView, permissions: settings.permissions, expiresInDays: settings.expiresInDays }
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    res.status(201).json({
      url: `/osd/share.html?token=${encodeURIComponent(token)}`,
      shareId,
      mode: settings.mode,
      protectedView: settings.protectedView,
      watermark: settings.watermark,
      permissions: settings.permissions,
      expiresInDays: settings.expiresInDays,
      expiresAt: new Date(Date.now() + settings.expiresInDays * 86400000).toISOString()
    });
  }));

  router.get('/documents/:id/shares', currentUser, requirePermission('SHARE_DOCUMENTS'), asyncRoute(async (req, res) => {
    const document = await getDocument(req.osdPool, cleanText(req.params.id, 100));
    if (!checkDocumentVisibility(req.osdUser, document, res)) return;
    const result = await req.osdPool.query(
      `SELECT share_id,share_mode,permissions,protected_view,watermark,expires_at,revoked_at,created_at
       FROM osd_document_shares WHERE document_id=$1 ORDER BY created_at DESC`,
      [document.id]
    );
    res.json({ shares: result.rows });
  }));

  router.delete('/documents/:id/shares/:shareId', currentUser, requirePermission('SHARE_DOCUMENTS'), asyncRoute(async (req, res) => {
    const client = await req.osdPool.connect();
    try {
      await client.query('BEGIN');
      const document = await getDocument(client, cleanText(req.params.id, 100), true);
      if (!checkDocumentVisibility(req.osdUser, document, res)) {
        await client.query('ROLLBACK');
        return;
      }
      const result = await client.query(
        `UPDATE osd_document_shares SET revoked_at=NOW(),revoked_by=$3
         WHERE document_id=$1 AND share_id=$2 AND revoked_at IS NULL
         RETURNING share_id,share_mode`,
        [document.id, cleanText(req.params.shareId, 100), req.osdUser.id]
      );
      if (!result.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Active share link not found.' });
      }
      await appendAudit(client, {
        documentId: document.id,
        actorId: req.osdUser.id,
        actorLabel: req.osdUser.role,
        action: 'SECURE SHARE LINK REVOKED',
        version: document.version,
        metadata: { shareId: result.rows[0].share_id, mode: result.rows[0].share_mode }
      });
      await client.query('COMMIT');
      res.json({ revoked: true, shareId: result.rows[0].share_id });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  router.get('/share/:token', asyncRoute(async (req, res) => {
    const pool = await poolOr503(res);
    if (!pool) return;
    const token = cleanText(req.params.token, 200);
    const result = await pool.query(
      `SELECT d.*,s.share_id,s.share_mode,s.protected_view,s.watermark,s.permissions AS share_permissions,
              s.expires_at AS share_expires_at,s.revoked_at AS share_revoked_at
       FROM osd_document_shares s JOIN osd_documents d ON d.id=s.document_id
       WHERE s.token_hash=$1`,
      [sha256(token)]
    );
    const document = result.rows[0];
    if (!document) return res.status(404).json({ error: 'Share link is invalid or expired.' });
    let viewer = null;
    if (document.share_mode === 'INTERNAL') {
      viewer = await loadUser(req, pool);
      if (!viewer) {
        const hasCookie = String(req.headers.cookie || '').includes('osd_session=');
        if (hasCookie) res.setHeader('Set-Cookie', clearSessionCookie(req));
      }
    }
    const access = shareAccessDecision({
      mode: document.share_mode,
      classification: document.classification,
      permissions: Array.isArray(document.share_permissions) ? document.share_permissions : [],
      revokedAt: document.share_revoked_at,
      shareExpiresAt: document.share_expires_at,
      documentStatus: document.status,
      documentRevokedAt: document.revoked_at,
      documentExpiresAt: document.expires_at,
      user: viewer
    });
    if (access === 'SIGN_IN_REQUIRED') return res.status(401).json({ error: 'Sign in with an OSD account to view this internal document.' });
    if (access === 'NOT_AUTHORIZED') return res.status(404).json({ error: 'Share link is invalid or you are not authorized to view this document.' });
    if (access !== 'ALLOW') return res.status(410).json({ error: 'This share link or document is no longer available.' });
    if (document.share_mode === 'INTERNAL') {
      const userCanDownload = hasPermission(viewer, 'DOWNLOAD_DOCUMENTS');
      if (Array.isArray(document.share_permissions) && document.share_permissions.includes('DOWNLOAD') && !userCanDownload) {
        return res.status(404).json({ error: 'Share link is invalid or you are not authorized to view this document.' });
      }
    }
    if (!signingSecretReady(env.OSD_SIGNING_SECRET)) {
      return res.status(503).json({ error: 'Document integrity verification is temporarily unavailable.' });
    }
    if (!verifyIssuedDocument(document, env.OSD_SIGNING_SECRET)) {
      return res.status(410).json({ error: 'This document is no longer available for sharing.' });
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
        recipient: document.share_mode === 'INTERNAL' ? document.recipient : '',
        status: document.status,
        version: document.version,
        issuedAt: document.issued_at,
        expiresAt: document.expires_at,
        body: document.share_permissions.some((permission) => ['VIEW', 'DOWNLOAD'].includes(permission)) ? {
          text: document.issued_snapshot?.body?.text || '',
          references: document.issued_snapshot?.body?.references || []
        } : undefined,
        signer: 'AUTHORIZED COMMAND',
        signature: !document.protected_view && document.share_permissions.includes('DOWNLOAD') ? {
          display: 'AUTHORIZED COMMAND',
          signedAt: document.signature?.signedAt,
          authorizationLevel: document.signature?.authorizationLevel,
          signatureImage: document.signature?.signatureImage
        } : undefined
      },
      shareId: document.share_id,
      mode: document.share_mode,
      protectedView: !!document.protected_view,
      watermark: cleanText(document.watermark, 100),
      expiresAt: document.share_expires_at,
      permissions: document.share_permissions
    });
  }));

  router.get('/users', currentUser, requirePermission('MANAGE_USERS'), asyncRoute(async (req, res) => {
    const result = await req.osdPool.query(
      `SELECT id,username,display_name,role,clearance,permissions,enabled,created_at,
              military_code,personnel_id,is_primary_chief
       FROM osd_users ORDER BY created_at`
    );
    const users = result.rows.map((account) => {
      const person = personnelForAccount(account);
      if (!person) {
        return {
          id: account.id,
          military_code: account.military_code,
          display_name: account.display_name,
          role: 'UNLINKED',
          clearance: '—',
          enabled: account.enabled === true,
          rank: 'UNLINKED'
        };
      }
      const user = publicUser(account, person);
      return {
        id: user.id,
        military_code: user.militaryCode,
        display_name: user.displayName,
        role: user.role,
        clearance: user.clearance,
        enabled: user.enabled,
        rank: user.rank
      };
    });
    res.json({ users });
  }));

  router.post('/users', currentUser, requirePermission('MANAGE_USERS'), asyncRoute(async (req, res) => {
    return res.status(403).json({ error: 'OSD accounts are created only from verified active military codes; roles and permissions come from the personnel record.' });
  }));

  router.patch('/users/:id', currentUser, requirePermission('MANAGE_USERS'), asyncRoute(async (req, res) => {
    const requestedFields = Object.keys(req.body || {});
    if (requestedFields.some((field) => field !== 'enabled')) {
      return res.status(400).json({ error: 'Role, rank, clearance, password and permissions cannot be changed through this endpoint; they are derived from the personnel record.' });
    }
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Only an enabled/disabled access state may be changed.' });
    if (req.params.id === req.osdUser.id && req.body?.enabled === false) return res.status(400).json({ error: 'You cannot disable your own account.' });
    const client = await req.osdPool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE osd_users SET enabled=$2,updated_at=NOW() WHERE id=$1
         RETURNING id,username,display_name,enabled,created_at,military_code,personnel_id,is_primary_chief`,
        [cleanText(req.params.id, 100), req.body.enabled]
      );
      if (!result.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found.' });
      }
      await appendAudit(client, {
        actorId: req.osdUser.id, actorLabel: req.osdUser.role, action: 'OSD USER UPDATED',
        metadata: { userId: req.params.id, changedFields: ['enabled'] }
      });
      await client.query('COMMIT');
      const account = result.rows[0];
      const person = personnelForAccount(account);
      res.json({
        user: person
          ? { ...publicUser(account, person), createdAt: account.created_at }
          : { id: account.id, militaryCode: account.military_code, displayName: account.display_name, role: 'UNLINKED', enabled: account.enabled }
      });
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
  findPersonnelByCode,
  isEligiblePersonnel,
  nextMinorVersion,
  normalizeMilitaryCode,
  normalizeDocument,
  normalizeShareOptions,
  normalizeSignatureImage,
  roleProfileForPersonnel,
  safeEqual,
  safeDocument,
  sectorCode,
  sha256,
  shareAccessDecision,
  signPayload,
  signingSecretReady,
  verificationResult,
  verifyTotp,
  verifyIssuedDocument
};