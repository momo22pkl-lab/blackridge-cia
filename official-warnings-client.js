'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const socket = () => window.blackRidgeSocket || null;
  let sessionKey = '';
  let activeWarning = null;
  const queue = [];
  const shown = new Set();
  const warningSound = new Audio('/warning-alert.mp3');
  warningSound.preload = 'auto';
  warningSound.volume = 0.8;
  warningSound.loop = true;
  let warningSoundPrimed = false;
  let warningSoundPriming = false;

  function primeWarningSound() {
    if (warningSoundPrimed || warningSoundPriming || activeWarning) return;
    warningSoundPriming = true;
    const wasMuted = warningSound.muted;
    warningSound.muted = true;
    let attempt;
    try { attempt = warningSound.play(); }
    catch (_error) { warningSound.muted = wasMuted; warningSoundPriming = false; return; }
    if (attempt && typeof attempt.then === 'function') {
      attempt.then(() => {
        if (!activeWarning) {
          warningSound.pause();
          warningSound.currentTime = 0;
        }
        warningSound.muted = wasMuted;
        warningSoundPrimed = true;
        warningSoundPriming = false;
      }).catch(() => {
        warningSound.muted = wasMuted;
        warningSoundPriming = false;
      });
    } else {
      warningSound.pause();
      warningSound.currentTime = 0;
      warningSound.muted = wasMuted;
      warningSoundPrimed = true;
      warningSoundPriming = false;
    }
  }

  function playWarningSound() {
    const button = $('ow-enable-warning-sound');
    warningSound.currentTime = 0;
    try {
      const attempt = warningSound.play();
      if (attempt && typeof attempt.then === 'function') {
        attempt.then(() => { if (button) button.hidden = true; }).catch(() => { if (button) button.hidden = false; });
      }
    } catch (_error) {
      if (button) button.hidden = false;
    }
  }

  function stopWarningSound() {
    warningSound.pause();
    warningSound.currentTime = 0;
  }

  function session() {
    try { return typeof window.blackRidgeGetNotificationSession === 'function' ? window.blackRidgeGetNotificationSession() : null; }
    catch (_error) { return null; }
  }
  function normalizedWarning(row) {
    const metadata = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    return {
      id: row && row.id || '',
      warningId: row && row.warningId || metadata.warningId || row && row.relatedId || row && row.id || '',
      warningType: row && row.warningType || metadata.warningType || 'أخرى',
      content: row && row.content || metadata.warningContent || row && row.message || '',
      allowJustification: row && row.allowJustification === true || metadata.allowJustification === true,
      createdAt: row && row.createdAt || '',
      readAt: row && row.readAt || null
    };
  }
  function enqueueWarning(row) {
    const warning = normalizedWarning(row);
    if (!warning.id || shown.has(warning.id) || warning.readAt) return;
    shown.add(warning.id);
    queue.push(warning);
    showNextWarning();
  }
  function ensureDialog() {
    let overlay = $('ow-warning-overlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'ow-overlay'; overlay.id = 'ow-warning-overlay'; overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = '<section class="ow-dialog" role="dialog" aria-modal="true" aria-labelledby="ow-warning-title" dir="rtl">' +
      '<header class="ow-dialog-header"><div><div class="ow-brand">BLACK RIDGE CITY CIA</div><div class="ow-classification">CLASSIFIED / INTELLIGENCE SYSTEM</div></div><div class="ow-security-state">SECURITY STATUS</div></header>' +
      '<span class="ow-warning-stamp">OFFICIAL NOTICE</span><h2 id="ow-warning-title">تحذير رسمي</h2><div class="ow-dialog-subtitle">BLACK RIDGE CIA</div>' +
      '<div class="ow-warning-type"><span>نوع التحذير</span><strong id="ow-warning-kind"></strong></div>' +
      '<div id="ow-warning-content" class="ow-warning-content" dir="auto"></div>' +
      '<div class="ow-warning-footer"><span id="ow-warning-id"></span><time id="ow-warning-date"></time></div>' +
      '<form id="ow-reply-form" class="ow-reply-area" hidden><label class="ow-reply-label" for="ow-reply-text">التبرير</label><textarea id="ow-reply-text" maxlength="3000" rows="4" placeholder="اكتب تبريرك بالتفصيل"></textarea><p class="ow-reply-note">سيصل التبرير إلى القائد الذي أصدر التحذير ويُحفظ في سجل الإشعارات.</p><div id="ow-reply-status" class="ow-reply-status" role="status" aria-live="polite"></div></form>' +
      '<div id="ow-no-reply-message" class="ow-reply-note" hidden>القائد منع التبرير لهذا التحذير. لا يمكن إرسال رد.</div>' +
      '<div class="ow-dialog-actions"><button type="button" id="ow-enable-warning-sound" class="ow-modal-button" hidden>تشغيل صوت التحذير</button><button type="button" id="ow-warning-close" class="ow-modal-button">إغلاق وتأكيد الاطلاع</button><button type="submit" form="ow-reply-form" id="ow-reply-submit" class="ow-modal-button primary" hidden>إرسال التبرير</button></div>' +
      '</section>';
    document.body.appendChild(overlay);
    $('ow-warning-close').addEventListener('click', markReadAndClose);
    $('ow-enable-warning-sound').addEventListener('click', playWarningSound);
    $('ow-reply-form').addEventListener('submit', submitReply);
    return overlay;
  }
  function showNextWarning() {
    if (activeWarning || !queue.length) return;
    activeWarning = queue.shift();
    const warning = activeWarning;
    const overlay = ensureDialog();
    $('ow-warning-kind').textContent = warning.warningType;
    $('ow-warning-content').textContent = warning.content;
    $('ow-warning-id').textContent = 'RECORD // ' + warning.warningId;
    $('ow-warning-date').textContent = warning.createdAt ? new Date(warning.createdAt).toLocaleString('ar-JO') : '';
    $('ow-reply-form').hidden = !warning.allowJustification;
    $('ow-reply-submit').hidden = !warning.allowJustification;
    $('ow-no-reply-message').hidden = warning.allowJustification;
    $('ow-reply-text').value = '';
    $('ow-reply-status').textContent = '';
    const closeButton = $('ow-warning-close'); closeButton.disabled = false;
    const soundButton = $('ow-enable-warning-sound'); if (soundButton) soundButton.hidden = true;
    playWarningSound();
    overlay.classList.add('is-open'); overlay.setAttribute('aria-hidden', 'false');
    closeButton.focus();
  }
  function markReadAndClose() {
    if (!activeWarning) return;
    const warningId = activeWarning.id;
    const connection = socket();
    if (connection && connection.connected) {
      connection.emit('notification:read', { id: warningId });
    }
    stopWarningSound();
    activeWarning = null;
    const overlay = $('ow-warning-overlay');
    if (overlay) { overlay.classList.remove('is-open'); overlay.setAttribute('aria-hidden', 'true'); }
    showNextWarning();
  }
  function submitReply(event) {
    event.preventDefault();
    if (!activeWarning) return;
    const value = ($('ow-reply-text').value || '').trim();
    if (value.length < 5) { $('ow-reply-status').textContent = 'اكتب تبريرًا من 5 أحرف على الأقل.'; return; }
    const connection = socket();
    if (!connection || !connection.connected) { $('ow-reply-status').textContent = 'تعذر الاتصال؛ لم يُرسل التبرير.'; return; }
    stopWarningSound();
    const submit = $('ow-reply-submit'); submit.disabled = true;
    connection.emit('official-warning:respond', { warningId: activeWarning.warningId, response: value }, (result) => {
      submit.disabled = false;
      if (!result || !result.ok) { $('ow-reply-status').textContent = result && result.message || 'تعذر إرسال التبرير.'; return; }
      $('ow-reply-status').textContent = result.message || 'تم حفظ التبرير وإرساله للقائد.';
      window.setTimeout(markReadAndClose, 450);
    });
  }
  function loadWarnings() {
    const connection = socket();
    if (!connection || !connection.connected) return;
    connection.emit('official-warning:list', { limit: 50, offset: 0 }, (result) => {
      if (result && result.ok) (result.warnings || []).forEach(enqueueWarning);
    });
  }
  function syncSession() {
    const current = session();
    if (!current || !current.authenticated || !current.user) {
      sessionKey = '';
      activeWarning = null; queue.length = 0; shown.clear();
      stopWarningSound();
      const overlay = $('ow-warning-overlay');
      if (overlay) { overlay.classList.remove('is-open'); overlay.setAttribute('aria-hidden', 'true'); }
      return;
    }
    const nextKey = String(current.user.id || '') + ':' + String(current.user.rank || '');
    if (nextKey === sessionKey) return;
    sessionKey = nextKey;
    loadWarnings();
  }
  const connection = socket();
  if (connection) {
    connection.on('connect', () => { sessionKey = ''; syncSession(); });
    connection.on('auth:login:result', (result) => {
      if (!result || !result.ok) return;
      sessionKey = '';
      syncSession();
    });
    connection.on('notification:new', (row) => {
      if (!row) return;
      if (row.type === 'WARNING') enqueueWarning(row);
    });
    connection.on('official-warning:justification:changed', (data) => {
      if (!data?.warning) return;
      const changed = data.warning;
      for (const item of queue) {
        if (item.warningId === changed.warningId) item.allowJustification = changed.allowJustification === true;
      }
      if (activeWarning && activeWarning.warningId === changed.warningId) {
        activeWarning.allowJustification = changed.allowJustification === true;
        $('ow-reply-form').hidden = !activeWarning.allowJustification;
        $('ow-reply-submit').hidden = !activeWarning.allowJustification;
        $('ow-no-reply-message').hidden = activeWarning.allowJustification;
        if (!activeWarning.allowJustification) $('ow-reply-text').value = '';
      }
    });
  }
  window.addEventListener('pointerdown', primeWarningSound, { once: true, capture: true });
  window.addEventListener('keydown', primeWarningSound, { once: true, capture: true });

  window.addEventListener('blackridge:logout', () => { sessionKey = ''; syncSession(); });
  window.setInterval(syncSession, 1000);
  syncSession();
})();