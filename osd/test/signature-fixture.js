'use strict';

const zlib = require('node:zlib');

function pngChunk(type, data) {
  let checksum = 0xffffffff;
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  for (const byte of body) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((checksum ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(300, 0);
header.writeUInt32BE(100, 4);
header[8] = 8;
header[9] = 6;
const pixels = zlib.deflateSync(Buffer.alloc(100 * (1 + 300 * 4)));

module.exports = `data:image/png;base64,${Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', header),
  pngChunk('IDAT', pixels),
  pngChunk('IEND', Buffer.alloc(0))
]).toString('base64')}`;
