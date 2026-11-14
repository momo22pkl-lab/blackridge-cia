'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('cipher inbox is returned only by an authenticated CIA CHIEF request', () => {
  assert.match(serverSource, /cia_cipher_inbox:\s*\[\]/);
  assert.match(serverSource, /'cia_cipher_logs',\s*'cia_cipher_inbox',/);
  const listHandler = sourceBetween(
    serverSource,
    "socket.on('cipher:inbox:list'",
    "socket.on('cipher:inbox:send'"
  );
  assert.match(listHandler, /requireAuthenticatedUser\(socket\)/);
  assert.match(listHandler, /if\s*\(!isChief\(actor\)\)/);
  assert.match(listHandler, /cipherInboxMessageForViewer\(message,\s*actor\)/);

  const viewerFilter = sourceBetween(
    serverSource,
    'function cipherInboxMessageForViewer',
    'const isLeadership'
  );
  assert.match(viewerFilter, /!isChief\(viewer\)/);

  const sharedSnapshot = sourceBetween(
    serverSource,
    'function snapshot(viewer = null)',
    'function emitState()'
  );
  assert.doesNotMatch(sharedSnapshot, /cia_cipher_inbox/);
});

test('new cipher messages are pushed only to authenticated CIA CHIEF sockets', () => {
  const sendHandler = sourceBetween(
    serverSource,
    "socket.on('cipher:inbox:send'",
    "socket.on('cipher:decoded'"
  );
  assert.match(sendHandler, /requireAuthenticatedUser\(socket\)/);
  assert.match(sendHandler, /rawSourceCode\.length\s*>\s*120000/);
  assert.match(sendHandler, /passphrase\.length\s*>\s*1024/);
  assert.match(sendHandler, /recipient\.serviceApproved\s*!==\s*false\s*&&\s*isChief\(recipient\)/);
  assert.match(sendHandler, /targetSocket\.emit\('cipher:inbox:received'/);
  assert.match(sendHandler, /passphrase,/);
});

test('the inbox panel and message-preparation controls are restricted to CIA CHIEF', () => {
  assert.match(pageSource, /id="br-cipher-chief-inbox"[^>]*hidden/);
  const renderer = sourceBetween(
    pageSource,
    'function renderCipherChiefInbox()',
    'function renderMorsePanels()'
  );
  assert.match(renderer, /normalizeRank\(currentUser\.rank\)\s*===\s*'CIA CHIEF'/);
  assert.match(renderer, /panel\.hidden\s*=\s*!canReview/);
  assert.match(renderer, /message\.passphrase/);
  assert.match(renderer, /message\.sourceCode/);
});
