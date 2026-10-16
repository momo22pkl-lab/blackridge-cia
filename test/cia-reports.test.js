'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('field-report deletion is enforced by the server for CIA Chief and Senior Commander only', () => {
  assert.match(server, /const isLeadership = \(user\) =>\s+isChief\(user\) \|\| isSenior\(user\);/);

  const start = server.indexOf("socket.on('report:delete'");
  const end = server.indexOf("socket.on('duty:start'", start);
  assert.notEqual(start, -1, 'field-report delete socket handler should exist');
  assert.notEqual(end, -1, 'field-report delete handler should end before duty events');
  const handler = server.slice(start, end);
  assert.match(handler, /const actor = requireSocketUser\(socket\)/);
  assert.match(handler, /if \(!isLeadership\(actor\)\)/);
  assert.match(handler, /CIA CHIEF وSenior Commander CIA فقط/);
});

test('field-report UI shows delete only to the two authorized command ranks', () => {
  assert.match(page, /const leadership = currentUser && \['CIA CHIEF','SUPREME COMMANDER'\]\.includes\(normalizeRank\(currentUser\.rank\)\)/);
  assert.match(page, /\$\{leadership \? `<button type="button" onclick="deleteReport/);
});

test('report images have a safe download link with cross-origin fallback', () => {
  assert.match(page, /function reportImageDownloadTarget\(value\)/);
  assert.match(page, /data:image\\\/\(\?:png\|jpe\?g\|gif\|webp\|bmp\|avif\);base64/);
  assert.match(page, /!\['http:', 'https:'\]\.includes\(url\.protocol\)/);
  assert.match(page, /download="\$\{esc\(reportImageDownloadName\(r\.id\)\)\}"/);
  assert.match(page, /\$\{image\.external \? 'target="_blank"' : ''\}/);
  assert.match(page, /تنزيل صورة التقرير/);
  assert.match(page, /"تنزيل صورة التقرير": "Download report image"/);
});
