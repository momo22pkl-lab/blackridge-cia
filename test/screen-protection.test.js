'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { install, LOCK_ATTRIBUTE, OVERLAY_ID } = require('../screen-protection');

function eventTarget(target = {}) {
  const listeners = new Map();
  target.addEventListener = (name, handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
  };
  target.removeEventListener = (name, handler) => listeners.get(name)?.delete(handler);
  target.dispatch = (name, event = {}) => {
    for (const handler of listeners.get(name) || []) handler({ type: name, ...event });
  };
  return target;
}

function element(tagName) {
  const node = eventTarget({
    tagName,
    children: [],
    attributes: new Map(),
    dataset: {},
    hidden: false,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    hasAttribute(name) { return this.attributes.has(name); }
  });
  return node;
}

function findById(node, id) {
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function makeHarness({ hidden = false, validate, displayCapture } = {}) {
  const head = element('head');
  const body = element('body');
  const root = element('html');
  root.lang = 'en';
  root.appendChild(head);
  root.appendChild(body);
  const doc = eventTarget({
    documentElement: root,
    head,
    body,
    hidden,
    visibilityState: hidden ? 'hidden' : 'visible',
    createElement: (tagName) => element(tagName),
    getElementById: (id) => findById(root, id)
  });
  const mediaDevices = displayCapture
    ? { getDisplayMedia: displayCapture }
    : undefined;
  const win = eventTarget({
    document: doc,
    navigator: { mediaDevices },
    setTimeout,
    clearTimeout
  });
  if (validate) win.blackRidgeValidateScreenProtectionSession = validate;
  const controller = install(win, doc);

  return {
    doc,
    win,
    controller,
    layer: () => doc.getElementById(OVERLAY_ID),
    setVisible(isVisible) {
      doc.hidden = !isVisible;
      doc.visibilityState = isVisible ? 'visible' : 'hidden';
      doc.dispatch('visibilitychange');
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('backgrounding covers the page and return waits for fresh session validation', async () => {
  const gate = deferred();
  let validations = 0;
  const h = makeHarness({
    hidden: true,
    validate: () => {
      validations += 1;
      return gate.promise;
    }
  });

  assert.equal(h.controller.getSnapshot().locked, true);
  assert.equal(h.layer().dataset.state, 'background');
  h.setVisible(true);
  await Promise.resolve();
  assert.equal(h.layer().dataset.state, 'verifying');
  assert.equal(validations, 1);

  const pending = h.controller.retry();
  gate.resolve(true);
  assert.equal(await pending, true);
  assert.equal(h.doc.documentElement.hasAttribute(LOCK_ATTRIBUTE), false);
});

test('pagehide masks content and pageshow revalidates before revealing it', async () => {
  const reasons = [];
  const h = makeHarness({ validate: ({ reason }) => { reasons.push(reason); return true; } });

  h.win.dispatch('pagehide');
  assert.equal(h.controller.getSnapshot().locked, true);
  assert.equal(h.layer().dataset.state, 'background');
  h.win.dispatch('pageshow');
  await h.controller.retry();

  assert.ok(reasons.includes('foreground'));
  assert.equal(h.controller.getSnapshot().locked, false);
});

test('failed validation keeps the page black and a retry can recover', async () => {
  let validations = 0;
  const h = makeHarness({
    validate: () => {
      validations += 1;
      return validations > 1;
    }
  });

  h.setVisible(false);
  h.setVisible(true);
  await h.controller.retry();
  assert.equal(h.layer().dataset.state, 'failed');
  assert.equal(h.layer()._screenProtectionRetry.hidden, false);

  assert.equal(await h.controller.retry(), true);
  assert.equal(h.controller.getSnapshot().locked, false);
});

test('missing session validation fails closed', async () => {
  const h = makeHarness();
  h.setVisible(false);
  h.setVisible(true);
  await h.controller.retry();

  assert.equal(h.controller.getSnapshot().locked, true);
  assert.equal(h.layer().dataset.state, 'failed');
});

test('a late successful validation cannot reveal a page hidden again', async () => {
  const gate = deferred();
  const h = makeHarness({ validate: () => gate.promise });

  h.setVisible(false);
  h.setVisible(true);
  await Promise.resolve();
  const staleValidation = h.controller.retry();
  h.setVisible(false);
  gate.resolve(true);
  await staleValidation;

  assert.equal(h.controller.getSnapshot().locked, true);
  assert.equal(h.layer().dataset.state, 'background');
});

test('page-initiated display capture covers content until the capture track ends', async () => {
  const track = eventTarget({ readyState: 'live' });
  let validations = 0;
  const h = makeHarness({
    validate: () => { validations += 1; return true; },
    displayCapture: async function () {
      assert.equal(this, h.win.navigator.mediaDevices);
      return { getVideoTracks: () => [track] };
    }
  });

  await h.win.navigator.mediaDevices.getDisplayMedia({ video: true });
  assert.equal(h.controller.getSnapshot().captureActive, true);
  assert.equal(h.layer().dataset.state, 'capture');
  assert.equal(validations, 0);

  track.readyState = 'ended';
  track.dispatch('ended');
  await h.controller.retry();
  assert.equal(validations, 1);
  assert.equal(h.controller.getSnapshot().locked, false);
});

test('protected surfaces load the shared guard and do not fake screenshot blocking', () => {
  const root = path.join(__dirname, '..');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const ibpPages = fs.readFileSync(path.join(root, 'ibp/pages.js'), 'utf8');
  const ibpClient = fs.readFileSync(path.join(root, 'ibp/ibp.js'), 'utf8');
  const osd = fs.readFileSync(path.join(root, 'osd/index.html'), 'utf8');
  const shareHtml = fs.readFileSync(path.join(root, 'osd/share.html'), 'utf8');
  const shareJs = fs.readFileSync(path.join(root, 'osd/share.js'), 'utf8');
  const shareCss = fs.readFileSync(path.join(root, 'osd/share.css'), 'utf8');

  assert.match(index, /<script src="\/screen-protection\.js"><\/script>/);
  assert.match(server, /'\/screen-protection\.js': 'screen-protection\.js'/);
  assert.match(ibpPages, /screen-protection\.js/);
  assert.match(osd, /<script src="\/screen-protection\.js"><\/script>/);
  assert.match(shareHtml, /<script src="\/screen-protection\.js"><\/script>/);
  assert.match(index, /blackRidgeValidateScreenProtectionSession/);
  assert.match(ibpClient, /blackRidgeValidateScreenProtectionSession/);
  assert.match(fs.readFileSync(path.join(root, 'osd/app.js'), 'utf8'), /blackRidgeValidateScreenProtectionSession/);
  assert.match(shareJs, /blackRidgeValidateScreenProtectionSession/);
  assert.doesNotMatch(shareJs, /addEventListener\(['"](?:contextmenu|copy|cut)['"]/);
  assert.doesNotMatch(shareCss, /user-select\s*:\s*none/);
});
