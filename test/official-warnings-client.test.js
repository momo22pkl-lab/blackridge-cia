'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clientSource = fs.readFileSync(path.join(__dirname, '..', 'official-warnings-client.js'), 'utf8');

function makeNode(id = '') {
  const classes = new Set();
  return {
    id,
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    className: '',
    style: {},
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    addEventListener() {},
    setAttribute() {},
    appendChild() {},
    replaceChildren() {},
    focus() {}
  };
}

function bootClient(initialSession) {
  const elements = new Map();
  const listeners = new Map();
  let currentSession = initialSession;
  let warningListRequests = 0;
  const audio = {
    currentTime: 0,
    muted: false,
    playCalls: 0,
    play() { this.playCalls += 1; return Promise.resolve(); },
    pause() {}
  };
  const body = makeNode('body');
  body.appendChild = (node) => { if (node.id) elements.set(node.id, node); };
  const document = {
    body,
    getElementById(id) { return elements.get(id) || null; },
    createElement() {
      const node = makeNode();
      Object.defineProperty(node, 'innerHTML', {
        set(markup) {
          for (const match of markup.matchAll(/id="([^"]+)"/g)) elements.set(match[1], makeNode(match[1]));
        }
      });
      return node;
    }
  };
  const connection = {
    connected: true,
    on(event, handler) { listeners.set(event, handler); },
    emit(event, _payload, callback) {
      if (event !== 'official-warning:list') return;
      warningListRequests += 1;
      callback({
        ok: true,
        warnings: [{
          id: 'notification-1', warningId: 'WRN-1', warningType: 'أمني',
          content: 'اختبار تحذير معلّق', allowJustification: false,
          createdAt: '2026-11-12T00:00:00.000Z', readAt: null
        }]
      });
    }
  };
  const window = {
    blackRidgeSocket: connection,
    blackRidgeGetNotificationSession() { return currentSession; },
    addEventListener() {},
    setInterval() {}
  };
  class FakeAudio { constructor() { return audio; } }

  vm.runInNewContext(clientSource, { window, document, Audio: FakeAudio, FormData: class {} }, { filename: 'official-warnings-client.js' });
  return {
    elements,
    listeners,
    audio,
    setSession(value) { currentSession = value; },
    getWarningListRequests() { return warningListRequests; }
  };
}

const returningUser = { authenticated: true, user: { id: 'agent-1', rank: 'AGENT' } };

function assertWarningDisplayedAndSoundAttempted(client) {
  assert.equal(client.getWarningListRequests(), 1);
  const overlay = client.elements.get('ow-warning-overlay');
  assert.ok(overlay);
  assert.equal(overlay.classList.contains('is-open'), true);
  assert.equal(client.elements.get('ow-warning-content').textContent, 'اختبار تحذير معلّق');
  assert.equal(client.audio.playCalls, 1);
}

test('loads and displays a pending warning when a returning user opens the site', () => {
  const client = bootClient(returningUser);
  assertWarningDisplayedAndSoundAttempted(client);
});

test('loads and displays a pending warning after login on an already-open site', () => {
  const client = bootClient(null);
  assert.equal(client.getWarningListRequests(), 0);
  client.setSession(returningUser);
  const onLogin = client.listeners.get('auth:login:result');
  assert.equal(typeof onLogin, 'function');
  onLogin({ ok: true });
  assertWarningDisplayedAndSoundAttempted(client);
});
