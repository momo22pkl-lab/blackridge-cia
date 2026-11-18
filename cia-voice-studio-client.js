'use strict';

(function attachCiaVoiceStudio(root, factory) {
  const studio = factory(root);
  if (root) {
    root.openCiaVoiceStudio = studio.openCiaVoiceStudio;
    studio.initialize();
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = { createCiaVoiceStudioClient: factory };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createCiaVoiceStudioClient(root) {
  let initialized = false;
  let mode = 'voice';
  let socket = null;
  let mediaStream = null;
  let recorder = null;
  let discardCurrentRecording = false;
  let audioContext = null;
  let animationFrame = null;
  let durationTimer = null;
  let recordingStartedAt = 0;
  let recordingSeconds = 0;
  let sourceBlob = null;
  let sourceUrl = '';
  let resultUrl = '';
  let resultExtension = 'mp3';
  let voiceReady = false;
  let translationReady = false;
  let processing = false;

  function element(id) {
    return root && root.document && typeof root.document.getElementById === 'function'
      ? root.document.getElementById(id)
      : null;
  }

  function setStatus(message, tone) {
    const status = element('cvs-status');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone || 'neutral';
  }

  function getSocket() {
    return root && root.blackRidgeSocket ? root.blackRidgeSocket : null;
  }

  function refreshButtons() {
    const processButton = element('cvs-process');
    const startButton = element('cvs-record-start');
    const stopButton = element('cvs-record-stop');
    if (processButton) {
      processButton.disabled = processing || !sourceBlob || !voiceReady || (mode === 'translate' && !translationReady);
    }
    if (startButton) startButton.disabled = processing || !!recorder;
    if (stopButton) stopButton.disabled = !recorder;
  }

  function requestStatus() {
    socket = getSocket();
    if (!socket || !socket.connected) {
      voiceReady = false;
      translationReady = false;
      setStatus('سجّل الدخول وانتظر اتصال النظام للتحقق من إعدادات الصوت.', 'warning');
      refreshButtons();
      return;
    }
    socket.emit('cia-voice:status', {}, function onVoiceStatus(response) {
      if (!response || !response.ok) {
        voiceReady = false;
        translationReady = false;
        setStatus(response && response.message || 'تعذر التحقق من الخدمة.', 'error');
        refreshButtons();
        return;
      }
      voiceReady = response.voiceReady === true;
      translationReady = response.translationReady === true;
      const presets = new Map((response.presets || []).map((preset) => [preset.id, preset]));
      const select = element('cvs-preset');
      if (select) {
        Array.from(select.options || []).forEach((option) => {
          if (!option.value) return;
          const preset = presets.get(option.value);
          option.disabled = !preset || preset.available !== true;
        });
        const selected = presets.get(select.value);
        if (!selected || selected.available !== true) {
          const firstAvailable = (response.presets || []).find((preset) => preset.available === true);
          if (firstAvailable) select.value = firstAvailable.id;
        }
      }
      if (!voiceReady) {
        setStatus('خدمة الصوت غير جاهزة. يلزم إعداد ElevenLabs ومعرّف صوت صالح على الخادم.', 'warning');
      } else if (mode === 'translate' && !translationReady) {
        setStatus('تحويل الصوت جاهز؛ أضف إعداد OpenAI لتفعيل الترجمة.', 'warning');
      } else {
        setStatus('الخدمة جاهزة. سجّل أو ارفع ملفاً صوتياً للبدء.', 'success');
      }
      refreshButtons();
    });
  }

  function formatDuration(seconds) {
    const whole = Math.max(0, Math.floor(Number(seconds) || 0));
    return String(Math.floor(whole / 60)).padStart(2, '0') + ':' + String(whole % 60).padStart(2, '0');
  }

  function setSource(blob) {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceBlob = blob || null;
    sourceUrl = sourceBlob ? URL.createObjectURL(sourceBlob) : '';
    const player = element('cvs-original-player');
    if (player) {
      player.pause();
      player.removeAttribute('src');
      if (sourceUrl) {
        player.src = sourceUrl;
        player.load();
      }
    }
    refreshButtons();
  }

  function clearResult() {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = '';
    const result = element('cvs-result-player');
    if (result) {
      result.pause();
      result.removeAttribute('src');
      result.load();
    }
    const card = element('cvs-result-card');
    const download = element('cvs-download');
    if (card) card.hidden = true;
    if (download) download.removeAttribute('href');
  }

  function clearAll() {
    stopRecording(true);
    setSource(null);
    clearResult();
    recordingSeconds = 0;
    const duration = element('cvs-duration');
    if (duration) duration.textContent = '00:00';
    const upload = element('cvs-audio-upload');
    if (upload) upload.value = '';
    const consent = element('cvs-consent');
    if (consent) consent.checked = false;
    const transcriptWrap = element('cvs-transcript-wrap');
    if (transcriptWrap) transcriptWrap.hidden = true;
    setStatus('تم حذف التسجيل والنتيجة المؤقتين من الصفحة.', 'success');
    refreshButtons();
  }

  function stopVisualizer() {
    if (animationFrame) root.cancelAnimationFrame(animationFrame);
    animationFrame = null;
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    const canvas = element('cvs-waveform');
    const context = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      drawIdleWave(context, canvas);
    }
  }

  function drawIdleWave(context, canvas) {
    if (!context || !canvas) return;
    const width = canvas.width;
    const height = canvas.height;
    context.fillStyle = '#c1a46b';
    for (let index = 0; index < 26; index += 1) {
      const barHeight = 4 + (index % 5) * 2;
      context.fillRect(index * (width / 26) + 2, (height - barHeight) / 2, Math.max(2, width / 26 - 4), barHeight);
    }
  }

  function startVisualizer(stream) {
    const canvas = element('cvs-waveform');
    if (!canvas || typeof root.AudioContext !== 'function') return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const ratio = Math.max(1, root.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(260, Math.round(rect.width * ratio));
    canvas.height = Math.round(88 * ratio);
    audioContext = new root.AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 64;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const values = new Uint8Array(analyser.frequencyBinCount);
    const render = function renderAudioLevel() {
      if (!audioContext) return;
      analyser.getByteFrequencyData(values);
      context.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = canvas.width / values.length;
      values.forEach((value, index) => {
        const height = Math.max(4 * ratio, (value / 255) * canvas.height * 0.86);
        context.fillStyle = index % 4 === 0 ? '#c6aa70' : '#8e2227';
        context.fillRect(index * barWidth + 2 * ratio, (canvas.height - height) / 2, Math.max(2, barWidth - 4 * ratio), height);
      });
      animationFrame = root.requestAnimationFrame(render);
    };
    render();
  }

  async function startRecording() {
    if (!root.navigator || !root.navigator.mediaDevices || typeof root.navigator.mediaDevices.getUserMedia !== 'function') {
      setStatus('هذا المتصفح لا يتيح الوصول إلى الميكروفون.', 'error');
      return;
    }
    if (typeof root.MediaRecorder !== 'function') {
      setStatus('هذا المتصفح لا يدعم التسجيل الصوتي داخل الصفحة.', 'error');
      return;
    }
    try {
      mediaStream = await root.navigator.mediaDevices.getUserMedia({ audio: true });
      const options = {};
      if (root.MediaRecorder && typeof root.MediaRecorder.isTypeSupported === 'function' &&
          root.MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        options.mimeType = 'audio/webm;codecs=opus';
      }
      recorder = new root.MediaRecorder(mediaStream, options);
      const chunks = [];
      discardCurrentRecording = false;
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener('stop', () => {
        if (!discardCurrentRecording && chunks.length) {
          setSource(new Blob(chunks, { type: recorder && recorder.mimeType || 'audio/webm' }));
          setStatus(sourceBlob ? 'اكتمل التسجيل. استمع إليه أو ابدأ التحويل.' : 'لم يصل صوت في التسجيل.', sourceBlob ? 'success' : 'warning');
        }
        discardCurrentRecording = false;
        cleanupMedia();
        recorder = null;
        refreshButtons();
      }, { once: true });
      setSource(null);
      clearResult();
      recordingStartedAt = Date.now();
      recordingSeconds = 0;
      recorder.start(250);
      startVisualizer(mediaStream);
      durationTimer = root.setInterval(() => {
        recordingSeconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
        const duration = element('cvs-duration');
        if (duration) duration.textContent = formatDuration(recordingSeconds);
        if (recordingSeconds >= 120) stopRecording(false);
      }, 250);
      setStatus('التسجيل جارٍ — اضغط إيقاف عند الانتهاء.', 'warning');
      refreshButtons();
    } catch (_error) {
      cleanupMedia();
      recorder = null;
      setStatus('لم يُمنح إذن الميكروفون أو تعذر تشغيله.', 'error');
      refreshButtons();
    }
  }

  function cleanupMedia() {
    if (durationTimer) root.clearInterval(durationTimer);
    durationTimer = null;
    if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    stopVisualizer();
  }

  function stopRecording(discard) {
    if (discard) discardCurrentRecording = true;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      recorder = null;
      cleanupMedia();
    }
  }

  function selectMode(nextMode) {
    mode = nextMode === 'translate' ? 'translate' : 'voice';
    const options = element('cvs-translation-options');
    if (options) options.hidden = mode !== 'translate';
    const buttons = root.document.querySelectorAll('[data-mode]');
    buttons.forEach((button) => {
      const active = button.getAttribute('data-mode') === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const submit = element('cvs-process');
    const label = submit && submit.querySelector('span');
    if (label) label.textContent = mode === 'translate' ? 'ترجمة وإنشاء الصوت' : 'إنشاء الصوت الجديد';
    if (voiceReady && mode === 'translate' && !translationReady) {
      setStatus('تحويل الصوت جاهز؛ أضف إعداد OpenAI لتفعيل الترجمة.', 'warning');
    }
    refreshButtons();
  }

  function toArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Uint8Array.from(value.data).buffer;
    return null;
  }

  function showResult(response) {
    const audio = toArrayBuffer(response.audio);
    if (!audio || !audio.byteLength) {
      setStatus('وصلت استجابة بلا ملف صوت صالح.', 'error');
      return;
    }
    clearResult();
    resultExtension = response.extension === 'wav' ? 'wav' : 'mp3';
    const resultBlob = new Blob([audio], { type: response.mimeType || (resultExtension === 'wav' ? 'audio/wav' : 'audio/mpeg') });
    resultUrl = URL.createObjectURL(resultBlob);
    const transcriptWrap = element('cvs-transcript-wrap');
    const transcript = element('cvs-transcript');
    const translation = element('cvs-translation');
    const hasText = Boolean(response.transcript || response.translation);
    if (transcriptWrap) transcriptWrap.hidden = !hasText;
    if (transcript) transcript.textContent = response.transcript || '';
    if (translation) translation.textContent = response.translation || '';
    const player = element('cvs-result-player');
    if (player) {
      player.src = resultUrl;
      player.load();
    }
    const download = element('cvs-download');
    if (download) {
      download.href = resultUrl;
      download.download = 'blackridge-voice-result.' + resultExtension;
      download.textContent = 'تحميل ' + resultExtension.toUpperCase();
    }
    const card = element('cvs-result-card');
    if (card) card.hidden = false;
    setStatus('اكتملت المعالجة. النص ظاهر قبل تشغيل الصوت الجديد.', 'success');
  }

  async function processAudio() {
    if (!sourceBlob || processing) return;
    if (!element('cvs-consent')?.checked) {
      setStatus('وافق على إرسال التسجيل إلى مزودي المعالجة قبل البدء.', 'warning');
      return;
    }
    socket = getSocket();
    if (!socket || !socket.connected) {
      setStatus('اتصال النظام غير جاهز. سجّل الدخول ثم حاول مجدداً.', 'error');
      return;
    }
    if (mode === 'translate' && !translationReady) {
      setStatus('الترجمة غير مهيأة. يلزم إعداد OpenAI على الخادم.', 'warning');
      return;
    }
    processing = true;
    clearResult();
    refreshButtons();
    setStatus('جارٍ معالجة الصوت عبر خدمة الذكاء الاصطناعي…', 'warning');
    try {
      const audio = await sourceBlob.arrayBuffer();
      const payload = {
        mode,
        preset: element('cvs-preset')?.value || 'obsidian',
        format: element('cvs-format')?.value || 'mp3',
        depth: element('cvs-depth')?.value || '72',
        intensity: element('cvs-intensity')?.value || '72',
        clarity: element('cvs-clarity')?.value || '78',
        sourceLanguage: element('cvs-source-language')?.value || 'auto',
        targetLanguage: element('cvs-target-language')?.value || 'en',
        mimeType: sourceBlob.type || 'audio/webm',
        consent: true,
        audio
      };
      socket.emit('cia-voice:process', payload, function onProcessed(response) {
        processing = false;
        refreshButtons();
        if (!response || !response.ok) {
          setStatus(response && response.message || 'تعذر تحويل الصوت. لم يتم إنشاء نتيجة وهمية.', 'error');
          return;
        }
        showResult(response);
      });
    } catch (_error) {
      processing = false;
      refreshButtons();
      setStatus('تعذر إرسال التسجيل للمعالجة. لم يتم حفظه على الخادم.', 'error');
    }
  }

  function compareAudio() {
    const original = element('cvs-original-player');
    const result = element('cvs-result-player');
    if (!original || !result || !original.src || !result.src) return;
    result.pause();
    original.pause();
    original.currentTime = 0;
    result.currentTime = 0;
    original.onended = () => {
      original.onended = null;
      result.play().catch(() => {});
    };
    original.play().catch(() => setStatus('اضغط تشغيل السماعة للسماح بالمقارنة.', 'warning'));
  }

  function installListeners() {
    const start = element('cvs-record-start');
    const stop = element('cvs-record-stop');
    const upload = element('cvs-audio-upload');
    const process = element('cvs-process');
    const deleteButton = element('cvs-delete');
    const compare = element('cvs-compare');
    if (start) start.addEventListener('click', startRecording);
    if (stop) stop.addEventListener('click', () => stopRecording(false));
    if (process) process.addEventListener('click', processAudio);
    if (deleteButton) deleteButton.addEventListener('click', clearAll);
    if (compare) compare.addEventListener('click', compareAudio);
    if (upload) upload.addEventListener('change', () => {
      const file = upload.files && upload.files[0];
      if (!file) return;
      if (!file.type.startsWith('audio/')) {
        upload.value = '';
        setStatus('اختر ملفاً صوتياً فقط؛ ملفات الفيديو غير مدعومة.', 'error');
        return;
      }
      const normalizedType = file.type.split(';')[0].toLowerCase();
      if (!['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a'].includes(normalizedType)) {
        upload.value = '';
        setStatus('صيغة هذا الملف غير مدعومة. استخدم WebM أو MP3 أو WAV أو OGG أو M4A.', 'error');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        upload.value = '';
        setStatus('حجم الملف يتجاوز الحد المسموح (5 MB).', 'error');
        return;
      }
      stopRecording(true);
      setSource(file);
      clearResult();
      const duration = element('cvs-duration');
      if (duration) duration.textContent = '—';
      setStatus('تم اختيار الملف محلياً. لن يُرسل حتى توافق وتبدأ المعالجة.', 'success');
    });
    root.document.querySelectorAll('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => selectMode(button.getAttribute('data-mode')));
    });
    for (const [id, outputId] of [
      ['cvs-depth', 'cvs-depth-value'],
      ['cvs-intensity', 'cvs-intensity-value'],
      ['cvs-clarity', 'cvs-clarity-value']
    ]) {
      const input = element(id);
      const output = element(outputId);
      if (input && output) input.addEventListener('input', () => { output.value = input.value + '%'; });
    }
  }

  function openCiaVoiceStudio() {
    if (!root || typeof root.showPane !== 'function') return false;
    root.showPane('cia-voice-studio-view', element('cia-voice-studio-nav'));
    requestStatus();
    return true;
  }

  function initialize() {
    if (initialized || !root || !root.document || !element('cia-voice-studio-view')) return false;
    initialized = true;
    installListeners();
    socket = getSocket();
    if (socket && typeof socket.on === 'function') socket.on('connect', requestStatus);
    const nav = element('cia-voice-studio-nav');
    if (nav) nav.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openCiaVoiceStudio();
      }
    });
    const canvas = element('cvs-waveform');
    drawIdleWave(canvas && canvas.getContext ? canvas.getContext('2d') : null, canvas);
    requestStatus();
    refreshButtons();
    return true;
  }

  return { initialize, openCiaVoiceStudio, clearAll, selectMode, showResult, toArrayBuffer };
});
