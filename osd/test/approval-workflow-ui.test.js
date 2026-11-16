'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

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
  assert.ok(actions.includes('data-action="approveDocument"'));
  assert.ok(actions.includes("data-action=\"rejectDocument\""));
  assert.ok(actions.includes('button-reject'));
});

test('approval inbox renders assigned documents instead of every document awaiting approval', () => {
  const rows = section('function renderRows()', 'async function loadDocuments()');
  const inboxLoader = section('async function loadApprovalInbox()', 'function renderNotifications()');
  assert.ok(rows.includes('const pending = state.inbox'));
  assert.ok(rows.includes('reviewCreatorCell(doc)'));
  assert.ok(rows.includes('reviewSignatureCell(doc)'));
  assert.ok(rows.includes('reviewSubmissionCell(doc)'));
  assert.ok(rows.includes('reviewActionsCell(doc)'));
  assert.ok(inboxLoader.includes("request('/approval-inbox')"));
});

test('review rows show accept and reject only to the assigned authorized reviewer', () => {
  const actions = section('function reviewActionsCell(document)', 'function filteredDocuments(');
  assert.ok(actions.includes("document.status === 'PENDING APPROVAL'"));
  assert.ok(actions.includes('document.approvalAssignedTo === state.user?.id'));
  assert.ok(actions.includes("can('APPROVE_DOCUMENTS')"));
  assert.ok(actions.includes('data-action="approveDocument"'));
  assert.ok(actions.includes('data-action="rejectDocument"'));
});

test('CIA Chief submission shows automatic approval instead of a review message', () => {
  const actions = section('async function actOnDocument(action, id)', 'let signingDocumentId');
  assert.ok(actions.includes("action === 'submitForApproval' && result.document?.status === 'APPROVED'"));
  assert.ok(actions.includes("t('autoApproved')"));
  assert.equal(app.split('autoApproved:').length - 1, 2);
});

test('review queue shows creator identity, signature time and reviewer assignment time', () => {
  assert.ok(app.includes('signature?.signerName'));
  assert.ok(app.includes('signature?.signerRank'));
  assert.ok(app.includes('signature?.militaryCode'));
  assert.ok(app.includes('signature.signedAt'));
  assert.ok(app.includes('document.approvalAssignee?.assignedAt'));
  assert.ok(page.includes('data-i18n="reviewCreator"'));
  assert.ok(page.includes('data-i18n="reviewSignature"'));
  assert.ok(page.includes('data-i18n="submittedAtLabel"'));
  assert.ok(styles.includes('.review-queue-table'));
  assert.ok(styles.includes('.review-signature-recorded'));
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
  assert.ok(app.includes('location.assign(link.href)'));
  assert.ok(page.includes('id="notificationPanel"'));
  assert.ok(page.includes('data-action="toggleNotifications"'));
  assert.ok(app.includes('button-reject'));
  assert.ok(app.includes('rejectionPrompt'));
  assert.ok(app.includes('rejectionReason'));
  assert.ok(!app.includes('localStorage'));
});

test('approval workflow stages have Arabic and English status labels', () => {
  for (const key of [
    'statusDraft', 'statusPendingSignature', 'statusPendingApproval',
    'statusApproved', 'statusRejected'
  ]) {
    assert.ok(app.split(`${key}:`).length - 1 >= 2, `missing localized status label: ${key}`);
  }
});
