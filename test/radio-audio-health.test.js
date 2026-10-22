'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createState, summarize } = require('../radio-audio-health');

function stats(type, bytes, audioLevel) {
  return new Map([[
    'audio',
    {
      type,
      kind: 'audio',
      bytesReceived: type === 'inbound-rtp' ? bytes : undefined,
      bytesSent: type === 'outbound-rtp' ? bytes : undefined,
      audioLevel
    }
  ]]);
}

test('distinguishes an active media stream from a stream with no new RTP bytes', () => {
  const state = createState();
  assert.equal(summarize(stats('inbound-rtp', 1200, 0.18), 'inbound', state).status, 'active');
  assert.equal(summarize(stats('inbound-rtp', 1200, 0), 'inbound', state).status, 'waiting');
  assert.equal(summarize(stats('inbound-rtp', 1200, 0), 'inbound', state).status, 'no-media');
});

test('reports persistently low audio level separately from a complete media gap', () => {
  const state = createState();
  summarize(stats('inbound-rtp', 100, 0.005), 'inbound', state);
  summarize(stats('inbound-rtp', 200, 0.005), 'inbound', state);
  assert.equal(summarize(stats('inbound-rtp', 300, 0.005), 'inbound', state).status, 'low-level');
});

test('supports outbound audio counters and browsers without audioLevel statistics', () => {
  const state = createState();
  assert.equal(summarize(stats('outbound-rtp', 200, undefined), 'outbound', state).status, 'active');
  assert.equal(summarize(stats('outbound-rtp', 400, undefined), 'outbound', state).audioLevel, null);
});

test('the page loads the tested audio-health helper before its inline radio code', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const helper = html.indexOf('<script src="/radio-audio-health.js"></script>');
  const inlinePageScript = html.indexOf('<script>', html.indexOf('<script src="/radio-signal-policy.js"></script>'));
  assert.ok(helper >= 0 && helper < inlinePageScript, 'audio health helper must load before the inline client');
  assert.ok(html.includes('RadioAudioHealth.summarize'), 'radio stats monitoring must use the tested helper');
});
