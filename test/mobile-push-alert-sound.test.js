'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createMobilePushAlertSound = require('../mobile-push-alert-sound');

test('critical push alarm requires a user gesture and only plays on the visible page', async () => {
  const documentListeners = new Map();
  const serviceWorkerListeners = new Map();
  const playStates = [];
  const audioInstances = [];
  class FakeAudio {
    constructor(source) {
      this.source = source;
      this.muted = false;
      this.paused = true;
      this.currentTime = 0;
      audioInstances.push(this);
    }
    play() {
      playStates.push(this.muted);
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
  }
  const document = {
    visibilityState: 'visible',
    addEventListener(name, handler) { documentListeners.set(name, handler); }
  };
  const navigator = {
    serviceWorker: {
      addEventListener(name, handler) { serviceWorkerListeners.set(name, handler); }
    }
  };
  createMobilePushAlertSound({
    Audio: FakeAudio,
    document,
    navigator,
    location: { origin: 'https://blackridge.example' }
  });

  const onMessage = serviceWorkerListeners.get('message');
  let reply;
  await onMessage({
    data: { type: 'blackridge:mobile-push-critical-alarm' },
    origin: 'https://blackridge.example',
    ports: [{ postMessage(value) { reply = value; } }]
  });
  assert.deepEqual(reply, { played: false });

  await documentListeners.get('pointerdown')();
  assert.equal(audioInstances[0].source, '/warning-alert.mp3');
  assert.equal(audioInstances[0].loop, false);
  assert.deepEqual(playStates, [true]);

  reply = undefined;
  await onMessage({
    data: { type: 'blackridge:mobile-push-critical-alarm' },
    origin: 'https://blackridge.example',
    ports: [{ postMessage(value) { reply = value; } }]
  });
  assert.deepEqual(reply, { played: true });
  assert.deepEqual(playStates, [true, false]);

  document.visibilityState = 'hidden';
  reply = undefined;
  await onMessage({
    data: { type: 'blackridge:mobile-push-critical-alarm' },
    origin: 'https://blackridge.example',
    ports: [{ postMessage(value) { reply = value; } }]
  });
  assert.deepEqual(reply, { played: false });
  assert.deepEqual(playStates, [true, false]);
});
