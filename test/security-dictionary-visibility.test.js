'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function visibilityFunctions() {
  const renderStart = indexHtml.indexOf('function renderSecurityBlockedTerms(chief) {');
  const toggleStart = indexHtml.indexOf('function toggleSecurityBlockedTermsVisibility() {', renderStart);
  const end = indexHtml.indexOf('function manageSecurityBlockedTerm(', toggleStart);
  assert.notEqual(renderStart, -1, 'blocked-term renderer should exist');
  assert.notEqual(toggleStart, -1, 'visibility toggle should exist');
  assert.notEqual(end, -1, 'blocked-term management handler should exist');
  return indexHtml.slice(renderStart, end);
}

test('blocked dictionary terms start hidden and are removed from the DOM while hidden', () => {
  assert.match(indexHtml, /id="security-blocked-terms-toggle"[^>]*aria-controls="security-blocked-terms-list"[^>]*aria-expanded="false"/);
  assert.match(indexHtml, /id="security-blocked-terms-list" aria-hidden="true" style="display:none;/);

  const terms = ['example hidden term'];
  const elements = {
    'security-dictionary-section': { style: {} },
    'security-blocked-terms-list': { style: {}, attributes: {}, innerHTML: 'initial', setAttribute(name, value) { this.attributes[name] = value; }, querySelectorAll() { return []; } },
    'security-blocked-terms-toggle': { textContent: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }
  };
  const document = { getElementById(id) { return elements[id] || null; } };
  const factory = new Function('document', 'securityBlockedTerms', 'esc', 'currentUser', 'normalizeRank', 'let securityBlockedTermsVisible = false;\n' + visibilityFunctions() + '\nreturn { renderSecurityBlockedTerms, toggleSecurityBlockedTermsVisibility };');
  const ui = factory(document, terms, value => String(value), { rank: 'CIA CHIEF' }, value => value);
  ui.renderSecurityBlockedTerms(true);
  assert.equal(elements['security-blocked-terms-list'].style.display, 'none');
  assert.equal(elements['security-blocked-terms-list'].innerHTML, '');
  assert.equal(elements['security-blocked-terms-toggle'].textContent, 'إظهار الكلمات المحظورة');
  assert.equal(elements['security-blocked-terms-toggle'].attributes['aria-expanded'], 'false');
});

test('only CIA CHIEF can reveal the dictionary and the button toggles it back closed', () => {
  const terms = ['example hidden term'];
  const elements = {
    'security-dictionary-section': { style: {} },
    'security-blocked-terms-list': { style: {}, attributes: {}, innerHTML: '', setAttribute(name, value) { this.attributes[name] = value; }, querySelectorAll() { return []; } },
    'security-blocked-terms-toggle': { textContent: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }
  };
  const document = { getElementById(id) { return elements[id] || null; } };
  const currentUser = { rank: 'CIA CHIEF' };
  const factory = new Function('document', 'securityBlockedTerms', 'esc', 'currentUser', 'normalizeRank', 'let securityBlockedTermsVisible = false;\n' + visibilityFunctions() + '\nreturn { renderSecurityBlockedTerms, toggleSecurityBlockedTermsVisibility };');
  const ui = factory(document, terms, value => String(value), currentUser, value => value);
  ui.renderSecurityBlockedTerms(true);
  ui.toggleSecurityBlockedTermsVisibility();
  assert.equal(elements['security-blocked-terms-list'].style.display, 'grid');
  assert.match(elements['security-blocked-terms-list'].innerHTML, /example hidden term/);
  assert.equal(elements['security-blocked-terms-toggle'].textContent, 'إخفاء الكلمات المحظورة');
  assert.equal(elements['security-blocked-terms-toggle'].attributes['aria-expanded'], 'true');
  ui.toggleSecurityBlockedTermsVisibility();
  assert.equal(elements['security-blocked-terms-list'].style.display, 'none');
  assert.equal(elements['security-blocked-terms-list'].innerHTML, '');

  currentUser.rank = 'HIGH COMMANDER';
  ui.toggleSecurityBlockedTermsVisibility();
  assert.equal(elements['security-blocked-terms-list'].style.display, 'none');
});
