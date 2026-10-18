'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const createSOSAlertSound = require('../sos-alert-sound');

function makeHarness(playAction = () => Promise.resolve()) {
  const listeners = new Map();
  const enableButton = { hidden: true };
  const audio = {
    src: '',
    preload: '',
    loop: false,
    volume: 0,
    currentTime: 0,
    muted: false,
    paused: true,
    playCalls: 0,
    pauseCalls: 0,
    play() {
      this.playCalls += 1;
      const result = playAction(this);
      if (result && typeof result.then === 'function') {
        return result.then((value) => {
          this.paused = false;
          return value;
        });
      }
      this.paused = false;
      return result;
    },
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    }
  };
  const environment = {
    Audio: function FakeAudio(src) {
      audio.src = src;
      return audio;
    },
    document: {
      getElementById(id) {
        return id === 'sos-audio-enable' ? enableButton : null;
      },
      addEventListener(name, handler, options) {
        listeners.set(name, { handler, options });
      }
    }
  };
  return {
    audio,
    enableButton,
    listeners,
    controller: createSOSAlertSound(environment)
  };
}

test('the alert audio loops and only stops for its active alert', async () => {
  const { audio, controller } = makeHarness();
  await controller.start('SOS-1');
  assert.equal(audio.src, '/sos-alert.mp3');
  assert.equal(audio.loop, true);
  assert.equal(audio.paused, false);
  assert.equal(controller.isActive(), true);

  assert.equal(controller.stop('SOS-2'), false);
  assert.equal(audio.paused, false);
  assert.equal(controller.stop('SOS-1'), true);
  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 0);
  assert.equal(controller.isActive(), false);
});

test('a browser autoplay block reveals a manual play control', async () => {
  let allowed = false;
  const { audio, enableButton, controller } = makeHarness(() => (
    allowed ? Promise.resolve() : Promise.reject(new Error('autoplay blocked'))
  ));

  await controller.start('SOS-3');
  assert.equal(enableButton.hidden, false);

  allowed = true;
  await controller.enable();
  assert.equal(audio.paused, false);
  assert.equal(enableButton.hidden, true);
});

test('a prior user gesture primes the alarm silently for later automatic playback', async () => {
  const { audio, listeners, controller } = makeHarness();
  assert.deepEqual([...listeners.keys()], ['pointerdown', 'touchstart', 'keydown']);
  assert.equal(listeners.get('pointerdown').options.once, true);

  await controller.prime();
  assert.equal(audio.playCalls, 1);
  assert.equal(audio.paused, true);
  assert.equal(audio.muted, false);
});

test('the SOS banner connects the looping sound to dismissal and terminal alert updates', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /SOSAlertSound\?\.start\(currentSOSBannerId\)/);
  assert.match(html, /SOSAlertSound\?\.stop\(currentSOSBannerId\)/);
  assert.match(html, /!sosIsActive\(alert\)\) dismissSOSBanner\(\)/);
  assert.match(html, /String\(data\.id\) === currentSOSBannerId\) dismissSOSBanner\(\)/);
});
