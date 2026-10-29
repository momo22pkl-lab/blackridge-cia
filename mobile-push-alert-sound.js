'use strict';

function createMobilePushAlertSound(environment = {}) {
  const AudioConstructor = environment.Audio;
  const document = environment.document;
  const serviceWorker = environment.navigator?.serviceWorker;
  if (typeof AudioConstructor !== 'function') {
    return { prime: () => Promise.resolve(false), play: () => Promise.resolve(false) };
  }

  const audio = new AudioConstructor('/warning-alert.mp3');
  audio.preload = 'auto';
  audio.loop = false;
  audio.volume = 0.8;
  let primed = false;
  let priming = false;

  function resetAudio() {
    try { audio.pause(); } catch (_error) {}
    try { audio.currentTime = 0; } catch (_error) {}
  }

  function prime() {
    if (primed) return Promise.resolve(true);
    if (priming) return Promise.resolve(false);
    priming = true;
    const wasMuted = audio.muted;
    audio.muted = true;
    let attempt;
    try {
      attempt = audio.play();
    } catch (_error) {
      audio.muted = wasMuted;
      priming = false;
      return Promise.resolve(false);
    }

    const finish = (success) => {
      priming = false;
      audio.muted = wasMuted;
      resetAudio();
      primed = success;
      return success;
    };
    if (attempt && typeof attempt.then === 'function') {
      return attempt.then(() => finish(true), () => finish(false));
    }
    return Promise.resolve(finish(true));
  }

  function play() {
    if (!primed || !document || document.visibilityState !== 'visible') {
      return Promise.resolve(false);
    }
    audio.muted = false;
    try { audio.currentTime = 0; } catch (_error) {}
    let attempt;
    try {
      attempt = audio.play();
    } catch (_error) {
      return Promise.resolve(false);
    }
    if (attempt && typeof attempt.then === 'function') {
      return attempt.then(() => true, () => false);
    }
    return Promise.resolve(true);
  }

  function handleServiceWorkerMessage(event) {
    if (event.data?.type !== 'blackridge:mobile-push-critical-alarm') return;
    const replyPort = event.ports?.[0];
    if (!replyPort || typeof replyPort.postMessage !== 'function') return;
    if (event.origin && environment.location?.origin && event.origin !== environment.location.origin) {
      replyPort.postMessage({ played: false });
      return;
    }
    return play().then((played) => {
      try { replyPort.postMessage({ played: played === true }); } catch (_error) {}
    });
  }

  if (document && typeof document.addEventListener === 'function') {
    const onUserGesture = () => { void prime(); };
    for (const eventName of ['pointerdown', 'touchstart', 'keydown']) {
      document.addEventListener(eventName, onUserGesture, {
        capture: true,
        once: true,
        passive: true
      });
    }
  }
  if (serviceWorker && typeof serviceWorker.addEventListener === 'function') {
    serviceWorker.addEventListener('message', handleServiceWorkerMessage);
  }

  return { prime, play };
}

if (typeof module === 'object' && module.exports) module.exports = createMobilePushAlertSound;
if (typeof window !== 'undefined' && window.document && typeof window.Audio === 'function') {
  window.BlackridgeMobilePushAlertSound = createMobilePushAlertSound(window);
}
