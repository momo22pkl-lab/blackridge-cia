'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clientPath = path.resolve(__dirname, '..', 'notifications-client.js');

function createElement() {
  const listeners = new Map();
  return {
    id: '',
    className: '',
    dataset: {},
    hidden: false,
    innerHTML: '',
    textContent: '',
    children: [],
    listeners,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    },
    addEventListener(name, handler) { listeners.set(name, handler); },
    setAttribute() {},
    appendChild(child) { this.children.push(child); },
    insertBefore(child) { this.children.push(child); },
    insertAdjacentElement(_position, child) { this.children.push(child); },
    querySelector() { return createElement(); },
    querySelectorAll() { return []; },
    focus() { this.focused = true; },
    remove() {}
  };
}

test('notification deep link opens the owner-scoped official summons detail with live fields', () => {
  const elements = new Map();
  const document = {
    readyState: 'complete',
    body: {
      appendChild(element) {
        if (element.id) elements.set(element.id, element);
      }
    },
    head: { appendChild() {} },
    querySelector() { return null; },
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return createElement(); },
    addEventListener() {}
  };
  const readRecord = {
    id: 'NTF-owner-123',
    userId: 'member-owner',
    type: 'OFFICIAL_SUMMON',
    title: 'استدعاء رسمي',
    message: 'يرجى الحضور إلى القيادة <في الموعد>.',
    priority: 'NOTICE',
    status: 'SEEN',
    createdAt: '2026-10-29T09:20:00.000Z',
    readAt: '2026-10-29T09:20:01.000Z',
    relatedId: 'SUM-reference-123',
    metadata: {
      issuerName: 'القيادة الفعلية',
      issuerRank: 'CIA CHIEF',
      recipientName: 'المستلم الفعلي',
      subject: 'مراجعة المهمة الفعلية',
      summonsNumber: 'SUM-reference-123',
      issuedAt: '2026-10-29T09:20:00.000Z'
    }
  };
  const socketListeners = new Map();
  const calls = [];
  const socket = {
    connected: true,
    on(name, handler) { socketListeners.set(name, handler); },
    emit(name, payload, callback) {
      calls.push({ name, payload });
      if (name === 'notification:read') callback({ ok: true, notification: readRecord });
    }
  };
  const historyCalls = [];
  const window = {
    location: { href: 'https://blackridge.example/?notificationId=NTF-owner-123', search: '?notificationId=NTF-owner-123' },
    history: { state: null, replaceState(...args) { historyCalls.push(args); } },
    blackRidgeSocket: socket,
    blackRidgeGetNotificationSession: () => ({
      user: { id: 'member-owner' },
      authenticated: true,
      recovering: false
    }),
    addEventListener() {}
  };

  vm.runInNewContext(fs.readFileSync(clientPath, 'utf8'), {
    window,
    document,
    URL,
    URLSearchParams,
    console
  });

  const detail = elements.get('notification-detail-overlay');
  assert.ok(detail);
  assert.equal(detail.hidden, false);
  assert.match(detail.innerHTML, /القيادة الفعلية/);
  assert.match(detail.innerHTML, /المستلم الفعلي/);
  assert.match(detail.innerHTML, /مراجعة المهمة الفعلية/);
  assert.match(detail.innerHTML, /SUM-reference-123/);
  assert.match(detail.innerHTML, /&lt;في الموعد&gt;/);
  assert.doesNotMatch(detail.innerHTML, /<في الموعد>/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'notification:read');
  assert.equal(calls[0].payload.id, 'NTF-owner-123');
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0][2], '/');
});

test('notification deep link opens the owner-scoped security alert with live red-warning details', () => {
  const elements = new Map();
  const document = {
    readyState: 'complete',
    body: {
      appendChild(element) {
        if (element.id) elements.set(element.id, element);
      }
    },
    head: { appendChild() {} },
    querySelector() { return null; },
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return createElement(); },
    addEventListener() {}
  };
  const readRecord = {
    id: 'NTF-security-owner-456',
    userId: 'member-security-owner',
    type: 'SECURITY_ALERT',
    title: 'تحذير أمني',
    message: 'تم رصد نشاط <غير معتاد> & يرجى التحقق.',
    priority: 'CRITICAL',
    status: 'SEEN',
    createdAt: '2026-10-29T09:20:00.000Z',
    readAt: '2026-10-29T09:20:01.000Z',
    metadata: {
      issuerName: 'القيادة الفعلية',
      issuerRank: 'CIA CHIEF',
      recipientName: 'المستلم الفعلي',
      subject: 'نشاط أمني قرب الموقع',
      warningLevel: 'CRITICAL',
      issuedAt: '2026-10-29T09:20:00.000Z'
    }
  };
  const socketListeners = new Map();
  const calls = [];
  const socket = {
    connected: true,
    on(name, handler) { socketListeners.set(name, handler); },
    emit(name, payload, callback) {
      calls.push({ name, payload });
      if (name === 'notification:read') callback({ ok: true, notification: readRecord });
    }
  };
  const historyCalls = [];
  const window = {
    location: { href: 'https://blackridge.example/?notificationId=NTF-security-owner-456', search: '?notificationId=NTF-security-owner-456' },
    history: { state: null, replaceState(...args) { historyCalls.push(args); } },
    blackRidgeSocket: socket,
    blackRidgeGetNotificationSession: () => ({
      user: { id: 'member-security-owner' },
      authenticated: true,
      recovering: false
    }),
    addEventListener() {}
  };

  vm.runInNewContext(fs.readFileSync(clientPath, 'utf8'), {
    window,
    document,
    URL,
    URLSearchParams,
    console
  });

  const detail = elements.get('notification-detail-overlay');
  assert.ok(detail);
  assert.equal(detail.hidden, false);
  assert.match(detail.innerHTML, /تحذير أمني/);
  assert.match(detail.innerHTML, /مستوى التحذير/);
  assert.match(detail.innerHTML, /عاجل/);
  assert.match(detail.innerHTML, /القيادة الفعلية/);
  assert.match(detail.innerHTML, /المستلم الفعلي/);
  assert.match(detail.innerHTML, /نشاط أمني قرب الموقع/);
  assert.match(detail.innerHTML, /&lt;غير معتاد&gt; &amp; يرجى التحقق/);
  assert.doesNotMatch(detail.innerHTML, /<غير معتاد>/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'notification:read');
  assert.equal(calls[0].payload.id, 'NTF-security-owner-456');
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0][2], '/');
});
