(function attachBlackridgeCipher(root, factory) {
  const api = factory(root && root.crypto);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BlackridgeCipher = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBlackridgeCipher(webCrypto) {
  'use strict';

  const FORMAT_PREFIX = 'BLACKRIDGE-CIPHER/1';
  const VERSION = 1;
  const PBKDF2_ITERATIONS = 600000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;
  const GCM_TAG_BYTES = 16;
  const MAX_MESSAGE_LENGTH = 20000;
  const MAX_KEY_LENGTH = 1024;
  const SCRIBBLE_MAGIC = Uint8Array.from([0x42, 0x52, 0x53, 0x43]);
  const SCRIBBLE_VERSION = 1;
  const SCRIBBLE_WIDTH = 1200;
  const SCRIBBLE_MARGIN_X = 40;
  const SCRIBBLE_CELL_WIDTH = 10;
  const SCRIBBLE_COLUMNS = 112;
  const SCRIBBLE_MARGIN_Y = 20;
  const SCRIBBLE_ROW_PITCH = 64;
  const SCRIBBLE_BASELINE = 56;
  const SCRIBBLE_LEVEL_TOP = 5;
  const SCRIBBLE_LEVEL_STEP = 2.8;
  const SCRIBBLE_MAX_PIXELS = 12000000;
  const SCRIBBLE_MAX_DIMENSION = 16384;
  const SYMBOLS = Array.from('◈◉◇◆◐◑◒◓◔◕◖◗⊙⊚⊛⊜⊝⊞⊟⊠⊡⋄⋇⋈⋉⋊⋋⋌⋍⌁⌖⌘');
  const symbolIndex = new Map(SYMBOLS.map((symbol, index) => [symbol, index]));
  const utf8Encoder = new TextEncoder();

  class CipherError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'CipherError';
      this.code = code;
    }
  }

  function fail(message, code) {
    throw new CipherError(message, code);
  }

  function requireWebCrypto() {
    if (!webCrypto || !webCrypto.subtle || typeof webCrypto.getRandomValues !== 'function') {
      fail('يلزم متصفح يدعم Web Crypto عبر HTTPS أو localhost.', 'crypto_unavailable');
    }
    return webCrypto.subtle;
  }

  function validateInput(message, passphrase) {
    if (typeof message !== 'string' || message.length === 0) {
      fail('اكتب رسالة قبل التشفير.', 'invalid_input');
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      fail('الرسالة أطول من الحد المسموح (20,000 حرف).', 'invalid_input');
    }
    if (typeof passphrase !== 'string' || passphrase.length < 8) {
      fail('استخدم مفتاحًا مشتركًا من 8 أحرف على الأقل.', 'invalid_key');
    }
    if (passphrase.length > MAX_KEY_LENGTH) {
      fail('المفتاح أطول من الحد المسموح.', 'invalid_key');
    }
  }

  async function deriveAesKey(passphrase, salt, usage) {
    const subtle = requireWebCrypto();
    const keyMaterial = await subtle.importKey(
      'raw',
      utf8Encoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      [usage]
    );
  }

  function encodeSymbolBytes(bytes) {
    let buffer = 0;
    let bitCount = 0;
    let encoded = '';
    for (const byte of bytes) {
      buffer = (buffer << 8) | byte;
      bitCount += 8;
      while (bitCount >= 5) {
        bitCount -= 5;
        encoded += SYMBOLS[(buffer >> bitCount) & 31];
        buffer &= (1 << bitCount) - 1;
      }
    }
    if (bitCount > 0) encoded += SYMBOLS[(buffer << (5 - bitCount)) & 31];
    return encoded;
  }

  function groupSymbols(encoded) {
    const groups = encoded.match(/.{1,8}/gu) || [];
    const lines = [];
    for (let i = 0; i < groups.length; i += 6) lines.push(groups.slice(i, i + 6).join(' '));
    return lines.join('\n');
  }

  function decodeSymbolBytes(code) {
    const normalized = String(code ?? '').trim();
    const lines = normalized.split(/\r?\n/u);
    let symbolText = normalized;
    if (lines[0].startsWith('BLACKRIDGE-CIPHER/')) {
      if (lines[0] !== FORMAT_PREFIX) {
        fail('إصدار الشفرة غير مدعوم.', 'invalid_format');
      }
      symbolText = lines.slice(1).join('');
    }
    const symbols = symbolText.replace(/\s/gu, '');
    if (!symbols) fail('الشفرة فارغة أو غير مكتملة.', 'invalid_format');

    const bytes = [];
    let buffer = 0;
    let bitCount = 0;
    for (const symbol of Array.from(symbols)) {
      const value = symbolIndex.get(symbol);
      if (value === undefined) {
        fail('تحتوي الشفرة على رمز غير صالح أو محذوف.', 'invalid_format');
      }
      buffer = (buffer << 5) | value;
      bitCount += 5;
      if (bitCount >= 8) {
        bitCount -= 8;
        bytes.push((buffer >> bitCount) & 255);
        buffer &= (1 << bitCount) - 1;
      }
    }
    if (bitCount > 0 && buffer !== 0) {
      fail('الشفرة تالفة أو غير مكتملة.', 'invalid_format');
    }
    const packed = Uint8Array.from(bytes);
    if (encodeSymbolBytes(packed) !== symbols || packed.length < 1 + SALT_BYTES + IV_BYTES + GCM_TAG_BYTES) {
      fail('الشفرة تالفة أو غير مكتملة.', 'invalid_format');
    }
    if (packed[0] !== VERSION) fail('إصدار الشفرة غير مدعوم.', 'invalid_format');
    return packed;
  }

  async function encryptMessageBytes(message, passphrase) {
    validateInput(message, passphrase);
    const subtle = requireWebCrypto();
    const salt = webCrypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = webCrypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await deriveAesKey(passphrase, salt, 'encrypt');
    const encrypted = new Uint8Array(await subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      utf8Encoder.encode(message)
    ));
    const packed = new Uint8Array(1 + SALT_BYTES + IV_BYTES + encrypted.length);
    packed[0] = VERSION;
    packed.set(salt, 1);
    packed.set(iv, 1 + SALT_BYTES);
    packed.set(encrypted, 1 + SALT_BYTES + IV_BYTES);
    return packed;
  }

  function encodeSymbolMessage(packed) {
    return groupSymbols(encodeSymbolBytes(packed));
  }

  async function decryptMessageBytes(packed, passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > MAX_KEY_LENGTH) {
      fail('أدخل المفتاح المشترك الصحيح (8 أحرف على الأقل).', 'invalid_key');
    }
    if (!(packed instanceof Uint8Array) || packed.length < 1 + SALT_BYTES + IV_BYTES + GCM_TAG_BYTES) {
      fail('الشفرة فارغة أو غير مكتملة.', 'invalid_format');
    }
    if (packed[0] !== VERSION) fail('إصدار الشفرة غير مدعوم.', 'invalid_format');
    const saltStart = 1;
    const ivStart = saltStart + SALT_BYTES;
    const encryptedStart = ivStart + IV_BYTES;
    const salt = packed.slice(saltStart, ivStart);
    const iv = packed.slice(ivStart, encryptedStart);
    const encrypted = packed.slice(encryptedStart);
    const subtle = requireWebCrypto();
    const key = await deriveAesKey(passphrase, salt, 'decrypt');
    try {
      const plaintext = await subtle.decrypt(
        { name: 'AES-GCM', iv, tagLength: 128 },
        key,
        encrypted
      );
      return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    } catch (_error) {
      fail('تعذر فك التشفير: المفتاح غير صحيح أو الرسالة تالفة.', 'authentication_failed');
    }
  }

  async function encryptMessage(message, passphrase) {
    return encodeSymbolMessage(await encryptMessageBytes(message, passphrase));
  }

  async function decryptMessage(code, passphrase) {
    return decryptMessageBytes(decodeSymbolBytes(code), passphrase);
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeUint32(bytes, offset, value) {
    bytes[offset] = (value >>> 24) & 255;
    bytes[offset + 1] = (value >>> 16) & 255;
    bytes[offset + 2] = (value >>> 8) & 255;
    bytes[offset + 3] = value & 255;
  }

  function readUint32(bytes, offset) {
    return (
      (bytes[offset] * 0x1000000) +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3]
    ) >>> 0;
  }

  function wrapScribblePayload(packed) {
    if (!(packed instanceof Uint8Array) || packed.length < 1 + SALT_BYTES + IV_BYTES + GCM_TAG_BYTES) {
      fail('لا توجد بيانات تشفير صالحة لتحويلها إلى صورة.', 'invalid_format');
    }
    const wrapped = new Uint8Array(13 + packed.length);
    wrapped.set(SCRIBBLE_MAGIC, 0);
    wrapped[4] = SCRIBBLE_VERSION;
    writeUint32(wrapped, 5, packed.length);
    writeUint32(wrapped, 9, crc32(packed));
    wrapped.set(packed, 13);
    return wrapped;
  }

  function unwrapScribblePayload(wrapped) {
    if (!(wrapped instanceof Uint8Array) || wrapped.length < 13) {
      fail('الصورة لا تحتوي على شفرة BLACKRIDGE صالحة.', 'invalid_image');
    }
    for (let i = 0; i < SCRIBBLE_MAGIC.length; i += 1) {
      if (wrapped[i] !== SCRIBBLE_MAGIC[i]) {
        fail('لم أتعرف على هذه الصورة كصورة BLACKRIDGE SCRIBBLE.', 'invalid_image');
      }
    }
    if (wrapped[4] !== SCRIBBLE_VERSION) {
      fail('إصدار صورة الشخابيط غير مدعوم.', 'invalid_image');
    }
    const length = readUint32(wrapped, 5);
    const expectedLength = 13 + length;
    if (length < 1 + SALT_BYTES + IV_BYTES + GCM_TAG_BYTES || expectedLength !== wrapped.length) {
      fail('صورة الشخابيط تالفة أو غير مكتملة.', 'invalid_image');
    }
    const payload = wrapped.slice(13);
    if (crc32(payload) !== readUint32(wrapped, 9)) {
      fail('تعذر قراءة الصورة: بيانات الشخابيط تالفة.', 'invalid_image');
    }
    return payload;
  }

  function encodeScribbleFrame(packed) {
    const wrapped = wrapScribblePayload(packed);
    const nibbleCount = wrapped.length * 2;
    const rows = Math.ceil(nibbleCount / SCRIBBLE_COLUMNS);
    const height = (SCRIBBLE_MARGIN_Y * 2) + (rows * SCRIBBLE_ROW_PITCH);
    if (height > SCRIBBLE_MAX_DIMENSION || SCRIBBLE_WIDTH * height > SCRIBBLE_MAX_PIXELS) {
      fail('الرسالة أكبر من سعة صورة الشخابيط الآمنة. استخدم SYMBOL MODE أو اختصر الرسالة.', 'image_too_large');
    }
    const nibbles = new Uint8Array(rows * SCRIBBLE_COLUMNS);
    for (let i = 0; i < wrapped.length; i += 1) {
      nibbles[i * 2] = wrapped[i] >>> 4;
      nibbles[(i * 2) + 1] = wrapped[i] & 15;
    }
    return Object.freeze({
      width: SCRIBBLE_WIDTH,
      height,
      rows,
      columns: SCRIBBLE_COLUMNS,
      nibbles
    });
  }

  function drawScribbleFrame(context, frame) {
    if (!context || !frame || frame.width !== SCRIBBLE_WIDTH || !(frame.nibbles instanceof Uint8Array)) {
      fail('تعذر إنشاء صورة الشخابيط.', 'invalid_image');
    }
    context.fillStyle = '#000000';
    context.fillRect(0, 0, frame.width, frame.height);
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();

    const left = SCRIBBLE_MARGIN_X;
    const right = left + (SCRIBBLE_COLUMNS * SCRIBBLE_CELL_WIDTH);
    const rowBaseline = (row) => SCRIBBLE_MARGIN_Y + (row * SCRIBBLE_ROW_PITCH) + SCRIBBLE_BASELINE;
    let edgeX = left;
    context.moveTo(edgeX, rowBaseline(0));

    for (let row = 0; row < frame.rows; row += 1) {
      const leftToRight = row % 2 === 0;
      if (row > 0) context.lineTo(edgeX, rowBaseline(row));
      for (let position = 0; position < SCRIBBLE_COLUMNS; position += 1) {
        const nibble = frame.nibbles[(row * SCRIBBLE_COLUMNS) + position];
        const column = leftToRight ? position : (SCRIBBLE_COLUMNS - 1 - position);
        const centerX = left + (column * SCRIBBLE_CELL_WIDTH) + (SCRIBBLE_CELL_WIDTH / 2);
        const levelY = SCRIBBLE_MARGIN_Y + (row * SCRIBBLE_ROW_PITCH) +
          SCRIBBLE_LEVEL_TOP + (nibble * SCRIBBLE_LEVEL_STEP);
        if (leftToRight) {
          context.lineTo(centerX - 2, levelY);
          context.lineTo(centerX + 2, levelY);
          edgeX = left + ((column + 1) * SCRIBBLE_CELL_WIDTH);
        } else {
          context.lineTo(centerX + 2, levelY);
          context.lineTo(centerX - 2, levelY);
          edgeX = left + (column * SCRIBBLE_CELL_WIDTH);
        }
        context.lineTo(edgeX, rowBaseline(row));
      }
    }
    if (edgeX !== (frame.rows % 2 === 0 ? left : right)) {
      fail('تعذر إكمال مسار الشخابيط.', 'invalid_image');
    }
    context.stroke();
  }

  function decodeScribblePixels(width, height, rgba) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < SCRIBBLE_WIDTH ||
        width > SCRIBBLE_MAX_DIMENSION || height > SCRIBBLE_MAX_DIMENSION ||
        width * height > SCRIBBLE_MAX_PIXELS || !rgba || rgba.length !== width * height * 4) {
      fail('أبعاد الصورة غير صالحة أو تتجاوز الحد الآمن.', 'invalid_image');
    }
    const scale = width / SCRIBBLE_WIDTH;
    const normalizedHeight = height / scale;
    const rows = Math.round((normalizedHeight - (SCRIBBLE_MARGIN_Y * 2)) / SCRIBBLE_ROW_PITCH);
    const expectedHeight = ((SCRIBBLE_MARGIN_Y * 2) + (rows * SCRIBBLE_ROW_PITCH)) * scale;
    if (scale < 1 || rows < 1 || Math.abs(height - expectedHeight) > Math.max(2, scale * 1.5)) {
      fail('أبعاد الصورة تغيّرت أو لا تطابق تنسيق BLACKRIDGE. استخدم PNG الأصلية دون قص.', 'invalid_image');
    }

    const readBrightness = (x, y) => {
      let brightest = 0;
      for (let sampleY = Math.max(0, y - 1); sampleY <= Math.min(height - 1, y + 1); sampleY += 1) {
        const offset = ((sampleY * width) + x) * 4;
        const alpha = rgba[offset + 3] / 255;
        const luminance = ((rgba[offset] + rgba[offset + 1] + rgba[offset + 2]) / 3) * alpha;
        if (luminance > brightest) brightest = luminance;
      }
      return brightest;
    };

    const nibbles = new Uint8Array(rows * SCRIBBLE_COLUMNS);
    for (let row = 0; row < rows; row += 1) {
      const leftToRight = row % 2 === 0;
      for (let position = 0; position < SCRIBBLE_COLUMNS; position += 1) {
        const column = leftToRight ? position : (SCRIBBLE_COLUMNS - 1 - position);
        const x = Math.round((SCRIBBLE_MARGIN_X + (column * SCRIBBLE_CELL_WIDTH) +
          (SCRIBBLE_CELL_WIDTH / 2)) * scale);
        let bestLevel = -1;
        let bestBrightness = 0;
        for (let level = 0; level < 16; level += 1) {
          const y = Math.round((SCRIBBLE_MARGIN_Y + (row * SCRIBBLE_ROW_PITCH) +
            SCRIBBLE_LEVEL_TOP + (level * SCRIBBLE_LEVEL_STEP)) * scale);
          const brightness = readBrightness(x, y);
          if (brightness > bestBrightness) {
            bestBrightness = brightness;
            bestLevel = level;
          }
        }
        if (bestLevel < 0 || bestBrightness < 120) {
          fail('تعذر التعرّف على خط الشخابيط. ارفع صورة PNG الأصلية دون تعديل.', 'invalid_image');
        }
        nibbles[(row * SCRIBBLE_COLUMNS) + position] = bestLevel;
      }
    }

    const wrapped = new Uint8Array(Math.floor(nibbles.length / 2));
    for (let i = 0; i < wrapped.length; i += 1) {
      wrapped[i] = (nibbles[i * 2] << 4) | nibbles[(i * 2) + 1];
    }
    if (wrapped.length < 13) fail('الصورة لا تحتوي على شفرة BLACKRIDGE صالحة.', 'invalid_image');
    const payloadLength = readUint32(wrapped, 5);
    const wrappedLength = 13 + payloadLength;
    const expectedRows = Math.ceil((wrappedLength * 2) / SCRIBBLE_COLUMNS);
    if (expectedRows !== rows || wrappedLength > wrapped.length) {
      fail('صورة الشخابيط تالفة أو غير مكتملة.', 'invalid_image');
    }
    for (let i = wrappedLength * 2; i < nibbles.length; i += 1) {
      if (nibbles[i] !== 0) fail('صورة الشخابيط تالفة أو عُدّلت.', 'invalid_image');
    }
    return unwrapScribblePayload(wrapped.slice(0, wrappedLength));
  }

  return Object.freeze({
    FORMAT_PREFIX,
    PBKDF2_ITERATIONS,
    SYMBOLS: Object.freeze(SYMBOLS.slice()),
    SCRIBBLE_WIDTH,
    SCRIBBLE_MAX_PIXELS,
    SCRIBBLE_MAX_DIMENSION,
    encodeSymbolBytes,
    encodeSymbolMessage,
    decodeSymbolBytes,
    encryptMessageBytes,
    decryptMessageBytes,
    encodeScribbleFrame,
    drawScribbleFrame,
    decodeScribblePixels,
    encryptMessage,
    decryptMessage
  });
});

if (typeof document !== 'undefined' && typeof globalThis !== 'undefined' && globalThis.BlackridgeCipher) {
  initializeCipherPage(document, globalThis.BlackridgeCipher);
}

function initializeCipherPage(documentRef, cipher) {
  const root = documentRef.getElementById('blackridge-cipher-view');
  if (!root || root.dataset.cipherReady === 'true') return;
  root.dataset.cipherReady = 'true';

  const query = (selector) => root.querySelector(selector);
  const getStatus = (mode) => query(`[data-cipher-status="${mode}"]`);
  const setStatus = (mode, message, kind) => {
    const status = getStatus(mode);
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || 'info';
  };
  const setBusy = (button, busy, label) => {
    if (!button) return;
    if (busy) {
      button.dataset.originalMarkup = button.innerHTML;
      button.textContent = label;
      button.disabled = true;
    } else {
      button.innerHTML = button.dataset.originalMarkup || button.textContent;
      button.disabled = false;
      delete button.dataset.originalMarkup;
    }
  };
  const copyText = async (value, mode) => {
    if (!value) {
      setStatus(mode, 'لا يوجد نص لنسخه.', 'error');
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const fallback = documentRef.createElement('textarea');
        fallback.value = value;
        fallback.setAttribute('readonly', '');
        fallback.style.position = 'fixed';
        fallback.style.opacity = '0';
        documentRef.body.appendChild(fallback);
        fallback.select();
        const copied = documentRef.execCommand('copy');
        fallback.remove();
        if (!copied) throw new Error('clipboard unavailable');
      }
      setStatus(mode, 'تم النسخ إلى الحافظة.', 'success');
    } catch (_error) {
      setStatus(mode, 'تعذر النسخ تلقائيًا. حدّد النص وانسخه يدويًا.', 'error');
    }
  };

  root.querySelectorAll('[data-cipher-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.cipherTab;
      root.querySelectorAll('[data-cipher-tab]').forEach((item) => {
        const active = item === tab;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', String(active));
      });
      root.querySelectorAll('[data-cipher-panel]').forEach((panel) => {
        const active = panel.dataset.cipherPanel === mode;
        panel.hidden = !active;
        panel.classList.toggle('is-active', active);
      });
      root.querySelectorAll('[data-cipher-status]').forEach((status) => {
        status.textContent = '';
        status.dataset.kind = 'info';
      });
    });
  });

  let scribbleObjectUrl = '';
  const releaseScribbleUrl = () => {
    if (scribbleObjectUrl) URL.revokeObjectURL(scribbleObjectUrl);
    scribbleObjectUrl = '';
  };
  const renderScribbleDownload = async (frame) => {
    const canvas = documentRef.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('تعذر تجهيز لوحة رسم صورة الشخابيط.');
    cipher.drawScribbleFrame(context, frame);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error('تعذر تصدير صورة PNG.');
    releaseScribbleUrl();
    scribbleObjectUrl = URL.createObjectURL(blob);
    query('#br-cipher-scribble-preview').src = scribbleObjectUrl;
    const download = query('#br-cipher-scribble-download');
    download.href = scribbleObjectUrl;
    download.hidden = false;
  };
  const readScribbleUpload = async (file) => {
    if (!file || (!/image\/png/iu.test(file.type) && !/\.png$/iu.test(file.name || ''))) {
      throw new Error('ارفع صورة PNG التي صدّرها نظام BLACKRIDGE.');
    }
    if (file.size > 20000000) throw new Error('حجم الصورة أكبر من الحد المسموح (20 MB).');
    const pngHeader = new Uint8Array(await file.slice(0, 24).arrayBuffer());
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (pngHeader.length < 24 || pngSignature.some((byte, index) => pngHeader[index] !== byte) ||
        String.fromCharCode(...pngHeader.slice(12, 16)) !== 'IHDR') {
      throw new Error('الملف ليس صورة PNG صالحة.');
    }
    const pngDimensions = new DataView(pngHeader.buffer, pngHeader.byteOffset, pngHeader.byteLength);
    const pngWidth = pngDimensions.getUint32(16, false);
    const pngHeight = pngDimensions.getUint32(20, false);
    if (pngWidth < cipher.SCRIBBLE_WIDTH || pngWidth > cipher.SCRIBBLE_MAX_DIMENSION ||
        pngHeight > cipher.SCRIBBLE_MAX_DIMENSION || pngWidth * pngHeight > cipher.SCRIBBLE_MAX_PIXELS) {
      throw new Error('أبعاد الصورة أكبر من الحد الآمن أو أصغر من تنسيق الشخابيط.');
    }
    let bitmap;
    let fallbackUrl = '';
    try {
      if (typeof createImageBitmap === 'function') {
        bitmap = await createImageBitmap(file);
      } else {
        fallbackUrl = URL.createObjectURL(file);
        const image = new Image();
        bitmap = await new Promise((resolve, reject) => {
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('تعذر فتح صورة PNG.'));
          image.src = fallbackUrl;
        });
      }
      if (bitmap.width * bitmap.height > cipher.SCRIBBLE_MAX_PIXELS) {
        throw new Error('أبعاد الصورة أكبر من الحد الآمن.');
      }
      const canvas = documentRef.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('تعذر قراءة صورة الشخابيط.');
      context.drawImage(bitmap, 0, 0);
      const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
      canvas.width = 0;
      canvas.height = 0;
      return cipher.decodeScribblePixels(bitmap.width, bitmap.height, imageData.data);
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
      if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
    }
  };

  const encryptButton = query('[data-cipher-action="encrypt"]');
  encryptButton.addEventListener('click', async () => {
    const message = query('#br-cipher-plain').value;
    const passphrase = query('#br-cipher-encrypt-key').value;
    const result = query('[data-cipher-result="encrypted"]');
    const symbolResult = query('[data-cipher-symbol-result]');
    const scribbleResult = query('[data-cipher-scribble-result]');
    setBusy(encryptButton, true, 'جارٍ التشفير…');
    result.hidden = true;
    setStatus('encrypt', 'يتم التشفير على هذا الجهاز فقط.', 'info');
    try {
      const packed = await cipher.encryptMessageBytes(message, passphrase);
      if (query('#br-cipher-output-mode').value === 'scribble') {
        symbolResult.hidden = true;
        scribbleResult.hidden = false;
        await renderScribbleDownload(cipher.encodeScribbleFrame(packed));
        query('[data-cipher-action="copy-encrypted"]').hidden = true;
        setStatus('encrypt', 'اكتمل التشفير. نزّل صورة PNG الأصلية وأرسل المفتاح عبر قناة منفصلة.', 'success');
      } else {
        releaseScribbleUrl();
        query('#br-cipher-scribble-preview').removeAttribute('src');
        query('#br-cipher-scribble-download').hidden = true;
        query('[data-cipher-action="copy-encrypted"]').hidden = false;
        scribbleResult.hidden = true;
        symbolResult.hidden = false;
        query('#br-cipher-output').value = cipher.encodeSymbolMessage(packed);
        setStatus('encrypt', 'اكتمل التشفير. انسخ الرموز وأرسل المفتاح عبر قناة منفصلة.', 'success');
      }
      result.hidden = false;
    } catch (error) {
      result.hidden = true;
      setStatus('encrypt', error && error.message ? error.message : 'تعذر تشفير الرسالة.', 'error');
    } finally {
      setBusy(encryptButton, false);
    }
  });

  const decryptButton = query('[data-cipher-action="decrypt"]');
  decryptButton.addEventListener('click', async () => {
    const code = query('#br-cipher-code').value;
    const imageFile = query('#br-cipher-scribble-upload').files[0];
    const passphrase = query('#br-cipher-decrypt-key').value;
    const result = query('[data-cipher-result="decrypted"]');
    setBusy(decryptButton, true, 'جارٍ فك التشفير…');
    result.hidden = true;
    setStatus('decrypt', imageFile ? 'تُقرأ خطوط الصورة وتُفك محليًا على هذا الجهاز.' : 'يتم التحقق من الشفرة على هذا الجهاز فقط.', 'info');
    try {
      const plaintext = imageFile
        ? await cipher.decryptMessageBytes(await readScribbleUpload(imageFile), passphrase)
        : await cipher.decryptMessage(code, passphrase);
      query('#br-cipher-plaintext-output').value = plaintext;
      result.hidden = false;
      setStatus('decrypt', 'تم التحقق وفك التشفير بنجاح.', 'success');
    } catch (error) {
      result.hidden = true;
      query('#br-cipher-plaintext-output').value = '';
      setStatus('decrypt', error && error.message ? error.message : 'تعذر فك التشفير.', 'error');
    } finally {
      setBusy(decryptButton, false);
    }
  });

  query('[data-cipher-action="clear-encrypt"]').addEventListener('click', () => {
    releaseScribbleUrl();
    query('#br-cipher-plain').value = '';
    query('#br-cipher-encrypt-key').value = '';
    query('#br-cipher-output').value = '';
    query('#br-cipher-scribble-preview').removeAttribute('src');
    query('#br-cipher-scribble-download').hidden = true;
    query('[data-cipher-action="copy-encrypted"]').hidden = false;
    query('[data-cipher-symbol-result]').hidden = false;
    query('[data-cipher-scribble-result]').hidden = true;
    query('[data-cipher-result="encrypted"]').hidden = true;
    setStatus('encrypt', '', 'info');
  });

  query('[data-cipher-action="clear-decrypt"]').addEventListener('click', () => {
    query('#br-cipher-code').value = '';
    query('#br-cipher-scribble-upload').value = '';
    query('#br-cipher-decrypt-key').value = '';
    query('#br-cipher-plaintext-output').value = '';
    query('[data-cipher-result="decrypted"]').hidden = true;
    setStatus('decrypt', '', 'info');
  });

  query('[data-cipher-action="copy-encrypted"]').addEventListener('click', () => {
    copyText(query('#br-cipher-output').value, 'encrypt');
  });
  query('[data-cipher-action="copy-decrypted"]').addEventListener('click', () => {
    copyText(query('#br-cipher-plaintext-output').value, 'decrypt');
  });
  query('[data-cipher-action="paste-code"]').addEventListener('click', async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        setStatus('decrypt', 'الصق الشفرة في الحقل يدويًا باستخدام أمر اللصق في جهازك.', 'info');
        return;
      }
      query('#br-cipher-code').value = await navigator.clipboard.readText();
      setStatus('decrypt', 'تم لصق الشفرة من الحافظة.', 'success');
    } catch (_error) {
      setStatus('decrypt', 'تعذر الوصول إلى الحافظة. الصق الشفرة يدويًا في الحقل.', 'error');
    }
  });
}
