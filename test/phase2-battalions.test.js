'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerIBPSocket } = require('../ibp/handlers');
const { registerPages } = require('../ibp/pages');

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
    position: { x: 440, y: 270 }
  });
  assert.equal(response.ok, true);
  assert.deepEqual(harness.state.cia_battalions[0].mapPosition, { x: 440, y: 270 });
  assert.equal(harness.state.cia_battalions[0].lastMovement.actorCode, 'ALPHA-1');
  assert.deepEqual(harness.state.cia_battalions[0].movementHistory[0].from, { x: 100, y: 120 });
  assert.equal(harness.state.cia_battalions[0].movementHistory[0].at, '2026-10-07T10:00:00.000Z');
  assert.equal(harness.metrics.broadcasts, 1);
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
  const point = await harness.invoke('ibp:phase2:location', { battalionId: 'bat-alpha', x: -1, y: 7000 });
  assert.equal(color.ok, false);
  assert.equal(emblem.ok, false);
  assert.equal(point.ok, false);
  assert.equal(harness.state.cia_battalions[0].color, '#55aacc');
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
