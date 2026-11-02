'use strict';
/*
  BLACKRIDGE CIA - COVER IDENTITY SYSTEM (client)
  Fictional in-game badges for BLACKRIDGE CITY ROLEPLAY only.
  Every permission is enforced by the server; this file only decides what to show.
*/
(() => {
  const FONT = '"Tajawal","Segoe UI",Tahoma,Arial,sans-serif';
  const W = 1011;
  const H = 638;
  const NOTICE_AR = 'هوية معتمدة رسميًا داخل BLACKRIDGE CITY ROLEPLAY، وقد تمت مراجعتها والموافقة عليها من الجهات المخوّلة.';
  const NOTICE_EN = 'APPROVED IN BLACKRIDGE CITY ROLEPLAY ONLY · NOT A GOVERNMENT ID';
  const STATUS_AR = {
    ACTIVE: 'فعّال',
    PENDING_REVIEW: 'قيد المراجعة',
    REJECTED: 'مرفوض',
    EXPIRED: 'منتهي',
    DISABLED: 'معطّل',
    REVOKED: 'ملغى'
  };
  const ACTION_AR = {
    CREATED: 'إنشاء', UPDATED: 'تعديل', RENEWED: 'تجديد', REVOKED: 'إلغاء',
    DISABLED: 'تعطيل', ENABLED: 'إعادة تفعيل', EXPIRED: 'انتهاء تلقائي',
    APPROVED: 'اعتماد', REJECTED: 'رفض'
  };
  const THEMES = {
    MILITARY: { bg: ['#2b3320', '#141810'], accent: '#c9b458', band: '#3a4528', text: '#f1ecd0', sub: '#c8c39a', en: 'MILITARY IDENTIFICATION', ar: 'هوية عسكرية', pattern: 'stripes' },
    POLICE: { bg: ['#12295a', '#08122a'], accent: '#c0c8d8', band: '#1b3a7a', text: '#eef3ff', sub: '#aebbd8', en: 'POLICE IDENTIFICATION', ar: 'هوية شرطة', pattern: 'grid' },
    EMS: { bg: ['#ffffff', '#eef2f6'], accent: '#dc2626', band: '#dc2626', text: '#111827', sub: '#4b5563', en: 'EMERGENCY MEDICAL ID', ar: 'هوية إسعاف', pattern: 'dots' },
    MEDIA: { bg: ['#1a1a1a', '#0a0a0a'], accent: '#f97316', band: '#f97316', text: '#fafafa', sub: '#d4d4d4', en: 'PRESS / MEDIA PASS', ar: 'هوية إعلامية', pattern: 'lines' },
    JUSTICE: { bg: ['#45101f', '#1f060d'], accent: '#d4af37', band: '#5f162b', text: '#fdf3d0', sub: '#e3cf92', en: 'DEPARTMENT OF JUSTICE ID', ar: 'هوية وزارة العدل', pattern: 'columns' },
    CIVILIAN: { bg: ['#e8eef2', '#c9d4dc'], accent: '#0f766e', band: '#0f766e', text: '#102a2e', sub: '#3f5560', en: 'CIVILIAN IDENTIFICATION', ar: 'هوية مدنية', pattern: 'waves' }
  };

  const $ = (id) => document.getElementById(id);
  const sock = () => window.blackRidgeSocket || null;
  const S = { meta: null, tab: 'mine', mine: [], admin: [], adminTotal: 0, activity: [], editing: null, userId: '', msg: null };
  const imageCache = new Map();

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) el.setAttribute(key, value);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function call(event, payload) {
    return new Promise((resolve) => {
      const socket = sock();
      if (!socket) return resolve({ ok: false, message: 'الاتصال بالخادم غير جاهز.' });
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, message: 'انتهت مهلة الاتصال.' }); } }, 20000);
      socket.emit(event, payload || {}, (reply) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(reply || { ok: false, message: 'لا يوجد رد من الخادم.' });
      });
    });
  }

  const day = (iso) => String(iso || '').slice(0, 10);
  const stamp = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');
  function inDays(count) {
    const d = new Date(Date.now() + count * 86400000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const endOfDayIso = (dateValue) => new Date(dateValue + 'T23:59:00').toISOString();

  /* ---------------- canvas badge card ---------------- */
  function roundRect(ctx, x, y, w, h2, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h2, r);
    ctx.arcTo(x + w, y + h2, x, y + h2, r);
    ctx.arcTo(x, y + h2, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function put(ctx, value, x, y, o) {
    let size = o.size || 24;
    ctx.save();
    ctx.fillStyle = o.color;
    ctx.textAlign = o.align || 'right';
    ctx.direction = o.dir || 'rtl';
    const setFont = () => { ctx.font = (o.weight || '700') + ' ' + size + 'px ' + FONT; };
    setFont();
    const content = String(value == null ? '' : value);
    while (o.max && ctx.measureText(content).width > o.max && size > 12) { size -= 1; setFont(); }
    ctx.fillText(content, x, y);
    ctx.restore();
  }

  function drawPattern(ctx, theme) {
    ctx.save();
    ctx.globalAlpha = 0.09;
    ctx.strokeStyle = theme.accent;
    ctx.fillStyle = theme.accent;
    ctx.lineWidth = 2;
    if (theme.pattern === 'stripes') {
      for (let i = -H; i < W; i += 38) { ctx.beginPath(); ctx.moveTo(i, H); ctx.lineTo(i + H, 0); ctx.stroke(); }
    } else if (theme.pattern === 'grid') {
      for (let x = 0; x < W; x += 42) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 42) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    } else if (theme.pattern === 'dots') {
      for (let x = 20; x < W; x += 34) for (let y = 20; y < H; y += 34) { ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); }
    } else if (theme.pattern === 'lines') {
      for (let y = 0; y < H; y += 14) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    } else if (theme.pattern === 'columns') {
      for (let x = 0; x < W; x += 60) { ctx.fillRect(x, 0, 18, H); }
    } else {
      for (let y = 30; y < H; y += 36) {
        ctx.beginPath();
        for (let x = 0; x <= W; x += 20) ctx.lineTo(x, y + Math.sin(x / 40) * 8);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Original fictional emblems drawn from simple shapes; no real seals or logos are used.
  function drawEmblem(ctx, type, cx, cy, r, color, onColor) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = onColor;
    ctx.strokeStyle = onColor;
    ctx.lineWidth = r * 0.08;
    if (type === 'MILITARY') {
      ctx.beginPath();
      for (let i = 0; i < 10; i += 1) {
        const rad = i % 2 ? r * 0.28 : r * 0.62;
        const a = -Math.PI / 2 + i * Math.PI / 5;
        ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath(); ctx.fill();
    } else if (type === 'POLICE') {
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.65); ctx.lineTo(r * 0.5, -r * 0.4); ctx.lineTo(r * 0.45, r * 0.15);
      ctx.quadraticCurveTo(r * 0.3, r * 0.5, 0, r * 0.68);
      ctx.quadraticCurveTo(-r * 0.3, r * 0.5, -r * 0.45, r * 0.15);
      ctx.lineTo(-r * 0.5, -r * 0.4); ctx.closePath(); ctx.fill();
    } else if (type === 'EMS') {
      ctx.fillRect(-r * 0.16, -r * 0.58, r * 0.32, r * 1.16);
      ctx.fillRect(-r * 0.58, -r * 0.16, r * 1.16, r * 0.32);
    } else if (type === 'MEDIA') {
      ctx.fillRect(-r * 0.16, -r * 0.5, r * 0.32, r * 0.62);
      ctx.beginPath(); ctx.arc(0, -r * 0.5, r * 0.16, Math.PI, 0); ctx.fill();
      ctx.beginPath(); ctx.arc(0, -r * 0.02, r * 0.36, 0, Math.PI); ctx.stroke();
      ctx.fillRect(-r * 0.04, r * 0.34, r * 0.08, r * 0.26);
      ctx.fillRect(-r * 0.24, r * 0.56, r * 0.48, r * 0.07);
    } else if (type === 'JUSTICE') {
      ctx.fillRect(-r * 0.04, -r * 0.55, r * 0.08, r * 1.05);
      ctx.fillRect(-r * 0.5, -r * 0.5, r, r * 0.07);
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.arc(side * r * 0.4, r * 0.05, r * 0.2, 0, Math.PI); ctx.fill();
        ctx.beginPath(); ctx.moveTo(side * r * 0.5, -r * 0.45); ctx.lineTo(side * r * 0.22, r * 0.05); ctx.lineTo(side * r * 0.58, r * 0.05); ctx.closePath(); ctx.stroke();
      }
      ctx.fillRect(-r * 0.3, r * 0.5, r * 0.6, r * 0.08);
    } else {
      ctx.beginPath(); ctx.arc(0, -r * 0.2, r * 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0, r * 0.62, r * 0.42, Math.PI, 0); ctx.fill();
    }
    ctx.restore();
  }

  function drawBars(ctx, seed, x, y, w, barH, color) {
    let n = 0;
    for (const ch of String(seed)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    ctx.save();
    ctx.fillStyle = color;
    let cursor = x;
    while (cursor < x + w) {
      n = (n * 1103515245 + 12345) >>> 0;
      const width = 2 + (n % 4);
      if ((n >> 8) % 3) ctx.fillRect(cursor, y, width, barH);
      cursor += width + 2;
    }
    ctx.restore();
  }

  function loadImage(src) {
    if (!src) return Promise.resolve(null);
    if (imageCache.has(src)) return imageCache.get(src);
    const promise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    imageCache.set(src, promise);
    return promise;
  }

  async function drawBadge(canvas, badge) {
    const theme = THEMES[badge.type] || THEMES.CIVILIAN;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const photo = await loadImage(badge.photo);

    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, theme.bg[0]);
    grad.addColorStop(1, theme.bg[1]);
    ctx.save(); roundRect(ctx, 0, 0, W, H, 34); ctx.clip();
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    drawPattern(ctx, theme);

    // header band
    ctx.fillStyle = theme.band; ctx.fillRect(0, 0, W, 112);
    ctx.fillStyle = theme.accent; ctx.fillRect(0, 112, W, 6);
    drawEmblem(ctx, badge.type, W - 78, 58, 40, theme.accent, theme.band);
    const headText = badge.type === 'EMS' || badge.type === 'CIVILIAN' ? '#ffffff' : theme.text;
    put(ctx, theme.ar, W - 138, 54, { size: 36, color: headText, weight: '800' });
    put(ctx, theme.en, W - 138, 88, { size: 19, color: headText, dir: 'ltr', align: 'right', weight: '600' });
    put(ctx, 'BLACKRIDGE CITY RP', 40, 62, { size: 20, color: headText, dir: 'ltr', align: 'left', weight: '700' });

    // photo
    ctx.save();
    roundRect(ctx, 40, 150, 240, 300, 16); ctx.clip();
    ctx.fillStyle = 'rgba(128,128,128,.25)'; ctx.fillRect(40, 150, 240, 300);
    if (photo) {
      const scale = Math.max(240 / photo.width, 300 / photo.height);
      const dw = photo.width * scale; const dh = photo.height * scale;
      ctx.drawImage(photo, 40 + (240 - dw) / 2, 150 + (300 - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = theme.accent; ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(160, 265, 52, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(160, 440, 100, Math.PI, 0); ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = theme.accent; ctx.lineWidth = 4; roundRect(ctx, 40, 150, 240, 300, 16); ctx.stroke();
    drawBars(ctx, badge.badgeNumber, 40, 470, 240, 54, theme.text);

    // fields
    const right = W - 44;
    put(ctx, 'الاسم المستعار', right, 168, { size: 20, color: theme.sub, weight: '600' });
    put(ctx, badge.alias, right, 226, { size: 54, color: theme.text, weight: '800', max: 640 });
    put(ctx, 'الرتبة / الصفة', right, 276, { size: 20, color: theme.sub, weight: '600' });
    put(ctx, badge.title, right, 316, { size: 34, color: theme.accent, weight: '800', max: 640 });
    put(ctx, 'القطاع / الجهة', right, 366, { size: 20, color: theme.sub, weight: '600' });
    put(ctx, badge.sector, right, 406, { size: 32, color: theme.text, weight: '700', max: 640 });

    const rows = [['رقم البادج', badge.badgeNumber, 'ltr'], ['تاريخ الإنشاء', day(badge.createdAt), 'ltr'], ['ينتهي في', day(badge.expiresAt), 'ltr']];
    rows.forEach((row, i) => {
      const x = right - i * 232;
      put(ctx, row[0], x, 466, { size: 18, color: theme.sub, weight: '600' });
      put(ctx, row[1], x, 504, { size: 28, color: theme.text, dir: row[2], weight: '800', max: 214 });
    });

    // Only a server-approved badge receives the in-game approval statement.
    ctx.fillStyle = theme.band; ctx.globalAlpha = 0.92; ctx.fillRect(0, 548, W, 90); ctx.globalAlpha = 1;
    const approved = badge.isApproved === true;
    const approvalStatus = badge.reviewStatus || 'PENDING_REVIEW';
    const footerAr = approved
      ? NOTICE_AR
      : approvalStatus === 'REJECTED' ? 'مرفوضة — غير معتمدة داخل النظام' : 'قيد المراجعة — غير معتمدة';
    const footerEn = approved
      ? NOTICE_EN
      : approvalStatus === 'REJECTED' ? 'REJECTED · NOT APPROVED' : 'PENDING REVIEW · NOT APPROVED';
    put(ctx, footerAr, W / 2, 588, { size: 24, color: headText, align: 'center', weight: '700', max: W - 60 });
    put(ctx, footerEn, W / 2, 620, { size: 15, color: headText, align: 'center', dir: 'ltr', weight: '600', max: W - 60 });

    // status stamp
    if (badge.status && badge.status !== 'ACTIVE') {
      ctx.save();
      ctx.translate(W / 2, 330); ctx.rotate(-0.28);
      ctx.globalAlpha = 0.82;
      ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 10;
      roundRect(ctx, -260, -70, 520, 140, 18); ctx.stroke();
      put(ctx, STATUS_AR[badge.status] || badge.status, 0, 28, { size: 90, color: '#dc2626', align: 'center', weight: '900' });
      ctx.restore();
    }
    ctx.restore();
    ctx.strokeStyle = theme.accent; ctx.lineWidth = 6; roundRect(ctx, 3, 3, W - 6, H - 6, 32); ctx.stroke();
  }

  function downloadBadge(badge) {
    const canvas = document.createElement('canvas');
    drawBadge(canvas, badge).then(() => {
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = h('a', { href: url, download: 'badge-' + badge.badgeNumber + '.png' });
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }, 'image/png');
    });
  }

  /* ---------------- UI ---------------- */
  function setMsg(text, kind) { S.msg = text ? { text, kind } : null; const el = $('cvr-msg'); if (el) { el.textContent = text || ''; el.className = 'cvr-msg ' + (kind || ''); } }

  function ensurePane() {
    let pane = $('cover-identity-view');
    if (pane) return pane;
    const host = document.querySelector('.content-area');
    if (!host) return null;
    pane = h('div', { id: 'cover-identity-view', class: 'view-pane', 'aria-label': 'نظام الهويات الميدانية' });
    host.append(pane);
    return pane;
  }

  function badgeCanvas(badge) {
    const canvas = h('canvas', { width: W, height: H, role: 'img', 'aria-label': 'بادج ' + badge.badgeNumber });
    drawBadge(canvas, badge);
    return canvas;
  }

  function render() {
    const pane = ensurePane();
    if (!pane) return;
    const admin = S.meta && S.meta.canAdmin;
    pane.replaceChildren(h('div', { class: 'cvr-wrap' },
      h('div', { class: 'cvr-head' },
        h('h2', { text: 'نظام الهويات الميدانية · COVER IDENTITY SYSTEM' }),
        h('p', { text: 'إنشاء وإدارة بادجات وهويات عمليات UNDERCOVER داخل اللعبة.' })),
      h('div', { class: 'cvr-notice', text: S.meta ? S.meta.notice + ' — لا تُستخدم شعارات أو أختام حكومية حقيقية.' : '' }),
      h('div', { class: 'cvr-tabs' },
        tabButton('mine', 'بادجاتي'),
        tabButton('create', S.editing ? 'تعديل البادج' : 'إنشاء بادج'),
        admin ? tabButton('admin', 'لوحة القيادة') : null),
      h('div', { id: 'cvr-body' }),
      h('div', { id: 'cvr-msg', class: 'cvr-msg ' + (S.msg ? S.msg.kind : ''), text: S.msg ? S.msg.text : '' })));
    renderBody();
  }

  function tabButton(key, label) {
    return h('button', { type: 'button', class: 'cvr-tab' + (S.tab === key ? ' active' : ''), text: label, onclick: () => { S.tab = key; if (key !== 'create') S.editing = null; render(); refreshTab(); } });
  }

  function renderBody() {
    const body = $('cvr-body');
    if (!body) return;
    body.replaceChildren(S.tab === 'create' ? formView() : S.tab === 'admin' ? adminView() : mineView());
  }

  function mineView() {
    if (!S.mine.length) return h('div', { class: 'cvr-empty', text: 'لا توجد بادجات بعد. أنشئ أول بادج من تبويب «إنشاء بادج».' });
    return h('div', { class: 'cvr-grid' }, S.mine.map((badge) => badgeItem(badge)));
  }

  function badgeItem(badge) {
    return h('div', { class: 'cvr-item' },
      badgeCanvas(badge),
      h('div', { class: 'cvr-meta' },
        h('span', { text: badge.typeLabel + ' · ' + badge.badgeNumber }),
        h('span', { class: 'cvr-chip ' + badge.status, text: STATUS_AR[badge.status] || badge.status })),
      h('div', { class: 'cvr-actions' },
        h('button', { type: 'button', class: 'cvr-btn', text: 'التفاصيل', onclick: () => openDetail(badge.id) }),
        h('button', { type: 'button', class: 'cvr-btn', text: 'تنزيل PNG', onclick: () => downloadBadge(badge) }),
        badge.can.edit ? h('button', { type: 'button', class: 'cvr-btn', text: 'تعديل', onclick: () => { S.editing = badge; S.tab = 'create'; render(); } }) : null));
  }

  function field(label, input, wide) { return h('label', { class: wide ? 'wide' : '' }, label, input); }

  function formView() {
    const editing = S.editing;
    const types = (S.meta && S.meta.types) || [];
    const typeSelect = h('select', { id: 'cvr-type', disabled: editing ? 'disabled' : false },
      types.map((t) => h('option', { value: t.key, text: t.labelAr + ' — ' + t.label, selected: editing && editing.type === t.key ? 'selected' : false })));
    const inputs = {
      alias: h('input', { id: 'cvr-alias', maxlength: 60, value: editing ? editing.alias : '' }),
      title: h('input', { id: 'cvr-title', maxlength: 60, value: editing ? editing.title : '' }),
      sector: h('input', { id: 'cvr-sector', maxlength: 80, value: editing ? editing.sector : '' }),
      number: h('input', { id: 'cvr-number', maxlength: 24, dir: 'ltr', placeholder: 'اتركه فارغًا للتوليد التلقائي', value: editing ? editing.badgeNumber : '', disabled: editing ? 'disabled' : false }),
      expires: h('input', { id: 'cvr-expires', type: 'date', value: editing ? day(editing.expiresAt) : inDays(7), disabled: editing ? 'disabled' : false }),
      purpose: h('textarea', { id: 'cvr-purpose', maxlength: 300, rows: 3 }, editing ? editing.purpose : ''),
      photo: h('input', { id: 'cvr-photo', type: 'file', accept: 'image/png,image/jpeg,image/webp' })
    };
    let photoData = editing && editing.photo ? editing.photo : undefined;
    const previewHost = h('div', { class: 'cvr-preview' });
    const preview = () => {
      const typeKey = editing ? editing.type : typeSelect.value;
      const sample = {
        type: typeKey, badgeNumber: inputs.number.value || 'AUTO-000000', alias: inputs.alias.value || 'الاسم المستعار',
        title: inputs.title.value || 'الرتبة', sector: inputs.sector.value || 'الجهة',
        status: 'PENDING_REVIEW', reviewStatus: 'PENDING_REVIEW', isApproved: false,
        createdAt: editing ? editing.createdAt : new Date().toISOString(), expiresAt: inputs.expires.value ? endOfDayIso(inputs.expires.value) : new Date().toISOString(),
        photo: photoData
      };
      previewHost.replaceChildren(badgeCanvas(sample));
    };
    [typeSelect, inputs.alias, inputs.title, inputs.sector, inputs.number, inputs.expires].forEach((el) => el.addEventListener('input', preview));
    inputs.photo.addEventListener('change', async () => {
      const file = inputs.photo.files && inputs.photo.files[0];
      if (!file) return;
      try { photoData = await shrinkPhoto(file); setMsg('', ''); } catch (error) { photoData = undefined; setMsg(error.message, 'error'); }
      preview();
    });
    const save = h('button', { type: 'button', class: 'cvr-btn primary', text: editing ? 'حفظ التعديلات' : 'إنشاء البادج', onclick: async () => {
      save.disabled = true;
      const payload = { alias: inputs.alias.value, title: inputs.title.value, sector: inputs.sector.value, purpose: inputs.purpose.value };
      if (photoData !== undefined && (!editing || photoData !== editing.photo)) payload.photo = photoData;
      let reply;
      if (editing) { payload.id = editing.id; reply = await call('cover:update', payload); }
      else {
        payload.type = typeSelect.value; payload.badgeNumber = inputs.number.value;
        payload.expiresAt = inputs.expires.value ? endOfDayIso(inputs.expires.value) : '';
        reply = await call('cover:create', payload);
      }
      save.disabled = false;
      if (!reply.ok) return setMsg(reply.message, 'error');
      S.editing = null; S.tab = 'mine';
      await loadMine();
      setMsg(editing ? 'تم حفظ التعديلات وإرسال الهوية للمراجعة.' : 'تم إنشاء البادج برقم ' + reply.badge.badgeNumber + ' وإرساله للمراجعة.', 'ok');
      render();
    } });
    const cancel = editing ? h('button', { type: 'button', class: 'cvr-btn', text: 'إلغاء التعديل', onclick: () => { S.editing = null; S.tab = 'mine'; render(); } }) : null;
    setTimeout(preview, 0);
    return h('div', null,
      h('div', { class: 'cvr-form' },
        field('نوع البادج', typeSelect),
        field('الاسم المستعار', inputs.alias),
        field('الرتبة أو الصفة داخل الهوية', inputs.title),
        field('القطاع أو الجهة الظاهرة', inputs.sector),
        field('رقم تعريف البادج', inputs.number),
        field('تاريخ انتهاء الصلاحية', inputs.expires),
        field('سبب إنشاء الهوية أو اسم المهمة', inputs.purpose, true),
        field('صورة (اختيارية)', inputs.photo, true)),
      h('p', { class: 'cvr-empty', text: 'سيُسجَّل اسمك الحقيقي وكودك العسكري مع البادج ويراه القادة المخوّلون فقط، ولا يظهر على البطاقة.' }),
      h('div', { class: 'cvr-actions' }, save, cancel),
      previewHost);
  }

  function shrinkPhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 480 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        for (const quality of [0.85, 0.7, 0.55, 0.4]) {
          const data = canvas.toDataURL('image/jpeg', quality);
          if (data.length < 300000) return resolve(data);
        }
        reject(new Error('الصورة كبيرة جدًا. اختر صورة أصغر.'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('تعذر قراءة الصورة.')); };
      img.src = url;
    });
  }

  function adminView() {
    const query = h('input', { id: 'cvr-q', placeholder: 'بحث: عضو، كود عسكري، رقم بادج' });
    const type = h('select', { id: 'cvr-ft' }, h('option', { value: '', text: 'كل الأنواع' }), ((S.meta && S.meta.types) || []).map((t) => h('option', { value: t.key, text: t.labelAr })));
    const status = h('select', { id: 'cvr-fs' }, h('option', { value: '', text: 'كل الحالات' }), Object.entries(STATUS_AR).map(([k, v]) => h('option', { value: k, text: v })));
    const run = async () => { await loadAdmin({ query: query.value, type: type.value, status: status.value }); renderBody(); };
    query.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    type.addEventListener('change', run); status.addEventListener('change', run);
    const rows = S.admin.map((b) => h('tr', null,
      h('td', null, h('button', { type: 'button', class: 'cvr-btn', text: b.badgeNumber, onclick: () => openDetail(b.id) })),
      h('td', { text: b.typeLabel }), h('td', { text: b.alias }),
      h('td', { text: b.owner.name + ' (' + b.owner.militaryCode + ')' }),
      h('td', { text: day(b.createdAt) }), h('td', { text: day(b.expiresAt) }),
      h('td', null, h('span', { class: 'cvr-chip ' + b.status, text: STATUS_AR[b.status] || b.status }))));
    const feed = S.activity.map((a) => {
      const reviewer = ['APPROVED', 'REJECTED'].includes(a.action)
        ? ' · ' + [a.byCode, a.byRank, a.bySector].filter(Boolean).join(' · ')
        : '';
      return h('li', { text: stamp(a.at) + ' · ' + (ACTION_AR[a.action] || a.action) + ' · ' + a.badgeNumber + ' · ' + a.ownerName + ' (' + a.ownerCode + ') · بواسطة ' + a.byName + reviewer + (a.note ? ' — ' + a.note : '') });
    });
    return h('div', null,
      h('div', { class: 'cvr-filters' }, query, type, status, h('button', { type: 'button', class: 'cvr-btn primary', text: 'بحث', onclick: run })),
      h('div', { class: 'cvr-empty', text: 'عدد النتائج: ' + S.adminTotal + (S.meta && S.meta.scope === 'SECTOR' ? ' (أفراد قطاعك فقط)' : '') }),
      h('div', { class: 'cvr-table-wrap' }, h('table', { class: 'cvr-table' },
        h('thead', null, h('tr', null, ['الرقم', 'النوع', 'الاسم المستعار', 'العضو الحقيقي', 'الإنشاء', 'الانتهاء', 'الحالة'].map((t) => h('th', { text: t })))),
        h('tbody', null, rows))),
      h('h3', { text: 'آخر العمليات (إنشاء · مراجعة · اعتماد · رفض · تعديل · إلغاء)' }),
      h('ul', { class: 'cvr-feed' }, feed));
  }

  async function openDetail(id) {
    const reply = await call('cover:get', { id });
    if (!reply.ok) return setMsg(reply.message, 'error');
    const badge = reply.badge;
    const overlay = h('div', { class: 'cvr-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
    const reason = h('textarea', {
      rows: 2,
      maxlength: 300,
      placeholder: badge.can.reject
        ? 'سبب الرفض (مطلوب عند الرفض)'
        : 'سبب الإلغاء أو التعطيل (مطلوب)'
    });
    const renewDate = h('input', { type: 'date', value: inDays(7) });
    const msg = h('div', { class: 'cvr-msg' });
    const act = (label, cls, fn) => h('button', { type: 'button', class: 'cvr-btn ' + cls, text: label, onclick: async () => {
      const result = await fn();
      if (!result.ok) { msg.textContent = result.message; msg.className = 'cvr-msg error'; return; }
      overlay.remove(); await refreshTab(); setMsg('تم تنفيذ العملية.', 'ok'); render();
    } });
    const actions = [h('button', { type: 'button', class: 'cvr-btn', text: 'تنزيل PNG', onclick: () => downloadBadge(badge) })];
    if (badge.can.approve) {
      actions.push(act('اعتماد الهوية', 'primary', () => call('cover:approve', { id })));
    }
    if (badge.can.reject) {
      actions.push(act('رفض الهوية', 'danger', () => call('cover:reject', { id, reason: reason.value })));
    }
    if (badge.can.renew) actions.push(renewDate, act('تجديد', '', () => call('cover:renew', { id, expiresAt: endOfDayIso(renewDate.value) })));
    if (badge.can.revoke) actions.push(act('إلغاء البادج', 'danger', () => call('cover:revoke', { id, reason: reason.value })));
    if (badge.can.disable) actions.push(act('تعطيل', 'danger', () => call('cover:disable', { id, reason: reason.value })));
    if (badge.can.enable) actions.push(act('إعادة تفعيل', '', () => call('cover:enable', { id })));
    overlay.append(h('div', { class: 'cvr-modal' },
      badgeCanvas(badge),
      h('div', { class: 'cvr-meta' },
        h('span', { text: 'العضو: ' + badge.owner.name + ' (' + badge.owner.militaryCode + ')' }),
        h('span', { class: 'cvr-chip ' + badge.status, text: STATUS_AR[badge.status] || badge.status })),
      h('div', { class: 'cvr-meta', text: 'المهمة: ' + badge.purpose }),
      badge.statusReason ? h('div', { class: 'cvr-meta', text: 'سبب الحالة: ' + badge.statusReason }) : null,
      (badge.can.revoke || badge.can.disable || badge.can.reject) ? reason : null,
      h('div', { class: 'cvr-actions' }, actions),
      msg,
      h('ul', { class: 'cvr-history' }, (badge.history || []).slice().reverse().map((e) => {
        const reviewer = ['APPROVED', 'REJECTED'].includes(e.action)
          ? ' · ' + [e.byCode, e.byRank, e.bySector].filter(Boolean).join(' · ')
          : '';
        return h('li', { text: stamp(e.at) + ' · ' + (ACTION_AR[e.action] || e.action) + ' · ' + e.byName + reviewer + (e.note ? ' — ' + e.note : '') });
      })),
      h('div', { class: 'cvr-actions' }, h('button', { type: 'button', class: 'cvr-btn', text: 'إغلاق', onclick: () => overlay.remove() }))));
    document.body.append(overlay);
  }

  async function loadMine() { const r = await call('cover:mine'); if (r.ok) S.mine = r.badges; else setMsg(r.message, 'error'); }
  async function loadAdmin(filters) {
    const r = await call('cover:admin:list', filters || {});
    if (r.ok) { S.admin = r.badges; S.adminTotal = r.total; } else setMsg(r.message, 'error');
    const feed = await call('cover:admin:activity');
    if (feed.ok) S.activity = feed.activity;
  }
  async function refreshTab() {
    if (S.tab === 'mine') await loadMine();
    if (S.tab === 'admin') await loadAdmin();
    renderBody();
  }

  async function open() {
    const meta = await call('cover:meta');
    if (!meta.ok) { S.meta = null; ensurePane(); return setMsg(meta.message, 'error'); }
    S.meta = meta;
    render();
    await refreshTab();
  }

  function currentUserSafe() { try { return typeof currentUser !== 'undefined' ? currentUser : null; } catch (_e) { return null; } }
  function sessionOk() { try { return typeof ciaSessionAuthenticated !== 'undefined' && ciaSessionAuthenticated === true; } catch (_e) { return false; } }

  function syncNav() {
    const user = currentUserSafe();
    const nav = $('cover-identity-nav');
    if (nav) nav.style.display = user && sessionOk() ? 'flex' : 'none';
    const id = user ? String(user.id || '') : '';
    if (id !== S.userId) { S.userId = id; S.meta = null; S.mine = []; S.admin = []; S.activity = []; S.editing = null; S.tab = 'mine'; S.msg = null; }
  }

  function boot() {
    ensurePane();
    const nav = $('cover-identity-nav');
    if (nav) nav.addEventListener('click', () => { if (currentUserSafe() && sessionOk()) open(); });
    setInterval(syncNav, 1500);
    syncNav();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  window.blackRidgeCoverIdentity = { drawBadge, THEMES };
})();
