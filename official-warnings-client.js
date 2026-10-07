'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const socket = () => window.blackRidgeSocket || null;
  let sessionKey = '';
  let activeWarning = null;
  const queue = [];
  const shown = new Set();

  function session() {
    try { return typeof window.blackRidgeGetNotificationSession === 'function' ? window.blackRidgeGetNotificationSession() : null; }
    catch (_error) { return null; }
  }
  function chief(sessionValue) { return !!(sessionValue && sessionValue.authenticated && sessionValue.user && String(sessionValue.user.rank || '').toUpperCase() === 'CIA CHIEF'); }
  function setStatus(message, isError) {
    const node = $('ow-form-status');
    if (node) { node.textContent = message || ''; node.style.color = isError ? '#ce6060' : '#bca7a7'; }
  }
  function labelPerson(person) {
    return [person.name, person.publicCode, person.rankLabel || person.rank].filter(Boolean).join(' · ');
  }
  function updatePersonInfo() {
    const select = $('ow-target');
    const box = $('ow-person-info');
    if (!select || !box) return;
    const selected = select.options[select.selectedIndex];
    const name = selected && selected.dataset.name;
    if (!name) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = 'الاسم: ' + name + '  |  الكود العسكري: ' + (selected.dataset.code || 'غير متوفر') +
      '  |  الرتبة: ' + (selected.dataset.rank || 'غير متوفرة') +
      (selected.dataset.sector ? '  |  القطاع: ' + selected.dataset.sector : '');
  }
  function loadPeople() {
    const connection = socket();
    if (!connection || !connection.connected) return;
    connection.emit('official-warning:people:list', {}, (result) => {
      const select = $('ow-target');
      if (!select || !result) return;
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = result.ok ? '— اختر الشخص —' : (result.message || 'تعذر تحميل القائمة');
      select.appendChild(placeholder);
      if (!result.ok) { setStatus(result.message || 'تعذر تحميل قائمة الأفراد.', true); return; }
      (result.people || []).forEach((person) => {
        const option = document.createElement('option');
        option.value = person.id;
        option.textContent = labelPerson(person);
        option.dataset.name = person.name || '';
        option.dataset.code = person.publicCode || '';
        option.dataset.rank = person.rankLabel || person.rank || '';
        option.dataset.sector = person.sector || '';
        select.appendChild(option);
      });
      updatePersonInfo();
    });
  }
  function renderResponses(responses) {
    const root = $('ow-response-list');
    if (!root) return;
    root.replaceChildren();
    if (!responses || !responses.length) {
      const empty = document.createElement('p'); empty.className = 'ow-empty'; empty.textContent = 'لا توجد تبريرات واردة.'; root.appendChild(empty); return;
    }
    responses.forEach((item) => {
      const card = document.createElement('article'); card.className = 'ow-response-item';
      const meta = document.createElement('div'); meta.className = 'ow-response-meta';
      const who = document.createElement('span'); who.textContent = [item.sourceName, item.sourceCode].filter(Boolean).join(' · ') || 'فرد';
      const date = document.createElement('time');
      date.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString('ar-JO') : '';
      meta.append(who, date);
      const text = document.createElement('div'); text.className = 'ow-response-text'; text.textContent = item.response || '';
      const kind = document.createElement('div'); kind.className = 'ow-response-meta'; kind.textContent = (item.warningType || 'تحذير رسمي') + ' · ' + (item.warningId || '');
      card.append(meta, text, kind); root.appendChild(card);
    });
  }
  function loadResponses() {
    const connection = socket();
    if (!connection || !connection.connected) return;
    connection.emit('official-warning:responses:list', {}, (result) => {
      if (result && result.ok) renderResponses(result.responses || []);
    });
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
      '<div class="ow-dialog-actions"><button type="button" id="ow-warning-close" class="ow-modal-button">إغلاق وتأكيد الاطلاع</button><button type="submit" form="ow-reply-form" id="ow-reply-submit" class="ow-modal-button primary" hidden>إرسال التبرير</button></div>' +
      '</section>';
    document.body.appendChild(overlay);
    $('ow-warning-close').addEventListener('click', markReadAndClose);
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
    overlay.classList.add('is-open'); overlay.setAttribute('aria-hidden', 'false');
    closeButton.focus();
  }
  function markReadAndClose() {
    if (!activeWarning) return;
    const current = activeWarning; activeWarning = null;
    const connection = socket();
    if (connection && connection.connected) connection.emit('notification:read', { id: current.id }, () => {});
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
    const card = $('official-warning-admin');
    if (!current || !current.authenticated || !current.user) {
      sessionKey = '';
      if (card) card.hidden = true;
      activeWarning = null; queue.length = 0;
      const overlay = $('ow-warning-overlay');
      if (overlay) { overlay.classList.remove('is-open'); overlay.setAttribute('aria-hidden', 'true'); }
      return;
    }
    if (card) card.hidden = !chief(current);
    const nextKey = String(current.user.id || '') + ':' + String(current.user.rank || '');
    if (nextKey === sessionKey) return;
    sessionKey = nextKey;
    loadWarnings();
    if (chief(current)) { loadPeople(); loadResponses(); }
  }
  const connection = socket();
  if (connection) {
    connection.on('connect', () => { sessionKey = ''; syncSession(); });
    connection.on('notification:new', (row) => {
      if (!row) return;
      if (row.type === 'WARNING') enqueueWarning(row);
      if (row.type === 'WARNING_RESPONSE' && chief(session())) loadResponses();
    });
  }
  const target = $('ow-target');
  if (target) target.addEventListener('change', updatePersonInfo);
  const form = $('official-warning-form');
  if (form) form.addEventListener('submit', (event) => {
    event.preventDefault();
    const current = session();
    if (!chief(current)) { setStatus('إصدار التحذيرات الرسمية متاح للقائد فقط.', true); return; }
    const connectionNow = socket();
    if (!connectionNow || !connectionNow.connected) { setStatus('تعذر الاتصال بالخادم؛ لم يُصدر التحذير.', true); return; }
    const data = new FormData(form);
    const button = form.querySelector('button[type="submit"]'); button.disabled = true; setStatus('جارٍ حفظ التحذير وإرساله…', false);
    connectionNow.emit('official-warning:create', {
      targetUserId: data.get('targetUserId'), warningType: data.get('warningType'), content: data.get('content'),
      allowJustification: data.get('allowJustification') === 'on'
    }, (result) => {
      button.disabled = false;
      if (!result || !result.ok) { setStatus(result && result.message || 'تعذر إصدار التحذير.', true); return; }
      const recipient = $('ow-target').selectedOptions[0];
      setStatus('تم حفظ التحذير وإرساله إلى ' + (recipient && recipient.dataset.name || 'الشخص المحدد') + '.', false);
      form.elements.content.value = '';
      form.elements.warningType.value = '';
      form.elements.allowJustification.checked = true;
      loadResponses();
    });
  });
  const refresh = $('ow-refresh-responses');
  if (refresh) refresh.addEventListener('click', loadResponses);
  window.addEventListener('blackridge:logout', () => { sessionKey = ''; syncSession(); });
  window.setInterval(syncSession, 1000);
  syncSession();
})();