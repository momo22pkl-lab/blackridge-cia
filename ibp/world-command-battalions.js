(function () {
  'use strict';

  if (window.__blackRidgeBattalionPhase2) return;
  window.__blackRidgeBattalionPhase2 = true;

  const EMBLEMS = {
    SHIELD: '<path d="M24 3 41 9v13c0 11-7 18-17 23C14 40 7 33 7 22V9L24 3Z"/><path d="m15 24 6 6 12-13"/>',
    EAGLE: '<path d="M24 10 19 4l-2 13L5 12l7 16 12 13 12-13 7-16-12 5-2-13-5 6Z"/><path d="m12 28 12-6 12 6M24 22v19"/>',
    WOLF: '<path d="m8 7 11 5 5-5 5 5 11-5-3 15-7 13-6 5-6-5-7-13L8 7Z"/><path d="m16 22 5 2m11-2-5 2m-5 7 2 2 2-2"/>',
    LION: '<path d="m24 4 5 5 8-1 1 8 6 5-5 7-2 9-9 1-4 5-5-5-9-1-2-9-5-7 6-5 1-8 8 1 6-5Z"/><path d="m16 22 5 2m11-2-5 2m-5 7 2 2 2-2"/>',
    FALCON: '<path d="M6 13 20 17 24 5l4 12 14-4-11 13 5 12-12-7-12 7 5-12L6 13Z"/><path d="m24 18 7 2-7 4-7-4 7-2Z"/>',
    STAR: '<path d="m24 4 5.7 12 13.1 1.8-9.5 9.2 2.3 13L24 34l-11.6 6 2.3-13-9.5-9.2L18.3 16 24 4Z"/>',
    SWORD: '<path d="m30 7 8 8-19 19-8 2 2-8L32 9"/><path d="m27 12 9 9M12 34l-4 7m-1-7 7 1"/>',
    COMMAND: '<path d="M24 4 42 14v14L24 42 6 28V14L24 4Z"/><path d="M15 26V15l9-5 9 5v11l-9 6-9-6Zm9-16v22m-9-16 18 10m0-10L15 26"/>',
    SPECIAL: '<path d="M24 4 29 16l13-2-8 10 8 10-13-2-5 12-5-12-13 2 8-10-8-10 13 2 5-12Z"/><circle cx="24" cy="24" r="6"/>'
  };
  const EMBLEM_NAMES = {
    SHIELD: 'Shield', EAGLE: 'Eagle', WOLF: 'Wolf', LION: 'Lion',
    FALCON: 'Falcon', STAR: 'Star', SWORD: 'Sword',
    COMMAND: 'Command Crest', SPECIAL: 'Special Unit Crest'
  };
  const state = {
    page: '',
    battalions: [],
    canCreate: false,
    selectedId: '',
    mode: '',
    polygon: [],
    viewport: { x: 0, y: 0, w: 1000, h: 700 },
    loading: false,
    refreshing: false,
    timer: null,
    search: ''
  };
  const socket = () => window.blackRidgeSocket || null;
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
  const safeColor = (value) => /^#[\da-f]{6}$/i.test(String(value || '')) ? value : '#c6a86a';
  const selected = () => state.battalions.find((unit) => String(unit.id) === String(state.selectedId)) || null;
  const pointText = (point) => point && Number.isFinite(Number(point.x)) ? 'GRID ' + Math.round(point.x) + ' / ' + Math.round(point.y) : 'NOT SET';
  const dateText = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString();
  };
  const emblemSvg = (name, color, size) => {
    const id = String(name || 'SHIELD').toUpperCase();
    return '<svg class="br2-emblem" width="' + (size || 36) + '" height="' + (size || 36) + '" viewBox="0 0 48 48" aria-hidden="true">' +
      '<g fill="' + safeColor(color) + '" stroke="#f1e6cc" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">' +
      (EMBLEMS[id] || EMBLEMS.SHIELD) + '</g></svg>';
  };
  const styles = [
    '.br2{--br2-ink:#edf0e9;--br2-muted:#9ca69f;--br2-line:rgba(206,216,200,.13);--br2-panel:#101713;--br2-panel2:#141d18;color:var(--br2-ink);font-family:Inter,Arial,sans-serif}',
    '.br2 *{box-sizing:border-box}.br2-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px;flex-wrap:wrap}',
    '.br2-kicker{font:500 10px/1.3 "DM Mono",monospace;letter-spacing:.18em;color:#9da99d;text-transform:uppercase}.br2-title{font-size:19px;letter-spacing:.04em;margin:5px 0}.br2-subtitle{font-size:12px;color:var(--br2-muted);line-height:1.65;margin:0}',
    '.br2-button{border:1px solid var(--br2-line);background:#19231c;color:#e8ece5;padding:9px 12px;border-radius:7px;font:600 10px "DM Mono",monospace;letter-spacing:.08em;cursor:pointer;transition:.18s}.br2-button:hover{border-color:#a8b993;color:#fff;transform:translateY(-1px)}.br2-button.primary{background:#bda36b;color:#141913;border-color:#bda36b}.br2-button.danger{color:#ffb4aa}.br2-button:disabled{opacity:.45;cursor:not-allowed;transform:none}',
    '.br2-chip{display:inline-flex;align-items:center;gap:7px;padding:5px 8px;border:1px solid var(--br2-line);border-radius:99px;color:#cbd0c5;font:500 9px "DM Mono",monospace;letter-spacing:.08em}.br2-dot{width:7px;height:7px;border-radius:50%;background:#77d0a3;display:inline-block}.br2-dot.alert{background:#f49b67}.br2-dot.standby{background:#86928b}',
    '.br2-layout{display:grid;grid-template-columns:minmax(245px,.78fr) minmax(0,1.6fr);gap:14px;align-items:start}.br2-card{background:linear-gradient(145deg,#141d18,#0f1511);border:1px solid var(--br2-line);border-radius:10px;overflow:hidden}.br2-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 14px;border-bottom:1px solid var(--br2-line)}.br2-card-head h2{font-size:11px;letter-spacing:.14em;margin:0}.br2-card-body{padding:14px}.br2-list{display:flex;flex-direction:column;gap:7px;padding:9px}.br2-list-item{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:9px;width:100%;text-align:left;border:1px solid transparent;background:#131a15;color:inherit;padding:9px;border-radius:8px;cursor:pointer}.br2-list-item:hover,.br2-list-item.active{background:#1b251d;border-color:var(--br2-line)}.br2-list-copy{min-width:0}.br2-list-copy b,.br2-list-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.br2-list-copy b{font-size:11px}.br2-list-copy small{color:var(--br2-muted);font:9px "DM Mono",monospace;margin-top:4px}.br2-code{font:10px "DM Mono",monospace;color:#d0c49f}.br2-status{font:9px "DM Mono",monospace;letter-spacing:.08em;color:#c7d1c7}',
    '.br2-empty{padding:26px 16px;color:var(--br2-muted);font-size:12px;text-align:center;border:1px dashed var(--br2-line);border-radius:8px;line-height:1.7}.br2-info-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.br2-info{padding:10px;border:1px solid var(--br2-line);border-radius:7px;background:rgba(255,255,255,.015);min-width:0}.br2-info span{display:block;color:var(--br2-muted);font:9px "DM Mono",monospace;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px}.br2-info b{display:block;font-size:11px;line-height:1.5;overflow-wrap:anywhere}.br2-section{margin-top:14px}.br2-section-title{font:500 9px "DM Mono",monospace;color:#abb6a8;letter-spacing:.16em;border-bottom:1px solid var(--br2-line);padding-bottom:7px;margin:0 0 8px}.br2-member{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(206,216,200,.07);font-size:11px}.br2-member small{color:var(--br2-muted);font:9px "DM Mono",monospace}.br2-online{color:#80d7a5}.br2-report{padding:7px 0;border-bottom:1px solid rgba(206,216,200,.07);font-size:10px;line-height:1.5}.br2-report small{display:block;color:var(--br2-muted);font:9px "DM Mono",monospace;margin-top:3px}',
    '.br2-map-toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:11px}.br2-map-layout{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(235px,.75fr);gap:12px;align-items:start}.br2-map-frame{position:relative;overflow:hidden;border:1px solid rgba(199,213,184,.18);border-radius:10px;background:#17211d;min-height:420px;box-shadow:0 18px 45px rgba(0,0,0,.2)}.br2-map-svg{display:block;width:100%;height:auto;min-height:420px;touch-action:none;cursor:grab}.br2-map-svg.dragging{cursor:grabbing}.br2-map-grid{stroke:#d1d9c9;stroke-opacity:.09}.br2-map-water{fill:#1d3335}.br2-map-land{fill:#28342b;stroke:#88927f;stroke-opacity:.38;stroke-width:2}.br2-map-park{fill:#354638;stroke:#8a9d7e;stroke-opacity:.25}.br2-map-road-major{fill:none;stroke:#d2c59c;stroke-opacity:.6;stroke-width:5}.br2-map-road-minor{fill:none;stroke:#b7c0ad;stroke-opacity:.34;stroke-width:2}.br2-map-road-line{fill:none;stroke:#243029;stroke-width:1}.br2-map-label{fill:#b2bdad;font:11px \"DM Mono\",monospace;letter-spacing:2px;opacity:.8}.br2-map-water-label{fill:#8eafae;font:10px \"DM Mono\",monospace;letter-spacing:3px;opacity:.75}.br2-map-coord{fill:#b5c1b4;font:9px \"DM Mono\",monospace;opacity:.8}.br2-marker{cursor:pointer}.br2-marker:hover{filter:brightness(1.25)}.br2-marker-label{font:700 11px Inter,Arial,sans-serif;paint-order:stroke;stroke:#101613;stroke-width:3px;stroke-linejoin:round}.br2-trail{fill:none;stroke-width:4;stroke-linecap:round;stroke-dasharray:7 6;opacity:.6}.br2-area{stroke-width:2;stroke-dasharray:5 4}.br2-map-hint{min-height:25px;color:#d0c49f;font:10px \"DM Mono\",monospace;padding:7px 2px}.br2-map-panel{max-height:680px;overflow:auto}.br2-zoom{margin-left:auto;display:flex;gap:5px}',
    '.br2-modal{position:fixed;z-index:99999;inset:0;background:rgba(3,6,4,.78);display:flex;align-items:center;justify-content:center;padding:18px}.br2-modal[hidden]{display:none}.br2-modal-card{width:min(720px,100%);max-height:92vh;overflow:auto;background:#111914;border:1px solid rgba(209,218,200,.22);border-radius:12px;box-shadow:0 20px 80px #000;padding:18px}.br2-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.br2-field{display:flex;flex-direction:column;gap:6px;color:#b4beb3;font:9px \"DM Mono\",monospace;letter-spacing:.08em}.br2-field.full{grid-column:1/-1}.br2-input,.br2-select,.br2-textarea{width:100%;border:1px solid var(--br2-line);border-radius:6px;background:#0c120e;color:#f0f1e9;padding:9px;font:12px Inter,Arial,sans-serif;min-height:37px}.br2-textarea{min-height:82px;resize:vertical}.br2-input[type=color]{padding:3px;height:38px}.br2-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:15px}.br2-form-error{color:#ff9e91;font-size:11px;min-height:18px;margin-top:7px}.br2-toast{position:fixed;z-index:100000;bottom:20px;left:50%;transform:translateX(-50%);background:#16211a;color:#e7ede2;border:1px solid rgba(209,218,200,.2);border-radius:8px;padding:11px 15px;font-size:12px;box-shadow:0 9px 30px #000;max-width:min(90vw,520px)}.br2-toast[hidden]{display:none}.br2-loading{color:#bdc7b8;font:10px \"DM Mono\",monospace;padding:16px;text-align:center}',
    '@media(max-width:950px){.br2-layout,.br2-map-layout{grid-template-columns:1fr}.br2-map-frame,.br2-map-svg{min-height:330px}.br2-map-panel{max-height:none}}@media(max-width:580px){.br2-info-grid,.br2-form-grid{grid-template-columns:1fr}.br2-field.full{grid-column:auto}.br2-map-frame,.br2-map-svg{min-height:270px}.br2-toolbar{align-items:flex-start}}'
  ].join('');

  function injectStyles() {
    if (document.getElementById('br2-styles')) return;
    const style = document.createElement('style');
    style.id = 'br2-styles';
    style.textContent = styles;
    document.head.appendChild(style);
  }
  function notify(message, bad) {
    let toast = document.getElementById('br2-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'br2-toast';
      toast.className = 'br2-toast';
      toast.hidden = true;
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.borderColor = bad ? 'rgba(255,134,118,.55)' : 'rgba(141,211,159,.4)';
    toast.hidden = false;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { toast.hidden = true; }, 3600);
  }
  function rpc(eventName, payload) {
    return new Promise((resolve, reject) => {
      const channel = socket();
      const session = typeof window.blackRidgeGetNotificationSession === 'function' ? window.blackRidgeGetNotificationSession() : null;
      if (!channel || !channel.connected) return reject(new Error('الاتصال الآمن غير متاح. سجّل الدخول وانتظر اتصال Socket.IO.'));
      if (!session || !session.user || !session.authenticated) return reject(new Error('يلزم تسجيل الدخول إلى الحساب المعتمد قبل فتح بيانات الكتائب.'));
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('انتهت مهلة استجابة الخادم. أعد المحاولة بعد استقرار الاتصال.'));
      }, 12000);
      channel.emit(eventName, payload || {}, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (!result || result.ok !== true) return reject(new Error(result && result.message || 'تعذر تنفيذ الطلب.'));
        resolve(result);
      });
    });
  }
  function contentNode() { return document.getElementById('brw-page-content'); }
  function sideNode() { return document.getElementById('brw-side-panels'); }
  function header(page) {
    const title = document.getElementById('brw-page-title');
    const description = document.getElementById('brw-page-description');
    const live = document.querySelector('.brw-live-label');
    const content = contentNode();
    const side = sideNode();
    if (!content || !title || !description) return false;
    state.page = page;
    title.textContent = page === 'map' ? 'LOS SANTOS BATTALION MAP' : 'BATTALION COMMAND';
    description.textContent = page === 'map' ? 'خريطة الكتائب · Movement, deployment and authorized battalion locations.' : 'Battalion organization, commanders, members and unit records.';
    if (live) live.textContent = 'LIVE · SERVER-SCOPED DATA';
    document.querySelectorAll('.brw-nav-button').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-br-page') === page);
    });
    if (side) side.innerHTML = '';
    return true;
  }
  async function refresh(showError) {
    if (state.loading) return;
    state.loading = true;
    try {
      const result = await rpc('ibp:phase2:list', {});
      state.battalions = Array.isArray(result.battalions) ? result.battalions : [];
      state.canCreate = !!result.canCreate;
      if (!state.battalions.some((unit) => String(unit.id) === String(state.selectedId))) {
        state.selectedId = state.battalions[0] ? state.battalions[0].id : '';
      }
      if (state.page === 'map') renderMap();
      if (state.page === 'battalions') renderBattalions();
      renderSideSummary();
    } catch (error) {
      if (showError) notify(error.message, true);
      const content = contentNode();
      if (content && state.page) content.innerHTML = '<div class="br2 br2-empty">' + escapeHtml(error.message) + '</div>';
      if (state.page === 'map') renderMapSide();
    } finally {
      state.loading = false;
    }
  }
  function renderSideSummary() {
    const side = sideNode();
    if (!side || !state.page) return;
    const active = state.battalions.filter((unit) => unit.status !== 'ARCHIVED').length;
    const online = state.battalions.reduce((sum, unit) => sum + Number(unit.onlineMembers || 0), 0);
    side.innerHTML = '<article class="brw-panel brw-side-panel"><header class="brw-panel-head"><div class="brw-side-title"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i><h2>BATTALION NETWORK</h2></div><span class="brw-row-status">' + active + '</span></header><div class="br2 brw-panel-body"><div class="br2-info-grid">' +
      '<div class="br2-info"><span>VISIBLE UNITS</span><b>' + active + '</b></div><div class="br2-info"><span>ONLINE MEMBERS</span><b>' + online + '</b></div>' +
      '<div class="br2-info"><span>ACCESS SCOPE</span><b>SERVER VERIFIED</b></div><div class="br2-info"><span>LIVE SYNC</span><b>SOCKET.IO</b></div></div><p class="br2-subtitle" style="margin-top:12px">Only battalions and records within your authorized scope are returned.</p></div></article>';
  }
  function statusTone(status) {
    const value = String(status || '').toUpperCase();
    return value === 'ALERT' ? 'alert' : value === 'STANDBY' ? 'standby' : '';
  }
  function battalionList() {
    const rows = state.battalions.filter((unit) => {
      const q = state.search.toLowerCase();
      return !q || [unit.name, unit.code, unit.sector, unit.commanderCode].some((value) => String(value || '').toLowerCase().includes(q));
    });
    if (!rows.length) return '<div class="br2-empty">No battalions are visible in this account’s authorized scope.</div>';
    return '<div class="br2-list">' + rows.map((unit) => {
      const color = safeColor(unit.color);
      return '<button class="br2-list-item ' + (String(unit.id) === String(state.selectedId) ? 'active' : '') + '" type="button" data-br2-select="' + escapeHtml(unit.id) + '" style="border-left:3px solid ' + color + '">' +
        '<span>' + emblemSvg(unit.emblem, color, 30) + '</span><span class="br2-list-copy"><b>' + escapeHtml(unit.name || unit.code) + '</b><small>' + escapeHtml(unit.code) + ' · ' + escapeHtml(unit.sector || 'SECTOR —') + '</small></span>' +
        '<span class="br2-status"><i class="br2-dot ' + statusTone(unit.status) + '"></i> ' + escapeHtml(unit.status || 'ACTIVE') + '</span></button>';
    }).join('') + '</div>';
  }
  function memberRows(unit) {
    const people = Array.isArray(unit.members) ? unit.members : [];
    if (!people.length) return '<div class="br2-empty">No visible members are assigned to this battalion.</div>';
    return people.map((person) => '<div class="br2-member"><span>' + escapeHtml(person.name || person.publicCode || person.code || 'MEMBER') +
      (String(person.publicCode || person.code || '').toUpperCase() === String(unit.commanderCode || '').toUpperCase() ? ' <small>· COMMANDER</small>' : '') +
      (String(person.publicCode || person.code || '').toUpperCase() === String(unit.deputyCode || '').toUpperCase() ? ' <small>· DEPUTY</small>' : '') +
      '</span><small class="' + (person.online ? 'br2-online' : '') + '">' + (person.online ? 'ONLINE' : 'OFFLINE') + '</small></div>').join('');
  }
  function unitDetails(unit, mapMode) {
    if (!unit) return '<div class="br2-empty">Select a battalion to view its authorized command panel.</div>';
    const area = unit.operationArea ? (unit.operationArea.type === 'CIRCLE' ? 'CIRCLE · RADIUS ' + unit.operationArea.radius : 'POLYGON · ' + (unit.operationArea.points || []).length + ' POINTS') : 'NOT SET';
    const location = pointText(unit.mapPosition);
    const operation = unit.currentOperation ? escapeHtml(unit.currentOperation.name) + ' · ' + escapeHtml(unit.currentOperation.status) : 'NO ACTIVE OPERATION';
    const reports = Array.isArray(unit.reports) && unit.reports.length
      ? unit.reports.map((report) => '<div class="br2-report"><b>' + escapeHtml(report.title) + '</b><small>' + escapeHtml(report.classification) + ' · ' + dateText(report.createdAt) + '</small></div>').join('')
      : '<div class="br2-subtitle">No linked battalion reports in the visible scope.</div>';
    const move = unit.lastMovement
      ? escapeHtml(unit.lastMovement.actorCode || '—') + ' · ' + dateText(unit.lastMovement.at) + '<br><small>FROM ' + escapeHtml(pointText(unit.lastMovement.from)) + ' → TO ' + escapeHtml(pointText(unit.lastMovement.to)) + '</small>'
      : 'NO RECORDED MOVEMENT';
    return '<div class="br2-card-head"><div><div class="br2-kicker">BATTALION COMMAND</div><h2 class="br2-title">' + escapeHtml(unit.name || unit.code) + '</h2><p class="br2-subtitle">' + escapeHtml(unit.code) + ' · ' + escapeHtml(unit.sector || 'SECTOR —') + '</p></div>' + emblemSvg(unit.emblem, unit.color, 46) + '</div>' +
      '<div class="br2-card-body"><div class="br2-info-grid">' +
      '<div class="br2-info"><span>COMMANDER</span><b>' + escapeHtml(unit.commanderName || unit.commanderCode || '—') + '</b></div><div class="br2-info"><span>DEPUTY</span><b>' + escapeHtml(unit.deputyName || unit.deputyCode || '—') + '</b></div>' +
      '<div class="br2-info"><span>COLOR / EMBLEM</span><b><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + safeColor(unit.color) + '"></span> ' + escapeHtml(EMBLEM_NAMES[unit.emblem] || 'Shield') + '</b></div><div class="br2-info"><span>ONLINE MEMBERS</span><b>' + Number(unit.onlineMembers || 0) + ' / ' + Number(unit.memberCount || 0) + '</b></div>' +
      '<div class="br2-info"><span>CURRENT LOCATION</span><b>' + escapeHtml(location) + '</b></div><div class="br2-info"><span>AREA OF OPERATION</span><b>' + escapeHtml(area) + '</b></div>' +
      '<div class="br2-info"><span>CURRENT OPERATION</span><b>' + operation + '</b></div><div class="br2-info"><span>RADIO</span><b>' + escapeHtml(unit.radioChannel || '—') + '</b></div>' +
      '<div class="br2-info"><span>STATUS</span><b><i class="br2-dot ' + statusTone(unit.status) + '"></i> ' + escapeHtml(unit.status || 'ACTIVE') + '</b></div><div class="br2-info"><span>LAST UPDATE</span><b>' + dateText(unit.updatedAt) + '</b></div></div>' +
      (unit.description ? '<div class="br2-section"><h3 class="br2-section-title">BATTALION DESCRIPTION</h3><div class="br2-subtitle">' + escapeHtml(unit.description) + '</div></div>' : '') +
      '<div class="br2-section"><h3 class="br2-section-title">LAST MOVEMENT · ACTOR & TIME</h3><div class="br2-subtitle">' + move + '</div></div>' +
      '<div class="br2-section"><h3 class="br2-section-title">BATTALION MEMBERS</h3>' + memberRows(unit) + '</div>' +
      '<div class="br2-section"><h3 class="br2-section-title">LINKED BATTALION REPORTS</h3>' + reports + '</div>' +
      (unit.canManage ? '<div class="br2-section br2-toolbar"><button class="br2-button primary" type="button" data-br2-action="edit">EDIT BATTALION</button>' +
        (mapMode ? '<button class="br2-button" type="button" data-br2-action="set-location">SET BATTALION LOCATION</button><button class="br2-button" type="button" data-br2-action="start-circle">DRAW CIRCLE AREA</button><button class="br2-button" type="button" data-br2-action="start-polygon">DRAW POLYGON AREA</button>' +
          (unit.operationArea ? '<button class="br2-button danger" type="button" data-br2-action="clear-area">CLEAR AREA</button>' : '') : '') +
        (mapMode && unit.operationArea && unit.operationArea.type === 'POLYGON' ? '<button class="br2-button" type="button" data-br2-action="start-polygon">REDRAW POLYGON</button>' : '') +
        '</div>' : '') +
      (mapMode && state.mode ? '<div class="br2-map-hint">' + escapeHtml(modeHint()) + '</div>' : '') +
      (mapMode && state.mode === 'circle' ? '<label class="br2-field br2-section">AREA RADIUS · ' + Number(document.getElementById('br2-radius') && document.getElementById('br2-radius').value || 85) + '<input id="br2-radius" class="br2-input" type="range" min="20" max="300" value="85"></label>' : '') +
      (mapMode && state.mode === 'polygon' ? '<div class="br2-section br2-toolbar"><span class="br2-chip">' + state.polygon.length + ' POINTS</span><button class="br2-button primary" type="button" data-br2-action="finish-polygon"' + (state.polygon.length < 3 ? ' disabled' : '') + '>SAVE POLYGON</button><button class="br2-button" type="button" data-br2-action="cancel-draw">CANCEL</button></div>' : '') +
      (mapMode && !unit.canManage ? '<div class="br2-map-hint">READ ONLY · Location and area editing is restricted to this battalion’s commander and authorized command.</div>' : '') +
      (mapMode ? '<div class="br2-section"><button class="br2-button" type="button" data-br2-action="open-command">OPEN BATTALION COMMAND</button></div>' : '') +
      '</div>';
  }
  function renderBattalions() {
    if (!header('battalions')) return;
    const content = contentNode();
    const current = selected();
    content.innerHTML = '<div class="br2"><div class="br2-toolbar"><div><div class="br2-kicker">BATTALION ORGANIZATION</div><p class="br2-subtitle">Only unit records available to your account are shown.</p></div>' +
      '<div class="br2-toolbar"><input class="br2-input" style="width:190px" type="search" data-br2-search placeholder="Search units" value="' + escapeHtml(state.search) + '">' +
      (state.canCreate ? '<button class="br2-button primary" type="button" data-br2-action="create">CREATE BATTALION</button>' : '') + '</div></div>' +
      '<div class="br2-layout"><section class="br2-card"><div class="br2-card-head"><h2>VISIBLE BATTALIONS</h2><span class="br2-chip">' + state.battalions.length + ' UNITS</span></div>' + battalionList() + '</section>' +
      '<section class="br2-card" id="br2-detail">' + unitDetails(current, false) + '</section></div></div>';
    renderSideSummary();
  }
  function mapBase() {
    return '<svg id="br2-map-svg" class="br2-map-svg" viewBox="0 0 1000 700" role="img" aria-label="Los Santos battalion movement map">' +
      '<defs><pattern id="br2-map-grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" class="br2-map-grid" fill="none"/></pattern><linearGradient id="br2-map-shade" x2="0" y2="1"><stop stop-color="#344238"/><stop offset="1" stop-color="#202c25"/></linearGradient></defs>' +
      '<rect width="1000" height="700" fill="#1b3032"/><rect width="1000" height="700" fill="url(#br2-map-grid)"/>' +
      '<path class="br2-map-land" fill="url(#br2-map-shade)" d="M0 130 72 119 118 92 166 110 207 87 251 105 301 74 345 101 390 81 440 107 487 91 530 118 582 96 623 117 669 93 715 115 762 85 809 112 853 91 901 118 946 102 1000 129V700H0Z"/>' +
      '<path class="br2-map-park" d="m110 282 72-61 88 19 23 83-44 56-101-5-51-42Zm479-119 72-26 58 41-8 86-65 34-68-46Zm65 290 67-27 50 46-15 74-73 18-49-47Z"/>' +
      '<path class="br2-map-road-major" d="M43 494 164 450 279 464 383 408 500 425 609 377 720 395 843 342 960 358M102 585 208 540 320 554 428 505 546 523 655 486 777 506 900 466M230 143 257 246 295 350 279 490 317 655M415 127 398 230 432 333 412 441 451 576M604 133 574 249 614 357 588 475 633 625M788 128 748 232 782 334 749 462 795 612"/>' +
      '<path class="br2-map-road-line" d="M43 494 164 450 279 464 383 408 500 425 609 377 720 395 843 342 960 358M102 585 208 540 320 554 428 505 546 523 655 486 777 506 900 466"/>' +
      '<path class="br2-map-road-minor" d="M53 300 159 274 269 294 371 254 478 283 579 239 691 259 803 220 918 247M80 380 188 351 298 376 405 332 515 365 623 324 737 353 848 301 958 322M124 655 223 618 334 633 444 585 560 604 671 566 786 588 895 551M153 175 354 190 518 167 710 197 899 167M186 687 372 676 538 668 713 678 905 650"/>' +
      '<text class="br2-map-water-label" x="52" y="55">PACIFIC COAST</text><text class="br2-map-label" x="108" y="340">VESPUCCI</text><text class="br2-map-label" x="287" y="280">LITTLE SEOUL</text><text class="br2-map-label" x="405" y="368">DOWNTOWN</text><text class="br2-map-label" x="580" y="280">EAST LOS SANTOS</text><text class="br2-map-label" x="714" y="456">MIRROR PARK</text><text class="br2-map-label" x="830" y="270">VINEWOOD</text><text class="br2-map-label" x="524" y="624">AIRPORT CORRIDOR</text>' +
      '<text class="br2-map-coord" x="20" y="680">LOS SANTOS · BATTALION GRID</text><text class="br2-map-coord" x="875" y="680">NORTH ↑</text>' +
      '<rect id="br2-map-hit" x="0" y="0" width="1000" height="700" fill="transparent" pointer-events="all"/><g id="br2-areas" pointer-events="none"></g><g id="br2-trails" pointer-events="none"></g><g id="br2-operations" pointer-events="none"></g><g id="br2-markers"></g><g id="br2-draft" pointer-events="none"></g></svg>';
  }
  function areaMarkup(unit) {
    if (!unit.operationArea) return '';
    const color = safeColor(unit.color);
    const area = unit.operationArea;
    if (area.type === 'CIRCLE' && area.center) {
      return '<circle class="br2-area" cx="' + Number(area.center.x) + '" cy="' + Number(area.center.y) + '" r="' + Number(area.radius) + '" fill="' + color + '" fill-opacity=".16" stroke="' + color + '"/>';
    }
    if (area.type === 'POLYGON' && Array.isArray(area.points) && area.points.length > 2) {
      return '<polygon class="br2-area" points="' + area.points.map((point) => Number(point.x) + ',' + Number(point.y)).join(' ') + '" fill="' + color + '" fill-opacity=".16" stroke="' + color + '"/>';
    }
    return '';
  }
  function renderMapLayers() {
    const areas = document.getElementById('br2-areas');
    const trails = document.getElementById('br2-trails');
    const ops = document.getElementById('br2-operations');
    const markers = document.getElementById('br2-markers');
    const draft = document.getElementById('br2-draft');
    if (!areas || !trails || !ops || !markers || !draft) return;
    areas.innerHTML = state.battalions.map(areaMarkup).join('');
    trails.innerHTML = state.battalions.map((unit) => {
      const color = safeColor(unit.color);
      return (unit.movementHistory || []).slice(-4).map((move) => move.from && move.to
        ? '<path class="br2-trail" stroke="' + color + '" d="M' + move.from.x + ' ' + move.from.y + ' L' + move.to.x + ' ' + move.to.y + '"/>' : '').join('');
    }).join('');
    ops.innerHTML = state.battalions.map((unit) => {
      const op = unit.currentOperation;
      const pos = op && op.position;
      if (!pos) return '';
      return '<g transform="translate(' + Number(pos.x) + ' ' + Number(pos.y) + ')"><circle r="10" fill="#111914" stroke="' + safeColor(unit.color) + '" stroke-width="2"/><path d="M-4 0h8M0-4v8" stroke="' + safeColor(unit.color) + '" stroke-width="2"/><title>' + escapeHtml(op.name) + '</title></g>';
    }).join('');
    markers.innerHTML = state.battalions.map((unit) => {
      if (!unit.mapPosition) return '';
      const pos = unit.mapPosition;
      const color = safeColor(unit.color);
      const selectedClass = String(unit.id) === String(state.selectedId) ? ' selected' : '';
      return '<g class="br2-marker' + selectedClass + '" data-br2-unit="' + escapeHtml(unit.id) + '" transform="translate(' + Number(pos.x) + ' ' + Number(pos.y) + ')">' +
        '<circle r="22" fill="' + color + '" fill-opacity=".13" stroke="' + color + '" stroke-opacity=".72" stroke-width="1.5"/>' +
        '<circle r="15" fill="#101713" stroke="' + color + '" stroke-width="2"/>' +
        '<g transform="translate(-10 -10) scale(.42)">' + (EMBLEMS[String(unit.emblem || '').toUpperCase()] || EMBLEMS.SHIELD) + '</g>' +
        '<circle cx="13" cy="-13" r="4" fill="' + (unit.status === 'ALERT' ? '#fa8d6b' : unit.status === 'STANDBY' ? '#929d94' : '#84d6a6') + '" stroke="#101713" stroke-width="2"/>' +
        '<text class="br2-marker-label" x="0" y="35" text-anchor="middle" fill="' + color + '">' + escapeHtml(unit.name || unit.code) + '</text><title>' + escapeHtml(unit.code) + ' · ' + escapeHtml(unit.status) + '</title></g>';
    }).join('');
    const pts = state.polygon.map((point) => Number(point.x) + ',' + Number(point.y)).join(' ');
    draft.innerHTML = state.mode === 'polygon' && state.polygon.length
      ? '<polyline points="' + pts + '" fill="none" stroke="#f3e6bd" stroke-width="3" stroke-dasharray="6 5"/>' +
        state.polygon.map((point) => '<circle cx="' + point.x + '" cy="' + point.y + '" r="5" fill="#f3e6bd"/>').join('')
      : '';
  }
  function mapPoint(svg, event) {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const position = point.matrixTransform(matrix.inverse());
    return { x: Math.max(0, Math.min(1000, Math.round(position.x))), y: Math.max(0, Math.min(700, Math.round(position.y))) };
  }
  function modeHint() {
    if (state.mode === 'location') return 'SET BATTALION LOCATION · Select a point on the map.';
    if (state.mode === 'circle') return 'AREA OF OPERATION · Choose a radius, then select a center point.';
    if (state.mode === 'polygon') return 'AREA OF OPERATION · Click to add vertices; save after at least three points.';
    return '';
  }
  async function saveLocation(unit, point) {
    if (!unit || !unit.canManage) return notify('This battalion is read-only for your account.', true);
    try {
      await rpc('ibp:phase2:location', { battalionId: unit.id, position: point });
      state.mode = '';
      state.polygon = [];
      notify('Battalion location saved and shared with authorized users.');
      await refresh(false);
    } catch (error) { notify(error.message, true); }
  }
  async function saveArea(unit, area) {
    if (!unit || !unit.canManage) return notify('This battalion is read-only for your account.', true);
    try {
      await rpc('ibp:phase2:area', Object.assign({ battalionId: unit.id }, area));
      state.mode = '';
      state.polygon = [];
      notify('Battalion area saved and shared with authorized users.');
      await refresh(false);
    } catch (error) { notify(error.message, true); }
  }
  function attachMap(svg) {
    let drag = null;
    let moved = false;
    svg.addEventListener('wheel', (event) => {
      event.preventDefault();
      const point = mapPoint(svg, event);
      if (!point) return;
      const factor = event.deltaY < 0 ? .84 : 1.19;
      const old = state.viewport;
      const w = Math.max(280, Math.min(1000, old.w * factor));
      const h = w * .7;
      state.viewport = { x: point.x - (point.x - old.x) * (w / old.w), y: point.y - (point.y - old.y) * (h / old.h), w, h };
      svg.setAttribute('viewBox', [state.viewport.x, state.viewport.y, w, h].join(' '));
    }, { passive: false });
    svg.addEventListener('pointerdown', (event) => {
      if (event.target.closest('[data-br2-unit]')) return;
      drag = { x: event.clientX, y: event.clientY, start: Object.assign({}, state.viewport) };
      moved = false;
    });
    svg.addEventListener('pointermove', (event) => {
      if (!drag || !(event.buttons & 1)) return;
      const rect = svg.getBoundingClientRect();
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      state.viewport.x = drag.start.x - dx / rect.width * drag.start.w;
      state.viewport.y = drag.start.y - dy / rect.height * drag.start.h;
      svg.setAttribute('viewBox', [state.viewport.x, state.viewport.y, state.viewport.w, state.viewport.h].join(' '));
      svg.classList.toggle('dragging', moved);
    });
    svg.addEventListener('pointerup', () => {
      drag = null;
      setTimeout(() => { moved = false; svg.classList.remove('dragging'); }, 0);
    });
    svg.addEventListener('pointercancel', () => { drag = null; moved = false; });
    svg.addEventListener('click', async (event) => {
      const marker = event.target.closest('[data-br2-unit]');
      if (marker) {
        state.selectedId = marker.getAttribute('data-br2-unit');
        renderMap();
        return;
      }
      if (moved) return;
      if (!state.mode) return;
      const unit = selected();
      if (!unit || !unit.canManage) return notify('Select a battalion you are authorized to manage.', true);
      const point = mapPoint(svg, event);
      if (!point) return;
      if (state.mode === 'location') return saveLocation(unit, point);
      if (state.mode === 'circle') {
        const radiusInput = document.getElementById('br2-radius');
        return saveArea(unit, { type: 'CIRCLE', center: point, radius: Number(radiusInput && radiusInput.value || 85) });
      }
      if (state.mode === 'polygon') {
        state.polygon.push(point);
        renderMapLayers();
        const count = document.querySelector('.br2-map-panel .br2-chip');
        if (count && count.parentElement) count.parentElement.innerHTML = '<span class="br2-chip">' + state.polygon.length + ' POINTS</span><button class="br2-button primary" type="button" data-br2-action="finish-polygon"' + (state.polygon.length < 3 ? ' disabled' : '') + '>SAVE POLYGON</button><button class="br2-button" type="button" data-br2-action="cancel-draw">CANCEL</button>';
      }
    });
  }
  function renderMapSide() {
    const panel = document.getElementById('br2-map-panel');
    if (!panel) return;
    const unit = selected();
    const options = state.battalions.map((item) => '<option value="' + escapeHtml(item.id) + '"' + (String(item.id) === String(state.selectedId) ? ' selected' : '') + '>' + escapeHtml(item.code + ' · ' + (item.name || item.code)) + '</option>').join('');
    panel.innerHTML = '<div class="br2-card-head"><div><div class="br2-kicker">MAP ACCESS</div><h2>AUTHORIZED BATTALIONS</h2></div></div><div class="br2-card-body">' +
      (state.battalions.length ? '<label class="br2-field">SELECT BATTALION<select class="br2-select" id="br2-map-select">' + options + '</select></label>' : '<div class="br2-empty">No battalion data is visible in your account’s authorized scope.</div>') +
      '<div class="br2-map-hint" id="br2-map-hint">' + escapeHtml(state.mode ? modeHint() : 'Select a marker or unit to view its battalion panel.') + '</div></div>' +
      (unit ? '<section class="br2-card" style="margin-top:10px">' + unitDetails(unit, true) + '</section>' : '');
  }
  function renderMap() {
    if (!header('map')) return;
    const content = contentNode();
    content.innerHTML = '<div class="br2"><div class="br2-toolbar"><div><div class="br2-kicker">LOS SANTOS BATTALION MAP</div><p class="br2-subtitle">خريطة الكتائب · Pan, zoom, locations, areas and movement trails.</p></div><span class="br2-chip"><i class="br2-dot"></i> SOCKET.IO · AUTHORIZED DATA</span></div>' +
      '<div class="br2-map-toolbar"><button class="br2-button" type="button" data-br2-action="zoom-in">ZOOM IN</button><button class="br2-button" type="button" data-br2-action="zoom-out">ZOOM OUT</button><button class="br2-button" type="button" data-br2-action="reset-map">RESET VIEW</button><div class="br2-zoom"><span class="br2-chip">' + state.battalions.length + ' VISIBLE UNITS</span></div></div>' +
      '<div class="br2-map-layout"><div><div class="br2-map-frame">' + mapBase() + '</div><div class="br2-map-hint" id="br2-map-mode-hint">' + escapeHtml(state.mode ? modeHint() : 'Select a battalion marker to open its command panel. Use wheel or drag to navigate.') + '</div></div>' +
      '<aside class="br2-card br2-map-panel" id="br2-map-panel"></aside></div></div>';
    const svg = document.getElementById('br2-map-svg');
    svg.setAttribute('viewBox', [state.viewport.x, state.viewport.y, state.viewport.w, state.viewport.h].join(' '));
    renderMapLayers();
    renderMapSide();
    attachMap(svg);
    renderSideSummary();
  }
  function field(name, label, value, type, required, full) {
    return '<label class="br2-field' + (full ? ' full' : '') + '">' + label +
      '<input class="br2-input" name="' + name + '" type="' + (type || 'text') + '" value="' + escapeHtml(value || '') + '"' + (required ? ' required' : '') + '></label>';
  }
  function openEditor(unit) {
    const editing = !!unit;
    let modal = document.getElementById('br2-editor');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'br2-editor';
      modal.className = 'br2-modal';
      modal.hidden = true;
      document.body.appendChild(modal);
    }
    const emblemOptions = Object.keys(EMBLEM_NAMES).map((id) => '<option value="' + id + '"' + (String(unit && unit.emblem || 'SHIELD') === id ? ' selected' : '') + '>' + EMBLEM_NAMES[id] + '</option>').join('');
    const currentMembers = unit && Array.isArray(unit.members) ? unit.members.map((person) => person.publicCode || person.code).filter(Boolean).join('\n') : '';
    modal.innerHTML = '<section class="br2-modal-card" role="dialog" aria-modal="true" aria-labelledby="br2-editor-title"><div class="br2-card-head"><div><div class="br2-kicker">BATTALION RECORD</div><h2 class="br2-title" id="br2-editor-title">' + (editing ? 'EDIT BATTALION' : 'CREATE BATTALION') + '</h2></div><button class="br2-button" type="button" data-br2-action="close-editor">CLOSE</button></div>' +
      '<form id="br2-battalion-form" class="br2-card-body"><div class="br2-form-grid">' +
      field('name', 'BATTALION NAME', unit && (unit.name || unit.code), 'text', true) +
      field('code', 'BATTALION CODE', unit && unit.code, 'text', !editing) +
      (editing ? '' : field('commanderCode', 'BATTALION COMMANDER · PUBLIC CODE', '', 'text', true)) +
      (editing ? '' : field('deputyCode', 'DEPUTY COMMANDER · PUBLIC CODE', '', 'text', false)) +
      (editing ? '' : field('sector', 'SECTOR', '', 'text', true)) +
      (editing ? '' : '<label class="br2-field">STATUS<select class="br2-select" name="status"><option>ACTIVE</option><option>ALERT</option><option>STANDBY</option></select></label>') +
      '<label class="br2-field">BATTALION COLOR<input class="br2-input" name="color" type="color" value="' + safeColor(unit && unit.color) + '"></label>' +
      '<label class="br2-field">BATTALION EMBLEM<select class="br2-select" name="emblem">' + emblemOptions + '</select></label>' +
      (editing ? '' : field('radioChannel', 'RADIO CHANNEL', '', 'text', false)) +
      (editing ? '' : '<label class="br2-field full">DESCRIPTION<textarea class="br2-textarea" name="description"></textarea></label><label class="br2-field full">MEMBER PUBLIC CODES · ONE PER LINE<textarea class="br2-textarea" name="memberCodes" placeholder="Optional; commander and deputy are included automatically"></textarea></label>') +
      (editing ? '<label class="br2-field">RADIO CHANNEL<input class="br2-input" name="radioChannel" value="' + escapeHtml(unit.radioChannel || '') + '"></label>' +
        '<label class="br2-field">STATUS<select class="br2-select" name="status"><option' + (unit.status === 'ACTIVE' ? ' selected' : '') + '>ACTIVE</option><option' + (unit.status === 'ALERT' ? ' selected' : '') + '>ALERT</option><option' + (unit.status === 'STANDBY' ? ' selected' : '') + '>STANDBY</option></select></label>' +
        '<label class="br2-field full">DESCRIPTION<textarea class="br2-textarea" name="description">' + escapeHtml(unit.description || '') + '</textarea></label>' +
        '<label class="br2-field full">MEMBER PUBLIC CODES · ONE PER LINE<textarea class="br2-textarea" name="memberCodes">' + escapeHtml(currentMembers) + '</textarea></label>' : '') +
      '</div><div class="br2-form-error" id="br2-form-error"></div><div class="br2-form-actions"><button class="br2-button" type="button" data-br2-action="close-editor">CANCEL</button><button class="br2-button primary" type="submit">' + (editing ? 'SAVE BATTALION' : 'CREATE BATTALION') + '</button></div></form></section>';
    modal.hidden = false;
  }
  function closeEditor() {
    const modal = document.getElementById('br2-editor');
    if (modal) modal.hidden = true;
  }
  async function submitEditor(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    const editing = !!selected();
    const error = document.getElementById('br2-form-error');
    if (error) error.textContent = '';
    try {
      if (editing) {
        delete values.code;
        await rpc('ibp:phase2:update', Object.assign({ battalionId: selected().id }, values));
        notify('Battalion record updated.');
      } else {
        await rpc('ibp:phase2:create', values);
        notify('Battalion created and saved.');
      }
      closeEditor();
      await refresh(false);
    } catch (reason) {
      if (error) error.textContent = reason.message;
    }
  }
  async function action(name, target) {
    const unit = selected();
    if (name === 'create') return openEditor(null);
    if (name === 'edit') return unit && unit.canManage ? openEditor(unit) : notify('You cannot manage this battalion.', true);
    if (name === 'close-editor') return closeEditor();
    if (name === 'open-command') {
      state.mode = '';
      return renderBattalions();
    }
    if (name === 'set-location') {
      if (!unit || !unit.canManage) return notify('You cannot move this battalion.', true);
      state.mode = 'location'; state.polygon = []; renderMap();
      return notify('Choose a point on the map to save the new location.');
    }
    if (name === 'start-circle') {
      if (!unit || !unit.canManage) return notify('You cannot edit this battalion area.', true);
      state.mode = 'circle'; state.polygon = []; renderMap();
      return notify('Choose a center point; set the radius in the battalion panel.');
    }
    if (name === 'start-polygon') {
      if (!unit || !unit.canManage) return notify('You cannot edit this battalion area.', true);
      state.mode = 'polygon'; state.polygon = []; renderMap();
      return notify('Click the map to add polygon vertices; save at least three points.');
    }
    if (name === 'finish-polygon') {
      if (!unit || state.polygon.length < 3) return;
      return saveArea(unit, { type: 'POLYGON', points: state.polygon.slice() });
    }
    if (name === 'cancel-draw') {
      state.mode = ''; state.polygon = []; return renderMap();
    }
    if (name === 'clear-area') {
      if (!unit || !unit.canManage || !window.confirm('Clear this battalion’s saved area of operation?')) return;
      return saveArea(unit, { clear: true });
    }
    if (name === 'zoom-in' || name === 'zoom-out') {
      const svg = document.getElementById('br2-map-svg');
      if (!svg) return;
      const factor = name === 'zoom-in' ? .8 : 1.25;
      const old = state.viewport;
      const w = Math.max(280, Math.min(1000, old.w * factor));
      const h = w * .7;
      state.viewport = { x: old.x + (old.w - w) / 2, y: old.y + (old.h - h) / 2, w, h };
      svg.setAttribute('viewBox', [state.viewport.x, state.viewport.y, w, h].join(' '));
      return;
    }
    if (name === 'reset-map') {
      state.viewport = { x: 0, y: 0, w: 1000, h: 700 };
      const svg = document.getElementById('br2-map-svg');
      if (svg) svg.setAttribute('viewBox', '0 0 1000 700');
      return;
    }
  }
  function onClick(event) {
    const pageButton = event.target.closest('[data-br-page]');
    if (pageButton) {
      const page = pageButton.getAttribute('data-br-page');
      if (page === 'battalions' || page === 'map') {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        if (page === 'map') renderMap(); else renderBattalions();
        refresh(false);
      }
      return;
    }
    const selectButton = event.target.closest('[data-br2-select]');
    if (selectButton) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      state.selectedId = selectButton.getAttribute('data-br2-select');
      if (state.page === 'map') renderMap(); else renderBattalions();
      return;
    }
    const button = event.target.closest('[data-br2-action]');
    if (!button) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    action(button.getAttribute('data-br2-action'), button);
  }
  function onSubmit(event) {
    if (!event.target || event.target.id !== 'br2-battalion-form') return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    submitEditor(event.target);
  }
  function onInput(event) {
    if (event.target.matches('[data-br2-search]')) {
      state.search = event.target.value || '';
      const active = document.activeElement === event.target;
      renderBattalions();
      const search = document.querySelector('[data-br2-search]');
      if (search && active) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
    }
    if (event.target.id === 'br2-radius') {
      const label = event.target.closest('.br2-field');
      if (label) label.firstChild.textContent = 'AREA RADIUS · ' + event.target.value;
    }
  }
  function mount() {
    if (!contentNode() || document.__br2Mounted) return false;
    document.__br2Mounted = true;
    injectStyles();
    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('input', onInput, true);
    const channel = socket();
    if (channel) {
      channel.on('state:update', () => {
        if (state.page === 'map' || state.page === 'battalions') {
          clearTimeout(state.timer);
          state.timer = setTimeout(() => refresh(false), 250);
        }
      });
      channel.on('connect', () => {
        if (state.page === 'map' || state.page === 'battalions') refresh(false);
      });
    }
    return true;
  }
  if (!mount()) {
    const observer = new MutationObserver(() => {
      if (mount()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 30000);
  }
})();
