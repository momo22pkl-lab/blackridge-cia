'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const clientPath = path.join(root, 'ibp', 'world-command-battalions.js');
const mapPath = path.join(root, 'ibp', 'los-santos-map-reference.jpg');
const viewHeight = 1000;

class FakeElement {
  constructor(document, id = '') {
    this.ownerDocument = document;
    this.id = id;
    this.attributes = {};
    this.listeners = new Map();
    this._innerHTML = '';
    this.textContent = '';
    this.hidden = false;
    this.style = {};
    this.classList = {
      toggle: () => {},
      remove: () => {},
      add: () => {}
    };
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    if (this.id === 'brw-page-content') this.ownerDocument.mountContent(this._innerHTML);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  closest(selector) {
    const attributes = {
      '[data-br-page]': 'data-br-page',
      '[data-br2-select]': 'data-br2-select',
      '[data-br2-action]': 'data-br2-action',
      '[data-br2-unit]': 'data-br2-unit'
    };
    const attribute = attributes[selector];
    return attribute && Object.hasOwn(this.attributes, attribute) ? this : null;
  }

  appendChild(child) {
    if (child.id) this.ownerDocument.nodes.set(child.id, child);
    return child;
  }
}

class FakeSvg extends FakeElement {
  constructor(document) {
    super(document, 'br2-map-svg');
    this.pointerCapture = null;
  }

  createSVGPoint() {
    return {
      x: 0,
      y: 0,
      matrixTransform(matrix) {
        return matrix.convert(this.x, this.y);
      }
    };
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1000, height: viewHeight };
  }

  getScreenCTM() {
    const [x, y, width, height] = this.getAttribute('viewBox').split(/\s+/).map(Number);
    const rect = this.getBoundingClientRect();
    return {
      inverse: () => ({
        convert: (clientX, clientY) => ({
          x: x + clientX / rect.width * width,
          y: y + clientY / rect.height * height
        })
      })
    };
  }

  setPointerCapture(pointerId) {
    this.pointerCapture = pointerId;
  }

  dispatch(name, event) {
    const callback = this.listeners.get(name);
    return callback ? callback(event) : undefined;
  }
}

class FakeDocument {
  constructor() {
    this.nodes = new Map();
    this.contentNodes = new Map();
    this.listeners = new Map();
    this.__br2Mounted = false;
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    for (const id of ['brw-page-content', 'brw-side-panels', 'brw-page-title', 'brw-page-description']) {
      this.nodes.set(id, new FakeElement(this, id));
    }
  }

  getElementById(id) {
    return this.contentNodes.get(id) || this.nodes.get(id) || null;
  }

  createElement() {
    return new FakeElement(this);
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  fire(name, event) {
    const callback = this.listeners.get(name);
    return callback ? callback(event) : undefined;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  mountContent(markup) {
    this.contentNodes.clear();
    for (const match of markup.matchAll(/\bid="([^"]+)"/g)) {
      const id = match[1];
      const element = id === 'br2-map-svg' ? new FakeSvg(this) : new FakeElement(this, id);
      const openingTag = markup.match(new RegExp('<[^>]*\\bid="' + id + '"[^>]*>'));
      if (openingTag) {
        for (const attribute of openingTag[0].matchAll(/([a-zA-Z_:][\w:.-]*)="([^"]*)"/g)) {
          element.attributes[attribute[1]] = attribute[2];
        }
      }
      this.contentNodes.set(id, element);
    }
  }
}

function target(document, attributes = {}) {
  const element = new FakeElement(document);
  element.attributes = attributes;
  return element;
}

function clickEvent(element) {
  return {
    target: element,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {}
  };
}

function makeHarness() {
  const document = new FakeDocument();
  const calls = [];
  const serverUnits = [{
    id: 'unit-live-01',
    code: 'NORTH-01',
    name: 'Northern Battalion',
    sector: 'NORTH',
    status: 'ACTIVE',
    color: '#55aacc',
    emblem: 'SHIELD',
    mapPosition: { x: 500, y: 350 },
    operationArea: { type: 'CIRCLE', center: { x: 500, y: 350 }, radius: 70 },
    commanderCode: 'CMD-01',
    commanderName: 'Field Commander',
    deputyCode: 'DPTY-01',
    deputyName: 'Deputy Commander',
    radioChannel: 'R-14',
    memberCount: 2,
    onlineMembers: 1,
    members: [{ name: 'Field Commander', publicCode: 'CMD-01', online: true }],
    movementHistory: [],
    reports: [],
    canManage: true
  }];
  const socket = {
    connected: true,
    on() {},
    emit(eventName, payload, callback) {
      calls.push({ eventName, payload });
      if (eventName === 'ibp:phase2:list') {
        callback({ ok: true, battalions: structuredClone(serverUnits), canCreate: false });
        return;
      }
      if (eventName === 'ibp:phase2:location') {
        const unit = serverUnits.find((entry) => entry.id === payload.battalionId);
        unit.mapPosition = structuredClone(payload.position);
        callback({ ok: true, battalion: structuredClone(unit) });
        return;
      }
      callback({ ok: false, message: 'Unexpected test event: ' + eventName });
    }
  };
  const window = {
    blackRidgeSocket: socket,
    blackRidgeGetNotificationSession: () => ({ user: { id: 'authorized-user' }, authenticated: true }),
    confirm: () => true
  };
  let timerId = 0;
  const context = {
    window,
    document,
    setTimeout: () => ++timerId,
    clearTimeout() {},
    console,
    structuredClone
  };
  vm.runInNewContext(fs.readFileSync(clientPath, 'utf8'), context, { filename: clientPath });
  return { document, calls, serverUnits };
}

function viewport(svg) {
  return svg.getAttribute('viewBox').split(/\s+/).map(Number);
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 7 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += segmentLength;
  }
  return null;
}

test('the map uses the existing high-resolution Los Santos map and exposes the server-backed battalion record', async () => {
  const { document, calls } = makeHarness();
  document.fire('click', clickEvent(target(document, { 'data-br-page': 'map' })));
  await new Promise((resolve) => setImmediate(resolve));

  let svg = document.getElementById('br2-map-svg');
  assert.ok(svg);
  assert.match(document.getElementById('brw-page-content').innerHTML, /href="https:\/\/www\.bragitoff\.com\/wp-content\/uploads\/2015\/11\/GTAV-HD-MAP-roadmap\.jpg"/);
  assert.doesNotMatch(document.getElementById('brw-page-content').innerHTML, /br2-map-land|br2-map-ocean/);
  assert.ok(calls.some((call) => call.eventName === 'ibp:phase2:list'));
  const image = document.getElementById('br2-map-image');
  assert.equal(image.getAttribute('href'), 'https://www.bragitoff.com/wp-content/uploads/2015/11/GTAV-HD-MAP-roadmap.jpg');
  image.listeners.get('error')();
  assert.equal(image.getAttribute('href'), 'https://www.gta5.info/p/files/gta5-satellite-map.jpg');
  image.listeners.get('error')();
  assert.equal(image.getAttribute('href'), '/ibp/los-santos-map-reference.jpg');

  const markerLayer = document.getElementById('br2-markers');
  assert.match(markerLayer.innerHTML, /data-br2-unit="unit-live-01"/);
  await svg.dispatch('click', clickEvent(target(document, { 'data-br2-unit': 'unit-live-01' })));

  const panel = document.getElementById('br2-map-panel');
  assert.match(panel.innerHTML, /Northern Battalion/);
  assert.match(panel.innerHTML, /Field Commander/);
  assert.match(document.getElementById('br2-areas').innerHTML, /<ellipse class="br2-area"/);
});

test('map zoom, wheel navigation, pointer drag, marker selection and saved locations stay in the original server coordinate system', async () => {
  const { document, calls, serverUnits } = makeHarness();
  document.fire('click', clickEvent(target(document, { 'data-br-page': 'map' })));
  await new Promise((resolve) => setImmediate(resolve));

  let svg = document.getElementById('br2-map-svg');
  await svg.dispatch('click', clickEvent(target(document, { 'data-br2-unit': 'unit-live-01' })));
  document.fire('click', clickEvent(target(document, { 'data-br2-action': 'set-location' })));
  svg = document.getElementById('br2-map-svg');

  await svg.dispatch('click', {
    ...clickEvent(target(document)),
    clientX: 500,
    clientY: viewHeight / 2
  });
  const move = calls.find((call) => call.eventName === 'ibp:phase2:location');
  assert.equal(move.payload.position.x, 500);
  assert.equal(move.payload.position.y, 350);
  assert.deepEqual(serverUnits[0].mapPosition, { x: 500, y: 350 });

  document.fire('click', clickEvent(target(document, { 'data-br2-action': 'zoom-in' })));
  svg = document.getElementById('br2-map-svg');
  let [x, y, width, height] = viewport(svg);
  assert.ok(width < 1000);
  assert.equal(height, width);

  await svg.dispatch('wheel', {
    target: target(document),
    clientX: 500,
    clientY: viewHeight / 2,
    deltaY: -120,
    preventDefault() {}
  });
  const afterWheel = viewport(svg);
  assert.ok(afterWheel[2] < width);
  assert.equal(afterWheel[3], afterWheel[2]);

  const beforePan = viewport(svg);
  svg.dispatch('pointerdown', { target: target(document), clientX: 500, clientY: viewHeight / 2, pointerId: 7 });
  svg.dispatch('pointermove', { clientX: 530, clientY: viewHeight / 2 + 25, pointerId: 7 });
  svg.dispatch('pointerup', { pointerId: 7 });
  const afterPan = viewport(svg);
  assert.notDeepEqual(afterPan.slice(0, 2), beforePan.slice(0, 2));
  assert.equal(svg.pointerCapture, 7);

  svg.dispatch('pointerdown', { target: target(document), clientX: 20, clientY: 20, pointerId: 8 });
  svg.dispatch('pointermove', { clientX: 10000, clientY: 10000, pointerId: 8 });
  svg.dispatch('pointerup', { pointerId: 8 });
  const bounded = viewport(svg);
  assert.ok(bounded[0] >= 0 && bounded[1] >= 0);
  assert.ok(bounded[0] + bounded[2] <= 1000.0001);
  assert.ok(bounded[1] + bounded[3] <= viewHeight + 0.0001);
});

test('the interactive map uses its existing high-resolution sources and a local JPEG fallback served inside IBP', () => {
  const asset = fs.readFileSync(mapPath);
  assert.deepEqual([...asset.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual(jpegDimensions(asset), { width: 483, height: 524 });
  const legacyMap = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(legacyMap, /GTAV-HD-MAP-roadmap\.jpg/);
  assert.match(legacyMap, /gta5-satellite-map\.jpg/);
  assert.match(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), /'\/ibp\/los-santos-map-reference\.jpg': path\.join\('ibp', 'los-santos-map-reference\.jpg'\)/);
  assert.match(fs.readFileSync(clientPath, 'utf8'), /ibp:phase2:list/);
});
