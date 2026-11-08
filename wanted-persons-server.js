'use strict';

const { SEVERITIES, STATUSES, safeImageUrl } = require('./wanted-persons-store');

const WANTED_HEAD_MARKUP = '<link href="/wanted-persons.css" rel="stylesheet">';
const WANTED_NAV_MARKUP = '<li id="wanted-persons-nav" class="nav-btn" onclick="showPane(\'wanted-persons\', this)"><i class="fa-solid fa-user-secret" aria-hidden="true"></i> المجرمون المطلوبون</li>';
const WANTED_PANE_MARKUP = [
  '<div id="wanted-persons" class="view-pane wanted-persons-page" aria-label="المجرمون المطلوبون">',
  '  <main class="wp-shell" dir="rtl">',
  '    <header class="wp-header">',
  '      <div><p class="wp-eyebrow">BLACKRIDGE // INTELLIGENCE DIRECTORATE</p><h1>المجرمون المطلوبون</h1><p class="wp-subtitle">فهرس الملفات التحقيقية المصنفة · الوصول مقيد للقيادة</p></div>',
  '      <div class="wp-header-mark" aria-hidden="true"><span>BR</span><i class="fa-solid fa-user-secret"></i></div>',
  '    </header>',
  '    <div id="wp-status" class="wp-status" role="status" aria-live="polite" hidden></div>',
  '    <section id="wp-list-section" class="wp-list-section">',
  '      <div class="wp-section-heading"><div><p class="wp-kicker">PERSONS OF INTEREST</p><h2>سجل المطلوبين</h2></div><button id="wp-add-button" class="wp-button wp-button-primary" type="button" hidden><i class="fa-solid fa-plus" aria-hidden="true"></i> إنشاء ملف</button></div>',
  '      <form id="wp-search-form" class="wp-filter-panel">',
  '        <label>الاسم<input id="wp-filter-name" name="name" type="search" maxlength="120" autocomplete="off" placeholder="ابحث بالاسم"></label>',
  '        <label>رقم الملف<input id="wp-filter-file" name="fileNumber" type="search" maxlength="64" autocomplete="off" placeholder="BR-…"></label>',
  '        <label>درجة الخطورة<select id="wp-filter-severity" name="severity"><option value="">كل الدرجات</option><option value="LOW">منخفضة</option><option value="MEDIUM">متوسطة</option><option value="HIGH">عالية</option><option value="CRITICAL">حرجة</option></select></label>',
  '        <label>حالة الملف<select id="wp-filter-status" name="status"><option value="">كل الحالات</option><option value="WANTED">مطلوب</option><option value="UNDER_INVESTIGATION">قيد التحقيق</option><option value="DETAINED">موقوف</option><option value="CLOSED">مغلق</option></select></label>',
  '        <button class="wp-button wp-button-muted" type="submit">بحث وتصفية</button>',
  '      </form>',
  '      <div id="wp-results-meta" class="wp-results-meta" aria-live="polite"></div>',
  '      <div id="wp-person-grid" class="wp-person-grid"><div class="wp-empty">سجّل الدخول ثم حمّل السجلات.</div></div>',
  '    </section>',
  '    <section id="wp-detail" class="wp-detail" aria-labelledby="wp-detail-title" hidden>',
  '      <div class="wp-detail-toolbar"><button id="wp-back-button" class="wp-button wp-button-muted" type="button"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i> العودة إلى السجل</button><button id="wp-edit-button" class="wp-button wp-button-primary" type="button" hidden>تعديل الملف</button></div>',
  '      <article class="wp-dossier">',
  '        <div id="wp-profile-photo" class="wp-profile-photo"></div>',
  '        <div class="wp-profile-main"><p class="wp-kicker">INVESTIGATIVE DOSSIER</p><h2 id="wp-detail-title"></h2><p id="wp-detail-file" class="wp-file-number"></p><div id="wp-detail-badges" class="wp-badges"></div><div class="wp-profile-block"><h3>الأسماء المستعارة</h3><ul id="wp-detail-aliases" class="wp-aliases"></ul></div></div>',
  '      </article>',
  '      <div class="wp-detail-grid">',
  '        <section class="wp-detail-card"><p class="wp-kicker">LINKED CASES</p><h3>القضايا المرتبطة</h3><div id="wp-detail-cases" class="wp-linked-cases"></div></section>',
  '        <section class="wp-detail-card"><p class="wp-kicker">FIELD NOTES</p><h3>الملاحظات</h3><p id="wp-detail-notes" class="wp-long-text"></p></section>',
  '        <section class="wp-detail-card wp-detail-wide"><p class="wp-kicker">CASE DETAILS</p><h3>التفاصيل</h3><p id="wp-detail-details" class="wp-long-text"></p></section>',
  '      </div>',
  '    </section>',
  '    <section id="wp-editor" class="wp-editor" aria-labelledby="wp-editor-title" hidden>',
  '      <div class="wp-detail-toolbar"><button id="wp-cancel-button" class="wp-button wp-button-muted" type="button">إلغاء والعودة</button></div>',
  '      <form id="wp-person-form" class="wp-editor-card">',
  '        <p class="wp-kicker">RESTRICTED RECORD ENTRY</p><h2 id="wp-editor-title">إنشاء ملف تحقيق</h2><input id="wp-person-id" name="id" type="hidden">',
  '        <div class="wp-form-grid">',
  '          <label>الاسم الكامل<input id="wp-full-name" name="fullName" maxlength="160" required></label>',
  '          <label>رقم الملف<input id="wp-file-number" name="fileNumber" maxlength="64" required></label>',
  '          <label>رابط الصورة الأساسية<input id="wp-image-url" name="imageUrl" type="url" maxlength="700" placeholder="https://…"></label>',
  '          <label>درجة الخطورة<select id="wp-severity" name="severity" required><option value="">اختر درجة الخطورة</option><option value="LOW">منخفضة</option><option value="MEDIUM">متوسطة</option><option value="HIGH">عالية</option><option value="CRITICAL">حرجة</option></select></label>',
  '          <label>حالة الملف<select id="wp-status" name="status" required><option value="WANTED">مطلوب</option><option value="UNDER_INVESTIGATION">قيد التحقيق</option><option value="DETAINED">موقوف</option><option value="CLOSED">مغلق</option></select></label>',
  '          <label class="wp-form-wide">الأسماء المستعارة <span class="wp-help">اسم واحد في كل سطر</span><textarea id="wp-aliases" name="aliases" maxlength="2200" rows="3"></textarea></label>',
  '          <fieldset class="wp-form-wide"><legend>اربط بقضايا موجودة</legend><div id="wp-case-options" class="wp-case-options"><span class="wp-muted">لا توجد قضايا متاحة للربط.</span></div></fieldset>',
  '          <label class="wp-form-wide">الملاحظات<textarea id="wp-notes" name="notes" maxlength="5000" rows="4"></textarea></label>',
  '          <label class="wp-form-wide">التفاصيل<textarea id="wp-details" name="details" maxlength="10000" rows="6"></textarea></label>',
  '        </div>',
  '        <div class="wp-form-actions"><button class="wp-button wp-button-primary" type="submit">حفظ الملف</button></div>',
  '      </form>',
  '    </section>',
  '    <footer class="wp-footer">BLACKRIDGE · ملفات سرية · لا يتم إنشاء بيانات افتراضية</footer>',
  '  </main>',
  '</div>'
].join('\n');

function injectWantedPersonsMarkup(html) {
  let result = String(html == null ? '' : html);
  if (!/<head(?:\s[^>]*)?>/i.test(result) || !/<\/body>/i.test(result)) return result;
  if (!result.includes('href="/wanted-persons.css"')) result = result.replace(/<\/head>/i, '  ' + WANTED_HEAD_MARKUP + '\n</head>');
  if (!result.includes('id="wanted-persons-nav"')) {
    const armoryNav = /(<li id="weapon-armory-nav"[^>]*>[\s\S]*?<\/li>)/i;
    const ibpNav = /(<li id="ibp-nav"[^>]*>[\s\S]*?<\/li>)/i;
    if (armoryNav.test(result)) result = result.replace(armoryNav, WANTED_NAV_MARKUP + '\n$1');
    else if (ibpNav.test(result)) result = result.replace(ibpNav, '$1\n' + WANTED_NAV_MARKUP);
    else result = result.replace(/(<ul class="nav-list">)/i, '$1\n' + WANTED_NAV_MARKUP);
  }
  if (!result.includes('id="wanted-persons"')) {
    const dashboard = /(<div id="dashboard" class="view-pane active">)/i;
    if (dashboard.test(result)) result = result.replace(dashboard, WANTED_PANE_MARKUP + '\n$1');
  }
  if (!result.includes('src="/wanted-persons-client.js"')) {
    result = result.replace(/<\/body>/i, '  <script src="/wanted-persons-client.js" defer></script>\n</body>');
  }
  return result;
}

function clean(value, maxLength = 200) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function summarizeCase(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    id: clean(record.id, 120),
    caseNumber: clean(record.caseNumber || record.number || record.id, 100),
    title: clean(record.title, 200),
    status: clean(record.status, 40),
    classification: clean(record.classification, 40)
  };
}

function availableCases(state) {
  const rows = Array.isArray(state?.cia_cases) ? state.cia_cases : [];
  return rows.map(summarizeCase).filter((item) => item && item.id);
}

function casesForPerson(caseIds, state) {
  const ids = new Set(Array.isArray(caseIds) ? caseIds.map((id) => clean(id, 120)) : []);
  return availableCases(state).filter((item) => ids.has(item.id));
}

function cardPerson(person) {
  return {
    id: person.id,
    fileNumber: person.fileNumber,
    fullName: person.fullName,
    imageUrl: safeImageUrl(person.imageUrl),
    severity: person.severity,
    status: person.status,
    caseCount: Array.isArray(person.caseIds) ? person.caseIds.length : 0
  };
}

function registerWantedPersonsSocket(socket, context = {}) {
  const getStore = () => typeof context.getStore === 'function' ? context.getStore() : context.store;
  const getState = () => typeof context.getState === 'function' ? context.getState() : {};
  const requireUser = () => typeof context.requireUser === 'function' ? context.requireUser(socket) : null;
  const isLeadership = (user) => typeof context.isLeadership === 'function' && context.isLeadership(user) === true;
  const reply = (callback, result) => {
    if (typeof callback === 'function') callback(result);
  };
  const unavailable = () => ({ ok: false, available: false, message: 'قسم المطلوبين يحتاج اتصال قاعدة PostgreSQL الحالية؛ لم يتم عرض أو حفظ بيانات محلية بديلة.' });
  const denied = () => ({ ok: false, message: 'يتطلب هذا القسم صلاحية القيادة.' });
  const access = () => {
    const actor = requireUser();
    if (!actor) return { error: { ok: false, message: 'يلزم تسجيل الدخول بصلاحية فعالة.' } };
    if (!isLeadership(actor)) return { actor, error: denied() };
    return { actor, error: null };
  };

  socket.on('wanted-persons:list', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    const store = getStore();
    if (!store) return reply(callback, unavailable());
    const filters = {
      name: clean(payload?.name, 120),
      fileNumber: clean(payload?.fileNumber, 64),
      severity: clean(payload?.severity, 40).toUpperCase(),
      status: clean(payload?.status, 40).toUpperCase(),
      limit: 100,
      offset: Math.max(0, Math.min(100000, Number.parseInt(payload?.offset, 10) || 0))
    };
    if (filters.severity && !SEVERITIES.includes(filters.severity)) return reply(callback, { ok: false, message: 'درجة الخطورة المحددة غير صالحة.' });
    if (filters.status && !STATUSES.includes(filters.status)) return reply(callback, { ok: false, message: 'حالة الملف المحددة غير صالحة.' });
    try {
      const result = await store.list(filters);
      return reply(callback, {
        ok: true,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        items: (result.items || []).map(cardPerson),
        availableCases: availableCases(getState()),
        permissions: { canManage: true }
      });
    } catch (_error) {
      return reply(callback, { ok: false, message: 'تعذر تحميل سجل المطلوبين من قاعدة البيانات.' });
    }
  });

  socket.on('wanted-persons:detail', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    const store = getStore();
    if (!store) return reply(callback, unavailable());
    const id = clean(payload?.id, 120);
    if (!id) return reply(callback, { ok: false, message: 'معرّف الملف غير صالح.' });
    try {
      const person = await store.get(id);
      if (!person) return reply(callback, { ok: false, message: 'ملف المطلوب غير موجود.' });
      return reply(callback, { ok: true, person, relatedCases: casesForPerson(person.caseIds, getState()), permissions: { canManage: true } });
    } catch (_error) {
      return reply(callback, { ok: false, message: 'تعذر تحميل الملف التحقيقي.' });
    }
  });

  socket.on('wanted-persons:save', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    const store = getStore();
    if (!store) return reply(callback, unavailable());
    const source = payload && typeof payload === 'object' ? payload : {};
    const aliases = Array.isArray(source.aliases) ? source.aliases : null;
    const caseIds = Array.isArray(source.caseIds) ? [...new Set(source.caseIds.map((item) => clean(item, 120)).filter(Boolean))] : null;
    const imageUrl = clean(source.imageUrl, 700);
    const person = {
      id: clean(source.id, 120),
      fullName: clean(source.fullName, 160),
      fileNumber: clean(source.fileNumber, 64),
      aliases,
      imageUrl,
      severity: clean(source.severity, 40).toUpperCase(),
      status: clean(source.status, 40).toUpperCase(),
      caseIds,
      notes: typeof source.notes === 'string' ? source.notes : '',
      details: typeof source.details === 'string' ? source.details : ''
    };
    if (imageUrl && !safeImageUrl(imageUrl)) return reply(callback, { ok: false, message: 'رابط الصورة يجب أن يكون HTTPS أو مسارًا محليًا آمنًا.' });
    if (!person.fullName || !person.fileNumber || !aliases || !caseIds) return reply(callback, { ok: false, message: 'أكمل الاسم ورقم الملف والقوائم المطلوبة.' });
    if (caseIds.length) {
      const validIds = new Set(availableCases(getState()).map((item) => item.id));
      if (caseIds.some((caseId) => !validIds.has(caseId))) return reply(callback, { ok: false, message: 'يمكن ربط الملف بقضايا موجودة فقط.' });
    }
    try {
      const result = await store.save({ person, actor: auth.actor });
      if (!result.ok) return reply(callback, result);
      return reply(callback, { ...result, relatedCases: casesForPerson(result.person.caseIds, getState()) });
    } catch (_error) {
      return reply(callback, { ok: false, message: 'تعذر حفظ التغييرات في قاعدة البيانات.' });
    }
  });
}

module.exports = { availableCases, casesForPerson, injectWantedPersonsMarkup, registerWantedPersonsSocket, summarizeCase };
