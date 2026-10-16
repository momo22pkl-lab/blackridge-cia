'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  createOsdRouter,
  findPersonnelByCode,
  isEligiblePersonnel,
  normalizeMilitaryCode,
  roleProfileForPersonnel
} = require('../server');

const personnel = [
  { id: 'person-chief', militaryCode: 'CH-100', displayName: 'Primary Chief', rank: 'CIA CHIEF', active: true },
  { id: 'person-agent', militaryCode: 'AG-200', displayName: 'Field Agent', rank: 'AGENT', active: true },
  { id: 'person-commander', militaryCode: 'CMD-300', displayName: 'High Command', rank: 'SUPREME COMMANDER', active: true },
  { id: 'person-suspended', militaryCode: 'SUS-400', displayName: 'Suspended Agent', rank: 'AGENT', active: false }
];

class MemoryPool {
  constructor() {
    this.users = [];
    this.sessions = [];
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
    env: { NODE_ENV: 'test', OSD_BOOTSTRAP_CODE: 'secure-test-bootstrap-code-0123456789' }
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
    return { response, data, cookie: setCookie.match(/osd_session=[^;]+/)?.[0] || '' };
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
  assert.deepEqual(setup.data, { created: true, militaryCode: 'CH-100' });
  const primaryChief = pool.users.find((user) => user.is_primary_chief);
  assert.ok(primaryChief);
  assert.notEqual(primaryChief.password_hash, 'a-long-test-password');
  assert.match(primaryChief.password_hash, /^[a-f0-9]{128}$/);
  assert.equal(Object.hasOwn(primaryChief, 'password'), false);
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

  const leaderLogin = await call('/auth/login', {
    method: 'POST',
    body: { mode: 'leader', militaryCode: 'CH-100', password: 'a-long-test-password' }
  });
  assert.equal(leaderLogin.response.status, 200);
  assert.equal(leaderLogin.data.user.role, 'ADMIN');
  assert.ok(leaderLogin.data.user.permissions.includes('MANAGE_USERS'));

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
