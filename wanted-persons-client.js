'use strict';

(function () {
  const byId = (id) => document.getElementById(id);
  const state = {
    cases: [], activeId: '', busy: false, lastList: null, activePerson: null, board: null, personPermissions: {},
    boardNodes: [], boardDrag: null, boardScale: 1, boardX: 0, boardY: 0
  };
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

  function lockSubmission(form) {
    if (state.busy) return null;
    state.busy = true;
    const submit = form?.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    return () => {
      state.busy = false;
      if (submit) submit.disabled = false;
    };
  }

  async function confirmRefreshAfterWrite(successMessage) {
    if (!await loadInvestigation(state.activeId)) {
      setStatus('تم حفظ التغيير، لكن تعذر تحديث العرض. أعد فتح الملف للتحقق من البيانات المحفوظة.', 'error');
      return false;
    }
    setStatus(successMessage, 'success');
    return true;
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
    byId('wp-add-button').hidden = !data.permissions?.canCreate;
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
      copy.append(make('small', 'wp-record-meta', contributorText(
        person.createdByName, person.createdByCode, person.createdByRank, person.createdAt, 'أنشأ الملف'
      )));
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
      byId('wp-detail-author').textContent = contributorText(
        person.createdByName, person.createdByCode, person.createdByRank, person.createdAt, 'أنشأ الملف'
      );
      state.personPermissions = result.permissions || {};
      byId('wp-edit-button').hidden = !state.personPermissions.canEdit;
      byId('wp-delete-button').hidden = !state.personPermissions.canDelete;
      state.activePerson = person;
      showOnly('detail');
      if (!await loadInvestigation(person.id)) return false;
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
    if (person ? !state.personPermissions.canEdit : !state.lastList?.permissions?.canCreate) return;
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
      state.personPermissions = result.permissions || {};
      openEditor(result.person);
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function deleteCurrent() {
    if (!state.personPermissions.canDelete) return;
    if (!window.confirm('سيُحذف الملف نهائيًا من PostgreSQL، بما في ذلك الأدلة والملاحظات والأحداث المرتبطة. سيبقى هذا الإجراء محصورًا بمنشئ الملف والقائد الرئيس. هل تريد المتابعة؟')) return;
    const unlock = lockSubmission();
    if (!unlock) return;
    try {
      const result = await request('wanted-persons:delete', { id: state.activeId });
      if (!result.ok) throw new Error(result.message || 'تعذر حذف الملف.');
      state.activeId = '';
      state.activePerson = null;
      state.board = null;
      showOnly('list');
      const refreshed = await load(true, true);
      if (!refreshed?.ok) throw new Error('حُذف الملف، لكن تعذر تحديث السجل.');
      setStatus('تم حذف الملف وسجلات التحقيق المرتبطة به.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      unlock();
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

  const evidenceLabels = { IMAGE: 'صورة / دليل', VEHICLE: 'مركبة', LOCATION: 'موقع', PERSON: 'شخص / صورة ملف', DOCUMENT: 'مستند', OTHER: 'أخرى' };
  const evidenceIcons = { IMAGE: 'fa-image', VEHICLE: 'fa-car', LOCATION: 'fa-location-dot', PERSON: 'fa-user', DOCUMENT: 'fa-file-lines', OTHER: 'fa-box-archive' };
  const auditLabels = {
    CREATED: 'إنشاء ملف', UPDATED: 'تعديل ملف', EVIDENCE_CREATED: 'إضافة دليل', EVIDENCE_UPDATED: 'تعديل دليل',
    EVIDENCE_DELETED: 'حذف دليل', EVIDENCE_LINKED: 'ربط دليل بقضية', EVIDENCE_UNLINKED: 'فك ارتباط دليل',
    NOTE_CREATED: 'إضافة ملاحظة', NOTE_UPDATED: 'تعديل ملاحظة', NOTE_DELETED: 'حذف ملاحظة', TIMELINE_CREATED: 'إضافة حدث زمني'
  };

  function localDateTime(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function readableDate(value) {
    if (!value) return 'غير محدد';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ar');
  }

  function contributorText(name, code, rank, createdAt, action) {
    return (action || 'أضيف') + ' بواسطة ' + (name || 'غير معروف') +
      ' · الكود العسكري: ' + (code || 'غير متاح') +
      ' · الرتبة: ' + (rank || 'غير محددة') +
      ' · ' + readableDate(createdAt);
  }

  function caseLabel(item) {
    return [item.caseNumber || item.id, item.title, item.status].filter(Boolean).join(' · ');
  }

  function fillSelect(select, selectedId) {
    select.replaceChildren();
    const none = make('option', '', 'بدون قضية');
    none.value = '';
    select.append(none);
    for (const item of state.cases) {
      const option = make('option', '', caseLabel(item));
      option.value = item.id;
      option.selected = item.id === selectedId;
      select.append(option);
    }
  }

  function fillEvidenceCases(selectedIds) {
    const container = byId('wp-evidence-cases');
    container.replaceChildren();
    const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
    if (!state.cases.length) {
      container.append(make('span', 'wp-muted', 'لا توجد قضايا موجودة للربط.'));
      return;
    }
    for (const item of state.cases) {
      const label = make('label', 'wp-case-option');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'wp-evidence-case';
      input.value = item.id;
      input.checked = selected.has(item.id);
      label.append(input, make('span', '', caseLabel(item)));
      container.append(label);
    }
  }

  function activeCaseIds() {
    return [...byId('wp-evidence-cases').querySelectorAll('input[name="wp-evidence-case"]:checked')].map((input) => input.value);
  }

  function hideInlineEditors() {
    for (const id of ['wp-evidence-editor', 'wp-note-editor', 'wp-timeline-editor', 'wp-case-editor']) byId(id).hidden = true;
  }

  function showInlineEditor(id) {
    hideInlineEditors();
    byId(id).hidden = false;
    byId(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function applyBoardTransform() {
    const world = byId('wp-board-world');
    if (!world) return;
    world.style.transform = 'translate(' + state.boardX + 'px, ' + state.boardY + 'px) scale(' + state.boardScale + ')';
  }

  function fitBoard() {
    const viewport = byId('wp-board-viewport');
    if (!viewport) return;
    state.boardScale = Math.min(viewport.clientWidth / 1000, viewport.clientHeight / 760) * 0.94;
    state.boardScale = Math.max(0.22, Math.min(1.1, state.boardScale));
    state.boardX = (viewport.clientWidth - 1000 * state.boardScale) / 2;
    state.boardY = (viewport.clientHeight - 760 * state.boardScale) / 2;
    applyBoardTransform();
  }

  function drawEdge(svg, from, to, kind) {
    const edge = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    edge.setAttribute('x1', String(from.x));
    edge.setAttribute('y1', String(from.y));
    edge.setAttribute('x2', String(to.x));
    edge.setAttribute('y2', String(to.y));
    edge.setAttribute('class', 'wp-board-edge wp-board-edge-' + kind);
    svg.append(edge);
  }

  function nodeButton({ x, y, item, type, label, thumbnail, icon }) {
    const button = make('button', 'wp-board-node wp-board-node-' + type);
    button.type = 'button';
    button.style.left = x + 'px';
    button.style.top = y + 'px';
    const visual = make('span', 'wp-node-visual');
    if (thumbnail) {
      const image = document.createElement('img');
      image.src = thumbnail;
      image.alt = '';
      image.loading = 'lazy';
      visual.append(image);
    } else {
      const glyph = make('i', 'fa-solid ' + icon);
      glyph.setAttribute('aria-hidden', 'true');
      visual.append(glyph);
    }
    button.append(visual, make('span', 'wp-node-label', label));
    button.addEventListener('click', () => {
      if (type === 'case') showCaseDetails(item);
      else if (type === 'note') showNoteDetails(item);
      else if (type === 'timeline') showTimelineDetails(item);
      else showEvidenceDetails(item);
    });
    return button;
  }

  function renderBoard() {
    const world = byId('wp-board-world');
    const nodes = byId('wp-board-nodes');
    const svg = byId('wp-board-edges');
    if (!world || !nodes || !svg || !state.activePerson) return;
    nodes.replaceChildren();
    svg.replaceChildren();
    svg.setAttribute('viewBox', '0 0 1000 760');
    svg.setAttribute('preserveAspectRatio', 'none');
    const center = { x: 500, y: 365 };
    const evidence = Array.isArray(state.board?.evidence) ? state.board.evidence : [];
    const notes = Array.isArray(state.board?.notes) ? state.board.notes : [];
    const timeline = Array.isArray(state.board?.timeline) ? state.board.timeline : [];
    const evidenceCaseIds = evidence.flatMap((item) => item.caseIds || []);
    const contributionCaseIds = [...notes, ...timeline].map((item) => item.caseId).filter(Boolean);
    const linkedIds = new Set([...(state.activePerson.caseIds || []), ...evidenceCaseIds, ...contributionCaseIds]);
    const relatedCases = state.cases.filter((item) => linkedIds.has(item.id));
    const centralEvidence = evidence.find((item) => item.category === 'PERSON');
    const centralPhoto = centralEvidence?.thumbnailData || state.activePerson.imageUrl;

    const personNode = make('button', 'wp-board-person');
    personNode.type = 'button';
    personNode.setAttribute('aria-label', 'عرض الملف المركزي ' + (state.activePerson.fullName || ''));
    personNode.style.left = center.x + 'px';
    personNode.style.top = center.y + 'px';
    const portrait = make('div', 'wp-board-person-photo');
    if (centralPhoto) {
      const image = document.createElement('img');
      image.src = centralPhoto;
      image.alt = 'صورة ' + (state.activePerson.fullName || 'الشخص المطلوب');
      image.referrerPolicy = 'no-referrer';
      portrait.append(image);
    } else {
      const icon = make('i', 'fa-solid fa-user-secret');
      icon.setAttribute('aria-hidden', 'true');
      portrait.append(icon);
    }
    personNode.append(portrait, make('strong', '', state.activePerson.fullName || 'شخص مطلوب'), make('small', '', state.activePerson.fileNumber || ''));
    personNode.addEventListener('click', () => centralEvidence ? showEvidenceDetails(centralEvidence) : showPersonDetails());
    nodes.append(personNode);

    const evidencePoints = new Map();
    const boardEvidence = evidence.slice(0, 12);
    boardEvidence.forEach((item, index) => {
      const angle = (Math.PI * 2 * index / Math.max(boardEvidence.length, 1)) - Math.PI / 2;
      const point = { x: center.x + Math.cos(angle) * 235, y: center.y + Math.sin(angle) * 235 };
      evidencePoints.set(item.id, point);
      drawEdge(svg, center, point, 'evidence');
      nodes.append(nodeButton({
        x: point.x, y: point.y, item, type: 'evidence',
        label: item.title || evidenceLabels[item.category] || 'دليل',
        thumbnail: item.thumbnailData, icon: evidenceIcons[item.category] || evidenceIcons.OTHER
      }));
    });

    const casePoints = new Map();
    relatedCases.forEach((item, index) => {
      const angle = (Math.PI * 2 * index / Math.max(relatedCases.length, 1)) - Math.PI / 2;
      const point = { x: center.x + Math.cos(angle) * 360, y: center.y + Math.sin(angle) * 285 };
      casePoints.set(item.id, point);
      if (!evidence.some((evidenceItem) => (evidenceItem.caseIds || []).includes(item.id))) drawEdge(svg, center, point, 'case');
      nodes.append(nodeButton({
        x: point.x, y: point.y, item, type: 'case',
        label: (item.caseNumber || 'CASE') + ' · ' + (item.title || 'قضية'),
        icon: 'fa-folder-open'
      }));
    });

    const boardNotes = notes.slice(0, 12);
    boardNotes.forEach((item, index) => {
      const angle = (Math.PI * 2 * index / Math.max(boardNotes.length, 1)) - Math.PI / 2;
      const point = { x: center.x + Math.cos(angle) * 420, y: center.y + Math.sin(angle) * 325 };
      const linkedCase = item.caseId && casePoints.has(item.caseId) ? casePoints.get(item.caseId) : center;
      drawEdge(svg, linkedCase, point, 'note');
      nodes.append(nodeButton({
        x: point.x, y: point.y, item, type: 'note',
        label: item.title || 'ملاحظة محقق', icon: 'fa-note-sticky'
      }));
    });

    const boardTimeline = timeline.slice(0, 12);
    boardTimeline.forEach((item, index) => {
      const angle = (Math.PI * 2 * index / Math.max(boardTimeline.length, 1)) - Math.PI / 2 + Math.PI / 12;
      const point = { x: center.x + Math.cos(angle) * 315, y: center.y + Math.sin(angle) * 245 };
      const linkedCase = item.caseId && casePoints.has(item.caseId) ? casePoints.get(item.caseId) : center;
      drawEdge(svg, linkedCase, point, 'timeline');
      nodes.append(nodeButton({
        x: point.x, y: point.y, item, type: 'timeline',
        label: item.title || 'حدث زمني', icon: 'fa-clock'
      }));
    });

    for (const item of boardEvidence) {
      const point = evidencePoints.get(item.id);
      for (const caseId of item.caseIds || []) {
        const casePoint = casePoints.get(caseId);
        if (casePoint) drawEdge(svg, point, casePoint, 'relationship');
      }
    }
    byId('wp-board-empty').hidden = evidence.length > 0 || notes.length > 0 || timeline.length > 0 || relatedCases.length > 0;
    byId('wp-add-evidence').hidden = !state.board?.permissions?.canContribute;
    byId('wp-add-note').hidden = !state.board?.permissions?.canContribute;
    byId('wp-add-event').hidden = !state.board?.permissions?.canContribute;
    if (evidence.length > 12 || notes.length > 12 || timeline.length > 12) {
      byId('wp-board-hint').textContent = 'تُعرض أحدث 12 من كل نوع على اللوحة؛ القوائم أسفلها تعرض السجلات المتاحة.';
    }
    fitBoard();
  }

  async function loadInvestigation(personId) {
    try {
      const result = await request('wanted-persons:investigation', { personId });
      if (!result.ok) {
        setStatus(result.message || 'تعذر تحميل لوحة التحقيق.', 'error');
        return false;
      }
      state.board = result;
      state.cases = Array.isArray(result.availableCases) ? result.availableCases : state.cases;
      renderBoard();
      renderInvestigationRecords(result);
      byId('wp-board-selection').replaceChildren(make('p', 'wp-muted', 'اختر دليلًا أو قضية لعرض التفاصيل.'));
      hideInlineEditors();
      return true;
    } catch (error) {
      setStatus(error.message, 'error');
      return false;
    }
  }

  function renderCaseLinks(container, cases) {
    if (!cases || !cases.length) {
      container.append(make('span', 'wp-muted', 'لا توجد قضية مرتبطة.'));
      return;
    }
    for (const item of cases) {
      const row = make('span', 'wp-related-case-chip', caseLabel(item));
      container.append(row);
    }
  }

  function showEvidenceDetails(item) {
    const panel = byId('wp-board-selection');
    panel.replaceChildren();
    const heading = make('div', 'wp-selection-heading');
    heading.append(make('div', '', 'الدليل · ' + (evidenceLabels[item.category] || 'أخرى')), make('h4', '', item.title || 'دليل'));
    const actions = make('div', 'wp-board-actions');
    const download = make('button', 'wp-button wp-button-muted', 'تنزيل الملف');
    download.type = 'button';
    download.addEventListener('click', () => downloadEvidence(item));
    actions.append(download);
    if (item.permissions?.canEdit) {
      const edit = make('button', 'wp-button wp-button-muted', 'تعديل / ربط');
      edit.type = 'button';
      edit.addEventListener('click', () => openEvidenceEditor(item));
      actions.append(edit);
    }
    if (item.permissions?.canDelete) {
      const remove = make('button', 'wp-button wp-button-danger', 'حذف الدليل');
      remove.type = 'button';
      remove.addEventListener('click', () => deleteEvidence(item));
      actions.append(remove);
    }
    panel.append(
      heading,
      make('p', 'wp-long-text', item.description || 'لا يوجد وصف.'),
      make('p', 'wp-record-meta', 'المصدر: ' + (item.source || 'غير مسجل') + ' · تاريخ الدليل: ' + readableDate(item.recordedAt)),
      make('p', 'wp-record-meta', 'الملف: ' + item.fileName + ' · ' + formatBytes(item.fileSize)),
      make('small', 'wp-record-meta', contributorText(item.createdByName, item.createdByCode, item.createdByRank, item.createdAt))
    );
    const related = make('div', 'wp-related-cases');
    renderCaseLinks(related, item.relatedCases);
    panel.append(make('strong', 'wp-record-label', 'القضايا المرتبطة'), related, actions);
  }

  function showCaseDetails(item) {
    const panel = byId('wp-board-selection');
    panel.replaceChildren();
    const heading = make('div', 'wp-selection-heading');
    heading.append(make('div', '', item.caseNumber || 'CIA CASE'), make('h4', '', item.title || 'قضية'));
    panel.append(heading, make('p', 'wp-record-meta', 'الحالة: ' + (item.status || 'غير محددة') + ' · التصنيف: ' + (item.classification || 'غير محدد')));
    panel.append(make('p', 'wp-long-text', item.description || 'لا توجد تفاصيل مسجلة.'));
    panel.append(make('strong', 'wp-record-label', 'القرار النهائي'), make('p', 'wp-long-text', item.finalDecision || 'لم يصدر قرار نهائي.'));
    panel.append(make('p', 'wp-record-meta', 'تاريخ الفتح: ' + readableDate(item.createdAt) + (item.updatedAt ? ' · آخر تحديث: ' + readableDate(item.updatedAt) : '')));
    if (state.board?.permissions?.canManageAll) {
      const edit = make('button', 'wp-button wp-button-primary', 'تحديث تفاصيل القضية والقرار');
      edit.type = 'button';
      edit.addEventListener('click', () => openCaseEditor(item));
      panel.append(edit);
    }
  }

  function showNoteDetails(item) {
    const panel = byId('wp-board-selection');
    panel.replaceChildren();
    panel.append(
      make('div', 'wp-selection-heading', 'ملاحظة محقق'),
      make('h4', '', item.title || 'ملاحظة'),
      make('p', 'wp-long-text', item.body || ''),
      make('small', 'wp-record-meta', contributorText(item.createdByName, item.createdByCode, item.createdByRank, item.createdAt)),
      make('small', 'wp-record-meta', 'آخر تعديل: ' + (item.updatedByName || 'غير معروف') + ' · ' + readableDate(item.updatedAt))
    );
    const related = make('div', 'wp-related-cases');
    renderCaseLinks(related, item.relatedCases);
    panel.append(make('strong', 'wp-record-label', 'القضية المرتبطة'), related);
    const actions = make('div', 'wp-board-actions');
    if (item.permissions?.canEdit) {
      const edit = make('button', 'wp-button wp-button-muted', 'تعديل الملاحظة');
      edit.type = 'button';
      edit.addEventListener('click', () => openNoteEditor(item));
      actions.append(edit);
    }
    if (item.permissions?.canDelete) {
      const remove = make('button', 'wp-button wp-button-danger', 'حذف الملاحظة');
      remove.type = 'button';
      remove.addEventListener('click', () => deleteNote(item));
      actions.append(remove);
    }
    if (actions.childElementCount) panel.append(actions);
  }

  function showTimelineDetails(item) {
    const panel = byId('wp-board-selection');
    panel.replaceChildren();
    panel.append(
      make('div', 'wp-selection-heading', 'حدث زمني'),
      make('h4', '', item.title || 'حدث'),
      make('p', 'wp-long-text', item.body || 'لا توجد تفاصيل إضافية.'),
      make('small', 'wp-record-meta', 'وقت الحدث: ' + readableDate(item.occurredAt)),
      make('small', 'wp-record-meta', contributorText(item.actorName, item.actorCode, item.actorRank, item.createdAt, 'أضاف الحدث')),
      make('small', 'wp-record-meta', 'آخر تعديل: ' + (item.updatedByName || item.actorName || 'غير معروف') + ' · ' + readableDate(item.updatedAt))
    );
    const related = make('div', 'wp-related-cases');
    renderCaseLinks(related, item.relatedCases);
    panel.append(make('strong', 'wp-record-label', 'القضية المرتبطة'), related);
    const actions = make('div', 'wp-board-actions');
    if (item.permissions?.canEdit) {
      const edit = make('button', 'wp-button wp-button-muted', 'تعديل الحدث');
      edit.type = 'button';
      edit.addEventListener('click', () => openTimelineEditor(item));
      actions.append(edit);
    }
    if (item.permissions?.canDelete) {
      const remove = make('button', 'wp-button wp-button-danger', 'حذف الحدث');
      remove.type = 'button';
      remove.addEventListener('click', () => deleteTimelineEvent(item));
      actions.append(remove);
    }
    if (actions.childElementCount) panel.append(actions);
  }

  function showPersonDetails() {
    const panel = byId('wp-board-selection');
    panel.replaceChildren();
    panel.append(make('strong', 'wp-record-label', 'ملف الشخص في مركز اللوحة'));
    panel.append(make('h4', '', state.activePerson?.fullName || 'شخص مطلوب'));
    panel.append(make('p', 'wp-record-meta', 'رقم الملف: ' + (state.activePerson?.fileNumber || '—')));
    panel.append(make('p', 'wp-long-text', state.activePerson?.details || 'لا توجد تفاصيل مسجلة.'));
    panel.append(make('p', 'wp-record-meta', 'لجعل الصورة مركزية وخاصة، أضف صورة من نوع «شخص / صورة ملف» ضمن الأدلة المرتبطة.'));
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  async function downloadEvidence(item) {
    try {
      const result = await request('wanted-persons:evidence:file', { personId: state.activeId, evidenceId: item.id });
      if (!result.ok) throw new Error(result.message || 'تعذر استرجاع الملف.');
      const raw = atob(result.file.data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: result.file.contentType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.file.fileName || 'evidence';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  function openEvidenceEditor(item) {
    byId('wp-evidence-form').reset();
    byId('wp-evidence-id').value = item?.id || '';
    byId('wp-evidence-editor-title').textContent = item ? 'تعديل الدليل وربطه' : 'إضافة دليل';
    byId('wp-evidence-category').value = item?.category || 'IMAGE';
    byId('wp-evidence-title').value = item?.title || '';
    byId('wp-evidence-source').value = item?.source || '';
    byId('wp-evidence-date').value = localDateTime(item?.recordedAt);
    byId('wp-evidence-description').value = item?.description || '';
    byId('wp-evidence-file-current').textContent = item ? 'الملف الحالي: ' + item.fileName + ' (اترك اختيار الملف فارغًا للاحتفاظ به)' : '';
    fillEvidenceCases(item?.caseIds || []);
    showInlineEditor('wp-evidence-editor');
    byId('wp-evidence-title').focus();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('تعذرت قراءة الملف.'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });
  }

  async function imageThumbnail(file) {
    if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return '';
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 160 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.58);
      return dataUrl.split(',')[1] || '';
    } catch (_error) {
      return '';
    } finally {
      if (bitmap) bitmap.close();
    }
  }

  async function saveEvidenceForm(event) {
    event.preventDefault();
    const unlock = lockSubmission(byId('wp-evidence-form'));
    if (!unlock) return;
    const file = byId('wp-evidence-file').files[0];
    if (file && file.size > 2 * 1024 * 1024) {
      setStatus('الحد الأقصى لملف الدليل 2 ميغابايت.', 'error');
      unlock();
      return;
    }
    try {
      const payload = {
        id: byId('wp-evidence-id').value || undefined,
        category: byId('wp-evidence-category').value,
        title: byId('wp-evidence-title').value,
        source: byId('wp-evidence-source').value,
        recordedAt: new Date(byId('wp-evidence-date').value).toISOString(),
        description: byId('wp-evidence-description').value,
        caseIds: activeCaseIds()
      };
      if (file) {
        const dataUrl = await readFileAsDataUrl(file);
        payload.fileData = dataUrl.split(',')[1] || '';
        payload.fileName = file.name;
        payload.contentType = file.type;
        payload.thumbnailData = await imageThumbnail(file);
      }
      const result = await request('wanted-persons:evidence:save', { personId: state.activeId, evidence: payload });
      if (!result.ok) throw new Error(result.message || 'تعذر حفظ الدليل.');
      hideInlineEditors();
      await confirmRefreshAfterWrite('تم حفظ الدليل وتوثيق العملية.');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      unlock();
    }
  }

  async function deleteEvidence(item) {
    if (!window.confirm('سيُحذف الملف المرفق نهائيًا من قاعدة البيانات، وسيبقى سجل التدقيق. هل تريد المتابعة؟')) return;
    const unlock = lockSubmission();
    if (!unlock) return;
    try {
      const result = await request('wanted-persons:evidence:delete', { personId: state.activeId, evidenceId: item.id });
      if (!result.ok) throw new Error(result.message || 'تعذر حذف الدليل.');
      await confirmRefreshAfterWrite('تم حذف الدليل وتسجيل العملية.');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      unlock();
    }
  }

  function renderInvestigationRecords(data) {
    const evidence = byId('wp-evidence-list');
    evidence.replaceChildren();
    if (!data.evidence?.length) evidence.append(make('p', 'wp-muted', 'لا توجد أدلة مرفقة.'));
    for (const item of data.evidence || []) {
      const row = make('article', 'wp-record-card');
      row.append(
        make('strong', '', item.title || 'دليل'),
        make('p', 'wp-long-text', item.description || 'لا يوجد وصف.'),
        make('small', 'wp-record-meta', 'نوع الدليل: ' + (evidenceLabels[item.category] || 'أخرى') + ' · تاريخ الدليل: ' + readableDate(item.recordedAt)),
        make('small', 'wp-record-meta', 'الملف: ' + (item.fileName || 'غير مسجل') + ' · ' + formatBytes(item.fileSize)),
        make('small', 'wp-record-meta', contributorText(item.createdByName, item.createdByCode, item.createdByRank, item.createdAt))
      );
      const cases = make('div', 'wp-related-cases');
      renderCaseLinks(cases, item.relatedCases);
      row.append(cases);
      const actions = make('div', 'wp-board-actions');
      const download = make('button', 'wp-button wp-button-muted', 'تنزيل الملف');
      download.type = 'button';
      download.addEventListener('click', () => downloadEvidence(item));
      actions.append(download);
      if (item.permissions?.canEdit) {
        const edit = make('button', 'wp-button wp-button-muted', 'تعديل / ربط');
        edit.type = 'button';
        edit.addEventListener('click', () => openEvidenceEditor(item));
        actions.append(edit);
      }
      if (item.permissions?.canDelete) {
        const remove = make('button', 'wp-button wp-button-danger', 'حذف');
        remove.type = 'button';
        remove.addEventListener('click', () => deleteEvidence(item));
        actions.append(remove);
      }
      row.append(actions);
      evidence.append(row);
    }

    const notes = byId('wp-notes-list');
    notes.replaceChildren();
    if (!data.notes?.length) notes.append(make('p', 'wp-muted', 'لا توجد ملاحظات محققين.'));
    for (const item of data.notes || []) {
      const row = make('article', 'wp-record-card');
      row.append(
        make('strong', '', item.title),
        make('p', 'wp-long-text', item.body),
        make('small', 'wp-record-meta', contributorText(item.createdByName, item.createdByCode, item.createdByRank, item.createdAt)),
        make('small', 'wp-record-meta', 'آخر تعديل: ' + (item.updatedByName || 'غير معروف') + ' · الكود العسكري: ' + (item.updatedByCode || 'غير متاح') + ' · الرتبة: ' + (item.updatedByRank || 'غير محددة') + ' · ' + readableDate(item.updatedAt))
      );
      const cases = make('div', 'wp-related-cases');
      renderCaseLinks(cases, item.relatedCases);
      row.append(cases);
      const actions = make('div', 'wp-board-actions');
      if (item.permissions?.canEdit) {
        const edit = make('button', 'wp-button wp-button-muted', 'تعديل');
        edit.type = 'button';
        edit.addEventListener('click', () => openNoteEditor(item));
        actions.append(edit);
      }
      if (item.permissions?.canDelete) {
        const remove = make('button', 'wp-button wp-button-danger', 'حذف');
        remove.type = 'button';
        remove.addEventListener('click', () => deleteNote(item));
        actions.append(remove);
      }
      if (actions.childElementCount) row.append(actions);
      notes.append(row);
    }

    const timeline = byId('wp-timeline-list');
    timeline.replaceChildren();
    if (!data.timeline?.length) timeline.append(make('p', 'wp-muted', 'لا توجد أحداث مسجلة.'));
    for (const item of data.timeline || []) {
      const row = make('article', 'wp-record-card wp-timeline-entry');
      row.append(
        make('strong', '', item.title),
        make('small', 'wp-record-meta', 'وقت الحدث: ' + readableDate(item.occurredAt)),
        make('small', 'wp-record-meta', contributorText(item.actorName, item.actorCode, item.actorRank, item.createdAt, 'أضاف الحدث')),
        make('p', 'wp-long-text', item.body || 'لا توجد تفاصيل إضافية.')
      );
      const cases = make('div', 'wp-related-cases');
      renderCaseLinks(cases, item.relatedCases);
      row.append(cases);
      const actions = make('div', 'wp-board-actions');
      if (item.permissions?.canEdit) {
        const edit = make('button', 'wp-button wp-button-muted', 'تعديل الحدث');
        edit.type = 'button';
        edit.addEventListener('click', () => openTimelineEditor(item));
        actions.append(edit);
      }
      if (item.permissions?.canDelete) {
        const remove = make('button', 'wp-button wp-button-danger', 'حذف الحدث');
        remove.type = 'button';
        remove.addEventListener('click', () => deleteTimelineEvent(item));
        actions.append(remove);
      }
      if (actions.childElementCount) row.append(actions);
      timeline.append(row);
    }

    const audit = byId('wp-audit-list');
    audit.replaceChildren();
    if (!data.audit?.length) audit.append(make('p', 'wp-muted', 'لا توجد عمليات مسجلة بعد.'));
    for (const item of data.audit || []) {
      const row = make('article', 'wp-audit-entry');
      const title = (auditLabels[item.action] || item.action || 'عملية') + ' · ' + (item.actorName || item.actorUserId || 'مستخدم');
      row.append(
        make('strong', '', title),
        make('small', 'wp-record-meta', 'الكود العسكري: ' + (item.actorCode || 'غير متاح') + ' · الرتبة: ' + (item.actorRank || 'غير محددة') + ' · ' + readableDate(item.createdAt))
      );
      if (item.changedFields?.length) row.append(make('span', 'wp-record-meta', 'الحقول: ' + item.changedFields.join('، ')));
      audit.append(row);
    }
  }

  function openNoteEditor(item) {
    byId('wp-note-form').reset();
    byId('wp-note-id').value = item?.id || '';
    byId('wp-note-editor-title').textContent = item ? 'تعديل ملاحظة المحقق' : 'ملاحظة محقق';
    byId('wp-note-title').value = item?.title || '';
    byId('wp-note-body').value = item?.body || '';
    fillSelect(byId('wp-note-case'), item?.caseId || '');
    showInlineEditor('wp-note-editor');
    byId('wp-note-title').focus();
  }

  async function saveNoteForm(event) {
    event.preventDefault();
    const unlock = lockSubmission(byId('wp-note-form'));
    if (!unlock) return;
    try {
      const result = await request('wanted-persons:note:save', {
        personId: state.activeId,
        note: {
          id: byId('wp-note-id').value || undefined,
          title: byId('wp-note-title').value,
          body: byId('wp-note-body').value,
          caseId: byId('wp-note-case').value
        }
      });
      if (!result.ok) throw new Error(result.message || 'تعذر حفظ الملاحظة.');
      hideInlineEditors();
      await confirmRefreshAfterWrite('تم حفظ الملاحظة وتسجيل العملية.');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      unlock();
    }
  }

  async function deleteNote(item) {
    if (!window.confirm('سيتم حذف الملاحظة نهائيًا مع الاحتفاظ بسجل التدقيق. هل تريد المتابعة؟')) return;
    const unlock = lockSubmission();
    if (!unlock) return;
    try {
      const result = await request('wanted-persons:note:delete', { personId: state.activeId, noteId: item.id });
      if (!result.ok) throw new Error(result.message || 'تعذر حذف الملاحظة.');
      await confirmRefreshAfterWrite('تم حذف الملاحظة وتسجيل العملية.');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      unlock();
    }
  }

  async function saveTimelineForm(event) {
    event.preventDefault();
    const unlock = lockSubmission(byId('wp-timeline-form'));
    if (!unlock) return;
    const editing = Boolean(byId('wp-event-id').value);
    try {
      const result = await request('wanted-persons:timeline:add', {
        personId: state.activeId,
        event: {
          id: byId('wp-event-id').value || undefined,
          title: byId('wp-event-title').value,
          body: byId('wp-event-body').value,
          caseId: byId('wp-event-case').value,
          occurredAt: new Date(byId('wp-event-date').value).toISOString()
        }
      });
      if (!result.ok) throw new Error(result.message || 'تعذر إضافة الحدث.');
      byId('wp-timeline-form').reset();
      hideInlineEditors();
      await confirmRefreshAfterWrite(editing ? 'تم تحديث الحدث الزمني.' : 'تمت إضافة الحدث إلى السجل الزمني.');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      unlock();
    }
  }

  function openTimelineEditor(item) {
    byId('wp-timeline-form').reset();
    byId('wp-event-id').value = item?.id || '';
    byId('wp-event-editor-title').textContent = item ? 'تعديل الحدث الزمني' : 'إضافة حدث زمني';
    byId('wp-event-submit').textContent = item ? 'حفظ التعديل' : 'إضافة إلى الخط الزمني';
    byId('wp-event-title').value = item?.title || '';
    byId('wp-event-body').value = item?.body || '';
    byId('wp-event-date').value = localDateTime(item?.occurredAt);
    fillSelect(byId('wp-event-case'), item?.caseId || '');
    showInlineEditor('wp-timeline-editor');
    byId('wp-event-title').focus();
  }

  async function deleteTimelineEvent(item) {
    if (!window.confirm('سيُحذف الحدث نهائيًا مع الاحتفاظ بسجل التدقيق. هل تريد المتابعة؟')) return;
    const unlock = lockSubmission();
    if (!unlock) return;
    try {
      const result = await request('wanted-persons:timeline:delete', { personId: state.activeId, eventId: item.id });
      if (!result.ok) throw new Error(result.message || 'تعذر حذف الحدث.');
      await confirmRefreshAfterWrite('تم حذف الحدث وتسجيل العملية.');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      unlock();
    }
  }

  function openCaseEditor(item) {
    byId('wp-case-form').reset();
    byId('wp-case-id').value = item.id;
    byId('wp-case-title').value = item.title || '';
    byId('wp-case-status').value = item.status || 'OPEN';
    byId('wp-case-classification').value = item.classification || '';
    byId('wp-case-description').value = item.description || '';
    byId('wp-case-decision').value = item.finalDecision || '';
    showInlineEditor('wp-case-editor');
  }

  async function saveCaseForm(event) {
    event.preventDefault();
    const unlock = lockSubmission(byId('wp-case-form'));
    if (!unlock) return;
    try {
      const result = await request('case:update', {
        id: byId('wp-case-id').value,
        title: byId('wp-case-title').value,
        status: byId('wp-case-status').value,
        classification: byId('wp-case-classification').value,
        description: byId('wp-case-description').value,
        finalDecision: byId('wp-case-decision').value
      });
      if (!result.ok) throw new Error(result.message || 'تعذر تحديث القضية.');
      await confirmRefreshAfterWrite('تم تحديث القضية وتسجيلها في سجل CIA.');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      unlock();
    }
  }

  function bindBoardGestures() {
    const viewport = byId('wp-board-viewport');
    const pointers = new Map();
    let gesture = null;
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    viewport.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.wp-board-node')) return;
      viewport.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) gesture = { kind: 'pan', point: { x: event.clientX, y: event.clientY }, x: state.boardX, y: state.boardY };
      if (pointers.size === 2) {
        const pair = [...pointers.values()];
        const mid = midpoint(pair[0], pair[1]);
        const rect = viewport.getBoundingClientRect();
        gesture = {
          kind: 'pinch', distance: Math.max(1, distance(pair[0], pair[1])), scale: state.boardScale,
          worldX: (mid.x - rect.left - state.boardX) / state.boardScale,
          worldY: (mid.y - rect.top - state.boardY) / state.boardScale
        };
      }
    });
    viewport.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1 && gesture?.kind === 'pan') {
        state.boardX = gesture.x + event.clientX - gesture.point.x;
        state.boardY = gesture.y + event.clientY - gesture.point.y;
        applyBoardTransform();
      } else if (pointers.size >= 2 && gesture?.kind === 'pinch') {
        const pair = [...pointers.values()].slice(0, 2);
        const nextScale = Math.max(0.22, Math.min(2.5, gesture.scale * distance(pair[0], pair[1]) / gesture.distance));
        const mid = midpoint(pair[0], pair[1]);
        const rect = viewport.getBoundingClientRect();
        state.boardScale = nextScale;
        state.boardX = mid.x - rect.left - gesture.worldX * nextScale;
        state.boardY = mid.y - rect.top - gesture.worldY * nextScale;
        applyBoardTransform();
      }
    });
    const release = (event) => {
      pointers.delete(event.pointerId);
      if (pointers.size === 1) {
        const point = [...pointers.values()][0];
        gesture = { kind: 'pan', point, x: state.boardX, y: state.boardY };
      } else if (!pointers.size) gesture = null;
    };
    viewport.addEventListener('pointerup', release);
    viewport.addEventListener('pointercancel', release);
    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const nextScale = Math.max(0.22, Math.min(2.5, state.boardScale * (event.deltaY < 0 ? 1.12 : 0.89)));
      const worldX = (pointerX - state.boardX) / state.boardScale;
      const worldY = (pointerY - state.boardY) / state.boardScale;
      state.boardScale = nextScale;
      state.boardX = pointerX - worldX * nextScale;
      state.boardY = pointerY - worldY * nextScale;
      applyBoardTransform();
    }, { passive: false });
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
    byId('wp-delete-button').addEventListener('click', deleteCurrent);
    byId('wp-cancel-button').addEventListener('click', () => {
      if (state.activeId) showOnly('detail');
      else showOnly('list');
      setStatus('', '');
    });
    byId('wp-person-form').addEventListener('submit', saveForm);
    byId('wp-add-evidence').addEventListener('click', () => openEvidenceEditor(null));
    byId('wp-add-note').addEventListener('click', () => openNoteEditor(null));
    byId('wp-add-event').addEventListener('click', () => openTimelineEditor(null));
    byId('wp-board-reset').addEventListener('click', fitBoard);
    byId('wp-evidence-form').addEventListener('submit', saveEvidenceForm);
    byId('wp-note-form').addEventListener('submit', saveNoteForm);
    byId('wp-timeline-form').addEventListener('submit', saveTimelineForm);
    byId('wp-case-form').addEventListener('submit', saveCaseForm);
    byId('wp-evidence-cancel').addEventListener('click', hideInlineEditors);
    byId('wp-note-cancel').addEventListener('click', hideInlineEditors);
    byId('wp-event-cancel').addEventListener('click', hideInlineEditors);
    byId('wp-case-cancel').addEventListener('click', hideInlineEditors);
    bindBoardGestures();
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
