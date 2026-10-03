(function () {
  "use strict";

  const arToEn = {
    "← رجوع إلى مركز IBP": "← Back to IBP Command Center",
    "الخروج إلى BLACK RIDGE": "Exit to BLACK RIDGE",
    "خريطة لوس سانتوس التفاعلية (Los Santos GTA V)": "Interactive Los Santos Map (GTA V)",
    "اضغط زر «تحديد موقعي» ثم اختر نقطة واحدة على الخريطة؛ استخدم زر الإزالة لمسح موقعك. حركة الخريطة محدودة لتجنب الانزلاق والتكبير العرضي.": "Choose “Set my location,” then select one point on the map. Use Remove to clear your saved location. Map movement is limited to prevent accidental panning and zooming.",
    "إزالة موقعي من الخريطة": "Remove my map location",
    "تحديد موقعي بالضغط على الخريطة": "Set my location by clicking the map",
    "جارٍ تجهيز الخريطة التفاعلية...": "Loading the interactive map…",
    "إدارة مواقع الأعضاء — CIA CHIEF وSenior وHigh Commander": "Manage member locations — CIA CHIEF, Senior, and High Commander",
    "إزالة الموقع المحدد": "Remove selected location",
    "خريطة لوس سانتوس التفاعلية — نفس خلفية خريطة الاستغاثة.": "Interactive Los Santos map — uses the same background as the emergency map.",
    "اختر العضو لإزالة موقعه": "Select a member to remove their location",
    "خريطة لوس سانتوس التفاعلية": "Interactive Los Santos map",
    "أرشيف القضايا والأدلة (Cases Vault)": "Cases and Evidence Archive",
    "توثيق قضية جديدة / دليل ميداني": "Document a new case / field evidence",
    "حفظ القضية بالأرشيف": "Save case to archive",
    "القضايا الموثقة بالأرشيف": "Archived cases",
    "عنوان القضية / الملاحقة": "Case / investigation title",
    "رقم المركبة المدنية / أرقام السناد المشاركين": "Civilian vehicle number / supporting personnel codes",
    "تفاصيل القضية والأحداث والأدلة...": "Case details, events, and evidence…",
    "رابط صورة / مقطع فيديو للدليل (اختياري)": "Evidence image or video link (optional)",
    "بلاغات الطوارئ S.O.S": "Emergency SOS alerts",
    "جميع البلاغات المحفوظة تظهر لكل العناصر. الحذف متاح فقط لـ CIA CHIEF و Senior Commander CIA.": "Saved alerts are visible to all personnel. Only CIA CHIEF and Senior Commander CIA can delete them.",
    "عرض البلاغات على خريطة الاستغاثة": "View alerts on the SOS map",
    "سجل التقارير والعمليات الميدانية": "Field reports and operations log",
    "إضافة تقرير جديد": "Add a new report",
    "📷 رفع صورة من الجهاز": "📷 Upload an image from this device",
    "🔒 تقرير سري للغاية (يظهر فقط للقائد CIA CHIEF)": "🔒 Top secret report (visible only to CIA CHIEF)",
    "رفع التقرير للقيادة": "Submit report to command",
    "التقارير المسجلة": "Submitted reports",
    "عنوان التقرير / موضوع العملية": "Report title / operation subject",
    "تفاصيل التقرير الاستخباراتي الميداني...": "Field intelligence report details…",
    "رابط صورة الدليل / التقرير (اختياري)": "Evidence or report image link (optional)",
    "دليل العملاء وحالة الحضور الميدانية": "Personnel directory and field attendance",
    "الكود الظاهر": "Public code",
    "الاسم (حسب الصلاحية)": "Name (subject to access level)",
    "الرتبة": "Rank",
    "حالة الخدمة": "Service status",
    "المهمات الميدانية — Tactical Operations": "Field Operations",
    "إنشاء مهمة ميدانية": "Create field operation",
    "مراقبة": "Surveillance",
    "مداهمة": "Raid",
    "حماية شخصية": "Close protection",
    "جمع أدلة": "Evidence collection",
    "منخفض": "Low",
    "متوسط": "Medium",
    "مرتفع": "High",
    "حرج": "Critical",
    "أفراد القطاع — جميع الرتب": "Sector personnel — all ranks",
    "تحديث الأفراد": "Refresh personnel",
    "اضغط تحديث الأفراد لتحميل القائمة": "Select Refresh personnel to load the list",
    "اختر عدة أفراد من القائمة؛ يظهر الاسم الحقيقي والكود والرتبة للقيادة.": "Select one or more people. Real names, codes, and ranks are shown to authorized command roles.",
    "من خريطة المهمة": "From operation map",
    "إنشاء مهمة لمرة واحدة": "Create one-time operation",
    "المهمات المسندة / المسجلة": "Assigned / recorded operations",
    "خريطة المهمة": "Operation map",
    "لون الرسم والعلامات": "Drawing and marker color",
    "علامة عامة": "General marker",
    "مجرمون": "Suspects",
    "عدد الأشخاص": "Number of people",
    "خط حر — اسحب": "Freehand — drag",
    "دائرة — اسحب": "Circle — drag",
    "منطقة مستطيلة — اسحب": "Rectangle — drag",
    "حفظ الرسم الحالي": "Save current drawing",
    "إغلاق الخريطة": "Close map",
    "اضغط على خريطة المهمة لتحديد الموقع؛ سيظهر دبوس المعاينة قبل اعتماد النقطة.": "Click the operation map to choose a location. A preview pin appears before you confirm it.",
    "اختر نقطة على الخريطة.": "Select a point on the map.",
    "اعتماد الموقع": "Confirm location",
    "إلغاء": "Cancel",
    "اسم المهمة": "Operation name",
    "الهدف والتعليمات الميدانية": "Objective and field instructions",
    "كودك العسكري كمنشئ المهمة": "Your service code as operation creator",
    "ابحث بالكود العسكري أو الرتبة": "Search by service code or rank",
    "بداية العملية: x,y (اختياري)": "Operation start: x,y (optional)",
    "نهاية العملية: x,y (اختياري)": "Operation end: x,y (optional)",
    "ملاحظات القيادة": "Command notes",
    "اختر لون الرسم": "Choose drawing color",
    "خريطة المهمة لاختيار نقطة البداية أو النهاية": "Operation map for choosing a start or end point",
    "هوية دخول القيادة": "Command sign-in credentials",
    "كود الدخول الشخصي الحالي:": "Current personal sign-in code:",
    "رمز الحفظ الرسمي للتأسيس فقط:": "Official setup code (initial setup only):",
    "تغيير كود دخولي": "Change my sign-in code",
    "تغيير كودي العسكري": "Change my service code",
    "تعديل بياناتي الإضافية": "Edit my additional details",
    "رمز الحفظ الرسمي مخصص للتأسيس فقط ولا يظهر في الدخول اليومي. كود الدخول هو الكود الشخصي الذي اختاره القائد ويمكن تغييره من هنا.": "The official setup code is for initial setup only and is not used for daily sign-in. The personal sign-in code can be changed here.",
    "المرحلة الأولى: قبول الشخصية": "Stage 1: Character approval",
    "الاسم المطلوب": "Requested name",
    "كود طلب القبول": "Admission request code",
    "الإجراء": "Action",
    "طلبات اعتماد الهوية": "Identity approval requests",
    "الشخصية": "Character",
    "الهوية المقدمة": "Submitted identity",
    "المرحلة الثالثة: طلب دخول الخدمة وإصدار الكود العسكري": "Stage 3: Service access request and service code",
    "لا يظهر الطلب هنا إلا بعد اعتماد الشخصية والهوية. موافقة CIA CHIEF تفتح الخدمة وتصدر الكود العسكري.": "Requests appear here after character and identity approval. CIA CHIEF approval enables service access and issues a service code.",
    "الهوية": "Identity",
    "طلبات شخصيات الأعضاء": "Member character requests",
    "صاحب الحساب": "Account holder",
    "الشخصية المطلوبة": "Requested character",
    "إدارة الأعضاء": "Personnel management",
    "الكود": "Code",
    "الاسم": "Name",
    "الحضور": "Attendance",
    "سلم الرتب المعتمد": "Approved rank ladder",
    "القائد يستطيع ترقية وتنزيل الرتبة وفصل العضو. Senior Commander CIA يملك صلاحيات قيادية محدودة تشمل إدارة الرتب والفصل والوصول إلى الهويات السرية، دون صلاحيات القائد الحساسة.": "The chief can promote, demote, or dismiss members. Senior Commander CIA has limited command permissions, including rank management, dismissal, and access to classified identities, but not the chief’s sensitive controls.",
    "الهويات العامة — إدارة القيادة": "Public identities — command management",
    "الهويات الخاصة للقيادات": "Classified identities for command",
    "السجل القيادي يعرض الأكواد فقط للقيادات العليا. أسماء الأشخاص لا تظهر هنا. تفاصيل الهوية الخاصة الكاملة متاحة لـ CIA CHIEF و Senior Commander CIA فقط.": "The command roster shows codes only to senior leadership. Names are not shown here. Full classified identity details are available only to CIA CHIEF and Senior Commander CIA.",
    "السجلات اليومية": "Daily activity logs",
    "سجل قيادي سري يوضح الدخول والخروج والترقيات والتنزيلات والفصل واعتماد الأعضاء. يظهر فقط لـ CIA CHIEF و Senior Commander CIA.": "A classified command log of sign-ins, sign-outs, promotions, demotions, dismissals, and member approvals. Visible only to CIA CHIEF and Senior Commander CIA.",
    "سجل المباشرة اليومية": "Daily duty records",
    "لا توجد سجلات يومية حتى الآن.": "There are no daily records yet.",
    "لا توجد سجلات مباشرة بعد.": "There are no duty records yet.",
    "مباشرة": "Duty started",
    "غير محدد": "Not specified",
    "مباشر الآن": "Active now",
    "تم الصرف": "Paid",
    "مؤهل / لم يُصرف": "Eligible / unpaid",
    "قيد التنفيذ": "In progress",
    "مخططة": "Planned",
    "تمت": "Completed",
    "مكتملة": "Completed",
    "فشلت": "Failed",
    "ملغاة": "Cancelled",
    "إنشاء المهمات متاح للرتب العليا الثلاث فقط.": "Creating operations is limited to the three highest ranks.",
    "أكمل اسم المهمة والهدف واختر فردًا واحدًا على الأقل.": "Enter an operation name and objective, and select at least one person.",
    "تم إنشاء المهمة بنجاح.": "Operation created successfully.",
    "تعذر تحميل المهمات.": "Could not load operations.",
    "الاتصال بالسيرفر غير متاح.": "The server connection is unavailable.",
    "يجب تسجيل الدخول إلى حسابك أولاً.": "Sign in to your account first.",
    "يجب تسجيل الدخول إلى الخدمة أولاً.": "Sign in to the service first.",
    "هذه المحطة غير متاحة حالياً.": "This module is not available right now.",
    "أكمل الموافقات الثلاث من لوحة الحالة قبل دخول أقسام الخدمة.": "Complete the three approvals on the status panel before entering service sections.",
    "اعتماد الهوية من القيادة مطلوب قبل استخدام مورس.": "Command identity approval is required before using Morse.",
    "سجّل الدخول للخدمة أولاً لاستخدام شفرة مورس.": "Sign in to service before using Morse.",
    "الخريطة جاهزة — فعّل زر تحديد الموقع ثم اختر نقطة. للقيادات، اختر عضواً لإزالة موقعه.": "Map ready — enable location selection and choose a point. Command roles can select a member to remove their location.",
    "تعذر تحميل أداة الخريطة؛ أعد تحميل الصفحة ثم حاول مرة أخرى.": "The map library could not be loaded. Reload the page and try again.",
    "تعذر تحميل صورة الخريطة؛ تحقق من اتصال الإنترنت ثم أعد فتح الصفحة.": "The map image could not be loaded. Check the internet connection and reopen the page.",
    "أدخل اسماً عربياً أو إنجليزياً للكتيبة.": "Enter a battalion name in Arabic or English.",
    "أحد الأفراد محدد بالفعل ضمن كتيبة أخرى نشطة.": "A selected person is already assigned to another active battalion.",
    "يجب أن يكون قائد الكتيبة من الرتب القيادية.": "Choose a commander with a leadership rank.",
    "رمز قائد الكتيبة غير صالح.": "The commander code is not valid.",
    "تعذر التحقق من أحد أكواد الأفراد المختارين.": "One of the selected personnel codes could not be verified."
  };

  const enToAr = Object.create(null);
  Object.entries(arToEn).forEach(([ar, en]) => {
    if (!enToAr[en]) enToAr[en] = ar;
  });
  const textState = new WeakMap();
  const attributeState = new WeakMap();
  let observer = null;
  let scheduled = false;

  function language() {
    const select = document.getElementById("ibp-language-select");
    return select && select.value === "en" ? "en" : "ar";
  }

  function translate(value, lang) {
    const source = String(value == null ? "" : value);
    const trimmed = source.trim();
    const leading = source.match(/^\s*/)[0];
    const trailing = source.match(/\s*$/)[0];
    if (lang === "en") {
      if (Object.prototype.hasOwnProperty.call(arToEn, trimmed)) return leading + arToEn[trimmed] + trailing;
      return source;
    }
    if (Object.prototype.hasOwnProperty.call(enToAr, trimmed)) return leading + enToAr[trimmed] + trailing;
    return source;
  }

  function activePane() {
    if (!document.body.classList.contains("ibp-mode")) return null;
    const pane = document.querySelector(".view-pane.active");
    if (!pane || pane.id === "ibp-command-center") return null;
    return pane;
  }

  function localizeTextNode(node, lang) {
    if (!node || !node.parentElement || !activePane()?.contains(node.parentElement)) return;
    const parent = node.parentElement.closest("script,style,textarea,input,select,option,code,pre");
    if (parent) return;
    const current = node.nodeValue;
    const prior = textState.get(node);
    const source = prior && current === prior.last ? prior.source : current;
    const localized = translate(source, lang);
    textState.set(node, { source, last: localized });
    if (localized !== current) node.nodeValue = localized;
  }

  function localizeAttribute(element, attribute, lang) {
    const pane = activePane();
    if (!pane || !element || !pane.contains(element)) return;
    const current = element.getAttribute(attribute);
    if (!current) return;
    let records = attributeState.get(element);
    if (!records) {
      records = new Map();
      attributeState.set(element, records);
    }
    const prior = records.get(attribute);
    const source = prior && current === prior.last ? prior.source : current;
    const localized = translate(source, lang);
    records.set(attribute, { source, last: localized });
    if (localized !== current) element.setAttribute(attribute, localized);
  }

  function localizeSubtree(node, lang) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      localizeTextNode(node, lang);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const pane = activePane();
    if (!pane) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : null;
    if (element && !pane.contains(element) && element !== pane) return;
    if (element) {
      ["placeholder", "title", "aria-label", "alt"].forEach((attribute) => localizeAttribute(element, attribute, lang));
    }
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) localizeTextNode(textNode, lang);
    if (element) {
      element.querySelectorAll("[placeholder],[title],[aria-label],[alt]").forEach((child) => {
        ["placeholder", "title", "aria-label", "alt"].forEach((attribute) => localizeAttribute(child, attribute, lang));
      });
    }
  }

  function setDirectionAndTranslate() {
    const lang = language();
    const pane = activePane();
    if (pane) {
      pane.dir = lang === "ar" ? "rtl" : "ltr";
      pane.classList.toggle("ibp-module-english", lang === "en");
      localizeSubtree(pane, lang);
    }
    const bar = document.getElementById("ibp-return-bar");
    if (bar) {
      bar.dir = lang === "ar" ? "rtl" : "ltr";
      const buttons = bar.querySelectorAll("button");
      if (buttons[0]) buttons[0].textContent = lang === "ar" ? "← رجوع إلى مركز IBP" : "← Back to IBP Command Center";
      if (buttons[buttons.length - 1]) buttons[buttons.length - 1].textContent = lang === "ar" ? "الخروج إلى BLACK RIDGE" : "Exit to BLACK RIDGE";
      const label = bar.querySelector(".ibp-return-language-label");
      if (label) label.textContent = lang === "ar" ? "لغة الواجهة" : "Interface language";
      const select = bar.querySelector("#ibp-return-language-select");
      if (select) {
        select.value = lang;
        select.setAttribute("aria-label", lang === "ar" ? "لغة الواجهة" : "Interface language");
      }
    }
  }

  function scheduleLocalization() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      setDirectionAndTranslate();
    });
  }

  function setLanguage(value) {
    const lang = value === "en" ? "en" : "ar";
    const mainSelect = document.getElementById("ibp-language-select");
    if (mainSelect && mainSelect.value !== lang) {
      mainSelect.value = lang;
      mainSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    scheduleLocalization();
  }

  function ensureReturnLanguageControl() {
    const bar = document.getElementById("ibp-return-bar");
    if (!bar || bar.querySelector("#ibp-return-language-select")) return;
    const control = document.createElement("label");
    control.className = "ibp-return-language";
    control.innerHTML = `<span class="ibp-return-language-label"></span><select id="ibp-return-language-select"><option value="ar">العربية</option><option value="en">English</option></select>`;
    const anchor = bar.querySelector("span");
    bar.insertBefore(control, anchor || null);
    const select = control.querySelector("select");
    select.addEventListener("change", () => setLanguage(select.value));
    setDirectionAndTranslate();
  }

  function handleLanguageChange(event) {
    if (event.target && event.target.id === "ibp-language-select") scheduleLocalization();
  }

  function scanMutation(record) {
    if (!activePane()) return;
    if (record.type === "characterData") {
      localizeTextNode(record.target, language());
      return;
    }
    if (record.type === "attributes") {
      localizeAttribute(record.target, record.attributeName, language());
      return;
    }
    record.addedNodes.forEach((node) => localizeSubtree(node, language()));
  }

  function installObserver() {
    if (observer || !window.MutationObserver) return;
    const target = document.querySelector(".content-area") || document.body;
    observer = new MutationObserver((records) => {
      records.forEach(scanMutation);
      ensureReturnLanguageControl();
      scheduleLocalization();
    });
    observer.observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "placeholder", "title", "aria-label", "alt"]
    });
  }

  function translatePrompt(kind, original) {
    if (!document.body.classList.contains("ibp-mode")) return original;
    return translate(String(original == null ? "" : original), language());
  }

  function installBrowserPromptTranslations() {
    if (!window.__ibpLegacyPromptTranslations) {
      window.__ibpLegacyPromptTranslations = true;
      const alertFn = window.alert;
      const confirmFn = window.confirm;
      const promptFn = window.prompt;
      window.alert = function (message) {
        return alertFn.call(window, translatePrompt("alert", message));
      };
      window.confirm = function (message) {
        return confirmFn.call(window, translatePrompt("confirm", message));
      };
      window.prompt = function (message, defaultValue) {
        return promptFn.call(window, translatePrompt("prompt", message), defaultValue);
      };
    }
  }

  function boot() {
    ensureReturnLanguageControl();
    installObserver();
    installBrowserPromptTranslations();
    document.addEventListener("change", handleLanguageChange);
    setDirectionAndTranslate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();