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
  normalizeShareOptions,
  normalizeSignatureImage,
  safeDocument,
  sectorCode,
  sha256,
  shareAccessDecision,
  signPayload,
  signingSecretReady,
  verificationResult,
  verifyIssuedDocument
} = require('../server');
const QR = require('../qr-code');

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

test('share settings restrict anonymous links to PUBLIC documents and enforce expiry and print permissions', () => {
  const shareAdmin = { permissions: ['SHARE_DOCUMENTS', 'DOWNLOAD_DOCUMENTS'] };
  assert.deepEqual(
    normalizeShareOptions({ mode: 'PUBLIC', expiresInDays: 7, protectedView: true, permissions: ['VIEW', 'VERIFY'] }, 'PUBLIC', shareAdmin),
    { mode: 'PUBLIC', protectedView: true, watermark: '', expiresInDays: 7, permissions: ['VIEW', 'VERIFY'] }
  );
  assert.throws(() => normalizeShareOptions({ mode: 'PUBLIC' }, 'INTERNAL', shareAdmin), /Only PUBLIC documents/);
  assert.throws(() => normalizeShareOptions({ mode: 'EXTERNAL' }, 'PUBLIC', shareAdmin), /valid share access mode/);
  assert.throws(() => normalizeShareOptions({ mode: 'INTERNAL', expiresInDays: 91 }, 'SECRET', shareAdmin), /between 1 and 90 days/);
  assert.throws(() => normalizeShareOptions({ mode: 'PUBLIC', protectedView: true, permissions: ['VIEW', 'DOWNLOAD'] }, 'PUBLIC', shareAdmin), /cannot include print or download/);
  assert.throws(() => normalizeShareOptions({ mode: 'INTERNAL', protectedView: false, permissions: ['DOWNLOAD'] }, 'SECRET', { permissions: ['SHARE_DOCUMENTS'] }), /does not have permission to share document downloads/);
});

test('share access requires an active link and server-side account clearance for internal documents', () => {
  const base = {
    mode: 'INTERNAL', classification: 'SECRET', permissions: ['VIEW'], documentStatus: 'ISSUED',
    shareExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  assert.equal(shareAccessDecision(base), 'SIGN_IN_REQUIRED');
  assert.equal(shareAccessDecision({ ...base, user: { clearance: 'INTERNAL', permissions: ['VIEW_DOCUMENTS'] } }), 'NOT_AUTHORIZED');
  assert.equal(shareAccessDecision({ ...base, user: { clearance: 'TOP SECRET', permissions: ['VIEW_DOCUMENTS'] } }), 'ALLOW');
  assert.equal(shareAccessDecision({ ...base, mode: 'PUBLIC', user: null }), 'DOCUMENT_UNAVAILABLE');
  assert.equal(shareAccessDecision({ ...base, revokedAt: new Date().toISOString() }), 'LINK_REVOKED');
  assert.equal(shareAccessDecision({ ...base, shareExpiresAt: new Date(Date.now() - 60_000).toISOString() }), 'LINK_EXPIRED');
  assert.equal(shareAccessDecision({ ...base, documentStatus: 'REVOKED', user: { clearance: 'TOP SECRET', permissions: ['VIEW_DOCUMENTS'] } }), 'DOCUMENT_UNAVAILABLE');
});

test('public verification returns only status and identifier for classified documents', () => {
  const classified = {
    document_number: 'OSD-LSS-2026-00001', document_type: 'INTELLIGENCE REPORT',
    classification: 'SECRET', version: '9.4', issued_at: '2026-10-01T12:00:00Z',
    recipient: 'Restricted recipient', signature: { signerName: 'Private signer' }
  };
  const restricted = verificationResult('DOCUMENT VALID', classified);
  assert.deepEqual(restricted, { status: 'DOCUMENT VALID', documentNumber: 'OSD-LSS-2026-00001' });
  const publicDoc = { ...classified, classification: 'PUBLIC' };
  assert.deepEqual(verificationResult('DOCUMENT VALID', publicDoc), {
    status: 'DOCUMENT VALID',
    documentNumber: 'OSD-LSS-2026-00001',
    type: 'INTELLIGENCE REPORT',
    classification: 'PUBLIC',
    version: '9.4',
    issuedAt: '2026-10-01T12:00:00Z'
  });
  assert.deepEqual(verificationResult('DOCUMENT NOT FOUND'), { status: 'DOCUMENT NOT FOUND' });
});

test('share payloads are served only while the issued snapshot HMAC remains intact', () => {
  const secret = 'test-only-signing-secret-with-at-least-32-bytes';
  const snapshot = {
    id: 'doc-1', documentNumber: 'OSD-LSS-2026-00001', verificationCode: 'A1B2C3D4',
    type: 'ORDER', title: 'Test order', body: { text: 'Approved test body' }, sector: 'Los Santos',
    classification: 'PUBLIC', recipient: '', version: '1.0',
    issuedAt: '2026-10-01T12:00:00.000Z', expiresAt: null,
    authorizationLevel: 'COMMANDER', signatureImage: null
  };
  const signaturePayload = { snapshot };
  const signature = signPayload(signaturePayload, secret);
  const document = {
    id: snapshot.id, document_number: snapshot.documentNumber, verification_code: snapshot.verificationCode,
    document_type: snapshot.type, title: snapshot.title, body: snapshot.body, sector: snapshot.sector,
    classification: snapshot.classification, recipient: snapshot.recipient, version: snapshot.version,
    issued_at: snapshot.issuedAt, expires_at: snapshot.expiresAt,
    issued_snapshot: snapshot, integrity_hash: signature,
    signature: {
      signaturePayload, signature, authorizationLevel: snapshot.authorizationLevel, signatureImage: snapshot.signatureImage
    }
  };
  assert.equal(verifyIssuedDocument(document, secret), true);
  assert.equal(verifyIssuedDocument({ ...document, title: 'Tampered order' }, secret), false);
  assert.equal(verifyIssuedDocument(document, 'wrong-secret-that-is-also-32-bytes-long'), false);
  assert.equal(verifyIssuedDocument(document, 'short'), false);
});

test('QR verification symbols are generated locally for short verification URLs', () => {
  const short = QR.makeMatrix('https://blackridge.example/osd/?verify=ABC123');
  const long = QR.makeMatrix('https://blackridge.example/osd/?verify=1234567890ABCDEF');
  assert.equal(short.length, 29);
  assert.equal(long.length, 33);
  assert.ok(short.every((row) => row.length === short.length && row.every((cell) => typeof cell === 'boolean')));
  assert.match(QR.toSvg('https://blackridge.example/osd/?verify=ABC123'), /<svg[^>]+viewBox="0 0 37 37"/);
  assert.match(QR.toDataUri('https://blackridge.example/osd/?verify=ABC123'), /^data:image\/svg\+xml;charset=utf-8,/);
  assert.throws(() => QR.makeMatrix(`https://example.test/${'x'.repeat(90)}`), /too long/);
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