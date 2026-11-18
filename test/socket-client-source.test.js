'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('main page loads the Socket.IO client from the same origin', () => {
  assert.ok(html.includes('<script src="/socket.io/socket.io.js"></script>'));
  assert.ok(!html.includes('https://cdn.socket.io'));
});
