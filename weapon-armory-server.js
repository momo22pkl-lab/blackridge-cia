'use strict';

const { normalizeSectors, validRequestId } = require('./weapon-armory-store');

const ARMORY_HEAD_MARKUP = '<link href="/weapon-armory.css" rel="stylesheet">';
const ARMORY_NAV_MARKUP = `<li id="weapon-armory-nav" class="nav-btn" onclick="showPane('weapon-armory', this)">
  <i class="fa-solid fa-boxes-stacked" aria-hidden="true"></i> WEAPON ARMORY // مستودع الأسلحة
</li>`;
const ARMORY_PANE_MARKUP = `<div id="weapon-armory" class="view-pane weapon-armory-page" aria-label="WEAPON ARMORY">
  <main class="weapon-armory-shell" dir="rtl">
    <header class="wa-header">
      <div>
        <p class="wa-eyebrow">BLACK RIDGE // QUARTERMASTER</p>
        <h1>WEAPON ARMORY</h1>
        <p id="wa-sector-label" class="wa-subtitle">مخزون قطاعك وعهدتك الحالية</p>
      </div>
      <div class="wa-limit-card" aria-live="polite">
        <span>الأسلحة المستلمة</span>
        <strong id="wa-limit-count">0/3</strong>
        <div class="wa-limit-track"><span id="wa-limit-progress"></span></div>
      </div>
    </header>
    <div id="wa-status" class="wa-status" role="status" aria-live="polite" hidden></div>
    <section class="wa-section" aria-labelledby="wa-available-title">
      <div class="wa-section-heading"><div><p class="wa-kicker">SECTOR ISSUE</p><h2 id="wa-available-title">الأسلحة المتاحة</h2></div></div>
      <div id="wa-weapon-grid" class="wa-weapon-grid"><div class="wa-empty">سجّل الدخول لعرض مخزون قطاعك.</div></div>
    </section>
    <section class="wa-section" aria-labelledby="wa-held-title">
      <div class="wa-section-heading"><div><p class="wa-kicker">CURRENT CUSTODY</p><h2 id="wa-held-title">الأسلحة المستلمة</h2></div></div>
      <div id="wa-held-list" class="wa-held-list"><div class="wa-empty">لا توجد عهدة مسجلة.</div></div>
    </section>
    <section id="wa-admin" class="wa-admin wa-section" aria-labelledby="wa-admin-title" hidden>
      <div class="wa-section-heading"><div><p class="wa-kicker">COMMAND INVENTORY</p><h2 id="wa-admin-title">إدارة المستودع</h2></div></div>
      <div class="wa-admin-grid">
        <form id="wa-weapon-form" class="wa-panel">
          <h3>إضافة أو تعديل سلاح</h3>
          <input type="hidden" name="id">
          <label>اسم السلاح<input name="name" maxlength="100" required></label>
          <label>رابط الصورة (اختياري)<input name="imageUrl" type="url" maxlength="500" placeholder="https://…"></label>
          <label>أيقونة Font Awesome<input name="icon" maxlength="52" value="fa-gun" placeholder="fa-gun"></label>
          <fieldset><legend>القطاعات المسموح بها وسياسة الإرجاع لكل قطاع</legend><div id="wa-sector-options" class="wa-sector-options"></div></fieldset>
          <button class="wa-button wa-button-primary" type="submit">حفظ السلاح والقطاعات</button>
          <button id="wa-weapon-cancel" class="wa-button wa-button-muted" type="button" hidden>إلغاء التعديل</button>
        </form>
        <form id="wa-stock-form" class="wa-panel">
          <h3>تعديل المخزون</h3>
          <label>السلاح<select name="weaponId" required></select></label>
          <label>القطاع<select name="sectorId" required></select></label>
          <label>تغيير الكمية<input name="delta" type="number" step="1" required placeholder="مثال: 5 أو -2"></label>
          <label>سبب التعديل<textarea name="reason" maxlength="500" minlength="3" required></textarea></label>
          <button class="wa-button wa-button-primary" type="submit">تسجيل تعديل المخزون</button>
        </form>
      </div>
      <form id="wa-search-form" class="wa-search-panel">
        <h3>البحث والسجلات</h3>
        <div class="wa-search-fields">
          <label>العضو أو الرمز العسكري أو السلاح<input name="search" maxlength="120"></label>
          <label>من تاريخ<input name="from" type="date"></label>
          <label>إلى تاريخ<input name="to" type="date"></label>
          <button class="wa-button wa-button-primary" type="submit">بحث</button>
        </div>
      </form>
      <div class="wa-admin-grid">
        <section class="wa-panel"><h3>المخزون المتبقي</h3><div class="wa-table-wrap"><table><thead><tr><th>السلاح</th><th>القطاع</th><th>المتاح</th><th>الحالة</th><th>الإرجاع</th><th></th></tr></thead><tbody id="wa-stock-rows"></tbody></table></div></section>
        <section class="wa-panel"><h3>العهد المسجلة على الأعضاء</h3><div class="wa-table-wrap"><table><thead><tr><th>العضو</th><th>الرمز</th><th>السلاح</th><th>القطاع</th><th>العدد</th><th>الحالة</th><th>التاريخ</th></tr></thead><tbody id="wa-issue-rows"></tbody></table></div></section>
      </div>
      <section class="wa-panel"><h3>سجل التدقيق</h3><div class="wa-table-wrap"><table><thead><tr><th>الوقت</th><th>الفاعل</th><th>العضو</th><th>السلاح</th><th>القطاع</th><th>العملية</th><th>الكمية</th><th>النتيجة</th><th>السبب</th></tr></thead><tbody id="wa-audit-rows"></tbody></table></div></section>
    </section>
  </main>
</div>`;

function injectWeaponArmoryMarkup(html) {
  let result = String(html == null ? '' : html);
  if (!/<head(?:\s[^>]*)?>/i.test(result) || !/<\/body>/i.test(result)) return result;

  if (!result.includes('href="/weapon-armory.css"')) {
    result = result.replace(/<\/head>/i, `  ${ARMORY_HEAD_MARKUP}\n</head>`);
  }
  if (!result.includes('id="weapon-armory-nav"')) {
    const ibpNav = /(<li id="ibp-nav"[^>]*>[\s\S]*?<\/li>)/i;
    if (ibpNav.test(result)) result = result.replace(ibpNav, `$1\n${ARMORY_NAV_MARKUP}`);
    else result = result.replace(/(<ul class="nav-list">)/i, `$1\n${ARMORY_NAV_MARKUP}`);
  }
  if (!result.includes('id="weapon-armory"')) {
    const dashboard = /(<div id="dashboard" class="view-pane active">)/i;
    if (dashboard.test(result)) result = result.replace(dashboard, `${ARMORY_PANE_MARKUP}\n$1`);
  }
  if (!result.includes('src="/weapon-armory-client.js"')) {
    result = result.replace(/<\/body>/i, '  <script src="/weapon-armory-client.js" defer></script>\n</body>');
  }
  return result;
}

function sectorKey(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim().toLocaleLowerCase().slice(0, 120);
}

function userCodes(user) {
  const code = String(user?.publicCode || '').trim().toLocaleUpperCase();
  return code ? [code] : [];
}

function unitContainsUser(unit, codes) {
  if (!unit || String(unit.status || '').toUpperCase() === 'ARCHIVED' || !codes.length) return false;
  const unitCodes = [
    ...(Array.isArray(unit.memberCodes) ? unit.memberCodes : []),
    unit.commanderCode,
    unit.deputyCode,
    unit.seniorCommanderCode
  ].map((value) => String(value || '').trim().toLocaleUpperCase()).filter(Boolean);
  return codes.some((code) => unitCodes.includes(code));
}

function activeSectors(state) {
  const sectors = new Map();
  for (const unit of Array.isArray(state?.cia_battalions) ? state.cia_battalions : []) {
    if (!unit || String(unit.status || '').toUpperCase() === 'ARCHIVED') continue;
    const label = String(unit.sector || '').normalize('NFKC').trim().slice(0, 120);
    const key = sectorKey(label);
    if (label && key && !sectors.has(key)) sectors.set(key, { id: key, name: label });
  }
  return [...sectors.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function memberSector(user, state) {
  const codes = userCodes(user);
  if (!codes.length) return null;
  const matches = (Array.isArray(state?.cia_battalions) ? state.cia_battalions : [])
    .filter((unit) => unitContainsUser(unit, codes))
    .map((unit) => {
      const name = String(unit.sector || '').normalize('NFKC').trim().slice(0, 120);
      return { id: sectorKey(name), name };
    })
    .filter((sector) => sector.id && sector.name);
  const unique = new Map(matches.map((sector) => [sector.id, sector]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function adminScope(user, state, context) {
  const sectors = activeSectors(state);
  if (typeof context.isLeadership === 'function' && context.isLeadership(user)) {
    return { canView: true, canManage: true, sectors };
  }
  const rank = typeof context.rankLevel === 'function' ? context.rankLevel(user?.rank) : 0;
  const codes = userCodes(user);
  if (rank < 2 || !codes.length) return { canView: false, canManage: false, sectors: [] };
  const visibleIds = new Set((Array.isArray(state?.cia_battalions) ? state.cia_battalions : [])
    .filter((unit) => unit && String(unit.status || '').toUpperCase() !== 'ARCHIVED')
    .filter((unit) => [unit.commanderCode, unit.seniorCommanderCode]
      .map((value) => String(value || '').trim().toLocaleUpperCase())
      .some((code) => codes.includes(code)))
    .map((unit) => sectorKey(unit.sector))
    .filter(Boolean));
  const scoped = sectors.filter((sector) => visibleIds.has(sector.id));
  return { canView: scoped.length > 0, canManage: false, sectors: scoped };
}

function registerWeaponArmorySocket(socket, context) {
  const getStore = () => typeof context.getStore === 'function' ? context.getStore() : context.store;
  const getState = () => typeof context.getState === 'function' ? context.getState() : {};
  const requireUser = () => typeof context.requireUser === 'function' ? context.requireUser(socket) : null;
  const canManage = (user) => typeof context.isLeadership === 'function' && context.isLeadership(user);
  const reply = (callback, result) => {
    if (typeof callback === 'function') callback(result);
  };
  const unavailable = (callback) => reply(callback, {
    ok: false,
    message: 'مخزن الأسلحة غير متاح؛ يلزم اتصال PostgreSQL لحماية المخزون من التزامن.'
  });
  const auditDenied = async (store, user, payload, action, reason, sectorId = '') => {
    if (!store || typeof store.recordDenied !== 'function') return;
    try {
      await store.recordDenied({
        actor: user,
        requestId: payload?.requestId,
        action,
        sectorId,
        weaponId: payload?.weaponId || payload?.weapon?.id,
        weaponName: payload?.weapon?.name,
        quantity: Number.isInteger(Number(payload?.delta)) ? Number(payload.delta) : 0,
        reason
      });
    } catch (_error) {}
  };

  socket.on('weapon-armory:member:get', async (_payload, callback) => {
    const user = requireUser();
    if (!user) return reply(callback, { ok: false, message: 'يجب تسجيل الدخول للخدمة أولاً.' });
    const sector = memberSector(user, getState());
    if (!sector) return reply(callback, { ok: false, message: 'لا توجد عضوية مؤكدة في قطاع نشط لهذا الحساب.' });
    const store = getStore();
    if (!store) return unavailable(callback);
    try {
      return reply(callback, { ...(await store.memberSnapshot({ member: user, sectorId: sector.id })), sector });
    } catch (_error) {
      return reply(callback, { ok: false, message: 'تعذر تحميل مستودع القطاع.' });
    }
  });

  socket.on('weapon-armory:issue', async (payload, callback) => {
    const user = requireUser();
    if (!user) return reply(callback, { ok: false, message: 'يجب تسجيل الدخول للخدمة أولاً.' });
    const sector = memberSector(user, getState());
    if (!sector) return reply(callback, { ok: false, message: 'لا توجد عضوية مؤكدة في قطاع نشط لهذا الحساب.' });
    const store = getStore();
    if (!store) return unavailable(callback);
    try {
      return reply(callback, await store.issue({ actor: user, requestId: payload?.requestId, sectorId: sector.id, weaponId: payload?.weaponId }));
    } catch (_error) {
      return reply(callback, { ok: false, message: 'تعذر تسجيل الاستلام؛ لم يُعتمد تغيير المخزون.' });
    }
  });

  socket.on('weapon-armory:return', async (payload, callback) => {
    const user = requireUser();
    if (!user) return reply(callback, { ok: false, message: 'يجب تسجيل الدخول للخدمة أولاً.' });
    const store = getStore();
    if (!store) return unavailable(callback);
    try {
      return reply(callback, await store.returnIssue({ actor: user, requestId: payload?.requestId, issueId: payload?.issueId }));
    } catch (_error) {
      return reply(callback, { ok: false, message: 'تعذر تسجيل الإرجاع؛ لم يُعتمد تغيير المخزون.' });
    }
  });

  socket.on('weapon-armory:admin:get', async (_payload, callback) => {
    const user = requireUser();
    if (!user) return reply(callback, { ok: false, message: 'يجب تسجيل الدخول للخدمة أولاً.' });
    const scope = adminScope(user, getState(), context);
    if (!scope.canView) return reply(callback, { ok: false, message: 'عرض بيانات المستودع متاح للقيادة ضمن نطاق القطاع فقط.' });
    const store = getStore();
    if (!store) return unavailable(callback);
    try {
      const data = await store.adminSnapshot({
        sectorIds: scope.sectors.map((sector) => sector.id),
        includeGlobalAudit: scope.canManage,
        globalMemberCounts: scope.canManage
      });
      return reply(callback, { ...data, sectors: scope.sectors, canManage: scope.canManage, canView: true });
    } catch (_error) {
      return reply(callback, { ok: false, message: 'تعذر تحميل لوحة إدارة المستودع.' });
    }
  });

  socket.on('weapon-armory:weapon:save', async (payload, callback) => {
    const user = requireUser();
    if (!user) return reply(callback, { ok: false, message: 'يجب تسجيل الدخول للخدمة أولاً.' });
    const store = getStore();
    if (!store) return unavailable(callback);
    if (!canManage(user)) {
      await auditDenied(store, user, payload, 'WEAPON_SAVE', 'إدارة الأسلحة متاحة لـ CIA CHIEF وSUPREME COMMANDER فقط.');
      return reply(callback, { ok: false, message: 'إدارة الأسلحة متاحة لـ CIA CHIEF وSUPREME COMMANDER فقط.' });
    }
    const allowed = new Set(activeSectors(getState()).map((sector) => sector.id));
    const requested = normalizeSectors(payload?.sectorIds);
    const sectorIds = requested.filter((sector) => allowed.has(sector));
    const returnAllowedSectorIds = normalizeSectors(payload?.returnAllowedSectorIds);
    if (sectorIds.length !== requested.length || !sectorIds.length || returnAllowedSectorIds.some((sector) => !sectorIds.includes(sector))) {
      const message = 'اختر قطاعًا نشطًا واحدًا أو أكثر.';
      await auditDenied(store, user, payload, 'WEAPON_SAVE', message);
      return reply(callback, { ok: false, message });
    }
    try {
      return reply(callback, await store.saveWeapon({
        actor: user,
        requestId: payload?.requestId,
        weapon: payload?.weapon,
        sectorIds,
        returnAllowedSectorIds
      }));
    } catch (_error) {
      return reply(callback, { ok: false, message: 'تعذر حفظ بيانات السلاح؛ لم يُعتمد التغيير.' });
    }
  });

  socket.on('weapon-armory:stock:adjust', async (payload, callback) => {
    const user = requireUser();
    if (!user) return reply(callback, { ok: false, message: 'يجب تسجيل الدخول للخدمة أولاً.' });
    const store = getStore();
    if (!store) return unavailable(callback);
    const sectors = new Set(activeSectors(getState()).map((sector) => sector.id));
    const sectorId = sectorKey(payload?.sectorId);
    if (!canManage(user) || !sectors.has(sectorId)) {
      const message = !canManage(user)
        ? 'تعديل المخزون متاح لـ CIA CHIEF وSUPREME COMMANDER فقط.'
        : 'القطاع المحدد غير موجود ضمن نطاق الإدارة.';
      await auditDenied(store, user, payload, 'STOCK_ADJUSTED', message, sectorId);
      return reply(callback, { ok: false, message });
    }
    try {
      return reply(callback, await store.adjustStock({
        actor: user,
        requestId: payload?.requestId,
        sectorId,
        weaponId: payload?.weaponId,
        delta: payload?.delta,
        reason: payload?.reason
      }));
    } catch (_error) {
      return reply(callback, { ok: false, message: 'تعذر حفظ تعديل المخزون؛ لم يُعتمد التغيير.' });
    }
  });

  socket.on('weapon-armory:admin:search', async (payload, callback) => {
    const user = requireUser();
    if (!user) return reply(callback, { ok: false, message: 'يجب تسجيل الدخول للخدمة أولاً.' });
    const scope = adminScope(user, getState(), context);
    if (!scope.canView) return reply(callback, { ok: false, message: 'عرض السجلات متاح للقيادة ضمن نطاق القطاع فقط.' });
    const store = getStore();
    if (!store) return unavailable(callback);
    try {
      const data = await store.adminSnapshot({
        sectorIds: scope.sectors.map((sector) => sector.id),
        includeGlobalAudit: scope.canManage,
        globalMemberCounts: scope.canManage,
        filters: {
          search: payload?.search,
          from: payload?.from,
          to: payload?.to
        }
      });
      return reply(callback, data);
    } catch (_error) {
      return reply(callback, { ok: false, message: 'تعذر البحث في سجل المستودع.' });
    }
  });
}

module.exports = {
  ARMORY_HEAD_MARKUP,
  ARMORY_NAV_MARKUP,
  ARMORY_PANE_MARKUP,
  activeSectors,
  adminScope,
  injectWeaponArmoryMarkup,
  memberSector,
  registerWeaponArmorySocket,
  sectorKey,
  unitContainsUser,
  validRequestId
};
