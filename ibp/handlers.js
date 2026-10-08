'use strict';

const crypto = require('node:crypto');
const sessions = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;
const CLASSIFICATION_LEVEL = Object.freeze({ PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, SECRET: 3, 'TOP SECRET': 4 });
const STATUSES = new Set(['ACTIVE','ALERT','STANDBY','PLANNED','IN_PROGRESS','COMPLETE','CANCELLED','ARCHIVED']);

function registerIBPSocket(socket, ctx) {
  const state = () => ctx.getState();
  const user = () => ctx.requireSocketUser(socket);
  const reply = (cb, value) => { if (typeof cb === 'function') cb(value); return value; };
  const fail = (cb, message) => reply(cb, { ok: false, message });
  const clean = (value, max) => ctx.clean(value, max || 500);
  const code = (person) => clean(person && person.publicCode, 100).toUpperCase();
  const rank = (person) => ctx.rankLevel(person && person.rank);
  const senior = (person) => ctx.isChief(person) || ctx.isSenior(person);
  const leader = (person) => rank(person) >= 2;
  const units = () => Array.isArray(state().cia_battalions) ? state().cia_battalions : [];
  const records = (key) => Array.isArray(state()[key]) ? state()[key] : (state()[key] = []);
  const unitCodes = (unit) => [...new Set([...(Array.isArray(unit && unit.memberCodes) ? unit.memberCodes : []), unit && unit.commanderCode].map((x) => clean(x, 100).toUpperCase()).filter(Boolean))];
  function inUnitScope(person, unit) {
    if (!person || !unit) return false;
    if (senior(person)) return true;
    const own = code(person);
    if (!own) return false;
    const members = unitCodes(unit);
    if (members.includes(own)) return true;
    return rank(person) >= 2 && [unit.commanderCode, unit.seniorCommanderCode].some((x) => clean(x,100).toUpperCase() === own);
  }
  function scopedUnits(person) { return units().filter((unit) => unit.status !== 'ARCHIVED' && inUnitScope(person, unit)); }
  function canManageUnit(person, unit) { return !!person && !!unit && (senior(person) || (rank(person) >= 2 && inUnitScope(person, unit))); }
  function scopedUser(person, target) {
    if (!person || !target || target.suspended || target.approved === false || target.serviceApproved === false) return false;
    if (person.id === target.id) return true;
    if (senior(person)) return true;
    const ownUnits = scopedUnits(person);
    return ownUnits.some((unit) => unitCodes(unit).includes(code(target)));
  }
  function safePerson(person, viewer) {
    const self = person && viewer && person.id === viewer.id;
    const visibleName = ctx.isChief(viewer) || self;
    return {
      publicCode: person.publicCode, code: person.publicCode, rank: ctx.normalizeRank(person.rank), rankLabel: ctx.rankLabel(person.rank),
      name: visibleName ? (person.identity && person.identity.fullName || person.name || '') : '',
      status: person.status || (person.activeService ? 'ACTIVE' : 'STANDBY'), online: !!person.online,
      battalionCode: (units().find((unit) => unitCodes(unit).includes(code(person))) || {}).code || '',
      commanderCode: (units().find((unit) => unitCodes(unit).includes(code(person))) || {}).commanderCode || '',
      assignments: records('ibp_operations').filter((op) => (op.memberCodes || []).some((c) => clean(c,100).toUpperCase() === code(person)) && op.status !== 'COMPLETE' && op.status !== 'CANCELLED').map((op) => op.operationCode || op.id),
      history: records('cia_audit_logs').filter((event) => event.targetCode && clean(event.targetCode,100).toUpperCase() === code(person)).slice(0, 20).map((event) => ({ action: event.action || 'UPDATE', at: event.at || '', detail: event.details || '', actorCode: event.actorCode || '' }))
    };
  }
  function safeUnit(unit, viewer) {
    const commander = ctx.ibpResolveCode(unit.commanderCode);
    const visibleMembers = unitCodes(unit).map((memberCode) => ctx.ibpResolveCode(memberCode)).filter((person) => scopedUser(viewer, person));
    const mapPosition = unit.mapPosition && Number.isFinite(Number(unit.mapPosition.x)) && Number.isFinite(Number(unit.mapPosition.y)) ? { x: Number(unit.mapPosition.x), y: Number(unit.mapPosition.y) } : null;
    const result = {
      id: unit.id, code: unit.code || unit.id, name: unit.name || unit.nameAr || unit.nameEn || unit.code,
      nameAr: unit.nameAr || unit.name || '', nameEn: unit.nameEn || unit.name || '', sector: unit.sector || '',
      status: unit.status || 'ACTIVE', color: /^#[\da-f]{6}$/i.test(unit.color || '') ? unit.color : '#c7a25a',
      symbol: unit.symbol || 'UNIT', emblem: unit.emblem || unit.symbol || 'UNIT', commanderCode: unit.commanderCode || '',
      commanderName: ctx.isChief(viewer) && commander ? (commander.identity && commander.identity.fullName || commander.name || '') : '',
      deputyCode: unit.deputyCode || '', seniorCommanderCode: unit.seniorCommanderCode || '',
      memberCodes: visibleMembers.map((person) => person.publicCode), members: visibleMembers.map((person) => safePerson(person, viewer)),
      deploymentCount: records('ibp_deployments').filter((d) => String(d.battalionId) === String(unit.id) && d.status !== 'ARCHIVED').length,
      mapPosition, canManage: ctx.canManageIBPBattalions(viewer), notes: senior(viewer) ? (unit.notes || '') : '',
      history: senior(viewer) && Array.isArray(unit.history) ? unit.history.slice(-40) : []
    };
    return result;
  }
  function scopedOperations(person) {
    return records('ibp_operations').filter((op) => {
      const unit = units().find((item) => String(item.id) === String(op.battalionId));
      return (unit && inUnitScope(person, unit)) || (op.memberCodes || []).some((c) => clean(c,100).toUpperCase() === code(person)) || clean(op.commanderCode,100).toUpperCase() === code(person);
    });
  }
  function safeOperation(op, viewer) {
    const unit = units().find((item) => String(item.id) === String(op.battalionId));
    const members = (op.memberCodes || []).map((memberCode) => ctx.ibpResolveCode(memberCode)).filter((person) => scopedUser(viewer, person));
    return { id: op.id, operationCode: op.operationCode || op.id, name: op.name || op.title || op.operationCode, battalionId: op.battalionId || '', battalionCode: unit && (unit.code || unit.id) || '', commanderCode: op.commanderCode || '', memberCodes: members.map((person) => person.publicCode), status: op.status || 'PLANNED', priority: op.priority || 'NORMAL', startAt: op.startAt || '', endAt: op.endAt || '', position: op.position || null, notes: senior(viewer) || (op.memberCodes || []).some((c) => clean(c,100).toUpperCase() === code(viewer)) ? (op.notes || '') : '', history: Array.isArray(op.history) ? op.history.slice(-40) : [], createdAt: op.createdAt || '', updatedAt: op.updatedAt || '', canManage: leader(viewer) && !!unit && canManageUnit(viewer, unit) };
  }
  function visibleDeployments(person) {
    return records('ibp_deployments').filter((d) => {
      const unit = units().find((item) => String(item.id) === String(d.battalionId));
      return (unit && inUnitScope(person, unit)) || (d.assignedCodes || []).some((c) => clean(c,100).toUpperCase() === code(person));
    });
  }
  function safeDeployment(d, viewer) {
    const unit = units().find((item) => String(item.id) === String(d.battalionId));
    const assignedCodes = (d.assignedCodes || []).filter((c) => { const person = ctx.ibpResolveCode(c); return scopedUser(viewer, person); });
    const canManage = !!unit && leader(viewer) && canManageUnit(viewer);
    return { id: d.id, battalionId: d.battalionId, battalionCode: unit && (unit.code || unit.id) || '', title: d.title || '', type: d.type || '', status: d.status || 'ACTIVE', position: d.position || null, assignedCodes, notes: canManage ? (d.notes || '') : '', createdAt: d.createdAt || '', updatedAt: d.updatedAt || '', canManage };
  }
  function clearance(person) { return ctx.isChief(person) ? 4 : ctx.isSenior(person) ? 3 : Math.min(2, rank(person)); }
  function classificationAllowed(person, value) { return (CLASSIFICATION_LEVEL[String(value || 'INTERNAL').toUpperCase()] ?? 1) <= clearance(person); }
  function persist(actor, action, details, target, cb, payload = {}) {
    ctx.addAuditLog(action, actor, target || null, details || '');
    let pending;
    try { pending = ctx.saveState(); } catch (error) { pending = Promise.reject(error); }
    return Promise.resolve(pending).then(() => {
      ctx.emitState();
      return reply(cb, { ok: true, ...payload });
    }).catch((error) => {
      console.error('[IBP] State persistence failed:', error && error.message || error);
      return fail(cb, 'تعذر حفظ التغيير. تحقق من الاتصال ثم أعد المحاولة.');
    });
  }
  function gate(cb) { const actor = user(); return actor ? actor : (fail(cb, 'يجب تسجيل الدخول إلى IBP أولاً.'), null); }
  function pruneSessions() { const now = Date.now(); for (const [token, entry] of sessions) if (entry.expiresAt <= now) sessions.delete(token); }
  const PHASE2_EMBLEMS = new Set(['SHIELD', 'EAGLE', 'WOLF', 'LION', 'FALCON', 'STAR', 'SWORD', 'COMMAND', 'SPECIAL']);
  const PHASE2_STATUSES = new Set(['ACTIVE', 'ALERT', 'STANDBY']);
  function phase2CanView(person, unit) {
    return !!person && !!unit && (
      inUnitScope(person, unit) ||
      clean(unit.deputyCode, 100).toUpperCase() === code(person)
    );
  }
  function phase2CanManage(person, unit) {
    return !!person && !!unit && (
      (ctx.canManageIBPBattalions(person) && canManageUnit(person, unit)) ||
      (!!code(person) && clean(unit.commanderCode, 100).toUpperCase() === code(person))
    );
  }
  function phase2Point(value) {
    if (!value || typeof value !== 'object') return null;
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1000 || y < 0 || y > 700) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }
  function phase2Area(value) {
    if (!value || typeof value !== 'object') return null;
    const type = String(value.type || '').toUpperCase();
    if (type === 'CIRCLE') {
      const center = phase2Point(value.center);
      const radius = Number(value.radius);
      if (!center || !Number.isFinite(radius) || radius < 10 || radius > 500) return null;
      return { type, center, radius: Math.round(radius) };
    }
    if (type === 'POLYGON' && Array.isArray(value.points) && value.points.length >= 3 && value.points.length <= 60) {
      const points = value.points.map(phase2Point);
      if (points.some((point) => !point)) return null;
      return { type, points };
    }
    return null;
  }
  function phase2SafeUnit(unit, viewer) {
    const membersByCode = new Map();
    const linkedCodes = [...new Set([
      ...(Array.isArray(unit.memberCodes) ? unit.memberCodes : []),
      unit.commanderCode || '',
      unit.deputyCode || ''
    ].map((value) => clean(value, 100).toUpperCase()).filter(Boolean))];
    linkedCodes.forEach((memberCode) => {
      const person = ctx.ibpResolveCode(memberCode);
      if (person && (scopedUser(viewer, person) || clean(unit.deputyCode, 100).toUpperCase() === code(viewer))) {
        membersByCode.set(memberCode, safePerson(person, viewer));
      }
    });
    const commander = ctx.ibpResolveCode(unit.commanderCode);
    const deputy = ctx.ibpResolveCode(unit.deputyCode);
    const activeOperations = records('ibp_operations')
      .filter((item) => String(item.battalionId) === String(unit.id) && !['COMPLETE', 'CANCELLED', 'ARCHIVED'].includes(item.status))
      .slice(0, 1);
    const visibleReports = records('ibp_reports')
      .filter((item) => String(item.battalionId) === String(unit.id) && classificationAllowed(viewer, item.classification))
      .slice(0, 5)
      .map((item) => ({ id: item.id, title: clean(item.title, 140), classification: item.classification || 'INTERNAL', createdAt: item.createdAt || '' }));
    const movements = (Array.isArray(unit.movementHistory) ? unit.movementHistory : [])
      .map((item) => ({
        at: item.at || '',
        actorCode: clean(item.actorCode, 100),
        from: phase2Point(item.from),
        to: phase2Point(item.to),
        reason: clean(item.reason, 500)
      }));
    const lastMovement = unit.lastMovement && typeof unit.lastMovement === 'object'
      ? {
        at: unit.lastMovement.at || '',
        actorCode: clean(unit.lastMovement.actorCode, 100),
        from: phase2Point(unit.lastMovement.from),
        to: phase2Point(unit.lastMovement.to),
        reason: clean(unit.lastMovement.reason, 500)
      }
      : movements[movements.length - 1] || null;
    const base = safeUnit(unit, viewer);
    return {
      ...base,
      name: clean(unit.name || unit.nameAr || unit.nameEn || unit.code, 100),
      mapPosition: phase2Point(unit.mapPosition),
      color: /^#[\da-f]{6}$/i.test(unit.color || '') ? unit.color : '#c7a25a',
      emblem: PHASE2_EMBLEMS.has(String(unit.emblem || unit.symbol || '').toUpperCase()) ? String(unit.emblem || unit.symbol).toUpperCase() : 'SHIELD',
      description: clean(unit.description, 1000),
      radioChannel: clean(unit.radioChannel, 80),
      operationArea: phase2Area(unit.operationArea || unit.areaOfOperation),
      members: [...membersByCode.values()],
      memberCount: linkedCodes.length,
      onlineMembers: linkedCodes.reduce((sum, memberCode) => {
        const person = ctx.ibpResolveCode(memberCode);
        return sum + (person && person.online ? 1 : 0);
      }, 0),
      commanderName: commander ? safePerson(commander, viewer).name : '',
      deputyName: deputy ? safePerson(deputy, viewer).name : '',
      currentOperation: activeOperations[0] ? {
        name: clean(activeOperations[0].name || activeOperations[0].title || activeOperations[0].operationCode, 140),
        status: clean(activeOperations[0].status, 40),
        position: phase2Point(activeOperations[0].position)
      } : null,
      reports: visibleReports,
      lastMovement,
      movementHistory: movements,
      canManage: phase2CanManage(viewer, unit),
      canManageStructure: ctx.canManageIBPBattalions(viewer),
      updatedAt: unit.updatedAt || null
    };
  }
  function phase2PersonIsAssignable(person, unit) {
    if (!person || person.suspended || person.approved === false || person.serviceApproved === false) return false;
    return !units().some((other) => String(other.id) !== String(unit && unit.id || '') && other.status !== 'ARCHIVED' && [
      ...(Array.isArray(other.memberCodes) ? other.memberCodes : []),
      other.commanderCode || '',
      other.deputyCode || ''
    ].some((memberCode) => clean(memberCode, 100).toUpperCase() === code(person)));
  }
  const BATTALION_REPORT_TYPES = new Set([
    'PATROL REPORT', 'MOVEMENT REPORT', 'INCIDENT REPORT', 'OPERATION REPORT',
    'PERSONNEL REPORT', 'SECURITY REPORT', 'OTHER'
  ]);
  const BATTALION_REPORT_PRIORITIES = new Set(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']);
  const BATTALION_REPORT_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'CLOSED']);
  function battalionMemberCodes(unit) {
    return [...new Set([
      ...(Array.isArray(unit.memberCodes) ? unit.memberCodes : []),
      unit.commanderCode || '',
      unit.deputyCode || ''
    ].map((value) => clean(value, 100).toUpperCase()).filter(Boolean))];
  }
  function safeBattalionReport(report) {
    const author = ctx.ibpResolveCode(report.authorCode);
    const createdAt = report.createdAt || '';
    return {
      id: report.id,
      reportId: report.reportId || report.id,
      battalionId: report.battalionId,
      battalionCode: report.battalionCode || '',
      authorCode: report.authorCode || '',
      authorName: clean(report.authorName || author && (author.identity && author.identity.fullName || author.name), 160),
      type: report.type || 'OTHER',
      priority: report.priority || 'NORMAL',
      location: phase2Point(report.location),
      description: clean(report.description, 3000),
      createdAt,
      status: BATTALION_REPORT_STATUSES.has(String(report.status || '').toUpperCase()) ? String(report.status).toUpperCase() : 'OPEN'
    };
  }
  function battalionAttendanceRoster(unit) {
    const attendance = Array.isArray(state().cia_battalion_attendance) ? state().cia_battalion_attendance : [];
    const nowMs = Date.parse(ctx.now());
    return battalionMemberCodes(unit).map((memberCode) => {
      const person = ctx.ibpResolveCode(memberCode);
      if (!person) return null;
      const session = attendance.find((item) =>
        item.userId === person.id && String(item.battalionId) === String(unit.id) && item.status === 'ONLINE' && !item.logoutAt
      );
      const latest = attendance.find((item) =>
        item.userId === person.id && String(item.battalionId) === String(unit.id)
      );
      const started = Date.parse(session && session.loginAt || person.lastLoginAt || '');
      const elapsed = session && Number.isFinite(started) && Number.isFinite(nowMs) ? Math.max(0, nowMs - started) : null;
      return {
        publicCode: person.publicCode || memberCode,
        name: clean(person.identity && person.identity.fullName || person.name, 160),
        rank: ctx.normalizeRank(person.rank),
        battalionId: unit.id,
        battalionCode: unit.code || unit.id,
        loginAt: session && session.loginAt || person.lastLoginAt || '',
        logoutAt: person.online ? '' : latest && latest.logoutAt || person.lastLogoutAt || '',
        status: person.online ? 'ONLINE' : 'OFFLINE',
        lastSeenAt: person.lastSeenAt || latest && latest.lastSeenAt || person.lastLogoutAt || '',
        totalSessionMs: person.online ? elapsed : Number(latest && latest.durationMs || 0)
      };
    }).filter(Boolean);
  }
  function phase3Dashboard(unit, viewer) {
    const canManage = phase2CanManage(viewer, unit);
    const movementHistory = Array.isArray(unit.movementHistory) ? unit.movementHistory : [];
    const reportRows = records('cia_battalion_reports')
      .filter((report) => String(report.battalionId) === String(unit.id))
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      .map(safeBattalionReport);
    const operations = records('ibp_operations').filter((operation) =>
      String(operation.battalionId) === String(unit.id) &&
      !['COMPLETE', 'CANCELLED', 'ARCHIVED'].includes(String(operation.status || '').toUpperCase())
    );
    const today = String(ctx.now()).slice(0, 10);
    const todayAttendance = (Array.isArray(state().cia_battalion_attendance) ? state().cia_battalion_attendance : [])
      .filter((entry) => String(entry.battalionId) === String(unit.id) && String(entry.loginAt || '').slice(0, 10) === today);
    const attendance = canManage ? battalionAttendanceRoster(unit) : [];
    return {
      canManage,
      onlineCount: attendance.filter((entry) => entry.status === 'ONLINE').length,
      offlineCount: attendance.filter((entry) => entry.status === 'OFFLINE').length,
      todayAttendanceCount: new Set(todayAttendance.map((entry) => clean(entry.publicCode, 100).toUpperCase()).filter(Boolean)).size,
      activeOperations: operations.length,
      currentLocation: phase2Point(unit.mapPosition),
      currentArea: phase2Area(unit.operationArea || unit.areaOfOperation),
      recentMovements: movementHistory.slice(-5).reverse().map((item) => ({
        at: item.at || '',
        actorCode: clean(item.actorCode, 100),
        from: phase2Point(item.from),
        to: phase2Point(item.to),
        reason: clean(item.reason, 500)
      })),
      recentReports: reportRows.slice(0, 5),
      attendanceRoster: attendance
    };
  }
  function safeAttendanceHistory(entry) {
    const person = ctx.ibpResolveCode(entry.publicCode);
    const loginAt = entry.loginAt || '';
    const logoutAt = entry.logoutAt || '';
    const started = Date.parse(loginAt);
    const ended = logoutAt ? Date.parse(logoutAt) : Date.parse(ctx.now());
    const durationMs = entry.durationMs != null && Number.isFinite(Number(entry.durationMs))
      ? Number(entry.durationMs)
      : Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0;
    return {
      id: entry.id,
      publicCode: entry.publicCode || '',
      name: clean(entry.memberName || person && (person.identity && person.identity.fullName || person.name), 160),
      rank: clean(entry.rank || person && ctx.normalizeRank(person.rank), 80),
      battalionCode: entry.battalionCode || '',
      loginAt,
      logoutAt,
      lastSeenAt: entry.lastSeenAt || logoutAt || loginAt,
      status: entry.status === 'ONLINE' && !logoutAt ? 'ONLINE' : 'OFFLINE',
      durationMs
    };
  }

  socket.on('ibp:auth:issue', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    pruneSessions();
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: actor.id, expiresAt: Date.now() + SESSION_TTL });
    return reply(cb, { ok: true, token, expiresAt: new Date(Date.now() + SESSION_TTL).toISOString() });
  });
  socket.on('ibp:auth:resume', (payload, cb) => {
    pruneSessions();
    const token = clean(payload && payload.token, 128); const entry = sessions.get(token);
    const actor = entry && state().cia_users.find((person) => person.id === entry.userId);
    if (!actor || actor.suspended || actor.serviceApproved === false) { sessions.delete(token); return fail(cb, 'انتهت جلسة IBP. سجّل الدخول مجدداً.'); }
    ctx.markLogin(socket, actor, { resumeService: true });
    entry.expiresAt = Date.now() + SESSION_TTL;
    return reply(cb, { ok: true, user: ctx.publicUser(actor, actor), ibpSessionToken: token });
  });
  socket.on('ibp:auth:logout', (payload, cb) => {
    sessions.delete(clean(payload && payload.token, 128));
    if (user()) ctx.markLogout(socket);
    return reply(cb, { ok: true });
  });

  socket.on('ibp:overview:get', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const visibleUnits = scopedUnits(actor); const operations = scopedOperations(actor); const deployments = visibleDeployments(actor);
    const events = (records('cia_audit_logs') || []).filter((event) => senior(actor) || event.actorId === actor.id || event.targetId === actor.id || visibleUnits.some((unit) => unitCodes(unit).includes(clean(event.targetCode,100).toUpperCase()))).slice(0, 12).map((event) => ({ action: event.action, actorCode: event.actorCode || '', target: event.details || '', at: event.at || '' }));
    const intelligence = records('ibp_intelligence').filter((item) => classificationAllowed(actor, item.classification) && (!item.battalionId || visibleUnits.some((unit) => String(unit.id) === String(item.battalionId))));
    return reply(cb, { ok: true, counts: { battalions: visibleUnits.length, personnel: new Set(visibleUnits.flatMap(unitCodes).concat([code(actor)])).size, operations: operations.filter((op) => !['COMPLETE','CANCELLED','ARCHIVED'].includes(op.status)).length, alerts: visibleUnits.filter((unit) => unit.status === 'ALERT').length }, sectorStatus: 'ACTIVE', commandStatus: 'ONLINE', recentActivity: events, intelligenceSummary: intelligence[0] && intelligence[0].summary || '', permissions: { leadership: leader(actor), admin: senior(actor), create: leader(actor) } });
  });
  socket.on('ibp:map:get', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const visibleUnits = scopedUnits(actor); const visibleOps = scopedOperations(actor).filter((op) => op.status !== 'ARCHIVED'); const deployments = visibleDeployments(actor).filter((d) => d.status !== 'ARCHIVED');
    return reply(cb, { ok: true, battalions: visibleUnits.map((unit) => safeUnit(unit, actor)), deployments: deployments.map((item) => safeDeployment(item, actor)), operations: visibleOps.map((item) => safeOperation(item, actor)), canManage: visibleUnits.some((unit) => canManageUnit(actor,unit)), permissions: { map: true, place: visibleUnits.some((unit) => canManageUnit(actor,unit)) } });
  });
  socket.on('ibp:command:get', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const visibleUnits = scopedUnits(actor); const codes = new Set(visibleUnits.flatMap(unitCodes)); codes.add(code(actor));
    const commanders = state().cia_users.filter((person) => rank(person) >= 2 && (senior(actor) || codes.has(code(person)) || visibleUnits.some((unit) => [unit.commanderCode,unit.seniorCommanderCode].some((c) => clean(c,100).toUpperCase() === code(person))))).map((person) => safePerson(person, actor));
    return reply(cb, { ok: true, commanders, battalions: visibleUnits.map((unit) => safeUnit(unit, actor)) });
  });
  socket.on('ibp:personnel:list', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const people = state().cia_users.filter((person) => scopedUser(actor, person)).map((person) => safePerson(person, actor));
    return reply(cb, { ok: true, personnel: people, permissions: { viewNames: ctx.isChief(actor), manage: senior(actor) } });
  });
  socket.on('ibp:deployments:list', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const visibleUnits = scopedUnits(actor);
    const assignablePersonnel = visibleUnits.flatMap(unitCodes).map((c) => ctx.ibpResolveCode(c)).filter(Boolean).map((person) => safePerson(person, actor));
    return reply(cb, { ok: true, deployments: visibleDeployments(actor).map((item) => safeDeployment(item, actor)), battalions: visibleUnits.map((unit) => safeUnit(unit, actor)), assignablePersonnel, canCreate: leader(actor) });
  });
  socket.on('ibp:operations:list', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const visibleUnits = scopedUnits(actor); const assignablePersonnel = visibleUnits.flatMap(unitCodes).map((c) => ctx.ibpResolveCode(c)).filter(Boolean).map((person) => safePerson(person, actor));
    return reply(cb, { ok: true, operations: scopedOperations(actor).map((item) => safeOperation(item, actor)), battalions: visibleUnits.map((unit) => safeUnit(unit, actor)), assignablePersonnel, canCreate: leader(actor) });
  });
  socket.on('ibp:intelligence:list', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const visibleUnits = scopedUnits(actor);
    const items = records('ibp_intelligence').filter((item) => classificationAllowed(actor,item.classification) && (!item.battalionId || visibleUnits.some((unit) => String(unit.id) === String(item.battalionId)))).slice(0,300);
    return reply(cb, { ok: true, items, battalions: visibleUnits.map((unit) => safeUnit(unit, actor)), canCreate: leader(actor) });
  });
  socket.on('ibp:archive:list', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const visibleUnits = units().filter((unit) => unit.status === 'ARCHIVED' && inUnitScope(actor, unit));
    const visibleOps = scopedOperations(actor).filter((op) => ['ARCHIVED','CANCELLED','COMPLETE'].includes(op.status));
    const reports = records('ibp_reports').filter((item) => classificationAllowed(actor,item.classification) && (!item.battalionId || scopedUnits(actor).some((unit) => String(unit.id) === String(item.battalionId))) && item.status === 'ARCHIVED');
    return reply(cb, { ok: true, battalions: visibleUnits.map((unit) => safeUnit(unit,actor)), operations: visibleOps.map((op) => safeOperation(op,actor)), reports });
  });
  socket.on('ibp:blackbox:list', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const own = code(actor); const visibleUnits = scopedUnits(actor); const visibleCodes = new Set(visibleUnits.flatMap(unitCodes).concat([own]));
    const events = records('cia_audit_logs').filter((event) => senior(actor) || event.actorId === actor.id || event.targetId === actor.id || visibleCodes.has(clean(event.targetCode,100).toUpperCase())).slice(0,300).map((event) => ({ id: event.id, at: event.at || '', actorCode: event.actorCode || '', actor: ctx.isChief(actor) ? (event.actorName || event.actorCode || '') : (event.actorCode || ''), action: event.action || '', target: ctx.isChief(actor) ? (event.targetName || event.targetCode || '') : (event.targetCode || ''), detail: event.details || '', result: 'RECORDED' }));
    return reply(cb, { ok: true, events });
  });
  socket.on('ibp:reports:list', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const visibleUnits = scopedUnits(actor);
    const reports = records('ibp_reports').filter((item) => classificationAllowed(actor,item.classification) && (!item.battalionId || visibleUnits.some((unit) => String(unit.id) === String(item.battalionId)) || item.authorCode === actor.publicCode)).slice(0,300);
    return reply(cb, { ok: true, reports, battalions: visibleUnits.map((unit) => safeUnit(unit, actor)), canCreate: true });
  });
  socket.on('ibp:access:get', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const level = rank(actor); const role = ctx.rankLabel(actor.rank); const effective = [
      { key: 'view_sector', name: 'Sector overview', allowed: true },
      { key: 'view_units', name: 'Assigned battalions', allowed: scopedUnits(actor).length > 0 },
      { key: 'view_personnel', name: 'Scoped personnel', allowed: true },
      { key: 'manage_units', name: 'Create or change battalions', allowed: ctx.canManageIBPBattalions(actor) },
      { key: 'manage_operations', name: 'Create or change operations', allowed: leader(actor) },
      { key: 'classified_intelligence', name: 'Confidential intelligence', allowed: clearance(actor) >= 2 },
      { key: 'audit', name: 'Blackbox audit', allowed: senior(actor) }
    ];
    const roles = [
      { role: 'AGENT', scope: 'Self and assigned unit', battalions: 'View scoped', operations: 'Assigned records', audit: 'Own activity' },
      { role: 'HIGH COMMANDER', scope: 'Command-linked units', battalions: 'Scoped management', operations: 'Scoped management', audit: 'Scoped' },
      { role: 'SENIOR COMMANDER', scope: 'Sector-wide', battalions: 'Manage', operations: 'Manage', audit: 'Sector-wide' },
      { role: 'CIA CHIEF', scope: 'Sector-wide', battalions: 'Manage', operations: 'Manage', audit: 'Sector-wide' }
    ];
    return reply(cb, { ok: true, roleLabel: role, scopeDescription: senior(actor) ? 'Sector-wide authorized scope.' : level >= 2 ? 'Command-linked units and operations.' : 'Personal and assigned-unit records only.', effective, roles });
  });

  socket.on('ibp:phase2:list', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const battalions = units()
      .filter((unit) => unit.status !== 'ARCHIVED' && phase2CanView(actor, unit))
      .map((unit) => phase2SafeUnit(unit, actor));
    return reply(cb, {
      ok: true,
      battalions,
      canCreate: ctx.canManageIBPBattalions(actor),
      permissions: { view: true, create: ctx.canManageIBPBattalions(actor), sectorWide: senior(actor) }
    });
  });
  socket.on('ibp:phase3:dashboard', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const visibleUnits = units().filter((unit) => unit.status !== 'ARCHIVED' && phase2CanView(actor, unit));
    const battalions = visibleUnits.map((unit) => ({
      ...phase2SafeUnit(unit, actor),
      dashboard: phase3Dashboard(unit, actor)
    }));
    const visibleIds = new Set(visibleUnits.map((unit) => String(unit.id)));
    const reports = records('cia_battalion_reports')
      .filter((report) => visibleIds.has(String(report.battalionId)))
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      .map(safeBattalionReport);
    return reply(cb, {
      ok: true,
      battalions,
      reports,
      canCreate: ctx.canManageIBPBattalions(actor),
      permissions: { view: true, create: ctx.canManageIBPBattalions(actor), sectorWide: senior(actor) }
    });
  });
  socket.on('ibp:phase3:attendance:history', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const battalion = units().find((unit) => String(unit.id) === String(payload && payload.battalionId));
    if (!battalion || !phase2CanManage(actor, battalion)) return fail(cb, 'لا تملك صلاحية عرض سجل حضور هذه الكتيبة.');
    const fromDate = clean(payload && payload.fromDate, 10);
    const toDate = clean(payload && payload.toDate, 10);
    const validDate = (value) => {
      if (!value) return true;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const [year, month, day] = value.split('-').map(Number);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
    };
    if (!validDate(fromDate) || !validDate(toDate) || (fromDate && toDate && fromDate > toDate)) {
      return fail(cb, 'نطاق التاريخ غير صالح.');
    }
    const rows = (Array.isArray(state().cia_battalion_attendance) ? state().cia_battalion_attendance : [])
      .filter((entry) => {
        if (String(entry.battalionId) !== String(battalion.id)) return false;
        const day = String(entry.loginAt || '').slice(0, 10);
        return (!fromDate || day >= fromDate) && (!toDate || day <= toDate);
      })
      .sort((left, right) => String(right.loginAt || '').localeCompare(String(left.loginAt || '')))
      .map(safeAttendanceHistory);
    return reply(cb, { ok: true, attendance: rows });
  });
  socket.on('ibp:phase3:report:create', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const battalion = units().find((unit) => String(unit.id) === String(payload && payload.battalionId));
    if (!battalion || battalion.status === 'ARCHIVED' || !phase2CanManage(actor, battalion)) {
      return fail(cb, 'إنشاء التقارير متاح لقائد الكتيبة والقيادة المخولة فقط.');
    }
    const type = clean(payload && payload.type, 40).toUpperCase();
    const priority = clean(payload && payload.priority, 20).toUpperCase();
    const status = clean(payload && payload.status, 20).toUpperCase() || 'OPEN';
    const description = clean(payload && payload.description, 3000);
    const suppliedLocation = payload && payload.location;
    const location = suppliedLocation ? phase2Point(suppliedLocation) : null;
    if (!BATTALION_REPORT_TYPES.has(type) || !BATTALION_REPORT_PRIORITIES.has(priority) ||
        !BATTALION_REPORT_STATUSES.has(status) || !description || (suppliedLocation && !location)) {
      return fail(cb, 'تحقق من نوع التقرير وأولويته وحالته ووصفه وموقعه.');
    }
    const at = ctx.now();
    const reportId = ctx.makeId('BTR');
    const report = {
      id: reportId,
      reportId,
      battalionId: battalion.id,
      battalionCode: battalion.code || battalion.id,
      authorCode: actor.publicCode || '',
      authorName: clean(actor.identity && actor.identity.fullName || actor.name, 160),
      type,
      priority,
      location,
      description,
      createdAt: at,
      status
    };
    records('cia_battalion_reports').unshift(report);
    return persist(actor, 'إنشاء تقرير كتيبة', report.reportId + ' · ' + report.type, null, cb, { report: safeBattalionReport(report) });
  });
  socket.on('ibp:phase2:create', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    if (!ctx.canManageIBPBattalions(actor)) return fail(cb, 'إنشاء الكتائب غير متاح ضمن نطاق صلاحيتك.');
    const codeValue = clean(payload && payload.code, 32).toUpperCase().replace(/\s+/g, '-');
    const name = clean(payload && payload.name, 100);
    const sector = clean(payload && payload.sector, 100);
    if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(codeValue) || !name || !sector) {
      return fail(cb, 'أدخل اسم الكتيبة ورمزًا فريدًا والقطاع.');
    }
    if (units().some((unit) => String(unit.code || '').toUpperCase() === codeValue)) return fail(cb, 'رمز الكتيبة مستخدم بالفعل.');
    const commander = ctx.ibpResolveCode(payload && payload.commanderCode);
    const deputy = payload && payload.deputyCode ? ctx.ibpResolveCode(payload.deputyCode) : null;
    if (!commander || !phase2PersonIsAssignable(commander, null)) return fail(cb, 'اختر قائدًا معتمدًا غير معيّن في كتيبة أخرى.');
    if (payload && payload.deputyCode && (!deputy || deputy.id === commander.id || !phase2PersonIsAssignable(deputy, null))) {
      return fail(cb, 'اختر نائبًا معتمدًا غير القائد وغير معيّن في كتيبة أخرى.');
    }
    const color = /^#[\da-f]{6}$/i.test(payload && payload.color || '') ? payload.color : '#c7a25a';
    const emblem = String(payload && payload.emblem || 'SHIELD').toUpperCase();
    if (!PHASE2_EMBLEMS.has(emblem)) return fail(cb, 'الشعار المختار غير معتمد.');
    const requestedMembers = Array.isArray(payload && payload.memberCodes)
      ? payload.memberCodes
      : String(payload && payload.memberCodes || '').split(/[\s,;]+/).filter(Boolean);
    const memberCodes = new Map([[code(commander), commander.publicCode]]);
    if (deputy) memberCodes.set(code(deputy), deputy.publicCode);
    for (const value of requestedMembers) {
      const person = ctx.ibpResolveCode(value);
      if (!person || !phase2PersonIsAssignable(person, null)) return fail(cb, 'تأكد أن كل فرد معتمد وغير معيّن في كتيبة أخرى.');
      memberCodes.set(code(person), person.publicCode);
    }
    const at = ctx.now();
    const battalion = {
      id: ctx.makeId('BAT'),
      code: codeValue,
      name,
      nameAr: name,
      nameEn: name,
      sector,
      status: PHASE2_STATUSES.has(String(payload && payload.status || '').toUpperCase()) ? String(payload.status).toUpperCase() : 'ACTIVE',
      color,
      symbol: emblem,
      emblem,
      commanderCode: commander.publicCode,
      deputyCode: deputy ? deputy.publicCode : '',
      memberCodes: [...memberCodes.values()],
      description: clean(payload && payload.description, 1000),
      radioChannel: clean(payload && payload.radioChannel, 80),
      mapPosition: null,
      operationArea: null,
      movementHistory: [],
      history: [],
      createdAt: at,
      createdByCode: actor.publicCode || '',
      updatedAt: at,
      updatedByCode: actor.publicCode || ''
    };
    records('cia_battalions').unshift(battalion);
    return persist(actor, 'إنشاء كتيبة', codeValue + ' · ' + name, null, cb, { battalion: phase2SafeUnit(battalion, actor) });
  });
  socket.on('ibp:phase2:update', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const battalion = units().find((unit) => String(unit.id) === String(payload && payload.battalionId));
    if (!battalion || battalion.status === 'ARCHIVED' || !phase2CanManage(actor, battalion)) return fail(cb, 'لا تملك صلاحية إدارة هذه الكتيبة.');
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'name')) {
      const name = clean(payload.name, 100);
      if (!name) return fail(cb, 'اسم الكتيبة مطلوب.');
      patch.name = name; patch.nameAr = name; patch.nameEn = name;
    }
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'color')) {
      if (!/^#[\da-f]{6}$/i.test(String(payload.color || ''))) return fail(cb, 'لون الكتيبة غير صالح.');
      patch.color = payload.color;
    }
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'emblem')) {
      const emblem = String(payload.emblem || '').toUpperCase();
      if (!PHASE2_EMBLEMS.has(emblem)) return fail(cb, 'الشعار المختار غير معتمد.');
      patch.emblem = emblem; patch.symbol = emblem;
    }
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'description')) patch.description = clean(payload.description, 1000);
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'radioChannel')) patch.radioChannel = clean(payload.radioChannel, 80);
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'status')) {
      const status = String(payload.status || '').toUpperCase();
      if (!PHASE2_STATUSES.has(status)) return fail(cb, 'حالة الكتيبة غير صالحة.');
      patch.status = status;
    }
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'memberCodes')) {
      const requested = (Array.isArray(payload.memberCodes) ? payload.memberCodes : String(payload.memberCodes || '').split(/[\s,;]+/))
        .filter((memberCode) => !!clean(memberCode, 100));
      const nextMembers = new Map();
      const preservedCodes = (Array.isArray(battalion.memberCodes) ? battalion.memberCodes : []).filter((memberCode) => {
        const person = ctx.ibpResolveCode(memberCode);
        return !!clean(memberCode, 100) && (!person || person.suspended || person.approved === false || person.serviceApproved === false);
      });
      for (const memberCode of preservedCodes) nextMembers.set(clean(memberCode, 100).toUpperCase(), memberCode);
      for (const value of requested) {
        const person = ctx.ibpResolveCode(value);
        if (!person || !phase2PersonIsAssignable(person, battalion)) return fail(cb, 'تأكد أن كل فرد معتمد وغير معيّن في كتيبة أخرى.');
        nextMembers.set(code(person), person.publicCode);
      }
      for (const leaderCode of [battalion.commanderCode, battalion.deputyCode]) {
        const person = ctx.ibpResolveCode(leaderCode);
        if (person) nextMembers.set(code(person), person.publicCode);
      }
      patch.memberCodes = [...nextMembers.values()];
    }
    Object.assign(battalion, patch);
    battalion.updatedAt = ctx.now();
    battalion.updatedByCode = actor.publicCode || '';
    return persist(actor, 'تعديل بيانات كتيبة', (battalion.code || battalion.id) + ' · ' + (actor.publicCode || ''), null, cb, { battalion: phase2SafeUnit(battalion, actor) });
  });
  socket.on('ibp:phase2:location', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const battalion = units().find((unit) => String(unit.id) === String(payload && payload.battalionId));
    const position = phase2Point(payload && (payload.position || payload));
    const reason = clean(payload && payload.reason, 500);
    if (!battalion || battalion.status === 'ARCHIVED' || !phase2CanManage(actor, battalion)) return fail(cb, 'لا تملك صلاحية نقل هذه الكتيبة.');
    if (!position) return fail(cb, 'إحداثيات الموقع غير صالحة.');
    if (!reason) return fail(cb, 'أدخل سبب نقل الكتيبة.');
    const at = ctx.now();
    const movement = { at, actorCode: actor.publicCode || '', from: phase2Point(battalion.mapPosition), to: position, reason };
    battalion.movementHistory = [...(Array.isArray(battalion.movementHistory) ? battalion.movementHistory : []), movement];
    battalion.lastMovement = movement;
    battalion.mapPosition = position;
    battalion.updatedAt = at;
    battalion.updatedByCode = actor.publicCode || '';
    return persist(actor, 'نقل موقع كتيبة', (battalion.code || battalion.id) + ' · ' + position.x + ',' + position.y + ' · ' + reason, null, cb, { battalion: phase2SafeUnit(battalion, actor) });
  });
  socket.on('ibp:phase2:area', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const battalion = units().find((unit) => String(unit.id) === String(payload && payload.battalionId));
    if (!battalion || battalion.status === 'ARCHIVED' || !phase2CanManage(actor, battalion)) return fail(cb, 'لا تملك صلاحية تعديل منطقة انتشار هذه الكتيبة.');
    let area = null;
    if (!(payload && payload.clear === true)) {
      area = phase2Area(payload);
      if (!area) return fail(cb, 'تعذر حفظ المنطقة. تحقق من النوع ونقاط الرسم أو نصف القطر.');
    }
    battalion.operationArea = area;
    battalion.updatedAt = ctx.now();
    battalion.updatedByCode = actor.publicCode || '';
    return persist(actor, area ? 'تحديث منطقة انتشار كتيبة' : 'مسح منطقة انتشار كتيبة', (battalion.code || battalion.id), null, cb, { battalion: phase2SafeUnit(battalion, actor) });
  });

  socket.on('ibp:battalion:transfer', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    if (!ctx.canManageIBPBattalions(actor)) return fail(cb, 'نقل الأفراد متاح للقيادة العليا فقط.');
    const from = units().find((unit) => String(unit.id) === String(payload && payload.fromBattalionId)); const to = units().find((unit) => String(unit.id) === String(payload && payload.toBattalionId));
    const member = ctx.ibpResolveCode(payload && payload.publicCode);
    if (!from || !to || from === to || !canManageUnit(actor,from) || !canManageUnit(actor,to)) return fail(cb, 'تعذر التحقق من الكتيبتين ضمن نطاقك.');
    if (!member || !unitCodes(from).includes(code(member)) || member.suspended || member.approved === false) return fail(cb, 'الفرد غير موجود في الكتيبة المصدر أو غير معتمد.');
    if (unitCodes(to).includes(code(member))) return fail(cb, 'الفرد معيّن بالفعل في الكتيبة المستهدفة.');
    from.memberCodes = (from.memberCodes || []).filter((c) => clean(c,100).toUpperCase() !== code(member));
    to.memberCodes = [...new Set([...(to.memberCodes || []), member.publicCode])];
    const at = ctx.now(); from.updatedAt = at; to.updatedAt = at;
    return persist(actor,'نقل فرد بين الكتائب',member.publicCode+' من '+(from.code||from.id)+' إلى '+(to.code||to.id),member,cb);
  });
  socket.on('ibp:battalion:archive', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const unit = units().find((item) => String(item.id) === String(payload && payload.id));
    if (!unit || !ctx.canManageIBPBattalions(actor) || !canManageUnit(actor,unit)) return fail(cb,'لا تملك صلاحية أرشفة هذه الكتيبة.');
    unit.status='ARCHIVED'; unit.archivedAt=ctx.now(); unit.updatedAt=unit.archivedAt;
    return persist(actor,'أرشفة كتيبة',(unit.code||unit.id)+' · ARCHIVED',null,cb);
  });
  socket.on('ibp:battalion:position', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    const unit = units().find((item) => String(item.id) === String(payload && payload.battalionId));
    const x=Number(payload && payload.x), y=Number(payload && payload.y);
    if (!unit || !leader(actor) || !canManageUnit(actor,unit)) return fail(cb,'لا تملك صلاحية تعديل موقع هذه الكتيبة.');
    if (!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1000||y<0||y>700) return fail(cb,'إحداثيات الخريطة غير صالحة.');
    unit.mapPosition={x:Math.round(x),y:Math.round(y)}; unit.updatedAt=ctx.now();
    return persist(actor,'تحديث موقع كتيبة',(unit.code||unit.id)+' · '+x+','+y,null,cb,{battalion:safeUnit(unit,actor)});
  });
  socket.on('ibp:deployment:save', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    if (!leader(actor)) return fail(cb,'إنشاء الانتشار متاح للقيادات فقط.');
    const id=clean(payload && payload.id,120); const row=records('ibp_deployments').find((item)=>String(item.id)===id); const unit=units().find((item)=>String(item.id)===String(payload && payload.battalionId));
    const title=clean(payload && payload.title,120); const x=Number(payload && payload.x),y=Number(payload && payload.y);
    if (!unit||!canManageUnit(actor,unit)||!title) return fail(cb,'اختر كتيبة ضمن نطاقك وأدخل اسم الانتشار.');
    if (row && (!row.battalionId||String(row.battalionId)!==String(unit.id)||!canManageUnit(actor,units().find((u)=>String(u.id)===String(row.battalionId))))) return fail(cb,'لا تملك صلاحية تعديل هذا الانتشار.');
    if ((payload && payload.x!=='' || payload && payload.y!=='')&&(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1000||y<0||y>700)) return fail(cb,'إحداثيات الانتشار غير صالحة.');
    const allowedCodes=new Set(unitCodes(unit)); const assignedCodes=[...new Set((Array.isArray(payload && payload.assignedCodes)?payload.assignedCodes:[]).map((c)=>ctx.ibpResolveCode(c)).filter((p)=>p&&allowedCodes.has(code(p))).map((p)=>p.publicCode))];
    const record={...(row||{}),id:row?row.id:ctx.makeId('DEP'),battalionId:unit.id,title,type:clean(payload && payload.type,80),status:STATUSES.has(payload && payload.status)?payload.status:'ACTIVE',position:Number.isFinite(x)&&Number.isFinite(y)?{x:Math.round(x),y:Math.round(y)}:null,assignedCodes,notes:clean(payload && payload.notes,1000),createdAt:row && row.createdAt||ctx.now(),updatedAt:ctx.now(),createdByCode:row && row.createdByCode||actor.publicCode};
    const list=records('ibp_deployments'); if(row)list[list.indexOf(row)]=record;else list.unshift(record);
    return persist(actor,row?'تحديث انتشار':'إنشاء انتشار',record.title+' · '+(unit.code||unit.id),null,cb,{deployment:safeDeployment(record,actor)});
  });
  socket.on('ibp:operation:save', (payload, cb) => {
    const actor = gate(cb); if (!actor) return;
    if (!leader(actor)) return fail(cb,'إنشاء العمليات متاح للقيادات فقط.');
    const id=clean(payload && payload.id,120); const row=records('ibp_operations').find((item)=>String(item.id)===id); const unit=units().find((item)=>String(item.id)===String(payload && payload.battalionId));
    const name=clean(payload && payload.name,120); if(!unit||!canManageUnit(actor,unit)||!name)return fail(cb,'اختر كتيبة ضمن نطاقك وأدخل اسم العملية.');
    if(row&&(!units().some((u)=>String(u.id)===String(row.battalionId)&&canManageUnit(actor,u))))return fail(cb,'لا تملك صلاحية تعديل هذه العملية.');
    const status=STATUSES.has(payload && payload.status)?payload.status:'PLANNED'; const priority=['LOW','NORMAL','HIGH','CRITICAL'].includes(String(payload && payload.priority).toUpperCase())?String(payload.priority).toUpperCase():'NORMAL';
    const commander=ctx.ibpResolveCode(payload && payload.commanderCode); if(payload && payload.commanderCode&&(!commander||!unitCodes(unit).includes(code(commander))))return fail(cb,'قائد العملية يجب أن يكون من أفراد الكتيبة.');
    const allowedCodes=new Set(unitCodes(unit));const members=[...new Set((Array.isArray(payload && payload.memberCodes)?payload.memberCodes:[]).map((c)=>ctx.ibpResolveCode(c)).filter((p)=>p&&allowedCodes.has(code(p))).map((p)=>p.publicCode))];
    const x=Number(payload && payload.x),y=Number(payload && payload.y); if((payload && payload.x!==''||payload && payload.y!=='')&&(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1000||y<0||y>700))return fail(cb,'إحداثيات العملية غير صالحة.');
    const at=ctx.now();const history=Array.isArray(row&&row.history)?row.history.slice(-39):[];history.push({action:row?'تحديث عملية':'إنشاء عملية',actorCode:actor.publicCode||'',at,detail:name+' · '+(unit.code||unit.id)});const record={...(row||{}),id:row?row.id:ctx.makeId('OP'),operationCode:row && row.operationCode||ctx.makeId('IBP-OP'),name,battalionId:unit.id,commanderCode:commander&&commander.publicCode||'',memberCodes:members,status,priority,startAt:clean(payload && payload.startAt,40),endAt:clean(payload && payload.endAt,40),position:Number.isFinite(x)&&Number.isFinite(y)?{x:Math.round(x),y:Math.round(y)}:null,notes:clean(payload && payload.notes,2000),history,createdAt:row&&row.createdAt||at,updatedAt:at,createdByCode:row&&row.createdByCode||actor.publicCode};
    const list=records('ibp_operations'); if(row)list[list.indexOf(row)]=record;else list.unshift(record);
    return persist(actor,row?'تحديث عملية':'إنشاء عملية',record.name+' · '+(unit.code||unit.id),null,cb,{operation:safeOperation(record,actor)});
  });
  socket.on('ibp:report:create', (payload, cb) => {
    const actor=gate(cb);if(!actor)return;const title=clean(payload&&payload.title,140), text=clean(payload&&payload.text,5000), summary=clean(payload&&payload.summary,500);
    if(!title||(!summary&&!text))return fail(cb,'أدخل عنوان التقرير ومحتواه.');
    const unit=payload&&payload.battalionId?units().find((u)=>String(u.id)===String(payload.battalionId)):null;
    if(payload&&payload.battalionId&&(!unit||!inUnitScope(actor,unit)))return fail(cb,'لا تملك صلاحية ربط التقرير بهذه الكتيبة.');
    const classification=String(payload&&payload.classification||'INTERNAL').toUpperCase();if(!Object.prototype.hasOwnProperty.call(CLASSIFICATION_LEVEL,classification)||!classificationAllowed(actor,classification))return fail(cb,'لا تملك صلاحية استخدام هذا التصنيف.');
    const report={id:ctx.makeId('RPT'),title,type:clean(payload&&payload.type,50)||'SECTOR',battalionId:unit&&unit.id||'',battalionCode:unit&&unit.code||'',classification,summary,text,status:'SUBMITTED',authorCode:actor.publicCode,createdAt:ctx.now()};
    records('ibp_reports').unshift(report);records('ibp_reports').splice(500);return persist(actor,'إنشاء تقرير',title,null,cb,{report});
  });
  socket.on('ibp:intelligence:create', (payload, cb) => {
    const actor=gate(cb);if(!actor)return;if(!leader(actor))return fail(cb,'نشر الموجزات متاح للقيادات فقط.');
    const title=clean(payload&&payload.title,140),summary=clean(payload&&payload.summary,1800);if(!title||!summary)return fail(cb,'أدخل عنوان الموجز وملخصه.');
    const unit=payload&&payload.battalionId?units().find((u)=>String(u.id)===String(payload.battalionId)):null;if(payload&&payload.battalionId&&(!unit||!canManageUnit(actor,unit)))return fail(cb,'لا تملك صلاحية ربط الموجز بهذه الكتيبة.');
    const classification=String(payload&&payload.classification||'INTERNAL').toUpperCase();if(!Object.prototype.hasOwnProperty.call(CLASSIFICATION_LEVEL,classification)||!classificationAllowed(actor,classification))return fail(cb,'لا تملك صلاحية هذا التصنيف.');
    const item={id:ctx.makeId('INT'),title,type:clean(payload&&payload.type,80)||'INTELLIGENCE',classification,battalionId:unit&&unit.id||'',battalionCode:unit&&unit.code||'',summary,authorCode:actor.publicCode,createdAt:ctx.now(),at:ctx.now()};records('ibp_intelligence').unshift(item);records('ibp_intelligence').splice(500);return persist(actor,'نشر موجز استخباراتي',title,null,cb,{item});
  });
}
module.exports = { registerIBPSocket, SESSION_TTL, CLASSIFICATION_LEVEL };
