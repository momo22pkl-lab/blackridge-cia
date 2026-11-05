'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectUserTextValues,
  getSocketTextInputs,
  installSocketModerationBoundary,
  isMutatingSocketEvent
} = require('../moderation-boundaries');
const { inspectMessage } = require('../security-moderation');

test('central socket policy covers direct writes and the old shared-data save paths', () => {
  assert.deepEqual(getSocketTextInputs('radio:message', { message: 'Please send the report.' }), ['Please send the report.']);
  assert.deepEqual(getSocketTextInputs('chat:global', { text: 'A clean update.' }), ['A clean update.']);
  assert.deepEqual(getSocketTextInputs('ibp:report:create', { title: 'Sector review', text: 'A clean report.' }), ['Sector review', 'A clean report.']);
  assert.deepEqual(
    getSocketTextInputs('shared:data:set', {
      key: 'cia_chats',
      value: { global: [{ senderCode: 'AG-10', text: 'A saved direct message.' }] }
    }),
    ['A saved direct message.']
  );
  assert.deepEqual(
    getSocketTextInputs('shared:data:seed', {
      cia_chats: { global: [{ text: 'Seeded chat content.' }] },
      cia_reports: [{ title: 'Seeded report', body: 'Report body.' }],
      systemConfig: { securityBlockedTerms: ['not content to re-check'] }
    }),
    ['Seeded chat content.', 'Seeded report', 'Report body.']
  );
  assert.deepEqual(getSocketTextInputs('security:manageBlockedTerm', { term: 'admin-managed rule' }), []);
});

test('future write-style socket events use the central fallback without swallowing control fields', () => {
  assert.equal(isMutatingSocketEvent('future:content:updateStatus'), true);
  assert.deepEqual(
    getSocketTextInputs('future:content:create', {
      title: 'A future clean title',
      body: 'A future clean body',
      id: 'not user content',
      password: 'not user content'
    }),
    ['A future clean title', 'A future clean body']
  );
  assert.equal(isMutatingSocketEvent('future:content:list'), false);
  assert.throws(
    () => collectUserTextValues(['first field', 'unscanned hidden field'], { maxValues: 1 }),
    (error) => error.code === 'TEXT_MODERATION_SCAN_LIMIT'
  );
});

test('socket middleware blocks direct abusive sends, accepts clean text, and emits a warning without an ack', async () => {
  let packetMiddleware;
  const emitted = [];
  let actorRead = false;
  const socket = {
    use(handler) { packetMiddleware = handler; },
    emit(...args) { emitted.push(args); }
  };
  installSocketModerationBoundary(socket, {
    getActor: () => { actorRead = true; return { id: 'member-1' }; },
    moderateOutgoingText: async (_actor, text) => inspectMessage(text) || false
  });

  const blocked = await new Promise((resolve) => {
    packetMiddleware(['radio:message', { text: 'That is shit.' }, resolve], () => resolve({ passed: true }));
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /منع/);
  assert.equal(actorRead, true);

  const clean = await new Promise((resolve) => {
    packetMiddleware(['chat:private', { text: 'Please review the report when you can.' }, () => {}], () => resolve({ passed: true }));
  });
  assert.deepEqual(clean, { passed: true });

  await new Promise((resolve) => {
    packetMiddleware(['chat:global', { text: 'That is shit.' }], () => resolve());
    setImmediate(resolve);
  });
  assert.equal(emitted.some(([event]) => event === 'security:moderation:blocked'), true);
});
