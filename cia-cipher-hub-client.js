'use strict';

(function attachCiaCipherHub(root, factory) {
  const navigation = factory(root);
  if (root) {
    root.openCiaCipherHub = navigation.openCiaCipherHub;
    root.openCiaCipherTarget = navigation.openCiaCipherTarget;
    navigation.installKeyboardAccess();
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = { createCiaCipherHubNavigation: factory };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createCiaCipherHubNavigation(root) {
  function navElement(id) {
    return root && root.document && typeof root.document.getElementById === 'function'
      ? root.document.getElementById(id)
      : null;
  }

  function openCiaCipherHub() {
    if (!root || typeof root.showPane !== 'function') return false;
    root.showPane('cia-cipher-hub-view', navElement('cia-cipher-hub-nav'));
    return true;
  }

  function openCiaCipherTarget(target) {
    if (!root) return false;
    if (target === 'morse' && typeof root.openMorseTranslator === 'function') {
      root.openMorseTranslator();
      return true;
    }
    if (target === 'intelligence' && typeof root.showPane === 'function') {
      root.showPane('blackridge-cipher-view', navElement('blackridge-cipher-nav'));
      return true;
    }
    if (target === 'puzzle' && typeof root.openBlackridgePuzzles === 'function') {
      root.openBlackridgePuzzles(navElement('puzzles-nav'));
      return true;
    }
    return false;
  }

  function installKeyboardAccess() {
    const doc = root && root.document;
    if (!doc || typeof doc.getElementById !== 'function') return false;
    const attach = function attachKeyboardListener() {
      const nav = navElement('cia-cipher-hub-nav');
      if (!nav || nav.dataset.ciaCipherHubKeyboard === 'true') return;
      nav.dataset.ciaCipherHubKeyboard = 'true';
      nav.addEventListener('keydown', function onNavKeydown(event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openCiaCipherHub();
        }
      });
    };
    if (doc.readyState === 'loading' && typeof doc.addEventListener === 'function') {
      doc.addEventListener('DOMContentLoaded', attach, { once: true });
    } else {
      attach();
    }
    return true;
  }

  return { openCiaCipherHub, openCiaCipherTarget, installKeyboardAccess };
});