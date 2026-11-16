'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { injectCiaCipherHubMarkup } = require('../cia-cipher-hub');
const { createCiaCipherHubNavigation } = require('../cia-cipher-hub-client');

const fixture = [
  '<!doctype html><html><head></head><body>',
  '<ul class="nav-list">',
  '      <li id="morse-nav" class="nav-btn" onclick="openMorseTranslator()"><i></i> أدوات شفرة مورس</li>',
  '    </ul>',
  '  <div class="content-area">',
  '    <div id="morse-translator-view" class="view-pane"><h3>مورس</h3></div>',
  '    <div id="blackridge-cipher-view" class="view-pane"><h1>شفرة الاستخبارات</h1></div>',
  '    <div id="puzzles-view" class="view-pane br-puzzle-page"><h1>ألغاز المواقع</h1></div>',
  '  </div></body></html>'
].join('\n');

test('injects one CIA ciphers navigation item, a three-card hub, and separate back buttons', () => {
  const html = injectCiaCipherHubMarkup(fixture);
  assert.equal((html.match(/id="cia-cipher-hub-nav"/g) || []).length, 1);
  assert.equal((html.match(/data-cia-cipher-card=/g) || []).length, 3);
  assert.match(html, /شفرات الـCIA/);
  assert.match(html, /شفرة مورس/);
  assert.match(html, /الشفرة الاستخباراتية/);
  assert.match(html, /شفرة البازل/);
  assert.match(html, /openCiaCipherTarget\('morse'\)/);
  assert.match(html, /openCiaCipherTarget\('intelligence'\)/);
  assert.match(html, /openCiaCipherTarget\('puzzle'\)/);
  for (const pane of ['morse-translator-view', 'blackridge-cipher-view', 'puzzles-view']) {
    assert.match(html, new RegExp('data-cia-cipher-back="' + pane + '"'));
  }
  assert.match(html, /href="\/cia-cipher-hub\.css"/);
  assert.match(html, /src="\/cia-cipher-hub-client\.js"/);
});

test('markup injection is idempotent and does not duplicate the hub', () => {
  const once = injectCiaCipherHubMarkup(fixture);
  assert.equal(injectCiaCipherHubMarkup(once), once);
});

test('routes cards through the current Morse, intelligence, and puzzle entry points', () => {
  const calls = [];
  const fakeWindow = {
    document: { getElementById: (id) => ({ id }) },
    showPane: (...args) => calls.push(['showPane', ...args]),
    openMorseTranslator: () => calls.push(['morse']),
    openBlackridgePuzzles: (button) => calls.push(['puzzle', button])
  };
  const navigation = createCiaCipherHubNavigation(fakeWindow);
  assert.equal(navigation.openCiaCipherHub(), true);
  assert.equal(navigation.openCiaCipherTarget('morse'), true);
  assert.equal(navigation.openCiaCipherTarget('intelligence'), true);
  assert.equal(navigation.openCiaCipherTarget('puzzle'), true);
  assert.equal(navigation.openCiaCipherTarget('missing'), false);
  assert.deepEqual(calls, [
    ['showPane', 'cia-cipher-hub-view', { id: 'cia-cipher-hub-nav' }],
    ['morse'],
    ['showPane', 'blackridge-cipher-view', { id: 'blackridge-cipher-nav' }],
    ['puzzle', { id: 'puzzles-nav' }]
  ]);
});

test('hub styles provide three-column desktop, two-column tablet, and one-column mobile layouts', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'cia-cipher-hub.css'), 'utf8');
  assert.match(css, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]*?grid-template-columns:\s*repeat\(2,/);
  assert.match(css, /@media\s*\(max-width:\s*620px\)[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});