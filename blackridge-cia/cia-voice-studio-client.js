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
  let previewObjectUrl = '';
  let resultExtension = 'mp3';
  let voiceReady = false;
  let translationReady = false;
  let scriptReady = false;
  let availablePresets = new Map();
  let processing = false;
  let previewing = false;
  let studioWasActive = false;

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
    const generateButton = element('cvs-script-generate');
    const previewButton = element('cvs-preview-button');
    const startButton = element('cvs-record-start');
    const stopButton = element('cvs-record-stop');
    const scriptText = element('cvs-script-text');
    const presetSelect = element('cvs-preset');
    const selectedPresetAvailable = Boolean(presetSelect && presetSelect.selectedOptions &&
      presetSelect.selectedOptions[0] && !presetSelect.selectedOptions[0].disabled);
    if (processButton) {
      processButton.disabled = processing || !voiceReady || !selectedPresetAvailable ||
        (mode === 'text'
          ? !String(scriptText && scriptText.value || '').trim() || String(scriptText && scriptText.value || '').trim().length > 12000
          : !sourceBlob || (mode === 'translate' && !translationReady));
    }
    if (generateButton) generateButton.disabled = processing || !scriptReady;
    if (previewButton) previewButton.disabled = processing || previewing || !selectedPresetAvailable;
    if (root && root.document && typeof root.document.querySelectorAll === 'function') {
      root.document.querySelectorAll('[data-cvs-preview]').forEach((button) => {
        button.disabled = processing || previewing;
      });
    }
    if (startButton) startButton.disabled = processing || !!recorder;
    if (stopButton) stopButton.disabled = !recorder;
  }

  function requestStatus() {
    socket = getSocket();
    if (!socket || !socket.connected) {
      voiceReady = false;
      translationReady = false;
      scriptReady = false;
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
      scriptReady = response.scriptReady === true;
      const presets = new Map((response.presets || []).map((preset) => [preset.id, preset]));
      availablePresets = presets;
      const generatorStatus = element('cvs-generator-status');
      if (generatorStatus) {
        generatorStatus.textContent = scriptReady
          ? 'المسودة ستظهر في مربع النص لتراجعها وتحررها؛ لن تتحول إلى صوت تلقائياً.'
          : 'مولّد النصوص معطّل حتى يُهيأ OPENAI_API_KEY على الخادم.';
      }
      const select = element('cvs-preset');
      if (select) {
        Array.from(select.options || []).forEach((option) => {
          if (!option.value) return;
          const preset = presets.get(option.value);
          option.disabled = !preset || preset.available !== true;
          option.hidden = !preset || preset.available !== true;
        });
        const selected = presets.get(select.value);
        if (!selected || selected.available !== true) {
          const firstAvailable = (response.presets || []).find((preset) => preset.available === true);
          if (firstAvailable) select.value = firstAvailable.id;
        }
      }
      updatePresetDescription(presets);
      renderAvailableVoices(response.presets || []);
      if (mode === 'text' && !scriptReady) {
        setStatus('مولّد النصوص غير جاهز. يلزم إعداد OpenAI على الخادم.', 'warning');
      } else if (!voiceReady) {
        setStatus('خدمة الصوت غير جاهزة. يلزم إعداد ElevenLabs ومعرّف صوت صالح على الخادم.', 'warning');
      } else if (mode === 'translate' && !translationReady) {
        setStatus('تحويل الصوت جاهز؛ أضف إعداد OpenAI لتفعيل الترجمة.', 'warning');
      } else if (mode === 'text') {
        setStatus('اكتب النص أو أنشئ مسودة، ثم وافق على الإرسال قبل المعالجة.', 'success');
      } else {
        setStatus('الخدمة جاهزة. سجّل أو ارفع ملفاً صوتياً للبدء.', 'success');
      }
      refreshButtons();
    });
  }

  function updatePresetDescription(presets) {
    const select = element('cvs-preset');
    const description = element('cvs-preset-description');
    if (!select || !description) return;
    const selected = (presets || availablePresets).get(select.value);
    description.textContent = selected && selected.available === true
      ? selected.description || 'هوية صوت متاحة على الخادم.'
      : 'هذا الصوت غير مهيأ حالياً على الخادم.';
  }

  function renderAvailableVoices(presets) {
    const list = element('cvs-voice-preview-list');
    if (!list || !root.document || typeof root.document.createElement !== 'function') return;
    list.replaceChildren();
    const available = (Array.isArray(presets) ? presets : []).filter((preset) => preset && preset.available === true);
    if (!available.length) {
      const empty = root.document.createElement('p');
      empty.className = 'cvs-note';
      empty.textContent = 'لا توجد أصوات مهيأة حالياً على الخادم.';
      list.appendChild(empty);
      return;
    }
    available.forEach((preset) => {
      const card = root.document.createElement('article');
      card.className = 'cvs-voice-option';
      const name = root.document.createElement('strong');
      name.textContent = preset.label || 'صوت جاهز';
      const description = root.document.createElement('p');
      description.textContent = preset.description || 'هوية صوت متاحة على الخادم.';
      const preview = root.document.createElement('button');
      preview.type = 'button';
      preview.className = 'cvs-button cvs-voice-preview-action';
      preview.textContent = 'اختيار ومعاينة';
      preview.setAttribute('data-cvs-preview', preset.id);
      card.append(name, description, preview);
      list.appendChild(card);
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

  function clearPreview() {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = '';
    const player = element('cvs-preview-player');
    if (player) {
      player.pause();
      player.removeAttribute('src');
      player.load();
      player.hidden = true;
    }
  }

  function clearAll() {
    stopRecording(true);
    setSource(null);
    clearResult();
    clearPreview();
    recordingSeconds = 0;
    const duration = element('cvs-duration');
    if (duration) duration.textContent = '00:00';
    const upload = element('cvs-audio-upload');
    if (upload) upload.value = '';
    const consent = element('cvs-consent');
    if (consent) consent.checked = false;
    const scriptText = element('cvs-script-text');
    const notes = element('cvs-script-notes');
    if (scriptText) scriptText.value = '';
    if (notes) notes.value = '';
    const transcriptWrap = element('cvs-transcript-wrap');
    if (transcriptWrap) transcriptWrap.hidden = true;
    const generatorStatus = element('cvs-generator-status');
    if (generatorStatus) generatorStatus.textContent = 'المسودة ستظهر في مربع النص لتراجعها وتحررها؛ لن تتحول إلى صوت تلقائياً.';
    setStatus('تم حذف التسجيلات والمسودة والنتائج المؤقتة من الاستوديو.', 'success');
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
    mode = ['voice', 'translate', 'text'].includes(nextMode) ? nextMode : 'voice';
    const options = element('cvs-translation-options');
    if (options) options.hidden = mode !== 'translate';
    const recordCard = element('cvs-record-card');
    const textCard = element('cvs-text-card');
    const grid = element('cia-voice-studio-view')?.querySelector('.cvs-grid');
    if (recordCard) recordCard.hidden = mode === 'text';
    if (textCard) textCard.hidden = mode !== 'text';
    if (grid) grid.dataset.mode = mode;
    const buttons = root.document.querySelectorAll('[data-mode]');
    buttons.forEach((button) => {
      const active = button.getAttribute('data-mode') === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const submit = element('cvs-process');
    const label = submit && submit.querySelector('span');
    if (label) {
      label.textContent = mode === 'translate'
        ? 'ترجمة وإنشاء الصوت'
        : mode === 'text' ? 'تحويل النص إلى صوت' : 'إنشاء الصوت الجديد';
    }
    const compare = element('cvs-compare');
    const resultCard = element('cvs-result-card');
    if (compare && resultCard && !resultCard.hidden) compare.hidden = mode === 'text';
    if (mode === 'text' && !scriptReady) {
      setStatus('مولّد النصوص غير جاهز. يلزم إعداد OpenAI على الخادم.', 'warning');
    } else if (mode === 'text' && !voiceReady) {
      setStatus('مولّد النصوص مستقل؛ يلزم إعداد ElevenLabs ومعرّف صوت لتحويل المسودة إلى صوت.', 'warning');
    } else if (voiceReady && mode === 'translate' && !translationReady) {
      setStatus('تحويل الصوت جاهز؛ أضف إعداد OpenAI لتفعيل الترجمة.', 'warning');
    } else if (mode === 'text') {
      setStatus('اكتب النص أو أنشئ مسودة، ثم وافق على الإرسال قبل المعالجة.', 'success');
    }
    refreshButtons();
  }

  function toArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Uint8Array.from(value.data).buffer;
    return null;
  }

  function showResult(response, resultMode) {
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
    const compare = element('cvs-compare');
    if (compare) compare.hidden = (resultMode || mode) === 'text';
    setStatus(
      (resultMode || mode) === 'text'
        ? 'اكتمل توليد الصوت. عدّل النص ثم أعد التوليد عند الحاجة.'
        : 'اكتملت المعالجة. استمع إلى الصوت الجديد أو نزّله.',
      'success'
    );
  }

  async function processAudio() {
    const textMode = mode === 'text';
    const text = String(element('cvs-script-text')?.value || '').trim();
    if (processing || (!textMode && !sourceBlob)) return;
    if (textMode && !text) {
      setStatus('اكتب النص أو أنشئ مسودة قبل تحويله إلى صوت.', 'warning');
      return;
    }
    if (textMode && text.length > 12000) {
      setStatus('النص يتجاوز الحد المسموح (12000 حرف).', 'error');
      return;
    }
    if (!element('cvs-consent')?.checked) {
      setStatus('وافق على إرسال النص أو التسجيل إلى المزود المناسب قبل البدء.', 'warning');
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
    const requestMode = mode;
    processing = true;
    clearResult();
    refreshButtons();
    setStatus(textMode ? 'جارٍ تحويل النص إلى صوت…' : 'جارٍ معالجة الصوت عبر خدمة الذكاء الاصطناعي…', 'warning');
    try {
      const payload = {
        mode: requestMode,
        preset: element('cvs-preset')?.value || 'obsidian',
        format: element('cvs-format')?.value || 'mp3',
        depth: element('cvs-depth')?.value || '72',
        intensity: element('cvs-intensity')?.value || '72',
        clarity: element('cvs-clarity')?.value || '78',
        sourceLanguage: element('cvs-source-language')?.value || 'auto',
        targetLanguage: element('cvs-target-language')?.value || 'en',
        consent: true
      };
      if (textMode) {
        payload.text = text;
      } else {
        payload.mimeType = sourceBlob.type || 'audio/webm';
        payload.audio = await sourceBlob.arrayBuffer();
      }
      socket.emit('cia-voice:process', payload, function onProcessed(response) {
        processing = false;
        refreshButtons();
        if (!response || !response.ok) {
          setStatus(response && response.message || 'تعذر تحويل الصوت. لم يتم إنشاء نتيجة وهمية.', 'error');
          return;
        }
        showResult(response, requestMode);
      });
    } catch (_error) {
      processing = false;
      refreshButtons();
      setStatus('تعذر إرسال التسجيل للمعالجة. لم يتم حفظه على الخادم.', 'error');
    }
  }

  function generateScript() {
    if (processing) return;
    if (!scriptReady) {
      setStatus('مولّد النصوص غير جاهز. يلزم إعداد OpenAI على الخادم.', 'warning');
      return;
    }
    if (!element('cvs-consent')?.checked) {
      setStatus('وافق على إرسال إعدادات المسودة إلى OpenAI قبل إنشائها.', 'warning');
      return;
    }
    socket = getSocket();
    if (!socket || !socket.connected) {
      setStatus('اتصال النظام غير جاهز. سجّل الدخول ثم حاول مجدداً.', 'error');
      return;
    }
    processing = true;
    refreshButtons();
    const generatorStatus = element('cvs-generator-status');
    if (generatorStatus) generatorStatus.textContent = 'جارٍ إنشاء مسودة للمراجعة…';
    setStatus('جارٍ إعداد مسودة نصية؛ لم يبدأ تحويل الصوت.', 'warning');
    try {
      socket.emit('cia-voice:generate-script', {
        type: element('cvs-script-type')?.value || 'mission_brief',
        language: element('cvs-script-language')?.value || 'ar',
        tone: element('cvs-script-tone')?.value || 'formal',
        lengthSeconds: Number(element('cvs-script-length')?.value || 30),
        notes: String(element('cvs-script-notes')?.value || ''),
        consent: true
      }, function onScriptGenerated(response) {
        processing = false;
        refreshButtons();
        if (!response || !response.ok || typeof response.text !== 'string' || !response.text.trim()) {
          const message = response && response.message || 'تعذر إنشاء المسودة.';
          if (generatorStatus) generatorStatus.textContent = message;
          setStatus(message, 'error');
          return;
        }
        const scriptText = element('cvs-script-text');
        if (scriptText) scriptText.value = response.text;
        if (generatorStatus) generatorStatus.textContent = 'المسودة جاهزة. راجعها وعدّلها قبل الضغط على تحويل النص إلى صوت.';
        setStatus('المسودة جاهزة للتحرير؛ لم تُنشأ أي نتيجة صوتية.', 'success');
        refreshButtons();
      });
    } catch (_error) {
      processing = false;
      refreshButtons();
      const message = 'تعذر إرسال إعدادات المسودة. لم يتم حفظ النص على الخادم.';
      if (generatorStatus) generatorStatus.textContent = message;
      setStatus(message, 'error');
    }
  }

  function requestVoicePreview() {
    if (processing || previewing) return;
    socket = getSocket();
    if (!socket || !socket.connected) {
      setStatus('اتصال النظام غير جاهز. سجّل الدخول ثم حاول مجدداً.', 'error');
      return;
    }
    const preset = element('cvs-preset')?.value || '';
    const status = element('cvs-preview-status');
    const player = element('cvs-preview-player');
    clearPreview();
    previewing = true;
    refreshButtons();
    if (status) status.textContent = 'جارٍ التحقق من وجود عينة فعلية…';
    socket.emit('cia-voice:preview', { preset }, function onVoicePreview(response) {
      previewing = false;
      refreshButtons();
      if (!response || !response.ok) {
        if (status) status.textContent = response && response.message || 'تعذر جلب عينة هذا الصوت حالياً.';
        return;
      }
      if (response.available !== true) {
        if (status) status.textContent = 'لا تتوفر عينة لهذا الصوت؛ لم يتم إنشاء عينة بديلة.';
        return;
      }
      const audio = toArrayBuffer(response.audio);
      if (!audio || !audio.byteLength || !player) {
        if (status) status.textContent = 'لم تصل عينة صوت صالحة.';
        return;
      }
      previewObjectUrl = URL.createObjectURL(new Blob([audio], {
        type: response.mimeType || 'audio/mpeg'
      }));
      player.src = previewObjectUrl;
      player.hidden = false;
      player.load();
      if (status) status.textContent = 'عينة فعلية جاهزة للتشغيل.';
      const playResult = player.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {
          if (status) status.textContent = 'العينة جاهزة؛ اضغط تشغيل في المشغّل للاستماع.';
        });
      }
    });
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
    const generate = element('cvs-script-generate');
    const preview = element('cvs-preview-button');
    const preset = element('cvs-preset');
    if (start) start.addEventListener('click', startRecording);
    if (stop) stop.addEventListener('click', () => stopRecording(false));
    if (process) process.addEventListener('click', processAudio);
    if (deleteButton) deleteButton.addEventListener('click', clearAll);
    if (compare) compare.addEventListener('click', compareAudio);
    if (generate) generate.addEventListener('click', generateScript);
    if (preview) preview.addEventListener('click', requestVoicePreview);
    if (preset) preset.addEventListener('change', () => {
      clearPreview();
      updatePresetDescription();
      const previewStatus = element('cvs-preview-status');
      if (previewStatus) previewStatus.textContent = 'تُعرض عينة فعلية فقط إذا كانت متاحة لهذا الصوت.';
      refreshButtons();
    });
    const voiceList = element('cvs-voice-preview-list');
    if (voiceList) voiceList.addEventListener('click', (event) => {
      const button = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-cvs-preview]')
        : null;
      const presetId = button && button.getAttribute('data-cvs-preview');
      if (!presetId || !preset) return;
      preset.value = presetId;
      clearPreview();
      updatePresetDescription();
      requestVoicePreview();
    });
    const scriptText = element('cvs-script-text');
    if (scriptText) scriptText.addEventListener('input', refreshButtons);
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

  function installPrivacyCleanup() {
    const pane = element('cia-voice-studio-view');
    if (!pane) return;
    studioWasActive = Boolean(pane.classList && pane.classList.contains('active'));
    if (typeof root.MutationObserver === 'function') {
      const observer = new root.MutationObserver(() => {
        const isActive = Boolean(pane.classList && pane.classList.contains('active') && !pane.hidden);
        if (studioWasActive && !isActive) clearAll();
        studioWasActive = isActive;
      });
      observer.observe(pane, { attributes: true, attributeFilter: ['class', 'hidden'] });
    }
    if (typeof root.addEventListener === 'function') root.addEventListener('pagehide', clearAll);
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
    installPrivacyCleanup();
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
