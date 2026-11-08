'use strict';

const DOSSIER_HEAD_MARKUP = '<link href="/military-personnel-dossier.css" rel="stylesheet">';
const DOSSIER_NAV_MARKUP = `<li id="military-personnel-dossier-nav" class="nav-btn" onclick="window.openMilitaryPersonnelDossier(this)">
  <i class="fa-solid fa-id-card-clip" aria-hidden="true"></i> الملف العسكري
</li>`;
const DOSSIER_PANE_MARKUP = `<div id="military-personnel-dossier" class="view-pane military-personnel-dossier-pane" aria-label="الملف العسكري">
  <main class="mpd-shell" dir="rtl">
    <header class="mpd-header">
      <div>
        <p class="mpd-eyebrow">BLACKRIDGE CIA // PERSONNEL RECORDS</p>
        <h1>الملف العسكري</h1>
        <p class="mpd-subtitle">سجل الأفراد المصرّح لك بالاطلاع عليهم</p>
      </div>
      <div class="mpd-classification"><i class="fa-solid fa-lock" aria-hidden="true"></i><span>سجل مقيّد بالصلاحيات</span></div>
    </header>
    <div id="mpd-status" class="mpd-status" role="status" aria-live="polite" hidden></div>
    <section class="mpd-toolbar" aria-label="البحث في الملفات العسكرية">
      <label class="mpd-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input id="mpd-search" type="search" maxlength="120" autocomplete="off" placeholder="ابحث بالاسم أو الكود العسكري" aria-label="ابحث بالاسم أو الكود العسكري">
      </label>
      <button id="mpd-refresh" class="mpd-refresh" type="button"><i class="fa-solid fa-rotate" aria-hidden="true"></i><span>تحديث السجل</span></button>
    </section>
    <div class="mpd-layout">
      <section class="mpd-roster" aria-label="قائمة العسكريين">
        <header class="mpd-section-head"><div><span class="mpd-kicker">AUTHORIZED ROSTER</span><h2>سجل العسكريين</h2></div><span id="mpd-count" class="mpd-count">—</span></header>
        <div id="mpd-roster-list" class="mpd-roster-list"><div class="mpd-empty">جارٍ تحميل السجل…</div></div>
      </section>
      <section id="mpd-profile" class="mpd-profile" aria-label="الملف الشخصي للعسكري">
        <div class="mpd-empty mpd-profile-empty"><i class="fa-solid fa-folder-open" aria-hidden="true"></i><strong>اختر سجلًا لعرض الملف</strong><span>تظهر هنا البيانات التي تسمح بها صلاحيات حسابك.</span></div>
      </section>
    </div>
    <footer class="mpd-footer"><span>BLACKRIDGE CIA</span><span>واجهة المرحلة الأولى · الملاحظات والقضايا والسجل الزمني والمرفقات غير مفعّلة بعد</span></footer>
  </main>
</div>`;

function injectMilitaryPersonnelDossierMarkup(html) {
  let result = String(html == null ? '' : html);
  if (!/<head(?:\s[^>]*)?>/i.test(result) || !/<\/body>/i.test(result)) return result;

  if (!result.includes('href="/military-personnel-dossier.css"')) {
    result = result.replace(/<\/head>/i, `  ${DOSSIER_HEAD_MARKUP}\n</head>`);
  }
  if (!result.includes('id="military-personnel-dossier-nav"')) {
    const ibpNav = /(<li id="ibp-nav"[^>]*>[\s\S]*?<\/li>)/i;
    if (ibpNav.test(result)) result = result.replace(ibpNav, `$1\n${DOSSIER_NAV_MARKUP}`);
    else result = result.replace(/(<ul class="nav-list">)/i, `$1\n${DOSSIER_NAV_MARKUP}`);
  }
  if (!result.includes('id="military-personnel-dossier"')) {
    const dashboard = /(<div id="dashboard" class="view-pane active">)/i;
    if (dashboard.test(result)) result = result.replace(dashboard, `${DOSSIER_PANE_MARKUP}\n$1`);
  }
  if (!result.includes('src="/military-personnel-dossier-client.js"')) {
    result = result.replace(/<\/body>/i, '  <script src="/military-personnel-dossier-client.js" defer></script>\n</body>');
  }
  return result;
}

module.exports = { injectMilitaryPersonnelDossierMarkup };
