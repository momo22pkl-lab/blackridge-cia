'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { injectMilitaryPersonnelDossierMarkup } = require('../military-personnel-dossier-server');

const projectRoot = path.resolve(__dirname, '..');

test('the military dossier is injected once into the existing CIA navigation and pane shell', () => {
  const original = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  const injected = injectMilitaryPersonnelDossierMarkup(original);
  const injectedAgain = injectMilitaryPersonnelDossierMarkup(injected);

  assert.match(injected, /id="military-personnel-dossier-nav"/);
  assert.match(injected, /id="military-personnel-dossier"/);
  assert.match(injected, /href="\/military-personnel-dossier\.css"/);
  assert.match(injected, /src="\/military-personnel-dossier-client\.js"/);
  assert.match(injected, /id="dashboard" class="view-pane active"/);
  assert.match(injected, /id="agents-directory"/);
  for (const [needle, label] of [
    ['id="military-personnel-dossier-nav"', 'navigation entry'],
    ['id="military-personnel-dossier"', 'dossier pane'],
    ['href="/military-personnel-dossier.css"', 'stylesheet'],
    ['src="/military-personnel-dossier-client.js"', 'client script']
  ]) {
    assert.equal(injectedAgain.split(needle).length - 1, 1, `${label} should not be duplicated`);
  }
});

test('the dossier reads the existing scoped directory API and connects its four record tabs', () => {
  const client = fs.readFileSync(path.join(projectRoot, 'military-personnel-dossier-client.js'), 'utf8');
  const markup = fs.readFileSync(path.join(projectRoot, 'military-personnel-dossier-server.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectRoot, 'military-personnel-dossier.css'), 'utf8');

  assert.match(client, /ibp:directory:list/);
  assert.match(client, /ibp:directory:detail/);
  assert.match(markup, /ابحث بالاسم أو الكود العسكري/);
  assert.match(client, /person\.publicCode/);
  for (const label of ['الملاحظات', 'القضايا', 'السجل الزمني', 'المرفقات']) {
    assert.ok(client.includes(label), `expected the ${label} tab`);
  }
  assert.match(client, /mpd:dossier:get/);
  assert.match(client, /mpd:note:create/);
  assert.match(client, /mpd:case:create/);
  assert.match(client, /mpd:timeline:create/);
  assert.match(client, /mpd:attachment:upload/);
  assert.match(client, /mpd:attachment:download/);
  assert.doesNotMatch(client, /ibp:directory:(?:create|save|delete)/);
  assert.doesNotMatch(client, /localStorage|sessionStorage/);
  assert.match(stylesheet, /@media\(max-width:900px\)/);
  assert.match(stylesheet, /@media\(max-width:600px\)/);
  assert.match(stylesheet, /@media\(prefers-reduced-motion:reduce\)/);
});

test('dossier static assets are explicitly served without exposing the repository root', () => {
  const server = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');

  assert.match(server, /'\/military-personnel-dossier\.css': 'military-personnel-dossier\.css'/);
  assert.match(server, /'\/military-personnel-dossier-client\.js': 'military-personnel-dossier-client\.js'/);
  assert.doesNotMatch(server, /express\.static\(__dirname\)/);
});
