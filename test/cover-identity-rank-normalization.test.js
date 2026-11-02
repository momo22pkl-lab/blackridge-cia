'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = serverSource.indexOf('function normalizeRank(rank) {');
const end = serverSource.indexOf('\nfunction rankLabel', start);
assert.ok(start >= 0 && end > start, 'server rank normalizer should be present');
const clean = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const normalizeRank = vm.runInNewContext('(' + serverSource.slice(start, end) + ')', { clean });

test('recognizes Senior Commander role labels used by the cover identity review', () => {
  assert.equal(normalizeRank('Senior Commander'), 'SUPREME COMMANDER');
  assert.equal(normalizeRank('Senior Commander CIA'), 'SUPREME COMMANDER');
  assert.equal(normalizeRank('High Commander'), 'HIGH COMMANDER');
});
