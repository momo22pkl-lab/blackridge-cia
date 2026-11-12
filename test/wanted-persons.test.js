'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SCHEMA_SQL,
  WantedPersonsStore,
  buildListFilters,
  matchesMimeSignature,
  safeImageUrl
} = require('../wanted-persons-store');
const {
  casesForPerson,
  injectWantedPersonsMarkup,
  investigationCases,
  registerWantedPersonsSocket
} = require('../wanted-persons-server');
const { getSocketTextInputs } = require('../moderation-boundaries');

function cloneRows(rows) {
  return new Map([...rows].map(([id, row]) => [id, { ...row, aliases: [...row.aliases], case_ids: [...row.case_ids] }]));
}

class FakePostgres {
  constructor() {
    this.rows = new Map();
    this.audit = [];
    this.evidence = [];
    this.notes = [];
    this.timeline = [];
    this.backup = null;
    this.sequence = 0;
  }

  async query(sql, params) { return this.execute(sql, params || []); }
  async connect() { return { query: (sql, params) => this.execute(sql, params || []), release() {} }; }

  async execute(sql, params) {
    const query = String(sql).replace(/\s+/g, ' ').trim();
    const lower = query.toLowerCase();
    if (lower === 'begin') {
      this.backup = { rows: cloneRows(this.rows), audit: [...this.audit], evidence: [...this.evidence], notes: [...this.notes], timeline: [...this.timeline] };
      return { rows: [], rowCount: 0 };
    }
    if (lower === 'commit') { this.backup = null; return { rows: [], rowCount: 0 }; }
    if (lower === 'rollback') {
      if (this.backup) {
        this.rows = this.backup.rows;
        this.audit = this.backup.audit;
        this.evidence = this.backup.evidence;
        this.notes = this.backup.notes;
        this.timeline = this.backup.timeline;
      }
      this.backup = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^(create|alter|do)\s/i.test(lower)) return { rows: [], rowCount: 0 };
    if (lower.startsWith('select id, status, case_ids from blackridge_wanted_persons where id = $1 for update')) {
      const row = this.rows.get(params[0]);
      return { rows: row ? [{ id: row.id, status: row.status, case_ids: [...row.case_ids] }] : [], rowCount: row ? 1 : 0 };
    }
    if (lower.startsWith('select id, case_ids from blackridge_wanted_persons where id = $1 for update')) {
      const row = this.rows.get(params[0]);
      return { rows: row ? [{ id: row.id, case_ids: [...row.case_ids] }] : [], rowCount: row ? 1 : 0 };
    }
    if (lower.startsWith('select id from blackridge_wanted_persons where id = $1 for update')) {
      return { rows: this.rows.has(params[0]) ? [{ id: params[0] }] : [], rowCount: this.rows.has(params[0]) ? 1 : 0 };
    }
    if (lower.startsWith('select id from blackridge_wanted_persons where id = $1')) {
      return { rows: this.rows.has(params[0]) ? [{ id: params[0] }] : [], rowCount: this.rows.has(params[0]) ? 1 : 0 };
    }
    if (lower.startsWith('insert into blackridge_wanted_persons (')) {
      if ([...this.rows.values()].some((row) => row.file_number.toLowerCase() === params[1].toLowerCase())) {
        const error = new Error('duplicate file number'); error.code = '23505'; throw error;
      }
      const timestamp = new Date(0).toISOString();
      const row = {
        id: params[0], file_number: params[1], full_name: params[2], aliases: JSON.parse(params[3]), image_url: params[4],
        severity: params[5], status: params[6], case_ids: [...params[7]], notes: params[8], details: params[9],
        created_by_user_id: params[10], updated_by_user_id: params[10], created_at: timestamp, updated_at: timestamp
      };
      this.rows.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('update blackridge_wanted_persons set file_number = $2')) {
      const row = this.rows.get(params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      if ([...this.rows.values()].some((other) => other.id !== row.id && other.file_number.toLowerCase() === params[1].toLowerCase())) {
        const error = new Error('duplicate file number'); error.code = '23505'; throw error;
      }
      Object.assign(row, {
        file_number: params[1], full_name: params[2], aliases: JSON.parse(params[3]), image_url: params[4],
        severity: params[5], status: params[6], case_ids: [...params[7]], notes: params[8], details: params[9],
        updated_by_user_id: params[10], updated_at: new Date(1).toISOString()
      });
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('update blackridge_wanted_persons set case_ids = $2')) {
      const row = this.rows.get(params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.case_ids = [...params[1]];
      row.updated_by_user_id = params[2];
      row.updated_at = new Date(2).toISOString();
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('insert into blackridge_wanted_persons_audit')) {
      this.audit.push({ id: params[0], person_id: params[1], actor_user_id: params[2], action: params[3], changed_fields: JSON.parse(params[4]) });
      return { rows: [], rowCount: 1 };
    }
    if (lower.startsWith('insert into blackridge_wanted_timeline')) {
      const row = {
        id: params[0], person_id: params[1], case_id: params[2], event_type: params[3],
        title: params[4], body: params[5], occurred_at: params[6], actor_user_id: params[7],
        created_at: new Date(3).toISOString()
      };
      this.timeline.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('insert into blackridge_wanted_evidence')) {
      const row = {
        id: params[0], person_id: params[1], category: params[2], title: params[3], description: params[4],
        source: params[5], recorded_at: params[6], case_ids: [...params[7]], content_type: params[8],
        file_name: params[9], file_size: params[10], file_sha256: params[11], file_data: params[12],
        thumbnail_data: params[13], created_by_user_id: params[14], updated_by_user_id: params[14],
        created_at: new Date(6).toISOString(), updated_at: new Date(6).toISOString()
      };
      this.evidence.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('select id from blackridge_wanted_timeline')) {
      const rows = this.timeline.filter((row) => row.person_id === params[0] && row.actor_user_id === params[1] && row.event_type === 'FILE_OPENED');
      return { rows: rows.slice(-1).map((row) => ({ id: row.id })), rowCount: rows.length ? 1 : 0 };
    }
    if (lower.startsWith('select id, person_id, case_id, event_type, title, body, occurred_at, actor_user_id, created_at from blackridge_wanted_timeline')) {
      const rows = this.timeline.filter((row) => row.person_id === params[0]);
      return { rows: [...rows].reverse(), rowCount: rows.length };
    }
    if (lower.startsWith('select id, person_id, case_id, title, body, created_by_user_id, updated_by_user_id, created_at, updated_at from blackridge_wanted_notes')) {
      const rows = this.notes.filter((row) => row.person_id === params[0]);
      return { rows: [...rows].reverse(), rowCount: rows.length };
    }
    if (lower.startsWith('select id, case_id, title, body, created_by_user_id from blackridge_wanted_notes')) {
      const row = this.notes.find((item) => item.id === params[0] && item.person_id === params[1]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (lower.startsWith('select id, created_by_user_id from blackridge_wanted_notes')) {
      const row = this.notes.find((item) => item.id === params[0] && item.person_id === params[1]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (lower.startsWith('insert into blackridge_wanted_notes')) {
      const timestamp = new Date(4).toISOString();
      const row = {
        id: params[0], person_id: params[1], case_id: params[2], title: params[3], body: params[4],
        created_by_user_id: params[5], updated_by_user_id: params[6], created_at: timestamp, updated_at: timestamp
      };
      this.notes.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('update blackridge_wanted_notes')) {
      const row = this.notes.find((item) => item.id === params[0] && item.person_id === params[1]);
      if (!row) return { rows: [], rowCount: 0 };
      Object.assign(row, { case_id: params[2], title: params[3], body: params[4], updated_by_user_id: params[5], updated_at: new Date(5).toISOString() });
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('delete from blackridge_wanted_notes')) {
      this.notes = this.notes.filter((item) => !(item.id === params[0] && item.person_id === params[1]));
      return { rows: [], rowCount: 1 };
    }
    if (lower.startsWith('select id, person_id, category, title, description, source, recorded_at, case_ids, content_type, file_name, file_size, file_sha256, thumbnail_data, created_by_user_id, updated_by_user_id, created_at, updated_at from blackridge_wanted_evidence')) {
      return { rows: [], rowCount: 0 };
    }
    if (lower.startsWith('select id, person_id, actor_user_id, action, entity_type, entity_id, changed_fields, metadata, created_at from blackridge_wanted_persons_audit')) {
      return { rows: [], rowCount: 0 };
    }
    if (lower.startsWith('select count(*)::int as total from blackridge_wanted_persons')) {
      return { rows: [{ total: this.rows.size }], rowCount: 1 };
    }
    if (lower.startsWith('select id, file_number, full_name, aliases, image_url, severity, status, case_ids, notes, details, created_by_user_id, updated_by_user_id, created_at, updated_at from blackridge_wanted_persons where id = $1')) {
      const row = this.rows.get(params[0]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (lower.startsWith('select id, file_number, full_name, aliases, image_url, severity, status, case_ids, notes, details, created_by_user_id, updated_by_user_id, created_at, updated_at from blackridge_wanted_persons')) {
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      const rows = [...this.rows.values()].slice(offset, offset + limit).map((row) => ({ ...row }));
      return { rows, rowCount: rows.length };
    }
    throw new Error('Unexpected SQL: ' + query);
  }
}

function person(overrides = {}) {
  return {
    fullName: 'شخص للاختبار', fileNumber: 'BR-TEST-01', aliases: ['اسم اختبار'], imageUrl: '',
    severity: 'HIGH', status: 'WANTED', caseIds: ['case-1'], notes: 'ملاحظة اختبار', details: 'تفاصيل اختبار', ...overrides
  };
}

function makeSocket() {
  const handlers = new Map();
  return { handlers, socket: { on: (event, handler) => handlers.set(event, handler) } };
}

test('the additive PostgreSQL schema creates empty wanted-person tables without seeding records', async () => {
  const pool = new FakePostgres();
  const store = new WantedPersonsStore(pool);
  await store.initialize();
  assert.equal(pool.rows.size, 0);
  assert.equal(pool.audit.length, 0);
  const schema = SCHEMA_SQL.join('\n');
  assert.match(schema, /blackridge_wanted_persons/);
  assert.match(schema, /UNIQUE INDEX IF NOT EXISTS idx_blackridge_wanted_persons_file_number/);
  assert.match(schema, /severity IN \('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'\)/);
  assert.match(schema, /status IN \('WANTED', 'UNDER_INVESTIGATION', 'DETAINED', 'CLOSED'\)/);
  assert.doesNotMatch(schema, /INSERT INTO blackridge_wanted_persons/i);
});

test('name, file number, severity and status filters use bound values', () => {
  const filters = buildListFilters({ name: "x%' OR TRUE --", fileNumber: 'BR_10', severity: 'critical', status: 'under_investigation' });
  assert.match(filters.where, /POSITION\(\$1 IN LOWER\(full_name\)\)/);
  assert.match(filters.where, /POSITION\(\$2 IN LOWER\(file_number\)\)/);
  assert.match(filters.where, /severity = \$3/);
  assert.match(filters.where, /status = \$4/);
  assert.deepEqual(filters.values, ["x%' or true --", 'br_10', 'CRITICAL', 'UNDER_INVESTIGATION']);
  assert.equal(buildListFilters({ severity: 'INVALID', status: 'INVALID' }).where, '');
});

test('save persists create and edit atomically, links existing case ids, and audits only changed field names', async () => {
  let id = 0;
  const pool = new FakePostgres();
  const store = new WantedPersonsStore(pool, { makeId: (prefix) => prefix + '-' + (++id) });
  await store.initialize();
  const created = await store.save({ person: person(), actor: { id: 'leader-1' } });
  assert.equal(created.ok, true);
  assert.equal(created.person.id, 'WANTED-1');
  assert.equal(created.person.fileNumber, 'BR-TEST-01');
  assert.deepEqual(created.person.caseIds, ['case-1']);
  assert.equal(pool.audit[0].action, 'CREATED');
  assert.equal(pool.audit[0].actor_user_id, 'leader-1');
  assert.deepEqual(pool.audit[0].changed_fields, ['fileNumber', 'fullName', 'aliases', 'imageUrl', 'severity', 'status', 'caseIds', 'notes', 'details']);
  assert.doesNotMatch(JSON.stringify(pool.audit), /ملاحظة اختبار|تفاصيل اختبار/);

  const updated = await store.save({ person: person({ id: created.person.id, status: 'UNDER_INVESTIGATION', notes: 'ملاحظة محدثة' }), actor: { id: 'leader-2' } });
  assert.equal(updated.ok, true);
  assert.equal(updated.person.status, 'UNDER_INVESTIGATION');
  assert.equal(updated.person.notes, 'ملاحظة محدثة');
  assert.equal(pool.audit[1].action, 'UPDATED');
  assert.equal(pool.timeline.some((event) => event.event_type === 'STATUS_UPDATED'), true);
  assert.equal(pool.rows.size, 1);

  const detail = await store.get(created.person.id);
  assert.equal(detail.fullName, 'شخص للاختبار');
  assert.equal(detail.createdByUserId, undefined);
  const listing = await store.list({ limit: 100, offset: 0 });
  assert.equal(listing.total, 1);
  assert.equal(listing.items.length, 1);
});

test('case links update the existing wanted-person record and audit the archive references', async () => {
  const pool = new FakePostgres();
  let nextId = 0;
  const store = new WantedPersonsStore(pool, { makeId: (prefix) => prefix + '-case-link-' + (++nextId) });
  const created = await store.save({ person: person({ caseIds: ['case-1'] }), actor: { id: 'leader-1' } });
  const linked = await store.saveCaseLinks({
    personId: created.person.id,
    caseIds: ['case-1', 'case-2', 'case-2'],
    caseLabels: { 'case-2': 'CASE-002 · قضية قائمة' },
    actor: { id: 'leader-1' }
  });
  assert.equal(linked.ok, true);
  assert.deepEqual(linked.person.caseIds, ['case-1', 'case-2']);
  assert.deepEqual(linked.linkedCaseIds, ['case-2']);
  assert.deepEqual(linked.unlinkedCaseIds, []);
  assert.equal(pool.timeline.some((event) => event.event_type === 'CASE_LINKED' && event.case_id === 'case-2'), true);
  assert.equal(pool.timeline.find((event) => event.event_type === 'CASE_LINKED' && event.case_id === 'case-2').body, 'CASE-002 · قضية قائمة');
  assert.equal(pool.audit.at(-1).action, 'UPDATED');
  assert.deepEqual(pool.audit.at(-1).changed_fields, ['caseIds']);

  const unlinked = await store.saveCaseLinks({
    personId: created.person.id,
    caseIds: [],
    actor: { id: 'leader-1' }
  });
  assert.equal(unlinked.ok, true);
  assert.deepEqual(unlinked.person.caseIds, []);
  assert.deepEqual(unlinked.unlinkedCaseIds, ['case-1', 'case-2']);
  assert.equal(pool.timeline.some((event) => event.event_type === 'CASE_UNLINKED' && event.case_id === 'case-1'), true);
});

test('investigator notes and timeline events persist in PostgreSQL with distinct audit records', async () => {
  const pool = new FakePostgres();
  let nextId = 0;
  const store = new WantedPersonsStore(pool, { makeId: (prefix) => prefix + '-investigation-' + (++nextId) });
  const created = await store.save({ person: person({ caseIds: ['case-1'] }), actor: { id: 'leader-1' } });
  const evidenceBytes = Buffer.from('%PDF-1.4\nRP evidence\n');
  const evidence = await store.saveEvidence({
    personId: created.person.id,
    evidence: {
      category: 'DOCUMENT', title: 'مستند مرفوع', description: 'تفاصيل الدليل', source: 'اختبار',
      recordedAt: '2026-11-11T09:00:00.000Z', caseIds: ['case-1'], contentType: 'application/pdf',
      fileName: 'evidence.pdf', fileData: evidenceBytes.toString('base64')
    },
    actor: { id: 'investigator-1', canManageAll: false }
  });
  assert.equal(evidence.ok, true);
  const note = await store.saveNote({
    personId: created.person.id,
    note: { title: 'إفادة شاهد', body: 'تفاصيل الإفادة', caseId: 'case-1' },
    actor: { id: 'investigator-1', canManageAll: false }
  });
  assert.equal(note.ok, true);
  assert.equal(note.note.createdByUserId, 'investigator-1');
  assert.ok(note.note.createdAt);
  const noCaseNote = await store.saveNote({
    personId: created.person.id,
    note: { title: 'ملاحظة بلا قضية', body: 'محتوى محفوظ دون ارتباط بقضية', caseId: '' },
    actor: { id: 'investigator-2', canManageAll: false }
  });
  assert.equal(noCaseNote.ok, true);
  assert.equal(noCaseNote.note.caseId, '');

  const deniedUpdate = await store.saveNote({
    personId: created.person.id,
    note: { id: note.note.id, title: 'تغيير غير مخول', body: 'نص', caseId: 'case-1' },
    actor: { id: 'investigator-2', canManageAll: false }
  });
  assert.equal(deniedUpdate.ok, false);
  const deniedDelete = await store.deleteNote({
    personId: created.person.id,
    noteId: note.note.id,
    actor: { id: 'investigator-2', canManageAll: false }
  });
  assert.equal(deniedDelete.ok, false);

  const invalidCase = await store.addTimelineEvent({
    personId: created.person.id,
    event: { eventType: 'MANUAL', title: 'حدث غير مرتبط', body: 'نص', caseId: 'case-unlinked' },
    actor: { id: 'investigator-1' }
  });
  assert.equal(invalidCase.ok, false);
  assert.match(invalidCase.message, /اربط القضية/);
  const missingDetails = await store.addTimelineEvent({
    personId: created.person.id,
    event: { eventType: 'MANUAL', title: 'حدث بلا تفاصيل', body: '', caseId: '' },
    actor: { id: 'investigator-1' }
  });
  assert.equal(missingDetails.ok, false);
  assert.match(missingDetails.message, /تفاصيله مطلوبان/);

  const testimony = await store.addTimelineEvent({
    personId: created.person.id,
    event: { eventType: 'TESTIMONY_RECORDED', title: 'إفادة شاهد', body: 'تم تسجيل الإفادة', caseId: 'case-1', occurredAt: '2026-11-11T10:00:00.000Z' },
    actor: { id: 'investigator-1' }
  });
  assert.equal(testimony.event.eventType, 'TESTIMONY_RECORDED');
  const firstOpen = await store.recordFileOpened({ personId: created.person.id, actor: { id: 'investigator-1' }, fileNumber: 'BR-TEST-01', actorName: 'محقق الاختبار' });
  const repeatedOpen = await store.recordFileOpened({ personId: created.person.id, actor: { id: 'investigator-1' }, fileNumber: 'BR-TEST-01', actorName: 'محقق الاختبار' });
  assert.equal(firstOpen.recorded, true);
  assert.equal(repeatedOpen.recorded, false);

  const board = await store.board(created.person.id);
  assert.equal(board.notes.length, 2);
  const storedNote = board.notes.find((item) => item.id === note.note.id);
  assert.equal(storedNote.title, 'إفادة شاهد');
  assert.equal(storedNote.createdByUserId, 'investigator-1');
  assert.ok(storedNote.createdAt);
  assert.deepEqual(
    board.timeline.map((event) => event.eventType).sort(),
    ['CASE_LINKED', 'EVIDENCE_ADDED', 'FILE_OPENED', 'TESTIMONY_RECORDED'].sort()
  );
  assert.equal(pool.audit.some((entry) => entry.action === 'NOTE_CREATED'), true);
  assert.equal(pool.audit.some((entry) => entry.action === 'TIMELINE_CREATED'), true);
  assert.match(SCHEMA_SQL.join('\n'), /ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'MANUAL'/);
});

test('invalid records and duplicate file numbers fail closed', async () => {
  const store = new WantedPersonsStore(new FakePostgres(), { makeId: (prefix) => prefix + '-1' });
  const invalid = await store.save({ person: person({ severity: 'EXTREME' }), actor: { id: 'leader-1' } });
  assert.equal(invalid.ok, false);
  assert.match(invalid.message, /درجة الخطورة/);
  const first = await store.save({ person: person(), actor: { id: 'leader-1' } });
  const duplicate = await store.save({ person: person({ fileNumber: 'br-test-01' }), actor: { id: 'leader-1' } });
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.message, /رقم الملف مستخدم/);
});

test('image URLs permit HTTPS and safe local paths only', () => {
  assert.equal(safeImageUrl('https://images.example.test/profile.png'), 'https://images.example.test/profile.png');
  assert.equal(safeImageUrl('/uploads/profile.png'), '/uploads/profile.png');
  assert.equal(safeImageUrl('//images.example.test/profile.png'), '');
  assert.equal(safeImageUrl('http://images.example.test/profile.png'), '');
  assert.equal(safeImageUrl('javascript:alert(1)'), '');
});

test('evidence uploads accept only bounded files with matching image and document signatures', async () => {
  assert.equal(matchesMimeSignature(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'), true);
  assert.equal(matchesMimeSignature(Buffer.from('%PDF-1.4\n'), 'application/pdf'), true);
  assert.equal(matchesMimeSignature(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml'), false);
  const store = new WantedPersonsStore(new FakePostgres(), { makeId: (prefix) => prefix + '-test' });
  const rejected = await store.saveEvidence({
    personId: 'WANTED-TEST',
    actor: { id: 'leader-test' },
    evidence: {
      category: 'IMAGE',
      title: 'Invalid image',
      caseIds: [],
      recordedAt: '2026-11-08T10:00:00.000Z',
      contentType: 'image/png',
      fileName: 'bad.png',
      fileData: Buffer.from('<script>alert(1)</script>').toString('base64')
    }
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /لا يطابق/);
});

test('wanted persons markup adds one independent nav item, page and assets', () => {
  const html = '<html><head></head><body><ul class="nav-list"><li id="ibp-nav">IBP</li><li id="weapon-armory-nav">Armory</li></ul><div id="dashboard" class="view-pane active"></div></body></html>';
  const injected = injectWantedPersonsMarkup(html);
  assert.match(injected, /id="wanted-persons-nav"/);
  assert.match(injected, /id="wanted-persons"/);
  assert.match(injected, /href="\/wanted-persons\.css"/);
  assert.match(injected, /src="\/wanted-persons-client\.js"/);
  assert.match(injected, /id="wp-investigation-board"/);
  assert.match(injected, /id="wp-evidence-form"/);
  assert.match(injected, /id="wp-audit-list"/);
  assert.match(injected, /id="wp-link-case"/);
  assert.match(injected, /id="wp-create-case"/);
  assert.match(injected, /id="wp-case-link-options"/);
  assert.match(injected, /id="wp-new-case-form"/);
  assert.match(injected, /id="wp-event-type"/);
  assert.match(injected, /تسجيل إفادة/);
  assert.match(injected, /السجل الزمني/);
  assert.match(injected, /سجل للتطورات، وليس سجل التدقيق/);
  assert.match(injected, /أرشيف القضايا والأدلة/);
  const again = injectWantedPersonsMarkup(injected);
  for (const id of ['wanted-persons-nav', 'wanted-persons']) assert.equal((again.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1);
  assert.equal((again.match(/src="\/wanted-persons-client\.js"/g) || []).length, 1);
  assert.equal(injectWantedPersonsMarkup('<main>incomplete'), '<main>incomplete');
});

test('socket handlers let active users read files while leadership creates and links profiles', async () => {
  const { socket, handlers } = makeSocket();
  const calls = [];
  const record = { id: 'WANTED-1', fileNumber: 'BR-1', fullName: 'فرد', aliases: [], imageUrl: '', severity: 'MEDIUM', status: 'WANTED', caseIds: ['case-1'], notes: 'secret note', details: 'secret detail' };
  const store = {
    list: async (filters) => { calls.push(['list', filters]); return { items: [record], total: 1, limit: 100, offset: 0 }; },
    get: async (id) => { calls.push(['get', id]); return id === record.id ? record : null; },
    save: async (input) => { calls.push(['save', input]); return { ok: true, action: 'CREATED', person: { ...record, ...input.person, id: record.id } }; }
  };
  let actor = null;
  const state = { cia_cases: [
    { id: 'case-1', caseNumber: 'CASE-001', title: 'قضية قائمة', status: 'OPEN', classification: 'CONFIDENTIAL', description: 'do not leak' },
    { id: 'case-2', caseNumber: 'CASE-002', title: 'قضية ثانية', status: 'OPEN' }
  ] };
  registerWantedPersonsSocket(socket, {
    getStore: () => store,
    getState: () => state,
    requireUser: () => actor,
    isLeadership: (user) => user?.id === 'leader-1'
  });

  let response;
  await handlers.get('wanted-persons:list')({}, (result) => { response = result; });
  assert.equal(response.ok, false);
  assert.equal(calls.length, 0);
  actor = { id: 'member-1' };
  await handlers.get('wanted-persons:detail')({ id: record.id }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(response.permissions.canManage, false);
  assert.equal(response.permissions.canContribute, true);
  assert.equal(calls.some((call) => call[0] === 'get'), true);
  actor = { id: 'leader-1' };
  await handlers.get('wanted-persons:list')({ name: 'فرد', fileNumber: 'BR-1' }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(response.items[0].fullName, 'فرد');
  assert.equal(Object.hasOwn(response.items[0], 'notes'), false);
  assert.equal(response.availableCases[0].title, 'قضية قائمة');
  assert.equal(Object.hasOwn(response.availableCases[0], 'description'), false);

  await handlers.get('wanted-persons:detail')({ id: record.id }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.deepEqual(casesForPerson(record.caseIds, state).map((item) => item.caseNumber), ['CASE-001']);
  assert.equal(Object.hasOwn(response.relatedCases[0], 'description'), false);

  const payload = { ...person(), fullName: 'فرد', fileNumber: 'BR-2', caseIds: ['missing-case'] };
  await handlers.get('wanted-persons:save')(payload, (result) => { response = result; });
  assert.equal(response.ok, false);
  assert.match(response.message, /قضايا موجودة فقط/);
  assert.equal(calls.some((call) => call[0] === 'save'), false);

  payload.caseIds = ['case-2'];
  await handlers.get('wanted-persons:save')(payload, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(calls.filter((call) => call[0] === 'save').length, 1);
  assert.equal(calls.find((call) => call[0] === 'save')[1].actor.id, 'leader-1');
});

test('active investigators can read files and contribute notes or events while record management stays restricted', async () => {
  const { socket, handlers } = makeSocket();
  const calls = [];
  let actor = { id: 'member-1' };
  const state = {
    cia_cases: [{
      id: 'case-1', caseNumber: 'CASE-RP-001', title: 'قضية خيالية', description: 'تفاصيل تمثيلية',
      status: 'OPEN', classification: 'CONFIDENTIAL', finalDecision: 'قرار تمثيلي'
    }],
    cia_users: [{ id: 'leader-1', name: 'قائد اختبار' }, { id: 'member-1', name: 'محقق اختبار' }]
  };
  const store = {
    board: async (id) => {
      calls.push(['board', id]);
      return {
        evidence: [],
        notes: [{ id: 'NOTE-1', caseId: 'case-1', title: 'ملاحظة', body: 'نص', createdByUserId: 'member-1', updatedByUserId: 'member-1', createdAt: '2026-11-11T10:00:00.000Z' }],
        timeline: [{ id: 'TIME-1', caseId: 'case-1', eventType: 'TESTIMONY_RECORDED', title: 'إفادة', body: 'تفاصيل', actorUserId: 'member-1', occurredAt: '2026-11-11T11:00:00.000Z' }],
        audit: []
      };
    },
    evidenceFile: async (args) => { calls.push(['file', args]); return { contentType: 'text/plain', fileName: 'rp-test.txt', data: 'UlA=' }; },
    saveEvidence: async (args) => { calls.push(['evidence', args]); return { ok: true }; },
    deleteEvidence: async (args) => { calls.push(['delete-evidence', args]); return { ok: true }; },
    saveNote: async (args) => { calls.push(['note', args]); return { ok: true }; },
    deleteNote: async (args) => { calls.push(['delete-note', args]); return { ok: true }; },
    addTimelineEvent: async (args) => { calls.push(['timeline', args]); return { ok: true }; }
  };
  registerWantedPersonsSocket(socket, {
    getStore: () => store,
    getState: () => state,
    requireUser: () => actor,
    isLeadership: (user) => user?.id === 'leader-1'
  });

  const leadershipOnlyEvents = [
    ['wanted-persons:save', { fullName: 'اسم', fileNumber: 'BR-01', aliases: [], caseIds: [] }],
    ['wanted-persons:cases:save', { personId: 'WANTED-1', caseIds: ['case-1'] }],
    ['wanted-persons:evidence:save', { personId: 'WANTED-1', evidence: { caseIds: [] } }],
    ['wanted-persons:evidence:delete', { personId: 'WANTED-1', evidenceId: 'EVIDENCE-1' }]
  ];
  for (const [event, payload] of leadershipOnlyEvents) {
    let response;
    await handlers.get(event)(payload, (result) => { response = result; });
    assert.equal(response.ok, false, event + ' must reject non-leadership');
  }
  assert.equal(calls.length, 0, 'restricted operations must reject before store writes');

  let response;
  await handlers.get('wanted-persons:investigation')({ personId: 'WANTED-1' }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(response.permissions.canManage, false);
  assert.equal(response.permissions.canContribute, true);
  assert.equal(response.notes[0].createdByName, 'محقق اختبار');
  assert.equal(response.notes[0].permissions.canEdit, true);
  assert.equal(response.timeline[0].actorName, 'محقق اختبار');
  assert.equal(response.timeline[0].eventType, 'TESTIMONY_RECORDED');
  await handlers.get('wanted-persons:evidence:file')({ personId: 'WANTED-1', evidenceId: 'EVIDENCE-1' }, (result) => { response = result; });
  assert.equal(response.ok, true);
  await handlers.get('wanted-persons:note:save')({ personId: 'WANTED-1', note: { title: 'ملاحظة', body: 'نص', caseId: '' } }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(calls.find((call) => call[0] === 'note')[1].actor.canManageAll, false);
  await handlers.get('wanted-persons:timeline:add')({ personId: 'WANTED-1', event: { eventType: 'TESTIMONY_RECORDED', title: 'إفادة', caseId: 'case-1' } }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(calls.some((call) => call[0] === 'timeline'), true);

  actor = { id: 'leader-1' };
  await handlers.get('wanted-persons:investigation')({ personId: 'WANTED-1' }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(response.availableCases[0].description, 'تفاصيل تمثيلية');
  assert.equal(response.availableCases[0].finalDecision, 'قرار تمثيلي');
  assert.equal(response.permissions.canManage, true);

  await handlers.get('wanted-persons:evidence:file')({ personId: 'WANTED-1', evidenceId: 'EVIDENCE-1' }, (result) => { response = result; });
  assert.equal(response.ok, true);
  await handlers.get('wanted-persons:evidence:save')({ personId: 'WANTED-1', evidence: { caseIds: ['missing'] } }, (result) => { response = result; });
  assert.equal(response.ok, false);
  assert.match(response.message, /قضايا موجودة فقط/);
  assert.equal(calls.some((call) => call[0] === 'evidence'), false);

  await handlers.get('wanted-persons:evidence:save')({ personId: 'WANTED-1', evidence: { caseIds: ['case-1'] } }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(calls.find((call) => call[0] === 'evidence')[1].actor.id, 'leader-1');
  await handlers.get('wanted-persons:note:save')({ personId: 'WANTED-1', note: { title: 'ملاحظة', body: 'نص', caseId: 'case-1' } }, (result) => { response = result; });
  assert.equal(response.ok, true);
  await handlers.get('wanted-persons:timeline:add')({ personId: 'WANTED-1', event: { title: 'حدث', caseId: 'case-1' } }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(calls.some((call) => call[0] === 'timeline'), true);
});

test('case summaries preserve the phase one limited payload while the board reads existing case details', () => {
  const cases = [{
    id: 'case-1', caseNumber: 'CASE-RP-001', title: 'قضية خيالية', description: 'تفاصيل سرية',
    status: 'CLOSED', classification: 'CONFIDENTIAL', finalDecision: 'قرار نهائي',
    media: 'https://archive.example.test/evidence.pdf'
  }];
  assert.equal(Object.hasOwn(casesForPerson(['case-1'], { cia_cases: cases })[0], 'description'), false);
  assert.equal(casesForPerson(['case-1'], { cia_cases: cases })[0].mediaUrl, 'https://archive.example.test/evidence.pdf');
  const detailed = investigationCases({ cia_cases: cases })[0];
  assert.equal(detailed.description, 'تفاصيل سرية');
  assert.equal(detailed.finalDecision, 'قرار نهائي');
  assert.equal(detailed.mediaUrl, 'https://archive.example.test/evidence.pdf');
  const legacy = investigationCases({ cia_cases: [{ id: 'legacy-rp-01', title: 'قضية قديمة', details: 'تفاصيل قديمة' }] })[0];
  assert.equal(legacy.caseNumber, 'CASE-legacy-rp-01');
  const missingArchiveRecord = casesForPerson(['deleted-case-id'], { cia_cases: cases })[0];
  assert.equal(missingArchiveRecord.unavailable, true);
  assert.equal(missingArchiveRecord.id, 'deleted-case-id');
  assert.match(missingArchiveRecord.title, /غير متاحة/);
});

test('case-link socket writes accept only real archive cases', async () => {
  const { socket, handlers } = makeSocket();
  const calls = [];
  const store = {
    saveCaseLinks: async (input) => {
      calls.push(input);
      return { ok: true, person: { id: input.personId, caseIds: input.caseIds } };
    }
  };
  let actor = { id: 'leader-1' };
  const state = { cia_cases: [{ id: 'case-1', caseNumber: 'CASE-001', title: 'قضية قائمة' }] };
  registerWantedPersonsSocket(socket, {
    getStore: () => store,
    getState: () => state,
    requireUser: () => actor,
    isLeadership: (user) => user?.id === 'leader-1'
  });

  let response;
  await handlers.get('wanted-persons:cases:save')({
    personId: 'WANTED-1',
    caseIds: ['missing-case']
  }, (result) => { response = result; });
  assert.equal(response.ok, false);
  assert.equal(calls.length, 0);

  await handlers.get('wanted-persons:cases:save')({
    personId: 'WANTED-1',
    caseIds: ['case-1', 'case-1']
  }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.deepEqual(calls[0].caseIds, ['case-1']);
  assert.deepEqual(response.relatedCases.map((item) => item.caseNumber), ['CASE-001']);
});

test('the existing Cases Vault writes numbered cases through server CIA events', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(page, /ciaSocket\.emit\('case:create'/);
  assert.match(page, /status:\s*'OPEN'/);
  assert.match(page, /classification:\s*'CONFIDENTIAL'/);
  assert.match(page, /state\.cia_cases\)\) \{ casesList = state\.cia_cases/);
  assert.match(server, /caseNumberPrefix = `CASE-\$\{Date\.now\(\)\}`/);
  assert.match(server, /key === 'cia_cases'.*تعديل القضايا عبر التخزين المشترك غير مسموح/s);
  assert.match(server, /payload\?\.finalDecision !== undefined && !isLeadership\(actor\)/);
});

test('save event is automatically scanned by the existing text moderation boundary', () => {
  const values = getSocketTextInputs('wanted-persons:save', {
    fullName: 'Name', aliases: ['Alias'], notes: 'investigative note', details: 'record detail', imageUrl: 'https://example.test/img.jpg', id: 'WANTED-1'
  });
  assert.ok(values.includes('Name'));
  assert.ok(values.includes('investigative note'));
  assert.ok(values.includes('record detail'));
  assert.equal(values.includes('https://example.test/img.jpg'), false);
  assert.equal(values.includes('WANTED-1'), false);
  const evidenceValues = getSocketTextInputs('wanted-persons:evidence:save', {
    evidence: {
      title: 'Fictional evidence',
      source: 'RP test archive',
      description: 'A documented fictional clue.',
      fileName: 'evidence.pdf',
      contentType: 'application/pdf',
      fileData: 'base64-binary-content',
      thumbnailData: 'base64-thumbnail'
    }
  });
  assert.ok(evidenceValues.includes('A documented fictional clue.'));
  assert.equal(evidenceValues.includes('base64-binary-content'), false);
  assert.equal(evidenceValues.includes('base64-thumbnail'), false);
  assert.equal(evidenceValues.includes('evidence.pdf'), false);
});

test('frontend uses text nodes and server events rather than browser storage', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'wanted-persons-client.js'), 'utf8');
  assert.match(client, /wanted-persons:list/);
  assert.match(client, /wanted-persons:detail/);
  assert.match(client, /wanted-persons:save/);
  assert.match(client, /wanted-persons:cases:save/);
  assert.match(client, /request\('case:create'/);
  assert.match(client, /فتح أرشيف القضايا والأدلة/);
  assert.match(client, /state\.activePerson\?\.caseIds/);
  assert.match(client, /أُضيفت بواسطة/);
  assert.match(client, /item\.createdAt/);
  assert.match(client, /orderedTimeline/);
  assert.match(client, /eventType: byId\('wp-event-type'\)\.value/);
  assert.match(client, /textContent/);
  assert.match(client, /await load\(true, true\)/);
  assert.match(client, /state\.activeId = person\?\.id/);
  assert.doesNotMatch(client, /innerHTML|localStorage|sessionStorage/);
});

test('the current dashboard receives the wanted persons section through the root injector', () => {
  const appHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const injected = injectWantedPersonsMarkup(appHtml);
  assert.match(injected, /id="wanted-persons-nav"[^>]*onclick="showPane\('wanted-persons', this\)"/);
  assert.match(injected, /id="wanted-persons" class="view-pane wanted-persons-page"/);
  assert.match(server, /injectWantedPersonsMarkup\(/);
  assert.match(server, /wanted-persons\.css/);
  assert.match(server, /wanted-persons-client\.js/);
  assert.equal((injected.match(/id="wanted-persons-nav"/g) || []).length, 1);
  assert.equal((injected.match(/id="wanted-persons"/g) || []).length, 1);
});

test('write failures are logged by operation and code without exposing raw database messages', async () => {
  const { socket, handlers } = makeSocket();
  const store = {
    list: async () => {
      const error = new Error('private database connection detail');
      error.code = 'ECONNREFUSED';
      throw error;
    }
  };
  registerWantedPersonsSocket(socket, {
    getStore: () => store,
    getState: () => ({ cia_cases: [] }),
    requireUser: () => ({ id: 'leader-1' }),
    isLeadership: (user) => user?.id === 'leader-1'
  });
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  let response;
  try {
    await handlers.get('wanted-persons:list')({}, (result) => { response = result; });
  } finally {
    console.error = originalError;
  }
  assert.equal(response.ok, false);
  assert.match(response.message, /قاعدة البيانات/);
  assert.match(logs.join('\n'), /WANTED PERSONS.*list failed.*ECONNREFUSED/);
  assert.doesNotMatch(logs.join('\n'), /private database connection detail/);
});

test('the unavailable store response identifies the PostgreSQL configuration without falling back locally', async () => {
  const { socket, handlers } = makeSocket();
  registerWantedPersonsSocket(socket, {
    getStore: () => null,
    getState: () => ({ cia_cases: [] }),
    requireUser: () => ({ id: 'leader-1' }),
    isLeadership: (user) => user?.id === 'leader-1'
  });
  let response;
  await handlers.get('wanted-persons:list')({}, (result) => { response = result; });
  assert.equal(response.ok, false);
  assert.match(response.message, /DATABASE_URL/);
  assert.match(response.message, /لا يوجد حفظ محلي بديل/);
});

test('investigation writes prevent duplicate submissions and report refresh failures', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'wanted-persons-client.js'), 'utf8');
  assert.match(client, /function lockSubmission\(form\)/);
  assert.match(client, /if \(state\.busy\) return null/);
  assert.match(client, /function confirmRefreshAfterWrite\(successMessage\)/);
  assert.match(client, /تم حفظ التغيير، لكن تعذر تحديث العرض/);
  assert.ok((client.match(/confirmRefreshAfterWrite\(/g) || []).length >= 7);
});
