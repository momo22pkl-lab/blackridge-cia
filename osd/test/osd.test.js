'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {
  ALL_PERMISSIONS,
  CLASSIFICATIONS,
  ROLE_DEFAULTS,
  allowedPermissions,
  canReadClassification,
  canonicalJson,
  nextMinorVersion,
  normalizeDocument,
  normalizeSignatureImage,
  safeDocument,
  sectorCode,
  sha256,
  signPayload,
  signingSecretReady
} = require('../server');

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBuffer, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function testSignaturePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(320, 0);
  header.writeUInt32BE(120, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(120 * (1 + 320 * 4));
  const image = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${image.toString('base64')}`;
}

test('canonical JSON sorts object keys without changing array order', () => {
  assert.equal(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, a: [2, 1] }), '{"a":[2,1],"nested":{"a":1,"b":2},"z":1}');
});

test('clearance checks are enforced from the server-side classification order', () => {
  assert.equal(canReadClassification({ clearance: 'INTERNAL' }, 'PUBLIC'), true);
  assert.equal(canReadClassification({ clearance: 'INTERNAL' }, 'INTERNAL'), true);
  assert.equal(canReadClassification({ clearance: 'INTERNAL' }, 'SECRET'), false);
  assert.equal(canReadClassification({ clearance: 'TOP SECRET' }, 'TOP SECRET'), true);
  assert.deepEqual(ROLE_DEFAULTS.AGENT.clearance, 'INTERNAL');
});

test('user-assigned permissions reject unknown capabilities and deduplicate valid entries', () => {
  assert.deepEqual(allowedPermissions(['VIEW_DOCUMENTS', 'VIEW_DOCUMENTS']), ['VIEW_DOCUMENTS']);
  assert.deepEqual(allowedPermissions([]), []);
  assert.equal(allowedPermissions(['ROOT_ACCESS']), null);
});

test('draft edits create incrementing version numbers and major rollover', () => {
  assert.equal(nextMinorVersion('1.0'), '1.1');
  assert.equal(nextMinorVersion('1.8'), '1.9');
  assert.equal(nextMinorVersion('1.9'), '2.0');
  assert.equal(nextMinorVersion('invalid'), '1.1');
});

test('document normalization accepts only supported types and classifications', () => {
  const draft = normalizeDocument({
    type: 'OFFICIAL MEMORANDUM',
    title: 'Sector briefing',
    sector: 'Los Santos Sector',
    classification: 'SECRET',
    recipient: 'Operations',
    body: 'First line\nSecond line',
    notes: 'Not public',
    references: ['OPS-17', '   ']
  });
  assert.equal(draft.body.text, 'First line\nSecond line');
  assert.equal(draft.body.notes, 'Not public');
  assert.deepEqual(draft.body.references, ['OPS-17']);
  assert.throws(() => normalizeDocument({ type: 'UNLISTED', title: 'X', sector: 'Y', classification: 'PUBLIC', body: 'Z' }), /valid document type/);
  assert.throws(() => normalizeDocument({ type: 'OFFICIAL MEMORANDUM', title: '', sector: 'Y', classification: 'PUBLIC', body: 'Z' }), /title is required/);
  assert.throws(() => normalizeDocument({ type: 'OFFICIAL MEMORANDUM', title: 'X', sector: 'Y', classification: 'UNMARKED', body: 'Z' }), /valid classification/);
});

test('sector numbering code is deterministic and classification list is ordered', () => {
  assert.equal(sectorCode('Los Santos Sector'), 'LSS');
  assert.equal(sectorCode(''), 'SE');
  assert.deepEqual(CLASSIFICATIONS, ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET']);
});

test('issued-document HMAC changes when the signed snapshot changes', () => {
  const secret = 'test-only-secret';
  const original = { documentNumber: 'OSD-LSS-2026-00001', version: '1.0', title: 'Order' };
  const sign = (value) => crypto.createHmac('sha256', secret).update(canonicalJson(value)).digest('hex');
  const signature = sign(original);
  assert.equal(signature, sign({ title: 'Order', version: '1.0', documentNumber: 'OSD-LSS-2026-00001' }));
  assert.notEqual(signature, sign({ ...original, title: 'Altered order' }));
  assert.equal(signature.length, 64);
  assert.equal(sha256('event').length, 64);
});

test('timestamp signing is stable before and after JSON serialization; weak keys are rejected', () => {
  const timestamp = new Date('2026-10-04T12:30:00.000Z');
  const key = '0123456789abcdef0123456789abcdef';
  assert.equal(signPayload({ expiresAt: timestamp }, key), signPayload({ expiresAt: timestamp.toISOString() }, key));
  assert.equal(signingSecretReady(key), true);
  assert.equal(signingSecretReady('too-short'), false);
});

test('signature images must be bounded, correctly sized PNGs with valid chunk checksums', () => {
  const image = testSignaturePng();
  assert.equal(normalizeSignatureImage(image), image);
  assert.throws(() => normalizeSignatureImage(''), /drawn PNG signature is required/);
  assert.throws(() => normalizeSignatureImage(image.replace('data:image/png', 'data:image/jpeg')), /drawn PNG signature is required/);
  const corrupt = image.slice(0, -8) + 'AAAAAA==';
  assert.throws(() => normalizeSignatureImage(corrupt), /PNG|signature image/i);
});

test('real signer identity is withheld unless the viewer has its dedicated permission', () => {
  const document = {
    id: 'doc-id', document_number: 'OSD-LSS-2026-00001', verification_code: 'AB12',
    document_type: 'COMMAND ORDER', title: 'Order', body: { text: 'body' }, sector: 'Los Santos',
    classification: 'SECRET', recipient: 'Command', status: 'ISSUED', version: '1.0',
    created_by: 'author-id', updated_at: '2026-10-04T00:00:00Z', issued_at: '2026-10-04T00:00:00Z',
    signature: { signerName: 'Commander Real Name', signerRole: 'COMMANDER', signedAt: '2026-10-04T00:00:00Z', signatureImage: 'data:image/png;base64,signature' },
    integrity_hash: 'a'.repeat(64)
  };
  const standard = safeDocument(document, { permissions: [] });
  const commander = safeDocument(document, { permissions: ['VIEW_SIGNER_IDENTITY'] });
  const downloader = safeDocument(document, { permissions: ['DOWNLOAD_DOCUMENTS'] });
  const publicView = safeDocument(document, { permissions: [] }, { public: true });
  assert.equal(ALL_PERMISSIONS.includes('VIEW_SIGNER_IDENTITY'), true);
  assert.equal(standard.signature.display, 'AUTHORIZED COMMAND');
  assert.equal(standard.signature.display.includes('Commander Real Name'), false);
  assert.equal(standard.signature.signatureImage, undefined);
  assert.equal(commander.signature.display, 'Commander Real Name');
  assert.equal(commander.signature.signatureImage, 'data:image/png;base64,signature');
  assert.equal(downloader.signature.signatureImage, 'data:image/png;base64,signature');
  assert.equal(publicView.signature.display, 'AUTHORIZED COMMAND');
  assert.equal(publicView.signature.signatureImage, undefined);
  assert.equal(publicView.body, undefined);
  assert.equal(publicView.integrityHash, undefined);
});