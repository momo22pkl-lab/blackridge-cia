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
  { term: 'قحبة', level: 1 },
  { term: 'شرموطة', level: 1 },
  { term: 'منيوك', level: 1 }
]);

function normalizeMessage(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/gu, '')
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function containsWholeTerm(text, term) {
  const phrase = escapeRegExp(term).replace(/\s+/gu, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${phrase}(?=$|[^\\p{L}\\p{N}])`, 'u').test(text);
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

function inspectMessage(value, configuredTerms = '') {
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

  const hasLookalike = [...source].some((character) => LOOKALIKE_MAP.has(character));
  const rules = [...DEFAULT_BLOCKED_TERMS, ...parseBlockedTerms(configuredTerms)];
  for (const rule of rules) {
    if (containsWholeTerm(scanText, rule.term)) {
      if (!morseDecoded && hasLookalike) {
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

  if (hasLookalike) {
    for (const rule of rules) {
      if (containsWholeTerm(normalized, rule.term)) {
        return {
          type: 'OBFUSCATED_PROFANITY',
          level: 3,
          reason: 'UNICODE_LOOKALIKE_BYPASS',
          source: 'unicode-lookalike'
        };
      }
    }
  }
  return null;
}

function canRestoreSecurityMember(user) {
  const rank = normalizeMessage(user && user.rank);
  return rank === 'cia chief';
}

module.exports = {
  canRestoreSecurityMember,
  decodeMorse,
  inspectMessage,
  normalizeMessage,
  parseBlockedTerms
};
