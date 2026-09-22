'use strict';

/*
  BLACK RIDGE CITY CIA SYSTEM
  server.js

  This server is intentionally matched to the Socket.IO API used by the
  current BLACK RIDGE HTML UI (account:create, auth:claimChief, auth:login,
  join:request, admin:action, character:* , radio:* , sos:broadcast, etc.).

  Install:
    npm i express socket.io

  Run:
    node server.js

  Open:
    http://localhost:3000
*/

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, 'cia-data.json');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true
  }
});

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const candidates = ['index.html', 'index26-7.html', 'index(29).html', 'index (31).html'];
  for (const file of candidates) {
    const full = path.join(__dirname, file);
    if (fs.existsSync(full)) return res.sendFile(full);
  }
  res.status(404).send('BLACK RIDGE CIA: index.html not found.');
});

const now = () => new Date().toISOString();
const clean = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const lower = (value) => clean(value, 200).toLowerCase();
const makeId = (prefix = 'ID') => `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;

const SYSTEM = Object.freeze({
  chiefRegistrationCode: '1531',
  chiefSaveCode: '4139',
  memberRequestCode: '0012',
  defaultSalary: 580
});

const EMPTY_STATE = {
  cia_users: [],
  cia_queue: [],
  cia_character_queue: [],
  cia_accounts: [],
  cia_chats: { global: [], private: {} },
  cia_sos: [],
  cia_reports: [],
  cia_cases: [],
  cia_map_locations: {},
  cia_hq_locations: [],
  cia_audit_logs: [],
  cia_attendance: [],
  cia_operations: [],
  settings: {
    publicSalary: SYSTEM.defaultSalary,
    rankSalaries: {
      AGENT: SYSTEM.defaultSalary,
      'HIGH COMMANDER': SYSTEM.defaultSalary,
      'SUPREME COMMANDER': SYSTEM.defaultSalary,
      'CIA CHIEF': SYSTEM.defaultSalary
    }
  },
  systemConfig: {
    chiefRegistrationCode: SYSTEM.chiefRegistrationCode,
    chiefSaveCode: SYSTEM.chiefSaveCode
  }
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function loadState() {
  if (!fs.existsSync(DATA_FILE)) return clone(EMPTY_STATE);
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const base = clone(EMPTY_STATE);
    const state = {
      ...base,
      ...parsed,
      settings: {
        ...base.settings,
        ...(parsed.settings || {}),
        rankSalaries: {
          ...(base.settings.rankSalaries || {}),
          ...((parsed.settings && parsed.settings.rankSalaries) || {})
        }
      },
      systemConfig: { ...base.systemConfig, ...(parsed.systemConfig || {}) },
      cia_chats: {
        global: Array.isArray(parsed.cia_chats?.global) ? parsed.cia_chats.global : [],
        private: parsed.cia_chats?.private && typeof parsed.cia_chats.private === 'object' ? parsed.cia_chats.private : {}
      }
    };

    if (state.settings.rankSalaries && state.settings.rankSalaries['Senior Commander CIA'] !== undefined) {
      const legacySeniorSalary = Number(state.settings.rankSalaries['Senior Commander CIA']);
      if (!Number.isFinite(Number(state.settings.rankSalaries['SUPREME COMMANDER'])) || Number(state.settings.rankSalaries['SUPREME COMMANDER']) === SYSTEM.defaultSalary) {
        if (Number.isFinite(legacySeniorSalary) && legacySeniorSalary >= 0) {
          state.settings.rankSalaries['SUPREME COMMANDER'] = Math.floor(legacySeniorSalary);
        }
      }
      delete state.settings.rankSalaries['Senior Commander CIA'];
    }

    for (const key of [
      'cia_users', 'cia_queue', 'cia_character_queue', 'cia_accounts',
      'cia_sos', 'cia_reports', 'cia_cases', 'cia_hq_locations',
      'cia_audit_logs', 'cia_attendance', 'cia_operations'
    ]) {
      if (!Array.isArray(state[key])) state[key] = [];
    }

    if (!state.cia_map_locations || typeof state.cia_map_locations !== 'object') {
      state.cia_map_locations = {};
    }

    normalizeAllUsers(state);
    return state;
  } catch (error) {
    console.error('[BLACK RIDGE] Failed to load cia-data.json:', error.message);
    return clone(EMPTY_STATE);
  }
}

function saveState() {
  try {
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (error) {
    console.error('[BLACK RIDGE] Failed to save state:', error.message);
  }
}

let state;
state = loadState();

const sessions = new Map();
const socketToUser = new Map();
const radioChannels = new Map();

function normalizeRank(rank) {
  const value = clean(rank, 100).toUpperCase();

  if (value === 'CIA CHIEF') return 'CIA CHIEF';

  if (
    value === 'SUPREME COMMANDER' ||
    value === 'SENIOR COMMANDER CIA'
  ) {
    return 'SUPREME COMMANDER';
  }

  if (value === 'HIGH COMMANDER') return 'HIGH COMMANDER';

  return 'AGENT';
}

function rankLabel(rank) {
  switch (normalizeRank(rank)) {
    case 'CIA CHIEF':
      return 'CIA CHIEF';

    case 'SUPREME COMMANDER':
      return 'Senior Commander CIA';

    case 'HIGH COMMANDER':
      return 'High Commander';

    default:
      return 'Agent';
  }
}

function rankLevel(rank) {
  switch (normalizeRank(rank)) {
    case 'CIA CHIEF':
      return 4;

    case 'SUPREME COMMANDER':
      return 3;

    case 'HIGH COMMANDER':
      return 2;

    default:
      return 1;
  }
}

function defaultSalaryForRank(rank) {
  const normalized = normalizeRank(rank);

  const configured = Number(
    state &&
    state.settings &&
    state.settings.rankSalaries
      ? state.settings.rankSalaries[normalized]
      : NaN
  );

  return Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : SYSTEM.defaultSalary;
}

function canManageBank(actor, target) {
  if (!actor || !target) return false;

  if (isChief(actor)) return true;

  if (isSenior(actor)) {
    return (
      target.id !== actor.id &&
      !isChief(target) &&
      !isSenior(target)
    );
  }

  if (isHighCommander(actor)) {
    return normalizeRank(target.rank) === 'AGENT';
  }

  return false;
}

function canDepositBank(actor, target) {
  if (!actor || !target) return false;

  if (isChief(actor)) return true;

  if (isSenior(actor)) {
    return !isChief(target) && !isSenior(target);
  }

  return false;
}

function canSetRankSalary(actor, rank) {
  if (!actor) return false;

  const desired = normalizeRank(rank);

  if (isChief(actor)) return true;

  if (isSenior(actor)) {
    return (
      desired === 'AGENT' ||
      desired === 'HIGH COMMANDER'
    );
  }

  if (isHighCommander(actor)) {
    return desired === 'AGENT';
  }

  return false;
}

const isChief = (user) =>
  !!user && normalizeRank(user.rank) === 'CIA CHIEF';

const isSenior = (user) =>
  !!user && normalizeRank(user.rank) === 'SUPREME COMMANDER';

const isHighCommander = (user) =>
  !!user && normalizeRank(user.rank) === 'HIGH COMMANDER';

const isLeadership = (user) =>
  isChief(user) || isSenior(user);

function ensureBank(user) {
  if (!user.bank || typeof user.bank !== 'object') {
    user.bank = {};
  }

  if (!Number.isFinite(Number(user.bank.balance))) {
    user.bank.balance = 0;
  }

  user.bankAccount = clean(user.bankAccount || '', 60);

  if (!Number.isFinite(Number(user.bank.salary))) {
    user.bank.salary = defaultSalaryForRank(user.rank);
  }

  if (!Object.prototype.hasOwnProperty.call(user.bank, 'lastSalaryAt')) {
    user.bank.lastSalaryAt = null;
  }

  if (!Object.prototype.hasOwnProperty.call(user.bank, 'salaryClaimedToday')) {
    user.bank.salaryClaimedToday = false;
  }

  user.bank.frozen = user.bank.frozen === true;
  user.bank.enabled = user.bank.enabled !== false;
  user.bank.salaryEnabled = user.bank.salaryEnabled !== false;

  if (!user.bank.bankCode) {
    user.bank.bankCode =
      `BANK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  }

  return user.bank;
}

function normalizeUser(user) {
  if (!user.id) user.id = makeId('USER');

  user.name = clean(user.name || 'Unnamed', 120);
  user.rank = normalizeRank(user.rank);
  user.publicCode = clean(user.publicCode || '', 100);
  user.secretCode = clean(user.secretCode || '', 100);
  user.status = clean(user.status || 'في الخدمة', 100);

  user.approved = user.approved !== false;
  user.activeService = user.activeService !== false;
  user.suspended = user.suspended === true;
  user.online = user.online === true;

  user.identity = user.identity || null;
  user.identityRequired = user.identityRequired !== false;

  user.loginCount = Number(user.loginCount || 0);
  user.lastLoginAt = user.lastLoginAt || null;
  user.lastLogoutAt = user.lastLogoutAt || null;

  user.radioChannel = clean(user.radioChannel || 'CH-1', 50);
  user.radioOnline = user.radioOnline === true;

  user.hobbies = clean(user.hobbies || '', 1000);

  user.accountId = user.accountId || null;
  user.characterOwnerId =
    user.characterOwnerId ||
    user.accountId ||
    user.id;

  user.characterType =
    user.characterType ||
    'main';

  user.separatedAt =
    user.separatedAt ||
    null;

  user.separationReason =
    user.separationReason ||
    '';

  ensureBank(user);

  return user;
}

function normalizeAllUsers(targetState) {
  for (const user of targetState.cia_users || []) {
    normalizeUser(user);
  }
}

function makePublicCode(rank) {
  const prefix = {
    'CIA CHIEF': 'CHIEF',
    'SUPREME COMMANDER': 'SC',
    'HIGH COMMANDER': 'HC',
    'AGENT': 'AG'
  }[normalizeRank(rank)] || 'AG';

  let value;

  do {
    value =
      `${prefix}-${Math.floor(100 + Math.random() * 900)}`;
  } while (
    state.cia_users.some(
      (u) => u.publicCode === value
    )
  );

  return value;
}

function makeSecretCode() {
  let value;

  do {
    value =
      String(Math.floor(1000 + Math.random() * 9000));
  } while (
    state.cia_users.some(
      (u) => u.secretCode === value
    ) ||
    value === SYSTEM.memberRequestCode ||
    value === SYSTEM.chiefRegistrationCode ||
    value === SYSTEM.chiefSaveCode
  );

  return value;
}

function validateSecretCode(value, target = null) {
  const code = clean(value, 100);

  if (code.length < 4) {
    return 'الكود يجب أن يكون 4 أحرف/أرقام على الأقل.';
  }

  if (code === SYSTEM.memberRequestCode) {
    return 'هذا الكود محجوز لطلبات القبول.';
  }

  if (code === SYSTEM.chiefRegistrationCode) {
    return 'هذا الكود محجوز لتأسيس القيادة.';
  }

  if (code === SYSTEM.chiefSaveCode) {
    return 'هذا الكود محجوز كرمز حماية القيادة.';
  }

  if (
    state.cia_users.some(
      (u) =>
        u.id !== target?.id &&
        u.secretCode === code
    )
  ) {
    return 'كود الدخول مستخدم من شخصية أخرى.';
  }

  return null;
}

function getUserById(userId) {
  return (
    state.cia_users.find(
      (u) => u.id === userId
    ) || null
  );
}

function getUserByPublicCode(publicCode) {
  const wanted = clean(publicCode, 100);

  return (
    state.cia_users.find(
      (u) => u.publicCode === wanted
    ) || null
  );
}

function getUserByMilitaryOrSecretCode(value) {
  const wanted = clean(value, 100);

  return (
    state.cia_users.find(
      (u) =>
        u.publicCode === wanted ||
        u.secretCode === wanted
    ) || null
  );
}

function findUser(name, secretCode) {
  const n = lower(name);
  const c = clean(secretCode, 100);

  return (
    state.cia_users.find(
      (u) =>
        lower(u.name) === n &&
        u.secretCode === c &&
        u.approved !== false &&
        u.activeService !== false &&
        u.suspended !== true
    ) || null
  );
}

function publicUser(user, viewer = null) {
  if (!user) return null;

  const leadership = isLeadership(viewer);
  const self =
    !!viewer &&
    viewer.id === user.id;

  const result = {
    id: user.id,
    publicCode: user.publicCode,

    name:
      self || leadership
        ? user.name
        : null,

    rank: normalizeRank(user.rank),
    rankLabel: rankLabel(user.rank),

    online: !!user.online,

    status:
      user.status ||
      'في الخدمة',

    loginCount:
      Number(user.loginCount || 0),

    lastLoginAt:
      user.lastLoginAt || null,

    lastLogoutAt:
      user.lastLogoutAt || null,

    identity:
      self || leadership
        ? (user.identity || null)
        : null,

    identityRequired:
      user.identityRequired !== false,

    characterOwnerId:
      user.characterOwnerId ||
      user.accountId ||
      user.id,

    characterType:
      user.characterType ||
      'main',

    accountId:
      self || leadership
        ? user.accountId || null
        : null,

    activeService:
      user.activeService !== false,

    suspended:
      user.suspended === true,

    bank:
      self || leadership
        ? {
            accountNumber:
              user.bankAccount || '',

            balance:
              ensureBank(user).balance,

            salary:
              ensureBank(user).salary,

            lastSalaryAt:
              ensureBank(user).lastSalaryAt,

            frozen:
              !!ensureBank(user).frozen,

            enabled:
              ensureBank(user).enabled !== false,

            salaryEnabled:
              ensureBank(user).salaryEnabled !== false,

            bankCode:
              ensureBank(user).bankCode ||
              null
          }
        : null,

    radioChannel:
      user.radioChannel ||
      'CH-1',

    radioOnline:
      !!user.radioOnline
  };

  if (self) {
    result.secretCode =
      user.secretCode;

    result.hobbies =
      user.hobbies || '';
  } else if (leadership) {
    result.hobbies =
      user.hobbies || '';
  }

  return result;
}

function addAuditLog(
  action,
  actor = null,
  target = null,
  details = ''
) {
  state.cia_audit_logs.unshift({
    id: makeId('AUD'),

    action:
      clean(action, 120),

    actorId:
      actor?.id || null,

    actorName:
      actor?.name || '',

    actorCode:
      actor?.publicCode || '',

    targetId:
      target?.id || null,

    targetName:
      target?.name || '',

    targetCode:
      target?.publicCode || '',

    details:
      clean(details, 1000),

    at: now()
  });

  state.cia_audit_logs =
    state.cia_audit_logs.slice(0, 500);
}

function chatKey(a, b) {
  return [
    clean(a, 100),
    clean(b, 100)
  ]
    .sort()
    .join('::');
}

function privateChatsFor(viewer) {
  if (!viewer?.publicCode) return {};

  if (isLeadership(viewer)) {
    return state.cia_chats.private || {};
  }

  const result = {};
  const own = viewer.publicCode;

  for (
    const [key, value]
    of Object.entries(
      state.cia_chats.private || {}
    )
  ) {
    if (
      key
        .split('::')
        .includes(own)
    ) {
      result[key] = value;
    }
  }

  return result;
}

function sanitizeShared(key, value) {
  const allowed = new Set([
    'cia_chats',
    'cia_reports',
    'cia_cases',
    'cia_map_locations',
    'cia_hq_locations'
  ]);

  if (!allowed.has(key)) return null;

  if (key === 'cia_chats') {
    const global =
      Array.isArray(value?.global)
        ? value.global
            .filter(
              (m) => !m?.targetCode
            )
            .slice(-1000)
        : [];

    const privateChats = {};

    const src =
      value?.private &&
      typeof value.private === 'object'
        ? value.private
        : {};

    for (
      const [k, messages]
      of Object.entries(src)
    ) {
      if (!Array.isArray(messages)) continue;

      privateChats[
        clean(k, 150)
      ] = messages.slice(-500);
    }

    return {
      global,
      private: privateChats
    };
  }

  if (key === 'cia_map_locations') {
    return value &&
      typeof value === 'object'
      ? value
      : {};
  }

  if (key === 'cia_hq_locations') {
    return Array.isArray(value)
      ? value.slice(-20)
      : [];
  }

  if (key === 'cia_reports') {
    const incoming =
      Array.isArray(value)
        ? value
        : [];

    const existing =
      Array.isArray(state.cia_reports)
        ? state.cia_reports
        : [];

    const byId = new Map(
      existing.map(
        (r) => [String(r.id), r]
      )
    );

    for (const report of incoming) {
      if (
        !report ||
        report.id === undefined ||
        report.id === null
      ) continue;

      const id =
        String(report.id);

      if (!byId.has(id)) {
        byId.set(id, {
          ...report,
          id: report.id,
          immutable: true,
          createdAt:
            report.createdAt ||
            report.date ||
            now()
        });
      }
    }

    return [
      ...byId.values()
    ].slice(-1000);
  }

  return Array.isArray(value)
    ? value.slice(-1000)
    : [];
}

function snapshot(viewer = null) {
  return {
    cia_users:
      state.cia_users.map(
        (u) => publicUser(u, viewer)
      ),

    cia_queue:
      isChief(viewer)
        ? state.cia_queue
        : [],

    cia_character_queue:
      isChief(viewer)
        ? state.cia_character_queue
        : [],

    cia_chats: {
      global:
        state.cia_chats.global || [],

      private:
        privateChatsFor(viewer)
    },

    cia_sos:
      state.cia_sos || [],

    cia_reports:
      state.cia_reports || [],

    cia_cases:
      state.cia_cases || [],

    cia_map_locations:
      state.cia_map_locations || {},

    cia_hq_locations:
      state.cia_hq_locations || [],

    cia_audit_logs:
      isLeadership(viewer)
        ? state.cia_audit_logs
        : [],

    cia_attendance:
      isLeadership(viewer)
        ? (state.cia_attendance || [])
        : [],

    cia_operations:
      (state.cia_operations || [])
        .map(
          (op) =>
            operationSanitize(
              op,
              viewer
            )
        )
        .filter(Boolean)
  };
}

function emitState() {
  for (
    const socket
    of io.sockets.sockets.values()
  ) {
    const user =
      socket.userId
        ? getUserById(socket.userId)
        : null;

    socket.emit(
      'state:update',
      snapshot(user)
    );
  }
}

function reply(cb, payload) {
  if (typeof cb === 'function') {
    cb(payload);
  }

  return payload;
}

function ok(cb, payload = {}) {
  return reply(cb, {
    ok: true,
    ...payload
  });
}

function no(cb, message) {
  return reply(cb, {
    ok: false,
    message:
      clean(message, 500)
  });
}

function sessionSet(userId) {
  if (!sessions.has(userId)) {
    sessions.set(
      userId,
      new Set()
    );
  }

  return sessions.get(userId);
}

function markLogin(socket, user) {
  const set =
    sessionSet(user.id);

  const first =
    set.size === 0;

  set.add(socket.id);

  socket.userId =
    user.id;

  socketToUser.set(
    socket.id,
    user.id
  );

  user.online = true;
  user.activeService = true;
  user.status = 'في الخدمة';

  if (first) {
    user.loginCount += 1;
    user.lastLoginAt = now();

    addAuditLog(
      'تسجيل الدخول',
      user,
      user,
      'تم تسجيل دخول الشخصية.'
    );
  }

  saveState();
  emitState();
}

function markLogout(socket) {
  const userId =
    socket.userId;

  if (!userId) return;

  const set =
    sessions.get(userId);

  if (set) {
    set.delete(socket.id);

    if (set.size > 0) {
      socket.userId = null;
      socketToUser.delete(
        socket.id
      );
      return;
    }

    sessions.delete(userId);
  }

  const user =
    getUserById(userId);

  if (user) {
    user.online = false;
    user.radioOnline = false;
    user.lastLogoutAt = now();

    addAuditLog(
      'تسجيل الخروج',
      user,
      user,
      'تم تسجيل خروج الشخصية.'
    );

    saveState();
  }

  socket.userId = null;
  socketToUser.delete(
    socket.id
  );

  emitState();
}

function requireSocketUser(socket) {
  const user =
    socket.userId
      ? getUserById(socket.userId)
      : null;

  if (!user) return null;

  if (
    user.suspended ||
    user.activeService === false
  ) {
    return null;
  }

  return user;
}

function canManageMember(
  actor,
  target
) {
  if (
    !actor ||
    !target ||
    actor.id === target.id
  ) {
    return false;
  }

  if (isChief(actor)) {
    return true;
  }

  if (isSenior(actor)) {
    return (
      !isChief(target) &&
      !isSenior(target)
    );
  }

  if (isHighCommander(actor)) {
    return (
      normalizeRank(target.rank) ===
      'AGENT'
    );
  }

  return false;
}

function canChangeRank(
  actor,
  target,
  newRank
) {
  if (!actor || !target) {
    return false;
  }

  const desired =
    normalizeRank(newRank);

  if (desired === 'CIA CHIEF') {
    return false;
  }

  if (isChief(actor)) {
    return !isChief(target);
  }

  if (isSenior(actor)) {
    return (
      !isChief(target) &&
      !isSenior(target) &&
      desired !== 'SUPREME COMMANDER'
    );
  }

  return false;
}

function canChangeSecret(
  actor,
  target
) {
  if (!actor || !target) {
    return false;
  }

  if (isChief(actor)) {
    return !isChief(target);
  }

  if (isSenior(actor)) {
    return (
      !isChief(target) &&
      !isSenior(target)
    );
  }

  if (isHighCommander(actor)) {
    return (
      normalizeRank(target.rank) ===
      'AGENT'
    );
  }

  return false;
}

function sanitizeMapLocationsForActor(
  actor,
  incoming
) {
  const source =
    incoming &&
    typeof incoming === 'object'
      ? incoming
      : {};

  const current =
    state.cia_map_locations &&
    typeof state.cia_map_locations === 'object'
      ? state.cia_map_locations
      : {};

  if (
    isChief(actor) ||
    isSenior(actor) ||
    isHighCommander(actor)
  ) {
    return source;
  }

  const ownCode =
    actor?.publicCode;

  if (!ownCode) {
    return current;
  }

  const result = {
    ...current
  };

  if (
    Object.prototype.hasOwnProperty.call(
      source,
      ownCode
    ) &&
    source[ownCode]
  ) {
    result[ownCode] =
      source[ownCode];
  } else {
    delete result[ownCode];
  }

  return result;
}

function canRemoveAnyMapLocation(
  actor
) {
  return !!actor &&
    (
      isChief(actor) ||
      isSenior(actor) ||
      isHighCommander(actor)
    );
}

function removeMapLocationByCode(
  code
) {
  const wanted =
    clean(code, 100);

  if (
    !wanted ||
    !state.cia_map_locations ||
    typeof state.cia_map_locations !== 'object'
  ) {
    return false;
  }

  if (
    !Object.prototype.hasOwnProperty.call(
      state.cia_map_locations,
      wanted
    )
  ) {
    return false;
  }

  delete state.cia_map_locations[wanted];

  return true;
}

function addRadioMember(
  channel,
  socketId
) {
  if (
    !radioChannels.has(channel)
  ) {
    radioChannels.set(
      channel,
      new Set()
    );
  }

  radioChannels
    .get(channel)
    .add(socketId);
}

function removeRadioMember(
  socketId
) {
  for (
    const members
    of radioChannels.values()
  ) {
    members.delete(socketId);
  }
}

function radioTargets(channel) {
  const members =
    radioChannels.get(channel);

  return members
    ? [...members]
    : [];
}

function dailySalary(user) {
  ensureBank(user);

  if (
    !user.approved ||
    user.activeService === false ||
    user.suspended
  ) {
    return null;
  }

  if (
    user.bank.enabled === false ||
    user.bank.frozen ||
    user.bank.salaryEnabled === false
  ) {
    return null;
  }

  if (
    !user.online ||
    !user.lastLoginAt
  ) {
    return null;
  }

  const lastSalary =
    user.bank.lastSalaryAt
      ? new Date(
          user.bank.lastSalaryAt
        ).getTime()
      : 0;

  const dayMs =
    24 * 60 * 60 * 1000;

  if (
    lastSalary &&
    Date.now() - lastSalary <
      dayMs
  ) {
    user.bank.salaryClaimedToday =
      true;

    return null;
  }

  const amount =
    Math.max(
      0,
      Math.floor(
        Number(user.bank.salary) || 0
      )
    );

  user.bank.balance +=
    amount;

  user.bank.lastSalaryAt =
    now();

  user.bank.salaryClaimedToday =
    true;

  addAuditLog(
    'صرف راتب',
    null,
    user,
    `تم إيداع ${amount} في الحساب البنكي.`
  );

  return amount;
}

function characterListForUser(
  user
) {
  return state.cia_users.filter(
    (u) =>
      (
        u.accountId &&
        u.accountId ===
          user.accountId
      ) ||
      u.characterOwnerId ===
        (
          user.characterOwnerId ||
          user.id
        )
  );
}

/* ---------------------------------------------------------
   REST compatibility endpoints
--------------------------------------------------------- */

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,
      service:
        'BLACK RIDGE CITY CIA SYSTEM',
      time: now(),
      personnel:
        state.cia_users.length
    });
  }
);

app.get(
  '/api/health',
  (req, res) => {
    res.json({
      ok: true,
      service:
        'BLACK RIDGE CITY CIA SYSTEM',
      time: now(),
      personnel:
        state.cia_users.length
    });
  }
);

app.get(
  '/api/state',
  (req, res) => {
    res.json({
      ok: true,
      state:
        snapshot(null)
    });
  }
);

function parseMoney(value) {
  const amount =
    Math.floor(
      Number(value)
    );

  return Number.isFinite(amount)
    ? amount
    : NaN;
}

function bankView(
  user,
  viewer = user
) {
  ensureBank(user);

  const chiefViewer =
    isChief(viewer);

  const self =
    !!viewer &&
    viewer.id === user.id;

  const managerAccess =
    canManageBank(
      viewer,
      user
    );

  const visible =
    self ||
    chiefViewer ||
    managerAccess;

  const showName =
    self ||
    chiefViewer;

  return {
    id: user.id,
    code: user.publicCode,

    accountNumber:
      visible
        ? (user.bankAccount || '')
        : '',

    name:
      showName
        ? user.name
        : '',

    rank:
      normalizeRank(
        user.rank
      ),

    balance:
      visible
        ? user.bank.balance
        : null,

    salary:
      visible
        ? user.bank.salary
        : null,

    online:
      !!user.online,

    lastSalaryAt:
      user.bank.lastSalaryAt ||
      null,

    salaryClaimedToday:
      !!user.bank.salaryClaimedToday,

    frozen:
      !!user.bank.frozen,

    enabled:
      user.bank.enabled !== false,

    salaryEnabled:
      user.bank.salaryEnabled !== false,

    bankCode:
      visible
        ? (
            user.bank.bankCode ||
            null
          )
        : null
  };
}

function canSetSalary(
  actor,
  target
) {
  if (!actor || !target) {
    return false;
  }

  if (isChief(actor)) {
    return true;
  }

  if (isSenior(actor)) {
    return (
      target.id !== actor.id &&
      !isChief(target) &&
      !isSenior(target)
    );
  }

  if (isHighCommander(actor)) {
    return (
      normalizeRank(target.rank) ===
      'AGENT'
    );
  }

  return false;
}

function statusLabelForResult(
  status
) {
  const labels = {
    PLANNED: 'مخططة',
    IN_PROGRESS: 'قيد التنفيذ',
    COMPLETED: 'مكتملة',
    FAILED: 'فشلت',
    CANCELLED: 'ملغاة'
  };

  return (
    labels[status] ||
    status
  );
}

function operationSanitize(
  op,
  viewer
) {
  if (!op) return null;

  const normalizedViewerRank =
    normalizeRank(
      viewer?.rank
    );

  const leadership =
    isLeadership(viewer);

  const privilegedMissionViewer =
    leadership ||
    normalizedViewerRank ===
      'HIGH COMMANDER';

  const crews =
    (
      Array.isArray(
        op.memberCodes
      )
        ? op.memberCodes
        : []
    ).map((code) => {
      const member =
        getUserByPublicCode(
          code
        );

      return leadership &&
        member
        ? {
            code,
            name: member.name
          }
        : {
            code
          };
    });

  if (
    viewer &&
    normalizedViewerRank ===
      'AGENT' &&
    !privilegedMissionViewer
  ) {
    return {
      id: op.id,

      missionNumber:
        op.missionNumber ||
        op.id,

      title: op.title,
      type: op.type,
      risk: op.risk,
      objective:
        op.objective,

      status:
        op.status,

      startLocation:
        op.startLocation ||
        null,

      endLocation:
        op.endLocation ||
        null,

      missionLocation:
        op.startLocation ||
        op.endLocation ||
        null,

      commanderCode: '',
      battalionLeaderCode: '',
      commanderName: '',

      crew: [],

      battalionCount: 0,

      notes: [],

      createdAt:
        op.createdAt,

      updatedAt:
        op.updatedAt,

      createdByCode: '',
      createdByName: ''
    };
  }

  return {
    id: op.id,

    missionNumber:
      op.missionNumber ||
      op.id,

    title: op.title,
    type: op.type,
    risk: op.risk,
    objective:
      op.objective,

    status:
      op.status,

    startLocation:
      op.startLocation ||
      null,

    endLocation:
      op.endLocation ||
      null,

    missionLocation:
      op.startLocation ||
      op.endLocation ||
      null,

    commanderCode:
      op.commanderCode ||
      '',

    battalionLeaderCode:
      op.commanderCode ||
      '',

    commanderName:
      leadership
        ? (
            op.commanderName ||
            ''
          )
        : '',

    crew: crews,

    battalionCount:
      Array.isArray(
        op.memberCodes
      )
        ? op.memberCodes.length
        : 0,

    notes:
      (
        Array.isArray(op.notes)
          ? op.notes
          : []
      ).map((n) => ({
        at: n.at,

        authorCode:
          n.authorCode ||
          '',

        authorName:
          leadership
            ? (
                n.authorName ||
                ''
              )
            : '',

        text:
          n.text ||
          ''
      })),

    createdAt:
      op.createdAt,

    updatedAt:
      op.updatedAt,

    createdByCode:
      op.createdByCode ||
      '',

    createdByName:
      leadership
        ? (
            op.createdByName ||
            ''
          )
        : ''
  };
}

function emitOperationState() {
  for (
    const socket
    of io.sockets.sockets.values()
  ) {
    const viewer =
      socket.userId
        ? getUserById(
            socket.userId
          )
        : null;

    if (!viewer) continue;

    socket.emit(
      'operation:list:result',
      {
        ok: true,

        operations:
          (
            state.cia_operations ||
            []
          )
            .map(
              (op) =>
                operationSanitize(
                  op,
                  viewer
                )
            )
            .filter(Boolean)
      }
    );
  }
}

/* ---------------------------------------------------------
   SOCKET.IO
--------------------------------------------------------- */

io.on(
  'connection',
  (socket) => {
    socket.emit(
      'state:update',
      snapshot(null)
    );

    socket.on(
      'shared:data:seed',
      (seed, cb) => {
        try {
          const object =
            seed &&
            typeof seed === 'object'
              ? seed
              : {};

          const actor =
            requireSocketUser(
              socket
            );

          for (
            const [key, value]
            of Object.entries(object)
          ) {
            const safe =
              sanitizeShared(
                key,
                value
              );

            if (safe === null) {
              continue;
            }

            state[key] =
              key ===
              'cia_map_locations'
                ? sanitizeMapLocationsForActor(
                    actor,
                    safe
                  )
                : safe;
          }

          saveState();

          if (
            typeof cb === 'function'
          ) {
            cb({ ok: true });
          }

          emitState();
        } catch (error) {
          no(
            cb,
            error.message ||
              'تعذر حفظ البيانات المشتركة.'
          );
        }
      }
    );

    socket.on(
      'shared:data:set',
      (payload, cb) => {
        try {
          const key =
            clean(
              payload?.key,
              100
            );

          const safe =
            sanitizeShared(
              key,
              payload?.value
            );

          if (safe === null) {
            return no(
              cb,
              'نوع البيانات غير مسموح.'
            );
          }

          const actor =
            requireSocketUser(
              socket
            );

          if (
            key ===
              'cia_map_locations' &&
            !actor
          ) {
            return no(
              cb,
              'يجب تسجيل الدخول لإدارة مواقع الخريطة.'
            );
          }

          const finalValue =
            key ===
              'cia_map_locations'
              ? sanitizeMapLocationsForActor(
                  actor,
                  safe
                )
              : safe;

          state[key] =
            finalValue;

          saveState();

          io.emit(
            'shared:data:update',
            {
              key,
              value:
                finalValue
            }
          );

          if (
            typeof cb ===
            'function'
          ) {
            cb({
              ok: true
            });
          }
        } catch (error) {
          no(
            cb,
            error.message ||
              'تعذر حفظ البيانات.'
          );
        }
      }
    );

    /* =====================================================
       ACCOUNT CREATE
    ===================================================== */

    socket.on(
      'account:create',
      (payload, cb) => {
        try {
          const loginName =
            clean(
              payload?.loginName,
              100
            );

          const password =
            String(
              payload?.password ||
                ''
            );

          const characterName =
            clean(
              payload?.characterName,
              120
            );

          const characterCode =
            clean(
              payload?.characterCode,
              100
            );

          if (
            !loginName ||
            password.length < 4 ||
            !characterName ||
            !characterCode
          ) {
            return no(
              cb,
              'أكمل بيانات إنشاء الحساب.'
            );
          }

          if (
            state.cia_accounts.some(
              (a) =>
                lower(
                  a.loginName
                ) ===
                lower(
                  loginName
                )
            )
          ) {
            return no(
              cb,
              'اسم تسجيل الدخول مستخدم بالفعل.'
            );
          }

          if (
            state.cia_users.some(
              (u) =>
                lower(u.name) ===
                lower(
                  characterName
                )
            )
          ) {
            return no(
              cb,
              'اسم الشخصية مستخدم بالفعل.'
            );
          }

          if (
            state.cia_accounts.some(
              (a) =>
                lower(
                  a.pendingPrimary?.name
                ) ===
                lower(
                  characterName
                )
            )
          ) {
            return no(
              cb,
              'يوجد طلب معلق لهذه الشخصية.'
            );
          }

          const account = {
            id: makeId('ACCT'),

            loginName,

            passwordHash:
              crypto
                .createHash(
                  'sha256'
                )
                .update(password)
                .digest('hex'),

            createdAt:
              now(),

            status:
              'PENDING_APPROVAL',

            pendingPrimary: {
              name:
                characterName,

              initialCode:
                characterCode,

              createdAt:
                now()
            }
          };

          state.cia_accounts.push(
            account
          );

          addAuditLog(
            'إنشاء حساب',
            null,
            null,
            `تم إنشاء حساب ${loginName} مع الشخصية ${characterName}.`
          );

          saveState();
          emitState();

          return ok(
            cb,
            {
              account: {
                id:
                  account.id,

                loginName:
                  account.loginName
              },

              pending:
                true,

              message:
                'تم إنشاء الحساب. استخدم 0012 من شاشة الدخول لإرسال طلب القبول.'
            }
          );
        } catch (error) {
          return no(
            cb,
            error.message ||
              'تعذر إنشاء الحساب.'
          );
        }
      }
    );

    /* =====================================================
       FIRST CIA CHIEF
    ===================================================== */

    socket.on(
      'auth:claimChief',
      (payload, cb) => {
        try {
          if (
            state.cia_users.some(
              isChief
            )
          ) {
            const result =
              no(
                cb,
                'يوجد CIA CHIEF بالفعل.'
              );

            socket.emit(
              'auth:chief:result',
              result
            );

            return;
          }

          const name =
            clean(
              payload?.name,
              120
            );

          const personalCode =
            clean(
              payload?.code,
              100
            );

          const officialCode =
            clean(
              payload?.officialCode,
              100
            );

          const registrationCode =
            clean(
              payload?.registrationCode,
              100
            );

          const hobbies =
            clean(
              payload?.hobbies,
              1000
            );

          if (
            !name ||
            !personalCode ||
            !officialCode ||
            !registrationCode
          ) {
            const result =
              no(
                cb,
                'أكمل بيانات تأسيس القيادة.'
              );

            socket.emit(
              'auth:chief:result',
              result
            );

            return;
          }

          if (
            registrationCode !==
            SYSTEM.chiefRegistrationCode
          ) {
            const result =
              no(
                cb,
                'رمز تأسيس القيادة غير صحيح.'
              );

            socket.emit(
              'auth:chief:result',
              result
            );

            return;
          }

          if (
            officialCode !==
            SYSTEM.chiefSaveCode
          ) {
            const result =
              no(
                cb,
                'رمز الحفظ السري للقيادة غير صحيح.'
              );

            socket.emit(
              'auth:chief:result',
              result
            );

            return;
          }

          const codeError =
            validateSecretCode(
              personalCode
            );

          if (codeError) {
            const result =
              no(
                cb,
                codeError
              );

            socket.emit(
              'auth:chief:result',
              result
            );

            return;
          }

          const chief =
            normalizeUser({
              id:
                makeId('CHIEF'),

              accountId:
                null,

              characterOwnerId:
                null,

              characterType:
                'main',

              name,

              secretCode:
                personalCode,

              publicCode:
                'CHIEF-01',

              rank:
                'CIA CHIEF',

              online:
                false,

              approved:
                true,

              activeService:
                true,

              status:
                'في الخدمة',

              loginCount:
                0,

              lastLoginAt:
                null,

              lastLogoutAt:
                null,

              identity:
                null,

              identityRequired:
                true,

              hobbies,

              bank: {
                balance:
                  0,

                salary:
                  SYSTEM.defaultSalary,

                lastSalaryAt:
                  null,

                salaryClaimedToday:
                  false
              }
            });

          chief.characterOwnerId =
            chief.id;

          state.cia_users.push(
            chief
          );

          addAuditLog(
            'تأسيس القيادة',
            chief,
            chief,
            'تم إنشاء CIA CHIEF لأول مرة.'
          );

          markLogin(
            socket,
            chief
          );

          const result =
            ok(
              cb,
              {
                user:
                  publicUser(
                    chief,
                    chief
                  ),

                needsIdentity:
                  true
              }
            );

          socket.emit(
            'auth:chief:result',
            result
          );

          emitState();
        } catch (error) {
          const result =
            no(
              cb,
              error.message ||
                'تعذر تأسيس القيادة.'
            );

          socket.emit(
            'auth:chief:result',
            result
          );
        }
      }
    );

    /* =====================================================
       LOGIN
    ===================================================== */

    socket.on(
      'auth:login',
      (payload, cb) => {
        try {
          const name =
            clean(
              payload?.name,
              120
            );

          const code =
            clean(
              payload?.code,
              100
            );

          const user =
            findUser(
              name,
              code
            );

          if (!user) {
            const pending =
              state.cia_accounts.some(
                (a) =>
                  lower(
                    a.pendingPrimary?.name
                  ) ===
                  lower(name)
              );

            const message =
              pending
                ? 'هذه الشخصية بانتظار قبول CIA CHIEF. كود التسجيل الأولي لا يمنح صلاحية دخول.'
                : 'الاسم أو كود الدخول غير متطابقين.';

            const result =
              no(
                cb,
                message
              );

            socket.emit(
              'auth:login:result',
              result
            );

            return;
          }

          markLogin(
            socket,
            user
          );

          const salary =
            dailySalary(
              user
            );

          if (
            salary !== null
          ) {
            saveState();
          }

          const result =
            ok(
              cb,
              {
                user:
                  publicUser(
                    user,
                    user
                  ),

                needsIdentity:
                  user.identityRequired !== false &&
                  !user.identity
              }
            );

          socket.emit(
            'auth:login:result',
            result
          );

          emitState();
        } catch (error) {
          const result =
            no(
              cb,
              error.message ||
                'تعذر تسجيل الدخول.'
            );

          socket.emit(
            'auth:login:result',
            result
          );
        }
      }
    );
    /* =====================================================
       LOGOUT
    ===================================================== */

    socket.on(
      'auth:logout',
      (payload, cb) => {
        markLogout(socket);

        return ok(cb, {
          message:
            'تم تسجيل الخروج.'
        });
      }
    );

    socket.on(
      'auth:me',
      (payload, cb) => {
        const user =
          requireSocketUser(socket);

        if (!user) {
          return no(
            cb,
            'غير مسجل الدخول.'
          );
        }

        return ok(cb, {
          user:
            publicUser(
              user,
              user
            )
        });
      }
    );

    socket.on(
      'presence:ping',
      (payload, cb) => {
        const user =
          requireSocketUser(socket);

        if (!user) {
          return no(
            cb,
            'غير مسجل الدخول.'
          );
        }

        user.online = true;
        user.activeService = true;
        user.status =
          clean(
            payload?.status ||
              user.status ||
              'في الخدمة',
            100
          );

        if (
          payload?.radioChannel
        ) {
          user.radioChannel =
            clean(
              payload.radioChannel,
              50
            );
        }

        if (
          typeof payload?.radioOnline ===
          'boolean'
        ) {
          user.radioOnline =
            payload.radioOnline;
        }

        saveState();

        return ok(cb, {
          user:
            publicUser(
              user,
              user
            )
        });
      }
    );

    /* =====================================================
       JOIN REQUEST
    ===================================================== */

    socket.on(
      'join:request',
      (payload, cb) => {
        try {
          const name =
            clean(
              payload?.name ||
              payload?.characterName,
              120
            );

          const code =
            clean(
              payload?.code ||
              payload?.characterCode,
              100
            );

          if (
            !name ||
            !code
          ) {
            return no(
              cb,
              'أدخل اسم الشخصية والكود.'
            );
          }

          if (
            code !==
            SYSTEM.memberRequestCode
          ) {
            return no(
              cb,
              'كود طلب القبول غير صحيح.'
            );
          }

          const existing =
            state.cia_queue.find(
              (item) =>
                lower(item.name) ===
                lower(name)
            );

          if (existing) {
            return no(
              cb,
              'يوجد طلب قبول مسبق لهذه الشخصية.'
            );
          }

          if (
            state.cia_users.some(
              (u) =>
                lower(u.name) ===
                lower(name)
            )
          ) {
            return no(
              cb,
              'الشخصية موجودة بالفعل في النظام.'
            );
          }

          const request = {
            id:
              makeId('JOIN'),

            name,

            characterName:
              name,

            initialCode:
              code,

            requestedRank:
              'AGENT',

            requestedAt:
              now(),

            status:
              'PENDING'
          };

          state.cia_queue.push(
            request
          );

          addAuditLog(
            'طلب قبول',
            null,
            null,
            `تم تقديم طلب قبول للشخصية ${name}.`
          );

          saveState();
          emitState();

          return ok(
            cb,
            {
              request
            }
          );
        } catch (error) {
          return no(
            cb,
            error.message ||
              'تعذر إرسال طلب القبول.'
          );
        }
      }
    );

    /* =====================================================
       ADMIN ACTIONS
    ===================================================== */

    socket.on(
      'admin:action',
      (payload, cb) => {
        try {
          const actor =
            requireSocketUser(socket);

          if (!actor) {
            return no(
              cb,
              'يجب تسجيل الدخول.'
            );
          }

          const action =
            clean(
              payload?.action,
              100
            ).toLowerCase();

          const targetId =
            clean(
              payload?.targetId ||
              payload?.userId ||
              payload?.id,
              100
            );

          const target =
            getUserById(
              targetId
            );

          /* -------------------------------------------------
             ACCEPT JOIN
          ------------------------------------------------- */

          if (
            action ===
              'accept_join' ||
            action ===
              'approve_join' ||
            action ===
              'accept'
          ) {
            if (
              !isChief(actor)
            ) {
              return no(
                cb,
                'قبول أعضاء جدد متاح لـ CIA CHIEF فقط.'
              );
            }

            const request =
              state.cia_queue.find(
                (item) =>
                  item.id ===
                  targetId
              ) ||
              state.cia_queue.find(
                (item) =>
                  item.name ===
                  clean(
                    payload?.name,
                    120
                  )
              );

            if (!request) {
              return no(
                cb,
                'طلب القبول غير موجود.'
              );
            }

            const requestedName =
              clean(
                request.name ||
                request.characterName,
                120
              );

            const secretCode =
              clean(
                payload?.secretCode ||
                payload?.loginCode ||
                makeSecretCode(),
                100
              );

            const codeError =
              validateSecretCode(
                secretCode
              );

            if (codeError) {
              return no(
                cb,
                codeError
              );
            }

            const rank =
              normalizeRank(
                payload?.rank ||
                'AGENT'
              );

            if (
              rank ===
              'CIA CHIEF'
            ) {
              return no(
                cb,
                'لا يمكن إنشاء CIA CHIEF من طلب قبول.'
              );
            }

            const publicCode =
              makePublicCode(
                rank
              );

            const newUser =
              normalizeUser({
                id:
                  makeId('AGENT'),

                accountId:
                  payload?.accountId ||
                  null,

                characterOwnerId:
                  payload?.accountId ||
                  null,

                characterType:
                  'main',

                name:
                  requestedName,

                secretCode,

                publicCode,

                rank,

                approved:
                  true,

                activeService:
                  true,

                suspended:
                  false,

                online:
                  false,

                status:
                  'في الخدمة',

                identity:
                  null,

                identityRequired:
                  true,

                hobbies:
                  clean(
                    payload?.hobbies,
                    1000
                  ),

                bank: {
                  balance:
                    0,

                  salary:
                    defaultSalaryForRank(
                      rank
                    ),

                  lastSalaryAt:
                    null,

                  salaryClaimedToday:
                    false
                }
              });

            newUser.characterOwnerId =
              newUser.characterOwnerId ||
              newUser.id;

            state.cia_users.push(
              newUser
            );

            state.cia_queue =
              state.cia_queue.filter(
                (item) =>
                  item.id !==
                  request.id
              );

            addAuditLog(
              'قبول عضو',
              actor,
              newUser,
              `تم قبول ${newUser.name} برتبة ${rankLabel(newUser.rank)}.`
            );

            saveState();
            emitState();

            return ok(
              cb,
              {
                user:
                  publicUser(
                    newUser,
                    actor
                  ),

                secretCode:
                  newUser.secretCode,

                publicCode:
                  newUser.publicCode
              }
            );
          }

          /* -------------------------------------------------
             REJECT JOIN
          ------------------------------------------------- */

          if (
            action ===
              'reject_join' ||
            action ===
              'deny_join' ||
            action ===
              'reject'
          ) {
            if (
              !isChief(actor)
            ) {
              return no(
                cb,
                'رفض طلبات القبول متاح لـ CIA CHIEF فقط.'
              );
            }

            const request =
              state.cia_queue.find(
                (item) =>
                  item.id ===
                  targetId
              ) ||
              state.cia_queue.find(
                (item) =>
                  item.name ===
                  clean(
                    payload?.name,
                    120
                  )
              );

            if (!request) {
              return no(
                cb,
                'طلب القبول غير موجود.'
              );
            }

            state.cia_queue =
              state.cia_queue.filter(
                (item) =>
                  item.id !==
                  request.id
              );

            addAuditLog(
              'رفض عضو',
              actor,
              null,
              `تم رفض طلب ${request.name}.`
            );

            saveState();
            emitState();

            return ok(cb, {
              message:
                'تم رفض الطلب.'
            });
          }

          /* -------------------------------------------------
             CHANGE RANK
          ------------------------------------------------- */

          if (
            action ===
              'change_rank' ||
            action ===
              'set_rank'
          ) {
            if (!target) {
              return no(
                cb,
                'الشخصية المستهدفة غير موجودة.'
              );
            }

            const desiredRank =
              normalizeRank(
                payload?.rank
              );

            if (
              !canChangeRank(
                actor,
                target,
                desiredRank
              )
            ) {
              return no(
                cb,
                'لا تملك صلاحية تغيير رتبة هذه الشخصية.'
              );
            }

            const oldRank =
              normalizeRank(
                target.rank
              );

            target.rank =
              desiredRank;

            ensureBank(
              target
            );

            target.bank.salary =
              defaultSalaryForRank(
                desiredRank
              );

            addAuditLog(
              'تغيير رتبة',
              actor,
              target,
              `${rankLabel(oldRank)} → ${rankLabel(desiredRank)}`
            );

            saveState();
            emitState();

            return ok(
              cb,
              {
                user:
                  publicUser(
                    target,
                    actor
                  )
              }
            );
          }

          /* -------------------------------------------------
             CHANGE SECRET CODE
          ------------------------------------------------- */

          if (
            action ===
              'change_secret' ||
            action ===
              'change_code' ||
            action ===
              'reset_code'
          ) {
            if (!target) {
              return no(
                cb,
                'الشخصية غير موجودة.'
              );
            }

            if (
              !canChangeSecret(
                actor,
                target
              )
            ) {
              return no(
                cb,
                'لا تملك صلاحية تغيير كود هذه الشخصية.'
              );
            }

            const newCode =
              clean(
                payload?.secretCode ||
                payload?.code,
                100
              );

            const codeError =
              validateSecretCode(
                newCode,
                target
              );

            if (codeError) {
              return no(
                cb,
                codeError
              );
            }

            target.secretCode =
              newCode;

            addAuditLog(
              'تغيير كود الدخول',
              actor,
              target,
              'تم تغيير كود الدخول.'
            );

            saveState();
            emitState();

            return ok(
              cb,
              {
                user:
                  publicUser(
                    target,
                    actor
                  ),

                secretCode:
                  newCode
              }
            );
          }

          /* -------------------------------------------------
             SUSPEND
          ------------------------------------------------- */

          if (
            action ===
              'suspend' ||
            action ===
              'ban'
          ) {
            if (!target) {
              return no(
                cb,
                'الشخصية غير موجودة.'
              );
            }

            if (
              !canManageMember(
                actor,
                target
              )
            ) {
              return no(
                cb,
                'لا تملك صلاحية إيقاف هذه الشخصية.'
              );
            }

            target.suspended =
              true;

            target.activeService =
              false;

            target.online =
              false;

            target.radioOnline =
              false;

            const targetSessions =
              sessions.get(
                target.id
              );

            if (
              targetSessions
            ) {
              for (
                const socketId
                of targetSessions
              ) {
                const s =
                  io.sockets.sockets.get(
                    socketId
                  );

                if (s) {
                  s.emit(
                    'auth:forcedLogout',
                    {
                      reason:
                        'تم إيقاف الشخصية من الإدارة.'
                    }
                  );

                  s.disconnect(
                    true
                  );
                }
              }

              sessions.delete(
                target.id
              );
            }

            addAuditLog(
              'إيقاف شخصية',
              actor,
              target,
              'تم إيقاف الشخصية.'
            );

            saveState();
            emitState();

            return ok(cb, {
              user:
                publicUser(
                  target,
                  actor
                )
            });
          }

          /* -------------------------------------------------
             UNSUSPEND
          ------------------------------------------------- */

          if (
            action ===
              'unsuspend' ||
            action ===
              'unban'
          ) {
            if (!target) {
              return no(
                cb,
                'الشخصية غير موجودة.'
              );
            }

            if (
              !canManageMember(
                actor,
                target
              )
            ) {
              return no(
                cb,
                'لا تملك صلاحية إعادة تفعيل هذه الشخصية.'
              );
            }

            target.suspended =
              false;

            target.activeService =
              true;

            target.status =
              'في الخدمة';

            addAuditLog(
              'إعادة تفعيل شخصية',
              actor,
              target,
              'تمت إعادة تفعيل الشخصية.'
            );

            saveState();
            emitState();

            return ok(cb, {
              user:
                publicUser(
                  target,
                  actor
                )
            });
          }

          /* -------------------------------------------------
             DELETE USER
          ------------------------------------------------- */

          if (
            action ===
              'delete' ||
            action ===
              'delete_user' ||
            action ===
              'remove'
          ) {
            if (!target) {
              return no(
                cb,
                'الشخصية غير موجودة.'
              );
            }

            if (
              isChief(target)
            ) {
              return no(
                cb,
                'لا يمكن حذف CIA CHIEF.'
              );
            }

            if (
              !canManageMember(
                actor,
                target
              )
            ) {
              return no(
                cb,
                'لا تملك صلاحية حذف هذه الشخصية.'
              );
            }

            const oldName =
              target.name;

            const targetSessions =
              sessions.get(
                target.id
              );

            if (
              targetSessions
            ) {
              for (
                const socketId
                of targetSessions
              ) {
                const s =
                  io.sockets.sockets.get(
                    socketId
                  );

                if (s) {
                  s.emit(
                    'auth:forcedLogout',
                    {
                      reason:
                        'تم حذف الشخصية من النظام.'
                    }
                  );

                  s.disconnect(
                    true
                  );
                }
              }

              sessions.delete(
                target.id
              );
            }

            state.cia_users =
              state.cia_users.filter(
                (u) =>
                  u.id !==
                  target.id
              );

            addAuditLog(
              'حذف شخصية',
              actor,
              target,
              `تم حذف الشخصية ${oldName}.`
            );

            saveState();
            emitState();

            return ok(cb, {
              message:
                'تم حذف الشخصية.'
            });
          }

          /* -------------------------------------------------
             EDIT NAME / HOBBIES
          ------------------------------------------------- */

          if (
            action ===
              'edit_user' ||
            action ===
              'edit_profile'
          ) {
            if (!target) {
              return no(
                cb,
                'الشخصية غير موجودة.'
              );
            }

            if (
              !canManageMember(
                actor,
                target
              )
            ) {
              return no(
                cb,
                'لا تملك صلاحية تعديل هذه الشخصية.'
              );
            }

            if (
              payload?.name !==
              undefined
            ) {
              const newName =
                clean(
                  payload.name,
                  120
                );

              if (
                !newName
              ) {
                return no(
                  cb,
                  'اسم الشخصية لا يمكن أن يكون فارغاً.'
                );
              }

              const duplicate =
                state.cia_users.some(
                  (u) =>
                    u.id !== target.id &&
                    lower(u.name) ===
                      lower(newName)
                );

              if (duplicate) {
                return no(
                  cb,
                  'اسم الشخصية مستخدم بالفعل.'
                );
              }

              target.name =
                newName;
            }

            if (
              payload?.hobbies !==
              undefined
            ) {
              target.hobbies =
                clean(
                  payload.hobbies,
                  1000
                );
            }

            addAuditLog(
              'تعديل شخصية',
              actor,
              target,
              'تم تعديل بيانات الشخصية.'
            );

            saveState();
            emitState();

            return ok(cb, {
              user:
                publicUser(
                  target,
                  actor
                )
            });
          }

          return no(
            cb,
            'إجراء الإدارة غير معروف.'
          );
        } catch (error) {
          return no(
            cb,
            error.message ||
              'حدث خطأ في إجراء الإدارة.'
          );
        }
      }
    );

    /* =====================================================
       CHARACTER MANAGEMENT
    ===================================================== */

    socket.on(
      'character:create',
      (payload, cb) => {
        try {
          const actor =
            requireSocketUser(socket);

          if (!actor) {
            return no(
              cb,
              'يجب تسجيل الدخول.'
            );
          }

          const name =
            clean(
              payload?.name ||
              payload?.characterName,
              120
            );

          const characterType =
            clean(
              payload?.characterType ||
              payload?.type ||
              'main',
              50
            );

          if (!name) {
            return no(
              cb,
              'أدخل اسم الشخصية.'
            );
          }

          if (
            characterType ===
              'main' &&
            characterListForUser(
              actor
            ).some(
              (u) =>
                u.characterType ===
                'main'
            )
          ) {
            return no(
              cb,
              'لديك شخصية أساسية بالفعل.'
            );
          }

          if (
            state.cia_users.some(
              (u) =>
                lower(u.name) ===
                lower(name)
            )
          ) {
            return no(
              cb,
              'اسم الشخصية مستخدم بالفعل.'
            );
          }

          const character =
            normalizeUser({
              id:
                makeId('CHAR'),

              accountId:
                actor.accountId ||
                null,

              characterOwnerId:
                actor.characterOwnerId ||
                actor.id,

              characterType,

              name,

              secretCode:
                makeSecretCode(),

              publicCode:
                makePublicCode(
                  'AGENT'
                ),

              rank:
                'AGENT',

              approved:
                true,

              activeService:
                false,

              suspended:
                false,

              online:
                false,

              status:
                'غير مفعلة',

              identity:
                null,

              identityRequired:
                true,

              hobbies:
                '',

              bank: {
                balance:
                  0,

                salary:
                  defaultSalaryForRank(
                    'AGENT'
                  ),

                lastSalaryAt:
                  null,

                salaryClaimedToday:
                  false
              }
            });

          state.cia_character_queue.push({
            id:
              makeId('CHARREQ'),

            ownerId:
              actor.id,

            accountId:
              actor.accountId ||
              null,

            characterId:
              character.id,

            name:
              character.name,

            characterType,

            requestedAt:
              now(),

            status:
              'PENDING'
          });

          state.cia_users.push(
            character
          );

          addAuditLog(
            'إنشاء شخصية',
            actor,
            character,
            `تم إنشاء شخصية ${character.name} بانتظار التفعيل.`
          );

          saveState();
          emitState();

          return ok(
            cb,
            {
              user:
                publicUser(
                  character,
                  actor
                ),

              secretCode:
                character.secretCode,

              publicCode:
                character.publicCode,

              pending:
                true
            }
          );
        } catch (error) {
          return no(
            cb,
            error.message ||
              'تعذر إنشاء الشخصية.'
          );
        }
      }
    );

    socket.on(
      'character:activate',
      (payload, cb) => {
        try {
          const actor =
            requireSocketUser(socket);

          if (!actor) {
            return no(
              cb,
              'يجب تسجيل الدخول.'
            );
          }

          const characterId =
            clean(
              payload?.characterId ||
              payload?.id,
              100
            );

          const target =
            getUserById(
              characterId
            );

          if (!target) {
            return no(
              cb,
              'الشخصية غير موجودة.'
            );
          }

          const owner =
            target.characterOwnerId ===
              (
                actor.characterOwnerId ||
                actor.id
              ) ||
            target.accountId ===
              actor.accountId;

          if (
            !owner &&
            !isLeadership(actor)
          ) {
            return no(
              cb,
              'لا تملك صلاحية تفعيل هذه الشخصية.'
            );
          }

          target.activeService =
            true;

          target.approved =
            true;

          target.suspended =
            false;

          target.status =
            'في الخدمة';

          const request =
            state.cia_character_queue.find(
              (item) =>
                item.characterId ===
                target.id
            );

          if (request) {
            request.status =
              'APPROVED';
          }

          addAuditLog(
            'تفعيل شخصية',
            actor,
            target,
            'تم تفعيل الشخصية.'
          );

          saveState();
          emitState();

          return ok(cb, {
            user:
              publicUser(
                target,
                actor
              )
          });
        } catch (error) {
          return no(
            cb,
            error.message ||
              'تعذر تفعيل الشخصية.'
          );
        }
      }
    );

    socket.on(
      'character:delete',
      (payload, cb) => {
        try {
          const actor =
            requireSocketUser(socket);

          if (!actor) {
            return no(
              cb,
              'يجب تسجيل الدخول.'
            );
          }

          const characterId =
            clean(
              payload?.characterId ||
              payload?.id,
              100
            );

          const target =
            getUserById(
              characterId
            );

          if (!target) {
            return no(
              cb,
              'الشخصية غير موجودة.'
            );
          }

          const owner =
            target.characterOwnerId ===
              (
                actor.characterOwnerId ||
                actor.id
              ) ||
            target.accountId ===
              actor.accountId;

          if (
            !owner &&
            !isLeadership(actor)
          ) {
            return no(
              cb,
              'لا تملك صلاحية حذف هذه الشخصية.'
            );
          }

          if (
            isChief(target)
          ) {
            return no(
              cb,
              'لا يمكن حذف CIA CHIEF.'
            );
          }

          state.cia_users =
            state.cia_users.filter(
              (u) =>
                u.id !==
                target.id
            );

          state.cia_character_queue =
            state.cia_character_queue.filter(
              (item) =>
                item.characterId !==
                target.id
            );

          addAuditLog(
            'حذف شخصية',
            actor,
            target,
            'تم حذف الشخصية.'
          );

          saveState();
          emitState();

          return ok(cb, {
            message:
              'تم حذف الشخصية.'
          });
        } catch (error) {
          return no(
            cb,
            error.message ||
              'تعذر حذف الشخصية.'
          );
        }
      }
    );

    /* =====================================================
       BANK
    ===================================================== */

    socket.on(
      'bank:get',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const requestedCode =
          clean(
            payload?.code ||
            payload?.publicCode,
            100
          );

        let target =
          requestedCode
            ? getUserByPublicCode(
                requestedCode
              )
            : actor;

        if (!target) {
          target = actor;
        }

        if (
          target.id !== actor.id &&
          !canManageBank(
            actor,
            target
          )
        ) {
          return no(
            cb,
            'لا تملك صلاحية عرض هذا الحساب.'
          );
        }

        ensureBank(target);

        return ok(
          cb,
          {
            bank:
              bankView(
                target,
                actor
              ),

            users:
              isLeadership(actor) ||
              isHighCommander(actor)
                ? state.cia_users.map(
                    (u) =>
                      bankView(
                        u,
                        actor
                      )
                  )
                : []
          }
        );
      }
    );

    socket.on(
      'bank:claimSalary',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const amount =
          dailySalary(
            actor
          );

        if (
          amount === null
        ) {
          ensureBank(actor);

          if (
            actor.bank.frozen
          ) {
            return no(
              cb,
              'الحساب البنكي مجمد.'
            );
          }

          if (
            actor.bank.salaryEnabled ===
            false
          ) {
            return no(
              cb,
              'الراتب متوقف.'
            );
          }

          return no(
            cb,
            'تم صرف الراتب مسبقاً أو لا يمكن صرفه حالياً.'
          );
        }

        saveState();
        emitState();

        return ok(
          cb,
          {
            amount,

            balance:
              actor.bank.balance,

            bank:
              bankView(
                actor,
                actor
              )
          }
        );
      }
    );

    socket.on(
      'bank:setRankSalary',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const rank =
          normalizeRank(
            payload?.rank
          );

        const amount =
          parseMoney(
            payload?.salary ??
            payload?.amount
          );

        if (
          !Number.isFinite(
            amount
          ) ||
          amount < 0
        ) {
          return no(
            cb,
            'قيمة الراتب غير صحيحة.'
          );
        }

        if (
          !canSetRankSalary(
            actor,
            rank
          )
        ) {
          return no(
            cb,
            'لا تملك صلاحية تعديل راتب هذه الرتبة.'
          );
        }

        state.settings.rankSalaries[
          rank
        ] =
          Math.floor(
            amount
          );

        for (
          const user
          of state.cia_users
        ) {
          if (
            normalizeRank(
              user.rank
            ) === rank
          ) {
            ensureBank(user);

            user.bank.salary =
              Math.floor(
                amount
              );
          }
        }

        addAuditLog(
          'تعديل راتب رتبة',
          actor,
          null,
          `${rankLabel(rank)} = ${Math.floor(amount)}`
        );

        saveState();
        emitState();

        return ok(
          cb,
          {
            rank,
            salary:
              Math.floor(
                amount
              )
          }
        );
      }
    );

    socket.on(
      'bank:setSalary',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const target =
          getUserByPublicCode(
            payload?.publicCode ||
            payload?.code
          );

        if (!target) {
          return no(
            cb,
            'الشخصية غير موجودة.'
          );
        }

        const amount =
          parseMoney(
            payload?.salary
          );

        if (
          !Number.isFinite(
            amount
          ) ||
          amount < 0
        ) {
          return no(
            cb,
            'قيمة الراتب غير صحيحة.'
          );
        }

        if (
          !canSetSalary(
            actor,
            target
          )
        ) {
          return no(
            cb,
            'لا تملك صلاحية تعديل راتب هذه الشخصية.'
          );
        }

        ensureBank(target);

        target.bank.salary =
          Math.floor(
            amount
          );

        state.settings.rankSalaries[
          normalizeRank(
            target.rank
          )
        ] =
          Math.floor(
            amount
          );

        addAuditLog(
          'تعديل راتب شخصية',
          actor,
          target,
          `تم تحديد الراتب إلى ${Math.floor(amount)}.`
        );

        saveState();
        emitState();

        return ok(
          cb,
          {
            user:
              publicUser(
                target,
                actor
              ),

            salary:
              Math.floor(
                amount
              )
          }
        );
      }
    );

    socket.on(
      'bank:deposit',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const target =
          getUserByPublicCode(
            payload?.publicCode ||
            payload?.code
          ) || actor;

        const amount =
          parseMoney(
            payload?.amount
          );

        if (
          !Number.isFinite(
            amount
          ) ||
          amount <= 0
        ) {
          return no(
            cb,
            'قيمة الإيداع غير صحيحة.'
          );
        }

        if (
          target.id !== actor.id &&
          !canDepositBank(
            actor,
            target
          )
        ) {
          return no(
            cb,
            'لا تملك صلاحية الإيداع لهذا الحساب.'
          );
        }

        ensureBank(target);

        target.bank.balance +=
          Math.floor(
            amount
          );

        addAuditLog(
          'إيداع بنكي',
          actor,
          target,
          `تم إيداع ${Math.floor(amount)}.`
        );

        saveState();
        emitState();

        return ok(
          cb,
          {
            bank:
              bankView(
                target,
                actor
              )
          }
        );
      }
    );

    socket.on(
      'bank:withdraw',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const target =
          getUserByPublicCode(
            payload?.publicCode ||
            payload?.code
          ) || actor;

        const amount =
          parseMoney(
            payload?.amount
          );

        if (
          !Number.isFinite(
            amount
          ) ||
          amount <= 0
        ) {
          return no(
            cb,
            'قيمة السحب غير صحيحة.'
          );
        }

        if (
          target.id !== actor.id &&
          !canManageBank(
            actor,
            target
          )
        ) {
          return no(
            cb,
            'لا تملك صلاحية السحب من هذا الحساب.'
          );
        }

        ensureBank(target);

        if (
          target.bank.frozen
        ) {
          return no(
            cb,
            'الحساب البنكي مجمد.'
          );
        }

        if (
          target.bank.balance <
          amount
        ) {
          return no(
            cb,
            'الرصيد غير كافٍ.'
          );
        }

        target.bank.balance -=
          Math.floor(
            amount
          );

        addAuditLog(
          'سحب بنكي',
          actor,
          target,
          `تم سحب ${Math.floor(amount)}.`
        );

        saveState();
        emitState();

        return ok(
          cb,
          {
            bank:
              bankView(
                target,
                actor
              )
          }
        );
      }
    );

    socket.on(
      'bank:freeze',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const target =
          getUserByPublicCode(
            payload?.publicCode ||
            payload?.code
          );

        if (!target) {
          return no(
            cb,
            'الشخصية غير موجودة.'
          );
        }

        if (
          !canManageBank(
            actor,
            target
          )
        ) {
          return no(
            cb,
            'لا تملك صلاحية تجميد هذا الحساب.'
          );
        }

        ensureBank(target);

        target.bank.frozen =
          payload?.frozen !== false;

        addAuditLog(
          target.bank.frozen
            ? 'تجميد حساب بنكي'
            : 'فك تجميد حساب بنكي',
          actor,
          target,
          ''
        );

        saveState();
        emitState();

        return ok(
          cb,
          {
            bank:
              bankView(
                target,
                actor
              )
          }
        );
      }
    );

    socket.on(
      'bank:toggleSalary',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const target =
          getUserByPublicCode(
            payload?.publicCode ||
            payload?.code
          );

        if (!target) {
          return no(
            cb,
            'الشخصية غير موجودة.'
          );
        }

        if (
          !canManageBank(
            actor,
            target
          )
        ) {
          return no(
            cb,
            'لا تملك صلاحية التحكم براتب هذه الشخصية.'
          );
        }

        ensureBank(target);

        target.bank.salaryEnabled =
          payload?.enabled !== false;

        addAuditLog(
          target.bank.salaryEnabled
            ? 'تفعيل راتب'
            : 'إيقاف راتب',
          actor,
          target,
          ''
        );

        saveState();
        emitState();

        return ok(
          cb,
          {
            bank:
              bankView(
                target,
                actor
              )
          }
        );
      }
    );

    /* =====================================================
       MAP — NORMAL GTA LOCATION
    ===================================================== */

    socket.on(
      'map:setLocation',
      (payload, cb) => {
        try {
          const actor =
            requireSocketUser(socket);

          if (!actor) {
            return no(
              cb,
              'يجب تسجيل الدخول لتحديد موقعك.'
            );
          }

          const x =
            Number(
              payload?.x
            );

          const y =
            Number(
              payload?.y
            );

          if (
            !Number.isFinite(x) ||
            !Number.isFinite(y)
          ) {
            return no(
              cb,
              'إحداثيات الموقع غير صحيحة.'
            );
          }

          if (
            !state.cia_map_locations ||
            typeof state.cia_map_locations !==
              'object'
          ) {
            state.cia_map_locations = {};
          }

          const code =
            actor.publicCode;

          state.cia_map_locations[
            code
          ] = {
            x,
            y,

            name:
              actor.name,

            rank:
              normalizeRank(
                actor.rank
              ),

            rankLabel:
              rankLabel(
                actor.rank
              ),

            radioChannel:
              actor.radioChannel ||
              'CH-1',

            radioOnline:
              !!actor.radioOnline,

            updatedAt:
              now()
          };

          saveState();

          io.emit(
            'shared:data:update',
            {
              key:
                'cia_map_locations',

              value:
                state.cia_map_locations
            }
          );

          return ok(
            cb,
            {
              location:
                state.cia_map_locations[
                  code
                ],

              locations:
                state.cia_map_locations
            }
          );
        } catch (error) {
          return no(
            cb,
            error.message ||
              'تعذر حفظ موقعك.'
          );
        }
      }
    );

    socket.on(
      'map:removeLocation',
      (payload, cb) => {
        try {
          const actor =
            requireSocketUser(socket);

          if (!actor) {
            return no(
              cb,
              'يجب تسجيل الدخول.'
            );
          }

          const requestedCode =
            clean(
              payload?.code ||
              payload?.publicCode,
              100
            );

          const targetCode =
            requestedCode ||
            actor.publicCode;

          if (
            targetCode !==
              actor.publicCode &&
            !canRemoveAnyMapLocation(
              actor
            )
          ) {
            return no(
              cb,
              'لا تملك صلاحية إزالة هذا الموقع.'
            );
          }

          removeMapLocationByCode(
            targetCode
          );

          saveState();

          io.emit(
            'shared:data:update',
            {
              key:
                'cia_map_locations',

              value:
                state.cia_map_locations
            }
          );

          return ok(
            cb,
            {
              locations:
                state.cia_map_locations
            }
          );
        } catch (error) {
          return no(
            cb,
            error.message ||
              'تعذر إزالة الموقع.'
          );
        }
      }
    );

    socket.on(
      'map:listLocations',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        return ok(
          cb,
          {
            locations:
              state.cia_map_locations ||
              {}
          }
        );
      }
    );

    /* =====================================================
       RADIO
    ===================================================== */

    socket.on(
      'radio:join',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const channel =
          clean(
            payload?.channel ||
            actor.radioChannel ||
            'CH-1',
            50
          );

        removeRadioMember(
          socket.id
        );

        addRadioMember(
          channel,
          socket.id
        );

        actor.radioChannel =
          channel;

        actor.radioOnline =
          true;

        saveState();
        emitState();

        return ok(
          cb,
          {
            channel
          }
        );
      }
    );

    socket.on(
      'radio:leave',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        removeRadioMember(
          socket.id
        );

        actor.radioOnline =
          false;

        saveState();
        emitState();

        return ok(cb, {
          message:
            'تم الخروج من القناة.'
        });
      }
    );

    socket.on(
      'radio:setChannel',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const channel =
          clean(
            payload?.channel,
            50
          );

        if (!channel) {
          return no(
            cb,
            'القناة غير صحيحة.'
          );
        }

        removeRadioMember(
          socket.id
        );

        addRadioMember(
          channel,
          socket.id
        );

        actor.radioChannel =
          channel;

        actor.radioOnline =
          true;

        saveState();
        emitState();

        return ok(
          cb,
          {
            channel
          }
        );
      }
    );

    socket.on(
      'radio:message',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const channel =
          clean(
            payload?.channel ||
            actor.radioChannel ||
            'CH-1',
            50
          );

        const message =
          clean(
            payload?.message ||
            payload?.text,
            2000
          );

        if (!message) {
          return no(
            cb,
            'الرسالة فارغة.'
          );
        }

        const packet = {
          id:
            makeId('RADIO'),

          channel,

          fromCode:
            actor.publicCode,

          fromRank:
            rankLabel(
              actor.rank
            ),

          text:
            message,

          at:
            now()
        };

        for (
          const socketId
          of radioTargets(channel)
        ) {
          const targetSocket =
            io.sockets.sockets.get(
              socketId
            );

          if (
            targetSocket
          ) {
            targetSocket.emit(
              'radio:message',
              packet
            );
          }
        }

        return ok(cb, {
          message:
            packet
        });
      }
    );

    /* =====================================================
       SOS — BROADCAST
    ===================================================== */

    socket.on(
      'sos:broadcast',
      (payload, cb) => {
        try {
          const actor =
            requireSocketUser(socket);

          if (!actor) {
            return no(
              cb,
              'يجب تسجيل الدخول لإرسال S.O.S.'
            );
          }

          const locationRaw =
            payload?.location;

          let location =
            null;

          let locationCoords =
            null;

          if (
            locationRaw &&
            typeof locationRaw ===
              'object'
          ) {
            const lat =
              Number(
                locationRaw.lat
              );

            const lng =
              Number(
                locationRaw.lng
              );

            const x =
              Number(
                locationRaw.x ??
                locationRaw.lng
              );

            const y =
              Number(
                locationRaw.y ??
                locationRaw.lat
              );

            location = {
              lat:
                Number.isFinite(lat)
                  ? lat
                  : null,

              lng:
                Number.isFinite(lng)
                  ? lng
                  : null,

              label:
                clean(
                  locationRaw.label ||
                  locationRaw.name ||
                  '',
                  500
                )
            };

            if (
              Number.isFinite(x) &&
              Number.isFinite(y)
            ) {
              locationCoords = {
                x,
                y
              };
            }
          } else if (
            locationRaw
          ) {
            location = {
              lat: null,
              lng: null,

              label:
                clean(
                  locationRaw,
                  500
                )
            };
          }

          if (
            !locationCoords &&
            payload?.locationCoords &&
            typeof payload.locationCoords ===
              'object'
          ) {
            const x =
              Number(
                payload.locationCoords.x
              );

            const y =
              Number(
                payload.locationCoords.y
              );

            if (
              Number.isFinite(x) &&
              Number.isFinite(y)
            ) {
              locationCoords = {
                x,
                y
              };
            }
          }

          const countCandidates = [
            payload?.count,
            payload?.crewCount,
            payload?.membersCount
          ];

          let count = null;

          for (
            const candidate
            of countCandidates
          ) {
            if (
              candidate ===
              null ||
              candidate ===
              undefined ||
              candidate === ''
            ) {
              continue;
            }

            const parsed =
              Number(
                candidate
              );

            if (
              Number.isFinite(
                parsed
              )
            ) {
              count =
                Math.max(
                  0,
                  Math.floor(
                    parsed
                  )
                );

              break;
            }
          }

          const text =
            clean(
              payload?.text ||
              payload?.message ||
              '',
              4000
            );

          const status =
            clean(
              payload?.status ||
              payload?.dangerStatus ||
              '',
              200
            );

          const note =
            clean(
              payload?.note ||
              payload?.message ||
              '',
              2000
            );

          const alert = {
            id:
              makeId('SOS'),

            fromCode:
              actor.publicCode,

            fromRank:
              normalizeRank(
                actor.rank
              ),

            rankLabel:
              rankLabel(
                actor.rank
              ),

            rank:
              rankLabel(
                actor.rank
              ),

            location,

            locationCoords,

            count,

            crewCount:
              count,

            membersCount:
              count,

            status:
              status ||
              'OPEN',

            note,

            statusCode:
              'OPEN',

            userCode:
              actor.publicCode,

            text,

            createdAt:
              now(),

            at:
              now(),

            senderName:
              actor.name
          };

          state.cia_sos.unshift(
            alert
          );

          state.cia_sos =
            state.cia_sos.slice(
              0,
              500
            );

          addAuditLog(
            'S.O.S',
            actor,
            null,
            `تم إرسال بلاغ استغاثة ${alert.id}.`
          );

          saveState();

          io.emit(
            'sos:alert',
            alert
          );

          emitState();

          return ok(
            cb,
            {
              alert
            }
          );
        } catch (error) {
          return no(
            cb,
            error.message ||
              'تعذر إرسال بلاغ S.O.S.'
          );
        }
      }
    );

    /* =====================================================
       SOS — DELETE
    ===================================================== */

    socket.on(
      'sos:delete',
      (payload, cb) => {
        try {
          const actor =
            requireSocketUser(socket);

          if (!actor) {
            return no(
              cb,
              'يجب تسجيل الدخول.'
            );
          }

          if (
            !(
              isChief(actor) ||
              isSenior(actor) ||
              isHighCommander(actor)
            )
          ) {
            return no(
              cb,
              'حذف بلاغات الاستغاثة متاح للقيادة فقط.'
            );
          }

          const id =
            clean(
              payload?.id ||
              payload?.sosId,
              200
            );

          if (!id) {
            return no(
              cb,
              'معرف البلاغ غير موجود.'
            );
          }

          const exists =
            state.cia_sos.some(
              (alert) =>
                String(alert.id) ===
                String(id)
            );

          if (!exists) {
            return no(
              cb,
              'بلاغ الاستغاثة غير موجود.'
            );
          }

          state.cia_sos =
            state.cia_sos.filter(
              (alert) =>
                String(alert.id) !==
                String(id)
            );

          addAuditLog(
            'حذف S.O.S',
            actor,
            null,
            `تم حذف البلاغ ${id}.`
          );

          saveState();

          io.emit(
            'sos:deleted',
            {
              id
            }
          );

          emitState();

          return ok(
            cb,
            {
              id
            }
          );
        } catch (error) {
          return no(
            cb,
            error.message ||
              'تعذر حذف بلاغ الاستغاثة.'
          );
        }
      }
    );

    /* =====================================================
       SOS STATUS
    ===================================================== */

    socket.on(
      'sos:updateStatus',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const id =
          clean(
            payload?.id ||
            payload?.sosId,
            200
          );

        const alert =
          state.cia_sos.find(
            (item) =>
              String(item.id) ===
              String(id)
          );

        if (!alert) {
          return no(
            cb,
            'بلاغ الاستغاثة غير موجود.'
          );
        }

        if (
          !(
            isChief(actor) ||
            isSenior(actor) ||
            isHighCommander(actor)
          )
        ) {
          return no(
            cb,
            'لا تملك صلاحية تحديث حالة البلاغ.'
          );
        }

        const newStatus =
          clean(
            payload?.status ||
            'OPEN',
            100
          );

        alert.status =
          newStatus;

        alert.statusCode =
          newStatus;

        alert.updatedAt =
          now();

        addAuditLog(
          'تحديث S.O.S',
          actor,
          null,
          `${id} → ${newStatus}`
        );

        saveState();

        io.emit(
          'sos:updated',
          alert
        );

        emitState();

        return ok(
          cb,
          {
            alert
          }
        );
      }
    );

    /* =====================================================
       GLOBAL CHAT
    ===================================================== */

    socket.on(
      'chat:global',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const text =
          clean(
            payload?.text ||
            payload?.message,
            4000
          );

        if (!text) {
          return no(
            cb,
            'الرسالة فارغة.'
          );
        }

        const message = {
          id:
            makeId('CHAT'),

          fromCode:
            actor.publicCode,

          fromRank:
            rankLabel(
              actor.rank
            ),

          text,

          at:
            now()
        };

        state.cia_chats.global.push(
          message
        );

        state.cia_chats.global =
          state.cia_chats.global.slice(
            -1000
          );

        saveState();

        io.emit(
          'chat:global',
          message
        );

        return ok(
          cb,
          {
            message
          }
        );
      }
    );

    /* =====================================================
       PRIVATE CHAT
    ===================================================== */

    socket.on(
      'chat:private',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const targetCode =
          clean(
            payload?.targetCode ||
            payload?.toCode,
            100
          );

        const text =
          clean(
            payload?.text ||
            payload?.message,
            4000
          );

        if (
          !targetCode ||
          !text
        ) {
          return no(
            cb,
            'بيانات المحادثة غير مكتملة.'
          );
        }

        const target =
          getUserByPublicCode(
            targetCode
          );

        if (!target) {
          return no(
            cb,
            'المستخدم المستهدف غير موجود.'
          );
        }

        const key =
          chatKey(
            actor.publicCode,
            target.publicCode
          );

        if (
          !state.cia_chats.private[key]
        ) {
          state.cia_chats.private[key] =
            [];
        }

        const message = {
          id:
            makeId('PCHAT'),

          fromCode:
            actor.publicCode,

          toCode:
            target.publicCode,

          fromName:
            isLeadership(actor)
              ? actor.name
              : null,

          text,

          at:
            now()
        };

        state.cia_chats.private[key].push(
          message
        );

        state.cia_chats.private[key] =
          state.cia_chats.private[key].slice(
            -500
          );

        saveState();

        const targetSockets =
          sessions.get(
            target.id
          );

        if (
          targetSockets
        ) {
          for (
            const socketId
            of targetSockets
          ) {
            const targetSocket =
              io.sockets.sockets.get(
                socketId
              );

            if (
              targetSocket
            ) {
              targetSocket.emit(
                'chat:private',
                message
              );
            }
          }
        }

        socket.emit(
          'chat:private',
          message
        );

        return ok(
          cb,
          {
            message
          }
        );
      }
    );

    /* =====================================================
       REPORTS
    ===================================================== */

    socket.on(
      'report:create',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const report = {
          id:
            makeId('REPORT'),

          title:
            clean(
              payload?.title ||
              'تقرير CIA',
              200
            ),

          type:
            clean(
              payload?.type ||
              'GENERAL',
              100
            ),

          text:
            clean(
              payload?.text ||
              payload?.description ||
              '',
              10000
            ),

          status:
            clean(
              payload?.status ||
              'OPEN',
              100
            ),

          fromCode:
            actor.publicCode,

          fromRank:
            rankLabel(
              actor.rank
            ),

          createdAt:
            now(),

          immutable:
            true
        };

        if (!report.text) {
          return no(
            cb,
            'التقرير فارغ.'
          );
        }

        state.cia_reports.unshift(
          report
        );

        state.cia_reports =
          state.cia_reports.slice(
            0,
            1000
          );

        addAuditLog(
          'إنشاء تقرير',
          actor,
          null,
          `تم إنشاء التقرير ${report.id}.`
        );

        saveState();

        io.emit(
          'report:new',
          report
        );

        emitState();

        return ok(
          cb,
          {
            report
          }
        );
      }
    );

    socket.on(
      'report:update',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const id =
          clean(
            payload?.id,
            200
          );

        const report =
          state.cia_reports.find(
            (r) =>
              String(r.id) ===
              String(id)
          );

        if (!report) {
          return no(
            cb,
            'التقرير غير موجود.'
          );
        }

        if (
          !(
            isLeadership(actor) ||
            report.fromCode ===
              actor.publicCode
          )
        ) {
          return no(
            cb,
            'لا تملك صلاحية تعديل هذا التقرير.'
          );
        }

        if (
          payload?.status !==
          undefined
        ) {
          report.status =
            clean(
              payload.status,
              100
            );
        }

        if (
          payload?.text !==
          undefined
        ) {
          report.text =
            clean(
              payload.text,
              10000
            );
        }

        report.updatedAt =
          now();

        addAuditLog(
          'تحديث تقرير',
          actor,
          null,
          `تم تحديث التقرير ${id}.`
        );

        saveState();

        io.emit(
          'report:update',
          report
        );

        emitState();

        return ok(
          cb,
          {
            report
          }
        );
      }
    );

    /* =====================================================
       CASES
    ===================================================== */

    socket.on(
      'case:create',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const title =
          clean(
            payload?.title ||
            'CIA CASE',
            200
          );

        const description =
          clean(
            payload?.description ||
            payload?.text ||
            '',
            10000
          );

        const caseItem = {
          id:
            makeId('CASE'),

          caseNumber:
            `CASE-${Date.now()}`,

          title,

          description,

          status:
            clean(
              payload?.status ||
              'OPEN',
              100
            ),

          classification:
            clean(
              payload?.classification ||
              'CONFIDENTIAL',
              100
            ),

          assignedCode:
            clean(
              payload?.assignedCode ||
              '',
              100
            ),

          createdByCode:
            actor.publicCode,

          createdByName:
            isLeadership(actor)
              ? actor.name
              : '',

          createdAt:
            now(),

          updatedAt:
            now()
        };

        state.cia_cases.unshift(
          caseItem
        );

        state.cia_cases =
          state.cia_cases.slice(
            0,
            1000
          );

        addAuditLog(
          'فتح قضية',
          actor,
          null,
          `تم فتح القضية ${caseItem.caseNumber}.`
        );

        saveState();

        io.emit(
          'case:new',
          caseItem
        );

        emitState();

        return ok(
          cb,
          {
            case:
              caseItem
          }
        );
      }
    );

    socket.on(
      'case:update',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const id =
          clean(
            payload?.id,
            200
          );

        const caseItem =
          state.cia_cases.find(
            (c) =>
              String(c.id) ===
              String(id)
          );

        if (!caseItem) {
          return no(
            cb,
            'القضية غير موجودة.'
          );
        }

        if (
          !(
            isLeadership(actor) ||
            caseItem.createdByCode ===
              actor.publicCode
          )
        ) {
          return no(
            cb,
            'لا تملك صلاحية تعديل هذه القضية.'
          );
        }

        if (
          payload?.title !==
          undefined
        ) {
          caseItem.title =
            clean(
              payload.title,
              200
            );
        }

        if (
          payload?.description !==
          undefined
        ) {
          caseItem.description =
            clean(
              payload.description,
              10000
            );
        }

        if (
          payload?.status !==
          undefined
        ) {
          caseItem.status =
            clean(
              payload.status,
              100
            );
        }

        if (
          payload?.classification !==
          undefined
        ) {
          caseItem.classification =
            clean(
              payload.classification,
              100
            );
        }

        if (
          payload?.assignedCode !==
          undefined
        ) {
          caseItem.assignedCode =
            clean(
              payload.assignedCode,
              100
            );
        }

        caseItem.updatedAt =
          now();

        addAuditLog(
          'تحديث قضية',
          actor,
          null,
          `تم تحديث القضية ${caseItem.caseNumber}.`
        );

        saveState();

        io.emit(
          'case:update',
          caseItem
        );

        emitState();

        return ok(
          cb,
          {
            case:
              caseItem
          }
        );
      }
    );

    /* =====================================================
       OPERATION / MISSIONS
    ===================================================== */

    socket.on(
      'operation:create',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        if (
          !(
            isLeadership(actor) ||
            isHighCommander(actor)
          )
        ) {
          return no(
            cb,
            'إنشاء العمليات متاح للقيادة.'
          );
        }

        const operation = {
          id:
            makeId('OP'),

          missionNumber:
            clean(
              payload?.missionNumber ||
              `OP-${Date.now()}`,
              100
            ),

          title:
            clean(
              payload?.title ||
              'CIA OPERATION',
              200
            ),

          type:
            clean(
              payload?.type ||
              'GENERAL',
              100
            ),

          risk:
            clean(
              payload?.risk ||
              'MEDIUM',
              100
            ),

          objective:
            clean(
              payload?.objective ||
              '',
              5000
            ),

          status:
            clean(
              payload?.status ||
              'PLANNED',
              100
            ),

          startLocation:
            payload?.startLocation ||
            null,

          endLocation:
            payload?.endLocation ||
            null,

          commanderCode:
            clean(
              payload?.commanderCode ||
              actor.publicCode,
              100
            ),

          commanderName:
            isLeadership(actor)
              ? actor.name
              : '',

          memberCodes:
            Array.isArray(
              payload?.memberCodes
            )
              ? payload.memberCodes
                  .map(
                    (x) =>
                      clean(
                        x,
                        100
                      )
                  )
                  .filter(Boolean)
              : [],

          notes: [],

          createdByCode:
            actor.publicCode,

          createdByName:
            isLeadership(actor)
              ? actor.name
              : '',

          createdAt:
            now(),

          updatedAt:
            now()
        };

        state.cia_operations.push(
          operation
        );

        addAuditLog(
          'إنشاء عملية',
          actor,
          null,
          `تم إنشاء العملية ${operation.missionNumber}.`
        );

        saveState();

        emitOperationState();

        return ok(
          cb,
          {
            operation:
              operationSanitize(
                operation,
                actor
              )
          }
        );
      }
    );

    socket.on(
      'operation:list',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        return ok(
          cb,
          {
            operations:
              state.cia_operations
                .map(
                  (op) =>
                    operationSanitize(
                      op,
                      actor
                    )
                )
                .filter(Boolean)
          }
        );
      }
    );

    socket.on(
      'operation:update',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        if (
          !(
            isLeadership(actor) ||
            isHighCommander(actor)
          )
        ) {
          return no(
            cb,
            'لا تملك صلاحية تعديل العمليات.'
          );
        }

        const id =
          clean(
            payload?.id,
            200
          );

        const operation =
          state.cia_operations.find(
            (op) =>
              String(op.id) ===
              String(id)
          );

        if (!operation) {
          return no(
            cb,
            'العملية غير موجودة.'
          );
        }

        const fields = [
          'missionNumber',
          'title',
          'type',
          'risk',
          'objective',
          'status',
          'commanderCode'
        ];

        for (
          const field
          of fields
        ) {
          if (
            payload?.[field] !==
            undefined
          ) {
            operation[field] =
              clean(
                payload[field],
                field ===
                  'objective'
                  ? 5000
                  : 500
              );
          }
        }

        if (
          payload?.startLocation !==
          undefined
        ) {
          operation.startLocation =
            payload.startLocation;
        }

        if (
          payload?.endLocation !==
          undefined
        ) {
          operation.endLocation =
            payload.endLocation;
        }

        if (
          Array.isArray(
            payload?.memberCodes
          )
        ) {
          operation.memberCodes =
            payload.memberCodes
              .map(
                (x) =>
                  clean(
                    x,
                    100
                  )
              )
              .filter(Boolean);
        }

        operation.updatedAt =
          now();

        addAuditLog(
          'تحديث عملية',
          actor,
          null,
          `تم تحديث العملية ${operation.missionNumber}.`
        );

        saveState();

        emitOperationState();

        return ok(
          cb,
          {
            operation:
              operationSanitize(
                operation,
                actor
              )
          }
        );
      }
    );

    socket.on(
      'operation:addNote',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        const id =
          clean(
            payload?.id,
            200
          );

        const operation =
          state.cia_operations.find(
            (op) =>
              String(op.id) ===
              String(id)
          );

        if (!operation) {
          return no(
            cb,
            'العملية غير موجودة.'
          );
        }

        const text =
          clean(
            payload?.text ||
            payload?.note,
            3000
          );

        if (!text) {
          return no(
            cb,
            'الملاحظة فارغة.'
          );
        }

        operation.notes =
          Array.isArray(
            operation.notes
          )
            ? operation.notes
            : [];

        operation.notes.push({
          at:
            now(),

          authorCode:
            actor.publicCode,

          authorName:
            isLeadership(actor)
              ? actor.name
              : '',

          text
        });

        operation.notes =
          operation.notes.slice(
            -200
          );

        operation.updatedAt =
          now();

        saveState();

        emitOperationState();

        return ok(
          cb,
          {
            operation:
              operationSanitize(
                operation,
                actor
              )
          }
        );
      }
    );

    socket.on(
      'operation:delete',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            'يجب تسجيل الدخول.'
          );
        }

        if (
          !isChief(actor)
        ) {
          return no(
            cb,
            'حذف العمليات متاح لـ CIA CHIEF فقط.'
          );
        }

        const id =
          clean(
            payload?.id,
            200
          );

        const exists =
          state.cia_operations.some(
            (op) =>
              String(op.id) ===
              String(id)
          );

        if (!exists) {
          return no(
            cb,
            'العملية غير موجودة.'
          );
        }

        state.cia_operations =
          state.cia_operations.filter(
            (op) =>
              String(op.id) !==
              String(id)
          );

        addAuditLog(
          'حذف عملية',
          actor,
          null,
          `تم حذف العملية ${id}.`
        );

        saveState();

        emitOperationState();

        return ok(
          cb,
          {
            id
          }
        );
      }
    );

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
      'disconnect',
      () => {
        removeRadioMember(
          socket.id
        );

        markLogout(socket);
      }
    );
  }
);

/* ---------------------------------------------------------
   START
--------------------------------------------------------- */

httpServer.listen(
  PORT,
  () => {
    console.log(
      `BLACK RIDGE CITY CIA SYSTEM running on http://localhost:${PORT}`
    );

    console.log(
      `Data file: ${DATA_FILE}`
    );
  }
);

process.on(
  'SIGINT',
  () => {
    try {
      saveState();
    } finally {
      process.exit(0);
    }
  }
);

process.on(
  'SIGTERM',
  () => {
    try {
      saveState();
    } finally {
      process.exit(0);
    }
  }
);
    saveState();
    const result = ok(cb, { action, user: publicUser(target, actor) });
    socket.emit('admin:member:result', result);
    emitState();
  });

  /* =====================================================
     BANK — SALARY BY RANK
  ===================================================== */

  socket.on('bank:get', (cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const directory = Object.values(state.users || {})
      .map((user) => {
        ensureBank(user);

        return {
          code: user.publicCode,
          name: user.name,
          rank: normalizeRank(user.rank),
          rankLabel: rankLabel(user.rank),
          salary: Number(user.bank?.salary || 0),
          balance: Number(user.bank?.balance || 0)
        };
      });

    ok(cb, {
      directory,
      rankSalaries: state.settings.rankSalaries || {}
    });
  });

  socket.on('bank:getAccount', (cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    ensureBank(actor);

    ok(cb, {
      code: actor.publicCode,
      name: actor.name,
      rank: normalizeRank(actor.rank),
      rankLabel: rankLabel(actor.rank),
      salary: Number(actor.bank?.salary || 0),
      balance: Number(actor.bank?.balance || 0),
      transactions: Array.isArray(actor.bank?.transactions)
        ? actor.bank.transactions
        : []
    });
  });

  socket.on('bank:setRankSalary', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const rank = normalizeRank(payload.rank);
    const amount = Number(payload.amount);

    if (!Number.isFinite(amount) || amount < 0) {
      return no(cb, 'قيمة الراتب غير صالحة.');
    }

    if (!canSetRankSalary(actor, rank)) {
      return no(cb, 'ليس لديك صلاحية تعديل راتب هذه الرتبة.');
    }

    if (!state.settings) {
      state.settings = {};
    }

    if (!state.settings.rankSalaries) {
      state.settings.rankSalaries = {};
    }

    state.settings.rankSalaries[rank] = amount;

    Object.values(state.users || {}).forEach((user) => {
      if (normalizeRank(user.rank) === rank) {
        ensureBank(user);
        user.bank.salary = amount;
      }
    });

    saveState();

    const result = ok(cb, {
      rank,
      rankLabel: rankLabel(rank),
      amount
    });

    socket.emit('bank:setRankSalary:result', result);
    emitState();
  });

  socket.on('bank:deposit', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    ensureBank(actor);

    const amount = Number(payload.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return no(cb, 'قيمة الإيداع غير صالحة.');
    }

    actor.bank.balance = Number(actor.bank.balance || 0) + amount;

    actor.bank.transactions.push({
      type: 'DEPOSIT',
      amount,
      timestamp: Date.now(),
      note: String(payload.note || 'إيداع')
    });

    saveState();

    ok(cb, {
      balance: actor.bank.balance
    });

    emitState();
  });

  socket.on('bank:withdraw', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    ensureBank(actor);

    const amount = Number(payload.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return no(cb, 'قيمة السحب غير صالحة.');
    }

    if (Number(actor.bank.balance || 0) < amount) {
      return no(cb, 'الرصيد غير كافٍ.');
    }

    actor.bank.balance -= amount;

    actor.bank.transactions.push({
      type: 'WITHDRAW',
      amount,
      timestamp: Date.now(),
      note: String(payload.note || 'سحب')
    });

    saveState();

    ok(cb, {
      balance: actor.bank.balance
    });

    emitState();
  });

  socket.on('bank:transfer', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    ensureBank(actor);

    const targetCode = String(
      payload.targetCode ||
      payload.code ||
      ''
    ).trim();

    const amount = Number(payload.amount);

    if (!targetCode) {
      return no(cb, 'أدخل كود المستلم.');
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return no(cb, 'قيمة التحويل غير صالحة.');
    }

    if (actor.publicCode === targetCode) {
      return no(cb, 'لا يمكنك التحويل لنفسك.');
    }

    const target = getUserByPublicCode(targetCode);

    if (!target) {
      return no(cb, 'المستخدم غير موجود.');
    }

    ensureBank(target);

    if (Number(actor.bank.balance || 0) < amount) {
      return no(cb, 'الرصيد غير كافٍ.');
    }

    actor.bank.balance -= amount;
    target.bank.balance = Number(target.bank.balance || 0) + amount;

    actor.bank.transactions.push({
      type: 'TRANSFER_OUT',
      amount,
      targetCode,
      timestamp: Date.now()
    });

    target.bank.transactions.push({
      type: 'TRANSFER_IN',
      amount,
      targetCode: actor.publicCode,
      timestamp: Date.now()
    });

    saveState();

    ok(cb, {
      balance: actor.bank.balance,
      targetCode
    });

    emitState();
  });

  /* =====================================================
     MAP — MILITARY LOCATION
  ===================================================== */

  socket.on('map:setLocation', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const x = Number(payload.x);
    const y = Number(payload.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return no(cb, 'إحداثيات الموقع غير صالحة.');
    }

    if (!state.cia_map_locations) {
      state.cia_map_locations = {};
    }

    state.cia_map_locations[actor.publicCode] = {
      x,
      y,
      name: actor.name,
      rank: normalizeRank(actor.rank),
      rankLabel: rankLabel(actor.rank),
      radioChannel: actor.radioChannel || null,
      radioOnline: Boolean(actor.radioOnline),
      updatedAt: Date.now()
    };

    saveState();

    ok(cb, {
      code: actor.publicCode,
      location: state.cia_map_locations[actor.publicCode]
    });

    emitState();
  });

  socket.on('map:removeLocation', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const targetCode = String(
      payload.code ||
      actor.publicCode ||
      ''
    ).trim();

    if (!targetCode) {
      return no(cb, 'كود العضو غير موجود.');
    }

    if (
      targetCode !== actor.publicCode &&
      !isLeadership(actor)
    ) {
      return no(cb, 'ليس لديك صلاحية حذف موقع هذا العضو.');
    }

    if (!state.cia_map_locations) {
      state.cia_map_locations = {};
    }

    delete state.cia_map_locations[targetCode];

    saveState();

    ok(cb, {
      code: targetCode
    });

    emitState();
  });

  socket.on('map:listLocations', (cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    ok(cb, {
      locations: state.cia_map_locations || {}
    });
  });

  /* =====================================================
     RADIO
  ===================================================== */

  socket.on('radio:setChannel', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const channel = String(
      payload.channel ||
      ''
    ).trim();

    if (!channel) {
      return no(cb, 'القناة غير صالحة.');
    }

    actor.radioChannel = channel;
    actor.radioOnline = true;

    saveState();

    ok(cb, {
      channel,
      online: true
    });

    emitState();
  });

  socket.on('radio:setOnline', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    actor.radioOnline = Boolean(payload.online);

    saveState();

    ok(cb, {
      online: actor.radioOnline
    });

    emitState();
  });

  /* =====================================================
     SOS
  ===================================================== */

  socket.on('sos:broadcast', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const location =
      payload.location &&
      typeof payload.location === 'object'
        ? payload.location
        : null;

    const rawCount =
      payload.count ??
      payload.crewCount ??
      payload.membersCount;

    const count =
      rawCount === null ||
      rawCount === undefined ||
      rawCount === ''
        ? null
        : Number(rawCount);

    const alertId =
      `SOS-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    const alert = {
      id: alertId,

      fromCode: actor.publicCode,
      userCode: actor.publicCode,

      fromRank: normalizeRank(actor.rank),
      rank: normalizeRank(actor.rank),
      rankLabel: rankLabel(actor.rank),

      location: location
        ? {
            lat: Number.isFinite(Number(location.lat))
              ? Number(location.lat)
              : null,

            lng: Number.isFinite(Number(location.lng))
              ? Number(location.lng)
              : null,

            label: String(
              location.label ||
              location.name ||
              ''
            )
          }
        : null,

      locationCoords: location
        ? {
            x: Number.isFinite(Number(location.lng))
              ? Number(location.lng)
              : null,

            y: Number.isFinite(Number(location.lat))
              ? Number(location.lat)
              : null
          }
        : null,

      count:
        Number.isFinite(count)
          ? count
          : null,

      crewCount:
        Number.isFinite(count)
          ? count
          : null,

      membersCount:
        Number.isFinite(count)
          ? count
          : null,

      status: String(
        payload.status ||
        'OPEN'
      ),

      statusCode: 'OPEN',

      note: String(
        payload.note ||
        payload.message ||
        ''
      ),

      text: String(
        payload.text ||
        payload.message ||
        ''
      ),

      createdAt: Date.now()
    };

    if (!Array.isArray(state.cia_sos)) {
      state.cia_sos = [];
    }

    state.cia_sos.push(alert);

    saveState();

    io.emit('sos:alert', alert);

    ok(cb, {
      alert
    });

    emitState();
  });

  socket.on('sos:list', (cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    ok(cb, {
      alerts: Array.isArray(state.cia_sos)
        ? state.cia_sos
        : []
    });
  });

  socket.on('sos:delete', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const rank = normalizeRank(actor.rank);

    if (
      rank !== 'CIA CHIEF' &&
      rank !== 'SUPREME COMMANDER' &&
      rank !== 'HIGH COMMANDER'
    ) {
      return no(cb, 'ليس لديك صلاحية حذف بلاغات الاستغاثة.');
    }

    const alertId = String(
      payload.id ||
      payload.alertId ||
      ''
    ).trim();

    if (!alertId) {
      return no(cb, 'رقم البلاغ غير موجود.');
    }

    if (!Array.isArray(state.cia_sos)) {
      state.cia_sos = [];
    }

    const before = state.cia_sos.length;

    state.cia_sos = state.cia_sos.filter(
      (alert) => String(alert.id) !== alertId
    );

    if (state.cia_sos.length === before) {
      return no(cb, 'البلاغ غير موجود.');
    }

    saveState();

    io.emit('sos:deleted', {
      id: alertId
    });

    ok(cb, {
      id: alertId
    });

    emitState();
  });

  /* =====================================================
     CHAT
  ===================================================== */

  socket.on('chat:send', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const text = String(
      payload.text ||
      payload.message ||
      ''
    ).trim();

    if (!text) {
      return no(cb, 'الرسالة فارغة.');
    }

    const message = {
      id:
        `MSG-${Date.now()}-${Math.floor(Math.random() * 10000)}`,

      code: actor.publicCode,
      name: actor.name,
      rank: normalizeRank(actor.rank),
      rankLabel: rankLabel(actor.rank),

      text,

      createdAt: Date.now()
    };

    if (!Array.isArray(state.chat)) {
      state.chat = [];
    }

    state.chat.push(message);

    if (state.chat.length > 500) {
      state.chat = state.chat.slice(-500);
    }

    saveState();

    io.emit('chat:message', message);

    ok(cb, {
      message
    });

    emitState();
  });

  socket.on('chat:list', (cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    ok(cb, {
      messages: Array.isArray(state.chat)
        ? state.chat
        : []
    });
  });

  /* =====================================================
     REPORTS
  ===================================================== */

  socket.on('report:create', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const report = {
      id:
        `RPT-${Date.now()}-${Math.floor(Math.random() * 10000)}`,

      fromCode: actor.publicCode,
      fromName: actor.name,

      title: String(
        payload.title ||
        'بلاغ'
      ),

      text: String(
        payload.text ||
        payload.message ||
        ''
      ),

      type: String(
        payload.type ||
        'GENERAL'
      ),

      status: 'OPEN',

      createdAt: Date.now()
    };

    if (!Array.isArray(state.reports)) {
      state.reports = [];
    }

    state.reports.push(report);

    saveState();

    io.emit('report:new', report);

    ok(cb, {
      report
    });

    emitState();
  });

  socket.on('report:list', (cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    ok(cb, {
      reports: Array.isArray(state.reports)
        ? state.reports
        : []
    });
  });

  socket.on('report:update', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    if (!isLeadership(actor)) {
      return no(cb, 'ليس لديك صلاحية تعديل البلاغات.');
    }

    const reportId = String(
      payload.id ||
      payload.reportId ||
      ''
    ).trim();

    const report = (state.reports || []).find(
      (item) => String(item.id) === reportId
    );

    if (!report) {
      return no(cb, 'البلاغ غير موجود.');
    }

    if (payload.status !== undefined) {
      report.status = String(payload.status);
    }

    if (payload.note !== undefined) {
      report.note = String(payload.note);
    }

    report.updatedAt = Date.now();

    saveState();

    io.emit('report:updated', report);

    ok(cb, {
      report
    });

    emitState();
  });

  /* =====================================================
     CASES
  ===================================================== */

  socket.on('case:create', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const caseItem = {
      id:
        `CASE-${Date.now()}-${Math.floor(Math.random() * 10000)}`,

      title: String(
        payload.title ||
        'قضية جديدة'
      ),

      description: String(
        payload.description ||
        payload.text ||
        ''
      ),

      createdBy: actor.publicCode,
      createdByName: actor.name,

      status: 'OPEN',

      createdAt: Date.now()
    };

    if (!Array.isArray(state.cases)) {
      state.cases = [];
    }

    state.cases.push(caseItem);

    saveState();

    io.emit('case:new', caseItem);

    ok(cb, {
      caseItem
    });

    emitState();
  });

  socket.on('case:list', (cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    ok(cb, {
      cases: Array.isArray(state.cases)
        ? state.cases
        : []
    });
  });

  socket.on('case:update', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    if (!isLeadership(actor)) {
      return no(cb, 'ليس لديك صلاحية تعديل القضايا.');
    }

    const caseId = String(
      payload.id ||
      payload.caseId ||
      ''
    ).trim();

    const caseItem = (state.cases || []).find(
      (item) => String(item.id) === caseId
    );

    if (!caseItem) {
      return no(cb, 'القضية غير موجودة.');
    }

    if (payload.status !== undefined) {
      caseItem.status = String(payload.status);
    }

    if (payload.title !== undefined) {
      caseItem.title = String(payload.title);
    }

    if (payload.description !== undefined) {
      caseItem.description = String(payload.description);
    }

    caseItem.updatedAt = Date.now();

    saveState();

    io.emit('case:updated', caseItem);

    ok(cb, {
      caseItem
    });

    emitState();
  });

  /* =====================================================
     OPERATIONS
  ===================================================== */

  socket.on('operation:create', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const operation = {
      id:
        `OP-${Date.now()}-${Math.floor(Math.random() * 10000)}`,

      title: String(
        payload.title ||
        'عملية جديدة'
      ),

      description: String(
        payload.description ||
        payload.text ||
        ''
      ),

      status: 'ACTIVE',

      createdBy: actor.publicCode,
      createdByName: actor.name,

      memberCodes: Array.isArray(payload.memberCodes)
        ? payload.memberCodes.map(String)
        : [],

      createdAt: Date.now()
    };

    if (!Array.isArray(state.operations)) {
      state.operations = [];
    }

    state.operations.push(operation);

    saveState();

    io.emit('operation:new', operation);

    ok(cb, {
      operation
    });

    emitState();
  });

  socket.on('operation:list', (cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    const leadership = isLeadership(actor);

    const operations = (state.operations || []).map((op) => {
      const crews = (
        Array.isArray(op.memberCodes)
          ? op.memberCodes
          : []
      ).map((code) => {
        const member = getUserByPublicCode(code);

        return leadership && member
          ? {
              code,
              name: member.name
            }
          : {
              code
            };
      });

      return {
        ...op,
        crews
      };
    });

    ok(cb, {
      operations
    });
  });

  socket.on('operation:update', (payload = {}, cb) => {
    const actor = getUserBySocket(socket.id);

    if (!actor) {
      return no(cb, 'غير مسجل دخول.');
    }

    if (!isLeadership(actor)) {
      return no(cb, 'ليس لديك صلاحية تعديل العمليات.');
    }

    const operationId = String(
      payload.id ||
      payload.operationId ||
      ''
    ).trim();

    const operation = (state.operations || []).find(
      (item) => String(item.id) === operationId
    );

    if (!operation) {
      return no(cb, 'العملية غير موجودة.');
    }

    if (payload.status !== undefined) {
      operation.status = String(payload.status);
    }

    if (payload.title !== undefined) {
      operation.title = String(payload.title);
    }

    if (payload.description !== undefined) {
      operation.description = String(payload.description);
    }

    if (Array.isArray(payload.memberCodes)) {
      operation.memberCodes =
        payload.memberCodes.map(String);
    }

    operation.updatedAt = Date.now();

    saveState();

    io.emit('operation:updated', operation);

    ok(cb, {
      operation
    });

    emitState();
  });

  /* =====================================================
     DISCONNECT
  ===================================================== */

  socket.on('disconnect', () => {
    const actor = getUserBySocket(socket.id);

    if (actor) {
      actor.online = false;
      actor.socketId = null;
      actor.lastSeen = Date.now();

      if (state.cia_map_locations?.[actor.publicCode]) {
        state.cia_map_locations[actor.publicCode].radioOnline = false;
      }

      saveState();
      emitState();
    }
  });
});

/* =====================================================
   HTTP SERVER START
===================================================== */

server.listen(PORT, () => {
  console.log('');
  console.log('==================================================');
  console.log(' BLACK RIDGE CITY CIA SYSTEM');
  console.log(` PORT: ${PORT}`);
  console.log(' STATUS: ONLINE');
  console.log(' LOGIN / LEADERSHIP / RADIO / SOS: READY');
  console.log('==================================================');
});

