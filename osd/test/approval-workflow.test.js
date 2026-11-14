'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const {
  createOsdRouter,
  roleProfileForPersonnel,
  sha256
} = require('../server');

const signingSecret = 'osd-approval-workflow-test-signing-secret-32-bytes';
const personnel = [
  { id: 'person-agent', militaryCode: 'AG-100', displayName: 'Agent One', rank: 'AGENT', active: true },
  { id: 'person-high', militaryCode: 'HC-200', displayName: 'High Commander', rank: 'HIGH COMMANDER', active: true },
  { id: 'person-senior', militaryCode: 'SC-300', displayName: 'Senior Commander', rank: 'SUPREME COMMANDER', active: true },
  { id: 'person-chief', militaryCode: 'CH-400', displayName: 'Chief One', rank: 'CIA CHIEF', active: true },
  { id: 'person-chief-peer', militaryCode: 'CH-401', displayName: 'Chief Two', rank: 'CIA CHIEF', active: true }
];

class ApprovalWorkflowPool {
  constructor() {
    this.users = personnel.map((person, index) => {
      const isPrimaryChief = person.id === 'person-chief';
      const profile = roleProfileForPersonnel(person, isPrimaryChief);
      return {
        id: `user-${person.id}`,
        username: `osd-${person.id}`,
        display_name: person.displayName,
        role: profile.role,
        clearance: profile.clearance,
        permissions: profile.permissions,
        military_code: person.militaryCode,
        personnel_id: person.id,
        is_primary_chief: isPrimaryChief,
        enabled: true,
        created_at: new Date(Date.now() + index).toISOString()
      };
    });
    this.sessions = [];
    this.documents = [];
    this.notifications = [];
    this.auditEvents = [];
    this.version = 0;
    this.counter = 0;
  }

  addSession(userId) {
    const token = `session-${userId}-${crypto.randomUUID()}`;
    this.sessions.push({
      token_hash: sha256(token),
      user_id: userId,
      expires_at: Date.now() + 60 * 60 * 1000
    });
    return token;
  }

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }

  async query(sql, values = []) {
    const query = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (query.startsWith('create table if not exists osd_users')) return { rows: [] };
    if (['begin', 'commit', 'rollback'].includes(query)) return { rows: [] };

    if (query.includes('from osd_sessions s join osd_users u')) {
      const session = this.sessions.find((item) => item.token_hash === values[0] && item.expires_at > Date.now());
      const user = session && this.users.find((item) => item.id === session.user_id && item.enabled);
      return { rows: user ? [{
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        clearance: user.clearance,
        permissions: user.permissions,
        military_code: user.military_code,
        personnel_id: user.personnel_id,
        is_primary_chief: user.is_primary_chief,
        enabled: user.enabled
      }] : [] };
    }

    if (query.startsWith('select id,personnel_id,military_code,is_primary_chief from osd_users')) {
      return { rows: this.users.filter((user) => user.enabled).map((user) => ({
        id: user.id,
        personnel_id: user.personnel_id,
        military_code: user.military_code,
        is_primary_chief: user.is_primary_chief
      })) };
    }

    if (query.startsWith('insert into osd_counters')) {
      return { rows: [{ value: ++this.counter }] };
    }

    if (query.startsWith('insert into osd_documents')) {
      const [id, documentNumber, verificationCode, type, title, body, sector, classification, recipient, createdBy, expiresAt] = values;
      const document = {
        id,
        amends_document_id: null,
        document_number: documentNumber,
        verification_code: verificationCode,
        document_type: type,
        title,
        body: JSON.parse(body),
        sector,
        classification,
        recipient,
        status: 'DRAFT',
        version: '1.0',
        created_by: createdBy,
        updated_at: new Date().toISOString(),
        issued_at: null,
        expires_at: expiresAt,
        revoked_at: null,
        revoked_reason: null,
        creator_signature: null,
        approval_assigned_to: null,
        approval_assignment_snapshot: null,
        approval_decided_by: null,
        approval_decision_snapshot: null,
        rejection_reason: null,
        signature: null,
        integrity_hash: null,
        issued_snapshot: null
      };
      this.documents.push(document);
      return { rows: [] };
    }

    if (query.startsWith('insert into osd_document_versions')) {
      this.version += 1;
      return { rows: [] };
    }

    if (query.startsWith('select pg_advisory_xact_lock')) return { rows: [] };
    if (query.startsWith('select event_hash from osd_audit_events')) {
      const documentId = values[0];
      const event = [...this.auditEvents].reverse().find((item) => item.document_id === documentId);
      return { rows: event ? [{ event_hash: event.event_hash }] : [] };
    }
    if (query.startsWith('insert into osd_audit_events')) {
      const [documentId, actorId, actorLabel, action, version, metadata, previousHash, eventHash, createdAt] = values;
      this.auditEvents.push({
        document_id: documentId,
        actor_id: actorId,
        actor_label: actorLabel,
        action,
        version,
        metadata: JSON.parse(metadata),
        previous_hash: previousHash,
        event_hash: eventHash,
        created_at: createdAt
      });
      return { rows: [] };
    }

    if (query.startsWith('select * from osd_documents where id = $1') ||
        query.startsWith('select * from osd_documents where id=$1')) {
      return { rows: this.documents.filter((document) => document.id === values[0]) };
    }
    if (query.startsWith('select * from osd_documents where id=$1 or document_number=$1')) {
      return { rows: this.documents.filter((document) =>
        document.id === values[0] || document.document_number === values[0]) };
    }
    if (query.startsWith('select * from osd_documents where status=')) {
      const [assignee, classifications] = values;
      return { rows: this.documents.filter((document) =>
        document.status === 'PENDING APPROVAL' &&
        document.approval_assigned_to === assignee &&
        classifications.includes(document.classification)) };
    }
    if (query.startsWith('select * from osd_documents where classification = any')) {
      const [classifications] = values;
      return { rows: this.documents
        .filter((document) => classifications.includes(document.classification))
        .sort((left, right) => new Date(right.updated_at) - new Date(left.updated_at))
        .slice(0, 200) };
    }

    if (query.startsWith("update osd_documents set status='pending signature'")) {
      const document = this.documents.find((item) => item.id === values[0]);
      if (document) {
        document.status = 'PENDING SIGNATURE';
        document.approval_assigned_to = null;
        document.approval_assignment_snapshot = null;
        document.updated_at = new Date().toISOString();
      }
      return { rows: [] };
    }
    if (query.startsWith("update osd_documents set status='signed'")) {
      const document = this.documents.find((item) => item.id === values[0]);
      if (document) {
        document.status = 'SIGNED';
        document.creator_signature = JSON.parse(values[1]);
        document.updated_at = new Date().toISOString();
      }
      return { rows: [] };
    }
    if (query.startsWith("update osd_documents set status='pending approval'")) {
      const document = this.documents.find((item) => item.id === values[0]);
      if (document) {
        document.status = 'PENDING APPROVAL';
        document.approval_assigned_to = values[1];
        document.approval_assignment_snapshot = JSON.parse(values[2]);
        document.approval_decided_by = null;
        document.approval_decision_snapshot = null;
        document.rejection_reason = null;
        document.updated_at = new Date().toISOString();
      }
      return { rows: [] };
    }
    if (query.startsWith('update osd_documents set status=$2')) {
      const document = this.documents.find((item) => item.id === values[0]);
      if (document) {
        document.status = values[1];
        document.approval_decided_by = values[2];
        document.approval_decision_snapshot = JSON.parse(values[3]);
        document.rejection_reason = values[4];
        document.updated_at = new Date().toISOString();
      }
      return { rows: [] };
    }

    if (query.startsWith('insert into osd_notifications')) {
      const [id, userId, documentId, type, title, message, href] = values;
      this.notifications.push({
        id, user_id: userId, document_id: documentId, notification_type: type,
        title, message, href, read_at: null, created_at: new Date().toISOString()
      });
      return { rows: [] };
    }
    if (query.startsWith('select id,document_id,notification_type,title,message,href,read_at,created_at from osd_notifications')) {
      return { rows: this.notifications.filter((item) => item.user_id === values[0])
        .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))
        .slice(0, 25) };
    }
    if (query.startsWith('update osd_notifications set read_at=')) {
      const notification = this.notifications.find((item) => item.id === values[0] && item.user_id === values[1]);
      if (!notification) return { rows: [] };
      notification.read_at ||= new Date().toISOString();
      return { rows: [{ id: notification.id }] };
    }

    throw new Error(`Unexpected test query: ${query.slice(0, 140)}`);
  }
}

test('OSD approval workflow persists signatures, routed review, decisions and notifications for every rank', async (t) => {
  const pool = new ApprovalWorkflowPool();
  const tokens = new Map(pool.users.map((user) => [user.id, pool.addSession(user.id)]));
  const app = express();
  app.use(express.json());
  app.use('/api/osd', createOsdRouter({
    getPool: () => pool,
    getPersonnel: () => personnel,
    env: { OSD_SIGNING_SECRET: signingSecret, NODE_ENV: 'test' }
  }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/osd`;
  const request = async (userId, path, options = {}) => fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: {
      cookie: `osd_session=${tokens.get(userId)}`,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const userIdFor = (personId) => `user-${personId}`;
  const routes = [
    { author: 'person-agent', reviewer: 'person-high', decision: 'approve' },
    { author: 'person-high', reviewer: 'person-senior', decision: 'reject' },
    { author: 'person-senior', reviewer: 'person-chief', decision: 'approve' },
    { author: 'person-chief', reviewer: 'person-chief-peer', decision: 'reject' }
  ];

  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    const authorId = userIdFor(route.author);
    const reviewerId = userIdFor(route.reviewer);
    const create = await request(authorId, '/documents', {
      method: 'POST',
      body: {
        type: 'OFFICIAL MEMORANDUM',
        title: `Approval route ${index + 1}`,
        sector: 'Operations',
        classification: 'INTERNAL',
        recipient: 'Command',
        body: 'A clean workflow test document.'
      }
    });
    assert.equal(create.status, 201);
    const { document: draft } = await create.json();
    assert.equal(draft.status, 'DRAFT');

    const earlySubmit = await request(authorId, `/documents/${draft.id}/submit`, { method: 'POST', body: {} });
    assert.equal(earlySubmit.status, 409, 'an unsigned draft cannot be submitted');

    const prepared = await request(authorId, `/documents/${draft.id}/prepare-signature`, { method: 'POST', body: {} });
    assert.equal(prepared.status, 200);
    assert.equal((await prepared.json()).document.status, 'PENDING SIGNATURE');

    const signed = await request(authorId, `/documents/${draft.id}/signature`, { method: 'POST', body: {} });
    assert.equal(signed.status, 200);
    const signedDocument = (await signed.json()).document;
    assert.equal(signedDocument.status, 'SIGNED');
    assert.equal(signedDocument.creatorSignature.signerRank, personnel.find((person) => person.id === route.author).rank);
    assert.equal(signedDocument.creatorSignature.militaryCode, personnel.find((person) => person.id === route.author).militaryCode);
    assert.ok(signedDocument.creatorSignature.signedAt);

    const submitted = await request(authorId, `/documents/${draft.id}/submit`, { method: 'POST', body: {} });
    assert.equal(submitted.status, 200);
    const routed = (await submitted.json()).document;
    assert.equal(routed.status, 'PENDING APPROVAL');
    assert.equal(routed.approvalAssignedTo, reviewerId);
    assert.equal(routed.approvalAssignee.rank, personnel.find((person) => person.id === route.reviewer).rank);

    const inbox = await request(reviewerId, '/approval-inbox');
    assert.equal(inbox.status, 200);
    assert.ok((await inbox.json()).documents.some((document) => document.id === draft.id));
    const unauthorizedApprover = userIdFor(route.reviewer === 'person-chief' ? 'person-high' : 'person-chief');
    const wrongInbox = await request(unauthorizedApprover, '/approval-inbox');
    assert.equal(wrongInbox.status, 200);
    assert.equal((await wrongInbox.json()).documents.some((document) => document.id === draft.id), false);

    const reviewNotificationResponse = await request(reviewerId, '/notifications');
    const reviewNotifications = (await reviewNotificationResponse.json()).notifications;
    const reviewNotification = reviewNotifications.find((notification) => notification.documentId === draft.id);
    assert.ok(reviewNotification);
    assert.equal(reviewNotification.type, 'REVIEW_REQUEST');
    assert.equal(reviewNotification.href, `/osd/?document=${draft.id}`);

    const unauthorizedDecision = await request(unauthorizedApprover, `/documents/${draft.id}/approve`, {
      method: 'POST', body: {}
    });
    assert.equal(unauthorizedDecision.status, 403, 'an authorized approver who was not assigned cannot decide it');

    if (route.decision === 'reject') {
      const missingReason = await request(reviewerId, `/documents/${draft.id}/reject`, { method: 'POST', body: {} });
      assert.equal(missingReason.status, 400);
    }
    const decisionResponse = await request(reviewerId, `/documents/${draft.id}/${route.decision}`, {
      method: 'POST',
      body: route.decision === 'reject' ? { reason: 'Supporting details are required.' } : {}
    });
    assert.equal(decisionResponse.status, 200);
    const decided = (await decisionResponse.json()).document;
    assert.equal(decided.status, route.decision === 'reject' ? 'REJECTED' : 'APPROVED');
    assert.equal(decided.approvalDecision.userId, reviewerId);
    assert.ok(decided.approvalDecision.decidedAt);
    if (route.decision === 'reject') assert.equal(decided.rejectionReason, 'Supporting details are required.');
    else assert.equal(decided.rejectionReason, null);

    const newLoginToken = pool.addSession(authorId);
    tokens.set(authorId, newLoginToken);
    const persisted = await request(authorId, `/documents/${draft.id}`);
    assert.equal(persisted.status, 200);
    assert.equal((await persisted.json()).document.status, decided.status);
    const decisionNotifications = (await (await request(authorId, '/notifications')).json()).notifications;
    const decisionNotification = decisionNotifications.find((notification) => notification.documentId === draft.id);
    assert.ok(decisionNotification, 'the decision notification remains available after a fresh session');
    assert.equal(decisionNotification.type, 'DECISION');

    const markRead = await request(authorId, `/notifications/${decisionNotification.id}/read`, {
      method: 'POST', body: {}
    });
    assert.equal(markRead.status, 200);
    const refreshedNotifications = (await (await request(authorId, '/notifications')).json()).notifications;
    assert.ok(refreshedNotifications.find((notification) => notification.id === decisionNotification.id).readAt);

    const eventActions = pool.auditEvents.filter((event) => event.document_id === draft.id).map((event) => event.action);
    assert.deepEqual(eventActions, [
      'DOCUMENT CREATED',
      'DOCUMENT PREPARED FOR CREATOR SIGNATURE',
      'CREATOR SIGNED DOCUMENT',
      'SUBMITTED FOR APPROVAL',
      route.decision === 'reject' ? 'DOCUMENT REJECTED' : 'DOCUMENT APPROVED',
      'DOCUMENT VIEWED'
    ]);
  }
});
