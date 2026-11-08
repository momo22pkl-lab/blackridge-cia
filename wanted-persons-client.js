'use strict';

(function () {
  const byId = (id) => document.getElementById(id);
  const state = { cases: [], activeId: '', busy: false, lastList: null };
  const severityLabels = { LOW: 'منخفضة', MEDIUM: 'متوسطة', HIGH: 'عالية', CRITICAL: 'حرجة' };
  const statusLabels = { WANTED: 'مطلوب', UNDER_INVESTIGATION: 'قيد التحقيق', DETAINED: 'موقوف', CLOSED: 'مغلق' };

  function request(event, payload) {
    const socket = window.blackRidgeSocket;
    if (!socket || typeof socket.emit !== 'function') return Promise.reject(new Error('اتصال الخدمة غير جاهز.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('انتهت مهلة الاتصال؛ أعد تحميل السجل قبل تكرار العملية.'));
      }, 20000);
      socket.emit(event, payload || {}, (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (!result || typeof result !== 'object') return reject(new Error('لم يصل رد صالح من الخادم.'));
        resolve(result);
      });
    });
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setStatus(message, type) {
    const node = byId('wp-status');
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
    node.className = 'wp-status' + (type ? ' wp-status-' + type : '');
  }

  function severityBadge(value) {
    const key = String(value || '').toUpperCase();
    return make('span', 'wp-badge wp-severity-' + key.toLowerCase(), 'الخطورة: ' + (severityLabels[key] || 'غير محددة'));
  }

  function statusBadge(value) {
    const key = String(value || '').toUpperCase();
    return make('span', 'wp-badge wp-status-' + key.toLowerCase(), statusLabels[key] || 'غير محددة');
  }

  function photoNode(imageUrl, name, className) {
    const wrapper = make('div', className);
    if (!imageUrl) {
      const icon = make('i', 'fa-solid fa-user-secret');
      icon.setAttribute('aria-hidden', 'true');
      wrapper.append(icon);
      return wrapper;
    }
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = name ? 'صورة ' + name : 'الصورة الأساسية';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.onerror = () => {
      image.remove();
      const icon = make('i', 'fa-solid fa-user-secret');
      icon.setAttribute('aria-hidden', 'true');
      wrapper.append(icon);
    };
    wrapper.append(image);
    return wrapper;
  }

  function renderCases(container, cases, emptyText) {
    container.replaceChildren();
    if (!cases || !cases.length) {
      container.append(make('p', 'wp-muted', emptyText));
      return;
    }
    for (const item of cases) {
      const row = make('article', 'wp-case-row');
      row.append(make('span', 'wp-case-number', item.caseNumber || item.id || '—'));
      row.append(make('span', 'wp-case-title', item.title || 'قضية بلا عنوان'));
      const meta = [item.status, item.classification].filter(Boolean).join(' · ');
      row.append(make('span', 'wp-case-meta', meta || 'قضية مرتبطة بالسجل'));
      container.append(row);
    }
  }

  function renderCards(data) {
    state.lastList = data;
    state.cases = Array.isArray(data.availableCases) ? data.availableCases : [];
    const grid = byId('wp-person-grid');
    grid.replaceChildren();
    byId('wp-add-button').hidden = !data.permissions?.canManage;
    byId('wp-results-meta').textContent = 'عدد الملفات: ' + (Number(data.total) || 0);
    if (!Array.isArray(data.items) || !data.items.length) {
      grid.append(make('div', 'wp-empty', 'لا توجد ملفات مطابقة للبحث. لا تُعرض سجلات تجريبية؛ أضف ملفًا حقيقيًا مخولًا أو غيّر عوامل التصفية.'));
      return;
    }
    for (const person of data.items) {
      const card = make('button', 'wp-person-card');
      card.type = 'button';
      card.setAttribute('aria-label', 'فتح الملف التحقيقي ' + (person.fullName || person.fileNumber || ''));
      card.append(photoNode(person.imageUrl, person.fullName, 'wp-card-photo'));
      const copy = make('span', 'wp-card-copy');
      copy.append(make('span', 'wp-card-name', person.fullName || 'اسم غير متاح'));
      copy.append(make('span', 'wp-card-file', person.fileNumber || '—'));
      const meta = make('span', 'wp-card-meta');
      meta.append(severityBadge(person.severity), statusBadge(person.status));
      copy.append(meta);
      card.append(copy);
      card.addEventListener('click', () => openDetail(person.id));
      grid.append(card);
    }
  }

  function currentFilters() {
    return {
      name: byId('wp-filter-name').value.trim(),
      fileNumber: byId('wp-filter-file').value.trim(),
      severity: byId('wp-filter-severity').value,
      status: byId('wp-filter-status').value
    };
  }

  async function load(keepStatus, force) {
    if (state.busy && !force) return;
    try {
      const result = await request('wanted-persons:list', currentFilters());
      if (!result.ok) {
        byId('wp-add-button').hidden = true;
        byId('wp-results-meta').textContent = '';
        byId('wp-person-grid').replaceChildren(make('div', 'wp-empty', result.message || 'تعذر تحميل السجل.'));
        setStatus(result.message || 'تعذر تحميل سجل المطلوبين.', 'error');
        return result;
      }
      renderCards(result);
      if (!keepStatus) setStatus('', '');
      return result;
    } catch (error) {
      byId('wp-person-grid').replaceChildren(make('div', 'wp-empty', error.message));
      setStatus(error.message, 'error');
      return { ok: false };
    }
  }

  function showOnly(id) {
    byId('wp-list-section').hidden = id !== 'list';
    byId('wp-detail').hidden = id !== 'detail';
    byId('wp-editor').hidden = id !== 'editor';
  }

  async function openDetail(id) {
    setStatus('جارٍ تحميل الملف التحقيقي…', '');
    try {
      const result = await request('wanted-persons:detail', { id });
      if (!result.ok) {
        setStatus(result.message || 'تعذر تحميل الملف.', 'error');
        return false;
      }
      const person = result.person;
      state.activeId = person.id;
      byId('wp-detail-title').textContent = person.fullName || 'اسم غير متاح';
      byId('wp-detail-file').textContent = 'رقم الملف: ' + (person.fileNumber || '—');
      const photo = byId('wp-profile-photo');
      const nextPhoto = photoNode(person.imageUrl, person.fullName, 'wp-profile-photo');
      nextPhoto.id = 'wp-profile-photo';
      photo.replaceWith(nextPhoto);
      const badges = byId('wp-detail-badges');
      badges.replaceChildren(severityBadge(person.severity), statusBadge(person.status));
      const aliases = byId('wp-detail-aliases');
      aliases.replaceChildren();
      if (person.aliases?.length) {
        for (const alias of person.aliases) aliases.append(make('li', '', alias));
      } else {
        aliases.append(make('li', 'wp-muted', 'لا توجد أسماء مستعارة مسجلة.'));
      }
      renderCases(byId('wp-detail-cases'), result.relatedCases, 'لا توجد قضايا مرتبطة بهذا الملف.');
      byId('wp-detail-notes').textContent = person.notes || 'لا توجد ملاحظات مسجلة.';
      byId('wp-detail-details').textContent = person.details || 'لا توجد تفاصيل مسجلة.';
      byId('wp-edit-button').hidden = !result.permissions?.canManage;
      showOnly('detail');
      setStatus('', '');
      return true;
    } catch (error) {
      setStatus(error.message, 'error');
      return false;
    }
  }

  function fillCaseOptions(selectedIds) {
    const container = byId('wp-case-options');
    container.replaceChildren();
    if (!state.cases.length) {
      container.append(make('span', 'wp-muted', 'لا توجد قضايا حالية متاحة للربط.'));
      return;
    }
    const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
    for (const item of state.cases) {
      const label = make('label', 'wp-case-option');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'caseIds';
      input.value = item.id;
      input.checked = selected.has(item.id);
      const labelText = [item.caseNumber || item.id, item.title, item.status].filter(Boolean).join(' · ');
      label.append(input, make('span', '', labelText));
      container.append(label);
    }
  }

  function openEditor(person) {
    if (!state.lastList?.permissions?.canManage) return;
    state.activeId = person?.id || '';
    const form = byId('wp-person-form');
    form.reset();
    byId('wp-editor-title').textContent = person ? 'تعديل الملف التحقيقي' : 'إنشاء ملف تحقيق';
    byId('wp-person-id').value = person?.id || '';
    byId('wp-full-name').value = person?.fullName || '';
    byId('wp-file-number').value = person?.fileNumber || '';
    byId('wp-image-url').value = person?.imageUrl || '';
    byId('wp-severity').value = person?.severity || '';
    byId('wp-status').value = person?.status || 'WANTED';
    byId('wp-aliases').value = Array.isArray(person?.aliases) ? person.aliases.join('\n') : '';
    byId('wp-notes').value = person?.notes || '';
    byId('wp-details').value = person?.details || '';
    fillCaseOptions(person?.caseIds || []);
    showOnly('editor');
    byId('wp-full-name').focus();
  }

  async function editCurrent() {
    try {
      const result = await request('wanted-persons:detail', { id: state.activeId });
      if (!result.ok) return setStatus(result.message || 'تعذر تحميل الملف للتعديل.', 'error');
      openEditor(result.person);
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function saveForm(event) {
    event.preventDefault();
    if (state.busy) return;
    state.busy = true;
    const form = byId('wp-person-form');
    const payload = {
      id: byId('wp-person-id').value || undefined,
      fullName: byId('wp-full-name').value,
      fileNumber: byId('wp-file-number').value,
      imageUrl: byId('wp-image-url').value,
      severity: byId('wp-severity').value,
      status: byId('wp-status').value,
      aliases: byId('wp-aliases').value.split('\n').map((value) => value.trim()).filter(Boolean),
      caseIds: [...byId('wp-case-options').querySelectorAll('input[name="caseIds"]:checked')].map((input) => input.value),
      notes: byId('wp-notes').value,
      details: byId('wp-details').value
    };
    try {
      const result = await request('wanted-persons:save', payload);
      if (!result.ok) {
        setStatus(result.message || 'تعذر حفظ الملف.', 'error');
        return;
      }
      const savedId = result.person?.id;
      showOnly('list');
      const refreshed = await load(true, true);
      if (!refreshed?.ok) {
        setStatus('تم الحفظ، لكن تعذر تحديث سجل المطلوبين.', 'error');
        return;
      }
      if (savedId) {
        const opened = await openDetail(savedId);
        if (opened) setStatus('تم حفظ الملف في قاعدة البيانات.', 'success');
      } else {
        setStatus('تم حفظ الملف في قاعدة البيانات.', 'success');
      }
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      state.busy = false;
      if (form) form.querySelector('button[type="submit"]').disabled = false;
    }
  }

  function bind() {
    byId('wp-search-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      showOnly('list');
      await load(false);
    });
    byId('wp-add-button').addEventListener('click', () => openEditor(null));
    byId('wp-back-button').addEventListener('click', () => { showOnly('list'); setStatus('', ''); });
    byId('wp-edit-button').addEventListener('click', editCurrent);
    byId('wp-cancel-button').addEventListener('click', () => {
      if (state.activeId) showOnly('detail');
      else showOnly('list');
      setStatus('', '');
    });
    byId('wp-person-form').addEventListener('submit', saveForm);
  }

  function boot() {
    const nav = byId('wanted-persons-nav');
    const pane = byId('wanted-persons');
    if (!nav || !pane) return;
    nav.addEventListener('click', () => load(false));
    if (window.blackRidgeSocket && typeof window.blackRidgeSocket.on === 'function') {
      window.blackRidgeSocket.on('connect', () => {
        if (pane.classList.contains('active')) load(false);
      });
    }
    bind();
    if (pane.classList.contains('active')) load(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
