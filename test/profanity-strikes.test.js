'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STRIKE_MESSAGES,
  isProfanityDetection,
  normalizeProfanityStrikes,
  registerProfanityStrike
} = require('../profanity-strikes');

test('profanity detection types use the dedicated strike flow, not threat types', () => {
  for (const type of ['PROFANITY', 'MORSE_PROFANITY', 'OBFUSCATED_PROFANITY']) {
    assert.equal(isProfanityDetection({ type }), true);
  }
  for (const type of ['THREAT', 'MORSE_THREAT', 'OBFUSCATED_THREAT', 'MALICIOUS_PAYLOAD']) {
    assert.equal(isProfanityDetection({ type }), false);
  }
});

test('first strike warns and leaves security counters and status untouched', () => {
  const user = {
    profanityStrikes: 0,
    securityViolationCount: 7,
    securityStatus: 'ACTIVE',
    suspended: false
  };

  const result = registerProfanityStrike(user);

  assert.deepEqual(result, { count: 1, separated: false, message: STRIKE_MESSAGES.first });
  assert.equal(user.profanityStrikes, 1);
  assert.equal(user.securityViolationCount, 7);
  assert.equal(user.securityStatus, 'ACTIVE');
  assert.equal(user.suspended, false);
});

test('second strike warns without separating the user', () => {
  const user = { profanityStrikes: 1, securityViolationCount: 2, securityStatus: 'ACTIVE', suspended: false };

  const result = registerProfanityStrike(user);

  assert.deepEqual(result, { count: 2, separated: false, message: STRIKE_MESSAGES.second });
  assert.equal(user.profanityStrikes, 2);
  assert.equal(user.securityViolationCount, 2);
  assert.equal(user.securityStatus, 'ACTIVE');
  assert.equal(user.suspended, false);
});

test('third strike separates the user and keeps the counter independent', () => {
  const user = { profanityStrikes: 2, securityViolationCount: 4, securityStatus: 'ACTIVE', suspended: false };

  const result = registerProfanityStrike(user);

  assert.deepEqual(result, { count: 3, separated: true, message: STRIKE_MESSAGES.separation });
  assert.equal(user.profanityStrikes, 3);
  assert.equal(user.securityViolationCount, 4);
  assert.equal(user.securityStatus, 'SUSPENDED');
  assert.equal(user.suspended, true);
  assert.equal(user.activeService, false);
  assert.equal(user.online, false);
  assert.equal(user.radioOnline, false);
  assert.equal(user.status, 'موقوف أمنياً');
  assert.equal(user.suspensionReason, 'تكرار المخالفات اللفظية ثلاث مرات.');
});

test('normalized strike counts survive JSON persistence and invalid values reset safely', () => {
  const persistedUser = JSON.parse(JSON.stringify({ profanityStrikes: 2 }));
  assert.equal(normalizeProfanityStrikes(persistedUser.profanityStrikes), 2);
  assert.equal(normalizeProfanityStrikes(-3), 0);
  assert.equal(normalizeProfanityStrikes('not-a-number'), 0);
  assert.equal(normalizeProfanityStrikes(Infinity), 0);
});
