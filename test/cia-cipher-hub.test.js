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
  '      <li id="blackridge-cipher-nav" class="nav-btn">شفرة الاستخبارات</li>',
  '    </ul>',
  '  <div class="content-area">',
  '    <div id="morse-translator-view" class="view-pane"><h3>مورس</h3></div>',
  '    <div id="blackridge-cipher-view" class="view-pane"><h1>شفرة الاستخبارات</h1></div>',
  '    <div id="puzzles-view" class="view-pane br-puzzle-page"><h1>ألغاز المواقع</h1></div>',
  '  </div></body></html>'
].join('\n');

test('injects one hub menu and one in-section selector without cipher cards', () => {
  const html = injectCiaCipherHubMarkup(fixture);
  assert.equal((html.match(/id="cia-cipher-hub-nav"/g) || []).length, 1);
  assert.match(html, /id="cia-cipher-hub-select"/);
  assert.match(html, /id="cia-cipher-hub-tool-slot"/);
  assert.equal((html.match(/data-cia-cipher-card=/g) || []).length, 0);
  for (const target of ['morse', 'intelligence', 'puzzle']) assert.match(html, new RegExp('value="' + target + '"'));
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

function makeNode(id, classes = []) {
  const values = new Set(classes);
  return {
    id,
    parentNode: null,
    children: [],
    classList: {
      add: (value) => values.add(value),
      remove: (value) => values.delete(value),
      contains: (value) => values.has(value)
    },
    dataset: {},
    value: '',
    listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    appendChild(node) {
      if (node.parentNode && Array.isArray(node.parentNode.children)) {
        node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
      }
      node.parentNode = this;
      this.children.push(node);
      return node;
    }
  };
}

function makeNavigationFixture() {
  const nodes = new Map();
  const ids = ['cia-cipher-hub-view', 'cia-cipher-hub-nav', 'cia-cipher-hub-select', 'cia-cipher-hub-status', 'cia-cipher-hub-tool-slot', 'morse-translator-view', 'blackridge-cipher-view', 'puzzles-view', 'morse-nav', 'blackridge-cipher-nav', 'puzzles-nav'];
  for (const id of ids) nodes.set(id, makeNode(id, id.endsWith('-view') ? ['view-pane'] : ['nav-btn']));
  const doc = {
    readyState: 'complete',
    getElementById: (id) => nodes.get(id) || null,
    querySelectorAll(selector) {
      if (selector === '.view-pane') return [...nodes.values()].filter((node) => node.classList.contains('view-pane'));
      if (selector === '.nav-btn') return [...nodes.values()].filter((node) => node.classList.contains('nav-btn'));
      return [];
    }
  };
  const calls = [];
  const root = {
    document: doc,
    showPane(paneId, button) {
      calls.push(paneId);
      doc.querySelectorAll('.view-pane').forEach((node) => node.classList.remove('active'));
      doc.querySelectorAll('.nav-btn').forEach((node) => node.classList.remove('active'));
      nodes.get(paneId)?.classList.add('active');
      button?.classList.add('active');
    },
    openMorseTranslator() { this.showPane('morse-translator-view', nodes.get('morse-nav')); },
    openBlackridgePuzzles() { this.showPane('puzzles-view', nodes.get('puzzles-nav')); }
  };
  return { root, nodes, calls };
}

test('mounts each existing tool once and keeps tool navigation inside the hub', () => {
  const { root, nodes, calls } = makeNavigationFixture();
  const navigation = createCiaCipherHubNavigation(root);
  assert.equal(navigation.mountCipherPanes(), true);
  assert.equal(navigation.installInlineNavigation(), true);
  assert.equal(navigation.installToolSelector(), true);
  for (const id of ['morse-translator-view', 'blackridge-cipher-view', 'puzzles-view']) {
    assert.equal(nodes.get(id).parentNode, nodes.get('cia-cipher-hub-tool-slot'));
  }
  assert.equal(navigation.openCiaCipherTarget('morse'), true);
  assert.equal(nodes.get('cia-cipher-hub-view').classList.contains('active'), true);
  assert.equal(nodes.get('morse-translator-view').classList.contains('active'), true);
  assert.equal(nodes.get('cia-cipher-hub-nav').classList.contains('active'), true);
  assert.equal(nodes.get('morse-nav').classList.contains('active'), false);
  assert.equal(navigation.openCiaCipherTarget('intelligence'), true);
  assert.equal(nodes.get('blackridge-cipher-view').classList.contains('active'), true);
  assert.equal(nodes.get('cia-cipher-hub-view').classList.contains('active'), true);
  assert.equal(navigation.openCiaCipherTarget('puzzle'), true);
  assert.equal(nodes.get('puzzles-view').classList.contains('active'), true);
  assert.equal(navigation.openCiaCipherTarget('missing'), false);
  nodes.get('cia-cipher-hub-select').value = 'morse';
  assert.equal(navigation.openCiaCipherHub(), true);
  assert.equal(nodes.get('cia-cipher-hub-select').value, '');
  assert.equal(nodes.get('cia-cipher-hub-view').classList.contains('active'), true);
  assert.equal(nodes.get('puzzles-view').classList.contains('active'), false);
  assert.deepEqual(calls, ['morse-translator-view', 'blackridge-cipher-view', 'puzzles-view', 'cia-cipher-hub-view']);
});

test('selector changes open a tool in place', () => {
  const { root, nodes } = makeNavigationFixture();
  const navigation = createCiaCipherHubNavigation(root);
  navigation.mountCipherPanes();
  navigation.installInlineNavigation();
  navigation.installToolSelector();
  const select = nodes.get('cia-cipher-hub-select');
  select.value = 'intelligence';
  select.listeners.change();
  assert.equal(nodes.get('blackridge-cipher-view').classList.contains('active'), true);
  assert.equal(nodes.get('cia-cipher-hub-view').classList.contains('active'), true);
});

test('styles hide duplicate navigation entries and adapt the selector on phones', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'cia-cipher-hub.css'), 'utf8');
  assert.match(css, /#morse-nav[\s\S]*?#blackridge-cipher-nav[\s\S]*?#puzzles-nav[\s\S]*?display:\s*none/);
  assert.match(css, /@media\s*\(max-width:\s*620px\)[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});
