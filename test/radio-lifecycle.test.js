'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const notificationsCss = fs.readFileSync(path.join(__dirname, '..', 'notifications.css'), 'utf8');

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

test('speaking notices wait for an active microphone track and reuse the notification toast stack', () => {
  const start = html.indexOf('async function startPTT(event)');
  const stop = html.indexOf('function stopPTT(event)', start);
  assert.ok(start >= 0 && stop > start, 'PTT lifecycle exists');
  const handler = html.slice(start, stop);
  const trackEnabled = handler.indexOf('track => { track.enabled = true; }');
  const radioReady = handler.indexOf("ciaSocket.emit('radio:ptt:ready'");
  assert.ok(trackEnabled >= 0 && radioReady > trackEnabled, 'server must be notified only after microphone audio is enabled');
  assert.match(handler, /radio:ptt:ready/);
  assert.match(html, /ciaSocket\.on\('radio:speaker', syncRadioSpeakerNotice\)/);
  assert.match(html, /notification-toast-stack/);
  assert.match(html, /radioSpeakingNotices\.has\(socketId\)/);
  assert.match(html, /removeRadioSpeakingNotice\(socketId\)/);
  assert.match(html, /RADIO_SPEAKER_NOTICE_CHANNELS = new Set\(\['CH-1', 'TAC-1'\]\)/);
  const noticeStart = html.indexOf('function syncRadioSpeakerNotice(data)');
  const noticeEnd = html.indexOf('    let bootstrapMode', noticeStart);
  assert.ok(noticeStart >= 0 && noticeEnd > noticeStart, 'speaking notice handler exists');
  const noticeHandler = html.slice(noticeStart, noticeEnd);
  assert.doesNotMatch(noticeHandler, /data\.channel !== radioChannel|!radioPoweredOn/);
  assert.ok(noticeHandler.includes('الكود العسكري ${userCode} يتحدث الآن على موجة ${data.channel}'));
  assert.ok(notificationsCss.includes('.notification-toast.radio-speaking-toast'));
});

test('server gates ephemeral speaking notices and encrypted-wave state by channel authorization', () => {
  assert.match(server, /socket\.on\('radio:ptt:ready'/);
  assert.match(server, /emitRadioSpeakerState\(channel, speaker, true\)/);
  assert.match(server, /if \(!\['CH-1', 'TAC-1'\]\.includes\(channel\)\) return/);
  assert.match(server, /radioSocketCanReceiveState\(socketId, channel\)/);
  const noticeGateStart = server.indexOf('function radioSocketCanReceiveSpeakerNotice(socketId, channel)');
  const noticeGateEnd = server.indexOf('\n}', noticeGateStart) + 2;
  assert.ok(noticeGateStart >= 0 && noticeGateEnd > noticeGateStart, 'speaker notice authorization gate exists');
  const noticeGate = server.slice(noticeGateStart, noticeGateEnd);
  assert.match(noticeGate, /activeService === true/);
  assert.doesNotMatch(noticeGate, /radioSocketIsEligible|radioSocketCanReceiveState/);
  assert.match(server, /for \(const socketIds of sessions\.values\(\)\)/);
  assert.match(server, /channel === 'CH-3' \|\| !RADIO_MAIN_CHANNEL_IDS\.has\(channel\)/);
  assert.match(server, /if \(channel === 'CH-3' && !isLeadership\(actor\)\)/);
  assert.match(server, /!isCustomRadioChannel\(channel\) \|\| radioCustomChannelAllows\(channel, user\.id\)/);
});

test('radio power explains the active-duty gate without bypassing it', () => {
  assert.match(html, /if \(currentUser\.activeService !== true\) return alert\('يجب بدء المناوبة قبل تشغيل الراديو\.'\);/);
});

test('full-duplex PTT keeps the peer connection and receive path when one microphone releases', () => {
  assert.match(html, /pc\.addTransceiver\('audio', \{ direction: 'sendrecv' \}\)/);
  assert.match(html, /async function getRadioVoiceAudioTransceiver\(peer\)/);
  assert.match(html, /candidate\.mid !== null/);
  assert.match(html, /transceiver\.direction = 'sendrecv'/);
  assert.match(html, /transceiver\.currentDirection !== 'sendrecv'/);
  assert.match(html, /await attachRadioVoiceLocalAudio\(peer\)/);
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

test('custom radio entry stays outside the main-channel list and preserves the existing radio controls', () => {
  assert.match(html, /id="radio-custom-channel-input"[^>]*maxlength="43"/);
  assert.match(html, /onclick="joinCustomRadioChannel\(\)"/);
  assert.match(html, /function joinCustomRadioChannel\(\)/);
  assert.match(html, /function normalizeCustomRadioLabel\(value\)/);
  assert.match(html, /isValidCustomRadioChannelKey\(saved\.channel\)/);
  for (const channel of ['CH-1', 'TAC-1', 'CH-3']) {
    assert.match(html, new RegExp(`data-channel="${channel}"`));
  }
  assert.match(html, /هذه موجة افتراضية داخل الموقع وليست تردداً فعلياً/);
});

test('private radio membership and leadership roster are enforced on the server', () => {
  const subscribeStart = server.indexOf("socket.on('radio:admin:subscribe'");
  const subscribeEnd = server.indexOf("socket.on('radio:admin:unsubscribe'", subscribeStart);
  assert.ok(subscribeStart >= 0 && subscribeEnd > subscribeStart, 'radio admin subscription handler exists');
  const subscribeHandler = server.slice(subscribeStart, subscribeEnd);
  assert.match(subscribeHandler, /requireSocketUser\(socket\)/);
  assert.match(subscribeHandler, /if \(!isChief\(actor\)\)/);
  assert.match(subscribeHandler, /radioAdminChannelList\(\)/);
  assert.match(server, /targetSocket\.radioAdminSubscribed === true && isChief\(viewer\)/);
  assert.match(server, /canSeeRadioChannel \? \(user\.radioChannel \|\| 'CH-1'\) : null/);
  assert.match(server, /canSeeRadioChannel && !!user\.radioOnline/);
  assert.match(server, /radioSocketIsEligible\(socketId, channel\)/);
  assert.match(html, /data-radio-access-mode/);
  assert.match(html, /data-radio-add-user/);
  assert.match(html, /data-radio-remove-user/);
  assert.match(html, /radio:access-revoked/);
  assert.match(server, /socket\.on\('radio:admin:set-access-mode'/);
  assert.match(server, /socket\.on\('radio:admin:update-allowlist'/);
  assert.match(server, /accessMode: 'open', allowedUserIds: \[\]/);
  assert.match(server, /radioCustomChannelAllows\(channel, actor\.id\)/);
});
