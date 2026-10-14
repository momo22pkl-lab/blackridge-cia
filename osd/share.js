'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);
  const token = new URLSearchParams(location.search).get('token') || '';
  const arabic = /^ar\b/i.test(navigator.language || '');
  const labels = arabic ? {
    lang: 'ar', direction: 'rtl', access: 'رابط وثيقة آمن', loginTitle: 'سجّل الدخول لمشاهدة الوثيقة الداخلية',
    loginDescription: 'تتطلب هذه الوثيقة حساب OSD وصلاحية التصنيف المناسبة.', username: 'اسم المستخدم',
    password: 'كلمة المرور', signIn: 'تسجيل الدخول', invalid: 'رابط المشاركة غير صالح أو انتهت صلاحيته أو تم إلغاؤه.',
    denied: 'لا تملك صلاحية مشاهدة هذه الوثيقة.', loading: 'جارٍ تحميل الوثيقة…',
    valid: 'سجل الإصدار وسلامة النسخة مطابقان', openVerify: 'فتح سجل التحقق',
    expires: 'تنتهي صلاحية رابط المشاركة في',
    print: 'طباعة / حفظ PDF', protected: 'مشاهدة محمية',
    screenshotNotice: 'إخفاء أدوات الطباعة والتنزيل والنسخ يقلل النسخ غير المصرح به، لكنه لا يمنع تصوير الشاشة أو أدوات المتصفح.',
    verifyOnly: 'حالة الإصدار والتحقق فقط', validStatus: 'وثيقة صحيحة', revoked: 'وثيقة ملغاة',
    expired: 'وثيقة منتهية', failed: 'تعذر التحقق من سلامة الوثيقة',
    notVerified: 'الوثيقة غير متحققة', notFound: 'الوثيقة غير موجودة',
    loginFailed: 'تعذر تسجيل الدخول. تحقق من بيانات الحساب.'
  } : {
    lang: 'en', direction: 'ltr', access: 'SECURE DOCUMENT LINK',
    loginTitle: 'Sign in to view this internal document',
    loginDescription: 'This document requires an OSD account with sufficient classification clearance.',
    username: 'Username', password: 'Password', signIn: 'Sign in',
    invalid: 'The share link is invalid, expired, revoked, or the document is unavailable.',
    denied: 'Your account is not authorized to view this document.', loading: 'Loading document…',
    openVerify: 'Open verification record', print: 'Print / Save PDF', expires: 'Share link expires',
    protected: 'Protected viewing',
    screenshotNotice: 'Hiding print, download, and copy controls reduces casual copying; it cannot prevent screenshots, photographs, or browser-level access.',
    verifyOnly: 'Issue and verification status only', validStatus: 'DOCUMENT VALID', revoked: 'DOCUMENT REVOKED',
    expired: 'DOCUMENT EXPIRED', failed: 'DOCUMENT INTEGRITY CHECK FAILED',
    notVerified: 'DOCUMENT NOT VERIFIED', notFound: 'DOCUMENT NOT FOUND',
    loginFailed: 'Sign-in failed. Check your OSD account details.'
  };
  document.documentElement.lang = labels.lang;
  document.documentElement.dir = labels.direction;

  $('#accessLabel').textContent = labels.access;
  $('#loginTitle').textContent = labels.loginTitle;
  $('#loginDescription').textContent = labels.loginDescription;
  $('#usernameLabel').textContent = labels.username;
  $('#passwordLabel').textContent = labels.password;
  $('#loginButton').textContent = labels.signIn;
  $('#protectedNotice').querySelector('b').textContent = labels.protected;
  $('#protectedNotice').querySelector('span').textContent = labels.screenshotNotice;
  $('#verifyButton').textContent = labels.verifyOnly;
  $('#printButton').textContent = labels.print;
  $('#verificationLink').textContent = labels.openVerify;

  function showError(message = labels.invalid) {
    $('#errorMessage').textContent = message;
    $('#errorPanel').hidden = false;
    $('#loginPanel').hidden = true;
    $('#documentFrame').hidden = true;
  }

  function showLogin() {
    $('#loginPanel').hidden = false;
    $('#errorPanel').hidden = true;
    $('#documentFrame').hidden = true;
    $('#loginUsername').focus();
  }

  async function loadShare() {
    if (!token || token.length > 200) return showError();
    const response = await fetch(`/api/osd/share/${encodeURIComponent(token)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) return showLogin();
    if (response.status === 403 || response.status === 404) return showError(labels.denied);
    if (response.status === 410) return showError(labels.invalid);
    if (!response.ok || !data.document) return showError(data.error || labels.invalid);
    await renderDocument(data);
  }

  async function renderDocument(data) {
    const doc = data.document;
    const protectedView = !!data.protectedView;
    const code = String(doc.verificationCode || '');
    const verifyUrl = new URL(`/osd/?verify=${encodeURIComponent(code)}`, location.origin).toString();
    document.title = `${doc.title || doc.documentNumber} · OSD`;
    $('#documentStatus').textContent = labels.notVerified;
    $('#documentStatus').dataset.status = doc.status || '';
    const expiry = $('#shareExpiryDisplay');
    if (data.expiresAt) {
      const formattedExpiry = new Date(data.expiresAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
      expiry.textContent = `${labels.expires}: ${formattedExpiry}`;
      expiry.hidden = false;
    }
    $('#classification').textContent = doc.classification || '—';
    $('#footerClass').textContent = doc.classification || '—';
    $('#documentNumber').textContent = doc.documentNumber || '—';
    $('#footerNumber').textContent = `${doc.documentNumber || '—'} · v${doc.version || '—'}`;
    $('#issuedAt').textContent = doc.issuedAt ? new Date(doc.issuedAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '—';
    $('#version').textContent = doc.version || '—';
    $('#sector').textContent = doc.sector || '—';
    $('#recipient').textContent = doc.recipient || '';
    $('#recipientRow').hidden = !doc.recipient;
    $('#documentType').textContent = doc.type || 'OFFICIAL DOCUMENT';
    $('#documentTitle').textContent = doc.title || 'Official document';
    const body = [doc.body?.text || '', ...(doc.body?.references || []).map((item) => `Reference: ${item}`)].filter(Boolean).join('\n\n');
    $('#documentBody').textContent = body || labels.verifyOnly;
    $('#signer').textContent = doc.signature?.display || doc.signer || 'AUTHORIZED COMMAND';
    const signature = $('#signatureImage');
    if (!protectedView && doc.signature?.signatureImage && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(doc.signature.signatureImage)) {
      signature.src = doc.signature.signatureImage;
      signature.hidden = false;
    } else {
      signature.removeAttribute('src');
      signature.hidden = true;
    }
    $('#verificationCode').textContent = code || '—';
    $('#verificationLink').href = verifyUrl;
    $('#verifyButton').href = verifyUrl;
    try {
      $('#verificationQr').src = window.OSDQR.toDataUri(verifyUrl);
    } catch {
      $('#verificationQr').hidden = true;
    }
    const canPrint = !protectedView && Array.isArray(data.permissions) && data.permissions.includes('DOWNLOAD');
    $('#printButton').hidden = !canPrint;
    $('#protectedNotice').hidden = !protectedView;
    document.body.classList.toggle('protected', protectedView);
    const watermark = String(data.watermark || '').trim();
    const layer = $('#watermarkLayer');
    layer.replaceChildren();
    if (protectedView && watermark) {
      for (let i = 0; i < 15; i += 1) {
        const mark = document.createElement('span');
        mark.textContent = watermark;
        layer.append(mark);
      }
      layer.hidden = false;
    } else {
      layer.hidden = true;
    }
    $('#documentFrame').hidden = false;
    try {
      const verifyResponse = await fetch(`/api/osd/verify/${encodeURIComponent(code)}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      const verification = await verifyResponse.json();
      const statusLabels = {
        'DOCUMENT VALID': labels.validStatus,
        'DOCUMENT REVOKED': labels.revoked,
        'DOCUMENT EXPIRED': labels.expired,
        'DOCUMENT INTEGRITY CHECK FAILED': labels.failed,
        'DOCUMENT NOT VERIFIED': labels.notVerified,
        'DOCUMENT NOT FOUND': labels.notFound
      };
      $('#documentStatus').textContent = statusLabels[verification.status] || labels.notVerified;
      $('#documentStatus').dataset.status = verification.status;
    } catch {
      $('#documentStatus').textContent = labels.notVerified;
    }
  }

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#loginError').textContent = '';
    $('#loginButton').disabled = true;
    try {
      const response = await fetch('/api/osd/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#loginUsername').value, password: $('#loginPassword').value })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        $('#loginError').textContent = data.error || labels.loginFailed;
        return;
      }
      $('#loginPassword').value = '';
      await loadShare();
    } catch {
      $('#loginError').textContent = labels.loginFailed;
    } finally {
      $('#loginButton').disabled = false;
    }
  });

  $('#printButton').addEventListener('click', () => window.print());
  document.addEventListener('contextmenu', (event) => {
    if (document.body.classList.contains('protected')) event.preventDefault();
  });
  document.addEventListener('copy', (event) => {
    if (document.body.classList.contains('protected')) event.preventDefault();
  });
  document.addEventListener('cut', (event) => {
    if (document.body.classList.contains('protected')) event.preventDefault();
  });
  document.addEventListener('keydown', (event) => {
    if (!document.body.classList.contains('protected')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && ['a', 'c', 'p', 's', 'u', 'x'].includes(key)) event.preventDefault();
  });

  loadShare().catch(() => showError(labels.invalid));
})();
