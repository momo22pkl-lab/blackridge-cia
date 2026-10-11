'use strict';
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const root = document;
  const ROLES = ['CIA CHIEF', 'SENIOR COMMANDER', 'HIGH COMMANDER', 'AGENT'];
  let role = 'CIA CHIEF';
  let selectedCode = 'AG-1042';
  let page = 'dash';
  let state = { people: [], warnings: [], reports: [], inquiries: [], totals: {} };
  let currentStatus = null;
  let priorStatusSignature = '';
  let notice = '';
  let reportDraft = null;
  let searchTerm = '';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const formatDate = (value) => value ? new Date(value).toLocaleString('ar-JO', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const timeLeft = (ms) => {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600), minutes = Math.floor((seconds % 3600) / 60), secs = seconds % 60;
    if (days) return `${days} يوم ${hours} ساعة`;
    if (hours) return `${hours} ساعة ${minutes} دقيقة`;
    return `${minutes} دقيقة ${secs} ثانية`;
  };
  const isChief = () => role === 'CIA CHIEF';
  const isSenior = () => role === 'SENIOR COMMANDER';
  const canSuspend = () => isChief() || isSenior();
  const canReadReports = () => isChief() || isSenior();
  const activePerson = () => state.people.find(p => p.code === selectedCode) || { code: selectedCode, rank: 'AGENT', hasWarning: false, warningCount: 0 };

  async function api(path, options = {}) {
    const demoActor = ({ 'CIA CHIEF': 'DEMO-CHIEF-001', 'SENIOR COMMANDER': 'DEMO-SENIOR-001', 'HIGH COMMANDER': 'DEMO-HIGH-001', 'AGENT': selectedCode })[role] || selectedCode;
    const headers = { 'X-Demo-Role': role, 'X-Demo-Code': selectedCode, 'X-Demo-Actor': demoActor, ...(options.headers || {}) };
    let body = options.body;
    if (body && !(body instanceof FormData) && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await fetch(path, { ...options, headers, body });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.blob();
    if (!response.ok) throw new Error(payload?.error || 'تعذر تنفيذ الطلب.');
    return payload;
  }
  async function loadState() {
    state = await api('/api/state');
    adjustSelectedCode();
    render();
  }
  function adjustSelectedCode() {
    if (role === 'AGENT') {
      if (!selectedCode.startsWith('AG-')) selectedCode = state.people.find(p => p.code.startsWith('AG-'))?.code || 'AG-1042';
    } else if (!state.people.some(p => p.code === selectedCode)) {
      selectedCode = state.people[0]?.code || 'AG-1042';
    }
  }
  function opts(personFilter = () => true, selected = '') {
    return state.people.filter(personFilter).map(p => {
      const label = isChief() ? `${p.code} — ${p.rank || 'AGENT'} — ${p.name || ''}` : `${p.code}${p.rank ? ` — ${p.rank}` : ''}`;
      return `<option value="${esc(p.code)}" ${p.code === selected ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
  }
  function rosterOptions() {
    return state.people.filter(p => role !== 'AGENT' || p.code.startsWith('AG-')).map(p => {
      const label = isChief() && p.name ? `${p.code} — ${p.name}` : `${p.code}${p.rank ? ` — ${p.rank}` : ''}`;
      return `<option value="${esc(p.code)}" ${p.code === selectedCode ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
  }
  function navItems() {
    const items = [ ['dash','لوحة القيادة','▦'] ];
    if (role !== 'AGENT') items.push(['people','قائمة الأفراد','▤'], ['warning','إصدار تحذير','＋']);
    else items.push(['people','قائمة الأكواد','▤']);
    if (canSuspend()) items.push(['suspend','إيقاف مؤقت','◷']);
    if (canReadReports()) items.push(['records','التحذيرات والتقارير','▣']);
    items.push(['portal','بوابة الفرد','▣']);
    if (canReadReports()) items.push(['inquiries','الاستفسارات','✉']);
    items.push(['permissions','الصلاحيات','⌑']);
    return items;
  }
  function renderNav() {
    $('#main-nav').innerHTML = navItems().map(([id, label, icon]) => `<button class="nav-btn ${id === page ? 'active' : ''}" data-page="${id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`).join('');
    $('#role-select').value = role;
    $('#code-select').innerHTML = rosterOptions();
    $('#code-select').value = selectedCode;
    $('#code-select').disabled = role === 'AGENT' && state.people.filter(p => p.code.startsWith('AG-')).length <= 1;
  }
  function head(kicker, title, description, right = '') {
    return `<div class="page-head"><div><div class="page-kicker">${kicker}</div><h1 class="page-title">${title}</h1><div class="page-description">${description}</div></div>${right ? `<div class="toolbar">${right}</div>` : ''}</div>`;
  }
  function panel(title, caption, body, actions = '') {
    return `<section class="panel"><div class="panel-header"><div><div class="panel-title">${title}</div>${caption ? `<div class="panel-caption">${caption}</div>` : ''}</div>${actions}</div>${body}</section>`;
  }
  function stat(title, value, tone = '') {
    return `<div class="stat-card"><div class="stat-title">${title}</div><div class="stat-number ${tone}">${value}</div></div>`;
  }
  function badge(text, kind = '') { return `<span class="badge ${kind}">${text}</span>`; }
  function statusBadge(p) {
    if (p.dismissed) return badge('مفصول', 'danger');
    if (p.suspended) return badge('إيقاف فعال', 'danger');
    if (p.hasWarning || p.warningCount > 0) return badge('يوجد تحذير', 'warn');
    return badge('سليم', 'good');
  }
  function actionsForPerson(p) {
    const controls = [];
    if (isChief() && !p.dismissed) controls.push(`<button class="btn btn-danger" data-action="dismiss" data-code="${esc(p.code)}">فصل</button>`);
    if (p.suspended && (isChief() || (isSenior() && p.suspensionByRole === role))) controls.push(`<button class="btn" data-action="lift" data-code="${esc(p.code)}">رفع الإيقاف</button>`);
    return controls.length ? `<div class="row-actions">${controls.join('')}</div>` : '';
  }
  function personRows({ restricted = false, showActions = true } = {}) {
    const list = state.people.filter(p => !searchTerm || p.code.toLowerCase().includes(searchTerm.toLowerCase()) || (isChief() && (p.name || '').includes(searchTerm)));
    if (!list.length) return `<div class="empty">لا توجد نتائج مطابقة.</div>`;
    if (restricted || role === 'AGENT') {
      return `<div class="list">${list.map(p => `<div class="list-row"><div class="row-main"><div class="code">${esc(p.code)}</div></div><div class="row-end">${statusBadge(p)}${showActions ? actionsForPerson(p) : ''}</div></div>`).join('')}</div>`;
    }
    return `<div class="list">${list.map(p => `<div class="list-row"><div class="row-main"><div class="code">${esc(p.code)}</div><div class="row-sub">${esc(p.rank || '')}${p.suspensionEndsAt ? ` · ينتهي الإيقاف: ${formatDate(p.suspensionEndsAt)}` : ''}</div>${isChief() ? `<div class="identity-line">الهوية: ${esc(p.name || 'غير متاحة')}</div>` : ''}</div><div class="row-end">${statusBadge(p)}${showActions ? actionsForPerson(p) : ''}</div></div>`).join('')}</div>`;
  }
  function dashboard() {
    if (role === 'AGENT') {
      const p = activePerson();
      return head('PERSONNEL PORTAL', 'لوحة حساب الفرد', 'يعرض حساب Agent الكود العسكري وحالة التحذير فقط.') +
        `<div class="cards">${stat('الكود العسكري', `<span style="font-size:21px;direction:ltr;display:inline-block">${esc(p.code)}</span>`)}${stat('حالة التحذير', p.hasWarning || p.warningCount ? 'يوجد تحذير' : 'لا يوجد', p.hasWarning || p.warningCount ? 'gold' : 'green')}${stat('حالة الحساب', p.dismissed ? 'مفصول' : p.suspended ? 'موقوف' : 'نشط', p.dismissed || p.suspended ? 'red' : 'green')}</div>` +
        panel('ملخص الحساب', 'لا تظهر أسماء حقيقية أو أسماء مصدر الإجراء في واجهة Agent.', `<div class="help">يتم تحديث حالة الحساب من الخادم دوريًا. استخدم «بوابة الفرد» لعرض إشعار الإيقاف أو الفصل والاستفسار عنه.</div><div class="button-row"><button class="btn btn-primary" data-page="portal">فتح بوابة الفرد</button><button class="btn" data-page="people">عرض الأكواد والحالات</button></div>`);
    }
    const cards = `${stat('إجمالي الأفراد', state.totals.personnel ?? state.people.length)}${stat('التحذيرات المسجلة', state.totals.warnings ?? 0, 'gold')}${stat('الإيقافات الفعالة', state.totals.suspensions ?? 0, 'red')}${stat('حالات الفصل', state.totals.dismissed ?? 0, 'red')}`;
    const quick = `<div class="button-row"><button class="btn btn-primary" data-page="warning">＋ إصدار تحذير</button>${canSuspend() ? `<button class="btn" data-page="suspend">إيقاف مؤقت</button>` : ''}${isChief() ? `<button class="btn btn-danger" data-page="people">إدارة الأفراد والفصل</button>` : ''}${canReadReports() ? `<button class="btn" data-page="records">التحذيرات والتقارير</button>` : ''}</div>`;
    const recent = [...state.people].filter(p => p.dismissed || p.suspended || p.hasWarning).slice(0, 6);
    return head('COMMAND DASHBOARD', 'لوحة القيادة', 'نظرة عامة على حالة الأفراد والإجراءات المتاحة حسب رتبتك.') + `<div class="cards">${cards}</div>` + panel('إجراءات سريعة', 'يمكنك تنفيذ الإجراءات التي تسمح بها رتبتك فقط.', quick) + panel('الحالات المسجلة', 'الهوية الحقيقية لا تظهر إلا للقائد CIA CHIEF.', recent.length ? personRows({ showActions: true }) : `<div class="empty">لا توجد حالات تستدعي الانتباه.</div>`);
  }
  function peoplePage() {
    const search = `<input id="person-search" value="${esc(searchTerm)}" placeholder="بحث بالكود العسكري${isChief() ? ' أو الهوية' : ''}…" aria-label="بحث">`;
    return head('PERSONNEL DIRECTORY', 'قائمة الأفراد', isChief() ? 'صلاحيات القائد: عرض الهوية الحقيقية وإدارة الفصل ورفع الإيقاف.' : role === 'AGENT' ? 'عرض محدود: الأكواد العسكرية وحالة التحذير فقط.' : 'تظهر الأكواد العسكرية والرتب دون الأسماء الحقيقية. يمكن للسينيور رفع الإيقاف الذي أصدره بنفسه فقط.', search) + panel('سجل الأفراد', 'الفصل متاح للقائد فقط، والإيقاف المؤقت له صلاحيات مستقلة.', personRows({ restricted: role === 'AGENT' }));
  }
  function warningPage() {
    if (role === 'AGENT') return head('ACCESS CONTROL', 'غير مصرح', 'إصدار التحذيرات ليس من صلاحيات Agent.') + `<div class="empty">لا تملك صلاحية إصدار التحذيرات.</div>`;
    return head('OFFICIAL WARNING', 'إصدار تحذير رسمي', 'اختر الفرد من القائمة العسكرية. عند إصدار تحذير من High Commander أو Senior Commander ستظهر خطوة اختيارية لكتابة تقرير PDF.') + panel('بيانات التحذير', 'يرتبط التحذير بالكود العسكري تلقائيًا.', `<form id="warning-form"><div class="form-grid"><div class="field"><label for="warning-code">الفرد المستهدف</label><select id="warning-code" name="code" required>${opts(p => !p.dismissed, selectedCode)}</select></div><div class="field"><label for="warning-reason">سبب التحذير</label><select id="warning-reason" name="reason" required><option value="">اختر السبب</option><option>مخالفة التعليمات</option><option>الغياب عن الخدمة</option><option>سوء استخدام الصلاحيات</option><option>مخالفة إجراءات العمل</option><option>سلوك غير مهني</option><option>أخرى</option></select></div></div><div class="field"><label for="warning-note">ملاحظات موجزة (اختياري)</label><textarea id="warning-note" name="note" placeholder="ملاحظات مرتبطة بالتحذير…"></textarea></div><div class="button-row"><button class="btn btn-primary" type="submit">تأكيد إصدار التحذير</button><button class="btn btn-soft" type="button" data-page="dash">إلغاء</button></div><div id="form-notice" class="notice">${esc(notice)}</div></form>`);
  }
  function suspensionPage() {
    if (!canSuspend()) return head('ACCESS CONTROL', 'غير مصرح', 'الإيقاف المؤقت متاح للقائد والسينيور كوماندر فقط.') + `<div class="empty">رتبتك لا تملك صلاحية الإيقاف أو رفعه.</div>`;
    return head('TEMPORARY SUSPENSION', 'إيقاف مؤقت', 'يُرفع الإيقاف تلقائيًا عند انتهاء المدة، ويمكن للقائد رفعه يدويًا في أي وقت.') + `<div class="help red-help">Senior Commander يستطيع رفع إيقافه هو فقط. CIA CHIEF يستطيع رفع أي إيقاف.</div>` + panel('تفاصيل الإيقاف', 'المدة محددة بالثواني في الخادم ويُحسب وقت الانتهاء تلقائيًا.', `<form id="suspension-form"><div class="form-grid"><div class="field"><label for="suspension-code">الفرد المستهدف</label><select id="suspension-code" name="code" required>${opts(p => !p.dismissed, selectedCode)}</select></div><div class="field"><label for="suspension-duration">مدة الإيقاف</label><select id="suspension-duration" name="durationSeconds"><option value="60">دقيقة واحدة (اختبار)</option><option value="300">5 دقائق</option><option value="1800">30 دقيقة</option><option value="3600">ساعة</option><option value="86400">24 ساعة</option><option value="604800">7 أيام</option></select></div></div><div class="field"><label for="suspension-reason">سبب الإيقاف</label><select id="suspension-reason" name="reason" required><option value="">اختر السبب</option><option>مخالفة جسيمة</option><option>مراجعة إدارية</option><option>تكرار المخالفات</option><option>إجراء أمني مؤقت</option><option>أخرى</option></select></div><div class="field"><label for="suspension-note">تفاصيل الإجراء (اختياري)</label><textarea id="suspension-note" name="note" placeholder="تفاصيل موجزة…"></textarea></div><div class="button-row"><button class="btn btn-danger" type="submit">تفعيل الإيقاف</button></div><div id="form-notice" class="notice">${esc(notice)}</div></form>`);
  }
  function reportCard(report) {
    const nameLine = isChief() && report.targetName ? `<div class="identity-line">الهوية: ${esc(report.targetName)}</div>` : '';
    return `<div class="report-card"><div class="report-top"><div><div class="code">${esc(report.targetCode)}${report.targetRank ? ` · ${esc(report.targetRank)}` : ''}</div>${nameLine}<div class="row-sub">رقم التقرير: ${esc(report.id)} · ${formatDate(report.createdAt)}</div></div>${badge(esc(report.createdByRole), 'blue')}</div><div class="report-reason">سبب التحذير: ${esc(report.reason)}</div><div class="report-body">${esc(report.reportBody)}</div><div class="button-row"><button class="btn btn-primary" data-download-report="${esc(report.id)}">تنزيل التقرير PDF</button></div></div>`;
  }
  function recordsPage() {
    if (!canReadReports()) return head('RESTRICTED RECORDS', 'غير مصرح', 'هذه الصفحة مقتصرة على CIA CHIEF وSenior Commander.') + `<div class="empty">ليس لديك صلاحية عرض التحذيرات والتقارير الرسمية.</div>`;
    const warningRows = (state.warnings || []).map(w => `<div class="list-row"><div class="row-main"><div class="code">${esc(w.targetCode)}${w.targetRank ? ` · ${esc(w.targetRank)}` : ''}</div>${isChief() && w.targetName ? `<div class="identity-line">الهوية: ${esc(w.targetName)}</div>` : ''}<div class="row-sub">${esc(w.reason)} · ${formatDate(w.createdAt)}</div>${w.note ? `<div class="row-sub">${esc(w.note)}</div>` : ''}</div><div class="row-end">${badge('تحذير رسمي','warn')}</div></div>`).join('');
    const reportRows = (state.reports || []).map(reportCard).join('');
    return head('RESTRICTED RECORDS', 'التحذيرات والتقارير الرسمية', 'هذه الخانة لا تظهر إلا للقائد CIA CHIEF والسينيور كوماندر. التقارير المرسلة من High Commander أو Senior Commander تُحفظ بصيغة PDF.', `<button class="btn" id="refresh-records">تحديث السجلات</button>`) + panel(`التقارير الرسمية (${state.reports?.length || 0})`, 'تقرير PDF مرفق بكل تحذير أرسل صاحبه تقريرًا بعده.', reportRows || `<div class="empty">لا توجد تقارير رسمية بعد.</div>`) + panel(`سجل التحذيرات (${state.warnings?.length || 0})`, 'يظهر سجل الأسماء الحقيقية للقائد فقط.', warningRows ? `<div class="list">${warningRows}</div>` : `<div class="empty">لا توجد تحذيرات لعرضها.</div>`);
  }
  function inquiryForm(code, inModal = false) {
    return `<form id="inquiry-form" data-code="${esc(code)}"><div class="field"><label for="inquiry-subject">موضوع الاستفسار</label><select id="inquiry-subject" name="subject"><option>طلب معرفة سبب القرار</option><option>طلب مراجعة الإيقاف</option><option>اعتراض على الفصل</option><option>طلب رفع الإيقاف</option><option>أخرى</option></select></div><div class="field"><label for="inquiry-body">تفاصيل الاستفسار</label><textarea id="inquiry-body" name="body" required minlength="4" placeholder="اكتب الاستفسار الذي تريد إرساله إلى القيادة…"></textarea></div><button class="btn btn-primary" type="submit">إرسال الاستفسار</button><div class="notice" id="form-notice"></div></form>`;
  }
  function portalPage() {
    const p = activePerson();
    const status = currentStatus && currentStatus.code === selectedCode ? currentStatus : null;
    const dismissed = status ? status.dismissed : p.dismissed;
    const suspension = status ? status.suspension : null;
    const suspended = status ? Boolean(status.suspension) : Boolean(p.suspended);
    const warningCount = status ? status.warningCount : p.warningCount;
    const alertForm = `<div class="panel"><div class="panel-title">طلب مراجعة أو استفسار</div><div class="panel-caption">يرسل الطلب إلى سجل الاستفسارات لدى القيادة المخولة.</div>${inquiryForm(p.code)}</div>`;
    if (dismissed) return head('PERSONNEL PORTAL', 'بوابة الفرد', 'الحالة الحالية للحساب المعروض في وضع الاختبار.') + `<div class="status-lock"><div class="seal">BR</div><div class="eyebrow">ACCESS TERMINATED</div><h2>أنت مفصول</h2><p>تم إنهاء صلاحية هذا الحساب ومنع الدخول إلى النظام. يمكنك إرسال استفسار رسمي لطلب معرفة السبب أو مراجعة القرار.</p>${isChief() && status?.dismissalReason ? `<p>سبب الفصل المسجل: ${esc(status.dismissalReason)}</p>` : ''}<div class="code">${esc(p.code)}</div></div>${alertForm}`;
    if (suspended) return head('PERSONNEL PORTAL', 'بوابة الفرد', 'تنبيه الحالة يظهر أثناء استخدام الموقع ويُحدّث من الخادم.') + `<div class="alert alert-red"><div class="eyebrow">TEMPORARY SUSPENSION</div><div class="alert-title">تم إيقاف حسابك مؤقتًا</div><p>سبب الإجراء: ${esc(suspension?.reason || (isChief() ? p.suspensionReason : '') || 'إيقاف إداري مؤقت')}</p><p>الوقت المتبقي: <strong id="remaining-time">${timeLeft(suspension?.remainingMs || Math.max(0, (p.suspensionEndsAt || Date.now()) - Date.now()))}</strong></p><div class="progress-track"><div class="progress-bar"></div></div><p>سينتهي الإيقاف تلقائيًا عند انتهاء المدة، أو يمكن للقائد رفعه قبل ذلك.</p></div>${alertForm}`;
    return head('PERSONNEL PORTAL', 'بوابة الفرد', 'واجهة معاينة لا تعرض الهوية الحقيقية أو مصدر العقوبة للفرد.') + `<div class="cards">${stat('الكود العسكري', `<span style="font-size:20px;direction:ltr;display:inline-block">${esc(p.code)}</span>`)}${stat('حالة التحذير', warningCount ? 'يوجد تحذير' : 'لا يوجد', warningCount ? 'gold' : 'green')}${stat('حالة الحساب', 'نشط', 'green')}</div>` + panel('حالة الحساب', 'يتم تحديث حالة الحساب من الخادم كل ثانيتين في وضع المعاينة.', `<div class="help green-help">لا توجد حاليًا حالة إيقاف أو فصل لهذا الحساب.</div>${warningCount ? `<div class="help">يوجد تحذير أو أكثر مسجل على هذا الحساب. راجع القيادة المختصة للتفاصيل.</div>` : ''}`) + panel('طلب مراجعة / استفسار', 'يمكن للفرد إرسال استفسار رسمي إلى القيادة.', inquiryForm(p.code));
  }
  function inquiriesPage() {
    if (!canReadReports()) return head('RESTRICTED', 'غير مصرح', 'الاستفسارات متاحة للقائد والسينيور كوماندر فقط.') + `<div class="empty">ليس لديك صلاحية عرض الاستفسارات.</div>`;
    const rows = (state.inquiries || []).map(q => `<div class="list-row"><div class="row-main"><div class="code">${isChief() && q.targetName ? esc(q.targetName) + ' · ' : ''}${esc(q.targetCode)}</div><div class="report-reason">${esc(q.subject)}</div><div class="row-sub">${esc(q.body)}</div><div class="row-sub">${formatDate(q.createdAt)}</div></div><div class="row-end">${badge(esc(q.status || 'قيد المراجعة'))}</div></div>`).join('');
    return head('PERSONNEL INQUIRIES', 'الاستفسارات الواردة', 'الطلبات المرسلة من بوابة الأفراد.') + panel(`الطلبات (${state.inquiries?.length || 0})`, '', rows ? `<div class="list">${rows}</div>` : `<div class="empty">لا توجد استفسارات واردة.</div>`);
  }
  function permissionsPage() {
    const data = [
      ['CIA CHIEF — القائد', 'عرض جميع الهويات الحقيقية، إصدار التحذيرات، الإيقاف ورفعه، الفصل من لوحة القيادة أو قائمة الأفراد، وعرض كل التقارير والاستفسارات.'],
      ['SENIOR COMMANDER', 'إصدار التحذيرات، إيقاف مؤقت، ورفع الإيقاف الذي أصدره بنفسه. يمكنه الاطلاع على التقارير الرسمية مع عدم إظهار الهويات الحقيقية. لا يملك صلاحية الفصل.'],
      ['HIGH COMMANDER', 'إصدار التحذيرات. بعد التحذير يمكن كتابة تقرير رسمي وتحويله إلى PDF وإرساله إلى السجل القيادي. لا يملك صلاحية الإيقاف أو الفصل، ولا يرى خانة التقارير.'],
      ['AGENT', 'عرض الكود العسكري وحالة التحذير فقط. لا تظهر الأسماء الحقيقية أو هوية مصدر التحذير. عند الإيقاف أو الفصل يظهر تنبيه في الحساب، ويمكن إرسال استفسار.']
    ];
    return head('ACCESS POLICY', 'مصفوفة الصلاحيات', 'مرجع سريع للصلاحيات المصممة في هذا النموذج.') + `<div class="panel">${data.map(([name,desc]) => `<div class="permission-card"><strong>${name}</strong><p>${desc}</p></div>`).join('')}<div class="help red-help">تنبيه: قائمة الرتب في أعلى الصفحة لمعاينة الواجهة فقط. يجب ربط الصلاحيات بهوية المستخدم الموثقة داخل الخادم قبل تشغيلها على بيانات حقيقية.</div></div>`;
  }
  function render() {
    renderNav();
    // A selected Agent account that is suspended or dismissed is shown as blocked regardless of selected page.
    const p = activePerson();
    const status = currentStatus && currentStatus.code === selectedCode ? currentStatus : null;
    const blocked = role === 'AGENT' && (status ? (status.dismissed || Boolean(status.suspension)) : (p.dismissed || p.suspended));
    let html;
    if (blocked && page !== 'portal') {
      const previous = page; page = 'portal'; renderNav(); html = portalPage();
      // Keep the selected navigation on the only safe user action.
      $('#main-nav').querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.page === 'portal'));
    } else {
      switch (page) {
        case 'people': html = peoplePage(); break;
        case 'warning': html = warningPage(); break;
        case 'suspend': html = suspensionPage(); break;
        case 'records': html = recordsPage(); break;
        case 'portal': html = portalPage(); break;
        case 'inquiries': html = inquiriesPage(); break;
        case 'permissions': html = permissionsPage(); break;
        default: page = 'dash'; html = dashboard();
      }
    }
    $('#main-content').innerHTML = html;
  }
  async function refreshSelectedStatus({ renderOnChange = true } = {}) {
    if (!selectedCode) return;
    try {
      const next = await api(`/api/status/${encodeURIComponent(selectedCode)}`);
      const signature = JSON.stringify({ dismissed: next.dismissed, suspensionId: next.suspension?.id || null, suspended: Boolean(next.suspension), hasWarning: next.hasWarning, warningCount: next.warningCount });
      const changed = priorStatusSignature && priorStatusSignature !== signature;
      priorStatusSignature = signature;
      currentStatus = next;
      if (renderOnChange && changed && (page === 'portal' || role === 'AGENT')) render();
      const remaining = $('#remaining-time');
      if (remaining && next.suspension) remaining.textContent = timeLeft(next.suspension.remainingMs);
    } catch (_error) {
      // A temporary polling failure must not break the page; the next poll retries.
    }
  }
  async function go(nextPage) {
    page = nextPage;
    notice = '';
    await refreshSelectedStatus({ renderOnChange: false });
    render();
  }
  function formDataAsObject(form) { return Object.fromEntries(new FormData(form).entries()); }
  async function createWarning(form) {
    const data = formDataAsObject(form);
    const result = await api('/api/warnings', { method: 'POST', body: data });
    await loadState();
    notice = 'تم إصدار التحذير بنجاح.';
    if (result.allowReport) openReportPrompt(result.warning);
    else render();
  }
  function showModal(title, content) {
    $('#modal-root').innerHTML = `<div class="modal-backdrop" role="dialog" aria-modal="true"><section class="modal"><div class="modal-top"><div><div class="eyebrow">BLACKRIDGE CITY CIA</div><div class="modal-title">${title}</div></div><button class="close-btn" type="button" data-close-modal>إغلاق</button></div><div class="modal-body">${content}</div></section></div>`;
  }
  function closeModal() { $('#modal-root').innerHTML = ''; reportDraft = null; }
  function openReportPrompt(warning) {
    reportDraft = warning;
    showModal('إرفاق تقرير رسمي للتحذير', `<div class="help">تم إصدار التحذير. هل تريد كتابة تقرير مفصل وتحويله إلى PDF وإرساله إلى سجل القيادة؟ سيظهر التقرير للقائد CIA CHIEF والسينيور كوماندر فقط. لن تُدرج الأسماء الحقيقية داخل ملف PDF.</div><div class="report-card"><div class="code">${esc(warning.targetCode)} · ${esc(warning.targetRank || '')}</div><div class="report-reason">سبب التحذير: ${esc(warning.reason)}</div><div class="row-sub">رقم التحذير: ${esc(warning.id)}</div></div><form id="report-form"><div class="field"><label for="report-body">التقرير الرسمي</label><textarea id="report-body" name="reportBody" required minlength="10" rows="7" placeholder="اكتب تفاصيل الواقعة بدقة: ماذا حدث، متى وأين حدث، التعليمات التي خولفت، الشواهد المتاحة، وأي توصية للقيادة…"></textarea><small>يُنشأ PDF رسمي مع كود الفرد ورتبته وسبب التحذير والتفاصيل وتاريخ الإصدار.</small></div><div class="button-row"><button class="btn btn-primary" type="submit">توليد PDF وإرساله للقيادة</button><button class="btn" type="button" data-close-modal>تخطي الآن</button></div><div class="notice" id="report-notice"></div></form>`);
  }
  async function buildPdfBlob(warning, reportBody) {
    if (typeof window.html2pdf !== 'function') throw new Error('مكتبة إنشاء PDF لم تُحمّل. تحقق من اتصال الإنترنت ثم أعد المحاولة.');
    const now = new Date().toLocaleString('ar-JO', { dateStyle: 'full', timeStyle: 'short' });
    const doc = document.createElement('div');
    doc.setAttribute('dir', 'rtl');
    doc.style.cssText = 'width:760px;padding:42px 48px;background:#ffffff;color:#111827;font-family:Tahoma,Arial,sans-serif;direction:rtl;line-height:1.9;box-sizing:border-box;';
    const textBody = esc(reportBody).replace(/\n/g, '<br>');
    doc.innerHTML = `<div style="border-bottom:3px solid #a98139;padding-bottom:18px;margin-bottom:20px"><img id="report-seal" src="/blackridge-official-seal.jpg" alt="شعار BLACKRIDGE CITY CIA الرسمي" style="display:block;width:88px;height:88px;object-fit:contain;margin:0 auto 9px"><div style="font:900 24px Arial;letter-spacing:1px;direction:ltr;text-align:center;color:#111827">BLACKRIDGE CITY CIA</div><div style="text-align:center;font-size:12px;color:#5c6470;margin-top:5px">تقرير رسمي سري — PERSONNEL ACTION REPORT</div></div><div style="border:1px solid #c8ced6;padding:14px;background:#f7f8fa;margin-bottom:18px"><div><b>رقم التحذير:</b> ${esc(warning.id)}</div><div><b>الكود العسكري:</b> <span dir="ltr">${esc(warning.targetCode)}</span></div><div><b>الرتبة:</b> ${esc(warning.targetRank || 'غير محددة')}</div><div><b>سبب التحذير:</b> ${esc(warning.reason)}</div><div><b>الجهة المصدرة:</b> ${esc(role)}</div><div><b>تاريخ التقرير:</b> ${esc(now)}</div></div><h3 style="border-right:4px solid #a98139;padding-right:9px;font-size:16px">تفاصيل الواقعة والتبرير</h3><div style="font-size:13px;white-space:normal;min-height:150px">${textBody}</div><div style="margin-top:26px;padding-top:12px;border-top:1px solid #c8ced6;font-size:10px;color:#6b7280">سري: يوزع داخل نظام BLACKRIDGE CITY CIA على CIA CHIEF وSENIOR COMMANDER فقط. يحتوي هذا الملف على الكود العسكري دون الاسم الحقيقي.</div>`;
    const reportSeal = doc.querySelector('#report-seal');
    if (reportSeal) await reportSeal.decode();
    const options = { margin: [10, 10, 12, 10], image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }, pagebreak: { mode: ['css', 'legacy'] } };
    const worker = window.html2pdf().set(options).from(doc).toPdf();
    return await worker.outputPdf('blob');
  }
  async function createReport(form) {
    const body = new FormData(form).get('reportBody').trim();
    const warning = reportDraft;
    const button = $('button[type="submit"]', form);
    button.disabled = true; button.textContent = 'يتم توليد ملف PDF…';
    const note = $('#report-notice'); if (note) note.textContent = 'يجري إعداد التقرير وتحويله إلى PDF ثم إرساله إلى الخادم…';
    try {
      const blob = await buildPdfBlob(warning, body);
      const uploadData = new FormData();
      uploadData.append('warningId', warning.id);
      uploadData.append('reportBody', body);
      uploadData.append('pdf', blob, `BR-CIA-${warning.id}.pdf`);
      await api('/api/reports', { method: 'POST', body: uploadData });
      closeModal();
      page = 'dash';
      await loadState();
      showModal('تم إرسال التقرير', `<div class="alert alert-green"><div class="alert-title" style="color:#81e0b0">تم إنشاء ملف PDF وإرساله بنجاح</div><p style="color:#d3eadc">تم حفظ التقرير في الخادم، ويظهر في خانة «التحذيرات والتقارير» للقائد CIA CHIEF والسينيور كوماندر.</p></div><div class="button-row"><button class="btn btn-primary" data-close-modal>متابعة</button>${canReadReports() ? '<button class="btn" data-page="records">فتح التقارير</button>' : ''}</div>`);
    } catch (error) {
      if (note) note.textContent = error.message;
      if (button) { button.disabled = false; button.textContent = 'إعادة المحاولة'; }
    }
  }
  async function dismissPerson(code) {
    const p = state.people.find(item => item.code === code);
    const confirmText = `تأكيد فصل ${code}${isChief() && p?.name ? ` (${p.name})` : ''}؟ سيتم منع الحساب من الدخول.`;
    if (!window.confirm(confirmText)) return;
    const reason = window.prompt('اكتب سبب الفصل ليظهر في السجل القيادي:');
    if (reason === null) return;
    if (!reason.trim()) { window.alert('سبب الفصل مطلوب.'); return; }
    try {
      await api(`/api/dismissals/${encodeURIComponent(code)}`, { method: 'POST', body: { reason } });
      notice = 'تم تسجيل الفصل. سيظهر إشعار «أنت مفصول» للحساب عند التحقق من حالته.';
      await loadState();
    } catch (error) { window.alert(error.message); }
  }
  async function liftSuspension(code) {
    if (!window.confirm(`هل تريد رفع الإيقاف المؤقت عن ${code}؟`)) return;
    try { await api(`/api/suspensions/${encodeURIComponent(code)}/lift`, { method: 'POST', body: {} }); notice = 'تم رفع الإيقاف.'; await loadState(); await refreshSelectedStatus({ renderOnChange: false }); render(); }
    catch (error) { window.alert(error.message); }
  }
  async function submitSuspension(form) {
    const data = formDataAsObject(form);
    data.durationSeconds = Number(data.durationSeconds);
    const result = await api('/api/suspensions', { method: 'POST', body: data });
    selectedCode = result.code;
    $('#code-select').value = selectedCode;
    await loadState(); await refreshSelectedStatus({ renderOnChange: false });
    notice = 'تم تفعيل الإيقاف. يستطيع الحساب المتأثر رؤية التنبيه فور تحديث حالته.';
    render();
    showModal('تم تفعيل الإيقاف المؤقت', `<div class="alert alert-red"><div class="alert-title">الإيقاف فعال</div><p>الكود العسكري: <b dir="ltr">${esc(result.code)}</b></p><p>ينتهي في: <b>${formatDate(result.suspension.endsAt)}</b></p><p>عند انتهاء المدة يُرفع الإيقاف تلقائيًا من الخادم. يمكن للقائد رفعه يدويًا في أي وقت.</p></div><div class="button-row"><button class="btn btn-primary" data-close-modal>حسنًا</button><button class="btn" data-open-portal>معاينة تنبيه الفرد</button></div>`);
  }
  async function submitInquiry(form) {
    const body = formDataAsObject(form);
    body.code = form.dataset.code || selectedCode;
    await api('/api/inquiries', { method: 'POST', body });
    const n = $('#form-notice'); if (n) n.textContent = 'تم إرسال الاستفسار إلى سجل القيادة.';
    if (canReadReports()) { await loadState(); if (page === 'inquiries') render(); }
    else { form.reset(); if (n) n.textContent = 'تم إرسال الاستفسار إلى القيادة المختصة.'; }
  }
  function errorNotice(form, message) {
    const element = $('#form-notice', form);
    if (element) element.textContent = message;
    else window.alert(message);
  }

  root.addEventListener('click', async event => {
    const pageButton = event.target.closest('[data-page]');
    if (pageButton) {
      if (role === 'AGENT' && activePerson().dismissed && pageButton.dataset.page !== 'portal') return;
      if (pageButton.closest('.modal')) closeModal();
      await go(pageButton.dataset.page); return;
    }
    const action = event.target.closest('[data-action]');
    if (action) {
      if (action.dataset.action === 'dismiss') await dismissPerson(action.dataset.code);
      if (action.dataset.action === 'lift') await liftSuspension(action.dataset.code);
      return;
    }
    const close = event.target.closest('[data-close-modal]');
    if (close) { closeModal(); return; }
    const download = event.target.closest('[data-download-report]');
    if (download) {
      try {
        const file = await api(`/api/reports/${encodeURIComponent(download.dataset.downloadReport)}/pdf`);
        const url = URL.createObjectURL(file);
        const a = document.createElement('a'); a.href = url; a.download = `${download.dataset.downloadReport}.pdf`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      } catch (error) { window.alert(error.message); }
      return;
    }
    if (event.target.closest('#refresh-records')) { await loadState(); return; }
    if (event.target.closest('[data-open-portal]')) { closeModal(); await go('portal'); return; }
    if (event.target.classList.contains('modal-backdrop')) closeModal();
  });
  root.addEventListener('change', async event => {
    if (event.target.id === 'role-select') {
      role = event.target.value;
      if (role === 'AGENT' && !selectedCode.startsWith('AG-')) selectedCode = 'AG-1042';
      currentStatus = null; priorStatusSignature = ''; page = 'dash'; notice = '';
      try { await loadState(); await refreshSelectedStatus({ renderOnChange: false }); render(); } catch (error) { showFatal(error); }
    }
    if (event.target.id === 'code-select') {
      selectedCode = event.target.value;
      priorStatusSignature = '';
      await refreshSelectedStatus({ renderOnChange: false });
      render();
    }
    if (event.target.id === 'person-search') { searchTerm = event.target.value; render(); const input = $('#person-search'); if (input) { input.focus(); input.setSelectionRange(input.value.length,input.value.length); } }
  });
  root.addEventListener('input', event => {
    if (event.target.id === 'person-search') {
      searchTerm = event.target.value;
      const cursor = event.target.selectionStart;
      const list = $('.panel .list', $('#main-content'));
      if (list) { list.outerHTML = personRows({ restricted: role === 'AGENT' }); const input = $('#person-search'); if (input) { input.focus(); input.setSelectionRange(cursor,cursor); } }
    }
  });
  root.addEventListener('submit', async event => {
    const form = event.target;
    if (form.id === 'warning-form') {
      event.preventDefault();
      const button = $('button[type="submit"]', form); button.disabled = true;
      try { await createWarning(form); }
      catch (error) { errorNotice(form,error.message); button.disabled = false; }
      return;
    }
    if (form.id === 'suspension-form') {
      event.preventDefault(); const button = $('button[type="submit"]', form); button.disabled = true;
      try { await submitSuspension(form); }
      catch (error) { errorNotice(form,error.message); button.disabled = false; }
      return;
    }
    if (form.id === 'report-form') { event.preventDefault(); await createReport(form); return; }
    if (form.id === 'inquiry-form') {
      event.preventDefault(); const button = $('button[type="submit"]', form); button.disabled = true;
      try { await submitInquiry(form); }
      catch (error) { errorNotice(form,error.message); }
      finally { if (button && document.contains(button)) button.disabled = false; }
    }
  });

  function showFatal(error) { $('#main-content').innerHTML = `<div class="alert alert-red"><div class="alert-title">تعذر تحميل النظام</div><p>${esc(error.message)}</p><p>تأكد من تشغيل الخادم باستخدام npm start.</p></div>`; }
  async function init() {
    try {
      const health = await fetch('/api/health').then(r => r.json());
      if (!health.ok) throw new Error('الخادم غير جاهز.');
      await loadState();
      await refreshSelectedStatus({ renderOnChange: false });
      render();
      setInterval(async () => {
        await refreshSelectedStatus({ renderOnChange: true });
        // Keep badge and roster counts fresh without resetting active forms on every poll.
        if (page === 'dash' && role !== 'AGENT') {
          try { state = await api('/api/state'); } catch (_) { }
        }
      }, 2000);
    } catch (error) { showFatal(error); }
  }
  init();
})();
