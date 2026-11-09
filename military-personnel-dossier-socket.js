'use strict';

function reply(callback, result) {
  if (typeof callback === 'function') callback(result);
}

function failure(callback, message) {
  reply(callback, { ok: false, message });
}

function registerMilitaryPersonnelDossierSocket(socket, context = {}) {
  const getStore = typeof context.getStore === 'function' ? context.getStore : () => null;
  const getState = typeof context.getState === 'function' ? context.getState : () => ({ cia_users: [] });
  const requireUser = typeof context.requireUser === 'function' ? context.requireUser : () => null;
  const canViewPersonnel = typeof context.canViewPersonnel === 'function' ? context.canViewPersonnel : () => false;
  const isLeadership = typeof context.isLeadership === 'function' ? context.isLeadership : () => false;
  const canSeeNames = typeof context.canSeeNames === 'function' ? context.canSeeNames : () => false;
  const logger = typeof context.logger === 'function' ? context.logger : console.error;

  function sanitizeDossier(dossier, showNames) {
    return {
      notes: (dossier.notes || []).map((note) => ({
        id: note.id,
        body: note.body,
        authorName: showNames ? note.authorName : '',
        authorCode: note.authorCode,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt
      })),
      cases: (dossier.cases || []).map((item) => ({
        id: item.id,
        title: item.title,
        details: item.details,
        evidence: item.evidence,
        status: item.status,
        finalDecision: item.finalDecision,
        createdByName: showNames ? item.createdByName : '',
        createdByCode: item.createdByCode,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      })),
      timeline: (dossier.timeline || []).map((entry) => ({
        id: entry.id,
        type: entry.type,
        description: entry.description,
        eventAt: entry.eventAt,
        actorName: showNames ? entry.actorName : '',
        actorCode: entry.actorCode,
        createdAt: entry.createdAt
      })),
      attachments: (dossier.attachments || []).map((file) => ({
        id: file.id,
        caseId: file.caseId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: file.size,
        uploadedByName: showNames ? file.uploadedByName : '',
        uploadedByCode: file.uploadedByCode,
        createdAt: file.createdAt
      }))
    };
  }

  function sanitizeResult(result, showNames, property) {
    if (!result || result.ok !== true || !result[property]) return result;
    const item = result[property];
    const sanitized = property === 'note'
      ? { id: item.id, body: item.body, authorName: showNames ? item.authorName : '', authorCode: item.authorCode, createdAt: item.createdAt, updatedAt: item.updatedAt }
      : property === 'case'
        ? { id: item.id, title: item.title, details: item.details, evidence: item.evidence, status: item.status, finalDecision: item.finalDecision, createdByName: showNames ? item.createdByName : '', createdByCode: item.createdByCode, createdAt: item.createdAt, updatedAt: item.updatedAt }
        : { id: item.id, caseId: item.caseId, fileName: item.fileName, mimeType: item.mimeType, size: item.size, uploadedByName: showNames ? item.uploadedByName : '', uploadedByCode: item.uploadedByCode, createdAt: item.createdAt };
    return { ...result, [property]: sanitized };
  }

  function authorizePerson(personnelId, callback) {
    const actor = requireUser();
    if (!actor) {
      failure(callback, 'يجب تسجيل الدخول للخدمة أولاً.');
      return null;
    }
    const id = String(personnelId == null ? '' : personnelId).trim();
    const target = (getState().cia_users || []).find((person) => String(person.id) === id);
    if (!target || !canViewPersonnel(actor, target)) {
      failure(callback, 'الملف غير موجود أو لا تملك صلاحية الاطلاع عليه.');
      return null;
    }
    return { actor, target, personId: String(target.id), canWrite: isLeadership(actor) === true };
  }

  function requireStore(callback) {
    const store = getStore();
    if (!store) {
      failure(callback, 'خدمة الملفات العسكرية غير متاحة دون قاعدة بيانات PostgreSQL.');
      return null;
    }
    return store;
  }

  async function run(callback, operation) {
    try {
      const result = await operation();
      if (result !== null) reply(callback, result);
    } catch (error) {
      logger('[MPD] Dossier operation failed:', error && error.message || error);
      failure(callback, 'تعذر إتمام العملية أو حفظها في قاعدة البيانات. حاول مرة أخرى.');
    }
  }

  socket.on('mpd:dossier:get', (payload, callback) => run(callback, async () => {
    const access = authorizePerson(payload?.personnelId, callback);
    if (!access) return null;
    const store = requireStore(callback);
    if (!store) return null;
    const dossier = await store.getDossier(access.personId);
    if (!dossier) return { ok: false, message: 'تعذر تحميل الملف العسكري.' };
    return {
      ok: true,
      dossier: sanitizeDossier(dossier, canSeeNames(access.actor) === true),
      permissions: {
        canWrite: access.canWrite,
        canDelete: access.canWrite
      }
    };
  }));

  socket.on('mpd:note:create', (payload, callback) => run(callback, async () => {
    const access = authorizePerson(payload?.personnelId, callback);
    if (!access) return null;
    if (!access.canWrite) return { ok: false, message: 'إضافة الملاحظات متاحة للقيادة فقط.' };
    const store = requireStore(callback);
    if (!store) return null;
    const result = await store.createNote({ personId: access.personId, actor: access.actor, body: payload?.body });
    return sanitizeResult(result, canSeeNames(access.actor) === true, 'note');
  }));

  socket.on('mpd:note:update', (payload, callback) => run(callback, async () => {
    const access = authorizePerson(payload?.personnelId, callback);
    if (!access) return null;
    if (!access.canWrite) return { ok: false, message: 'تعديل الملاحظات متاح للقيادة فقط.' };
    const store = requireStore(callback);
    if (!store) return null;
    const result = await store.updateNote({ personId: access.personId, noteId: payload?.noteId, actor: access.actor, body: payload?.body });
    return sanitizeResult(result, canSeeNames(access.actor) === true, 'note');
  }));

  socket.on('mpd:note:delete', (payload, callback) => run(callback, async () => {
    const access = authorizePerson(payload?.personnelId, callback);
    if (!access) return null;
    if (!access.canWrite) return { ok: false, message: 'حذف الملاحظات متاح للقيادة فقط.' };
    const store = requireStore(callback);
    if (!store) return null;
    return store.deleteNote({ personId: access.personId, noteId: payload?.noteId, actor: access.actor });
  }));

  socket.on('mpd:case:create', (payload, callback) => run(callback, async () => {
    const access = authorizePerson(payload?.personnelId, callback);
    if (!access) return null;
    if (!access.canWrite) return { ok: false, message: 'إنشاء القضايا متاح للقيادة فقط.' };
    const store = requireStore(callback);
    if (!store) return null;
    const result = await store.createCase({ personId: access.personId, actor: access.actor, input: payload?.case || {} });
    return sanitizeResult(result, canSeeNames(access.actor) === true, 'case');
  }));

  socket.on('mpd:case:update', (payload, callback) => run(callback, async () => {
    const access = authorizePerson(payload?.personnelId, callback);
    if (!access) return null;
    if (!access.canWrite) return { ok: false, message: 'تعديل القضايا وقراراتها متاح للقيادة فقط.' };
    const store = requireStore(callback);
    if (!store) return null;
    const result = await store.updateCase({
      personId: access.personId,
      caseId: payload?.caseId,
      actor: access.actor,
      input: payload?.case || {}
    });
    return sanitizeResult(result, canSeeNames(access.actor) === true, 'case');
  }));

  socket.on('mpd:timeline:create', (payload, callback) => run(callback, async () => {
    const access = authorizePerson(payload?.personnelId, callback);
    if (!access) return null;
    if (!access.canWrite) return { ok: false, message: 'إضافة الإجراءات إلى السجل الزمني متاحة للقيادة فقط.' };
    const store = requireStore(callback);
    if (!store) return null;
    const result = await store.createTimelineEntry({
      personId: access.personId,
      actor: access.actor,
      type: payload?.type,
      description: payload?.description,
      eventAt: payload?.eventAt
    });
    if (!result || result.ok !== true || !result.entry) return result;
    const entry = result.entry;
    return {
      ...result,
      entry: {
        id: entry.id, type: entry.type, description: entry.description, eventAt: entry.eventAt,
        actorName: canSeeNames(access.actor) === true ? entry.actorName : '',
        actorCode: entry.actorCode, createdAt: entry.createdAt
      }
    };
  }));

  socket.on('mpd:attachment:upload', (payload, callback) => run(callback, async () => {
    const access = authorizePerson(payload?.personnelId, callback);
    if (!access) return null;
    if (!access.canWrite) return { ok: false, message: 'رفع المرفقات متاح للقيادة فقط.' };
    const store = requireStore(callback);
    if (!store) return null;
    const result = await store.uploadAttachment({
      personId: access.personId,
      caseId: payload?.caseId,
      actor: access.actor,
      fileName: payload?.fileName,
      mimeType: payload?.mimeType,
      bytes: payload?.bytes
    });
    return sanitizeResult(result, canSeeNames(access.actor) === true, 'attachment');
  }));

  socket.on('mpd:attachment:download', (payload, callback) => run(callback, async () => {
    const actor = requireUser();
    if (!actor) return { ok: false, message: 'يجب تسجيل الدخول للخدمة أولاً.' };
    const store = requireStore(callback);
    if (!store) return null;
    const attachment = await store.getAttachmentAccess(payload?.attachmentId);
    if (!attachment) return { ok: false, message: 'المرفق غير موجود.' };
    const access = authorizePerson(attachment.personnelId, callback);
    if (!access) return null;
    const result = await store.downloadAttachment({ attachmentId: attachment.id, actor });
    if (!result || result.ok !== true) return result;
    const file = result.attachment;
    return {
      ...result,
      attachment: {
        id: file.id, caseId: file.caseId, fileName: file.fileName, mimeType: file.mimeType,
        size: file.size, uploadedByName: canSeeNames(actor) === true ? file.uploadedByName : '',
        uploadedByCode: file.uploadedByCode, createdAt: file.createdAt
      }
    };
  }));

  socket.on('mpd:attachment:delete', (payload, callback) => run(callback, async () => {
    const actor = requireUser();
    if (!actor) return { ok: false, message: 'يجب تسجيل الدخول للخدمة أولاً.' };
    if (isLeadership(actor) !== true) return { ok: false, message: 'حذف المرفقات متاح للقيادة فقط.' };
    const store = requireStore(callback);
    if (!store) return null;
    const attachment = await store.getAttachmentAccess(payload?.attachmentId);
    if (!attachment) return { ok: false, message: 'المرفق غير موجود.' };
    const access = authorizePerson(attachment.personnelId, callback);
    if (!access) return null;
    return store.deleteAttachment({ attachmentId: attachment.id, actor });
  }));

  return socket;
}

module.exports = { registerMilitaryPersonnelDossierSocket };
