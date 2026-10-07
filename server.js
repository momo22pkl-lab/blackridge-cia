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
const { PostgresStateStore } = require('./state-store');
const { NotificationsStore } = require('./notifications-store');
const { canRestoreSecurityMember, inspectMessage } = require('./security-moderation');
const { isProfanityDetection, normalizeProfanityStrikes, registerProfanityStrike } = require('./profanity-strikes');
const { registerPages } = require('./ibp/pages');
const { registerIBPSocket } = require('./ibp/handlers');
const { readChiefBootstrapConfig, withoutBootstrapCodes } = require('./chief-bootstrap');
const { registerOfficialWarnings } = require('./official-warnings');

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const IS_RENDER_RUNTIME = process.env.RENDER === 'true' || Boolean(process.env.RENDER_SERVICE_ID);
const LEGACY_DATA_FILE = path.resolve(path.join(__dirname, 'cia-data.json'));
const DEFAULT_DATA_FILE = IS_RENDER_RUNTIME
  ? path.join('/tmp', 'cia-data.json')
  : path.join(__dirname, '.blackridge-data', 'cia-data.json');
const DATA_FILE = path.resolve(
  IS_RENDER_RUNTIME && !DATABASE_URL
    ? path.join('/tmp', 'cia-data.json')
    : (process.env.CIA_DATA_FILE || DEFAULT_DATA_FILE)
);

function prepareFileStorage() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(DATA_FILE)) {
    const legacy = readLegacyStateFile();
    if (legacy && legacy.file !== DATA_FILE) {
      fs.copyFileSync(legacy.file, DATA_FILE);
      console.log('[BLACK RIDGE] Migrated existing data from ' + legacy.file + ' to ' + DATA_FILE);
    }
  }
}

let postgresPool = null;
let stateStore = null;
let notificationsStore = null;

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
app.use((req, res, next) => {
  if (/^\/cia-data\.json(?:\.tmp)?$/i.test(req.path)) return res.sendStatus(404);
  next();
});
const publicAssets = Object.freeze({
  '/notifications.css': 'notifications.css',
  '/notifications-client.js': 'notifications-client.js',
  '/official-warnings.css': 'official-warnings.css',
  '/official-warnings-client.js': 'official-warnings-client.js',
  '/ibp/ibp.css': path.join('ibp', 'ibp.css'),
  '/ibp/ibp.js': path.join('ibp', 'ibp.js')
});

for (const [route, file] of Object.entries(publicAssets)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
}

app.get(['/', '/index.html'], (req, res) => {
  const entryPoint = path.join(__dirname, 'index.html');
  if (!fs.existsSync(entryPoint)) {
    return res.status(404).send('BLACK RIDGE CIA: index.html not found.');
  }
  return res.sendFile(entryPoint);
});

registerPages(app);

const now = () => new Date().toISOString();
const clean = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const redactSecurityReason = (value) => clean(value, 300)
  .replace(/\b(password|passcode|secret(?:\s+code)?|api[\s-]*key|access[\s-]*token|token)\s*(?::|=|\bis\b)\s*[^\s,;]+/giu, '$1=[REDACTED]')
  .replace(/(كلمة المرور|كلمه المرور|رمز الدخول|الكود السري)\s*(?::|=|هو)?\s*[^\s,;]+/gu, '$1=[محجوب]');
const lower = (value) => clean(value, 200).toLowerCase();
const makeId = (prefix = 'ID') => `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;

const CHIEF_BOOTSTRAP = readChiefBootstrapConfig(process.env);
const SYSTEM = Object.freeze({
  chiefRegistrationCode: CHIEF_BOOTSTRAP.registrationCode,
  chiefSaveCode: CHIEF_BOOTSTRAP.saveCode,
  memberRequestCode: '0012',
  defaultSalary: 580
});

function chiefBootstrapCodesAreConfigured() {
  return CHIEF_BOOTSTRAP.configured;
}

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
  cia_security_incidents: [],
  cia_attendance: [],
  cia_operations: [],
  cia_notifications: [],
  cia_battalions: [],
  ibp_deployments: [],
  ibp_operations: [],
  ibp_intelligence: [],
  ibp_reports: [],
  settings: {
    publicSalary: SYSTEM.defaultSalary,
    rankSalaries: {
      AGENT: SYSTEM.defaultSalary,
      'HIGH COMMANDER': SYSTEM.defaultSalary,
      'SUPREME COMMANDER': SYSTEM.defaultSalary,
      'CIA CHIEF': SYSTEM.defaultSalary
    }
  },
  systemConfig: {}
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizePersistedState(parsed, source = 'persisted state') {
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.cia_users)) {
    throw new Error('Persisted state at ' + source + ' is missing its required cia_users data; refusing to start with an empty state.');
  }
  const base = clone(EMPTY_STATE);
  const loadedState = {
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
    systemConfig: withoutBootstrapCodes({
      ...base.systemConfig,
      ...(parsed.systemConfig || {})
    }),
    cia_chats: {
      global: Array.isArray(parsed.cia_chats?.global) ? parsed.cia_chats.global : [],
      private: parsed.cia_chats?.private && typeof parsed.cia_chats.private === 'object' ? parsed.cia_chats.private : {}
    }
  };

  if (loadedState.settings.rankSalaries && loadedState.settings.rankSalaries['Senior Commander CIA'] !== undefined) {
    const legacySeniorSalary = Number(loadedState.settings.rankSalaries['Senior Commander CIA']);
    if (!Number.isFinite(Number(loadedState.settings.rankSalaries['SUPREME COMMANDER'])) || Number(loadedState.settings.rankSalaries['SUPREME COMMANDER']) === SYSTEM.defaultSalary) {
      if (Number.isFinite(legacySeniorSalary) && legacySeniorSalary >= 0) {
        loadedState.settings.rankSalaries['SUPREME COMMANDER'] = Math.floor(legacySeniorSalary);
      }
    }
    delete loadedState.settings.rankSalaries['Senior Commander CIA'];
  }

  for (const key of [
    'cia_users', 'cia_queue', 'cia_character_queue', 'cia_accounts',
    'cia_support', 'cia_sos', 'cia_reports', 'cia_cases', 'cia_hq_locations',
    'cia_morse_logs', 'cia_audit_logs', 'cia_security_incidents', 'cia_attendance', 'cia_operations', 'cia_battalions',
    'cia_notifications', 'ibp_deployments', 'ibp_operations', 'ibp_intelligence', 'ibp_reports'
  ]) {
    if (!Array.isArray(loadedState[key])) loadedState[key] = [];
  }
  if (!loadedState.cia_map_locations || typeof loadedState.cia_map_locations !== 'object') {
    loadedState.cia_map_locations = {};
  }

  const previousState = state;
  state = loadedState;
  try {
    normalizeAllUsers(loadedState);
  } finally {
    state = previousState;
  }
  return loadedState;
}

function readLegacyStateFile() {
  const candidates = [...new Set([
    DATA_FILE,
    LEGACY_DATA_FILE,
    path.join(__dirname, '.blackridge-data', 'cia-data.json'),
    path.join('/var/data', 'cia-data.json')
  ])];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      return { file, state: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (error) {
      throw new Error('Unable to read legacy state at ' + file + ': ' + error.message);
    }
  }
  return null;
}

function loadState() {
  if (!fs.existsSync(DATA_FILE)) return normalizePersistedState(clone(EMPTY_STATE), DATA_FILE);
  try {
    return normalizePersistedState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')), DATA_FILE);
  } catch (error) {
    console.error('[BLACK RIDGE] Refusing to start without saved data at ' + DATA_FILE + ':', error.message);
    throw new Error('Unable to load persisted state at ' + DATA_FILE + ': ' + error.message);
  }
}

function saveState() {
  if (stateStore) {
    const pendingWrite = stateStore.save(state);
    pendingWrite.catch((error) => {
      console.error('[BLACK RIDGE] Failed to persist state to PostgreSQL:', error.message);
    });
    return pendingWrite;
  }
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, DATA_FILE);
    return Promise.resolve();
  } catch (error) {
    console.error('[BLACK RIDGE] Failed to save persistent state at ' + DATA_FILE + ':', error.message);
    throw new Error('Unable to persist application state at ' + DATA_FILE + ': ' + error.message);
  }
}


let state = clone(EMPTY_STATE);

const sessions = new Map();
const socketToUser = new Map();
const radioChannels = new Map();
const pendingRequestSockets = new Map();
const supportThreadSockets = new Map();

function notificationCanReach(user, details) {
  if (!user || user.suspended || user.securityStatus !== 'ACTIVE' || user.approved === false || user.serviceApproved === false) return false;
  const targetUserId = details.targetUserId ? String(details.targetUserId) : '';
  const sourceUserId = details.sourceUserId ? String(details.sourceUserId) : '';
  if (details.type === 'SECURITY' && details.leadershipOnly === true) return isSecuritySupervisor(user);
  if (details.type === 'SYSTEM' && details.leadershipOnly === true) return isLeadership(user);
  if (details.type === 'MESSAGE' || details.type === 'SALARY' || details.type === 'TRANSACTION' || details.type === 'FINANCE') {
    return !!targetUserId && user.id === targetUserId;
  }
  if (details.type === 'SOS') return user.id !== sourceUserId;
  if (details.type === 'WARNING' || details.type === 'WARNING_RESPONSE') {
    return !!targetUserId && user.id === targetUserId;
  }
  if (details.type === 'OPERATION') {
    const ownCode = clean(user.publicCode, 100).toUpperCase();
    const memberCodes = Array.isArray(details.memberCodes) ? details.memberCodes : [];
    return user.id !== sourceUserId && (rankLevel(user.rank) >= 2 ||
      (!!ownCode && memberCodes.some((code) => clean(code, 100).toUpperCase() === ownCode)));
  }
  if (details.type === 'CASE') {
    const ownCode = clean(user.publicCode, 100).toUpperCase();
    return isLeadership(user) ||
      (!!ownCode && clean(details.createdByCode, 100).toUpperCase() === ownCode) ||
      (!!ownCode && clean(details.assignedCode, 100).toUpperCase() === ownCode);
  }
  if (details.type === 'REPORT') {
    return isLeadership(user) ||
      (!!targetUserId && user.id === targetUserId) ||
      details.isSecret !== true;
  }
  if (details.type === 'LOGIN') return isLeadership(user) && user.id !== sourceUserId;
  if (['RANK', 'PERMISSION', 'PROFILE', 'REQUEST', 'SECURITY'].includes(details.type)) {
    return (!!targetUserId && user.id === targetUserId) ||
      (details.leadershipOnly === true && isLeadership(user));
  }
  return (!!targetUserId && user.id === targetUserId) ||
    (details.leadershipOnly === true && isLeadership(user));
}

async function sendNotificationCounts(userId) {
  if (!notificationsStore || !userId) return null;
  try {
    try {
      await notificationsStore.markDelivered(userId);
    } catch (error) {
      console.error('[BLACK RIDGE] Could not mark queued notifications delivered:', error.message);
    }
    const counts = await notificationsStore.countsForUser(userId);
    for (const socketId of sessions.get(userId) || []) {
      const targetSocket = io.sockets.sockets.get(socketId);
      if (targetSocket) targetSocket.emit('notification:count', counts);
    }
    return counts;
  } catch (error) {
    console.error('[BLACK RIDGE] Could not load notification counts:', error.message);
    return null;
  }
}

async function publishNotifications(recipients, details = {}) {
  if (!notificationsStore || !Array.isArray(recipients) || !recipients.length) return [];
  const seen = new Set();
  const targets = recipients.filter((user) => {
    if (!user || seen.has(user.id) || !notificationCanReach(user, details)) return false;
    seen.add(user.id);
    return true;
  });
  if (!targets.length) return [];
  const priority = ['CRITICAL', 'HIGH', 'NOTICE', 'SYSTEM'].includes(String(details.priority || '').toUpperCase())
    ? String(details.priority).toUpperCase()
    : 'NOTICE';
  const source = details.sourceUserId ? state.cia_users.find((user) => user.id === details.sourceUserId) : null;
  const records = targets.map((user) => ({
    id: makeId('NTF'),
    userId: user.id,
    type: clean(details.type || 'SYSTEM', 40).toUpperCase(),
    title: clean(details.title || 'BLACK RIDGE INTELLIGENCE', 180),
    message: clean(details.message || '', 1000),
    priority,
    status: (sessions.get(user.id)?.size || 0) > 0 ? 'DELIVERED' : 'SENT',
    sourceUserId: source?.id || null,
    sourceCode: clean(details.sourceCode || source?.publicCode || '', 100),
    relatedId: clean(details.relatedId || '', 200) || null,
    metadata: {
      ...(details.metadata && typeof details.metadata === 'object' && !Array.isArray(details.metadata)
        ? details.metadata
        : {}),
      ...(source && (isChief(user) || user.id === source.id || details.sourceNameVisible === true)
        ? { sourceName: clean(source.identity?.fullName || source.name, 120) }
        : {})
    }
  }));
  try {
    const created = await notificationsStore.createMany(records);
    const countsToRefresh = new Set();
    for (const notification of created) {
      countsToRefresh.add(notification.userId);
      for (const socketId of sessions.get(notification.userId) || []) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) targetSocket.emit('notification:new', notification);
      }
    }
    await Promise.all([...countsToRefresh].map(sendNotificationCounts));
    return created;
  } catch (error) {
    console.error('[BLACK RIDGE] Notification persistence failed:', error.message);
    return [];
  }
}

function missionMapColor(value) {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#facc15';
}
const MISSION_DRAWING_SHAPES = new Set(['freehand', 'circle', 'rectangle', 'line', 'polygon']);

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

const isSecuritySupervisor = (user) =>
  isChief(user) || isSenior(user) || isHighCommander(user);

function morseLogForViewer(log, viewer) {
  if (!log || !isMorseSupervisor(viewer)) return null;
  const visibleLog = { ...log };
  if (!isChief(viewer)) {
    delete visibleLog.realName;
    delete visibleLog.userName;
    delete visibleLog.userId;
  }
  return visibleLog;
}

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

  // Older records may have stored a BANK-* identifier or already saved a
  // military code. Migrate those existing bindings without allowing a second link.
  const hadLegacyBankBinding =
    /^BANK-/i.test(user.bankAccount) ||
    /^BANK-/i.test(clean(user.bank.bankCode || '', 60));
  const hadExistingBinding =
    user.bank.militaryCodeLinked === true ||
    !!user.bankAccount ||
    hadLegacyBankBinding;
  if (user.publicCode && hadExistingBinding) {
    user.bankAccount = user.publicCode;
    user.bank.militaryCodeLinked = true;
  } else {
    user.bank.militaryCodeLinked = user.bank.militaryCodeLinked === true;
  }
  if (user.publicCode) user.bank.bankCode = user.publicCode;

  return user.bank;
}

function hasLinkedMilitaryBankCode(user) {
  if (!user) return false;
  const bank = ensureBank(user);
  return bank.militaryCodeLinked === true &&
    !!user.publicCode &&
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
  user.suspensionReason = clean(user.suspensionReason || '', 1000);
  user.suspended = user.suspended === true;
  user.securityStatus = ['ACTIVE', 'SECURITY_RESTRICTED', 'SUSPENDED'].includes(user.securityStatus)
    ? user.securityStatus
    : (user.suspended ? 'SUSPENDED' : 'ACTIVE');
  if (user.suspended) user.securityStatus = 'SUSPENDED';
  user.securityViolationCount = Math.max(0, Math.floor(Number(user.securityViolationCount) || 0));
  user.profanityStrikes = normalizeProfanityStrikes(user.profanityStrikes);
  user.online = user.online === true;

  user.identity = user.identity || null;
  user.identityRequired = user.identityRequired !== false;
  user.identityApproved = user.identityApproved === true || (user.serviceApproved !== false && !!user.identity && user.identityApprovalPending !== true);
  user.serviceApprovalPending = user.serviceApprovalPending === true;

  user.loginCount = Number(user.loginCount || 0);
  user.lastLoginAt = user.lastLoginAt || null;
  user.lastLogoutAt = user.lastLogoutAt || null;
  user.lastSeenAt = user.lastSeenAt || user.lastLogoutAt || user.lastLoginAt || null;
  user.lastNotificationCheckAt = user.lastNotificationCheckAt || null;
  user.notificationSessionSinceAt = user.notificationSessionSinceAt || null;

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
        u.suspended !== true &&
        u.securityStatus === 'ACTIVE'
    ) || null
  );
}

function publicUser(user, viewer = null) {
  if (!user) return null;

  const leadership = isLeadership(viewer);
  const canSeeOtherNames = isChief(viewer);
  const self =
    !!viewer &&
    viewer.id === user.id;

  const result = {
    id: user.id,
    publicCode: user.publicCode,

    name:
      self
        ? user.name
        : canSeeOtherNames
          ? (user.identity?.fullName || user.name)
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
      self || canSeeOtherNames
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
      self || canSeeOtherNames
        ? user.accountId || null
        : null,

    activeService:
      user.activeService !== false,

    serviceApproved:
      user.serviceApproved !== false,

    identityApprovalPending:
      user.identityApprovalPending === true,

    identityApproved:
      self || leadership ? user.identityApproved === true : false,

    serviceApprovalPending:
      self || isChief(viewer) ? user.serviceApprovalPending === true : false,

    rejectionMessage:
      self
        ? (user.rejectionMessage || '')
        : '',

    suspended:
      user.suspended === true,

    securityStatus:
      self || isSecuritySupervisor(viewer)
        ? (user.suspended ? 'SUSPENDED' : (user.securityStatus || 'ACTIVE'))
        : null,

    bank:
      self || canSeeOtherNames
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
              null,

            militaryCodeLinked:
              ensureBank(user).militaryCodeLinked === true
          }
        : null,

    radioChannel:
      user.radioChannel ||
      'CH-1',

    ibpLanguage:
      user.ibpLanguage === 'en' ? 'en' : 'ar',

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

function recordSecurityEvent({
  actor = null,
  target = null,
  action,
  type = 'SECURITY',
  level = 1,
  reason = '',
  status = 'REVIEW_REQUIRED',
  relatedId = null,
  notificationCount = null,
  profanityStrikeCount = null
}) {
  const timestamp = now();
  const incident = {
    id: makeId('SEC'),
    userId: target?.id || actor?.id || null,
    userName: clean(target?.identity?.fullName || target?.name || actor?.name || '', 120),
    publicCode: clean(target?.publicCode || actor?.publicCode || '', 100),
    rank: normalizeRank(target?.rank || actor?.rank || 'AGENT'),
    actorId: actor?.id || null,
    actorName: clean(actor?.identity?.fullName || actor?.name || '', 120),
    actorCode: clean(actor?.publicCode || '', 100),
    actorRank: normalizeRank(actor?.rank || 'AGENT'),
    timestamp,
    at: timestamp,
    type: clean(type, 80).toUpperCase(),
    level: `LEVEL ${Math.max(1, Math.min(4, Number(level) || 1))}`,
    severity: `LEVEL ${Math.max(1, Math.min(4, Number(level) || 1))}`,
    action: clean(action, 80).toUpperCase(),
    reason: redactSecurityReason(reason),
    status: clean(status, 40).toUpperCase(),
    ...(relatedId ? { relatedId: clean(relatedId, 200) } : {}),
    ...(Number.isFinite(notificationCount) ? { notificationCount } : {}),
    ...(Number.isFinite(profanityStrikeCount) ? { profanityStrikeCount } : {})
  };
  state.cia_security_incidents.unshift(incident);
  state.cia_security_incidents = state.cia_security_incidents.slice(0, 2000);
  addAuditLog(
    `SECURITY_${incident.action}`,
    actor,
    target,
    `${incident.type} // ${incident.level} // ${incident.reason} // ${incident.status}`
  );
  saveState();
  for (const targetSocket of io.sockets.sockets.values()) {
    const viewer = targetSocket.userId ? getUserById(targetSocket.userId) : null;
    if (viewer && isSecuritySupervisor(viewer)) {
      targetSocket.emit('security:incident', securityEventForViewer(incident, viewer));
    }
  }
  return incident;
}

function securityEventForViewer(incident, viewer) {
  const result = {
    id: incident.id,
    publicCode: incident.publicCode,
    rank: incident.rank,
    actorCode: incident.actorCode || '',
    actorRank: incident.actorRank || '',
    timestamp: incident.timestamp || incident.at,
    type: incident.type,
    level: incident.level,
    severity: incident.severity,
    action: incident.action,
    status: incident.status,
    relatedId: incident.relatedId || null
  };
  if (Number.isFinite(incident.notificationCount)) result.notificationCount = incident.notificationCount;
  if (Number.isFinite(incident.profanityStrikeCount)) result.profanityStrikeCount = incident.profanityStrikeCount;
  if (isChief(viewer)) {
    result.userId = incident.userId;
    result.userName = incident.userName;
    result.actorId = incident.actorId;
    result.actorName = incident.actorName;
    result.reason = incident.reason;
  }
  return result;
}

async function notifySecurityLeadership(incident, options = {}) {
  const priority = incident.level === 'LEVEL 4' || incident.level === 'LEVEL 3'
    ? 'CRITICAL'
    : incident.level === 'LEVEL 2' ? 'HIGH' : 'NOTICE';
  const notifications = await publishNotifications(state.cia_users, {
    type: 'SECURITY',
    title: 'SECURITY ALERT',
    message: clean(options.message || `${incident.publicCode ? `#${incident.publicCode}` : 'عضو'} — ${incident.type} — ${incident.level} — ${incident.action}`, 500),
    priority,
    sourceUserId: incident.userId,
    sourceCode: incident.publicCode,
    relatedId: incident.id,
    leadershipOnly: true,
    metadata: {
      incidentId: incident.id,
      publicCode: incident.publicCode,
      rank: incident.rank,
      type: incident.type,
      level: incident.level,
      action: incident.action,
      status: incident.status,
      ...(Number.isFinite(incident.profanityStrikeCount) ? { profanityStrikeCount: incident.profanityStrikeCount } : {}),
      ...(incident.profanityStrikeCount && incident.reason ? { reason: incident.reason } : {})
    }
  });
  if (notifications.length) {
    recordSecurityEvent({
      actor: null,
      target: state.cia_users.find((user) => user.id === incident.userId) || null,
      action: 'NOTIFICATION_CREATED',
      type: 'SECURITY_NOTIFICATION',
      level: Number(incident.level.replace('LEVEL ', '')) || 1,
      reason: `Security alert delivered to ${notifications.length} leadership account(s).`,
      status: 'DELIVERED',
      relatedId: incident.id,
      notificationCount: notifications.length
    });
  }
  return notifications;
}

function endRestrictedSessions(user, reason) {
  for (const socketId of [...(sessions.get(user.id) || [])]) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (!targetSocket) continue;
    targetSocket.emit('security:restricted', {
      status: user.securityStatus,
      reason: clean(reason, 300)
    });
    targetSocket.disconnect(true);
  }
}

async function recordModerationViolation(actor, detection, channel) {
  if (isProfanityDetection(detection)) {
    const strike = registerProfanityStrike(actor);
    const separated = strike.separated;
    const channelName = clean(channel, 40).toUpperCase();
    const reason = `PROFANITY_STRIKE_${strike.count}${separated ? '_AUTO_SEPARATION' : ''} // ${detection.reason} // CHANNEL_${channelName}`;

    const incident = recordSecurityEvent({
      actor,
      target: actor,
      action: separated ? 'MEMBER_SUSPENDED' : 'PROFANITY_WARNING',
      type: detection.type,
      level: separated ? 3 : 1,
      reason,
      status: separated ? 'SUSPENDED' : 'REVIEW_REQUIRED',
      profanityStrikeCount: strike.count
    });
    const leadershipMessage = separated
      ? `تم فصل ${clean(actor.name || 'عضو', 120)} (#${clean(actor.publicCode || '—', 100)}) بعد المخالفة ${strike.count}/3. السبب: رصد إساءة لفظية في ${channelName}.`
      : undefined;

    await saveState();
    emitState();
    if (separated) endRestrictedSessions(actor, strike.message);
    await notifySecurityLeadership(incident, leadershipMessage ? { message: leadershipMessage } : {});
    await saveState();

    return {
      blocked: true,
      message: strike.message,
      strikeCount: strike.count,
      separated,
      incident
    };
  }

  actor.securityViolationCount = (Number(actor.securityViolationCount) || 0) + 1;
  let level = detection.level;
  if (level < 2 && actor.securityViolationCount >= 2) level = 2;
  const status = level >= 3 ? 'SUSPENDED' : level === 2 ? 'SECURITY_RESTRICTED' : 'REVIEW_REQUIRED';
  if (level >= 2) {
    actor.securityStatus = status;
    actor.suspended = level >= 3;
    actor.activeService = false;
    actor.radioOnline = false;
    actor.status = level >= 3 ? 'موقوف أمنياً' : 'مقيّد أمنياً';
    actor.suspensionReason = clean(detection.reason, 1000);
  }
  const incident = recordSecurityEvent({
    actor,
    target: actor,
    action: 'MESSAGE_BLOCKED',
    type: detection.type,
    level,
    reason: `${detection.reason} // CHANNEL_${clean(channel, 40).toUpperCase()}`,
    status: level >= 2 ? status : 'REVIEW_REQUIRED'
  });
  if (level >= 2) endRestrictedSessions(actor, 'تم تقييد الحساب أمنيًا. راجع القيادة.');
  await notifySecurityLeadership(incident);
  saveState();
  emitState();
  return incident;
}

async function moderateOutgoingText(actor, text, channel) {
  const detection = inspectMessage(text, process.env.CIA_SECURITY_BLOCKED_TERMS || '');
  if (!detection) return false;
  if (actor) {
    const result = await recordModerationViolation(actor, detection, channel);
    return result && result.blocked === true ? result : true;
  } else {
    const incident = recordSecurityEvent({
      actor: null,
      target: null,
      action: 'MESSAGE_BLOCKED',
      type: detection.type,
      level: detection.level,
      reason: `${detection.reason} // CHANNEL_${clean(channel, 40).toUpperCase()}`,
      status: 'REVIEW_REQUIRED'
    });
    await notifySecurityLeadership(incident);
    saveState();
    emitState();
  }
  return true;
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


function canManageIBPBattalions(actor) { return isChief(actor) || isSenior(actor); }
function ibpResolveCode(value) {
  const wanted = clean(value, 100).toUpperCase();
  return wanted ? state.cia_users.find((user) => clean(user.publicCode, 100).toUpperCase() === wanted) || null : null;
}
function ibpBattalionForViewer(record, viewer) {
  if (!record || !viewer) return null;
  const memberCodes = [...new Set((Array.isArray(record.memberCodes) ? record.memberCodes : []).map((value) => clean(value,100).toUpperCase()).filter(Boolean))];
  const commanderCode = clean(record.commanderCode,100).toUpperCase();
  const deputyCode = clean(record.deputyCode,100).toUpperCase();
  const seniorCommanderCode = clean(record.seniorCommanderCode,100).toUpperCase();
  const viewerCode = clean(viewer.publicCode,100).toUpperCase();
  const isMember = !!viewerCode && (memberCodes.includes(viewerCode) || commanderCode === viewerCode || deputyCode === viewerCode);
  const isLinkedCommander = rankLevel(viewer.rank) >= 2 && [commanderCode, seniorCommanderCode].includes(viewerCode);
  if (!isLeadership(viewer) && !isMember && !isLinkedCommander) return null;
  const commander = ibpResolveCode(record.commanderCode);
  const members = memberCodes.map((memberCode) => ibpResolveCode(memberCode)).filter((person) => person && !person.suspended && person.approved !== false && person.serviceApproved !== false).map((person) => {
    const item = { publicCode: person.publicCode, rank: normalizeRank(person.rank), rankLabel: rankLabel(person.rank), online: !!person.online, status: person.status || 'في الخدمة', activeService: person.activeService === true };
    if (isChief(viewer)) item.name = person.identity?.fullName || person.name || '';
    return item;
  });
  const deployments = Array.isArray(state.ibp_deployments) ? state.ibp_deployments : [];
  const history = canManageIBPBattalions(viewer) && Array.isArray(record.history) ? record.history.slice(-40) : [];
  const mapPosition = record.mapPosition && Number.isFinite(Number(record.mapPosition.x)) && Number.isFinite(Number(record.mapPosition.y)) ? { x: Number(record.mapPosition.x), y: Number(record.mapPosition.y) } : null;
  return {
    id: clean(record.id,120), code: clean(record.code || record.id,32), name: clean(record.nameAr || record.nameEn || record.name,100), nameAr: clean(record.nameAr || record.name,100), nameEn: clean(record.nameEn || record.name,100),
    sector: clean(record.sector,100), status: ['ACTIVE','ALERT','STANDBY','ARCHIVED'].includes(record.status) ? record.status : 'ACTIVE',
    color: /^#[0-9a-fA-F]{6}$/.test(record.color || '') ? record.color : '#c7a25a', symbol: clean(record.symbol,16), emblem: clean(record.emblem || record.symbol,32),
    commanderCode: commander?.publicCode || clean(record.commanderCode,100), commanderRank: commander ? normalizeRank(commander.rank) : '',
    commanderName: isChief(viewer) && commander ? (commander.identity?.fullName || commander.name || '') : '',
    deputyCode: clean(record.deputyCode,100), seniorCommanderCode: clean(record.seniorCommanderCode,100), members, memberCodes: members.map((person) => person.publicCode), memberCount: members.length,
    notes: canManageIBPBattalions(viewer) ? clean(record.notes,1000) : '', history,
    mapPosition, canManage: canManageIBPBattalions(viewer), deploymentCount: deployments.filter((item) => String(item.battalionId) === String(record.id) && item.status !== 'ARCHIVED').length,
    createdAt: record.createdAt || null, updatedAt: record.updatedAt || null, archivedAt: record.archivedAt || null
  };
}
function emitIBPBattalionState() {
  for (const targetSocket of io.sockets.sockets.values()) {
    const viewer = targetSocket.userId ? getUserById(targetSocket.userId) : null;
    if (!viewer) continue;
    const battalions = (state.cia_battalions || []).map((item) => ibpBattalionForViewer(item, viewer)).filter(Boolean);
    targetSocket.emit('ibp:battalions:update', { battalions });
  }
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

    cia_service_queue:
      isChief(viewer)
        ? state.cia_users
            .filter((u) => u.serviceApprovalPending === true)
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
            .map((log) => morseLogForViewer(log, viewer))
            .filter(Boolean)
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
  if (stateStore) {
    stateStore.flush().then(() => emitStateNow()).catch((error) => {
      console.error('[BLACK RIDGE] State broadcast skipped because persistence failed:', error.message);
    });
    return;
  }
  return emitStateNow();
}

function emitStateNow() {
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
  const response = {
    ok: true,
    ...payload
  };
  if (typeof cb === 'function' && stateStore) {
    stateStore.flush().then(() => {
      reply(cb, response);
    }).catch((error) => {
      console.error('[BLACK RIDGE] Success acknowledgement withheld; PostgreSQL write failed:', error.message);
      reply(cb, { ok: false, message: 'تعذر تأكيد حفظ التغيير في قاعدة البيانات. أعد المحاولة بعد استقرار الاتصال.' });
    });
    return response;
  }
  return reply(cb, response);
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
    const sessionStartedAt = now();
    const priorSessionAt = user.lastSeenAt || user.lastLogoutAt || user.lastLoginAt || null;
    if (options.resumeSession !== true || !user.notificationSessionSinceAt) {
      user.notificationSessionSinceAt = priorSessionAt;
    }
    socket.notificationSessionSinceAt = options.resumeSession === true ? null : user.notificationSessionSinceAt;
    user.lastSeenAt = sessionStartedAt;
    user.loginCount += 1;
    user.lastLoginAt = sessionStartedAt;

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
    user.lastSeenAt = user.lastLogoutAt;

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

  if (!user || user.suspended || user.securityStatus !== 'ACTIVE' || user.approved === false || user.serviceApproved === false) {
    return null;
  }

  // A signed-in account remains authorized for ordinary and leadership actions
  // while off duty. Duty-only access is checked explicitly by its feature.
  return user;
}

function requireAuthenticatedUser(socket) {
  const user =
    socket.userId
      ? getUserById(socket.userId)
      : null;

  if (!user || user.suspended || user.securityStatus !== 'ACTIVE' || user.approved === false) return null;
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
  if (!user) return 'سجّل الدخول إلى حسابك أولاً.';
  if (user.serviceApproved === false) return 'هويتك بانتظار اعتماد القيادة؛ أكمل اعتمادها قبل استخدام النظام.';
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

  const financeDirectoryViewer =
    isChief(viewer) || isSenior(viewer) || isHighCommander(viewer);

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
    financeDirectoryViewer ||
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
        ? (user.identity?.fullName || user.name)
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

    canManage: managerAccess,

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
        : null,

    militaryCodeLinked:
      visible
        ? user.bank.militaryCodeLinked === true
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
  if (!op || !viewer) return null;

  const normalizedViewerRank =
    normalizeRank(
      viewer?.rank
    );

  const leadershipMissionViewer =
    canManageOperations(viewer);

  const privilegedMissionViewer =
    canManageOperations(viewer);

  const chiefMissionViewer = isChief(viewer);

  const viewerPublicCode = clean(viewer.publicCode, 100).toUpperCase();
  const matchesViewerCode = (code) =>
    !!viewerPublicCode && clean(code, 100).toUpperCase() === viewerPublicCode;

  const assignedMissionAgent =
    normalizedViewerRank === 'AGENT' &&
    Array.isArray(op.memberCodes) &&
    op.memberCodes.some(matchesViewerCode);

  const crews =
    (
      Array.isArray(
        op.memberCodes
      )
        ? op.memberCodes
        : []
    ).map((code) => {
      const normalizedMemberCode = clean(code, 100).toUpperCase();
      const member =
        getUserByPublicCode(code) ||
        state.cia_users.find((candidate) => clean(candidate.publicCode, 100).toUpperCase() === normalizedMemberCode);

      if (leadershipMissionViewer && member) {
        const safeMember = {
          code,
          rank: normalizeRank(member.rank),
          rankLabel: rankLabel(member.rank),
          online: !!member.online,
          activeService: member.activeService === true
        };
        if (chiefMissionViewer) {
          safeMember.name = member.identity?.fullName || member.name;
        }
        return safeMember;
      }
      if (normalizedViewerRank === 'AGENT' && matchesViewerCode(code)) {
        return { code, assignedToSelf: true };
      }
      return { code };
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
        assignedMissionAgent ? (op.startLocation || null) : null,

      endLocation:
        assignedMissionAgent ? (op.endLocation || null) : null,

      missionLocation:
        null,

      mapMarkers: [],

      mapDrawings: [],

      commanderCode: '',
      battalionLeaderCode: '',
      commanderName: '',

      crew: assignedMissionAgent ? [{ code: viewer.publicCode, assignedToSelf: true }] : [],

      battalionCount: assignedMissionAgent ? 1 : 0,

      notes: [],
      statusHistory: [],

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

    statusHistory:
      chiefMissionViewer
        ? (Array.isArray(op.statusHistory) ? op.statusHistory.slice(-50).map((entry) => ({
            at: entry.at || '',
            status: entry.status || '',
            actorCode: entry.actorCode || '',
            actorName: entry.actorName || '',
            actorRank: entry.actorRank || ''
          })) : [])
        : [],

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
  return !!actor && !!operation && canManageOperations(actor);
}

function addOperationStatusHistory(operation, actor, previousStatus) {
  const status = clean(operation?.status, 100).toUpperCase();
  const previous = clean(previousStatus, 100).toUpperCase();
  if (!['COMPLETED', 'FAILED'].includes(status) || status === previous) return;
  operation.statusHistory = Array.isArray(operation.statusHistory) ? operation.statusHistory : [];
  operation.statusHistory.push({
    at: now(),
    status,
    actorCode: clean(actor?.publicCode, 100),
    actorName: clean(actor?.identity?.fullName || actor?.name, 120),
    actorRank: rankLabel(actor?.rank)
  });
  operation.statusHistory = operation.statusHistory.slice(-100);
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
  if (stateStore) {
    stateStore.flush().then(() => emitOperationStateNow()).catch((error) => {
      console.error('[BLACK RIDGE] Operation broadcast skipped because persistence failed:', error.message);
    });
    return;
  }
  return emitOperationStateNow();
}

function emitOperationStateNow() {
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
    const originalSocketEmit = socket.emit.bind(socket);
    socket.emit = function(event, ...args) {
      if (!stateStore) return originalSocketEmit(event, ...args);
      stateStore.flush().then(() => originalSocketEmit(event, ...args)).catch((error) => {
        console.error('[BLACK RIDGE] Socket message skipped because persistence failed:', error.message);
      });
      return socket;
    };

    registerOfficialWarnings(socket, {
      getAuthenticatedUser: () => requireSocketUser(socket),
      getUsers: () => state.cia_users,
      getNotificationsStore: () => notificationsStore,
      isChief,
      normalizeRank,
      rankLabel,
      publishNotifications,
      makeId,
      recordAudit: async (action, actor, target, details) => {
        addAuditLog(action, actor, target, details);
        await saveState();
        emitState();
      }
    });

    socket.emit(
      'state:update',
      snapshot(null)
    );

    socket.on('notification:count', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      try {
        const counts = await notificationsStore.countsForUser(actor.id);
        socket.emit('notification:count', counts);
        return ok(cb, { counts });
      } catch (error) {
        console.error('[BLACK RIDGE] Notification count query failed:', error.message);
        return no(cb, 'تعذر تحميل عداد الإشعارات.');
      }
    });

    socket.on('notification:list', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      try {
        const result = await notificationsStore.listForUser({
          userId: actor.id,
          category: payload?.category,
          search: payload?.search,
          priority: payload?.priority,
          type: payload?.type,
          limit: payload?.limit,
          offset: payload?.offset
        });
        actor.lastNotificationCheckAt = now();
        saveState();
        const response = {
          ok: true,
          rows: result.rows,
          hasMore: result.hasMore,
          offset: Math.max(0, Number(payload?.offset) || 0),
          counts: await notificationsStore.countsForUser(actor.id)
        };
        socket.emit('notification:list:result', response);
        return ok(cb, response);
      } catch (error) {
        console.error('[BLACK RIDGE] Notification list query failed:', error.message);
        return no(cb, 'تعذر تحميل مركز الإشعارات.');
      }
    });

    socket.on('notification:since', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      try {
        const since = actor.notificationSessionSinceAt || null;
        const [summary, result] = await Promise.all([
          notificationsStore.summarySince(actor.id, since),
          notificationsStore.listForUser({
            userId: actor.id,
            since,
            limit: payload?.limit,
            offset: payload?.offset
          })
        ]);
        actor.lastNotificationCheckAt = now();
        saveState();
        const response = {
          ok: true,
          since,
          summary,
          rows: result.rows,
          hasMore: result.hasMore,
          offset: Math.max(0, Number(payload?.offset) || 0)
        };
        socket.emit('notification:since:result', response);
        return ok(cb, response);
      } catch (error) {
        console.error('[BLACK RIDGE] Missed-notification query failed:', error.message);
        return no(cb, 'تعذر تحميل ملخص الغياب.');
      }
    });

    socket.on('notification:read', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      try {
        const notification = await notificationsStore.markRead(actor.id, clean(payload?.id, 200));
        if (!notification) return no(cb, 'الإشعار غير موجود أو لا تملك صلاحية عرضه.');
        if (notification.type === 'SECURITY') {
          recordSecurityEvent({
            actor,
            target: actor,
            action: 'NOTIFICATION_READ',
            type: 'SECURITY_NOTIFICATION',
            level: 1,
            reason: 'SECURITY_NOTIFICATION_READ',
            status: 'READ',
            relatedId: notification.id
          });
        }
        const result = { ok: true, notification };
        socket.emit('notification:read:result', result);
        await sendNotificationCounts(actor.id);
        return ok(cb, result);
      } catch (error) {
        console.error('[BLACK RIDGE] Mark-read update failed:', error.message);
        return no(cb, 'تعذر تحديث حالة الإشعار.');
      }
    });

    socket.on('notification:markAllRead', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      try {
        const before = await notificationsStore.countsForUser(actor.id);
        const changed = await notificationsStore.markAllRead(actor.id);
        if (before.unreadSecurity > 0) {
          recordSecurityEvent({
            actor,
            target: actor,
            action: 'NOTIFICATIONS_MARKED_READ',
            type: 'SECURITY_NOTIFICATION',
            level: 1,
            reason: `SECURITY_NOTIFICATIONS_READ_${before.unreadSecurity}`,
            status: 'READ'
          });
        }
        const result = { ok: true, changed };
        socket.emit('notification:markAllRead:result', result);
        await sendNotificationCounts(actor.id);
        return ok(cb, result);
      } catch (error) {
        console.error('[BLACK RIDGE] Mark-all-read update failed:', error.message);
        return no(cb, 'تعذر تحديث الإشعارات.');
      }
    });

    socket.on('notification:acknowledge', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      try {
        const notification = await notificationsStore.acknowledge(actor.id, clean(payload?.id, 200));
        if (!notification) return no(cb, 'يمكن تأكيد الإشعارات الحرجة الخاصة بحسابك فقط.');
        if (notification.type === 'SECURITY') {
          recordSecurityEvent({
            actor,
            target: actor,
            action: 'NOTIFICATION_ACKNOWLEDGED',
            type: 'SECURITY_NOTIFICATION',
            level: 1,
            reason: 'SECURITY_NOTIFICATION_ACKNOWLEDGED',
            status: 'ACKNOWLEDGED',
            relatedId: notification.id
          });
        }
        const result = { ok: true, notification };
        socket.emit('notification:acknowledged', result);
        await sendNotificationCounts(actor.id);
        return ok(cb, result);
      } catch (error) {
        console.error('[BLACK RIDGE] Critical acknowledgement failed:', error.message);
        return no(cb, 'تعذر تأكيد التنبيه الحرج.');
      }
    });

    socket.on('security:getLogs', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      if (!isSecuritySupervisor(actor)) {
        const incident = recordSecurityEvent({
          actor,
          target: actor,
          action: 'SECURITY_CENTER_ACCESS_DENIED',
          type: 'ACCESS_CONTROL',
          level: 2,
          reason: 'UNAUTHORIZED_SECURITY_CENTER_ACCESS',
          status: 'BLOCKED'
        });
        await notifySecurityLeadership(incident);
        return no(cb, 'مركز الأمن متاح للقيادة الأمنية فقط.');
      }
      try {
        const counts = await notificationsStore.countsForUser(actor.id);
        const response = {
          ok: true,
          incidents: state.cia_security_incidents.slice(0, 300)
            .map((incident) => securityEventForViewer(incident, actor)),
          unreadSecurityNotifications: counts.unreadSecurity || 0
        };
        socket.emit('security:logs:result', response);
        return ok(cb, response);
      } catch (error) {
        console.error('[BLACK RIDGE] Security center read failed:', error.message);
        return no(cb, 'تعذر تحميل سجل الأمن.');
      }
    });

    socket.on('security:suspendMember', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      if (!isChief(actor)) {
        const incident = recordSecurityEvent({
          actor,
          target: actor,
          action: 'UNAUTHORIZED_SUSPENSION_ATTEMPT',
          type: 'ACCESS_CONTROL',
          level: 3,
          reason: 'ONLY_CIA_CHIEF_CAN_SUSPEND_MEMBERS',
          status: 'BLOCKED'
        });
        await notifySecurityLeadership(incident);
        return no(cb, 'إيقاف العضو أمنيًا متاح لـ CIA CHIEF فقط.');
      }
      const target = getUserById(clean(payload?.userId, 120));
      const reason = redactSecurityReason(payload?.reason);
      if (!target || target.id === actor.id) return no(cb, 'اختر عضوًا آخر لإيقافه.');
      if (!reason) return no(cb, 'سبب الإيقاف مطلوب.');
      if (target.securityStatus !== 'ACTIVE') return no(cb, 'العضو مقيّد أو موقوف بالفعل.');

      target.securityStatus = 'SUSPENDED';
      target.suspended = true;
      target.suspensionReason = reason;
      target.activeService = false;
      target.online = false;
      target.radioOnline = false;
      target.status = 'موقوف أمنياً';
      const incident = recordSecurityEvent({
        actor,
        target,
        action: 'MEMBER_SUSPENDED',
        type: 'MANUAL_REVIEW',
        level: 2,
        reason,
        status: 'SUSPENDED'
      });
      endRestrictedSessions(target, 'تم إيقاف الحساب أمنيًا. راجع القيادة.');
      await notifySecurityLeadership(incident);
      saveState();
      emitState();
      return ok(cb, { action: 'suspend', user: publicUser(target, actor) });
    });

    socket.on('security:restoreMember', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const target = getUserById(clean(payload?.userId, 120));
      if (!canRestoreSecurityMember(actor)) {
        const incident = recordSecurityEvent({
          actor,
          target: actor,
          action: 'UNAUTHORIZED_RESTORE_ATTEMPT',
          type: 'ACCESS_CONTROL',
          level: 3,
          reason: 'ONLY_CIA_CHIEF_CAN_RESTORE_SECURITY_RESTRICTED_MEMBERS',
          status: 'BLOCKED'
        });
        await notifySecurityLeadership(incident);
        return no(cb, 'إعادة العضو من الإيقاف الأمني متاحة لـ CIA CHIEF فقط.');
      }
      if (!target || target.id === actor.id) return no(cb, 'لا يمكن استعادة هذا الحساب.');
      if (target.securityStatus === 'ACTIVE' && !target.suspended) {
        return no(cb, 'الحساب غير موقوف أو مقيّد أمنيًا.');
      }

      target.securityStatus = 'ACTIVE';
      target.suspended = false;
      target.suspensionReason = '';
      target.activeService = false;
      target.online = false;
      target.radioOnline = false;
      target.status = 'خارج الخدمة';
      const incident = recordSecurityEvent({
        actor,
        target,
        action: 'MEMBER_RESTORED',
        type: 'MANUAL_REVIEW',
        level: 1,
        reason: 'RESTORED_BY_CIA_CHIEF',
        status: 'RESTORED'
      });
      await notifySecurityLeadership(incident);
      saveState();
      emitState();
      return ok(cb, { action: 'restore', user: publicUser(target, actor) });
    });

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
            ok(cb);
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
            ok(cb);
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

          if (!chiefBootstrapCodesAreConfigured()) {
            const result = no(
              cb,
              'تأسيس القيادة غير متاح؛ اضبط متغيري CIA_CHIEF_REGISTRATION_CODE وCIA_CHIEF_SAVE_CODE بقيمتين عشوائيتين مختلفتين لا تقل كل منهما عن 24 حرفاً.'
            );
            socket.emit('auth:chief:result', result);
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
      async (payload, cb) => {
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
            const suspended =
              state.cia_users.find(
                (candidate) =>
                  lower(candidate.name) === lower(name) &&
                  candidate.secretCode === code &&
                   (candidate.suspended === true || candidate.securityStatus !== 'ACTIVE')
              );
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
              suspended
                ? `تم تقييد هذه الشخصية أمنيًا. ${suspended.suspensionReason ? `سبب الإجراء: ${suspended.suspensionReason}` : 'راجع القيادة لمعرفة الإجراء.'}`
                : rejected
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
                payload?.resumeService === true,
              resumeSession:
                payload?.resumeSession === true
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
            await publishNotifications([user], {
              type: 'SALARY',
              title: 'FINANCIAL // SALARY DEPOSIT',
              message: `تم إيداع راتبك: ${salary}$`,
              priority: 'NOTICE',
              targetUserId: user.id,
              relatedId: user.id,
              metadata: { amount: salary }
            });
          }

          if (payload?.resumeSession !== true) {
            await publishNotifications(state.cia_users, {
              type: 'LOGIN',
              title: 'IMPORTANT SIGN-IN',
              message: `تسجيل دخول جديد من ${user.publicCode || 'حساب CIA'}.`,
              priority: 'SYSTEM',
              sourceUserId: user.id,
              relatedId: user.id,
              leadershipOnly: true
            });
          }

          let welcomeBack = null;
          if (payload?.resumeSession !== true && socket.notificationSessionSinceAt && notificationsStore) {
            try {
              const summary = await notificationsStore.summarySince(user.id, socket.notificationSessionSinceAt);
              if (summary.total > 0) welcomeBack = summary;
            } catch (error) {
              console.error('[BLACK RIDGE] Welcome-back summary query failed:', error.message);
            }
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
                  !user.identity &&
                  (user.identityRequired !== false || isChief(user)),

                serviceApproved:
                  user.serviceApproved !== false,

                serviceRequired:
                  user.activeService !== true ||
                  user.serviceApproved === false,

                welcomeBack,
                resumeSession: payload?.resumeSession === true
              }
            );

          socket.emit(
            'auth:login:result',
            result
          );

          await sendNotificationCounts(user.id);
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
      actor.identityApproved = false;
      actor.identityApprovalPending = true;
      actor.serviceApprovalPending = false;
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

    socket.on('service:request', (payload, cb) => {
      try {
        const actor = requireAuthenticatedUser(socket);
        if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
        if (actor.suspended || actor.approved === false) return no(cb, 'لا يمكن إرسال طلب الخدمة لهذا الحساب.');
        if (actor.identityApprovalPending || actor.identityApproved !== true) {
          return no(cb, 'يجب اعتماد هويتك أولاً قبل طلب دخول الخدمة.');
        }
        if (actor.serviceApproved === true) return no(cb, 'تم اعتماد دخولك للخدمة بالفعل.');
        if (actor.serviceApprovalPending === true) return no(cb, 'طلب دخول الخدمة قيد المراجعة بالفعل.');
        actor.serviceApprovalPending = true;
        actor.activeService = false;
        actor.status = 'بانتظار موافقة القائد على دخول الخدمة';
        addAuditLog('طلب دخول الخدمة', actor, actor, 'تم إرسال طلب دخول الخدمة بعد اعتماد الهوية.');
        saveState();
        emitState();
        for (const targetSocket of io.sockets.sockets.values()) {
          const targetUser = targetSocket.userId ? getUserById(targetSocket.userId) : null;
          if (targetUser && isChief(targetUser)) targetSocket.emit('service:approval:new', { userId: actor.id });
        }
        return ok(cb, { pending: true, user: publicUser(actor, actor) });
      } catch (error) {
        return no(cb, error.message || 'تعذر إرسال طلب دخول الخدمة.');
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
        // Presence does not start duty; only duty:start changes activeService.
        user.status =
          clean(
            payload?.status ||
              user.status ||
              (user.activeService === true ? 'في الخدمة' : 'خارج الخدمة'),
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
      async (payload, cb) => {
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
              target.identityApproved = false;
              target.serviceApprovalPending = false;
              target.serviceApproved = false;
              target.approved = false;
              target.activeService = false;
              target.online = false;
              target.status = 'مرفوضة';
              target.rejectionMessage =
                'تم رفضك. لأي استفسار قم بإرساله هنا، وسيصل إلى CIA CHIEF وSenior Commander CIA فقط.';
              addAuditLog('رفض الهوية', actor, target, target.rejectionMessage);
            } else {
              target.identityApprovalPending = false;
              target.identityApproved = true;
              target.serviceApprovalPending = false;
              target.serviceApproved = false;
              target.activeService = false;
              target.approved = true;
              target.rejectionMessage = '';
              target.status = 'بانتظار طلب دخول الخدمة';
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
                    : 'تم اعتماد هويتك. أرسل طلب دخول الخدمة من لوحة الحالة للمتابعة.',
                  secretCode: null,
                  publicCode: null
                });
              }
            }

            return ok(cb, {
              action: rejecting ? 'reject_identity' : 'approve_identity',
              user: publicUser(target, actor),
              message: rejecting
                ? target.rejectionMessage
                : 'تم اعتماد الهوية؛ بانتظار طلب دخول الخدمة.',
              secretCode: null,
              publicCode: null
            });
          }

          /* -------------------------------------------------
             FINAL SERVICE APPROVAL
          ------------------------------------------------- */

          if (action === 'approve_service' || action === 'reject_service') {
            if (!isChief(actor)) return no(cb, 'اعتماد دخول الخدمة متاح لـ CIA CHIEF فقط.');
            if (!target) return no(cb, 'الشخصية المستهدفة غير موجودة.');
            if (target.identityApproved !== true || target.identityApprovalPending === true) {
              return no(cb, 'اعتماد الهوية مطلوب قبل مراجعة طلب دخول الخدمة.');
            }
            if (target.serviceApproved === true) return no(cb, 'تم اعتماد دخول هذه الشخصية للخدمة بالفعل.');
            if (target.serviceApprovalPending !== true) return no(cb, 'لا يوجد طلب دخول خدمة معلق لهذه الشخصية.');

            const rejecting = action === 'reject_service';
            target.serviceApprovalPending = false;
            target.activeService = false;
            if (rejecting) {
              target.serviceApproved = false;
              target.status = 'تم رفض طلب دخول الخدمة';
              addAuditLog('رفض طلب دخول الخدمة', actor, target, 'يمكن للشخصية إرسال طلب جديد لاحقاً.');
            } else {
              if (!target.publicCode) target.publicCode = makePublicCode(target.rank);
              target.serviceApproved = true;
              target.approved = true;
              target.status = 'خارج الخدمة';
              addAuditLog('اعتماد دخول الخدمة', actor, target, `تم اعتماد ${target.name} وإصدار الكود العسكري ${target.publicCode}.`);
            }

            saveState();
            emitState();
            for (const socketId of sessions.get(target.id) || []) {
              const targetSocket = io.sockets.sockets.get(socketId);
              if (targetSocket) targetSocket.emit('member:service:reviewed', {
                ok: !rejecting,
                message: rejecting ? 'تم رفض طلب دخول الخدمة؛ يمكنك إرسال طلب جديد بعد مراجعة السبب مع القيادة.' : 'تم اعتماد طلبك ودخولك للخدمة.',
                publicCode: rejecting ? null : target.publicCode
              });
            }
            return ok(cb, {
              action,
              user: publicUser(target, actor),
              publicCode: rejecting ? null : target.publicCode,
              message: rejecting ? 'تم رفض طلب دخول الخدمة.' : 'تم اعتماد دخول الخدمة وإصدار الكود العسكري.'
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

                publicCode: '',

                rank,

                approved:
                  true,

                activeService:
                  false,

                serviceApproved:
                  false,

                identityApproved:
                  false,

                serviceApprovalPending:
                  false,

                identityApprovalPending:
                  false,

                suspended:
                  false,

                online:
                  false,

                status:
                  'بانتظار إكمال الهوية',

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
            await publishNotifications(state.cia_users, {
              type: 'RANK',
              title: 'RANK CHANGE',
              message: `تم تحديث رتبتك: ${rankLabel(oldRank)} ← ${rankLabel(desiredRank)}.`,
              priority: 'HIGH',
              sourceUserId: actor.id,
              targetUserId: target.id,
              relatedId: target.id,
              leadershipOnly: true,
              metadata: { oldRank, newRank: desiredRank }
            });
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
            const suspensionReason = clean(payload?.reason, 1000);
            if (!target) {
              return no(
                cb,
                'الشخصية غير موجودة.'
              );
            }
            if (!suspensionReason) {
              return no(cb, 'سبب الفصل إلزامي.');
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
            target.suspensionReason =
              suspensionReason;

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
                  s.emit('member:kicked', {
                    message: 'تم فصل الشخصية من الخدمة.',
                    reason: suspensionReason
                  });

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
              'فصل من الخدمة',
              actor,
              target,
              `سبب الفصل: ${suspensionReason}`
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
        if (target.suspended || target.serviceApproved === false || target.approved === false || target.identityApprovalPending === true) {
          return no(cb, 'لا يمكن تسليم القيادة لشخصية موقوفة أو لم تعتمد دخول الخدمة بعد.');
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
                '',

              rank:
                'AGENT',

              approved:
                false,

              activeService:
                false,

              serviceApproved:
                false,

              identityApproved:
                false,

              serviceApprovalPending:
                false,

              suspended:
                false,

              online:
                false,

              status:
                'بانتظار اعتماد الشخصية',

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
                null,

              publicCode:
                null,

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
          if (target.serviceApproved !== true || (!isLeadership(target) && !target.publicCode)) {
            return no(cb, 'اعتماد الشخصية والهوية وطلب دخول الخدمة مع إصدار الكود العسكري مطلوب قبل التفعيل.');
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
          publicCode: direct ? makePublicCode('AGENT') : '',
          rank: 'AGENT',
          approved: direct,
          activeService: direct,
          serviceApproved: direct,
          identityApproved: direct,
          serviceApprovalPending: false,
          suspended: false,
          online: false,
          status: direct ? 'في الخدمة' : 'بانتظار اعتماد الشخصية',
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
          secretCode: direct ? character.secretCode : null,
          publicCode: direct ? character.publicCode : null
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
        if (!target.approved || target.suspended) {
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
          target.serviceApproved = false;
          target.identityApproved = false;
          target.serviceApprovalPending = false;
          target.approved = false;
          target.status = 'مرفوضة';
          state.cia_character_queue = state.cia_character_queue.filter((item) => item.id !== request.id);
          saveState();
          emitState();
          const result = ok(cb, { action: 'reject', user: publicUser(target, actor) });
          for (const socketId of sessions.get(request.ownerId) || []) {
            const ownerSocket = io.sockets.sockets.get(socketId);
            if (ownerSocket) ownerSocket.emit('character:rejected', { message: `تم رفض طلب الشخصية ${target.name}.` });
          }
          return result;
        }
        if (action !== 'approve' && action !== 'accept') return no(cb, 'إجراء الشخصية غير معروف.');

        if (!target.secretCode) target.secretCode = makeSecretCode();
        target.publicCode = '';
        target.approved = true;
        target.activeService = false;
        target.serviceApproved = false;
        target.identityApproved = false;
        target.serviceApprovalPending = false;
        target.identityApprovalPending = false;
        target.identityRequired = true;
        target.status = 'بانتظار إكمال الهوية';
        state.cia_character_queue = state.cia_character_queue.filter((item) => item.id !== request.id);
        addAuditLog('اعتماد شخصية', actor, target, `تم اعتماد الشخصية ${target.name}.`);
        saveState();
        emitState();

        const result = ok(cb, {
          action: 'approve',
          user: publicUser(target, actor),
          secretCode: target.secretCode,
          publicCode: null
        });
        for (const socketId of sessions.get(request.ownerId) || []) {
          const ownerSocket = io.sockets.sockets.get(socketId);
          if (ownerSocket) ownerSocket.emit('character:approved', result);
        }
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
      const accountBank = ensureBank(actor);
      if (accountBank.militaryCodeLinked === true) {
        return no(cb, 'تم ربط الكود العسكري مسبقاً ولا يمكن إعادة ربطه.');
      }
      const bankCode = clean(payload?.bankCode || payload?.code || '', 100);
      if (bankCode && bankCode !== actor.publicCode) {
        return no(cb, 'كود البنك يجب أن يساوي الكود العسكري للشخصية الحالية.');
      }
      const accountNumber = clean(payload?.accountNumber || payload?.account || '', 60);
      if (accountNumber !== actor.publicCode) {
        return no(cb, 'أدخل كودك العسكري نفسه لربطه بالحساب البنكي.');
      }
      actor.bankAccount = actor.publicCode;
      accountBank.bankCode = actor.publicCode;
      accountBank.militaryCodeLinked = true;
      accountBank.militaryCodeLinkedAt = now();
      saveState();
      emitState();
      const bank = bankView(actor, actor);
      return ok(cb, { bank, self: bank });
    });

    socket.on('bank:setBalance', async (payload, cb) => {
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
      await publishNotifications([target], {
        type: 'TRANSACTION',
        title: 'FINANCIAL // BALANCE UPDATE',
        message: 'تم تحديث رصيد حسابك البنكي.',
        priority: 'NOTICE',
        sourceUserId: actor.id,
        targetUserId: target.id,
        relatedId: target.id,
        metadata: { action: 'balance_update', amount }
      });
      emitState();
      const bank = bankView(target, actor);
      return ok(cb, { bank, self: target.id === actor.id ? bank : bankView(actor, actor) });
    });

    socket.on('bank:manage', async (payload, cb) => {
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
      const isMoneyMovement = ['withdraw', 'deduct'].includes(action);
      const isAccountControl = ['freeze', 'unfreeze', 'stop-account', 'start-account'].includes(action);
      if (isMoneyMovement || isAccountControl) {
        await publishNotifications([target], {
          type: isMoneyMovement ? 'TRANSACTION' : 'FINANCE',
          title: isMoneyMovement ? 'FINANCIAL // WITHDRAWAL' : 'FINANCIAL // ACCOUNT STATUS',
          message: isMoneyMovement
            ? `تم سحب ${Math.floor(Number(payload?.amount) || 0)}$ من حسابك البنكي.`
            : `تم تحديث حالة حسابك البنكي: ${action}.`,
          priority: action === 'freeze' || action === 'stop-account' ? 'HIGH' : 'NOTICE',
          sourceUserId: actor.id,
          targetUserId: target.id,
          relatedId: target.id,
          metadata: { action, amount: isMoneyMovement ? Math.floor(Number(payload?.amount) || 0) : null }
        });
      }
      emitState();
      const bank = bankView(target, actor);
      const result = ok(cb, { bank, self: target.id === actor.id ? bank : bankView(actor, actor) });
      socket.emit('bank:manage:result', result);
      return result;
    });

    socket.on('bank:paySalary', async (payload, cb) => {
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
      await publishNotifications([target], {
        type: 'SALARY',
        title: 'FINANCIAL // SALARY DEPOSIT',
        message: `تم إيداع راتبك: ${amount}$`,
        priority: 'NOTICE',
        sourceUserId: actor.id,
        targetUserId: target.id,
        relatedId: target.id,
        metadata: { amount }
      });
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

            rankSalaries: Object.fromEntries(
              ['AGENT', 'HIGH COMMANDER', 'SUPREME COMMANDER', 'CIA CHIEF']
                .map((rank) => [rank, defaultSalaryForRank(rank)])
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
      async (payload, cb) => {
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
        await publishNotifications([actor], {
          type: 'SALARY',
          title: 'FINANCIAL // SALARY DEPOSIT',
          message: `تم إيداع راتبك: ${amount}$`,
          priority: 'NOTICE',
          targetUserId: actor.id,
          relatedId: actor.id,
          metadata: { amount }
        });
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

        addAuditLog(
          'تعديل راتب شخصية',
          actor,
          target,
          `تم تحديد راتب هذه الشخصية فقط إلى ${Math.floor(amount)} دون تغيير راتب رتبتها.`
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

    socket.on('morse:translate', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'سجّل الدخول إلى حسابك أولاً لاستخدام مورس.');
      if (actor.serviceApproved === false) return no(cb, 'اعتماد الهوية من القيادة مطلوب قبل استخدام مورس.');
      const direction = clean(payload?.direction, 20).toLowerCase();
      const source = clean(payload?.text, 500);
      if (!['encode','decode'].includes(direction)) return no(cb, 'اختر اتجاه الترجمة الصحيح.');
      if (!source) return no(cb, 'اكتب النص أو شفرة مورس أولاً.');
      const moderation = await moderateOutgoingText(actor, source, 'MORSE');
      if (moderation) {
        return no(cb, moderation.message || 'تم حظر النص بواسطة مركز الأمن.');
      }

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
        if (isMorseSupervisor(recipient)) {
          const visibleLog = morseLogForViewer(log, recipient);
          if (visibleLog) targetSocket.emit('morse:activity', { log: visibleLog });
        }
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
      async (payload, cb) => {
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

          await publishNotifications(state.cia_users, {
            type: 'SOS',
            title: 'CRITICAL — S.O.S RECEIVED',
            message: `${actor.publicCode || 'Agent'} أرسل استغاثة${location?.label ? ` من ${location.label}` : ''}${count !== null ? ` — عدد الأفراد: ${count}` : ''}.`,
            priority: 'CRITICAL',
            sourceUserId: actor.id,
            sourceCode: actor.publicCode,
            sourceNameVisible: true,
            relatedId: alert.id,
            metadata: { location: location?.label || '', count }
          });

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
      async (payload, cb) => {
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

        await publishNotifications(state.cia_users, {
          type: 'REPORT',
          title: 'NEW REPORT',
          message: `تم إنشاء تقرير جديد: ${report.title}`,
          priority: report.isSecret ? 'HIGH' : 'NOTICE',
          sourceUserId: actor.id,
          targetUserId: actor.id,
          sourceNameVisible: true,
          relatedId: report.id,
          isSecret: report.isSecret,
          metadata: { reportType: report.type, status: report.status }
        });

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
      async (payload, cb) => {
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

        const reportOwner = getUserByPublicCode(report.fromCode);
        await publishNotifications(state.cia_users, {
          type: 'REPORT',
          title: report.isSecret ? 'CLASSIFIED REPORT UPDATED' : 'REPORT UPDATED',
          message: `تم تحديث التقرير${report.status ? ` — الحالة: ${report.status}` : ''}.`,
          priority: report.isSecret ? 'HIGH' : 'NOTICE',
          sourceUserId: actor.id,
          targetUserId: reportOwner?.id || null,
          relatedId: report.id,
          isSecret: report.isSecret === true,
          metadata: { reportType: report.type, status: report.status }
        });

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
      async (payload, cb) => {
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

        await publishNotifications(state.cia_users, {
          type: 'CASE',
          title: 'NEW CASE FILE',
          message: `تم فتح قضية جديدة: ${caseItem.caseNumber} — ${caseItem.title}`,
          priority: 'HIGH',
          sourceUserId: actor.id,
          relatedId: caseItem.id,
          createdByCode: caseItem.createdByCode,
          assignedCode: caseItem.assignedCode,
          metadata: { caseNumber: caseItem.caseNumber, classification: caseItem.classification }
        });

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
      async (payload, cb) => {
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

        await publishNotifications(state.cia_users, {
          type: 'CASE',
          title: 'CASE FILE UPDATED',
          message: `تم تحديث القضية ${caseItem.caseNumber}: ${caseItem.title}`,
          priority: 'HIGH',
          sourceUserId: actor.id,
          relatedId: caseItem.id,
          createdByCode: caseItem.createdByCode,
          assignedCode: caseItem.assignedCode,
          metadata: { caseNumber: caseItem.caseNumber, status: caseItem.status }
        });

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


    socket.on('ibp:user-language:set', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول للخدمة أولاً.');
      const language = payload?.language;
      if (language !== 'ar' && language !== 'en') return no(cb, 'اللغة غير مدعومة.');
      actor.ibpLanguage = language;
      saveState();
      return ok(cb, { language });
    });
    socket.on('ibp:battalions:list', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول للخدمة أولاً.');
      const includeArchived = payload?.includeArchived === true;
      const battalions = (state.cia_battalions || []).filter((item) => includeArchived || item.status !== 'ARCHIVED').map((item) => ibpBattalionForViewer(item, actor)).filter(Boolean);
      const canManage = canManageIBPBattalions(actor);
      const assignablePersonnel = canManage ? state.cia_users.filter((user) => user.publicCode && user.approved !== false && user.suspended !== true && user.serviceApproved !== false).map((user) => {
        const item = { publicCode: user.publicCode, rank: normalizeRank(user.rank), rankLabel: rankLabel(user.rank), online: !!user.online };
        if (isChief(actor)) item.name = user.identity?.fullName || user.name || '';
        return item;
      }) : [];
      return ok(cb, { battalions, assignablePersonnel, canManage, canCreate: canManage, canTransfer: canManage, permissions: { leadership: canManageOperations(actor), admin: canManage } });
    });
    socket.on('ibp:battalion:save', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول للخدمة أولاً.');
      if (!canManageIBPBattalions(actor)) return no(cb, 'إنشاء الكتائب وتعديلها متاح لـ CIA CHIEF و SUPREME COMMANDER فقط.');
      const id = clean(payload?.id, 120);
      const existing = id ? (state.cia_battalions || []).find((item) => String(item.id) === id) : null;
      if (id && !existing) return no(cb, 'الكتيبة المطلوبة غير موجودة.');
      if (existing?.status === 'ARCHIVED') return no(cb, 'السجل المؤرشف للقراءة فقط.');
      const code = clean(payload?.code || existing?.code, 32).toUpperCase().replace(/\s+/g, '-');
      if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code)) return no(cb, 'أدخل رمز كتيبة فريداً من حرفين إلى 32 حرفاً أو رقماً.');
      const duplicateCode = (state.cia_battalions || []).find((item) => String(item.id) !== String(existing?.id || '') && String(item.code || '').toUpperCase() === code);
      if (duplicateCode) return no(cb, 'رمز الكتيبة مستخدم بالفعل.');
      const nameAr = clean(payload?.nameAr || existing?.nameAr, 100);
      const nameEn = clean(payload?.nameEn || existing?.nameEn, 100);
      if (!nameAr && !nameEn) return no(cb, 'أدخل اسم الكتيبة بالعربية أو الإنجليزية.');
      const sector = clean(payload?.sector, 100);
      const status = ['ACTIVE','ALERT','STANDBY'].includes(payload?.status) ? payload.status : 'ACTIVE';
      const color = /^#[0-9a-fA-F]{6}$/.test(payload?.color || '') ? payload.color : (existing?.color || '#c7a25a');
      const symbol = clean(payload?.symbol || existing?.symbol || 'UNIT', 16).replace(/[^a-zA-Z0-9 -]/g, '').trim().toUpperCase() || 'UNIT';
      const emblem = clean(payload?.emblem || existing?.emblem || symbol, 32);
      const resolveRole = (value, minRank, label) => {
        const roleCode = clean(value, 100);
        const person = roleCode ? ibpResolveCode(roleCode) : null;
        if (roleCode && (!person || person.approved === false || person.suspended === true || person.serviceApproved === false)) throw new Error('رمز ' + label + ' غير صالح.');
        if (person && rankLevel(person.rank) < minRank) throw new Error('يجب أن يكون ' + label + ' من الرتبة القيادية المطلوبة.');
        return person;
      };
      let commander, deputy, seniorCommander;
      try {
        commander = resolveRole(payload?.commanderCode ?? existing?.commanderCode, 2, 'قائد الكتيبة');
        deputy = resolveRole(payload?.deputyCode ?? existing?.deputyCode, 2, 'نائب قائد الكتيبة');
        seniorCommander = resolveRole(payload?.seniorCommanderCode ?? existing?.seniorCommanderCode, 3, 'القائد الأعلى');
      } catch (error) { return no(cb, error.message); }
      if (commander && deputy && clean(commander.publicCode,100).toUpperCase() === clean(deputy.publicCode,100).toUpperCase()) return no(cb, 'يجب أن يكون القائد والنائب شخصين مختلفين.');
      const requested = Array.isArray(payload?.memberCodes) ? payload.memberCodes.slice(0, 150) : (existing?.memberCodes || []);
      const memberMap = new Map();
      for (const value of requested) {
        const memberCode = clean(value, 100);
        if (!memberCode) continue;
        const person = ibpResolveCode(memberCode);
        if (!person || person.approved === false || person.suspended === true || person.serviceApproved === false) return no(cb, 'تعذر التحقق من أحد أكواد الأفراد المختارين.');
        memberMap.set(clean(person.publicCode, 100).toUpperCase(), person.publicCode);
      }
      for (const person of [commander, deputy]) if (person) memberMap.set(clean(person.publicCode,100).toUpperCase(), person.publicCode);
      const memberCodes = [...memberMap.values()];
      const wanted = new Set(memberCodes.map((memberCode) => clean(memberCode, 100).toUpperCase()));
      const conflict = (state.cia_battalions || []).find((unit) => String(unit.id) !== String(existing?.id || '') && unit.status !== 'ARCHIVED' && [...(Array.isArray(unit.memberCodes) ? unit.memberCodes : []), unit.commanderCode || '', unit.deputyCode || ''].some((memberCode) => wanted.has(clean(memberCode, 100).toUpperCase())));
      if (conflict) return no(cb, 'أحد الأفراد المحددّين معيّن بالفعل ضمن كتيبة أخرى نشطة.');
      const nowValue = now();
      const action = existing ? 'تعديل بيانات كتيبة' : 'إنشاء كتيبة';
      const detail = 'تم حفظ الكتيبة ' + code + ' وربط ' + memberCodes.length + ' من الأفراد.';
      const history = Array.isArray(existing?.history) ? existing.history.slice(-99) : [];
      history.push({ action, actorCode: actor.publicCode || '', at: nowValue, detail });
      const record = {
        ...(existing || {}), id: existing ? existing.id : makeId('BAT'), code, name: nameAr || nameEn, nameAr, nameEn, sector,
        status, color, symbol, emblem, commanderCode: commander ? commander.publicCode : '', deputyCode: deputy ? deputy.publicCode : '',
        seniorCommanderCode: seniorCommander ? seniorCommander.publicCode : '', memberCodes,
        notes: clean(payload?.notes ?? existing?.notes, 1000), mapPosition: existing?.mapPosition || null, history,
        createdAt: existing?.createdAt || nowValue, createdByCode: existing?.createdByCode || actor.publicCode,
        updatedAt: nowValue, updatedByCode: actor.publicCode
      };
      if (!Array.isArray(state.cia_battalions)) state.cia_battalions = [];
      if (existing) state.cia_battalions = state.cia_battalions.map((item) => String(item.id) === String(existing.id) ? record : item);
      else state.cia_battalions.unshift(record);
      addAuditLog(action, actor, null, detail);
      if (state.cia_audit_logs[0]) { state.cia_audit_logs[0].system = 'IBP'; state.cia_audit_logs[0].ibpBattalionId = String(record.id); }
      const persistence = saveState();
      const result = ok(cb, { battalion: ibpBattalionForViewer(record, actor) });
      Promise.resolve(persistence).then(() => emitIBPBattalionState()).catch(() => {});
      return result;
    });

    socket.on(
      'operation:create',
      async (payload, cb) => {
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
          return no(cb, 'اختر من فرد واحد إلى 50 فردًا للمهمة.');
        }
        const assignedAgents = memberCodes.map((code) => getUserByPublicCode(code));
        if (assignedAgents.some((member) =>
          !member ||
          member.approved === false ||
          member.suspended
        )) {
          return no(cb, 'تأكد أن جميع الأفراد المختارين معتمدون وغير موقوفين. يمكن إسناد المهمة حتى لمن هو غير متصل بالخدمة.');
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

        await publishNotifications(state.cia_users, {
          type: 'OPERATION',
          title: 'NEW OPERATION ASSIGNMENT',
          message: `تمت إضافتك إلى عملية جديدة: ${operation.missionNumber} — ${operation.title}`,
          priority: operation.risk === 'HIGH' || operation.risk === 'CRITICAL' ? 'HIGH' : 'NOTICE',
          sourceUserId: actor.id,
          relatedId: operation.id,
          memberCodes: operation.memberCodes,
          metadata: { missionNumber: operation.missionNumber, risk: operation.risk }
        });

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
          requireAuthenticatedUser(socket);

        if (!actor) {
          return no(
            cb,
            socketRequirementMessage(socket)
          );
        }
        if (actor.serviceApproved === false && normalizeRank(actor.rank) !== 'AGENT') {
          return no(cb, 'عرض المهمات متاح للقيادة بعد اعتماد دخول الخدمة.');
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
      const members = state.cia_users
        .filter((member) =>
          member.approved !== false &&
          !member.suspended &&
          member.publicCode
        )
        .sort((left, right) =>
          rankLevel(right.rank) - rankLevel(left.rank) ||
          clean(left.publicCode, 100).localeCompare(clean(right.publicCode, 100))
        )
        .map((member) => {
          const safeMember = {
            code: member.publicCode,
            rank: normalizeRank(member.rank),
            rankLabel: rankLabel(member.rank),
            online: !!member.online,
            activeService: member.activeService === true
          };
          if (isChief(actor)) safeMember.name = member.identity?.fullName || member.name;
          return safeMember;
        });
      return ok(cb, { agents: members });
    });

    socket.on(
      'operation:update',
      async (payload, cb) => {
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

        const previousMemberCodes = Array.isArray(operation.memberCodes) ? [...operation.memberCodes] : [];
        let selectedAgents = null;
        if (Array.isArray(payload?.memberCodes)) {
          const selectedCodes = [...new Set(
            payload.memberCodes.map((code) => clean(code, 100)).filter(Boolean)
          )];
          if (!selectedCodes.length || selectedCodes.length > 50) {
            return no(cb, 'اختر من فرد واحد إلى 50 فردًا للمهمة.');
          }
          selectedAgents = selectedCodes.map((code) => getUserByPublicCode(code));
          if (selectedAgents.some((member) =>
            !member ||
            member.approved === false ||
            member.suspended
          )) {
            return no(cb, 'تأكد أن الأكواد المختارة تخص أفرادًا معتمدين وغير موقوفين.');
          }
        }

        if (selectedAgents) {
          operation.memberCodes = selectedAgents.map((member) => member.publicCode);
        }

        const previousStatus = operation.status;
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

        addOperationStatusHistory(operation, actor, previousStatus);

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

        await publishNotifications(state.cia_users, {
          type: 'OPERATION',
          title: 'OPERATION UPDATED',
          message: `تم تحديث العملية ${operation.missionNumber} — ${operation.title}.`,
          priority: operation.risk === 'HIGH' || operation.risk === 'CRITICAL' ? 'HIGH' : 'NOTICE',
          sourceUserId: actor.id,
          relatedId: operation.id,
          memberCodes: [...new Set([...previousMemberCodes, ...(operation.memberCodes || [])])],
          metadata: { missionNumber: operation.missionNumber, risk: operation.risk, status: operation.status }
        });

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
      async (payload, cb) => {
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

        await publishNotifications(state.cia_users, {
          type: 'OPERATION',
          title: 'FIELD UPDATE // OPERATION NOTE',
          message: `أُضيف تحديث ميداني إلى العملية ${operation.missionNumber}.`,
          priority: operation.risk === 'HIGH' || operation.risk === 'CRITICAL' ? 'HIGH' : 'NOTICE',
          sourceUserId: actor.id,
          relatedId: operation.id,
          memberCodes: operation.memberCodes,
          metadata: { missionNumber: operation.missionNumber, risk: operation.risk }
        });

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
        kind: ['criminal', 'people'].includes(payload?.kind) ? payload.kind : 'point',
        count: Number.isInteger(Number(payload?.count)) && Number(payload?.count) >= 1 && Number(payload?.count) <= 1000
          ? Number(payload.count)
          : null,
        color: missionMapColor(payload?.color),
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
      const shape = MISSION_DRAWING_SHAPES.has(payload?.shape) ? payload.shape : 'freehand';
      const drawing = {
        id: makeId('OPDRAW'),
        points,
        shape,
        color: missionMapColor(payload?.color),
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
          if (target.serviceApproved !== true) return no(cb, 'لا يمكن إصدار أو تغيير الكود العسكري قبل موافقة دخول الخدمة.');
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

    socket.on('admin:reactivateMember', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      const target = getUserById(clean(payload?.memberId || payload?.userId, 120));
      if (!actor || !target) return no(cb, 'الشخصية غير موجودة.');
      if (!canRestoreSecurityMember(actor)) {
        const incident = recordSecurityEvent({
          actor,
          target: actor,
          action: 'UNAUTHORIZED_RESTORE_ATTEMPT',
          type: 'ACCESS_CONTROL',
          level: 3,
          reason: 'ONLY_CIA_CHIEF_CAN_RESTORE_MEMBERS',
          status: 'BLOCKED'
        });
        await notifySecurityLeadership(incident);
        return no(cb, 'لا تملك صلاحية إعادة هذه الشخصية للخدمة.');
      }
      if (target.id === actor.id) return no(cb, 'لا يمكن استعادة حسابك بهذه العملية.');
      if (target.securityStatus === 'ACTIVE' && !target.suspended) {
        return no(cb, 'الحساب غير موقوف أو مقيّد أمنيًا.');
      }
      target.securityStatus = 'ACTIVE';
      target.activeService = false;
      target.suspended = false;
      target.suspensionReason = '';
      target.status = 'خارج الخدمة';
      const incident = recordSecurityEvent({
        actor,
        target,
        action: 'MEMBER_RESTORED',
        type: 'MANUAL_REVIEW',
        level: 1,
        reason: 'RESTORED_BY_CIA_CHIEF',
        status: 'RESTORED'
      });
      await notifySecurityLeadership(incident);
      saveState();
      emitState();
      const result = ok(cb, { action: 'reactivate', user: publicUser(target, actor) });
      socket.emit('admin:member:result', result);
      return result;
    });

    socket.on('admin:kickMember', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      const target = getUserById(clean(payload?.memberId || payload?.userId, 120));
      const reason = redactSecurityReason(payload?.reason);
      if (!actor) return no(cb, 'يجب تسجيل الدخول إلى الحساب أولاً.');
      if (!target) return no(cb, 'الشخصية غير موجودة.');
      if (!canManageMember(actor, target)) return no(cb, 'لا تملك صلاحية فصل هذه الشخصية.');
      if (!reason) return no(cb, 'سبب الفصل إلزامي.');
      target.activeService = false;
      target.suspended = true;
      target.securityStatus = 'SUSPENDED';
      target.suspensionReason = reason;
      target.online = false;
      target.status = 'مفصول';
      for (const socketId of sessions.get(target.id) || []) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) {
          targetSocket.emit('member:kicked', { message: 'تم فصل الشخصية من الخدمة.', reason });
        }
      }
      addAuditLog('فصل من الخدمة', actor, target, `سبب الفصل: ${redactSecurityReason(reason)}`);
      const incident = recordSecurityEvent({
        actor,
        target,
        action: 'MEMBER_SUSPENDED',
        type: 'ADMINISTRATIVE_SUSPENSION',
        level: 2,
        reason,
        status: 'SUSPENDED'
      });
      await notifySecurityLeadership(incident);
      saveState();
      emitState();
      const result = ok(cb, { action: 'kick', user: publicUser(target, actor) });
      socket.emit('admin:member:result', result);
      return result;
    });

    socket.on('admin:kickUser', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      const target = getUserById(clean(payload?.userId || payload?.memberId, 120));
      const reason = redactSecurityReason(payload?.reason);
      if (!actor) return no(cb, 'يجب تسجيل الدخول إلى الحساب أولاً.');
      if (!target) return no(cb, 'الشخصية غير موجودة.');
      if (!canManageMember(actor, target)) return no(cb, 'لا تملك صلاحية فصل هذه الشخصية.');
      if (!reason) return no(cb, 'سبب الفصل إلزامي.');
      target.activeService = false;
      target.suspended = true;
      target.securityStatus = 'SUSPENDED';
      target.suspensionReason = reason;
      target.online = false;
      target.status = 'مفصول';
      for (const socketId of sessions.get(target.id) || []) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) {
          targetSocket.emit('member:kicked', { message: 'تم فصل الشخصية من الخدمة.', reason });
        }
      }
      addAuditLog('فصل من الخدمة', actor, target, `سبب الفصل: ${redactSecurityReason(reason)}`);
      const incident = recordSecurityEvent({
        actor,
        target,
        action: 'MEMBER_SUSPENDED',
        type: 'ADMINISTRATIVE_SUSPENSION',
        level: 2,
        reason,
        status: 'SUSPENDED'
      });
      await notifySecurityLeadership(incident);
      saveState();
      emitState();
      return ok(cb, { action: 'kick', user: publicUser(target, actor) });
    });

    socket.on('radio:text', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const channel = clean(payload?.channel || actor.radioChannel || 'CH-1', 50);
      const text = clean(payload?.text || payload?.message, 2000);
      if (!text) return no(cb, 'الرسالة فارغة.');
      const moderation = await moderateOutgoingText(actor, text, 'RADIO');
      if (moderation) {
        return no(cb, moderation.message || 'تم حظر الرسالة بواسطة مركز الأمن.');
      }
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

    socket.on('radio:code', async (payload, cb) => {
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
      const moderation = await moderateOutgoingText(actor, `${packet.code} ${packet.meaning}`, 'RADIO_CODE');
      if (moderation) {
        return no(cb, moderation.message || 'تم حظر كود الراديو بواسطة مركز الأمن.');
      }
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
      if (actor.serviceApproved !== true) {
        return no(cb, 'يلزم قبول الشخصية واعتماد الهوية وطلب دخول الخدمة قبل مباشرة الخدمة.');
      }
      if (!actor.publicCode && !isLeadership(actor)) {
        return no(cb, 'لم يصدر الكود العسكري بعد؛ اطلب من CIA CHIEF إكمال اعتماد دخول الخدمة.');
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

    socket.on('operation:updateStatus', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, socketRequirementMessage(socket));
      const id = clean(payload?.operationId || payload?.id, 200);
      const operation = state.cia_operations.find((item) => String(item.id) === String(id));
      if (!operation) return no(cb, 'المهمة غير موجودة.');
      if (!canManageOperations(actor)) {
        return no(cb, 'تحديث المهمة متاح للرتب العليا الثلاث فقط.');
      }
      const previousStatus = operation.status;
      operation.status = clean(payload?.status, 100) || operation.status;
      addOperationStatusHistory(operation, actor, previousStatus);
      operation.updatedAt = now();
      saveState();
      await publishNotifications(state.cia_users, {
        type: 'OPERATION',
        title: 'OPERATION STATUS CHANGE',
        message: `تغيرت حالة العملية ${operation.missionNumber}: ${previousStatus} ← ${operation.status}.`,
        priority: operation.risk === 'HIGH' || operation.risk === 'CRITICAL' ? 'HIGH' : 'NOTICE',
        sourceUserId: actor.id,
        relatedId: operation.id,
        memberCodes: operation.memberCodes,
        metadata: { missionNumber: operation.missionNumber, status: operation.status, risk: operation.risk }
      });
      emitOperationState();
      return ok(cb, { operation: operationSanitize(operation, actor) });
    });

    socket.on('chat:send', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'يجب تسجيل الدخول.');
      const mode = payload?.mode === 'private' ? 'private' : 'global';
      const text = clean(payload?.text || payload?.message, 4000);
      const image = clean(payload?.image, 8 * 1024 * 1024);
      if (!text && !image) return no(cb, 'الرسالة فارغة.');
      const moderation = text
        ? await moderateOutgoingText(actor, text, mode === 'private' ? 'PRIVATE_CHAT' : 'CHAT')
        : false;
      if (moderation) {
        return no(cb, moderation.message || 'تم حظر الرسالة بواسطة مركز الأمن.');
      }

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
      let privateRecipient = null;
      if (mode === 'private') {
        const target = getUserByPublicCode(message.targetCode);
        if (!target) return no(cb, 'المستخدم المستهدف غير موجود.');
        privateRecipient = target;
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
      if (privateRecipient && privateRecipient.id !== actor.id) {
        await publishNotifications([privateRecipient], {
          type: 'MESSAGE',
          title: 'NEW MESSAGE',
          message: `وصلتك رسالة خاصة من ${actor.publicCode || 'Agent'}.`,
          priority: 'NOTICE',
          sourceUserId: actor.id,
          targetUserId: privateRecipient.id,
          sourceNameVisible: true,
          relatedId: message.id,
          metadata: { senderCode: actor.publicCode }
        });
      }
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

    socket.on('support:send', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      const senderName = actor
        ? actor.name
        : clean(payload?.name || payload?.characterName || 'شخصية غير معتمدة', 120);
      const text = clean(payload?.text || payload?.message, 3000);
      if (!text) return no(cb, 'اكتب الاستفسار أولاً.');
      const moderation = await moderateOutgoingText(actor, text, 'SUPPORT');
      if (moderation) {
        return no(cb, moderation.message || 'تم حظر الاستفسار بواسطة مركز الأمن.');
      }

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

    socket.on('support:reply', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor || !isLeadership(actor)) {
        return no(cb, 'الرد على استفسارات الاعتماد متاح للقائد وSenior Commander CIA فقط.');
      }
      const text = clean(payload?.text || payload?.message, 3000);
      const threadId = clean(payload?.threadId, 120);
      if (!text || !threadId) return no(cb, 'بيانات الرد غير مكتملة.');
      const moderation = await moderateOutgoingText(actor, text, 'SUPPORT_REPLY');
      if (moderation) {
        return no(cb, moderation.message || 'تم حظر الرد بواسطة مركز الأمن.');
      }
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

io.on('connection', (socket) => {
  registerIBPSocket(socket, {
    getState: () => state,
    requireSocketUser,
    clean,
    rankLevel,
    normalizeRank,
    rankLabel,
    isChief,
    isSenior,
    isLeadership,
    canManageIBPBattalions,
    ibpResolveCode,
    ibpBattalionForViewer,
    publicUser,
    now,
    makeId,
    addAuditLog,
    saveState,
    emitState,
    markLogin,
    markLogout,
    socketToUser
  });
});

/* =====================================================
   HTTP SERVER START
===================================================== */

function installPersistenceEmitBarriers() {
  const originalIoEmit = io.emit.bind(io);
  io.emit = function(event, ...args) {
    if (!stateStore) return originalIoEmit(event, ...args);
    stateStore.flush().then(() => originalIoEmit(event, ...args)).catch((error) => {
      console.error('[BLACK RIDGE] Broadcast skipped because persistence failed:', error.message);
    });
    return io;
  };
}

async function initializePersistence() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    postgresPool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000
    });
    postgresPool.on('error', (error) => {
      console.error('[BLACK RIDGE] Idle PostgreSQL connection error:', error.message);
    });
    await postgresPool.query('SELECT 1');
    stateStore = new PostgresStateStore(postgresPool);
    state = await stateStore.load({
      initialState: EMPTY_STATE,
      getLegacyState: () => {
        const legacy = readLegacyStateFile();
        if (legacy) console.log('[BLACK RIDGE] Importing legacy JSON data from ' + legacy.file);
        return legacy ? legacy.state : null;
      },
      normalizeState: (value) => normalizePersistedState(value, 'PostgreSQL state')
    });
    notificationsStore = new NotificationsStore(postgresPool, {
      getRows: () => state.cia_notifications || [],
      setRows: (rows) => {
        state.cia_notifications = rows;
        saveState();
      }
    });
    await notificationsStore.initialize();
    installPersistenceEmitBarriers();
    console.log('[BLACK RIDGE] PostgreSQL state store ready.');
    console.log('[BLACK RIDGE] PostgreSQL notification store ready.');
    return;
  }

  if (IS_RENDER_RUNTIME) {
    console.warn('[BLACK RIDGE] DATABASE_URL is not configured; using temporary JSON state at ' + DATA_FILE + '. State may be lost on restart or redeploy.');
  }

  prepareFileStorage();
  state = loadState();
  notificationsStore = new NotificationsStore(null, {
    getRows: () => state.cia_notifications || [],
    setRows: (rows) => {
      state.cia_notifications = rows;
      saveState();
    }
  });
  await notificationsStore.initialize();
  console.log((IS_RENDER_RUNTIME ? '[BLACK RIDGE] Render temporary JSON state store ready: ' : '[BLACK RIDGE] Local JSON state store ready: ') + DATA_FILE);
}

let shutdownPromise = null;
function installGracefulShutdown() {
  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      console.log('[BLACK RIDGE] ' + signal + ' received; draining connections and saved-state writes.');
      const forceExitTimer = setTimeout(() => {
        console.error('[BLACK RIDGE] Shutdown timed out while draining state writes.');
        process.exit(1);
      }, 25000);
      if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();

      try {
        await new Promise((resolve) => io.close(resolve));
      } catch (error) {
        console.error('[BLACK RIDGE] Error closing Socket.IO:', error.message);
        process.exitCode = 1;
      }
      try {
        if (stateStore) await stateStore.flush();
      } catch (error) {
        console.error('[BLACK RIDGE] Pending PostgreSQL writes did not finish cleanly:', error.message);
        process.exitCode = 1;
      }
      try {
        if (postgresPool) await postgresPool.end();
      } catch (error) {
        console.error('[BLACK RIDGE] Error closing PostgreSQL pool:', error.message);
        process.exitCode = 1;
      } finally {
        clearTimeout(forceExitTimer);
      }
    })();
    return shutdownPromise;
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

async function startServer() {
  await initializePersistence();
  httpServer.listen(PORT, () => {
    console.log('');
    console.log('==================================================');
    console.log(' BLACK RIDGE CITY CIA SYSTEM');
    console.log(' PORT: ' + PORT);
    console.log(' STATUS: ONLINE');
    console.log(' LOGIN / LEADERSHIP / RADIO / SOS: READY');
    console.log('==================================================');
    installGracefulShutdown();
  });
}

startServer().catch(async (error) => {
  console.error('[BLACK RIDGE] Startup failed:', error.message);
  if (postgresPool) {
    try {
      await postgresPool.end();
    } catch (closeError) {
      console.error('[BLACK RIDGE] Error closing PostgreSQL pool after startup failure:', closeError.message);
    }
  }
  process.exitCode = 1;
});
