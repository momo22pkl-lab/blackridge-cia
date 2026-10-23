'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canHandleSignalWithoutPeer, createEarlyCandidateBuffer } = require('../radio-signal-policy');

test('accepts server-validated trickle ICE before the talker state or offer arrives', () => {
  assert.equal(canHandleSignalWithoutPeer('ice'), true);
});

test('permits a server-validated offer to create the receiving peer', () => {
  assert.equal(canHandleSignalWithoutPeer('offer'), true);
});

test('does not let an answer create an unknown peer', () => {
  assert.equal(canHandleSignalWithoutPeer('answer'), false);
  assert.equal(canHandleSignalWithoutPeer('unknown'), false);
});

test('buffers early ICE in order and bounds candidates per sender', () => {
  const buffer = createEarlyCandidateBuffer(2);
  buffer.enqueue('speaker', { candidate: 'one' });
  buffer.enqueue('speaker', { candidate: 'two' });
  buffer.enqueue('speaker', { candidate: 'three' });
  buffer.enqueue('other', { candidate: 'separate-peer' });

  assert.deepEqual(buffer.drain('speaker'), [{ candidate: 'two' }, { candidate: 'three' }]);
  assert.deepEqual(buffer.drain('speaker'), []);
  assert.deepEqual(buffer.drain('other'), [{ candidate: 'separate-peer' }]);
  assert.deepEqual(buffer.drain('unknown'), []);
});

test('clears early candidates when the radio leaves or changes channels', () => {
  const buffer = createEarlyCandidateBuffer();
  buffer.enqueue('speaker', { candidate: 'pending' });
  buffer.clear();
  assert.deepEqual(buffer.drain('speaker'), []);
});

test('the radio page loads and uses the shared signal policy', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const policyScript = html.indexOf('<script src="/radio-signal-policy.js"></script>');
  const radioSignalHandler = html.indexOf('async function handleRadioVoiceSignal(data)');
  assert.ok(policyScript >= 0 && policyScript < radioSignalHandler, 'policy must load before the radio signal handler');
  assert.ok(html.includes('policy.canHandleSignalWithoutPeer(data.type)'), 'radio handler must use the tested policy');
  assert.ok(html.includes('radioEarlyVoiceCandidates.drain(peerId)'), 'the offer must drain candidates queued before peer creation');
});
