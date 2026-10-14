'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

function makeHarness(actor, state = baseState(), options = {}) {
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
    addAuditLog: (action, user, target, details) => {
      metrics.audits += 1;
      state.cia_audit_logs.unshift({ action, actorCode: user && user.publicCode || '', targetId: target && target.id || null, details });
    },
    saveState: () => {
      metrics.saves += 1;
      return options.failSave ? Promise.reject(new Error('test persistence failure')) : Promise.resolve();
    },
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

test('battalion commanders can create deduplicated, persisted reports for their own unit', async () => {
  const commander = makeHarness(people[3]);
  const payload = {
    requestId: 'report-request-001',
    title: 'West perimeter update',
    summary: 'Patrol coverage completed.',
    text: 'No incidents recorded.',
    battalionId: 'bat-alpha',
    classification: 'INTERNAL',
    status: 'SUBMITTED'
  };
  const first = await commander.invoke('ibp:report:create', payload);
  const duplicate = await commander.invoke('ibp:report:create', payload);
  assert.equal(first.ok, true);
  assert.equal(first.report.reportNumber, 'RPT-TEST-1');
  assert.equal(first.report.battalionCode, 'ALPHA');
  assert.equal(first.report.status, 'SUBMITTED');
  assert.equal(first.report.authorCode, 'ALPHA-1');
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(commander.state.ibp_reports.length, 1);
  assert.equal(commander.metrics.saves, 1);
  assert.equal(commander.metrics.audits, 1);
});

test('ordinary agents can read only scoped reports and cannot create reports', async () => {
  const state = baseState();
  state.ibp_reports = [
    { id: 'RPT-ALPHA', title: 'Alpha patrol', text: 'Scoped details', status: 'SUBMITTED', authorCode: 'ALPHA-1', battalionId: 'bat-alpha', battalionCode: 'ALPHA', classification: 'INTERNAL', createdAt: '2026-10-01T10:00:00.000Z' },
    { id: 'RPT-BRAVO', title: 'Bravo patrol', text: 'Private details', status: 'SUBMITTED', authorCode: 'BRAVO-1', battalionId: 'bat-bravo', battalionCode: 'BRAVO', classification: 'INTERNAL', createdAt: '2026-10-02T10:00:00.000Z' },
    { id: 'RPT-SECRET', title: 'Classified', text: 'Restricted', status: 'SUBMITTED', authorCode: 'ALPHA-1', battalionId: 'bat-alpha', battalionCode: 'ALPHA', classification: 'SECRET', createdAt: '2026-10-03T10:00:00.000Z' }
  ];
  const member = makeHarness(people[5], state);
  const list = await member.invoke('ibp:reports:list', {});
  const create = await member.invoke('ibp:report:create', {
    title: 'Unauthorized report', text: 'Agents are read-only.', battalionId: 'bat-alpha'
  });
  assert.deepEqual(list.reports.map((report) => report.id), ['RPT-ALPHA']);
  assert.equal(list.canCreate, false);
  assert.equal(create.ok, false);
  assert.equal(member.state.ibp_reports.length, 3);
  assert.equal(member.metrics.saves, 0);
});

test('report list filters are applied only after server-side scope and classification checks', async () => {
  const state = baseState();
  state.ibp_reports = [
    { id: 'RPT-A1', title: 'West patrol', text: 'Foot patrol', status: 'SUBMITTED', authorCode: 'ALPHA-1', battalionId: 'bat-alpha', battalionCode: 'ALPHA', classification: 'INTERNAL', createdAt: '2026-10-01T10:00:00.000Z' },
    { id: 'RPT-A2', title: 'West review', text: 'Review notes', status: 'IN_REVIEW', authorCode: 'ALPHA-1', battalionId: 'bat-alpha', battalionCode: 'ALPHA', classification: 'INTERNAL', createdAt: '2026-10-02T10:00:00.000Z' },
    { id: 'RPT-B1', title: 'East patrol', text: 'Not in scope', status: 'SUBMITTED', authorCode: 'BRAVO-1', battalionId: 'bat-bravo', battalionCode: 'BRAVO', classification: 'INTERNAL', createdAt: '2026-10-03T10:00:00.000Z' }
  ];
  const member = makeHarness(people[5], state);
  const filtered = await member.invoke('ibp:reports:list', { battalionId: 'bat-alpha', status: 'IN_REVIEW', query: 'review' });
  const hidden = await member.invoke('ibp:reports:list', { battalionId: 'bat-bravo' });
  assert.deepEqual(filtered.reports.map((report) => report.id), ['RPT-A2']);
  assert.deepEqual(hidden.reports, []);
});

test('report status workflow allows unit commanders to submit for review but reserves decisions to senior command', async () => {
  const commander = makeHarness(people[3]);
  const created = await commander.invoke('ibp:report:create', {
    title: 'Field report', text: 'Review this record.', battalionId: 'bat-alpha'
  });
  const reportId = created.report.id;
  const review = await commander.invoke('ibp:report:update', { id: reportId, status: 'IN_REVIEW' });
  const unauthorizedApproval = await commander.invoke('ibp:report:update', { id: reportId, status: 'APPROVED' });
  assert.equal(review.ok, true);
  assert.equal(review.report.status, 'IN_REVIEW');
  assert.equal(unauthorizedApproval.ok, false);
  const senior = makeHarness(people[1], commander.state);
  const approved = await senior.invoke('ibp:report:update', { id: reportId, status: 'APPROVED' });
  assert.equal(approved.ok, true);
  assert.equal(approved.report.status, 'APPROVED');
  const immutable = await senior.invoke('ibp:report:update', { id: reportId, title: 'Changed after approval' });
  assert.equal(immutable.ok, false);
  assert.equal(senior.state.ibp_reports[0].title, 'Field report');
});

test('report owners can edit and delete drafts; deletion is audited and persisted', async () => {
  const commander = makeHarness(people[3]);
  const created = await commander.invoke('ibp:report:create', {
    title: 'Working draft', text: 'Initial text', battalionId: 'bat-alpha', status: 'DRAFT'
  });
  const edited = await commander.invoke('ibp:report:update', {
    id: created.report.id, title: 'Updated draft', text: 'Revised text'
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.report.title, 'Updated draft');
  assert.equal(edited.report.text, 'Revised text');
  const deleted = await commander.invoke('ibp:report:delete', { id: created.report.id });
  assert.equal(deleted.ok, true);
  assert.equal(commander.state.ibp_reports.length, 0);
  assert.equal(commander.metrics.audits, 3);
  assert.equal(commander.metrics.saves, 3);
});

test('report creation rejects duplicate request IDs with a different author and invalid classifications', async () => {
  const commander = makeHarness(people[3]);
  const first = await commander.invoke('ibp:report:create', {
    requestId: 'shared-request-001', title: 'First report', text: 'Original', battalionId: 'bat-alpha'
  });
  const invalidClassification = await commander.invoke('ibp:report:create', {
    title: 'Overclassified report', text: 'Not allowed', battalionId: 'bat-alpha', classification: 'TOP SECRET'
  });
  const invalidStatus = await commander.invoke('ibp:report:create', {
    title: 'Invalid state', text: 'No status mutation', battalionId: 'bat-alpha', status: 'APPROVED'
  });
  assert.equal(first.ok, true);
  assert.equal(invalidClassification.ok, false);
  assert.equal(invalidStatus.ok, false);
  assert.equal(commander.state.ibp_reports.length, 1);
});

test('failed report persistence rolls back both the report and its audit row', async () => {
  const harness = makeHarness(people[3], baseState(), { failSave: true });
  const result = await harness.invoke('ibp:report:create', {
    requestId: 'report-save-failure-01',
    title: 'Uncommitted report',
    text: 'This must not remain in state after the failed save.',
    battalionId: 'bat-alpha',
    classification: 'INTERNAL'
  });
  assert.equal(result.ok, false);
  assert.equal(harness.state.ibp_reports.length, 0);
  assert.equal(harness.state.cia_audit_logs.length, 0);
  assert.equal(harness.metrics.broadcasts, 0);
});

test('military reports open inside the existing IBP center, while CIA reports and bank panes remain present', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(index, /id="ibp-command-center"/);
  assert.match(index, /data-ibp-feature-open="reports"/);
  assert.match(index, /id="ibp-reports-module"/);
  assert.match(index, /id="reports"/);
  assert.match(index, /id="bank"/);
  assert.match(index, /ibp:reports:list/);
  assert.doesNotMatch(index, /onclick="openIBPModule\('reports'\)"/);
});

test('messages persist between battalions and are visible only to endpoint members', async () => {
  const sender = makeHarness(people[5]);
  const sent = await sender.invoke('ibp:message:send', {
    requestId: 'battalion-message-001',
    fromBattalionId: 'bat-alpha',
    toBattalionId: 'bat-bravo',
    subject: 'Route coordination',
    text: 'Use the western approach at 20:00.',
    classification: 'INTERNAL'
  });
  assert.equal(sent.ok, true);
  assert.equal(sender.state.ibp_messages.length, 1);
  assert.equal(sender.metrics.saves, 1);
  assert.equal(sender.metrics.audits, 1);

  const recipient = makeHarness(people[6], sender.state);
  const inbox = await recipient.invoke('ibp:messages:list', { box: 'INBOX' });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].subject, 'Route coordination');
  assert.equal(inbox.messages[0].incoming, true);
  assert.equal(inbox.unreadCount, 1);

  const outsider = makeHarness(people[7], sender.state);
  const hidden = await outsider.invoke('ibp:messages:list', {});
  assert.equal(hidden.ok, true);
  assert.equal(hidden.messages.length, 0);
  assert.equal(hidden.unreadCount, 0);
});

test('message sending rejects unauthorized source, same-unit delivery, and excessive classification', async () => {
  const member = makeHarness(people[5]);
  const foreignSource = await member.invoke('ibp:message:send', {
    fromBattalionId: 'bat-bravo', toBattalionId: 'bat-alpha',
    subject: 'Unauthorized', text: 'No.'
  });
  const sameUnit = await member.invoke('ibp:message:send', {
    fromBattalionId: 'bat-alpha', toBattalionId: 'bat-alpha',
    subject: 'Loop', text: 'No.'
  });
  const overclassified = await member.invoke('ibp:message:send', {
    fromBattalionId: 'bat-alpha', toBattalionId: 'bat-bravo',
    subject: 'Restricted', text: 'No.', classification: 'SECRET'
  });
  assert.equal(foreignSource.ok, false);
  assert.equal(sameUnit.ok, false);
  assert.equal(overclassified.ok, false);
  assert.equal(member.state.ibp_messages, undefined);
  assert.equal(member.metrics.saves, 0);
});

test('message recipient can mark read idempotently while sender cannot impersonate the recipient', async () => {
  const sender = makeHarness(people[5]);
  const sent = await sender.invoke('ibp:message:send', {
    requestId: 'battalion-message-read-01',
    fromBattalionId: 'bat-alpha', toBattalionId: 'bat-bravo',
    subject: 'Read receipt', text: 'Please acknowledge.'
  });
  const senderAttempt = await sender.invoke('ibp:message:read', { id: sent.message.id });
  assert.equal(senderAttempt.ok, false);
  const recipient = makeHarness(people[6], sender.state);
  const marked = await recipient.invoke('ibp:message:read', { id: sent.message.id });
  const repeated = await recipient.invoke('ibp:message:read', { id: sent.message.id });
  assert.equal(marked.ok, true);
  assert.equal(marked.message.read, true);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.unchanged, true);
  assert.deepEqual(recipient.state.ibp_messages[0].readBy, ['BRAVO-1']);
});

test('duplicate message requests are idempotent and failed persistence removes the message and audit', async () => {
  const sender = makeHarness(people[5]);
  const payload = {
    requestId: 'battalion-message-dedup-01',
    fromBattalionId: 'bat-alpha', toBattalionId: 'bat-bravo',
    subject: 'One message', text: 'Exactly once.'
  };
  const first = await sender.invoke('ibp:message:send', payload);
  const duplicate = await sender.invoke('ibp:message:send', payload);
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(sender.state.ibp_messages.length, 1);
  assert.equal(sender.metrics.saves, 1);

  const failing = makeHarness(people[5], baseState(), { failSave: true });
  const failed = await failing.invoke('ibp:message:send', {
    fromBattalionId: 'bat-alpha', toBattalionId: 'bat-bravo',
    subject: 'Not persisted', text: 'Rollback this.'
  });
  assert.equal(failed.ok, false);
  assert.equal(failing.state.ibp_messages.length, 0);
  assert.equal(failing.state.cia_audit_logs.length, 0);
  assert.equal(failing.metrics.broadcasts, 0);
});

test('battalion messaging is embedded in the current IBP center and stays separate from CIA chat', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(index, /id="ibp-command-center"/);
  assert.match(index, /id="ibp-messages-module"/);
  assert.match(index, /data-ibp-feature-open="messages"/);
  assert.match(index, /id="chat"/);
  assert.match(index, /id="reports"/);
  assert.match(index, /id="bank"/);
  assert.match(server, /ibp_messages: \[\]/);
  assert.match(server, /'ibp_messages'/);
});
