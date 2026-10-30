(function attachScreenProtection(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) api.install(root, root.document);
})(typeof window === 'undefined' ? null : window, function createScreenProtection() {
  'use strict';

  const LOCK_ATTRIBUTE = 'data-black-ridge-screen-locked';
  const OVERLAY_ID = 'black-ridge-screen-protection-overlay';
  const STYLE_ID = 'black-ridge-screen-protection-styles';
  const VALIDATION_TIMEOUT_MS = 15000;

  function install(win, doc) {
    if (!win || !doc || !doc.documentElement) return null;
    if (win.blackRidgeScreenProtection) return win.blackRidgeScreenProtection;

    let backgrounded = doc.hidden === true || doc.visibilityState === 'hidden';
    let validationGeneration = 0;
    let activeValidation = null;
    const captureTracks = new Set();
    const isArabic = /^ar\b/i.test(doc.documentElement.lang || win.navigator?.language || '');

    function ensureLayer() {
      let layer = doc.getElementById(OVERLAY_ID);
      if (layer) return layer;

      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        #${OVERLAY_ID} {
          display: none;
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: #000;
          color: #e8e8e8;
          font: 14px/1.6 system-ui, sans-serif;
          text-align: center;
          pointer-events: auto;
          color-scheme: dark;
        }
        html[${LOCK_ATTRIBUTE}] #${OVERLAY_ID} { display: flex; }
        #${OVERLAY_ID} .br-screen-protection-panel {
          display: none;
          width: min(460px, 100%);
          padding: 22px;
          border: 1px solid #252525;
          border-radius: 8px;
          background: #050505;
        }
        #${OVERLAY_ID}[data-state="verifying"] .br-screen-protection-panel,
        #${OVERLAY_ID}[data-state="failed"] .br-screen-protection-panel,
        #${OVERLAY_ID}[data-state="capture"] .br-screen-protection-panel { display: block; }
        #${OVERLAY_ID} p { margin: 0 0 14px; }
        #${OVERLAY_ID} button {
          border: 1px solid #777;
          border-radius: 5px;
          padding: 9px 14px;
          background: #111;
          color: #fff;
          font: inherit;
          cursor: pointer;
        }
        #${OVERLAY_ID} button:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
        #${OVERLAY_ID}[data-state="background"] .br-screen-protection-panel { display: none; }
        @media (prefers-reduced-motion: reduce) {
          #${OVERLAY_ID}, #${OVERLAY_ID} * { scroll-behavior: auto !important; }
        }
      `;
      (doc.head || doc.documentElement).appendChild(style);

      layer = doc.createElement('div');
      layer.id = OVERLAY_ID;
      layer.setAttribute('role', 'status');
      layer.setAttribute('aria-live', 'polite');
      layer.setAttribute('aria-label', isArabic ? 'حماية الشاشة مفعّلة' : 'Screen protection is active');

      const panel = doc.createElement('div');
      panel.className = 'br-screen-protection-panel';
      const message = doc.createElement('p');
      message.textContent = isArabic
        ? 'جارٍ التحقق من صلاحية الجلسة قبل عرض البيانات.'
        : 'Verifying the session before showing system data.';
      const retry = doc.createElement('button');
      retry.type = 'button';
      retry.textContent = isArabic ? 'إعادة التحقق' : 'Retry verification';
      retry.addEventListener('click', function retryVerification() {
        void verifyBeforeReveal('manual-retry');
      });
      panel.appendChild(message);
      panel.appendChild(retry);
      layer.appendChild(panel);
      layer._screenProtectionMessage = message;
      layer._screenProtectionRetry = retry;
      doc.documentElement.appendChild(layer);
      return layer;
    }

    function setLocked(state) {
      const layer = ensureLayer();
      if (state) {
        doc.documentElement.setAttribute(LOCK_ATTRIBUTE, 'true');
        layer.dataset.state = state;
        if (state === 'capture') {
          layer._screenProtectionMessage.textContent = isArabic
            ? 'مشاركة الشاشة نشطة. أوقف المشاركة لإعادة التحقق وعرض البيانات.'
            : 'Screen sharing is active. Stop sharing to verify the session and show data.';
          layer._screenProtectionRetry.hidden = true;
        }
      } else {
        doc.documentElement.removeAttribute(LOCK_ATTRIBUTE);
        layer.dataset.state = 'unlocked';
      }
    }

    function setFailureMessage() {
      const layer = ensureLayer();
      layer._screenProtectionMessage.textContent = isArabic
        ? 'تعذر التحقق من الجلسة. بقيت البيانات مخفية؛ أعد المحاولة عند استعادة الاتصال.'
        : 'The session could not be verified. Data remains hidden; retry when the connection is available.';
      layer._screenProtectionRetry.hidden = false;
    }

    function liveCaptureExists() {
      for (const track of captureTracks) {
        if (track.readyState !== 'ended') return true;
        captureTracks.delete(track);
      }
      return false;
    }

    function handleHidden() {
      backgrounded = true;
      validationGeneration += 1;
      activeValidation = null;
      setLocked('background');
    }

    function withTimeout(promise) {
      return new Promise((resolve) => {
        const timer = win.setTimeout(() => resolve(false), VALIDATION_TIMEOUT_MS);
        Promise.resolve(promise).then(
          (value) => {
            win.clearTimeout(timer);
            resolve(value === true);
          },
          () => {
            win.clearTimeout(timer);
            resolve(false);
          }
        );
      });
    }

    function verifyBeforeReveal(reason) {
      if (doc.hidden === true || doc.visibilityState === 'hidden') {
        handleHidden();
        return Promise.resolve(false);
      }
      backgrounded = false;
      if (liveCaptureExists()) {
        setLocked('capture');
        return Promise.resolve(false);
      }
      if (activeValidation) return activeValidation.promise;

      const generation = ++validationGeneration;
      const layer = ensureLayer();
      layer.dataset.state = 'verifying';
      layer._screenProtectionMessage.textContent = isArabic
        ? 'جارٍ التحقق من صلاحية الجلسة قبل عرض البيانات.'
        : 'Verifying the session before showing system data.';
      layer._screenProtectionRetry.hidden = true;
      setLocked('verifying');

      const verifier = win.blackRidgeValidateScreenProtectionSession;
      const verification = typeof verifier === 'function'
        ? withTimeout(Promise.resolve().then(() => verifier({ reason })))
        : Promise.resolve(false);

      const record = { generation, promise: null };
      record.promise = verification.then((isSafe) => {
        if (generation !== validationGeneration) return false;
        if (doc.hidden === true || doc.visibilityState === 'hidden') {
          handleHidden();
          return false;
        }
        if (liveCaptureExists()) {
          setLocked('capture');
          return false;
        }
        if (isSafe) {
          setLocked(false);
          return true;
        }
        setFailureMessage();
        setLocked('failed');
        return false;
      }).finally(() => {
        if (activeValidation === record) activeValidation = null;
      });
      activeValidation = record;
      return record.promise;
    }

    function handleVisible() {
      if (doc.hidden === true || doc.visibilityState === 'hidden') return;
      backgrounded = false;
      void verifyBeforeReveal('foreground');
    }

    function handleCaptureEnded(track) {
      captureTracks.delete(track);
      if (!liveCaptureExists() && !backgrounded &&
          doc.hidden !== true && doc.visibilityState !== 'hidden') {
        void verifyBeforeReveal('screen-share-ended');
      }
    }

    function installDisplayCaptureDetection() {
      const devices = win.navigator && win.navigator.mediaDevices;
      if (!devices || typeof devices.getDisplayMedia !== 'function') return false;
      const original = devices.getDisplayMedia;
      try {
        Object.defineProperty(devices, 'getDisplayMedia', {
          configurable: true,
          writable: true,
          value: function protectedGetDisplayMedia() {
            return Promise.resolve(original.apply(this, arguments)).then((stream) => {
              const tracks = stream && typeof stream.getVideoTracks === 'function'
                ? stream.getVideoTracks()
                : [];
              tracks.forEach((track) => {
                if (!track || track.readyState === 'ended') return;
                captureTracks.add(track);
                if (typeof track.addEventListener === 'function') {
                  track.addEventListener('ended', () => handleCaptureEnded(track), { once: true });
                }
              });
              if (liveCaptureExists()) setLocked('capture');
              return stream;
            });
          }
        });
        return true;
      } catch (_error) {
        return false;
      }
    }

    doc.addEventListener('visibilitychange', () => {
      if (doc.hidden === true || doc.visibilityState === 'hidden') handleHidden();
      else handleVisible();
    });
    win.addEventListener('pagehide', handleHidden);
    win.addEventListener('pageshow', handleVisible);
    doc.addEventListener('freeze', handleHidden);
    doc.addEventListener('resume', handleVisible);
    installDisplayCaptureDetection();

    const controller = {
      retry: () => verifyBeforeReveal('manual-retry'),
      getSnapshot: () => ({
        locked: doc.documentElement.hasAttribute(LOCK_ATTRIBUTE),
        backgrounded,
        captureActive: liveCaptureExists(),
        state: ensureLayer().dataset.state || 'unlocked'
      })
    };
    win.blackRidgeScreenProtection = controller;
    if (backgrounded) setLocked('background');
    return controller;
  }

  return { install, LOCK_ATTRIBUTE, OVERLAY_ID, VALIDATION_TIMEOUT_MS };
});
