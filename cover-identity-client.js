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
    MILITARY: { bg: ['#1c1b16', '#080909'], accent: '#d1b15c', band: '#15140f', text: '#f4eedc', sub: '#b6aa82', en: 'MILITARY IDENTIFICATION', ar: 'هوية عسكرية', pattern: 'mesh' },
    POLICE: { bg: ['#111b29', '#070b11'], accent: '#4b78a5', band: '#101a29', text: '#edf3f8', sub: '#9eb1c2', en: 'POLICE ID', ar: 'هوية الشرطة', pattern: 'grid' },
    EMS: { bg: ['#102019', '#070b09'], accent: '#37a879', band: '#10231b', text: '#e9f5ee', sub: '#a4c9b4', en: 'MEDICAL ID', ar: 'هوية طبية', pattern: 'dots' },
    MEDIA: { bg: ['#222629', '#090b0d'], accent: '#c0c7ce', band: '#1b1f22', text: '#f4f5f6', sub: '#b0b7bd', en: 'PRESS ID', ar: 'هوية إعلامية', pattern: 'lines' },
    JUSTICE: { bg: ['#241117', '#080809'], accent: '#c9aa5c', band: '#2b121a', text: '#f5ebdc', sub: '#c6a88f', en: 'DEPARTMENT OF JUSTICE ID', ar: 'هوية وزارة العدل', pattern: 'columns' },
    CIVILIAN: { bg: ['#1b2224', '#090c0e'], accent: '#91a8a5', band: '#182124', text: '#edf3f2', sub: '#a8b9b7', en: 'CIVILIAN IDENTIFICATION', ar: 'هوية مدنية', pattern: 'waves' }
  };

  const $ = (id) => document.getElementById(id);
  const sock = () => window.blackRidgeSocket || null;
  const S = { meta: null, tab: 'mine', mine: [], admin: [], adminTotal: 0, reviewQueue: [], activity: [], editing: null, userId: '', msg: null };
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
  function ownerInfo(owner) {
    const fields = [];
    if (owner && owner.name) fields.push('الاسم الحقيقي: ' + owner.name);
    if (owner && owner.militaryCode) fields.push('الكود العسكري: ' + owner.militaryCode);
    return fields.join(' · ') || '—';
  }
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
    ctx.globalAlpha = 0.045;
    ctx.strokeStyle = theme.accent;
    ctx.fillStyle = theme.accent;
    ctx.lineWidth = 1;
    if (theme.pattern === 'mesh') {
      for (let i = -H; i < W; i += 46) { ctx.beginPath(); ctx.moveTo(i, H); ctx.lineTo(i + H, 0); ctx.stroke(); }
      for (let i = 0; i < W; i += 92) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, H); ctx.stroke(); }
    } else if (theme.pattern === 'grid') {
      for (let x = 0; x < W; x += 46) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 46) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    } else if (theme.pattern === 'dots') {
      for (let x = 18; x < W; x += 38) for (let y = 18; y < H; y += 38) { ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill(); }
    } else if (theme.pattern === 'lines') {
      for (let y = 0; y < H; y += 18) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    } else if (theme.pattern === 'columns') {
      for (let x = 0; x < W; x += 72) { ctx.fillRect(x, 0, 7, H); }
    } else {
      for (let y = 32; y < H; y += 42) {
        ctx.beginPath();
        for (let x = 0; x <= W; x += 22) ctx.lineTo(x, y + Math.sin(x / 42) * 5);
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

  // Abstract BLACKRIDGE wordmark; this is original artwork, not a government seal.
  function drawBrandMark(ctx, x, y, theme) {
    ctx.save();
    ctx.fillStyle = 'rgba(5, 7, 9, .72)';
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, 58, 58, 10); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(x + 10, y + 40); ctx.lineTo(x + 22, y + 24); ctx.lineTo(x + 29, y + 32);
    ctx.lineTo(x + 39, y + 17); ctx.lineTo(x + 49, y + 40); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 10, y + 45); ctx.lineTo(x + 49, y + 45); ctx.stroke();
    ctx.restore();
  }

  function drawReviewStamp(ctx, x, y, w, h2, status, theme) {
    const colors = { APPROVED: '#52b486', PENDING: '#d3a74e', REJECTED: '#d46d72' };
    const labels = { APPROVED: 'معتمدة', PENDING: 'قيد المراجعة', REJECTED: 'مرفوضة' };
    const color = colors[status] || colors.PENDING;
    ctx.save();
    ctx.fillStyle = 'rgba(5, 7, 9, .68)';
    roundRect(ctx, x, y, w, h2, 9); ctx.fill();
    ctx.globalAlpha = 0.12; ctx.fillStyle = color; roundRect(ctx, x, y, w, h2, 9); ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = color; ctx.lineWidth = 2.2; roundRect(ctx, x, y, w, h2, 9); ctx.stroke();
    if (status === 'APPROVED') { ctx.lineWidth = 1; roundRect(ctx, x + 5, y + 5, w - 10, h2 - 10, 6); ctx.stroke(); }
    put(ctx, status, x + w / 2, y + 31, { size: 23, color, align: 'center', dir: 'ltr', weight: '900' });
    put(ctx, labels[status] || labels.PENDING, x + w / 2, y + 53, { size: 14, color: theme.text, align: 'center', weight: '700' });
    ctx.restore();
  }

  function drawIdentityCell(ctx, label, value, right, y, width, theme, dir) {
    const x = right - width;
    ctx.save();
    ctx.fillStyle = 'rgba(5, 8, 11, .42)';
    roundRect(ctx, x, y, width, 72, 8); ctx.fill();
    ctx.globalAlpha = 0.32; ctx.strokeStyle = theme.accent; ctx.lineWidth = 1.2; roundRect(ctx, x, y, width, 72, 8); ctx.stroke(); ctx.globalAlpha = 1;
    put(ctx, label, right - 12, y + 23, { size: 17, color: theme.sub, weight: '600', max: width - 26 });
    const content = value == null || String(value).trim() === '' ? '—' : value;
    put(ctx, content, right - 12, y + 54, { size: 27, color: theme.text, weight: '800', dir: dir || 'rtl', max: width - 26 });
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
    const rawReview = String(badge.reviewStatus || 'PENDING_REVIEW').toUpperCase();
    const reviewStatus = rawReview === 'REJECTED' ? 'REJECTED' :
      (rawReview === 'APPROVED' && badge.isApproved === true ? 'APPROVED' : 'PENDING');

    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, theme.bg[0]);
    grad.addColorStop(1, theme.bg[1]);
    ctx.save();
    roundRect(ctx, 0, 0, W, H, 32); ctx.clip();
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    drawPattern(ctx, theme);

    // Restrained metallic header and fictional brand mark.
    const headGrad = ctx.createLinearGradient(0, 0, W, 0);
    headGrad.addColorStop(0, theme.band);
    headGrad.addColorStop(0.55, theme.bg[0]);
    headGrad.addColorStop(1, theme.band);
    ctx.fillStyle = headGrad; ctx.fillRect(0, 0, W, 112);
    ctx.fillStyle = theme.accent; ctx.globalAlpha = 0.82; ctx.fillRect(0, 110, W, 2); ctx.globalAlpha = 1;
    drawBrandMark(ctx, 30, 25, theme);
    put(ctx, 'BLACKRIDGE', 104, 49, { size: 23, color: theme.text, dir: 'ltr', align: 'left', weight: '900' });
    put(ctx, 'CITY ROLEPLAY', 105, 73, { size: 14, color: theme.accent, dir: 'ltr', align: 'left', weight: '700' });
    put(ctx, 'COVER IDENTITY SYSTEM', 105, 96, { size: 11, color: theme.sub, dir: 'ltr', align: 'left', weight: '600' });
    drawReviewStamp(ctx, 386, 21, 240, 72, reviewStatus, theme);
    drawEmblem(ctx, badge.type, 680, 56, 29, theme.accent, theme.band);
    put(ctx, theme.ar, 974, 49, { size: 25, color: theme.text, weight: '800', max: 244 });
    put(ctx, theme.en, 974, 80, { size: 15, color: theme.sub, dir: 'ltr', align: 'right', weight: '700', max: 244 });

    // Portrait and metallic inset frame.
    ctx.fillStyle = 'rgba(3, 5, 7, .58)';
    roundRect(ctx, 27, 137, 232, 290, 16); ctx.fill();
    ctx.save();
    roundRect(ctx, 34, 144, 218, 276, 12); ctx.clip();
    ctx.fillStyle = 'rgba(128, 128, 128, .18)'; ctx.fillRect(34, 144, 218, 276);
    if (photo) {
      const scale = Math.max(218 / photo.width, 276 / photo.height);
      const dw = photo.width * scale; const dh = photo.height * scale;
      ctx.drawImage(photo, 34 + (218 - dw) / 2, 144 + (276 - dh) / 2, dw, dh);
      ctx.fillStyle = 'rgba(4, 6, 8, .12)'; ctx.fillRect(34, 144, 218, 276);
    } else {
      ctx.fillStyle = theme.accent; ctx.globalAlpha = 0.45;
      ctx.beginPath(); ctx.arc(143, 242, 47, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(143, 420, 88, Math.PI, 0); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.strokeStyle = theme.accent; ctx.lineWidth = 2.5; roundRect(ctx, 27, 137, 232, 290, 16); ctx.stroke();
    ctx.globalAlpha = 0.86; drawBars(ctx, badge.badgeNumber, 34, 438, 218, 34, theme.accent); ctx.globalAlpha = 1;

    // Identity fields use existing badge and owner data only.
    const right = W - 34;
    put(ctx, 'الاسم المستعار', right, 151, { size: 17, color: theme.sub, weight: '600' });
    put(ctx, badge.alias, right, 207, { size: 48, color: theme.text, weight: '900', max: 670 });
    const leftColumn = 620;
    const columnWidth = 326;
    drawIdentityCell(ctx, 'الرتبة / الصفة', badge.title, right, 250, columnWidth, theme, 'rtl');
    const ownerName = badge.owner && badge.owner.name;
    const ownerCode = badge.owner && badge.owner.militaryCode;
    const ownerCardField = ownerName && !ownerCode
      ? { label: 'الاسم الحقيقي', value: ownerName, dir: 'rtl' }
      : { label: 'الكود العسكري', value: ownerCode, dir: 'ltr' };
    drawIdentityCell(ctx, ownerCardField.label, ownerCardField.value, leftColumn, 250, columnWidth, theme, ownerCardField.dir);
    drawIdentityCell(ctx, 'القطاع / الجهة', badge.sector, right, 334, columnWidth, theme, 'rtl');
    drawIdentityCell(ctx, 'رقم الهوية الفريد', badge.badgeNumber, leftColumn, 334, columnWidth, theme, 'ltr');
    drawIdentityCell(ctx, 'تاريخ الإصدار', day(badge.createdAt), right, 418, columnWidth, theme, 'ltr');
    drawIdentityCell(ctx, 'صالح حتى', day(badge.expiresAt), leftColumn, 418, columnWidth, theme, 'ltr');

    // Review state is distinct from other lifecycle states such as expired or revoked.
    ctx.fillStyle = theme.band; ctx.globalAlpha = 0.96; ctx.fillRect(0, 526, W, 112); ctx.globalAlpha = 1;
    ctx.fillStyle = theme.accent; ctx.globalAlpha = 0.76; ctx.fillRect(0, 526, W, 2); ctx.globalAlpha = 1;
    const approved = reviewStatus === 'APPROVED';
    const footerAr = approved
      ? NOTICE_AR
      : reviewStatus === 'REJECTED' ? 'مرفوضة — غير معتمدة داخل النظام' : 'قيد المراجعة — غير معتمدة';
    const footerEn = approved
      ? NOTICE_EN
      : reviewStatus === 'REJECTED' ? 'REJECTED · NOT APPROVED' : 'PENDING REVIEW · NOT APPROVED';
    put(ctx, footerAr, W / 2, 578, { size: 20, color: theme.text, align: 'center', weight: '700', max: W - 48 });
    put(ctx, footerEn, W / 2, 613, { size: 14, color: theme.sub, align: 'center', dir: 'ltr', weight: '700', max: W - 48 });
    if (badge.status && !['ACTIVE', 'PENDING_REVIEW', 'REJECTED'].includes(badge.status)) {
      ctx.fillStyle = 'rgba(5, 7, 9, .78)';
      roundRect(ctx, W - 174, 532, 142, 25, 7); ctx.fill();
      ctx.strokeStyle = '#c86b72'; ctx.lineWidth = 1; roundRect(ctx, W - 174, 532, 142, 25, 7); ctx.stroke();
      put(ctx, STATUS_AR[badge.status] || badge.status, W - 103, 550, { size: 13, color: '#f0b2b6', align: 'center', weight: '700', max: 128 });
    }
    ctx.restore();

    // Double metallic edge, kept separate from the status stamp.
    const frameGrad = ctx.createLinearGradient(0, 0, W, H);
    frameGrad.addColorStop(0, theme.accent);
    frameGrad.addColorStop(0.45, '#e7dfc6');
    frameGrad.addColorStop(1, theme.accent);
    ctx.strokeStyle = frameGrad; ctx.lineWidth = 5; roundRect(ctx, 3, 3, W - 6, H - 6, 29); ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, .15)'; ctx.lineWidth = 1; roundRect(ctx, 11, 11, W - 22, H - 22, 23); ctx.stroke();
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
      h('div', { class: 'cvr-tabs' },
        tabButton('mine', 'بادجاتي'),
        tabButton('create', S.editing ? 'تعديل البادج' : 'إنشاء بادج'),
        admin && S.meta.canReviewQueue
          ? tabButton('review', S.meta.scope === 'SECTOR' ? 'مراجعات القطاع' : 'مراجعات الهويات')
          : null,
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
    body.replaceChildren(
      S.tab === 'create'
        ? formView()
        : S.tab === 'review'
          ? reviewQueueView()
          : S.tab === 'admin'
            ? adminView()
            : mineView()
    );
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

  function reviewQueueView() {
    const title = S.meta && S.meta.scope === 'SECTOR'
      ? 'الهويات والبادجات المعلّقة لأعضاء قطاعك'
      : 'الهويات والبادجات المعلّقة للمراجعة';
    if (!S.reviewQueue.length) {
      return h('section', { class: 'cvr-review-panel' },
        h('h3', { text: title }),
        h('div', { class: 'cvr-empty', text: 'لا توجد هويات بانتظار المراجعة ضمن نطاق صلاحيتك.' }));
    }

    const cards = S.reviewQueue.map((badge) => {
      const reason = h('textarea', {
        class: 'cvr-review-reason',
        rows: 2,
        maxlength: 300,
        required: 'required',
        placeholder: 'سبب الرفض (مطلوب عند الرفض)'
      });
      const message = h('div', { class: 'cvr-msg' });
      let busy = false;
      const decide = async (decision) => {
        if (busy) return;
        if (decision === 'reject' && !String(reason.value || '').trim()) {
          message.textContent = 'اكتب سبب الرفض أولًا.';
          message.className = 'cvr-msg error';
          return;
        }
        busy = true;
        const reply = decision === 'approve'
          ? await call('cover:approve', { id: badge.id })
          : await call('cover:reject', { id: badge.id, reason: String(reason.value).trim() });
        if (!reply.ok) {
          busy = false;
          message.textContent = reply.message;
          message.className = 'cvr-msg error';
          return;
        }
        setMsg(decision === 'approve' ? 'تم اعتماد الهوية وأصبحت فعّالة.' : 'تم رفض الهوية وحفظ سبب الرفض.', 'ok');
        await loadReviewQueue();
        render();
      };
      const actions = [
        h('button', { type: 'button', class: 'cvr-btn', text: 'التفاصيل', onclick: () => openDetail(badge.id) })
      ];
      if (badge.can && badge.can.approve) {
        actions.push(h('button', { type: 'button', class: 'cvr-btn primary', text: 'اعتماد الهوية', onclick: () => decide('approve') }));
      }
      if (badge.can && badge.can.reject) {
        actions.push(h('button', { type: 'button', class: 'cvr-btn danger', text: 'رفض الهوية', onclick: () => decide('reject') }));
      }
      return h('article', { class: 'cvr-review-card' },
        h('div', { class: 'cvr-review-head' },
          h('strong', { text: badge.alias || badge.badgeNumber }),
          h('span', { class: 'cvr-chip PENDING_REVIEW', text: 'قيد المراجعة' })),
        h('div', { class: 'cvr-review-meta' },
          h('span', { text: (badge.typeLabel || badge.type) + ' · ' + badge.badgeNumber }),
          h('span', { text: 'العضو: ' + badge.owner.name + ' (' + badge.owner.militaryCode + ')' }),
          h('span', { text: 'القطاع: ' + (badge.sector || 'غير محدد') }),
          h('span', { text: 'الانتهاء: ' + day(badge.expiresAt) })),
        badge.can && badge.can.reject ? reason : null,
        h('div', { class: 'cvr-actions' }, actions),
        message);
    });
    return h('section', { class: 'cvr-review-panel' },
      h('div', { class: 'cvr-review-summary' },
        h('h3', { text: title }),
        h('span', { class: 'cvr-chip PENDING_REVIEW', text: String(S.reviewQueue.length) + ' معلّق' })),
      h('div', { class: 'cvr-review-list' }, cards));
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
      h('td', { text: ownerInfo(b.owner) }),
      h('td', { text: day(b.createdAt) }), h('td', { text: day(b.expiresAt) }),
      h('td', null, h('span', { class: 'cvr-chip ' + b.status, text: STATUS_AR[b.status] || b.status })),
      h('td', null, b.can && b.can.approve
        ? h('button', { type: 'button', class: 'cvr-btn primary', text: 'اعتماد الهوية', onclick: async () => {
          const result = await call('cover:approve', { id: b.id });
          if (!result.ok) return setMsg(result.message, 'error');
          await loadAdmin();
          renderBody();
          setMsg('تم اعتماد الهوية.', 'ok');
        } })
        : h('span', { class: 'cvr-empty', text: '—' }))));
    const feed = S.activity.map((a) => {
      const reviewer = ['APPROVED', 'REJECTED'].includes(a.action)
        ? ' · ' + [a.byCode, a.byRank, a.bySector].filter(Boolean).join(' · ')
        : '';
      return h('li', { text: stamp(a.at) + ' · ' + (ACTION_AR[a.action] || a.action) + ' · ' + a.badgeNumber + ' · ' + ownerInfo({ name: a.ownerName, militaryCode: a.ownerCode }) + ' · بواسطة ' + a.byName + reviewer + (a.note ? ' — ' + a.note : '') });
    });
    return h('div', null,
      h('div', { class: 'cvr-filters' }, query, type, status, h('button', { type: 'button', class: 'cvr-btn primary', text: 'بحث', onclick: run })),
      h('div', { class: 'cvr-empty', text: 'عدد النتائج: ' + S.adminTotal + (S.meta && S.meta.scope === 'SECTOR' ? ' (أفراد قطاعك فقط)' : '') }),
      h('div', { class: 'cvr-table-wrap' }, h('table', { class: 'cvr-table' },
        h('thead', null, h('tr', null, ['الرقم', 'النوع', 'الاسم المستعار', 'بيانات العضو', 'الإنشاء', 'الانتهاء', 'الحالة', 'الإجراء'].map((t) => h('th', { text: t })))),
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
        h('span', { text: ownerInfo(badge.owner) }),
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
  async function loadReviewQueue() {
    const r = await call('cover:review:list');
    if (r.ok) S.reviewQueue = r.badges || [];
    else { S.reviewQueue = []; setMsg(r.message, 'error'); }
  }
  async function loadAdmin(filters) {
    const r = await call('cover:admin:list', filters || {});
    if (r.ok) { S.admin = r.badges; S.adminTotal = r.total; } else setMsg(r.message, 'error');
    const feed = await call('cover:admin:activity');
    if (feed.ok) S.activity = feed.activity;
  }
  async function refreshTab() {
    if (S.tab === 'mine') await loadMine();
    if (S.tab === 'review') await loadReviewQueue();
    if (S.tab === 'admin') await loadAdmin();
    renderBody();
  }

  async function open() {
    const meta = await call('cover:meta');
    if (!meta.ok) { S.meta = null; ensurePane(); return setMsg(meta.message, 'error'); }
    S.meta = meta;
    if (meta.canReviewQueue && S.tab === 'mine') S.tab = 'review';
    if (!meta.canReviewQueue && S.tab === 'review') S.tab = 'mine';
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
    if (id !== S.userId) { S.userId = id; S.meta = null; S.mine = []; S.admin = []; S.reviewQueue = []; S.activity = []; S.editing = null; S.tab = 'mine'; S.msg = null; }
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
