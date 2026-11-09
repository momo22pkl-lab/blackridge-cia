'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_ATTACHMENT_BYTES,
  SCHEMA_SQL,
  MilitaryPersonnelDossierStore
} = require('../military-personnel-dossier-store');
const { registerMilitaryPersonnelDossierSocket } = require('../military-personnel-dossier-socket');
const { getSocketTextInputs } = require('../moderation-boundaries');

function cloneMap(map) {
  return new Map([...map].map(([key, value]) => [key, structuredClone(value)]));
}

class FakePostgres {
  constructor() {
    this.notes = new Map();
    this.cases = new Map();
    this.timeline = new Map();
    this.attachments = new Map();
    this.audit = [];
    this.backup = null;
    this.sequence = 0;
    this.statements = [];
  }

  async query(sql, params = []) { return this.execute(sql, params); }

  async connect() {
    return {
      query: (sql, params = []) => this.execute(sql, params),
      release() {}
    };
  }

  async execute(sql, params = []) {
    const query = String(sql).replace(/\s+/g, ' ').trim();
    const lower = query.toLowerCase();
    this.statements.push({ query, params });
    if (lower === 'begin') {
      this.backup = {
        notes: cloneMap(this.notes), cases: cloneMap(this.cases), timeline: cloneMap(this.timeline),
        attachments: cloneMap(this.attachments), audit: structuredClone(this.audit)
      };
      return { rows: [], rowCount: 0 };
    }
    if (lower === 'commit') { this.backup = null; return { rows: [], rowCount: 0 }; }
    if (lower === 'rollback') {
      if (this.backup) Object.assign(this, this.backup);
      this.backup = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^create\s/i.test(lower)) return { rows: [], rowCount: 0 };

    if (lower.startsWith('insert into blackridge_mpd_notes')) {
      const row = {
        id: params[0], personnel_id: params[1], author_user_id: params[2], author_name: params[3],
        author_code: params[4], body: params[5], created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString()
      };
      this.notes.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('update blackridge_mpd_notes')) {
      const row = this.notes.get(params[1]);
      if (!row || row.personnel_id !== params[0]) return { rows: [], rowCount: 0 };
      row.body = params[2];
      row.updated_at = new Date(1000).toISOString();
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('delete from blackridge_mpd_notes')) {
      const row = this.notes.get(params[1]);
      if (!row || row.personnel_id !== params[0]) return { rows: [], rowCount: 0 };
      this.notes.delete(params[1]);
      return { rows: [{ id: params[1] }], rowCount: 1 };
    }
    if (lower.startsWith('insert into blackridge_mpd_cases')) {
      const row = {
        id: params[0], personnel_id: params[1], title: params[2], details: params[3], evidence: params[4],
        status: params[5], final_decision: params[6], created_by_user_id: params[7], created_by_name: params[8],
        created_by_code: params[9], updated_by_user_id: params[7], created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString()
      };
      this.cases.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('select title, details, evidence, status, final_decision from blackridge_mpd_cases')) {
      const row = this.cases.get(params[1]);
      return { rows: row && row.personnel_id === params[0] ? [{
        title: row.title, details: row.details, evidence: row.evidence, status: row.status, final_decision: row.final_decision
      }] : [], rowCount: row && row.personnel_id === params[0] ? 1 : 0 };
    }
    if (lower.startsWith('update blackridge_mpd_cases')) {
      const row = this.cases.get(params[1]);
      if (!row || row.personnel_id !== params[0]) return { rows: [], rowCount: 0 };
      Object.assign(row, {
        title: params[2], details: params[3], evidence: params[4], status: params[5],
        final_decision: params[6], updated_by_user_id: params[7], updated_at: new Date(1000).toISOString()
      });
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('select id from blackridge_mpd_cases')) {
      const row = this.cases.get(params[1]);
      return { rows: row && row.personnel_id === params[0] ? [{ id: row.id }] : [], rowCount: row && row.personnel_id === params[0] ? 1 : 0 };
    }
    if (lower.startsWith('insert into blackridge_mpd_timeline')) {
      const row = {
        id: params[0], personnel_id: params[1], event_type: params[2], description: params[3], event_at: params[4],
        actor_user_id: params[5], actor_name: params[6], actor_code: params[7], created_at: new Date(0).toISOString()
      };
      this.timeline.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('insert into blackridge_mpd_attachments')) {
      const row = {
        id: params[0], personnel_id: params[1], case_id: params[2], file_name: params[3], mime_type: params[4],
        file_size: params[5], sha256: params[6], file_data: Buffer.from(params[7]),
        uploaded_by_user_id: params[8], uploaded_by_name: params[9], uploaded_by_code: params[10],
        created_at: new Date(0).toISOString()
      };
      this.attachments.set(row.id, row);
      return { rows: [{ ...row, file_data: undefined }], rowCount: 1 };
    }
    if (lower.startsWith('select id, personnel_id, case_id from blackridge_mpd_attachments')) {
      const row = this.attachments.get(params[0]);
      return { rows: row ? [{ id: row.id, personnel_id: row.personnel_id, case_id: row.case_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (lower.startsWith('select id, personnel_id, case_id, file_name, mime_type, file_size, sha256, file_data')) {
      const row = this.attachments.get(params[0]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (lower.startsWith('delete from blackridge_mpd_attachments')) {
      const row = this.attachments.get(params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      this.attachments.delete(params[0]);
      return { rows: [{ id: row.id, personnel_id: row.personnel_id, case_id: row.case_id, file_name: row.file_name, file_size: row.file_size }], rowCount: 1 };
    }
    if (lower.startsWith('insert into blackridge_mpd_audit')) {
      this.audit.push({
        id: params[0], personnel_id: params[1], actor_user_id: params[2], actor_code: params[3],
        action: params[4], entity_type: params[5], entity_id: params[6], metadata: JSON.parse(params[7])
      });
      return { rows: [], rowCount: 1 };
    }
    if (lower.startsWith('select id, personnel_id, author_user_id')) {
      const rows = [...this.notes.values()].filter((row) => row.personnel_id === params[0]);
      return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
    }
    if (lower.startsWith('select id, personnel_id, title, details, evidence, status')) {
      const rows = [...this.cases.values()].filter((row) => row.personnel_id === params[0]);
      return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
    }
    if (lower.startsWith('select id, personnel_id, event_type')) {
      const rows = [...this.timeline.values()].filter((row) => row.personnel_id === params[0]);
      return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
    }
    if (lower.startsWith('select id, personnel_id, case_id, file_name, mime_type, file_size, sha256, uploaded_by')) {
      const rows = [...this.attachments.values()].filter((row) => row.personnel_id === params[0]);
      return { rows: rows.map(({ file_data: _file_data, ...row }) => ({ ...row })), rowCount: rows.length };
    }
    throw new Error('Unexpected SQL: ' + query);
  }
}

const leader = { id: 'leader-1', name: 'قائد الاختبار', publicCode: 'LC-01' };

function makeStore() {
  let sequence = 0;
  const pool = new FakePostgres();
  const store = new MilitaryPersonnelDossierStore(pool, { makeId: (prefix) => prefix + '-' + (++sequence) });
  return { pool, store };
}

function makeSocket() {
  const handlers = new Map();
  return { handlers, socket: { on: (event, handler) => handlers.set(event, handler) } };
}

async function invoke(handlers, event, payload) {
  let response;
  await handlers.get(event)(payload || {}, (value) => { response = value; });
  return response;
}

test('the PostgreSQL schema is additive and does not seed military accounts or records', async () => {
  const { pool, store } = makeStore();
  await store.initialize();
  assert.equal(pool.notes.size + pool.cases.size + pool.timeline.size + pool.attachments.size, 0);
  assert.ok(SCHEMA_SQL.some((sql) => /blackridge_mpd_notes/.test(sql)));
  assert.ok(SCHEMA_SQL.some((sql) => /blackridge_mpd_cases/.test(sql)));
  assert.ok(SCHEMA_SQL.some((sql) => /blackridge_mpd_timeline/.test(sql)));
  assert.ok(SCHEMA_SQL.some((sql) => /blackridge_mpd_attachments/.test(sql) && /BYTEA/.test(sql)));
  assert.ok(SCHEMA_SQL.some((sql) => /blackridge_mpd_audit/.test(sql)));
  assert.doesNotMatch(SCHEMA_SQL.join('\n'), /INSERT INTO blackridge_mpd_/i);
  assert.ok(pool.statements.every(({ params }) => params.length === 0));
});

test('notes create, edit and delete are person-scoped and audited transactionally', async () => {
  const { pool, store } = makeStore();
  await store.initialize();
  const created = await store.createNote({ personId: 'person-1', actor: leader, body: 'ملاحظة متابعة' });
  assert.equal(created.ok, true);
  assert.equal(created.note.personnelId, 'person-1');
  assert.equal(created.note.authorUserId, 'leader-1');
  assert.equal(created.note.authorName, 'قائد الاختبار');
  assert.equal(pool.audit[0].action, 'NOTE_CREATED');
  assert.equal(pool.audit[0].personnel_id, 'person-1');

  const edited = await store.updateNote({
    personId: 'person-1', noteId: created.note.id, actor: { ...leader, id: 'leader-2' }, body: 'ملاحظة معدلة'
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.note.body, 'ملاحظة معدلة');
  assert.equal(pool.audit[1].action, 'NOTE_UPDATED');
  assert.equal((await store.updateNote({ personId: 'person-2', noteId: created.note.id, actor: leader, body: 'تجاوز النطاق' })).ok, false);

  const deleted = await store.deleteNote({ personId: 'person-1', noteId: created.note.id, actor: leader });
  assert.equal(deleted.ok, true);
  assert.equal(pool.notes.size, 0);
  assert.equal(pool.audit[2].action, 'NOTE_DELETED');
  assert.equal(pool.audit[2].entity_id, created.note.id);
  assert.equal(pool.statements.filter(({ query }) => /^(INSERT|UPDATE|DELETE)/i.test(query)).every(({ params }) => params.length), true);
});

test('case status and decision, timeline dates and actors are persisted against the exact personnel id', async () => {
  const { pool, store } = makeStore();
  const created = await store.createCase({
    personId: 'person-1', actor: leader,
    input: { title: 'مراجعة ميدانية', details: 'تفاصيل', evidence: 'محضر رقم 4', status: 'UNDER_REVIEW' }
  });
  assert.equal(created.ok, true);
  assert.equal(created.case.personnelId, 'person-1');
  assert.equal(created.case.evidence, 'محضر رقم 4');

  const closed = await store.updateCase({
    personId: 'person-1', caseId: created.case.id, actor: { ...leader, id: 'leader-2' },
    input: { status: 'CLOSED', finalDecision: 'إغلاق بعد المراجعة' }
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.case.status, 'CLOSED');
  assert.equal(closed.case.finalDecision, 'إغلاق بعد المراجعة');
  assert.equal((await store.updateCase({
    personId: 'person-1', caseId: created.case.id, actor: leader,
    input: { status: 'CLOSED', finalDecision: '' }
  })).ok, false);
  assert.equal((await store.updateCase({ personId: 'person-2', caseId: created.case.id, actor: leader, input: { title: 'قضية مختلفة' } })).ok, false);

  const timeline = await store.createTimelineEntry({
    personId: 'person-1', actor: leader, type: 'TRANSFER',
    description: 'نقل إلى القطاع الغربي', eventAt: '2026-10-04'
  });
  assert.equal(timeline.ok, true);
  assert.equal(timeline.entry.personnelId, 'person-1');
  assert.equal(timeline.entry.actorUserId, 'leader-1');
  assert.equal(timeline.entry.type, 'TRANSFER');
  assert.equal(new Date(timeline.entry.eventAt).toISOString(), '2026-10-04T00:00:00.000Z');
  assert.deepEqual(pool.audit.map((item) => item.action), ['CASE_CREATED', 'CASE_UPDATED', 'TIMELINE_CREATED']);
  assert.ok(pool.audit.every((item) => item.personnel_id === 'person-1' && item.actor_user_id));
});

test('attachments validate type and size, link only to the right case, download bytes and audit each action', async () => {
  const { pool, store } = makeStore();
  const caseRow = await store.createCase({ personId: 'person-1', actor: leader, input: { title: 'قضية ملف' } });
  const pdf = Buffer.from('%PDF-1.7\nsafe test file');
  const rejected = await store.uploadAttachment({
    personId: 'person-1', actor: leader, fileName: '../bad.svg', mimeType: 'image/svg+xml', bytes: pdf
  });
  assert.equal(rejected.ok, false);
  const wrongLink = await store.uploadAttachment({
    personId: 'person-2', caseId: caseRow.case.id, actor: leader, fileName: 'evidence.pdf', mimeType: 'application/pdf', bytes: pdf
  });
  assert.equal(wrongLink.ok, false);
  const tooLarge = await store.uploadAttachment({
    personId: 'person-1', actor: leader, fileName: 'large.pdf', mimeType: 'application/pdf',
    bytes: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_ATTACHMENT_BYTES)])
  });
  assert.equal(tooLarge.ok, false);

  const uploaded = await store.uploadAttachment({
    personId: 'person-1', caseId: caseRow.case.id, actor: leader, fileName: 'evidence.pdf',
    mimeType: 'application/pdf', bytes: pdf
  });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.attachment.personnelId, 'person-1');
  assert.equal(uploaded.attachment.caseId, caseRow.case.id);
  assert.equal(Object.hasOwn(uploaded.attachment, 'file_data'), false);
  const ref = await store.getAttachmentAccess(uploaded.attachment.id);
  assert.equal(ref.personnelId, 'person-1');

  const downloaded = await store.downloadAttachment({ attachmentId: uploaded.attachment.id, actor: { ...leader, id: 'leader-2' } });
  assert.equal(downloaded.ok, true);
  assert.deepEqual(downloaded.bytes, pdf);
  assert.equal(downloaded.attachment.sha256, uploaded.attachment.sha256);
  const removed = await store.deleteAttachment({ attachmentId: uploaded.attachment.id, actor: leader });
  assert.equal(removed.ok, true);
  assert.equal(pool.attachments.size, 0);
  assert.deepEqual(pool.audit.map((item) => item.action), ['CASE_CREATED', 'ATTACHMENT_UPLOADED', 'ATTACHMENT_DOWNLOADED', 'ATTACHMENT_DELETED']);
  assert.equal(pool.audit[1].metadata.fileName, 'evidence.pdf');
  assert.equal(pool.audit[2].entity_id, uploaded.attachment.id);
});

test('Socket.IO handlers enforce account scope and leadership permissions on the server', async () => {
  const { socket, handlers } = makeSocket();
  const calls = [];
  const store = {
    getDossier: async (id) => {
      calls.push(['getDossier', id]);
      return {
        notes: [{ id: 'note-1', body: 'نص', authorName: 'اسم محفوظ', authorCode: 'LC-01', authorUserId: 'private-id' }],
        cases: [{ id: 'case-1', title: 'قضية', createdByName: 'اسم محفوظ', createdByCode: 'LC-01', createdByUserId: 'private-id' }],
        timeline: [{ id: 'timeline-1', type: 'TRANSFER', description: 'نقل', actorName: 'اسم محفوظ', actorCode: 'LC-01', actorUserId: 'private-id' }],
        attachments: [{ id: 'file-1', fileName: 'doc.pdf', mimeType: 'application/pdf', uploadedByName: 'اسم محفوظ', uploadedByCode: 'LC-01', uploadedByUserId: 'private-id', sha256: 'private-hash' }]
      };
    },
    createNote: async (input) => {
      calls.push(['createNote', input]);
      return { ok: true, note: { id: 'note-new', body: input.body, authorUserId: input.actor.id, authorName: input.actor.name, authorCode: input.actor.publicCode } };
    },
    getAttachmentAccess: async (id) => { calls.push(['getAttachmentAccess', id]); return { id, personnelId: 'outside-1' }; },
    downloadAttachment: async (input) => {
      calls.push(['downloadAttachment', input]);
      return {
        ok: true,
        bytes: Buffer.from('%PDF-'),
        attachment: { id: input.attachmentId, caseId: '', fileName: 'doc.pdf', mimeType: 'application/pdf', size: 5, uploadedByName: 'اسم محفوظ', uploadedByCode: 'LC-01' }
      };
    }
  };
  const target = { id: 'in-scope-1' };
  const state = { cia_users: [target, { id: 'outside-1' }] };
  let actor = null;
  registerMilitaryPersonnelDossierSocket(socket, {
    getStore: () => store,
    getState: () => state,
    requireUser: () => actor,
    canViewPersonnel: (user, person) => user?.id === 'leader-1' || user?.id === person.id,
    canSeeNames: (user) => user?.id === 'leader-1',
    isLeadership: (user) => user?.id === 'leader-1',
    logger: () => {}
  });

  assert.equal((await invoke(handlers, 'mpd:dossier:get', { personnelId: 'in-scope-1' })).ok, false);
  actor = { id: 'member-1' };
  assert.equal((await invoke(handlers, 'mpd:dossier:get', { personnelId: 'outside-1' })).ok, false);
  assert.equal((await invoke(handlers, 'mpd:note:create', { personnelId: 'in-scope-1', body: 'ملاحظة' })).ok, false);
  assert.equal(calls.length, 0);

  actor = { id: 'in-scope-1' };
  const visible = await invoke(handlers, 'mpd:dossier:get', { personnelId: 'in-scope-1' });
  assert.equal(visible.ok, true);
  assert.equal(visible.permissions.canWrite, false);
  assert.equal(visible.dossier.notes[0].authorName, '');
  assert.equal(visible.dossier.cases[0].createdByName, '');
  assert.equal(visible.dossier.timeline[0].actorName, '');
  assert.equal(visible.dossier.attachments[0].uploadedByName, '');
  assert.equal(Object.hasOwn(visible.dossier.notes[0], 'authorUserId'), false);
  assert.equal(Object.hasOwn(visible.dossier.attachments[0], 'sha256'), false);
  assert.equal((await invoke(handlers, 'mpd:attachment:download', { attachmentId: 'file-1' })).ok, false);
  assert.equal(calls.some(([name]) => name === 'downloadAttachment'), false);

  actor = leader;
  const leadershipView = await invoke(handlers, 'mpd:dossier:get', { personnelId: 'in-scope-1' });
  assert.equal(leadershipView.dossier.notes[0].authorName, 'اسم محفوظ');
  const saved = await invoke(handlers, 'mpd:note:create', { personnelId: 'in-scope-1', body: 'ملاحظة' });
  assert.equal(saved.ok, true);
  assert.equal(Object.hasOwn(saved.note, 'authorUserId'), false);
  assert.equal(calls.find(([name]) => name === 'createNote')[1].actor.id, 'leader-1');
  const download = await invoke(handlers, 'mpd:attachment:download', { attachmentId: 'file-2' });
  assert.equal(download.ok, true);
  assert.equal(calls.some(([name]) => name === 'downloadAttachment'), true);
});

test('dossier text writes pass through moderation, binary bytes are not treated as text, and UI avoids browser storage', () => {
  const fileBytes = Uint8Array.from([37, 80, 68, 70, 45]);
  const content = getSocketTextInputs('mpd:case:create', {
    personnelId: 'person-1', case: { title: 'Case title', details: 'Case details', evidence: 'Evidence summary' }
  });
  assert.ok(content.includes('Case title'));
  assert.ok(content.includes('Case details'));
  assert.ok(content.includes('Evidence summary'));
  assert.deepEqual(getSocketTextInputs('mpd:attachment:upload', {
    personnelId: 'person-1', fileName: 'record.pdf', mimeType: 'application/pdf', bytes: fileBytes
  }), []);

  const client = fs.readFileSync(path.join(__dirname, '..', 'military-personnel-dossier-client.js'), 'utf8');
  const socketModule = fs.readFileSync(path.join(__dirname, '..', 'military-personnel-dossier-socket.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'military-personnel-dossier.css'), 'utf8');
  for (const event of ['mpd:note:create', 'mpd:note:update', 'mpd:note:delete', 'mpd:case:create', 'mpd:case:update', 'mpd:timeline:create', 'mpd:attachment:upload', 'mpd:attachment:download', 'mpd:attachment:delete']) {
    assert.ok(client.includes(event), 'UI should use ' + event);
    assert.ok(socketModule.includes(event), 'server should enforce ' + event);
  }
  assert.doesNotMatch(client, /localStorage|sessionStorage/);
  assert.match(client, /URL\.createObjectURL/);
  assert.match(styles, /@media\(max-width:600px\)/);
});
