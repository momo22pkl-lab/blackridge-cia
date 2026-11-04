'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_BLOCKED_TERMS,
  SECURITY_BLOCKED_TERMS_VERSION,
  canRestoreSecurityMember,
  decodeMorse,
  inspectMessage,
  migrateBlockedTerms,
  normalizeBlockedTerm,
  normalizeBlockedTerms,
  normalizeMessage,
  parseBlockedTerms,
  updateBlockedTerms
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
  assert.equal(inspectMessage('f u c k').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('kcuf').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('fuсk').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('ك-س-م-ك').type, 'OBFUSCATED_PROFANITY');
  assert.equal(inspectMessage('كِسْمَك').type, 'PROFANITY');
  assert.equal(inspectMessage('that is shit and а').level, 1);
  assert.equal(inspectMessage('كسمك').type, 'PROFANITY');
  assert.equal(decodeMorse('.... . .-.. .-.. ---'), 'HELLO');
  assert.equal(inspectMessage('.... . .-.. .-.. ---'), null);
});

test('uses an explicit dictionary as the complete editable rule set', () => {
  assert.equal(inspectMessage('fuck', 'custom phrase'), null);
  assert.equal(inspectMessage('custom phrase', 'custom phrase').type, 'PROFANITY');
  assert.equal(inspectMessage('custom phrase', ''), null);
});

test('default dictionary avoids blocking ordinary Arabic and English text', () => {
  const defaults = DEFAULT_BLOCKED_TERMS.map(({ term }) => term).join('\n');
  const cleanMessages = [
    'اكتب كلمة أمك في هذا الحقل',
    'أين أختك الآن؟',
    'ذهبت إلى ملهى ليلي مع الأصدقاء',
    'يا ابن عمي أرسل التقرير',
    'assistant has the file',
    'The classic cocktail was excellent',
    'I will assess the assignment today'
  ];
  for (const message of cleanMessages) {
    assert.equal(inspectMessage(message, defaults), null, `expected clean message to pass: ${message}`);
  }
});

test('normalizes, adds, edits, and removes dictionary terms safely', () => {
  assert.equal(normalizeBlockedTerm('  BAD Phrase  '), 'bad phrase');
  assert.equal(normalizeBlockedTerm('bad<script>'), null);
  assert.deepEqual(normalizeBlockedTerms(['BAD', 'bad', 'good phrase', '']), ['bad', 'good phrase']);

  const added = updateBlockedTerms(['bad phrase'], 'add', 'new term');
  assert.deepEqual(added.blockedTerms, ['bad phrase', 'new term']);
  assert.equal(updateBlockedTerms(added.blockedTerms, 'add', 'NEW TERM').changed, false);

  const edited = updateBlockedTerms(added.blockedTerms, 'edit', 'bad phrase', 'replacement phrase');
  assert.deepEqual(edited.blockedTerms, ['replacement phrase', 'new term']);
  assert.equal(updateBlockedTerms(edited.blockedTerms, 'edit', 'new term', 'replacement phrase').error, 'duplicate-term');

  const removed = updateBlockedTerms(edited.blockedTerms, 'remove', 'replacement phrase');
  assert.deepEqual(removed.blockedTerms, ['new term']);
  assert.equal(updateBlockedTerms(removed.blockedTerms, 'remove', 'missing').error, 'term-not-found');
  assert.equal(updateBlockedTerms([], 'add', 'x').error, 'invalid-term');
});

test('migrates legacy defaults once and preserves custom entries', () => {
  const legacy = [
    'fuck', 'shit', 'bitch', 'asshole', 'motherfucker', 'كسمك', 'كس امك',
    'قحبة', 'شرموطة', 'منيوك', 'امك', 'اختك', 'يا ابن', 'ملهى ليلي',
    'custom phrase'
  ];
  const migrated = migrateBlockedTerms(legacy, 0);
  assert.equal(migrated.includes('custom phrase'), true);
  assert.equal(migrated.includes('fuck'), true);
  assert.equal(migrated.includes('امك'), false);
  assert.equal(migrated.includes('اختك'), false);
  assert.equal(migrated.includes('يا ابن'), false);
  assert.equal(migrated.includes('ملهى ليلي'), false);

  const explicitlyRestored = migrateBlockedTerms([...migrated, 'امك'], SECURITY_BLOCKED_TERMS_VERSION);
  assert.equal(explicitlyRestored.includes('امك'), true);
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
