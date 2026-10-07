'use strict';

const WARNING_TYPES = Object.freeze(['سلوكي', 'ميداني', 'أمني', 'إداري', 'أخرى']);

function send(callback, result) {
  if (typeof callback === 'function') callback(result);
  return result;
}

function fail(callback, message) {
  return send(callback, { ok: false, message });
}

function text(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function warningView(row) {
  const metadata = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: row.id,
    warningId: metadata.warningId || row.relatedId || row.id,
    title: row.title,
    warningType: metadata.warningType || 'أخرى',
    content: metadata.warningContent || row.message || '',
    allowJustification: metadata.allowJustification === true,
    createdAt: row.createdAt,
    readAt: row.readAt || null
  };
}

function registerOfficialWarnings(socket, context) {
  const actor = () => context.getAuthenticatedUser();
  const store = () => context.getNotificationsStore();
  const users = () => context.getUsers() || [];
  const requireChief = (callback) => {
    const current = actor();
    if (!current) return { error: fail(callback, 'يجب تسجيل الدخول.') };
    if (!context.isChief(current)) return { error: fail(callback, 'إصدار التحذيرات الرسمية متاح للقائد فقط.') };
    return { current };
  };
  const eligible = (person) => !!person && person.suspended !== true && person.securityStatus === 'ACTIVE' &&
    person.approved !== false && person.serviceApproved !== false;

  socket.on('official-warning:people:list', (_payload, callback) => {
    const auth = requireChief(callback);
    if (auth.error) return auth.error;
    const people = users().filter((person) => person.id !== auth.current.id && eligible(person)).map((person) => ({
      id: text(person.id, 120),
      name: text(person.identity && person.identity.fullName || person.name, 120),
      publicCode: text(person.publicCode, 100),
      rank: context.normalizeRank(person.rank),
      rankLabel: context.rankLabel(person.rank),
      sector: text(person.sector || person.department || person.unitName || '', 120)
    }));
    return send(callback, { ok: true, people });
  });

  socket.on('official-warning:list', async (payload, callback) => {
    const current = actor();
    if (!current) return fail(callback, 'يجب تسجيل الدخول.');
    try {
      const result = await store().listForUser({
        userId: current.id,
        type: 'WARNING',
        limit: Math.max(1, Math.min(50, Number(payload && payload.limit) || 50)),
        offset: Math.max(0, Math.min(1000000, Number(payload && payload.offset) || 0))
      });
      return send(callback, { ok: true, warnings: result.rows.map(warningView), hasMore: result.hasMore });
    } catch (error) {
      return fail(callback, 'تعذر تحميل التحذيرات الرسمية.');
    }
  });

  socket.on('official-warning:responses:list', async (_payload, callback) => {
    const auth = requireChief(callback);
    if (auth.error) return auth.error;
    try {
      const result = await store().listForUser({ userId: auth.current.id, type: 'WARNING_RESPONSE', limit: 50, offset: 0 });
      const responses = result.rows.map((row) => {
        const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
        return {
          id: row.id,
          warningId: metadata.warningId || row.relatedId || '',
          response: metadata.responseText || row.message || '',
          warningType: metadata.warningType || '',
          sourceCode: row.sourceCode || '',
          sourceName: row.sourceUser && row.sourceUser.name || '',
          createdAt: row.createdAt
        };
      });
      return send(callback, { ok: true, responses });
    } catch (error) {
      return fail(callback, 'تعذر تحميل تبريرات التحذيرات.');
    }
  });

  socket.on('official-warning:create', async (payload, callback) => {
    const auth = requireChief(callback);
    if (auth.error) return auth.error;
    const warningType = text(payload && payload.warningType, 40);
    const content = text(payload && payload.content, 3000);
    const targetId = text(payload && payload.targetUserId, 120);
    if (!WARNING_TYPES.includes(warningType)) return fail(callback, 'اختر نوعًا صالحًا للتحذير.');
    if (content.length < 10) return fail(callback, 'اكتب تفاصيل التحذير (10 أحرف على الأقل).');
    const target = users().find((person) => person.id === targetId);
    if (!target || target.id === auth.current.id || !eligible(target)) return fail(callback, 'الشخص المحدد غير متاح لإصدار التحذير.');
    if (typeof context.publishNotifications !== 'function') return fail(callback, 'خدمة الإشعارات غير متاحة.');

    try {
      const warningId = context.makeId('WRN');
      const created = await context.publishNotifications([target], {
        type: 'WARNING',
        title: 'تحذير رسمي',
        message: content,
        priority: 'CRITICAL',
        targetUserId: target.id,
        sourceUserId: auth.current.id,
        relatedId: warningId,
        metadata: {
          warningId,
          warningType,
          warningContent: content,
          allowJustification: payload && payload.allowJustification === true,
          issuerId: auth.current.id,
          recipientCode: target.publicCode || ''
        }
      });
      if (!Array.isArray(created) || !created.length) return fail(callback, 'تعذر حفظ التحذير وإرساله.');
      return send(callback, { ok: true, warning: warningView(created[0]) });
    } catch (error) {
      return fail(callback, 'تعذر حفظ التحذير وإرساله.');
    }
  });

  socket.on('official-warning:respond', async (payload, callback) => {
    const current = actor();
    if (!current) return fail(callback, 'يجب تسجيل الدخول.');
    const warningId = text(payload && payload.warningId, 120);
    const responseText = text(payload && payload.response, 3000);
    if (!warningId || responseText.length < 5) return fail(callback, 'اكتب التبرير قبل الإرسال.');
    try {
      const warningResult = await store().listForUser({ userId: current.id, type: 'WARNING', search: warningId, limit: 50, offset: 0 });
      const warningRow = warningResult.rows.find((row) => row.relatedId === warningId || (row.metadata && row.metadata.warningId === warningId));
      if (!warningRow) return fail(callback, 'التحذير غير موجود أو لا تملك صلاحية الرد عليه.');
      const metadata = warningRow.metadata && typeof warningRow.metadata === 'object' ? warningRow.metadata : {};
      if (metadata.allowJustification !== true) return fail(callback, 'القائد منع التبرير لهذا التحذير.');
      const issuerId = text(metadata.issuerId || warningRow.sourceUserId, 120);
      const issuer = users().find((person) => person.id === issuerId);
      if (!issuer) return fail(callback, 'تعذر تحديد القائد الذي أصدر التحذير.');
      const existing = await store().listForUser({ userId: issuer.id, type: 'WARNING_RESPONSE', search: warningId, limit: 50, offset: 0 });
      if (existing.rows.some((row) => row.relatedId === warningId)) return fail(callback, 'تم إرسال تبرير لهذا التحذير مسبقًا.');
      const created = await context.publishNotifications([issuer], {
        type: 'WARNING_RESPONSE',
        title: 'تبرير لتحذير رسمي',
        message: responseText,
        priority: 'HIGH',
        targetUserId: issuer.id,
        sourceUserId: current.id,
        relatedId: warningId,
        metadata: {
          warningId,
          responseText,
          warningType: metadata.warningType || 'أخرى',
          recipientCode: current.publicCode || ''
        }
      });
      if (!Array.isArray(created) || !created.length) return fail(callback, 'تعذر حفظ التبرير وإرساله للقائد.');
      return send(callback, { ok: true, message: 'تم حفظ التبرير وإرساله للقائد.' });
    } catch (error) {
      return fail(callback, 'تعذر حفظ التبرير وإرساله للقائد.');
    }
  });
}

module.exports = { registerOfficialWarnings, WARNING_TYPES, warningView };
