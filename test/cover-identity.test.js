'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BADGE_TYPES, REVIEW_STATUS, createCoverIdentity, injectCoverIdentityMarkup, registerCoverIdentitySocket } = require('../cover-identity');

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
    units,
    ctx,
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


test('limits creator identity fields by reviewer role in details, search, and activity', async () => {
  const f = fixture();
  const created = await f.api.handlers.create(f.users[3], payload(f.now()));
  const id = created.badge.id;

  const commander = await f.api.handlers.get(f.users[2], { id });
  assert.equal(commander.badge.owner.name, 'Real Member Name');
  assert.equal(commander.badge.owner.militaryCode, '');
  assert.equal(commander.badge.owner.rank, '');
  assert.equal(commander.badge.history[0].byName, 'Real Member Name');
  assert.equal(commander.badge.history[0].byCode, '');
  assert.equal(commander.badge.history[0].byRank, '');
  assert.equal(commander.badge.can.approve, false, 'sector commanders can view scoped badges but cannot decide reviews');
  assert.equal((await f.api.handlers.adminList(f.users[2], { query: 'Real Member Name' })).total, 1);
  assert.equal((await f.api.handlers.adminList(f.users[2], { query: 'AG-101' })).total, 0);
  const commanderFeed = await f.api.handlers.adminActivity(f.users[2]);
  assert.equal(commanderFeed.activity[0].ownerName, 'Real Member Name');
  assert.equal(commanderFeed.activity[0].ownerCode, '');
  assert.equal(commanderFeed.activity[0].byName, 'Real Member Name');
  assert.equal(commanderFeed.activity[0].byCode, '');

  const senior = await f.api.handlers.get(f.users[1], { id });
  assert.equal(senior.badge.owner.name, '');
  assert.equal(senior.badge.owner.militaryCode, 'AG-101');
  assert.equal(senior.badge.owner.rank, '');
  assert.equal(senior.badge.history[0].byName, '');
  assert.equal(senior.badge.history[0].byCode, 'AG-101');
  assert.equal(senior.badge.history[0].byRank, '');
  assert.equal(senior.badge.can.approve, true);
  assert.equal((await f.api.handlers.adminList(f.users[1], { query: 'Real Member Name' })).total, 0);
  assert.equal((await f.api.handlers.adminList(f.users[1], { query: 'AG-101' })).total, 1);
  const seniorFeed = await f.api.handlers.adminActivity(f.users[1]);
  assert.equal(seniorFeed.activity[0].ownerName, '');
  assert.equal(seniorFeed.activity[0].ownerCode, 'AG-101');
  assert.equal(seniorFeed.activity[0].byName, '');
  assert.equal(seniorFeed.activity[0].byCode, 'AG-101');

  const chief = await f.api.handlers.get(f.users[0], { id });
  assert.equal(chief.badge.owner.name, 'Real Member Name');
  assert.equal(chief.badge.owner.militaryCode, 'AG-101');
  assert.equal(chief.badge.owner.rank, 'AGENT');
});

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

test('automatically approves CIA CHIEF identities on creation and edits and excludes its own identities from review queues', async () => {
  const f = fixture();
  const chief = f.users[0];
  const created = await f.api.handlers.create(chief, payload(f.now()));
  assert.equal(created.ok, true);
  assert.equal(created.badge.status, 'ACTIVE');
  assert.equal(created.badge.reviewStatus, REVIEW_STATUS.APPROVED);
  assert.equal(created.badge.isApproved, true);
  assert.equal(created.badge.review.decisions.length, 1);
  assert.equal(created.badge.review.decisions[0].action, 'AUTO_APPROVED');
  assert.equal(created.badge.review.decisions[0].automatic, true);
  assert.match(f.state.cia_audit_logs[0].details, /autoApproved=true/);
  assert.equal((await f.api.handlers.reviewList(f.users[1])).total, 0);
  assert.equal((await f.api.handlers.reviewList(f.users[2])).ok, false, 'sector commanders cannot access the review queue');

  const updated = await f.api.handlers.update(chief, { id: created.badge.id, alias: 'Chief Raven' });
  assert.equal(updated.ok, true);
  assert.equal(updated.badge.status, 'ACTIVE');
  assert.equal(updated.badge.reviewStatus, REVIEW_STATUS.APPROVED);
  assert.equal(updated.badge.review.decisions.length, 2);
  assert.equal(updated.badge.review.decisions[1].action, 'AUTO_APPROVED');
  assert.equal((await f.api.handlers.mine(chief)).badges[0].isApproved, true);

  const meta = f.api.handlers.meta(chief);
  assert.equal(meta.isChief, true);
  assert.equal(meta.canAdmin, true);
  assert.equal(meta.scope, 'ALL');
  assert.equal(meta.canReviewQueue, true);
  assert.equal((await f.api.handlers.adminList(chief, {})).total, 1, 'CIA CHIEF keeps system-wide supervision');
});

test('CIA CHIEF can approve and cancel pending identities across sectors', async () => {
  const f = fixture();
  const alpha = await f.api.handlers.create(f.users[3], payload(f.now()));
  const beta = await f.api.handlers.create(f.users[4], payload(f.now(), { type: 'EMS', badgeNumber: 'EMS-300003' }));
  const chiefIdentity = await f.api.handlers.create(f.users[0], payload(f.now(), { type: 'POLICE', badgeNumber: 'PD-200002' }));

  const chief = f.users[0];
  const queue = await f.api.handlers.reviewList(chief);
  assert.equal(queue.ok, true);
  assert.equal(queue.scope, 'ALL');
  assert.deepEqual(queue.badges.map((badge) => badge.id).sort(), [alpha.badge.id, beta.badge.id].sort());
  assert.equal(queue.badges.every((badge) => badge.can.approve && badge.can.reject), true);
  assert.equal(queue.badges.some((badge) => badge.id === chiefIdentity.badge.id), false, 'CIA CHIEF identity remains auto-approved and outside the queue');

  const approved = await f.api.handlers.approve(chief, { id: alpha.badge.id });
  assert.equal(approved.ok, true);
  assert.equal(approved.badge.status, 'ACTIVE');
  const canceled = await f.api.handlers.reject(chief, { id: beta.badge.id, reason: 'بيانات الهوية تحتاج تصحيحًا' });
  assert.equal(canceled.ok, true);
  assert.equal(canceled.badge.status, REVIEW_STATUS.REJECTED);
  assert.equal(canceled.badge.statusReason, 'بيانات الهوية تحتاج تصحيحًا');
  assert.equal((await f.api.handlers.reviewList(f.users[2])).ok, false, 'sector commanders cannot access the review queue');
  assert.equal((await f.api.handlers.reviewList(f.users[3])).ok, false, 'ordinary members cannot query the review queue');
});



test('automatically approves legacy pending identities owned by the current CIA CHIEF before listing reviews', async () => {
  const f = fixture();
  const created = await f.api.handlers.create(f.users[3], payload(f.now()));
  const stored = f.state.cia_cover_badges[0];
  stored.owner = {
    userId: f.users[0].id,
    name: 'Chief Real Name',
    militaryCode: 'CHIEF-1',
    rank: 'CIA CHIEF'
  };

  const queue = await f.api.handlers.reviewList(f.users[1]);
  assert.equal(queue.ok, true);
  assert.equal(queue.total, 0);
  assert.equal(stored.status, 'ACTIVE');
  assert.equal(stored.review.status, REVIEW_STATUS.APPROVED);
  assert.equal(stored.review.decisions[0].automatic, true);
  assert.equal(f.state.cia_audit_logs[0].action, 'COVER_BADGE_AUTO_APPROVED');
  assert.match(f.state.cia_audit_logs[0].details, /reviewer=Chief Real Name/);
  assert.match(f.state.cia_audit_logs[0].details, /automatic=true/);
  assert.equal(created.ok, true);
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
  const approved = await f.api.handlers.approve(f.users[1], { id: created.badge.id });
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

test('only CIA CHIEF and Senior Commander can approve or cancel across all sectors', async () => {
  const f = fixture();
  const inScope = await f.api.handlers.create(f.users[3], payload(f.now()));
  const outsideToReject = await f.api.handlers.create(f.users[4], payload(f.now(), { type: 'EMS', badgeNumber: 'EMS-300003' }));
  const outsideToApprove = await f.api.handlers.create(f.users[4], payload(f.now(), { type: 'POLICE', badgeNumber: 'PD-400004' }));
  const commander = f.users[2];
  const scoped = await f.api.handlers.adminList(commander, {});
  assert.equal(scoped.ok, true);
  assert.equal(scoped.scope, 'SECTOR');
  assert.equal(f.api.handlers.meta(commander).canReviewQueue, false);
  assert.equal(f.api.handlers.meta(f.users[0]).canReviewQueue, true);
  assert.equal(f.api.handlers.meta(f.users[1]).canReviewQueue, true);
  assert.equal(scoped.total, 1);
  assert.equal(scoped.badges[0].id, inScope.badge.id);
  assert.equal(scoped.badges[0].can.approve, false);
  assert.equal(scoped.badges[0].can.reject, false);
  assert.equal((await f.api.handlers.get(commander, { id: outsideToReject.badge.id })).ok, false);
  assert.equal((await f.api.handlers.disable(commander, { id: inScope.badge.id, reason: 'Review' })).ok, false);
  assert.equal((await f.api.handlers.approve(commander, { id: inScope.badge.id })).ok, false, 'sector commanders cannot approve even in their sector');
  assert.equal((await f.api.handlers.reject(commander, { id: inScope.badge.id, reason: 'Not authorized' })).ok, false, 'sector commanders cannot cancel reviews');

  assert.equal((await f.api.handlers.approve(f.users[0], { id: inScope.badge.id })).ok, true, 'CIA CHIEF can approve across sectors');
  assert.equal((await f.api.handlers.approve(f.users[1], { id: inScope.badge.id })).ok, false, 'one approval is final');
  assert.equal((await f.api.handlers.reject(f.users[1], { id: outsideToReject.badge.id, reason: 'Senior review' })).ok, true, 'Senior Commander can cancel across sectors');
  assert.equal((await f.api.handlers.approve(f.users[1], { id: outsideToApprove.badge.id })).ok, true, 'Senior Commander can approve across sectors');

  const chiefList = await f.api.handlers.adminList(f.users[0], {});
  const seniorList = await f.api.handlers.adminList(f.users[1], {});
  assert.equal(chiefList.total, 3);
  assert.equal(seniorList.total, 3);
  assert.equal((await f.api.handlers.disable(f.users[0], { id: inScope.badge.id, reason: 'Leadership review' })).ok, true);
  assert.equal((await f.api.handlers.enable(f.users[0], { id: inScope.badge.id })).ok, true);
});



test('sector commanders cannot access review queues or decide badge reviews', async () => {
  const f = fixture();
  f.units[0].memberCodes = ['CMD-1'];
  f.units[0].deputyCode = 'AG-101';
  const memberBadge = await f.api.handlers.create(f.users[3], payload(f.now()));
  const outsideBadge = await f.api.handlers.create(f.users[4], payload(f.now(), { type: 'POLICE', badgeNumber: 'PD-808080' }));
  const commanderBadge = await f.api.handlers.create(f.users[2], payload(f.now(), { type: 'MEDIA', badgeNumber: 'MED-808080' }));

  const commander = f.users[2];
  const queue = await f.api.handlers.reviewList(commander);
  assert.equal(queue.ok, false);
  assert.equal(f.api.handlers.meta(commander).canReviewQueue, false);
  const scoped = await f.api.handlers.adminList(commander, {});
  assert.equal(scoped.ok, true);
  assert.equal(scoped.scope, 'SECTOR');
  assert.equal(scoped.badges.some((badge) => badge.id === memberBadge.badge.id), true);
  assert.equal(scoped.badges.find((badge) => badge.id === memberBadge.badge.id).can.approve, false);
  assert.equal((await f.api.handlers.reviewList(f.users[3])).ok, false, 'ordinary members cannot query the review queue');
  assert.equal((await f.api.handlers.approve(commander, { id: memberBadge.badge.id })).ok, false);
  assert.equal((await f.api.handlers.reject(commander, { id: memberBadge.badge.id, reason: 'Not authorized' })).ok, false);
  assert.equal((await f.api.handlers.approve(commander, { id: commanderBadge.badge.id })).ok, false, 'a commander cannot approve their own identity');
  assert.equal((await f.api.handlers.approve(commander, { id: outsideBadge.badge.id })).ok, false);

  const seniorQueue = await f.api.handlers.reviewList(f.users[1]);
  assert.equal(seniorQueue.total, 3, 'Senior Commander can see all pending identities');
  assert.equal(seniorQueue.badges.every((badge) => badge.can.approve && badge.can.reject), true);
  const approved = await f.api.handlers.approve(f.users[1], { id: memberBadge.badge.id });
  assert.equal(approved.ok, true);
  assert.equal(approved.badge.isApproved, true);
  assert.equal(approved.badge.status, 'ACTIVE');
  assert.equal((await f.api.handlers.reviewList(f.users[1])).total, 2);
});



test('socket review-list and approval events use the authenticated actor and persist decisions', async () => {
  const f = fixture();
  const created = await f.api.handlers.create(f.users[3], payload(f.now()));
  const routes = new Map();
  let actor = f.users[1];
  const socket = { on: (event, handler) => routes.set(event, handler) };
  const ctx = {
    ...f.ctx,
    requireSocketUser: () => actor,
    ok: (callback, data) => callback && callback({ ok: true, ...data }),
    no: (callback, message) => callback && callback({ ok: false, message })
  };
  registerCoverIdentitySocket(socket, ctx);

  let queueReply;
  await routes.get('cover:review:list')({}, (reply) => { queueReply = reply; });
  assert.equal(queueReply.ok, true);
  assert.equal(queueReply.badges.length, 1);
  assert.equal(queueReply.badges[0].id, created.badge.id);

  actor = f.users[2];
  let denied;
  await routes.get('cover:approve')({ id: created.badge.id }, (reply) => { denied = reply; });
  assert.equal(denied.ok, false, 'sector leaders cannot bypass server authorization');
  assert.equal(f.state.cia_cover_badges[0].status, REVIEW_STATUS.PENDING);

  actor = f.users[1];
  let approved;
  await routes.get('cover:approve')({ id: created.badge.id }, (reply) => { approved = reply; });
  assert.equal(approved.ok, true);
  assert.equal(approved.badge.isApproved, true);
  assert.equal(approved.badge.status, 'ACTIVE');
  assert.equal(f.state.cia_audit_logs[0].action, 'COVER_BADGE_APPROVED');
});



test('records rejection metadata and reason, then preserves it when the owner resubmits', async () => {
  const f = fixture();
  const created = await f.api.handlers.create(f.users[3], payload(f.now()));
  const senior = f.users[1];

  assert.equal((await f.api.handlers.reject(senior, { id: created.badge.id })).ok, false, 'a cancellation reason is required');
  assert.equal((await f.api.handlers.reject(f.users[4], { id: created.badge.id, reason: 'Outside scope' })).ok, false);

  const rejected = await f.api.handlers.reject(senior, { id: created.badge.id, reason: 'يرجى تصحيح بيانات المهمة' });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.badge.status, REVIEW_STATUS.REJECTED);
  assert.equal(rejected.badge.isApproved, false);
  assert.equal(rejected.badge.statusReason, 'يرجى تصحيح بيانات المهمة');
  const decision = rejected.badge.review.decisions[0];
  assert.equal(decision.byName, 'Senior Real Name');
  assert.equal(decision.byCode, 'SENIOR-1');
  assert.equal(decision.byRank, 'SUPREME COMMANDER');
  assert.equal(decision.bySector, 'القيادة العليا');
  assert.equal(decision.at, rejected.badge.review.decidedAt);
  assert.equal(decision.reason, 'يرجى تصحيح بيانات المهمة');
  assert.equal(f.state.cia_audit_logs[0].action, 'COVER_BADGE_REJECTED');
  assert.match(f.state.cia_audit_logs[0].details, /reviewer=Senior Real Name/);
  assert.match(f.state.cia_audit_logs[0].details, /code=SENIOR-1/);
  assert.match(f.state.cia_audit_logs[0].details, /rank=SUPREME COMMANDER/);
  assert.match(f.state.cia_audit_logs[0].details, /sector=القيادة العليا/);
  assert.ok(f.state.cia_audit_logs[0].details.includes('at=' + decision.at));
  assert.match(f.state.cia_audit_logs[0].details, /reason=يرجى تصحيح بيانات المهمة/);

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
  assert.equal((await f.api.handlers.approve(f.users[1], { id: created.badge.id })).ok, true);
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

  const result = await f.api.handlers.approve(f.users[1], { id: created.badge.id });
  assert.equal(result.ok, false);
  assert.equal(f.state.cia_cover_badges[0].status, REVIEW_STATUS.PENDING);
  assert.equal(f.state.cia_cover_badges[0].review.status, REVIEW_STATUS.PENDING);
  assert.deepEqual(f.state.cia_cover_badges[0].review.decisions, []);
  assert.deepEqual(f.state.cia_audit_logs.map((row) => row.action), ['COVER_BADGE_CREATED']);
});
