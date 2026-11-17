'use strict';

(function attachCiaCipherHub(root, factory) {
  const navigation = factory(root);
  if (root) {
    root.openCiaCipherHub = navigation.openCiaCipherHub;
    root.openCiaCipherTarget = navigation.openCiaCipherTarget;
    navigation.mountCipherPanes();
    navigation.installInlineNavigation();
    navigation.installToolSelector();
    navigation.installKeyboardAccess();
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = { createCiaCipherHubNavigation: factory };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createCiaCipherHubNavigation(root) {
  const PANE_IDS = Object.freeze({
    morse: 'morse-translator-view',
    intelligence: 'blackridge-cipher-view',
    puzzle: 'puzzles-view'
  });
  const TOOL_LABELS = Object.freeze({
    morse: 'شفرة مورس مفتوحة داخل القسم.',
    intelligence: 'الشفرة الاستخباراتية مفتوحة داخل القسم.',
    puzzle: 'شفرة البازل مفتوحة داخل القسم.'
  });

  function navElement(id) {
    return root && root.document && typeof root.document.getElementById === 'function'
      ? root.document.getElementById(id)
      : null;
  }

  function mountCipherPanes() {
    const host = navElement('cia-cipher-hub-tool-slot');
    if (!host || typeof host.appendChild !== 'function') return false;
    let mounted = 0;
    for (const paneId of Object.values(PANE_IDS)) {
      const pane = navElement(paneId);
      if (!pane) continue;
      if (pane.parentNode !== host) host.appendChild(pane);
      if (pane.classList && typeof pane.classList.remove === 'function') pane.classList.remove('active');
      mounted += 1;
    }
    return mounted === Object.keys(PANE_IDS).length;
  }

  function focusHubShell(paneId) {
    const hub = navElement('cia-cipher-hub-view');
    const nav = navElement('cia-cipher-hub-nav');
    const target = Object.keys(PANE_IDS).find((key) => PANE_IDS[key] === paneId);
    if (target) {
      const select = navElement('cia-cipher-hub-select');
      if (select) select.value = target;
      updateHubStatus(TOOL_LABELS[target]);
    }
    if (root && root.document && typeof root.document.querySelectorAll === 'function') {
      root.document.querySelectorAll('.nav-btn').forEach((item) => {
        if (item.classList) item.classList.remove('active');
      });
    }
    if (hub && hub.classList) hub.classList.add('active');
    if (nav && nav.classList) nav.classList.add('active');
  }

  function installInlineNavigation() {
    if (!root || typeof root.showPane !== 'function') return false;
    if (root.__ciaCipherHubShowPaneInstalled === true) return true;
    const originalShowPane = root.showPane;
    root.showPane = function showPaneWithinCiaCipherHub(paneId, button) {
      const result = originalShowPane.apply(this, arguments);
      if (Object.values(PANE_IDS).includes(paneId)) {
        const pane = navElement(paneId);
        if (pane && pane.classList && pane.classList.contains('active')) focusHubShell(paneId);
        else updateHubStatus('لم يُفتح النظام؛ راجع تنبيه الدخول والصلاحيات المطلوبة.');
      }
      return result;
    };
    root.__ciaCipherHubShowPaneInstalled = true;
    return true;
  }

  function updateHubStatus(message) {
    const status = navElement('cia-cipher-hub-status');
    if (status) status.textContent = message;
  }

  function openCiaCipherHub() {
    if (!root || typeof root.showPane !== 'function') return false;
    const select = navElement('cia-cipher-hub-select');
    if (select) select.value = '';
    updateHubStatus('اختر نظامًا من القائمة لعرضه داخل هذا القسم.');
    root.showPane('cia-cipher-hub-view', navElement('cia-cipher-hub-nav'));
    return true;
  }

  function openCiaCipherTarget(target) {
    if (!root || !Object.prototype.hasOwnProperty.call(PANE_IDS, target)) return false;
    mountCipherPanes();
    const select = navElement('cia-cipher-hub-select');
    if (select) select.value = target;
    updateHubStatus(TOOL_LABELS[target]);
    if (target === 'morse' && typeof root.openMorseTranslator === 'function') {
      root.openMorseTranslator();
    } else if (target === 'intelligence' && typeof root.showPane === 'function') {
      root.showPane(PANE_IDS.intelligence, navElement('blackridge-cipher-nav'));
    } else if (target === 'puzzle' && typeof root.openBlackridgePuzzles === 'function') {
      root.openBlackridgePuzzles(navElement('puzzles-nav'));
    } else {
      return false;
    }
    const pane = navElement(PANE_IDS[target]);
    if (!pane || !pane.classList || !pane.classList.contains('active')) {
      updateHubStatus('لم يُفتح النظام؛ راجع تنبيه الدخول والصلاحيات المطلوبة.');
    }
    return true;
  }

  function installToolSelector() {
    const select = navElement('cia-cipher-hub-select');
    if (!select || typeof select.addEventListener !== 'function' || select.dataset.ciaCipherHubReady === 'true') return false;
    select.dataset.ciaCipherHubReady = 'true';
    select.addEventListener('change', function onCipherSelectionChange() {
      if (!select.value) {
        openCiaCipherHub();
        return;
      }
      openCiaCipherTarget(select.value);
    });
    return true;
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

  return { openCiaCipherHub, openCiaCipherTarget, mountCipherPanes, installInlineNavigation, installToolSelector, installKeyboardAccess };
});
