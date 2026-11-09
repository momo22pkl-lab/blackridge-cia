'use strict';

(() => {
  const pane = document.getElementById('military-personnel-dossier');
  if (!pane || pane.dataset.mpdMounted === 'true') return;
  pane.dataset.mpdMounted = 'true';

  const listNode = pane.querySelector('#mpd-roster-list');
  const profileNode = pane.querySelector('#mpd-profile');
  const searchNode = pane.querySelector('#mpd-search');
  const countNode = pane.querySelector('#mpd-count');
  const statusNode = pane.querySelector('#mpd-status');
  const tabLabels = {
    notes: 'الملاحظات',
    cases: 'القضايا',
    timeline: 'السجل الزمني',
    attachments: 'المرفقات'
  };
  const state = {
    people: [],
    selectedId: '',
    detail: null,
    search: '',
    activeTab: 'notes',
    dossier: null,
    permissions: { canWrite: false, canDelete: false },
    editingNoteId: '',
    editingCaseId: '',
    preview: null,
    loading: false,
    detailLoading: false,
    loaded: false,
    error: '',
    requestId: 0,
    detailRequestId: 0
  };

  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const initials = (value) => {
    const text = String(value || '').trim();
    return text ? Array.from(text).slice(0, 2).join('') : '—';
  };
  const safePhotoUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw, window.location.href);
      if (url.protocol !== 'https:' && !(url.origin === window.location.origin && url.protocol === 'http:')) return '';
      if (url.username || url.password) return '';
      return url.href;
    } catch (_error) {
      return '';
    }
  };
  const formatDate = (value) => {
    if (!value) return 'غير مسجل';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : date.toLocaleDateString('ar-JO', { year: 'numeric', month: 'long', day: 'numeric' });
  };
  const displayStatus = (value) => ({
    'ON DUTY': 'على رأس العمل',
    'OFF DUTY': 'خارج الخدمة',
    ONLINE: 'متصل',
    SUSPENDED: 'موقوف',
    RESTRICTED: 'مقيّد',
    'PENDING APPROVAL': 'بانتظار الاعتماد'
  }[String(value || '').toUpperCase()] || value || 'غير مسجل');
  const statusTone = (value) => {
    const status = String(value || '').toUpperCase();
    if (status.includes('SUSPENDED') || status.includes('RESTRICTED')) return 'danger';
    if (status.includes('PENDING')) return 'pending';
    if (status === 'ON DUTY' || status === 'ONLINE') return 'active';
    return '';
  };
  const emit = (eventName, payload, timeoutMs = 10000) => {
    const socket = window.blackRidgeSocket;
    if (!socket || !socket.connected) {
      return Promise.resolve({ ok: false, message: 'تعذر الاتصال الآمن. أعد تسجيل الدخول ثم حاول مرة أخرى.' });
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response || { ok: false, message: 'لم يصل رد من الخادم.' });
      };
      const timer = setTimeout(() => finish({ ok: false, message: 'انتهت مهلة تحميل السجل. حاول التحديث.' }), timeoutMs);
      socket.emit(eventName, payload || {}, finish);
    });
  };

  function setStatus(message, tone = '') {
    statusNode.textContent = message || '';
    statusNode.className = `mpd-status${tone ? ` ${tone}` : ''}`;
    statusNode.hidden = !message;
  }

  function photoMarkup(person, compact = false) {
    const url = safePhotoUrl(person && person.portraitUrl);
    const name = person && (person.name || person.publicCode) || '';
    const classes = compact ? 'mpd-avatar mpd-avatar-small' : 'mpd-portrait';
    if (url) {
      return `<div class="${classes}"><img data-mpd-photo src="${escapeHtml(url)}" alt="${escapeHtml(name ? `صورة ${name}` : 'صورة عسكرية')}" loading="lazy" referrerpolicy="no-referrer"><span class="mpd-photo-fallback" aria-hidden="true"><i class="fa-solid fa-user-secret"></i><b>${escapeHtml(initials(name))}</b></span></div>`;
    }
    if (compact) {
      return `<span class="${classes}" aria-hidden="true"><i class="fa-solid fa-user-secret"></i></span>`;
    }
    return `<div class="${classes} is-empty" role="img" aria-label="لا توجد صورة مسجلة"><span class="mpd-photo-fallback"><i class="fa-solid fa-user-secret" aria-hidden="true"></i><b>${escapeHtml(initials(name))}</b><small>لا توجد صورة مسجلة</small></span></div>`;
  }

  function filteredPeople() {
    const query = state.search.trim().toLocaleLowerCase();
    if (!query) return state.people;
    return state.people.filter((person) => [
      person.name,
      person.publicCode,
      person.rankLabel,
      person.battalion && person.battalion.code,
      person.battalion && person.battalion.name,
      person.battalion && person.battalion.sector,
      person.position,
      person.statusLabel
    ].join(' ').toLocaleLowerCase().includes(query));
  }

  function renderRoster() {
    const people = filteredPeople();
    countNode.textContent = state.loading && !state.loaded ? '…' : `${people.length} / ${state.people.length}`;
    if (state.loading && !state.loaded) {
      listNode.innerHTML = '<div class="mpd-empty">جارٍ تحميل السجل المصرّح به…</div>';
      return;
    }
    if (!people.length) {
      listNode.innerHTML = `<div class="mpd-empty">${state.people.length ? 'لا توجد نتائج مطابقة.' : 'لا توجد سجلات متاحة ضمن صلاحيات هذا الحساب.'}</div>`;
      return;
    }
    listNode.innerHTML = people.map((person) => {
      const selected = String(person.id) === String(state.selectedId);
      const name = person.name || 'الهوية غير متاحة';
      const unit = person.battalion ? `${person.battalion.code || ''}${person.battalion.name ? ` · ${person.battalion.name}` : ''}` : 'دون كتيبة مسجلة';
      return `<button class="mpd-person-card${selected ? ' is-selected' : ''}" type="button" data-mpd-person="${escapeHtml(person.id)}" aria-pressed="${selected}">
        ${photoMarkup(person, true)}
        <span class="mpd-card-copy"><b>${escapeHtml(name)}</b><span class="mpd-card-rank">${escapeHtml(person.rankLabel || person.rank || 'رتبة غير مسجلة')}</span><span class="mpd-card-meta"><code>${escapeHtml(person.publicCode || '—')}</code><span>${escapeHtml(unit)}</span></span></span>
        <span class="mpd-card-status ${statusTone(person.statusLabel)}">${escapeHtml(displayStatus(person.statusLabel))}</span>
      </button>`;
    }).join('');
    listNode.querySelectorAll('[data-mpd-photo]').forEach((image) => {
      image.addEventListener('error', () => image.closest('.mpd-avatar')?.classList.add('photo-error'), { once: true });
      image.addEventListener('load', () => image.closest('.mpd-avatar')?.classList.add('photo-loaded'), { once: true });
    });
  }

  function renderNoteForm(note = null) {
    const editing = !!note;
    return `<form class="mpd-editor-form" data-mpd-form="note" data-mpd-id="${escapeHtml(note && note.id || '')}">
      <label>نص الملاحظة<textarea name="body" maxlength="5000" required placeholder="دوّن الملاحظة المرتبطة بهذا الملف">${escapeHtml(note && note.body || '')}</textarea></label>
      <div class="mpd-form-actions"><button class="mpd-action-button is-primary" type="submit">${editing ? 'حفظ التعديل' : 'إضافة ملاحظة'}</button>${editing ? '<button class="mpd-action-button is-muted" type="button" data-mpd-cancel-edit>إلغاء</button>' : ''}</div>
    </form>`;
  }

  function renderNotes() {
    const notes = state.dossier && Array.isArray(state.dossier.notes) ? state.dossier.notes : [];
    const editor = state.permissions.canWrite
      ? renderNoteForm(notes.find((note) => String(note.id) === String(state.editingNoteId)) || null)
      : '';
    const items = notes.length ? notes.map((note) => {
      if (String(note.id) === String(state.editingNoteId)) {
        return `<article class="mpd-record-card">${renderNoteForm(note)}</article>`;
      }
      return `<article class="mpd-record-card">
        <header class="mpd-record-card-head"><div><strong>${escapeHtml(note.authorName || note.authorCode || 'القيادة')}</strong><span>${escapeHtml(note.authorCode || '')} · ${escapeHtml(formatDate(note.createdAt))}${note.updatedAt && String(note.updatedAt) !== String(note.createdAt) ? ` · عُدّلت ${escapeHtml(formatDate(note.updatedAt))}` : ''}</span></div>
          ${state.permissions.canWrite ? `<div class="mpd-inline-actions"><button class="mpd-text-button" type="button" data-mpd-note-edit="${escapeHtml(note.id)}">تعديل</button><button class="mpd-text-button is-danger" type="button" data-mpd-note-delete="${escapeHtml(note.id)}">حذف</button></div>` : ''}
        </header><p class="mpd-record-body">${escapeHtml(note.body)}</p>
      </article>`;
    }).join('') : '<div class="mpd-empty mpd-tab-empty">لا توجد ملاحظات مسجلة لهذا الملف.</div>';
    return `<div class="mpd-tab-content"><div class="mpd-tab-heading"><div><span class="mpd-kicker">FIELD NOTES</span><h4>ملاحظات الملف</h4></div><span class="mpd-count">${notes.length}</span></div>${state.permissions.canWrite && !state.editingNoteId ? editor : ''}<div class="mpd-record-list">${items}</div></div>`;
  }

  function renderCaseForm(record = null) {
    const editing = !!record;
    const item = record || {};
    return `<form class="mpd-editor-form mpd-case-form" data-mpd-form="case" data-mpd-id="${escapeHtml(item.id || '')}">
      <label>عنوان القضية<input name="title" type="text" maxlength="160" required value="${escapeHtml(item.title || '')}" placeholder="عنوان موجز وواضح"></label>
      <label>التفاصيل<textarea name="details" maxlength="10000" placeholder="تفاصيل القضية">${escapeHtml(item.details || '')}</textarea></label>
      <label>الأدلة<textarea name="evidence" maxlength="10000" placeholder="وصف الأدلة المتاحة أو مراجعها">${escapeHtml(item.evidence || '')}</textarea></label>
      <div class="mpd-form-grid"><label>الحالة<select name="status">
        <option value="OPEN"${item.status === 'OPEN' || !item.status ? ' selected' : ''}>مفتوحة</option>
        <option value="UNDER_REVIEW"${item.status === 'UNDER_REVIEW' ? ' selected' : ''}>قيد المراجعة</option>
        <option value="CLOSED"${item.status === 'CLOSED' ? ' selected' : ''}>مغلقة</option>
        <option value="DISMISSED"${item.status === 'DISMISSED' ? ' selected' : ''}>مستبعدة</option>
      </select></label><label>القرار النهائي<input name="finalDecision" type="text" maxlength="5000" value="${escapeHtml(item.finalDecision || '')}" placeholder="مطلوب عند إغلاق القضية"></label></div>
      <div class="mpd-form-actions"><button class="mpd-action-button is-primary" type="submit">${editing ? 'حفظ القضية' : 'إنشاء قضية'}</button>${editing ? '<button class="mpd-action-button is-muted" type="button" data-mpd-cancel-edit>إلغاء</button>' : ''}</div>
    </form>`;
  }

  function caseStatusLabel(value) {
    return ({ OPEN: 'مفتوحة', UNDER_REVIEW: 'قيد المراجعة', CLOSED: 'مغلقة', DISMISSED: 'مستبعدة' })[String(value || '').toUpperCase()] || 'غير محددة';
  }

  function renderCases() {
    const cases = state.dossier && Array.isArray(state.dossier.cases) ? state.dossier.cases : [];
    const editor = state.permissions.canWrite
      ? renderCaseForm(cases.find((item) => String(item.id) === String(state.editingCaseId)) || null)
      : '';
    const items = cases.length ? cases.map((item) => {
      if (String(item.id) === String(state.editingCaseId)) {
        return `<article class="mpd-record-card">${renderCaseForm(item)}</article>`;
      }
      const linked = (state.dossier.attachments || []).filter((file) => String(file.caseId) === String(item.id));
      const evidenceFiles = linked.length ? `<div class="mpd-case-files"><b>الأدلة المرفقة</b>${linked.map((file) => `<button type="button" class="mpd-file-link" data-mpd-preview="${escapeHtml(file.id)}">${escapeHtml(file.fileName)}</button>`).join('')}</div>` : '';
      return `<article class="mpd-record-card mpd-case-card">
        <header class="mpd-record-card-head"><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(caseStatusLabel(item.status))} · ${escapeHtml(formatDate(item.createdAt))} · ${escapeHtml(item.createdByName || item.createdByCode || 'القيادة')}</span></div>
          ${state.permissions.canWrite ? `<button class="mpd-text-button" type="button" data-mpd-case-edit="${escapeHtml(item.id)}">تعديل</button>` : ''}
        </header>
        ${item.details ? `<div class="mpd-case-section"><b>التفاصيل</b><p class="mpd-record-body">${escapeHtml(item.details)}</p></div>` : ''}
        ${item.evidence ? `<div class="mpd-case-section"><b>الأدلة</b><p class="mpd-record-body">${escapeHtml(item.evidence)}</p></div>` : ''}
        ${item.finalDecision ? `<div class="mpd-case-decision"><b>القرار النهائي</b><p>${escapeHtml(item.finalDecision)}</p></div>` : ''}
        ${evidenceFiles}
      </article>`;
    }).join('') : '<div class="mpd-empty mpd-tab-empty">لا توجد قضايا مرتبطة بهذا العسكري.</div>';
    return `<div class="mpd-tab-content"><div class="mpd-tab-heading"><div><span class="mpd-kicker">CASE RECORDS</span><h4>القضايا المرتبطة</h4></div><span class="mpd-count">${cases.length}</span></div>${state.permissions.canWrite && !state.editingCaseId ? editor : ''}<div class="mpd-record-list">${items}</div></div>`;
  }

  function renderTimeline() {
    const events = state.dossier && Array.isArray(state.dossier.timeline) ? state.dossier.timeline : [];
    const labels = { PROMOTION: 'ترقية', TRANSFER: 'نقل', POSITION: 'تغيير منصب', SECTOR: 'تغيير قطاع', ADMIN_ACTION: 'إجراء إداري' };
    const form = state.permissions.canWrite ? `<form class="mpd-editor-form" data-mpd-form="timeline">
      <div class="mpd-form-grid"><label>نوع الإجراء<select name="type">
        <option value="PROMOTION">ترقية</option><option value="TRANSFER">نقل</option><option value="POSITION">تغيير منصب</option><option value="SECTOR">تغيير قطاع</option><option value="ADMIN_ACTION">إجراء إداري</option>
      </select></label><label>تاريخ الإجراء<input name="eventAt" type="date" required value="${new Date().toISOString().slice(0, 10)}"></label></div>
      <label>التفاصيل<textarea name="description" maxlength="5000" required placeholder="اكتب ملخص الإجراء أو سبب التغيير"></textarea></label>
      <div class="mpd-form-actions"><button class="mpd-action-button is-primary" type="submit">إضافة إلى السجل</button></div>
    </form>` : '';
    const items = events.length ? events.map((entry) => `<article class="mpd-timeline-entry">
      <span class="mpd-timeline-dot" aria-hidden="true"></span><div class="mpd-timeline-copy"><header><strong>${escapeHtml(labels[entry.type] || 'إجراء')}</strong><time>${escapeHtml(formatDate(entry.eventAt))}</time></header>
        <p class="mpd-record-body">${escapeHtml(entry.description)}</p><small>نفّذ بواسطة ${escapeHtml(entry.actorName || entry.actorCode || 'حساب القيادة')}${entry.actorCode ? ` · ${escapeHtml(entry.actorCode)}` : ''}</small>
      </div></article>`).join('') : '<div class="mpd-empty mpd-tab-empty">لا توجد إجراءات مسجلة في السجل الزمني.</div>';
    return `<div class="mpd-tab-content"><div class="mpd-tab-heading"><div><span class="mpd-kicker">SERVICE HISTORY</span><h4>السجل الزمني</h4></div><span class="mpd-count">${events.length}</span></div>${form}<div class="mpd-timeline">${items}</div></div>`;
  }

  function renderAttachments() {
    const files = state.dossier && Array.isArray(state.dossier.attachments) ? state.dossier.attachments : [];
    const cases = state.dossier && Array.isArray(state.dossier.cases) ? state.dossier.cases : [];
    const form = state.permissions.canWrite ? `<form class="mpd-editor-form mpd-upload-form" data-mpd-form="attachment">
      <label>ربط المرفق بقضية<select name="caseId"><option value="">ملف العسكري فقط</option>${cases.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join('')}</select></label>
      <label class="mpd-file-picker">اختر صورة أو ملفًا<input name="file" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required><span>حد أقصى 4 ميغابايت · صور وPDF وTXT وCSV وDOCX وXLSX</span></label>
      <div class="mpd-form-actions"><button class="mpd-action-button is-primary" type="submit">رفع المرفق</button></div>
    </form>` : '';
    const items = files.length ? files.map((file) => `<article class="mpd-attachment-card">
      <span class="mpd-attachment-icon"><i class="fa-solid ${String(file.mimeType).startsWith('image/') ? 'fa-image' : file.mimeType === 'application/pdf' ? 'fa-file-pdf' : 'fa-file-lines'}" aria-hidden="true"></i></span>
      <div class="mpd-attachment-info"><strong>${escapeHtml(file.fileName)}</strong><span>${escapeHtml((file.size / 1024).toFixed(1))} KB · ${escapeHtml(formatDate(file.createdAt))} · ${escapeHtml(file.uploadedByName || file.uploadedByCode || 'القيادة')}${file.caseId ? ` · قضية: ${escapeHtml(cases.find((item) => String(item.id) === String(file.caseId))?.title || 'مرتبطة')}` : ''}</span></div>
      <div class="mpd-inline-actions"><button class="mpd-text-button" type="button" data-mpd-preview="${escapeHtml(file.id)}">عرض / تنزيل</button>${state.permissions.canDelete ? `<button class="mpd-text-button is-danger" type="button" data-mpd-file-delete="${escapeHtml(file.id)}">حذف</button>` : ''}</div>
    </article>`).join('') : '<div class="mpd-empty mpd-tab-empty">لا توجد مرفقات محفوظة لهذا الملف.</div>';
    return `<div class="mpd-tab-content"><div class="mpd-tab-heading"><div><span class="mpd-kicker">SECURE ATTACHMENTS</span><h4>مرفقات الملف</h4></div><span class="mpd-count">${files.length}</span></div>${form}<div class="mpd-record-list">${items}</div></div>`;
  }

  function renderPreview() {
    if (!state.preview) return '';
    const preview = state.preview;
    const content = preview.text !== undefined
      ? `<pre class="mpd-preview-text">${escapeHtml(preview.text)}</pre>`
      : preview.mimeType.startsWith('image/')
        ? `<img class="mpd-preview-image" src="${escapeHtml(preview.url)}" alt="${escapeHtml(preview.fileName)}">`
        : preview.mimeType === 'application/pdf'
          ? `<iframe class="mpd-preview-pdf" src="${escapeHtml(preview.url)}" title="${escapeHtml(preview.fileName)}"></iframe>`
          : '<p class="mpd-preview-note">لا تتوفر معاينة داخلية لهذا النوع. استخدم زر التنزيل.</p>';
    return `<div class="mpd-preview" role="dialog" aria-modal="true" aria-label="معاينة المرفق"><div class="mpd-preview-card"><header><strong>${escapeHtml(preview.fileName)}</strong><div><a class="mpd-action-button is-primary" href="${escapeHtml(preview.url)}" download="${escapeHtml(preview.fileName)}">تنزيل</a><button class="mpd-action-button is-muted" type="button" data-mpd-preview-close>إغلاق</button></div></header><div class="mpd-preview-body">${content}</div></div></div>`;
  }

  function renderTabContent() {
    if (!state.dossier) return '<div class="mpd-tab-panel" role="tabpanel"><span class="mpd-spinner" aria-hidden="true"></span><strong>جارٍ تحميل سجلات الملف</strong></div>';
    return ({ notes: renderNotes, cases: renderCases, timeline: renderTimeline, attachments: renderAttachments })[state.activeTab]() + renderPreview();
  }

  function renderProfile() {
    if (state.detailLoading) {
      profileNode.innerHTML = '<div class="mpd-empty mpd-profile-empty"><span class="mpd-spinner" aria-hidden="true"></span><strong>جارٍ فتح الملف</strong><span>يُتحقق من نطاق الوصول على الخادم.</span></div>';
      return;
    }
    if (!state.detail) {
      profileNode.innerHTML = '<div class="mpd-empty mpd-profile-empty"><i class="fa-solid fa-folder-open" aria-hidden="true"></i><strong>اختر سجلًا لعرض الملف</strong><span>تظهر هنا البيانات التي تسمح بها صلاحيات حسابك.</span></div>';
      return;
    }
    const person = state.detail;
    const unit = person.battalion ? `${person.battalion.code || ''}${person.battalion.name ? ` · ${person.battalion.name}` : ''}` : 'غير مسجل';
    const facts = [
      ['الكود العسكري', person.publicCode || 'غير مسجل', 'code'],
      ['الرتبة', person.rankLabel || person.rank || 'غير مسجل'],
      ['القطاع', person.battalion && person.battalion.sector || 'غير مسجل'],
      ['الكتيبة', unit],
      ['المنصب', person.position || 'غير مسجل'],
      ['الحالة العسكرية', displayStatus(person.statusLabel)],
      ['تاريخ الانتساب', formatDate(person.createdAt)]
    ].map(([label, value, kind]) => `<div class="mpd-fact${kind === 'code' ? ' is-code' : ''}"><span>${escapeHtml(label)}</span><b>${kind === 'code' ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value)}</b></div>`).join('');
    const tabs = Object.entries(tabLabels).map(([key, label]) => `<button class="mpd-tab${state.activeTab === key ? ' is-active' : ''}" type="button" role="tab" aria-selected="${state.activeTab === key}" aria-controls="mpd-tab-panel" data-mpd-tab="${key}">${escapeHtml(label)}</button>`).join('');
    profileNode.innerHTML = `<article class="mpd-profile-card">
      <header class="mpd-profile-hero">${photoMarkup(person)}<div class="mpd-profile-identity"><span class="mpd-kicker">PERSONNEL FILE // ${escapeHtml(person.publicCode || 'NO CODE')}</span><h2>${escapeHtml(person.name || 'الهوية غير متاحة حسب الصلاحية')}</h2><p>${escapeHtml(person.rankLabel || person.rank || 'رتبة غير مسجلة')}</p><span class="mpd-profile-status ${statusTone(person.statusLabel)}"><i class="fa-solid fa-circle" aria-hidden="true"></i>${escapeHtml(displayStatus(person.statusLabel))}</span></div></header>
      <section class="mpd-facts" aria-label="بيانات الملف">${facts}</section>
      <section class="mpd-records"><header class="mpd-section-head"><div><span class="mpd-kicker">RECORD SECTIONS</span><h3>سجل الملف</h3></div><span class="mpd-record-mark">01</span></header>
        <div class="mpd-tabs" role="tablist" aria-label="أقسام الملف">${tabs}</div>
        <div id="mpd-tab-panel" class="mpd-tab-panel" role="tabpanel" aria-live="polite">${renderTabContent()}</div>
      </section>
      <p class="mpd-scope-note"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> تُعرض بيانات هذا الملف وفق صلاحيات الحساب ونطاقه المعتمد.</p>
    </article>`;
    profileNode.querySelectorAll('[data-mpd-photo]').forEach((image) => {
      image.addEventListener('error', () => image.closest('.mpd-portrait')?.classList.add('photo-error'), { once: true });
      image.addEventListener('load', () => image.closest('.mpd-portrait')?.classList.add('photo-loaded'), { once: true });
    });
  }

  function render() {
    renderRoster();
    renderProfile();
  }

  async function loadDossier() {
    if (!state.selectedId || !state.detail) return { ok: false };
    const requestedPersonId = state.selectedId;
    const response = await emit('mpd:dossier:get', { personnelId: requestedPersonId });
    if (requestedPersonId !== state.selectedId) return { ok: false, stale: true };
    if (!response || response.ok !== true) {
      state.dossier = { notes: [], cases: [], timeline: [], attachments: [] };
      state.permissions = { canWrite: false, canDelete: false };
      setStatus(response && response.message || 'تعذر تحميل سجلات الملف العسكري.', 'error');
      renderProfile();
      return response || { ok: false };
    }
    state.dossier = response.dossier || { notes: [], cases: [], timeline: [], attachments: [] };
    state.permissions = response.permissions || { canWrite: false, canDelete: false };
    setStatus('');
    renderProfile();
    return response;
  }

  async function finishMutation(eventName, payload, successMessage) {
    setStatus('جارٍ حفظ التغيير في قاعدة البيانات…');
    const response = await emit(eventName, payload);
    if (!response || response.ok !== true) {
      setStatus(response && response.message || 'تعذر حفظ التغيير.', 'error');
      return false;
    }
    state.editingNoteId = '';
    state.editingCaseId = '';
    if (successMessage) setStatus(successMessage);
    await loadDossier();
    if (successMessage) setStatus(successMessage);
    return true;
  }

  function getAckBytes(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Uint8Array.from(value.data);
    if (Array.isArray(value)) return Uint8Array.from(value);
    return null;
  }

  async function previewAttachment(attachmentId) {
    const response = await emit('mpd:attachment:download', { attachmentId }, 30000);
    if (!response || response.ok !== true) {
      setStatus(response && response.message || 'تعذر تنزيل المرفق.', 'error');
      return;
    }
    const bytes = getAckBytes(response.bytes);
    if (!bytes || !bytes.length) {
      setStatus('وصل سجل المرفق دون محتواه. أعد المحاولة.', 'error');
      return;
    }
    if (state.preview && state.preview.url) URL.revokeObjectURL(state.preview.url);
    const file = response.attachment || {};
    const mimeType = String(file.mimeType || 'application/octet-stream');
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const preview = { url, mimeType, fileName: file.fileName || 'attachment' };
    if (mimeType === 'text/plain' || mimeType === 'text/csv') preview.text = new TextDecoder().decode(bytes);
    state.preview = preview;
    renderProfile();
  }

  async function loadPersonDetail(id) {
    const requestId = ++state.detailRequestId;
    state.selectedId = String(id || '');
    state.detail = null;
    state.dossier = null;
    state.permissions = { canWrite: false, canDelete: false };
    state.editingNoteId = '';
    state.editingCaseId = '';
    if (state.preview && state.preview.url) URL.revokeObjectURL(state.preview.url);
    state.preview = null;
    state.detailLoading = true;
    state.activeTab = 'notes';
    render();
    const response = await emit('ibp:directory:detail', { id: state.selectedId });
    if (requestId !== state.detailRequestId) return;
    state.detailLoading = false;
    if (!response || response.ok !== true) {
      state.error = response && response.message || 'تعذر فتح الملف ضمن صلاحيات الحساب.';
      state.selectedId = '';
      setStatus(state.error, 'error');
    } else {
      state.detail = response.person || null;
      state.error = '';
      setStatus('');
    }
    render();
    if (state.detail) {
      const dossierResponse = await loadDossier();
      if (requestId !== state.detailRequestId) return;
      if (!dossierResponse || dossierResponse.ok !== true) return;
    }
  }

  pane.addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-mpd-form]');
    if (!form) return;
    event.preventDefault();
    const kind = form.dataset.mpdForm;
    if (kind === 'note') {
      const noteId = form.dataset.mpdId || '';
      await finishMutation(noteId ? 'mpd:note:update' : 'mpd:note:create', {
        personnelId: state.selectedId,
        noteId,
        body: form.elements.body.value
      }, noteId ? 'تم تحديث الملاحظة.' : 'تمت إضافة الملاحظة.');
      return;
    }
    if (kind === 'case') {
      const caseId = form.dataset.mpdId || '';
      const value = {
        title: form.elements.title.value,
        details: form.elements.details.value,
        evidence: form.elements.evidence.value,
        status: form.elements.status.value,
        finalDecision: form.elements.finalDecision.value
      };
      await finishMutation(caseId ? 'mpd:case:update' : 'mpd:case:create', {
        personnelId: state.selectedId,
        caseId,
        case: value
      }, caseId ? 'تم تحديث القضية.' : 'تم إنشاء القضية.');
      return;
    }
    if (kind === 'timeline') {
      await finishMutation('mpd:timeline:create', {
        personnelId: state.selectedId,
        type: form.elements.type.value,
        eventAt: form.elements.eventAt.value,
        description: form.elements.description.value
      }, 'تمت إضافة الإجراء إلى السجل الزمني.');
      return;
    }
    if (kind === 'attachment') {
      const file = form.elements.file.files && form.elements.file.files[0];
      if (!file) return setStatus('اختر ملفًا قبل الرفع.', 'error');
      if (file.size > 4 * 1024 * 1024) return setStatus('حجم الملف يتجاوز الحد الأقصى البالغ 4 ميغابايت.', 'error');
      setStatus('جارٍ رفع الملف وحفظه في قاعدة البيانات…');
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const response = await emit('mpd:attachment:upload', {
          personnelId: state.selectedId,
          caseId: form.elements.caseId.value,
          fileName: file.name,
          mimeType: file.type,
          bytes
        }, 30000);
        if (!response || response.ok !== true) {
          setStatus(response && response.message || 'تعذر رفع المرفق.', 'error');
          return;
        }
        form.reset();
        await loadDossier();
        setStatus('تم رفع المرفق وحفظه.');
      } catch (_error) {
        setStatus('تعذر قراءة الملف أو رفعه. تحقق من الاتصال ثم حاول مرة أخرى.', 'error');
      }
    }
  });

  async function loadRoster() {
    const requestId = ++state.requestId;
    state.loading = true;
    state.error = '';
    setStatus('');
    render();
    const response = await emit('ibp:directory:list', {});
    if (requestId !== state.requestId) return;
    state.loading = false;
    state.loaded = !!response && response.ok === true;
    if (!response || response.ok !== true) {
      state.people = [];
      state.selectedId = '';
      state.detail = null;
      state.error = response && response.message || 'تعذر تحميل السجل العسكري.';
      setStatus(state.error, 'error');
      render();
      return;
    }
    state.people = Array.isArray(response.people) ? response.people : [];
    if (!state.people.some((person) => String(person.id) === String(state.selectedId))) {
      state.selectedId = state.people[0] ? String(state.people[0].id) : '';
      state.detail = null;
    }
    render();
    if (state.selectedId) await loadPersonDetail(state.selectedId);
  }

  pane.addEventListener('click', (event) => {
    const personButton = event.target.closest('[data-mpd-person]');
    if (personButton) {
      loadPersonDetail(personButton.getAttribute('data-mpd-person'));
      return;
    }
    const tabButton = event.target.closest('[data-mpd-tab]');
    if (tabButton && Object.prototype.hasOwnProperty.call(tabLabels, tabButton.dataset.mpdTab)) {
      state.activeTab = tabButton.dataset.mpdTab;
      renderProfile();
      return;
    }
    if (event.target.closest('[data-mpd-cancel-edit]')) {
      state.editingNoteId = '';
      state.editingCaseId = '';
      renderProfile();
      return;
    }
    const noteEdit = event.target.closest('[data-mpd-note-edit]');
    if (noteEdit) {
      state.editingNoteId = noteEdit.dataset.mpdNoteEdit;
      renderProfile();
      return;
    }
    const caseEdit = event.target.closest('[data-mpd-case-edit]');
    if (caseEdit) {
      state.editingCaseId = caseEdit.dataset.mpdCaseEdit;
      renderProfile();
      return;
    }
    const noteDelete = event.target.closest('[data-mpd-note-delete]');
    if (noteDelete) {
      if (!window.confirm('هل تريد حذف هذه الملاحظة نهائيًا؟')) return;
      finishMutation('mpd:note:delete', {
        personnelId: state.selectedId,
        noteId: noteDelete.dataset.mpdNoteDelete
      }, 'تم حذف الملاحظة.');
      return;
    }
    const fileDelete = event.target.closest('[data-mpd-file-delete]');
    if (fileDelete) {
      if (!window.confirm('هل تريد حذف هذا المرفق نهائيًا؟')) return;
      (async () => {
        setStatus('جارٍ حذف المرفق…');
        const response = await emit('mpd:attachment:delete', { attachmentId: fileDelete.dataset.mpdFileDelete });
        if (!response || response.ok !== true) {
          setStatus(response && response.message || 'تعذر حذف المرفق.', 'error');
          return;
        }
        await loadDossier();
        setStatus('تم حذف المرفق.');
      })();
      return;
    }
    if (event.target.closest('[data-mpd-preview-close]')) {
      if (state.preview && state.preview.url) URL.revokeObjectURL(state.preview.url);
      state.preview = null;
      renderProfile();
      return;
    }
    const previewButton = event.target.closest('[data-mpd-preview]');
    if (previewButton) {
      previewAttachment(previewButton.dataset.mpdPreview);
    }
  });
  searchNode.addEventListener('input', () => {
    state.search = searchNode.value;
    renderRoster();
  });
  pane.querySelector('#mpd-refresh').addEventListener('click', loadRoster);

  window.openMilitaryPersonnelDossier = function (button) {
    if (typeof showPane === 'function') {
      showPane('military-personnel-dossier', button || document.getElementById('military-personnel-dossier-nav'));
    }
    loadRoster();
  };
  if (window.blackRidgeSocket) {
    window.blackRidgeSocket.on('connect', () => {
      if (pane.classList.contains('active')) loadRoster();
    });
  }
})();
