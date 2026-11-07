'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const {
  createOsdRouter,
  findPersonnelByCode,
  isEligiblePersonnel,
  normalizeMilitaryCode,
  roleProfileForPersonnel
} = require('../server');

const chiefAccessCode = 'test-only-chief-access-code-at-least-24-characters';
const personnel = [
  { id: 'person-chief', militaryCode: 'CH-100', displayName: 'Primary Chief', rank: 'CIA CHIEF', active: true },
  { id: 'person-agent', militaryCode: 'AG-200', displayName: 'Field Agent', rank: 'AGENT', active: true },
  { id: 'person-commander', militaryCode: 'CMD-300', displayName: 'High Command', rank: 'SUPREME COMMANDER', active: true },
  { id: 'person-suspended', militaryCode: 'SUS-400', displayName: 'Suspended Agent', rank: 'AGENT', active: false },
  { id: 'person-secondary-chief', militaryCode: 'CH-101', displayName: 'Other Chief', rank: 'CIA CHIEF', active: true }
];

function accountFor(person, isPrimaryChief) {
  const profile = roleProfileForPersonnel(person, isPrimaryChief);
  return {
    id: isPrimaryChief ? 'osd-primary-chief' : `osd-${person.id}`,
    username: isPrimaryChief ? 'primary-chief' : `account-${person.id}`,
    display_name: person.displayName,
    password_salt: isPrimaryChief ? 'existing-salt-keep' : null,
    password_hash: isPrimaryChief ? 'existing-password-hash-keep' : null,
    role: profile.role,
    clearance: profile.clearance,
    permissions: profile.permissions,
    military_code: person.militaryCode,
    personnel_id: person.id,
    is_primary_chief: isPrimaryChief,
    enabled: true,
    totp_secret_enc: isPrimaryChief ? 'existing-encrypted-totp-keep' : null,
    recovery_code_hashes: isPrimaryChief ? ['existing-recovery-hash-keep'] : [],
    mfa_enabled_at: isPrimaryChief ? '2025-01-01T00:00:00.000Z' : null,
    created_at: '2025-01-01T00:00:00.000Z'
  };
}

class MemoryPool {
  constructor() {
    this.users = [];
    this.sessions = [];
    this.challenges = [];
    this.enrollments = [];
    this.documents = [];
    this.signatures = [];
    this.auditEvents = [];
    this.queries = [];
  }

  async query(sql, values = []) {
    const query = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    this.queries.push({ sql: query, values: [...values] });

    if (query.startsWith('select * from osd_users where personnel_id = $1 or military_code = $2')) {
      const [personnelId, militaryCode] = values;
      const rows = this.users
        .filter((user) => user.personnel_id === personnelId || user.military_code === militaryCode)
        .sort((left, right) => Number(right.personnel_id === personnelId) - Number(left.personnel_id === personnelId))
        .slice(0, 2);
      return { rows };
    }
    if (query.startsWith('select id from osd_users where is_primary_chief')) {
      return { rows: this.users.filter((user) => user.is_primary_chief).slice(0, 1).map(({ id }) => ({ id })) };
    }
    if (query.startsWith('insert into osd_users')) {
      const [id, username, displayName, role, clearance, permissions, militaryCode, personnelId, primary] = values;
      const user = {
        id, username, display_name: displayName, password_salt: null, password_hash: null,
        role, clearance, permissions: JSON.parse(permissions), military_code: militaryCode,
        personnel_id: personnelId, is_primary_chief: primary, enabled: true,
        totp_secret_enc: null, recovery_code_hashes: [], mfa_enabled_at: null,
        created_at: new Date().toISOString()
      };
      this.users.push(user);
      return { rows: [user] };
    }
    if (query.startsWith('select u.id, u.username, u.display_name')) {
      const session = this.sessions.find((item) => item.token_hash === values[0] && item.expires_at > Date.now());
      const user = session && this.users.find((item) => item.id === session.user_id && item.enabled);
      return { rows: user ? [user] : [] };
    }
    if (query.startsWith('insert into osd_sessions')) {
      this.sessions.push({
        token_hash: values[0],
        user_id: values[1],
        expires_at: Date.now() + 8 * 60 * 60 * 1000
      });
      return { rows: [] };
    }
    if (query.startsWith('delete from osd_sessions where expires_at')) {
      this.sessions = this.sessions.filter((session) => session.expires_at > Date.now());
      return { rows: [] };
    }
    return { rows: [] };
  }

  async connect() {
    return {
      query: (sql, values) => this.query(sql, values),
      release() {}
    };
  }
}

async function startAuthServer(t, pool, env = {}) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/osd', createOsdRouter({
    getPool: () => pool,
    getPersonnel: () => personnel,
    env: {
      NODE_ENV: 'production',
      OSD_CHIEF_TOTP_ENROLLMENT_CODE: chiefAccessCode,
      OSD_TOTP_ENCRYPTION_KEY: 'test-only-encryption-key-remains-unchanged',
      OSD_SIGNING_SECRET: 'test-only-signing-secret-remains-unchanged',
      ...env
    }
  }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(500).json({ error: error.message });
  });

  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/osd`;
  let requestNumber = 0;

  async function call(route, { method = 'GET', body, cookie } = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        'x-forwarded-for': `198.51.100.${++requestNumber}`,
        'x-forwarded-proto': 'https',
        ...(cookie ? { cookie } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => ({}));
    const setCookie = response.headers.get('set-cookie') || '';
    return {
      response,
      data,
      setCookie,
      cookie: setCookie.match(/osd_session=[^;,]+/)?.[0] || ''
    };
  }

  return { call };
}

test('military codes resolve only to eligible personnel and ranks derive server roles', () => {
  assert.equal(normalizeMilitaryCode('  ag-200  '), 'AG-200');
  assert.equal(findPersonnelByCode(personnel, 'ag-200'), personnel[1]);
  assert.equal(findPersonnelByCode(personnel, 'SUS-400'), null);
  assert.equal(findPersonnelByCode(personnel, 'not-registered'), null);
  assert.equal(findPersonnelByCode([...personnel, { id: 'duplicate', militaryCode: 'AG-200', active: true }], 'AG-200'), null);
  assert.equal(isEligiblePersonnel({ id: 'x', active: false }), false);

  const chief = roleProfileForPersonnel(personnel[0], true);
  assert.equal(chief.role, 'ADMIN');
  assert.ok(chief.permissions.includes('MANAGE_USERS'));
  const otherChief = roleProfileForPersonnel(personnel[4], false);
  assert.equal(otherChief.role, 'COMMANDER');
  assert.equal(otherChief.permissions.includes('MANAGE_USERS'), false);
  assert.equal(roleProfileForPersonnel(personnel[2], false).role, 'COMMANDER');
  assert.equal(roleProfileForPersonnel(personnel[1]).role, 'AGENT');
});

test('chief login checks the server code and existing primary account without changing records', async (t) => {
  const pool = new MemoryPool();
  const primaryChief = accountFor(personnel[0], true);
  const otherChief = accountFor(personnel[4], false);
  pool.users.push(primaryChief, otherChief);
  pool.documents.push({ id: 'existing-document', version: '2.0', body: { text: 'keep' } });
  pool.signatures.push({ document_id: 'existing-document', signature: 'keep' });
  pool.auditEvents.push({ id: 'existing-audit-event', event_hash: 'keep' });
  pool.challenges.push({ id: 'pending-old-challenge', user_id: primaryChief.id });
  pool.enrollments.push({ id: 'existing-enrollment-record', user_id: primaryChief.id });
  pool.sessions.push({
    token_hash: 'pre-existing-session-hash',
    user_id: primaryChief.id,
    expires_at: Date.now() + 60 * 60 * 1000
  });
  const chiefBefore = structuredClone(primaryChief);
  const recordsBefore = JSON.stringify({
    users: pool.users,
    documents: pool.documents,
    signatures: pool.signatures,
    auditEvents: pool.auditEvents,
    challenges: pool.challenges,
    enrollments: pool.enrollments
  });
  const { call } = await startAuthServer(t, pool);

  const wrongCode = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'leader', militaryCode: 'CH-100', chiefAccessCode: 'wrong-code' }
  });
  assert.equal(wrongCode.response.status, 401);
  assert.equal(wrongCode.cookie, '');
  assert.equal(pool.sessions.length, 1);

  const wrongMilitaryCode = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'leader', militaryCode: 'AG-200', chiefAccessCode }
  });
  assert.equal(wrongMilitaryCode.response.status, 401);
  assert.equal(wrongMilitaryCode.cookie, '');
  assert.equal(pool.sessions.length, 1);

  const nonPrimaryChief = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'leader', militaryCode: 'CH-101', chiefAccessCode }
  });
  assert.equal(nonPrimaryChief.response.status, 401);
  assert.equal(nonPrimaryChief.cookie, '');
  assert.equal(pool.sessions.length, 1);

  const leaderLogin = await call('/auth/login', {
    method: 'POST',
    body: {
      mode: 'leader',
      militaryCode: 'CH-100',
      chiefAccessCode,
      role: 'AGENT',
      permissions: []
    }
  });
  assert.equal(leaderLogin.response.status, 200);
  assert.ok(leaderLogin.cookie);
  assert.match(leaderLogin.setCookie, /HttpOnly/);
  assert.match(leaderLogin.setCookie, /SameSite=Strict/);
  assert.match(leaderLogin.setCookie, /Secure/);
  assert.equal(leaderLogin.data.user.id, primaryChief.id);
  assert.equal(leaderLogin.data.user.role, 'ADMIN');
  assert.deepEqual(leaderLogin.data.user.permissions, roleProfileForPersonnel(personnel[0], true).permissions);
  assert.equal(JSON.stringify(leaderLogin.data).includes(chiefAccessCode), false);
  assert.equal(pool.sessions.length, 2);

  const currentUser = await call('/auth/me', { cookie: leaderLogin.cookie });
  assert.equal(currentUser.response.status, 200);
  assert.equal(currentUser.data.user.id, primaryChief.id);
  assert.equal(currentUser.data.user.permissions.includes('MANAGE_USERS'), true);

  assert.deepEqual(primaryChief, chiefBefore);
  assert.equal(pool.users.length, 2);
  assert.equal(JSON.stringify({
    users: pool.users,
    documents: pool.documents,
    signatures: pool.signatures,
    auditEvents: pool.auditEvents,
    challenges: pool.challenges,
    enrollments: pool.enrollments
  }), recordsBefore);
  assert.equal(JSON.stringify(pool.queries).includes(chiefAccessCode), false);
  assert.equal(pool.queries.some(({ sql }) => /^(insert|update|delete|truncate)\s+(into\s+)?osd_(users|documents|document_versions|audit_events|document_signatures)\b/.test(sql)), false);

  for (const [route, method] of [
    ['/bootstrap/status', 'GET'],
    ['/bootstrap', 'POST'],
    ['/auth/mfa/enroll/start', 'POST'],
    ['/auth/mfa/enroll/confirm', 'POST'],
    ['/auth/mfa/verify', 'POST'],
    ['/auth/mfa/cancel', 'POST']
  ]) {
    const retired = await call(route, {
      method,
      ...(method === 'GET' ? {} : { body: { militaryCode: 'CH-100', chiefAccessCode } })
    });
    assert.equal(retired.response.status, 410, `${method} ${route} should be retired`);
  }
  assert.equal(pool.users.length, 2);
  assert.equal(pool.enrollments.length, 1);
  assert.equal(pool.challenges.length, 1);
});

test('personnel login cannot request or receive chief permissions', async (t) => {
  const pool = new MemoryPool();
  pool.users.push(accountFor(personnel[0], true));
  const { call } = await startAuthServer(t, pool);

  const chiefAsMember = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'member', militaryCode: 'CH-100', chiefAccessCode }
  });
  assert.equal(chiefAsMember.response.status, 401);
  assert.equal(pool.sessions.length, 0);

  const memberLogin = await call('/auth/login', {
    method: 'POST',
    body: {
      mode: 'member',
      militaryCode: 'ag-200',
      chiefAccessCode,
      role: 'ADMIN',
      permissions: ['MANAGE_USERS'],
      clearance: 'TOP SECRET',
      isPrimaryChief: true
    }
  });
  assert.equal(memberLogin.response.status, 200);
  assert.equal(memberLogin.data.user.role, 'AGENT');
  assert.equal(memberLogin.data.user.permissions.includes('MANAGE_USERS'), false);
  assert.equal(pool.users.find((user) => user.military_code === 'AG-200').is_primary_chief, false);
  assert.equal(pool.users.length, 2);

  const memberProfile = await call('/auth/me', { cookie: memberLogin.cookie });
  assert.equal(memberProfile.response.status, 200);
  assert.equal(memberProfile.data.user.militaryCode, 'AG-200');
  assert.equal(memberProfile.data.user.permissions.includes('MANAGE_USERS'), false);

  const badCode = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'member', militaryCode: 'NO-SUCH-CODE' }
  });
  assert.equal(badCode.response.status, 401);
  const suspendedCode = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'member', militaryCode: 'SUS-400' }
  });
  assert.equal(suspendedCode.response.status, 401);
});

test('chief access code is an unprefilled password input and never appears in browser assets', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const shareHtml = fs.readFileSync(path.join(__dirname, '../share.html'), 'utf8');
  const shareApp = fs.readFileSync(path.join(__dirname, '../share.js'), 'utf8');
  const browserAssets = `${html}\n${app}\n${shareHtml}\n${shareApp}`;
  assert.match(html, /id="chiefAccessCode" type="password" autocomplete="off"/);
  assert.match(shareHtml, /id="loginChiefAccessCode" type="password" autocomplete="off"/);
  assert.match(shareApp, /chiefAccessCode: \$\('#loginChiefAccessCode'\)\.value/);
  assert.doesNotMatch(browserAssets, /OSD_CHIEF_TOTP_ENROLLMENT_CODE/);
  assert.doesNotMatch(browserAssets, new RegExp(chiefAccessCode));
  assert.doesNotMatch(html, /bootstrapForm|mfaLoginForm|mfaEnrollStartForm|mfaProvisioning|leaderPassword/);
  assert.doesNotMatch(browserAssets, /\/bootstrap|\/auth\/mfa|leaderPassword|Master Password|loginPassword|bootstrapForm|mfaLoginForm/);
});

test('direct OSD document API blocks central-engine matches and persists clean content', async (t) => {
  const pool = new MemoryPool();
  pool.users.push({
    id: 'osd-document-chief',
    username: 'osd-document-chief',
    display_name: 'Primary Chief',
    role: 'ADMIN',
    clearance: 'TOP SECRET',
    permissions: ['VIEW_DOCUMENTS', 'CREATE_DOCUMENTS'],
    military_code: 'CH-100',
    personnel_id: 'person-chief',
    is_primary_chief: true,
    enabled: true
  });
  const sessionToken = 'osd-document-test-session';
  pool.sessions.push({
    token_hash: crypto.createHash('sha256').update(sessionToken).digest('hex'),
    user_id: 'osd-document-chief',
    expires_at: Date.now() + 60_000
  });
  let counter = 0;
  const memoryQuery = pool.query.bind(pool);
  pool.query = async (sql, values = []) => {
    const query = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (query.startsWith('insert into osd_counters')) return { rows: [{ value: ++counter }] };
    if (query.startsWith('insert into osd_documents')) {
      const [id, documentNumber, verificationCode, type, title, body, sector, classification, recipient, createdBy, expiresAt] = values;
      pool.documents.push({
        id, document_number: documentNumber, verification_code: verificationCode,
        document_type: type, title, body: JSON.parse(body), sector, classification,
        recipient, status: 'DRAFT', version: '1.0', created_by: createdBy,
        expires_at: expiresAt, updated_at: new Date().toISOString()
      });
      return { rows: [] };
    }
    if (query.startsWith('select * from osd_documents where id=$1')) {
      return { rows: pool.documents.filter((document) => document.id === values[0]) };
    }
    if (query.startsWith('select pg_advisory_xact_lock') ||
        query.startsWith('select event_hash from osd_audit_events') ||
        query.startsWith('insert into osd_document_versions') ||
        query.startsWith('insert into osd_audit_events')) return { rows: [] };
    return memoryQuery(sql, values);
  };
  pool.connect = async () => ({ query: pool.query.bind(pool), release() {} });

  const app = express();
  app.use(express.json());
  app.use('/api/osd', createOsdRouter({ getPool: () => pool, getPersonnel: () => personnel }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/osd/documents`;
  const document = {
    type: 'OFFICIAL MEMORANDUM',
    title: 'That is shit.',
    sector: 'Operations',
    classification: 'PUBLIC',
    body: 'A clean body.'
  };
  const blocked = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(document)
  });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /منع/);
  assert.equal(pool.documents.length, 0);

  const clean = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `osd_session=${sessionToken}`
    },
    body: JSON.stringify({ ...document, title: 'Quarterly operations memorandum' })
  });
  assert.equal(clean.status, 201);
  assert.equal((await clean.json()).document.title, 'Quarterly operations memorandum');
  assert.equal(pool.documents.length, 1);
});
