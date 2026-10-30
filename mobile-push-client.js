(() => {
  'use strict';

  const socket = () => window.blackRidgeSocket || null;
  const state = { info: null, busy: false, opened: false, subscribed: false, memberLoadId: 0 };
  const IOS_DEVICE = /iphone|ipad|ipod/i.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints) > 1);

  function session() {
    try {
      return typeof window.blackRidgeGetNotificationSession === 'function'
        ? window.blackRidgeGetNotificationSession()
        : null;
    } catch (_error) {
      return null;
    }
  }

  function pushSupportMessage() {
    if (!window.isSecureContext) return 'تحتاج إشعارات الهاتف إلى اتصال HTTPS آمن.';
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      return 'هذا المتصفح لا يدعم Web Push. جرّب Chrome على Android أو Safari على iPhone/iPad بإصدار حديث.';
    }
    const standalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    if (IOS_DEVICE && !standalone) {
      return 'على iPhone/iPad: افتح قائمة المشاركة في Safari، اختر «إضافة إلى الشاشة الرئيسية»، ثم افتح الموقع من الأيقونة وفعّل الإشعارات من هناك.';
    }
    if (Notification.permission === 'denied') {
      return 'إذن الإشعارات مرفوض من المتصفح. غيّره من إعدادات الموقع في المتصفح ثم أعد فتح هذه الصفحة.';
    }
    return 'تظهر هذه التنبيهات من نظام الهاتف حتى عند إغلاق الموقع. على iPhone/iPad يجب فتح BLACK RIDGE من أيقونة الشاشة الرئيسية.';
  }

  function setStatus(text, kind = '') {
    const status = document.getElementById('mobile-push-status');
    if (!status) return;
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function emit(event, payload = {}) {
    return new Promise((resolve, reject) => {
      const connection = socket();
      if (!connection || !connection.connected) {
        reject(new Error('الاتصال بالخادم غير متاح الآن.'));
        return;
      }
      connection.emit(event, payload, (result) => {
        if (result?.ok) resolve(result);
        else reject(new Error(result?.message || 'تعذر إكمال الطلب.'));
      });
    });
  }

  function addStyles() {
    if (document.getElementById('mobile-push-styles')) return;
    const style = document.createElement('style');
    style.id = 'mobile-push-styles';
    style.textContent = `
      #mobile-push-settings-nav { list-style:none; }
      #mobile-push-settings-nav[hidden] { display:none!important; }
      #mobile-push-overlay { position:fixed; inset:0; z-index:2147480000; display:grid; place-items:center; padding:12px; padding-top:max(12px,env(safe-area-inset-top)); padding-bottom:max(12px,env(safe-area-inset-bottom)); background:rgba(0,0,0,.82); }
      #mobile-push-overlay[hidden] { display:none!important; }
      .mobile-push-dialog { width:min(560px,100%); max-height:min(92dvh,900px); overflow:auto; padding:clamp(16px,4vw,24px); color:#eaf0f4; background:linear-gradient(145deg,#121b25,#080d13); border:1px solid rgba(214,177,104,.45); border-radius:12px; box-shadow:0 24px 90px rgba(0,0,0,.7); font:14px/1.7 system-ui,sans-serif; }
      .mobile-push-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding-bottom:12px; border-bottom:1px solid rgba(148,163,184,.2); }
      .mobile-push-head h2 { margin:0; color:#e8c778; font-size:1.05rem; }
      .mobile-push-close { width:38px; height:38px; color:#d4dce2; background:#16212c; border:1px solid #344353; border-radius:6px; font-size:1.3rem; cursor:pointer; }
      .mobile-push-intro,.mobile-push-help { margin:12px 0; color:#a8b6c3; font-size:.8rem; }
      #mobile-push-status { min-height:2.8em; margin:12px 0; padding:9px 11px; color:#c9d4dc; background:#0a1119; border:1px solid #273746; border-radius:6px; font-size:.78rem; }
      #mobile-push-status[data-kind="error"] { color:#ffc3c3; border-color:#803941; }
      #mobile-push-status[data-kind="success"] { color:#bce8c9; border-color:#34744a; }
      .mobile-push-controls { display:flex; flex-wrap:wrap; gap:8px; }
      .mobile-push-button { min-height:42px; padding:9px 14px; color:#10151a; background:#d6b168; border:1px solid #edcf86; border-radius:6px; font:700 .8rem system-ui,sans-serif; cursor:pointer; }
      .mobile-push-button.secondary { color:#dce4e9; background:#111b26; border-color:#344453; }
      .mobile-push-button:disabled { opacity:.55; cursor:wait; }
      #mobile-push-send-form { display:grid; gap:10px; margin-top:18px; padding-top:16px; border-top:1px solid rgba(148,163,184,.2); }
      #mobile-push-send-form[hidden] { display:none!important; }
      #mobile-push-send-form .mobile-push-field[hidden] { display:none!important; }
      .mobile-push-form-title { margin:0 0 2px; color:#e8c778; font-size:.9rem; }
      .mobile-push-field { display:grid; gap:5px; color:#bfccd5; font-size:.75rem; }
      .mobile-push-field input,.mobile-push-field textarea,.mobile-push-field select { width:100%; min-height:42px; padding:9px 10px; color:#edf2f6; background:#080e15; border:1px solid #354656; border-radius:5px; font:inherit; }
      .mobile-push-field textarea { min-height:100px; resize:vertical; }
      .mobile-push-field input:focus,.mobile-push-field textarea:focus,.mobile-push-field select:focus { outline:2px solid rgba(214,177,104,.55); outline-offset:1px; }
      @media(max-width:420px) { #mobile-push-overlay { padding-inline:8px; } .mobile-push-dialog { max-height:94dvh; padding:15px 13px; border-radius:9px; } }
    `;
    document.head.appendChild(style);
  }

  function buildPanel() {
    const nav = document.querySelector('.nav-list');
    if (nav && !document.getElementById('mobile-push-settings-nav')) {
      const item = document.createElement('li');
      item.id = 'mobile-push-settings-nav';
      item.className = 'nav-btn';
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.innerHTML = '<i class="fa-solid fa-mobile-screen-button" aria-hidden="true"></i><span>إشعارات الهاتف</span>';
      item.addEventListener('click', openPanel);
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPanel();
        }
      });
      const notificationCenter = document.getElementById('notification-nav-button');
      if (notificationCenter?.parentNode === nav) nav.insertBefore(item, notificationCenter.nextSibling);
      else nav.appendChild(item);
      item.hidden = true;
    }

    if (!document.getElementById('mobile-push-overlay')) {
      const overlay = document.createElement('div');
      overlay.id = 'mobile-push-overlay';
      overlay.hidden = true;
      overlay.innerHTML = `
        <section class="mobile-push-dialog" role="dialog" aria-modal="true" aria-labelledby="mobile-push-title" dir="rtl">
          <header class="mobile-push-head">
            <h2 id="mobile-push-title">إشعارات الهاتف</h2>
            <button type="button" class="mobile-push-close" data-mobile-push-close aria-label="إغلاق">×</button>
          </header>
          <p class="mobile-push-intro">تُرسل الاستدعاءات والتحذيرات والتعاميم إلى أجهزة المستلمين المشتركين، وتُحفظ في مركز إشعارات BLACK RIDGE CIA.</p>
          <p id="mobile-push-status" role="status" aria-live="polite"></p>
          <div class="mobile-push-controls">
            <button type="button" class="mobile-push-button" data-mobile-push-enable>تفعيل على هذا الجهاز</button>
            <button type="button" class="mobile-push-button secondary" data-mobile-push-disable hidden>إيقاف على هذا الجهاز</button>
          </div>
          <p class="mobile-push-help" id="mobile-push-compatibility"></p>
          <form id="mobile-push-send-form" hidden>
            <h3 class="mobile-push-form-title">إصدار استدعاء رسمي</h3>
            <label class="mobile-push-field">نوع الإشعار
              <select name="notificationType" required>
                <option value="OFFICIAL_SUMMON">استدعاء رسمي</option>
                <option value="SECURITY_ALERT">تحذير أمني</option>
                <option value="COMMAND_CIRCULAR">تعميم قيادي</option>
              </select>
            </label>
            <label class="mobile-push-field">القطاع
              <select name="sector" required></select>
            </label>
            <p class="mobile-push-help" id="mobile-push-no-sectors" role="status" hidden>لا توجد قطاعات مؤهلة للإرسال بعد. يلزم وجود وحدة نشطة وعضو مؤهل فيها.</p>
            <label class="mobile-push-field" id="mobile-push-audience-field" hidden>المستلمون
              <select name="audience" required disabled>
                <option value="SECTOR">كل أفراد القطاع</option>
                <option value="MEMBER">شخص معين</option>
              </select>
            </label>
            <label class="mobile-push-field" id="mobile-push-member-field" hidden>الشخص
              <select name="memberId" disabled></select>
            </label>
            <label class="mobile-push-field">
              <span data-push-subject-label>موضوع الاستدعاء</span>
              <input name="subject" type="text" maxlength="180" required autocomplete="off">
            </label>
            <label class="mobile-push-field">
              <span data-push-message-label>نص الاستدعاء</span>
              <textarea name="message" maxlength="600" required></textarea>
            </label>
            <label class="mobile-push-field"><span data-push-priority-label>الأولوية</span>
              <select name="priority">
                <option value="NORMAL">عادية</option>
                <option value="HIGH">مرتفعة</option>
                <option value="CRITICAL">حرجة</option>
              </select>
            </label>
            <button class="mobile-push-button" type="submit" data-push-submit-label>إصدار الاستدعاء وإرساله</button>
          </form>
        </section>
      `;
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay || event.target.closest('[data-mobile-push-close]')) closePanel();
      });
      overlay.querySelector('[data-mobile-push-enable]').addEventListener('click', enablePush);
      overlay.querySelector('[data-mobile-push-disable]').addEventListener('click', disablePush);
      overlay.querySelector('#mobile-push-send-form [name="sector"]').addEventListener('change', handleSectorChange);
      overlay.querySelector('#mobile-push-send-form [name="audience"]').addEventListener('change', handleAudienceChange);
      overlay.querySelector('#mobile-push-send-form [name="memberId"]').addEventListener('change', updateSendAvailability);
      overlay.querySelector('#mobile-push-send-form [name="notificationType"]').addEventListener('change', updateNotificationTypeFields);
      overlay.querySelector('#mobile-push-send-form').addEventListener('submit', sendSectorPush);
      document.body.appendChild(overlay);
      updateNotificationTypeFields();
    }
    addStyles();
  }

  function refreshNavigation() {
    const item = document.getElementById('mobile-push-settings-nav');
    const current = session();
    const visible = !!current?.user && current.authenticated === true;
    if (item) item.hidden = !visible;
    if (!visible) closePanel();
    return visible;
  }

  function openPanel() {
    if (!refreshNavigation()) {
      const auth = document.getElementById('passcode-modal');
      if (auth) auth.style.display = 'flex';
      return;
    }
    const overlay = document.getElementById('mobile-push-overlay');
    if (!overlay) return;
    overlay.hidden = false;
    state.opened = true;
    const compatibility = document.getElementById('mobile-push-compatibility');
    if (compatibility) compatibility.textContent = pushSupportMessage();
    setStatus('جارٍ التحقق من اتصال الخدمة وإعدادات هذا الجهاز…');
    void refreshInfo();
    overlay.querySelector('[data-mobile-push-close]')?.focus();
  }

  function closePanel() {
    const overlay = document.getElementById('mobile-push-overlay');
    if (overlay) overlay.hidden = true;
    state.opened = false;
  }

  function updateDeviceControls() {
    const enable = document.querySelector('[data-mobile-push-enable]');
    const disable = document.querySelector('[data-mobile-push-disable]');
    const compatible = window.isSecureContext &&
      'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window &&
      !(IOS_DEVICE && !(navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches));
    if (enable) {
      enable.hidden = !compatible || !('Notification' in window) || Notification.permission === 'denied' || state.subscribed;
      enable.disabled = !compatible || state.info?.configured !== true;
    }
    if (disable) {
      disable.hidden = !state.subscribed;
      disable.disabled = !compatible;
    }
  }

  function fillSectorOptions(sectors) {
    const select = document.querySelector('#mobile-push-send-form [name="sector"]');
    if (!select) return;
    select.replaceChildren();
    const availableSectors = Array.isArray(sectors) ? sectors : [];
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = availableSectors.length ? 'اختر القطاع' : 'لا توجد قطاعات مؤهلة';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    for (const sector of availableSectors) {
      const option = document.createElement('option');
      option.value = String(sector.name || '');
      option.textContent = `${String(sector.name || '')} — ${Number(sector.memberCount) || 0} فرد`;
      select.appendChild(option);
    }
    select.disabled = availableSectors.length === 0;
    const emptyMessage = document.getElementById('mobile-push-no-sectors');
    if (emptyMessage) emptyMessage.hidden = availableSectors.length > 0;
    resetAudienceControls();
    updateSendAvailability();
  }

  function resetAudienceControls() {
    const audienceField = document.getElementById('mobile-push-audience-field');
    const audienceSelect = document.querySelector('#mobile-push-send-form [name="audience"]');
    const memberField = document.getElementById('mobile-push-member-field');
    const memberSelect = document.querySelector('#mobile-push-send-form [name="memberId"]');
    if (audienceField) audienceField.hidden = true;
    if (audienceSelect) {
      audienceSelect.value = 'SECTOR';
      audienceSelect.disabled = true;
    }
    if (memberField) memberField.hidden = true;
    if (memberSelect) {
      memberSelect.replaceChildren();
      memberSelect.disabled = true;
      memberSelect.required = false;
    }
    state.memberLoadId += 1;
  }

  function updateSendAvailability() {
    const form = document.getElementById('mobile-push-send-form');
    const send = form?.querySelector('[type="submit"]');
    if (!form || !send) return;
    const sector = form.querySelector('[name="sector"]')?.value || '';
    const audience = form.querySelector('[name="audience"]')?.value || 'SECTOR';
    const member = form.querySelector('[name="memberId"]');
    send.disabled = state.busy || !sector ||
      (audience === 'MEMBER' && (!member?.value || member.disabled));
  }

  function updateNotificationTypeFields() {
    const form = document.getElementById('mobile-push-send-form');
    if (!form) return;
    const type = form.querySelector('[name="notificationType"]')?.value;
    const isCircular = type === 'COMMAND_CIRCULAR';
    const isSecurityAlert = type === 'SECURITY_ALERT';
    const formTitle = form.querySelector('.mobile-push-form-title');
    const subjectLabel = form.querySelector('[data-push-subject-label]');
    const messageLabel = form.querySelector('[data-push-message-label]');
    const priorityLabel = form.querySelector('[data-push-priority-label]');
    const messageInput = form.querySelector('[name="message"]');
    const submitLabel = form.querySelector('[data-push-submit-label]');
    if (formTitle) formTitle.textContent = isCircular
      ? 'إصدار تعميم قيادي'
      : isSecurityAlert ? 'إرسال تحذير أمني' : 'إصدار استدعاء رسمي';
    if (subjectLabel) subjectLabel.textContent = isCircular
      ? 'عنوان التعميم'
      : isSecurityAlert ? 'موضوع التحذير' : 'موضوع الاستدعاء';
    if (messageLabel) messageLabel.textContent = isCircular
      ? 'محتوى التعميم'
      : isSecurityAlert ? 'نص التنبيه' : 'نص الاستدعاء';
    if (priorityLabel) priorityLabel.textContent = isSecurityAlert ? 'مستوى التحذير' : 'الأولوية';
    if (messageInput) messageInput.maxLength = isCircular ? 3000 : 600;
    if (submitLabel) submitLabel.textContent = isCircular
      ? 'إصدار التعميم وإرساله'
      : isSecurityAlert ? 'إرسال التحذير الأمني' : 'إصدار الاستدعاء وإرساله';
  }

  function handleSectorChange(event) {
    const audienceField = document.getElementById('mobile-push-audience-field');
    const audienceSelect = document.querySelector('#mobile-push-send-form [name="audience"]');
    resetAudienceControls();
    const hasSector = !!event.currentTarget.value;
    if (audienceField) audienceField.hidden = !hasSector;
    if (audienceSelect) audienceSelect.disabled = !hasSector;
    updateSendAvailability();
  }

  async function handleAudienceChange(event) {
    const audienceSelect = event.currentTarget;
    const wantsOneMember = audienceSelect.value === 'MEMBER';
    const memberField = document.getElementById('mobile-push-member-field');
    const memberSelect = document.querySelector('#mobile-push-send-form [name="memberId"]');
    const sectorSelect = document.querySelector('#mobile-push-send-form [name="sector"]');
    const requestedSector = sectorSelect?.value || '';
    if (memberField) memberField.hidden = !wantsOneMember;
    if (!memberSelect) return;
    memberSelect.replaceChildren();
    memberSelect.disabled = !wantsOneMember;
    memberSelect.required = wantsOneMember;
    updateSendAvailability();
    if (!wantsOneMember || !sectorSelect?.value) return;

    const loadId = ++state.memberLoadId;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'جارٍ تحميل الأسماء…';
    placeholder.disabled = true;
    placeholder.selected = true;
    memberSelect.appendChild(placeholder);
    memberSelect.disabled = true;
    try {
      const result = await emit('mobile-push:members', { sector: sectorSelect.value });
      if (loadId !== state.memberLoadId ||
          audienceSelect.value !== 'MEMBER' ||
          sectorSelect.value !== requestedSector ||
          sectorSelect.value !== result.sector) return;
      memberSelect.replaceChildren();
      const members = Array.isArray(result.members) ? result.members : [];
      const choose = document.createElement('option');
      choose.value = '';
      choose.textContent = members.length ? 'اختر الشخص' : 'لا يوجد أفراد مؤهلون';
      choose.disabled = true;
      choose.selected = true;
      memberSelect.appendChild(choose);
      for (const member of members) {
        const option = document.createElement('option');
        option.value = String(member.id || '');
        option.textContent = member.publicCode
          ? `${String(member.name || 'عضو')} — ${String(member.publicCode)}`
          : String(member.name || 'عضو');
        memberSelect.appendChild(option);
      }
      memberSelect.disabled = members.length === 0;
      if (!members.length) setStatus('لا يوجد أفراد مؤهلون في القطاع المحدد.', 'error');
      updateSendAvailability();
    } catch (error) {
      if (loadId !== state.memberLoadId) return;
      memberSelect.replaceChildren();
      const failed = document.createElement('option');
      failed.value = '';
      failed.textContent = 'تعذر تحميل الأفراد';
      failed.disabled = true;
      failed.selected = true;
      memberSelect.appendChild(failed);
      memberSelect.disabled = true;
      setStatus(error.message, 'error');
      updateSendAvailability();
    }
  }

  async function refreshInfo() {
    if (!refreshNavigation()) return;
    try {
      state.info = await emit('mobile-push:info');
      const form = document.getElementById('mobile-push-send-form');
      if (form) {
        form.hidden = !(state.info.canSend && state.info.configured);
        fillSectorOptions(state.info.sectors);
      }
      const infoMessage = state.info.configured
        ? 'الخادم جاهز لإشعارات Web Push.'
        : 'ميزة الإرسال تنتظر إعداد مفاتيح VAPID على الخادم.';
      setStatus(infoMessage, state.info.configured ? '' : 'error');
      updateDeviceControls();
      await syncExistingSubscription();
    } catch (error) {
      state.info = null;
      const form = document.getElementById('mobile-push-send-form');
      if (form) form.hidden = true;
      setStatus(error.message, 'error');
    }
  }

  function base64UrlToBytes(value) {
    const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  }

  async function readyRegistration() {
    const registration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
    return navigator.serviceWorker.ready || registration;
  }

  async function syncExistingSubscription() {
    if (!window.isSecureContext || !('Notification' in window) ||
        Notification.permission !== 'granted' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (IOS_DEVICE && !(navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches)) return;
    try {
      const registration = await readyRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        state.subscribed = false;
        updateDeviceControls();
        return;
      }
      state.subscribed = true;
      if (state.info?.configured) await emit('mobile-push:subscribe', { subscription: subscription.toJSON() });
      updateDeviceControls();
      setStatus('إشعارات الهاتف مفعّلة على هذا الجهاز.', 'success');
    } catch (_error) {
      // Rebinding a previously approved browser subscription is best-effort.
    }
  }

  async function enablePush(event) {
    if (state.busy) return;
    const button = event.currentTarget;
    if (!state.info?.configured || !state.info.publicKey) {
      setStatus('إشعارات الهاتف غير مهيأة على الخادم بعد.', 'error');
      return;
    }
    if (!window.isSecureContext || !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setStatus(pushSupportMessage(), 'error');
      return;
    }
    if (IOS_DEVICE && !(navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches)) {
      setStatus(pushSupportMessage(), 'error');
      return;
    }

    state.busy = true;
    button.disabled = true;
    setStatus('اختر «سماح» في نافذة المتصفح لتفعيل إشعارات الهاتف.');
    try {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus(permission === 'denied'
          ? 'لم يُمنح الإذن. غيّر إذن الإشعارات من إعدادات الموقع في المتصفح.'
          : 'لم يُمنح إذن الإشعارات.', 'error');
        return;
      }
      const registration = await readyRegistration();
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(state.info.publicKey)
        });
      }
      await emit('mobile-push:subscribe', { subscription: subscription.toJSON() });
      state.subscribed = true;
      updateDeviceControls();
      setStatus('تم تفعيل إشعارات الهاتف على هذا الجهاز.', 'success');
    } catch (error) {
      setStatus(error.message || 'تعذر تفعيل إشعارات الهاتف على هذا الجهاز.', 'error');
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  }

  async function disablePush(event) {
    if (state.busy) return;
    const button = event.currentTarget;
    state.busy = true;
    button.disabled = true;
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager?.getSubscription();
      if (!subscription) {
        state.subscribed = false;
        updateDeviceControls();
        setStatus('لا يوجد اشتراك نشط على هذا الجهاز.');
        return;
      }
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();
      await emit('mobile-push:unsubscribe', { endpoint });
      state.subscribed = false;
      updateDeviceControls();
      setStatus('تم إيقاف إشعارات الهاتف على هذا الجهاز.', 'success');
    } catch (error) {
      state.subscribed = false;
      updateDeviceControls();
      setStatus(error.message || 'تم إيقاف الاشتراك المحلي لكن تعذر تنظيفه على الخادم.', 'error');
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  }

  async function sendSectorPush(event) {
    event.preventDefault();
    if (state.busy) return;
    const form = event.currentTarget;
    const send = form.querySelector('[type="submit"]');
    const data = new FormData(form);
    state.busy = true;
    send.disabled = true;
    setStatus('جارٍ إرسال إشعار الهاتف إلى أجهزة الأفراد المشتركين…');
    try {
      const result = await emit('mobile-push:send-sector', {
        notificationType: data.get('notificationType'),
        sector: data.get('sector'),
        audience: data.get('audience') || 'SECTOR',
        memberId: data.get('memberId'),
        subject: data.get('subject'),
        message: data.get('message'),
        priority: data.get('priority')
      });
      const isCircular = result.notificationType === 'COMMAND_CIRCULAR';
      const isSecurityAlert = result.notificationType === 'SECURITY_ALERT';
      const documentType = isCircular
        ? 'التعميم'
        : isSecurityAlert ? 'التحذير الأمني' : 'الاستدعاء';
      const savedType = isCircular
        ? 'تعميمًا قياديًا'
        : isSecurityAlert ? 'تحذيرًا أمنيًا' : 'استدعاءً رسميًا';
      const pushStatus = result.deviceCount
        ? `قبلت خدمة الهاتف ${result.acceptedByPushService} جهازًا من أصل ${result.deviceCount}.`
        : `لا توجد أجهزة هاتف مشتركة؛ حُفظ ${documentType} في مركز الإشعارات فقط.`;
      setStatus(
        `تم حفظ ${result.savedNotificationCount || 0} ${savedType} في مركز الإشعارات.${result.circularNumber ? ` رقم التعميم: ${result.circularNumber}.` : ''} المستهدف: ${result.audience === 'MEMBER' ? `الشخص ${result.targetMemberName || ''}` : 'كل أفراد القطاع'}. ${pushStatus} الأفراد المؤهلون: ${result.recipientCount}؛ لديهم اشتراك: ${result.subscribedMembers}؛ بلا اشتراك: ${result.noSubscriptionMembers}؛ الأجهزة التي رفضتها الخدمة: ${result.failed}.`,
        result.failed || result.noSubscriptionMembers ? 'error' : 'success'
      );
      form.reset();
      updateNotificationTypeFields();
      fillSectorOptions(state.info?.sectors);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      state.busy = false;
      updateSendAvailability();
    }
  }

  function install() {
    buildPanel();
    refreshNavigation();
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.opened) closePanel();
    });
    const connection = socket();
    if (connection) {
      connection.on('connect', () => {
        if (refreshNavigation()) void refreshInfo();
      });
      connection.on('auth:login:result', (result) => {
        if (result?.ok && result.user) window.setTimeout(() => {
          if (refreshNavigation()) void refreshInfo();
        }, 0);
      });
      connection.on('auth:logout:result', () => {
        state.info = null;
        refreshNavigation();
      });
    }
    window.addEventListener('blackridge:logout', () => {
      state.info = null;
      refreshNavigation();
    });
    window.setInterval(refreshNavigation, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
