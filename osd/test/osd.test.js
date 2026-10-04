'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  CLASSIFICATIONS,
  ROLE_DEFAULTS,
  canReadClassification,
  canonicalJson,
  nextMinorVersion,
  normalizeDocument,
  safeDocument,
  sectorCode,
  sha256,
  signPayload,
  signingSecretReady
} = require('../server');

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

test('real signer identity is withheld unless the viewer has its dedicated permission', () => {
  const document = {
    id: 'doc-id', document_number: 'OSD-LSS-2026-00001', verification_code: 'AB12',
    document_type: 'COMMAND ORDER', title: 'Order', body: { text: 'body' }, sector: 'Los Santos',
    classification: 'SECRET', recipient: 'Command', status: 'ISSUED', version: '1.0',
    created_by: 'author-id', updated_at: '2026-10-04T00:00:00Z', issued_at: '2026-10-04T00:00:00Z',
    signature: { signerName: 'Commander Real Name', signerRole: 'COMMANDER', signedAt: '2026-10-04T00:00:00Z' },
    integrity_hash: 'a'.repeat(64)
  };
  const standard = safeDocument(document, { permissions: [] });
  const commander = safeDocument(document, { permissions: ['VIEW_REAL_SIGNER_IDENTITY'] });
  const publicView = safeDocument(document, { permissions: [] }, { public: true });
  assert.equal(standard.signature.display, 'AUTHORIZED COMMAND');
  assert.equal(standard.signature.display.includes('Commander Real Name'), false);
  assert.equal(commander.signature.display, 'Commander Real Name');
  assert.equal(publicView.signature.display, 'AUTHORIZED COMMAND');
  assert.equal(publicView.body, undefined);
  assert.equal(publicView.integrityHash, undefined);
});