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

test('issued document actions keep PDF, PNG, share, and permission gates separate', () => {
  const actions = section('function modalActions(document)', 'function showDocument(document)');
  assert.ok(actions.includes('data-action="printDocument"'));
  assert.ok(actions.includes('data-action="downloadDocumentImage"'));
  assert.ok(actions.includes('data-action="shareDocument"'));
  assert.ok(actions.includes("can('DOWNLOAD_DOCUMENTS')"));
  assert.ok(actions.includes("can('SHARE_DOCUMENTS')"));
  assert.ok(app.includes("imageDownload: 'تنزيل صورة التقرير'"));
  assert.ok(app.includes("imageDownload: 'Download Report Image'"));
});

test('PNG export uses bundled html2canvas, same-origin/CORS-safe rendering, and a real PNG Blob', () => {
  const exporter = section('async function downloadDocumentImage(documentData)', 'async function printDocument(');
  assert.ok(app.includes('html2canvas 1.4.1'));
  assert.ok(exporter.includes('await window.html2canvas(paper'));
  assert.ok(exporter.includes('useCORS: true'));
  assert.ok(exporter.includes('allowTaint: false'));
  assert.ok(exporter.includes("canvas.toBlob(resolve, 'image/png')"));
  assert.ok(exporter.includes("anchor.download = 'report-' + safeNumber + '.png'"));
  assert.ok(!exporter.includes('<foreignObject'));
  assert.ok(!exporter.includes('new XMLSerializer()'));
  assert.ok(app.includes("action === 'downloadDocumentImage'"));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'vendor', 'html2canvas.LICENSE')));
});

test('PNG export rasterizes the generated SVG QR to a PNG and prepares image assets before capture', () => {
  const prep = section('async function prepareDocumentImagesForPng(root)', 'async function downloadDocumentImage(');
  const exporter = section('async function downloadDocumentImage(documentData)', 'async function printDocument(');
  assert.ok(prep.includes("data:image\\/svg\\+xml"));
  assert.ok(prep.includes("credentials: 'same-origin', mode: 'cors'"));
  assert.ok(prep.includes('rasterContext.drawImage(vector, 0, 0, raster.width, raster.height)'));
  assert.ok(prep.includes("raster.toBlob(resolve, 'image/png')"));
  assert.ok(exporter.indexOf('await prepareDocumentImagesForPng(paper)') < exporter.indexOf('window.html2canvas(paper'));
});
