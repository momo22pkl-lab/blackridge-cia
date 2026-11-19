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

test('main page uses WebSocket transport to avoid polling session affinity', () => {
  assert.ok(html.includes("const ciaSocket = typeof io === 'function' ? io({ transports: ['websocket'] }) : null;"));
});

test('main page clears the stale server-not-ready message when the socket reconnects', () => {
  const connectStart = html.indexOf("ciaSocket.on('connect', function() {");
  const connectEnd = html.indexOf("ciaSocket.on('radio:service-ended'", connectStart);
  assert.ok(connectStart >= 0 && connectEnd > connectStart, 'Socket.IO connect handler exists');
  const connectHandler = html.slice(connectStart, connectEnd);
  assert.ok(connectHandler.includes("const authMsg = document.getElementById('auth-msg');"));
  assert.ok(connectHandler.includes("if (authMsg && authMsg.innerText === 'الاتصال بالسيرفر غير جاهز.') authMsg.innerText = '';"));
});
