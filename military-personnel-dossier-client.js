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
  const emit = (eventName, payload) => {
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
      const timer = setTimeout(() => finish({ ok: false, message: 'انتهت مهلة تحميل السجل. حاول التحديث.' }), 10000);
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
    const tabIcon = { notes: 'fa-note-sticky', cases: 'fa-folder-open', timeline: 'fa-clock-rotate-left', attachments: 'fa-paperclip' }[state.activeTab];
    profileNode.innerHTML = `<article class="mpd-profile-card">
      <header class="mpd-profile-hero">${photoMarkup(person)}<div class="mpd-profile-identity"><span class="mpd-kicker">PERSONNEL FILE // ${escapeHtml(person.publicCode || 'NO CODE')}</span><h2>${escapeHtml(person.name || 'الهوية غير متاحة حسب الصلاحية')}</h2><p>${escapeHtml(person.rankLabel || person.rank || 'رتبة غير مسجلة')}</p><span class="mpd-profile-status ${statusTone(person.statusLabel)}"><i class="fa-solid fa-circle" aria-hidden="true"></i>${escapeHtml(displayStatus(person.statusLabel))}</span></div></header>
      <section class="mpd-facts" aria-label="بيانات الملف">${facts}</section>
      <section class="mpd-records"><header class="mpd-section-head"><div><span class="mpd-kicker">RECORD SECTIONS</span><h3>سجل الملف</h3></div><span class="mpd-record-mark">01</span></header>
        <div class="mpd-tabs" role="tablist" aria-label="أقسام الملف">${tabs}</div>
        <div id="mpd-tab-panel" class="mpd-tab-panel" role="tabpanel" aria-live="polite"><i class="fa-solid ${tabIcon}" aria-hidden="true"></i><strong>${escapeHtml(tabLabels[state.activeTab])}</strong><span>لا توجد سجلات بعد. مساحة القسم جاهزة للربط في المرحلة التالية.</span></div>
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

  async function loadPersonDetail(id) {
    const requestId = ++state.detailRequestId;
    state.selectedId = String(id || '');
    state.detail = null;
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
  }

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
