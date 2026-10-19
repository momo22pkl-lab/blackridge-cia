'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('chat profanity reaches authoritative server moderation', () => {
  const start = indexHtml.indexOf('function sendChatMessage() {');
  const end = indexHtml.indexOf('function deleteGlobalChatMessage(', start);
  assert.notEqual(start, -1, 'sendChatMessage should exist');
  assert.notEqual(end, -1, 'chat handler boundary should exist');
  const sendChat = indexHtml.slice(start, end);

  assert.match(sendChat, /ciaSocket\.emit\(\s*['"]chat:send['"]/);
  assert.doesNotMatch(sendChat, /hasBlockedChatTerm|CHAT_SECURITY_BLOCKED_TERMS|تحتوي الرسالة على ألفاظ غير مسموح بها/);
});

test('chat profanity strikes use the in-app warning dialog in the send callback', () => {
  const start = indexHtml.indexOf('function sendChatMessage() {');
  const end = indexHtml.indexOf('function deleteGlobalChatMessage(', start);
  const sendChat = indexHtml.slice(start, end);

  assert.match(sendChat, /isProfanityStrikeWarning/);
  assert.match(sendChat, /showProfanityStrikeWarning/);
  assert.match(sendChat, /finalStrike/);
  assert.match(sendChat, /if \(finalStrike\) return/);
});
