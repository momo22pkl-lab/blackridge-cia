'use strict';

const { SEVERITIES, STATUSES, safeImageUrl } = require('./wanted-persons-store');

const WANTED_HEAD_MARKUP = '<link href="/wanted-persons.css" rel="stylesheet">';
const WANTED_NAV_MARKUP = '<li id="wanted-persons-nav" class="nav-btn" onclick="showPane(\'wanted-persons\', this)"><i class="fa-solid fa-user-secret" aria-hidden="true"></i> المجرمون المطلوبون</li>';
const WANTED_PANE_MARKUP = [
  '<div id="wanted-persons" class="view-pane wanted-persons-page" aria-label="المجرمون المطلوبون">',
  '  <main class="wp-shell" dir="rtl">',
  '    <header class="wp-header">',
  '      <div><p class="wp-eyebrow">BLACKRIDGE // INTELLIGENCE DIRECTORATE</p><h1>المجرمون المطلوبون</h1><p class="wp-subtitle">ملفات BLACKRIDGE CITY RP · ابدأ بفتح ملف أو إنشاء ملف مخوّل، ثم اربطه بقضية من الأرشيف.</p></div>',
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
  '      <p class="wp-help wp-page-guide">ابدأ باختيار ملف من السجل أو إنشاء ملف جديد. من صفحة الملف يمكنك فتح أرشيف القضايا والأدلة، ربط قضية موجودة أو إنشاء قضية جديدة؛ الأدلة والملاحظات والسجل الزمني تظهر في أقسامها أسفل لوحة التحقيق.</p>',
  '    </section>',
  '    <section id="wp-detail" class="wp-detail" aria-labelledby="wp-detail-title" hidden>',
  '      <div class="wp-detail-toolbar"><button id="wp-back-button" class="wp-button wp-button-muted" type="button"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i> العودة إلى السجل</button><button id="wp-edit-button" class="wp-button wp-button-primary" type="button" hidden>تعديل الملف</button></div>',
  '      <article class="wp-dossier">',
  '        <div id="wp-profile-photo" class="wp-profile-photo"></div>',
  '        <div class="wp-profile-main"><p class="wp-kicker">INVESTIGATIVE DOSSIER</p><h2 id="wp-detail-title"></h2><p id="wp-detail-file" class="wp-file-number"></p><div id="wp-detail-badges" class="wp-badges"></div><div class="wp-profile-block"><h3>الأسماء المستعارة</h3><ul id="wp-detail-aliases" class="wp-aliases"></ul></div></div>',
  '      </article>',
  '      <div class="wp-detail-grid">',
  '        <section class="wp-detail-card"><p class="wp-kicker">LINKED CASES</p><div class="wp-case-section-heading"><h3>القضايا المرتبطة</h3><div id="wp-case-actions" class="wp-board-actions"><button id="wp-open-case-archive" class="wp-button wp-button-muted" type="button">فتح أرشيف القضايا والأدلة</button><button id="wp-link-case" class="wp-button wp-button-muted" type="button">ربط قضية موجودة</button><button id="wp-create-case" class="wp-button wp-button-primary" type="button">إنشاء قضية جديدة</button></div></div><div id="wp-detail-cases" class="wp-linked-cases"></div></section>',
  '        <section class="wp-detail-card"><p class="wp-kicker">FIELD NOTES</p><h3>الملاحظات</h3><p id="wp-detail-notes" class="wp-long-text"></p></section>',
  '        <section class="wp-detail-card wp-detail-wide"><p class="wp-kicker">CASE DETAILS</p><h3>التفاصيل</h3><p id="wp-detail-details" class="wp-long-text"></p></section>',
  '      </div>',
  '      <section id="wp-investigation-board" class="wp-investigation-board" aria-label="لوحة التحقيق">',
  '        <div class="wp-board-heading"><div><p class="wp-kicker">INVESTIGATION BOARD</p><h3>لوحة التحقيق</h3><p class="wp-muted">حرّك اللوحة بالسحب، كبّر بعجلة الفأرة أو بإيماءة اللمس. المرفقات لا تُعرض إلا للمخولين.</p></div>',
  '          <div class="wp-board-actions"><button id="wp-add-evidence" class="wp-button wp-button-primary" type="button" hidden><i class="fa-solid fa-paperclip" aria-hidden="true"></i> رفع دليل</button><button id="wp-add-note" class="wp-button wp-button-muted" type="button" hidden>ملاحظة محقق</button><button id="wp-add-event" class="wp-button wp-button-muted" type="button" hidden>حدث زمني</button><button id="wp-board-reset" class="wp-button wp-button-muted" type="button" aria-label="إعادة ضبط اللوحة">إعادة الضبط</button></div>',
  '        </div>',
  '        <div id="wp-board-viewport" class="wp-board-viewport" tabindex="0" aria-label="مساحة لوحة التحقيق التفاعلية">',
  '          <div id="wp-board-world" class="wp-board-world"><svg id="wp-board-edges" class="wp-board-edges" aria-hidden="true"></svg><div id="wp-board-nodes" class="wp-board-nodes"></div></div>',
  '          <div class="wp-board-hint">اسحب للتحريك · عجلة/قرصان للتكبير · اضغط عنصرًا لعرضه</div>',
  '        </div>',
  '        <div id="wp-board-empty" class="wp-empty" hidden>لا توجد أدلة أو قضايا مرتبطة بعد. أضف سجلات موثقة فقط.</div>',
  '        <div id="wp-board-selection" class="wp-board-selection" aria-live="polite"><p class="wp-muted">اختر دليلًا أو قضية لعرض التفاصيل.</p></div>',
  '      </section>',
  '      <section id="wp-case-link-editor" class="wp-inline-editor" hidden><div class="wp-editor-card"><p class="wp-kicker">LINK EXISTING CASE</p><h3>ربط قضية من الأرشيف</h3><p class="wp-help">اختر القضايا الموجودة فعلًا في أرشيف القضايا. يُحفظ الربط مع ملف الشخص.</p><fieldset class="wp-form-wide"><legend>القضايا المرتبطة بالملف</legend><div id="wp-case-link-options" class="wp-case-options"></div></fieldset><div class="wp-form-actions"><button id="wp-case-link-save" class="wp-button wp-button-primary" type="button">حفظ روابط القضايا</button><button id="wp-case-link-cancel" class="wp-button wp-button-muted" type="button">إلغاء</button></div></div></section>',
  '      <section id="wp-new-case-editor" class="wp-inline-editor" hidden><form id="wp-new-case-form" class="wp-editor-card"><p class="wp-kicker">NEW CASE IN CASES VAULT</p><h3>إنشاء قضية وربطها بالملف</h3><p class="wp-help">تُنشأ القضية عبر أرشيف القضايا الحالي، ثم تُربط بهذا الملف. إذا تعذر الربط بعد الإنشاء ستبقى القضية محفوظة في الأرشيف.</p><div class="wp-form-grid"><label>عنوان القضية<input id="wp-new-case-title" maxlength="200" required></label><label>رابط دليل أرشيفي (HTTPS، اختياري)<input id="wp-new-case-media" type="url" maxlength="700" placeholder="https://…"></label><label class="wp-form-wide">تفاصيل القضية<textarea id="wp-new-case-description" maxlength="10000" rows="4" required></textarea></label></div><div class="wp-form-actions"><button class="wp-button wp-button-primary" type="submit">إنشاء القضية وربطها</button><button id="wp-new-case-cancel" class="wp-button wp-button-muted" type="button">إلغاء</button></div></form></section>',
  '      <section id="wp-evidence-editor" class="wp-inline-editor" hidden><form id="wp-evidence-form" class="wp-editor-card">',
  '        <p class="wp-kicker">RESTRICTED EVIDENCE INTAKE</p><h3 id="wp-evidence-editor-title">إضافة دليل</h3><input id="wp-evidence-id" type="hidden">',
  '        <div class="wp-form-grid"><label>نوع العنصر<select id="wp-evidence-category" required><option value="IMAGE">صورة / دليل</option><option value="VEHICLE">مركبة</option><option value="LOCATION">موقع</option><option value="PERSON">شخص / صورة ملف</option><option value="DOCUMENT">مستند</option><option value="OTHER">أخرى</option></select></label>',
  '          <label>العنوان<input id="wp-evidence-title" maxlength="200" required></label><label>المصدر<input id="wp-evidence-source" maxlength="500" placeholder="مصدر الدليل"></label><label>تاريخ الدليل<input id="wp-evidence-date" type="datetime-local" required></label>',
  '          <label class="wp-form-wide">وصف الدليل<textarea id="wp-evidence-description" maxlength="3000" rows="3"></textarea></label>',
  '          <label class="wp-form-wide">الملف (JPG/PNG/WebP/PDF/TXT، بحد أقصى 2MB)<input id="wp-evidence-file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf,text/plain"><span id="wp-evidence-file-current" class="wp-help"></span></label>',
  '          <fieldset class="wp-form-wide"><legend>القضايا المرتبطة بهذا الدليل</legend><div id="wp-evidence-cases" class="wp-case-options"></div></fieldset></div>',
  '        <div class="wp-form-actions"><button class="wp-button wp-button-primary" type="submit">حفظ الدليل</button><button id="wp-evidence-cancel" class="wp-button wp-button-muted" type="button">إلغاء</button></div>',
  '      </form></section>',
  '      <section id="wp-note-editor" class="wp-inline-editor" hidden><form id="wp-note-form" class="wp-editor-card"><p class="wp-kicker">INVESTIGATOR NOTE</p><h3 id="wp-note-editor-title">ملاحظة محقق</h3><input id="wp-note-id" type="hidden">',
  '        <div class="wp-form-grid"><label>العنوان<input id="wp-note-title" maxlength="200" required></label><label>القضية<select id="wp-note-case"></select></label><label class="wp-form-wide">الملاحظة<textarea id="wp-note-body" maxlength="10000" rows="4" required></textarea></label></div>',
  '        <div class="wp-form-actions"><button class="wp-button wp-button-primary" type="submit">حفظ الملاحظة</button><button id="wp-note-cancel" class="wp-button wp-button-muted" type="button">إلغاء</button></div>',
  '      </form></section>',
  '      <section id="wp-timeline-editor" class="wp-inline-editor" hidden><form id="wp-timeline-form" class="wp-editor-card"><p class="wp-kicker">TIMELINE ENTRY</p><h3>إضافة حدث زمني</h3><p class="wp-help">سجّل تطورًا يدويًا أو إفادة، وحدد التاريخ والقضية المرتبطة إن وجدت. تُعرض الأحداث من الأحدث إلى الأقدم.</p>',
  '        <div class="wp-form-grid"><label>نوع الحدث<select id="wp-event-type"><option value="MANUAL">تطور يدوي</option><option value="TESTIMONY_RECORDED">تسجيل إفادة</option></select></label><label>عنوان الحدث<input id="wp-event-title" maxlength="200" required></label><label>القضية<select id="wp-event-case"></select></label><label>وقت الحدث<input id="wp-event-date" type="datetime-local" required></label><label class="wp-form-wide">التفاصيل<textarea id="wp-event-body" maxlength="4000" rows="3" required></textarea></label></div>',
  '        <div class="wp-form-actions"><button class="wp-button wp-button-primary" type="submit">إضافة إلى الخط الزمني</button><button id="wp-event-cancel" class="wp-button wp-button-muted" type="button">إلغاء</button></div>',
  '      </form></section>',
  '      <section id="wp-case-editor" class="wp-inline-editor" hidden><form id="wp-case-form" class="wp-editor-card"><p class="wp-kicker">CIA CASE RECORD</p><h3>تحديث القضية المرتبطة</h3><input id="wp-case-id" type="hidden">',
  '        <div class="wp-form-grid"><label>عنوان القضية<input id="wp-case-title" maxlength="200" required></label><label>الحالة<input id="wp-case-status" maxlength="100" required></label><label>التصنيف<input id="wp-case-classification" maxlength="100"></label><label class="wp-form-wide">التفاصيل<textarea id="wp-case-description" maxlength="10000" rows="4"></textarea></label><label class="wp-form-wide">القرار النهائي<textarea id="wp-case-decision" maxlength="2000" rows="3" placeholder="يُترك فارغًا ما دامت القضية مفتوحة"></textarea></label></div>',
  '        <div class="wp-form-actions"><button class="wp-button wp-button-primary" type="submit">حفظ القضية</button><button id="wp-case-cancel" class="wp-button wp-button-muted" type="button">إلغاء</button></div>',
  '      </form></section>',
  '      <div class="wp-detail-grid wp-board-records">',
  '        <section class="wp-detail-card"><p class="wp-kicker">INVESTIGATOR NOTES</p><h3>ملاحظات المحققين</h3><p class="wp-help">دوّن ملاحظة بعنوان ومحتوى، واربطها بقضية متصلة بالملف أو اختر «بدون قضية». صاحب الملاحظة والوقت محفوظان.</p><div id="wp-notes-list" class="wp-record-list"></div></section>',
  '        <section class="wp-detail-card"><p class="wp-kicker">CHRONOLOGY</p><h3>السجل الزمني</h3><p class="wp-help">يعرض فتح الملف وإضافة الأدلة وربط القضايا وتغيير الحالة والإفادات والأحداث اليدوية؛ الأحدث أولًا. هذا سجل للتطورات، وليس سجل التدقيق.</p><div id="wp-timeline-list" class="wp-record-list"></div></section>',
  '        <section class="wp-detail-card wp-detail-wide"><p class="wp-kicker">AUDIT TRAIL</p><h3>سجل التدقيق</h3><p class="wp-help">يسجل تغييرات البيانات والعمليات المنفذة، مستقلًا عن التسلسل الزمني للتحقيق.</p><div id="wp-audit-list" class="wp-record-list"></div></section>',
  '      </div>',
  '    </section>',
  '    <section id="wp-editor" class="wp-editor" aria-labelledby="wp-editor-title" hidden>',
  '      <div class="wp-detail-toolbar"><button id="wp-cancel-button" class="wp-button wp-button-muted" type="button">إلغاء والعودة</button></div>',
  '      <form id="wp-person-form" class="wp-editor-card">',
  '        <p class="wp-kicker">RESTRICTED RECORD ENTRY</p><h2 id="wp-editor-title">إنشاء ملف تحقيق</h2><input id="wp-person-id" name="id" type="hidden">',
  '        <div class="wp-form-grid">',
  '          <label>الاسم الكامل<input id="wp-full-name" name="fullName" maxlength="160" required></label>',
  '          <label>رقم الملف<input id="wp-file-number" name="fileNumber" maxlength="64" required></label>',
  '          <label>رابط الصورة الأساسية<input id="wp-image-url" name="imageUrl" type="url" maxlength="700" placeholder="https://…"><span class="wp-help">للصور الحساسة، ارفعها كدليل «شخص / صورة ملف» لتخزينها الخاص.</span></label>',
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

function logStoreFailure(operation, error) {
  const rawCode = String(error?.code || 'UNKNOWN');
  const code = /^[A-Z0-9_-]{1,40}$/i.test(rawCode) ? rawCode : 'UNKNOWN';
  const rawName = String(error?.name || 'Error');
  const name = /^[A-Z0-9_$]{1,80}$/i.test(rawName) ? rawName : 'Error';
  console.error(`[WANTED PERSONS] ${operation} failed (${name}; code=${code}).`);
}

function summarizeCase(record) {
  if (!record || typeof record !== 'object') return null;
  const id = clean(record.id, 120);
  let mediaUrl = '';
  const media = clean(record.media, 700);
  if (media) {
    try {
      const parsed = new URL(media);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) mediaUrl = parsed.toString();
    } catch (_error) {}
  }
  return {
    id,
    caseNumber: clean(record.caseNumber || record.number || (id ? 'CASE-' + id : ''), 100),
    title: clean(record.title, 200),
    status: clean(record.status, 40),
    classification: clean(record.classification, 40),
    mediaUrl
  };
}

function availableCases(state) {
  const rows = Array.isArray(state?.cia_cases) ? state.cia_cases : [];
  return rows.map(summarizeCase).filter((item) => item && item.id);
}

function investigationCases(state) {
  const rows = Array.isArray(state?.cia_cases) ? state.cia_cases : [];
  return rows.map((record) => {
    const summary = summarizeCase(record);
    return summary ? {
      ...summary,
      description: clean(record.description || record.details, 10000),
      finalDecision: clean(record.finalDecision, 2000),
      mediaUrl: summary.mediaUrl,
      siad: clean(record.siad, 200),
      author: clean(record.author, 120),
      date: clean(record.date || record.createdAt, 80),
      createdAt: clean(record.createdAt || record.date, 80),
      updatedAt: clean(record.updatedAt, 80)
    } : null;
  }).filter((item) => item && item.id);
}

function casesForPerson(caseIds, state) {
  const ids = [...new Set(Array.isArray(caseIds) ? caseIds.map((id) => clean(id, 120)).filter(Boolean) : [])];
  const byId = new Map(availableCases(state).map((item) => [item.id, item]));
  return ids.map((id) => byId.get(id) || {
    id,
    caseNumber: id,
    title: 'بيانات القضية غير متاحة في الأرشيف',
    status: 'غير متاح',
    classification: '',
    mediaUrl: '',
    unavailable: true
  });
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
  const unavailable = () => ({
    ok: false,
    available: false,
    message: 'قسم المطلوبين غير متاح لأن مخزن PostgreSQL غير مهيأ. تحقق من إعداد DATABASE_URL وسجل تشغيل الخادم؛ لا يوجد حفظ محلي بديل.'
  });
  const denied = () => ({ ok: false, message: 'يتطلب هذا القسم صلاحية القيادة.' });
  const storeActor = (auth) => ({ ...auth.actor, canManageAll: auth.isLeadership === true });
  const actorName = (actor) => {
    const users = Array.isArray(getState()?.cia_users) ? getState().cia_users : [];
    const user = users.find((item) => String(item.id) === String(actor?.id || ''));
    return clean(user?.identity?.fullName || user?.name || user?.fullName || actor?.id, 120);
  };
  const caseLabels = () => Object.fromEntries(availableCases(getState()).map((item) => [
    item.id,
    [item.caseNumber, item.title].filter(Boolean).join(' · ') || item.id
  ]));
  const access = () => {
    const actor = requireUser();
    if (!actor) return { error: { ok: false, message: 'يلزم تسجيل الدخول بصلاحية فعالة.' } };
    return { actor, isLeadership: isLeadership(actor), error: null };
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
        permissions: { canManage: auth.isLeadership, canContribute: true }
      });
    } catch (error) {
      logStoreFailure('list', error);
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
      let historyWarning = '';
      if (typeof store.recordFileOpened === 'function') {
        try {
          await store.recordFileOpened({
            personId: id,
            actor: auth.actor,
            fileNumber: person.fileNumber,
            actorName: actorName(auth.actor)
          });
        } catch (error) {
          logStoreFailure('timeline-file-open', error);
          historyWarning = 'تعذر تسجيل فتح الملف في السجل الزمني.';
        }
      }
      return reply(callback, {
        ok: true, person, relatedCases: casesForPerson(person.caseIds, getState()),
        permissions: { canManage: auth.isLeadership, canContribute: true },
        historyWarning
      });
    } catch (error) {
      logStoreFailure('detail', error);
      return reply(callback, { ok: false, message: 'تعذر تحميل الملف التحقيقي.' });
    }
  });

  socket.on('wanted-persons:investigation', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    const store = getStore();
    if (!store || typeof store.board !== 'function') return reply(callback, unavailable());
    const personId = clean(payload?.personId, 120);
    if (!personId) return reply(callback, { ok: false, message: 'معرّف الملف غير صالح.' });
    try {
      const board = await store.board(personId);
      if (!board) return reply(callback, { ok: false, message: 'ملف المطلوب غير موجود.' });
      const caseRows = investigationCases(getState());
      const byCase = new Map(caseRows.map((item) => [item.id, item]));
      const users = Array.isArray(getState()?.cia_users) ? getState().cia_users : [];
      const byUser = new Map(users.map((user) => [String(user.id), user]));
      const decorate = (row) => ({
        ...row,
        relatedCases: (row.caseIds || (row.caseId ? [row.caseId] : [])).map((id) => byCase.get(id)).filter(Boolean)
      });
      board.evidence = (board.evidence || []).map(decorate);
      board.notes = (board.notes || []).map((row) => ({
        ...decorate(row),
        createdByName: clean(byUser.get(String(row.createdByUserId))?.identity?.fullName || byUser.get(String(row.createdByUserId))?.name || row.createdByUserId, 120),
        updatedByName: clean(byUser.get(String(row.updatedByUserId))?.identity?.fullName || byUser.get(String(row.updatedByUserId))?.name || row.updatedByUserId, 120),
        permissions: {
          canEdit: auth.isLeadership || String(row.createdByUserId) === String(auth.actor.id),
          canDelete: auth.isLeadership || String(row.createdByUserId) === String(auth.actor.id)
        }
      }));
      board.timeline = (board.timeline || []).map((row) => ({
        ...decorate(row),
        actorName: clean(byUser.get(String(row.actorUserId))?.identity?.fullName || byUser.get(String(row.actorUserId))?.name || row.actorUserId, 120)
      }));
      board.audit = (board.audit || []).map((entry) => {
        const user = byUser.get(String(entry.actorUserId));
        return { ...entry, actorName: clean(user?.identity?.fullName || user?.name || user?.publicCode || entry.actorUserId, 120) };
      });
      return reply(callback, { ok: true, ...board, availableCases: caseRows, permissions: { canManage: auth.isLeadership, canContribute: true } });
    } catch (error) {
      logStoreFailure('investigation', error);
      return reply(callback, { ok: false, message: 'تعذر تحميل لوحة التحقيق.' });
    }
  });

  socket.on('wanted-persons:save', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    if (!auth.isLeadership) return reply(callback, denied());
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
      const result = await store.save({ person, actor: storeActor(auth), caseLabels: caseLabels() });
      if (!result.ok) return reply(callback, result);
      return reply(callback, { ...result, relatedCases: casesForPerson(result.person.caseIds, getState()) });
    } catch (error) {
      logStoreFailure('save', error);
      return reply(callback, { ok: false, message: 'تعذر حفظ التغييرات في قاعدة البيانات.' });
    }
  });

  socket.on('wanted-persons:cases:save', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    if (!auth.isLeadership) return reply(callback, denied());
    const store = getStore();
    if (!store || typeof store.saveCaseLinks !== 'function') return reply(callback, unavailable());
    const source = payload && typeof payload === 'object' ? payload : {};
    const caseIds = Array.isArray(source.caseIds)
      ? [...new Set(source.caseIds.map((item) => clean(item, 120)).filter(Boolean))]
      : null;
    if (!caseIds) return reply(callback, { ok: false, message: 'قائمة القضايا غير صالحة.' });
    const validIds = new Set(availableCases(getState()).map((item) => item.id));
    if (caseIds.some((caseId) => !validIds.has(caseId))) return reply(callback, { ok: false, message: 'يمكن ربط الملف بقضايا موجودة في الأرشيف فقط.' });
    try {
      const result = await store.saveCaseLinks({
        personId: clean(source.personId, 120),
        caseIds,
        actor: storeActor(auth),
        caseLabels: caseLabels()
      });
      if (!result.ok) return reply(callback, result);
      return reply(callback, { ...result, relatedCases: casesForPerson(result.person.caseIds, getState()) });
    } catch (error) {
      logStoreFailure('case-links-save', error);
      return reply(callback, { ok: false, message: 'تعذر حفظ روابط القضايا في قاعدة البيانات.' });
    }
  });

  socket.on('wanted-persons:evidence:save', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    if (!auth.isLeadership) return reply(callback, denied());
    const store = getStore();
    if (!store || typeof store.saveEvidence !== 'function') return reply(callback, unavailable());
    const source = payload && typeof payload === 'object' ? payload : {};
    const personId = clean(source.personId, 120);
    const evidence = source.evidence && typeof source.evidence === 'object' ? source.evidence : {};
    const caseIds = Array.isArray(evidence.caseIds) ? [...new Set(evidence.caseIds.map((item) => clean(item, 120)).filter(Boolean))] : null;
    if (!caseIds) return reply(callback, { ok: false, message: 'قائمة القضايا المرتبطة غير صالحة.' });
    const validIds = new Set(availableCases(getState()).map((item) => item.id));
    if (caseIds.some((caseId) => !validIds.has(caseId))) return reply(callback, { ok: false, message: 'يمكن ربط الدليل بقضايا موجودة فقط.' });
    try {
      const result = await store.saveEvidence({ personId, evidence: { ...evidence, caseIds }, actor: auth.actor });
      return reply(callback, result);
    } catch (error) {
      logStoreFailure('evidence-save', error);
      return reply(callback, { ok: false, message: 'تعذر حفظ الدليل في قاعدة البيانات.' });
    }
  });

  socket.on('wanted-persons:evidence:delete', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    if (!auth.isLeadership) return reply(callback, denied());
    const store = getStore();
    if (!store || typeof store.deleteEvidence !== 'function') return reply(callback, unavailable());
    try {
      const result = await store.deleteEvidence({
        personId: clean(payload?.personId, 120),
        evidenceId: clean(payload?.evidenceId, 120),
        actor: auth.actor
      });
      return reply(callback, result);
    } catch (error) {
      logStoreFailure('evidence-delete', error);
      return reply(callback, { ok: false, message: 'تعذر حذف الدليل من قاعدة البيانات.' });
    }
  });

  socket.on('wanted-persons:evidence:file', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    const store = getStore();
    if (!store || typeof store.evidenceFile !== 'function') return reply(callback, unavailable());
    try {
      const file = await store.evidenceFile({
        personId: clean(payload?.personId, 120),
        evidenceId: clean(payload?.evidenceId, 120)
      });
      return reply(callback, file ? { ok: true, file } : { ok: false, message: 'المرفق غير موجود في هذا الملف.' });
    } catch (error) {
      logStoreFailure('evidence-file', error);
      return reply(callback, { ok: false, message: 'تعذر استرجاع المرفق الآمن.' });
    }
  });

  socket.on('wanted-persons:note:save', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    const store = getStore();
    if (!store || typeof store.saveNote !== 'function') return reply(callback, unavailable());
    const source = payload && typeof payload === 'object' ? payload : {};
    const caseId = clean(source.note?.caseId, 120);
    if (caseId && !availableCases(getState()).some((item) => item.id === caseId)) return reply(callback, { ok: false, message: 'اختر قضية موجودة أو اترك الحقل فارغًا.' });
    try {
      return reply(callback, await store.saveNote({
        personId: clean(source.personId, 120),
        note: source.note,
        actor: storeActor(auth)
      }));
    } catch (error) {
      logStoreFailure('note-save', error);
      return reply(callback, { ok: false, message: 'تعذر حفظ ملاحظة المحقق.' });
    }
  });

  socket.on('wanted-persons:note:delete', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    const store = getStore();
    if (!store || typeof store.deleteNote !== 'function') return reply(callback, unavailable());
    try {
      return reply(callback, await store.deleteNote({
        personId: clean(payload?.personId, 120),
        noteId: clean(payload?.noteId, 120),
        actor: storeActor(auth)
      }));
    } catch (error) {
      logStoreFailure('note-delete', error);
      return reply(callback, { ok: false, message: 'تعذر حذف ملاحظة المحقق.' });
    }
  });

  socket.on('wanted-persons:timeline:add', async (payload, callback) => {
    const auth = access();
    if (auth.error) return reply(callback, auth.error);
    const store = getStore();
    if (!store || typeof store.addTimelineEvent !== 'function') return reply(callback, unavailable());
    const source = payload && typeof payload === 'object' ? payload : {};
    const caseId = clean(source.event?.caseId, 120);
    const eventType = clean(source.event?.eventType || 'MANUAL', 40).toUpperCase();
    if (!['MANUAL', 'TESTIMONY_RECORDED'].includes(eventType)) return reply(callback, { ok: false, message: 'نوع الحدث اليدوي غير صالح.' });
    if (caseId && !availableCases(getState()).some((item) => item.id === caseId)) return reply(callback, { ok: false, message: 'اختر قضية موجودة أو اترك الحقل فارغًا.' });
    try {
      return reply(callback, await store.addTimelineEvent({
        personId: clean(source.personId, 120),
        event: source.event,
        actor: storeActor(auth)
      }));
    } catch (error) {
      logStoreFailure('timeline-add', error);
      return reply(callback, { ok: false, message: 'تعذر إضافة الحدث إلى السجل الزمني.' });
    }
  });
}

module.exports = { availableCases, casesForPerson, injectWantedPersonsMarkup, investigationCases, registerWantedPersonsSocket, summarizeCase };
