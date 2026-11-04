'use strict';

const MORSE_CODES = Object.freeze({
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.',
  H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
  O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-',
  V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
  5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.',
  '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-',
  '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-',
  '+': '.-.-.', '-': '-....-', '"': '.-..-.', '$': '...-..-',
  '@': '.--.-.'
});
const MORSE_CHARACTERS = Object.freeze(
  Object.fromEntries(Object.entries(MORSE_CODES).map(([character, code]) => [code, character]))
);

const LOOKALIKE_MAP = new Map(Object.entries({
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x',
  'у': 'y', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm',
  'т': 't', 'в': 'b', 'н': 'h', 'ѕ': 's', 'ԁ': 'd',
  'Α': 'a', 'Β': 'b', 'Ε': 'e', 'Ι': 'i', 'Κ': 'k', 'Μ': 'm',
  'Ν': 'n', 'Ο': 'o', 'Ρ': 'p', 'Τ': 't', 'Χ': 'x',
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v',
  'ο': 'o', 'ρ': 'p', 'τ': 't', 'χ': 'x'
}));

const LEET_MAP = Object.freeze({
  0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g'
});
const ARABIZI_MAP = Object.freeze({
  2: 'ء', 3: 'ع', 5: 'خ', 6: 'ط', 7: 'ح', 9: 'ص'
});

const DEFAULT_BLOCKED_TERMS = Object.freeze([
  { term: 'fuck', level: 1 },
  { term: 'shit', level: 1 },
  { term: 'bitch', level: 1 },
  { term: 'asshole', level: 1 },
  { term: 'motherfucker', level: 2 },
  { term: 'كسمك', level: 1 },
  { term: 'كس امك', level: 1 },
  { term: 'كس', level: 1 },
  { term: 'كسختك', level: 1 },
  { term: 'كسعيلتك', level: 1 },
  { term: 'كس اختك', level: 1 },
  { term: 'زب', level: 1 },
  { term: 'مص', level: 1 },
  { term: 'نيك', level: 1 },
  { term: 'فشخ', level: 1 },
  { term: 'نكح', level: 1 },
  { term: 'اركب على زبي', level: 1 },
  { term: 'يفضح عرضك', level: 1 },
  { term: 'يفضح عيلتك', level: 1 },
  { term: 'يفضح امك', level: 1 },
  { term: 'يضفح اختك', level: 1 },
  { term: 'امك منيوكة', level: 1 },
  { term: 'اختك منيوكة', level: 1 },
  { term: 'يلعن امك', level: 1 },
  { term: 'يلعن اختك', level: 1 },
  { term: 'يلعن شرفك', level: 1 },
  { term: 'قحبة', level: 1 },
  { term: 'شرموطة', level: 1 },
  { term: 'منيوك', level: 1 },
  { term: 'يا ابن العرص', level: 1 },
  { term: 'يامفتزح', level: 1 },
  { term: 'يا مفتزح', level: 1 },
  { term: 'يا شرموط', level: 1 },
  { term: 'يا قحبة', level: 1 },
  { term: 'قحب', level: 1 },
  { term: 'شرموط', level: 1 },
  { term: 'يا ابن النايمة', level: 1 },
  { term: 'يفضح شرفك', level: 1 },
  { term: 'امك تمص', level: 1 },
  { term: 'يلعن ابو الي خلفك عرص', level: 1 },
  { term: 'خرا', level: 1 }
]);

const BLOCKED_TERM_LIMIT = 250;
const SECURITY_BLOCKED_TERMS_VERSION = 1;
const LEGACY_ENGINE_BLOCKED_TERMS = Object.freeze([
  'fuck', 'shit', 'bitch', 'asshole', 'motherfucker',
  'كسمك', 'كس امك', 'قحبة', 'شرموطة', 'منيوك'
]);
const LEGACY_AMBIGUOUS_BLOCKED_TERMS = new Set([
  'اركب عليه',
  'يفضح',
  'امك',
  'ابوك',
  'اختك',
  'ستك',
  'عيلتك',
  'يا ابن',
  'ملهى ليلي'
]);

function normalizeMessage(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u064B-\u065F\u0670]/gu, '')
    .replace(/\u0640/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .replace(/[０-９]/gu, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFF10 + 48))
    .replace(/./gu, (character) => LOOKALIKE_MAP.get(character) || character)
    .replace(/\s+/gu, ' ')
    .trim();
}

function parseBlockedTerms(value) {
  const rules = [];
  for (const entry of String(value || '').split(/[;\n\r]+/u)) {
    const line = entry.trim();
    if (!line) continue;
    const match = line.match(/^(?:LEVEL\s*)?([1-4])\s*[:=]\s*(.+)$/iu);
    const level = match ? Number(match[1]) : 1;
    const term = normalizeMessage(match ? match[2] : line);
    if (term && term.length <= 80) rules.push({ term, level });
  }
  return rules;
}

function normalizeBlockedTerm(value) {
  const term = normalizeMessage(String(value == null ? '' : value));
  if ([...term].length < 2 || [...term].length > 80) return null;
  return /^[\p{L}\p{N}]+(?:[ '\u2019-][\p{L}\p{N}]+)*$/u.test(term) ? term : null;
}

function normalizeBlockedTerms(value, limit = BLOCKED_TERM_LIMIT) {
  const terms = [];
  const seen = new Set();
  const maxTerms = Math.max(1, Math.min(BLOCKED_TERM_LIMIT, Number(limit) || BLOCKED_TERM_LIMIT));
  for (const entry of Array.isArray(value) ? value : []) {
    const term = normalizeBlockedTerm(entry);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= maxTerms) break;
  }
  return terms;
}

function migrateBlockedTerms(value, version, limit = BLOCKED_TERM_LIMIT) {
  let terms = normalizeBlockedTerms(value, limit);
  if ((Number(version) || 0) < SECURITY_BLOCKED_TERMS_VERSION) {
    terms = terms.filter((term) => !LEGACY_AMBIGUOUS_BLOCKED_TERMS.has(term));
    for (const term of LEGACY_ENGINE_BLOCKED_TERMS) {
      if (!terms.includes(term) && terms.length < limit) terms.push(term);
    }
    terms = normalizeBlockedTerms(terms, limit);
  }
  return terms;
}

function updateBlockedTerms(currentValue, actionValue, termValue, replacementValue, limit = BLOCKED_TERM_LIMIT) {
  const terms = normalizeBlockedTerms(currentValue, limit);
  const action = String(actionValue || '').trim().toLowerCase();
  if (!['add', 'edit', 'remove'].includes(action)) {
    return { ok: false, error: 'invalid-action', blockedTerms: terms };
  }

  const term = normalizeBlockedTerm(termValue);
  if (!term) return { ok: false, error: 'invalid-term', blockedTerms: terms };

  const index = terms.indexOf(term);
  if (action === 'add') {
    if (index >= 0) return { ok: true, action, changed: false, blockedTerms: terms };
    if (terms.length >= limit) return { ok: false, error: 'dictionary-full', blockedTerms: terms };
    return { ok: true, action, changed: true, blockedTerms: [...terms, term] };
  }
  if (index < 0) return { ok: false, error: 'term-not-found', blockedTerms: terms };
  if (action === 'remove') {
    return { ok: true, action, changed: true, blockedTerms: terms.filter((entry) => entry !== term) };
  }

  const replacement = normalizeBlockedTerm(replacementValue);
  if (!replacement) return { ok: false, error: 'invalid-replacement', blockedTerms: terms };
  if (replacement === term) return { ok: true, action, changed: false, blockedTerms: terms };
  if (terms.includes(replacement)) return { ok: false, error: 'duplicate-term', blockedTerms: terms };
  const updated = [...terms];
  updated[index] = replacement;
  return { ok: true, action, changed: true, blockedTerms: updated };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function containsWholeTerm(text, term) {
  const phrase = escapeRegExp(term).replace(/\s+/gu, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${phrase}(?=$|[^\\p{L}\\p{N}])`, 'u').test(text);
}

function containsTermLookalike(value, term) {
  return [...String(value || '')].some((character) => {
    const raw = character.normalize('NFKC').toLocaleLowerCase('en');
    const mapped = LOOKALIKE_MAP.get(raw) || raw;
    return mapped !== raw && [...mapped].length === 1 && term.includes(mapped);
  });
}

function decodeMorse(value) {
  const input = String(value || '').trim();
  if (!input || !/^[.\-/\s]+$/u.test(input) || (input.match(/[.-]/gu) || []).length < 4) return null;
  const words = input.split(/\s*\/\s*|\s{3,}/u);
  try {
    return words.map((word) => word.trim().split(/\s+/u).map((code) => {
      const character = MORSE_CHARACTERS[code];
      if (!character) throw new Error('Unknown Morse sequence');
      return character;
    }).join('')).join(' ').trim() || null;
  } catch {
    return null;
  }
}

function deobfuscationVariants(value) {
  const normalized = normalizeMessage(value);
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  const variants = [];
  const add = (candidate, source) => {
    if (candidate && candidate !== normalized) variants.push({ value: candidate, source });
  };

  const punctuationCollapsed = normalized
    .split(/\s+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .join(' ')
    .trim();
  add(punctuationCollapsed, 'separator-obfuscation');

  for (const word of words) {
    const collapsed = word.replace(/(.)\1{2,}/gu, '$1');
    if (collapsed !== word) add(collapsed, 'repeated-letters');

    if (/[a-z]/u.test(word) && /\d/u.test(word)) {
      const leet = word.replace(/[01345789]/gu, (digit) => LEET_MAP[digit] || digit);
      if (leet !== word) add(leet, 'digit-substitution');
    }
    if (/[a-z]/u.test(word) && /[235679]/u.test(word)) {
      const arabizi = word.replace(/[235679]/gu, (digit) => ARABIZI_MAP[digit] || digit);
      if (arabizi !== word) add(arabizi, 'arabizi');
    }

    const forms = new Set([word, collapsed]);
    if (/[a-z]/u.test(word) && /\d/u.test(word)) {
      forms.add(word.replace(/[01345789]/gu, (digit) => LEET_MAP[digit] || digit));
    }
    if (/[a-z]/u.test(word) && /[235679]/u.test(word)) {
      forms.add(word.replace(/[235679]/gu, (digit) => ARABIZI_MAP[digit] || digit));
    }
    for (const form of forms) {
      if (form.length >= 4) add([...form].reverse().join(''), 'reversed');
    }
  }

  const pieces = normalized.split(/[^\p{L}\p{N}]+/gu).filter(Boolean);
  let singleLetterRun = '';
  const flush = () => {
    if (singleLetterRun.length >= 4) add(singleLetterRun, 'spaced-letters');
    singleLetterRun = '';
  };
  for (const piece of pieces) {
    if ([...piece].length === 1) singleLetterRun += piece;
    else flush();
  }
  flush();
  return variants;
}

function inspectMessage(value, configuredTerms) {
  const source = String(value == null ? '' : value);
  const normalized = normalizeMessage(source);
  if (!normalized) return null;

  if (source.length > 8000 || /<\s*script\b|<\s*iframe\b|javascript\s*:|data\s*:\s*text\/html|\bon[a-z]+\s*=/iu.test(source)) {
    return { type: 'MALICIOUS_PAYLOAD', level: 4, reason: 'PAYLOAD_PATTERN', source: 'direct' };
  }

  const morseDecoded = decodeMorse(source);
  const scanText = morseDecoded ? normalizeMessage(morseDecoded) : normalized;
  const threatPattern = /\b(?:i(?:'|’)m going to|i will|i'll|we will)\s+(?:kill|shoot|hurt|attack)\s+(?:you|him|her|them)\b|\b(?:kill|shoot|hurt|attack)\s+(?:you|him|her|them)\b/iu;
  const arabicThreatPattern = /(?:ساقتلك|سوف اقتلك|راح اقتلك|بقتلك|سوف اقتل(?:ه|ها|هم|كم)|راح اقتل(?:ه|ها|هم|كم))/u;
  const deobfuscatedThreatText = scanText
    .replace(/[01345789]/gu, (digit) => LEET_MAP[digit] || digit)
    .replace(/(.)\1{2,}/gu, '$1');
  if (threatPattern.test(scanText) || arabicThreatPattern.test(scanText)) {
    return { type: morseDecoded ? 'MORSE_THREAT' : 'THREAT', level: 3, reason: morseDecoded ? 'MORSE_DECODED_THREAT' : 'THREAT_PATTERN', source: morseDecoded ? 'morse' : 'direct' };
  }
  if (threatPattern.test(deobfuscatedThreatText) || arabicThreatPattern.test(deobfuscatedThreatText)) {
    return { type: 'OBFUSCATED_THREAT', level: 3, reason: 'OBFUSCATED_THREAT_PATTERN', source: 'obfuscation' };
  }

  const rules = configuredTerms === undefined
    ? [...DEFAULT_BLOCKED_TERMS]
    : parseBlockedTerms(configuredTerms);
  for (const rule of rules) {
    if (containsWholeTerm(scanText, rule.term)) {
      if (!morseDecoded && containsTermLookalike(source, rule.term)) {
        return {
          type: 'OBFUSCATED_PROFANITY',
          level: 3,
          reason: 'UNICODE_LOOKALIKE_BYPASS',
          source: 'unicode-lookalike'
        };
      }
      return {
        type: morseDecoded ? 'MORSE_PROFANITY' : 'PROFANITY',
        level: rule.level,
        reason: morseDecoded ? 'MORSE_DECODED_PROFANITY' : 'PROFANITY_MATCH',
        source: morseDecoded ? 'morse' : 'direct',
        ...(morseDecoded ? { decodedText: morseDecoded } : {})
      };
    }
  }

  if (morseDecoded) return null;
  for (const variant of deobfuscationVariants(source)) {
    const candidate = normalizeMessage(variant.value);
    for (const rule of rules) {
      if (candidate === rule.term || containsWholeTerm(candidate, rule.term)) {
        return {
          type: 'OBFUSCATED_PROFANITY',
          level: 3,
          reason: 'OBFUSCATION_BYPASS',
          source: variant.source
        };
      }
    }
  }

  for (const rule of rules) {
    if (containsTermLookalike(source, rule.term) && containsWholeTerm(normalized, rule.term)) {
      return {
        type: 'OBFUSCATED_PROFANITY',
        level: 3,
        reason: 'UNICODE_LOOKALIKE_BYPASS',
        source: 'unicode-lookalike'
      };
    }
  }
  return null;
}

function canRestoreSecurityMember(user) {
  const rank = normalizeMessage(user && user.rank);
  return rank === 'cia chief';
}

module.exports = {
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
};
