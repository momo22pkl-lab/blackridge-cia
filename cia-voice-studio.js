'use strict';

const NAV_MARKER = 'id="cia-cipher-hub-nav"';
const CONTENT_MARKER = '  <div class="content-area">';
const STUDIO_MARKER = 'data-cia-voice-studio';
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_LENGTH = 12000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 6;
let voiceStudioInitializationWarningLogged = false;

const VOICE_PRESETS = Object.freeze({
  obsidian: { label: 'The Unknown · مجهول مهيب ومرعب', env: 'ELEVENLABS_VOICE_ID_OBSIDIAN' },
  authority: { label: 'Deep Authority · سلطة عميقة', env: 'ELEVENLABS_VOICE_ID_DEEP_AUTHORITY' },
  operator: { label: 'CIA Operator · مشغّل هادئ', env: 'ELEVENLABS_VOICE_ID_OPERATOR' },
  professional: { label: 'Professional · احترافي واضح', env: 'ELEVENLABS_VOICE_ID_PROFESSIONAL' }
});

const LANGUAGES = Object.freeze({
  ar: 'Arabic',
  en: 'English',
  fr: 'French',
  es: 'Spanish'
});

const MIME_EXTENSIONS = Object.freeze({
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a'
});

const OUTPUT_FORMATS = Object.freeze({
  mp3: { provider: 'mp3_44100_128', mimeType: 'audio/mpeg', extension: 'mp3' },
  wav: { provider: 'wav_22050', mimeType: 'audio/wav', extension: 'wav' }
});

class VoiceStudioError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VoiceStudioError';
    this.code = code;
  }
}

function injectCiaVoiceStudioMarkup(html) {
  if (typeof html !== 'string' || html.includes(STUDIO_MARKER)) return html;
  const navAt = html.indexOf(NAV_MARKER);
  const contentAt = html.indexOf(CONTENT_MARKER);
  if (navAt < 0 || contentAt < 0) return html;

  const navEnd = html.indexOf('</li>', navAt);
  if (navEnd < 0) return html;

  const navItem = [
    '',
    '      <li id="cia-voice-studio-nav" class="nav-btn" role="button" tabindex="0" aria-controls="cia-voice-studio-view" onclick="openCiaVoiceStudio()">',
    '        <i class="fa-solid fa-microphone-lines" aria-hidden="true"></i> استوديو الصوت',
    '      </li>'
  ].join('\n');

  const pane = [
    '    <section id="cia-voice-studio-view" class="view-pane" data-cia-voice-studio dir="rtl" aria-labelledby="cia-voice-studio-title">',
    '      <div class="cvs-shell">',
    '        <header class="cvs-header">',
    '          <div>',
    '            <p class="cvs-kicker">BLACKRIDGE CIA / AUDIO LAB</p>',
    '            <h1 id="cia-voice-studio-title">استوديو الصوت</h1>',
    '            <p class="cvs-intro">حوّل تسجيلك إلى صوت اصطناعي جديد، عميق وواضح، من دون تقليد شخص حقيقي.</p>',
    '          </div>',
    '          <div class="cvs-seal" aria-hidden="true"><i class="fa-solid fa-wave-square"></i></div>',
    '        </header>',
    '        <div class="cvs-mode-row" role="group" aria-label="وضع المعالجة">',
    '          <button type="button" class="cvs-mode is-active" data-mode="voice">تغيير الصوت</button>',
    '          <button type="button" class="cvs-mode" data-mode="translate">ترجمة صوتية</button>',
    '        </div>',
    '        <div class="cvs-grid">',
    '          <section class="cvs-card cvs-record-card" aria-labelledby="cvs-record-title">',
    '            <div class="cvs-card-heading"><span class="cvs-step">01</span><div><h2 id="cvs-record-title">مصدر الصوت</h2><p>سجّل بصوتك أو ارفع ملفاً صوتياً.</p></div></div>',
    '            <canvas id="cvs-waveform" class="cvs-waveform" aria-label="مؤشر مستوى الصوت"></canvas>',
    '            <div class="cvs-record-controls">',
    '              <button type="button" id="cvs-record-start" class="cvs-button cvs-button-primary"><i class="fa-solid fa-microphone"></i> بدء التسجيل</button>',
    '              <button type="button" id="cvs-record-stop" class="cvs-button" disabled><i class="fa-solid fa-stop"></i> إيقاف</button>',
    '              <span id="cvs-duration" class="cvs-duration" aria-live="polite">00:00</span>',
    '            </div>',
    '            <label class="cvs-file-label" for="cvs-audio-upload"><i class="fa-solid fa-file-audio"></i> أو اختر ملفاً صوتياً</label>',
    '            <input id="cvs-audio-upload" type="file" accept="audio/*" aria-describedby="cvs-source-note">',
    '            <p id="cvs-source-note" class="cvs-note">الصوت يبقى في الذاكرة المؤقتة للصفحة حتى تطلب التحويل أو الحذف.</p>',
    '            <div class="cvs-player-block"><label for="cvs-original-player">التسجيل الأصلي</label><audio id="cvs-original-player" controls preload="metadata"></audio></div>',
    '          </section>',
    '          <section class="cvs-card cvs-options-card" aria-labelledby="cvs-options-title">',
    '            <div class="cvs-card-heading"><span class="cvs-step">02</span><div><h2 id="cvs-options-title">هوية الصوت</h2><p>صوت مُولّد مستقل، لا يحاكي شخصاً بعينه.</p></div></div>',
    '            <label class="cvs-field-label" for="cvs-preset">النبرة</label>',
    '            <select id="cvs-preset" class="cvs-select">',
    '              <option value="obsidian">The Unknown · مجهول مهيب ومرعب</option>',
    '              <option value="authority">Deep Authority · سلطة عميقة</option>',
    '              <option value="operator">CIA Operator · مشغّل هادئ</option>',
    '              <option value="professional">Professional · احترافي واضح</option>',
    '            </select>',
    '            <p class="cvs-note">عمق الهوية يأتي من الصوت المختار؛ منزلق الإلقاء يبطئ الوتيرة فقط، ولا يخفض الطبقة رقمياً.</p>',
    '            <div class="cvs-slider-field"><label for="cvs-depth">بطء الإلقاء · إحساس أعمق</label><output id="cvs-depth-value">72%</output><input id="cvs-depth" type="range" min="0" max="100" value="72"></div>',
    '            <div class="cvs-slider-field"><label for="cvs-intensity">قوة الأداء</label><output id="cvs-intensity-value">72%</output><input id="cvs-intensity" type="range" min="0" max="100" value="72"></div>',
    '            <div class="cvs-slider-field"><label for="cvs-clarity">الثبات والوضوح</label><output id="cvs-clarity-value">78%</output><input id="cvs-clarity" type="range" min="0" max="100" value="78"></div>',
    '            <div id="cvs-translation-options" class="cvs-translation-options" hidden>',
    '              <div class="cvs-language-pair">',
    '                <label>لغة الإدخال<select id="cvs-source-language" class="cvs-select"><option value="auto">كشف تلقائي</option><option value="ar" selected>العربية</option><option value="en">English</option><option value="fr">Français</option><option value="es">Español</option></select></label>',
    '                <span aria-hidden="true" class="cvs-language-arrow">←</span>',
    '                <label>لغة الإخراج<select id="cvs-target-language" class="cvs-select"><option value="en" selected>English</option><option value="ar">العربية</option><option value="fr">Français</option><option value="es">Español</option></select></label>',
    '              </div>',
    '            </div>',
    '            <label class="cvs-field-label" for="cvs-format">صيغة النتيجة</label>',
    '            <select id="cvs-format" class="cvs-select"><option value="mp3">MP3</option><option value="wav">WAV</option></select>',
    '            <label class="cvs-consent"><input id="cvs-consent" type="checkbox"><span>أوافق على إرسال هذا التسجيل إلى مزودي الذكاء الاصطناعي لمعالجته. التطبيق لا يحفظ الملف، لكن سياسات احتفاظ المزودين تنطبق.</span></label>',
    '            <button type="button" id="cvs-process" class="cvs-button cvs-button-primary cvs-process-button"><i class="fa-solid fa-wand-magic-sparkles"></i> <span>إنشاء الصوت الجديد</span></button>',
    '            <div id="cvs-status" class="cvs-status" role="status" aria-live="polite">جارٍ التحقق من إعداد الخدمة…</div>',
    '          </section>',
    '        </div>',
    '        <section id="cvs-result-card" class="cvs-card cvs-result-card" aria-labelledby="cvs-result-title" hidden>',
    '          <div class="cvs-card-heading"><span class="cvs-step">03</span><div><h2 id="cvs-result-title">النتيجة</h2><p>استمع وقارن ثم نزّل أو احذف الملفات المؤقتة.</p></div></div>',
    '          <div id="cvs-transcript-wrap" class="cvs-transcript-grid" hidden><div><label for="cvs-transcript">النص الأصلي</label><p id="cvs-transcript" dir="auto"></p></div><div><label for="cvs-translation">الترجمة</label><p id="cvs-translation" dir="auto"></p></div></div>',
    '          <div class="cvs-player-block cvs-result-player"><label for="cvs-result-player">الصوت الجديد</label><audio id="cvs-result-player" controls preload="metadata"></audio></div>',
    '          <div class="cvs-result-actions"><button type="button" id="cvs-compare" class="cvs-button">مقارنة الأصل والنتيجة</button><a id="cvs-download" class="cvs-button cvs-download" download>تحميل النتيجة</a><button type="button" id="cvs-delete" class="cvs-button cvs-delete">حذف التسجيل والنتيجة</button></div>',
    '        </section>',
    '        <p class="cvs-footer-note">لا تستخدم أصوات أشخاص حقيقيين دون موافقتهم. الصوت المُنشأ مخصص للأداء الإبداعي، ولا يوحي بأنه تسجيل حقيقي لشخص أو جهة.</p>',
    '      </div>',
    '    </section>'
  ].join('\n');

  let output = html.slice(0, navEnd + '</li>'.length) + navItem + html.slice(navEnd + '</li>'.length);
  const currentContentAt = output.indexOf(CONTENT_MARKER);
  output = output.slice(0, currentContentAt + CONTENT_MARKER.length) + '\n' + pane + output.slice(currentContentAt + CONTENT_MARKER.length);
  const styles = '<link rel="stylesheet" href="/cia-voice-studio.css" data-cia-voice-studio-styles>';
  const script = '<script src="/cia-voice-studio-client.js" data-cia-voice-studio-client defer></script>';
  if (output.includes('</head>')) output = output.replace('</head>', styles + '\n</head>');
  if (output.includes('</body>')) output = output.replace('</body>', script + '\n</body>');
  return output;
}

function cleanLanguage(value, allowAuto) {
  const language = String(value || '').toLowerCase();
  if (allowAuto && language === 'auto') return 'auto';
  return Object.prototype.hasOwnProperty.call(LANGUAGES, language) ? language : null;
}

function toAudioBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  return null;
}

function createCiaVoiceStudioService(options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const runtimeEnv = globalThis.process &&
    globalThis.process.env &&
    typeof globalThis.process.env === 'object'
    ? globalThis.process.env
    : Object.create(null);
  const env = settings.env && typeof settings.env === 'object' ? settings.env : runtimeEnv;
  const fetchImpl = settings.fetchImpl || globalThis.fetch;
  const openAiModel = String(env.CIA_VOICE_TRANSLATION_MODEL || 'gpt-4o-mini').trim();

  function getStatus() {
    const presets = Object.entries(VOICE_PRESETS).map(([id, preset]) => ({
      id,
      label: preset.label,
      available: Boolean(String(env[preset.env] || '').trim())
    }));
    return {
      voiceReady: Boolean(String(env.ELEVENLABS_API_KEY || '').trim()) && presets.some((preset) => preset.available),
      translationReady: Boolean(String(env.ELEVENLABS_API_KEY || '').trim()) &&
        Boolean(String(env.OPENAI_API_KEY || '').trim()) && presets.some((preset) => preset.available),
      presets
    };
  }

  function requireVoiceId(presetId) {
    const preset = VOICE_PRESETS[presetId];
    const voiceId = preset ? String(env[preset.env] || '').trim() : '';
    if (!preset || !voiceId) {
      throw new VoiceStudioError('PRESET_UNAVAILABLE', 'الصوت المختار غير مهيأ في إعدادات الخادم.');
    }
    if (!String(env.ELEVENLABS_API_KEY || '').trim()) {
      throw new VoiceStudioError('SERVICE_UNAVAILABLE', 'خدمة الصوت غير مهيأة بعد.');
    }
    return voiceId;
  }

  function validateAudio(audioValue, mimeValue) {
    const audio = toAudioBuffer(audioValue);
    const mimeType = String(mimeValue || '').split(';')[0].trim().toLowerCase();
    if (!audio || audio.length < 256) throw new VoiceStudioError('INVALID_AUDIO', 'لم يصل ملف صوت صالح.');
    if (audio.length > MAX_AUDIO_BYTES) throw new VoiceStudioError('AUDIO_TOO_LARGE', 'حجم الصوت يتجاوز الحد المسموح (5 MB).');
    if (!MIME_EXTENSIONS[mimeType]) throw new VoiceStudioError('UNSUPPORTED_AUDIO', 'صيغة الصوت غير مدعومة. استخدم WebM أو MP3 أو WAV أو OGG أو M4A.');
    return { audio, mimeType, extension: MIME_EXTENSIONS[mimeType] };
  }

  async function providerFetch(url, init, provider) {
    if (typeof fetchImpl !== 'function') throw new VoiceStudioError('SERVICE_UNAVAILABLE', 'خدمة المعالجة غير متاحة على الخادم.');
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(90000) });
    } catch (_error) {
      throw new VoiceStudioError('UPSTREAM_UNAVAILABLE', 'تعذر الاتصال بخدمة المعالجة. حاول مجدداً لاحقاً.');
    }
    if (!response.ok) {
      throw new VoiceStudioError('UPSTREAM_FAILED', 'لم تكتمل المعالجة لدى ' + provider + '. تحقق من إعداد المزود أو جرّب ملفاً أقصر.');
    }
    return response;
  }

  function providerAudio(buffer, format) {
    if (!buffer || !buffer.length) throw new VoiceStudioError('EMPTY_RESULT', 'لم تُرجع خدمة الصوت ملفاً صالحاً.');
    if (buffer.length > MAX_AUDIO_BYTES) throw new VoiceStudioError('RESULT_TOO_LARGE', 'النتيجة كبيرة جداً. اختر MP3 أو سجّل مقطعاً أقصر.');
    return { audio: buffer, mimeType: format.mimeType, extension: format.extension };
  }

  function voiceSettings(intensity, clarity, depth) {
    const intensityValue = Number.isFinite(Number(intensity)) ? Number(intensity) : 72;
    const clarityValue = Number.isFinite(Number(clarity)) ? Number(clarity) : 78;
    const depthValue = Number.isFinite(Number(depth)) ? Number(depth) : 72;
    const performance = Math.max(0, Math.min(100, intensityValue)) / 100;
    const quality = Math.max(0, Math.min(100, clarityValue)) / 100;
    const measuredPace = Math.max(0, Math.min(100, depthValue)) / 100;
    return {
      stability: Number((0.35 + quality * 0.5).toFixed(2)),
      similarity_boost: Number((0.55 + quality * 0.35).toFixed(2)),
      style: Number((0.15 + performance * 0.55).toFixed(2)),
      speed: Number((1 - measuredPace * 0.22).toFixed(2)),
      use_speaker_boost: true
    };
  }

  async function transcribe(audio, mimeType, extension, sourceLanguage) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mimeType }), 'recording.' + extension);
    form.append('model_id', 'scribe_v2');
    form.append('tag_audio_events', 'false');
    const language = cleanLanguage(sourceLanguage, true);
    if (!language) throw new VoiceStudioError('INVALID_LANGUAGE', 'لغة الإدخال غير مدعومة.');
    if (language !== 'auto') form.append('language_code', language);
    const response = await providerFetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': String(env.ELEVENLABS_API_KEY || '').trim() },
      body: form
    }, 'ElevenLabs');
    let data;
    try {
      data = await response.json();
    } catch (_error) {
      throw new VoiceStudioError('TRANSCRIPTION_FAILED', 'تعذر قراءة النص المستخرج من الصوت.');
    }
    const text = String(data && data.text || '').trim().slice(0, MAX_TEXT_LENGTH);
    if (!text) throw new VoiceStudioError('TRANSCRIPTION_EMPTY', 'لم يُعثر على كلام واضح في التسجيل.');
    return { text, languageCode: cleanLanguage(data.language_code, false) || language };
  }

  async function translateText(text, targetLanguage) {
    if (!String(env.OPENAI_API_KEY || '').trim()) {
      throw new VoiceStudioError('TRANSLATION_UNAVAILABLE', 'الترجمة غير مهيأة بعد. أضف إعداد OpenAI للخادم.');
    }
    const target = cleanLanguage(targetLanguage, false);
    if (!target) throw new VoiceStudioError('INVALID_LANGUAGE', 'لغة الإخراج غير مدعومة.');
    const response = await providerFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + String(env.OPENAI_API_KEY || '').trim(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: openAiModel,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'Translate the user text faithfully into ' + LANGUAGES[target] + '. Preserve meaning, names, and tone. Do not add explanations, quotes, or content. Return only the translation.'
          },
          { role: 'user', content: String(text).slice(0, MAX_TEXT_LENGTH) }
        ]
      })
    }, 'OpenAI');
    let data;
    try {
      data = await response.json();
    } catch (_error) {
      throw new VoiceStudioError('TRANSLATION_FAILED', 'تعذر قراءة نتيجة الترجمة.');
    }
    const translation = String(data?.choices?.[0]?.message?.content || '').trim().slice(0, MAX_TEXT_LENGTH);
    if (!translation) throw new VoiceStudioError('TRANSLATION_EMPTY', 'لم تُنتج خدمة الترجمة نصاً.');
    return translation;
  }

  async function synthesize(text, voiceId, format, settings) {
    const url = new URL('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId));
    url.searchParams.set('output_format', format.provider);
    const response = await providerFetch(url.toString(), {
      method: 'POST',
      headers: {
        'xi-api-key': String(env.ELEVENLABS_API_KEY || '').trim(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: String(text).slice(0, MAX_TEXT_LENGTH),
        model_id: 'eleven_multilingual_v2',
        voice_settings: settings
      })
    }, 'ElevenLabs');
    return providerAudio(Buffer.from(await response.arrayBuffer()), format);
  }

  async function changeVoice(audio, mimeType, extension, voiceId, format, settings) {
    const form = new FormData();
    form.append('audiofile', new Blob([audio], { type: mimeType }), 'recording.' + extension);
    form.append('model_id', 'eleven_multilingual_sts_v2');
    form.append('voice_settings', JSON.stringify(settings));
    form.append('remove_background_noise', 'true');
    const url = new URL('https://api.elevenlabs.io/v1/speech-to-speech/' + encodeURIComponent(voiceId));
    url.searchParams.set('output_format', format.provider);
    const response = await providerFetch(url.toString(), {
      method: 'POST',
      headers: { 'xi-api-key': String(env.ELEVENLABS_API_KEY || '').trim() },
      body: form
    }, 'ElevenLabs');
    return providerAudio(Buffer.from(await response.arrayBuffer()), format);
  }

  async function processAudio(payload) {
    const { audio, mimeType, extension } = validateAudio(payload.audio, payload.mimeType);
    const voiceId = requireVoiceId(String(payload.preset || 'obsidian'));
    const format = OUTPUT_FORMATS[String(payload.format || 'mp3')];
    if (!format) throw new VoiceStudioError('INVALID_FORMAT', 'صيغة النتيجة غير مدعومة.');
    const settings = voiceSettings(payload.intensity, payload.clarity, payload.depth);

    if (payload.mode === 'voice') {
      return { ...await changeVoice(audio, mimeType, extension, voiceId, format, settings), transcript: '', translation: '', sourceLanguage: '' };
    }
    if (payload.mode !== 'translate') throw new VoiceStudioError('INVALID_MODE', 'وضع المعالجة غير صالح.');
    const targetLanguage = cleanLanguage(payload.targetLanguage, false);
    if (!targetLanguage) throw new VoiceStudioError('INVALID_LANGUAGE', 'لغة الإخراج غير مدعومة.');
    const transcription = await transcribe(audio, mimeType, extension, payload.sourceLanguage);
    const translation = await translateText(transcription.text, targetLanguage);
    const result = await synthesize(translation, voiceId, format, settings);
    return {
      ...result,
      transcript: transcription.text,
      translation,
      sourceLanguage: transcription.languageCode || ''
    };
  }

  return { getStatus, process: processAudio };
}

function createUnavailableVoiceStudioService() {
  return {
    getStatus() {
      return {
        voiceReady: false,
        translationReady: false,
        presets: Object.entries(VOICE_PRESETS).map(([id, preset]) => ({
          id,
          label: preset.label,
          available: false
        }))
      };
    },
    async process() {
      throw new VoiceStudioError('SERVICE_UNAVAILABLE', 'خدمة الصوت غير متاحة حالياً.');
    }
  };
}

function voiceInitializationFailureReason(error) {
  if (error instanceof TypeError) return 'configuration_type_error';
  const code = String(error && error.code || '').trim();
  if (/^[A-Z0-9_]{1,32}$/.test(code)) return 'dependency_error';
  return 'initialization_error';
}

function registerCiaVoiceStudioSocket(socket, context = {}) {
  const settings = context && typeof context === 'object' ? context : {};
  let service = settings.service;
  if (!service) {
    try {
      service = createCiaVoiceStudioService(settings);
    } catch (error) {
      service = createUnavailableVoiceStudioService();
      if (!voiceStudioInitializationWarningLogged) {
        voiceStudioInitializationWarningLogged = true;
        console.warn(
          `[BLACK RIDGE] Optional subsystem unavailable: system=voice-studio reason=${voiceInitializationFailureReason(error)} action=disabled`
        );
      }
    }
  }
  const requireUser = typeof settings.requireUser === 'function' ? settings.requireUser : () => null;
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const requests = new Map();

  function callbackFor(callback, result) {
    if (typeof callback === 'function') callback(result);
    return result;
  }

  function allowRequest(userId) {
    const timestamp = now();
    const recent = (requests.get(userId) || []).filter((item) => timestamp - item < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) return false;
    recent.push(timestamp);
    requests.set(userId, recent);
    return true;
  }

  socket.on('cia-voice:status', (_payload, callback) => {
    const user = requireUser();
    if (!user) return callbackFor(callback, { ok: false, code: 'AUTH_REQUIRED', message: 'سجّل الدخول بحساب نشط لاستخدام استوديو الصوت.' });
    return callbackFor(callback, { ok: true, ...service.getStatus() });
  });

  socket.on('cia-voice:process', async (payload, callback) => {
    const user = requireUser();
    if (!user) return callbackFor(callback, { ok: false, code: 'AUTH_REQUIRED', message: 'سجّل الدخول بحساب نشط لاستخدام استوديو الصوت.' });
    if (!payload || payload.consent !== true) {
      return callbackFor(callback, { ok: false, code: 'CONSENT_REQUIRED', message: 'وافق على إرسال الصوت إلى مزودي المعالجة قبل البدء.' });
    }
    const userId = String(user.id || '');
    if (!userId) return callbackFor(callback, { ok: false, code: 'AUTH_REQUIRED', message: 'سجّل الدخول بحساب نشط لاستخدام استوديو الصوت.' });
    if (!allowRequest(userId)) {
      return callbackFor(callback, { ok: false, code: 'RATE_LIMITED', message: 'وصلت إلى حد المعالجة المؤقت. انتظر قليلاً ثم حاول مجدداً.' });
    }
    try {
      const result = await service.process(payload);
      return callbackFor(callback, {
        ok: true,
        audio: result.audio,
        mimeType: result.mimeType,
        extension: result.extension,
        transcript: result.transcript,
        translation: result.translation,
        sourceLanguage: result.sourceLanguage
      });
    } catch (error) {
      const known = error instanceof VoiceStudioError;
      return callbackFor(callback, {
        ok: false,
        code: known ? error.code : 'PROCESSING_FAILED',
        message: known ? error.message : 'تعذرت معالجة الصوت. تحقق من الإعدادات وحاول مجدداً.'
      });
    }
  });

  return { requests };
}

module.exports = {
  MAX_AUDIO_BYTES,
  OUTPUT_FORMATS,
  VOICE_PRESETS,
  VoiceStudioError,
  createCiaVoiceStudioService,
  injectCiaVoiceStudioMarkup,
  registerCiaVoiceStudioSocket,
  toAudioBuffer
};
