'use strict';

const PROFANITY_TYPES = new Set([
  'PROFANITY',
  'MORSE_PROFANITY',
  'OBFUSCATED_PROFANITY'
]);

const STRIKE_MESSAGES = Object.freeze({
  first: 'تحذير أولي: تم اكتشاف إساءة في رسالتك. تم حذف رسالتك. يرجى الالتزام بقوانين النظام.',
  second: 'تحذير ثانوي: تم اكتشاف مخالفة ثانية. تم حذف رسالتك. تكرار الإساءة سيؤدي إلى فصلك من الخدمة.',
  separation: 'تم فصلك من الخدمة وحذف رسالتك بسبب تكرار المخالفات.'
});

function normalizeProfanityStrikes(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function isProfanityDetection(detection) {
  return !!detection && PROFANITY_TYPES.has(String(detection.type || '').toUpperCase());
}

function registerProfanityStrike(user) {
  if (!user || typeof user !== 'object') {
    throw new TypeError('A user record is required to register a profanity strike.');
  }

  const count = normalizeProfanityStrikes(user.profanityStrikes) + 1;
  user.profanityStrikes = count;

  if (count === 1) return { count, separated: false, message: STRIKE_MESSAGES.first };
  if (count === 2) return { count, separated: false, message: STRIKE_MESSAGES.second };

  user.securityStatus = 'SUSPENDED';
  user.suspended = true;
  user.activeService = false;
  user.online = false;
  user.radioOnline = false;
  user.status = 'موقوف أمنياً';
  user.suspensionReason = 'تكرار المخالفات اللفظية ثلاث مرات.';
  return { count, separated: true, message: STRIKE_MESSAGES.separation };
}

module.exports = {
  STRIKE_MESSAGES,
  isProfanityDetection,
  normalizeProfanityStrikes,
  registerProfanityStrike
};
