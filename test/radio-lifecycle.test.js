'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('PTT is bound to touch-friendly pointer release, cancellation, focus loss, and keyboard release', () => {
  const button = html.match(/<button[^>]*class="ptt-btn"[^>]*>/);
  assert.ok(button, 'PTT button exists');
  for (const event of ['onpointerdown="startPTT(event)"', 'onpointerup="stopPTT(event)"', 'onpointercancel="stopPTT(event)"', 'onlostpointercapture="stopPTT(event)"']) {
    assert.ok(button[0].includes(event), `PTT button must handle ${event}`);
  }
  assert.match(button[0], /onkeydown="[^"]*event\.repeat[^"]*startPTT\(event\)/);
  assert.match(button[0], /onkeyup="[^"]*stopPTT\(event\)/);
  assert.match(html, /window\.addEventListener\('blur', stopPTT\)/);
  assert.match(html, /window\.addEventListener\('pointerup', handleRadioGlobalPointerUp, true\)/);
  assert.match(html, /\.ptt-btn[\s\S]*?touch-action:\s*none/);
});

test('radio lifecycle restores a saved device preference and cleans/rejoins a socket once', () => {
  for (const event of ["addEventListener('pagehide', handleRadioPageHide)", "addEventListener('pageshow', handleRadioPageShow)", "addEventListener('online', handleRadioOnline)", "addEventListener('offline', handleRadioOffline)", "addEventListener('visibilitychange', handleRadioVisibilityChange)"]) {
    assert.ok(html.includes(event), `radio lifecycle must listen for ${event}`);
  }
  assert.match(html, /localStorage\.setItem\(RADIO_PREFERENCE_PREFIX/);
  assert.match(html, /loadRadioPreference\(currentUser\.id\)/);
  assert.match(html, /if \(ciaSocket && ciaSocket\.connected\) ciaSocket\.disconnect\(\)/);
  assert.match(html, /radioLifecycleConnectPending/);
  assert.match(html, /ciaSocket\.on\('radio:service-ended'/);
  assert.match(server, /targetSocket\.emit\('radio:service-ended'/);
});

test('full-duplex PTT keeps the peer connection and receive path when one microphone releases', () => {
  assert.match(html, /pc\.addTransceiver\('audio', \{ direction: 'sendrecv' \}\)/);
  assert.match(html, /peer\.localAudioSender\.replaceTrack\(track\)/);
  assert.match(html, /sender\.replaceTrack\(null\)/);
  assert.match(html, /polite: String\(ciaSocket\.id\)\.localeCompare\(key\) > 0/);
  assert.match(html, /setLocalDescription\(\{ type: 'rollback' \}\)/);

  const stopStart = html.indexOf('function stopPTT(event)');
  const stopEnd = html.indexOf('function sendRadioText()', stopStart);
  assert.ok(stopStart >= 0 && stopEnd > stopStart, 'PTT release handler exists');
  const stopHandler = html.slice(stopStart, stopEnd);
  assert.match(stopHandler, /detachRadioLocalAudio\(\)/);
  assert.doesNotMatch(stopHandler, /closeAllRadioVoicePeers\(\)/);

  const stateHandler = html.slice(html.indexOf("ciaSocket.on('radio:state'"), html.indexOf("ciaSocket.on('radio:voice:signal'"));
  assert.doesNotMatch(stateHandler, /closeRadioVoicePeer\(data\.socketId\)/);
});

test('duty UI only enables radio service after the server confirms active duty', () => {
  const startStart = html.indexOf('function startDuty()');
  const startEnd = html.indexOf('function endDuty()', startStart);
  assert.ok(startStart >= 0 && startEnd > startStart, 'duty-start handler exists');
  const startHandler = html.slice(startStart, startEnd);
  assert.match(startHandler, /r\.user\.activeService !== true/);
  assert.doesNotMatch(startHandler, /r\.user \|\| \{\.\.\.currentUser,\s*activeService:\s*true/);
});

test('remote audio starts at unity volume without changing system volume or applying a gain boost', () => {
  assert.match(html, /let radioVolume = 100/);
  assert.match(html, /audio\.volume = radioVolume \/ 100/);
  assert.match(html, /radioVolume = Math\.min\(100,/);
  assert.match(html, /getUserMedia\(\{[\s\S]*?echoCancellation: \{ ideal: true \}[\s\S]*?noiseSuppression: \{ ideal: true \}[\s\S]*?autoGainControl: \{ ideal: true \}/);
  assert.match(html, /track\.getSettings\(\)/);
  assert.match(html, /track\.enabled = false/);
  assert.match(html, /track => \{ track\.enabled = true; \}/);
  assert.match(html, /RadioAudioHealth\.summarize/);
  assert.doesNotMatch(html, /audio\.volume\s*=\s*(?:[1-9]\d{2,}|\d+\.\d{2,})/);
});
