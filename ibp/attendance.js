'use strict';

function battalionForUser(state, user) {
  const publicCode = String(user && user.publicCode || '').trim().toUpperCase();
  if (!publicCode) return null;
  return (Array.isArray(state && state.cia_battalions) ? state.cia_battalions : []).find((unit) => {
    if (!unit || unit.status === 'ARCHIVED') return false;
    const members = [
      ...(Array.isArray(unit.memberCodes) ? unit.memberCodes : []),
      unit.commanderCode || '',
      unit.deputyCode || ''
    ];
    return members.some((memberCode) => String(memberCode || '').trim().toUpperCase() === publicCode);
  }) || null;
}

function closeSession(session, at) {
  session.logoutAt = at;
  session.lastSeenAt = at;
  session.status = 'OFFLINE';
  const started = Date.parse(session.loginAt);
  const ended = Date.parse(at);
  session.durationMs = Number.isFinite(started) && Number.isFinite(ended)
    ? Math.max(0, ended - started)
    : 0;
}

function recordBattalionLogin(state, user, at, makeId) {
  const battalion = battalionForUser(state, user);
  if (!battalion) return null;
  const attendance = Array.isArray(state.cia_battalion_attendance)
    ? state.cia_battalion_attendance
    : (state.cia_battalion_attendance = []);
  const prior = attendance.find((item) => item.userId === user.id && item.status === 'ONLINE' && !item.logoutAt);
  if (prior) {
    const lastSeen = prior.lastSeenAt || user.lastSeenAt || prior.loginAt || at;
    closeSession(prior, lastSeen);
  }
  const entry = {
    id: typeof makeId === 'function' ? makeId('BATTEND') : 'BATTEND-' + Date.now(),
    userId: user.id,
    publicCode: String(user.publicCode || ''),
    memberName: String(user.identity && user.identity.fullName || user.name || ''),
    rank: String(user.rank || ''),
    battalionId: battalion.id,
    battalionCode: String(battalion.code || battalion.id || ''),
    loginAt: at,
    logoutAt: null,
    lastSeenAt: at,
    status: 'ONLINE',
    durationMs: null
  };
  attendance.unshift(entry);
  return entry;
}

function recordBattalionLogout(state, user, at) {
  if (!user) return null;
  const attendance = Array.isArray(state && state.cia_battalion_attendance)
    ? state.cia_battalion_attendance
    : [];
  const entry = attendance.find((item) => item.userId === user.id && item.status === 'ONLINE' && !item.logoutAt);
  if (!entry) return null;
  closeSession(entry, at);
  return entry;
}

module.exports = { battalionForUser, recordBattalionLogin, recordBattalionLogout };
