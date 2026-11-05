'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Personnel API exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Personnel API did not become ready.');
}

test('direct personnel REST writes reject blocked text and accept clean text before persistence', async (t) => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackridge-personnel-moderation-'));
  const serverPath = path.join(__dirname, '..', 'blackridge-personnel-module', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      BLACKRIDGE_PERSONNEL_DATA_DIR: dataDir,
      NODE_ENV: 'test'
    },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForHealth(`${base}/api/health`, child);

  async function jsonCall(url, body, headers = {}) {
    const response = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    return { response, data: await response.json() };
  }

  const before = (await fetch(`${base}/api/state`)).json();
  const beforeState = await before;
  const blockedInquiry = await jsonCall('/api/inquiries', {
    code: 'AG-1042',
    subject: 'Service question',
    body: 'That is shit.'
  });
  assert.equal(blockedInquiry.response.status, 400);
  assert.match(blockedInquiry.data.error, /منع/);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).inquiries.length, beforeState.inquiries.length);

  const cleanInquiry = await jsonCall('/api/inquiries', {
    code: 'AG-1042',
    subject: 'Service question',
    body: 'Please review my account access request.'
  });
  assert.equal(cleanInquiry.response.status, 201);

  const blockedWarning = await jsonCall('/api/warnings', {
    code: 'AG-1042',
    reason: 'That is shit.',
    note: 'Please review the procedure.'
  });
  assert.equal(blockedWarning.response.status, 400);
  const warningAfterBlock = await fetch(`${base}/api/state`).then((response) => response.json());
  assert.equal(warningAfterBlock.warnings.length, beforeState.warnings.length);

  const highCommander = { 'X-Demo-Role': 'HIGH COMMANDER', 'X-Demo-Actor': 'HC-MOD-TEST' };
  const cleanWarning = await jsonCall('/api/warnings', {
    code: 'AG-1042',
    reason: 'Missed the required check-in.',
    note: 'Please follow the duty schedule.'
  }, highCommander);
  assert.equal(cleanWarning.response.status, 201);
  const warningId = cleanWarning.data.warning.id;

  const blockedSuspension = await jsonCall('/api/suspensions', {
    code: 'AG-1042',
    durationSeconds: 60,
    reason: 'That is shit.',
    note: ''
  });
  assert.equal(blockedSuspension.response.status, 400);
  assert.equal((await fetch(`${base}/api/status/AG-1042`).then((response) => response.json())).suspension, null);

  const cleanSuspension = await jsonCall('/api/suspensions', {
    code: 'AG-1042',
    durationSeconds: 60,
    reason: 'Repeated missed check-ins.',
    note: 'Review the schedule before returning.'
  });
  assert.equal(cleanSuspension.response.status, 201);
  await fetch(`${base}/api/suspensions/AG-1042/lift`, { method: 'POST' });

  const blockedDismissal = await jsonCall('/api/dismissals/AG-1042', { reason: 'That is shit.' });
  assert.equal(blockedDismissal.response.status, 400);
  assert.equal((await fetch(`${base}/api/status/AG-1042`).then((response) => response.json())).dismissed, false);
  const cleanDismissal = await jsonCall('/api/dismissals/AG-1135', {
    reason: 'Repeated failure to follow the duty schedule.'
  });
  assert.equal(cleanDismissal.response.status, 201);
  assert.equal((await fetch(`${base}/api/status/AG-1135`).then((response) => response.json())).dismissed, true);

  async function reportCall(reportBody, includePdf) {
    const form = new FormData();
    form.set('warningId', warningId);
    form.set('reportBody', reportBody);
    if (includePdf) form.set('pdf', new Blob(['%PDF-1.4\n% test attachment'], { type: 'application/pdf' }), 'report.pdf');
    const response = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: highCommander,
      body: form
    });
    return { response, data: await response.json() };
  }

  const blockedReport = await reportCall('That is shit.', false);
  assert.equal(blockedReport.response.status, 400);
  assert.equal((await fetch(`${base}/api/state`).then((response) => response.json())).reports.length, 0);
  const cleanReport = await reportCall('This report documents the completed review.', true);
  assert.equal(cleanReport.response.status, 201);

  const finalState = await fetch(`${base}/api/state`).then((response) => response.json());
  assert.equal(finalState.inquiries.length, beforeState.inquiries.length + 1);
  assert.equal(finalState.warnings.length, beforeState.warnings.length + 1);
  assert.equal(finalState.reports.length, 1);
});
