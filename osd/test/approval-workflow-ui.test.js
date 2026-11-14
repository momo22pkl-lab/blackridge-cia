'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function section(start, end) {
  const startAt = app.indexOf(start);
  const endAt = app.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing section: ${start}`);
  assert.notEqual(endAt, -1, `missing section end: ${end}`);
  return app.slice(startAt, endAt);
}

test('creator actions require the creator account and assigned reviewer alone sees decision controls', () => {
  const actions = section('function modalActions(document)', 'function showDocument(document)');
  assert.ok(actions.includes("document.status === 'PENDING SIGNATURE' && isCreator"));
  assert.ok(actions.includes("document.status === 'SIGNED' && isCreator"));
  assert.ok(actions.includes("document.approvalAssignedTo === state.user?.id"));
  assert.ok(actions.includes("data-action=\"rejectDocument\""));
});

test('approval inbox renders assigned documents instead of every document awaiting approval', () => {
  const rows = section('function renderRows()', 'async function loadDocuments()');
  const inboxLoader = section('async function loadApprovalInbox()', 'function renderNotifications()');
  assert.ok(rows.includes('const pending = state.inbox'));
  assert.ok(inboxLoader.includes("request('/approval-inbox')"));
});

test('creator signing, submission, rejection reason, and notification deep links are wired', () => {
  const actions = section('async function actOnDocument(action, id)', 'let signingDocumentId');
  assert.ok(actions.includes('/prepare-signature'));
  assert.ok(actions.includes('/signature'));
  assert.ok(actions.includes('/submit'));
  assert.ok(actions.includes('/reject'));
  assert.ok(actions.includes("window.prompt(t('rejectionPrompt'))"));
  assert.ok(app.includes("request('/notifications')"));
  assert.ok(app.includes("request('/approval-inbox')"));
  assert.ok(app.includes("get('document')"));
  assert.ok(page.includes('id="notificationPanel"'));
  assert.ok(page.includes('data-action="toggleNotifications"'));
  assert.ok(!app.includes('localStorage'));
});
