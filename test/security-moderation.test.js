'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODERATION_EXCEPTION_CODES,
  canRestoreSecurityMember,
  decodeMorse,
  inspectMessage,
  isAllowedModerationException,
  isValidBlockedTerm,
  normalizeMessage,
  parseBlockedTerms,
  updateBlockedTerms
} = require('../security-moderation');

test('blocks clear profanity and avoids substring-only matches', () => {
  assert.equal(inspectMessage('That is shit').type, 'PROFANITY');
  assert.equal(inspectMessage('assistant has the file'), null);
  assert.equal(inspectMessage('this is a normal message'), null);
  assert.equal(inspectMessage('أرسل تقريرًا عن اجتماع BLACKRIDGE'), null);
  assert.equal(inspectMessage('The assistant reassessed the assets.'), null);
  assert.equal(inspectMessage('Shiitake mushrooms are on the menu.'), null);
});

test('normalizes Arabic and simple evasion without treating ordinary Morse as abuse', () => {
  assert.equal(normalizeMessage('كِسْمَك'), 'كسمك');
  assert.equal(inspectMessage('f.u.c.k').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('f\u200Bu.c.k').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('fuuuuuck').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('shitt').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('f u c k').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('kcuf').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('fuсk').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('كsمك').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('كssمك').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('مراجعة النص مع فريق Blackridge'), null);
  assert.equal(inspectMessage('that is shit and а').level, 1);
  assert.equal(inspectMessage('كسمك').type, 'PROFANITY');
  assert.equal(decodeMorse('.... . .-.. .-.. ---'), 'HELLO');
  assert.equal(inspectMessage('.... . .-.. .-.. ---'), null);
});

test('decodes offensive Morse for moderation and detects Arabic/English threats and payloads', () => {
  assert.deepEqual(inspectMessage('..-. ..- -.-. -.-'), {
    type: 'MORSE_PROFANITY',
    level: 1,
    reason: 'MORSE_DECODED_PROFANITY',
    source: 'morse',
    decodedText: 'FUCK'
  });
  assert.equal(inspectMessage("I'll kill you").level, 3);
  assert.equal(inspectMessage("i w1ll k1ll y0u").type, 'OBFUSCATED_THREAT');
  assert.equal(inspectMessage('.. / .-- .. .-.. .-.. / -.- .. .-.. .-.. / -.-- --- ..-').type, 'MORSE_THREAT');
  assert.equal(inspectMessage('سأقتلك').type, 'THREAT');
  assert.equal(inspectMessage('<script>alert(1)</script>').level, 4);
});

test('supports configurable blocked terms with severity and restricts restoration to CIA CHIEF', () => {
  assert.deepEqual(parseBlockedTerms('LEVEL2:bad phrase;LEVEL 3=customword'), [
    { term: 'bad phrase', level: 2 },
    { term: 'customword', level: 3 }
  ]);
  assert.equal(inspectMessage('a customword here', 'LEVEL 2=customword').level, 2);
  assert.equal(canRestoreSecurityMember({ rank: 'CIA CHIEF' }), true);
  assert.equal(canRestoreSecurityMember({ rank: 'SUPREME COMMANDER' }), false);
  assert.equal(canRestoreSecurityMember({ rank: 'HIGH COMMANDER' }), false);
  assert.equal(canRestoreSecurityMember({ rank: 'AGENT' }), false);
});

test('supports validated dictionary add, update, and remove operations', () => {
  assert.equal(isValidBlockedTerm('bad phrase'), true);
  assert.equal(isValidBlockedTerm('x'), false);
  assert.equal(isValidBlockedTerm('bad!word'), false);

  const added = updateBlockedTerms(['existing'], 'add', 'new phrase');
  assert.equal(added.ok, true);
  assert.deepEqual(added.terms, ['existing', 'new phrase']);

  const updated = updateBlockedTerms(added.terms, 'update', 'new phrase', 'replacement phrase');
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.terms, ['existing', 'replacement phrase']);

  const removed = updateBlockedTerms(updated.terms, 'remove', 'replacement phrase');
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.terms, ['existing']);

  assert.equal(updateBlockedTerms(['existing'], 'update', 'missing', 'new phrase').ok, false);
  assert.equal(updateBlockedTerms(['existing', 'taken'], 'update', 'existing', 'taken').ok, false);
  assert.equal(updateBlockedTerms(['existing'], 'update', 'existing', 'existing').ok, false);
});

test('administrative exceptions are explicit and limited to profane text', () => {
  const chief = { rank: 'CIA CHIEF' };
  const commander = { rank: 'SUPREME COMMANDER' };
  const profanity = inspectMessage('shit');
  const threat = inspectMessage("I'll kill you");
  const payload = inspectMessage('<script>alert(1)</script>');

  assert.deepEqual(MODERATION_EXCEPTION_CODES, ['SECURITY_REVIEW', 'OFFICIAL_QUOTE', 'FILTER_TEST']);
  assert.equal(isAllowedModerationException(chief, profanity, 'FILTER_TEST'), true);
  assert.equal(isAllowedModerationException(chief, profanity, ''), false);
  assert.equal(isAllowedModerationException(commander, profanity, 'FILTER_TEST'), false);
  assert.equal(isAllowedModerationException(chief, threat, 'FILTER_TEST'), false);
  assert.equal(isAllowedModerationException(chief, payload, 'FILTER_TEST'), false);
});
