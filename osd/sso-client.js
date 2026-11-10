'use strict';

(() => {
  const ssoQuery = new URLSearchParams(window.location.search);
  let pending = ssoQuery.get('osdSso') === '1';
  let issuing = false;

  if (pending) {
    ssoQuery.delete('osdSso');
    const cleanUrl = `${window.location.pathname}${ssoQuery.size ? `?${ssoQuery}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', cleanUrl);
  }

  function currentSession() {
    try {
      return typeof window.blackRidgeGetNotificationSession === 'function'
        ? window.blackRidgeGetNotificationSession()
        : null;
    } catch {
      return null;
    }
  }

  function setMessage(message) {
    const messageNode = document.getElementById('auth-msg');
    if (messageNode) messageNode.textContent = message;
  }

  function returnPath() {
    let value = '/osd/';
    try { value = sessionStorage.getItem('osd_sso_return') || value; } catch {}
    try {
      const target = new URL(value, window.location.origin);
      if (target.origin !== window.location.origin || !target.pathname.startsWith('/osd/')) return '/osd/';
      return `${target.pathname}${target.search}${target.hash}`;
    } catch {
      return '/osd/';
    }
  }

  function issueTicket() {
    const socket = window.blackRidgeSocket;
    const session = currentSession();
    if (!pending || issuing || !session?.authenticated || !socket) return;
    if (!socket.connected) {
      setMessage('الاتصال بالخادم غير جاهز؛ انتظر لحظة ثم أعد المحاولة.');
      return;
    }

    issuing = true;
    socket.emit('osd:sso:issue', {}, (result) => {
      issuing = false;
      if (!result?.ok || typeof result.ticket !== 'string') {
        pending = false;
        try { sessionStorage.removeItem('osd_sso_return'); } catch {}
        setMessage(result?.message || 'تعذر التحقق من صلاحية CIA CHIEF.');
        return;
      }

      try {
        sessionStorage.setItem('osd_sso_ticket', result.ticket);
        const destination = returnPath();
        sessionStorage.removeItem('osd_sso_return');
        pending = false;
        window.location.assign(destination);
      } catch {
        pending = false;
        setMessage('تعذر بدء جلسة OSD الآمنة. أعد المحاولة.');
      }
    });
  }

  if (pending) {
    const session = currentSession();
    if (!session?.authenticated) {
      const loginModal = document.getElementById('passcode-modal');
      if (loginModal) loginModal.style.display = 'flex';
      setMessage('سجّل الدخول عبر بوابة CIA بحساب CIA CHIEF النشط للمتابعة إلى OSD.');
    }

    const socket = window.blackRidgeSocket;
    if (socket?.on) {
      socket.on('connect', () => {
        if (pending) window.setTimeout(issueTicket, 0);
      });
      if (pending) {
        socket.on('auth:login:result', (result) => {
          if (pending && result?.ok) window.setTimeout(issueTicket, 0);
        });
      }
    }
    window.setTimeout(issueTicket, 0);
  }

  const osdLink = document.querySelector('a[href="/osd/"]');
  if (osdLink) {
    osdLink.addEventListener('click', (event) => {
      const session = currentSession();
      if (!session?.authenticated || String(session.user?.rank || '').trim().toUpperCase() !== 'CIA CHIEF') return;
      event.preventDefault();
      try { sessionStorage.setItem('osd_sso_return', '/osd/'); } catch {}
      pending = true;
      issueTicket();
    });
  }
})();
