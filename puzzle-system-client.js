'use strict';

(function attachPuzzleSystemClient() {
  const byId = (id) => document.getElementById(id);
  const listRoot = byId('br-puzzle-list');
  if (!listRoot) return;

  let preparedPuzzle = null;
  let selectedFile = null;
  let lastCreatedToken = '';

  function showMessage(text, type = '') {
    const node = byId('br-puzzle-message');
    if (!node) return;
    node.textContent = String(text || '');
    node.className = `br-puzzle-message${type ? ` is-${type}` : ''}`;
  }

  function getSocket() {
    return window.blackRidgeSocket || null;
  }

  function call(eventName, payload = {}) {
    return new Promise((resolve) => {
      const socket = getSocket();
      if (!socket) return resolve({ ok: false, message: 'تعذر الاتصال بخادم الموقع.' });
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve(result || { ok: false, message: 'لم يصل رد من الخادم.' });
      };
      const send = () => socket.emit(eventName, payload, finish);
      const timeout = setTimeout(() => finish({ ok: false, message: 'انتهت مهلة الاتصال بالخادم.' }), 30000);
      if (socket.connected) send();
      else {
        socket.once('connect', send);
        socket.once('connect_error', () => finish({ ok: false, message: 'تعذر الاتصال بخادم الموقع.' }));
      }
    });
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function renderShareLink(token) {
    const section = createElement('div', 'br-puzzle-created-link');
    section.append(createElement('span', 'br-puzzle-created-label', 'رابط البازل الجديد — انسخه لإرساله للاعب'));
    const copy = createElement('input', 'br-puzzle-share-input');
    copy.readOnly = true;
    copy.value = `${window.location.origin}/puzzles/${token}`;
    copy.setAttribute('aria-label', 'رابط مشاركة البازل');
    const button = createElement('button', 'br-puzzle-button br-puzzle-copy', 'نسخ الرابط');
    button.type = 'button';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(copy.value);
        button.textContent = 'تم نسخ الرابط';
      } catch (_error) {
        copy.focus();
        copy.select();
        const copied = document.execCommand('copy');
        button.textContent = copied ? 'تم نسخ الرابط' : 'حدد الرابط لنسخه';
      }
    });
    section.append(copy, button);
    return section;
  }

  function renderPuzzles(puzzles) {
    listRoot.replaceChildren();
    if (!Array.isArray(puzzles) || !puzzles.length) {
      listRoot.append(createElement('div', 'br-puzzle-empty', 'لا توجد ألغاز منشأة حتى الآن.'));
      return;
    }
    for (const puzzle of puzzles) {
      const card = createElement('article', 'br-puzzle-list-card');
      const title = createElement('h3', '', puzzle.title || 'بازل بلا عنوان');
      const detail = createElement('p', 'br-puzzle-muted', `${puzzle.pieceCount || 0} قطعة · أنشأه ${puzzle.creatorCode || 'القيادة'} · ${formatDate(puzzle.createdAt)}`);
      const actions = createElement('div', 'br-puzzle-list-actions');
      const open = createElement('a', 'br-puzzle-button br-puzzle-button-quiet', 'فتح رابط التحدي');
      const url = `${window.location.origin}/puzzles/${encodeURIComponent(puzzle.shareToken || '')}`;
      open.href = url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      const copy = createElement('button', 'br-puzzle-button br-puzzle-copy', 'نسخ');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); copy.textContent = 'تم النسخ'; }
        catch (_error) { showMessage(url, 'success'); }
      });
      actions.append(open, copy);
      card.append(title, detail, actions);
      listRoot.append(card);
    }
  }

  function formatDate(value) {
    if (!value) return 'الآن';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ar', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function renderPermissions(agents, audit) {
    const root = byId('br-puzzle-agent-list');
    const auditRoot = byId('br-puzzle-permission-audit');
    if (!root || !auditRoot) return;
    root.replaceChildren();
    if (!Array.isArray(agents) || !agents.length) {
      root.append(createElement('div', 'br-puzzle-empty', 'لا توجد حسابات Agent في القائمة.'));
    } else {
      for (const agent of agents) {
        const row = createElement('div', 'br-puzzle-agent-row');
        const identity = createElement('div', 'br-puzzle-agent-identity');
        identity.append(
          createElement('strong', '', agent.publicCode || 'Agent'),
          createElement('small', '', agent.granted ? 'صلاحية الإنشاء ممنوحة' : 'حل الألغاز فقط')
        );
        const button = createElement('button', `br-puzzle-button ${agent.granted ? 'br-puzzle-button-revoke' : 'br-puzzle-button-quiet'}`, agent.granted ? 'سحب الصلاحية' : 'منح صلاحية');
        button.type = 'button';
        button.dataset.targetUserId = agent.userId;
        button.dataset.action = agent.granted ? 'revoke' : 'grant';
        button.addEventListener('click', async () => {
          button.disabled = true;
          const action = button.dataset.action;
          const result = await call(`puzzles:permission:${action}`, { targetUserId: button.dataset.targetUserId });
          if (!result.ok) showMessage(result.message || 'تعذر تحديث الصلاحية.', 'error');
          else showMessage(action === 'grant' ? 'تم منح صلاحية الإنشاء وتسجيلها.' : 'تم سحب صلاحية الإنشاء وتسجيل ذلك.', 'success');
          await loadOverview();
        });
        row.append(identity, button);
        root.append(row);
      }
    }

    auditRoot.replaceChildren();
    if (!Array.isArray(audit) || !audit.length) {
      auditRoot.append(createElement('div', 'br-puzzle-empty', 'لا توجد تغييرات مسجلة بعد.'));
      return;
    }
    for (const entry of audit.slice(0, 60)) {
      const row = createElement('div', 'br-puzzle-audit-row');
      const action = entry.action === 'GRANTED' ? 'منح صلاحية' : 'سحب صلاحية';
      row.append(
        createElement('span', 'br-puzzle-audit-action', action),
        createElement('span', '', `${entry.actorCode || 'قيادة'} ← ${entry.targetCode || 'Agent'}`),
        createElement('time', '', formatDate(entry.createdAt))
      );
      auditRoot.append(row);
    }
  }

  async function loadOverview() {
    const status = byId('br-puzzle-db-status');
    if (status) status.textContent = 'جارٍ تحميل الألغاز من قاعدة البيانات…';
    const response = await call('puzzles:overview');
    if (!response.ok) {
      if (status) status.textContent = 'قاعدة البيانات غير متاحة';
      listRoot.replaceChildren(createElement('div', 'br-puzzle-empty is-error', response.message || 'تعذر تحميل الألغاز.'));
      if (lastCreatedToken) listRoot.prepend(renderShareLink(lastCreatedToken));
      byId('br-puzzle-create-panel').hidden = true;
      byId('br-puzzle-permissions-panel').hidden = true;
      return;
    }
    if (status) status.textContent = 'متصل بقاعدة البيانات';
    byId('br-puzzle-create-panel').hidden = response.canCreate !== true;
    byId('br-puzzle-permissions-panel').hidden = response.canManagePermissions !== true;
    renderPuzzles(response.puzzles);
    if (lastCreatedToken) listRoot.prepend(renderShareLink(lastCreatedToken));
    renderPermissions(response.agents, response.permissionAudit);
  }

  function renderPreview(prepared) {
    const root = byId('br-puzzle-preview');
    root.replaceChildren();
    root.hidden = false;
    const board = createElement('div', 'br-puzzle-preview-board');
    board.style.aspectRatio = `${prepared.imageWidth} / ${prepared.imageHeight}`;
    const photo = createElement('img', 'br-puzzle-preview-photo');
    photo.src = prepared.image;
    photo.alt = 'معاينة صورة البازل';
    board.append(photo);
    const grid = createElement('div', 'br-puzzle-preview-grid');
    grid.style.gridTemplateColumns = `repeat(${prepared.cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${prepared.rows}, 1fr)`;
    for (let index = 0; index < prepared.rows * prepared.cols; index += 1) grid.append(createElement('span', ''));
    board.append(grid);
    const tray = createElement('div', 'br-puzzle-preview-tray');
    for (const piece of prepared.pieces.slice(0, 8)) {
      const image = createElement('img', 'br-puzzle-preview-piece');
      image.src = piece.image;
      image.alt = '';
      tray.append(image);
    }
    root.append(
      createElement('div', 'br-puzzle-preview-title', `معاينة ${prepared.rows * prepared.cols} قطعة — هذه الصورة الكاملة لا تُرسل للاعب قبل اكتمال البازل.`),
      board,
      tray
    );
  }

  async function previewPuzzle() {
    const form = byId('br-puzzle-create-form');
    const file = selectedFile || byId('br-puzzle-image-file').files?.[0];
    if (!file) return showMessage('اختر صورة للموقع أولًا.', 'error');
    const count = Number(new FormData(form).get('pieceCount')) || 16;
    const side = Math.sqrt(count);
    if (!Number.isInteger(side)) return showMessage('عدد القطع غير صالح.', 'error');
    const button = byId('br-puzzle-preview-button');
    button.disabled = true;
    button.textContent = 'جارٍ تجهيز القطع…';
    try {
      preparedPuzzle = await window.BlackridgePuzzleGame.preparePieces(file, side, side);
      renderPreview(preparedPuzzle);
      byId('br-puzzle-create-button').disabled = false;
      showMessage('المعاينة جاهزة. ملف الصورة الكامل سيبقى مخفيًا عن اللاعب حتى يركّب كل القطع.', 'success');
    } catch (error) {
      preparedPuzzle = null;
      byId('br-puzzle-create-button').disabled = true;
      showMessage(error.message || 'تعذر تجهيز البازل.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'معاينة البازل';
    }
  }

  async function createPuzzle(event) {
    event.preventDefault();
    const form = byId('br-puzzle-create-form');
    if (!preparedPuzzle) return showMessage('اعرض المعاينة وجهّز القطع أولًا.', 'error');
    const data = new FormData(form);
    const button = byId('br-puzzle-create-button');
    button.disabled = true;
    button.textContent = 'جارٍ الحفظ في PostgreSQL…';
    const payload = {
      title: data.get('title'),
      hint: data.get('hint'),
      clue: data.get('clue'),
      answer: data.get('answer'),
      rows: preparedPuzzle.rows,
      cols: preparedPuzzle.cols,
      bleed: preparedPuzzle.bleed,
      image: preparedPuzzle.image,
      imageWidth: preparedPuzzle.imageWidth,
      imageHeight: preparedPuzzle.imageHeight,
      pieces: preparedPuzzle.pieces
    };
    try {
      const response = await call('puzzles:create', payload);
      const shareToken = response?.puzzle?.shareToken;
      if (response?.ok !== true || !/^[a-f0-9]{64}$/.test(String(shareToken || ''))) {
        return showMessage(response?.message || 'لم يؤكد الخادم حفظ البازل؛ لم يتم إنشاء رابط مشاركة.', 'error');
      }
      lastCreatedToken = shareToken;
      showMessage('تم حفظ البازل بنجاح. أرسل الرابط إلى اللاعب؛ لن يرى الصورة كاملة قبل إكماله.', 'success');
      listRoot.prepend(renderShareLink(lastCreatedToken));
      form.reset();
      selectedFile = null;
      preparedPuzzle = null;
      byId('br-puzzle-preview').replaceChildren();
      byId('br-puzzle-preview').hidden = true;
      button.disabled = true;
      await loadOverview();
    } finally {
      button.textContent = 'حفظ وإنشاء رابط المشاركة';
      if (preparedPuzzle) button.disabled = false;
    }
  }

  byId('br-puzzle-preview-button')?.addEventListener('click', previewPuzzle);
  byId('br-puzzle-create-form')?.addEventListener('submit', createPuzzle);
  byId('br-puzzle-image-file')?.addEventListener('change', (event) => {
    selectedFile = event.target.files?.[0] || null;
    preparedPuzzle = null;
    byId('br-puzzle-create-button').disabled = true;
    byId('br-puzzle-preview').replaceChildren();
    byId('br-puzzle-preview').hidden = true;
  });
  byId('br-puzzle-refresh')?.addEventListener('click', loadOverview);

  window.openBlackridgePuzzles = function openBlackridgePuzzles(button) {
    if (typeof window.showPane === 'function') window.showPane('puzzles-view', button || byId('puzzles-nav'));
    window.setTimeout(() => {
      if (byId('puzzles-view')?.classList.contains('active')) void loadOverview();
    }, 0);
  };
})();
