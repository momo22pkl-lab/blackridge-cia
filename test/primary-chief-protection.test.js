'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PRIMARY_CHIEF_REPAIR_SQL,
  PRIMARY_CHIEF_GUARD_SQL,
  restorePrimaryChiefAccess,
  restorePrimaryChiefInState
} = require('../primary-chief-protection');

test('restores only the existing chief access gates and preserves identity, code, and records', () => {
  const chief = {
    id: 'existing-chief', rank: 'CIA CHIEF', publicCode: 'CHIEF-TEST', secretCode: 'fixture-only',
    militaryCode: 'MIL-TEST', approved: false, suspended: true, securityStatus: 'SUSPENDED',
    serviceApproved: true, permissions: ['command'], suspensionReason: 'fixture reason',
    profanityStrikes: 4, securityViolationCount: 2
  };
  const other = { id: 'other-user', rank: 'AGENT', approved: true, suspended: true, securityStatus: 'SUSPENDED' };
  const state = {
    cia_users: [chief, other],
    cia_security_incidents: [{ id: 'incident-1', userId: 'existing-chief' }],
    cia_audit_logs: [{ id: 'audit-1', action: 'existing' }]
  };
  const originalChief = structuredClone(chief);
  const originalOther = structuredClone(other);
  const originalIncidents = structuredClone(state.cia_security_incidents);
  const originalAudit = structuredClone(state.cia_audit_logs);

  assert.equal(restorePrimaryChiefInState(state).restored, true);
  assert.equal(chief.approved, true);
  assert.equal(chief.suspended, false);
  assert.equal(chief.securityStatus, 'ACTIVE');
  for (const key of ['id', 'rank', 'publicCode', 'secretCode', 'militaryCode', 'serviceApproved', 'permissions', 'suspensionReason', 'profanityStrikes', 'securityViolationCount']) {
    assert.deepEqual(chief[key], originalChief[key], key + ' must be preserved');
  }
  assert.deepEqual(other, originalOther, 'other users must not be changed');
  assert.deepEqual(state.cia_security_incidents, originalIncidents, 'security incident history must be preserved');
  assert.deepEqual(state.cia_audit_logs, originalAudit, 'audit history must be preserved');
});

test('does not guess when more than one CIA CHIEF row exists', () => {
  const first = { id: 'one', rank: 'CIA CHIEF', approved: false, suspended: true, securityStatus: 'SUSPENDED' };
  const second = { id: 'two', rank: 'CIA CHIEF', approved: false, suspended: true, securityStatus: 'SUSPENDED' };
  const state = { cia_users: [first, second] };
  const before = structuredClone(state);
  assert.equal(restorePrimaryChiefInState(state).ambiguous, true);
  assert.deepEqual(state, before);
  assert.equal(restorePrimaryChiefAccess({ rank: 'AGENT', approved: false }), false);
});

test('PostgreSQL migration repairs one existing chief and guards direct account mutations', () => {
  assert.match(PRIMARY_CHIEF_REPAIR_SQL, /blackridge_app_state/);
  assert.match(PRIMARY_CHIEF_REPAIR_SQL, /jsonb_set/);
  assert.match(PRIMARY_CHIEF_REPAIR_SQL, /COUNT\(\*\)/);
  assert.match(PRIMARY_CHIEF_REPAIR_SQL, /securityStatus/);
  assert.doesNotMatch(PRIMARY_CHIEF_REPAIR_SQL, /cia_security_incidents|cia_audit_logs/);
  assert.match(PRIMARY_CHIEF_GUARD_SQL, /BEFORE UPDATE OR DELETE ON blackridge_app_state/);
  assert.match(PRIMARY_CHIEF_GUARD_SQL, /BEFORE TRUNCATE ON blackridge_app_state/);
  assert.match(PRIMARY_CHIEF_GUARD_SQL, /publicCode/);
  assert.match(PRIMARY_CHIEF_GUARD_SQL, /secretCode/);
  assert.match(PRIMARY_CHIEF_GUARD_SQL, /serviceApproved/);
  assert.match(PRIMARY_CHIEF_GUARD_SQL, /SUPREME COMMANDER/);
  assert.match(PRIMARY_CHIEF_GUARD_SQL, /old_successor/);
  assert.match(PRIMARY_CHIEF_GUARD_SQL, /current_setting/);
  assert.match(PRIMARY_CHIEF_GUARD_SQL, /replacement_count <> 1/);
});

test('server mutation routes protect Primary Chief while retaining the formal handover', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const section = (eventName) => {
    const marker = "'" + eventName + "'";
    const markerAt = server.indexOf(marker);
    assert.notEqual(markerAt, -1, 'missing ' + eventName + ' handler');
    const start = server.lastIndexOf('socket.on(', markerAt);
    const end = server.indexOf('socket.on(', markerAt + marker.length);
    return server.slice(start, end === -1 ? server.length : end);
  };
  for (const eventName of ['security:suspendMember', 'character:admin:action', 'admin:updateMember', 'admin:kickMember', 'admin:kickUser', 'ibp:directory:save']) {
    assert.match(section(eventName), /isPrimaryChief\(target\)/, eventName + ' must guard the chief target');
  }
  const adminAction = section('admin:action');
  assert.ok((adminAction.match(/isPrimaryChief\(target\)/g) || []).length >= 5, 'ban, identity, service, rank, and secret-code actions must be guarded');
  const moderationAt = server.indexOf('function recordModerationViolation');
  const moderationEnd = server.indexOf('const PROFANITY_LEET_MAP', moderationAt);
  const moderation = server.slice(moderationAt, moderationEnd);
  assert.match(moderation, /isPrimaryChief\(actor\)/);
  assert.match(moderation, /level >= 2 && !protectedChief/);
  const handover = section('leadership:handover');
  assert.match(handover, /actor\.rank = 'SUPREME COMMANDER'/);
  assert.match(handover, /target\.rank = 'CIA CHIEF'/);
  assert.match(handover, /saveState\(\{ primaryChiefHandoverFrom: actor\.id \}\)/);
});
