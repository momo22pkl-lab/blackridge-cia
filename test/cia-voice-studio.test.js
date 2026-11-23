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

function mp3Bytes() {
  const bytes = Buffer.alloc(512, 0);
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  return bytes;
}

function wavBytes() {
  const bytes = Buffer.alloc(256, 0);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(22050, 24);
  bytes.writeUInt32LE(44100, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

function okAudio(bytes = mp3Bytes()) {
  const payload = Buffer.from(bytes);
  const mimeType = payload.toString('ascii', 0, 4) === 'RIFF' ? 'audio/wav' : 'audio/mpeg';
  return new Response(payload, {
    status: 200,
    headers: { 'Content-Type': mimeType }
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
  assert.match(once, /data-mode="text"/);
  assert.match(once, /id="cvs-script-generate"/);
  assert.match(once, /id="cvs-script-text"/);
  assert.match(once, /id="cvs-voice-preview-list"/);
  assert.equal(injectCiaVoiceStudioMarkup(once), once);
  assert.equal((once.match(/id="cia-voice-studio-nav"/g) || []).length, 1);
  assert.equal((once.match(/id="cia-voice-studio-view"/g) || []).length, 1);
  assert.match(once, /id="existing-view" class="view-pane">باقٍ كما هو/);
});

test('main server serves the new assets and registers only authenticated voice events', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'cia-voice-studio-client.js'), 'utf8');
  assert.match(server, /'\/cia-voice-studio\.css': 'cia-voice-studio\.css'/);
  assert.match(server, /'\/cia-voice-studio-client\.js': 'cia-voice-studio-client\.js'/);
  assert.match(server, /injectCiaVoiceStudioMarkup\(injectCiaCipherHubMarkup/);
  assert.match(server, /registerCiaVoiceStudioSocket\(socket,\s*\{\s*requireUser:\s*\(\)\s*=>\s*requireSocketUser\(socket\)/);
  assert.doesNotMatch(server, /express\.static\(__dirname\)/);
  assert.match(client, /cia-voice:generate-script/);
  assert.match(client, /cia-voice:preview/);
  assert.match(client, /mode: requestMode/);
  assert.match(client, /URL\.revokeObjectURL/);
});

test('status reports configured presets without returning voice IDs or keys', () => {
  const service = createCiaVoiceStudioService({ env: baseEnv() });
  const status = service.getStatus();
  assert.equal(status.voiceReady, true);
  assert.equal(status.translationReady, true);
  assert.equal(status.scriptReady, true);
  assert.equal(status.presets.find((preset) => preset.id === 'obsidian').available, true);
  assert.ok(status.presets.find((preset) => preset.id === 'obsidian').description);
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
  assert.equal(status.scriptReady, false);
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

test('voice mode calls the ElevenLabs voice-changer endpoint with the selected voice and audio field', async () => {
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
  assert.match(calls[0].url, /\/v1\/voice-changer\/voice-not-a-real-person/);
  assert.match(calls[0].url, /output_format=mp3_44100_128/);
  assert.equal(calls[0].init.body.get('model_id'), 'eleven_multilingual_sts_v2');
  assert.equal(calls[0].init.body.get('remove_background_noise'), 'true');
  assert.equal(calls[0].init.body.get('audio').name, 'recording.webm');
  assert.equal(calls[0].init.body.get('audiofile'), null);
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
      if (String(url).includes('/text-to-speech/')) return okAudio(wavBytes());
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

test('text mode generates valid MP3 and WAV through text-to-speech only', async () => {
  for (const [format, expectedMime, expectedProviderFormat, bytes] of [
    ['mp3', 'audio/mpeg', 'mp3_44100_128', mp3Bytes()],
    ['wav', 'audio/wav', 'wav_22050', wavBytes()]
  ]) {
    const calls = [];
    const service = createCiaVoiceStudioService({
      env: baseEnv(),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return okAudio(bytes);
      }
    });
    const result = await service.process({
      mode: 'text',
      text: 'هذه مسودة قابلة للتعديل.',
      preset: 'obsidian',
      modelId: 'untrusted-client-model',
      format,
      intensity: 88,
      clarity: 91,
      depth: 64
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/text-to-speech\/voice-not-a-real-person/);
    assert.equal(new URL(calls[0].url).searchParams.get('output_format'), expectedProviderFormat);
    assert.equal(JSON.parse(calls[0].init.body).text, 'هذه مسودة قابلة للتعديل.');
    assert.equal(JSON.parse(calls[0].init.body).model_id, 'eleven_multilingual_v2');
    assert.doesNotMatch(calls[0].url, /speech-to-speech/);
    assert.equal(result.mimeType, expectedMime);
    assert.equal(result.extension, format);
    assert.deepEqual(result.audio, bytes);
    if (format === 'wav') {
      assert.equal(result.audio.toString('ascii', 0, 4), 'RIFF');
      assert.equal(result.audio.toString('ascii', 8, 12), 'WAVE');
    } else {
      assert.equal(result.audio[0], 0xff);
      assert.equal(result.audio[1], 0xfb);
    }
  }
});

test('text mode rejects empty or oversized text and invalid audio output before returning a result', async () => {
  let calls = 0;
  const service = createCiaVoiceStudioService({
    env: baseEnv(),
    fetchImpl: async () => { calls += 1; return okAudio(); }
  });
  await assert.rejects(service.process({ mode: 'text', text: '   ', preset: 'obsidian' }), /أدخل النص/);
  await assert.rejects(service.process({ mode: 'text', text: 'x'.repeat(12001), preset: 'obsidian' }), /12000 حرف/);
  assert.equal(calls, 0);
  const invalidAudioService = createCiaVoiceStudioService({
    env: baseEnv(),
    fetchImpl: async () => new Response(Buffer.alloc(512, 1), { status: 200 })
  });
  await assert.rejects(invalidAudioService.process({
    mode: 'text', text: 'نص صالح', preset: 'obsidian', format: 'mp3'
  }), /لا يطابق صيغة النتيجة/);
});

test('script generator returns an editable draft and edited text is sent only to TTS', async () => {
  const calls = [];
  const service = createCiaVoiceStudioService({
    env: baseEnv(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/chat/completions')) {
        return okJson({ choices: [{ message: { content: 'مسودة أولية للمراجعة.' } }] });
      }
      return okAudio(mp3Bytes());
    }
  });
  const draft = await service.generateScript({
    type: 'radio_call',
    language: 'ar',
    tone: 'calm',
    lengthSeconds: 15,
    notes: 'اذكر نقطة التجمع.'
  });
  assert.equal(draft.text, 'مسودة أولية للمراجعة.');
  assert.equal(calls.length, 1);
  const generatedPayload = JSON.parse(calls[0].init.body);
  assert.equal(generatedPayload.model, 'gpt-4o-mini');
  assert.match(generatedPayload.messages[1].content, /نداء لاسلكي/);
  assert.match(generatedPayload.messages[1].content, /15 seconds/);
  assert.match(generatedPayload.messages[1].content, /اذكر نقطة التجمع/);

  const editedText = 'النص بعد مراجعة المستخدم.';
  await service.process({
    mode: 'text',
    text: editedText,
    preset: 'obsidian',
    format: 'mp3'
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/v1\/text-to-speech\//);
  assert.equal(JSON.parse(calls[1].init.body).text, editedText);
  assert.doesNotMatch(calls[1].url, /speech-to-speech/);
});

test('script generation rejects unsupported inputs and unavailable OpenAI configuration', async () => {
  let calls = 0;
  const service = createCiaVoiceStudioService({
    env: baseEnv(),
    fetchImpl: async () => { calls += 1; return okJson({ choices: [{ message: { content: 'مسودة.' } }] }); }
  });
  const valid = { type: 'mission_brief', language: 'ar', tone: 'formal', lengthSeconds: 30 };
  await assert.rejects(service.generateScript({ ...valid, type: 'unknown' }), /نوع النص غير مدعوم/);
  await assert.rejects(service.generateScript({ ...valid, language: 'de' }), /لغة النص غير مدعومة/);
  await assert.rejects(service.generateScript({ ...valid, tone: 'angry' }), /نبرة النص غير مدعومة/);
  await assert.rejects(service.generateScript({ ...valid, lengthSeconds: 90 }), /15 أو 30 أو 60/);
  await assert.rejects(service.generateScript({ ...valid, notes: 'x'.repeat(501) }), /500 حرف/);
  assert.equal(calls, 0);

  const unavailable = createCiaVoiceStudioService({ env: {}, fetchImpl: async () => { calls += 1; } });
  assert.equal(unavailable.getStatus().scriptReady, false);
  await assert.rejects(unavailable.generateScript(valid), /مولّد النصوص غير مهيأ/);
  assert.equal(calls, 0);
});

test('voice preview uses only a configured provider sample and never fabricates one', async () => {
  const calls = [];
  const service = createCiaVoiceStudioService({
    env: baseEnv(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/v1/voices/')) {
        return okJson({ preview_url: 'https://storage.googleapis.com/eleven-public-prod/preview.mp3' });
      }
      return okAudio(mp3Bytes());
    }
  });
  const preview = await service.getVoicePreview('obsidian');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers['xi-api-key'], 'unit-test-key');
  assert.equal(calls[1].init.headers, undefined);
  assert.equal(preview.available, true);
  assert.equal(preview.mimeType, 'audio/mpeg');
  assert.equal(preview.extension, 'mp3');
  assert.ok(Buffer.isBuffer(preview.audio));
  assert.ok(!JSON.stringify({ ...preview, audio: undefined }).includes('voice-not-a-real-person'));

  const noSampleCalls = [];
  const noSampleService = createCiaVoiceStudioService({
    env: baseEnv(),
    fetchImpl: async (url) => {
      noSampleCalls.push(String(url));
      return okJson({});
    }
  });
  const noSample = await noSampleService.getVoicePreview('obsidian');
  assert.deepEqual(noSample, { available: false });
  assert.equal(noSampleCalls.length, 1);
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
  let scriptCalls = 0;
  const socket = { on: (event, handler) => { handlers[event] = handler; } };
  registerCiaVoiceStudioSocket(socket, {
    requireUser: () => user,
    service: {
      getStatus: () => ({ voiceReady: true, translationReady: true, presets: [] }),
      generateScript: async () => {
        scriptCalls += 1;
        return { text: 'مسودة.' };
      },
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
  await handlers['cia-voice:generate-script']({ consent: false }, (value) => { response = value; });
  assert.equal(response.code, 'CONSENT_REQUIRED');
  assert.equal(scriptCalls, 0);
  await handlers['cia-voice:process']({ consent: true }, (value) => { response = value; });
  assert.equal(response.ok, true);
  assert.equal(response.audio.length, 2);
  assert.equal(processCalls, 1);
});

test('script socket rejects missing login and missing OpenAI setup without a provider call', async () => {
  const handlers = {};
  let user = null;
  let calls = 0;
  const socket = { on: (event, handler) => { handlers[event] = handler; } };
  registerCiaVoiceStudioSocket(socket, {
    env: {},
    fetchImpl: async () => { calls += 1; return okJson({}); },
    requireUser: () => user
  });
  const payload = {
    type: 'mission_brief',
    language: 'ar',
    tone: 'formal',
    lengthSeconds: 30,
    consent: true
  };
  let response;
  await handlers['cia-voice:generate-script'](payload, (value) => { response = value; });
  assert.equal(response.code, 'AUTH_REQUIRED');
  user = { id: 'member-script-setup' };
  await handlers['cia-voice:generate-script'](payload, (value) => { response = value; });
  assert.equal(response.code, 'SCRIPT_UNAVAILABLE');
  assert.equal(response.ok, false);
  assert.equal(calls, 0);
});

test('text-mode controls work and temporary result URLs are revoked on deletion and exit', () => {
  const elements = new Map();
  const observers = [];
  const listeners = {};
  const makeElement = (id) => {
    const classes = new Set();
    const childLabel = { textContent: '' };
    return {
      id,
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      dataset: {},
      options: [],
      selectedOptions: [],
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      addEventListener() {},
      pause() {},
      removeAttribute(name) { delete this[name]; },
      load() {},
      querySelector(selector) { return selector === 'span' ? childLabel : null; },
      querySelectorAll() { return []; }
    };
  };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; }
  };
  const pane = document.getElementById('cia-voice-studio-view');
  const grid = document.getElementById('cvs-grid');
  pane.querySelector = (selector) => selector === '.cvs-grid' ? grid : null;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let objectId = 0;
  const revoked = [];
  URL.createObjectURL = () => 'blob:test-' + (++objectId);
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    class FakeMutationObserver {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
    }
    const root = {
      document,
      MutationObserver: FakeMutationObserver,
      addEventListener(name, callback) { listeners[name] = callback; },
      showPane() { return true; }
    };
    const client = require('../cia-voice-studio-client.js').createCiaVoiceStudioClient(root);
    assert.equal(client.initialize(), true);
    client.selectMode('text');
    assert.equal(document.getElementById('cvs-record-card').hidden, true);
    assert.equal(document.getElementById('cvs-text-card').hidden, false);
    assert.equal(document.getElementById('cvs-process').querySelector('span').textContent, 'تحويل النص إلى صوت');

    client.showResult({ audio: Buffer.from([0xff, 0xfb, 0, 0]), mimeType: 'audio/mpeg', extension: 'mp3' }, 'text');
    const deletedUrl = document.getElementById('cvs-result-player').src;
    client.clearAll();
    assert.ok(revoked.includes(deletedUrl));
    assert.equal(document.getElementById('cvs-result-card').hidden, true);

    client.showResult({ audio: Buffer.from([0xff, 0xfb, 0, 0]), mimeType: 'audio/mpeg', extension: 'mp3' }, 'text');
    const exitUrl = document.getElementById('cvs-result-player').src;
    pane.classList.add('active');
    observers[0].callback();
    pane.classList.remove('active');
    observers[0].callback();
    assert.ok(revoked.includes(exitUrl));
    assert.equal(typeof listeners.pagehide, 'function');
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
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
