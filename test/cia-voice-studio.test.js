'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_AUDIO_BYTES,
  createCiaVoiceStudioService,
  injectCiaVoiceStudioMarkup,
  registerCiaVoiceStudioSocket
} = require('../cia-voice-studio');

const fixture = [
  '<!doctype html><html><head></head><body>',
  '<ul class="nav-list">',
  '      <li id="cia-cipher-hub-nav" class="nav-btn">شفرات الـCIA</li>',
  '    </ul>',
  '  <div class="content-area">',
  '    <div id="existing-view" class="view-pane">باقٍ كما هو</div>',
  '  </div>',
  '</body></html>'
].join('\n');

function okJson(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function okAudio(bytes = [1, 2, 3, 4]) {
  return new Response(Uint8Array.from(bytes), {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' }
  });
}

function baseEnv(extra = {}) {
  return {
    ELEVENLABS_API_KEY: 'unit-test-key',
    OPENAI_API_KEY: 'unit-test-openai-key',
    ELEVENLABS_VOICE_ID_OBSIDIAN: 'voice-not-a-real-person',
    ...extra
  };
}

test('injects one independent voice section and is idempotent', () => {
  const once = injectCiaVoiceStudioMarkup(fixture);
  assert.match(once, /id="cia-voice-studio-nav"/);
  assert.match(once, /id="cia-voice-studio-view"/);
  assert.match(once, /href="\/cia-voice-studio\.css"/);
  assert.match(once, /src="\/cia-voice-studio-client\.js"/);
  assert.match(once, /accept="audio\/\*"/);
  assert.match(once, /data-mode="translate"/);
  assert.equal(injectCiaVoiceStudioMarkup(once), once);
  assert.equal((once.match(/id="cia-voice-studio-nav"/g) || []).length, 1);
  assert.equal((once.match(/id="cia-voice-studio-view"/g) || []).length, 1);
  assert.match(once, /id="existing-view" class="view-pane">باقٍ كما هو/);
});

test('main server serves the new assets and registers only authenticated voice events', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /'\/cia-voice-studio\.css': 'cia-voice-studio\.css'/);
  assert.match(server, /'\/cia-voice-studio-client\.js': 'cia-voice-studio-client\.js'/);
  assert.match(server, /injectCiaVoiceStudioMarkup\(injectCiaCipherHubMarkup/);
  assert.match(server, /registerCiaVoiceStudioSocket\(socket,\s*\{\s*requireUser:\s*\(\)\s*=>\s*requireSocketUser\(socket\)/);
  assert.doesNotMatch(server, /express\.static\(__dirname\)/);
});

test('status reports configured presets without returning voice IDs or keys', () => {
  const service = createCiaVoiceStudioService({ env: baseEnv() });
  const status = service.getStatus();
  assert.equal(status.voiceReady, true);
  assert.equal(status.translationReady, true);
  assert.equal(status.presets.find((preset) => preset.id === 'obsidian').available, true);
  assert.equal(status.presets.find((preset) => preset.id === 'authority').available, false);
  assert.ok(status.presets.every((preset) => !Object.hasOwn(preset, 'voiceId')));
  assert.ok(!JSON.stringify(status).includes('unit-test-key'));
});

test('default service configuration safely reads the Node environment', () => {
  const service = createCiaVoiceStudioService();
  const status = service.getStatus();
  assert.equal(typeof status.voiceReady, 'boolean');
  assert.equal(typeof status.translationReady, 'boolean');
});

test('missing provider credentials disable voice features without throwing', () => {
  const service = createCiaVoiceStudioService({ env: {} });
  const status = service.getStatus();
  assert.equal(status.voiceReady, false);
  assert.equal(status.translationReady, false);
  assert.ok(status.presets.every((preset) => preset.available === false));
});

test('voice initialization failures stay isolated from Socket.IO connections', async () => {
  const handlers = {};
  const socket = { on: (event, handler) => { handlers[event] = handler; } };
  const brokenEnv = new Proxy({}, {
    get(_target, key) {
      if (key === 'CIA_VOICE_TRANSLATION_MODEL') throw new TypeError('test-only configuration read failure');
      return undefined;
    }
  });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.doesNotThrow(() => registerCiaVoiceStudioSocket(socket, {
      env: brokenEnv,
      requireUser: () => ({ id: 'member-init-failure' })
    }));
  } finally {
    console.warn = originalWarn;
  }

  assert.match(warnings[0], /system=voice-studio reason=configuration_type_error action=disabled/);
  assert.ok(!warnings[0].includes('test-only configuration read failure'));

  let status;
  handlers['cia-voice:status']({}, (value) => { status = value; });
  assert.equal(status.ok, true);
  assert.equal(status.voiceReady, false);
  assert.equal(status.translationReady, false);

  let response;
  await handlers['cia-voice:process']({ consent: true }, (value) => { response = value; });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'SERVICE_UNAVAILABLE');
});

test('voice mode calls real speech-to-speech with the selected original voice', async () => {
  const calls = [];
  const service = createCiaVoiceStudioService({
    env: baseEnv(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return okAudio();
    }
  });
  const result = await service.process({
    mode: 'voice',
    preset: 'obsidian',
    format: 'mp3',
    audio: Buffer.alloc(512, 7),
    mimeType: 'audio/webm;codecs=opus',
    intensity: 88,
    clarity: 91
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/speech-to-speech\/voice-not-a-real-person/);
  assert.match(calls[0].url, /output_format=mp3_44100_128/);
  assert.equal(calls[0].init.body.get('model_id'), 'eleven_multilingual_sts_v2');
  assert.equal(calls[0].init.body.get('remove_background_noise'), 'true');
  assert.equal(calls[0].init.body.get('audiofile').name, 'recording.webm');
  assert.equal(JSON.parse(calls[0].init.body.get('voice_settings')).speed, 0.84);
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(result.extension, 'mp3');
  assert.equal(result.transcript, '');
});

test('translation mode transcribes, translates, then speaks before returning both texts', async () => {
  const calls = [];
  const service = createCiaVoiceStudioService({
    env: baseEnv(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/speech-to-text')) return okJson({ text: 'افتحوا البوابة الآن', language_code: 'ar' });
      if (String(url).includes('/chat/completions')) return okJson({ choices: [{ message: { content: 'Open the gate now.' } }] });
      if (String(url).includes('/text-to-speech/')) return okAudio([9, 8, 7]);
      throw new Error('unexpected provider');
    }
  });
  const result = await service.process({
    mode: 'translate',
    preset: 'obsidian',
    format: 'wav',
    audio: Buffer.alloc(512, 3),
    mimeType: 'audio/webm',
    sourceLanguage: 'ar',
    targetLanguage: 'en'
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/v1\/speech-to-text$/);
  assert.equal(calls[0].init.body.get('model_id'), 'scribe_v2');
  assert.equal(calls[0].init.body.get('language_code'), 'ar');
  assert.match(calls[1].url, /\/v1\/chat\/completions$/);
  assert.equal(JSON.parse(calls[1].init.body).messages[1].content, 'افتحوا البوابة الآن');
  assert.match(calls[2].url, /\/v1\/text-to-speech\/voice-not-a-real-person/);
  assert.equal(JSON.parse(calls[2].init.body).text, 'Open the gate now.');
  assert.equal(result.transcript, 'افتحوا البوابة الآن');
  assert.equal(result.translation, 'Open the gate now.');
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(result.extension, 'wav');
});

test('rejects unsupported formats and oversize recordings before provider calls', async () => {
  let calls = 0;
  const service = createCiaVoiceStudioService({
    env: baseEnv(),
    fetchImpl: async () => { calls += 1; return okAudio(); }
  });
  await assert.rejects(service.process({
    mode: 'voice',
    preset: 'obsidian',
    audio: Buffer.alloc(512),
    mimeType: 'video/mp4'
  }), /صيغة الصوت غير مدعومة/);
  await assert.rejects(service.process({
    mode: 'voice',
    preset: 'obsidian',
    audio: Buffer.alloc(MAX_AUDIO_BYTES + 1),
    mimeType: 'audio/wav'
  }), /حجم الصوت يتجاوز الحد/);
  assert.equal(calls, 0);
});

test('socket handler requires a signed-in user and explicit provider consent', async () => {
  const handlers = {};
  let user = null;
  let processCalls = 0;
  const socket = { on: (event, handler) => { handlers[event] = handler; } };
  registerCiaVoiceStudioSocket(socket, {
    requireUser: () => user,
    service: {
      getStatus: () => ({ voiceReady: true, translationReady: true, presets: [] }),
      process: async () => {
        processCalls += 1;
        return { audio: Buffer.from([4, 5]), mimeType: 'audio/mpeg', extension: 'mp3', transcript: '', translation: '', sourceLanguage: '' };
      }
    }
  });
  let response;
  await handlers['cia-voice:process']({ consent: true }, (value) => { response = value; });
  assert.equal(response.code, 'AUTH_REQUIRED');
  user = { id: 'member-1' };
  await handlers['cia-voice:process']({ consent: false }, (value) => { response = value; });
  assert.equal(response.code, 'CONSENT_REQUIRED');
  assert.equal(processCalls, 0);
  await handlers['cia-voice:process']({ consent: true }, (value) => { response = value; });
  assert.equal(response.ok, true);
  assert.equal(response.audio.length, 2);
  assert.equal(processCalls, 1);
});

test('socket rate limit prevents repeated costly processing without saving recordings', async () => {
  const handlers = {};
  let calls = 0;
  const socket = { on: (event, handler) => { handlers[event] = handler; } };
  registerCiaVoiceStudioSocket(socket, {
    requireUser: () => ({ id: 'member-rate-limit' }),
    now: () => 1000,
    service: {
      getStatus: () => ({ voiceReady: true, translationReady: true, presets: [] }),
      process: async () => {
        calls += 1;
        return { audio: Buffer.from([1]), mimeType: 'audio/mpeg', extension: 'mp3', transcript: '', translation: '', sourceLanguage: '' };
      }
    }
  });
  const results = [];
  for (let index = 0; index < 7; index += 1) {
    await handlers['cia-voice:process']({ consent: true }, (response) => results.push(response));
  }
  assert.equal(calls, 6);
  assert.equal(results[6].code, 'RATE_LIMITED');
  assert.ok(!Object.hasOwn(results[0], 'recording'));
});
