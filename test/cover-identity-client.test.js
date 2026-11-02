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
