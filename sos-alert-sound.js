'use strict';

(function exposeSOSAlertSound(root, createController) {
  if (typeof module === 'object' && module.exports) module.exports = createController;
  if (root && root.document && typeof root.Audio === 'function') {
    root.SOSAlertSound = createController(root);
  }
})(typeof window !== 'undefined' ? window : null, function createSOSAlertSound(environment = {}) {
  const AudioConstructor = environment.Audio;
  const document = environment.document;
  if (typeof AudioConstructor !== 'function') {
    return {
      start: () => Promise.resolve(false),
      stop: () => false,
      enable: () => Promise.resolve(false),
      prime: () => Promise.resolve(false)
    };
  }

  const audio = new AudioConstructor('/sos-alert.mp3');
  audio.preload = 'auto';
  audio.loop = true;
  audio.volume = 0.8;

  let active = false;
  let activeId = null;
  let primed = false;
  let priming = false;
  const enableButton = document && document.getElementById('sos-audio-enable');

  function setEnableButtonVisible(visible) {
    if (enableButton) enableButton.hidden = !visible;
  }

  function resetAudio() {
    try { audio.pause(); } catch (_error) {}
    try { audio.currentTime = 0; } catch (_error) {}
  }

  function showManualEnable() {
    if (active) setEnableButtonVisible(true);
  }

  function playActiveAlert() {
    if (!active) return Promise.resolve(false);
    setEnableButtonVisible(false);
    let attempt;
    try {
      attempt = audio.play();
    } catch (_error) {
      showManualEnable();
      return Promise.resolve(false);
    }
    if (!attempt || typeof attempt.then !== 'function') return Promise.resolve(true);
    return attempt.then(() => {
      if (!active) {
        resetAudio();
        return false;
      }
      setEnableButtonVisible(false);
      return true;
    }).catch(() => {
      showManualEnable();
      return false;
    });
  }

  function start(id) {
    const nextId = id == null ? null : String(id);
    const isNewAlert = !active || activeId !== nextId;
    active = true;
    activeId = nextId;
    if (isNewAlert) {
      try { audio.currentTime = 0; } catch (_error) {}
    }
    return playActiveAlert();
  }

  function stop(id) {
    if (!active) {
      setEnableButtonVisible(false);
      return false;
    }
    if (id != null && String(id) !== activeId) return false;
    active = false;
    activeId = null;
    setEnableButtonVisible(false);
    resetAudio();
    return true;
  }

  function enable() {
    if (!active) return Promise.resolve(false);
    audio.muted = false;
    return playActiveAlert();
  }

  function prime() {
    if (primed || priming || active) return Promise.resolve(false);
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

    const finish = () => {
      priming = false;
      primed = true;
      audio.muted = wasMuted;
      if (!active) resetAudio();
      else setEnableButtonVisible(false);
      return true;
    };
    const fail = () => {
      priming = false;
      audio.muted = wasMuted;
      showManualEnable();
      return false;
    };
    if (attempt && typeof attempt.then === 'function') return attempt.then(finish, fail);
    return Promise.resolve(finish());
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

  return {
    start,
    stop,
    enable,
    prime,
    isActive: () => active,
    getActiveId: () => activeId
  };
});
