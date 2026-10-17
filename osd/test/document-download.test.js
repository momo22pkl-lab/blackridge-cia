'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function section(start, end) {
  const startAt = app.indexOf(start);
  const endAt = app.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, 'missing section: ' + start);
  assert.notEqual(endAt, -1, 'missing section end: ' + end);
  return app.slice(startAt, endAt);
}

test('issuing an official document opens an automatically generated protected share link', () => {
  const issueFlow = section('async function confirmSignatureAndIssue()', 'async function shareDocument(');
  assert.ok(issueFlow.includes('await shareDocument(issuedId, { autoCreate: true })'));
  const shareFlow = section('async function shareDocument(', 'async function refreshShareLinks(');
  assert.ok(shareFlow.includes("const publicAllowed = documentData.classification === 'PUBLIC'"));
  assert.ok(shareFlow.includes('<input id="shareProtected" type="checkbox" checked>'));
  assert.ok(shareFlow.includes("days === 14 ? 'selected' : ''"));
  assert.ok(shareFlow.includes('await createShareLink(id)'));
  assert.ok(app.includes("const permissions = ['VIEW', 'VERIFY']"));
});

test('issued report actions retain PDF printing and add a separate PNG download action', () => {
  const actions = section('function modalActions(document)', 'function showDocument(document)');
  assert.ok(actions.includes('data-action="printDocument"'));
  assert.ok(actions.includes('data-action="downloadDocumentImage"'));
  assert.ok(app.includes("imageDownload: 'تنزيل صورة التقرير'"));
  assert.ok(app.includes("imageDownload: 'Download Report Image'"));
});

test('PNG export embeds document images, rasterizes at high resolution, and downloads as PNG', () => {
  const exporter = section('async function downloadDocumentImage(documentData)', 'async function printDocument(');
  assert.ok(exporter.includes('new XMLSerializer().serializeToString(paper)'));
  assert.ok(exporter.includes('Math.min(3, Math.sqrt(12000000 / (width * paperHeight)))'));
  assert.ok(exporter.includes("canvas.toBlob(resolve, 'image/png')"));
  assert.ok(exporter.includes("anchor.download = 'report-' + safeNumber + '.png'"));
  assert.ok(app.includes("action === 'downloadDocumentImage'"));
});

test('PNG export inlines SVG data-image QR codes before canvas rasterization', () => {
  const helper = section('async function inlineDataSvgImages(root)', 'async function downloadDocumentImage(');
  const exporter = section('async function downloadDocumentImage(documentData)', 'async function printDocument(');
  assert.ok(helper.includes("startsWith('data:image/svg+xml')"));
  assert.ok(helper.includes('document.importNode(rootElement, true)'));
  assert.ok(helper.includes('image.replaceWith(svg)'));
  assert.ok(exporter.indexOf('await inlineDataSvgImages(paper)') < exporter.indexOf('new XMLSerializer().serializeToString(paper)'));
});
