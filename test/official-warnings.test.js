'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerOfficialWarnings } = require('../official-warnings');

function makeHarness(initialActor, people) {
  let actor = initialActor;
  let nextId = 0;
  const handlers = new Map();
  const rows = [];
  const store = {
    async listForUser(options) {
      const matched = rows.filter((row) => row.userId === options.userId && (!options.type || row.type === options.type))
        .filter((row) => !options.search || row.relatedId === options.search || JSON.stringify(row.metadata).includes(options.search));
      const offset = options.offset || 0;
      return { rows: matched.slice(offset, offset + (options.limit || 50)), hasMore: false };
    }
  };
  const socket = { on: (event, handler) => handlers.set(event, handler) };
  const context = {
    getAuthenticatedUser: () => actor,
    getUsers: () => people,
    getNotificationsStore: () => store,
    isChief: (user) => !!user && String(user.rank).toUpperCase() === 'CIA CHIEF',
    normalizeRank: (rank) => String(rank || 'AGENT').toUpperCase(),
    rankLabel: (rank) => String(rank || 'Agent'),
    makeId: (prefix) => prefix + '-' + (++nextId),
    async publishNotifications(recipients, details) {
      const created = recipients.map((recipient) => {
        const row = {
          id: 'NTF-' + (++nextId), userId: recipient.id, type: details.type, title: details.title,
          message: details.message, priority: details.priority, status: 'SENT',
          sourceUserId: details.sourceUserId, sourceCode: people.find((person) => person.id === details.sourceUserId)?.publicCode || '',
          relatedId: details.relatedId, createdAt: new Date().toISOString(), readAt: null,
          metadata: { ...(details.metadata || {}) }
        };
        rows.unshift(row);
        return row;
      });
      return created;
    }
  };
  registerOfficialWarnings(socket, context);
  return {
    rows,
    setActor(value) { actor = value; },
    call(event, payload = {}) {
      const handler = handlers.get(event);
      assert.ok(handler, 'missing socket event: ' + event);
      return new Promise((resolve) => handler(payload, resolve));
    }
  };
}

const chief = { id: 'chief-1', rank: 'CIA CHIEF', publicCode: 'CHIEF-1', name: 'Chief', approved: true, serviceApproved: true, securityStatus: 'ACTIVE' };
const agent = { id: 'agent-1', rank: 'AGENT', publicCode: 'AG-1', name: 'Agent One', approved: true, serviceApproved: true, securityStatus: 'ACTIVE' };
const senior = { id: 'senior-1', rank: 'SUPREME COMMANDER', publicCode: 'SC-1', name: 'Senior', approved: true, serviceApproved: true, securityStatus: 'ACTIVE' };

test('only CIA CHIEF can list recipients and create an official warning', async () => {
  const h = makeHarness(agent, [chief, agent, senior]);
  const people = await h.call('official-warning:people:list');
  const created = await h.call('official-warning:create', { targetUserId: 'senior-1', warningType: 'أمني', content: 'رفض تنفيذ تعليمات القطاع.', allowJustification: true });
  assert.equal(people.ok, false);
  assert.equal(created.ok, false);
  assert.equal(h.rows.length, 0);
});

test('issued warnings persist for an offline recipient and can be loaded after a long absence', async () => {
  const h = makeHarness(chief, [chief, agent]);
  const people = await h.call('official-warning:people:list');
  assert.deepEqual(people.people.map((person) => person.id), ['agent-1']);
  const created = await h.call('official-warning:create', { targetUserId: 'agent-1', warningType: 'ميداني', content: 'تم تسجيل مخالفة بسبب عدم الالتزام بتعليمات القطاع أثناء تنفيذ المهمة.', allowJustification: true });
  assert.equal(created.ok, true);
  assert.equal(h.rows[0].userId, 'agent-1');
  assert.equal(h.rows[0].status, 'SENT');
  h.setActor(agent);
  const inbox = await h.call('official-warning:list', { limit: 50, offset: 0 });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.warnings.length, 1);
  assert.equal(inbox.warnings[0].content, 'تم تسجيل مخالفة بسبب عدم الالتزام بتعليمات القطاع أثناء تنفيذ المهمة.');
  assert.equal(inbox.warnings[0].allowJustification, true);
});

test('a prohibited justification is rejected server-side even if the client submits the socket event', async () => {
  const h = makeHarness(chief, [chief, agent]);
  const created = await h.call('official-warning:create', { targetUserId: 'agent-1', warningType: 'إداري', content: 'مخالفة إدارية موثقة.', allowJustification: false });
  h.setActor(agent);
  const rejected = await h.call('official-warning:respond', { warningId: created.warning.warningId, response: 'هذا الرد يجب رفضه.' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /منع التبرير/);
  assert.equal(h.rows.filter((row) => row.type === 'WARNING_RESPONSE').length, 0);
});

test('a permitted justification is saved for its issuing chief and cannot be duplicated', async () => {
  const h = makeHarness(chief, [chief, agent]);
  const created = await h.call('official-warning:create', { targetUserId: 'agent-1', warningType: 'سلوكي', content: 'تم توثيق مخالفة سلوكية.', allowJustification: true });
  h.setActor(agent);
  const response = await h.call('official-warning:respond', { warningId: created.warning.warningId, response: 'أوضح أنني اتبعت الإجراء المعتمد.' });
  assert.equal(response.ok, true);
  assert.equal(h.rows[0].type, 'WARNING_RESPONSE');
  assert.equal(h.rows[0].userId, 'chief-1');
  assert.equal(h.rows[0].metadata.responseText, 'أوضح أنني اتبعت الإجراء المعتمد.');
  const duplicate = await h.call('official-warning:respond', { warningId: created.warning.warningId, response: 'محاولة إرسال ثانية.' });
  assert.equal(duplicate.ok, false);
  h.setActor(chief);
  const responses = await h.call('official-warning:responses:list');
  assert.equal(responses.ok, true);
  assert.equal(responses.responses.length, 1);
});

test('another leadership rank cannot read the chief response inbox', async () => {
  const h = makeHarness(senior, [chief, agent, senior]);
  const result = await h.call('official-warning:responses:list');
  assert.equal(result.ok, false);
});
