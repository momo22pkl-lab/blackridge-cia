'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const cipher = require('../blackridge-cipher.js');
const sharedKey = 'Blackridge test phrase 2026';

test('encrypts and decrypts a message exactly using the shared passphrase', async () => {
  const message = 'Meet at the north entrance at 19:30. Bring the case file.';
  const encoded = await cipher.encryptMessage(message, sharedKey);

  assert.equal(await cipher.decryptMessage(encoded, sharedKey), message);
  assert.match(encoded, /^BLACKRIDGE-CIPHER\/1\n/u);
  assert.match(encoded, /[◈◉◇◆◐◑◒◓◔◕◖◗⊙⊚⊛⊜⊝⊞⊟⊠⊡⋄⋇⋈⋉⋊⋋⋌⋍⌁⌖⌘]/u);
  assert.equal(encoded.includes(message), false);
});

test('creates a fresh randomized symbol message for every encryption', async () => {
  const first = await cipher.encryptMessage('Same text', sharedKey);
  const second = await cipher.encryptMessage('Same text', sharedKey);

  assert.notEqual(first, second);
  assert.equal(await cipher.decryptMessage(first, sharedKey), 'Same text');
  assert.equal(await cipher.decryptMessage(second, sharedKey), 'Same text');
});

test('rejects a wrong passphrase without returning plaintext', async () => {
  const encoded = await cipher.encryptMessage('Private message', sharedKey);

  await assert.rejects(
    cipher.decryptMessage(encoded, 'Another wrong phrase'),
    (error) => error.code === 'authentication_failed'
  );
});

test('detects tampering through the AES-GCM authentication tag', async () => {
  const encoded = await cipher.encryptMessage('Do not alter this message', sharedKey);
  const lines = encoded.split('\n');
  const symbols = Array.from(lines.slice(1).join('').replace(/\s/gu, ''));
  const encryptedPayloadIndex = 60;
  const oldSymbol = symbols[encryptedPayloadIndex];
  symbols[encryptedPayloadIndex] = cipher.SYMBOLS[
    (cipher.SYMBOLS.indexOf(oldSymbol) + 1) % cipher.SYMBOLS.length
  ];

  await assert.rejects(
    cipher.decryptMessage(`${lines[0]}\n${symbols.join('')}`, sharedKey),
    (error) => error.code === 'authentication_failed'
  );
});

test('rejects malformed, truncated, and unsupported-format messages clearly', async () => {
  await assert.rejects(
    cipher.decryptMessage('not a BLACKRIDGE cipher', sharedKey),
    (error) => error.code === 'invalid_format'
  );
  await assert.rejects(
    cipher.decryptMessage('BLACKRIDGE-CIPHER/1\n◈', sharedKey),
    (error) => error.code === 'invalid_format'
  );
  await assert.rejects(
    cipher.decryptMessage('BLACKRIDGE-CIPHER/2\n◈', sharedKey),
    (error) => error.code === 'invalid_format'
  );
});

test('validates empty messages and too-short passphrases before encryption', async () => {
  await assert.rejects(
    cipher.encryptMessage('', sharedKey),
    (error) => error.code === 'invalid_input'
  );
  await assert.rejects(
    cipher.encryptMessage('Hello', 'short'),
    (error) => error.code === 'invalid_key'
  );
});

test('documents and uses the expected key derivation work factor', () => {
  assert.equal(cipher.PBKDF2_ITERATIONS, 600000);
});
