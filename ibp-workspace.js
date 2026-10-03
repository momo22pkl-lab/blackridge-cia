(function () {
  "use strict";

  const text = {
    ar: {
      language: "لغة الواجهة",
      home: "مركز القيادة",
      map: "خريطة القطاع",
      network: "شبكة الكتائب والقيادة",
      personnel: "ملفات الأفراد",
      operations: "مركز العمليات",
      archive: "أرشيف المعلومات",
      audit: "السجل القيادي",
      title: "مركز قيادة القطاع",
      caption: "مركز القيادة // قطاع لوس سانتوس",
      access: "مستوى الصلاحية",
      personnelScope: "أفراد ضمن صلاحية العرض",
      operationsScope: "عمليات حسب صلاحية الرتبة",
      serviceScope: "حالة المشغّل الحالي",
      mapOpen: "فتح خريطة الانتشار ←",
      feedNote: "تُعرض البيانات بحسب صلاحية الحساب. لا يعرض هذا المركز مواقع ميدانية غير متاحة للنظام.",
      modulesSub: "اختر محطة لفتحها داخل شبكة القيادة",
      cardDescriptions: [
        "خريطة القطاع ومواقع المهمة",
        "شبكة القيادة وإدارة الأفراد",
        "الأفراد والحضور والهويات المصرح بها",
        "المهمات والتحديثات الميدانية",
        "أرشيف القضايا والأدلة",
        "البلاغات والتنبيهات المصرح بها",
        "التقارير والملخصات",
        "سجل القيادة والتغييرات المصرح بها"
      ],
      scopeFooter: "دخول آمن // بحسب الرتبة",
      workspaceTitle: "شبكة القيادة والاستخبارات",
      workspaceEyebrow: "إدارة التشكيلات • صورة تشغيلية مصرح بها",
      selectUnit: "الكتيبة المحددة",
      filter: "تصفية",
      allUnits: "جميع الكتائب",
      createUnit: "＋ إنشاء كتيبة",
      activeUnits: "كتائب غير مؤرشفة",
      assignedPeople: "أفراد ضمن الكتائب الظاهرة",
      onlinePeople: "متصلون بالتطبيق",
      visibleOperations: "عمليات ظاهرة",
      battalionNetwork: "شبكة الكتائب",
      visibleUnits: "كتائب ضمن صلاحيتك",
      battalionDetail: "ملف الكتيبة",
      chooseUnit: "اختر كتيبة لعرض تفاصيلها",
      commandTree: "تسلسل القيادة",
      selectedUnit: "الكتيبة المحددة",
      commander: "قائد الكتيبة",
      members: "الأفراد",
      sector: "القطاع",
      status: "الحالة",
      operationsFeed: "موجز العمليات",
      noVisibleOperations: "لا توجد عمليات ظاهرة حالياً.",
      restrictedOperations: "مركز العمليات غير متاح لهذه الرتبة.",
      noUnits: "لا توجد كتائب ظاهرة لحسابك بعد.",
      noUnitsManager: "يمكن للمخوّلين إنشاء الكتيبة الأولى وربط الأفراد بها.",
      noUnitsMember: "ستظهر هنا الكتائب المرتبطة بحسابك أو المتاحة لرتبتك.",
      loadError: "تعذر تحميل بيانات الكتائب. أعد المحاولة بعد التحقق من اتصال الخدمة.",
      loading: "جارٍ تحميل البيانات…",
      noPersonnel: "لا يوجد أفراد مرتبطون بهذه الكتيبة.",
      online: "متصل",
      offline: "غير متصل",
      onDuty: "على رأس الخدمة",
      authorized: "مصرّح",
      notAuthorized: "غير متاح",
      openMap: "فتح خريطة القطاع",
      openOperations: "فتح مركز العمليات",
      openArchive: "فتح الأرشيف",
      edit: "تعديل",
      editBattalion: "تعديل بيانات الكتيبة",
      createBattalion: "إنشاء كتيبة",
      nameAr: "اسم الكتيبة بالعربية",
      nameEn: "اسم الكتيبة بالإنجليزية",
      sectorName: "اسم القطاع",
      symbol: "الرمز",
      unitColor: "لون التمييز",
      commanderField: "قائد الكتيبة",
      noCommander: "بدون قائد محدد",
      assignedMembers: "الأفراد المعيّنون",
      noAssignablePeople: "لا توجد قائمة أفراد متاحة لهذا الحساب.",
      statusActive: "نشطة",
      statusAlert: "تنبيه",
      statusStandby: "استعداد",
      statusArchived: "مؤرشفة",
      filterActive: "نشطة",
      filterAlert: "تنبيه",
      filterStandby: "استعداد",
      filterArchived: "مؤرشفة",
      save: "حفظ التغييرات",
      cancel: "إلغاء",
      archiveWarning: "الأرشفة لا تحذف البيانات، ويمكن إعادة تفعيل الكتيبة لاحقاً.",
      requiredName: "أدخل اسماً عربياً أو إنجليزياً للكتيبة.",
      saved: "تم حفظ الكتيبة.",
      saveError: "تعذر حفظ الكتيبة. تحقق من البيانات والصلاحيات.",
      statusOperation: "حالة العملية",
      operationUnknown: "غير محددة",
      secureChannel: "قناة القيادة",
      noCommanderData: "لم يُحدد قائد",
      memberCount: "عدد الأفراد",
      updatedFromServer: "محدّث من الخادم",
      notLiveTracking: "لا يوجد تتبع جغرافي حي",
      statusConnection: "حالة الاتصال",
      archiveConfirm: "سيؤدي حفظ الحالة المؤرشفة إلى إيقاف إسناد أفراد جدد لهذه الكتيبة. متابعة؟",
      errors: {
        "أحد الأفراد محدد بالفعل ضمن كتيبة أخرى نشطة.": "أحد الأفراد محدد بالفعل ضمن كتيبة أخرى نشطة.",
        "يجب أن يكون قائد الكتيبة من الرتب القيادية.": "يجب اختيار قائد من الرتب القيادية.",
        "رمز قائد الكتيبة غير صالح.": "رمز قائد الكتيبة غير صالح.",
        "تعذر التحقق من أحد أكواد الأفراد المختارين.": "تعذر التحقق من أحد أكواد الأفراد المختارين.",
        "أدخل اسم الكتيبة بالعربية أو الإنجليزية.": "أدخل اسماً عربياً أو إنجليزياً للكتيبة."
      }
    },
    en: {
      language: "Interface language",
      home: "Command center",
      map: "Sector map",
      network: "Battalion command network",
      personnel: "Personnel files",
      operations: "Operations center",
      archive: "Intelligence archive",
      audit: "Command audit",
      title: "Sector command center",
      caption: "COMMAND CENTER // LOS SANTOS SECTOR",
      access: "ACCESS LEVEL",
      personnelScope: "Personnel visible to your rank",
      operationsScope: "Operations visible to your rank",
      serviceScope: "Current operator status",
      mapOpen: "Open deployment map ←",
      feedNote: "Data is scoped to your account permissions. This console does not show field locations the system does not provide.",
      modulesSub: "Choose a station to open within the command network",
      cardDescriptions: [
        "Sector map and mission locations",
        "Command network and personnel assignment",
        "Personnel, attendance, and authorized identities",
        "Missions and field updates",
        "Case and evidence archive",
        "Authorized alerts and reports",
        "Reports and briefings",
        "Command activity and permitted changes"
      ],
      scopeFooter: "SECURE ACCESS // ROLE-SCOPED",
      workspaceTitle: "Intelligence command network",
      workspaceEyebrow: "Unit management • authorized operational view",
      selectUnit: "Selected battalion",
      filter: "Filter",
      allUnits: "All battalions",
      createUnit: "＋ Create battalion",
      activeUnits: "Non-archived battalions",
      assignedPeople: "People in visible battalions",
      onlinePeople: "App-connected personnel",
      visibleOperations: "Visible operations",
      battalionNetwork: "Battalion network",
      visibleUnits: "Battalions in your scope",
      battalionDetail: "Battalion file",
      chooseUnit: "Select a battalion to view its details",
      commandTree: "Command structure",
      selectedUnit: "Selected unit",
      commander: "Battalion commander",
      members: "Personnel",
      sector: "Sector",
      status: "Status",
      operationsFeed: "Operations feed",
      noVisibleOperations: "No visible operations right now.",
      restrictedOperations: "The operations center is not available at this rank.",
      noUnits: "No battalions are visible to this account yet.",
      noUnitsManager: "Authorized leaders can create the first battalion and assign personnel.",
      noUnitsMember: "Battalions assigned to your account or available to your rank will appear here.",
      loadError: "Battalion data could not be loaded. Check the service connection and retry.",
      loading: "Loading data…",
      noPersonnel: "No personnel are assigned to this battalion.",
      online: "Online",
      offline: "Offline",
      onDuty: "On duty",
      authorized: "Authorized",
      notAuthorized: "Unavailable",
      openMap: "Open sector map",
      openOperations: "Open operations center",
      openArchive: "Open archive",
      edit: "Edit",
      editBattalion: "Edit battalion",
      createBattalion: "Create battalion",
      nameAr: "Battalion name in Arabic",
      nameEn: "Battalion name in English",
      sectorName: "Sector name",
      symbol: "Unit symbol",
      unitColor: "Accent color",
      commanderField: "Battalion commander",
      noCommander: "No commander selected",
      assignedMembers: "Assigned personnel",
      noAssignablePeople: "No personnel roster is available to this account.",
      statusActive: "Active",
      statusAlert: "Alert",
      statusStandby: "Standby",
      statusArchived: "Archived",
      filterActive: "Active",
      filterAlert: "Alert",
      filterStandby: "Standby",
      filterArchived: "Archived",
      save: "Save changes",
      cancel: "Cancel",
      archiveWarning: "Archiving does not delete data. The battalion can be reactivated later.",
      requiredName: "Enter an Arabic or English battalion name.",
      saved: "Battalion saved.",
      saveError: "Battalion could not be saved. Check the data and your permissions.",
      statusOperation: "Operation status",
      operationUnknown: "Not specified",
      secureChannel: "Command channel",
      noCommanderData: "No commander assigned",
      memberCount: "Personnel",
      updatedFromServer: "Updated from server",
      notLiveTracking: "No live geographic tracking",
      statusConnection: "Connection",
      archiveConfirm: "Saving as archived will prevent new personnel assignments to this battalion. Continue?",
      errors: {
        "أحد الأفراد محدد بالفعل ضمن كتيبة أخرى نشطة.": "A selected person is already assigned to another active battalion.",
        "يجب أن يكون قائد الكتيبة من الرتب القيادية.": "Choose a commander with a leadership rank.",
        "رمز قائد الكتيبة غير صالح.": "The commander code is not valid.",
        "تعذر التحقق من أحد أكواد الأفراد المختارين.": "One of the selected personnel codes could not be verified.",
        "أدخل اسم الكتيبة بالعربية أو الإنجليزية.": "Enter an Arabic or English battalion name."
      }
    }
  };

  const state = {
    language: "ar",
    languageTouched: false,
    identity: "",
    battalions: [],
    assignablePersonnel: [],
    canManage: false,
    selectedId: "",
    filter: "ALL",
    loading: false,
    error: "",
    saving: false,
    lastBattalionRequest: 0,
    lastOperationsRequest: 0,
    operations: [],
    operationsLoading: false,
    operationsError: "",
    mounted: false
  };

  const root = () => document.getElementById("ibp-command-center");
  const locale = () => text[state.language] || text.ar;
  const t = (key) => locale()[key] || text.en[key] || key;
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[char]);
  const safeColor = (value) => /^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? value : "#c7a25a";
  const current = () => typeof currentUser !== "undefined" && currentUser ? currentUser : null;
  const socket = () => typeof ciaSocket !== "undefined" && ciaSocket ? ciaSocket : null;
  const connected = () => {
    const s = socket();
    return !!(s && s.connected);
  };
  const isAuthenticated = () => {
    return !!(current() && (typeof ciaSessionAuthenticated === "undefined" || ciaSessionAuthenticated));
  };
  const userCode = () => {
    const user = current();
    return user && (user.publicCode || user.code || user.characterCode) || "";
  };
  const statusLabel = (status) => {
    const key = {
      ACTIVE: "statusActive",
      ALERT: "statusAlert",
      STANDBY: "statusStandby",
      ARCHIVED: "statusArchived"
    }[String(status || "").toUpperCase()] || "statusActive";
    return t(key);
  };

  function canSeeOperations() {
    const nav = document.getElementById("operations-nav");
    if (!nav) return false;
    return getComputedStyle(nav).display !== "none" && !nav.hidden;
  }

  function mount() {
    const shell = root();
    if (!shell) return;
    if (!shell.querySelector("#ibp-language-select")) {
      const header = shell.querySelector(".ibp-header-right");
      if (header) {
        const control = document.createElement("label");
        control.className = "ibp-language-control";
        control.innerHTML = `<span data-ibp-lang-label></span><select id="ibp-language-select" aria-label="Interface language"><option value="ar">العربية</option><option value="en">English</option></select>`;
        header.insertBefore(control, header.firstChild);
      }
    }

    if (!shell.querySelector("#ibp-network-console")) {
      const dashboard = shell.querySelector(".ibp-dashboard");
      if (dashboard) {
        dashboard.insertAdjacentHTML("afterend", `
          <section id="ibp-network-console" class="ibp-network-console" aria-live="polite">
            <div class="ibp-network-heading">
              <div>
                <div class="ibp-network-eyebrow" data-ibp-i18n="workspaceEyebrow"></div>
                <h2 data-ibp-i18n="workspaceTitle"></h2>
              </div>
              <div class="ibp-network-toolbar">
                <label><span data-ibp-i18n="selectUnit"></span>
                  <select id="ibp-battalion-select" aria-label="Selected battalion"></select>
                </label>
                <label><span data-ibp-i18n="filter"></span>
                  <select id="ibp-battalion-filter" aria-label="Filter battalions"></select>
                </label>
                <button id="ibp-create-battalion" class="ibp-console-button" type="button" hidden></button>
              </div>
            </div>
            <div class="ibp-console-kpis">
              <div class="ibp-console-kpi"><span data-ibp-i18n="activeUnits"></span><strong id="ibp-kpi-units">—</strong><small data-ibp-i18n="updatedFromServer"></small></div>
              <div class="ibp-console-kpi"><span data-ibp-i18n="assignedPeople"></span><strong id="ibp-kpi-people">—</strong><small data-ibp-i18n="personnelScope"></small></div>
              <div class="ibp-console-kpi"><span data-ibp-i18n="onlinePeople"></span><strong id="ibp-kpi-online">—</strong><small data-ibp-i18n="statusConnection"></small></div>
              <div class="ibp-console-kpi"><span data-ibp-i18n="visibleOperations"></span><strong id="ibp-kpi-operations">—</strong><small data-ibp-i18n="operationsScope"></small></div>
            </div>
            <div class="ibp-network-grid">
              <section class="ibp-network-panel">
                <div class="ibp-console-title-row"><strong data-ibp-i18n="battalionNetwork"></strong><span id="ibp-network-count" class="ibp-console-meta"></span></div>
                <div id="ibp-battalion-grid" class="ibp-battalion-grid"></div>
              </section>
              <section class="ibp-network-panel">
                <div class="ibp-console-title-row"><strong data-ibp-i18n="battalionDetail"></strong><span id="ibp-detail-status" class="ibp-console-meta"></span></div>
                <div id="ibp-battalion-detail" class="ibp-battalion-detail"></div>
              </section>
            </div>
            <div class="ibp-lower-grid">
              <section class="ibp-network-panel">
                <div class="ibp-console-title-row"><strong data-ibp-i18n="commandTree"></strong><span id="ibp-tree-unit" class="ibp-console-meta"></span></div>
                <div id="ibp-command-tree" class="ibp-command-tree"></div>
              </section>
              <section class="ibp-network-panel">
                <div class="ibp-console-title-row"><strong data-ibp-i18n="operationsFeed"></strong><span id="ibp-feed-state" class="ibp-console-meta"></span></div>
                <div id="ibp-live-feed" class="ibp-live-feed"></div>
              </section>
            </div>
            <div class="ibp-quick-actions">
              <span data-ibp-i18n="secureChannel"></span>
              <button class="ibp-console-button secondary" type="button" data-ibp-open="tactical-map-view" data-ibp-i18n="openMap"></button>
              <button class="ibp-console-button secondary" type="button" data-ibp-open="operations" data-ibp-ops-action hidden data-ibp-i18n="openOperations"></button>
              <button class="ibp-console-button secondary" type="button" data-ibp-open="cases-vault" data-ibp-i18n="openArchive"></button>
            </div>
          </section>
          <div id="ibp-editor-modal" class="ibp-editor-modal" hidden>
            <section class="ibp-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="ibp-editor-title">
              <div class="ibp-editor-head">
                <h3 id="ibp-editor-title"></h3>
                <button id="ibp-editor-close" class="ibp-editor-close" type="button" aria-label="Close">×</button>
              </div>
              <form id="ibp-editor-form" class="ibp-editor-form">
                <input id="ibp-editor-id" type="hidden">
                <label class="ibp-editor-field"><span data-ibp-i18n="nameAr"></span><input id="ibp-editor-name-ar" maxlength="100" autocomplete="off"></label>
                <label class="ibp-editor-field"><span data-ibp-i18n="nameEn"></span><input id="ibp-editor-name-en" maxlength="100" autocomplete="off"></label>
                <label class="ibp-editor-field"><span data-ibp-i18n="sectorName"></span><input id="ibp-editor-sector" maxlength="100" autocomplete="off"></label>
                <label class="ibp-editor-field"><span data-ibp-i18n="symbol"></span><input id="ibp-editor-symbol" maxlength="16" autocomplete="off"></label>
                <label class="ibp-editor-field"><span data-ibp-i18n="unitColor"></span><input id="ibp-editor-color" type="color" value="#c7a25a"></label>
                <label class="ibp-editor-field"><span data-ibp-i18n="status"></span><select id="ibp-editor-status"></select></label>
                <label class="ibp-editor-field full"><span data-ibp-i18n="commanderField"></span><select id="ibp-editor-commander"></select></label>
                <div class="ibp-editor-field full"><span data-ibp-i18n="assignedMembers"></span><div id="ibp-editor-members" class="ibp-editor-members"></div></div>
                <div id="ibp-editor-error" class="ibp-editor-error" role="alert"></div>
              </form>
              <div class="ibp-editor-foot">
                <span class="ibp-editor-foot-note" data-ibp-i18n="archiveWarning"></span>
                <div><button id="ibp-editor-cancel" class="ibp-console-button secondary" type="button"></button> <button id="ibp-editor-save" class="ibp-console-button" type="submit" form="ibp-editor-form"></button></div>
              </div>
            </section>
          </div>
        `);
      }
    }

    const mapPreview = shell.querySelector("#ibp-map-preview");
    if (mapPreview && !mapPreview.querySelector(".ibp-map-data-note")) {
      const note = document.createElement("span");
      note.className = "ibp-map-data-note";
      mapPreview.append(note);
    }

    if (!state.mounted) {
      document.addEventListener("click", handleClick);
      document.addEventListener("change", handleChange);
      document.addEventListener("submit", handleSubmit);
      document.addEventListener("keydown", handleKeydown);
      state.mounted = true;
    }
    applyLanguage();
    syncIdentity();
    render();
  }

  function applyLanguage() {
    const shell = root();
    if (!shell) return;
    shell.dir = state.language === "ar" ? "rtl" : "ltr";
    shell.lang = state.language;
    const languageSelect = shell.querySelector("#ibp-language-select");
    if (languageSelect) {
      languageSelect.value = state.language;
      languageSelect.setAttribute("aria-label", t("language"));
    }
    const languageLabel = shell.querySelector("[data-ibp-lang-label]");
    if (languageLabel) languageLabel.textContent = t("language");
    shell.querySelectorAll("[data-ibp-i18n]").forEach((element) => {
      const key = element.getAttribute("data-ibp-i18n");
      if (key) element.textContent = t(key);
    });

    const navLabels = {
      openIBPHome: "home",
      "openIBPModule('tactical-map-view')": "map",
      "openIBPModule('chief-panel')": "network",
      "openIBPModule('agents-directory')": "personnel",
      "openIBPModule('operations')": "operations",
      "openIBPModule('cases-vault')": "archive",
      "openIBPModule('audit-panel')": "audit"
    };
    shell.querySelectorAll(".ibp-rail .ibp-link").forEach((button) => {
      const key = navLabels[button.getAttribute("onclick")];
      if (!key) return;
      const icon = button.querySelector("i");
      button.replaceChildren();
      if (icon) button.append(icon);
      button.append(document.createTextNode(` ${t(key)}`));
    });

    const title = shell.querySelector(".ibp-title");
    if (title) title.textContent = t("title");
    const caption = shell.querySelector(".ibp-caption");
    if (caption) caption.textContent = t("caption");
    const access = shell.querySelector("#ibp-access-chip");
    if (access) {
      const rank = current() && typeof normalizeRank === "function" ? normalizeRank(current().rank) : "OPERATOR";
      access.textContent = `${t("access")} // ${rank}`;
    }
    const railLabel = shell.querySelector(".ibp-rail-label");
    if (railLabel) railLabel.textContent = state.language === "ar" ? "قنوات القيادة" : "COMMAND CHANNELS";
    const statSub = shell.querySelectorAll(".ibp-stat-sub");
    if (statSub[0]) statSub[0].textContent = t("personnelScope");
    if (statSub[1]) statSub[1].textContent = t("operationsScope");
    if (statSub[2]) statSub[2].textContent = t("serviceScope");
    const mapOpen = shell.querySelector(".ibp-map-open");
    if (mapOpen) mapOpen.textContent = t("mapOpen");
    const note = shell.querySelector("#ibp-feed-note");
    if (note) note.textContent = t("feedNote");
    const moduleSub = shell.querySelector(".ibp-modules-head .ibp-panel-meta");
    if (moduleSub) moduleSub.textContent = t("modulesSub");
    const descriptions = shell.querySelectorAll(".ibp-card-desc");
    descriptions.forEach((el, index) => {
      const description = locale().cardDescriptions[index];
      if (description) el.textContent = description;
    });
    const footerScope = shell.querySelector("#ibp-data-scope");
    if (footerScope) footerScope.textContent = t("scopeFooter");
    const mapNote = shell.querySelector(".ibp-map-data-note");
    if (mapNote) mapNote.textContent = t("notLiveTracking");
    const liveLabel = shell.querySelector("#ibp-live-state");
    if (liveLabel && !connected()) liveLabel.textContent = state.language === "ar" ? "الشبكة في وضع الاستعداد" : "NETWORK STANDBY";
    const modal = shell.querySelector("#ibp-editor-modal");
    if (modal) modal.setAttribute("aria-label", t("createBattalion"));
  }

  function syncIdentity() {
    const user = current();
    const id = user ? String(user.id || user.publicCode || user.code || "") : "";
    if (id !== state.identity) {
      state.identity = id;
      state.battalions = [];
      state.assignablePersonnel = [];
      state.canManage = false;
      state.selectedId = "";
      state.loading = false;
      state.error = "";
      state.lastBattalionRequest = 0;
      state.lastOperationsRequest = 0;
      state.operations = [];
      state.operationsError = "";
      state.languageTouched = false;
    }
    if (!state.languageTouched && user && (user.ibpLanguage === "ar" || user.ibpLanguage === "en")) {
      state.language = user.ibpLanguage;
    }
    if (!user && !state.languageTouched) state.language = "ar";
  }

  function requestBattalions(force) {
    const shell = root();
    if (!shell || !document.body.classList.contains("ibp-mode") || !isAuthenticated()) return;
    const s = socket();
    if (!s || !s.connected || state.loading) return;
    if (!force && Date.now() - state.lastBattalionRequest < 15000) return;
    state.lastBattalionRequest = Date.now();
    state.loading = true;
    state.error = "";
    render();
    s.emit("ibp:battalions:list", {}, (result) => {
      state.loading = false;
      if (!result || !result.ok) {
        state.error = result && result.message || t("loadError");
        render();
        return;
      }
      state.battalions = Array.isArray(result.battalions) ? result.battalions : [];
      state.assignablePersonnel = Array.isArray(result.assignablePersonnel) ? result.assignablePersonnel : [];
      state.canManage = result.canManage === true;
      if (!state.battalions.some((unit) => String(unit.id) === state.selectedId)) {
        state.selectedId = state.battalions[0] ? String(state.battalions[0].id) : "";
      }
      render();
    });
  }

  function requestOperations(force) {
    if (!document.body.classList.contains("ibp-mode") || !canSeeOperations() || !isAuthenticated()) return;
    const s = socket();
    if (!s || !s.connected || state.operationsLoading) return;
    if (!force && Date.now() - state.lastOperationsRequest < 15000) return;
    state.lastOperationsRequest = Date.now();
    state.operationsLoading = true;
    s.emit("operation:list", {}, (result) => {
      state.operationsLoading = false;
      if (!result || !result.ok) {
        state.operationsError = result && result.message || "";
        renderFeed();
        return;
      }
      state.operations = Array.isArray(result.operations) ? result.operations.slice(0, 12) : [];
      state.operationsError = "";
      render();
    });
  }

  function selectedUnit() {
    return state.battalions.find((unit) => String(unit.id) === state.selectedId) || null;
  }

  function visibleUnits() {
    if (state.filter === "ALL") return state.battalions;
    return state.battalions.filter((unit) => String(unit.status || "ACTIVE").toUpperCase() === state.filter);
  }

  function renderFilters() {
    const shell = root();
    if (!shell) return;
    const filter = shell.querySelector("#ibp-battalion-filter");
    const selected = shell.querySelector("#ibp-battalion-select");
    if (filter) {
      filter.innerHTML = [
        ["ALL", t("allUnits")],
        ["ACTIVE", t("filterActive")],
        ["ALERT", t("filterAlert")],
        ["STANDBY", t("filterStandby")],
        ["ARCHIVED", t("filterArchived")]
      ].map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join("");
      filter.value = state.filter;
    }
    if (selected) {
      selected.innerHTML = state.battalions.length
        ? state.battalions.map((unit) => `<option value="${esc(unit.id)}">${esc(state.language === "ar" ? unit.nameAr || unit.nameEn : unit.nameEn || unit.nameAr)} · ${esc(statusLabel(unit.status))}</option>`).join("")
        : `<option value="">${esc(t("noUnits"))}</option>`;
      selected.value = state.selectedId;
      selected.disabled = !state.battalions.length;
    }
  }

  function renderKpis() {
    const shell = root();
    if (!shell) return;
    const activeUnits = state.battalions.filter((unit) => String(unit.status || "ACTIVE").toUpperCase() !== "ARCHIVED").length;
    const people = new Map();
    state.battalions.forEach((unit) => {
      (Array.isArray(unit.members) ? unit.members : []).forEach((member) => {
        const code = String(member.publicCode || "").toUpperCase();
        if (code) people.set(code, member);
      });
    });
    const online = [...people.values()].filter((person) => person.online).length;
    const visibleOperations = canSeeOperations() ? state.operations.length : null;
    const set = (id, value) => {
      const element = shell.querySelector(`#${id}`);
      if (element) element.textContent = value == null ? "—" : String(value).padStart(2, "0");
    };
    set("ibp-kpi-units", activeUnits);
    set("ibp-kpi-people", people.size);
    set("ibp-kpi-online", online);
    set("ibp-kpi-operations", visibleOperations);
  }

  function renderCards() {
    const shell = root();
    if (!shell) return;
    const grid = shell.querySelector("#ibp-battalion-grid");
    const count = shell.querySelector("#ibp-network-count");
    const create = shell.querySelector("#ibp-create-battalion");
    if (create) {
      create.hidden = !state.canManage;
      create.textContent = t("createUnit");
    }
    const operationsButton = shell.querySelector("[data-ibp-ops-action]");
    if (operationsButton) operationsButton.hidden = !canSeeOperations();
    if (count) count.textContent = `${state.battalions.length} ${t("visibleUnits")}`;
    if (!grid) return;

    if (state.loading && !state.battalions.length) {
      grid.innerHTML = `<div class="ibp-empty-state"><i class="fa-solid fa-circle-notch fa-spin"></i>${esc(t("loading"))}</div>`;
      return;
    }
    if (state.error && !state.battalions.length) {
      grid.innerHTML = `<div class="ibp-empty-state"><i class="fa-solid fa-triangle-exclamation"></i>${esc(state.error)} <button class="ibp-console-button secondary" type="button" data-ibp-refresh>${esc(state.language === "ar" ? "إعادة المحاولة" : "Retry")}</button></div>`;
      return;
    }
    if (!state.battalions.length) {
      const message = state.canManage ? t("noUnitsManager") : t("noUnitsMember");
      grid.innerHTML = `<div class="ibp-empty-state"><i class="fa-solid fa-diagram-project"></i><strong>${esc(t("noUnits"))}</strong><br>${esc(message)}</div>`;
      return;
    }
    const units = visibleUnits();
    if (!units.length) {
      grid.innerHTML = `<div class="ibp-empty-state">${esc(state.language === "ar" ? "لا توجد كتائب بهذه الحالة." : "No battalions match this status filter.")}</div>`;
      return;
    }
    grid.innerHTML = units.map((unit) => {
      const color = safeColor(unit.color);
      const selected = String(unit.id) === state.selectedId;
      const members = Array.isArray(unit.members) ? unit.members : [];
      const unitName = state.language === "ar" ? unit.nameAr || unit.nameEn : unit.nameEn || unit.nameAr;
      const sector = unit.sector || (state.language === "ar" ? "القطاع غير محدد" : "Sector not set");
      return `<button class="ibp-battalion-card${selected ? " selected" : ""}" type="button" data-unit-id="${esc(unit.id)}" style="--unit-color:${color}" aria-pressed="${selected}">
        <span class="ibp-unit-symbol">${esc(unit.symbol || "UNIT")}</span>
        <span class="ibp-battalion-card-copy"><strong>${esc(unitName || "—")}</strong><small>${esc(sector)} · ${members.length} ${esc(t("members"))}</small></span>
        <span class="ibp-status-pill status-${esc(String(unit.status || "ACTIVE").toLowerCase())}">${esc(statusLabel(unit.status))}</span>
      </button>`;
    }).join("");
  }

  function renderDetail() {
    const shell = root();
    if (!shell) return;
    const detail = shell.querySelector("#ibp-battalion-detail");
    const tree = shell.querySelector("#ibp-command-tree");
    const treeUnit = shell.querySelector("#ibp-tree-unit");
    const detailStatus = shell.querySelector("#ibp-detail-status");
    const unit = selectedUnit();
    if (!unit) {
      if (detail) detail.innerHTML = `<div class="ibp-empty-state"><i class="fa-regular fa-folder-open"></i>${esc(t("chooseUnit"))}</div>`;
      if (tree) tree.innerHTML = `<div class="ibp-empty-state">${esc(t("chooseUnit"))}</div>`;
      if (treeUnit) treeUnit.textContent = "";
      if (detailStatus) detailStatus.textContent = "";
      return;
    }
    const name = state.language === "ar" ? unit.nameAr || unit.nameEn : unit.nameEn || unit.nameAr;
    const color = safeColor(unit.color);
    const members = Array.isArray(unit.members) ? unit.members : [];
    const commander = members.find((person) => String(person.publicCode || "").toUpperCase() === String(unit.commanderCode || "").toUpperCase());
    if (detailStatus) detailStatus.textContent = statusLabel(unit.status);
    if (detail) {
      const commanderLabel = commander
        ? commander.name || `#${commander.publicCode}`
        : unit.commanderName || (unit.commanderCode ? `#${unit.commanderCode}` : t("noCommanderData"));
      const people = members.length
        ? members.map((person) => {
          const displayName = person.name || `#${person.publicCode || ""}`;
          const presence = person.activeService ? t("onDuty") : person.online ? t("online") : t("offline");
          return `<div class="ibp-person-row">
            <div class="ibp-person-identity"><strong>${esc(displayName)}</strong><small>${esc(person.rankLabel || person.rank || "")} · #${esc(person.publicCode || "")}</small></div>
            <span class="ibp-person-presence${person.online ? "" : " offline"}">${esc(presence)}</span>
          </div>`;
        }).join("")
        : `<div class="ibp-empty-state">${esc(t("noPersonnel"))}</div>`;
      detail.innerHTML = `
        <div class="ibp-detail-top">
          <div class="ibp-detail-identity">
            <span class="ibp-unit-symbol" style="--unit-color:${color}">${esc(unit.symbol || "UNIT")}</span>
            <div><h3>${esc(name || "—")}</h3><p>${esc(unit.sector || "—")} · ${esc(t("memberCount"))}: ${members.length}</p></div>
          </div>
          ${state.canManage ? `<button class="ibp-console-button secondary" type="button" data-ibp-edit="${esc(unit.id)}">${esc(t("edit"))}</button>` : ""}
        </div>
        <div class="ibp-detail-stats">
          <div class="ibp-detail-stat"><span>${esc(t("commander"))}</span><strong>${esc(commanderLabel)}</strong></div>
          <div class="ibp-detail-stat"><span>${esc(t("sector"))}</span><strong>${esc(unit.sector || "—")}</strong></div>
          <div class="ibp-detail-stat"><span>${esc(t("status"))}</span><strong>${esc(statusLabel(unit.status))}</strong></div>
        </div>
        <div class="ibp-personnel-list">${people}</div>`;
    }
    if (treeUnit) treeUnit.textContent = name || "";
    if (tree) {
      const commanderLabel = commander
        ? commander.name || `#${commander.publicCode}`
        : unit.commanderName || (unit.commanderCode ? `#${unit.commanderCode}` : t("noCommanderData"));
      const nodes = members
        .filter((person) => String(person.publicCode || "").toUpperCase() !== String(unit.commanderCode || "").toUpperCase())
        .map((person) => `<div class="ibp-tree-node">${esc(person.name || `#${person.publicCode || ""}`)}<small>${esc(person.rankLabel || person.rank || "")} · #${esc(person.publicCode || "")}</small></div>`)
        .join("");
      tree.innerHTML = `<div class="ibp-tree-root"><i class="fa-solid fa-shield-halved"></i><div><strong>${esc(commanderLabel)}</strong><small>${esc(t("commander"))} · ${esc(unit.symbol || "UNIT")}</small></div></div>${nodes ? `<div class="ibp-tree-branch">${nodes}</div>` : `<div class="ibp-empty-state">${esc(t("noPersonnel"))}</div>`}`;
    }
  }

  function operationStatus(operation) {
    const status = String(operation && operation.status || "").toUpperCase();
    const map = {
      PLANNED: state.language === "ar" ? "مخططة" : "Planned",
      IN_PROGRESS: state.language === "ar" ? "قيد التنفيذ" : "In progress",
      COMPLETED: state.language === "ar" ? "مكتملة" : "Completed",
      FAILED: state.language === "ar" ? "فشلت" : "Failed",
      CANCELLED: state.language === "ar" ? "ملغاة" : "Cancelled"
    };
    return map[status] || operation && operation.status || t("operationUnknown");
  }

  function renderFeed() {
    const shell = root();
    if (!shell) return;
    const feed = shell.querySelector("#ibp-live-feed");
    const feedState = shell.querySelector("#ibp-feed-state");
    if (!feed) return;
    if (!canSeeOperations()) {
      if (feedState) feedState.textContent = t("notAuthorized");
      feed.innerHTML = `<div class="ibp-empty-state"><i class="fa-solid fa-lock"></i>${esc(t("restrictedOperations"))}</div>`;
      return;
    }
    if (state.operationsLoading && !state.operations.length) {
      if (feedState) feedState.textContent = t("loading");
      feed.innerHTML = `<div class="ibp-empty-state"><i class="fa-solid fa-circle-notch fa-spin"></i>${esc(t("loading"))}</div>`;
      return;
    }
    if (state.operationsError && !state.operations.length) {
      if (feedState) feedState.textContent = state.language === "ar" ? "تعذر التحديث" : "Update failed";
      feed.innerHTML = `<div class="ibp-empty-state">${esc(state.operationsError)} <button class="ibp-console-button secondary" type="button" data-ibp-refresh-operations>${esc(state.language === "ar" ? "إعادة المحاولة" : "Retry")}</button></div>`;
      return;
    }
    if (!state.operations.length) {
      if (feedState) feedState.textContent = t("statusOperation");
      feed.innerHTML = `<div class="ibp-empty-state"><i class="fa-solid fa-wave-square"></i>${esc(t("noVisibleOperations"))}</div>`;
      return;
    }
    if (feedState) feedState.textContent = `${state.operations.length} ${state.language === "ar" ? "عملية" : "items"}`;
    feed.innerHTML = state.operations.slice(0, 6).map((operation) => {
      const title = operation.title || operation.name || operation.type || "—";
      const type = operation.type || (state.language === "ar" ? "عملية" : "Operation");
      const commander = operation.commanderCode ? `#${operation.commanderCode}` : "";
      return `<div class="ibp-feed-item"><div class="ibp-feed-item-copy"><strong>${esc(title)}</strong><small>${esc(type)}${commander ? ` · ${esc(commander)}` : ""}</small></div><span class="ibp-status-pill">${esc(operationStatus(operation))}</span></div>`;
    }).join("");
  }

  function render() {
    const shell = root();
    if (!shell) return;
    applyLanguage();
    renderFilters();
    renderKpis();
    renderCards();
    renderDetail();
    renderFeed();
  }

  function openEditor(id) {
    if (!state.canManage) return;
    const shell = root();
    const modal = shell && shell.querySelector("#ibp-editor-modal");
    const form = shell && shell.querySelector("#ibp-editor-form");
    if (!modal || !form) return;
    const unit = id ? state.battalions.find((item) => String(item.id) === String(id)) : null;
    form.reset();
    shell.querySelector("#ibp-editor-id").value = unit ? unit.id : "";
    shell.querySelector("#ibp-editor-name-ar").value = unit && unit.nameAr || "";
    shell.querySelector("#ibp-editor-name-en").value = unit && unit.nameEn || "";
    shell.querySelector("#ibp-editor-sector").value = unit && unit.sector || "";
    shell.querySelector("#ibp-editor-symbol").value = unit && unit.symbol || "";
    shell.querySelector("#ibp-editor-color").value = safeColor(unit && unit.color);
    shell.querySelector("#ibp-editor-title").textContent = unit ? t("editBattalion") : t("createBattalion");
    shell.querySelector("#ibp-editor-error").textContent = "";
    const statusSelect = shell.querySelector("#ibp-editor-status");
    statusSelect.innerHTML = [
      ["ACTIVE", t("statusActive")],
      ["ALERT", t("statusAlert")],
      ["STANDBY", t("statusStandby")],
      ["ARCHIVED", t("statusArchived")]
    ].map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join("");
    statusSelect.value = unit && unit.status || "ACTIVE";

    const selectedMembers = new Set(unit ? (unit.members || []).map((member) => String(member.publicCode).toUpperCase()) : []);
    const commanderSelect = shell.querySelector("#ibp-editor-commander");
    const candidates = state.assignablePersonnel.slice().sort((a, b) => String(a.publicCode).localeCompare(String(b.publicCode)));
    commanderSelect.innerHTML = `<option value="">${esc(t("noCommander"))}</option>` + candidates.map((person) => {
      const label = `${person.name ? `${person.name} · ` : ""}#${person.publicCode} · ${person.rankLabel || person.rank || ""}`;
      return `<option value="${esc(person.publicCode)}">${esc(label)}</option>`;
    }).join("");
    commanderSelect.value = unit && unit.commanderCode || "";
    const members = shell.querySelector("#ibp-editor-members");
    members.innerHTML = candidates.length ? candidates.map((person) => {
      const code = String(person.publicCode || "");
      const checked = selectedMembers.has(code.toUpperCase()) ? " checked" : "";
      const label = `${person.name ? `${person.name} · ` : ""}#${code} · ${person.rankLabel || person.rank || ""}`;
      return `<label class="ibp-editor-member"><input type="checkbox" name="ibp-member" value="${esc(code)}"${checked}><span>${esc(label)}</span></label>`;
    }).join("") : `<span>${esc(t("noAssignablePeople"))}</span>`;
    shell.querySelector("#ibp-editor-save").textContent = t("save");
    shell.querySelector("#ibp-editor-cancel").textContent = t("cancel");
    modal.hidden = false;
    shell.querySelector("#ibp-editor-name-ar").focus();
  }

  function closeEditor() {
    const modal = root() && root().querySelector("#ibp-editor-modal");
    if (modal) modal.hidden = true;
    state.saving = false;
  }

  function handleClick(event) {
    const shell = root();
    if (!shell) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const lang = target.closest("#ibp-language-select");
    if (lang) return;
    const unitCard = target.closest("[data-unit-id]");
    if (unitCard) {
      state.selectedId = unitCard.getAttribute("data-unit-id") || "";
      render();
      return;
    }
    const create = target.closest("#ibp-create-battalion");
    if (create) {
      openEditor("");
      return;
    }
    const edit = target.closest("[data-ibp-edit]");
    if (edit) {
      openEditor(edit.getAttribute("data-ibp-edit"));
      return;
    }
    if (target.closest("#ibp-editor-close, #ibp-editor-cancel")) {
      closeEditor();
      return;
    }
    if (target.closest("#ibp-editor-modal") && !target.closest(".ibp-editor-dialog")) {
      closeEditor();
      return;
    }
    const refresh = target.closest("[data-ibp-refresh]");
    if (refresh) {
      requestBattalions(true);
      return;
    }
    const refreshOperations = target.closest("[data-ibp-refresh-operations]");
    if (refreshOperations) {
      requestOperations(true);
      return;
    }
    const openModule = target.closest("[data-ibp-open]");
    if (openModule) {
      if (typeof openIBPModule === "function") openIBPModule(openModule.getAttribute("data-ibp-open"));
    }
  }

  function handleChange(event) {
    const shell = root();
    if (!shell) return;
    const target = event.target;
    if (target && target.id === "ibp-language-select") {
      setLanguage(target.value);
      return;
    }
    if (target && target.id === "ibp-battalion-select") {
      state.selectedId = target.value;
      render();
      return;
    }
    if (target && target.id === "ibp-battalion-filter") {
      state.filter = target.value;
      render();
    }
  }

  function setLanguage(language) {
    if (language !== "ar" && language !== "en") return;
    const previous = state.language;
    state.language = language;
    state.languageTouched = true;
    const user = current();
    if (user) user.ibpLanguage = language;
    render();
    const s = socket();
    if (s && s.connected && isAuthenticated()) {
      s.emit("ibp:user-language:set", { language }, (result) => {
        if (!result || !result.ok) {
          state.language = previous;
          state.languageTouched = false;
          if (user) user.ibpLanguage = previous;
          render();
          showToast(result && result.message || t("saveError"), true);
        }
      });
    } else if (user) {
      state.language = previous;
      state.languageTouched = false;
      user.ibpLanguage = previous;
      render();
      showToast(state.language === "ar" ? "تعذر الاتصال لحفظ اللغة." : "Language could not be saved while offline.", true);
    }
  }

  function showToast(message, isError) {
    const shell = root();
    if (!shell) return;
    let toast = shell.querySelector("#ibp-workspace-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "ibp-workspace-toast";
      toast.setAttribute("role", "status");
      toast.style.cssText = "position:fixed;z-index:10060;inset-inline-end:18px;bottom:18px;max-width:min(420px,calc(100vw - 36px));padding:11px 14px;border:1px solid rgba(193,162,90,.4);border-radius:4px;background:#101820;color:#e9e5da;font-size:11px;box-shadow:0 12px 32px rgba(0,0,0,.4);";
      document.body.append(toast);
    }
    toast.style.borderColor = isError ? "rgba(194,92,85,.7)" : "rgba(193,162,90,.4)";
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 3200);
  }

  function handleSubmit(event) {
    if (event.target && event.target.id === "ibp-editor-form") {
      event.preventDefault();
      saveBattalion();
    }
  }

  function handleKeydown(event) {
    if (event.key === "Escape") closeEditor();
  }

  function saveBattalion() {
    const shell = root();
    const s = socket();
    if (!shell || !s || !s.connected || !state.canManage || state.saving) {
      showToast(t("saveError"), true);
      return;
    }
    const nameAr = shell.querySelector("#ibp-editor-name-ar").value.trim();
    const nameEn = shell.querySelector("#ibp-editor-name-en").value.trim();
    if (!nameAr && !nameEn) {
      shell.querySelector("#ibp-editor-error").textContent = t("requiredName");
      shell.querySelector("#ibp-editor-name-ar").focus();
      return;
    }
    const status = shell.querySelector("#ibp-editor-status").value;
    if (status === "ARCHIVED" && shell.querySelector("#ibp-editor-id").value && !window.confirm(t("archiveConfirm"))) return;
    const memberCodes = [...shell.querySelectorAll('input[name="ibp-member"]:checked')].map((input) => input.value);
    const payload = {
      id: shell.querySelector("#ibp-editor-id").value || undefined,
      nameAr,
      nameEn,
      sector: shell.querySelector("#ibp-editor-sector").value.trim(),
      symbol: shell.querySelector("#ibp-editor-symbol").value.trim(),
      status,
      color: safeColor(shell.querySelector("#ibp-editor-color").value),
      commanderCode: shell.querySelector("#ibp-editor-commander").value,
      memberCodes
    };
    state.saving = true;
    const saveButton = shell.querySelector("#ibp-editor-save");
    saveButton.disabled = true;
    saveButton.textContent = state.language === "ar" ? "جارٍ الحفظ…" : "Saving…";
    shell.querySelector("#ibp-editor-error").textContent = "";
    s.emit("ibp:battalion:save", payload, (result) => {
      state.saving = false;
      saveButton.disabled = false;
      saveButton.textContent = t("save");
      if (!result || !result.ok || !result.battalion) {
        const raw = result && result.message || t("saveError");
        shell.querySelector("#ibp-editor-error").textContent = locale().errors[raw] || raw;
        return;
      }
      const saved = result.battalion;
      const existingIndex = state.battalions.findIndex((unit) => String(unit.id) === String(saved.id));
      if (existingIndex >= 0) state.battalions.splice(existingIndex, 1, saved);
      else state.battalions.unshift(saved);
      state.selectedId = String(saved.id);
      state.lastBattalionRequest = Date.now();
      closeEditor();
      render();
      showToast(t("saved"), false);
    });
  }

  function hookRenderer() {
    const base = window.renderIBPWorkspace;
    if (typeof base !== "function" || base.__ibpNetworkWrapped) return;
    const wrapped = function () {
      const result = base.apply(this, arguments);
      mount();
      const shouldLoad = document.body.classList.contains("ibp-mode");
      if (shouldLoad) {
        requestBattalions(false);
        requestOperations(false);
      }
      return result;
    };
    wrapped.__ibpNetworkWrapped = true;
    window.renderIBPWorkspace = wrapped;
  }

  function attachSocketListeners() {
    const s = socket();
    if (!s || s.__ibpNetworkListeners) return;
    s.__ibpNetworkListeners = true;
    s.on("ibp:battalions:update", (payload) => {
      if (!payload || !Array.isArray(payload.battalions)) return;
      state.battalions = payload.battalions;
      if (!state.battalions.some((unit) => String(unit.id) === state.selectedId)) {
        state.selectedId = state.battalions[0] ? String(state.battalions[0].id) : "";
      }
      render();
    });
    s.on("connect", () => {
      state.lastBattalionRequest = 0;
      state.lastOperationsRequest = 0;
      if (document.body.classList.contains("ibp-mode")) {
        requestBattalions(true);
        requestOperations(true);
      }
    });
  }

  function boot() {
    hookRenderer();
    attachSocketListeners();
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();