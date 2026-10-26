'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const cipher = require('../blackridge-cipher.js');
const sharedKey = 'Blackridge test phrase 2026';

function createRasterContext(frame) {
  const data = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const points = [];
  const setPixel = (x, y) => {
    if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return;
    const offset = ((y * frame.width) + x) * 4;
    data[offset] = 255;
    data[offset + 1] = 255;
    data[offset + 2] = 255;
  };
  return {
    data,
    fillRect() {},
    beginPath() { points.length = 0; },
    moveTo(x, y) { points.push([x, y]); },
    lineTo(x, y) { points.push([x, y]); },
    stroke() {
      for (let i = 1; i < points.length; i += 1) {
        let [x0, y0] = points[i - 1].map(Math.round);
        const [x1, y1] = points[i].map(Math.round);
        const dx = Math.abs(x1 - x0);
        const sx = x0 < x1 ? 1 : -1;
        const dy = -Math.abs(y1 - y0);
        const sy = y0 < y1 ? 1 : -1;
        let error = dx + dy;
        while (true) {
          setPixel(x0, y0);
          if (x0 === x1 && y0 === y1) break;
          const twiceError = 2 * error;
          if (twiceError >= dy) {
            error += dy;
            x0 += sx;
          }
          if (twiceError <= dx) {
            error += dx;
            y0 += sy;
          }
        }
      }
    }
  };
}

test('encrypts and decrypts symbols without displaying the format header', async () => {
  const message = 'Meet at the north entrance at 19:30. Bring the case file.';
  const encoded = await cipher.encryptMessage(message, sharedKey);

  assert.equal(await cipher.decryptMessage(encoded, sharedKey), message);
  assert.doesNotMatch(encoded, /BLACKRIDGE-CIPHER\/1/u);
  assert.match(encoded, /^[◈◉◇◆◐◑◒◓◔◕◖◗⊙⊚⊛⊜⊝⊞⊟⊠⊡⋄⋇⋈⋉⋊⋋⋌⋍⌁⌖⌘\s]+$/u);
  assert.match(encoded, /[◈◉◇◆◐◑◒◓◔◕◖◗⊙⊚⊛⊜⊝⊞⊟⊠⊡⋄⋇⋈⋉⋊⋋⋌⋍⌁⌖⌘]/u);
  assert.equal(encoded.includes(message), false);
});

test('continues to decrypt messages created with the previous visible header', async () => {
  const message = 'Older BLACKRIDGE cipher message';
  const symbols = await cipher.encryptMessage(message, sharedKey);

  assert.equal(await cipher.decryptMessage(`${cipher.FORMAT_PREFIX}\n${symbols}`, sharedKey), message);
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
  const symbols = Array.from(encoded.replace(/\s/gu, ''));
  const encryptedPayloadIndex = 60;
  const oldSymbol = symbols[encryptedPayloadIndex];
  symbols[encryptedPayloadIndex] = cipher.SYMBOLS[
    (cipher.SYMBOLS.indexOf(oldSymbol) + 1) % cipher.SYMBOLS.length
  ];

  await assert.rejects(
    cipher.decryptMessage(symbols.join(''), sharedKey),
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

test('exports line geometry that round-trips the complete encrypted payload', async () => {
  const message = 'The PNG path carries these bytes, not hidden metadata.';
  const packed = await cipher.encryptMessageBytes(message, sharedKey);
  const frame = cipher.encodeScribbleFrame(packed);
  const context = createRasterContext(frame);
  cipher.drawScribbleFrame(context, frame);
  const restored = cipher.decodeScribblePixels(frame.width, frame.height, context.data);

  assert.deepEqual(restored, packed);
  assert.equal(await cipher.decryptMessageBytes(restored, sharedKey), message);
});

test('rejects a wrong key and damaged scribble image without revealing plaintext', async () => {
  const message = 'Image authentication must fail closed.';
  const packed = await cipher.encryptMessageBytes(message, sharedKey);
  const frame = cipher.encodeScribbleFrame(packed);
  const context = createRasterContext(frame);
  cipher.drawScribbleFrame(context, frame);

  await assert.rejects(
    cipher.decryptMessageBytes(cipher.decodeScribblePixels(frame.width, frame.height, context.data), 'Wrong passphrase'),
    (error) => error.code === 'authentication_failed'
  );

  const alteredPixels = Uint8ClampedArray.from(context.data);
  const firstNibble = frame.nibbles[0];
  const firstX = 45;
  const firstY = Math.round(25 + (firstNibble * 2.8));
  const offset = ((firstY * frame.width) + firstX) * 4;
  alteredPixels[offset] = 0;
  alteredPixels[offset + 1] = 0;
  alteredPixels[offset + 2] = 0;
  const otherY = Math.round(25 + (((firstNibble + 1) % 16) * 2.8));
  const otherOffset = ((otherY * frame.width) + firstX) * 4;
  alteredPixels[otherOffset] = 255;
  alteredPixels[otherOffset + 1] = 255;
  alteredPixels[otherOffset + 2] = 255;

  assert.throws(
    () => cipher.decodeScribblePixels(frame.width, frame.height, alteredPixels),
    (error) => error.code === 'invalid_image'
  );
});

test('rejects unrelated or resized image data instead of guessing', () => {
  const width = cipher.SCRIBBLE_WIDTH;
  const height = 104;
  const blank = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < blank.length; i += 4) blank[i] = 255;

  assert.throws(
    () => cipher.decodeScribblePixels(width, height, blank),
    (error) => error.code === 'invalid_image'
  );
  assert.throws(
    () => cipher.decodeScribblePixels(width - 1, height, blank.subarray(0, (width - 1) * height * 4)),
    (error) => error.code === 'invalid_image'
  );
});

test('rejects image payloads above the browser-safe canvas limit', async () => {
  const packed = await cipher.encryptMessageBytes('x'.repeat(9000), sharedKey);

  assert.throws(
    () => cipher.encodeScribbleFrame(packed),
    (error) => error.code === 'image_too_large'
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
