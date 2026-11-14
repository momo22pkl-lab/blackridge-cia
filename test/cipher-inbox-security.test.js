'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const cipherClientSource = fs.readFileSync(path.join(__dirname, '..', 'blackridge-cipher.js'), 'utf8');

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

test('encryption and sending create CIA CHIEF audit entries without the passphrase', () => {
  const auditWriter = sourceBetween(
    serverSource,
    'function appendCipherAuditLog',
    'function cipherInboxMessageForViewer'
  );
  assert.match(auditWriter, /userId:\s*actor\.id/);
  assert.match(auditWriter, /sourceCode:/);
  assert.match(auditWriter, /translation:/);
  assert.match(auditWriter, /activity,/);
  assert.match(auditWriter, /if\s*\(isMorseSupervisor\(recipient\)\)/);
  assert.doesNotMatch(auditWriter, /passphrase/);

  const encryptionHandler = sourceBetween(
    serverSource,
    "socket.on('cipher:audit:send'",
    "socket.on('cipher:decoded'"
  );
  assert.match(encryptionHandler, /requireAuthenticatedUser\(socket\)/);
  assert.match(encryptionHandler, /payload\?\.activity\s*!==\s*'encrypted'/);
  assert.match(encryptionHandler, /appendCipherAuditLog\(actor,\s*sourceCode,\s*translation,\s*'encrypted'\)/);

  const sendHandler = sourceBetween(
    serverSource,
    "socket.on('cipher:inbox:send'",
    "socket.on('cipher:audit:send'"
  );
  assert.match(sendHandler, /rawTranslation/);
  assert.match(sendHandler, /moderateOutgoingText\(actor,\s*translation,\s*'CIPHER'\)/);
  assert.match(sendHandler, /appendCipherAuditLog\(actor,\s*message\.sourceCode,\s*translation,\s*'sent'\)/);

  const encryptionClient = sourceBetween(
    cipherClientSource,
    "encryptButton.addEventListener('click'",
    "sendToChiefButton.addEventListener('click'"
  );
  assert.match(encryptionClient, /blackridge:cipher-encrypted/);
  assert.match(encryptionClient, /plaintext:\s*message/);
  assert.match(cipherClientSource, /plaintext:\s*pendingEncryptedMessage\.plaintext/);
  assert.match(pageSource, /blackridge:cipher-encrypted/);
  assert.match(pageSource, /activity:'encrypted'/);
  assert.match(pageSource, /translation:detail\.plaintext/);
  assert.match(pageSource, /تشفير شفرة استخبارات/);
  assert.match(pageSource, /إرسال شفرة استخبارات/);
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
