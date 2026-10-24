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
    if (lines.shift() !== FORMAT_PREFIX) {
      fail('صيغة الشفرة غير معروفة. تأكد من نسخ شفرة BLACKRIDGE كاملة.', 'invalid_format');
    }
    const symbols = lines.join('').replace(/\s/gu, '');
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

  async function encryptMessage(message, passphrase) {
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
    return `${FORMAT_PREFIX}\n${groupSymbols(encodeSymbolBytes(packed))}`;
  }

  async function decryptMessage(code, passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > MAX_KEY_LENGTH) {
      fail('أدخل المفتاح المشترك الصحيح (8 أحرف على الأقل).', 'invalid_key');
    }
    const packed = decodeSymbolBytes(code);
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

  return Object.freeze({
    FORMAT_PREFIX,
    PBKDF2_ITERATIONS,
    SYMBOLS: Object.freeze(SYMBOLS.slice()),
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

  const encryptButton = query('[data-cipher-action="encrypt"]');
  encryptButton.addEventListener('click', async () => {
    const message = query('#br-cipher-plain').value;
    const passphrase = query('#br-cipher-encrypt-key').value;
    const result = query('[data-cipher-result="encrypted"]');
    setBusy(encryptButton, true, 'جارٍ التشفير…');
    setStatus('encrypt', 'يتم التشفير على هذا الجهاز فقط.', 'info');
    try {
      query('#br-cipher-output').value = await cipher.encryptMessage(message, passphrase);
      result.hidden = false;
      setStatus('encrypt', 'اكتمل التشفير. احفظ الشفرة والمفتاح كلًا على حدة.', 'success');
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
    const passphrase = query('#br-cipher-decrypt-key').value;
    const result = query('[data-cipher-result="decrypted"]');
    setBusy(decryptButton, true, 'جارٍ فك التشفير…');
    setStatus('decrypt', 'يتم التحقق من الشفرة على هذا الجهاز فقط.', 'info');
    try {
      query('#br-cipher-plaintext-output').value = await cipher.decryptMessage(code, passphrase);
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
    query('#br-cipher-plain').value = '';
    query('#br-cipher-encrypt-key').value = '';
    query('#br-cipher-output').value = '';
    query('[data-cipher-result="encrypted"]').hidden = true;
    setStatus('encrypt', '', 'info');
  });

  query('[data-cipher-action="clear-decrypt"]').addEventListener('click', () => {
    query('#br-cipher-code').value = '';
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
