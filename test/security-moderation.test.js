'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canRestoreSecurityMember,
  decodeMorse,
  inspectMessage,
  normalizeMessage,
  parseBlockedTerms
} = require('../security-moderation');

test('blocks clear profanity and avoids substring-only matches', () => {
  assert.equal(inspectMessage('That is shit').type, 'PROFANITY');
  assert.equal(inspectMessage('assistant has the file'), null);
  assert.equal(inspectMessage('this is a normal message'), null);
});

test('normalizes Arabic and simple evasion without treating ordinary Morse as abuse', () => {
  assert.equal(normalizeMessage('كِسْمَك'), 'كسمك');
  assert.equal(inspectMessage('f.u.c.k').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('f\u200Bu.c.k').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('fuuuuuck').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('kcuf').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('fuсk').type, 'OBFUSCATED_PROFANITY');
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
