'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const stateStoreJs = fs.readFileSync(path.join(root, 'state-store.js'), 'utf8');

test('characters button opens without waiting for DOMContentLoaded', () => {
  assert.equal(indexHtml.includes('onclick="window.__openBlackridgeCharacters()"'), true);
  assert.equal(indexHtml.includes('window.__openBlackridgeCharacters ='), true);
  assert.equal(indexHtml.includes('__blackridgeCharactersOpenPending'), true);
  assert.equal(indexHtml.includes("charactersOpenBtn.addEventListener('click"), false);
  assert.equal(indexHtml.includes('رجوع إلى تسجيل الدخول'), true);
});

test('characters UI renders real API results as cards and keeps empty/request states', () => {
  assert.equal(indexHtml.includes("ciaSocket.emit('character:list'"), true);
  assert.equal(indexHtml.includes('class="characters-list-grid"'), true);
  assert.equal(indexHtml.includes('data-character-id='), true);
  assert.equal(indexHtml.includes('لا توجد شخصيات معتمدة لهذا الحساب'), true);
  assert.equal(indexHtml.includes("'character:request'"), true);
  assert.equal(indexHtml.includes("'character:login'"), true);
  assert.equal(indexHtml.includes('const demoCharacters ='), false);
});

test('character APIs enforce account ownership and hide ownership metadata from public state', () => {
  const listStart = serverJs.indexOf("socket.on('character:list'");
  const listEnd = serverJs.indexOf("socket.on('character:request'", listStart);
  const listHandler = serverJs.slice(listStart, listEnd);
  assert.notEqual(listStart, -1);
  assert.equal(listHandler.includes('requireSocketUser(socket)'), true);
  assert.equal(listHandler.includes('characterListForUser(actor)'), true);

  const loginStart = serverJs.indexOf("socket.on('character:login'");
  const loginEnd = serverJs.indexOf("socket.on('character:admin:action'", loginStart);
  const loginHandler = serverJs.slice(loginStart, loginEnd);
  assert.equal(loginHandler.includes('sameOwner'), true);
  assert.equal(loginHandler.includes('if (!sameOwner)'), true);

  const userStart = serverJs.indexOf('function publicUser(');
  const userEnd = serverJs.indexOf('function addAuditLog(', userStart);
  const publicUser = serverJs.slice(userStart, userEnd);
  assert.equal(publicUser.includes('canSeeCharacterOwnership'), true);
  assert.equal(publicUser.includes('characterOwnerId:'), true);
  assert.equal(publicUser.includes('characterType:'), true);

  const stateStart = serverJs.indexOf("'/api/state'");
  const stateEnd = serverJs.indexOf('function parseMoney', stateStart);
  const stateRoute = serverJs.slice(stateStart, stateEnd);
  assert.equal(stateRoute.includes('status(401)'), true);
  assert.equal(stateRoute.includes('snapshot(null)'), false);
  assert.equal(stateStoreJs.includes('blackridge_app_state'), true);
});
