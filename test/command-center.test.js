'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { COMMAND_NAV, renderCommandPage } = require('../ibp/command-center');
const { matchRoute, pageHtml } = require('../ibp/pages');

test('the Phase 1 navigation contains every requested command section', () => {
  assert.deepEqual(COMMAND_NAV.map((item) => item.en), [
    'COMMAND', 'SECTORS', 'BATTALIONS', 'LOS SANTOS MAP', 'OPERATIONS',
    'SOS', 'REPORTS', 'PERSONNEL', 'MESSAGES', 'BANK', 'INTELLIGENCE'
  ]);
  for (const item of COMMAND_NAV.slice(1)) {
    assert.deepEqual(matchRoute(item.path), { key: item.key, recordId: '' });
  }
});

test('the home and dashboard routes render the new protected Command Center', () => {
  for (const pathname of ['/', '/index.html', '/dashboard']) {
    const html = pageHtml('dashboard', pathname, '');
    assert.match(html, /BLACK RIDGE WORLD COMMAND/);
    assert.match(html, /ACTIVE OPERATIONS/);
    assert.match(html, /CRITICAL SOS/);
    assert.match(html, /RECENT REPORTS/);
    assert.match(html, /ONLINE PERSONNEL/);
    assert.match(html, /LOS SANTOS MAP/);
    assert.match(html, /LATEST REPORTS/);
    assert.match(html, /\/ibp\/ibp\.js/);
    assert.match(html, /\/socket\.io\/socket\.io\.js/);
    assert.doesNotMatch(html, /href="\/(?:operations|reports|personnel)"/);
  }
});

test('all Phase 1 section pages stay inside the new shell and identify as placeholders', () => {
  for (const item of COMMAND_NAV.slice(1)) {
    const html = renderCommandPage(item.key, item.path);
    assert.match(html, /br-command-shell/);
    assert.match(html, /INTERFACE PLACEHOLDER · NO LIVE DATA OR ACTIONS/);
    assert.match(html, /href="\/dashboard"/);
  }
});

test('Phase 1 routing leaves the existing login, Socket.IO, database, and permission code in place', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'ibp', 'ibp.js'), 'utf8');
  assert.match(pageHtml('login', '/ibp-login', ''), /id="ibp-login-form"/);
  assert.match(server, /new Server\(httpServer/);
  assert.match(server, /PostgresStateStore/);
  assert.match(server, /registerPages\(app\)/);
  assert.match(client, /establishSession\(\)/);
  assert.match(client, /data-nav-permission/);
});
