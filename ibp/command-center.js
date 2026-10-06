'use strict';

const COMMAND_NAV = [
  { path: '/dashboard', key: 'dashboard', ar: 'COMMAND', en: 'COMMAND', icon: 'command' },
  { path: '/command/sectors', key: 'command-sectors', ar: 'SECTORS', en: 'SECTORS', icon: 'sectors' },
  { path: '/command/battalions', key: 'command-battalions', ar: 'BATTALIONS', en: 'BATTALIONS', icon: 'units' },
  { path: '/command/map', key: 'command-map', ar: 'LOS SANTOS MAP', en: 'LOS SANTOS MAP', icon: 'map' },
  { path: '/command/operations', key: 'command-operations', ar: 'OPERATIONS', en: 'OPERATIONS', icon: 'operations' },
  { path: '/command/sos', key: 'command-sos', ar: 'SOS', en: 'SOS', icon: 'sos' },
  { path: '/command/reports', key: 'command-reports', ar: 'REPORTS', en: 'REPORTS', icon: 'reports' },
  { path: '/command/personnel', key: 'command-personnel', ar: 'PERSONNEL', en: 'PERSONNEL', icon: 'personnel' },
  { path: '/command/messages', key: 'command-messages', ar: 'MESSAGES', en: 'MESSAGES', icon: 'messages' },
  { path: '/command/bank', key: 'command-bank', ar: 'BANK', en: 'BANK', icon: 'bank' },
  { path: '/command/intelligence', key: 'command-intelligence', ar: 'INTELLIGENCE', en: 'INTELLIGENCE', icon: 'intelligence' }
];

const ICONS = {
  command: '<path d="M12 2.5 20 6v5.2c0 5-3.4 8.4-8 10.3-4.6-1.9-8-5.3-8-10.3V6l8-3.5Z"/><path d="m9 12 2 2 4-4"/>',
  sectors: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/>',
  units: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.5 7.7 7.5 4.4 7.5-4.4M12 12v9"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15m6-12v15"/>',
  operations: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2M12 1v2m11 9h-2M3 12H1"/>',
  sos: '<path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/>',
  reports: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 12h6m-6 4h6"/>',
  personnel: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.3-3.4 2.7-5.5 6.5-5.5s6.2 2.1 6.5 5.5M16 5.2a3.5 3.5 0 0 1 0 6.6m1.2 3c2.7.7 4.1 2.4 4.3 5.2"/>',
  messages: '<path d="M4 5h16v12H9l-5 4V5Z"/><path d="M8 9h8m-8 4h5"/>',
  bank: '<path d="m3 9 9-6 9 6H3Zm2 2v7m4-7v7m6-7v7m4-7v7M3 21h18"/>',
  intelligence: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 4.5 1.5c-1.1 1.3-2 1.3-2 3m0 3h.01"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  signal: '<path d="M3 9a14 14 0 0 1 18 0M6.5 12.5a8.5 8.5 0 0 1 11 0M10 16a3.2 3.2 0 0 1 4 0m-2 4h.01"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/>',
  pin: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  shield: '<path d="M12 2.5 20 6v5.2c0 5-3.4 8.4-8 10.3-4.6-1.9-8-5.3-8-10.3V6l8-3.5Z"/><path d="M8.5 12h7"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>'
};

const TITLES = {
  'command-sectors': ['SECTORS', 'القطاعات', 'Sector directory and command boundaries.'],
  'command-battalions': ['BATTALIONS', 'الكتائب', 'Battalion command pages will be built in a later phase.'],
  'command-map': ['LOS SANTOS MAP', 'خريطة لوس سانتوس', 'Tactical map tools are reserved for a later phase.'],
  'command-operations': ['OPERATIONS', 'العمليات', 'Operations planning and records will be built in a later phase.'],
  'command-sos': ['SOS', 'نداءات الاستغاثة', 'SOS intake and response workflows are reserved for a later phase.'],
  'command-reports': ['REPORTS', 'التقارير', 'Report authoring and review are reserved for a later phase.'],
  'command-personnel': ['PERSONNEL', 'الأفراد', 'Personnel directory and assignment tools are reserved for a later phase.'],
  'command-messages': ['MESSAGES', 'الرسائل', 'Command messaging is reserved for a later phase.'],
  'command-bank': ['BANK', 'البنك', 'Bank and finance tools are reserved for a later phase.'],
  'command-intelligence': ['INTELLIGENCE', 'الاستخبارات', 'Intelligence workflows are reserved for a later phase.']
};

const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const tr = (ar, en) => '<span data-ibp-ar="' + esc(ar) + '" data-ibp-en="' + esc(en) + '">' + esc(ar) + '</span>';
const svg = (name, extra = '') => '<svg class="br-icon ' + extra + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || ICONS.command) + '</svg>';

function renderGlobe() {
  return '<div class="br-globe-wrap" aria-label="Decorative 3D globe preview">' +
    '<div class="br-orbit br-orbit-a"></div><div class="br-orbit br-orbit-b"></div><div class="br-orbit br-orbit-c"></div>' +
    '<div class="br-globe"><div class="br-globe-shine"></div><svg class="br-world" viewBox="0 0 360 360" role="img" aria-label="Stylized world globe">' +
    '<defs><clipPath id="br-sphere-clip"><circle cx="180" cy="180" r="160"/></clipPath><radialGradient id="br-sea" cx="38%" cy="31%"><stop stop-color="#19435b"/><stop offset=".52" stop-color="#0b2337"/><stop offset="1" stop-color="#030c16"/></radialGradient><radialGradient id="br-globe-shade" cx="35%" cy="28%"><stop stop-color="#fff" stop-opacity=".18"/><stop offset=".52" stop-color="#59c9ed" stop-opacity=".02"/><stop offset="1" stop-color="#000" stop-opacity=".68"/></radialGradient><pattern id="br-grid" width="34" height="34" patternUnits="userSpaceOnUse"><path d="M34 0H0V34" fill="none" stroke="#61c5ec" stroke-opacity=".15" stroke-width=".8"/></pattern></defs>' +
    '<g clip-path="url(#br-sphere-clip)"><circle cx="180" cy="180" r="160" fill="url(#br-sea)"/><path class="br-continent" d="m44 92 27-22 20 5 13-14 25 7 8 17-10 11 15 11-3 21-17 4-7 17-20 4-5 15-15 4-13-15-17-4-6-27-14-11 4-23Zm60 82 15 4 8 16-8 18 9 19-7 19-15-3-11-20-2-25-10-17Zm63-94 20-16 34 3 19 12 27 1 12 16-13 14-22-4-10 18-18 4-5 20-14 9-14-13-19-2-4-18-17-10 6-20-12-8Zm33 97 14-9 18 10 6 17-9 17-5 30-14 18-12-10 4-22-13-18 3-19Zm75-81 19-3 14 12 20 2 15 18-5 17-14 1-6 16-15 3-13-13-17-3-3-19-13-9Zm-9 104 13-8 16 10 9 17-13 18-19 1-9-15Z" fill="#73bcae" fill-opacity=".72" stroke="#a8e2d1" stroke-opacity=".55" stroke-width="1.1"/>' +
    '<path d="M20 180h320M180 20v320M33 122h294M33 238h294M84 34v292M276 34v292" stroke="#67c9ef" stroke-opacity=".32" stroke-width=".75"/><ellipse cx="180" cy="180" rx="82" ry="160" fill="none" stroke="#72d4f5" stroke-opacity=".24"/><ellipse cx="180" cy="180" rx="132" ry="160" fill="none" stroke="#72d4f5" stroke-opacity=".16"/><circle cx="180" cy="180" r="160" fill="url(#br-grid)"/><circle cx="180" cy="180" r="160" fill="url(#br-globe-shade)"/></g>' +
    '<circle cx="180" cy="180" r="160" fill="none" stroke="#81ddff" stroke-opacity=".78" stroke-width="1.5"/><circle cx="180" cy="180" r="165" fill="none" stroke="#44bce9" stroke-opacity=".2"/>' +
    '</svg><div class="br-globe-core"><span class="br-crest">' + svg('shield') + '</span><strong>BLACK RIDGE</strong><small>WORLD COMMAND</small></div></div>' +
    '<span class="br-orbit-dot br-dot-one"></span><span class="br-orbit-dot br-dot-two"></span><span class="br-orbit-dot br-dot-three"></span></div>';
}

function renderNode(item, className) {
  return '<a class="br-node ' + className + '" href="' + item.path + '" style="--node-accent:' + item.color + '">' +
    '<span class="br-node-icon">' + svg(item.icon) + '</span><span class="br-node-copy"><b>' + esc(item.title) + '</b><small>' + esc(item.subtitle) + '</small></span></a>';
}

function renderDashboard() {
  const nodes = [
    { title: 'SECTOR COMMAND', subtitle: 'CENTRAL COMMAND', icon: 'command', color: '#d5ad62', path: '/command/sectors', cls: 'br-node-sector' },
    { title: 'BATTALION ALPHA', subtitle: 'ALPHA SECTOR', icon: 'units', color: '#65c9ee', path: '/command/battalions', cls: 'br-node-alpha' },
    { title: 'BATTALION BRAVO', subtitle: 'BRAVO SECTOR', icon: 'units', color: '#67d5b1', path: '/command/battalions', cls: 'br-node-bravo' },
    { title: 'BATTALION DELTA', subtitle: 'DELTA SECTOR', icon: 'units', color: '#eb7078', path: '/command/battalions', cls: 'br-node-delta' },
    { title: 'BATTALION CHARLIE', subtitle: 'CHARLIE SECTOR', icon: 'units', color: '#a996e8', path: '/command/battalions', cls: 'br-node-charlie' },
    { title: 'OPERATIONS', subtitle: 'ACTIVE MISSIONS', icon: 'operations', color: '#e59b58', path: '/command/operations', cls: 'br-node-ops' },
    { title: 'PERSONNEL', subtitle: 'ROSTER OVERVIEW', icon: 'personnel', color: '#75b9d9', path: '/command/personnel', cls: 'br-node-personnel' },
    { title: 'INTELLIGENCE', subtitle: 'ANALYSIS & RECON', icon: 'intelligence', color: '#61c9e8', path: '/command/intelligence', cls: 'br-node-intel' }
  ];

  return '<div class="br-dashboard">' +
    '<section class="br-dashboard-grid">' +
    '<div class="br-center-column"><section class="br-command-stage"><div class="br-stage-meta"><span>GLOBAL OPERATIONS / LOS SANTOS</span><span class="br-preview-tag">PHASE 1 · UI PREVIEW</span></div>' +
    renderGlobe() + nodes.map((node) => renderNode(node, node.cls)).join('') +
    '<div class="br-coordinate br-coordinate-a">34°03′N / 118°15′W</div><div class="br-coordinate br-coordinate-b">SECURE CHANNEL · DEMO VIEW</div></section>' +
    '<section class="br-lower-grid"><article class="br-panel br-map-panel"><div class="br-panel-head"><div><span class="br-panel-kicker">TACTICAL OVERVIEW</span><h2>' + tr('خريطة لوس سانتوس', 'LOS SANTOS MAP') + '</h2></div><a class="br-view-link" href="/command/map">' + tr('معاينة', 'PREVIEW') + ' ' + svg('arrow') + '</a></div>' +
    '<a class="br-map-preview" href="/command/map" aria-label="Open Los Santos map placeholder"><svg viewBox="0 0 720 270" role="img" aria-label="Decorative tactical map preview"><defs><pattern id="br-map-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#27404a" stroke-width=".8" stroke-dasharray="2 4"/></pattern></defs><rect width="720" height="270" fill="#07121b"/><rect width="720" height="270" fill="url(#br-map-grid)"/><path class="br-map-water" d="M0 0h720v39l-48 15-38-10-44 20-58-13-51 20-69-15-59 17-52-10-41 18-58-11-50 17-45-12-44 19V0Z"/><path class="br-map-district" d="m61 108 58-31 61 12 42-30 53 19 53-24 60 23 54-13 51 30 56-5 61 39-15 45-45 30-17 39-63 4-36-19-54 27-51-21-49 23-43-31-44 17-46-24-52 3-26-40-42-10-22-45Z"/><path class="br-map-road" d="m40 180 92-25 83 18 70-39 77 17 82-39 78 26 104-26M92 218l85-23 76 18 87-19 75 24 94-24 102 25M174 87l28 75 35 75m81-131 9 73 47 72m94-127-31 61 38 62m83-98-17 49 25 48"/><path class="br-map-road minor" d="m118 113 75 22 64-5 62 27 63-16 71 29 65-12m-292 61 32-39 74-14 47 19 49-6m-109-97 9 55m-63 62 14-45m205 53 10-54"/>' +
    '<g class="br-map-pins"><circle cx="207" cy="153" r="5"/><circle cx="320" cy="139" r="5"/><circle cx="434" cy="172" r="5"/><circle cx="531" cy="128" r="5"/><circle cx="360" cy="211" r="5"/></g><text x="37" y="250">LOS SANTOS · GRID 04 / 27</text></svg><span class="br-map-legend"><i></i> PREVIEW MAP · NO LIVE UNITS</span></a></article>' +
    '<article class="br-panel br-report-panel"><div class="br-panel-head"><div><span class="br-panel-kicker">INTELLIGENCE DESK</span><h2>' + tr('أحدث التقارير', 'LATEST REPORTS') + '</h2></div><a class="br-view-link" href="/command/reports">' + tr('الكل', 'ALL') + ' ' + svg('arrow') + '</a></div>' +
    '<div class="br-report-list"><div class="br-report-row br-table-label"><span>REF / TITLE</span><span>STATUS</span><span>PRIORITY</span></div>' +
    '<div class="br-report-row"><span><b>RPT-026-0412</b><small>Operation overview</small></span><em class="br-status status-demo">DEMO</em><i class="br-priority priority-high">HIGH</i></div>' +
    '<div class="br-report-row"><span><b>RPT-026-0411</b><small>Sector intelligence</small></span><em class="br-status status-demo">DEMO</em><i class="br-priority priority-medium">MED</i></div>' +
    '<div class="br-report-row"><span><b>RPT-026-0410</b><small>Field situation</small></span><em class="br-status status-demo">DEMO</em><i class="br-priority priority-low">LOW</i></div></div>' +
    '<div class="br-demo-note">' + svg('shield') + '<span>' + tr('بيانات تجريبية للعرض فقط — لا توجد تقارير حية في المرحلة الأولى.', 'Illustrative preview only — no live reports are connected in Phase 1.') + '</span></div></article></section></div>' +
    '<aside class="br-side-panels">' +
    panel('operations', 'ACTIVE OPERATIONS', '<span class="br-panel-count">04</span>', '<div class="br-compact-list">' +
      compactRow('OP', 'Operation Nightfall', 'Los Santos · Preview', 'ONGOING', 'green') + compactRow('OP', 'Operation Steel', 'Paleto Bay · Preview', 'ONGOING', 'green') + compactRow('OP', 'Operation Horizon', 'San Andreas · Preview', 'PLANNED', 'gold') + compactRow('OP', 'Operation Viper', 'El Burro Heights · Preview', 'PLANNED', 'gold') + '</div>', '/command/operations') +
    panel('sos', 'CRITICAL SOS', '<span class="br-panel-count danger">02</span>', '<div class="br-compact-list">' +
      compactRow('!', 'S.O.S #7842', 'Los Santos · Demo item', 'DEMO', 'red') + compactRow('!', 'S.O.S #7839', 'Sandy Shores · Demo item', 'DEMO', 'red') + '</div>', '/command/sos') +
    panel('reports', 'RECENT REPORTS', '<span class="br-panel-count">05</span>', '<div class="br-compact-list">' +
      compactRow('R', 'RPT-2026-0412', 'Operation report', 'DEMO', 'cyan') + compactRow('R', 'RPT-2026-0411', 'Intelligence report', 'DEMO', 'gold') + compactRow('R', 'RPT-2026-0410', 'Field report', 'DEMO', 'cyan') + '</div>', '/command/reports') +
    panel('personnel', 'ONLINE PERSONNEL', '<span class="br-panel-count">12 / 48</span>', '<div class="br-compact-list">' +
      compactRow('AG', 'AG-217', 'Los Santos', 'DEMO', 'green') + compactRow('AG', 'AG-104', 'Sandy Shores', 'DEMO', 'green') + compactRow('AG', 'AG-332', 'Paleto Bay', 'DEMO', 'green') + compactRow('AG', 'AG-276', 'Los Santos', 'DEMO', 'green') + '</div>', '/command/personnel') +
    '<div class="br-quote-panel"><span class="br-quote-line"></span><p>“INTELLIGENCE IS NOT WHAT YOU KNOW.<br>IT IS WHAT YOU DO WITH WHAT YOU KNOW.”</p><small>— BLACK RIDGE</small><span class="br-quote-city"></span></div>' +
    '</aside></section></div>';
}

function compactRow(code, title, detail, status, tone) {
  return '<div class="br-compact-row"><span class="br-mini-icon tone-' + esc(tone) + '">' + esc(code) + '</span><span class="br-compact-copy"><b>' + esc(title) + '</b><small>' + esc(detail) + '</small></span><em class="br-status tone-status-' + esc(tone) + '">' + esc(status) + '</em></div>';
}

function panel(iconName, title, count, body, href) {
  return '<article class="br-panel br-side-panel"><div class="br-panel-head"><div class="br-panel-title">' + svg(iconName) + '<h2>' + esc(title) + '</h2>' + count + '</div><a class="br-view-link" href="' + href + '" aria-label="Open ' + esc(title) + '">' + svg('arrow') + '</a></div>' + body + '<div class="br-preview-foot">STATIC INTERFACE PREVIEW · PHASE 1</div></article>';
}

function renderPlaceholder(key) {
  const title = TITLES[key] || TITLES['command-sectors'];
  const navItem = COMMAND_NAV.find((item) => item.key === key) || COMMAND_NAV[1];
  return '<section class="br-placeholder-page"><div class="br-placeholder-icon">' + svg(navItem.icon) + '</div><div class="br-panel-kicker">BLACK RIDGE WORLD COMMAND / PHASE 1</div><h2>' + tr(title[1], title[0]) + '</h2><p>' + tr(title[2], title[2]) + '</p><div class="br-placeholder-status"><span class="br-status-dot"></span> INTERFACE PLACEHOLDER · NO LIVE DATA OR ACTIONS</div><a class="br-button" href="/dashboard">' + svg('arrow') + ' ' + tr('العودة إلى مركز القيادة', 'RETURN TO COMMAND CENTER') + '</a></section>';
}

function renderCommandPage(key, pathname) {
  const dashboard = key === 'dashboard';
  const nav = COMMAND_NAV.find((item) => item.key === key) || COMMAND_NAV[0];
  const navLinks = COMMAND_NAV.map((item) => '<a class="ibp-nav-link br-nav-link" href="' + item.path + '" data-nav-key="' + item.key + '">' + svg(item.icon, 'br-nav-svg') + '<span>' + tr(item.ar, item.en) + '</span></a>').join('');
  const pageTitle = dashboard ? ['مركز القيادة', 'COMMAND CENTER'] : [TITLES[key]?.[1] || 'القطاعات', TITLES[key]?.[0] || 'SECTORS'];
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#060b13"><meta name="description" content="BLACK RIDGE WORLD COMMAND"><title>' + esc(pageTitle[1]) + ' · BLACK RIDGE</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"><link rel="stylesheet" href="/ibp/ibp.css"><link rel="stylesheet" href="/ibp/command-center.css"></head>' +
    '<body data-page="' + esc(key) + '" data-route="' + esc(pathname) + '"><div class="ibp-app br-command-shell" id="ibp-app-shell">' +
    '<header class="ibp-topbar br-topbar"><div class="br-brand-block"><button class="ibp-icon-btn ibp-hamburger" id="ibp-nav-toggle" type="button" aria-label="Open navigation">' + svg('command') + '</button><a class="br-brand-mark" href="/dashboard">' + svg('shield') + '</a><div class="br-brand-text"><strong>BLACK RIDGE</strong><small>CITY CIA SYSTEM</small></div></div>' +
    '<div class="br-top-center"><span>INTELLIGENCE</span><i></i><span>OPERATIONS</span><i></i><span>SECURITY</span><i></i><span>COMMAND</span></div>' +
    '<div class="br-top-actions"><label class="br-search">' + svg('search') + '<input aria-label="Search" placeholder="Search command systems..." disabled></label><span class="br-network">' + svg('signal') + '<span>SECURE NETWORK</span></span><span class="ibp-user-pill br-user-pill" id="ibp-current-user">' + tr('مصادق عليه', 'AUTHORIZED') + '</span><button class="ibp-lang" id="ibp-language-toggle" type="button" aria-label="Change language">EN</button><button class="ibp-icon-btn br-logout" id="ibp-logout" type="button">' + tr('خروج', 'LOG OUT') + '</button></div></header>' +
    '<button class="br-mobile-backdrop" id="br-mobile-backdrop" type="button" aria-label="Close navigation"></button><nav class="ibp-nav br-sidebar" aria-label="Command Center navigation"><div class="br-side-brand"><span class="br-brand-mark">' + svg('shield') + '</span><div><strong>BLACK RIDGE</strong><small>WORLD COMMAND</small></div></div><div class="br-nav-caption">COMMAND NETWORK</div>' + navLinks + '<div class="br-sidebar-footer"><span class="br-footer-seal">' + svg('shield') + '</span><b>BLACK RIDGE</b><small>ONE NETWORK<br>ONE MISSION</small></div></nav>' +
    '<main class="ibp-main br-main" id="ibp-main"><header class="br-page-heading"><div><div class="br-eyebrow">WORLD COMMAND / LOS SANTOS</div><h1>' + tr(pageTitle[0], pageTitle[1]) + '</h1><p>' + (dashboard ? tr('رؤية تشغيلية موحّدة للقطاعات والقيادة.', 'Unified operational view of sectors and command.') : tr(TITLES[key]?.[2] || '', TITLES[key]?.[2] || 'Section interface placeholder.')) + '</p></div>' +
    '<div class="br-heading-meta"><span class="br-live-indicator"><i></i> ' + tr('القناة آمنة', 'SECURE CHANNEL') + '</span><span class="br-clock" id="br-clock">--:--</span><span class="br-date" id="br-date">--</span></div></header>' +
    (dashboard ? renderDashboard() : renderPlaceholder(key)) + '<footer class="br-footer"><span>BLACK RIDGE WORLD COMMAND</span><span>PHASE 1 · FOUNDATION INTERFACE</span></footer></main></div><div class="ibp-toast" id="ibp-toast" role="status" aria-live="polite"></div><script src="/socket.io/socket.io.js"></script><script src="/ibp/ibp.js" defer></script></body></html>';
}

module.exports = { COMMAND_NAV, renderCommandPage };
