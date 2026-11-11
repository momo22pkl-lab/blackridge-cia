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
    this.deletedTables = [];
    this.backup = null;
    this.sequence = 0;
  }

  async query(sql, params) { return this.execute(sql, params || []); }
  async connect() { return { query: (sql, params) => this.execute(sql, params || []), release() {} }; }

  async execute(sql, params) {
    const query = String(sql).replace(/\s+/g, ' ').trim();
    const lower = query.toLowerCase();
    if (lower === 'begin') {
      this.backup = { rows: cloneRows(this.rows), audit: [...this.audit] };
      return { rows: [], rowCount: 0 };
    }
    if (lower === 'commit') { this.backup = null; return { rows: [], rowCount: 0 }; }
    if (lower === 'rollback') {
      if (this.backup) { this.rows = this.backup.rows; this.audit = this.backup.audit; }
      this.backup = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^(create|alter|do)\s/i.test(lower)) return { rows: [], rowCount: 0 };
    if (lower.startsWith('update blackridge_wanted_timeline set updated_by_user_id')) return { rows: [], rowCount: 0 };
    if (lower.startsWith('select id, created_by_user_id from blackridge_wanted_persons')) {
      const row = this.rows.get(params[0]);
      return { rows: row ? [{ id: row.id, created_by_user_id: row.created_by_user_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (lower.startsWith('delete from blackridge_wanted_')) {
      this.deletedTables.push(lower.split(' ')[2]);
      if (lower.startsWith('delete from blackridge_wanted_persons where id')) this.rows.delete(params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (lower.startsWith('select id from blackridge_wanted_persons where id = $1 for update')) {
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
    if (lower.startsWith('insert into blackridge_wanted_persons_audit')) {
      this.audit.push({ id: params[0], person_id: params[1], actor_user_id: params[2], action: params[3], changed_fields: JSON.parse(params[4]) });
      return { rows: [], rowCount: 1 };
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

  const deniedUpdate = await store.save({ person: person({ id: created.person.id, status: 'UNDER_INVESTIGATION' }), actor: { id: 'leader-2' } });
  assert.equal(deniedUpdate.ok, false);
  const ownerUpdate = await store.save({ person: person({ id: created.person.id, status: 'UNDER_INVESTIGATION', notes: 'ملاحظة محدثة' }), actor: { id: 'leader-1' } });
  assert.equal(ownerUpdate.ok, true);
  const chiefUpdate = await store.save({ person: person({ id: created.person.id, status: 'UNDER_INVESTIGATION', notes: 'ملاحظة محدثة' }), actor: { id: 'leader-2', canManageAll: true } });
  assert.equal(chiefUpdate.ok, true);
  assert.equal(chiefUpdate.person.status, 'UNDER_INVESTIGATION');
  assert.equal(chiefUpdate.person.notes, 'ملاحظة محدثة');
  assert.equal(pool.audit[2].action, 'UPDATED');
  assert.equal(pool.rows.size, 1);

  const detail = await store.get(created.person.id);
  assert.equal(detail.fullName, 'شخص للاختبار');
  assert.equal(detail.createdByUserId, 'leader-1');
  const listing = await store.list({ limit: 100, offset: 0 });
  assert.equal(listing.total, 1);
  assert.equal(listing.items.length, 1);
});

test('only the report creator or Primary Chief can delete a report and its dependent records', async () => {
  const pool = new FakePostgres();
  let nextId = 0;
  const store = new WantedPersonsStore(pool, { makeId: (prefix) => prefix + '-delete-' + (++nextId) });
  await store.initialize();
  const created = await store.save({ person: person(), actor: { id: 'author-1' } });
  const denied = await store.deletePerson({ personId: created.person.id, actor: { id: 'other-1' } });
  assert.equal(denied.ok, false);
  assert.ok(pool.rows.has(created.person.id));
  const ownerDeleted = await store.deletePerson({ personId: created.person.id, actor: { id: 'author-1' } });
  assert.equal(ownerDeleted.ok, true);
  const chiefCreated = await store.save({ person: person({ fileNumber: 'BR-TEST-02' }), actor: { id: 'author-2' } });
  const chiefDeleted = await store.deletePerson({ personId: chiefCreated.person.id, actor: { id: 'chief-1', canManageAll: true } });
  assert.equal(chiefDeleted.ok, true);
  assert.equal(pool.rows.has(chiefCreated.person.id), false);
  assert.deepEqual(pool.deletedTables.slice(-5), [
    'blackridge_wanted_evidence', 'blackridge_wanted_notes', 'blackridge_wanted_timeline',
    'blackridge_wanted_persons_audit', 'blackridge_wanted_persons'
  ]);
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
  assert.match(injected, /id="wp-evidence-list"/);
  assert.match(injected, /id="wp-audit-list"/);
  assert.match(injected, /id="wp-delete-button"/);
  assert.match(injected, /id="wp-event-id"/);
  const again = injectWantedPersonsMarkup(injected);
  for (const id of ['wanted-persons-nav', 'wanted-persons']) assert.equal((again.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1);
  assert.equal((again.match(/src="\/wanted-persons-client\.js"/g) || []).length, 1);
  assert.equal(injectWantedPersonsMarkup('<main>incomplete'), '<main>incomplete');
});

test('authenticated ranks can read; report edits/deletes are creator-only except Primary Chief', async () => {
  const { socket, handlers } = makeSocket();
  const calls = [];
  const record = {
    id: 'WANTED-1', fileNumber: 'BR-1', fullName: 'فرد', aliases: [], imageUrl: '',
    severity: 'MEDIUM', status: 'WANTED', caseIds: ['case-1'], notes: 'secret note',
    details: 'secret detail', createdByUserId: 'owner-1', createdAt: '2026-11-09T10:00:00.000Z'
  };
  const store = {
    list: async (filters) => { calls.push(['list', filters]); return { items: [record], total: 1, limit: 100, offset: 0 }; },
    get: async (id) => { calls.push(['get', id]); return id === record.id ? record : null; },
    save: async (input) => { calls.push(['save', input]); return { ok: true, action: input.person.id ? 'UPDATED' : 'CREATED', person: { ...record, ...input.person, id: record.id } }; },
    deletePerson: async (input) => { calls.push(['delete', input]); return { ok: true }; }
  };
  let actor = null;
  const state = { cia_cases: [
    { id: 'case-1', caseNumber: 'CASE-001', title: 'قضية قائمة', status: 'OPEN', classification: 'CONFIDENTIAL', description: 'do not leak' },
    { id: 'case-2', caseNumber: 'CASE-002', title: 'قضية ثانية', status: 'OPEN' }
  ], cia_users: [
    { id: 'owner-1', name: 'صاحب الملف', publicCode: 'CIA-101', rank: 'AGENT' }
  ] };
  registerWantedPersonsSocket(socket, {
    getStore: () => store,
    getState: () => state,
    requireUser: () => actor,
    isLeadership: (user) => ['leader-1', 'chief-1'].includes(user?.id),
    isPrimaryChief: (user) => user?.id === 'chief-1',
    rankLabel: (rank) => rank || 'غير محددة'
  });

  let response;
  await handlers.get('wanted-persons:list')({}, (result) => { response = result; });
  assert.equal(response.ok, false);
  assert.equal(calls.length, 0);
  actor = { id: 'owner-1', rank: 'AGENT' };
  await handlers.get('wanted-persons:list')({}, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(response.permissions.canCreate, false);
  assert.equal(response.items[0].createdByName, 'صاحب الملف');
  assert.equal(response.items[0].createdByCode, 'CIA-101');
  assert.equal(response.items[0].createdByRank, 'AGENT');
  assert.equal(response.items[0].permissions.canEdit, true);

  actor = { id: 'member-1', rank: 'AGENT' };
  await handlers.get('wanted-persons:detail')({ id: record.id }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(response.permissions.canEdit, false);
  assert.equal(response.permissions.canDelete, false);
  assert.equal(response.permissions.canContribute, true);
  assert.equal(response.person.createdByName, 'صاحب الملف');
  assert.equal(Object.hasOwn(response.person, 'createdByUserId'), false);

  const payload = { ...person(), id: record.id, fullName: 'فرد محدث', fileNumber: 'BR-1', caseIds: ['case-2'] };
  await handlers.get('wanted-persons:save')(payload, (result) => { response = result; });
  assert.equal(response.ok, false);
  assert.match(response.message, /منشئه أو للقائد الرئيس/);
  assert.equal(calls.some((call) => call[0] === 'save'), false);

  actor = { id: 'owner-1', rank: 'AGENT' };
  await handlers.get('wanted-persons:save')(payload, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(calls.find((call) => call[0] === 'save')[1].actor.canManageAll, false);

  actor = { id: 'leader-1' };
  await handlers.get('wanted-persons:list')({ name: 'فرد', fileNumber: 'BR-1' }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(response.items[0].fullName, 'فرد');
  assert.equal(Object.hasOwn(response.items[0], 'notes'), false);
  assert.equal(response.availableCases[0].title, 'قضية قائمة');
  assert.equal(Object.hasOwn(response.availableCases[0], 'description'), false);

  assert.deepEqual(casesForPerson(record.caseIds, state).map((item) => item.caseNumber), ['CASE-001']);

  const badLink = { ...person(), fullName: 'فرد', fileNumber: 'BR-2', caseIds: ['missing-case'] };
  await handlers.get('wanted-persons:save')(badLink, (result) => { response = result; });
  assert.equal(response.ok, false);
  assert.match(response.message, /قضايا موجودة فقط/);
  assert.equal(calls.filter((call) => call[0] === 'save').length, 1);

  const createPayload = { ...person(), fullName: 'فرد جديد', fileNumber: 'BR-2', caseIds: ['case-2'] };
  await handlers.get('wanted-persons:save')(createPayload, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(calls.filter((call) => call[0] === 'save').length, 2);
  actor = { id: 'leader-1', rank: 'SUPREME COMMANDER' };
  await handlers.get('wanted-persons:save')(payload, (result) => { response = result; });
  assert.equal(response.ok, false);
  assert.equal(calls.filter((call) => call[0] === 'save').length, 2);
  actor = { id: 'chief-1', rank: 'CIA CHIEF' };
  await handlers.get('wanted-persons:save')(payload, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(calls.filter((call) => call[0] === 'save').at(-1)[1].actor.canManageAll, true);
  await handlers.get('wanted-persons:delete')({ id: record.id }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(calls.find((call) => call[0] === 'delete')[1].actor.canManageAll, true);
});

test('all authenticated ranks can add evidence, notes, and timeline events; metadata identifies each author', async () => {
  const { socket, handlers } = makeSocket();
  const calls = [];
  let actor = { id: 'member-1', rank: 'AGENT' };
  const state = {
    cia_cases: [{
      id: 'case-1', caseNumber: 'CASE-RP-001', title: 'قضية خيالية', description: 'تفاصيل تمثيلية',
      status: 'OPEN', classification: 'CONFIDENTIAL', finalDecision: 'قرار تمثيلي'
    }],
    cia_users: [
      { id: 'report-owner', name: 'صاحب الملف', publicCode: 'CIA-001', rank: 'AGENT' },
      { id: 'member-1', name: 'محقق مساعد', publicCode: 'CIA-102', rank: 'AGENT' },
      { id: 'other-2', name: 'محقق آخر', publicCode: 'CIA-103', rank: 'HIGH COMMANDER' }
    ]
  };
  const store = {
    board: async (id) => {
      calls.push(['board', id]);
      return {
        evidence: [{
          id: 'E-1', personId: id, title: 'دليل تمثيلي', caseIds: ['case-1'],
          createdByUserId: 'member-1', createdAt: '2026-11-09T12:00:00.000Z'
        }],
        notes: [{
          id: 'N-1', personId: id, title: 'ملاحظة تمثيلية', body: 'نص', caseId: 'case-1',
          createdByUserId: 'member-1', updatedByUserId: 'member-1',
          createdAt: '2026-11-09T12:01:00.000Z', updatedAt: '2026-11-09T12:01:00.000Z'
        }],
        timeline: [{
          id: 'T-1', personId: id, title: 'حدث تمثيلي', body: 'نص', caseId: 'case-1',
          actorUserId: 'member-1', updatedByUserId: 'member-1',
          createdAt: '2026-11-09T12:02:00.000Z', updatedAt: '2026-11-09T12:02:00.000Z'
        }],
        audit: []
      };
    },
    get: async (id) => id === 'WANTED-1' ? { id, createdByUserId: 'report-owner', caseIds: [] } : null,
    evidenceFile: async (args) => { calls.push(['file', args]); return { contentType: 'text/plain', fileName: 'rp-test.txt', data: 'UlA=' }; },
    saveEvidence: async (args) => { calls.push(['evidence', args]); return { ok: true }; },
    deleteEvidence: async (args) => { calls.push(['delete-evidence', args]); return { ok: true }; },
    saveNote: async (args) => { calls.push(['note', args]); return { ok: true }; },
    deleteNote: async (args) => { calls.push(['delete-note', args]); return { ok: true }; },
    saveTimelineEvent: async (args) => { calls.push(['timeline', args]); return { ok: true }; },
    deleteTimelineEvent: async (args) => { calls.push(['delete-timeline', args]); return { ok: true }; }
  };
  registerWantedPersonsSocket(socket, {
    getStore: () => store,
    getState: () => state,
    requireUser: () => actor,
    isLeadership: (user) => user?.id === 'leader-1' || user?.id === 'chief-1',
    isPrimaryChief: (user) => user?.id === 'chief-1',
    rankLabel: (rank) => rank || 'غير محددة'
  });

  let response;
  await handlers.get('wanted-persons:investigation')({ personId: 'WANTED-1' }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(response.availableCases[0].description, 'تفاصيل تمثيلية');
  assert.equal(response.availableCases[0].finalDecision, 'قرار تمثيلي');
  assert.equal(response.permissions.canManageAll, false);
  assert.equal(response.permissions.canContribute, true);
  assert.equal(response.evidence[0].createdByName, 'محقق مساعد');
  assert.equal(response.evidence[0].createdByCode, 'CIA-102');
  assert.equal(response.evidence[0].createdByRank, 'AGENT');
  assert.equal(response.evidence[0].permissions.canEdit, true);
  assert.equal(Object.hasOwn(response.evidence[0], 'createdByUserId'), false);
  assert.equal(response.notes[0].createdByCode, 'CIA-102');
  assert.equal(response.notes[0].createdByRank, 'AGENT');
  assert.equal(response.timeline[0].actorCode, 'CIA-102');
  assert.equal(response.timeline[0].actorRank, 'AGENT');
  assert.equal(response.timeline[0].createdAt, '2026-11-09T12:02:00.000Z');

  await handlers.get('wanted-persons:evidence:file')({ personId: 'WANTED-1', evidenceId: 'EVIDENCE-1' }, (result) => { response = result; });
  assert.equal(response.ok, true);
  await handlers.get('wanted-persons:evidence:save')({ personId: 'WANTED-1', evidence: { caseIds: ['missing'] } }, (result) => { response = result; });
  assert.equal(response.ok, false);
  assert.match(response.message, /قضايا موجودة فقط/);
  assert.equal(calls.some((call) => call[0] === 'evidence'), false);

  await handlers.get('wanted-persons:evidence:save')({ personId: 'WANTED-1', evidence: { caseIds: ['case-1'] } }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(calls.find((call) => call[0] === 'evidence')[1].actor.id, 'member-1');
  assert.equal(calls.find((call) => call[0] === 'evidence')[1].actor.canManageAll, false);
  await handlers.get('wanted-persons:note:save')({ personId: 'WANTED-1', note: { title: 'ملاحظة', body: 'نص', caseId: 'case-1' } }, (result) => { response = result; });
  assert.equal(response.ok, true);
  actor = { id: 'other-2', rank: 'HIGH COMMANDER' };
  await handlers.get('wanted-persons:timeline:add')({ personId: 'WANTED-1', event: { title: 'حدث', caseId: 'case-1' } }, (result) => { response = result; });
  assert.equal(response.ok, true);
  assert.equal(calls.some((call) => call[0] === 'timeline'), true);
  assert.equal(calls.find((call) => call[0] === 'timeline')[1].actor.id, 'other-2');
  actor = { id: 'chief-1', rank: 'CIA CHIEF' };
  await handlers.get('wanted-persons:evidence:save')({ personId: 'WANTED-1', evidence: { caseIds: ['case-1'] } }, (result) => { response = result; });
  assert.equal(calls.filter((call) => call[0] === 'evidence').at(-1)[1].actor.canManageAll, true);
});

test('case summaries preserve the phase one limited payload while the board reads existing case details', () => {
  const cases = [{
    id: 'case-1', caseNumber: 'CASE-RP-001', title: 'قضية خيالية', description: 'تفاصيل سرية',
    status: 'CLOSED', classification: 'CONFIDENTIAL', finalDecision: 'قرار نهائي'
  }];
  assert.equal(Object.hasOwn(casesForPerson(['case-1'], { cia_cases: cases })[0], 'description'), false);
  const detailed = investigationCases({ cia_cases: cases })[0];
  assert.equal(detailed.description, 'تفاصيل سرية');
  assert.equal(detailed.finalDecision, 'قرار نهائي');
  const legacy = investigationCases({ cia_cases: [{ id: 'legacy-rp-01', title: 'قضية قديمة', details: 'تفاصيل قديمة' }] })[0];
  assert.equal(legacy.caseNumber, 'CASE-legacy-rp-01');
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
  assert.match(client, /wanted-persons:delete/);
  assert.match(client, /wanted-persons:timeline:delete/);
  assert.match(client, /type: 'note'/);
  assert.match(client, /type: 'timeline'/);
  assert.match(client, /الكود العسكري/);
  assert.match(client, /الرتبة/);
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
