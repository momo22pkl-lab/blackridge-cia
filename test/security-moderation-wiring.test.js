'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function socketHandler(source, eventName) {
  const start = source.indexOf(`socket.on('${eventName}'`);
  assert.notEqual(start, -1, `${eventName} server handler should exist`);
  const next = source.indexOf('\n    socket.on(', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('server checks moderated text before chat, radio, Morse, and support persistence', () => {
  const orderedChecks = [
    ['chat:send', 'await moderateOutgoingText', 'state.cia_chats.global.push(message)'],
    ['radio:text', 'await moderateOutgoingText', "emitRadioToChannel(channel, 'radio:text'"],
    ['radio:code', 'await moderateOutgoingText', "emitRadioToChannel(channel, 'radio:code'"],
    ['morse:translate', 'await moderateOutgoingText', 'state.cia_morse_logs.unshift(log)'],
    ['support:send', 'await moderateOutgoingText', 'state.cia_support.push(message)'],
    ['support:reply', 'await moderateOutgoingText', 'state.cia_support.push(message)']
  ];

  for (const [eventName, moderationCall, persistenceCall] of orderedChecks) {
    const handler = socketHandler(server, eventName);
    assert.ok(handler.indexOf(moderationCall) >= 0, `${eventName} should call the shared server-side engine`);
    assert.ok(handler.indexOf(moderationCall) < handler.indexOf(persistenceCall), `${eventName} should moderate before storing or broadcasting`);
  }
});

test('admin exceptions require an explicit server-validated reason and are audited', () => {
  assert.match(server, /isAllowedModerationException\(actor,\s*detection,\s*exceptionCode\)/);
  assert.match(server, /action:\s*'MODERATION_EXCEPTION_USED'/);
  assert.match(server, /action:\s*'MODERATION_EXCEPTION_DENIED'/);
  assert.doesNotMatch(server, /isChief\(actor\)\s*&&\s*isProfanityDetection\(detection\)\)\s*return false/);
  assert.match(indexHtml, /function armSecurityModerationException\(\)/);
  assert.match(indexHtml, /expiresAt: Date\.now\(\) \+ 60000/);
  assert.match(indexHtml, /function consumeSecurityModerationException\(\)/);
});

test('dictionary edits include update and an audit record without storing the matched word', () => {
  assert.match(server, /updateBlockedTerms\(current,\s*payload\?\.action,\s*payload\?\.term,\s*payload\?\.newTerm\)/);
  assert.match(server, /إدارة معجم الكلمات المحظورة/);
  assert.match(server, /createHash\('sha256'\)\.update\(oldTerm\)/);
  assert.match(indexHtml, /data-security-edit-term=/);
  assert.match(indexHtml, /manageSecurityBlockedTerm\('update'/);
  assert.doesNotMatch(server, /profanityTerm\s*:/);
  assert.doesNotMatch(indexHtml, /incident\.profanityTerm/);
});

test('radio send failures show a user-visible warning instead of optimistic success', () => {
  assert.match(indexHtml, /function showRadioSubmissionError\(result\)/);
  assert.match(indexHtml, /ciaSocket\.emit\('radio:text', msgObj, function\(result\)/);
  assert.match(indexHtml, /ciaSocket\.emit\('radio:code', \{[\s\S]*?function\(result\)/);
});
