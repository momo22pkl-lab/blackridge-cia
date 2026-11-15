'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');
const { createOsdRouter, roleProfileForPersonnel, sha256 } = require('../server');

const databaseUrl = process.env.OSD_TEST_DATABASE_URL;
const signingSecret = 'osd-isolated-postgres-test-signing-secret-32-bytes';
const RANKS = [
  { id: 'person-agent', publicCode: 'AG-100', name: 'Agent One', rank: 'AGENT' },
  { id: 'person-high', publicCode: 'HC-200', name: 'High Commander', rank: 'HIGH COMMANDER' },
  { id: 'person-senior', publicCode: 'SC-300', name: 'Supreme Commander', rank: 'SUPREME COMMANDER' },
  { id: 'person-chief', publicCode: 'CH-400', name: 'Chief One', rank: 'CIA CHIEF' },
  { id: 'person-chief-peer', publicCode: 'CH-401', name: 'Chief Two', rank: 'CIA CHIEF' }
];

test('OSD approval workflow persists rank-based decisions atomically in isolated PostgreSQL', {
  skip: databaseUrl ? false : 'Set OSD_TEST_DATABASE_URL to run the isolated PostgreSQL workflow test.'
}, async (t) => {
  const schema = `osd_approval_test_${crypto.randomBytes(8).toString('hex')}`;
  const adminPool = new Pool({ connectionString: databaseUrl });
  let testPool;
  let server;

  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  testPool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`
  });

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (testPool) await testPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  });

  await testPool.query(`
    CREATE TABLE blackridge_app_state (
      id SMALLINT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `);
  const sourcePersonnel = RANKS.map((person) => ({
    ...person,
    approved: true,
    serviceApproved: true,
    suspended: false,
    securityStatus: 'ACTIVE'
  }));
  await testPool.query(
    'INSERT INTO blackridge_app_state (id,data) VALUES (1,$1::jsonb)',
    [JSON.stringify({ cia_users: sourcePersonnel })]
  );
  const personnelResult = await testPool.query(
    "SELECT data->'cia_users' AS cia_users FROM blackridge_app_state WHERE id=1"
  );
  const personnel = personnelResult.rows[0].cia_users.map((person) => ({
    id: person.id,
    militaryCode: person.publicCode,
    displayName: person.name,
    rank: person.rank,
    active: person.approved !== false &&
      person.serviceApproved !== false &&
      person.suspended !== true &&
      person.securityStatus === 'ACTIVE'
  }));
  const ssoTickets = new Map();

  const app = express();
  app.use(express.json());
  app.use('/api/osd', createOsdRouter({
    getPool: () => testPool,
    getPersonnel: () => personnel,
    env: { OSD_SIGNING_SECRET: signingSecret, NODE_ENV: 'test' },
    consumeMilitarySsoTicket: (ticket) => {
      const identity = ssoTickets.get(ticket) || null;
      ssoTickets.delete(ticket);
      return identity;
    }
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/osd`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const users = new Map();
  for (const person of personnel) {
    const isPrimaryChief = person.id === 'person-chief-peer';
    const profile = roleProfileForPersonnel(person, isPrimaryChief);
    const userId = `user-${person.id}`;
    await testPool.query(
      `INSERT INTO osd_users
       (id,username,display_name,password_salt,password_hash,role,clearance,permissions,
        military_code,personnel_id,is_primary_chief,enabled)
       VALUES ($1,$2,$3,'test-salt','test-hash',$4,$5,$6::jsonb,$7,$8,$9,TRUE)`,
      [
        userId,
        `osd-${person.id}`,
        person.displayName,
        profile.role,
        profile.clearance,
        JSON.stringify(profile.permissions),
        person.militaryCode,
        person.id,
        isPrimaryChief
      ]
    );
    const token = crypto.randomBytes(32).toString('base64url');
    await testPool.query(
      `INSERT INTO osd_sessions (token_hash,user_id,expires_at)
       VALUES ($1,$2,NOW() + INTERVAL '1 hour')`,
      [sha256(token), userId]
    );
    users.set(person.id, { id: userId, token });
  }

  const request = (personId, path, options = {}) => fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: {
      cookie: `osd_session=${users.get(personId).token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const logoutAndLogin = async (personId) => {
    const account = users.get(personId);
    const logout = await request(personId, '/auth/logout', { method: 'POST', body: {} });
    assert.equal(logout.status, 200, `${personId} should be able to log out`);
    const person = personnel.find((entry) => entry.id === personId);
    let login;
    if (person.rank === 'CIA CHIEF') {
      const ticket = crypto.randomBytes(24).toString('base64url');
      ssoTickets.set(ticket, { personnelId: person.id, militaryCode: person.militaryCode });
      login = await fetch(`${base}/auth/sso`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: new URL(base).origin
        },
        body: JSON.stringify({ ticket })
      });
    } else {
      login = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'member', militaryCode: person.militaryCode })
      });
    }
    assert.equal(login.status, 200, `${personId} should be able to sign in again`);
    const cookies = typeof login.headers.getSetCookie === 'function'
      ? login.headers.getSetCookie()
      : [login.headers.get('set-cookie') || ''];
    const sessionCookie = cookies.find((cookie) => cookie.startsWith('osd_session='));
    assert.ok(sessionCookie, `${personId} should receive a new session`);
    const token = decodeURIComponent(sessionCookie.split(';', 1)[0].slice('osd_session='.length));
    users.set(personId, { id: account.id, token });
  };
  const createSignedDocument = async (personId, title) => {
    const created = await request(personId, '/documents', {
      method: 'POST',
      body: {
        type: 'OFFICIAL MEMORANDUM',
        title,
        sector: 'Operations',
        classification: 'INTERNAL',
        recipient: 'Command',
        body: `PostgreSQL workflow test: ${title}`
      }
    });
    assert.equal(created.status, 201);
    const { document } = await created.json();
    assert.equal(document.status, 'DRAFT');
    const prepared = await request(personId, `/documents/${document.id}/prepare-signature`, {
      method: 'POST', body: {}
    });
    assert.equal(prepared.status, 200);
    const signed = await request(personId, `/documents/${document.id}/signature`, {
      method: 'POST', body: {}
    });
    assert.equal(signed.status, 200);
    const signedDocument = (await signed.json()).document;
    assert.equal(signedDocument.status, 'SIGNED');
    return document.id;
  };

  const chiefId = users.get('person-chief').id;
  const chiefDocumentId = await createSignedDocument('person-chief', 'CIA Chief automatic approval');
  const chiefSubmissions = await Promise.all([
    request('person-chief', `/documents/${chiefDocumentId}/submit`, { method: 'POST', body: {} }),
    request('person-chief', `/documents/${chiefDocumentId}/submit`, { method: 'POST', body: {} })
  ]);
  assert.deepEqual(chiefSubmissions.map((response) => response.status).sort(), [200, 409]);
  const chiefDocument = (await chiefSubmissions.find((response) => response.status === 200).json()).document;
  assert.equal(chiefDocument.status, 'APPROVED');
  assert.equal(chiefDocument.approvalAssignedTo, null);
  assert.equal(chiefDocument.approvalDecision.userId, chiefId);
  assert.equal(chiefDocument.approvalDecision.approvalMethod, 'AUTO_CIA_CHIEF_RANK');
  assert.equal(
    chiefDocument.approvalDecision.reason,
    'Automatically approved because the creator holds the CIA CHIEF rank.'
  );
  assert.ok(chiefDocument.approvalDecision.submittedAt);
  assert.ok(chiefDocument.approvalDecision.decidedAt);

  const savedChiefDocument = await testPool.query(
    `SELECT status,approval_assigned_to,approval_decided_by,approval_decision_snapshot,creator_signature
     FROM osd_documents WHERE id=$1`,
    [chiefDocumentId]
  );
  assert.equal(savedChiefDocument.rows[0].status, 'APPROVED');
  assert.equal(savedChiefDocument.rows[0].approval_assigned_to, null);
  assert.equal(savedChiefDocument.rows[0].approval_decided_by, chiefId);
  assert.equal(savedChiefDocument.rows[0].approval_decision_snapshot.approvalMethod, 'AUTO_CIA_CHIEF_RANK');
  assert.equal(savedChiefDocument.rows[0].approval_decision_snapshot.reason, chiefDocument.approvalDecision.reason);
  assert.equal(savedChiefDocument.rows[0].creator_signature.payload.signer.rank, 'CIA CHIEF');

  const chiefAudit = await testPool.query(
    `SELECT actor_id,action,metadata,created_at FROM osd_audit_events
     WHERE document_id=$1 ORDER BY id`,
    [chiefDocumentId]
  );
  const signatureEvent = chiefAudit.rows.find((event) => event.action === 'CREATOR SIGNED DOCUMENT');
  const submittedEvent = chiefAudit.rows.find((event) => event.action === 'SUBMITTED FOR APPROVAL');
  const approvalEvent = chiefAudit.rows.find((event) => event.action === 'DOCUMENT AUTO-APPROVED BY CIA CHIEF RANK');
  assert.equal(signatureEvent.actor_id, chiefId);
  assert.equal(signatureEvent.metadata.signerRank, 'CIA CHIEF');
  assert.ok(signatureEvent.metadata.signedAt);
  assert.equal(submittedEvent.actor_id, chiefId);
  assert.ok(submittedEvent.metadata.submittedAt);
  assert.ok(submittedEvent.metadata.signatureHash);
  assert.ok(approvalEvent.metadata.approvedAt);
  assert.equal(approvalEvent.metadata.approvalReason, 'Automatically approved because the creator holds the CIA CHIEF rank.');

  const chiefNotifications = await testPool.query(
    `SELECT user_id,notification_type FROM osd_notifications WHERE document_id=$1`,
    [chiefDocumentId]
  );
  assert.deepEqual(chiefNotifications.rows, [{ user_id: chiefId, notification_type: 'DECISION' }]);
  await logoutAndLogin('person-chief');
  const chiefAfterLogin = await request('person-chief', `/documents/${chiefDocumentId}`);
  assert.equal(chiefAfterLogin.status, 200);
  assert.equal((await chiefAfterLogin.json()).document.status, 'APPROVED');
  const chiefNotificationsAfterLogin = await request('person-chief', '/notifications');
  assert.equal(
    (await chiefNotificationsAfterLogin.json()).notifications.filter((item) => item.documentId === chiefDocumentId).length,
    1
  );
  assert.equal((await request('person-chief', `/documents/${chiefDocumentId}/approve`, {
    method: 'POST', body: {}
  })).status, 403, 'the creator cannot use the reviewer action to approve their own document');

  const agentDocumentId = await createSignedDocument('person-agent', 'Agent review');
  const agentSubmit = await request('person-agent', `/documents/${agentDocumentId}/submit`, {
    method: 'POST', body: { rank: 'CIA CHIEF', role: 'ADMIN' }
  });
  assert.equal(agentSubmit.status, 200);
  const agentDocument = (await agentSubmit.json()).document;
  assert.equal(agentDocument.status, 'PENDING APPROVAL');
  assert.equal(agentDocument.approvalAssignedTo, users.get('person-high').id);
  assert.equal((await request('person-agent', `/documents/${agentDocumentId}/approve`, {
    method: 'POST', body: {}
  })).status, 403, 'a non-chief creator cannot approve their own document');
  assert.equal((await request('person-chief-peer', `/documents/${agentDocumentId}/approve`, {
    method: 'POST', body: {}
  })).status, 403, 'an approver who was not assigned cannot approve the document');
  assert.equal((await request('person-high', `/documents/${agentDocumentId}/reject`, {
    method: 'POST', body: {}
  })).status, 400, 'reviewer rejection requires a reason');
  const rejected = await request('person-high', `/documents/${agentDocumentId}/reject`, {
    method: 'POST', body: { reason: 'Supporting details are required.' }
  });
  assert.equal(rejected.status, 200);
  assert.equal((await rejected.json()).document.status, 'REJECTED');
  assert.equal((await request('person-high', `/documents/${agentDocumentId}/reject`, {
    method: 'POST', body: { reason: 'Duplicate decision attempt.' }
  })).status, 409);
  await logoutAndLogin('person-agent');
  const agentAfterLogin = await request('person-agent', `/documents/${agentDocumentId}`);
  assert.equal(agentAfterLogin.status, 200);
  const persistedAgentDocument = (await agentAfterLogin.json()).document;
  assert.equal(persistedAgentDocument.status, 'REJECTED');
  assert.equal(persistedAgentDocument.rejectionReason, 'Supporting details are required.');
  const agentNotificationsAfterLogin = await request('person-agent', '/notifications');
  assert.equal(
    (await agentNotificationsAfterLogin.json()).notifications.filter((item) => item.documentId === agentDocumentId).length,
    1
  );

  for (const route of [
    { author: 'person-high', reviewer: 'person-senior' },
    { author: 'person-senior', reviewer: 'person-chief' }
  ]) {
    const documentId = await createSignedDocument(route.author, `${route.author} normal review`);
    const submitted = await request(route.author, `/documents/${documentId}/submit`, {
      method: 'POST', body: {}
    });
    assert.equal(submitted.status, 200);
    const pending = (await submitted.json()).document;
    assert.equal(pending.status, 'PENDING APPROVAL');
    assert.equal(pending.approvalAssignedTo, users.get(route.reviewer).id);
    const approved = await request(route.reviewer, `/documents/${documentId}/approve`, {
      method: 'POST', body: {}
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).document.status, 'APPROVED');
    await logoutAndLogin(route.author);
    const reopened = await request(route.author, `/documents/${documentId}`);
    assert.equal(reopened.status, 200);
    assert.equal((await reopened.json()).document.status, 'APPROVED');
    const decisionNotifications = await request(route.author, '/notifications');
    assert.equal(
      (await decisionNotifications.json()).notifications.filter((item) => item.documentId === documentId).length,
      1
    );
  }

  const failedSaveDocumentId = await createSignedDocument('person-chief', 'Failed approval write');
  await testPool.query(`
    CREATE FUNCTION reject_auto_approval_for_test() RETURNS trigger AS $$
    BEGIN
      IF OLD.status='SIGNED' AND NEW.status='APPROVED' THEN
        RAISE EXCEPTION 'forced isolated test write failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await testPool.query(`
    CREATE TRIGGER reject_auto_approval_for_test
    BEFORE UPDATE ON osd_documents
    FOR EACH ROW EXECUTE FUNCTION reject_auto_approval_for_test()
  `);
  const failedSubmit = await request('person-chief', `/documents/${failedSaveDocumentId}/submit`, {
    method: 'POST', body: {}
  });
  assert.equal(failedSubmit.status, 500);
  const afterFailedSave = await testPool.query(
    `SELECT status,approval_decided_by,approval_decision_snapshot
     FROM osd_documents WHERE id=$1`,
    [failedSaveDocumentId]
  );
  assert.equal(afterFailedSave.rows[0].status, 'SIGNED');
  assert.equal(afterFailedSave.rows[0].approval_decided_by, null);
  assert.equal(afterFailedSave.rows[0].approval_decision_snapshot, null);
  assert.equal((await testPool.query(
    `SELECT COUNT(*)::int AS count FROM osd_notifications WHERE document_id=$1`,
    [failedSaveDocumentId]
  )).rows[0].count, 0);
  assert.equal((await testPool.query(
    `SELECT COUNT(*)::int AS count FROM osd_audit_events
     WHERE document_id=$1 AND action IN ('SUBMITTED FOR APPROVAL','DOCUMENT AUTO-APPROVED BY CIA CHIEF RANK')`,
    [failedSaveDocumentId]
  )).rows[0].count, 0);
});
