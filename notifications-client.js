(function () {
  'use strict';

  const categories = [
    ['all', 'ALL'],
    ['critical', 'CRITICAL'],
    ['messages', 'MESSAGES'],
    ['sos', 'S.O.S'],
    ['operations', 'OPERATIONS'],
    ['finance', 'FINANCE'],
    ['system', 'SYSTEM']
  ];
  const state = {
    counts: {},
    category: 'all',
    mode: 'all',
    rows: [],
    offset: 0,
    hasMore: false,
    search: '',
    user: null,
    searchTimer: null,
    welcomeKey: ''
  };

  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const socket = () => window.blackRidgeSocket || null;
  const count = (key) => Number(state.counts[key] || 0);
  const message = (text) => {
    const node = document.getElementById('notification-feed');
    if (node) node.innerHTML = `<div class="notification-empty">${escapeHtml(text)}</div>`;
  };

  function buildUI() {
    const header = document.querySelector('.mobile-header');
    const userTag = document.getElementById('user-display-tag');
    if (header && userTag && !document.getElementById('notification-header-button')) {
      const button = document.createElement('button');
      button.id = 'notification-header-button';
      button.className = 'notification-header-button';
      button.type = 'button';
      button.setAttribute('aria-label', 'Open intelligence notifications');
      button.innerHTML = '<i class="fa-solid fa-bell"></i><span class="notification-button-label">INTEL</span><span class="notification-badge" id="notification-header-badge"></span>';
      button.addEventListener('click', () => openCenter('all'));
      userTag.parentNode.insertBefore(button, userTag);
    }

    const nav = document.querySelector('#sidebar .nav-list');
    if (nav && !document.getElementById('notification-nav-button')) {
      const item = document.createElement('li');
      item.id = 'notification-nav-button';
      item.className = 'nav-btn notification-nav-item';
      item.innerHTML = '<span class="notification-nav-label"><i class="fa-solid fa-bell"></i> BLACK RIDGE INTELLIGENCE</span><span class="notification-badge" id="notification-nav-badge"></span>';
      item.addEventListener('click', () => openCenter('all'));
      const firstPane = nav.children[0];
      nav.insertBefore(item, firstPane ? firstPane.nextSibling : null);
    }

    if (!document.getElementById('critical-alert-bar')) {
      const bar = document.createElement('button');
      bar.id = 'critical-alert-bar';
      bar.type = 'button';
      bar.setAttribute('aria-live', 'polite');
      bar.addEventListener('click', () => openCenter('critical'));
      if (header) header.insertAdjacentElement('afterend', bar);
    }

    if (!document.getElementById('notification-toast-stack')) {
      const stack = document.createElement('div');
      stack.id = 'notification-toast-stack';
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    if (!document.getElementById('notification-modal-overlay')) {
      const overlay = document.createElement('div');
      overlay.id = 'notification-modal-overlay';
      overlay.innerHTML = `
        <section class="notification-dialog" role="dialog" aria-modal="true" aria-labelledby="notification-dialog-title" dir="ltr">
          <header class="notification-dialog-header">
            <div><div class="notification-kicker">BLACK RIDGE // SECURE EVENT STREAM</div><h2 id="notification-dialog-title" class="notification-dialog-title">INTELLIGENCE CENTER</h2></div>
            <button class="notification-close" type="button" data-action="close" aria-label="Close">×</button>
          </header>
          <div class="notification-toolbar">
            <input id="notification-search" class="notification-search" type="search" maxlength="120" placeholder="Search name, public code, event, case or date" aria-label="Search notifications">
            <button class="notification-action" type="button" data-action="missed">WHAT DID I MISS?</button>
            <button class="notification-action" type="button" data-action="activity">MY ACTIVITY</button>
            <button class="notification-action" type="button" data-action="mark-all">MARK ALL AS READ</button>
          </div>
          <nav id="notification-tabs" class="notification-tabs" aria-label="Notification filters"></nav>
          <div id="notification-feed" class="notification-feed" role="list"></div>
          <button id="notification-load-more" class="notification-action notification-load-more" type="button" data-action="more">LOAD MORE EVENTS</button>
        </section>`;
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeCenter();
      });
      overlay.addEventListener('click', handlePanelClick);
      document.body.appendChild(overlay);
      const search = overlay.querySelector('#notification-search');
      search.addEventListener('input', () => {
        clearTimeout(state.searchTimer);
        state.search = search.value.trim();
        state.searchTimer = setTimeout(() => loadRows(true), 220);
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeCenter();
      });
    }
    if (!document.getElementById('notification-welcome-summary')) {
      const welcome = document.createElement('div');
      welcome.id = 'notification-welcome-summary';
      welcome.className = 'notification-welcome-summary';
      welcome.innerHTML = `
        <section class="notification-welcome-card" role="dialog" aria-modal="true" aria-labelledby="notification-welcome-title" dir="ltr">
          <div class="notification-kicker">BLACK RIDGE // ABSENCE BRIEF</div>
          <h2 id="notification-welcome-title">WELCOME BACK</h2>
          <p id="notification-welcome-copy"></p>
          <div id="notification-summary-grid" class="notification-summary-grid"></div>
          <div id="notification-attention-copy"></div>
          <div class="notification-welcome-actions">
            <button class="notification-action" type="button" data-action="review-missed">REVIEW INTELLIGENCE</button>
            <button class="notification-action" type="button" data-action="close-welcome">CLOSE</button>
          </div>
        </section>`;
      welcome.addEventListener('click', (event) => {
        if (event.target === welcome || event.target.closest('[data-action="close-welcome"]')) welcome.classList.remove('is-open');
        if (event.target.closest('[data-action="review-missed"]')) {
          welcome.classList.remove('is-open');
          openCenter('since');
        }
      });
      document.body.appendChild(welcome);
    }
    renderTabs();
  }

  function renderTabs() {
    const tabs = document.getElementById('notification-tabs');
    if (!tabs) return;
    tabs.innerHTML = categories.map(([key, label]) => `
      <button type="button" class="notification-tab${state.category === key ? ' is-active' : ''}" data-category="${key}">
        ${label}<span class="notification-tab-count">${count(key)}</span>
      </button>`).join('');
    tabs.querySelectorAll('[data-category]').forEach((button) => {
      button.addEventListener('click', () => {
        state.category = button.dataset.category;
        state.mode = 'all';
        renderTabs();
        loadRows(true);
      });
    });
  }

  function updateCounts(value) {
    if (!value || typeof value !== 'object') return;
    state.counts = { ...state.counts, ...value };
    const unread = count('unread');
    for (const id of ['notification-header-badge', 'notification-nav-badge']) {
      const badge = document.getElementById(id);
      if (!badge) continue;
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.classList.toggle('is-visible', unread > 0);
    }
    const critical = count('unreadCritical');
    const bar = document.getElementById('critical-alert-bar');
    if (bar) {
      bar.textContent = critical === 1
        ? '⚠ CRITICAL INTELLIGENCE — 1 UNREAD EVENT'
        : `⚠ CRITICAL INTELLIGENCE — ${critical} UNREAD EVENTS`;
      bar.classList.toggle('is-visible', critical > 0);
    }
    renderTabs();
  }

  function syncAppSession() {
    const getSession = window.blackRidgeGetNotificationSession;
    if (typeof getSession !== 'function') return null;
    try {
      const session = getSession();
      state.user = session?.user || null;
      return session;
    } catch (error) {
      return null;
    }
  }

  function openCenter(mode = 'all') {
    const session = syncAppSession();
    if (!state.user) {
      const auth = document.getElementById('passcode-modal');
      if (auth) auth.style.display = 'flex';
      return;
    }
    state.mode = mode === 'since' ? 'since' : mode === 'activity' ? 'activity' : 'all';
    state.category = mode === 'critical' ? 'critical' : 'all';
    state.search = '';
    const search = document.getElementById('notification-search');
    if (search) search.value = '';
    const title = document.getElementById('notification-dialog-title');
    if (title) title.textContent = mode === 'since' ? 'SINCE YOUR LAST SESSION' : mode === 'activity' ? 'MY ACTIVITY INTELLIGENCE' : 'INTELLIGENCE CENTER';
    document.getElementById('notification-modal-overlay')?.classList.add('is-open');
    renderTabs();
    if (!socket()?.connected || (session && (!session.authenticated || session.recovering))) {
      message('SECURE SESSION RECONNECTING — WAIT BEFORE LOADING NOTIFICATIONS.');
      return;
    }
    loadRows(true);
  }

  function closeCenter() {
    document.getElementById('notification-modal-overlay')?.classList.remove('is-open');
  }

  function formatDate(value) {
    if (!value) return 'SERVER TIME';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'SERVER TIME';
    return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderRows(append = false) {
    const feed = document.getElementById('notification-feed');
    if (!feed) return;
    const heading = state.mode === 'since' ? 'SINCE YOUR LAST SESSION' : 'MY ACTIVITY INTELLIGENCE // EVENT LOG';
    const headingHtml = `<div class="notification-feed-heading"><span>${heading}</span><span>${state.rows.length} LOADED</span></div>`;
    const rows = state.rows.map((row) => {
      const priority = ['CRITICAL', 'HIGH', 'NOTICE', 'SYSTEM'].includes(row.priority) ? row.priority : 'NOTICE';
      const isUnread = !row.readAt;
      const sourceName = row.metadata?.sourceName ? `${escapeHtml(row.metadata.sourceName)} · ` : '';
      const source = row.sourceCode ? `${sourceName}SOURCE #${escapeHtml(row.sourceCode)}` : 'BLACK RIDGE SYSTEM';
      const related = row.relatedId ? `REF ${escapeHtml(row.relatedId)}` : '';
      const stateLabel = row.acknowledgedAt ? 'ACKNOWLEDGED' : row.readAt ? 'SEEN' : row.status || 'SENT';
      return `<article class="notification-card${isUnread ? ' is-unread' : ''}" data-id="${escapeHtml(row.id)}" data-priority="${priority}" role="listitem">
        <div class="notification-card-head"><div class="notification-card-title">${escapeHtml(row.title || row.type)}</div><span class="notification-priority">${priority}</span></div>
        <div class="notification-card-message">${escapeHtml(row.message)}</div>
        <div class="notification-card-meta"><span>${escapeHtml(formatDate(row.createdAt))}</span><span>${source}</span>${related ? `<span>${related}</span>` : ''}<span>${escapeHtml(stateLabel)}</span></div>
        <div class="notification-card-actions">
          <button type="button" data-action="open" data-id="${escapeHtml(row.id)}">OPEN EVENT</button>
          ${isUnread ? `<button type="button" data-action="read" data-id="${escapeHtml(row.id)}">MARK AS READ</button>` : ''}
          ${priority === 'CRITICAL' && !row.acknowledgedAt ? `<button type="button" class="notification-ack-button" data-action="acknowledge" data-id="${escapeHtml(row.id)}">ACKNOWLEDGE</button>` : ''}
        </div>
      </article>`;
    }).join('');
    const empty = rows ? '' : '<div class="notification-empty">NO INTELLIGENCE RECORDS MATCH THIS FILTER.</div>';
    if (append) {
      if (!state.rows.length) feed.innerHTML = headingHtml + empty;
      else {
        const previousHeading = feed.querySelector('.notification-feed-heading');
        if (previousHeading) previousHeading.remove();
        feed.insertAdjacentHTML('afterbegin', headingHtml);
        feed.insertAdjacentHTML('beforeend', rows);
      }
    } else {
      feed.innerHTML = headingHtml + (rows || empty);
    }
    const more = document.getElementById('notification-load-more');
    if (more) more.classList.toggle('is-visible', state.hasMore);
  }

  function loadRows(reset = false) {
    const connection = socket();
    if (!state.user) {
      message('SIGN IN TO ACCESS YOUR PRIVATE INTELLIGENCE CENTER.');
      return;
    }
    if (!connection || !connection.connected) {
      message('SECURE SESSION RECONNECTING — WAIT BEFORE LOADING NOTIFICATIONS.');
      return;
    }
    if (reset) {
      state.offset = 0;
      state.rows = [];
    }
    const eventName = state.mode === 'since' ? 'notification:since' : 'notification:list';
    const payload = {
      category: state.category,
      search: state.search,
      limit: 20,
      offset: state.offset
    };
    connection.emit(eventName, payload, (result) => {
      if (!result || !result.ok) {
        message((result && result.message) || 'INTELLIGENCE FEED UNAVAILABLE.');
        return;
      }
      const incoming = Array.isArray(result.rows) ? result.rows : [];
      state.rows = reset ? incoming : state.rows.concat(incoming);
      state.offset = state.rows.length;
      state.hasMore = result.hasMore === true;
      if (result.counts) updateCounts(result.counts);
      renderRows(false);
    });
  }

  function showToast(row) {
    const stack = document.getElementById('notification-toast-stack');
    if (!stack || !state.user) return;
    const toast = document.createElement('button');
    toast.type = 'button';
    toast.className = 'notification-toast';
    toast.dataset.priority = row.priority || 'NOTICE';
    toast.innerHTML = `<strong>${escapeHtml(row.title || 'NEW INTELLIGENCE')}</strong><span>${escapeHtml(row.message || '')}</span>`;
    toast.addEventListener('click', () => {
      toast.remove();
      openCenter(row.priority === 'CRITICAL' ? 'critical' : 'all');
    });
    stack.prepend(toast);
    while (stack.children.length > 3) stack.lastElementChild.remove();
    setTimeout(() => toast.remove(), 9000);
  }

  function findRow(id) {
    return state.rows.find((row) => row.id === id);
  }

  function markRead(id, onDone) {
    const connection = socket();
    if (!connection) return;
    connection.emit('notification:read', { id }, (result) => {
      if (result?.ok && result.notification) {
        const index = state.rows.findIndex((row) => row.id === id);
        if (index >= 0) state.rows[index] = result.notification;
        renderRows(false);
      }
      if (typeof onDone === 'function') onDone(result);
    });
  }

  function openTarget(row) {
    const panes = {
      MESSAGE: 'chat',
      SOS: 'sos-alerts',
      SALARY: 'bank',
      FINANCE: 'bank',
      TRANSACTION: 'bank',
      OPERATION: 'operations',
      CASE: 'cases-vault',
      REPORT: 'reports',
      RANK: 'dashboard',
      PERMISSION: 'dashboard',
      PROFILE: 'dashboard',
      SECURITY: 'audit-panel',
      LOGIN: 'audit-panel'
    };
    const pane = panes[row.type];
    closeCenter();
    if (pane && typeof window.showPane === 'function') window.showPane(pane);
  }

  function handlePanelClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button) {
      const card = event.target.closest('.notification-card');
      if (card) {
        const row = findRow(card.dataset.id);
        if (row) markRead(row.id, () => openTarget(row));
      }
      return;
    }
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (action === 'close') closeCenter();
    if (action === 'missed') openCenter('since');
    if (action === 'activity') openCenter('activity');
    if (action === 'more') loadRows(false);
    if (action === 'mark-all') {
      socket()?.emit('notification:markAllRead', {}, (result) => {
        if (result?.ok) loadRows(true);
      });
    }
    if (action === 'read' && id) markRead(id);
    if (action === 'acknowledge' && id) {
      socket()?.emit('notification:acknowledge', { id }, (result) => {
        if (result?.ok && result.notification) {
          const index = state.rows.findIndex((row) => row.id === id);
          if (index >= 0) state.rows[index] = result.notification;
          renderRows(false);
        }
      });
    }
    if (action === 'open' && id) {
      const row = findRow(id);
      if (row) markRead(row.id, () => openTarget(row));
    }
  }

  function displayWelcome(summary, user) {
    if (!summary || !summary.total) return;
    const key = `${user?.id || ''}:${summary.since || ''}`;
    if (key === state.welcomeKey) return;
    state.welcomeKey = key;
    const rank = user?.rank || 'AGENT';
    const title = document.getElementById('notification-welcome-title');
    const copy = document.getElementById('notification-welcome-copy');
    const grid = document.getElementById('notification-summary-grid');
    const attention = document.getElementById('notification-attention-copy');
    if (title) title.textContent = `WELCOME BACK, ${rank}`;
    if (copy) copy.textContent = `${summary.total} intelligence event${summary.total === 1 ? '' : 's'} occurred since your last session.`;
    const labels = {
      MESSAGE: 'NEW MESSAGES',
      SOS: 'S.O.S',
      OPERATION: 'NEW OPERATIONS',
      SALARY: 'SALARY DEPOSITS',
      CASE: 'CASE FILES',
      REPORT: 'REPORTS',
      PROFILE: 'PROFILE UPDATES',
      RANK: 'RANK CHANGES',
      PERMISSION: 'ACCESS CHANGES',
      REQUEST: 'REQUESTS',
      LOGIN: 'SIGN-IN EVENTS',
      SECURITY: 'SECURITY EVENTS',
      SYSTEM: 'SYSTEM UPDATES'
    };
    const entries = Object.entries(summary.byType || {}).filter(([, amount]) => Number(amount) > 0);
    if (grid) grid.innerHTML = entries.map(([type, amount]) => `<div class="notification-summary-item">${escapeHtml(labels[type] || type)}<strong>${Number(amount)}</strong></div>`).join('');
    if (attention) {
      attention.innerHTML = Number(summary.attention) > 0
        ? `<p style="color:#fca5a5;font-size:.69rem;">${Number(summary.attention)} event${Number(summary.attention) === 1 ? '' : 's'} require your attention.</p>`
        : '';
    }
    document.getElementById('notification-welcome-summary')?.classList.add('is-open');
  }

  function clearNotificationSession() {
    state.user = null;
    state.rows = [];
    state.counts = {};
    updateCounts(state.counts);
    closeCenter();
    document.getElementById('notification-welcome-summary')?.classList.remove('is-open');
    const stack = document.getElementById('notification-toast-stack');
    if (stack) stack.textContent = '';
  }

  function installSocketHandlers() {
    const connection = socket();
    if (!connection || connection.__blackRidgeNotificationsInstalled) return;
    connection.__blackRidgeNotificationsInstalled = true;
    connection.on('notification:count', updateCounts);
    connection.on('notification:new', (row) => {
      if (!row || !state.user || row.userId !== state.user.id) return;
      state.counts.unread = count('unread') + (row.readAt ? 0 : 1);
      if (row.priority === 'CRITICAL' && !row.readAt) state.counts.unreadCritical = count('unreadCritical') + 1;
      updateCounts(state.counts);
      if (document.getElementById('notification-modal-overlay')?.classList.contains('is-open')) loadRows(true);
      showToast(row);
    });
    connection.on('auth:login:result', (result) => {
      if (!result?.ok || !result.user) {
        const session = syncAppSession();
        if (!session?.user || !session.authenticated) clearNotificationSession();
        return;
      }
      state.user = result.user;
      connection.emit('notification:count', {}, (response) => {
        if (response?.counts) updateCounts(response.counts);
      });
      if (!result.resumeSession) displayWelcome(result.welcomeBack, result.user);
      if (document.getElementById('notification-modal-overlay')?.classList.contains('is-open')) loadRows(true);
    });
    connection.on('disconnect', () => {
      const session = syncAppSession();
      if (!session?.user) {
        clearNotificationSession();
        return;
      }
      if (document.getElementById('notification-modal-overlay')?.classList.contains('is-open')) {
        message('SECURE SESSION RECONNECTING — WAIT BEFORE LOADING NOTIFICATIONS.');
      }
    });
    window.addEventListener('blackridge:logout', clearNotificationSession);
  }

  buildUI();
  installSocketHandlers();
})();

(function loadWorldCommandBattalionPhase2() {
  'use strict';
  if (window.__brWorldBattalionPhase2Loader) return;
  window.__brWorldBattalionPhase2Loader = true;
  const attach = () => {
    if (window.__brWorldBattalionPhase2Script) return;
    window.__brWorldBattalionPhase2Script = true;
    const script = document.createElement('script');
    script.src = '/world-command-battalions.js';
    script.async = true;
    script.onerror = () => { window.__brWorldBattalionPhase2Script = false; };
    document.head.appendChild(script);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach, { once: true });
  else attach();
})();