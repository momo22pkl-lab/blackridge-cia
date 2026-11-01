'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BADGE_TYPES, createCoverIdentity } = require('../cover-identity');

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1, 12, 0, 0);

function makeUser(id, name, publicCode, rank, fullName) {
  return { id, name, publicCode, rank, identity: { fullName: fullName || name } };
}

function fixture(options) {
  const opts = options || {};
  const state = { cia_cover_badges: [], cia_audit_logs: [] };
  const users = [
    makeUser('chief', 'Chief Account', 'CHIEF-1', 'CIA CHIEF', 'Chief Real Name'),
    makeUser('senior', 'Senior Account', 'SENIOR-1', 'SUPREME COMMANDER', 'Senior Real Name'),
    makeUser('commander', 'Commander Account', 'CMD-1', 'HIGH COMMANDER', 'Commander Real Name'),
    makeUser('member', 'Account Alias', 'AG-101', 'AGENT', 'Real Member Name'),
    makeUser('other', 'Other Account', 'AG-202', 'AGENT', 'Other Real Name')
  ];
  const units = [{ id: 'unit-alpha', status: 'ACTIVE', commanderCode: 'CMD-1', memberCodes: ['CMD-1', 'AG-101'] }];
  let now = START;
  let sequence = 0;
  let failSave = Boolean(opts.failSave);
  const ctx = {
    getState: () => state,
    getUsers: () => users,
    getUnits: () => units,
    isChief: (user) => Boolean(user && user.rank === 'CIA CHIEF'),
    isSenior: (user) => Boolean(user && user.rank === 'SUPREME COMMANDER'),
    isHighCommander: (user) => Boolean(user && user.rank === 'HIGH COMMANDER'),
    normalizeRank: (rank) => rank,
    makeId: (prefix) => prefix + '-' + (++sequence),
    addAuditLog: (action, actor, target, details) => {
      state.cia_audit_logs.unshift({ action, actorId: actor && actor.id || null, targetId: target && target.id || null, details });
      state.cia_audit_logs = state.cia_audit_logs.slice(0, 500);
    },
    saveState: async () => {
      if (failSave) { failSave = false; throw new Error('simulated persistence failure'); }
    },
    nowMs: () => now
  };
  return { api: createCoverIdentity(ctx), state, users, setNow: (value) => { now = value; }, now: () => now };
}

function payload(now, overrides) {
  return Object.assign({
    type: 'MILITARY',
    alias: 'Raven',
    title: 'Field Analyst',
    sector: 'Special Projects',
    badgeNumber: 'MIL-100001',
    expiresAt: new Date(now + 7 * DAY).toISOString(),
    purpose: 'Operation Northwind'
  }, overrides || {});
}

test('creates multiple fictional badge types with unique numbers and stores the real owner identity', async () => {
  const f = fixture();
  assert.deepEqual(Object.keys(BADGE_TYPES), ['MILITARY', 'POLICE', 'EMS', 'MEDIA', 'JUSTICE', 'CIVILIAN']);
  const member = f.users[3];
  const first = await f.api.handlers.create(member, payload(f.now()));
  assert.equal(first.ok, true);
  assert.equal(f.state.cia_cover_badges[0].owner.userId, 'member');
  assert.equal(first.badge.owner.name, 'Real Member Name');
  assert.equal(first.badge.owner.militaryCode, 'AG-101');
  assert.equal(first.badge.alias, 'Raven');
  assert.equal(first.badge.status, 'ACTIVE');

  const second = await f.api.handlers.create(member, payload(f.now(), {
    type: 'POLICE', badgeNumber: 'PD-200002', alias: 'Harbor', purpose: 'Second operation'
  }));
  assert.equal(second.ok, true, 'one member may hold multiple cover identities');
  const duplicate = await f.api.handlers.create(member, payload(f.now(), { badgeNumber: 'MIL-100001' }));
  assert.equal(duplicate.ok, false, 'badge numbers must be unique');
  assert.equal(f.state.cia_cover_badges.length, 2);
  assert.deepEqual(f.state.cia_audit_logs.map((row) => row.action), ['COVER_BADGE_CREATED', 'COVER_BADGE_CREATED']);
});

test('prevents editing another member badge and retains history after revocation', async () => {
  const f = fixture();
  const owner = f.users[3];
  const created = await f.api.handlers.create(owner, payload(f.now()));
  const denied = await f.api.handlers.update(f.users[4], { id: created.badge.id, alias: 'Tampered' });
  assert.equal(denied.ok, false);
  assert.equal(f.state.cia_cover_badges[0].alias, 'Raven');

  const edited = await f.api.handlers.update(owner, { id: created.badge.id, alias: 'Updated Raven' });
  assert.equal(edited.ok, true);
  assert.equal(edited.badge.alias, 'Updated Raven');
  const revoked = await f.api.handlers.revoke(owner, { id: created.badge.id, reason: 'Mission completed' });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.badge.status, 'REVOKED');
  assert.equal(f.state.cia_cover_badges.length, 1, 'revocation must not delete historical records');
  assert.deepEqual(revoked.badge.history.map((event) => event.action), ['CREATED', 'UPDATED', 'REVOKED']);
  assert.deepEqual(f.state.cia_audit_logs.map((row) => row.action), ['COVER_BADGE_REVOKED', 'COVER_BADGE_UPDATED', 'COVER_BADGE_CREATED']);
});

test('enforces battalion visibility and leadership actions on the server', async () => {
  const f = fixture();
  const inScope = await f.api.handlers.create(f.users[3], payload(f.now()));
  const outside = await f.api.handlers.create(f.users[4], payload(f.now(), { type: 'EMS', badgeNumber: 'EMS-300003' }));
  const commander = f.users[2];
  const scoped = await f.api.handlers.adminList(commander, {});
  assert.equal(scoped.ok, true);
  assert.equal(scoped.scope, 'BATTALION');
  assert.equal(scoped.total, 1);
  assert.equal(scoped.badges[0].id, inScope.badge.id);
  assert.equal((await f.api.handlers.get(commander, { id: outside.badge.id })).ok, false);
  assert.equal((await f.api.handlers.disable(commander, { id: inScope.badge.id, reason: 'Review' })).ok, false);

  const chiefList = await f.api.handlers.adminList(f.users[0], {});
  const seniorList = await f.api.handlers.adminList(f.users[1], {});
  assert.equal(chiefList.total, 2);
  assert.equal(seniorList.total, 2);
  assert.equal((await f.api.handlers.disable(f.users[0], { id: inScope.badge.id, reason: 'Leadership review' })).ok, true);
  assert.equal((await f.api.handlers.enable(f.users[0], { id: inScope.badge.id })).ok, true);
});

test('marks expired badges and writes both permanent history and audit records on read', async () => {
  const f = fixture();
  const created = await f.api.handlers.create(f.users[3], payload(f.now(), {
    expiresAt: new Date(f.now() + DAY).toISOString()
  }));
  f.setNow(f.now() + DAY + 1000);
  const read = await f.api.handlers.get(f.users[3], { id: created.badge.id });
  assert.equal(read.ok, true);
  assert.equal(read.badge.status, 'EXPIRED');
  assert.equal(f.state.cia_cover_badges.length, 1);
  assert.equal(f.state.cia_cover_badges[0].status, 'EXPIRED');
  assert.deepEqual(read.badge.history.map((event) => event.action), ['CREATED', 'EXPIRED']);
  assert.ok(f.state.cia_audit_logs.some((row) => row.action === 'COVER_BADGE_EXPIRED'));
});

test('rolls back both badge data and the audit trail if persistence fails', async () => {
  const f = fixture({ failSave: true });
  const result = await f.api.handlers.create(f.users[3], payload(f.now()));
  assert.equal(result.ok, false);
  assert.equal(f.state.cia_cover_badges.length, 0);
  assert.equal(f.state.cia_audit_logs.length, 0);
});
