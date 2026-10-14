'use strict';

(function attachQrCode(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OSDQR = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const BLOCKS = {
    1: { data: 19, ecc: 7 },
    2: { data: 34, ecc: 10 },
    3: { data: 55, ecc: 15 },
    4: { data: 80, ecc: 20 }
  };
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  let fieldValue = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = fieldValue;
    LOG[fieldValue] = i;
    fieldValue <<= 1;
    if (fieldValue & 0x100) fieldValue ^= 0x11d;
  }
  for (let i = 255; i < EXP.length; i += 1) EXP[i] = EXP[i - 255];

  function multiply(a, b) {
    return !a || !b ? 0 : EXP[LOG[a] + LOG[b]];
  }

  function errorCorrection(data, degree) {
    let generator = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = new Array(generator.length + 1).fill(0);
      for (let j = 0; j < generator.length; j += 1) {
        next[j] ^= generator[j];
        next[j + 1] ^= multiply(generator[j], EXP[i]);
      }
      generator = next;
    }
    const remainder = [...data, ...new Array(degree).fill(0)];
    for (let i = 0; i < data.length; i += 1) {
      const factor = remainder[i];
      if (!factor) continue;
      for (let j = 0; j < generator.length; j += 1) remainder[i + j] ^= multiply(generator[j], factor);
    }
    return remainder.slice(data.length);
  }

  function appendBits(target, value, width) {
    for (let bit = width - 1; bit >= 0; bit -= 1) target.push((value >>> bit) & 1);
  }

  function formatWord() {
    const data = 1 << 3; // Error-correction level L, mask pattern 0.
    let remainder = data << 10;
    for (let bit = 14; bit >= 10; bit -= 1) {
      if ((remainder >>> bit) & 1) remainder ^= 0x537 << (bit - 10);
    }
    return ((data << 10) | remainder) ^ 0x5412;
  }

  function makeMatrix(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    const version = Object.keys(BLOCKS).map(Number).find((candidate) => 12 + bytes.length * 8 <= BLOCKS[candidate].data * 8);
    if (!version) throw new RangeError('Verification link is too long for the built-in QR generator.');
    const { data: dataLength, ecc: eccLength } = BLOCKS[version];
    const bits = [];
    appendBits(bits, 0b0100, 4);
    appendBits(bits, bytes.length, 8);
    for (const byte of bytes) appendBits(bits, byte, 8);
    const capacity = dataLength * 8;
    for (let i = 0; i < Math.min(4, capacity - bits.length); i += 1) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
    }
    for (let pad = 0; data.length < dataLength; pad += 1) data.push(pad % 2 ? 0x11 : 0xec);
    const codewords = [...data, ...errorCorrection(data, eccLength)];
    const size = 17 + 4 * version;
    const matrix = Array.from({ length: size }, () => Array(size).fill(null));
    const set = (x, y, value) => {
      if (x >= 0 && y >= 0 && x < size && y < size) matrix[y][x] = !!value;
    };

    function finder(centerX, centerY) {
      for (let dy = -1; dy <= 7; dy += 1) {
        for (let dx = -1; dx <= 7; dx += 1) {
          const edge = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 &&
            (dx === 0 || dx === 6 || dy === 0 || dy === 6);
          const eye = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          set(centerX - 3 + dx, centerY - 3 + dy, edge || eye);
        }
      }
    }
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);

    if (version > 1) {
      const center = size - 7;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(center + dx, center + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    for (let position = 8; position < size - 8; position += 1) {
      if (matrix[6][position] === null) set(position, 6, position % 2 === 0);
      if (matrix[position][6] === null) set(6, position, position % 2 === 0);
    }

    const format = formatWord();
    for (let bit = 0; bit < 15; bit += 1) {
      const value = ((format >>> bit) & 1) !== 0;
      if (bit < 6) set(8, bit, value);
      else if (bit < 8) set(8, bit + 1, value);
      else if (bit === 8) set(7, 8, value);
      else set(14 - bit, 8, value);

      if (bit < 8) set(size - 1 - bit, 8, value);
      else set(8, size - 15 + bit, value);
    }
    set(8, size - 8, true);

    let bitIndex = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right -= 1;
      for (let vertical = 0; vertical < size; vertical += 1) {
        const y = upward ? size - 1 - vertical : vertical;
        for (let offset = 0; offset < 2; offset += 1) {
          const x = right - offset;
          if (matrix[y][x] !== null) continue;
          const raw = bitIndex < codewords.length * 8
            ? ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1
            : false;
          set(x, y, raw !== ((x + y) % 2 === 0));
          bitIndex += 1;
        }
      }
      upward = !upward;
    }
    return matrix;
  }

  function toSvg(text) {
    const matrix = makeMatrix(text);
    const quiet = 4;
    let path = '';
    for (let y = 0; y < matrix.length; y += 1) {
      for (let x = 0; x < matrix.length; x += 1) {
        if (matrix[y][x]) path += `M${x + quiet},${y + quiet}h1v1h-1z`;
      }
    }
    const total = matrix.length + quiet * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" role="img" aria-label="QR verification code" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#101820"/></svg>`;
  }

  function toDataUri(text) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(toSvg(text))}`;
  }

  return { makeMatrix, toSvg, toDataUri };
}));
