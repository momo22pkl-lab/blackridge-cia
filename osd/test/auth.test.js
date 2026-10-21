'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const {
  createOsdRouter,
  findPersonnelByCode,
  isEligiblePersonnel,
  normalizeMilitaryCode,
  roleProfileForPersonnel,
  verifyTotp
} = require('../server');

const personnel = [
  { id: 'person-chief', militaryCode: 'CH-100', displayName: 'Primary Chief', rank: 'CIA CHIEF', active: true },
  { id: 'person-agent', militaryCode: 'AG-200', displayName: 'Field Agent', rank: 'AGENT', active: true },
  { id: 'person-commander', militaryCode: 'CMD-300', displayName: 'High Command', rank: 'SUPREME COMMANDER', active: true },
  { id: 'person-suspended', militaryCode: 'SUS-400', displayName: 'Suspended Agent', rank: 'AGENT', active: false }
];

function totpForTest(secret, time = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  const secretBytes = [];
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      secretBytes.push((buffer >> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / 30)));
  const digest = crypto.createHmac('sha1', Buffer.from(secretBytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 1_000_000).padStart(6, '0');
}

function invalidTotpForTest(secret, time = Date.now()) {
  for (const candidate of ['000000', '000001', '999999', '123456', '654321']) {
    if (![-1, 0, 1].some((offset) => totpForTest(secret, time + offset * 30_000) === candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not select a non-current test TOTP.');
}

function staleTotpForTest(secret, time = Date.now()) {
  for (let minutes = 10; minutes < 100; minutes += 1) {
    const candidate = totpForTest(secret, time - minutes * 60_000);
    if (![-1, 0, 1].some((offset) => totpForTest(secret, time + offset * 30_000) === candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not select an expired test TOTP.');
}

test('TOTP verifier matches the RFC 6238 SHA-1 vector and rejects stale codes', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(verifyTotp(secret, '287082', 59_000), true);
  assert.equal(verifyTotp(secret, '94287082', 59_000), false);
  assert.equal(verifyTotp(secret, '287082', 59_000 + 90_000), false);
});

class MemoryPool {
  constructor() {
    this.users = [];
    this.sessions = [];
    this.challenges = [];
    this.enrollments = [];
  }

  async query(sql, values = []) {
    const query = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (query.includes('create table if not exists osd_users')) return { rows: [] };
    if (query.startsWith('select exists(')) {
      return { rows: [{ initialized: this.users.some((user) => user.is_primary_chief) }] };
    }
    if (query.startsWith('select * from osd_users where personnel_id = $1 or military_code = $2')) {
      const [personnelId, militaryCode] = values;
      const rows = this.users
        .filter((user) => user.personnel_id === personnelId || user.military_code === militaryCode)
        .sort((left, right) => Number(right.personnel_id === personnelId) - Number(left.personnel_id === personnelId))
        .slice(0, 2);
      return { rows };
    }
    if (query.startsWith('select * from osd_users where lower(username)')) {
      const [username] = values;
      return {
        rows: this.users.filter((user) =>
          user.username.toLowerCase() === String(username).toLowerCase() &&
          !user.military_code && !user.personnel_id
        ).slice(0, 1)
      };
    }
    if (query.startsWith('select id from osd_users where is_primary_chief')) {
      return { rows: this.users.filter((user) => user.is_primary_chief).slice(0, 1).map(({ id }) => ({ id })) };
    }
    if (query.startsWith('insert into osd_users')) {
      const [id, username, displayName, salt, hash, role, clearance, permissions, militaryCode, personnelId, primary] = values;
      const user = {
        id, username, display_name: displayName, password_salt: salt, password_hash: hash,
        role, clearance, permissions: JSON.parse(permissions), military_code: militaryCode,
        personnel_id: personnelId, is_primary_chief: primary, enabled: true,
        totp_secret_enc: null, recovery_code_hashes: [], mfa_enabled_at: null,
        created_at: new Date().toISOString()
      };
      this.users.push(user);
      return { rows: [user] };
    }
    if (query.startsWith('update osd_users set military_code=')) {
      const [id, militaryCode, personnelId, displayName, role, clearance, permissions, primary, salt, hash, enable] = values;
      const user = this.users.find((item) => item.id === id);
      if (!user) return { rows: [] };
      Object.assign(user, {
        military_code: militaryCode,
        personnel_id: personnelId,
        display_name: displayName,
        role,
        clearance,
        permissions: JSON.parse(permissions),
        is_primary_chief: primary,
        password_salt: salt || user.password_salt,
        password_hash: hash || user.password_hash,
        enabled: enable ? true : user.enabled
      });
      return { rows: [user] };
    }
    if (query.startsWith('select id,totp_secret_enc,mfa_enabled_at from osd_users')) {
      const user = this.users.find((item) => item.id === values[0] && item.is_primary_chief && item.enabled);
      return { rows: user ? [{ id: user.id, totp_secret_enc: user.totp_secret_enc, mfa_enabled_at: user.mfa_enabled_at }] : [] };
    }
    if (query.startsWith('update osd_users set totp_secret_enc=')) {
      const [id, encrypted, recoveryHashes] = values;
      const user = this.users.find((item) => item.id === id && item.is_primary_chief && item.enabled &&
        !item.totp_secret_enc && !item.mfa_enabled_at);
      if (!user) return { rows: [] };
      Object.assign(user, {
        totp_secret_enc: encrypted,
        recovery_code_hashes: JSON.parse(recoveryHashes),
        mfa_enabled_at: new Date().toISOString()
      });
      return { rows: [{ id: user.id }] };
    }
    if (query.startsWith('update osd_users set recovery_code_hashes=')) {
      const [id, recoveryHashes] = values;
      const user = this.users.find((item) => item.id === id);
      if (!user) return { rows: [] };
      user.recovery_code_hashes = JSON.parse(recoveryHashes);
      return { rows: [{ id: user.id }] };
    }
    if (query.startsWith('delete from osd_mfa_enrollments where user_id=')) {
      this.enrollments = this.enrollments.filter((item) => item.user_id !== values[0]);
      return { rows: [] };
    }
    if (query.startsWith('insert into osd_mfa_enrollments')) {
      const [enrollment_hash, user_id, secret_enc, recovery_code_hashes] = values;
      const enrollment = {
        enrollment_hash, user_id, secret_enc,
        recovery_code_hashes: JSON.parse(recovery_code_hashes),
        expires_at: Date.now() + 15 * 60 * 1000,
        failed_attempts: 0
      };
      this.enrollments.push(enrollment);
      return { rows: [] };
    }
    if (query.startsWith('select e.enrollment_hash')) {
      const enrollment = this.enrollments.find((item) =>
        item.enrollment_hash === values[0] && item.expires_at > Date.now());
      const user = enrollment && this.users.find((item) => item.id === enrollment.user_id);
      return { rows: enrollment && user ? [{
        ...enrollment,
        is_primary_chief: user.is_primary_chief,
        enabled: user.enabled,
        military_code: user.military_code,
        personnel_id: user.personnel_id
      }] : [] };
    }
    if (query.startsWith('update osd_mfa_enrollments set failed_attempts=')) {
      const enrollment = this.enrollments.find((item) => item.enrollment_hash === values[0]);
      if (enrollment) enrollment.failed_attempts += 1;
      return { rows: [] };
    }
    if (query.startsWith('delete from osd_mfa_enrollments where enrollment_hash=')) {
      this.enrollments = this.enrollments.filter((item) => item.enrollment_hash !== values[0]);
      return { rows: [] };
    }
    if (query.startsWith('delete from osd_login_challenges where expires_at')) {
      this.challenges = this.challenges.filter((item) => item.expires_at > Date.now());
      return { rows: [] };
    }
    if (query.startsWith('insert into osd_login_challenges')) {
      const [challenge_hash, user_id] = values;
      this.challenges.push({
        challenge_hash, user_id,
        expires_at: Date.now() + 5 * 60 * 1000,
        failed_attempts: 0
      });
      return { rows: [] };
    }
    if (query.startsWith('select c.challenge_hash')) {
      const challenge = this.challenges.find((item) =>
        item.challenge_hash === values[0] && item.expires_at > Date.now());
      const user = challenge && this.users.find((item) => item.id === challenge.user_id);
      return { rows: challenge && user ? [{
        ...challenge,
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        clearance: user.clearance,
        permissions: user.permissions,
        military_code: user.military_code,
        personnel_id: user.personnel_id,
        is_primary_chief: user.is_primary_chief,
        enabled: user.enabled,
        totp_secret_enc: user.totp_secret_enc,
        recovery_code_hashes: user.recovery_code_hashes,
        mfa_enabled_at: user.mfa_enabled_at
      }] : [] };
    }
    if (query.startsWith('update osd_login_challenges set failed_attempts=')) {
      const challenge = this.challenges.find((item) => item.challenge_hash === values[0]);
      if (challenge) challenge.failed_attempts += 1;
      return { rows: [] };
    }
    if (query.startsWith('delete from osd_login_challenges where challenge_hash=')) {
      this.challenges = this.challenges.filter((item) => item.challenge_hash !== values[0]);
      return { rows: [] };
    }
    if (query.startsWith('delete from osd_sessions where user_id=')) {
      this.sessions = this.sessions.filter((item) => item.user_id !== values[0]);
      return { rows: [] };
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
    if (query.startsWith('select id,username,display_name,role,clearance,permissions,enabled,created_at')) {
      return { rows: this.users };
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

test('military codes resolve case-insensitively only to eligible personnel', () => {
  assert.equal(normalizeMilitaryCode('  ag-200  '), 'AG-200');
  assert.equal(findPersonnelByCode(personnel, 'ag-200'), personnel[1]);
  assert.equal(findPersonnelByCode(personnel, 'SUS-400'), null);
  assert.equal(findPersonnelByCode(personnel, 'not-registered'), null);
  assert.equal(findPersonnelByCode(personnel, 'PENDING'), null);
  assert.equal(findPersonnelByCode([...personnel, { id: 'duplicate', militaryCode: 'AG-200', active: true }], 'AG-200'), null);
  assert.equal(isEligiblePersonnel({ id: 'x', active: false }), false);
});

test('personnel ranks derive server roles; only the primary chief receives user-management access', () => {
  const chief = roleProfileForPersonnel(personnel[0], true);
  assert.equal(chief.role, 'ADMIN');
  assert.ok(chief.permissions.includes('MANAGE_USERS'));
  assert.ok(chief.permissions.includes('VIEW_REAL_SIGNER_IDENTITY'));

  const uninitializedChief = roleProfileForPersonnel(personnel[0], false);
  assert.equal(uninitializedChief.role, 'COMMANDER');
  assert.equal(uninitializedChief.permissions.includes('MANAGE_USERS'), false);

  const commander = roleProfileForPersonnel(personnel[2], false);
  assert.equal(commander.role, 'COMMANDER');
  assert.equal(commander.permissions.includes('MANAGE_USERS'), false);
  assert.equal(roleProfileForPersonnel({ rank: 'HIGH COMMANDER' }).role, 'SENIOR');
  assert.equal(roleProfileForPersonnel(personnel[1]).role, 'AGENT');
});

test('OSD routes enforce one-time chief setup, military-code personnel access, and server-derived roles', async (t) => {
  const pool = new MemoryPool();
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/osd', createOsdRouter({
    getPool: () => pool,
    getPersonnel: () => personnel,
    env: {
      NODE_ENV: 'test',
      OSD_BOOTSTRAP_CODE: 'secure-test-bootstrap-code-0123456789',
      OSD_CHIEF_TOTP_ENROLLMENT_CODE: 'separate-chief-enrollment-code-0123456789',
      OSD_TOTP_ENCRYPTION_KEY: 'test-only-key-with-at-least-32-characters'
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

  async function call(path, { method = 'GET', body, cookie } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        'x-forwarded-for': `198.51.100.${++requestNumber}`,
        ...(cookie ? { cookie } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    const setCookie = response.headers.get('set-cookie') || '';
    return {
      response,
      data,
      cookie: setCookie.match(/osd_session=[^;]+/)?.[0] || '',
      challengeCookie: setCookie.match(/osd_mfa_challenge=[^;]+/)?.[0] || ''
    };
  }

  const statusBefore = await call('/bootstrap/status');
  assert.deepEqual(statusBefore.data, { needed: true, configured: true });

  const wrongSetupCode = await call('/bootstrap', {
    method: 'POST',
    body: {
      bootstrapCode: 'incorrect',
      militaryCode: 'CH-100',
      masterPassword: 'a-long-test-password',
      confirmPassword: 'a-long-test-password'
    }
  });
  assert.equal(wrongSetupCode.response.status, 403);
  assert.equal(pool.users.length, 0);

  const wrongChief = await call('/bootstrap', {
    method: 'POST',
    body: {
      bootstrapCode: 'secure-test-bootstrap-code-0123456789',
      militaryCode: 'AG-200',
      masterPassword: 'a-long-test-password',
      confirmPassword: 'a-long-test-password'
    }
  });
  assert.equal(wrongChief.response.status, 403);
  assert.equal(pool.users.length, 0);

  const setup = await call('/bootstrap', {
    method: 'POST',
    body: {
      bootstrapCode: 'secure-test-bootstrap-code-0123456789',
      militaryCode: 'CH-100',
      masterPassword: 'a-long-test-password',
      confirmPassword: 'a-long-test-password'
    }
  });
  assert.equal(setup.response.status, 201);
  assert.equal(setup.data.created, true);
  assert.equal(setup.data.militaryCode, 'CH-100');
  assert.ok(setup.data.mfaEnrollment.secret);
  assert.equal(setup.data.mfaEnrollment.recoveryCodes.length, 10);
  assert.match(setup.data.mfaEnrollment.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal(setup.cookie, '');
  const primaryChief = pool.users.find((user) => user.is_primary_chief);
  assert.ok(primaryChief);
  assert.notEqual(primaryChief.password_hash, 'a-long-test-password');
  assert.match(primaryChief.password_hash, /^[a-f0-9]{128}$/);
  assert.equal(Object.hasOwn(primaryChief, 'password'), false);
  assert.equal(primaryChief.totp_secret_enc, null);
  const initialMasterHash = primaryChief.password_hash;

  const repeatedSetup = await call('/bootstrap', {
    method: 'POST',
    body: {
      bootstrapCode: 'secure-test-bootstrap-code-0123456789',
      militaryCode: 'CH-100',
      masterPassword: 'another-long-password',
      confirmPassword: 'another-long-password'
    }
  });
  assert.equal(repeatedSetup.response.status, 409);
  assert.equal(pool.users.find((user) => user.id === primaryChief.id).password_hash, initialMasterHash);

  const wrongLeaderPassword = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'leader', militaryCode: 'CH-100', password: 'incorrect-long-password' }
  });
  assert.equal(wrongLeaderPassword.response.status, 401);

  const passwordWithoutLeaderIdentity = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'leader', militaryCode: 'AG-200', password: 'a-long-test-password' }
  });
  assert.equal(passwordWithoutLeaderIdentity.response.status, 401);

  const passwordOnlyLeaderLogin = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'leader', militaryCode: 'CH-100', password: 'a-long-test-password' }
  });
  assert.equal(passwordOnlyLeaderLogin.response.status, 428);
  assert.equal(passwordOnlyLeaderLogin.data.code, 'MFA_SETUP_REQUIRED');
  assert.equal(passwordOnlyLeaderLogin.cookie, '');
  assert.equal(pool.sessions.length, 0);
  const noSessionBeforeMfa = await call('/auth/me');
  assert.equal(noSessionBeforeMfa.response.status, 401);

  const wrongEnrollmentCode = await call('/auth/mfa/enroll/start', {
    method: 'POST',
    body: {
      militaryCode: 'CH-100',
      password: 'a-long-test-password',
      enrollmentCode: 'wrong-enrollment-code'
    }
  });
  assert.equal(wrongEnrollmentCode.response.status, 403);
  assert.equal(primaryChief.totp_secret_enc, null);

  const enrollmentStart = await call('/auth/mfa/enroll/start', {
    method: 'POST',
    body: {
      militaryCode: 'CH-100',
      password: 'a-long-test-password',
      enrollmentCode: 'separate-chief-enrollment-code-0123456789'
    }
  });
  assert.equal(enrollmentStart.response.status, 201);
  const mfaEnrollment = enrollmentStart.data.mfaEnrollment;
  assert.equal(mfaEnrollment.recoveryCodes.length, 10);
  const pendingEnrollment = pool.enrollments[0];
  assert.ok(pendingEnrollment.secret_enc.startsWith('v1.'));
  assert.equal(pendingEnrollment.secret_enc.includes(mfaEnrollment.secret), false);
  const wrongEnrollmentTotp = await call('/auth/mfa/enroll/confirm', {
    method: 'POST',
    body: { enrollmentToken: mfaEnrollment.enrollmentToken, code: invalidTotpForTest(mfaEnrollment.secret) }
  });
  assert.equal(wrongEnrollmentTotp.response.status, 401);
  assert.equal(primaryChief.mfa_enabled_at, null);

  pool.sessions.push({
    token_hash: 'pretend-pre-mfa-session',
    user_id: primaryChief.id,
    expires_at: Date.now() + 60 * 60 * 1000
  });
  const enrollmentConfirmation = await call('/auth/mfa/enroll/confirm', {
    method: 'POST',
    body: { enrollmentToken: mfaEnrollment.enrollmentToken, code: totpForTest(mfaEnrollment.secret) }
  });
  assert.equal(enrollmentConfirmation.response.status, 200);
  assert.equal(primaryChief.mfa_enabled_at !== null, true);
  assert.notEqual(primaryChief.totp_secret_enc, mfaEnrollment.secret);
  assert.equal(primaryChief.recovery_code_hashes.length, 10);
  assert.equal(pool.sessions.length, 0);

  const leaderPasswordStep = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'leader', militaryCode: 'CH-100', password: 'a-long-test-password' }
  });
  assert.equal(leaderPasswordStep.response.status, 202);
  assert.deepEqual(leaderPasswordStep.data, { mfaRequired: true });
  assert.equal(leaderPasswordStep.cookie, '');
  assert.ok(leaderPasswordStep.challengeCookie);
  const noLeaderSessionBeforeCode = await call('/auth/me', { cookie: leaderPasswordStep.challengeCookie });
  assert.equal(noLeaderSessionBeforeCode.response.status, 401);
  assert.equal(pool.sessions.length, 0);

  const invalidTotp = await call('/auth/mfa/verify', {
    method: 'POST',
    cookie: leaderPasswordStep.challengeCookie,
    body: { code: invalidTotpForTest(mfaEnrollment.secret) }
  });
  assert.equal(invalidTotp.response.status, 401);
  assert.equal(invalidTotp.cookie, '');
  const expiredTotp = await call('/auth/mfa/verify', {
    method: 'POST',
    cookie: leaderPasswordStep.challengeCookie,
    body: { code: staleTotpForTest(mfaEnrollment.secret) }
  });
  assert.equal(expiredTotp.response.status, 401);
  assert.equal(pool.sessions.length, 0);

  const leaderLogin = await call('/auth/mfa/verify', {
    method: 'POST',
    cookie: leaderPasswordStep.challengeCookie,
    body: { code: totpForTest(mfaEnrollment.secret) }
  });
  assert.equal(leaderLogin.response.status, 200);
  assert.ok(leaderLogin.cookie);
  assert.equal(leaderLogin.data.user.role, 'ADMIN');
  assert.ok(leaderLogin.data.user.permissions.includes('MANAGE_USERS'));
  const replayedChallenge = await call('/auth/mfa/verify', {
    method: 'POST',
    cookie: leaderPasswordStep.challengeCookie,
    body: { code: totpForTest(mfaEnrollment.secret) }
  });
  assert.equal(replayedChallenge.response.status, 401);
  const leaderSession = await call('/auth/me', { cookie: leaderLogin.cookie });
  assert.equal(leaderSession.response.status, 200);
  assert.equal(leaderSession.data.user.role, 'ADMIN');

  const resetAttempt = await call('/auth/mfa/enroll/start', {
    method: 'POST',
    body: {
      militaryCode: 'CH-100',
      password: 'a-long-test-password',
      enrollmentCode: 'separate-chief-enrollment-code-0123456789'
    }
  });
  assert.equal(resetAttempt.response.status, 409);
  assert.equal(primaryChief.recovery_code_hashes.length, 10);

  const recoveryLoginChallenge = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'leader', militaryCode: 'CH-100', password: 'a-long-test-password' }
  });
  assert.equal(recoveryLoginChallenge.response.status, 202);
  const recoveryCode = mfaEnrollment.recoveryCodes[0];
  const recoveryLogin = await call('/auth/mfa/verify', {
    method: 'POST',
    cookie: recoveryLoginChallenge.challengeCookie,
    body: { code: recoveryCode }
  });
  assert.equal(recoveryLogin.response.status, 200);
  assert.equal(primaryChief.recovery_code_hashes.length, 9);

  const reuseChallenge = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'leader', militaryCode: 'CH-100', password: 'a-long-test-password' }
  });
  const reusedRecoveryCode = await call('/auth/mfa/verify', {
    method: 'POST',
    cookie: reuseChallenge.challengeCookie,
    body: { code: recoveryCode }
  });
  assert.equal(reusedRecoveryCode.response.status, 401);

  const expiredChallenge = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'leader', militaryCode: 'CH-100', password: 'a-long-test-password' }
  });
  assert.equal(expiredChallenge.response.status, 202);
  const challengeRecord = pool.challenges.at(-1);
  challengeRecord.expires_at = Date.now() - 1;
  const rejectedExpiredChallenge = await call('/auth/mfa/verify', {
    method: 'POST',
    cookie: expiredChallenge.challengeCookie,
    body: { code: totpForTest(mfaEnrollment.secret) }
  });
  assert.equal(rejectedExpiredChallenge.response.status, 401);

  const memberLogin = await call('/auth/login', {
    method: 'POST',
    body: {
      mode: 'member',
      militaryCode: 'ag-200',
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

  const memberProfile = await call('/auth/me', { cookie: memberLogin.cookie });
  assert.equal(memberProfile.response.status, 200);
  assert.equal(memberProfile.data.user.militaryCode, 'AG-200');

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

  const memberTriesChiefMode = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'member', militaryCode: 'CH-100' }
  });
  assert.equal(memberTriesChiefMode.response.status, 401);

  const commanderLogin = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'member', militaryCode: 'CMD-300' }
  });
  assert.equal(commanderLogin.response.status, 200);
  assert.equal(commanderLogin.data.user.role, 'COMMANDER');
  assert.equal(commanderLogin.data.user.permissions.includes('MANAGE_USERS'), false);

  const forbiddenUserList = await call('/users', { cookie: memberLogin.cookie });
  assert.equal(forbiddenUserList.response.status, 403);

  const createElevatedAccount = await call('/users', {
    method: 'POST',
    cookie: leaderLogin.cookie,
    body: { username: 'browser-created-admin', role: 'ADMIN', permissions: ['MANAGE_USERS'] }
  });
  assert.equal(createElevatedAccount.response.status, 403);
  assert.equal(pool.users.some((user) => user.username === 'browser-created-admin'), false);

  const alterRole = await call(`/users/${encodeURIComponent(pool.users.find((user) => user.military_code === 'AG-200').id)}`, {
    method: 'PATCH',
    cookie: leaderLogin.cookie,
    body: { role: 'ADMIN', permissions: ['MANAGE_USERS'], clearance: 'TOP SECRET' }
  });
  assert.equal(alterRole.response.status, 400);
  assert.equal(pool.users.find((user) => user.military_code === 'AG-200').role, 'AGENT');
});
