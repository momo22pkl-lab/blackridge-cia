'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerIBPSocket } = require('../ibp/handlers');
const { registerPages } = require('../ibp/pages');
const { recordBattalionLogin, recordBattalionLogout } = require('../ibp/attendance');

const people = [
  { id: 'chief-id', publicCode: 'CHIEF-1', rank: 'CHIEF', approved: true, online: true, name: 'Chief' },
  { id: 'senior-id', publicCode: 'SEN-1', rank: 'SENIOR', approved: true, online: true, name: 'Senior' },
  { id: 'high-id', publicCode: 'HIGH-1', rank: 'HIGH', approved: true, online: true, name: 'High Commander' },
  { id: 'alpha-id', publicCode: 'ALPHA-1', rank: 'AGENT', approved: true, online: true, name: 'Alpha Commander' },
  { id: 'deputy-id', publicCode: 'DEPUTY-1', rank: 'AGENT', approved: true, online: false, name: 'Deputy' },
  { id: 'member-id', publicCode: 'MEMBER-1', rank: 'AGENT', approved: true, online: true, name: 'Member' },
  { id: 'bravo-id', publicCode: 'BRAVO-1', rank: 'AGENT', approved: true, online: false, name: 'Bravo Commander' },
  { id: 'free-id', publicCode: 'FREE-1', rank: 'AGENT', approved: true, online: false, name: 'Free Agent' }
];

function baseState() {
  return {
    cia_users: structuredClone(people),
    cia_battalions: [
      {
        id: 'bat-alpha', code: 'ALPHA', name: 'Alpha', nameAr: 'Alpha', sector: 'WEST',
        commanderCode: 'ALPHA-1', deputyCode: 'DEPUTY-1', seniorCommanderCode: 'HIGH-1',
        memberCodes: ['ALPHA-1', 'DEPUTY-1', 'MEMBER-1'], status: 'ACTIVE',
        color: '#55aacc', emblem: 'SHIELD', mapPosition: { x: 100, y: 120 },
        description: 'West battalion', radioChannel: 'R-14', operationArea: null,
        movementHistory: [], history: []
      },
      {
        id: 'bat-bravo', code: 'BRAVO', name: 'Bravo', nameAr: 'Bravo', sector: 'EAST',
        commanderCode: 'BRAVO-1', memberCodes: ['BRAVO-1'], status: 'ACTIVE',
        color: '#cc7755', emblem: 'EAGLE', mapPosition: null, history: []
      }
    ],
    ibp_operations: [],
    ibp_reports: [],
    cia_audit_logs: []
  };
}

function makeHarness(actor, state = baseState()) {
  const listeners = new Map();
  const metrics = { saves: 0, broadcasts: 0, audits: 0, ids: 0 };
  const socket = {
    id: 'socket-test',
    on(name, listener) { listeners.set(name, listener); }
  };
  const rankLevel = (rank) => ({ AGENT: 0, HIGH: 2, SENIOR: 3, CHIEF: 4 }[rank] || 0);
  const ctx = {
    getState: () => state,
    requireSocketUser: () => actor,
    clean: (value, max) => String(value == null ? '' : value).trim().slice(0, max || 500),
    rankLevel,
    normalizeRank: (rank) => rank,
    rankLabel: (rank) => rank,
    isChief: (person) => !!person && person.rank === 'CHIEF',
    isSenior: (person) => !!person && ['SENIOR', 'CHIEF'].includes(person.rank),
    canManageIBPBattalions: (person) => !!person && ['HIGH', 'SENIOR', 'CHIEF'].includes(person.rank),
    ibpResolveCode: (value) => state.cia_users.find((person) => String(person.publicCode).toUpperCase() === String(value || '').trim().toUpperCase()) || null,
    now: () => '2026-10-07T10:00:00.000Z',
    makeId: (prefix) => prefix + '-TEST-' + (++metrics.ids),
    addAuditLog: () => { metrics.audits += 1; },
    saveState: () => { metrics.saves += 1; return Promise.resolve(); },
    emitState: () => { metrics.broadcasts += 1; }
  };
  registerIBPSocket(socket, ctx);
  const invoke = (event, payload) => new Promise((resolve) => {
    const listener = listeners.get(event);
    assert.ok(listener, 'missing Socket.IO event: ' + event);
    listener(payload || {}, resolve);
  });
  return { state, metrics, listeners, invoke };
}

test('battalion commander can update their own battalion fields and persists the change', async () => {
  const harness = makeHarness(people[3]);
  const response = await harness.invoke('ibp:phase2:update', {
    battalionId: 'bat-alpha',
    name: 'Alpha West',
    color: '#12abef',
    emblem: 'WOLF',
    description: 'Updated patrol coverage',
    radioChannel: 'R-22'
  });
  assert.equal(response.ok, true);
  assert.equal(harness.state.cia_battalions[0].name, 'Alpha West');
  assert.equal(harness.state.cia_battalions[0].color, '#12abef');
  assert.equal(harness.state.cia_battalions[0].emblem, 'WOLF');
  assert.equal(harness.state.cia_battalions[0].radioChannel, 'R-22');
  assert.equal(harness.metrics.saves, 1);
  assert.equal(harness.metrics.broadcasts, 1);
  assert.equal(harness.metrics.audits, 1);
});

test('a battalion commander cannot change another battalion or grant themselves broader access', async () => {
  const harness = makeHarness(people[3]);
  const response = await harness.invoke('ibp:phase2:update', {
    battalionId: 'bat-bravo',
    name: 'Unauthorized'
  });
  assert.equal(response.ok, false);
  assert.equal(harness.state.cia_battalions[1].name, 'Bravo');
  assert.equal(harness.metrics.saves, 0);
});

test('ordinary members can view their battalion but cannot change its records or position', async () => {
  const harness = makeHarness(people[5]);
  const list = await harness.invoke('ibp:phase2:list', {});
  assert.deepEqual(list.battalions.map((unit) => unit.code), ['ALPHA']);
  const update = await harness.invoke('ibp:phase2:update', { battalionId: 'bat-alpha', color: '#112233' });
  const move = await harness.invoke('ibp:phase2:location', { battalionId: 'bat-alpha', x: 500, y: 500 });
  assert.equal(update.ok, false);
  assert.equal(move.ok, false);
  assert.equal(harness.state.cia_battalions[0].color, '#55aacc');
  assert.equal(harness.metrics.saves, 0);
});

test('deputy can see their unit, and existing high-command scope can still manage linked units', async () => {
  const deputy = makeHarness(people[4]);
  const list = await deputy.invoke('ibp:phase2:list', {});
  assert.deepEqual(list.battalions.map((unit) => unit.code), ['ALPHA']);

  const highCommand = makeHarness(people[2]);
  const update = await highCommand.invoke('ibp:phase2:update', { battalionId: 'bat-alpha', status: 'ALERT' });
  assert.equal(update.ok, true);
  assert.equal(highCommand.state.cia_battalions[0].status, 'ALERT');
});

test('movement saves the latest location, actor, timestamp, history, and a live state broadcast', async () => {
  const harness = makeHarness(people[3]);
  const response = await harness.invoke('ibp:phase2:location', {
    battalionId: 'bat-alpha',
    position: { x: 440, y: 270 },
    reason: 'Patrol'
  });
  assert.equal(response.ok, true);
  assert.deepEqual(harness.state.cia_battalions[0].mapPosition, { x: 440, y: 270 });
  assert.equal(harness.state.cia_battalions[0].lastMovement.actorCode, 'ALPHA-1');
  assert.equal(harness.state.cia_battalions[0].lastMovement.reason, 'Patrol');
  assert.deepEqual(harness.state.cia_battalions[0].movementHistory[0].from, { x: 100, y: 120 });
  assert.equal(harness.state.cia_battalions[0].movementHistory[0].at, '2026-10-07T10:00:00.000Z');
  assert.equal(harness.metrics.broadcasts, 1);
});

test('movement requires a reason and appends to existing history without truncating it', async () => {
  const state = baseState();
  state.cia_battalions[0].movementHistory = Array.from({ length: 45 }, (_, index) => ({
    at: '2026-10-06T00:00:00.000Z',
    actorCode: 'ALPHA-1',
    from: { x: index, y: 10 },
    to: { x: index + 1, y: 10 },
    reason: 'Legacy movement ' + index
  }));
  const harness = makeHarness(people[3], state);
  const missingReason = await harness.invoke('ibp:phase2:location', {
    battalionId: 'bat-alpha',
    position: { x: 440, y: 270 }
  });
  assert.equal(missingReason.ok, false);
  assert.equal(harness.state.cia_battalions[0].movementHistory.length, 45);
  const response = await harness.invoke('ibp:phase2:location', {
    battalionId: 'bat-alpha',
    position: { x: 440, y: 270 },
    reason: 'Patrol'
  });
  assert.equal(response.ok, true);
  assert.equal(harness.state.cia_battalions[0].movementHistory.length, 46);
  assert.equal(harness.state.cia_battalions[0].movementHistory[0].reason, 'Legacy movement 0');
});

test('battalion dashboard scopes attendance and reports and exposes command metrics to managers', async () => {
  const state = baseState();
  state.cia_battalion_attendance = [
    { id: 'att-1', userId: 'member-id', publicCode: 'MEMBER-1', memberName: 'Member', rank: 'AGENT', battalionId: 'bat-alpha', battalionCode: 'ALPHA', loginAt: '2026-10-07T09:00:00.000Z', logoutAt: null, lastSeenAt: '2026-10-07T09:00:00.000Z', status: 'ONLINE', durationMs: null },
    { id: 'att-1b', userId: 'member-id', publicCode: 'MEMBER-1', memberName: 'Member', rank: 'AGENT', battalionId: 'bat-alpha', battalionCode: 'ALPHA', loginAt: '2026-10-07T06:00:00.000Z', logoutAt: '2026-10-07T06:30:00.000Z', lastSeenAt: '2026-10-07T06:30:00.000Z', status: 'OFFLINE', durationMs: 1800000 },
    { id: 'att-2', userId: 'bravo-id', publicCode: 'BRAVO-1', memberName: 'Bravo Commander', rank: 'AGENT', battalionId: 'bat-bravo', battalionCode: 'BRAVO', loginAt: '2026-10-07T08:00:00.000Z', logoutAt: '2026-10-07T08:30:00.000Z', lastSeenAt: '2026-10-07T08:30:00.000Z', status: 'OFFLINE', durationMs: 1800000 }
  ];
  state.cia_battalion_reports = [
    { id: 'rpt-alpha', reportId: 'BTR-1', battalionId: 'bat-alpha', battalionCode: 'ALPHA', authorCode: 'ALPHA-1', type: 'PATROL REPORT', priority: 'HIGH', location: { x: 400, y: 250 }, description: 'Patrol completed', createdAt: '2026-10-07T09:15:00.000Z', status: 'OPEN' },
    { id: 'rpt-bravo', reportId: 'BTR-2', battalionId: 'bat-bravo', battalionCode: 'BRAVO', authorCode: 'BRAVO-1', type: 'INCIDENT REPORT', priority: 'NORMAL', location: { x: 600, y: 350 }, description: 'Other unit', createdAt: '2026-10-07T08:15:00.000Z', status: 'OPEN' }
  ];
  state.ibp_operations = [{ id: 'op-1', battalionId: 'bat-alpha', status: 'IN_PROGRESS' }];
  const commander = await makeHarness(people[3], state).invoke('ibp:phase3:dashboard', {});
  assert.equal(commander.ok, true);
  assert.deepEqual(commander.battalions.map((unit) => unit.code), ['ALPHA']);
  assert.equal(commander.battalions[0].dashboard.onlineCount, 2);
  assert.equal(commander.battalions[0].dashboard.todayAttendanceCount, 1);
  assert.equal(commander.battalions[0].dashboard.activeOperations, 1);
  assert.deepEqual(commander.reports.map((report) => report.reportId), ['BTR-1']);
  assert.equal(commander.canCreate, false);
  const highCommand = await makeHarness(people[2], state).invoke('ibp:phase3:dashboard', {});
  assert.equal(highCommand.canCreate, true);
  const member = await makeHarness(people[5], state).invoke('ibp:phase3:dashboard', {});
  assert.equal(member.battalions[0].dashboard.attendanceRoster.length, 0);
  assert.deepEqual(member.reports.map((report) => report.reportId), ['BTR-1']);
});

test('attendance history filters by date and is limited to the battalion command scope', async () => {
  const state = baseState();
  state.cia_battalion_attendance = [
    { id: 'att-1', userId: 'member-id', publicCode: 'MEMBER-1', memberName: 'Member', rank: 'AGENT', battalionId: 'bat-alpha', battalionCode: 'ALPHA', loginAt: '2026-10-06T09:00:00.000Z', logoutAt: '2026-10-06T10:00:00.000Z', lastSeenAt: '2026-10-06T10:00:00.000Z', status: 'OFFLINE', durationMs: 3600000 },
    { id: 'att-2', userId: 'member-id', publicCode: 'MEMBER-1', memberName: 'Member', rank: 'AGENT', battalionId: 'bat-alpha', battalionCode: 'ALPHA', loginAt: '2026-10-07T09:00:00.000Z', logoutAt: null, lastSeenAt: '2026-10-07T09:00:00.000Z', status: 'ONLINE', durationMs: null }
  ];
  const commander = makeHarness(people[3], state);
  const result = await commander.invoke('ibp:phase3:attendance:history', {
    battalionId: 'bat-alpha', fromDate: '2026-10-07', toDate: '2026-10-07'
  });
  assert.equal(result.ok, true);
  assert.equal(result.attendance.length, 1);
  assert.equal(result.attendance[0].status, 'ONLINE');
  assert.equal(result.attendance[0].durationMs, 3600000);
  const otherUnit = await commander.invoke('ibp:phase3:attendance:history', { battalionId: 'bat-bravo' });
  assert.equal(otherUnit.ok, false);
  const invalidDate = await commander.invoke('ibp:phase3:attendance:history', {
    battalionId: 'bat-alpha', fromDate: '2026-02-31'
  });
  assert.equal(invalidDate.ok, false);
  const member = makeHarness(people[5], state);
  assert.equal((await member.invoke('ibp:phase3:attendance:history', { battalionId: 'bat-alpha' })).ok, false);
});

test('battalion reports require command permission, validated fields, and keep map coordinates', async () => {
  const commander = makeHarness(people[3]);
  const report = await commander.invoke('ibp:phase3:report:create', {
    battalionId: 'bat-alpha',
    type: 'PATROL REPORT',
    priority: 'HIGH',
    status: 'OPEN',
    location: { x: 440, y: 270 },
    description: 'Patrol completed along the west road.'
  });
  assert.equal(report.ok, true);
  assert.equal(report.report.location.x, 440);
  assert.equal(report.report.authorCode, 'ALPHA-1');
  assert.equal(commander.state.cia_battalion_reports[0].battalionId, 'bat-alpha');
  const unauthorized = await commander.invoke('ibp:phase3:report:create', {
    battalionId: 'bat-bravo', type: 'PATROL REPORT', priority: 'LOW', description: 'Out of scope'
  });
  assert.equal(unauthorized.ok, false);
  const invalid = await commander.invoke('ibp:phase3:report:create', {
    battalionId: 'bat-alpha', type: 'UNKNOWN', priority: 'HIGH', description: 'Invalid type'
  });
  assert.equal(invalid.ok, false);
  assert.equal(commander.metrics.broadcasts, 1);
});

test('attendance sessions are created on login and closed with durable duration on logout', () => {
  const state = baseState();
  const user = state.cia_users.find((person) => person.id === 'member-id');
  let ids = 0;
  const opened = recordBattalionLogin(state, user, '2026-10-07T09:00:00.000Z', () => 'BATTEND-' + (++ids));
  assert.equal(opened.battalionCode, 'ALPHA');
  assert.equal(opened.status, 'ONLINE');
  const closed = recordBattalionLogout(state, user, '2026-10-07T10:30:00.000Z');
  assert.equal(closed.status, 'OFFLINE');
  assert.equal(closed.durationMs, 5400000);
  assert.equal(closed.logoutAt, '2026-10-07T10:30:00.000Z');
  assert.equal(recordBattalionLogout(state, user, '2026-10-07T10:45:00.000Z'), null);
});

test('circle and polygon operation areas are validated and persisted', async () => {
  const harness = makeHarness(people[3]);
  const circle = await harness.invoke('ibp:phase2:area', {
    battalionId: 'bat-alpha', type: 'CIRCLE', center: { x: 250, y: 330 }, radius: 90
  });
  assert.equal(circle.ok, true);
  assert.deepEqual(harness.state.cia_battalions[0].operationArea, {
    type: 'CIRCLE', center: { x: 250, y: 330 }, radius: 90
  });
  const polygon = await harness.invoke('ibp:phase2:area', {
    battalionId: 'bat-alpha', type: 'POLYGON',
    points: [{ x: 10, y: 10 }, { x: 180, y: 10 }, { x: 90, y: 180 }]
  });
  assert.equal(polygon.ok, true);
  assert.equal(harness.state.cia_battalions[0].operationArea.type, 'POLYGON');
  const invalid = await harness.invoke('ibp:phase2:area', {
    battalionId: 'bat-alpha', type: 'POLYGON',
    points: [{ x: 10, y: 10 }, { x: 1200, y: 10 }, { x: 90, y: 180 }]
  });
  assert.equal(invalid.ok, false);
  assert.equal(harness.metrics.saves, 2);
});

test('creation is restricted to existing battalion-management roles and validates commanders', async () => {
  const agent = makeHarness(people[3]);
  const denied = await agent.invoke('ibp:phase2:create', {
    code: 'NEW-ONE', name: 'New Unit', sector: 'NORTH', commanderCode: 'FREE-1'
  });
  assert.equal(denied.ok, false);
  assert.equal(agent.state.cia_battalions.length, 2);

  const senior = makeHarness(people[1]);
  const created = await senior.invoke('ibp:phase2:create', {
    code: 'NEW-ONE', name: 'New Unit', sector: 'NORTH',
    commanderCode: 'FREE-1', deputyCode: '', color: '#aa6611',
    emblem: 'FALCON', radioChannel: 'R-40', description: 'New north patrol',
    status: 'ACTIVE'
  });
  assert.equal(created.ok, true);
  assert.equal(senior.state.cia_battalions.length, 3);
  assert.equal(senior.state.cia_battalions[0].commanderCode, 'FREE-1');
  assert.equal(senior.state.cia_battalions[0].emblem, 'FALCON');
  const duplicate = await senior.invoke('ibp:phase2:create', {
    code: 'NEW-ONE', name: 'Duplicate', sector: 'NORTH', commanderCode: 'FREE-1'
  });
  assert.equal(duplicate.ok, false);
  assert.equal(senior.state.cia_battalions.length, 3);
});

test('invalid colors, emblems, and coordinates are rejected without mutation', async () => {
  const harness = makeHarness(people[3]);
  const color = await harness.invoke('ibp:phase2:update', { battalionId: 'bat-alpha', color: 'url(javascript:alert(1))' });
  const emblem = await harness.invoke('ibp:phase2:update', { battalionId: 'bat-alpha', emblem: '<script>' });
  const mixed = await harness.invoke('ibp:phase2:update', {
    battalionId: 'bat-alpha', name: 'Must not partially apply', color: '#123456', memberCodes: ['BRAVO-1']
  });
  const point = await harness.invoke('ibp:phase2:location', { battalionId: 'bat-alpha', x: -1, y: 7000 });
  assert.equal(color.ok, false);
  assert.equal(emblem.ok, false);
  assert.equal(mixed.ok, false);
  assert.equal(point.ok, false);
  assert.equal(harness.state.cia_battalions[0].name, 'Alpha');
  assert.equal(harness.state.cia_battalions[0].color, '#55aacc');
  assert.deepEqual(harness.state.cia_battalions[0].memberCodes, ['ALPHA-1', 'DEPUTY-1', 'MEMBER-1']);
  assert.equal(harness.metrics.saves, 0);
});

test('the Phase 2 client asset is registered by the existing IBP page router', () => {
  const routes = new Map();
  const app = { get: (route, handler) => routes.set(route, handler) };
  registerPages(app);
  const handler = routes.get('/world-command-battalions.js');
  assert.equal(typeof handler, 'function');
  let type;
  let file;
  handler({}, {
    type(value) { type = value; return this; },
    sendFile(value) { file = value; }
  });
  assert.equal(type, 'application/javascript');
  assert.ok(file.endsWith('/ibp/world-command-battalions.js'));
});
