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
  cia_support: [],
  cia_character_queue: [],
  cia_accounts: [],
  cia_chats: { global: [], private: {} },
  cia_sos: [],
  cia_reports: [],
  cia_cases: [],
  cia_map_locations: {},
  cia_morse_logs: [],
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
      'cia_support',
      'cia_sos', 'cia_reports', 'cia_cases', 'cia_hq_locations',
      'cia_morse_logs', 'cia_audit_logs', 'cia_attendance', 'cia_operations'
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
const pendingRequestSockets = new Map();
const supportThreadSockets = new Map();

const MISSION_DRAWING_COLORS = new Set([
  '#facc15',
  '#ef4444',
  '#111827',
  '#ffffff',
  '#a855f7'
]);

const MORSE_CODES = Object.freeze({"0":"-----","1":".----","2":"..---","3":"...--","4":"....-","5":".....","6":"-....","7":"--...","8":"---..","9":"----.","A":".-","B":"-...","C":"-.-.","D":"-..","E":".","F":"..-.","G":"--.","H":"....","I":"..","J":".---","K":"-.-","L":".-..","M":"--","N":"-.","O":"---","P":".--.","Q":"--.-","R":".-.","S":"...","T":"-","U":"..-","V":"...-","W":".--","X":"-..-","Y":"-.--","Z":"--..",".":".-.-.-",",":"--..--","?":"..--..","'":".----.","!":"-.-.--","/":"-..-.","(":"-.--.",")":"-.--.-","&":".-...",":":"---...",";":"-.-.-.","=":"-...-","+":".-.-.","-":"-....-","\"":".-..-.","$":"...-..-","@":".--.-."});
const MORSE_CHARACTERS = Object.fromEntries(Object.entries(MORSE_CODES).map(([character, code]) => [code, character]));

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

const isMorseSupervisor = (user) =>
  isChief(user) || isSenior(user) || isHighCommander(user);

const isLeadership = (user) =>
  isChief(user) || isSenior(user);

const canManageOperations = (user) =>
  !!user && rankLevel(user.rank) >= 2;

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

  // The banking identifier is the character's military code. Older records
  // may contain a generated BANK-* value; migrate them on first read.
  if (user.publicCode) user.bank.bankCode = user.publicCode;

  return user.bank;
}

function hasLinkedMilitaryBankCode(user) {
  if (!user) return false;
  const bank = ensureBank(user);
  return !!user.publicCode &&
    user.bankAccount === user.publicCode &&
    bank.bankCode === user.publicCode;
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
  user.serviceApproved = user.serviceApproved !== false;
  user.identityApprovalPending = user.identityApprovalPending === true;
  user.rejectionMessage = clean(user.rejectionMessage || '', 500);
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

    serviceApproved:
      user.serviceApproved !== false,

    identityApprovalPending:
      user.identityApprovalPending === true,

    rejectionMessage:
      self
        ? (user.rejectionMessage || '')
        : '',

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
      isLeadership(viewer)
        ? state.cia_queue.map((request) => {
            const account = request.accountId
              ? state.cia_accounts.find((item) => item.id === request.accountId)
              : null;
            const displayName = [
              request.name,
              request.characterName,
              request.requestedName,
              account?.pendingPrimary?.name
            ]
              .map((value) => clean(value, 120))
              .find((value) => value && !['unknown', 'غير معروف', 'unnamed'].includes(lower(value))) || '';
            return {
              ...request,
              name: displayName
            };
          })
        : [],

    cia_identity_queue:
      isLeadership(viewer)
        ? state.cia_users
            .filter((u) => u.identityApprovalPending === true)
            .map((u) => publicUser(u, viewer))
        : [],

    cia_character_queue:
      isChief(viewer)
        ? state.cia_character_queue
        : [],

    cia_support:
      isLeadership(viewer)
        ? (state.cia_support || [])
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

    cia_morse_logs:
      isMorseSupervisor(viewer)
        ? (state.cia_morse_logs || [])
        : [],

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
  const normalizedMessage = clean(message, 500);
  const loginMessage =
    normalizedMessage === 'يجب تسجيل الدخول.' ||
    normalizedMessage === 'يجب تسجيل الدخول أولاً.'
      ? 'يلزم تسجيل الدخول إلى الحساب أولاً. إذا كنت قد سجلت الدخول بالفعل، اضغط «تسجيل الدخول للخدمة» من بطاقة الحالة الميدانية؛ وإذا كانت هويتك بانتظار الاعتماد فانتظر موافقة القيادة.'
      : normalizedMessage;

  return reply(cb, {
    ok: false,
    message: loginMessage
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

function markLogin(socket, user, options = {}) {
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
  // Account login is deliberately separate from starting duty. During a
  // short Socket.IO reconnect, preserve an already active duty session.
  const resumeService =
    options.resumeService === true &&
    user.serviceApproved !== false &&
    user.activeService === true;
  if (!resumeService) {
    user.activeService = false;
    user.status = 'خارج الخدمة';
  }
  user.radioOnline = false;

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
    user.serviceApproved === false ||
    user.activeService === false
  ) {
    return null;
  }

  return user;
}

function requireAuthenticatedUser(socket) {
  const user =
    socket.userId
      ? getUserById(socket.userId)
      : null;

  if (!user || user.suspended) return null;
  return user;
}

function serviceError(cb, user) {
  if (!user) {
    return no(cb, 'يجب تسجيل الدخول أولاً.');
  }
  if (user.serviceApproved === false) {
    return no(cb, 'لا يمكنك تسجيل الدخول للخدمة قبل قبول الهوية من القيادة.');
  }
  if (user.activeService !== true) {
    return no(cb, 'يلزم تسجيل الدخول للخدمة أولاً.');
  }
  return null;
}

function socketRequirementMessage(socket) {
  const user = requireAuthenticatedUser(socket);
  if (!user) return 'يجب تسجيل الدخول أولاً.';
  if (user.serviceApproved === false) return 'لا يمكنك تسجيل الدخول للخدمة قبل قبول الهوية من القيادة.';
  if (user.activeService !== true) return 'يلزم تسجيل الدخول للخدمة أولاً.';
  return 'تعذر ربط الجلسة بالخادم؛ أعد الاتصال ثم حاول مجددًا.';
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

function emitRadioToChannel(channel, event, payload) {
  for (const socketId of radioTargets(channel)) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) targetSocket.emit(event, payload);
  }
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

  const chiefMissionViewer =
    isChief(viewer);

  const privilegedMissionViewer =
    canManageOperations(viewer);

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

      return chiefMissionViewer &&
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
        null,

      endLocation:
        null,

      missionLocation:
        null,

      mapMarkers: [],

      mapDrawings: [],

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

    mapMarkers: Array.isArray(op.mapMarkers)
      ? op.mapMarkers.slice(-200)
      : [],

    mapDrawings: Array.isArray(op.mapDrawings)
      ? op.mapDrawings.slice(-100)
      : [],

    commanderCode:
      op.commanderCode ||
      '',

    battalionLeaderCode:
      op.commanderCode ||
      '',

    commanderName:
      chiefMissionViewer
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
          chiefMissionViewer
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
      chiefMissionViewer
        ? (
            op.createdByName ||
            ''
          )
        : ''
  };
}

function canAnnotateOperation(actor, operation) {
  if (!actor || !operation) return false;
  return (
    canManageOperations(actor) ||
    actor.publicCode === operation.createdByCode ||
    actor.publicCode === operation.commanderCode ||
    (
      Array.isArray(operation.memberCodes) &&
      operation.memberCodes.includes(actor.publicCode)
    )
  );
}

function missionPoint(value) {
  const x = Number(value?.x ?? value?.lng);
  const y = Number(value?.y ?? value?.lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(0, Math.min(1000, x)),
    y: Math.max(0, Math.min(1000, y))
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

          const request = {
            id: makeId('JOIN'),
            accountId: account.id,
            name: characterName,
            characterName,
            initialCode: SYSTEM.memberRequestCode,
            requestedRank: 'AGENT',
            requestedAt: now(),
            status: 'PENDING'
          };
          state.cia_queue.push(request);
          pendingRequestSockets.set(request.id, socket.id);

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
                'تم إنشاء الحساب وإرسال طلب القبول إلى القيادة.'
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
            const rejected =
              state.cia_users.find(
                (candidate) =>
                  lower(candidate.name) === lower(name) &&
                  candidate.secretCode === code &&
                  candidate.rejectionMessage
              );
            const pending =
              state.cia_accounts.some(
                (a) =>
                  (a.status === 'PENDING_APPROVAL' || !a.status) &&
                  lower(
                    a.pendingPrimary?.name
                  ) ===
                  lower(name)
              );

            const message =
              rejected
                ? rejected.rejectionMessage
                : pending
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
            user,
            {
              resumeService:
                payload?.resumeService === true
            }
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
                  !user.identity,

                serviceApproved:
                  user.serviceApproved !== false,

                serviceRequired:
                  user.activeService !== true ||
                  user.serviceApproved === false
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
socket.on('member:saveIdentity', (payload, cb) => {
  try {
    const actor = requireAuthenticatedUser(socket);

    if (!actor) {
      return no(cb, 'يجب تسجيل الدخول أولاً.');
    }

    const x = payload?.identity || {};

    const identity = {
      fullName: clean(x.fullName, 160),
      birthDate: clean(x.birthDate, 30),
      nationality: clean(x.nationality, 80),
      height: clean(x.height, 40),
      bloodType: clean(x.bloodType, 20),
      occupation: clean(x.occupation, 120),
      notes: clean(x.notes, 1000)
    };

    if (!identity.fullName || !identity.birthDate || !identity.nationality) {
      return no(cb, 'الاسم الكامل وتاريخ الميلاد والجنسية إلزامية.');
    }

    actor.identity = identity;
    actor.identityRequired = false;
    if (!isLeadership(actor)) {
      actor.identityApprovalPending = true;
      actor.serviceApproved = false;
      actor.activeService = false;
      actor.status = 'بانتظار اعتماد الهوية';
    }

    saveState();

    addAuditLog(
      'اعتماد الهوية',
      actor,
      actor,
      isLeadership(actor)
        ? 'تم حفظ الهوية الأمنية للشخصية القيادية.'
        : 'تم حفظ الهوية وإرسال طلب اعتمادها إلى القيادة.'
    );

    const result = ok(cb, {
      user: publicUser(actor, actor)
    });

    socket.emit('identity:result', result);

    emitState();

    if (!isLeadership(actor)) {
      for (const targetSocket of io.sockets.sockets.values()) {
        const targetUser = targetSocket.userId
          ? getUserById(targetSocket.userId)
          : null;
        if (targetUser && isLeadership(targetUser)) {
          targetSocket.emit('identity:approval:new', {
            user: publicUser(actor, targetUser)
          });
        }
      }
    }

  } catch (error) {
    return no(
      cb,
      error.message || 'تعذر حفظ الهوية.'
    );
  }
});
    
    socket.on(
      'auth:me',
      (payload, cb) => {
        const user =
          requireAuthenticatedUser(socket);

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
          pendingRequestSockets.set(request.id, socket.id);

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
            requireAuthenticatedUser(socket);

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
              payload?.id ||
              payload?.requestId,
              100
            );

          const target =
            getUserById(
              targetId
            );

          /* -------------------------------------------------
             IDENTITY APPROVAL
          ------------------------------------------------- */

          if (
            action === 'approve_identity' ||
            action === 'accept_identity' ||
            action === 'reject_identity' ||
            action === 'deny_identity'
          ) {
            if (!isLeadership(actor)) {
              return no(cb, 'اعتماد الهويات متاح للقائد وSenior Commander CIA فقط.');
            }
            if (!target) {
              return no(cb, 'الشخصية المستهدفة غير موجودة.');
            }
            if (!target.identityApprovalPending) {
              return no(cb, 'لا يوجد طلب اعتماد هوية لهذه الشخصية.');
            }

            const rejecting =
              action === 'reject_identity' ||
              action === 'deny_identity';

            if (rejecting) {
              target.identityApprovalPending = false;
              target.serviceApproved = false;
              target.approved = false;
              target.activeService = false;
              target.online = false;
              target.status = 'مرفوضة';
              target.rejectionMessage =
                'تم رفضك. لأي استفسار قم بإرساله هنا، وسيصل إلى CIA CHIEF وSenior Commander CIA فقط.';
              addAuditLog('رفض الهوية', actor, target, target.rejectionMessage);
            } else {
              if (!target.secretCode) target.secretCode = makeSecretCode();
              if (!target.publicCode) target.publicCode = makePublicCode(target.rank);
              target.identityApprovalPending = false;
              target.serviceApproved = true;
              target.approved = true;
              target.rejectionMessage = '';
              target.status = 'خارج الخدمة';
              addAuditLog('اعتماد الهوية', actor, target, 'تم اعتماد الهوية من القيادة.');
            }

            saveState();
            emitState();

            for (const socketId of sessions.get(target.id) || []) {
              const targetSocket = io.sockets.sockets.get(socketId);
              if (targetSocket) {
                targetSocket.emit(rejecting ? 'identity:rejected' : 'identity:approved', {
                  ok: !rejecting,
                  message: rejecting
                    ? target.rejectionMessage
                    : 'تم اعتماد هويتك. سجّل الدخول للخدمة للمتابعة.',
                  secretCode: rejecting ? null : target.secretCode,
                  publicCode: rejecting ? null : target.publicCode
                });
              }
            }

            return ok(cb, {
              action: rejecting ? 'reject_identity' : 'approve_identity',
              user: publicUser(target, actor),
              message: rejecting
                ? target.rejectionMessage
                : 'تم اعتماد الهوية.',
              secretCode: rejecting ? null : target.secretCode,
              publicCode: rejecting ? null : target.publicCode
            });
          }

          /* -------------------------------------------------
             ACCEPT JOIN
          ------------------------------------------------- */

          if (
            action ===
              'accept_join' ||
            action ===
              'approve_join' ||
            action ===
              'accept' ||
            action ===
              'approve'
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

            const requestAccount = request.accountId
              ? state.cia_accounts.find((account) => account.id === request.accountId)
              : null;
            const requestedName = [
              request.name,
              request.characterName,
              request.requestedName,
              requestAccount?.pendingPrimary?.name,
              payload?.name
            ]
              .map((value) => clean(value, 120))
              .find((value) => value && !['unknown', 'غير معروف', 'unnamed'].includes(lower(value))) || '';
            if (!requestedName) {
              return no(cb, 'اسم الشخصية غير موجود في طلب القبول؛ حدّث الطلب قبل اعتماده.');
            }

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

            const requestedPublicCode =
              clean(
                payload?.publicCode,
                100
              );

            const publicCode =
              requestedPublicCode || makePublicCode(rank);

            if (
              !publicCode ||
              publicCode === 'PENDING' ||
              (
                state.cia_users.some(
                  (u) => u.publicCode === publicCode
                )
              )
            ) {
              return no(cb, 'الكود العسكري غير صالح أو مستخدم.');
            }

            const newUser =
              normalizeUser({
                id:
                  makeId('AGENT'),

                accountId:
                  request.accountId ||
                  payload?.accountId ||
                  null,

                characterOwnerId:
                  request.accountId ||
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
                  false,

                serviceApproved:
                  true,

                identityApprovalPending:
                  false,

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

            const account = request.accountId
              ? state.cia_accounts.find((a) => a.id === request.accountId)
              : null;
            if (account) {
              account.status = 'APPROVED';
              account.approvedAt = now();
              account.characterId = newUser.id;
              account.rejectionMessage = '';
              account.rejectedAt = null;
            }

            addAuditLog(
              'قبول عضو',
              actor,
              newUser,
              `تم قبول ${newUser.name} برتبة ${rankLabel(newUser.rank)}.`
            );

            saveState();
            emitState();

            const requesterSocketId = pendingRequestSockets.get(request.id);
            pendingRequestSockets.delete(request.id);
            const requesterSocket = requesterSocketId
              ? io.sockets.sockets.get(requesterSocketId)
              : null;
            if (requesterSocket) {
              requesterSocket.emit('member:approved', {
                ok: true,
                user: publicUser(newUser, newUser),
                secretCode: newUser.secretCode,
                publicCode: newUser.publicCode,
                message: 'تم قبولك. سجّل الدخول بكودك الشخصي لإكمال إنشاء هويتك.'
              });
            }

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

            const rejectionMessage = 'تم رفض طلب الانضمام. لأي استفسار، تواصل مع القيادة.';
            const rejectedAccount = request.accountId
              ? state.cia_accounts.find((account) => account.id === request.accountId)
              : null;
            if (rejectedAccount) {
              rejectedAccount.status = 'REJECTED';
              rejectedAccount.rejectionMessage = rejectionMessage;
              rejectedAccount.rejectedAt = now();
            }

            addAuditLog(
              'رفض عضو',
              actor,
              null,
              `تم رفض طلب ${request.name}.`
            );

            saveState();
            emitState();

            const requesterSocketId = pendingRequestSockets.get(request.id);
            pendingRequestSockets.delete(request.id);
            const requesterSocket = requesterSocketId
              ? io.sockets.sockets.get(requesterSocketId)
              : null;
            if (requesterSocket) {
              requesterSocket.emit('join:rejected', {
                ok: false,
                message: rejectionMessage
              });
            }

            return ok(cb, {
              message: rejectionMessage
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
       SELF / LEADERSHIP MANAGEMENT
    ===================================================== */

    socket.on('admin:updateSelf', (payload, cb) => {
      try {
        const actor = requireSocketUser(socket);
        if (!actor) return no(cb, 'يجب تسجيل الدخول.');

        if (payload?.secretCode !== undefined) {
          const secretCode = clean(payload.secretCode, 100);
          const error = validateSecretCode(secretCode, actor);
          if (error) return no(cb, error);
          actor.secretCode = secretCode;
        }
        if (payload?.publicCode !== undefined) {
          const publicCode = clean(payload.publicCode, 100);
          if (!publicCode || publicCode === 'PENDING') return no(cb, 'الكود العسكري غير صالح.');
          const duplicate = getUserByPublicCode(publicCode);
          if (duplicate && duplicate.id !== actor.id) return no(cb, 'الكود العسكري مستخدم من شخصية أخرى.');
          actor.publicCode = publicCode;
        }

        saveState();
        emitState();
        const result = ok(cb, { user: publicUser(actor, actor) });
        if (payload?.secretCode !== undefined) socket.emit('admin:chief-secret:result', result);
        else socket.emit('admin:member:result', { ...result, action: 'code' });
        return result;
      } catch (error) {
        return no(cb, error.message || 'تعذر تحديث بياناتك.');
      }
    });

    socket.on('admin:updateChiefProfile', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor || !isChief(actor)) return no(cb, 'هذه العملية متاحة لـ CIA CHIEF فقط.');
      actor.hobbies = clean(payload?.hobbies, 1000);
      saveState();
      emitState();
      const result = ok(cb, { user: publicUser(actor, actor) });
      socket.emit('admin:chief-profile:result', result);
      return result;
    });

    socket.on('leader:updateProfile', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor || !isLeadership(actor)) return no(cb, 'تعديل بيانات القيادة متاح للقيادة فقط.');
      const name = clean(payload?.name, 120);
      if (!name) return no(cb, 'اسم القائد لا يمكن أن يكون فارغاً.');
      const duplicate = state.cia_users.find(
        (user) => user.id !== actor.id && lower(user.name) === lower(name)
      );
      if (duplicate) return no(cb, 'اسم الشخصية مستخدم بالفعل.');
      actor.name = name;
      saveState();
      emitState();
      const result = ok(cb, { user: publicUser(actor, actor) });
      socket.emit('leader:profile:result', result);
      return result;
    });

    socket.on('leadership:handover', (payload, cb) => {
      try {
        const actor = requireSocketUser(socket);
        if (!actor || !isChief(actor)) return no(cb, 'تسليم القيادة متاح لـ CIA CHIEF فقط.');
        const targetCode = clean(payload?.targetCode || payload?.publicCode, 100);
        const target = getUserByPublicCode(targetCode);
        if (!target) return no(cb, 'الشخصية المستهدفة غير موجودة.');
        if (target.id === actor.id) return no(cb, 'لا يمكنك تسليم القيادة لنفسك.');
        if (target.suspended || target.activeService === false || target.approved === false) {
          return no(cb, 'لا يمكن تسليم القيادة لشخصية موقوفة أو غير معتمدة.');
        }

        target.rank = 'CIA CHIEF';
        actor.rank = 'SUPREME COMMANDER';
        ensureBank(target);
        ensureBank(actor);
        target.bank.salary = defaultSalaryForRank('CIA CHIEF');
        actor.bank.salary = defaultSalaryForRank('SUPREME COMMANDER');
        addAuditLog('تسليم القيادة', actor, target, `تم نقل منصب CIA CHIEF إلى ${target.name}.`);
        saveState();
        emitState();

        const result = ok(cb, {
          previousChief: publicUser(actor, actor),
          newChief: publicUser(target, target)
        });
        socket.emit('leader:handover:result', result);
        return result;
      } catch (error) {
        return no(cb, error.message || 'تعذر تسليم القيادة.');
      }
    });

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
       CHARACTER ACCOUNT UI ALIASES
    ===================================================== */

    socket.on('character:list', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
      const characters = characterListForUser(actor)
        .filter((user) => user.suspended !== true && !user.separatedAt)
        .map((user) => publicUser(user, actor));
      return ok(cb, {
        owner: { id: actor.characterOwnerId || actor.id, name: actor.name, accountId: actor.accountId || null },
        characters,
        limit: 10
      });
    });

    socket.on('character:request', (payload, cb) => {
      try {
        const actor = requireSocketUser(socket);
        if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
        const name = clean(payload?.requestedName || payload?.name || payload?.characterName, 120);
        if (!name) return no(cb, 'أدخل اسم الشخصية الجديدة.');

        const owned = characterListForUser(actor).filter((user) => user.suspended !== true && !user.separatedAt);
        if (owned.length >= 10) return no(cb, 'وصلت إلى الحد الأقصى للشخصيات في حسابك.');
        if (state.cia_users.some((user) => lower(user.name) === lower(name))) {
          return no(cb, 'اسم الشخصية مستخدم بالفعل.');
        }

        const direct = isLeadership(actor);
        const character = normalizeUser({
          id: makeId('CHAR'),
          accountId: actor.accountId || null,
          characterOwnerId: actor.characterOwnerId || actor.id,
          characterType: 'secondary',
          name,
          secretCode: makeSecretCode(),
          publicCode: makePublicCode('AGENT'),
          rank: 'AGENT',
          approved: true,
          activeService: direct,
          suspended: false,
          online: false,
          status: direct ? 'في الخدمة' : 'بانتظار اعتماد القيادة',
          identity: null,
          identityRequired: true,
          hobbies: '',
          bank: { balance: 0, salary: defaultSalaryForRank('AGENT'), lastSalaryAt: null, salaryClaimedToday: false }
        });
        state.cia_users.push(character);

        let request = null;
        if (!direct) {
          request = {
            id: makeId('CHARREQ'),
            ownerId: actor.id,
            accountId: actor.accountId || null,
            characterId: character.id,
            name: character.name,
            requestedName: character.name,
            characterType: character.characterType,
            requestedAt: now(),
            status: 'PENDING'
          };
          state.cia_character_queue.push(request);
        }

        addAuditLog(
          direct ? 'إنشاء شخصية قيادية' : 'طلب شخصية',
          actor,
          character,
          direct ? `تم إنشاء شخصية ${character.name} مباشرة للقائد.` : `تم تقديم طلب شخصية ${character.name}.`
        );
        saveState();
        emitState();

        const result = ok(cb, {
          direct,
          pending: !direct,
          user: publicUser(character, actor),
          secretCode: character.secretCode,
          publicCode: character.publicCode
        });
        if (direct) socket.emit('character:request:result', result);
        if (!direct) {
          io.emit('character:request:new', {
            ownerId: actor.id,
            ownerName: actor.name,
            requestedName: character.name
          });
        }
        return result;
      } catch (error) {
        return no(cb, error.message || 'تعذر إنشاء الشخصية.');
      }
    });

    socket.on('character:login', (payload, cb) => {
      try {
        const actor = requireSocketUser(socket);
        if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
        const characterId = clean(payload?.characterId || payload?.id, 120);
        const code = clean(payload?.characterCode || payload?.code, 100);
        const target = getUserById(characterId);
        if (!target) return no(cb, 'الشخصية غير موجودة.');

        const sameOwner =
          (target.accountId && actor.accountId && target.accountId === actor.accountId) ||
          target.characterOwnerId === (actor.characterOwnerId || actor.id);
        if (!sameOwner) return no(cb, 'لا تملك صلاحية الدخول إلى هذه الشخصية.');
        if (!target.approved || target.serviceApproved === false || target.suspended) {
          return no(cb, 'هذه الشخصية لم تعتمد أو تم إيقافها.');
        }
        if (
          code &&
          code !== target.secretCode &&
          code !== target.publicCode
        ) {
          return no(cb, 'كود الشخصية غير صحيح.');
        }

        markLogout(socket);
        markLogin(socket, target);
        const result = ok(cb, {
          user: publicUser(target, target),
          needsIdentity: target.identityRequired !== false && !target.identity
        });
        socket.emit('auth:login:result', result);
        emitState();
        return result;
      } catch (error) {
        return no(cb, error.message || 'تعذر تسجيل الدخول إلى الشخصية.');
      }
    });

    socket.on('character:admin:action', (payload, cb) => {
      try {
        const actor = requireSocketUser(socket);
        if (!actor || !isChief(actor)) return no(cb, 'اعتماد الشخصيات متاح لـ CIA CHIEF فقط.');
        const action = clean(payload?.action, 40).toLowerCase();
        const requestId = clean(payload?.requestId || payload?.id, 120);
        const request = state.cia_character_queue.find((item) => item.id === requestId);
        if (!request) return no(cb, 'طلب الشخصية غير موجود.');
        const target = getUserById(request.characterId);
        if (!target) return no(cb, 'الشخصية المطلوبة غير موجودة.');

        if (action === 'reject' || action === 'deny') {
          target.activeService = false;
          target.approved = false;
          target.status = 'مرفوضة';
          state.cia_character_queue = state.cia_character_queue.filter((item) => item.id !== request.id);
          saveState();
          emitState();
          const result = ok(cb, { action: 'reject', user: publicUser(target, actor) });
          io.emit('character:admin:result', result);
          return result;
        }
        if (action !== 'approve' && action !== 'accept') return no(cb, 'إجراء الشخصية غير معروف.');

        const publicCode = clean(payload?.publicCode, 100);
        if (!publicCode || publicCode === 'PENDING') return no(cb, 'كود الظهور العام مطلوب.');
        const duplicate = getUserByPublicCode(publicCode);
        if (duplicate && duplicate.id !== target.id) return no(cb, 'الكود العسكري مستخدم من شخصية أخرى.');

        target.publicCode = publicCode;
        target.approved = true;
        target.activeService = true;
        target.suspended = false;
        target.status = 'في الخدمة';
        state.cia_character_queue = state.cia_character_queue.filter((item) => item.id !== request.id);
        addAuditLog('اعتماد شخصية', actor, target, `تم اعتماد الشخصية ${target.name}.`);
        saveState();
        emitState();

        const result = ok(cb, {
          action: 'approve',
          user: publicUser(target, actor),
          secretCode: target.secretCode,
          publicCode: target.publicCode
        });
        for (const socketId of sessions.get(request.ownerId) || []) {
          const ownerSocket = io.sockets.sockets.get(socketId);
          if (ownerSocket) ownerSocket.emit('character:approved', result);
        }
        io.emit('character:admin:result', result);
        return result;
      } catch (error) {
        return no(cb, error.message || 'تعذر تنفيذ طلب الشخصية.');
      }
    });

    /* =====================================================
       BANK
    ===================================================== */

    socket.on('bank:setAccount', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const bankCode = clean(payload?.bankCode || payload?.code || '', 100);
      if (bankCode && bankCode !== actor.publicCode) {
        return no(cb, 'كود البنك يجب أن يساوي الكود العسكري للشخصية الحالية.');
      }
      const accountNumber = clean(payload?.accountNumber || payload?.account || '', 60);
      if (accountNumber !== actor.publicCode) {
        return no(cb, 'أدخل كودك العسكري نفسه لربطه بالحساب البنكي.');
      }
      actor.bankAccount = actor.publicCode;
      ensureBank(actor);
      saveState();
      emitState();
      const bank = bankView(actor, actor);
      return ok(cb, { bank, self: bank });
    });

    socket.on('bank:setBalance', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const target = getUserById(clean(payload?.memberId || payload?.userId, 120)) ||
        getUserByPublicCode(payload?.publicCode || payload?.code);
      const amount = parseMoney(payload?.amount);
      if (!target) return no(cb, 'الشخصية غير موجودة.');
      if (!Number.isFinite(amount) || amount < 0) return no(cb, 'الرصيد غير صالح.');
      if (target.id !== actor.id && !canManageBank(actor, target)) {
        return no(cb, 'لا تملك صلاحية تعديل هذا الحساب.');
      }
      ensureBank(target);
      target.bank.balance = amount;
      addAuditLog('تعديل رصيد بنكي', actor, target, `تم ضبط الرصيد إلى ${amount}.`);
      saveState();
      emitState();
      const bank = bankView(target, actor);
      return ok(cb, { bank, self: target.id === actor.id ? bank : bankView(actor, actor) });
    });

    socket.on('bank:manage', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const action = clean(payload?.action, 50).toLowerCase();
      const target = getUserByPublicCode(payload?.targetCode || payload?.publicCode || payload?.code);
      if (!target) return no(cb, 'الشخصية غير موجودة.');
      if (target.id !== actor.id && !canManageBank(actor, target)) {
        return no(cb, 'لا تملك صلاحية إدارة هذا الحساب.');
      }
      ensureBank(target);

      if (action === 'freeze' || action === 'unfreeze') {
        target.bank.frozen = action === 'freeze';
      } else if (action === 'stop-account' || action === 'start-account') {
        target.bank.enabled = action === 'start-account';
      } else if (action === 'withdraw' || action === 'deduct') {
        const amount = parseMoney(payload?.amount);
        if (!Number.isFinite(amount) || amount <= 0) return no(cb, 'اكتب مبلغاً صحيحاً.');
        if (target.bank.frozen || target.bank.enabled === false) return no(cb, 'الحساب البنكي مجمد أو موقوف.');
        if (target.bank.balance < amount) return no(cb, 'الرصيد غير كافٍ.');
        target.bank.balance -= amount;
      } else {
        return no(cb, 'إجراء البنك غير معروف.');
      }

      addAuditLog('إدارة حساب بنكي', actor, target, `الإجراء: ${action}.`);
      saveState();
      emitState();
      const bank = bankView(target, actor);
      const result = ok(cb, { bank, self: target.id === actor.id ? bank : bankView(actor, actor) });
      socket.emit('bank:manage:result', result);
      return result;
    });

    socket.on('bank:paySalary', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const target = getUserByPublicCode(payload?.targetCode || payload?.publicCode || payload?.code);
      if (!target) return no(cb, 'الشخصية غير موجودة.');
      if (target.id !== actor.id && !canManageBank(actor, target)) {
        return no(cb, 'لا تملك صلاحية صرف راتب هذه الشخصية.');
      }
      ensureBank(target);
      if (target.id === actor.id && !hasLinkedMilitaryBankCode(target)) {
        return no(cb, 'احفظ كودك العسكري مرة واحدة في البنك قبل تنفيذ العمليات.');
      }
      if (target.bank.enabled === false || target.bank.frozen || target.bank.salaryEnabled === false) {
        return no(cb, 'الحساب أو الراتب موقوف.');
      }
      const amount = Math.max(0, Math.floor(Number(target.bank.salary) || 0));
      target.bank.balance += amount;
      target.bank.lastSalaryAt = now();
      target.bank.salaryClaimedToday = true;
      addAuditLog('صرف راتب يدوي', actor, target, `تم صرف ${amount}.`);
      saveState();
      emitState();
      const bank = bankView(target, actor);
      const result = ok(cb, {
        amount,
        bank,
        self: target.id === actor.id ? bank : bankView(actor, actor)
      });
      socket.emit('bank:paySalary:result', result);
      return result;
    });

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

        if (!hasLinkedMilitaryBankCode(actor)) {
          return no(cb, 'احفظ كودك العسكري مرة واحدة في البنك قبل استلام الراتب.');
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
        if (target.id === actor.id && !hasLinkedMilitaryBankCode(target)) {
          return no(cb, 'احفظ كودك العسكري مرة واحدة في البنك قبل تنفيذ العمليات.');
        }

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

        if (target.id === actor.id && !hasLinkedMilitaryBankCode(target)) {
          return no(cb, 'احفظ كودك العسكري مرة واحدة في البنك قبل تنفيذ العمليات.');
        }

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
            requireAuthenticatedUser(socket);

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
            requireAuthenticatedUser(socket);

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

          const removed = removeMapLocationByCode(
            targetCode
          );

          if (removed) {
            io.emit('map:location:removed', { code: targetCode, byCode: actor.publicCode });
          }

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
              removed,
              removedCode:
                removed ? targetCode : null,
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
            requireAuthenticatedUser(socket);

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

    socket.on('morse:translate', (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
      const direction = clean(payload?.direction, 20).toLowerCase();
      const source = clean(payload?.text, 500);
      if (!['encode','decode'].includes(direction)) return no(cb, 'اختر اتجاه الترجمة الصحيح.');
      if (!source) return no(cb, 'اكتب النص أو شفرة مورس أولاً.');

      let translation;
      if (direction === 'encode') {
        const normalized = source.toUpperCase();
        const unsupported = [...normalized].find(character => !/\s/.test(character) && !Object.prototype.hasOwnProperty.call(MORSE_CODES, character));
        if (unsupported) return no(cb, 'اكتب النص باللغة الإنجليزية فقط، مع الأرقام وعلامات الترقيم المدعومة.');
        translation = normalized.trim().split(/\s+/).map(word => [...word].map(character => MORSE_CODES[character]).join(' ')).join(' / ');
      } else {
        if ([...source].some(character => !['.','-','/'].includes(character) && !/\s/.test(character))) {
          return no(cb, 'أدخل شفرة مورس باستخدام النقاط والشرطات والمسافات أو / بين الكلمات.');
        }
        try {
          const words = source.trim().split(/\s*\/\s*|\s{3,}/);
          translation = words.map(word => word.trim().split(/\s+/).map(code => {
            const character = MORSE_CHARACTERS[code];
            if (!character) throw new Error('رمز مورس غير معروف: ' + code);
            return character;
          }).join('')).join(' ');
        } catch (error) {
          return no(cb, error.message || 'تعذر فك شفرة مورس.');
        }
      }

      const log = {
        id: makeId('MORSE'),
        userId: actor.id,
        realName: clean(actor.identity?.fullName || actor.name, 160),
        userName: clean(actor.name, 120),
        publicCode: clean(actor.publicCode, 100),
        rank: normalizeRank(actor.rank),
        rankLabel: rankLabel(actor.rank),
        direction,
        source,
        translation,
        at: now()
      };
      state.cia_morse_logs.unshift(log);
      state.cia_morse_logs = state.cia_morse_logs.slice(0, 500);
      saveState();
      emitState();
      const connectedSockets = io.sockets && io.sockets.sockets;
      const socketList = connectedSockets instanceof Map
        ? connectedSockets.values()
        : Object.values(connectedSockets || {});
      for (const targetSocket of socketList) {
        const recipient = requireAuthenticatedUser(targetSocket);
        if (isMorseSupervisor(recipient)) targetSocket.emit('morse:activity', { log });
      }
      return ok(cb, { translation, logId: log.id });
    });

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
               payload?.body ||
               payload?.description ||
               '',
               10000
             ),

           body:
             clean(
               payload?.body ||
               payload?.text ||
               payload?.description ||
               '',
               10000
             ),

           img:
             clean(
               payload?.img ||
               payload?.image ||
               '',
               8 * 1024 * 1024
             ),

           isSecret:
             payload?.isSecret === true,

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

           code:
             actor.publicCode,

           author:
             actor.name,

          createdAt:
            now(),

           date:
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
            socketRequirementMessage(socket)
          );
        }

        if (!canManageOperations(actor)) {
          return no(cb, 'إنشاء المهمات متاح للرتب العليا الثلاث فقط.');
        }

        const requestedCodes = Array.isArray(payload?.memberCodes)
          ? payload.memberCodes
          : [payload?.agentCode || ''];
        const memberCodes = [...new Set(
          requestedCodes.map((code) => clean(code, 100)).filter(Boolean)
        )];
        if (!memberCodes.length || memberCodes.length > 50) {
          return no(cb, 'اختر من Agent واحد إلى 50 Agent للمهمة.');
        }
        const assignedAgents = memberCodes.map((code) => getUserByPublicCode(code));
        if (assignedAgents.some((member) =>
          !member ||
          normalizeRank(member.rank) !== 'AGENT' ||
          member.approved === false ||
          member.suspended ||
          member.online !== true ||
          member.activeService !== true
        )) {
          return no(cb, 'تأكد أن الأعضاء المختارين Agents معتمدون ومتصلون بالخدمة الآن. حدّث قائمة الأعضاء ثم أعد المحاولة.');
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
            actor.publicCode,

          commanderName:
            actor.name,

          memberCodes:
            assignedAgents.map((member) => member.publicCode),

          notes: [],

          mapMarkers: [],

          mapDrawings: [],

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
            socketRequirementMessage(socket)
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

    socket.on('operation:agents', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, socketRequirementMessage(socket));
      if (!canManageOperations(actor)) {
        return no(cb, 'قائمة اختيار أعضاء المهمة متاحة للرتب العليا الثلاث فقط.');
      }
      const agents = state.cia_users
        .filter((member) =>
          normalizeRank(member.rank) === 'AGENT' &&
          member.approved !== false &&
          !member.suspended &&
          member.online === true &&
          member.activeService === true &&
          member.publicCode
        )
        .map((member) => isChief(actor)
          ? { code: member.publicCode, name: member.name }
          : { code: member.publicCode });
      return ok(cb, { agents });
    });

    socket.on(
      'operation:update',
      (payload, cb) => {
        const actor =
          requireSocketUser(socket);

        if (!actor) {
          return no(
            cb,
            socketRequirementMessage(socket)
          );
        }

        if (!canManageOperations(actor)) {
          return no(cb, 'تعديل المهمات متاح للرتب العليا الثلاث فقط.');
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

        if (!canAnnotateOperation(actor, operation)) {
          return no(cb, 'التحديثات الميدانية متاحة لمنشئ المهمة والقيادة والمشارك المحدد فقط.');
        }

        let selectedAgents = null;
        if (Array.isArray(payload?.memberCodes)) {
          const selectedCodes = [...new Set(
            payload.memberCodes.map((code) => clean(code, 100)).filter(Boolean)
          )];
          if (!selectedCodes.length || selectedCodes.length > 50) {
            return no(cb, 'اختر من Agent واحد إلى 50 Agent للمهمة.');
          }
          selectedAgents = selectedCodes.map((code) => getUserByPublicCode(code));
          if (selectedAgents.some((member) =>
            !member ||
            normalizeRank(member.rank) !== 'AGENT' ||
            member.approved === false ||
            member.suspended
          )) {
            return no(cb, 'تأكد أن كل الأكواد المختارة تخص Agents معتمدين.');
          }
        }

        if (selectedAgents) {
          operation.memberCodes = selectedAgents.map((member) => member.publicCode);
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
            socketRequirementMessage(socket)
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

        if (!canAnnotateOperation(actor, operation)) {
          return no(cb, 'التحديثات الميدانية متاحة لمنشئ المهمة والقيادة والمشارك المحدد فقط.');
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
            isChief(actor)
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
            socketRequirementMessage(socket)
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

    socket.on('operation:addMarker', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يلزم تسجيل الدخول للخدمة أولاً.');
      const id = clean(payload?.id || payload?.operationId, 200);
      const operation = state.cia_operations.find((item) => String(item.id) === String(id));
      if (!operation) return no(cb, 'المهمة غير موجودة.');
      if (!canManageOperations(actor)) {
        return no(cb, 'مراجعة خريطة المهمة متاحة للرتب العليا الثلاث فقط.');
      }
      const point = missionPoint(payload?.point || payload);
      if (!point) return no(cb, 'موقع العلامة غير صحيح.');
      const marker = {
        id: makeId('OPMARK'),
        ...point,
        label: clean(payload?.label || 'علامة ميدانية', 180),
        color: MISSION_DRAWING_COLORS.has(payload?.color) ? payload.color : '#facc15',
        authorCode: actor.publicCode,
        at: now()
      };
      operation.mapMarkers = Array.isArray(operation.mapMarkers) ? operation.mapMarkers : [];
      operation.mapMarkers.push(marker);
      operation.mapMarkers = operation.mapMarkers.slice(-200);
      operation.updatedAt = now();
      saveState();
      emitOperationState();
      return ok(cb, { marker, operation: operationSanitize(operation, actor) });
    });

    socket.on('operation:addDrawing', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يلزم تسجيل الدخول للخدمة أولاً.');
      const id = clean(payload?.id || payload?.operationId, 200);
      const operation = state.cia_operations.find((item) => String(item.id) === String(id));
      if (!operation) return no(cb, 'المهمة غير موجودة.');
      if (!canManageOperations(actor)) {
        return no(cb, 'مراجعة خريطة المهمة متاحة للرتب العليا الثلاث فقط.');
      }
      const points = Array.isArray(payload?.points)
        ? payload.points.map(missionPoint).filter(Boolean).slice(0, 500)
        : [];
      if (points.length < 2) return no(cb, 'الرسم يحتاج نقطتين على الأقل.');
      const drawing = {
        id: makeId('OPDRAW'),
        points,
        color: MISSION_DRAWING_COLORS.has(payload?.color) ? payload.color : '#facc15',
        authorCode: actor.publicCode,
        at: now()
      };
      operation.mapDrawings = Array.isArray(operation.mapDrawings) ? operation.mapDrawings : [];
      operation.mapDrawings.push(drawing);
      operation.mapDrawings = operation.mapDrawings.slice(-100);
      operation.updatedAt = now();
      saveState();
      emitOperationState();
      return ok(cb, { drawing, operation: operationSanitize(operation, actor) });
    });
    
    /* =====================================================
       CLIENT COMPATIBILITY EVENTS
    ===================================================== */

    socket.on('admin:updateMember', (payload, cb) => {
      try {
        const actor = requireSocketUser(socket);
        if (!actor) return no(cb, 'يجب تسجيل الدخول.');
        const target = getUserById(clean(payload?.memberId || payload?.userId, 120));
        if (!target) return no(cb, 'الشخصية غير موجودة.');
        if (!canManageMember(actor, target)) return no(cb, 'لا تملك صلاحية تعديل هذه الشخصية.');

        let action = 'code';
        if (payload?.rank !== undefined) {
          const rank = normalizeRank(payload.rank);
          if (!canChangeRank(actor, target, rank)) return no(cb, 'لا تملك صلاحية تغيير رتبة هذه الشخصية.');
          target.rank = rank;
          ensureBank(target).salary = defaultSalaryForRank(rank);
          action = 'rank';
        }
        if (payload?.secretCode !== undefined) {
          const secretCode = clean(payload.secretCode, 100);
          const error = validateSecretCode(secretCode, target);
          if (error || !canChangeSecret(actor, target)) return no(cb, error || 'لا تملك صلاحية تغيير كود هذه الشخصية.');
          target.secretCode = secretCode;
          action = 'code';
        }
        if (payload?.publicCode !== undefined) {
          const publicCode = clean(payload.publicCode, 100);
          const duplicate = getUserByPublicCode(publicCode);
          if (!publicCode || publicCode === 'PENDING' || (duplicate && duplicate.id !== target.id)) {
            return no(cb, 'الكود العسكري غير صالح أو مستخدم.');
          }
          if (!canManageMember(actor, target)) return no(cb, 'لا تملك صلاحية تغيير الكود العسكري.');
          target.publicCode = publicCode;
          action = 'code';
        }
        saveState();
        emitState();
        const result = ok(cb, { action, user: publicUser(target, actor) });
        socket.emit('admin:member:result', result);
        return result;
      } catch (error) {
        return no(cb, error.message || 'تعذر تعديل الشخصية.');
      }
    });

    socket.on('admin:reactivateMember', (payload, cb) => {
      const actor = requireSocketUser(socket);
      const target = getUserById(clean(payload?.memberId || payload?.userId, 120));
      if (!actor || !target) return no(cb, 'الشخصية غير موجودة.');
      if (!canManageMember(actor, target) && !isHighCommander(actor)) {
        return no(cb, 'لا تملك صلاحية إعادة الشخصية للخدمة.');
      }
      target.activeService = true;
      target.suspended = false;
      target.status = 'في الخدمة';
      saveState();
      emitState();
      const result = ok(cb, { action: 'reactivate', user: publicUser(target, actor) });
      socket.emit('admin:member:result', result);
      return result;
    });

    socket.on('admin:kickMember', (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      const target = getUserById(clean(payload?.memberId || payload?.userId, 120));
      if (!actor) return no(cb, 'يجب تسجيل الدخول إلى الحساب أولاً.');
      if (!target) return no(cb, 'الشخصية غير موجودة.');
      if (!canManageMember(actor, target)) return no(cb, 'لا تملك صلاحية فصل هذه الشخصية.');
      target.activeService = false;
      target.suspended = true;
      target.online = false;
      target.status = 'مفصول';
      for (const socketId of sessions.get(target.id) || []) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) targetSocket.emit('member:kicked', { message: 'تم فصل الشخصية من الخدمة.' });
      }
      saveState();
      emitState();
      const result = ok(cb, { action: 'kick', user: publicUser(target, actor) });
      socket.emit('admin:member:result', result);
      return result;
    });

    socket.on('admin:kickUser', (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      const target = getUserById(clean(payload?.userId || payload?.memberId, 120));
      if (!actor) return no(cb, 'يجب تسجيل الدخول إلى الحساب أولاً.');
      if (!target) return no(cb, 'الشخصية غير موجودة.');
      if (!canManageMember(actor, target)) return no(cb, 'لا تملك صلاحية فصل هذه الشخصية.');
      target.activeService = false;
      target.suspended = true;
      target.online = false;
      target.status = 'مفصول';
      saveState();
      emitState();
      return ok(cb, { action: 'kick', user: publicUser(target, actor) });
    });

    socket.on('radio:text', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const channel = clean(payload?.channel || actor.radioChannel || 'CH-1', 50);
      const text = clean(payload?.text || payload?.message, 2000);
      if (!text) return no(cb, 'الرسالة فارغة.');
      const packet = {
        id: makeId('RADIO'),
        channel,
        userCode: actor.publicCode,
        fromCode: actor.publicCode,
        fromRank: rankLabel(actor.rank),
        text,
        at: now()
      };
      emitRadioToChannel(channel, 'radio:text', packet);
      return ok(cb, { message: packet });
    });

    socket.on('radio:code', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const channel = clean(payload?.channel || actor.radioChannel || 'CH-1', 50);
      const packet = {
        channel,
        userCode: actor.publicCode,
        userName: actor.name,
        code: clean(payload?.code, 50),
        meaning: clean(payload?.meaning, 200)
      };
      if (!packet.code) return no(cb, 'كود الراديو غير موجود.');
      emitRadioToChannel(channel, 'radio:code', packet);
      return ok(cb, { message: packet });
    });

    socket.on('radio:ptt:start', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const channel = clean(payload?.channel || actor.radioChannel || 'CH-1', 50);
      emitRadioToChannel(channel, 'radio:state', {
        channel, userCode: actor.publicCode, ptt: true,
        statusHtml: 'جاري البث الصوتي...'
      });
      return ok(cb);
    });

    socket.on('radio:ptt:stop', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const channel = clean(payload?.channel || actor.radioChannel || 'CH-1', 50);
      emitRadioToChannel(channel, 'radio:state', {
        channel, userCode: actor.publicCode, ptt: false,
        statusHtml: 'انتهى البث.'
      });
      return ok(cb);
    });

    socket.on('report:delete', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      if (!isLeadership(actor)) return no(cb, 'حذف التقارير متاح للقيادة فقط.');
      const id = clean(payload?.id || payload?.reportId, 200);
      const exists = state.cia_reports.some((report) => String(report.id) === String(id));
      if (!exists) return no(cb, 'التقرير غير موجود.');
      state.cia_reports = state.cia_reports.filter((report) => String(report.id) !== String(id));
      addAuditLog('حذف تقرير', actor, null, `تم حذف التقرير ${id}.`);
      saveState();
      emitState();
      return ok(cb, { id });
    });

    socket.on('duty:start', (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      if (actor.serviceApproved === false) {
        return no(cb, 'لا يمكنك تسجيل الدخول للخدمة قبل قبول هويتك من القيادة.');
      }
      if (actor.activeService === true) {
        return ok(cb, { attendance: null, user: publicUser(actor, actor) });
      }
      const dayKey = now().slice(0, 10);
      const current = (state.cia_attendance || []).find(
        (item) => item.userId === actor.id && item.dayKey === dayKey && !item.endedAt
      );
      if (current) return ok(cb, { attendance: current });
      const attendance = {
        id: makeId('DUTY'),
        userId: actor.id,
        userCode: actor.publicCode,
        userName: actor.name,
        dayKey,
        startedAt: now(),
        endedAt: null,
        salaryPaid: false
      };
      state.cia_attendance.unshift(attendance);
      actor.activeService = true;
      actor.online = true;
      actor.status = 'في الخدمة';
      saveState();
      emitState();
      return ok(cb, { attendance, user: publicUser(actor, actor) });
    });

    socket.on('duty:end', (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const current = (state.cia_attendance || []).find(
        (item) => item.userId === actor.id && !item.endedAt
      );
      if (current) current.endedAt = now();
      removeRadioMember(socket.id);
      actor.radioOnline = false;
      actor.activeService = false;
      actor.status = 'خارج الخدمة';
      saveState();
      emitState();
      return ok(cb, { attendance: current, user: publicUser(actor, actor) });
    });

    socket.on('operation:updateStatus', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, socketRequirementMessage(socket));
      const id = clean(payload?.operationId || payload?.id, 200);
      const operation = state.cia_operations.find((item) => String(item.id) === String(id));
      if (!operation) return no(cb, 'المهمة غير موجودة.');
      if (!canManageOperations(actor)) {
        return no(cb, 'تحديث المهمة متاح للرتب العليا الثلاث فقط.');
      }
      operation.status = clean(payload?.status, 100) || operation.status;
      operation.updatedAt = now();
      saveState();
      emitOperationState();
      return ok(cb, { operation: operationSanitize(operation, actor) });
    });

    socket.on('chat:send', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const mode = payload?.mode === 'private' ? 'private' : 'global';
      const text = clean(payload?.text || payload?.message, 4000);
      const image = clean(payload?.image, 8 * 1024 * 1024);
      if (!text && !image) return no(cb, 'الرسالة فارغة.');

      const message = {
        id: makeId(mode === 'private' ? 'PCHAT' : 'CHAT'),
        senderCode: actor.publicCode,
        senderName: actor.name,
        fromCode: actor.publicCode,
        fromName: actor.name,
        targetCode: clean(payload?.targetCode, 100),
        text,
        image,
        timestamp: now(),
        at: now()
      };
      if (mode === 'private') {
        const target = getUserByPublicCode(message.targetCode);
        if (!target) return no(cb, 'المستخدم المستهدف غير موجود.');
        const key = chatKey(actor.publicCode, target.publicCode);
        state.cia_chats.private[key] = state.cia_chats.private[key] || [];
        state.cia_chats.private[key].push(message);
        state.cia_chats.private[key] = state.cia_chats.private[key].slice(-500);
        const targets = new Set([...(sessions.get(actor.id) || []), ...(sessions.get(target.id) || [])]);
        for (const socketId of targets) {
          const targetSocket = io.sockets.sockets.get(socketId);
          if (targetSocket) targetSocket.emit('chat:private', message);
        }
      } else {
        state.cia_chats.global.push(message);
        state.cia_chats.global = state.cia_chats.global.slice(-1000);
        io.emit('chat:global', message);
      }
      saveState();
      emitState();
      return ok(cb, { message });
    });

    socket.on('chat:delete', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const messageId = clean(payload?.messageId || payload?.id, 200);
      const admin = payload?.admin === true;
      if (admin && !isLeadership(actor)) return no(cb, 'لا تملك صلاحية الحذف الإداري.');
      let removed = false;
      if (payload?.mode === 'private') {
        for (const key of Object.keys(state.cia_chats.private || {})) {
          const before = state.cia_chats.private[key].length;
          state.cia_chats.private[key] = state.cia_chats.private[key].filter(
            (message) => String(message.id) !== String(messageId) ||
              (!admin && message.senderCode !== actor.publicCode)
          );
          removed = removed || before !== state.cia_chats.private[key].length;
        }
      } else {
        const before = state.cia_chats.global.length;
        state.cia_chats.global = state.cia_chats.global.filter(
          (message) => String(message.id) !== String(messageId)
        );
        removed = before !== state.cia_chats.global.length;
      }
      if (!removed) return no(cb, 'الرسالة غير موجودة أو لا تملك صلاحية حذفها.');
      saveState();
      emitState();
      return ok(cb, { id: messageId });
    });

    socket.on('support:send', (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      const senderName = actor
        ? actor.name
        : clean(payload?.name || payload?.characterName || 'شخصية غير معتمدة', 120);
      const text = clean(payload?.text || payload?.message, 3000);
      if (!text) return no(cb, 'اكتب الاستفسار أولاً.');

      let threadId = clean(payload?.threadId, 120);
      let ownerToken = clean(payload?.ownerToken, 200);
      let original = null;
      if (threadId) {
        original = state.cia_support.find((item) => item.threadId === threadId && item.reply !== true);
        const suppliedHash = ownerToken
          ? crypto.createHash('sha256').update(ownerToken).digest('hex')
          : '';
        if (!original?.ownerTokenHash || suppliedHash !== original.ownerTokenHash) {
          return no(cb, 'تعذر إثبات ملكية محادثة الاستفسار.');
        }
      } else {
        threadId = `THREAD-${crypto.randomBytes(24).toString('hex')}`;
        ownerToken = crypto.randomBytes(32).toString('hex');
      }

      const message = {
        id: makeId('SUPPORT'),
        threadId,
        senderCode: actor?.publicCode || '',
        senderName,
        senderRank: actor ? rankLabel(actor.rank) : 'Agent قيد الاعتماد',
        text,
        at: now(),
        reply: false,
        ownerUserId: original?.ownerUserId || actor?.id || null,
        ...(!original ? {
          ownerTokenHash: crypto.createHash('sha256').update(ownerToken).digest('hex')
        } : {})
      };
      supportThreadSockets.set(message.threadId, socket.id);
      state.cia_support.push(message);
      state.cia_support = state.cia_support.slice(-500);
      saveState();

      for (const targetSocket of io.sockets.sockets.values()) {
        const targetUser = targetSocket.userId ? getUserById(targetSocket.userId) : null;
        if (targetUser && isLeadership(targetUser)) {
          targetSocket.emit('support:message', message);
        }
      }
      return ok(cb, { message, threadId: message.threadId, ownerToken });
    });

    socket.on('support:history', (payload, cb) => {
      const threadId = clean(payload?.threadId, 120);
      const ownerToken = clean(payload?.ownerToken, 200);
      const original = state.cia_support.find((item) => item.threadId === threadId && item.reply !== true);
      const suppliedHash = ownerToken
        ? crypto.createHash('sha256').update(ownerToken).digest('hex')
        : '';
      if (!original?.ownerTokenHash || suppliedHash !== original.ownerTokenHash) {
        return no(cb, 'تعذر إثبات ملكية محادثة الاستفسار.');
      }
      supportThreadSockets.set(threadId, socket.id);
      const messages = state.cia_support.filter((item) => item.threadId === threadId);
      return ok(cb, { threadId, messages });
    });

    socket.on('support:reply', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor || !isLeadership(actor)) {
        return no(cb, 'الرد على استفسارات الاعتماد متاح للقائد وSenior Commander CIA فقط.');
      }
      const text = clean(payload?.text || payload?.message, 3000);
      const threadId = clean(payload?.threadId, 120);
      if (!text || !threadId) return no(cb, 'بيانات الرد غير مكتملة.');
      const original = state.cia_support.find((item) => item.threadId === threadId && item.reply !== true);
      if (!original) return no(cb, 'محادثة الاستفسار غير موجودة.');
      const message = {
        id: makeId('SUPPORT'),
        threadId,
        senderCode: actor.publicCode,
        senderName: actor.name,
        senderRank: rankLabel(actor.rank),
        text,
        at: now(),
        reply: true
      };
      state.cia_support.push(message);
      state.cia_support = state.cia_support.slice(-500);
      saveState();
      for (const targetSocket of io.sockets.sockets.values()) {
        const targetUser = targetSocket.userId ? getUserById(targetSocket.userId) : null;
        if (targetUser && isLeadership(targetUser)) targetSocket.emit('support:message', message);
      }
      const requesterIds = new Set();
      if (original.ownerUserId) {
        for (const socketId of sessions.get(original.ownerUserId) || []) requesterIds.add(socketId);
      }
      const activeOwnerSocket = supportThreadSockets.get(threadId);
      if (activeOwnerSocket) requesterIds.add(activeOwnerSocket);
      for (const socketId of requesterIds) {
        const requesterSocket = io.sockets.sockets.get(socketId);
        if (requesterSocket) requesterSocket.emit('support:private-reply', { threadId, message });
      }
      return ok(cb, { message });
    });

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

/* =====================================================
   HTTP SERVER START
===================================================== */

httpServer.listen(PORT, () => {
  console.log('');
  console.log('==================================================');
  console.log(' BLACK RIDGE CITY CIA SYSTEM');
  console.log(` PORT: ${PORT}`);
  console.log(' STATUS: ONLINE');
  console.log(' LOGIN / LEADERSHIP / RADIO / SOS: READY');
  console.log('==================================================');
});