'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clientSource = fs.readFileSync(path.join(__dirname, '..', 'cover-identity-client.js'), 'utf8');

function makeCanvas() {
  const renderedText = [];
  const drawnText = [];
  const translations = [];
  const context2d = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    arcTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    fillRect() {},
    arc() {},
    translate(x, y) { translations.push([x, y]); },
    rotate() {},
    clip() {},
    drawImage() {},
    fillText(text, x, y) { const value = String(text); renderedText.push(value); drawnText.push({ text: value, x, y, align: context2d.textAlign }); },
    measureText(text) { return { width: String(text).length * 8 }; },
    createLinearGradient() { return { addColorStop() {} }; }
  };
  return {
    canvas: {
      width: 0,
      height: 0,
      getContext(type) {
        assert.equal(type, '2d');
        return context2d;
      }
    },
    renderedText, drawnText, translations
  };
}

test('renders distinct badge themes without presenting an unreviewed identity as approved', async () => {
  const document = {
    readyState: 'loading',
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; }
  };
  const window = {};
  vm.runInNewContext(clientSource, { document, window, setInterval() { return 0; } });

  const renderer = window.blackRidgeCoverIdentity;
  const types = ['MILITARY', 'POLICE', 'EMS', 'MEDIA', 'JUSTICE', 'CIVILIAN'];
  assert.deepEqual(Object.keys(renderer.THEMES), types);
  assert.equal(new Set(Object.values(renderer.THEMES).map((theme) => theme.bg.join('|') + theme.accent)).size, 6);

  for (const type of types) {
    const output = makeCanvas();
    await renderer.drawBadge(output.canvas, {
      type,
      badgeNumber: type + '-123456',
      alias: 'Raven',
      title: 'Field Analyst',
      sector: 'Special Projects',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-08T23:59:00.000Z',
      status: 'PENDING_REVIEW',
      reviewStatus: 'PENDING_REVIEW',
      isApproved: false
    });
    assert.equal(output.canvas.width, 1011);
    assert.equal(output.canvas.height, 638);
    const emblem = output.translations.find((point) => point[1] === 56);
    assert.deepEqual(emblem, [680, 56]);
    for (const title of [renderer.THEMES[type].ar, renderer.THEMES[type].en]) {
      const renderedTitle = output.drawnText.find((item) => item.text === title);
      assert.ok(renderedTitle, 'badge title should be rendered');
      assert.ok(renderedTitle.x - title.length * 8 > emblem[0] + 29, 'type title must not overlap the emblem');
    }
    assert.ok(output.renderedText.some((text) => text.includes('قيد المراجعة — غير معتمدة')));
    assert.ok(output.renderedText.some((text) => text.includes('PENDING REVIEW · NOT APPROVED')));
    assert.equal(output.renderedText.some((text) => text.includes('هوية معتمدة رسميًا داخل BLACKRIDGE CITY ROLEPLAY')), false);
    assert.equal(output.renderedText.some((text) => text.includes('وثيقة خيالية خاصة')), false);
  }

  const approved = makeCanvas();
  await renderer.drawBadge(approved.canvas, {
    type: 'MILITARY',
    badgeNumber: 'MIL-654321',
    alias: 'Raven',
    title: 'Field Analyst',
    sector: 'Special Projects',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T23:59:00.000Z',
    status: 'ACTIVE',
    reviewStatus: 'APPROVED',
    isApproved: true
  });
  assert.ok(approved.renderedText.includes('هوية معتمدة رسميًا داخل BLACKRIDGE CITY ROLEPLAY، وقد تمت مراجعتها والموافقة عليها من الجهات المخوّلة.'));
  assert.ok(approved.renderedText.includes('APPROVED IN BLACKRIDGE CITY ROLEPLAY ONLY · NOT A GOVERNMENT ID'));

  const rejected = makeCanvas();
  await renderer.drawBadge(rejected.canvas, {
    type: 'POLICE',
    badgeNumber: 'PD-123456',
    alias: 'Raven',
    title: 'Investigator',
    sector: 'Field Office',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T23:59:00.000Z',
    status: 'REJECTED',
    reviewStatus: 'REJECTED',
    isApproved: false
  });
  assert.ok(rejected.renderedText.includes('مرفوضة — غير معتمدة داخل النظام'));
  assert.ok(rejected.renderedText.includes('REJECTED · NOT APPROVED'));
  assert.equal(rejected.renderedText.some((text) => text.includes('هوية معتمدة رسميًا')), false);
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.nodeType = 1;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.value = '';
    this.style = {};
    this._text = '';
  }
  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      this.children.push(node);
      node.parentNode = this;
    }
  }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent || '').join(''); }
  set textContent(value) { this._text = String(value || ''); this.children = []; }
  async click() {
    for (const handler of this.listeners.click || []) await handler({ target: this });
  }
}

function mountReviewQueueClient(config) {
  const options = config || {};
  const body = new FakeElement('body');
  const content = new FakeElement('main');
  content.className = 'content-area';
  const nav = new FakeElement('button');
  nav.id = 'cover-identity-nav';
  body.append(nav, content);
  const find = (node, predicate) => {
    if (predicate(node)) return node;
    for (const child of node.children || []) {
      const match = find(child, predicate);
      if (match) return match;
    }
    return null;
  };
  const document = {
    readyState: 'complete',
    body,
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    getElementById: (id) => find(body, (node) => node.id === id),
    querySelector: (selector) => selector === '.content-area' ? content : null,
    addEventListener() {}
  };
  const pending = {
    id: 'CVR-QUEUE-1',
    badgeNumber: 'MIL-555555',
    type: 'MILITARY',
    typeLabel: 'هوية عسكرية',
    alias: 'Raven',
    sector: 'Special Operations',
    expiresAt: '2026-12-31T23:59:00.000Z',
    status: 'PENDING_REVIEW',
    owner: { name: 'Member One', militaryCode: 'AG-101' },
    can: options.badgeCan || { approve: true, reject: true }
  };
  let queue = [pending];
  const events = [];
  const window = {
    blackRidgeSocket: {
      emit(event, payload, callback) {
        events.push({ event, payload });
        let reply;
        if (event === 'cover:meta') {
          reply = { ok: true, canAdmin: true, canReviewQueue: true, isChief: false, scope: 'SECTOR', ...(options.meta || {}) };
        } else if (event === 'cover:review:list') {
          reply = { ok: true, scope: (options.meta && options.meta.scope) || 'SECTOR', total: queue.length, badges: queue.slice() };
        } else if (event === 'cover:approve') {
          queue = [];
          reply = { ok: true, badge: { ...pending, status: 'ACTIVE', isApproved: true } };
        } else if (event === 'cover:reject') {
          queue = [];
          reply = { ok: true, badge: { ...pending, status: 'REJECTED', isApproved: false, statusReason: payload.reason } };
        } else {
          reply = { ok: false, message: 'unexpected event: ' + event };
        }
        callback(reply);
      }
    }
  };
  vm.runInNewContext(clientSource, {
    document,
    window,
    currentUser: options.currentUser || { id: 'commander-1' },
    ciaSessionAuthenticated: true,
    setInterval() { return 0; },
    setTimeout,
    clearTimeout
  });
  return { nav, content, events };
}

function findButton(node, label) {
  if (node.tagName === 'button' && node.textContent === label) return node;
  for (const child of node.children || []) {
    const match = findButton(child, label);
    if (match) return match;
  }
  return null;
}

function findElement(node, tagName, className) {
  if (node.tagName === tagName && node.className === className) return node;
  for (const child of node.children || []) {
    const match = findElement(child, tagName, className);
    if (match) return match;
  }
  return null;
}

test('shows accept/cancel actions to an authorized reviewer and requires a cancellation reason', async () => {
  const client = mountReviewQueueClient({ meta: { isSenior: true, scope: 'ALL' } });
  await client.nav.click();
  await new Promise((resolve) => setImmediate(resolve));

  const text = client.content.textContent;
  assert.ok(text.includes('مراجعات الهويات'));
  assert.ok(text.includes('الهويات والبادجات المعلّقة للمراجعة'));
  assert.ok(text.includes('قبول البادج'));
  assert.ok(text.includes('إلغاء البادج'));
  assert.ok(text.includes('صلاحية قبول أو إلغاء البادج لـ CIA CHIEF وSenior Commander CIA فقط.'));
  assert.equal(text.includes('وثيقة خيالية للاستخدام داخل BLACKRIDGE CITY ROLEPLAY'), false);
  assert.equal(text.includes('لا تُستخدم شعارات أو أختام حكومية حقيقية'), false);

  const cancel = findButton(client.content, 'إلغاء البادج');
  const reason = findElement(client.content, 'textarea', 'cvr-review-reason');
  assert.ok(cancel);
  assert.ok(reason);
  await cancel.click();
  assert.equal(client.events.some((item) => item.event === 'cover:reject'), false, 'blank cancellation reason must not be sent');
  assert.ok(client.content.textContent.includes('اكتب سبب الإلغاء أولًا.'));
  reason.value = 'بيانات المهمة ناقصة';
  await cancel.click();
  const cancellation = client.events.find((item) => item.event === 'cover:reject');
  assert.equal(cancellation.payload.reason, 'بيانات المهمة ناقصة');
  assert.ok(client.events.some((item) => item.event === 'cover:review:list'));
});

test('Senior Commander approval button invokes the server event and refreshes the queue', async () => {
  const client = mountReviewQueueClient({ meta: { isSenior: true, scope: 'ALL' } });
  await client.nav.click();
  await new Promise((resolve) => setImmediate(resolve));
  const approve = findButton(client.content, 'قبول البادج');
  assert.ok(approve, 'authorized reviewer should see the approval button');
  await approve.click();
  assert.ok(client.events.some((item) => item.event === 'cover:approve'));
  assert.ok(client.events.filter((item) => item.event === 'cover:review:list').length >= 2);
  assert.ok(client.content.textContent.includes('لا توجد هويات بانتظار المراجعة'));
  assert.ok(client.content.textContent.includes('تم قبول البادج وأصبحت هوية ميدانية معتمدة رسميًا داخل النظام.'));
});

test('CIA CHIEF receives review actions across all sectors', async () => {
  const client = mountReviewQueueClient({
    meta: { isChief: true, scope: 'ALL' },
    badgeCan: { approve: true, reject: true }
  });
  await client.nav.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(client.content.textContent.includes('مراجعات الهويات'));
  assert.ok(client.content.textContent.includes('الهويات والبادجات المعلّقة للمراجعة'));
  assert.ok(client.content.textContent.includes('صلاحية قبول أو إلغاء البادج لـ CIA CHIEF وSenior Commander CIA فقط.'));
  assert.ok(findButton(client.content, 'التفاصيل'));
  assert.ok(findButton(client.content, 'قبول البادج'));
  assert.ok(findButton(client.content, 'إلغاء البادج'));
  assert.ok(client.events.some((item) => item.event === 'cover:review:list'));
  assert.equal(client.events.some((item) => item.event === 'cover:approve' || item.event === 'cover:reject'), false);
});
test('sector commanders do not receive the review queue or decision buttons', async () => {
  const client = mountReviewQueueClient({
    meta: { canReviewQueue: false, isChief: false, scope: 'SECTOR' },
    badgeCan: { approve: false, reject: false }
  });
  await client.nav.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(findButton(client.content, 'مراجعات القطاع'), null);
  assert.equal(findButton(client.content, 'قبول البادج'), null);
  assert.equal(findButton(client.content, 'إلغاء البادج'), null);
  assert.equal(client.events.some((item) => item.event === 'cover:review:list'), false);
});

