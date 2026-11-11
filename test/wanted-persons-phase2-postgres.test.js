'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { WantedPersonsStore } = require('../wanted-persons-store');
const { PostgresStateStore } = require('../state-store');

const databaseUrl = process.env.WANTED_TEST_DATABASE_URL || '';

test('phase two evidence, notes, timeline, links and audit persist in an isolated PostgreSQL schema', {
  skip: !databaseUrl && 'Set WANTED_TEST_DATABASE_URL to a disposable PostgreSQL test database.'
}, async (t) => {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const schema = 'wanted_phase2_test_' + crypto.randomBytes(5).toString('hex');
  await admin.query('CREATE SCHEMA "' + schema + '"');
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: '-c search_path=' + schema
  });
  t.after(async () => {
    await pool.end();
    await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
  });

  const store = new WantedPersonsStore(pool, { makeId: (prefix) => prefix + '-' + crypto.randomUUID() });
  const refreshedStore = new WantedPersonsStore(pool);
  await store.initialize();
  await store.initialize();
  const before = await pool.query('SELECT COUNT(*)::int AS total FROM blackridge_wanted_persons');
  assert.equal(before.rows[0].total, 0, 'the isolated test schema must start empty');

  const savedPerson = await store.save({
    person: {
      fileNumber: 'BR-RP-TEST-01',
      fullName: 'شخصية خيالية للاختبار',
      aliases: ['اسم تمثيلي'],
      imageUrl: '',
      severity: 'HIGH',
      status: 'UNDER_INVESTIGATION',
      caseIds: [],
      notes: '',
      details: 'سجل اختبار لبيئة RP'
    },
    actor: { id: 'test-investigator-1' }
  });
  assert.equal(savedPerson.ok, true);
  const reopenedPerson = await refreshedStore.get(savedPerson.person.id);
  assert.equal(reopenedPerson.fullName, 'شخصية خيالية للاختبار');
  assert.equal(reopenedPerson.createdByUserId, 'test-investigator-1');
  const updatedPerson = await store.save({
    person: { ...reopenedPerson, fullName: 'تعديل غير مصرح' },
    actor: { id: 'test-investigator-2' }
  });
  assert.equal(updatedPerson.ok, false);
  assert.equal((await refreshedStore.get(savedPerson.person.id)).fullName, 'شخصية خيالية للاختبار');
  const ownerUpdatedPerson = await store.save({
    person: { ...reopenedPerson, fullName: 'تعديل صاحب الملف' },
    actor: { id: 'test-investigator-1' }
  });
  assert.equal(ownerUpdatedPerson.ok, true);
  const chiefUpdatedPerson = await store.save({
    person: { ...ownerUpdatedPerson.person, fullName: 'شخصية خيالية معدلة للاختبار' },
    actor: { id: 'test-primary-chief', canManageAll: true }
  });
  assert.equal(chiefUpdatedPerson.ok, true);
  assert.equal((await refreshedStore.get(savedPerson.person.id)).fullName, 'شخصية خيالية معدلة للاختبار');

  const fileBytes = Buffer.from('%PDF-1.4\nFictional RP test evidence\n%%EOF\n');
  const addedEvidence = await store.saveEvidence({
    personId: savedPerson.person.id,
    actor: { id: 'test-investigator-1' },
    evidence: {
      category: 'DOCUMENT',
      title: 'مرفق اختبار خيالي',
      description: 'لا يحتوي بيانات حقيقية.',
      source: 'بيئة الاختبار',
      recordedAt: '2026-11-08T10:00:00.000Z',
      caseIds: ['CASE-RP-TEST-01'],
      contentType: 'application/pdf',
      fileName: 'fictional-evidence.pdf',
      fileData: fileBytes.toString('base64')
    }
  });
  assert.equal(addedEvidence.ok, true);
  assert.equal(addedEvidence.evidence.fileSize, fileBytes.length);
  assert.deepEqual(addedEvidence.evidence.caseIds, ['CASE-RP-TEST-01']);

  const portraitBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const portrait = await store.saveEvidence({
    personId: savedPerson.person.id,
    actor: { id: 'test-investigator-1' },
    evidence: {
      category: 'PERSON',
      title: 'صورة شخصية خيالية',
      source: 'بيئة الاختبار',
      recordedAt: '2026-11-08T10:30:00.000Z',
      caseIds: [],
      contentType: 'image/jpeg',
      fileName: 'fictional-portrait.jpg',
      fileData: portraitBytes.toString('base64'),
      thumbnailData: portraitBytes.toString('base64')
    }
  });
  assert.equal(portrait.ok, true);
  const imageBoard = await refreshedStore.board(savedPerson.person.id);
  assert.equal(imageBoard.evidence.find((item) => item.id === portrait.evidence.id).thumbnailData, 'data:image/jpeg;base64,' + portraitBytes.toString('base64'));
  assert.equal(imageBoard.evidence.find((item) => item.id === portrait.evidence.id).createdByUserId, 'test-investigator-1');
  const deniedEvidenceEdit = await store.saveEvidence({
    personId: savedPerson.person.id,
    actor: { id: 'test-investigator-2' },
    evidence: { ...addedEvidence.evidence, id: addedEvidence.evidence.id, title: 'تعديل غير مصرح' }
  });
  assert.equal(deniedEvidenceEdit.ok, false);
  const chiefEvidenceEdit = await store.saveEvidence({
    personId: savedPerson.person.id,
    actor: { id: 'test-primary-chief', canManageAll: true },
    evidence: { ...addedEvidence.evidence, id: addedEvidence.evidence.id, title: 'دليل بعد مراجعة القائد' }
  });
  assert.equal(chiefEvidenceEdit.ok, true);
  const deniedEvidenceDelete = await store.deleteEvidence({
    personId: savedPerson.person.id, evidenceId: addedEvidence.evidence.id,
    actor: { id: 'test-investigator-2' }
  });
  assert.equal(deniedEvidenceDelete.ok, false);

  const loadedFile = await store.evidenceFile({ personId: savedPerson.person.id, evidenceId: addedEvidence.evidence.id });
  assert.equal(Buffer.from(loadedFile.data, 'base64').toString(), fileBytes.toString());
  assert.equal(loadedFile.contentType, 'application/pdf');

  const addedNote = await store.saveNote({
    personId: savedPerson.person.id,
    actor: { id: 'test-investigator-2' },
    note: { title: 'ملاحظة تمثيلية', body: 'نص ملاحظة للاختبار فقط.', caseId: 'CASE-RP-TEST-01' }
  });
  assert.equal(addedNote.ok, true);
  assert.equal(addedNote.note.createdByUserId, 'test-investigator-2');
  const deniedNoteEdit = await store.saveNote({
    personId: savedPerson.person.id,
    actor: { id: 'test-investigator-1' },
    note: { ...addedNote.note, title: 'تعديل غير مصرح' }
  });
  assert.equal(deniedNoteEdit.ok, false);
  const editedNote = await store.saveNote({
    personId: savedPerson.person.id,
    actor: { id: 'test-investigator-2' },
    note: { ...addedNote.note, title: 'ملاحظة معدلة', body: 'تم التعديل في قاعدة الاختبار.' }
  });
  assert.equal(editedNote.ok, true);
  const chiefEditedNote = await store.saveNote({
    personId: savedPerson.person.id,
    actor: { id: 'test-primary-chief', canManageAll: true },
    note: { ...editedNote.note, title: 'ملاحظة راجعها القائد' }
  });
  assert.equal(chiefEditedNote.ok, true);
  const chiefTestNote = await store.saveNote({
    personId: savedPerson.person.id,
    actor: { id: 'test-investigator-1' },
    note: { title: 'ملاحظة للحذف بواسطة القائد', body: 'اختبار صلاحية القائد الرئيس.', caseId: '' }
  });
  assert.equal(chiefTestNote.ok, true);
  const chiefNoteDelete = await store.deleteNote({
    personId: savedPerson.person.id,
    noteId: chiefTestNote.note.id,
    actor: { id: 'test-primary-chief', canManageAll: true }
  });
  assert.equal(chiefNoteDelete.ok, true);

  const addedEvent = await store.addTimelineEvent({
    personId: savedPerson.person.id,
    actor: { id: 'test-investigator-1' },
    event: {
      title: 'حدث تمثيلي',
      body: 'حدث زمني اصطناعي لقياس الحفظ.',
      caseId: 'CASE-RP-TEST-01',
      occurredAt: '2026-11-08T11:00:00.000Z'
    }
  });
  assert.equal(addedEvent.ok, true);
  assert.equal(addedEvent.event.actorUserId, 'test-investigator-1');
  assert.ok(addedEvent.event.createdAt);
  const deniedTimelineEdit = await store.saveTimelineEvent({
    personId: savedPerson.person.id,
    actor: { id: 'test-investigator-2' },
    event: { ...addedEvent.event, title: 'تعديل غير مصرح' }
  });
  assert.equal(deniedTimelineEdit.ok, false);
  const chiefTimelineEdit = await store.saveTimelineEvent({
    personId: savedPerson.person.id,
    actor: { id: 'test-primary-chief', canManageAll: true },
    event: { ...addedEvent.event, title: 'حدث بعد مراجعة القائد' }
  });
  assert.equal(chiefTimelineEdit.ok, true);
  const deniedTimelineDelete = await store.deleteTimelineEvent({
    personId: savedPerson.person.id, eventId: addedEvent.event.id,
    actor: { id: 'test-investigator-2' }
  });
  assert.equal(deniedTimelineDelete.ok, false);

  const linkedBoard = await refreshedStore.board(savedPerson.person.id);
  assert.equal(linkedBoard.evidence.length, 2);
  assert.equal(linkedBoard.notes.length, 1);
  assert.equal(linkedBoard.timeline.length, 1);
  assert.ok(linkedBoard.audit.some((item) => item.action === 'EVIDENCE_CREATED' && item.actorUserId === 'test-investigator-1'));
  assert.ok(linkedBoard.audit.some((item) => item.action === 'NOTE_UPDATED' && item.actorUserId === 'test-investigator-2'));
  assert.ok(linkedBoard.audit.some((item) => item.action === 'TIMELINE_CREATED'));
  assert.equal(JSON.stringify(linkedBoard).includes(fileBytes.toString()), false, 'board metadata must not include original file bytes');

  const unlinkedEvidence = await store.saveEvidence({
    personId: savedPerson.person.id,
    actor: { id: 'test-investigator-1' },
    evidence: { ...addedEvidence.evidence, caseIds: [] }
  });
  assert.equal(unlinkedEvidence.ok, true);
  assert.deepEqual(unlinkedEvidence.evidence.caseIds, []);
  const unlinkedBoard = await refreshedStore.board(savedPerson.person.id);
  assert.ok(unlinkedBoard.audit.some((item) => item.action === 'EVIDENCE_UNLINKED' && item.actorUserId === 'test-investigator-1'));

  const deleted = await store.deleteEvidence({
    personId: savedPerson.person.id,
    evidenceId: addedEvidence.evidence.id,
    actor: { id: 'test-investigator-1' }
  });
  assert.equal(deleted.ok, true);
  assert.equal(await store.evidenceFile({ personId: savedPerson.person.id, evidenceId: addedEvidence.evidence.id }), null);
  const deletedBoard = await refreshedStore.board(savedPerson.person.id);
  assert.equal(deletedBoard.evidence.length, 1);
  assert.ok(deletedBoard.audit.some((item) => item.action === 'EVIDENCE_DELETED'));

  const deniedNoteDelete = await store.deleteNote({
    personId: savedPerson.person.id,
    noteId: addedNote.note.id,
    actor: { id: 'test-investigator-1' }
  });
  assert.equal(deniedNoteDelete.ok, false);
  const noteDelete = await store.deleteNote({
    personId: savedPerson.person.id,
    noteId: addedNote.note.id,
    actor: { id: 'test-investigator-2' }
  });
  assert.equal(noteDelete.ok, true);
  const finalBoard = await refreshedStore.board(savedPerson.person.id);
  assert.equal(finalBoard.notes.length, 0);
  assert.ok(finalBoard.audit.some((item) => item.action === 'NOTE_DELETED'));

  const deletedPortrait = await store.deleteEvidence({
    personId: savedPerson.person.id,
    evidenceId: portrait.evidence.id,
    actor: { id: 'test-primary-chief', canManageAll: true }
  });
  assert.equal(deletedPortrait.ok, true);
  assert.equal((await refreshedStore.board(savedPerson.person.id)).evidence.length, 0);
  const deletedTimeline = await store.deleteTimelineEvent({
    personId: savedPerson.person.id,
    eventId: addedEvent.event.id,
    actor: { id: 'test-primary-chief', canManageAll: true }
  });
  assert.equal(deletedTimeline.ok, true);

  const stateStore = new PostgresStateStore(pool);
  const initialState = {
    cia_cases: [{
      id: 'CASE-RP-TEST-01',
      caseNumber: 'CASE-RP-TEST-01',
      title: 'قضية تمثيلية',
      description: 'تفاصيل اختبار',
      status: 'OPEN',
      finalDecision: ''
    }]
  };
  const loadedState = await stateStore.load({ initialState, normalizeState: (value) => value });
  loadedState.cia_cases[0].status = 'CLOSED';
  loadedState.cia_cases[0].finalDecision = 'قرار إغلاق تمثيلي';
  await stateStore.save(loadedState);
  const restoredState = await stateStore.load({ initialState: { cia_cases: [] }, normalizeState: (value) => value });
  assert.equal(restoredState.cia_cases[0].caseNumber, 'CASE-RP-TEST-01');
  assert.equal(restoredState.cia_cases[0].status, 'CLOSED');
  assert.equal(restoredState.cia_cases[0].finalDecision, 'قرار إغلاق تمثيلي');

  const deletedReport = await store.deletePerson({
    personId: savedPerson.person.id,
    actor: { id: 'test-primary-chief', canManageAll: true }
  });
  assert.equal(deletedReport.ok, true);
  assert.equal(await refreshedStore.get(savedPerson.person.id), null);
  assert.equal(await refreshedStore.board(savedPerson.person.id), null);
  for (const table of [
    'blackridge_wanted_evidence', 'blackridge_wanted_notes',
    'blackridge_wanted_timeline', 'blackridge_wanted_persons_audit'
  ]) {
    const result = await pool.query('SELECT COUNT(*)::int AS total FROM ' + table + ' WHERE person_id = $1', [savedPerson.person.id]);
    assert.equal(result.rows[0].total, 0, table + ' should be removed with its report');
  }
});
