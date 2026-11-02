'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clientSource = fs.readFileSync(path.join(__dirname, '..', 'cover-identity-client.js'), 'utf8');

function makeCanvas() {
  const renderedText = [];
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
    translate() {},
    rotate() {},
    clip() {},
    drawImage() {},
    fillText(text) { renderedText.push(String(text)); },
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
    renderedText
  };
}

test('renders six distinct fictional badge themes and visible expiry/revocation status', async () => {
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
      status: 'ACTIVE'
    });
    assert.equal(output.canvas.width, 1011);
    assert.equal(output.canvas.height, 638);
    assert.ok(output.renderedText.some((text) => text.includes('FICTIONAL IN-GAME DOCUMENT')));
    assert.ok(output.renderedText.some((text) => text.includes('NOT A REAL ID')));
  }

  const expired = makeCanvas();
  await renderer.drawBadge(expired.canvas, {
    type: 'POLICE',
    badgeNumber: 'PD-123456',
    alias: 'Raven',
    title: 'Investigator',
    sector: 'Field Office',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T23:59:00.000Z',
    status: 'REVOKED'
  });
  assert.ok(expired.renderedText.includes('ملغى'));
});
