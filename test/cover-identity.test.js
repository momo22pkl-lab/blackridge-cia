'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BADGE_TYPES, REVIEW_STATUS, createCoverIdentity, injectCoverIdentityMarkup } = require('../cover-identity');

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1, 12, 0, 0);

test('injects the cover identity entry point without duplicating markup', () => {
  const html = '<html><head></head><body><li id="chief-nav">Leadership</li></body></html>';
  const injected = injectCoverIdentityMarkup(html);
  assert.match(injected, /href="\/cover-identity\.css"/);
  assert.match(injected, /id="cover-identity-nav"/);
  assert.match(injected, /src="\/cover-identity-client\.js"/);
  assert.ok(injected.indexOf('id="cover-identity-nav"') > injected.indexOf('id="chief-nav"'));
  const twice = injectCoverIdentityMarkup(injected);
  assert.equal((twice.match(/id="cover-identity-nav"/g) || []).length, 1);
  assert.equal((twice.match(/cover-identity-client\.js/g) || []).length, 1);
});

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
    makeUser('other', 'Other Account', 'AG-202', 'AGENT', 'Other Real Name'),
    makeUser('commander-two', 'Commander Two', 'CMD-2', 'HIGH COMMANDER', 'Commander Two Real Name')
  ];
  const units = [
    { id: 'unit-alpha', status: 'ACTIVE', sector: 'Special Operations', commanderCode: 'CMD-1', memberCodes: ['CMD-1', 'AG-101'] },
    { id: 'unit-beta', status: 'ACTIVE', sector: 'Internal Affairs', commanderCode: 'CMD-2', memberCodes: ['CMD-2', 'AG-202'] }
  ];
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
  return {
    api: createCoverIdentity(ctx),
    state,
    users,
    setNow: (value) => { now = value; },
    setFailSave: (value) => { failSave = value; },
    now: () => now
  };
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

test('creates multiple fictional badge types as pending and stores the real owner identity', async () => {
  const f = fixture();
  assert.deepEqual(Object.keys(BADGE_TYPES), ['MILITARY', 'POLICE', 'EMS', 'MEDIA', 'JUSTICE', 'CIVILIAN']);
  const member = f.users[3];
  const first = await f.api.handlers.create(member, payload(f.now()));
  assert.equal(first.ok, true);
  assert.equal(f.state.cia_cover_badges[0].owner.userId, 'member');
  assert.equal(first.badge.owner.name, 'Real Member Name');
  assert.equal(first.badge.owner.militaryCode, 'AG-101');
  assert.equal(first.badge.alias, 'Raven');
  assert.equal(first.badge.status, REVIEW_STATUS.PENDING);
  assert.equal(first.badge.reviewStatus, REVIEW_STATUS.PENDING);
  assert.equal(first.badge.isApproved, false);
  assert.equal(first.badge.can.review, false);

  const second = await f.api.handlers.create(member, payload(f.now(), {
    type: 'POLICE', badgeNumber: 'PD-200002', alias: 'Harbor', purpose: 'Second operation'
  }));
  assert.equal(second.ok, true, 'one member may hold multiple cover identities');
  const duplicate = await f.api.handlers.create(member, payload(f.now(), { badgeNumber: 'MIL-100001' }));
  assert.equal(duplicate.ok, false, 'badge numbers must be unique');
  assert.equal(f.state.cia_cover_badges.length, 2);
  assert.deepEqual(f.state.cia_audit_logs.map((row) => row.action), ['COVER_BADGE_CREATED', 'COVER_BADGE_CREATED']);
});

test('prevents cross-member edits and sends changed approved identities back for review', async () => {
  const f = fixture();
  const owner = f.users[3];
  const created = await f.api.handlers.create(owner, payload(f.now()));
  const denied = await f.api.handlers.update(f.users[4], { id: created.badge.id, alias: 'Tampered' });
  assert.equal(denied.ok, false);
  assert.equal(f.state.cia_cover_badges[0].alias, 'Raven');

  const edited = await f.api.handlers.update(owner, { id: created.badge.id, alias: 'Updated Raven' });
  assert.equal(edited.ok, true);
  assert.equal(edited.badge.alias, 'Updated Raven');
  assert.equal(edited.badge.status, REVIEW_STATUS.PENDING);
  const approved = await f.api.handlers.approve(f.users[2], { id: created.badge.id });
  assert.equal(approved.ok, true);
  assert.equal(approved.badge.isApproved, true);
  assert.equal(approved.badge.status, 'ACTIVE');
  const changedAfterApproval = await f.api.handlers.update(owner, { id: created.badge.id, alias: 'Changed Raven' });
  assert.equal(changedAfterApproval.ok, true);
  assert.equal(changedAfterApproval.badge.status, REVIEW_STATUS.PENDING);
  assert.equal(changedAfterApproval.badge.isApproved, false);
  assert.equal(changedAfterApproval.badge.review.decisions.length, 1, 'prior approval remains in the review audit');
  const revoked = await f.api.handlers.revoke(owner, { id: created.badge.id, reason: 'Mission completed' });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.badge.status, 'REVOKED');
  assert.equal(f.state.cia_cover_badges.length, 1, 'revocation must not delete historical records');
  assert.deepEqual(revoked.badge.history.map((event) => event.action), ['CREATED', 'UPDATED', 'APPROVED', 'UPDATED', 'REVOKED']);
  assert.deepEqual(f.state.cia_audit_logs.map((row) => row.action), [
    'COVER_BADGE_REVOKED', 'COVER_BADGE_UPDATED', 'COVER_BADGE_APPROVED',
    'COVER_BADGE_UPDATED', 'COVER_BADGE_CREATED'
  ]);
});

test('enforces sector review scope and allows either authorized reviewer to approve', async () => {
  const f = fixture();
  const inScope = await f.api.handlers.create(f.users[3], payload(f.now()));
  const outside = await f.api.handlers.create(f.users[4], payload(f.now(), { type: 'EMS', badgeNumber: 'EMS-300003' }));
  const commander = f.users[2];
  const scoped = await f.api.handlers.adminList(commander, {});
  assert.equal(scoped.ok, true);
  assert.equal(scoped.scope, 'SECTOR');
  assert.equal(scoped.total, 1);
  assert.equal(scoped.badges[0].id, inScope.badge.id);
  assert.equal((await f.api.handlers.get(commander, { id: outside.badge.id })).ok, false);
  assert.equal((await f.api.handlers.disable(commander, { id: inScope.badge.id, reason: 'Review' })).ok, false);
  assert.equal((await f.api.handlers.approve(f.users[0], { id: inScope.badge.id })).ok, false, 'CIA CHIEF supervises but is not one of the two approval roles');
  assert.equal((await f.api.handlers.approve(commander, { id: outside.badge.id })).ok, false, 'a sector leader cannot review another sector');
  assert.equal((await f.api.handlers.approve(commander, { id: inScope.badge.id })).ok, true);
  assert.equal((await f.api.handlers.approve(f.users[1], { id: inScope.badge.id })).ok, false, 'one approval is final');
  assert.equal((await f.api.handlers.approve(f.users[1], { id: outside.badge.id })).ok, true, 'Senior Commander can review across sectors');

  const chiefList = await f.api.handlers.adminList(f.users[0], {});
  const seniorList = await f.api.handlers.adminList(f.users[1], {});
  assert.equal(chiefList.total, 2);
  assert.equal(seniorList.total, 2);
  assert.equal((await f.api.handlers.disable(f.users[0], { id: inScope.badge.id, reason: 'Leadership review' })).ok, true);
  assert.equal((await f.api.handlers.enable(f.users[0], { id: inScope.badge.id })).ok, true);
});

test('records rejection metadata and reason, then preserves it when the owner resubmits', async () => {
  const f = fixture();
  const created = await f.api.handlers.create(f.users[3], payload(f.now()));
  const commander = f.users[2];

  assert.equal((await f.api.handlers.reject(commander, { id: created.badge.id })).ok, false, 'a rejection reason is required');
  assert.equal((await f.api.handlers.reject(f.users[4], { id: created.badge.id, reason: 'Outside scope' })).ok, false);

  const rejected = await f.api.handlers.reject(commander, { id: created.badge.id, reason: 'يرجى تصحيح بيانات المهمة' });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.badge.status, REVIEW_STATUS.REJECTED);
  assert.equal(rejected.badge.isApproved, false);
  assert.equal(rejected.badge.statusReason, 'يرجى تصحيح بيانات المهمة');
  const decision = rejected.badge.review.decisions[0];
  assert.equal(decision.byName, 'Commander Real Name');
  assert.equal(decision.byCode, 'CMD-1');
  assert.equal(decision.byRank, 'HIGH COMMANDER');
  assert.equal(decision.bySector, 'Special Operations');
  assert.equal(decision.at, rejected.badge.review.decidedAt);
  assert.equal(decision.reason, 'يرجى تصحيح بيانات المهمة');
  assert.match(f.state.cia_audit_logs[0].details, /rank=HIGH COMMANDER/);
  assert.match(f.state.cia_audit_logs[0].details, /sector=Special Operations/);

  const ownerView = (await f.api.handlers.mine(f.users[3])).badges[0];
  assert.equal(ownerView.status, REVIEW_STATUS.REJECTED);
  assert.equal(ownerView.statusReason, 'يرجى تصحيح بيانات المهمة');

  const resubmitted = await f.api.handlers.update(f.users[3], { id: created.badge.id, alias: 'Raven Revised' });
  assert.equal(resubmitted.ok, true);
  assert.equal(resubmitted.badge.status, REVIEW_STATUS.PENDING);
  assert.equal(resubmitted.badge.statusReason, '');
  assert.equal(resubmitted.badge.review.decisions.length, 1);
  const approved = await f.api.handlers.approve(f.users[1], { id: created.badge.id });
  assert.equal(approved.ok, true);
  assert.equal(approved.badge.status, 'ACTIVE');
  assert.equal(approved.badge.review.decisions.length, 2);
  assert.deepEqual(approved.badge.review.decisions.map((item) => item.action), ['REJECTED', 'APPROVED']);
});

test('treats existing unreviewed active records as pending rather than approved', async () => {
  const f = fixture();
  const created = await f.api.handlers.create(f.users[3], payload(f.now()));
  const stored = f.state.cia_cover_badges[0];
  stored.status = 'ACTIVE';
  delete stored.review;

  const read = await f.api.handlers.get(f.users[3], { id: created.badge.id });
  assert.equal(read.ok, true);
  assert.equal(read.badge.status, REVIEW_STATUS.PENDING);
  assert.equal(read.badge.reviewStatus, REVIEW_STATUS.PENDING);
  assert.equal(read.badge.isApproved, false);
});

test('marks expired badges and writes both permanent history and audit records on read', async () => {
  const f = fixture();
  const created = await f.api.handlers.create(f.users[3], payload(f.now(), {
    expiresAt: new Date(f.now() + DAY).toISOString()
  }));
  assert.equal((await f.api.handlers.approve(f.users[2], { id: created.badge.id })).ok, true);
  f.setNow(f.now() + DAY + 1000);
  const read = await f.api.handlers.get(f.users[3], { id: created.badge.id });
  assert.equal(read.ok, true);
  assert.equal(read.badge.status, 'EXPIRED');
  assert.equal(f.state.cia_cover_badges.length, 1);
  assert.equal(f.state.cia_cover_badges[0].status, 'EXPIRED');
  assert.deepEqual(read.badge.history.map((event) => event.action), ['CREATED', 'APPROVED', 'EXPIRED']);
  assert.ok(f.state.cia_audit_logs.some((row) => row.action === 'COVER_BADGE_EXPIRED'));
});

test('rolls back both badge data and the audit trail if persistence fails', async () => {
  const f = fixture({ failSave: true });
  const result = await f.api.handlers.create(f.users[3], payload(f.now()));
  assert.equal(result.ok, false);
  assert.equal(f.state.cia_cover_badges.length, 0);
  assert.equal(f.state.cia_audit_logs.length, 0);
});

test('rolls back a review decision and audit record if persistence fails', async () => {
  const f = fixture();
  const created = await f.api.handlers.create(f.users[3], payload(f.now()));
  f.setFailSave(true);

  const result = await f.api.handlers.approve(f.users[2], { id: created.badge.id });
  assert.equal(result.ok, false);
  assert.equal(f.state.cia_cover_badges[0].status, REVIEW_STATUS.PENDING);
  assert.equal(f.state.cia_cover_badges[0].review.status, REVIEW_STATUS.PENDING);
  assert.deepEqual(f.state.cia_cover_badges[0].review.decisions, []);
  assert.deepEqual(f.state.cia_audit_logs.map((row) => row.action), ['COVER_BADGE_CREATED']);
});
