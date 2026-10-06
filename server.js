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
const { pageHtml, registerPages } = require('./ibp/pages');
const { registerIBPSocket } = require('./ibp/handlers');
const { readChiefBootstrapConfig, withoutBootstrapCodes } = require('./chief-bootstrap');

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
  '/ibp/ibp.css': path.join('ibp', 'ibp.css'),
  '/ibp/ibp.js': path.join('ibp', 'ibp.js'),
  '/ibp/command-center.css': path.join('ibp', 'command-center.css')
});

for (const [route, file] of Object.entries(publicAssets)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
}

app.get(['/', '/index.html'], (req, res) => {
  return res.type('html').send(pageHtml('dashboard', req.path, ''));
});

registerPages(app);

const now = () => new Date().toISOString();
const clean = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const redactSecurityReason = (value) => clean(value, 300)
  .replace(/\b(password|passcode|secret(?:\s+code)?|api[\s-]*key|access[\s-]*token|token)\s*(?::|=|\bis\b)\s*[^\s,;]+/giu, '$1=[REDACTED]')
  .replace(/(ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±|ÙƒÙ„Ù…Ù‡ Ø§Ù„Ù…Ø±ÙˆØ±|Ø±Ù…Ø² Ø§Ù„Ø¯Ø®ÙˆÙ„|Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ø³Ø±ÙŠ)\s*(?::|=|Ù‡Ùˆ)?\s*[^\s,;]+/gu, '$1=[Ù…Ø­Ø¬ÙˆØ¨]');
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
  user.status = clean(user.status || 'ÙÙŠ Ø§Ù„Ø®Ø¯Ù…Ø©', 100);

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
    return 'Ø§Ù„ÙƒÙˆØ¯ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† 4 Ø£Ø­Ø±Ù/Ø£Ø±Ù‚Ø§Ù… Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„.';
  }

  if (code === SYSTEM.memberRequestCode) {
    return 'Ù‡Ø°Ø§ Ø§Ù„ÙƒÙˆØ¯ Ù…Ø­Ø¬ÙˆØ² Ù„Ø·Ù„Ø¨Ø§Øª Ø§Ù„Ù‚Ø¨ÙˆÙ„.';
  }

  if (code === SYSTEM.chiefRegistrationCode) {
    return 'Ù‡Ø°Ø§ Ø§Ù„ÙƒÙˆØ¯ Ù…Ø­Ø¬ÙˆØ² Ù„ØªØ£Ø³ÙŠØ³ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.';
  }

  if (code === SYSTEM.chiefSaveCode) {
    return 'Ù‡Ø°Ø§ Ø§Ù„ÙƒÙˆØ¯ Ù…Ø­Ø¬ÙˆØ² ÙƒØ±Ù…Ø² Ø­Ù…Ø§ÙŠØ© Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.';
  }

  if (
    state.cia_users.some(
      (u) =>
        u.id !== target?.id &&
        u.secretCode === code
    )
  ) {
    return 'ÙƒÙˆØ¯ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ù…Ø³ØªØ®Ø¯Ù… Ù…Ù† Ø´Ø®ØµÙŠØ© Ø£Ø®Ø±Ù‰.';
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
      'ÙÙŠ Ø§Ù„Ø®Ø¯Ù…Ø©',

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
  notificationCount = null
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
    ...(Number.isFinite(notificationCount) ? { notificationCount } : {})
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
  if (isChief(viewer)) {
    result.userId = incident.userId;
    result.userName = incident.userName;
    result.actorId = incident.actorId;
    result.actorName = incident.actorName;
    result.reason = incident.reason;
  }
  return result;
}

async function notifySecurityLeadership(incident) {
  const priority = incident.level === 'LEVEL 4' || incident.level === 'LEVEL 3'
    ? 'CRITICAL'
    : incident.level === 'LEVEL 2' ? 'HIGH' : 'NOTICE';
  const notifications = await publishNotifications(state.cia_users, {
    type: 'SECURITY',
    title: 'SECURITY ALERT',
    message: `${incident.publicCode ? `#${incident.publicCode}` : 'Ø¹Ø¶Ùˆ'} â€” ${incident.type} â€” ${incident.level} â€” ${incident.action}`,
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
      status: incident.status
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
  actor.securityViolationCount = (Number(actor.securityViolationCount) || 0) + 1;
  let level = detection.level;
  if (level < 2 && actor.securityViolationCount >= 2) level = 2;
  const status = level >= 3 ? 'SUSPENDED' : level === 2 ? 'SECURITY_RESTRICTED' : 'REVIEW_REQUIRED';
  if (level >= 2) {
    actor.securityStatus = status;
    actor.suspended = level >= 3;
    actor.activeService = false;
    actor.radioOnline = false;
    actor.status = level >= 3 ? 'Ù…ÙˆÙ‚ÙˆÙ Ø£Ù…Ù†ÙŠØ§Ù‹' : 'Ù…Ù‚ÙŠÙ‘Ø¯ Ø£Ù…Ù†ÙŠØ§Ù‹';
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
  if (level >= 2) endRestrictedSessions(actor, 'ØªÙ… ØªÙ‚ÙŠÙŠØ¯ Ø§Ù„Ø­Ø³Ø§Ø¨ Ø£Ù…Ù†ÙŠÙ‹Ø§. Ø±Ø§Ø¬Ø¹ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.');
  await notifySecurityLeadership(incident);
  saveState();
  emitState();
  return incident;
}

async function moderateOutgoingText(actor, text, channel) {
  const detection = inspectMessage(text, process.env.CIA_SECURITY_BLOCKED_TERMS || '');
  if (!detection) return false;
  if (actor) {
    await recordModerationViolation(actor, detection, channel);
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
    const item = { publicCode: person.publicCode, rank: normalizeRank(person.rank), rankLabel: rankLabel(person.rank), online: !!person.online, status: person.status || 'ÙÙŠ Ø§Ù„Ø®Ø¯Ù…Ø©', activeService: person.activeService === true };
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
              .find((value) => value && !['unknown', 'ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ', 'unnamed'].includes(lower(value))) || '';
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
      reply(cb, { ok: false, message: 'ØªØ¹Ø°Ø± ØªØ£ÙƒÙŠØ¯ Ø­ÙØ¸ Ø§Ù„ØªØºÙŠÙŠØ± ÙÙŠ Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª. Ø£Ø¹Ø¯ Ø§Ù„Ù…Ø­Ø§ÙˆÙ„Ø© Ø¨Ø¹Ø¯ Ø§Ø³ØªÙ‚Ø±Ø§Ø± Ø§Ù„Ø§ØªØµØ§Ù„.' });
    });
    return response;
  }
  return reply(cb, response);
}

function no(cb, message) {
  const normalizedMessage = clean(message, 500);
  const loginMessage =
    normalizedMessage === 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.' ||
    normalizedMessage === 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø£ÙˆÙ„Ø§Ù‹.'
      ? 'ÙŠÙ„Ø²Ù… ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø¥Ù„Ù‰ Ø§Ù„Ø­Ø³Ø§Ø¨ Ø£ÙˆÙ„Ø§Ù‹. Ø¥Ø°Ø§ ÙƒÙ†Øª Ù‚Ø¯ Ø³Ø¬Ù„Øª Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø¨Ø§Ù„ÙØ¹Ù„ØŒ Ø§Ø¶ØºØ· Â«ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ù„Ù„Ø®Ø¯Ù…Ø©Â» Ù…Ù† Ø¨Ø·Ø§Ù‚Ø© Ø§Ù„Ø­Ø§Ù„Ø© Ø§Ù„Ù…ÙŠØ¯Ø§Ù†ÙŠØ©Ø› ÙˆØ¥Ø°Ø§ ÙƒØ§Ù†Øª Ù‡ÙˆÙŠØªÙƒ Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø§Ù„Ø§Ø¹ØªÙ…Ø§Ø¯ ÙØ§Ù†ØªØ¸Ø± Ù…ÙˆØ§ÙÙ‚Ø© Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.'
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
    user.status = 'Ø®Ø§Ø±Ø¬ Ø§Ù„Ø®Ø¯Ù…Ø©';
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
      'ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„',
      user,
      user,
      'ØªÙ… ØªØ³Ø¬ÙŠÙ„ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
      'ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø®Ø±ÙˆØ¬',
      user,
      user,
      'ØªÙ… ØªØ³Ø¬ÙŠÙ„ Ø®Ø±ÙˆØ¬ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
    return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø£ÙˆÙ„Ø§Ù‹.');
  }
  if (user.serviceApproved === false) {
    return no(cb, 'Ù„Ø§ ÙŠÙ…ÙƒÙ†Ùƒ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ù„Ù„Ø®Ø¯Ù…Ø© Ù‚Ø¨Ù„ Ù‚Ø¨ÙˆÙ„ Ø§Ù„Ù‡ÙˆÙŠØ© Ù…Ù† Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.');
  }
  if (user.activeService !== true) {
    return no(cb, 'ÙŠÙ„Ø²Ù… ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ù„Ù„Ø®Ø¯Ù…Ø© Ø£ÙˆÙ„Ø§Ù‹.');
  }
  return null;
}

function socketRequirementMessage(socket) {
  const user = requireAuthenticatedUser(socket);
  if (!user) return 'Ø³Ø¬Ù‘Ù„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø¥Ù„Ù‰ Ø­Ø³Ø§Ø¨Ùƒ Ø£ÙˆÙ„Ø§Ù‹.';
  if (user.serviceApproved === false) return 'Ù‡ÙˆÙŠØªÙƒ Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©Ø› Ø£ÙƒÙ…Ù„ Ø§Ø¹ØªÙ…Ø§Ø¯Ù‡Ø§ Ù‚Ø¨Ù„ Ø§Ø³ØªØ®Ø¯Ø§Ù… Ø§Ù„Ù†Ø¸Ø§Ù….';
  return 'ØªØ¹Ø°Ø± Ø±Ø¨Ø· Ø§Ù„Ø¬Ù„Ø³Ø© Ø¨Ø§Ù„Ø®Ø§Ø¯Ù…Ø› Ø£Ø¹Ø¯ Ø§Ù„Ø§ØªØµØ§Ù„ Ø«Ù… Ø­Ø§ÙˆÙ„ Ù…Ø¬Ø¯Ø¯Ù‹Ø§.';
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
    'ØµØ±Ù Ø±Ø§ØªØ¨',
    null,
    user,
    `ØªÙ… Ø¥ÙŠØ¯Ø§Ø¹ ${amount} ÙÙŠ Ø§Ù„Ø­Ø³Ø§Ø¨ Ø§Ù„Ø¨Ù†ÙƒÙŠ.`
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
    PLANNED: 'Ù…Ø®Ø·Ø·Ø©',
    IN_PROGRESS: 'Ù‚ÙŠØ¯ Ø§Ù„ØªÙ†ÙÙŠØ°',
    COMPLETED: 'Ù…ÙƒØªÙ…Ù„Ø©',
    FAILED: 'ÙØ´Ù„Øª',
    CANCELLED: 'Ù…Ù„ØºØ§Ø©'
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

    socket.emit(
      'state:update',
      snapshot(null)
    );

    socket.on('notification:count', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
      try {
        const counts = await notificationsStore.countsForUser(actor.id);
        socket.emit('notification:count', counts);
        return ok(cb, { counts });
      } catch (error) {
        console.error('[BLACK RIDGE] Notification count query failed:', error.message);
        return no(cb, 'ØªØ¹Ø°Ø± ØªØ­Ù…ÙŠÙ„ Ø¹Ø¯Ø§Ø¯ Ø§Ù„Ø¥Ø´Ø¹Ø§Ø±Ø§Øª.');
      }
    });

    socket.on('notification:list', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
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
        return no(cb, 'ØªØ¹Ø°Ø± ØªØ­Ù…ÙŠÙ„ Ù…Ø±ÙƒØ² Ø§Ù„Ø¥Ø´Ø¹Ø§Ø±Ø§Øª.');
      }
    });

    socket.on('notification:since', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
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
        return no(cb, 'ØªØ¹Ø°Ø± ØªØ­Ù…ÙŠÙ„ Ù…Ù„Ø®Øµ Ø§Ù„ØºÙŠØ§Ø¨.');
      }
    });

    socket.on('notification:read', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
      try {
        const notification = await notificationsStore.markRead(actor.id, clean(payload?.id, 200));
        if (!notification) return no(cb, 'Ø§Ù„Ø¥Ø´Ø¹Ø§Ø± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯ Ø£Ùˆ Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø¹Ø±Ø¶Ù‡.');
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
        return no(cb, 'ØªØ¹Ø°Ø± ØªØ­Ø¯ÙŠØ« Ø­Ø§Ù„Ø© Ø§Ù„Ø¥Ø´Ø¹Ø§Ø±.');
      }
    });

    socket.on('notification:markAllRead', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
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
        return no(cb, 'ØªØ¹Ø°Ø± ØªØ­Ø¯ÙŠØ« Ø§Ù„Ø¥Ø´Ø¹Ø§Ø±Ø§Øª.');
      }
    });

    socket.on('notification:acknowledge', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
      try {
        const notification = await notificationsStore.acknowledge(actor.id, clean(payload?.id, 200));
        if (!notification) return no(cb, 'ÙŠÙ…ÙƒÙ† ØªØ£ÙƒÙŠØ¯ Ø§Ù„Ø¥Ø´Ø¹Ø§Ø±Ø§Øª Ø§Ù„Ø­Ø±Ø¬Ø© Ø§Ù„Ø®Ø§ØµØ© Ø¨Ø­Ø³Ø§Ø¨Ùƒ ÙÙ‚Ø·.');
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
        return no(cb, 'ØªØ¹Ø°Ø± ØªØ£ÙƒÙŠØ¯ Ø§Ù„ØªÙ†Ø¨ÙŠÙ‡ Ø§Ù„Ø­Ø±Ø¬.');
      }
    });

    socket.on('security:getLogs', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
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
        return no(cb, 'Ù…Ø±ÙƒØ² Ø§Ù„Ø£Ù…Ù† Ù…ØªØ§Ø­ Ù„Ù„Ù‚ÙŠØ§Ø¯Ø© Ø§Ù„Ø£Ù…Ù†ÙŠØ© ÙÙ‚Ø·.');
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
        return no(cb, 'ØªØ¹Ø°Ø± ØªØ­Ù…ÙŠÙ„ Ø³Ø¬Ù„ Ø§Ù„Ø£Ù…Ù†.');
      }
    });

    socket.on('security:suspendMember', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
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
        return no(cb, 'Ø¥ÙŠÙ‚Ø§Ù Ø§Ù„Ø¹Ø¶Ùˆ Ø£Ù…Ù†ÙŠÙ‹Ø§ Ù…ØªØ§Ø­ Ù„Ù€ CIA CHIEF ÙÙ‚Ø·.');
      }
      const target = getUserById(clean(payload?.userId, 120));
      const reason = redactSecurityReason(payload?.reason);
      if (!target || target.id === actor.id) return no(cb, 'Ø§Ø®ØªØ± Ø¹Ø¶ÙˆÙ‹Ø§ Ø¢Ø®Ø± Ù„Ø¥ÙŠÙ‚Ø§ÙÙ‡.');
      if (!reason) return no(cb, 'Ø³Ø¨Ø¨ Ø§Ù„Ø¥ÙŠÙ‚Ø§Ù Ù…Ø·Ù„ÙˆØ¨.');
      if (target.securityStatus !== 'ACTIVE') return no(cb, 'Ø§Ù„Ø¹Ø¶Ùˆ Ù…Ù‚ÙŠÙ‘Ø¯ Ø£Ùˆ Ù…ÙˆÙ‚ÙˆÙ Ø¨Ø§Ù„ÙØ¹Ù„.');

      target.securityStatus = 'SUSPENDED';
      target.suspended = true;
      target.suspensionReason = reason;
      target.activeService = false;
      target.online = false;
      target.radioOnline = false;
      target.status = 'Ù…ÙˆÙ‚ÙˆÙ Ø£Ù…Ù†ÙŠØ§Ù‹';
      const incident = recordSecurityEvent({
        actor,
        target,
        action: 'MEMBER_SUSPENDED',
        type: 'MANUAL_REVIEW',
        level: 2,
        reason,
        status: 'SUSPENDED'
      });
      endRestrictedSessions(target, 'ØªÙ… Ø¥ÙŠÙ‚Ø§Ù Ø§Ù„Ø­Ø³Ø§Ø¨ Ø£Ù…Ù†ÙŠÙ‹Ø§. Ø±Ø§Ø¬Ø¹ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.');
      await notifySecurityLeadership(incident);
      saveState();
      emitState();
      return ok(cb, { action: 'suspend', user: publicUser(target, actor) });
    });

    socket.on('security:restoreMember', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
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
        return no(cb, 'Ø¥Ø¹Ø§Ø¯Ø© Ø§Ù„Ø¹Ø¶Ùˆ Ù…Ù† Ø§Ù„Ø¥ÙŠÙ‚Ø§Ù Ø§Ù„Ø£Ù…Ù†ÙŠ Ù…ØªØ§Ø­Ø© Ù„Ù€ CIA CHIEF ÙÙ‚Ø·.');
      }
      if (!target || target.id === actor.id) return no(cb, 'Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø§Ø³ØªØ¹Ø§Ø¯Ø© Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨.');
      if (target.securityStatus === 'ACTIVE' && !target.suspended) {
        return no(cb, 'Ø§Ù„Ø­Ø³Ø§Ø¨ ØºÙŠØ± Ù…ÙˆÙ‚ÙˆÙ Ø£Ùˆ Ù…Ù‚ÙŠÙ‘Ø¯ Ø£Ù…Ù†ÙŠÙ‹Ø§.');
      }

      target.securityStatus = 'ACTIVE';
      target.suspended = false;
      target.suspensionReason = '';
      target.activeService = false;
      target.online = false;
      target.radioOnline = false;
      target.status = 'Ø®Ø§Ø±Ø¬ Ø§Ù„Ø®Ø¯Ù…Ø©';
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
              'ØªØ¹Ø°Ø± Ø­ÙØ¸ Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ø´ØªØ±ÙƒØ©.'
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
              'Ù†ÙˆØ¹ Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª ØºÙŠØ± Ù…Ø³Ù…ÙˆØ­.'
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
              'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ù„Ø¥Ø¯Ø§Ø±Ø© Ù…ÙˆØ§Ù‚Ø¹ Ø§Ù„Ø®Ø±ÙŠØ·Ø©.'
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
              'ØªØ¹Ø°Ø± Ø­ÙØ¸ Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª.'
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
              'Ø£ÙƒÙ…Ù„ Ø¨ÙŠØ§Ù†Ø§Øª Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ø­Ø³Ø§Ø¨.'
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
              'Ø§Ø³Ù… ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ù…Ø³ØªØ®Ø¯Ù… Ø¨Ø§Ù„ÙØ¹Ù„.'
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
              'Ø§Ø³Ù… Ø§Ù„Ø´Ø®ØµÙŠØ© Ù…Ø³ØªØ®Ø¯Ù… Ø¨Ø§Ù„ÙØ¹Ù„.'
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
              'ÙŠÙˆØ¬Ø¯ Ø·Ù„Ø¨ Ù…Ø¹Ù„Ù‚ Ù„Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
            'Ø¥Ù†Ø´Ø§Ø¡ Ø­Ø³Ø§Ø¨',
            null,
            null,
            `ØªÙ… Ø¥Ù†Ø´Ø§Ø¡ Ø­Ø³Ø§Ø¨ ${loginName} Ù…Ø¹ Ø§Ù„Ø´Ø®ØµÙŠØ© ${characterName}.`
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
                'ØªÙ… Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ø­Ø³Ø§Ø¨ ÙˆØ¥Ø±Ø³Ø§Ù„ Ø·Ù„Ø¨ Ø§Ù„Ù‚Ø¨ÙˆÙ„ Ø¥Ù„Ù‰ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.'
            }
          );
        } catch (error) {
          return no(
            cb,
            error.message ||
              'ØªØ¹Ø°Ø± Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ø­Ø³Ø§Ø¨.'
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
                'ÙŠÙˆØ¬Ø¯ CIA CHIEF Ø¨Ø§Ù„ÙØ¹Ù„.'
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
                'Ø£ÙƒÙ…Ù„ Ø¨ÙŠØ§Ù†Ø§Øª ØªØ£Ø³ÙŠØ³ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.'
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
              'ØªØ£Ø³ÙŠØ³ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø© ØºÙŠØ± Ù…ØªØ§Ø­Ø› Ø§Ø¶Ø¨Ø· Ù…ØªØºÙŠØ±ÙŠ CIA_CHIEF_REGISTRATION_CODE ÙˆCIA_CHIEF_SAVE_CODE Ø¨Ù‚ÙŠÙ…ØªÙŠÙ† Ø¹Ø´ÙˆØ§Ø¦ÙŠØªÙŠÙ† Ù…Ø®ØªÙ„ÙØªÙŠÙ† Ù„Ø§ ØªÙ‚Ù„ ÙƒÙ„ Ù…Ù†Ù‡Ù…Ø§ Ø¹Ù† 24 Ø­Ø±ÙØ§Ù‹.'
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
                'Ø±Ù…Ø² ØªØ£Ø³ÙŠØ³ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø© ØºÙŠØ± ØµØ­ÙŠØ­.'
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
                'Ø±Ù…Ø² Ø§Ù„Ø­ÙØ¸ Ø§Ù„Ø³Ø±ÙŠ Ù„Ù„Ù‚ÙŠØ§Ø¯Ø© ØºÙŠØ± ØµØ­ÙŠØ­.'
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
                'ÙÙŠ Ø§Ù„Ø®Ø¯Ù…Ø©',

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
            'ØªØ£Ø³ÙŠØ³ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©',
            chief,
            chief,
            'ØªÙ… Ø¥Ù†Ø´Ø§Ø¡ CIA CHIEF Ù„Ø£ÙˆÙ„ Ù…Ø±Ø©.'
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
                'ØªØ¹Ø°Ø± ØªØ£Ø³ÙŠØ³ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.'
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
                ? `ØªÙ… ØªÙ‚ÙŠÙŠØ¯ Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ© Ø£Ù…Ù†ÙŠÙ‹Ø§. ${suspended.suspensionReason ? `Ø³Ø¨Ø¨ Ø§Ù„Ø¥Ø¬Ø±Ø§Ø¡: ${suspended.suspensionReason}` : 'Ø±Ø§Ø¬Ø¹ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø© Ù„Ù…Ø¹Ø±ÙØ© Ø§Ù„Ø¥Ø¬Ø±Ø§Ø¡.'}`
                : rejected
                ? rejected.rejectionMessage
                : pending
                ? 'Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ© Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ù‚Ø¨ÙˆÙ„ CIA CHIEF. ÙƒÙˆØ¯ Ø§Ù„ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø£ÙˆÙ„ÙŠ Ù„Ø§ ÙŠÙ…Ù†Ø­ ØµÙ„Ø§Ø­ÙŠØ© Ø¯Ø®ÙˆÙ„.'
                : 'Ø§Ù„Ø§Ø³Ù… Ø£Ùˆ ÙƒÙˆØ¯ Ø§Ù„Ø¯Ø®ÙˆÙ„ ØºÙŠØ± Ù…ØªØ·Ø§Ø¨Ù‚ÙŠÙ†.';

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
              message: `ØªÙ… Ø¥ÙŠØ¯Ø§Ø¹ Ø±Ø§ØªØ¨Ùƒ: ${salary}$`,
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
              message: `ØªØ³Ø¬ÙŠÙ„ Ø¯Ø®ÙˆÙ„ Ø¬Ø¯ÙŠØ¯ Ù…Ù† ${user.publicCode || 'Ø­Ø³Ø§Ø¨ CIA'}.`,
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
                'ØªØ¹Ø°Ø± ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'ØªÙ… ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø®Ø±ÙˆØ¬.'
        });
      }
    );
socket.on('member:saveIdentity', (payload, cb) => {
  try {
    const actor = requireAuthenticatedUser(socket);

    if (!actor) {
      return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø£ÙˆÙ„Ø§Ù‹.');
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
      return no(cb, 'Ø§Ù„Ø§Ø³Ù… Ø§Ù„ÙƒØ§Ù…Ù„ ÙˆØªØ§Ø±ÙŠØ® Ø§Ù„Ù…ÙŠÙ„Ø§Ø¯ ÙˆØ§Ù„Ø¬Ù†Ø³ÙŠØ© Ø¥Ù„Ø²Ø§Ù…ÙŠØ©.');
    }

    actor.identity = identity;
    actor.identityRequired = false;
    if (!isLeadership(actor)) {
      actor.identityApproved = false;
      actor.identityApprovalPending = true;
      actor.serviceApprovalPending = false;
      actor.serviceApproved = false;
      actor.activeService = false;
      actor.status = 'Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ù‡ÙˆÙŠØ©';
    }

    saveState();

    addAuditLog(
      'Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ù‡ÙˆÙŠØ©',
      actor,
      actor,
      isLeadership(actor)
        ? 'ØªÙ… Ø­ÙØ¸ Ø§Ù„Ù‡ÙˆÙŠØ© Ø§Ù„Ø£Ù…Ù†ÙŠØ© Ù„Ù„Ø´Ø®ØµÙŠØ© Ø§Ù„Ù‚ÙŠØ§Ø¯ÙŠØ©.'
        : 'ØªÙ… Ø­ÙØ¸ Ø§Ù„Ù‡ÙˆÙŠØ© ÙˆØ¥Ø±Ø³Ø§Ù„ Ø·Ù„Ø¨ Ø§Ø¹ØªÙ…Ø§Ø¯Ù‡Ø§ Ø¥Ù„Ù‰ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.'
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
      error.message || 'ØªØ¹Ø°Ø± Ø­ÙØ¸ Ø§Ù„Ù‡ÙˆÙŠØ©.'
    );
  }
});

    socket.on('service:request', (payload, cb) => {
      try {
        const actor = requireAuthenticatedUser(socket);
        if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø£ÙˆÙ„Ø§Ù‹.');
        if (actor.suspended || actor.approved === false) return no(cb, 'Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø¥Ø±Ø³Ø§Ù„ Ø·Ù„Ø¨ Ø§Ù„Ø®Ø¯Ù…Ø© Ù„Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨.');
        if (actor.identityApprovalPending || actor.identityApproved !== true) {
          return no(cb, 'ÙŠØ¬Ø¨ Ø§Ø¹ØªÙ…Ø§Ø¯ Ù‡ÙˆÙŠØªÙƒ Ø£ÙˆÙ„Ø§Ù‹ Ù‚Ø¨Ù„ Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©.');
        }
        if (actor.serviceApproved === true) return no(cb, 'ØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ Ø¯Ø®ÙˆÙ„Ùƒ Ù„Ù„Ø®Ø¯Ù…Ø© Ø¨Ø§Ù„ÙØ¹Ù„.');
        if (actor.serviceApprovalPending === true) return no(cb, 'Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø© Ù‚ÙŠØ¯ Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹Ø© Ø¨Ø§Ù„ÙØ¹Ù„.');
        actor.serviceApprovalPending = true;
        actor.activeService = false;
        actor.status = 'Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ù…ÙˆØ§ÙÙ‚Ø© Ø§Ù„Ù‚Ø§Ø¦Ø¯ Ø¹Ù„Ù‰ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©';
        addAuditLog('Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©', actor, actor, 'ØªÙ… Ø¥Ø±Ø³Ø§Ù„ Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø© Ø¨Ø¹Ø¯ Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ù‡ÙˆÙŠØ©.');
        saveState();
        emitState();
        for (const targetSocket of io.sockets.sockets.values()) {
          const targetUser = targetSocket.userId ? getUserById(targetSocket.userId) : null;
          if (targetUser && isChief(targetUser)) targetSocket.emit('service:approval:new', { userId: actor.id });
        }
        return ok(cb, { pending: true, user: publicUser(actor, actor) });
      } catch (error) {
        return no(cb, error.message || 'ØªØ¹Ø°Ø± Ø¥Ø±Ø³Ø§Ù„ Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©.');
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
            'ØºÙŠØ± Ù…Ø³Ø¬Ù„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'ØºÙŠØ± Ù…Ø³Ø¬Ù„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
          );
        }

        user.online = true;
        // Presence does not start duty; only duty:start changes activeService.
        user.status =
          clean(
            payload?.status ||
              user.status ||
              (user.activeService === true ? 'ÙÙŠ Ø§Ù„Ø®Ø¯Ù…Ø©' : 'Ø®Ø§Ø±Ø¬ Ø§Ù„Ø®Ø¯Ù…Ø©'),
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
              'Ø£Ø¯Ø®Ù„ Ø§Ø³Ù… Ø§Ù„Ø´Ø®ØµÙŠØ© ÙˆØ§Ù„ÙƒÙˆØ¯.'
            );
          }

          if (
            code !==
            SYSTEM.memberRequestCode
          ) {
            return no(
              cb,
              'ÙƒÙˆØ¯ Ø·Ù„Ø¨ Ø§Ù„Ù‚Ø¨ÙˆÙ„ ØºÙŠØ± ØµØ­ÙŠØ­.'
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
              'ÙŠÙˆØ¬Ø¯ Ø·Ù„Ø¨ Ù‚Ø¨ÙˆÙ„ Ù…Ø³Ø¨Ù‚ Ù„Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
              'Ø§Ù„Ø´Ø®ØµÙŠØ© Ù…ÙˆØ¬ÙˆØ¯Ø© Ø¨Ø§Ù„ÙØ¹Ù„ ÙÙŠ Ø§Ù„Ù†Ø¸Ø§Ù….'
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
            'Ø·Ù„Ø¨ Ù‚Ø¨ÙˆÙ„',
            null,
            null,
            `ØªÙ… ØªÙ‚Ø¯ÙŠÙ… Ø·Ù„Ø¨ Ù‚Ø¨ÙˆÙ„ Ù„Ù„Ø´Ø®ØµÙŠØ© ${name}.`
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
              'ØªØ¹Ø°Ø± Ø¥Ø±Ø³Ø§Ù„ Ø·Ù„Ø¨ Ø§Ù„Ù‚Ø¨ÙˆÙ„.'
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
              'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
              return no(cb, 'Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ù‡ÙˆÙŠØ§Øª Ù…ØªØ§Ø­ Ù„Ù„Ù‚Ø§Ø¦Ø¯ ÙˆSenior Commander CIA ÙÙ‚Ø·.');
            }
            if (!target) {
              return no(cb, 'Ø§Ù„Ø´Ø®ØµÙŠØ© Ø§Ù„Ù…Ø³ØªÙ‡Ø¯ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.');
            }
            if (!target.identityApprovalPending) {
              return no(cb, 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø·Ù„Ø¨ Ø§Ø¹ØªÙ…Ø§Ø¯ Ù‡ÙˆÙŠØ© Ù„Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.');
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
              target.status = 'Ù…Ø±ÙÙˆØ¶Ø©';
              target.rejectionMessage =
                'ØªÙ… Ø±ÙØ¶Ùƒ. Ù„Ø£ÙŠ Ø§Ø³ØªÙØ³Ø§Ø± Ù‚Ù… Ø¨Ø¥Ø±Ø³Ø§Ù„Ù‡ Ù‡Ù†Ø§ØŒ ÙˆØ³ÙŠØµÙ„ Ø¥Ù„Ù‰ CIA CHIEF ÙˆSenior Commander CIA ÙÙ‚Ø·.';
              addAuditLog('Ø±ÙØ¶ Ø§Ù„Ù‡ÙˆÙŠØ©', actor, target, target.rejectionMessage);
            } else {
              target.identityApprovalPending = false;
              target.identityApproved = true;
              target.serviceApprovalPending = false;
              target.serviceApproved = false;
              target.activeService = false;
              target.approved = true;
              target.rejectionMessage = '';
              target.status = 'Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©';
              addAuditLog('Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ù‡ÙˆÙŠØ©', actor, target, 'ØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ù‡ÙˆÙŠØ© Ù…Ù† Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.');
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
                    : 'ØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ Ù‡ÙˆÙŠØªÙƒ. Ø£Ø±Ø³Ù„ Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø© Ù…Ù† Ù„ÙˆØ­Ø© Ø§Ù„Ø­Ø§Ù„Ø© Ù„Ù„Ù…ØªØ§Ø¨Ø¹Ø©.',
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
                : 'ØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ù‡ÙˆÙŠØ©Ø› Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©.',
              secretCode: null,
              publicCode: null
            });
          }

          /* -------------------------------------------------
             FINAL SERVICE APPROVAL
          ------------------------------------------------- */

          if (action === 'approve_service' || action === 'reject_service') {
            if (!isChief(actor)) return no(cb, 'Ø§Ø¹ØªÙ…Ø§Ø¯ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø© Ù…ØªØ§Ø­ Ù„Ù€ CIA CHIEF ÙÙ‚Ø·.');
            if (!target) return no(cb, 'Ø§Ù„Ø´Ø®ØµÙŠØ© Ø§Ù„Ù…Ø³ØªÙ‡Ø¯ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.');
            if (target.identityApproved !== true || target.identityApprovalPending === true) {
              return no(cb, 'Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ù‡ÙˆÙŠØ© Ù…Ø·Ù„ÙˆØ¨ Ù‚Ø¨Ù„ Ù…Ø±Ø§Ø¬Ø¹Ø© Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©.');
            }
            if (target.serviceApproved === true) return no(cb, 'ØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ Ø¯Ø®ÙˆÙ„ Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ© Ù„Ù„Ø®Ø¯Ù…Ø© Ø¨Ø§Ù„ÙØ¹Ù„.');
            if (target.serviceApprovalPending !== true) return no(cb, 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø®Ø¯Ù…Ø© Ù…Ø¹Ù„Ù‚ Ù„Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.');

            const rejecting = action === 'reject_service';
            target.serviceApprovalPending = false;
            target.activeService = false;
            if (rejecting) {
              target.serviceApproved = false;
              target.status = 'ØªÙ… Ø±ÙØ¶ Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©';
              addAuditLog('Ø±ÙØ¶ Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©', actor, target, 'ÙŠÙ…ÙƒÙ† Ù„Ù„Ø´Ø®ØµÙŠØ© Ø¥Ø±Ø³Ø§Ù„ Ø·Ù„Ø¨ Ø¬Ø¯ÙŠØ¯ Ù„Ø§Ø­Ù‚Ø§Ù‹.');
            } else {
              if (!target.publicCode) target.publicCode = makePublicCode(target.rank);
              target.serviceApproved = true;
              target.approved = true;
              target.status = 'Ø®Ø§Ø±Ø¬ Ø§Ù„Ø®Ø¯Ù…Ø©';
              addAuditLog('Ø§Ø¹ØªÙ…Ø§Ø¯ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©', actor, target, `ØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ ${target.name} ÙˆØ¥ØµØ¯Ø§Ø± Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ ${target.publicCode}.`);
            }

            saveState();
            emitState();
            for (const socketId of sessions.get(target.id) || []) {
              const targetSocket = io.sockets.sockets.get(socketId);
              if (targetSocket) targetSocket.emit('member:service:reviewed', {
                ok: !rejecting,
                message: rejecting ? 'ØªÙ… Ø±ÙØ¶ Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©Ø› ÙŠÙ…ÙƒÙ†Ùƒ Ø¥Ø±Ø³Ø§Ù„ Ø·Ù„Ø¨ Ø¬Ø¯ÙŠØ¯ Ø¨Ø¹Ø¯ Ù…Ø±Ø§Ø¬Ø¹Ø© Ø§Ù„Ø³Ø¨Ø¨ Ù…Ø¹ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.' : 'ØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ Ø·Ù„Ø¨Ùƒ ÙˆØ¯Ø®ÙˆÙ„Ùƒ Ù„Ù„Ø®Ø¯Ù…Ø©.',
                publicCode: rejecting ? null : target.publicCode
              });
            }
            return ok(cb, {
              action,
              user: publicUser(target, actor),
              publicCode: rejecting ? null : target.publicCode,
              message: rejecting ? 'ØªÙ… Ø±ÙØ¶ Ø·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø©.' : 'ØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø© ÙˆØ¥ØµØ¯Ø§Ø± Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ.'
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
                'Ù‚Ø¨ÙˆÙ„ Ø£Ø¹Ø¶Ø§Ø¡ Ø¬Ø¯Ø¯ Ù…ØªØ§Ø­ Ù„Ù€ CIA CHIEF ÙÙ‚Ø·.'
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
                'Ø·Ù„Ø¨ Ø§Ù„Ù‚Ø¨ÙˆÙ„ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯.'
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
              .find((value) => value && !['unknown', 'ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ', 'unnamed'].includes(lower(value))) || '';
            if (!requestedName) {
              return no(cb, 'Ø§Ø³Ù… Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯ ÙÙŠ Ø·Ù„Ø¨ Ø§Ù„Ù‚Ø¨ÙˆÙ„Ø› Ø­Ø¯Ù‘Ø« Ø§Ù„Ø·Ù„Ø¨ Ù‚Ø¨Ù„ Ø§Ø¹ØªÙ…Ø§Ø¯Ù‡.');
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
                'Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø¥Ù†Ø´Ø§Ø¡ CIA CHIEF Ù…Ù† Ø·Ù„Ø¨ Ù‚Ø¨ÙˆÙ„.'
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
                  'Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø¥ÙƒÙ…Ø§Ù„ Ø§Ù„Ù‡ÙˆÙŠØ©',

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
              'Ù‚Ø¨ÙˆÙ„ Ø¹Ø¶Ùˆ',
              actor,
              newUser,
              `ØªÙ… Ù‚Ø¨ÙˆÙ„ ${newUser.name} Ø¨Ø±ØªØ¨Ø© ${rankLabel(newUser.rank)}.`
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
                message: 'ØªÙ… Ù‚Ø¨ÙˆÙ„Ùƒ. Ø³Ø¬Ù‘Ù„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø¨ÙƒÙˆØ¯Ùƒ Ø§Ù„Ø´Ø®ØµÙŠ Ù„Ø¥ÙƒÙ…Ø§Ù„ Ø¥Ù†Ø´Ø§Ø¡ Ù‡ÙˆÙŠØªÙƒ.'
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
                'Ø±ÙØ¶ Ø·Ù„Ø¨Ø§Øª Ø§Ù„Ù‚Ø¨ÙˆÙ„ Ù…ØªØ§Ø­ Ù„Ù€ CIA CHIEF ÙÙ‚Ø·.'
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
                'Ø·Ù„Ø¨ Ø§Ù„Ù‚Ø¨ÙˆÙ„ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯.'
              );
            }

            state.cia_queue =
              state.cia_queue.filter(
                (item) =>
                  item.id !==
                  request.id
              );

            const rejectionMessage = 'ØªÙ… Ø±ÙØ¶ Ø·Ù„Ø¨ Ø§Ù„Ø§Ù†Ø¶Ù…Ø§Ù…. Ù„Ø£ÙŠ Ø§Ø³ØªÙØ³Ø§Ø±ØŒ ØªÙˆØ§ØµÙ„ Ù…Ø¹ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.';
            const rejectedAccount = request.accountId
              ? state.cia_accounts.find((account) => account.id === request.accountId)
              : null;
            if (rejectedAccount) {
              rejectedAccount.status = 'REJECTED';
              rejectedAccount.rejectionMessage = rejectionMessage;
              rejectedAccount.rejectedAt = now();
            }

            addAuditLog(
              'Ø±ÙØ¶ Ø¹Ø¶Ùˆ',
              actor,
              null,
              `ØªÙ… Ø±ÙØ¶ Ø·Ù„Ø¨ ${request.name}.`
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
                'Ø§Ù„Ø´Ø®ØµÙŠØ© Ø§Ù„Ù…Ø³ØªÙ‡Ø¯ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.'
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
                'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØºÙŠÙŠØ± Ø±ØªØ¨Ø© Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
              'ØªØºÙŠÙŠØ± Ø±ØªØ¨Ø©',
              actor,
              target,
              `${rankLabel(oldRank)} â†’ ${rankLabel(desiredRank)}`
            );

            saveState();
            await publishNotifications(state.cia_users, {
              type: 'RANK',
              title: 'RANK CHANGE',
              message: `ØªÙ… ØªØ­Ø¯ÙŠØ« Ø±ØªØ¨ØªÙƒ: ${rankLabel(oldRank)} â† ${rankLabel(desiredRank)}.`,
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
                'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.'
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
                'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØºÙŠÙŠØ± ÙƒÙˆØ¯ Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
              'ØªØºÙŠÙŠØ± ÙƒÙˆØ¯ Ø§Ù„Ø¯Ø®ÙˆÙ„',
              actor,
              target,
              'ØªÙ… ØªØºÙŠÙŠØ± ÙƒÙˆØ¯ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
                'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.'
              );
            }
            if (!suspensionReason) {
              return no(cb, 'Ø³Ø¨Ø¨ Ø§Ù„ÙØµÙ„ Ø¥Ù„Ø²Ø§Ù…ÙŠ.');
            }

            if (
              !canManageMember(
                actor,
                target
              )
            ) {
              return no(
                cb,
                'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø¥ÙŠÙ‚Ø§Ù Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
                    message: 'ØªÙ… ÙØµÙ„ Ø§Ù„Ø´Ø®ØµÙŠØ© Ù…Ù† Ø§Ù„Ø®Ø¯Ù…Ø©.',
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
              'ÙØµÙ„ Ù…Ù† Ø§Ù„Ø®Ø¯Ù…Ø©',
              actor,
              target,
              `Ø³Ø¨Ø¨ Ø§Ù„ÙØµÙ„: ${suspensionReason}`
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
                'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.'
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
                'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø¥Ø¹Ø§Ø¯Ø© ØªÙØ¹ÙŠÙ„ Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
              );
            }

            target.suspended =
              false;

            target.activeService =
              true;

            target.status =
              'ÙÙŠ Ø§Ù„Ø®Ø¯Ù…Ø©';

            addAuditLog(
              'Ø¥Ø¹Ø§Ø¯Ø© ØªÙØ¹ÙŠÙ„ Ø´Ø®ØµÙŠØ©',
              actor,
              target,
              'ØªÙ…Øª Ø¥Ø¹Ø§Ø¯Ø© ØªÙØ¹ÙŠÙ„ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
                'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.'
              );
            }

            if (
              isChief(target)
            ) {
              return no(
                cb,
                'Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø­Ø°Ù CIA CHIEF.'
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
                'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø­Ø°Ù Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
                        'ØªÙ… Ø­Ø°Ù Ø§Ù„Ø´Ø®ØµÙŠØ© Ù…Ù† Ø§Ù„Ù†Ø¸Ø§Ù….'
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
              'Ø­Ø°Ù Ø´Ø®ØµÙŠØ©',
              actor,
              target,
              `ØªÙ… Ø­Ø°Ù Ø§Ù„Ø´Ø®ØµÙŠØ© ${oldName}.`
            );

            saveState();
            emitState();

            return ok(cb, {
              message:
                'ØªÙ… Ø­Ø°Ù Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
                'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.'
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
                'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØ¹Ø¯ÙŠÙ„ Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
                  'Ø§Ø³Ù… Ø§Ù„Ø´Ø®ØµÙŠØ© Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø£Ù† ÙŠÙƒÙˆÙ† ÙØ§Ø±ØºØ§Ù‹.'
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
                  'Ø§Ø³Ù… Ø§Ù„Ø´Ø®ØµÙŠØ© Ù…Ø³ØªØ®Ø¯Ù… Ø¨Ø§Ù„ÙØ¹Ù„.'
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
              'ØªØ¹Ø¯ÙŠÙ„ Ø´Ø®ØµÙŠØ©',
              actor,
              target,
              'ØªÙ… ØªØ¹Ø¯ÙŠÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
            'Ø¥Ø¬Ø±Ø§Ø¡ Ø§Ù„Ø¥Ø¯Ø§Ø±Ø© ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ.'
          );
        } catch (error) {
          return no(
            cb,
            error.message ||
              'Ø­Ø¯Ø« Ø®Ø·Ø£ ÙÙŠ Ø¥Ø¬Ø±Ø§Ø¡ Ø§Ù„Ø¥Ø¯Ø§Ø±Ø©.'
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
        if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');

        if (payload?.secretCode !== undefined) {
          const secretCode = clean(payload.secretCode, 100);
          const error = validateSecretCode(secretCode, actor);
          if (error) return no(cb, error);
          actor.secretCode = secretCode;
        }
        if (payload?.publicCode !== undefined) {
          const publicCode = clean(payload.publicCode, 100);
          if (!publicCode || publicCode === 'PENDING') return no(cb, 'Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ ØºÙŠØ± ØµØ§Ù„Ø­.');
          const duplicate = getUserByPublicCode(publicCode);
          if (duplicate && duplicate.id !== actor.id) return no(cb, 'Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ Ù…Ø³ØªØ®Ø¯Ù… Ù…Ù† Ø´Ø®ØµÙŠØ© Ø£Ø®Ø±Ù‰.');
          actor.publicCode = publicCode;
        }

        saveState();
        emitState();
        const result = ok(cb, { user: publicUser(actor, actor) });
        if (payload?.secretCode !== undefined) socket.emit('admin:chief-secret:result', result);
        else socket.emit('admin:member:result', { ...result, action: 'code' });
        return result;
      } catch (error) {
        return no(cb, error.message || 'ØªØ¹Ø°Ø± ØªØ­Ø¯ÙŠØ« Ø¨ÙŠØ§Ù†Ø§ØªÙƒ.');
      }
    });

    socket.on('admin:updateChiefProfile', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor || !isChief(actor)) return no(cb, 'Ù‡Ø°Ù‡ Ø§Ù„Ø¹Ù…Ù„ÙŠØ© Ù…ØªØ§Ø­Ø© Ù„Ù€ CIA CHIEF ÙÙ‚Ø·.');
      actor.hobbies = clean(payload?.hobbies, 1000);
      saveState();
      emitState();
      const result = ok(cb, { user: publicUser(actor, actor) });
      socket.emit('admin:chief-profile:result', result);
      return result;
    });

    socket.on('leader:updateProfile', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor || !isLeadership(actor)) return no(cb, 'ØªØ¹Ø¯ÙŠÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù‚ÙŠØ§Ø¯Ø© Ù…ØªØ§Ø­ Ù„Ù„Ù‚ÙŠØ§Ø¯Ø© ÙÙ‚Ø·.');
      const name = clean(payload?.name, 120);
      if (!name) return no(cb, 'Ø§Ø³Ù… Ø§Ù„Ù‚Ø§Ø¦Ø¯ Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø£Ù† ÙŠÙƒÙˆÙ† ÙØ§Ø±ØºØ§Ù‹.');
      const duplicate = state.cia_users.find(
        (user) => user.id !== actor.id && lower(user.name) === lower(name)
      );
      if (duplicate) return no(cb, 'Ø§Ø³Ù… Ø§Ù„Ø´Ø®ØµÙŠØ© Ù…Ø³ØªØ®Ø¯Ù… Ø¨Ø§Ù„ÙØ¹Ù„.');
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
        if (!actor || !isChief(actor)) return no(cb, 'ØªØ³Ù„ÙŠÙ… Ø§Ù„Ù‚ÙŠØ§Ø¯Ø© Ù…ØªØ§Ø­ Ù„Ù€ CIA CHIEF ÙÙ‚Ø·.');
        const targetCode = clean(payload?.targetCode || payload?.publicCode, 100);
        const target = getUserByPublicCode(targetCode);
        if (!target) return no(cb, 'Ø§Ù„Ø´Ø®ØµÙŠØ© Ø§Ù„Ù…Ø³ØªÙ‡Ø¯ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.');
        if (target.id === actor.id) return no(cb, 'Ù„Ø§ ÙŠÙ…ÙƒÙ†Ùƒ ØªØ³Ù„ÙŠÙ… Ø§Ù„Ù‚ÙŠØ§Ø¯Ø© Ù„Ù†ÙØ³Ùƒ.');
        if (target.suspended || target.serviceApproved === false || target.approved === false || target.identityApprovalPending === true) {
          return no(cb, 'Ù„Ø§ ÙŠÙ…ÙƒÙ† ØªØ³Ù„ÙŠÙ… Ø§Ù„Ù‚ÙŠØ§Ø¯Ø© Ù„Ø´Ø®ØµÙŠØ© Ù…ÙˆÙ‚ÙˆÙØ© Ø£Ùˆ Ù„Ù… ØªØ¹ØªÙ…Ø¯ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø© Ø¨Ø¹Ø¯.');
        }

        target.rank = 'CIA CHIEF';
        actor.rank = 'SUPREME COMMANDER';
        ensureBank(target);
        ensureBank(actor);
        target.bank.salary = defaultSalaryForRank('CIA CHIEF');
        actor.bank.salary = defaultSalaryForRank('SUPREME COMMANDER');
        addAuditLog('ØªØ³Ù„ÙŠÙ… Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©', actor, target, `ØªÙ… Ù†Ù‚Ù„ Ù…Ù†ØµØ¨ CIA CHIEF Ø¥Ù„Ù‰ ${target.name}.`);
        saveState();
        emitState();

        const result = ok(cb, {
          previousChief: publicUser(actor, actor),
          newChief: publicUser(target, target)
        });
        socket.emit('leader:handover:result', result);
        return result;
      } catch (error) {
        return no(cb, error.message || 'ØªØ¹Ø°Ø± ØªØ³Ù„ÙŠÙ… Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.');
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
              'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
              'Ø£Ø¯Ø®Ù„ Ø§Ø³Ù… Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
              'Ù„Ø¯ÙŠÙƒ Ø´Ø®ØµÙŠØ© Ø£Ø³Ø§Ø³ÙŠØ© Ø¨Ø§Ù„ÙØ¹Ù„.'
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
              'Ø§Ø³Ù… Ø§Ù„Ø´Ø®ØµÙŠØ© Ù…Ø³ØªØ®Ø¯Ù… Ø¨Ø§Ù„ÙØ¹Ù„.'
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
                'Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ø´Ø®ØµÙŠØ©',

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
            'Ø¥Ù†Ø´Ø§Ø¡ Ø´Ø®ØµÙŠØ©',
            actor,
            character,
            `ØªÙ… Ø¥Ù†Ø´Ø§Ø¡ Ø´Ø®ØµÙŠØ© ${character.name} Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø§Ù„ØªÙØ¹ÙŠÙ„.`
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
              'ØªØ¹Ø°Ø± Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
              'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
              'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.'
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
              'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªÙØ¹ÙŠÙ„ Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
            );
          }
          if (target.serviceApproved !== true || (!isLeadership(target) && !target.publicCode)) {
            return no(cb, 'Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ø´Ø®ØµÙŠØ© ÙˆØ§Ù„Ù‡ÙˆÙŠØ© ÙˆØ·Ù„Ø¨ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø®Ø¯Ù…Ø© Ù…Ø¹ Ø¥ØµØ¯Ø§Ø± Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ Ù…Ø·Ù„ÙˆØ¨ Ù‚Ø¨Ù„ Ø§Ù„ØªÙØ¹ÙŠÙ„.');
          }

          target.activeService =
            true;

          target.approved =
            true;

          target.suspended =
            false;

          target.status =
            'ÙÙŠ Ø§Ù„Ø®Ø¯Ù…Ø©';

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
            'ØªÙØ¹ÙŠÙ„ Ø´Ø®ØµÙŠØ©',
            actor,
            target,
            'ØªÙ… ØªÙØ¹ÙŠÙ„ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
              'ØªØ¹Ø°Ø± ØªÙØ¹ÙŠÙ„ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
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
              'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
              'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.'
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
              'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø­Ø°Ù Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
            );
          }

          if (
            isChief(target)
          ) {
            return no(
              cb,
              'Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø­Ø°Ù CIA CHIEF.'
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
            'Ø­Ø°Ù Ø´Ø®ØµÙŠØ©',
            actor,
            target,
            'ØªÙ… Ø­Ø°Ù Ø§Ù„Ø´Ø®ØµÙŠØ©.'
          );

          saveState();
          emitState();

          return ok(cb, {
            message:
              'ØªÙ… Ø­Ø°Ù Ø§Ù„Ø´Ø®ØµÙŠØ©.'
          });
        } catch (error) {
          return no(
            cb,
            error.message ||
              'ØªØ¹Ø°Ø± Ø­Ø°Ù Ø§Ù„Ø´Ø®ØµÙŠØ©.'
          );
        }
      }
    );

    /* =====================================================
       CHARACTER ACCOUNT UI ALIASES
    ===================================================== */

    socket.on('character:list', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø£ÙˆÙ„Ø§Ù‹.');
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
        if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø£ÙˆÙ„Ø§Ù‹.');
        const name = clean(payload?.requestedName || payload?.name || payload?.characterName, 120);
        if (!name) return no(cb, 'Ø£Ø¯Ø®Ù„ Ø§Ø³Ù… Ø§Ù„Ø´Ø®ØµÙŠØ© Ø§Ù„Ø¬Ø¯ÙŠØ¯Ø©.');

        const owned = characterListForUser(actor).filter((user) => user.suspended !== true && !user.separatedAt);
        if (owned.length >= 10) return no(cb, 'ÙˆØµÙ„Øª Ø¥Ù„Ù‰ Ø§Ù„Ø­Ø¯ Ø§Ù„Ø£Ù‚ØµÙ‰ Ù„Ù„Ø´Ø®ØµÙŠØ§Øª ÙÙŠ Ø­Ø³Ø§Ø¨Ùƒ.');
        if (state.cia_users.some((user) => lower(user.name) === lower(name))) {
          return no(cb, 'Ø§Ø³Ù… Ø§Ù„Ø´Ø®ØµÙŠØ© Ù…Ø³ØªØ®Ø¯Ù… Ø¨Ø§Ù„ÙØ¹Ù„.');
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
          status: direct ? 'ÙÙŠ Ø§Ù„Ø®Ø¯Ù…Ø©' : 'Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ø´Ø®ØµÙŠØ©',
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
          direct ? 'Ø¥Ù†Ø´Ø§Ø¡ Ø´Ø®ØµÙŠØ© Ù‚ÙŠØ§Ø¯ÙŠØ©' : 'Ø·Ù„Ø¨ Ø´Ø®ØµÙŠØ©',
          actor,
          character,
          direct ? `ØªÙ… Ø¥Ù†Ø´Ø§Ø¡ Ø´Ø®ØµÙŠØ© ${character.name} Ù…Ø¨Ø§Ø´Ø±Ø© Ù„Ù„Ù‚Ø§Ø¦Ø¯.` : `ØªÙ… ØªÙ‚Ø¯ÙŠÙ… Ø·Ù„Ø¨ Ø´Ø®ØµÙŠØ© ${character.name}.`
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
        return no(cb, error.message || 'ØªØ¹Ø°Ø± Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ø´Ø®ØµÙŠØ©.');
      }
    });

    socket.on('character:login', (payload, cb) => {
      try {
        const actor = requireSocketUser(socket);
        if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø£ÙˆÙ„Ø§Ù‹.');
        const characterId = clean(payload?.characterId || payload?.id, 120);
        const code = clean(payload?.characterCode || payload?.code, 100);
        const target = getUserById(characterId);
        if (!target) return no(cb, 'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.');

        const sameOwner =
          (target.accountId && actor.accountId && target.accountId === actor.accountId) ||
          target.characterOwnerId === (actor.characterOwnerId || actor.id);
        if (!sameOwner) return no(cb, 'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø¥Ù„Ù‰ Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.');
        if (!target.approved || target.suspended) {
          return no(cb, 'Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ© Ù„Ù… ØªØ¹ØªÙ…Ø¯ Ø£Ùˆ ØªÙ… Ø¥ÙŠÙ‚Ø§ÙÙ‡Ø§.');
        }
        if (
          code &&
          code !== target.secretCode &&
          code !== target.publicCode
        ) {
          return no(cb, 'ÙƒÙˆØ¯ Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± ØµØ­ÙŠØ­.');
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
        return no(cb, error.message || 'ØªØ¹Ø°Ø± ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø¥Ù„Ù‰ Ø§Ù„Ø´Ø®ØµÙŠØ©.');
      }
    });

    socket.on('character:admin:action', (payload, cb) => {
      try {
        const actor = requireSocketUser(socket);
        if (!actor || !isChief(actor)) return no(cb, 'Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ø´Ø®ØµÙŠØ§Øª Ù…ØªØ§Ø­ Ù„Ù€ CIA CHIEF ÙÙ‚Ø·.');
        const action = clean(payload?.action, 40).toLowerCase();
        const requestId = clean(payload?.requestId || payload?.id, 120);
        const request = state.cia_character_queue.find((item) => item.id === requestId);
        if (!request) return no(cb, 'Ø·Ù„Ø¨ Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯.');
        const target = getUserById(request.characterId);
        if (!target) return no(cb, 'Ø§Ù„Ø´Ø®ØµÙŠØ© Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.');

        if (action === 'reject' || action === 'deny') {
          target.activeService = false;
          target.serviceApproved = false;
          target.identityApproved = false;
          target.serviceApprovalPending = false;
          target.approved = false;
          target.status = 'Ù…Ø±ÙÙˆØ¶Ø©';
          state.cia_character_queue = state.cia_character_queue.filter((item) => item.id !== request.id);
          saveState();
          emitState();
          const result = ok(cb, { action: 'reject', user: publicUser(target, actor) });
          for (const socketId of sessions.get(request.ownerId) || []) {
            const ownerSocket = io.sockets.sockets.get(socketId);
            if (ownerSocket) ownerSocket.emit('character:rejected', { message: `ØªÙ… Ø±ÙØ¶ Ø·Ù„Ø¨ Ø§Ù„Ø´Ø®ØµÙŠØ© ${target.name}.` });
          }
          return result;
        }
        if (action !== 'approve' && action !== 'accept') return no(cb, 'Ø¥Ø¬Ø±Ø§Ø¡ Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ.');

        if (!target.secretCode) target.secretCode = makeSecretCode();
        target.publicCode = '';
        target.approved = true;
        target.activeService = false;
        target.serviceApproved = false;
        target.identityApproved = false;
        target.serviceApprovalPending = false;
        target.identityApprovalPending = false;
        target.identityRequired = true;
        target.status = 'Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø¥ÙƒÙ…Ø§Ù„ Ø§Ù„Ù‡ÙˆÙŠØ©';
        state.cia_character_queue = state.cia_character_queue.filter((item) => item.id !== request.id);
        addAuditLog('Ø§Ø¹ØªÙ…Ø§Ø¯ Ø´Ø®ØµÙŠØ©', actor, target, `ØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ø´Ø®ØµÙŠØ© ${target.name}.`);
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
        return no(cb, error.message || 'ØªØ¹Ø°Ø± ØªÙ†ÙÙŠØ° Ø·Ù„Ø¨ Ø§Ù„Ø´Ø®ØµÙŠØ©.');
      }
    });

    /* =====================================================
       BANK
    ===================================================== */

    socket.on('bank:setAccount', (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
      const accountBank = ensureBank(actor);
      if (accountBank.militaryCodeLinked === true) {
        return no(cb, 'ØªÙ… Ø±Ø¨Ø· Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ Ù…Ø³Ø¨Ù‚Ø§Ù‹ ÙˆÙ„Ø§ ÙŠÙ…ÙƒÙ† Ø¥Ø¹Ø§Ø¯Ø© Ø±Ø¨Ø·Ù‡.');
      }
      const bankCode = clean(payload?.bankCode || payload?.code || '', 100);
      if (bankCode && bankCode !== actor.publicCode) {
        return no(cb, 'ÙƒÙˆØ¯ Ø§Ù„Ø¨Ù†Ùƒ ÙŠØ¬Ø¨ Ø£Ù† ÙŠØ³Ø§ÙˆÙŠ Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ Ù„Ù„Ø´Ø®ØµÙŠØ© Ø§Ù„Ø­Ø§Ù„ÙŠØ©.');
      }
      const accountNumber = clean(payload?.accountNumber || payload?.account || '', 60);
      if (accountNumber !== actor.publicCode) {
        return no(cb, 'Ø£Ø¯Ø®Ù„ ÙƒÙˆØ¯Ùƒ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ Ù†ÙØ³Ù‡ Ù„Ø±Ø¨Ø·Ù‡ Ø¨Ø§Ù„Ø­Ø³Ø§Ø¨ Ø§Ù„Ø¨Ù†ÙƒÙŠ.');
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
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
      const target = getUserById(clean(payload?.memberId || payload?.userId, 120)) ||
        getUserByPublicCode(payload?.publicCode || payload?.code);
      const amount = parseMoney(payload?.amount);
      if (!target) return no(cb, 'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.');
      if (!Number.isFinite(amount) || amount < 0) return no(cb, 'Ø§Ù„Ø±ØµÙŠØ¯ ØºÙŠØ± ØµØ§Ù„Ø­.');
      if (target.id !== actor.id && !canManageBank(actor, target)) {
        return no(cb, 'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØ¹Ø¯ÙŠÙ„ Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨.');
      }
      ensureBank(target);
      target.bank.balance = amount;
      addAuditLog('ØªØ¹Ø¯ÙŠÙ„ Ø±ØµÙŠØ¯ Ø¨Ù†ÙƒÙŠ', actor, target, `ØªÙ… Ø¶Ø¨Ø· Ø§Ù„Ø±ØµÙŠØ¯ Ø¥Ù„Ù‰ ${amount}.`);
      saveState();
      await publishNotifications([target], {
        type: 'TRANSACTION',
        title: 'FINANCIAL // BALANCE UPDATE',
        message: 'ØªÙ… ØªØ­Ø¯ÙŠØ« Ø±ØµÙŠØ¯ Ø­Ø³Ø§Ø¨Ùƒ Ø§Ù„Ø¨Ù†ÙƒÙŠ.',
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
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
      const action = clean(payload?.action, 50).toLowerCase();
      const target = getUserByPublicCode(payload?.targetCode || payload?.publicCode || payload?.code);
      if (!target) return no(cb, 'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.');
      if (target.id !== actor.id && !canManageBank(actor, target)) {
        return no(cb, 'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø¥Ø¯Ø§Ø±Ø© Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨.');
      }
      ensureBank(target);

      if (action === 'freeze' || action === 'unfreeze') {
        target.bank.frozen = action === 'freeze';
      } else if (action === 'stop-account' || action === 'start-account') {
        target.bank.enabled = action === 'start-account';
      } else if (action === 'withdraw' || action === 'deduct') {
        const amount = parseMoney(payload?.amount);
        if (!Number.isFinite(amount) || amount <= 0) return no(cb, 'Ø§ÙƒØªØ¨ Ù…Ø¨Ù„ØºØ§Ù‹ ØµØ­ÙŠØ­Ø§Ù‹.');
        if (target.bank.frozen || target.bank.enabled === false) return no(cb, 'Ø§Ù„Ø­Ø³Ø§Ø¨ Ø§Ù„Ø¨Ù†ÙƒÙŠ Ù…Ø¬Ù…Ø¯ Ø£Ùˆ Ù…ÙˆÙ‚ÙˆÙ.');
        if (target.bank.balance < amount) return no(cb, 'Ø§Ù„Ø±ØµÙŠØ¯ ØºÙŠØ± ÙƒØ§ÙÙ.');
        target.bank.balance -= amount;
      } else {
        return no(cb, 'Ø¥Ø¬Ø±Ø§Ø¡ Ø§Ù„Ø¨Ù†Ùƒ ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ.');
      }

      addAuditLog('Ø¥Ø¯Ø§Ø±Ø© Ø­Ø³Ø§Ø¨ Ø¨Ù†ÙƒÙŠ', actor, target, `Ø§Ù„Ø¥Ø¬Ø±Ø§Ø¡: ${action}.`);
      saveState();
      const isMoneyMovement = ['withdraw', 'deduct'].includes(action);
      const isAccountControl = ['freeze', 'unfreeze', 'stop-account', 'start-account'].includes(action);
      if (isMoneyMovement || isAccountControl) {
        await publishNotifications([target], {
          type: isMoneyMovement ? 'TRANSACTION' : 'FINANCE',
          title: isMoneyMovement ? 'FINANCIAL // WITHDRAWAL' : 'FINANCIAL // ACCOUNT STATUS',
          message: isMoneyMovement
            ? `ØªÙ… Ø³Ø­Ø¨ ${Math.floor(Number(payload?.amount) || 0)}$ Ù…Ù† Ø­Ø³Ø§Ø¨Ùƒ Ø§Ù„Ø¨Ù†ÙƒÙŠ.`
            : `ØªÙ… ØªØ­Ø¯ÙŠØ« Ø­Ø§Ù„Ø© Ø­Ø³Ø§Ø¨Ùƒ Ø§Ù„Ø¨Ù†ÙƒÙŠ: ${action}.`,
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
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
      const target = getUserByPublicCode(payload?.targetCode || payload?.publicCode || payload?.code);
      if (!target) return no(cb, 'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.');
      if (target.id !== actor.id && !canManageBank(actor, target)) {
        return no(cb, 'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØµØ±Ù Ø±Ø§ØªØ¨ Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.');
      }
      ensureBank(target);
      if (target.id === actor.id && !hasLinkedMilitaryBankCode(target)) {
        return no(cb, 'Ø§Ø­ÙØ¸ ÙƒÙˆØ¯Ùƒ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ Ù…Ø±Ø© ÙˆØ§Ø­Ø¯Ø© ÙÙŠ Ø§Ù„Ø¨Ù†Ùƒ Ù‚Ø¨Ù„ ØªÙ†ÙÙŠØ° Ø§Ù„Ø¹Ù…Ù„ÙŠØ§Øª.');
      }
      if (target.bank.enabled === false || target.bank.frozen || target.bank.salaryEnabled === false) {
        return no(cb, 'Ø§Ù„Ø­Ø³Ø§Ø¨ Ø£Ùˆ Ø§Ù„Ø±Ø§ØªØ¨ Ù…ÙˆÙ‚ÙˆÙ.');
      }
      const amount = Math.max(0, Math.floor(Number(target.bank.salary) || 0));
      target.bank.balance += amount;
      target.bank.lastSalaryAt = now();
      target.bank.salaryClaimedToday = true;
      addAuditLog('ØµØ±Ù Ø±Ø§ØªØ¨ ÙŠØ¯ÙˆÙŠ', actor, target, `ØªÙ… ØµØ±Ù ${amount}.`);
      saveState();
      await publishNotifications([target], {
        type: 'SALARY',
        title: 'FINANCIAL // SALARY DEPOSIT',
        message: `ØªÙ… Ø¥ÙŠØ¯Ø§Ø¹ Ø±Ø§ØªØ¨Ùƒ: ${amount}$`,
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø¹Ø±Ø¶ Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨.'
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
          );
        }

        if (!hasLinkedMilitaryBankCode(actor)) {
          return no(cb, 'Ø§Ø­ÙØ¸ ÙƒÙˆØ¯Ùƒ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ Ù…Ø±Ø© ÙˆØ§Ø­Ø¯Ø© ÙÙŠ Ø§Ù„Ø¨Ù†Ùƒ Ù‚Ø¨Ù„ Ø§Ø³ØªÙ„Ø§Ù… Ø§Ù„Ø±Ø§ØªØ¨.');
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
              'Ø§Ù„Ø­Ø³Ø§Ø¨ Ø§Ù„Ø¨Ù†ÙƒÙŠ Ù…Ø¬Ù…Ø¯.'
            );
          }

          if (
            actor.bank.salaryEnabled ===
            false
          ) {
            return no(
              cb,
              'Ø§Ù„Ø±Ø§ØªØ¨ Ù…ØªÙˆÙ‚Ù.'
            );
          }

          return no(
            cb,
            'ØªÙ… ØµØ±Ù Ø§Ù„Ø±Ø§ØªØ¨ Ù…Ø³Ø¨Ù‚Ø§Ù‹ Ø£Ùˆ Ù„Ø§ ÙŠÙ…ÙƒÙ† ØµØ±ÙÙ‡ Ø­Ø§Ù„ÙŠØ§Ù‹.'
          );
        }

        saveState();
        await publishNotifications([actor], {
          type: 'SALARY',
          title: 'FINANCIAL // SALARY DEPOSIT',
          message: `ØªÙ… Ø¥ÙŠØ¯Ø§Ø¹ Ø±Ø§ØªØ¨Ùƒ: ${amount}$`,
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'Ù‚ÙŠÙ…Ø© Ø§Ù„Ø±Ø§ØªØ¨ ØºÙŠØ± ØµØ­ÙŠØ­Ø©.'
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
            'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØ¹Ø¯ÙŠÙ„ Ø±Ø§ØªØ¨ Ù‡Ø°Ù‡ Ø§Ù„Ø±ØªØ¨Ø©.'
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
          'ØªØ¹Ø¯ÙŠÙ„ Ø±Ø§ØªØ¨ Ø±ØªØ¨Ø©',
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.'
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
            'Ù‚ÙŠÙ…Ø© Ø§Ù„Ø±Ø§ØªØ¨ ØºÙŠØ± ØµØ­ÙŠØ­Ø©.'
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
            'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØ¹Ø¯ÙŠÙ„ Ø±Ø§ØªØ¨ Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
          );
        }

        ensureBank(target);

        target.bank.salary =
          Math.floor(
            amount
          );

        addAuditLog(
          'ØªØ¹Ø¯ÙŠÙ„ Ø±Ø§ØªØ¨ Ø´Ø®ØµÙŠØ©',
          actor,
          target,
          `ØªÙ… ØªØ­Ø¯ÙŠØ¯ Ø±Ø§ØªØ¨ Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ© ÙÙ‚Ø· Ø¥Ù„Ù‰ ${Math.floor(amount)} Ø¯ÙˆÙ† ØªØºÙŠÙŠØ± Ø±Ø§ØªØ¨ Ø±ØªØ¨ØªÙ‡Ø§.`
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'Ù‚ÙŠÙ…Ø© Ø§Ù„Ø¥ÙŠØ¯Ø§Ø¹ ØºÙŠØ± ØµØ­ÙŠØ­Ø©.'
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
            'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø§Ù„Ø¥ÙŠØ¯Ø§Ø¹ Ù„Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨.'
          );
        }

        ensureBank(target);
        if (target.id === actor.id && !hasLinkedMilitaryBankCode(target)) {
          return no(cb, 'Ø§Ø­ÙØ¸ ÙƒÙˆØ¯Ùƒ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ Ù…Ø±Ø© ÙˆØ§Ø­Ø¯Ø© ÙÙŠ Ø§Ù„Ø¨Ù†Ùƒ Ù‚Ø¨Ù„ ØªÙ†ÙÙŠØ° Ø§Ù„Ø¹Ù…Ù„ÙŠØ§Øª.');
        }

        target.bank.balance +=
          Math.floor(
            amount
          );

        addAuditLog(
          'Ø¥ÙŠØ¯Ø§Ø¹ Ø¨Ù†ÙƒÙŠ',
          actor,
          target,
          `ØªÙ… Ø¥ÙŠØ¯Ø§Ø¹ ${Math.floor(amount)}.`
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'Ù‚ÙŠÙ…Ø© Ø§Ù„Ø³Ø­Ø¨ ØºÙŠØ± ØµØ­ÙŠØ­Ø©.'
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
            'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø§Ù„Ø³Ø­Ø¨ Ù…Ù† Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨.'
          );
        }

        ensureBank(target);

        if (target.id === actor.id && !hasLinkedMilitaryBankCode(target)) {
          return no(cb, 'Ø§Ø­ÙØ¸ ÙƒÙˆØ¯Ùƒ Ø§Ù„Ø¹Ø³ÙƒØ±ÙŠ Ù…Ø±Ø© ÙˆØ§Ø­Ø¯Ø© ÙÙŠ Ø§Ù„Ø¨Ù†Ùƒ Ù‚Ø¨Ù„ ØªÙ†ÙÙŠØ° Ø§Ù„Ø¹Ù…Ù„ÙŠØ§Øª.');
        }

        if (
          target.bank.frozen
        ) {
          return no(
            cb,
            'Ø§Ù„Ø­Ø³Ø§Ø¨ Ø§Ù„Ø¨Ù†ÙƒÙŠ Ù…Ø¬Ù…Ø¯.'
          );
        }

        if (
          target.bank.balance <
          amount
        ) {
          return no(
            cb,
            'Ø§Ù„Ø±ØµÙŠØ¯ ØºÙŠØ± ÙƒØ§ÙÙ.'
          );
        }

        target.bank.balance -=
          Math.floor(
            amount
          );

        addAuditLog(
          'Ø³Ø­Ø¨ Ø¨Ù†ÙƒÙŠ',
          actor,
          target,
          `ØªÙ… Ø³Ø­Ø¨ ${Math.floor(amount)}.`
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.'
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
            'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØ¬Ù…ÙŠØ¯ Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨.'
          );
        }

        ensureBank(target);

        target.bank.frozen =
          payload?.frozen !== false;

        addAuditLog(
          target.bank.frozen
            ? 'ØªØ¬Ù…ÙŠØ¯ Ø­Ø³Ø§Ø¨ Ø¨Ù†ÙƒÙŠ'
            : 'ÙÙƒ ØªØ¬Ù…ÙŠØ¯ Ø­Ø³Ø§Ø¨ Ø¨Ù†ÙƒÙŠ',
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'Ø§Ù„Ø´Ø®ØµÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©.'
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
            'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø§Ù„ØªØ­ÙƒÙ… Ø¨Ø±Ø§ØªØ¨ Ù‡Ø°Ù‡ Ø§Ù„Ø´Ø®ØµÙŠØ©.'
          );
        }

        ensureBank(target);

        target.bank.salaryEnabled =
          payload?.enabled !== false;

        addAuditLog(
          target.bank.salaryEnabled
            ? 'ØªÙØ¹ÙŠÙ„ Ø±Ø§ØªØ¨'
            : 'Ø¥ÙŠÙ‚Ø§Ù Ø±Ø§ØªØ¨',
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
       MAP â€” NORMAL GTA LOCATION
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
              'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ù„ØªØ­Ø¯ÙŠØ¯ Ù…ÙˆÙ‚Ø¹Ùƒ.'
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
              'Ø¥Ø­Ø¯Ø§Ø«ÙŠØ§Øª Ø§Ù„Ù…ÙˆÙ‚Ø¹ ØºÙŠØ± ØµØ­ÙŠØ­Ø©.'
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
              'ØªØ¹Ø°Ø± Ø­ÙØ¸ Ù…ÙˆÙ‚Ø¹Ùƒ.'
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
              'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
              'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø¥Ø²Ø§Ù„Ø© Ù‡Ø°Ø§ Ø§Ù„Ù…ÙˆÙ‚Ø¹.'
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
              'ØªØ¹Ø°Ø± Ø¥Ø²Ø§Ù„Ø© Ø§Ù„Ù…ÙˆÙ‚Ø¹.'
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
      if (!actor) return no(cb, 'Ø³Ø¬Ù‘Ù„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø¥Ù„Ù‰ Ø­Ø³Ø§Ø¨Ùƒ Ø£ÙˆÙ„Ø§Ù‹ Ù„Ø§Ø³ØªØ®Ø¯Ø§Ù… Ù…ÙˆØ±Ø³.');
      if (actor.serviceApproved === false) return no(cb, 'Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ù‡ÙˆÙŠØ© Ù…Ù† Ø§Ù„Ù‚ÙŠØ§Ø¯Ø© Ù…Ø·Ù„ÙˆØ¨ Ù‚Ø¨Ù„ Ø§Ø³ØªØ®Ø¯Ø§Ù… Ù…ÙˆØ±Ø³.');
      const direction = clean(payload?.direction, 20).toLowerCase();
      const source = clean(payload?.text, 500);
      if (!['encode','decode'].includes(direction)) return no(cb, 'Ø§Ø®ØªØ± Ø§ØªØ¬Ø§Ù‡ Ø§Ù„ØªØ±Ø¬Ù…Ø© Ø§Ù„ØµØ­ÙŠØ­.');
      if (!source) return no(cb, 'Ø§ÙƒØªØ¨ Ø§Ù„Ù†Øµ Ø£Ùˆ Ø´ÙØ±Ø© Ù…ÙˆØ±Ø³ Ø£ÙˆÙ„Ø§Ù‹.');
      if (await moderateOutgoingText(actor, source, 'MORSE')) {
        return no(cb, 'ØªÙ… Ø­Ø¸Ø± Ø§Ù„Ù†Øµ Ø¨ÙˆØ§Ø³Ø·Ø© Ù…Ø±ÙƒØ² Ø§Ù„Ø£Ù…Ù†.');
      }

      let translation;
      if (direction === 'encode') {
        const normalized = source.toUpperCase();
        const unsupported = [...normalized].find(character => !/\s/.test(character) && !Object.prototype.hasOwnProperty.call(MORSE_CODES, character));
        if (unsupported) return no(cb, 'Ø§ÙƒØªØ¨ Ø§Ù„Ù†Øµ Ø¨Ø§Ù„Ù„ØºØ© Ø§Ù„Ø¥Ù†Ø¬Ù„ÙŠØ²ÙŠØ© ÙÙ‚Ø·ØŒ Ù…Ø¹ Ø§Ù„Ø£Ø±Ù‚Ø§Ù… ÙˆØ¹Ù„Ø§Ù…Ø§Øª Ø§Ù„ØªØ±Ù‚ÙŠÙ… Ø§Ù„Ù…Ø¯Ø¹ÙˆÙ…Ø©.');
        translation = normalized.trim().split(/\s+/).map(word => [...word].map(character => MORSE_CODES[character]).join(' ')).join(' / ');
      } else {
        if ([...source].some(character => !['.','-','/'].includes(character) && !/\s/.test(character))) {
          return no(cb, 'Ø£Ø¯Ø®Ù„ Ø´ÙØ±Ø© Ù…ÙˆØ±Ø³ Ø¨Ø§Ø³ØªØ®Ø¯Ø§Ù… Ø§Ù„Ù†Ù‚Ø§Ø· ÙˆØ§Ù„Ø´Ø±Ø·Ø§Øª ÙˆØ§Ù„Ù…Ø³Ø§ÙØ§Øª Ø£Ùˆ / Ø¨ÙŠÙ† Ø§Ù„ÙƒÙ„Ù…Ø§Øª.');
        }
        try {
          const words = source.trim().split(/\s*\/\s*|\s{3,}/);
          translation = words.map(word => word.trim().split(/\s+/).map(code => {
            const character = MORSE_CHARACTERS[code];
            if (!character) throw new Error('Ø±Ù…Ø² Ù…ÙˆØ±Ø³ ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ: ' + code);
            return character;
          }).join('')).join(' ');
        } catch (error) {
          return no(cb, error.message || 'ØªØ¹Ø°Ø± ÙÙƒ Ø´ÙØ±Ø© Ù…ÙˆØ±Ø³.');
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'ØªÙ… Ø§Ù„Ø®Ø±ÙˆØ¬ Ù…Ù† Ø§Ù„Ù‚Ù†Ø§Ø©.'
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'Ø§Ù„Ù‚Ù†Ø§Ø© ØºÙŠØ± ØµØ­ÙŠØ­Ø©.'
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
            'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.'
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
            'Ø§Ù„Ø±Ø³Ø§Ù„Ø© ÙØ§Ø±ØºØ©.'
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
       SOS â€” BROADCAST
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
              'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ù„Ø¥Ø±Ø³Ø§Ù„ S.O.S.'
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
       'bÇb£f+b¤ƒbf ƒbŸfb—fb³ff+bËf+b¤¸œ¤ì(€€€€€½¹ÍÐÍ•Ñ½È€ô±•…¸¡Á…å±½…ü¹Í•Ñ½È°€ÄÀÀ¤ì(€€€€€½¹ÍÐÍÑ…ÑÕÌ€ôlQ%Yœ°1IPœ°MQ9	dt¹¥¹±Õ‘•Ì¡Á…å±½…ü¹ÍÑ…ÑÕÌ¤€üÁ…å±½…¹ÍÑ…ÑÕÌ€è€Q%Yœì(€€€€€½¹ÍÐ½±½È€ô€½xlÀ´å„µ™µuìÙô¼¹Ñ•ÍÐ¡Á…å±½…ü¹½±½Èñð€œœ¤€üÁ…å±½…¹½±½È€è€¡•á¥ÍÑ¥¹œü¹½±½Èñð€œŒÝ„ÈÕ„œ¤ì(€€€€€½¹ÍÐÍåµ‰½°€ô±•…¸¡Á…å±½…ü¹Íåµ‰½°ñð•á¥ÍÑ¥¹œü¹Íåµ‰½°ñð€U9%Pœ°€ÄØ¤¹É•Á±…” ½my„µéµhÀ´ä€µt½œ°€œœ¤¹ÑÉ¥´ ¤¹Ñ½UÁÁ•É…Í” ¤ñð€U9%Pœì(€€€€€½¹ÍÐ•µ‰±•´€ô±•…¸¡Á…å±½…ü¹•µ‰±•´ñð•á¥ÍÑ¥¹œü¹•µ‰±•´ñðÍåµ‰½°°€ÌÈ¤ì(€€€€€½¹ÍÐÉ•Í½±Ù•I½±”€ô€¡Ù…±Õ”°µ¥¹I…¹¬°±…‰•°¤€ôøì(€€€€€€€½¹ÍÐÉ½±•½‘”€ô±•…¸¡Ù…±Õ”°€ÄÀÀ¤ì(€€€€€€€½¹ÍÐÁ•ÉÍ½¸€ôÉ½±•½‘”€ü¥‰ÁI•Í½±Ù•½‘”¡É½±•½‘”¤€è¹Õ±°ì(€€€€€€€¥˜€¡É½±•½‘”€˜˜€ …Á•ÉÍ½¸ñðÁ•ÉÍ½¸¹…ÁÁÉ½Ù•€ôôô™…±Í”ñðÁ•ÉÍ½¸¹ÍÕÍÁ•¹‘•€ôôôÑÉÕ”ñðÁ•ÉÍ½¸¹Í•ÉÙ¥•ÁÁÉ½Ù•€ôôô™…±Í”¤¤Ñ¡É½Ü¹•ÜÉÉ½È ŸbÇfbÈ€œ€¬±…‰•°€¬€œƒbëf+bÄƒb×bŸfb´¸œ¤ì(€€€€€€€¥˜€¡Á•ÉÍ½¸€˜˜É…¹­1•Ù•°¡Á•ÉÍ½¸¹É…¹¬¤€ðµ¥¹I…¹¬¤Ñ¡É½Ü¹•ÜÉÉ½È Ÿf+b³b ƒbfƒf+ff#f€œ€¬±…‰•°€¬€œƒffƒbŸfbÇb«b£b¤ƒbŸfff+bŸb¿f+b¤ƒbŸffbßff#b£b¤¸œ¤ì(€€€€€€€É•ÑÕÉ¸Á•ÉÍ½¸ì(€€€€€ôì(€€€€€±•Ð½µµ…¹‘•È°‘•ÁÕÑä°Í•¹¥½É½µµ…¹‘•Èì(€€€€€ÑÉäì(€€€€€€€½µµ…¹‘•È€ôÉ•Í½±Ù•I½±”¡Á…å±½…ü¹½µµ…¹‘•É½‘”€üü•á¥ÍÑ¥¹œü¹½µµ…¹‘•É½‘”°€È°€ŸfbŸb›b¼ƒbŸffb«f+b£b¤œ¤ì(€€€€€€€‘•ÁÕÑä€ôÉ•Í½±Ù•I½±”¡Á…å±½…ü¹‘•ÁÕÑå½‘”€üü•á¥ÍÑ¥¹œü¹‘•ÁÕÑå½‘”°€È°€ŸfbŸb›b ƒfbŸb›b¼ƒbŸffb«f+b£b¤œ¤ì(€€€€€€€Í•¹¥½É½µµ…¹‘•È€ôÉ•Í½±Ù•I½±”¡Á…å±½…ü¹Í•¹¥½É½µµ…¹‘•É½‘”€üü•á¥ÍÑ¥¹œü¹Í•¹¥½É½µµ…¹‘•É½‘”°€Ì°€ŸbŸffbŸb›b¼ƒbŸfbbçff$œ¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ìÉ•ÑÕÉ¸¹¼¡ˆ°•ÉÉ½È¹µ•ÍÍ…”¤ìô(€€€€€¥˜€¡½µµ…¹‘•È€˜˜‘•ÁÕÑä€˜˜±•…¸¡½µµ…¹‘•È¹ÁÕ‰±¥½‘”°ÄÀÀ¤¹Ñ½UÁÁ•É…Í” ¤€ôôô±•…¸¡‘•ÁÕÑä¹ÁÕ‰±¥½‘”°ÄÀÀ¤¹Ñ½UÁÁ•É…Í” ¤¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒbfƒf+ff#fƒbŸffbŸb›b¼ƒf#bŸffbŸb›b ƒbÓb»b×f+fƒfb»b«fff+f¸œ¤ì(€€€€€½¹ÍÐÉ•ÅÕ•ÍÑ•€ôÉÉ…ä¹¥ÍÉÉ…ä¡Á…å±½…ü¹µ•µ‰•É½‘•Ì¤€üÁ…å±½…¹µ•µ‰•É½‘•Ì¹Í±¥” À°€ÄÔÀ¤€è€¡•á¥ÍÑ¥¹œü¹µ•µ‰•É½‘•Ìñðmt¤ì(€€€€€½¹ÍÐµ•µ‰•É5…À€ô¹•Ü5…À ¤ì(€€€€€™½È€¡½¹ÍÐÙ…±Õ”½˜É•ÅÕ•ÍÑ•¤ì(€€€€€€€½¹ÍÐµ•µ‰•É½‘”€ô±•…¸¡Ù…±Õ”°€ÄÀÀ¤ì(€€€€€€€¥˜€ …µ•µ‰•É½‘”¤½¹Ñ¥¹Õ”ì(€€€€€€€½¹ÍÐÁ•ÉÍ½¸€ô¥‰ÁI•Í½±Ù•½‘”¡µ•µ‰•É½‘”¤ì(€€€€€€€¥˜€ …Á•ÉÍ½¸ñðÁ•ÉÍ½¸¹…ÁÁÉ½Ù•€ôôô™…±Í”ñðÁ•ÉÍ½¸¹ÍÕÍÁ•¹‘•€ôôôÑÉÕ”ñðÁ•ÉÍ½¸¹Í•ÉÙ¥•ÁÁÉ½Ù•€ôôô™…±Í”¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«bçbÃbÄƒbŸfb«b·ffƒffƒbb·b¼ƒbff#bŸb¼ƒbŸfbfbÇbŸb¼ƒbŸffb»b«bŸbÇf+f¸œ¤ì(€€€€€€€µ•µ‰•É5…À¹Í•Ð¡±•…¸¡Á•ÉÍ½¸¹ÁÕ‰±¥½‘”°€ÄÀÀ¤¹Ñ½UÁÁ•É…Í” ¤°Á•ÉÍ½¸¹ÁÕ‰±¥½‘”¤ì(€€€€€ô(€€€€€™½È€¡½¹ÍÐÁ•ÉÍ½¸½˜m½µµ…¹‘•È°‘•ÁÕÑåt¤¥˜€¡Á•ÉÍ½¸¤µ•µ‰•É5…À¹Í•Ð¡±•…¸¡Á•ÉÍ½¸¹ÁÕ‰±¥½‘”°ÄÀÀ¤¹Ñ½UÁÁ•É…Í” ¤°Á•ÉÍ½¸¹ÁÕ‰±¥½‘”¤ì(€€€€€½¹ÍÐµ•µ‰•É½‘•Ì€ôl¸¸¹µ•µ‰•É5…À¹Ù…±Õ•Ì ¥tì(€€€€€½¹ÍÐÝ…¹Ñ•€ô¹•ÜM•Ð¡µ•µ‰•É½‘•Ì¹µ…À ¡µ•µ‰•É½‘”¤€ôø±•…¸¡µ•µ‰•É½‘”°€ÄÀÀ¤¹Ñ½UÁÁ•É…Í” ¤¤¤ì(€€€€€½¹ÍÐ½¹™±¥Ð€ô€¡ÍÑ…Ñ”¹¥…}‰…ÑÑ…±¥½¹Ìñðmt¤¹™¥¹ ¡Õ¹¥Ð¤€ôøMÑÉ¥¹œ¡Õ¹¥Ð¹¥¤€„ôôMÑÉ¥¹œ¡•á¥ÍÑ¥¹œü¹¥ñð€œœ¤€˜˜Õ¹¥Ð¹ÍÑ…ÑÕÌ€„ôô€I!%Yœ€˜˜l¸¸¸¡ÉÉ…ä¹¥ÍÉÉ…ä¡Õ¹¥Ð¹µ•µ‰•É½‘•Ì¤€üÕ¹¥Ð¹µ•µ‰•É½‘•Ì€èmt¤°Õ¹¥Ð¹½µµ…¹‘•É½‘”ñð€œœ°Õ¹¥Ð¹‘•ÁÕÑå½‘”ñð€œt¹Í½µ” ¡µ•µ‰•É½‘”¤€ôøÝ…¹Ñ•¹¡…Ì¡±•…¸¡µ•µ‰•É½‘”°€ÄÀÀ¤¹Ñ½UÁÁ•É…Í” ¤¤¤¤ì(€€€€€¥˜€¡½¹™±¥Ð¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿbb·b¼ƒbŸfbfbÇbŸb¼ƒbŸffb·b¿b¿fGf+fƒfbçf+fGfƒb£bŸffbçfƒbÛffƒfb«f+b£b¤ƒbb»bÇf$ƒfbÓbßb¤¸œ¤ì(€€€€€½¹ÍÐ¹½ÝY…±Õ”€ô¹½Ü ¤ì(€€€€€½¹ÍÐ…Ñ¥½¸€ô•á¥ÍÑ¥¹œ€ü€Ÿb«bçb¿f+fƒb£f+bŸfbŸb¨ƒfb«f+b£b¤œ€è€Ÿb—fbÓbŸb„ƒfb«f+b£b¤œì(€€€€€½¹ÍÐ‘•Ñ…¥°€ô€Ÿb«fƒb·fbàƒbŸffb«f+b£b¤€œ€¬½‘”€¬€œƒf#bÇb£bÜ€œ€¬µ•µ‰•É½‘•Ì¹±•¹Ñ €¬€œƒffƒbŸfbfbÇbŸb¼¸œì(€€€€€½¹ÍÐ¡¥ÍÑ½Éä€ôÉÉ…ä¹¥ÍÉÉ…ä¡•á¥ÍÑ¥¹œü¹¡¥ÍÑ½Éä¤€ü•á¥ÍÑ¥¹œ¹¡¥ÍÑ½Éä¹Í±¥” ´ää¤€èmtì(€€€€€¡¥ÍÑ½Éä¹ÁÕÍ ¡ì…Ñ¥½¸°…Ñ½É½‘”è…Ñ½È¹ÁÕ‰±¥½‘”ñð€œœ°…Ðè¹½ÝY…±Õ”°‘•Ñ…¥°ô¤ì(€€€€€½¹ÍÐÉ•½É€ôì(€€€€€€€€¸¸¸¡•á¥ÍÑ¥¹œñðíô¤°¥è•á¥ÍÑ¥¹œ€ü•á¥ÍÑ¥¹œ¹¥€èµ…­•% 	Pœ¤°½‘”°¹…µ”è¹…µ•Èñð¹…µ•¸°¹…µ•È°¹…µ•¸°Í•Ñ½È°(€€€€€€€ÍÑ…ÑÕÌ°½±½È°Íåµ‰½°°•µ‰±•´°½µµ…¹‘•É½‘”è½µµ…¹‘•È€ü½µµ…¹‘•È¹ÁÕ‰±¥½‘”€è€œœ°‘•ÁÕÑå½‘”è‘•ÁÕÑä€ü‘•ÁÕÑä¹ÁÕ‰±¥½‘”€è€œœ°(€€€€€€€Í•¹¥½É½µµ…¹‘•É½‘”èÍ•¹¥½É½µµ…¹‘•È€üÍ•¹¥½É½µµ…¹‘•È¹ÁÕ‰±¥½‘”€è€œœ°µ•µ‰•É½‘•Ì°(€€€€€€€¹½Ñ•Ìè±•…¸¡Á…å±½…ü¹¹½Ñ•Ì€üü•á¥ÍÑ¥¹œü¹¹½Ñ•Ì°€ÄÀÀÀ¤°µ…ÁA½Í¥Ñ¥½¸è•á¥ÍÑ¥¹œü¹µ…ÁA½Í¥Ñ¥½¸ñð¹Õ±°°¡¥ÍÑ½Éä°(€€€€€€€É•…Ñ•‘Ðè•á¥ÍÑ¥¹œü¹É•…Ñ•‘Ðñð¹½ÝY…±Õ”°É•…Ñ•‘	å½‘”è•á¥ÍÑ¥¹œü¹É•…Ñ•‘	å½‘”ñð…Ñ½È¹ÁÕ‰±¥½‘”°(€€€€€€€ÕÁ‘…Ñ•‘Ðè¹½ÝY…±Õ”°ÕÁ‘…Ñ•‘	å½‘”è…Ñ½È¹ÁÕ‰±¥½‘”(€€€€€ôì(€€€€€¥˜€ …ÉÉ…ä¹¥ÍÉÉ…ä¡ÍÑ…Ñ”¹¥…}‰…ÑÑ…±¥½¹Ì¤¤ÍÑ…Ñ”¹¥…}‰…ÑÑ…±¥½¹Ì€ômtì(€€€€€¥˜€¡•á¥ÍÑ¥¹œ¤ÍÑ…Ñ”¹¥…}‰…ÑÑ…±¥½¹Ì€ôÍÑ…Ñ”¹¥…}‰…ÑÑ…±¥½¹Ì¹µ…À ¡¥Ñ•´¤€ôøMÑÉ¥¹œ¡¥Ñ•´¹¥¤€ôôôMÑÉ¥¹œ¡•á¥ÍÑ¥¹œ¹¥¤€üÉ•½É€è¥Ñ•´¤ì(€€€€€•±Í”ÍÑ…Ñ”¹¥…}‰…ÑÑ…±¥½¹Ì¹Õ¹Í¡¥™Ð¡É•½É¤ì(€€€€€…‘‘Õ‘¥Ñ1½œ¡…Ñ¥½¸°…Ñ½È°¹Õ±°°‘•Ñ…¥°¤ì(€€€€€¥˜€¡ÍÑ…Ñ”¹¥…}…Õ‘¥Ñ}±½ÍlÁt¤ìÍÑ…Ñ”¹¥…}…Õ‘¥Ñ}±½ÍlÁt¹ÍåÍÑ•´€ô€%	@œìÍÑ…Ñ”¹¥…}…Õ‘¥Ñ}±½ÍlÁt¹¥‰Á	…ÑÑ…±¥½¹%€ôMÑÉ¥¹œ¡É•½É¹¥¤ìô(€€€€€½¹ÍÐÁ•ÉÍ¥ÍÑ•¹”€ôÍ…Ù•MÑ…Ñ” ¤ì(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô½¬¡ˆ°ì‰…ÑÑ…±¥½¸è¥‰Á	…ÑÑ…±¥½¹½ÉY¥•Ý•È¡É•½É°…Ñ½È¤ô¤ì(€€€€€AÉ½µ¥Í”¹É•Í½±Ù”¡Á•ÉÍ¥ÍÑ•¹”¤¹Ñ¡•¸  ¤€ôø•µ¥Ñ%	A	…ÑÑ…±¥½¹MÑ…Ñ” ¤¤¹…Ñ   ¤€ôøíô¤ì(€€€€€É•ÑÕÉ¸É•ÍÕ±Ðì(€€€ô¤ì((€€€Í½­•Ð¹½¸ (€€€€€€½Á•É…Ñ¥½¸éÉ•…Ñ”œ°(€€€€€…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€€€½¹ÍÐ…Ñ½È€ô(€€€€€€€€€É•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì((€€€€€€€¥˜€ ……Ñ½È¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼ (€€€€€€€€€€€ˆ°(€€€€€€€€€€€Í½­•ÑI•ÅÕ¥É•µ•¹Ñ5•ÍÍ…”¡Í½­•Ð¤(€€€€€€€€€€¤ì(€€€€€€€ô((€€€€€€€¥˜€ ……¹5…¹…•=Á•É…Ñ¥½¹Ì¡…Ñ½È¤¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb—fbÓbŸb„ƒbŸffffbŸb¨ƒfb«bŸb´ƒffbÇb«b ƒbŸfbçff+bœƒbŸfb¯fbŸb¬ƒffbÜ¸œ¤ì(€€€€€€€ô((€€€€€€€½¹ÍÐÉ•ÅÕ•ÍÑ•‘½‘•Ì€ôÉÉ…ä¹¥ÍÉÉ…ä¡Á…å±½…ü¹µ•µ‰•É½‘•Ì¤(€€€€€€€€€€üÁ…å±½…¹µ•µ‰•É½‘•Ì(€€€€€€€€€€èmÁ…å±½…ü¹…•¹Ñ½‘”ñð€œtì(€€€€€€€½¹ÍÐµ•µ‰•É½‘•Ì€ôl¸¸¹¹•ÜM•Ð (€€€€€€€€€É•ÅÕ•ÍÑ•‘½‘•Ì¹µ…À ¡½‘”¤€ôø±•…¸¡½‘”°€ÄÀÀ¤¤¹™¥±Ñ•È¡	½½±•…¸¤(€€€€€€€€¥tì(€€€€€€€¥˜€ …µ•µ‰•É½‘•Ì¹±•¹Ñ ñðµ•µ‰•É½‘•Ì¹±•¹Ñ €ø€ÔÀ¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸb»b«bÄƒffƒfbÇb¼ƒf#bŸb·b¼ƒb—ff$€ÔÀƒfbÇb¿f/bœƒfffffb¤¸œ¤ì(€€€€€€€ô(€€€€€€€½¹ÍÐ…ÍÍ¥¹•‘•¹ÑÌ€ôµ•µ‰•É½‘•Ì¹µ…À ¡½‘”¤€ôø•ÑUÍ•É	åAÕ‰±¥½‘”¡½‘”¤¤ì(€€€€€€€¥˜€¡…ÍÍ¥¹•‘•¹ÑÌ¹Í½µ” ¡µ•µ‰•È¤€ôø(€€€€€€€€€€…µ•µ‰•Èñð(€€€€€€€€€µ•µ‰•È¹…ÁÁÉ½Ù•€ôôô™…±Í”ñð(€€€€€€€€€µ•µ‰•È¹ÍÕÍÁ•¹‘•(€€€€€€€€¤¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«bfb¼ƒbfƒb³ff+bäƒbŸfbfbÇbŸb¼ƒbŸffb»b«bŸbÇf+fƒfbçb«fb¿f#fƒf#bëf+bÄƒff#ff#ff+f¸ƒf+fffƒb—bÏfbŸb¼ƒbŸffffb¤ƒb·b«f$ƒfffƒff ƒbëf+bÄƒfb«b×fƒb£bŸfb»b¿fb¤¸œ¤ì(€€€€€€€ô((€€€€€€€½¹ÍÐ½Á•É…Ñ¥½¸€ôì(€€€€€€€€€¥è(€€€€€€€€€€€µ…­•% =@œ¤°((€€€€€€€€€µ¥ÍÍ¥½¹9Õµ‰•Èè(€€€€€€€€€€€±•…¸ (€€€€€€€€€€€€€Á…å±½…ü¹µ¥ÍÍ¥½¹9Õµ‰•Èñð(€€€€€€€€€€€€€=@´‘í…Ñ”¹¹½Ü ¥õ€°(€€€€€€€€€€€€€€ÄÀÀ(€€€€€€€€€€€€¤°((€€€€€€€€€Ñ¥Ñ±”è(€€€€€€€€€€€±•…¸ (€€€€€€€€€€€€€Á…å±½…ü¹Ñ¥Ñ±”ñð(€€€€€€€€€€€€€€%=AIQ%=8œ°(€€€€€€€€€€€€€€ÈÀÀ(€€€€€€€€€€€€¤°((€€€€€€€€€ÑåÁ”è(€€€€€€€€€€€±•…¸ (€€€€€€€€€€€€€Á…å±½…ü¹ÑåÁ”ñð(€€€€€€€€€€€€€€9I0œ°(€€€€€€€€€€€€€€ÄÀÀ(€€€€€€€€€€€€¤°((€€€€€€€€€É¥Í¬è(€€€€€€€€€€€±•…¸ (€€€€€€€€€€€€€Á…å±½…ü¹É¥Í¬ñð(€€€€€€€€€€€€€€5%U4œ°(€€€€€€€€€€€€€€ÄÀÀ(€€€€€€€€€€€€¤°((€€€€€€€€€½‰©•Ñ¥Ù”è(€€€€€€€€€€€±•…¸ (€€€€€€€€€€€€€Á…å±½…ü¹½‰©•Ñ¥Ù”ñð(€€€€€€€€€€€€€€œœ°(€€€€€€€€€€€€€€ÔÀÀÀ(€€€€€€€€€€€€¤°((€€€€€€€€€ÍÑ…ÑÕÌè(€€€€€€€€€€€±•…¸ (€€€€€€€€€€€€€Á…å±½…ü¹ÍÑ…ÑÕÌñð(€€€€€€€€€€€€€€A199œ°(€€€€€€€€€€€€€€ÄÀÀ(€€€€€€€€€€€€¤°((€€€€€€€€€ÍÑ…ÉÑ1½…Ñ¥½¸è(€€€€€€€€€€€Á…å±½…ü¹ÍÑ…ÉÑ1½…Ñ¥½¸ñð(€€€€€€€€€€€¹Õ±°°((€€€€€€€€€•¹‘1½…Ñ¥½¸è(€€€€€€€€€€€Á…å±½…ü¹•¹‘1½…Ñ¥½¸ñð(€€€€€€€€€€€¹Õ±°°((€€€€€€€€€½µµ…¹‘•É½‘”è(€€€€€€€€€€€…Ñ½È¹ÁÕ‰±¥½‘”°((€€€€€€€€€½µµ…¹‘•É9…µ”è(€€€€€€€€€€€…Ñ½È¹¹…µ”°((€€€€€€€€€µ•µ‰•É½‘•Ìè(€€€€€€€€€€€…ÍÍ¥¹•‘•¹ÑÌ¹µ…À ¡µ•µ‰•È¤€ôøµ•µ‰•È¹ÁÕ‰±¥½‘”¤°((€€€€€€€€€¹½Ñ•Ìèmt°((€€€€€€€€€µ…Á5…É­•ÉÌèmt°((€€€€€€€€€µ…ÁÉ…Ý¥¹Ìèmt°((€€€€€€€€€É•…Ñ•‘	å½‘”è(€€€€€€€€€€€…Ñ½È¹ÁÕ‰±¥½‘”°((€€€€€€€€€É•…Ñ•‘	å9…µ”è(€€€€€€€€€€€¥Í1•…‘•ÉÍ¡¥À¡…Ñ½È¤(€€€€€€€€€€€€€€ü…Ñ½È¹¹…µ”(€€€€€€€€€€€€€€è€œœ°((€€€€€€€€€É•…Ñ•‘Ðè(€€€€€€€€€€€¹½Ü ¤°((€€€€€€€€€ÕÁ‘…Ñ•‘Ðè(€€€€€€€€€€€¹½Ü ¤(€€€€€€€ôì((€€€€€€€ÍÑ…Ñ”¹¥…}½Á•É…Ñ¥½¹Ì¹ÁÕÍ  (€€€€€€€€€½Á•É…Ñ¥½¸(€€€€€€€€¤ì((€€€€€€€…‘‘Õ‘¥Ñ1½œ (€€€€€€€€€€Ÿb—fbÓbŸb„ƒbçfff+b¤œ°(€€€€€€€€€…Ñ½È°(€€€€€€€€€¹Õ±°°(€€€€€€€€€ƒb«fƒb—fbÓbŸb„ƒbŸfbçfff+b¤€‘í½Á•É…Ñ¥½¸¹µ¥ÍÍ¥½¹9Õµ‰•Éô¹€(€€€€€€€€¤ì((€€€€€€€Í…Ù•MÑ…Ñ” ¤ì((€€€€€€€…Ý…¥ÐÁÕ‰±¥Í¡9½Ñ¥™¥…Ñ¥½¹Ì¡ÍÑ…Ñ”¹¥…}ÕÍ•ÉÌ°ì(€€€€€€€€€ÑåÁ”è€=AIQ%=8œ°(€€€€€€€€€Ñ¥Ñ±”è€9\=AIQ%=8MM%959Pœ°(€€€€€€€€€µ•ÍÍ…”èƒb«fb¨ƒb—bÛbŸfb«fƒb—ff$ƒbçfff+b¤ƒb³b¿f+b¿b¤è€‘í½Á•É…Ñ¥½¸¹µ¥ÍÍ¥½¹9Õµ‰•ÉôƒŠP€‘í½Á•É…Ñ¥½¸¹Ñ¥Ñ±•õ€°(€€€€€€€€€ÁÉ¥½É¥Ñäè½Á•É…Ñ¥½¸¹É¥Í¬€ôôô€!% œñð½Á•É…Ñ¥½¸¹É¥Í¬€ôôô€I%Q%0œ€ü€!% œ€è€9=Q%œ°(€€€€€€€€€Í½ÕÉ•UÍ•É%è…Ñ½È¹¥°(€€€€€€€€€É•±…Ñ•‘%è½Á•É…Ñ¥½¸¹¥°(€€€€€€€€€µ•µ‰•É½‘•Ìè½Á•É…Ñ¥½¸¹µ•µ‰•É½‘•Ì°(€€€€€€€€€µ•Ñ…‘…Ñ„èìµ¥ÍÍ¥½¹9Õµ‰•Èè½Á•É…Ñ¥½¸¹µ¥ÍÍ¥½¹9Õµ‰•È°É¥Í¬è½Á•É…Ñ¥½¸¹É¥Í¬ô(€€€€€€€ô¤ì((€€€€€€€•µ¥Ñ=Á•É…Ñ¥½¹MÑ…Ñ” ¤ì((€€€€€€€É•ÑÕÉ¸½¬ (€€€€€€€€€ˆ°(€€€€€€€€€ì(€€€€€€€€€€€½Á•É…Ñ¥½¸è(€€€€€€€€€€€€€½Á•É…Ñ¥½¹M…¹¥Ñ¥é” (€€€€€€€€€€€€€€€½Á•É…Ñ¥½¸°(€€€€€€€€€€€€€€€…Ñ½È(€€€€€€€€€€€€€€¤(€€€€€€€€€ô(€€€€€€€€¤ì(€€€€€ô(€€€€¤ì((€€€Í½­•Ð¹½¸ (€€€€€€½Á•É…Ñ¥½¸é±¥ÍÐœ°(€€€€€€¡Á…å±½…°ˆ¤€ôøì(€€€€€€€½¹ÍÐ…Ñ½È€ô(€€€€€€€€€É•ÅÕ¥É•ÕÑ¡•¹Ñ¥…Ñ•‘UÍ•È¡Í½­•Ð¤ì((€€€€€€€¥˜€ ……Ñ½È¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼ (€€€€€€€€€€€ˆ°(€€€€€€€€€€€Í½­•ÑI•ÅÕ¥É•µ•¹Ñ5•ÍÍ…”¡Í½­•Ð¤(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€¥˜€¡…Ñ½È¹Í•ÉÙ¥•ÁÁÉ½Ù•€ôôô™…±Í”€˜˜¹½Éµ…±¥é•I…¹¬¡…Ñ½È¹É…¹¬¤€„ôô€9Pœ¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€ŸbçbÇbØƒbŸffffbŸb¨ƒfb«bŸb´ƒffff+bŸb¿b¤ƒb£bçb¼ƒbŸbçb«fbŸb¼ƒb¿b»f#fƒbŸfb»b¿fb¤¸œ¤ì(€€€€€€€ô((€€€€€€€É•ÑÕÉ¸½¬ (€€€€€€€€€ˆ°(€€€€€€€€€ì(€€€€€€€€€€€½Á•É…Ñ¥½¹Ìè(€€€€€€€€€€€€€ÍÑ…Ñ”¹¥…}½Á•É…Ñ¥½¹Ì(€€€€€€€€€€€€€€€€¹µ…À (€€€€€€€€€€€€€€€€€€¡½À¤€ôø(€€€€€€€€€€€€€€€€€€€½Á•É…Ñ¥½¹M…¹¥Ñ¥é” (€€€€€€€€€€€€€€€€€€€€€½À°(€€€€€€€€€€€€€€€€€€€€€…Ñ½È(€€€€€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€€¹™¥±Ñ•È¡	½½±•…¸¤(€€€€€€€€€ô(€€€€€€€€¤ì(€€€€€ô(€€€€¤ì((€€€Í½­•Ð¹½¸ ½Á•É…Ñ¥½¸é…•¹ÑÌœ°€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°Í½­•ÑI•ÅÕ¥É•µ•¹Ñ5•ÍÍ…”¡Í½­•Ð¤¤ì(€€€€€¥˜€ ……¹5…¹…•=Á•É…Ñ¥½¹Ì¡…Ñ½È¤¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€ŸfbŸb›fb¤ƒbŸb»b«f+bŸbÄƒbbçbÛbŸb„ƒbŸffffb¤ƒfb«bŸb·b¤ƒffbÇb«b ƒbŸfbçff+bœƒbŸfb¯fbŸb¬ƒffbÜ¸œ¤ì(€€€€€ô(€€€€€½¹ÍÐµ•µ‰•ÉÌ€ôÍÑ…Ñ”¹¥…}ÕÍ•ÉÌ(€€€€€€€€¹™¥±Ñ•È ¡µ•µ‰•È¤€ôø(€€€€€€€€€µ•µ‰•È¹…ÁÁÉ½Ù•€„ôô™…±Í”€˜˜(€€€€€€€€€€…µ•µ‰•È¹ÍÕÍÁ•¹‘•€˜˜(€€€€€€€€€µ•µ‰•È¹ÁÕ‰±¥½‘”(€€€€€€€€¤(€€€€€€€€¹Í½ÉÐ ¡±•™Ð°É¥¡Ð¤€ôø(€€€€€€€€€É…¹­1•Ù•°¡É¥¡Ð¹É…¹¬¤€´É…¹­1•Ù•°¡±•™Ð¹É…¹¬¤ñð(€€€€€€€€€±•…¸¡±•™Ð¹ÁÕ‰±¥½‘”°€ÄÀÀ¤¹±½…±•½µÁ…É”¡±•…¸¡É¥¡Ð¹ÁÕ‰±¥½‘”°€ÄÀÀ¤¤(€€€€€€€€¤(€€€€€€€€¹µ…À ¡µ•µ‰•È¤€ôøì(€€€€€€€€€½¹ÍÐÍ…™•5•µ‰•È€ôì(€€€€€€€€€€€½‘”èµ•µ‰•È¹ÁÕ‰±¥½‘”°(€€€€€€€€€€€É…¹¬è¹½Éµ…±¥é•I…¹¬¡µ•µ‰•È¹É…¹¬¤°(€€€€€€€€€€€É…¹­1…‰•°èÉ…¹­1…‰•°¡µ•µ‰•È¹É…¹¬¤°(€€€€€€€€€€€½¹±¥¹”è€„…µ•µ‰•È¹½¹±¥¹”°(€€€€€€€€€€€…Ñ¥Ù•M•ÉÙ¥”èµ•µ‰•È¹…Ñ¥Ù•M•ÉÙ¥”€ôôôÑÉÕ”(€€€€€€€€€ôì(€€€€€€€€€¥˜€¡¥Í¡¥•˜¡…Ñ½È¤¤Í…™•5•µ‰•È¹¹…µ”€ôµ•µ‰•È¹¥‘•¹Ñ¥Ñäü¹™Õ±±9…µ”ñðµ•µ‰•È¹¹…µ”ì(€€€€€€€€€É•ÑÕÉ¸Í…™•5•µ‰•Èì(€€€€€€€ô¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ì…•¹ÑÌèµ•µ‰•ÉÌô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ (€€€€€€½Á•É…Ñ¥½¸éÕÁ‘…Ñ”œ°(€€€€€…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€€€½¹ÍÐ…Ñ½È€ô(€€€€€€€€€É•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì((€€€€€€€¥˜€ ……Ñ½È¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼ (€€€€€€€€€€€ˆ°(€€€€€€€€€€€Í½­•ÑI•ÅÕ¥É•µ•¹Ñ5•ÍÍ…”¡Í½­•Ð¤(€€€€€€€€€€¤ì(€€€€€€€ô((€€€€€€€¥˜€ ……¹5…¹…•=Á•É…Ñ¥½¹Ì¡…Ñ½È¤¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«bçb¿f+fƒbŸffffbŸb¨ƒfb«bŸb´ƒffbÇb«b ƒbŸfbçff+bœƒbŸfb¯fbŸb¬ƒffbÜ¸œ¤ì(€€€€€€€ô((€€€€€€€½¹ÍÐ¥€ô(€€€€€€€€€±•…¸ (€€€€€€€€€€€Á…å±½…ü¹¥°(€€€€€€€€€€€€ÈÀÀ(€€€€€€€€€€¤ì((€€€€€€€½¹ÍÐ½Á•É…Ñ¥½¸€ô(€€€€€€€€€ÍÑ…Ñ”¹¥…}½Á•É…Ñ¥½¹Ì¹™¥¹ (€€€€€€€€€€€€¡½À¤€ôø(€€€€€€€€€€€€€MÑÉ¥¹œ¡½À¹¥¤€ôôô(€€€€€€€€€€€€€MÑÉ¥¹œ¡¥¤(€€€€€€€€€€¤ì((€€€€€€€¥˜€ …½Á•É…Ñ¥½¸¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼ (€€€€€€€€€€€ˆ°(€€€€€€€€€€€€ŸbŸfbçfff+b¤ƒbëf+bÄƒff#b³f#b¿b¤¸œ(€€€€€€€€€€¤ì(€€€€€€€ô((€€€€€€€¥˜€ ……¹¹¹½Ñ…Ñ•=Á•É…Ñ¥½¸¡…Ñ½È°½Á•É…Ñ¥½¸¤¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfb«b·b¿f+b¯bŸb¨ƒbŸfff+b¿bŸff+b¤ƒfb«bŸb·b¤ƒfffbÓb˜ƒbŸffffb¤ƒf#bŸfff+bŸb¿b¤ƒf#bŸffbÓbŸbÇfƒbŸffb·b¿b¼ƒffbÜ¸œ¤ì(€€€€€€€ô((€€€€€€€½¹ÍÐÁÉ•Ù¥½ÕÍ5•µ‰•É½‘•Ì€ôÉÉ…ä¹¥ÍÉÉ…ä¡½Á•É…Ñ¥½¸¹µ•µ‰•É½‘•Ì¤€ül¸¸¹½Á•É…Ñ¥½¸¹µ•µ‰•É½‘•Ít€èmtì(€€€€€€€±•ÐÍ•±•Ñ•‘•¹ÑÌ€ô¹Õ±°ì(€€€€€€€¥˜€¡ÉÉ…ä¹¥ÍÉÉ…ä¡Á…å±½…ü¹µ•µ‰•É½‘•Ì¤¤ì(€€€€€€€€€½¹ÍÐÍ•±•Ñ•‘½‘•Ì€ôl¸¸¹¹•ÜM•Ð (€€€€€€€€€€€Á…å±½…¹µ•µ‰•É½‘•Ì¹µ…À ¡½‘”¤€ôø±•…¸¡½‘”°€ÄÀÀ¤¤¹™¥±Ñ•È¡	½½±•…¸¤(€€€€€€€€€€¥tì(€€€€€€€€€¥˜€ …Í•±•Ñ•‘½‘•Ì¹±•¹Ñ ñðÍ•±•Ñ•‘½‘•Ì¹±•¹Ñ €ø€ÔÀ¤ì(€€€€€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸb»b«bÄƒffƒfbÇb¼ƒf#bŸb·b¼ƒb—ff$€ÔÀƒfbÇb¿f/bœƒfffffb¤¸œ¤ì(€€€€€€€€€ô(€€€€€€€€€Í•±•Ñ•‘•¹ÑÌ€ôÍ•±•Ñ•‘½‘•Ì¹µ…À ¡½‘”¤€ôø•ÑUÍ•É	åAÕ‰±¥½‘”¡½‘”¤¤ì(€€€€€€€€€¥˜€¡Í•±•Ñ•‘•¹ÑÌ¹Í½µ” ¡µ•µ‰•È¤€ôø(€€€€€€€€€€€€…µ•µ‰•Èñð(€€€€€€€€€€€µ•µ‰•È¹…ÁÁÉ½Ù•€ôôô™…±Í”ñð(€€€€€€€€€€€µ•µ‰•È¹ÍÕÍÁ•¹‘•(€€€€€€€€€€¤¤ì(€€€€€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«bfb¼ƒbfƒbŸfbff#bŸb¼ƒbŸffb»b«bŸbÇb¤ƒb«b»bÔƒbfbÇbŸb¿f/bœƒfbçb«fb¿f+fƒf#bëf+bÄƒff#ff#ff+f¸œ¤ì(€€€€€€€€€ô(€€€€€€€ô((€€€€€€€¥˜€¡Í•±•Ñ•‘•¹ÑÌ¤ì(€€€€€€€€€½Á•É…Ñ¥½¸¹µ•µ‰•É½‘•Ì€ôÍ•±•Ñ•‘•¹ÑÌ¹µ…À ¡µ•µ‰•È¤€ôøµ•µ‰•È¹ÁÕ‰±¥½‘”¤ì(€€€€€€€ô((€€€€€€€½¹ÍÐÁÉ•Ù¥½ÕÍMÑ…ÑÕÌ€ô½Á•É…Ñ¥½¸¹ÍÑ…ÑÕÌì(€€€€€€€½¹ÍÐ™¥•±‘Ì€ôl(€€€€€€€€€€µ¥ÍÍ¥½¹9Õµ‰•Èœ°(€€€€€€€€€€Ñ¥Ñ±”œ°(€€€€€€€€€€ÑåÁ”œ°(€€€€€€€€€€É¥Í¬œ°(€€€€€€€€€€½‰©•Ñ¥Ù”œ°(€€€€€€€€€€ÍÑ…ÑÕÌœ°(€€€€€€€€€€½µµ…¹‘•É½‘”œ(€€€€€€€tì((€€€€€€€™½È€ (€€€€€€€€€½¹ÍÐ™¥•±(€€€€€€€€€½˜™¥•±‘Ì(€€€€€€€€¤ì(€€€€€€€€€¥˜€ (€€€€€€€€€€€Á…å±½…ü¹m™¥•±‘t€„ôô(€€€€€€€€€€€Õ¹‘•™¥¹•(€€€€€€€€€€¤ì(€€€€€€€€€€€½Á•É…Ñ¥½¹m™¥•±‘t€ô(€€€€€€€€€€€€€±•…¸ (€€€€€€€€€€€€€€€Á…å±½…‘m™¥•±‘t°(€€€€€€€€€€€€€€€™¥•±€ôôô(€€€€€€€€€€€€€€€€€€½‰©•Ñ¥Ù”œ(€€€€€€€€€€€€€€€€€€ü€ÔÀÀÀ(€€€€€€€€€€€€€€€€€€è€ÔÀÀ(€€€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€ô((€€€€€€€…‘‘=Á•É…Ñ¥½¹MÑ…ÑÕÍ!¥ÍÑ½Éä¡½Á•É…Ñ¥½¸°…Ñ½È°ÁÉ•Ù¥½ÕÍMÑ…ÑÕÌ¤ì((€€€€€€€¥˜€ (€€€€€€€€€Á…å±½…ü¹ÍÑ…ÉÑ1½…Ñ¥½¸€„ôô(€€€€€€€€€Õ¹‘•™¥¹•(€€€€€€€€¤ì(€€€€€€€€€½Á•É…Ñ¥½¸¹ÍÑ…ÉÑ1½…Ñ¥½¸€ô(€€€€€€€€€€€Á…å±½…¹ÍÑ…ÉÑ1½…Ñ¥½¸ì(€€€€€€€ô((€€€€€€€¥˜€ (€€€€€€€€€Á…å±½…ü¹•¹‘1½…Ñ¥½¸€„ôô(€€€€€€€€€Õ¹‘•™¥¹•(€€€€€€€€¤ì(€€€€€€€€€½Á•É…Ñ¥½¸¹•¹‘1½…Ñ¥½¸€ô(€€€€€€€€€€€Á…å±½…¹•¹‘1½…Ñ¥½¸ì(€€€€€€€ô((€€€€€€€½Á•É…Ñ¥½¸¹ÕÁ‘…Ñ•‘Ð€ô(€€€€€€€€€¹½Ü ¤ì((€€€€€€€…‘‘Õ‘¥Ñ1½œ (€€€€€€€€€€Ÿb«b·b¿f+b¬ƒbçfff+b¤œ°(€€€€€€€€€…Ñ½È°(€€€€€€€€€¹Õ±°°(€€€€€€€€€ƒb«fƒb«b·b¿f+b¬ƒbŸfbçfff+b¤€‘í½Á•É…Ñ¥½¸¹µ¥ÍÍ¥½¹9Õµ‰•Éô¹€(€€€€€€€€¤ì((€€€€€€€Í…Ù•MÑ…Ñ” ¤ì((€€€€€€€…Ý…¥ÐÁÕ‰±¥Í¡9½Ñ¥™¥…Ñ¥½¹Ì¡ÍÑ…Ñ”¹¥…}ÕÍ•ÉÌ°ì(€€€€€€€€€ÑåÁ”è€=AIQ%=8œ°(€€€€€€€€€Ñ¥Ñ±”è€=AIQ%=8UAQœ°(€€€€€€€€€µ•ÍÍ…”èƒb«fƒb«b·b¿f+b¬ƒbŸfbçfff+b¤€‘í½Á•É…Ñ¥½¸¹µ¥ÍÍ¥½¹9Õµ‰•ÉôƒŠP€‘í½Á•É…Ñ¥½¸¹Ñ¥Ñ±•ô¹€°(€€€€€€€€€ÁÉ¥½É¥Ñäè½Á•É…Ñ¥½¸¹É¥Í¬€ôôô€!% œñð½Á•É…Ñ¥½¸¹É¥Í¬€ôôô€I%Q%0œ€ü€!% œ€è€9=Q%œ°(€€€€€€€€€Í½ÕÉ•UÍ•É%è…Ñ½È¹¥°(€€€€€€€€€É•±…Ñ•‘%è½Á•É…Ñ¥½¸¹¥°(€€€€€€€€€µ•µ‰•É½‘•Ìèl¸¸¹¹•ÜM•Ð¡l¸¸¹ÁÉ•Ù¥½ÕÍ5•µ‰•É½‘•Ì°€¸¸¸¡½Á•É…Ñ¥½¸¹µ•µ‰•É½‘•Ìñðmt¥t¥t°(€€€€€€€€€µ•Ñ…‘…Ñ„èìµ¥ÍÍ¥½¹9Õµ‰•Èè½Á•É…Ñ¥½¸¹µ¥ÍÍ¥½¹9Õµ‰•È°É¥Í¬è½Á•É…Ñ¥½¸¹É¥Í¬°ÍÑ…ÑÕÌè½Á•É…Ñ¥½¸¹ÍÑ…ÑÕÌô(€€€€€€€ô¤ì((€€€€€€€•µ¥Ñ=Á•É…Ñ¥½¹MÑ…Ñ” ¤ì((€€€€€€€É•ÑÕÉ¸½¬ (€€€€€€€€€ˆ°(€€€€€€€€€ì(€€€€€€€€€€€½Á•É…Ñ¥½¸è(€€€€€€€€€€€€€½Á•É…Ñ¥½¹M…¹¥Ñ¥é” (€€€€€€€€€€€€€€€½Á•É…Ñ¥½¸°(€€€€€€€€€€€€€€€…Ñ½È(€€€€€€€€€€€€€€¤(€€€€€€€€€ô(€€€€€€€€¤ì(€€€€€ô(€€€€¤ì((€€€Í½­•Ð¹½¸ (€€€€€€½Á•É…Ñ¥½¸é…‘‘9½Ñ”œ°(€€€€€…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€€€½¹ÍÐ…Ñ½È€ô(€€€€€€€€€É•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì((€€€€€€€¥˜€ ……Ñ½È¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼ (€€€€€€€€€€€ˆ°(€€€€€€€€€€€Í½­•ÑI•ÅÕ¥É•µ•¹Ñ5•ÍÍ…”¡Í½­•Ð¤(€€€€€€€€€€¤ì(€€€€€€€ô((€€€€€€€½¹ÍÐ¥€ô(€€€€€€€€€±•…¸ (€€€€€€€€€€€Á…å±½…ü¹¥°(€€€€€€€€€€€€ÈÀÀ(€€€€€€€€€€¤ì((€€€€€€€½¹ÍÐ½Á•É…Ñ¥½¸€ô(€€€€€€€€€ÍÑ…Ñ”¹¥…}½Á•É…Ñ¥½¹Ì¹™¥¹ (€€€€€€€€€€€€¡½À¤€ôø(€€€€€€€€€€€€€MÑÉ¥¹œ¡½À¹¥¤€ôôô(€€€€€€€€€€€€€MÑÉ¥¹œ¡¥¤(€€€€€€€€€€¤ì((€€€€€€€¥˜€ …½Á•É…Ñ¥½¸¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼ (€€€€€€€€€€€ˆ°(€€€€€€€€€€€€ŸbŸfbçfff+b¤ƒbëf+bÄƒff#b³f#b¿b¤¸œ(€€€€€€€€€€¤ì(€€€€€€€ô((€€€€€€€¥˜€ ……¹¹¹½Ñ…Ñ•=Á•É…Ñ¥½¸¡…Ñ½È°½Á•É…Ñ¥½¸¤¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfb«b·b¿f+b¯bŸb¨ƒbŸfff+b¿bŸff+b¤ƒfb«bŸb·b¤ƒfffbÓb˜ƒbŸffffb¤ƒf#bŸfff+bŸb¿b¤ƒf#bŸffbÓbŸbÇfƒbŸffb·b¿b¼ƒffbÜ¸œ¤ì(€€€€€€€ô((€€€€€€€½¹ÍÐÑ•áÐ€ô(€€€€€€€€€±•…¸ (€€€€€€€€€€€Á…å±½…ü¹Ñ•áÐñð(€€€€€€€€€€€Á…å±½…ü¹¹½Ñ”°(€€€€€€€€€€€€ÌÀÀÀ(€€€€€€€€€€¤ì((€€€€€€€¥˜€ …Ñ•áÐ¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼ (€€€€€€€€€€€ˆ°(€€€€€€€€€€€€ŸbŸfffbŸb·bãb¤ƒfbŸbÇbëb¤¸œ(€€€€€€€€€€¤ì(€€€€€€€ô((€€€€€€€½Á•É…Ñ¥½¸¹¹½Ñ•Ì€ô(€€€€€€€€€ÉÉ…ä¹¥ÍÉÉ…ä (€€€€€€€€€€€½Á•É…Ñ¥½¸¹¹½Ñ•Ì(€€€€€€€€€€¤(€€€€€€€€€€€€ü½Á•É…Ñ¥½¸¹¹½Ñ•Ì(€€€€€€€€€€€€èmtì((€€€€€€€½Á•É…Ñ¥½¸¹¹½Ñ•Ì¹ÁÕÍ ¡ì(€€€€€€€€€…Ðè(€€€€€€€€€€€¹½Ü ¤°((€€€€€€€€€…ÕÑ¡½É½‘”è(€€€€€€€€€€€…Ñ½È¹ÁÕ‰±¥½‘”°((€€€€€€€€€…ÕÑ¡½É9…µ”è(€€€€€€€€€€€¥Í¡¥•˜¡…Ñ½È¤(€€€€€€€€€€€€€€ü…Ñ½È¹¹…µ”(€€€€€€€€€€€€€€è€œœ°((€€€€€€€€€Ñ•áÐ(€€€€€€€ô¤ì((€€€€€€€½Á•É…Ñ¥½¸¹¹½Ñ•Ì€ô(€€€€€€€€€½Á•É…Ñ¥½¸¹¹½Ñ•Ì¹Í±¥” (€€€€€€€€€€€€´ÈÀÀ(€€€€€€€€€€¤ì((€€€€€€€½Á•É…Ñ¥½¸¹ÕÁ‘…Ñ•‘Ð€ô(€€€€€€€€€¹½Ü ¤ì((€€€€€€€Í…Ù•MÑ…Ñ” ¤ì((€€€€€€€…Ý…¥ÐÁÕ‰±¥Í¡9½Ñ¥™¥…Ñ¥½¹Ì¡ÍÑ…Ñ”¹¥…}ÕÍ•ÉÌ°ì(€€€€€€€€€ÑåÁ”è€=AIQ%=8œ°(€€€€€€€€€Ñ¥Ñ±”è€%1UAQ€¼¼=AIQ%=89=Qœ°(€€€€€€€€€µ•ÍÍ…”èƒbf?bÛf+fƒb«b·b¿f+b¬ƒff+b¿bŸff(ƒb—ff$ƒbŸfbçfff+b¤€‘í½Á•É…Ñ¥½¸¹µ¥ÍÍ¥½¹9Õµ‰•Éô¹€°(€€€€€€€€€ÁÉ¥½É¥Ñäè½Á•É…Ñ¥½¸¹É¥Í¬€ôôô€!% œñð½Á•É…Ñ¥½¸¹É¥Í¬€ôôô€I%Q%0œ€ü€!% œ€è€9=Q%œ°(€€€€€€€€€Í½ÕÉ•UÍ•É%è…Ñ½È¹¥°(€€€€€€€€€É•±…Ñ•‘%è½Á•É…Ñ¥½¸¹¥°(€€€€€€€€€µ•µ‰•É½‘•Ìè½Á•É…Ñ¥½¸¹µ•µ‰•É½‘•Ì°(€€€€€€€€€µ•Ñ…‘…Ñ„èìµ¥ÍÍ¥½¹9Õµ‰•Èè½Á•É…Ñ¥½¸¹µ¥ÍÍ¥½¹9Õµ‰•È°É¥Í¬è½Á•É…Ñ¥½¸¹É¥Í¬ô(€€€€€€€ô¤ì((€€€€€€€•µ¥Ñ=Á•É…Ñ¥½¹MÑ…Ñ” ¤ì((€€€€€€€É•ÑÕÉ¸½¬ (€€€€€€€€€ˆ°(€€€€€€€€€ì(€€€€€€€€€€€½Á•É…Ñ¥½¸è(€€€€€€€€€€€€€½Á•É…Ñ¥½¹M…¹¥Ñ¥é” (€€€€€€€€€€€€€€€½Á•É…Ñ¥½¸°(€€€€€€€€€€€€€€€…Ñ½È(€€€€€€€€€€€€€€¤(€€€€€€€€€ô(€€€€€€€€¤ì(€€€€€ô(€€€€¤ì((€€€Í½­•Ð¹½¸ (€€€€€€½Á•É…Ñ¥½¸é‘•±•Ñ”œ°(€€€€€€¡Á…å±½…°ˆ¤€ôøì(€€€€€€€½¹ÍÐ…Ñ½È€ô(€€€€€€€€€É•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì((€€€€€€€¥˜€ ……Ñ½È¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼ (€€€€€€€€€€€ˆ°(€€€€€€€€€€€Í½­•ÑI•ÅÕ¥É•µ•¹Ñ5•ÍÍ…”¡Í½­•Ð¤(€€€€€€€€€€¤ì(€€€€€€€ô((€€€€€€€¥˜€ (€€€€€€€€€€…¥Í¡¥•˜¡…Ñ½È¤(€€€€€€€€¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼ (€€€€€€€€€€€ˆ°(€€€€€€€€€€€€Ÿb·bÃfƒbŸfbçfff+bŸb¨ƒfb«bŸb´ƒff %!%ƒffbÜ¸œ(€€€€€€€€€€¤ì(€€€€€€€ô((€€€€€€€½¹ÍÐ¥€ô(€€€€€€€€€±•…¸ (€€€€€€€€€€€Á…å±½…ü¹¥°(€€€€€€€€€€€€ÈÀÀ(€€€€€€€€€€¤ì((€€€€€€€½¹ÍÐ•á¥ÍÑÌ€ô(€€€€€€€€€ÍÑ…Ñ”¹¥…}½Á•É…Ñ¥½¹Ì¹Í½µ” (€€€€€€€€€€€€¡½À¤€ôø(€€€€€€€€€€€€€MÑÉ¥¹œ¡½À¹¥¤€ôôô(€€€€€€€€€€€€€MÑÉ¥¹œ¡¥¤(€€€€€€€€€€¤ì((€€€€€€€¥˜€ …•á¥ÍÑÌ¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼ (€€€€€€€€€€€ˆ°(€€€€€€€€€€€€ŸbŸfbçfff+b¤ƒbëf+bÄƒff#b³f#b¿b¤¸œ(€€€€€€€€€€¤ì(€€€€€€€ô((€€€€€€€ÍÑ…Ñ”¹¥…}½Á•É…Ñ¥½¹Ì€ô(€€€€€€€€€ÍÑ…Ñ”¹¥…}½Á•É…Ñ¥½¹Ì¹™¥±Ñ•È (€€€€€€€€€€€€¡½À¤€ôø(€€€€€€€€€€€€€MÑÉ¥¹œ¡½À¹¥¤€„ôô(€€€€€€€€€€€€€MÑÉ¥¹œ¡¥¤(€€€€€€€€€€¤ì((€€€€€€€…‘‘Õ‘¥Ñ1½œ (€€€€€€€€€€Ÿb·bÃfƒbçfff+b¤œ°(€€€€€€€€€…Ñ½È°(€€€€€€€€€¹Õ±°°(€€€€€€€€€ƒb«fƒb·bÃfƒbŸfbçfff+b¤€‘í¥‘ô¹€(€€€€€€€€¤ì((€€€€€€€Í…Ù•MÑ…Ñ” ¤ì((€€€€€€€•µ¥Ñ=Á•É…Ñ¥½¹MÑ…Ñ” ¤ì((€€€€€€€É•ÑÕÉ¸½¬ (€€€€€€€€€ˆ°(€€€€€€€€€ì(€€€€€€€€€€€¥(€€€€€€€€€ô(€€€€€€€€¤ì(€€€€€ô(€€€€¤ì((€€€Í½­•Ð¹½¸ ½Á•É…Ñ¥½¸é…‘‘5…É­•Èœ°€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+fbËfƒb«bÏb³f+fƒbŸfb¿b»f#fƒffb»b¿fb¤ƒbf#fbŸf,¸œ¤ì(€€€€€½¹ÍÐ¥€ô±•…¸¡Á…å±½…ü¹¥ñðÁ…å±½…ü¹½Á•É…Ñ¥½¹%°€ÈÀÀ¤ì(€€€€€½¹ÍÐ½Á•É…Ñ¥½¸€ôÍÑ…Ñ”¹¥…}½Á•É…Ñ¥½¹Ì¹™¥¹ ¡¥Ñ•´¤€ôøMÑÉ¥¹œ¡¥Ñ•´¹¥¤€ôôôMÑÉ¥¹œ¡¥¤¤ì(€€€€€¥˜€ …½Á•É…Ñ¥½¸¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸffffb¤ƒbëf+bÄƒff#b³f#b¿b¤¸œ¤ì(€€€€€¥˜€ ……¹5…¹…•=Á•É…Ñ¥½¹Ì¡…Ñ½È¤¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€ŸfbÇbŸb³bçb¤ƒb»bÇf+bßb¤ƒbŸffffb¤ƒfb«bŸb·b¤ƒffbÇb«b ƒbŸfbçff+bœƒbŸfb¯fbŸb¬ƒffbÜ¸œ¤ì(€€€€€ô(€€€€€½¹ÍÐÁ½¥¹Ð€ôµ¥ÍÍ¥½¹A½¥¹Ð¡Á…å±½…ü¹Á½¥¹ÐñðÁ…å±½…¤ì(€€€€€¥˜€ …Á½¥¹Ð¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿff#fbäƒbŸfbçfbŸfb¤ƒbëf+bÄƒb×b·f+b´¸œ¤ì(€€€€€½¹ÍÐµ…É­•È€ôì(€€€€€€€¥èµ…­•% =A5I,œ¤°(€€€€€€€€¸¸¹Á½¥¹Ð°(€€€€€€€±…‰•°è±•…¸¡Á…å±½…ü¹±…‰•°ñð€ŸbçfbŸfb¤ƒff+b¿bŸff+b¤œ°€ÄàÀ¤°(€€€€€€€­¥¹èlÉ¥µ¥¹…°œ°€Á•½Á±”t¹¥¹±Õ‘•Ì¡Á…å±½…ü¹­¥¹¤€üÁ…å±½…¹­¥¹€è€Á½¥¹Ðœ°(€€€€€€€½Õ¹Ðè9Õµ‰•È¹¥Í%¹Ñ••È¡9Õµ‰•È¡Á…å±½…ü¹½Õ¹Ð¤¤€˜˜9Õµ‰•È¡Á…å±½…ü¹½Õ¹Ð¤€øô€Ä€˜˜9Õµ‰•È¡Á…å±½…ü¹½Õ¹Ð¤€ðô€ÄÀÀÀ(€€€€€€€€€€ü9Õµ‰•È¡Á…å±½…¹½Õ¹Ð¤(€€€€€€€€€€è¹Õ±°°(€€€€€€€½±½Èèµ¥ÍÍ¥½¹5…Á½±½È¡Á…å±½…ü¹½±½È¤°(€€€€€€€…ÕÑ¡½É½‘”è…Ñ½È¹ÁÕ‰±¥½‘”°(€€€€€€€…Ðè¹½Ü ¤(€€€€€ôì(€€€€€½Á•É…Ñ¥½¸¹µ…Á5…É­•ÉÌ€ôÉÉ…ä¹¥ÍÉÉ…ä¡½Á•É…Ñ¥½¸¹µ…Á5…É­•ÉÌ¤€ü½Á•É…Ñ¥½¸¹µ…Á5…É­•ÉÌ€èmtì(€€€€€½Á•É…Ñ¥½¸¹µ…Á5…É­•ÉÌ¹ÁÕÍ ¡µ…É­•È¤ì(€€€€€½Á•É…Ñ¥½¸¹µ…Á5…É­•ÉÌ€ô½Á•É…Ñ¥½¸¹µ…Á5…É­•ÉÌ¹Í±¥” ´ÈÀÀ¤ì(€€€€€½Á•É…Ñ¥½¸¹ÕÁ‘…Ñ•‘Ð€ô¹½Ü ¤ì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€•µ¥Ñ=Á•É…Ñ¥½¹MÑ…Ñ” ¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ìµ…É­•È°½Á•É…Ñ¥½¸è½Á•É…Ñ¥½¹M…¹¥Ñ¥é”¡½Á•É…Ñ¥½¸°…Ñ½È¤ô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ ½Á•É…Ñ¥½¸é…‘‘É…Ý¥¹œœ°€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+fbËfƒb«bÏb³f+fƒbŸfb¿b»f#fƒffb»b¿fb¤ƒbf#fbŸf,¸œ¤ì(€€€€€½¹ÍÐ¥€ô±•…¸¡Á…å±½…ü¹¥ñðÁ…å±½…ü¹½Á•É…Ñ¥½¹%°€ÈÀÀ¤ì(€€€€€½¹ÍÐ½Á•É…Ñ¥½¸€ôÍÑ…Ñ”¹¥…}½Á•É…Ñ¥½¹Ì¹™¥¹ ¡¥Ñ•´¤€ôøMÑÉ¥¹œ¡¥Ñ•´¹¥¤€ôôôMÑÉ¥¹œ¡¥¤¤ì(€€€€€¥˜€ …½Á•É…Ñ¥½¸¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸffffb¤ƒbëf+bÄƒff#b³f#b¿b¤¸œ¤ì(€€€€€¥˜€ ……¹5…¹…•=Á•É…Ñ¥½¹Ì¡…Ñ½È¤¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€ŸfbÇbŸb³bçb¤ƒb»bÇf+bßb¤ƒbŸffffb¤ƒfb«bŸb·b¤ƒffbÇb«b ƒbŸfbçff+bœƒbŸfb¯fbŸb¬ƒffbÜ¸œ¤ì(€€€€€ô(€€€€€½¹ÍÐÁ½¥¹ÑÌ€ôÉÉ…ä¹¥ÍÉÉ…ä¡Á…å±½…ü¹Á½¥¹ÑÌ¤(€€€€€€€€üÁ…å±½…¹Á½¥¹ÑÌ¹µ…À¡µ¥ÍÍ¥½¹A½¥¹Ð¤¹™¥±Ñ•È¡	½½±•…¸¤¹Í±¥” À°€ÔÀÀ¤(€€€€€€€€èmtì(€€€€€¥˜€¡Á½¥¹ÑÌ¹±•¹Ñ €ð€È¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfbÇbÏfƒf+b·b«bŸb°ƒffbßb«f+fƒbçff$ƒbŸfbff¸œ¤ì(€€€€€½¹ÍÐÍ¡…Á”€ô5%MM%=9}I]%9}M!AL¹¡…Ì¡Á…å±½…ü¹Í¡…Á”¤€üÁ…å±½…¹Í¡…Á”€è€™É••¡…¹œì(€€€€€½¹ÍÐ‘É…Ý¥¹œ€ôì(€€€€€€€¥èµ…­•% =AI\œ¤°(€€€€€€€Á½¥¹ÑÌ°(€€€€€€€Í¡…Á”°(€€€€€€€½±½Èèµ¥ÍÍ¥½¹5…Á½±½È¡Á…å±½…ü¹½±½È¤°(€€€€€€€…ÕÑ¡½É½‘”è…Ñ½È¹ÁÕ‰±¥½‘”°(€€€€€€€…Ðè¹½Ü ¤(€€€€€ôì(€€€€€½Á•É…Ñ¥½¸¹µ…ÁÉ…Ý¥¹Ì€ôÉÉ…ä¹¥ÍÉÉ…ä¡½Á•É…Ñ¥½¸¹µ…ÁÉ…Ý¥¹Ì¤€ü½Á•É…Ñ¥½¸¹µ…ÁÉ…Ý¥¹Ì€èmtì(€€€€€½Á•É…Ñ¥½¸¹µ…ÁÉ…Ý¥¹Ì¹ÁÕÍ ¡‘É…Ý¥¹œ¤ì(€€€€€½Á•É…Ñ¥½¸¹µ…ÁÉ…Ý¥¹Ì€ô½Á•É…Ñ¥½¸¹µ…ÁÉ…Ý¥¹Ì¹Í±¥” ´ÄÀÀ¤ì(€€€€€½Á•É…Ñ¥½¸¹ÕÁ‘…Ñ•‘Ð€ô¹½Ü ¤ì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€•µ¥Ñ=Á•É…Ñ¥½¹MÑ…Ñ” ¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ì‘É…Ý¥¹œ°½Á•É…Ñ¥½¸è½Á•É…Ñ¥½¹M…¹¥Ñ¥é”¡½Á•É…Ñ¥½¸°…Ñ½È¤ô¤ì(€€€ô¤ì((€€€€¼¨€ôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôô(€€€€€€1%9P=5AQ%	%1%QdY9QL(€€€€ôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôô€¨¼((€€€Í½­•Ð¹½¸ …‘µ¥¸éÕÁ‘…Ñ•5•µ‰•Èœ°€¡Á…å±½…°ˆ¤€ôøì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#f¸œ¤ì(€€€€€€€½¹ÍÐÑ…É•Ð€ô•ÑUÍ•É	å%¡±•…¸¡Á…å±½…ü¹µ•µ‰•É%ñðÁ…å±½…ü¹ÕÍ•É%°€ÄÈÀ¤¤ì(€€€€€€€¥˜€ …Ñ…É•Ð¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfbÓb»b×f+b¤ƒbëf+bÄƒff#b³f#b¿b¤¸œ¤ì(€€€€€€€¥˜€ ……¹5…¹…•5•µ‰•È¡…Ñ½È°Ñ…É•Ð¤¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿfbœƒb«fffƒb×fbŸb·f+b¤ƒb«bçb¿f+fƒfbÃfƒbŸfbÓb»b×f+b¤¸œ¤ì((€€€€€€€±•Ð…Ñ¥½¸€ô€½‘”œì(€€€€€€€¥˜€¡Á…å±½…ü¹É…¹¬€„ôôÕ¹‘•™¥¹•¤ì(€€€€€€€€€½¹ÍÐÉ…¹¬€ô¹½Éµ…±¥é•I…¹¬¡Á…å±½…¹É…¹¬¤ì(€€€€€€€€€¥˜€ ……¹¡…¹•I…¹¬¡…Ñ½È°Ñ…É•Ð°É…¹¬¤¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿfbœƒb«fffƒb×fbŸb·f+b¤ƒb«bëf+f+bÄƒbÇb«b£b¤ƒfbÃfƒbŸfbÓb»b×f+b¤¸œ¤ì(€€€€€€€€€Ñ…É•Ð¹É…¹¬€ôÉ…¹¬ì(€€€€€€€€€•¹ÍÕÉ•	…¹¬¡Ñ…É•Ð¤¹Í…±…Éä€ô‘•™…Õ±ÑM…±…Éå½ÉI…¹¬¡É…¹¬¤ì(€€€€€€€€€…Ñ¥½¸€ô€É…¹¬œì(€€€€€€€ô(€€€€€€€¥˜€¡Á…å±½…ü¹Í•É•Ñ½‘”€„ôôÕ¹‘•™¥¹•¤ì(€€€€€€€€€½¹ÍÐÍ•É•Ñ½‘”€ô±•…¸¡Á…å±½…¹Í•É•Ñ½‘”°€ÄÀÀ¤ì(€€€€€€€€€½¹ÍÐ•ÉÉ½È€ôÙ…±¥‘…Ñ•M•É•Ñ½‘”¡Í•É•Ñ½‘”°Ñ…É•Ð¤ì(€€€€€€€€€¥˜€¡•ÉÉ½Èñð€……¹¡…¹•M•É•Ð¡…Ñ½È°Ñ…É•Ð¤¤É•ÑÕÉ¸¹¼¡ˆ°•ÉÉ½Èñð€Ÿfbœƒb«fffƒb×fbŸb·f+b¤ƒb«bëf+f+bÄƒff#b¼ƒfbÃfƒbŸfbÓb»b×f+b¤¸œ¤ì(€€€€€€€€€Ñ…É•Ð¹Í•É•Ñ½‘”€ôÍ•É•Ñ½‘”ì(€€€€€€€€€…Ñ¥½¸€ô€½‘”œì(€€€€€€€ô(€€€€€€€¥˜€¡Á…å±½…ü¹ÁÕ‰±¥½‘”€„ôôÕ¹‘•™¥¹•¤ì(€€€€€€€€€½¹ÍÐÁÕ‰±¥½‘”€ô±•…¸¡Á…å±½…¹ÁÕ‰±¥½‘”°€ÄÀÀ¤ì(€€€€€€€€€½¹ÍÐ‘ÕÁ±¥…Ñ”€ô•ÑUÍ•É	åAÕ‰±¥½‘”¡ÁÕ‰±¥½‘”¤ì(€€€€€€€€€¥˜€ …ÁÕ‰±¥½‘”ñðÁÕ‰±¥½‘”€ôôô€A9%9œñð€¡‘ÕÁ±¥…Ñ”€˜˜‘ÕÁ±¥…Ñ”¹¥€„ôôÑ…É•Ð¹¥¤¤ì(€€€€€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfff#b¼ƒbŸfbçbÏfbÇf(ƒbëf+bÄƒb×bŸfb´ƒbf ƒfbÏb«b»b¿f¸œ¤ì(€€€€€€€€€ô(€€€€€€€€€¥˜€ ……¹5…¹…•5•µ‰•È¡…Ñ½È°Ñ…É•Ð¤¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿfbœƒb«fffƒb×fbŸb·f+b¤ƒb«bëf+f+bÄƒbŸfff#b¼ƒbŸfbçbÏfbÇf(¸œ¤ì(€€€€€€€€€¥˜€¡Ñ…É•Ð¹Í•ÉÙ¥•ÁÁÉ½Ù•€„ôôÑÉÕ”¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿfbœƒf+fffƒb—b×b¿bŸbÄƒbf ƒb«bëf+f+bÄƒbŸfff#b¼ƒbŸfbçbÏfbÇf(ƒfb£fƒff#bŸffb¤ƒb¿b»f#fƒbŸfb»b¿fb¤¸œ¤ì(€€€€€€€€€Ñ…É•Ð¹ÁÕ‰±¥½‘”€ôÁÕ‰±¥½‘”ì(€€€€€€€€€…Ñ¥½¸€ô€½‘”œì(€€€€€€€ô(€€€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€€€•µ¥ÑMÑ…Ñ” ¤ì(€€€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô½¬¡ˆ°ì…Ñ¥½¸°ÕÍ•ÈèÁÕ‰±¥UÍ•È¡Ñ…É•Ð°…Ñ½È¤ô¤ì(€€€€€€€Í½­•Ð¹•µ¥Ð …‘µ¥¸éµ•µ‰•ÈéÉ•ÍÕ±Ðœ°É•ÍÕ±Ð¤ì(€€€€€€€É•ÑÕÉ¸É•ÍÕ±Ðì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°•ÉÉ½È¹µ•ÍÍ…”ñð€Ÿb«bçbÃbÄƒb«bçb¿f+fƒbŸfbÓb»b×f+b¤¸œ¤ì(€€€€€ô(€€€ô¤ì((€€€Í½­•Ð¹½¸ …‘µ¥¸éÉ•…Ñ¥Ù…Ñ•5•µ‰•Èœ°…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•ÕÑ¡•¹Ñ¥…Ñ•‘UÍ•È¡Í½­•Ð¤ì(€€€€€½¹ÍÐÑ…É•Ð€ô•ÑUÍ•É	å%¡±•…¸¡Á…å±½…ü¹µ•µ‰•É%ñðÁ…å±½…ü¹ÕÍ•É%°€ÄÈÀ¤¤ì(€€€€€¥˜€ ……Ñ½Èñð€…Ñ…É•Ð¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfbÓb»b×f+b¤ƒbëf+bÄƒff#b³f#b¿b¤¸œ¤ì(€€€€€¥˜€ ……¹I•ÍÑ½É•M•ÕÉ¥Ñå5•µ‰•È¡…Ñ½È¤¤ì(€€€€€€€½¹ÍÐ¥¹¥‘•¹Ð€ôÉ•½É‘M•ÕÉ¥ÑåÙ•¹Ð¡ì(€€€€€€€€€…Ñ½È°(€€€€€€€€€Ñ…É•Ðè…Ñ½È°(€€€€€€€€€…Ñ¥½¸è€U9UQ!=I%i}IMQ=I}QQ5APœ°(€€€€€€€€€ÑåÁ”è€MM}=9QI=0œ°(€€€€€€€€€±•Ù•°è€Ì°(€€€€€€€€€É•…Í½¸è€=91e}%}!%}9}IMQ=I}55	ILœ°(€€€€€€€€€ÍÑ…ÑÕÌè€	1=-œ(€€€€€€€ô¤ì(€€€€€€€…Ý…¥Ð¹½Ñ¥™åM•ÕÉ¥Ñå1•…‘•ÉÍ¡¥À¡¥¹¥‘•¹Ð¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿfbœƒb«fffƒb×fbŸb·f+b¤ƒb—bçbŸb¿b¤ƒfbÃfƒbŸfbÓb»b×f+b¤ƒffb»b¿fb¤¸œ¤ì(€€€€€ô(€€€€€¥˜€¡Ñ…É•Ð¹¥€ôôô…Ñ½È¹¥¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿfbœƒf+fffƒbŸbÏb«bçbŸb¿b¤ƒb·bÏbŸb£fƒb£fbÃfƒbŸfbçfff+b¤¸œ¤ì(€€€€€¥˜€¡Ñ…É•Ð¹Í•ÕÉ¥ÑåMÑ…ÑÕÌ€ôôô€Q%Yœ€˜˜€…Ñ…É•Ð¹ÍÕÍÁ•¹‘•¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfb·bÏbŸb ƒbëf+bÄƒff#ff#fƒbf ƒfff+fGb¼ƒbfff+f/bœ¸œ¤ì(€€€€€ô(€€€€€Ñ…É•Ð¹Í•ÕÉ¥ÑåMÑ…ÑÕÌ€ô€Q%Yœì(€€€€€Ñ…É•Ð¹…Ñ¥Ù•M•ÉÙ¥”€ô™…±Í”ì(€€€€€Ñ…É•Ð¹ÍÕÍÁ•¹‘•€ô™…±Í”ì(€€€€€Ñ…É•Ð¹ÍÕÍÁ•¹Í¥½¹I•…Í½¸€ô€œœì(€€€€€Ñ…É•Ð¹ÍÑ…ÑÕÌ€ô€Ÿb»bŸbÇb°ƒbŸfb»b¿fb¤œì(€€€€€½¹ÍÐ¥¹¥‘•¹Ð€ôÉ•½É‘M•ÕÉ¥ÑåÙ•¹Ð¡ì(€€€€€€€…Ñ½È°(€€€€€€€Ñ…É•Ð°(€€€€€€€…Ñ¥½¸è€55	I}IMQ=Iœ°(€€€€€€€ÑåÁ”è€59U1}IY%\œ°(€€€€€€€±•Ù•°è€Ä°(€€€€€€€É•…Í½¸è€IMQ=I}	e}%}!%œ°(€€€€€€€ÍÑ…ÑÕÌè€IMQ=Iœ(€€€€€ô¤ì(€€€€€…Ý…¥Ð¹½Ñ¥™åM•ÕÉ¥Ñå1•…‘•ÉÍ¡¥À¡¥¹¥‘•¹Ð¤ì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€•µ¥ÑMÑ…Ñ” ¤ì(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô½¬¡ˆ°ì…Ñ¥½¸è€É•…Ñ¥Ù…Ñ”œ°ÕÍ•ÈèÁÕ‰±¥UÍ•È¡Ñ…É•Ð°…Ñ½È¤ô¤ì(€€€€€Í½­•Ð¹•µ¥Ð …‘µ¥¸éµ•µ‰•ÈéÉ•ÍÕ±Ðœ°É•ÍÕ±Ð¤ì(€€€€€É•ÑÕÉ¸É•ÍÕ±Ðì(€€€ô¤ì((€€€Í½­•Ð¹½¸ …‘µ¥¸é­¥­5•µ‰•Èœ°…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•ÕÑ¡•¹Ñ¥…Ñ•‘UÍ•È¡Í½­•Ð¤ì(€€€€€½¹ÍÐÑ…É•Ð€ô•ÑUÍ•É	å%¡±•…¸¡Á…å±½…ü¹µ•µ‰•É%ñðÁ…å±½…ü¹ÕÍ•É%°€ÄÈÀ¤¤ì(€€€€€½¹ÍÐÉ•…Í½¸€ôÉ•‘…ÑM•ÕÉ¥ÑåI•…Í½¸¡Á…å±½…ü¹É•…Í½¸¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#fƒb—ff$ƒbŸfb·bÏbŸb ƒbf#fbŸf,¸œ¤ì(€€€€€¥˜€ …Ñ…É•Ð¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfbÓb»b×f+b¤ƒbëf+bÄƒff#b³f#b¿b¤¸œ¤ì(€€€€€¥˜€ ……¹5…¹…•5•µ‰•È¡…Ñ½È°Ñ…É•Ð¤¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿfbœƒb«fffƒb×fbŸb·f+b¤ƒfb×fƒfbÃfƒbŸfbÓb»b×f+b¤¸œ¤ì(€€€€€¥˜€ …É•…Í½¸¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbÏb£b ƒbŸffb×fƒb—fbËbŸff(¸œ¤ì(€€€€€Ñ…É•Ð¹…Ñ¥Ù•M•ÉÙ¥”€ô™…±Í”ì(€€€€€Ñ…É•Ð¹ÍÕÍÁ•¹‘•€ôÑÉÕ”ì(€€€€€Ñ…É•Ð¹Í•ÕÉ¥ÑåMÑ…ÑÕÌ€ô€MUMA9œì(€€€€€Ñ…É•Ð¹ÍÕÍÁ•¹Í¥½¹I•…Í½¸€ôÉ•…Í½¸ì(€€€€€Ñ…É•Ð¹½¹±¥¹”€ô™…±Í”ì(€€€€€Ñ…É•Ð¹ÍÑ…ÑÕÌ€ô€Ÿffb×f#fœì(€€€€€™½È€¡½¹ÍÐÍ½­•Ñ%½˜Í•ÍÍ¥½¹Ì¹•Ð¡Ñ…É•Ð¹¥¤ñðmt¤ì(€€€€€€€½¹ÍÐÑ…É•ÑM½­•Ð€ô¥¼¹Í½­•ÑÌ¹Í½­•ÑÌ¹•Ð¡Í½­•Ñ%¤ì(€€€€€€€¥˜€¡Ñ…É•ÑM½­•Ð¤ì(€€€€€€€€€Ñ…É•ÑM½­•Ð¹•µ¥Ð µ•µ‰•Èé­¥­•œ°ìµ•ÍÍ…”è€Ÿb«fƒfb×fƒbŸfbÓb»b×f+b¤ƒffƒbŸfb»b¿fb¤¸œ°É•…Í½¸ô¤ì(€€€€€€€ô(€€€€€ô(€€€€€…‘‘Õ‘¥Ñ1½œ Ÿfb×fƒffƒbŸfb»b¿fb¤œ°…Ñ½È°Ñ…É•Ð°ƒbÏb£b ƒbŸffb×fè€‘íÉ•‘…ÑM•ÕÉ¥ÑåI•…Í½¸¡É•…Í½¸¥õ€¤ì(€€€€€½¹ÍÐ¥¹¥‘•¹Ð€ôÉ•½É‘M•ÕÉ¥ÑåÙ•¹Ð¡ì(€€€€€€€…Ñ½È°(€€€€€€€Ñ…É•Ð°(€€€€€€€…Ñ¥½¸è€55	I}MUMA9œ°(€€€€€€€ÑåÁ”è€5%9%MQIQ%Y}MUMA9M%=8œ°(€€€€€€€±•Ù•°è€È°(€€€€€€€É•…Í½¸°(€€€€€€€ÍÑ…ÑÕÌè€MUMA9œ(€€€€€ô¤ì(€€€€€…Ý…¥Ð¹½Ñ¥™åM•ÕÉ¥Ñå1•…‘•ÉÍ¡¥À¡¥¹¥‘•¹Ð¤ì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€•µ¥ÑMÑ…Ñ” ¤ì(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô½¬¡ˆ°ì…Ñ¥½¸è€­¥¬œ°ÕÍ•ÈèÁÕ‰±¥UÍ•È¡Ñ…É•Ð°…Ñ½È¤ô¤ì(€€€€€Í½­•Ð¹•µ¥Ð …‘µ¥¸éµ•µ‰•ÈéÉ•ÍÕ±Ðœ°É•ÍÕ±Ð¤ì(€€€€€É•ÑÕÉ¸É•ÍÕ±Ðì(€€€ô¤ì((€€€Í½­•Ð¹½¸ …‘µ¥¸é­¥­UÍ•Èœ°…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•ÕÑ¡•¹Ñ¥…Ñ•‘UÍ•È¡Í½­•Ð¤ì(€€€€€½¹ÍÐÑ…É•Ð€ô•ÑUÍ•É	å%¡±•…¸¡Á…å±½…ü¹ÕÍ•É%ñðÁ…å±½…ü¹µ•µ‰•É%°€ÄÈÀ¤¤ì(€€€€€½¹ÍÐÉ•…Í½¸€ôÉ•‘…ÑM•ÕÉ¥ÑåI•…Í½¸¡Á…å±½…ü¹É•…Í½¸¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#fƒb—ff$ƒbŸfb·bÏbŸb ƒbf#fbŸf,¸œ¤ì(€€€€€¥˜€ …Ñ…É•Ð¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfbÓb»b×f+b¤ƒbëf+bÄƒff#b³f#b¿b¤¸œ¤ì(€€€€€¥˜€ ……¹5…¹…•5•µ‰•È¡…Ñ½È°Ñ…É•Ð¤¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿfbœƒb«fffƒb×fbŸb·f+b¤ƒfb×fƒfbÃfƒbŸfbÓb»b×f+b¤¸œ¤ì(€€€€€¥˜€ …É•…Í½¸¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbÏb£b ƒbŸffb×fƒb—fbËbŸff(¸œ¤ì(€€€€€Ñ…É•Ð¹…Ñ¥Ù•M•ÉÙ¥”€ô™…±Í”ì(€€€€€Ñ…É•Ð¹ÍÕÍÁ•¹‘•€ôÑÉÕ”ì(€€€€€Ñ…É•Ð¹Í•ÕÉ¥ÑåMÑ…ÑÕÌ€ô€MUMA9œì(€€€€€Ñ…É•Ð¹ÍÕÍÁ•¹Í¥½¹I•…Í½¸€ôÉ•…Í½¸ì(€€€€€Ñ…É•Ð¹½¹±¥¹”€ô™…±Í”ì(€€€€€Ñ…É•Ð¹ÍÑ…ÑÕÌ€ô€Ÿffb×f#fœì(€€€€€™½È€¡½¹ÍÐÍ½­•Ñ%½˜Í•ÍÍ¥½¹Ì¹•Ð¡Ñ…É•Ð¹¥¤ñðmt¤ì(€€€€€€€½¹ÍÐÑ…É•ÑM½­•Ð€ô¥¼¹Í½­•ÑÌ¹Í½­•ÑÌ¹•Ð¡Í½­•Ñ%¤ì(€€€€€€€¥˜€¡Ñ…É•ÑM½­•Ð¤ì(€€€€€€€€€Ñ…É•ÑM½­•Ð¹•µ¥Ð µ•µ‰•Èé­¥­•œ°ìµ•ÍÍ…”è€Ÿb«fƒfb×fƒbŸfbÓb»b×f+b¤ƒffƒbŸfb»b¿fb¤¸œ°É•…Í½¸ô¤ì(€€€€€€€ô(€€€€€ô(€€€€€…‘‘Õ‘¥Ñ1½œ Ÿfb×fƒffƒbŸfb»b¿fb¤œ°…Ñ½È°Ñ…É•Ð°ƒbÏb£b ƒbŸffb×fè€‘íÉ•‘…ÑM•ÕÉ¥ÑåI•…Í½¸¡É•…Í½¸¥õ€¤ì(€€€€€½¹ÍÐ¥¹¥‘•¹Ð€ôÉ•½É‘M•ÕÉ¥ÑåÙ•¹Ð¡ì(€€€€€€€…Ñ½È°(€€€€€€€Ñ…É•Ð°(€€€€€€€…Ñ¥½¸è€55	I}MUMA9œ°(€€€€€€€ÑåÁ”è€5%9%MQIQ%Y}MUMA9M%=8œ°(€€€€€€€±•Ù•°è€È°(€€€€€€€É•…Í½¸°(€€€€€€€ÍÑ…ÑÕÌè€MUMA9œ(€€€€€ô¤ì(€€€€€…Ý…¥Ð¹½Ñ¥™åM•ÕÉ¥Ñå1•…‘•ÉÍ¡¥À¡¥¹¥‘•¹Ð¤ì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€•µ¥ÑMÑ…Ñ” ¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ì…Ñ¥½¸è€­¥¬œ°ÕÍ•ÈèÁÕ‰±¥UÍ•È¡Ñ…É•Ð°…Ñ½È¤ô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ É…‘¥¼éÑ•áÐœ°…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#f¸œ¤ì(€€€€€½¹ÍÐ¡…¹¹•°€ô±•…¸¡Á…å±½…ü¹¡…¹¹•°ñð…Ñ½È¹É…‘¥½¡…¹¹•°ñð€ ´Äœ°€ÔÀ¤ì(€€€€€½¹ÍÐÑ•áÐ€ô±•…¸¡Á…å±½…ü¹Ñ•áÐñðÁ…å±½…ü¹µ•ÍÍ…”°€ÈÀÀÀ¤ì(€€€€€¥˜€ …Ñ•áÐ¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfbÇbÏbŸfb¤ƒfbŸbÇbëb¤¸œ¤ì(€€€€€¥˜€¡…Ý…¥Ðµ½‘•É…Ñ•=ÕÑ½¥¹Q•áÐ¡…Ñ½È°Ñ•áÐ°€I%<œ¤¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«fƒb·bãbÄƒbŸfbÇbÏbŸfb¤ƒb£f#bŸbÏbßb¤ƒfbÇfbÈƒbŸfbff¸œ¤ì(€€€€€ô(€€€€€½¹ÍÐÁ…­•Ð€ôì(€€€€€€€¥èµ…­•% I%<œ¤°(€€€€€€€¡…¹¹•°°(€€€€€€€ÕÍ•É½‘”è…Ñ½È¹ÁÕ‰±¥½‘”°(€€€€€€€™É½µ½‘”è…Ñ½È¹ÁÕ‰±¥½‘”°(€€€€€€€™É½µI…¹¬èÉ…¹­1…‰•°¡…Ñ½È¹É…¹¬¤°(€€€€€€€Ñ•áÐ°(€€€€€€€…Ðè¹½Ü ¤(€€€€€ôì(€€€€€•µ¥ÑI…‘¥½Q½¡…¹¹•°¡¡…¹¹•°°€É…‘¥¼éÑ•áÐœ°Á…­•Ð¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ìµ•ÍÍ…”èÁ…­•Ðô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ É…‘¥¼é½‘”œ°…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#f¸œ¤ì(€€€€€½¹ÍÐ¡…¹¹•°€ô±•…¸¡Á…å±½…ü¹¡…¹¹•°ñð…Ñ½È¹É…‘¥½¡…¹¹•°ñð€ ´Äœ°€ÔÀ¤ì(€€€€€½¹ÍÐÁ…­•Ð€ôì(€€€€€€€¡…¹¹•°°(€€€€€€€ÕÍ•É½‘”è…Ñ½È¹ÁÕ‰±¥½‘”°(€€€€€€€ÕÍ•É9…µ”è…Ñ½È¹¹…µ”°(€€€€€€€½‘”è±•…¸¡Á…å±½…ü¹½‘”°€ÔÀ¤°(€€€€€€€µ•…¹¥¹œè±•…¸¡Á…å±½…ü¹µ•…¹¥¹œ°€ÈÀÀ¤(€€€€€ôì(€€€€€¥˜€ …Á…­•Ð¹½‘”¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿff#b¼ƒbŸfbÇbŸb¿f+f ƒbëf+bÄƒff#b³f#b¼¸œ¤ì(€€€€€¥˜€¡…Ý…¥Ðµ½‘•É…Ñ•=ÕÑ½¥¹Q•áÐ¡…Ñ½È°€‘íÁ…­•Ð¹½‘•ô€‘íÁ…­•Ð¹µ•…¹¥¹õ€°€I%=}=œ¤¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«fƒb·bãbÄƒff#b¼ƒbŸfbÇbŸb¿f+f ƒb£f#bŸbÏbßb¤ƒfbÇfbÈƒbŸfbff¸œ¤ì(€€€€€ô(€€€€€•µ¥ÑI…‘¥½Q½¡…¹¹•°¡¡…¹¹•°°€É…‘¥¼é½‘”œ°Á…­•Ð¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ìµ•ÍÍ…”èÁ…­•Ðô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ É…‘¥¼éÁÑÐéÍÑ…ÉÐœ°€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#f¸œ¤ì(€€€€€½¹ÍÐ¡…¹¹•°€ô±•…¸¡Á…å±½…ü¹¡…¹¹•°ñð…Ñ½È¹É…‘¥½¡…¹¹•°ñð€ ´Äœ°€ÔÀ¤ì(€€€€€•µ¥ÑI…‘¥½Q½¡…¹¹•°¡¡…¹¹•°°€É…‘¥¼éÍÑ…Ñ”œ°ì(€€€€€€€¡…¹¹•°°ÕÍ•É½‘”è…Ñ½È¹ÁÕ‰±¥½‘”°ÁÑÐèÑÉÕ”°(€€€€€€€ÍÑ…ÑÕÍ!Ñµ°è€Ÿb³bŸbÇf(ƒbŸfb£b¬ƒbŸfb×f#b«f(¸¸¸œ(€€€€€ô¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ É…‘¥¼éÁÑÐéÍÑ½Àœ°€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#f¸œ¤ì(€€€€€½¹ÍÐ¡…¹¹•°€ô±•…¸¡Á…å±½…ü¹¡…¹¹•°ñð…Ñ½È¹É…‘¥½¡…¹¹•°ñð€ ´Äœ°€ÔÀ¤ì(€€€€€•µ¥ÑI…‘¥½Q½¡…¹¹•°¡¡…¹¹•°°€É…‘¥¼éÍÑ…Ñ”œ°ì(€€€€€€€¡…¹¹•°°ÕÍ•É½‘”è…Ñ½È¹ÁÕ‰±¥½‘”°ÁÑÐè™…±Í”°(€€€€€€€ÍÑ…ÑÕÍ!Ñµ°è€ŸbŸfb«ff$ƒbŸfb£b¬¸œ(€€€€€ô¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ É•Á½ÉÐé‘•±•Ñ”œ°€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#f¸œ¤ì(€€€€€¥˜€ …¥Í1•…‘•ÉÍ¡¥À¡…Ñ½È¤¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿb·bÃfƒbŸfb«fbŸbÇf+bÄƒfb«bŸb´ƒffff+bŸb¿b¤ƒffbÜ¸œ¤ì(€€€€€½¹ÍÐ¥€ô±•…¸¡Á…å±½…ü¹¥ñðÁ…å±½…ü¹É•Á½ÉÑ%°€ÈÀÀ¤ì(€€€€€½¹ÍÐ•á¥ÍÑÌ€ôÍÑ…Ñ”¹¥…}É•Á½ÉÑÌ¹Í½µ” ¡É•Á½ÉÐ¤€ôøMÑÉ¥¹œ¡É•Á½ÉÐ¹¥¤€ôôôMÑÉ¥¹œ¡¥¤¤ì(€€€€€¥˜€ …•á¥ÍÑÌ¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfb«fbÇf+bÄƒbëf+bÄƒff#b³f#b¼¸œ¤ì(€€€€€ÍÑ…Ñ”¹¥…}É•Á½ÉÑÌ€ôÍÑ…Ñ”¹¥…}É•Á½ÉÑÌ¹™¥±Ñ•È ¡É•Á½ÉÐ¤€ôøMÑÉ¥¹œ¡É•Á½ÉÐ¹¥¤€„ôôMÑÉ¥¹œ¡¥¤¤ì(€€€€€…‘‘Õ‘¥Ñ1½œ Ÿb·bÃfƒb«fbÇf+bÄœ°…Ñ½È°¹Õ±°°ƒb«fƒb·bÃfƒbŸfb«fbÇf+bÄ€‘í¥‘ô¹€¤ì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€•µ¥ÑMÑ…Ñ” ¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ì¥ô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ ‘ÕÑäéÍÑ…ÉÐœ°€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•ÕÑ¡•¹Ñ¥…Ñ•‘UÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#f¸œ¤ì(€€€€€¥˜€¡…Ñ½È¹Í•ÉÙ¥•ÁÁÉ½Ù•€„ôôÑÉÕ”¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+fbËfƒfb£f#fƒbŸfbÓb»b×f+b¤ƒf#bŸbçb«fbŸb¼ƒbŸfff#f+b¤ƒf#bßfb ƒb¿b»f#fƒbŸfb»b¿fb¤ƒfb£fƒfb£bŸbÓbÇb¤ƒbŸfb»b¿fb¤¸œ¤ì(€€€€€ô(€€€€€¥˜€ ……Ñ½È¹ÁÕ‰±¥½‘”€˜˜€…¥Í1•…‘•ÉÍ¡¥À¡…Ñ½È¤¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿffƒf+b×b¿bÄƒbŸfff#b¼ƒbŸfbçbÏfbÇf(ƒb£bçb¿blƒbŸbßfb ƒff%!%ƒb—ffbŸfƒbŸbçb«fbŸb¼ƒb¿b»f#fƒbŸfb»b¿fb¤¸œ¤ì(€€€€€ô(€€€€€¥˜€¡…Ñ½È¹…Ñ¥Ù•M•ÉÙ¥”€ôôôÑÉÕ”¤ì(€€€€€€€É•ÑÕÉ¸½¬¡ˆ°ì…ÑÑ•¹‘…¹”è¹Õ±°°ÕÍ•ÈèÁÕ‰±¥UÍ•È¡…Ñ½È°…Ñ½È¤ô¤ì(€€€€€ô(€€€€€½¹ÍÐ‘…å-•ä€ô¹½Ü ¤¹Í±¥” À°€ÄÀ¤ì(€€€€€½¹ÍÐÕÉÉ•¹Ð€ô€¡ÍÑ…Ñ”¹¥…}…ÑÑ•¹‘…¹”ñðmt¤¹™¥¹ (€€€€€€€€¡¥Ñ•´¤€ôø¥Ñ•´¹ÕÍ•É%€ôôô…Ñ½È¹¥€˜˜¥Ñ•´¹‘…å-•ä€ôôô‘…å-•ä€˜˜€…¥Ñ•´¹•¹‘•‘Ð(€€€€€€¤ì(€€€€€¥˜€¡ÕÉÉ•¹Ð¤É•ÑÕÉ¸½¬¡ˆ°ì…ÑÑ•¹‘…¹”èÕÉÉ•¹Ðô¤ì(€€€€€½¹ÍÐ…ÑÑ•¹‘…¹”€ôì(€€€€€€€¥èµ…­•% UQdœ¤°(€€€€€€€ÕÍ•É%è…Ñ½È¹¥°(€€€€€€€ÕÍ•É½‘”è…Ñ½È¹ÁÕ‰±¥½‘”°(€€€€€€€ÕÍ•É9…µ”è…Ñ½È¹¹…µ”°(€€€€€€€‘…å-•ä°(€€€€€€€ÍÑ…ÉÑ•‘Ðè¹½Ü ¤°(€€€€€€€•¹‘•‘Ðè¹Õ±°°(€€€€€€€Í…±…ÉåA…¥è™…±Í”(€€€€€ôì(€€€€€ÍÑ…Ñ”¹¥…}…ÑÑ•¹‘…¹”¹Õ¹Í¡¥™Ð¡…ÑÑ•¹‘…¹”¤ì(€€€€€…Ñ½È¹…Ñ¥Ù•M•ÉÙ¥”€ôÑÉÕ”ì(€€€€€…Ñ½È¹½¹±¥¹”€ôÑÉÕ”ì(€€€€€…Ñ½È¹ÍÑ…ÑÕÌ€ô€Ÿff(ƒbŸfb»b¿fb¤œì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€•µ¥ÑMÑ…Ñ” ¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ì…ÑÑ•¹‘…¹”°ÕÍ•ÈèÁÕ‰±¥UÍ•È¡…Ñ½È°…Ñ½È¤ô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ ‘ÕÑäé•¹œ°€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•ÕÑ¡•¹Ñ¥…Ñ•‘UÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#f¸œ¤ì(€€€€€½¹ÍÐÕÉÉ•¹Ð€ô€¡ÍÑ…Ñ”¹¥…}…ÑÑ•¹‘…¹”ñðmt¤¹™¥¹ (€€€€€€€€¡¥Ñ•´¤€ôø¥Ñ•´¹ÕÍ•É%€ôôô…Ñ½È¹¥€˜˜€…¥Ñ•´¹•¹‘•‘Ð(€€€€€€¤ì(€€€€€¥˜€¡ÕÉÉ•¹Ð¤ÕÉÉ•¹Ð¹•¹‘•‘Ð€ô¹½Ü ¤ì(€€€€€É•µ½Ù•I…‘¥½5•µ‰•È¡Í½­•Ð¹¥¤ì(€€€€€…Ñ½È¹É…‘¥½=¹±¥¹”€ô™…±Í”ì(€€€€€…Ñ½È¹…Ñ¥Ù•M•ÉÙ¥”€ô™…±Í”ì(€€€€€…Ñ½È¹ÍÑ…ÑÕÌ€ô€Ÿb»bŸbÇb°ƒbŸfb»b¿fb¤œì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€•µ¥ÑMÑ…Ñ” ¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ì…ÑÑ•¹‘…¹”èÕÉÉ•¹Ð°ÕÍ•ÈèÁÕ‰±¥UÍ•È¡…Ñ½È°…Ñ½È¤ô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ ½Á•É…Ñ¥½¸éÕÁ‘…Ñ•MÑ…ÑÕÌœ°…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°Í½­•ÑI•ÅÕ¥É•µ•¹Ñ5•ÍÍ…”¡Í½­•Ð¤¤ì(€€€€€½¹ÍÐ¥€ô±•…¸¡Á…å±½…ü¹½Á•É…Ñ¥½¹%ñðÁ…å±½…ü¹¥°€ÈÀÀ¤ì(€€€€€½¹ÍÐ½Á•É…Ñ¥½¸€ôÍÑ…Ñ”¹¥…}½Á•É…Ñ¥½¹Ì¹™¥¹ ¡¥Ñ•´¤€ôøMÑÉ¥¹œ¡¥Ñ•´¹¥¤€ôôôMÑÉ¥¹œ¡¥¤¤ì(€€€€€¥˜€ …½Á•É…Ñ¥½¸¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸffffb¤ƒbëf+bÄƒff#b³f#b¿b¤¸œ¤ì(€€€€€¥˜€ ……¹5…¹…•=Á•É…Ñ¥½¹Ì¡…Ñ½È¤¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«b·b¿f+b¬ƒbŸffffb¤ƒfb«bŸb´ƒffbÇb«b ƒbŸfbçff+bœƒbŸfb¯fbŸb¬ƒffbÜ¸œ¤ì(€€€€€ô(€€€€€½¹ÍÐÁÉ•Ù¥½ÕÍMÑ…ÑÕÌ€ô½Á•É…Ñ¥½¸¹ÍÑ…ÑÕÌì(€€€€€½Á•É…Ñ¥½¸¹ÍÑ…ÑÕÌ€ô±•…¸¡Á…å±½…ü¹ÍÑ…ÑÕÌ°€ÄÀÀ¤ñð½Á•É…Ñ¥½¸¹ÍÑ…ÑÕÌì(€€€€€…‘‘=Á•É…Ñ¥½¹MÑ…ÑÕÍ!¥ÍÑ½Éä¡½Á•É…Ñ¥½¸°…Ñ½È°ÁÉ•Ù¥½ÕÍMÑ…ÑÕÌ¤ì(€€€€€½Á•É…Ñ¥½¸¹ÕÁ‘…Ñ•‘Ð€ô¹½Ü ¤ì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€…Ý…¥ÐÁÕ‰±¥Í¡9½Ñ¥™¥…Ñ¥½¹Ì¡ÍÑ…Ñ”¹¥…}ÕÍ•ÉÌ°ì(€€€€€€€ÑåÁ”è€=AIQ%=8œ°(€€€€€€€Ñ¥Ñ±”è€=AIQ%=8MQQUL!9œ°(€€€€€€€µ•ÍÍ…”èƒb«bëf+bÇb¨ƒb·bŸfb¤ƒbŸfbçfff+b¤€‘í½Á•É…Ñ¥½¸¹µ¥ÍÍ¥½¹9Õµ‰•Éôè€‘íÁÉ•Ù¥½ÕÍMÑ…ÑÕÍôƒŠ@€‘í½Á•É…Ñ¥½¸¹ÍÑ…ÑÕÍô¹€°(€€€€€€€ÁÉ¥½É¥Ñäè½Á•É…Ñ¥½¸¹É¥Í¬€ôôô€!% œñð½Á•É…Ñ¥½¸¹É¥Í¬€ôôô€I%Q%0œ€ü€!% œ€è€9=Q%œ°(€€€€€€€Í½ÕÉ•UÍ•É%è…Ñ½È¹¥°(€€€€€€€É•±…Ñ•‘%è½Á•É…Ñ¥½¸¹¥°(€€€€€€€µ•µ‰•É½‘•Ìè½Á•É…Ñ¥½¸¹µ•µ‰•É½‘•Ì°(€€€€€€€µ•Ñ…‘…Ñ„èìµ¥ÍÍ¥½¹9Õµ‰•Èè½Á•É…Ñ¥½¸¹µ¥ÍÍ¥½¹9Õµ‰•È°ÍÑ…ÑÕÌè½Á•É…Ñ¥½¸¹ÍÑ…ÑÕÌ°É¥Í¬è½Á•É…Ñ¥½¸¹É¥Í¬ô(€€€€€ô¤ì(€€€€€•µ¥Ñ=Á•É…Ñ¥½¹MÑ…Ñ” ¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ì½Á•É…Ñ¥½¸è½Á•É…Ñ¥½¹M…¹¥Ñ¥é”¡½Á•É…Ñ¥½¸°…Ñ½È¤ô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ ¡…ÐéÍ•¹œ°…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#f¸œ¤ì(€€€€€½¹ÍÐµ½‘”€ôÁ…å±½…ü¹µ½‘”€ôôô€ÁÉ¥Ù…Ñ”œ€ü€ÁÉ¥Ù…Ñ”œ€è€±½‰…°œì(€€€€€½¹ÍÐÑ•áÐ€ô±•…¸¡Á…å±½…ü¹Ñ•áÐñðÁ…å±½…ü¹µ•ÍÍ…”°€ÐÀÀÀ¤ì(€€€€€½¹ÍÐ¥µ…”€ô±•…¸¡Á…å±½…ü¹¥µ…”°€à€¨€ÄÀÈÐ€¨€ÄÀÈÐ¤ì(€€€€€¥˜€ …Ñ•áÐ€˜˜€…¥µ…”¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfbÇbÏbŸfb¤ƒfbŸbÇbëb¤¸œ¤ì(€€€€€¥˜€¡Ñ•áÐ€˜˜…Ý…¥Ðµ½‘•É…Ñ•=ÕÑ½¥¹Q•áÐ¡…Ñ½È°Ñ•áÐ°µ½‘”€ôôô€ÁÉ¥Ù…Ñ”œ€ü€AI%YQ}!Pœ€è€!Pœ¤¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«fƒb·bãbÄƒbŸfbÇbÏbŸfb¤ƒb£f#bŸbÏbßb¤ƒfbÇfbÈƒbŸfbff¸œ¤ì(€€€€€ô((€€€€€½¹ÍÐµ•ÍÍ…”€ôì(€€€€€€€¥èµ…­•%¡µ½‘”€ôôô€ÁÉ¥Ù…Ñ”œ€ü€A!Pœ€è€!Pœ¤°(€€€€€€€Í•¹‘•É½‘”è…Ñ½È¹ÁÕ‰±¥½‘”°(€€€€€€€Í•¹‘•É9…µ”è…Ñ½È¹¹…µ”°(€€€€€€€™É½µ½‘”è…Ñ½È¹ÁÕ‰±¥½‘”°(€€€€€€€™É½µ9…µ”è…Ñ½È¹¹…µ”°(€€€€€€€Ñ…É•Ñ½‘”è±•…¸¡Á…å±½…ü¹Ñ…É•Ñ½‘”°€ÄÀÀ¤°(€€€€€€€Ñ•áÐ°(€€€€€€€¥µ…”°(€€€€€€€Ñ¥µ•ÍÑ…µÀè¹½Ü ¤°(€€€€€€€…Ðè¹½Ü ¤(€€€€€ôì(€€€€€±•ÐÁÉ¥Ù…Ñ•I•¥Á¥•¹Ð€ô¹Õ±°ì(€€€€€¥˜€¡µ½‘”€ôôô€ÁÉ¥Ù…Ñ”œ¤ì(€€€€€€€½¹ÍÐÑ…É•Ð€ô•ÑUÍ•É	åAÕ‰±¥½‘”¡µ•ÍÍ…”¹Ñ…É•Ñ½‘”¤ì(€€€€€€€¥˜€ …Ñ…É•Ð¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸffbÏb«b»b¿fƒbŸffbÏb«fb¿fƒbëf+bÄƒff#b³f#b¼¸œ¤ì(€€€€€€€ÁÉ¥Ù…Ñ•I•¥Á¥•¹Ð€ôÑ…É•Ðì(€€€€€€€½¹ÍÐ­•ä€ô¡…Ñ-•ä¡…Ñ½È¹ÁÕ‰±¥½‘”°Ñ…É•Ð¹ÁÕ‰±¥½‘”¤ì(€€€€€€€ÍÑ…Ñ”¹¥…}¡…ÑÌ¹ÁÉ¥Ù…Ñ•m­•åt€ôÍÑ…Ñ”¹¥…}¡…ÑÌ¹ÁÉ¥Ù…Ñ•m­•åtñðmtì(€€€€€€€ÍÑ…Ñ”¹¥…}¡…ÑÌ¹ÁÉ¥Ù…Ñ•m­•åt¹ÁÕÍ ¡µ•ÍÍ…”¤ì(€€€€€€€ÍÑ…Ñ”¹¥…}¡…ÑÌ¹ÁÉ¥Ù…Ñ•m­•åt€ôÍÑ…Ñ”¹¥…}¡…ÑÌ¹ÁÉ¥Ù…Ñ•m­•åt¹Í±¥” ´ÔÀÀ¤ì(€€€€€€€½¹ÍÐÑ…É•ÑÌ€ô¹•ÜM•Ð¡l¸¸¸¡Í•ÍÍ¥½¹Ì¹•Ð¡…Ñ½È¹¥¤ñðmt¤°€¸¸¸¡Í•ÍÍ¥½¹Ì¹•Ð¡Ñ…É•Ð¹¥¤ñðmt¥t¤ì(€€€€€€€™½È€¡½¹ÍÐÍ½­•Ñ%½˜Ñ…É•ÑÌ¤ì(€€€€€€€€€½¹ÍÐÑ…É•ÑM½­•Ð€ô¥¼¹Í½­•ÑÌ¹Í½­•ÑÌ¹•Ð¡Í½­•Ñ%¤ì(€€€€€€€€€¥˜€¡Ñ…É•ÑM½­•Ð¤Ñ…É•ÑM½­•Ð¹•µ¥Ð ¡…ÐéÁÉ¥Ù…Ñ”œ°µ•ÍÍ…”¤ì(€€€€€€€ô(€€€€€ô•±Í”ì(€€€€€€€ÍÑ…Ñ”¹¥…}¡…ÑÌ¹±½‰…°¹ÁÕÍ ¡µ•ÍÍ…”¤ì(€€€€€€€ÍÑ…Ñ”¹¥…}¡…ÑÌ¹±½‰…°€ôÍÑ…Ñ”¹¥…}¡…ÑÌ¹±½‰…°¹Í±¥” ´ÄÀÀÀ¤ì(€€€€€€€¥¼¹•µ¥Ð ¡…Ðé±½‰…°œ°µ•ÍÍ…”¤ì(€€€€€ô(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€¥˜€¡ÁÉ¥Ù…Ñ•I•¥Á¥•¹Ð€˜˜ÁÉ¥Ù…Ñ•I•¥Á¥•¹Ð¹¥€„ôô…Ñ½È¹¥¤ì(€€€€€€€…Ý…¥ÐÁÕ‰±¥Í¡9½Ñ¥™¥…Ñ¥½¹Ì¡mÁÉ¥Ù…Ñ•I•¥Á¥•¹Ñt°ì(€€€€€€€€€ÑåÁ”è€5MMœ°(€€€€€€€€€Ñ¥Ñ±”è€9\5MMœ°(€€€€€€€€€µ•ÍÍ…”èƒf#b×fb«fƒbÇbÏbŸfb¤ƒb»bŸb×b¤ƒff€‘í…Ñ½È¹ÁÕ‰±¥½‘”ñð€•¹Ðô¹€°(€€€€€€€€€ÁÉ¥½É¥Ñäè€9=Q%œ°(€€€€€€€€€Í½ÕÉ•UÍ•É%è…Ñ½È¹¥°(€€€€€€€€€Ñ…É•ÑUÍ•É%èÁÉ¥Ù…Ñ•I•¥Á¥•¹Ð¹¥°(€€€€€€€€€Í½ÕÉ•9…µ•Y¥Í¥‰±”èÑÉÕ”°(€€€€€€€€€É•±…Ñ•‘%èµ•ÍÍ…”¹¥°(€€€€€€€€€µ•Ñ…‘…Ñ„èìÍ•¹‘•É½‘”è…Ñ½È¹ÁÕ‰±¥½‘”ô(€€€€€€€ô¤ì(€€€€€ô(€€€€€•µ¥ÑMÑ…Ñ” ¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ìµ•ÍÍ…”ô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ ¡…Ðé‘•±•Ñ”œ°€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½È¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿf+b³b ƒb«bÏb³f+fƒbŸfb¿b»f#f¸œ¤ì(€€€€€½¹ÍÐµ•ÍÍ…•%€ô±•…¸¡Á…å±½…ü¹µ•ÍÍ…•%ñðÁ…å±½…ü¹¥°€ÈÀÀ¤ì(€€€€€½¹ÍÐ…‘µ¥¸€ôÁ…å±½…ü¹…‘µ¥¸€ôôôÑÉÕ”ì(€€€€€¥˜€¡…‘µ¥¸€˜˜€…¥Í1•…‘•ÉÍ¡¥À¡…Ñ½È¤¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿfbœƒb«fffƒb×fbŸb·f+b¤ƒbŸfb·bÃfƒbŸfb—b¿bŸbÇf(¸œ¤ì(€€€€€±•ÐÉ•µ½Ù•€ô™…±Í”ì(€€€€€¥˜€¡Á…å±½…ü¹µ½‘”€ôôô€ÁÉ¥Ù…Ñ”œ¤ì(€€€€€€€™½È€¡½¹ÍÐ­•ä½˜=‰©•Ð¹­•åÌ¡ÍÑ…Ñ”¹¥…}¡…ÑÌ¹ÁÉ¥Ù…Ñ”ñðíô¤¤ì(€€€€€€€€€½¹ÍÐ‰•™½É”€ôÍÑ…Ñ”¹¥…}¡…ÑÌ¹ÁÉ¥Ù…Ñ•m­•åt¹±•¹Ñ ì(€€€€€€€€€ÍÑ…Ñ”¹¥…}¡…ÑÌ¹ÁÉ¥Ù…Ñ•m­•åt€ôÍÑ…Ñ”¹¥…}¡…ÑÌ¹ÁÉ¥Ù…Ñ•m­•åt¹™¥±Ñ•È (€€€€€€€€€€€€¡µ•ÍÍ…”¤€ôøMÑÉ¥¹œ¡µ•ÍÍ…”¹¥¤€„ôôMÑÉ¥¹œ¡µ•ÍÍ…•%¤ñð(€€€€€€€€€€€€€€ ……‘µ¥¸€˜˜µ•ÍÍ…”¹Í•¹‘•É½‘”€„ôô…Ñ½È¹ÁÕ‰±¥½‘”¤(€€€€€€€€€€¤ì(€€€€€€€€€É•µ½Ù•€ôÉ•µ½Ù•ñð‰•™½É”€„ôôÍÑ…Ñ”¹¥…}¡…ÑÌ¹ÁÉ¥Ù…Ñ•m­•åt¹±•¹Ñ ì(€€€€€€€ô(€€€€€ô•±Í”ì(€€€€€€€½¹ÍÐ‰•™½É”€ôÍÑ…Ñ”¹¥…}¡…ÑÌ¹±½‰…°¹±•¹Ñ ì(€€€€€€€ÍÑ…Ñ”¹¥…}¡…ÑÌ¹±½‰…°€ôÍÑ…Ñ”¹¥…}¡…ÑÌ¹±½‰…°¹™¥±Ñ•È (€€€€€€€€€€¡µ•ÍÍ…”¤€ôøMÑÉ¥¹œ¡µ•ÍÍ…”¹¥¤€„ôôMÑÉ¥¹œ¡µ•ÍÍ…•%¤(€€€€€€€€¤ì(€€€€€€€É•µ½Ù•€ô‰•™½É”€„ôôÍÑ…Ñ”¹¥…}¡…ÑÌ¹±½‰…°¹±•¹Ñ ì(€€€€€ô(€€€€€¥˜€ …É•µ½Ù•¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfbÇbÏbŸfb¤ƒbëf+bÄƒff#b³f#b¿b¤ƒbf ƒfbœƒb«fffƒb×fbŸb·f+b¤ƒb·bÃffbœ¸œ¤ì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€•µ¥ÑMÑ…Ñ” ¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ì¥èµ•ÍÍ…•%ô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ ÍÕÁÁ½ÉÐéÍ•¹œ°…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•ÕÑ¡•¹Ñ¥…Ñ•‘UÍ•È¡Í½­•Ð¤ì(€€€€€½¹ÍÐÍ•¹‘•É9…µ”€ô…Ñ½È(€€€€€€€€ü…Ñ½È¹¹…µ”(€€€€€€€€è±•…¸¡Á…å±½…ü¹¹…µ”ñðÁ…å±½…ü¹¡…É…Ñ•É9…µ”ñð€ŸbÓb»b×f+b¤ƒbëf+bÄƒfbçb«fb¿b¤œ°€ÄÈÀ¤ì(€€€€€½¹ÍÐÑ•áÐ€ô±•…¸¡Á…å±½…ü¹Ñ•áÐñðÁ…å±½…ü¹µ•ÍÍ…”°€ÌÀÀÀ¤ì(€€€€€¥˜€ …Ñ•áÐ¤É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfb«b ƒbŸfbŸbÏb«fbÏbŸbÄƒbf#fbŸf,¸œ¤ì(€€€€€¥˜€¡…Ý…¥Ðµ½‘•É…Ñ•=ÕÑ½¥¹Q•áÐ¡…Ñ½È°Ñ•áÐ°€MUAA=IPœ¤¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«fƒb·bãbÄƒbŸfbŸbÏb«fbÏbŸbÄƒb£f#bŸbÏbßb¤ƒfbÇfbÈƒbŸfbff¸œ¤ì(€€€€€ô((€€€€€±•ÐÑ¡É•…‘%€ô±•…¸¡Á…å±½…ü¹Ñ¡É•…‘%°€ÄÈÀ¤ì(€€€€€±•Ð½Ý¹•ÉQ½­•¸€ô±•…¸¡Á…å±½…ü¹½Ý¹•ÉQ½­•¸°€ÈÀÀ¤ì(€€€€€±•Ð½É¥¥¹…°€ô¹Õ±°ì(€€€€€¥˜€¡Ñ¡É•…‘%¤ì(€€€€€€€½É¥¥¹…°€ôÍÑ…Ñ”¹¥…}ÍÕÁÁ½ÉÐ¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹Ñ¡É•…‘%€ôôôÑ¡É•…‘%€˜˜¥Ñ•´¹É•Á±ä€„ôôÑÉÕ”¤ì(€€€€€€€½¹ÍÐÍÕÁÁ±¥•‘!…Í €ô½Ý¹•ÉQ½­•¸(€€€€€€€€€€üÉåÁÑ¼¹É•…Ñ•!…Í  Í¡„ÈÔØœ¤¹ÕÁ‘…Ñ”¡½Ý¹•ÉQ½­•¸¤¹‘¥•ÍÐ ¡•àœ¤(€€€€€€€€€€è€œœì(€€€€€€€¥˜€ …½É¥¥¹…°ü¹½Ý¹•ÉQ½­•¹!…Í ñðÍÕÁÁ±¥•‘!…Í €„ôô½É¥¥¹…°¹½Ý¹•ÉQ½­•¹!…Í ¤ì(€€€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«bçbÃbÄƒb—b¯b£bŸb¨ƒffff+b¤ƒfb·bŸb¿b¯b¤ƒbŸfbŸbÏb«fbÏbŸbÄ¸œ¤ì(€€€€€€€ô(€€€€€ô•±Í”ì(€€€€€€€Ñ¡É•…‘%€ôQ!I´‘íÉåÁÑ¼¹É…¹‘½µ	åÑ•Ì ÈÐ¤¹Ñ½MÑÉ¥¹œ ¡•àœ¥õ€ì(€€€€€€€½Ý¹•ÉQ½­•¸€ôÉåÁÑ¼¹É…¹‘½µ	åÑ•Ì ÌÈ¤¹Ñ½MÑÉ¥¹œ ¡•àœ¤ì(€€€€€ô((€€€€€½¹ÍÐµ•ÍÍ…”€ôì(€€€€€€€¥èµ…­•% MUAA=IPœ¤°(€€€€€€€Ñ¡É•…‘%°(€€€€€€€Í•¹‘•É½‘”è…Ñ½Èü¹ÁÕ‰±¥½‘”ñð€œœ°(€€€€€€€Í•¹‘•É9…µ”°(€€€€€€€Í•¹‘•ÉI…¹¬è…Ñ½È€üÉ…¹­1…‰•°¡…Ñ½È¹É…¹¬¤€è€•¹Ðƒff+b¼ƒbŸfbŸbçb«fbŸb¼œ°(€€€€€€€Ñ•áÐ°(€€€€€€€…Ðè¹½Ü ¤°(€€€€€€€É•Á±äè™…±Í”°(€€€€€€€½Ý¹•ÉUÍ•É%è½É¥¥¹…°ü¹½Ý¹•ÉUÍ•É%ñð…Ñ½Èü¹¥ñð¹Õ±°°(€€€€€€€€¸¸¸ …½É¥¥¹…°€üì(€€€€€€€€€½Ý¹•ÉQ½­•¹!…Í èÉåÁÑ¼¹É•…Ñ•!…Í  Í¡„ÈÔØœ¤¹ÕÁ‘…Ñ”¡½Ý¹•ÉQ½­•¸¤¹‘¥•ÍÐ ¡•àœ¤(€€€€€€€ô€èíô¤(€€€€€ôì(€€€€€ÍÕÁÁ½ÉÑQ¡É•…‘M½­•ÑÌ¹Í•Ð¡µ•ÍÍ…”¹Ñ¡É•…‘%°Í½­•Ð¹¥¤ì(€€€€€ÍÑ…Ñ”¹¥…}ÍÕÁÁ½ÉÐ¹ÁÕÍ ¡µ•ÍÍ…”¤ì(€€€€€ÍÑ…Ñ”¹¥…}ÍÕÁÁ½ÉÐ€ôÍÑ…Ñ”¹¥…}ÍÕÁÁ½ÉÐ¹Í±¥” ´ÔÀÀ¤ì(€€€€€Í…Ù•MÑ…Ñ” ¤ì((€€€€€™½È€¡½¹ÍÐÑ…É•ÑM½­•Ð½˜¥¼¹Í½­•ÑÌ¹Í½­•ÑÌ¹Ù…±Õ•Ì ¤¤ì(€€€€€€€½¹ÍÐÑ…É•ÑUÍ•È€ôÑ…É•ÑM½­•Ð¹ÕÍ•É%€ü•ÑUÍ•É	å%¡Ñ…É•ÑM½­•Ð¹ÕÍ•É%¤€è¹Õ±°ì(€€€€€€€¥˜€¡Ñ…É•ÑUÍ•È€˜˜¥Í1•…‘•ÉÍ¡¥À¡Ñ…É•ÑUÍ•È¤¤ì(€€€€€€€€€Ñ…É•ÑM½­•Ð¹•µ¥Ð ÍÕÁÁ½ÉÐéµ•ÍÍ…”œ°µ•ÍÍ…”¤ì(€€€€€€€ô(€€€€€ô(€€€€€É•ÑÕÉ¸½¬¡ˆ°ìµ•ÍÍ…”°Ñ¡É•…‘%èµ•ÍÍ…”¹Ñ¡É•…‘%°½Ý¹•ÉQ½­•¸ô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ ÍÕÁÁ½ÉÐé¡¥ÍÑ½Éäœ°€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐÑ¡É•…‘%€ô±•…¸¡Á…å±½…ü¹Ñ¡É•…‘%°€ÄÈÀ¤ì(€€€€€½¹ÍÐ½Ý¹•ÉQ½­•¸€ô±•…¸¡Á…å±½…ü¹½Ý¹•ÉQ½­•¸°€ÈÀÀ¤ì(€€€€€½¹ÍÐ½É¥¥¹…°€ôÍÑ…Ñ”¹¥…}ÍÕÁÁ½ÉÐ¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹Ñ¡É•…‘%€ôôôÑ¡É•…‘%€˜˜¥Ñ•´¹É•Á±ä€„ôôÑÉÕ”¤ì(€€€€€½¹ÍÐÍÕÁÁ±¥•‘!…Í €ô½Ý¹•ÉQ½­•¸(€€€€€€€€üÉåÁÑ¼¹É•…Ñ•!…Í  Í¡„ÈÔØœ¤¹ÕÁ‘…Ñ”¡½Ý¹•ÉQ½­•¸¤¹‘¥•ÍÐ ¡•àœ¤(€€€€€€€€è€œœì(€€€€€¥˜€ …½É¥¥¹…°ü¹½Ý¹•ÉQ½­•¹!…Í ñðÍÕÁÁ±¥•‘!…Í €„ôô½É¥¥¹…°¹½Ý¹•ÉQ½­•¹!…Í ¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«bçbÃbÄƒb—b¯b£bŸb¨ƒffff+b¤ƒfb·bŸb¿b¯b¤ƒbŸfbŸbÏb«fbÏbŸbÄ¸œ¤ì(€€€€€ô(€€€€€ÍÕÁÁ½ÉÑQ¡É•…‘M½­•ÑÌ¹Í•Ð¡Ñ¡É•…‘%°Í½­•Ð¹¥¤ì(€€€€€½¹ÍÐµ•ÍÍ…•Ì€ôÍÑ…Ñ”¹¥…}ÍÕÁÁ½ÉÐ¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹Ñ¡É•…‘%€ôôôÑ¡É•…‘%¤ì(€€€€€É•ÑÕÉ¸½¬¡ˆ°ìÑ¡É•…‘%°µ•ÍÍ…•Ìô¤ì(€€€ô¤ì((€€€Í½­•Ð¹½¸ ÍÕÁÁ½ÉÐéÉ•Á±äœ°…Íå¹Œ€¡Á…å±½…°ˆ¤€ôøì(€€€€€½¹ÍÐ…Ñ½È€ôÉ•ÅÕ¥É•M½­•ÑUÍ•È¡Í½­•Ð¤ì(€€€€€¥˜€ ……Ñ½Èñð€…¥Í1•…‘•ÉÍ¡¥À¡…Ñ½È¤¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€ŸbŸfbÇb¼ƒbçff$ƒbŸbÏb«fbÏbŸbÇbŸb¨ƒbŸfbŸbçb«fbŸb¼ƒfb«bŸb´ƒfffbŸb›b¼ƒf!M•¹¥½È½µµ…¹‘•È%ƒffbÜ¸œ¤ì(€€€€€ô(€€€€€½¹ÍÐÑ•áÐ€ô±•…¸¡Á…å±½…ü¹Ñ•áÐñðÁ…å±½…ü¹µ•ÍÍ…”°€ÌÀÀÀ¤ì(€€€€€½¹ÍÐÑ¡É•…‘%€ô±•…¸¡Á…å±½…ü¹Ñ¡É•…‘%°€ÄÈÀ¤ì(€€€€€¥˜€ …Ñ•áÐñð€…Ñ¡É•…‘%¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿb£f+bŸfbŸb¨ƒbŸfbÇb¼ƒbëf+bÄƒffb«ffb¤¸œ¤ì(€€€€€¥˜€¡…Ý…¥Ðµ½‘•É…Ñ•=ÕÑ½¥¹Q•áÐ¡…Ñ½È°Ñ•áÐ°€MUAA=IQ}IA1dœ¤¤ì(€€€€€€€É•ÑÕÉ¸¹¼¡ˆ°€Ÿb«fƒb·bãbÄƒbŸfbÇb¼ƒb£f#bŸbÏbßb¤ƒfbÇfbÈƒbŸfbff¸œ¤ì(€€€€€ô(€€€€€½¹ÍÐ½É¥¥¹…°€ôÍÑ…Ñ”¹¥…}ÍÕÁÁ½ÉÐ¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹Ñ¡É•…‘%€ôôôÑ¡É•…‘%€˜˜¥Ñ•´¹É•Á±ä€„ôôÑÉÕ”¤ì(€€€€€¥˜€ …½É¥¥¹…°¤É•ÑÕÉ¸¹¼¡ˆ°€Ÿfb·bŸb¿b¯b¤ƒbŸfbŸbÏb«fbÏbŸbÄƒbëf+bÄƒff#b³f#b¿b¤¸œ¤ì(€€€€€½¹ÍÐµ•ÍÍ…”€ôì(€€€€€€€¥èµ…­•% MUAA=IPœ¤°(€€€€€€€Ñ¡É•…‘%°(€€€€€€€Í•¹‘•É½‘”è…Ñ½È¹ÁÕ‰±¥½‘”°(€€€€€€€Í•¹‘•É9…µ”è…Ñ½È¹¹…µ”°(€€€€€€€Í•¹‘•ÉI…¹¬èÉ…¹­1…‰•°¡…Ñ½È¹É…¹¬¤°(€€€€€€€Ñ•áÐ°(€€€€€€€…Ðè¹½Ü ¤°(€€€€€€€É•Á±äèÑÉÕ”(€€€€€ôì(€€€€€ÍÑ…Ñ”¹¥…}ÍÕÁÁ½ÉÐ¹ÁÕÍ ¡µ•ÍÍ…”¤ì(€€€€€ÍÑ…Ñ”¹¥…}ÍÕÁÁ½ÉÐ€ôÍÑ…Ñ”¹¥…}ÍÕÁÁ½ÉÐ¹Í±¥” ´ÔÀÀ¤ì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€™½È€¡½¹ÍÐÑ…É•ÑM½­•Ð½˜¥¼¹Í½­•ÑÌ¹Í½­•ÑÌ¹Ù…±Õ•Ì ¤¤ì(€€€€€€€½¹ÍÐÑ…É•ÑUÍ•È€ôÑ…É•ÑM½­•Ð¹ÕÍ•É%€ü•ÑUÍ•É	å%¡Ñ…É•ÑM½­•Ð¹ÕÍ•É%¤€è¹Õ±°ì(€€€€€€€¥˜€¡Ñ…É•ÑUÍ•È€˜˜¥Í1•…‘•ÉÍ¡¥À¡Ñ…É•ÑUÍ•È¤¤Ñ…É•ÑM½­•Ð¹•µ¥Ð ÍÕÁÁ½ÉÐéµ•ÍÍ…”œ°µ•ÍÍ…”¤ì(€€€€€ô(€€€€€½¹ÍÐÉ•ÅÕ•ÍÑ•É%‘Ì€ô¹•ÜM•Ð ¤ì(€€€€€¥˜€¡½É¥¥¹…°¹½Ý¹•ÉUÍ•É%¤ì(€€€€€€€™½È€¡½¹ÍÐÍ½­•Ñ%½˜Í•ÍÍ¥½¹Ì¹•Ð¡½É¥¥¹…°¹½Ý¹•ÉUÍ•É%¤ñðmt¤É•ÅÕ•ÍÑ•É%‘Ì¹…‘¡Í½­•Ñ%¤ì(€€€€€ô(€€€€€½¹ÍÐ…Ñ¥Ù•=Ý¹•ÉM½­•Ð€ôÍÕÁÁ½ÉÑQ¡É•…‘M½­•ÑÌ¹•Ð¡Ñ¡É•…‘%¤ì(€€€€€¥˜€¡…Ñ¥Ù•=Ý¹•ÉM½­•Ð¤É•ÅÕ•ÍÑ•É%‘Ì¹…‘¡…Ñ¥Ù•=Ý¹•ÉM½­•Ð¤ì(€€€€€™½È€¡½¹ÍÐÍ½­•Ñ%½˜É•ÅÕ•ÍÑ•É%‘Ì¤ì(€€€€€€€½¹ÍÐÉ•ÅÕ•ÍÑ•ÉM½­•Ð€ô¥¼¹Í½­•ÑÌ¹Í½­•ÑÌ¹•Ð¡Í½­•Ñ%¤ì(€€€€€€€¥˜€¡É•ÅÕ•ÍÑ•ÉM½­•Ð¤É•ÅÕ•ÍÑ•ÉM½­•Ð¹•µ¥Ð ÍÕÁÁ½ÉÐéÁÉ¥Ù…Ñ”µÉ•Á±äœ°ìÑ¡É•…‘%°µ•ÍÍ…”ô¤ì(€€€€€ô(€€€€€É•ÑÕÉ¸½¬¡ˆ°ìµ•ÍÍ…”ô¤ì(€€€ô¤ì((€€€€¼¨€ôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôô(€€€€€€%M=99P(€€€€ôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôô€¨¼((€€€Í½­•Ð¹½¸ (€€€€€€‘¥Í½¹¹•Ðœ°(€€€€€€ ¤€ôøì(€€€€€€€É•µ½Ù•I…‘¥½5•µ‰•È (€€€€€€€€€Í½­•Ð¹¥(€€€€€€€€¤ì((€€€€€€€µ…É­1½½ÕÐ¡Í½­•Ð¤ì(€€€€€ô(€€€€¤ì(€ô(¤ì()¥¼¹½¸ ½¹¹•Ñ¥½¸œ°€¡Í½­•Ð¤€ôøì(€É•¥ÍÑ•É%	AM½­•Ð¡Í½­•Ð°ì(€€€•ÑMÑ…Ñ”è€ ¤€ôøÍÑ…Ñ”°(€€€É•ÅÕ¥É•M½­•ÑUÍ•È°(€€€±•…¸°(€€€É…¹­1•Ù•°°(€€€¹½Éµ…±¥é•I…¹¬°(€€€É…¹­1…‰•°°(€€€¥Í¡¥•˜°(€€€¥ÍM•¹¥½È°(€€€¥Í1•…‘•ÉÍ¡¥À°(€€€…¹5…¹…•%	A	…ÑÑ…±¥½¹Ì°(€€€¥‰ÁI•Í½±Ù•½‘”°(€€€¥‰Á	…ÑÑ…±¥½¹½ÉY¥•Ý•È°(€€€ÁÕ‰±¥UÍ•È°(€€€¹½Ü°(€€€µ…­•%°(€€€…‘‘Õ‘¥Ñ1½œ°(€€€Í…Ù•MÑ…Ñ”°(€€€•µ¥ÑMÑ…Ñ”°(€€€µ…É­1½¥¸°(€€€µ…É­1½½ÕÐ°(€€€Í½­•ÑQ½UÍ•È(€ô¤ì)ô¤ì((¼¨€ôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôô(€€!QQ@MIYHMQIP(ôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôô€¨¼()™Õ¹Ñ¥½¸¥¹ÍÑ…±±A•ÉÍ¥ÍÑ•¹•µ¥Ñ	…ÉÉ¥•ÉÌ ¤ì(€½¹ÍÐ½É¥¥¹…±%½µ¥Ð€ô¥¼¹•µ¥Ð¹‰¥¹¡¥¼¤ì(€¥¼¹•µ¥Ð€ô™Õ¹Ñ¥½¸¡•Ù•¹Ð°€¸¸¹…ÉÌ¤ì(€€€¥˜€ …ÍÑ…Ñ•MÑ½É”¤É•ÑÕÉ¸½É¥¥¹…±%½µ¥Ð¡•Ù•¹Ð°€¸¸¹…ÉÌ¤ì(€€€ÍÑ…Ñ•MÑ½É”¹™±ÕÍ  ¤¹Ñ¡•¸  ¤€ôø½É¥¥¹…±%½µ¥Ð¡•Ù•¹Ð°€¸¸¹…ÉÌ¤¤¹…Ñ  ¡•ÉÉ½È¤€ôøì(€€€€€½¹Í½±”¹•ÉÉ½È m	1,I%t	É½…‘…ÍÐÍ­¥ÁÁ•‰•…ÕÍ”Á•ÉÍ¥ÍÑ•¹”™…¥±•èœ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€ô¤ì(€€€É•ÑÕÉ¸¥¼ì(€ôì)ô()…Íå¹Œ™Õ¹Ñ¥½¸¥¹¥Ñ¥…±¥é•A•ÉÍ¥ÍÑ•¹” ¤ì(€¥˜€¡Q	M}UI0¤ì(€€€½¹ÍÐìA½½°ô€ôÉ•ÅÕ¥É” Áœœ¤ì(€€€Á½ÍÑÉ•ÍA½½°€ô¹•ÜA½½°¡ì(€€€€€½¹¹•Ñ¥½¹MÑÉ¥¹œèQ	M}UI0°(€€€€€µ…àè€Ô°(€€€€€½¹¹•Ñ¥½¹Q¥µ•½ÕÑ5¥±±¥Ìè€ÄÀÀÀÀ°(€€€€€¥‘±•Q¥µ•½ÕÑ5¥±±¥Ìè€ÌÀÀÀÀ(€€€ô¤ì(€€€Á½ÍÑÉ•ÍA½½°¹½¸ •ÉÉ½Èœ°€¡•ÉÉ½È¤€ôøì(€€€€€½¹Í½±”¹•ÉÉ½È m	1,I%t%‘±”A½ÍÑÉ•ME0½¹¹•Ñ¥½¸•ÉÉ½Èèœ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€ô¤ì(€€€…Ý…¥ÐÁ½ÍÑÉ•ÍA½½°¹ÅÕ•Éä M1P€Äœ¤ì(€€€ÍÑ…Ñ•MÑ½É”€ô¹•ÜA½ÍÑÉ•ÍMÑ…Ñ•MÑ½É”¡Á½ÍÑÉ•ÍA½½°¤ì(€€€ÍÑ…Ñ”€ô…Ý…¥ÐÍÑ…Ñ•MÑ½É”¹±½…¡ì(€€€€€¥¹¥Ñ¥…±MÑ…Ñ”è5AQe}MQQ°(€€€€€•Ñ1•…åMÑ…Ñ”è€ ¤€ôøì(€€€€€€€½¹ÍÐ±•…ä€ôÉ•…‘1•…åMÑ…Ñ•¥±” ¤ì(€€€€€€€¥˜€¡±•…ä¤½¹Í½±”¹±½œ m	1,I%t%µÁ½ÉÑ¥¹œ±•…ä)M=8‘…Ñ„™É½´€œ€¬±•…ä¹™¥±”¤ì(€€€€€€€É•ÑÕÉ¸±•…ä€ü±•…ä¹ÍÑ…Ñ”€è¹Õ±°ì(€€€€€ô°(€€€€€¹½Éµ…±¥é•MÑ…Ñ”è€¡Ù…±Õ”¤€ôø¹½Éµ…±¥é•A•ÉÍ¥ÍÑ•‘MÑ…Ñ”¡Ù…±Õ”°€A½ÍÑÉ•ME0ÍÑ…Ñ”œ¤(€€€ô¤ì(€€€¹½Ñ¥™¥…Ñ¥½¹ÍMÑ½É”€ô¹•Ü9½Ñ¥™¥…Ñ¥½¹ÍMÑ½É”¡Á½ÍÑÉ•ÍA½½°°ì(€€€€€•ÑI½ÝÌè€ ¤€ôøÍÑ…Ñ”¹¥…}¹½Ñ¥™¥…Ñ¥½¹Ìñðmt°(€€€€€Í•ÑI½ÝÌè€¡É½ÝÌ¤€ôøì(€€€€€€€ÍÑ…Ñ”¹¥…}¹½Ñ¥™¥…Ñ¥½¹Ì€ôÉ½ÝÌì(€€€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€€€ô(€€€ô¤ì(€€€…Ý…¥Ð¹½Ñ¥™¥…Ñ¥½¹ÍMÑ½É”¹¥¹¥Ñ¥…±¥é” ¤ì(€€€¥¹ÍÑ…±±A•ÉÍ¥ÍÑ•¹•µ¥Ñ	…ÉÉ¥•ÉÌ ¤ì(€€€½¹Í½±”¹±½œ m	1,I%tA½ÍÑÉ•ME0ÍÑ…Ñ”ÍÑ½É”É•…‘ä¸œ¤ì(€€€½¹Í½±”¹±½œ m	1,I%tA½ÍÑÉ•ME0¹½Ñ¥™¥…Ñ¥½¸ÍÑ½É”É•…‘ä¸œ¤ì(€€€É•ÑÕÉ¸ì(€ô((€¥˜€¡%M}I9I}IU9Q%5¤ì(€€€½¹Í½±”¹Ý…É¸ m	1,I%tQ	M}UI0¥Ì¹½Ð½¹™¥ÕÉ•ìÕÍ¥¹œÑ•µÁ½É…Éä)M=8ÍÑ…Ñ”…Ð€œ€¬Q}%1€¬€œ¸MÑ…Ñ”µ…ä‰”±½ÍÐ½¸É•ÍÑ…ÉÐ½ÈÉ•‘•Á±½ä¸œ¤ì(€ô((€ÁÉ•Á…É•¥±•MÑ½É…” ¤ì(€ÍÑ…Ñ”€ô±½…‘MÑ…Ñ” ¤ì(€¹½Ñ¥™¥…Ñ¥½¹ÍMÑ½É”€ô¹•Ü9½Ñ¥™¥…Ñ¥½¹ÍMÑ½É”¡¹Õ±°°ì(€€€•ÑI½ÝÌè€ ¤€ôøÍÑ…Ñ”¹¥…}¹½Ñ¥™¥…Ñ¥½¹Ìñðmt°(€€€Í•ÑI½ÝÌè€¡É½ÝÌ¤€ôøì(€€€€€ÍÑ…Ñ”¹¥…}¹½Ñ¥™¥…Ñ¥½¹Ì€ôÉ½ÝÌì(€€€€€Í…Ù•MÑ…Ñ” ¤ì(€€€ô(€ô¤ì(€…Ý…¥Ð¹½Ñ¥™¥…Ñ¥½¹ÍMÑ½É”¹¥¹¥Ñ¥…±¥é” ¤ì(€½¹Í½±”¹±½œ ¡%M}I9I}IU9Q%5€ü€m	1,I%tI•¹‘•ÈÑ•µÁ½É…Éä)M=8ÍÑ…Ñ”ÍÑ½É”É•…‘äè€œ€è€m	1,I%t1½…°)M=8ÍÑ…Ñ”ÍÑ½É”É•…‘äè€œ¤€¬Q}%1¤ì)ô()±•ÐÍ¡ÕÑ‘½Ý¹AÉ½µ¥Í”€ô¹Õ±°ì)™Õ¹Ñ¥½¸¥¹ÍÑ…±±É…•™Õ±M¡ÕÑ‘½Ý¸ ¤ì(€½¹ÍÐÍ¡ÕÑ‘½Ý¸€ô€¡Í¥¹…°¤€ôøì(€€€¥˜€¡Í¡ÕÑ‘½Ý¹AÉ½µ¥Í”¤É•ÑÕÉ¸Í¡ÕÑ‘½Ý¹AÉ½µ¥Í”ì(€€€Í¡ÕÑ‘½Ý¹AÉ½µ¥Í”€ô€¡…Íå¹Œ€ ¤€ôøì(€€€€€½¹Í½±”¹±½œ m	1,I%t€œ€¬Í¥¹…°€¬€œÉ••¥Ù•ì‘É…¥¹¥¹œ½¹¹•Ñ¥½¹Ì…¹Í…Ù•µÍÑ…Ñ”ÝÉ¥Ñ•Ì¸œ¤ì(€€€€€½¹ÍÐ™½É•á¥ÑQ¥µ•È€ôÍ•ÑQ¥µ•½ÕÐ  ¤€ôøì(€€€€€€€½¹Í½±”¹•ÉÉ½È m	1,I%tM¡ÕÑ‘½Ý¸Ñ¥µ•½ÕÐÝ¡¥±”‘É…¥¹¥¹œÍÑ…Ñ”ÝÉ¥Ñ•Ì¸œ¤ì(€€€€€€€ÁÉ½•ÍÌ¹•á¥Ð Ä¤ì(€€€€€ô°€ÈÔÀÀÀ¤ì(€€€€€¥˜€¡ÑåÁ•½˜™½É•á¥ÑQ¥µ•È¹Õ¹É•˜€ôôô€™Õ¹Ñ¥½¸œ¤™½É•á¥ÑQ¥µ•È¹Õ¹É•˜ ¤ì((€€€€€ÑÉäì(€€€€€€€…Ý…¥Ð¹•ÜAÉ½µ¥Í” ¡É•Í½±Ù”¤€ôø¥¼¹±½Í”¡É•Í½±Ù”¤¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€½¹Í½±”¹•ÉÉ½È m	1,I%tÉÉ½È±½Í¥¹œM½­•Ð¹%<èœ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€€€€€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Äì(€€€€€ô(€€€€€ÑÉäì(€€€€€€€¥˜€¡ÍÑ…Ñ•MÑ½É”¤…Ý…¥ÐÍÑ…Ñ•MÑ½É”¹™±ÕÍ  ¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€½¹Í½±”¹•ÉÉ½È m	1,I%tA•¹‘¥¹œA½ÍÑÉ•ME0ÝÉ¥Ñ•Ì‘¥¹½Ð™¥¹¥Í ±•…¹±äèœ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€€€€€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Äì(€€€€€ô(€€€€€ÑÉäì(€€€€€€€¥˜€¡Á½ÍÑÉ•ÍA½½°¤…Ý…¥ÐÁ½ÍÑÉ•ÍA½½°¹•¹ ¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€½¹Í½±”¹•ÉÉ½È m	1,I%tÉÉ½È±½Í¥¹œA½ÍÑÉ•ME0Á½½°èœ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€€€€€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Äì(€€€€€ô™¥¹…±±äì(€€€€€€€±•…ÉQ¥µ•½ÕÐ¡™½É•á¥ÑQ¥µ•È¤ì(€€€€€ô(€€€ô¤ ¤ì(€€€É•ÑÕÉ¸Í¡ÕÑ‘½Ý¹AÉ½µ¥Í”ì(€ôì((€ÁÉ½•ÍÌ¹½¹” M%QI4œ°€ ¤€ôøìÙ½¥Í¡ÕÑ‘½Ý¸ M%QI4œ¤ìô¤ì(€ÁÉ½•ÍÌ¹½¹” M%%9Pœ°€ ¤€ôøìÙ½¥Í¡ÕÑ‘½Ý¸ M%%9Pœ¤ìô¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÍÑ…ÉÑM•ÉÙ•È ¤ì(€…Ý…¥Ð¥¹¥Ñ¥…±¥é•A•ÉÍ¥ÍÑ•¹” ¤ì(€¡ÑÑÁM•ÉÙ•È¹±¥ÍÑ•¸¡A=IP°€ ¤€ôøì(€€€½¹Í½±”¹±½œ œœ¤ì(€€€½¹Í½±”¹±½œ œôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôœ¤ì(€€€½¹Í½±”¹±½œ œ	1,I%%Qd%MeMQ4œ¤ì(€€€½¹Í½±”¹±½œ œA=IPè€œ€¬A=IP¤ì(€€€½¹Í½±”¹±½œ œMQQULè=91%9œ¤ì(€€€½¹Í½±”¹±½œ œ1=%8€¼1IM!%@€¼I%<€¼M=LèIdœ¤ì(€€€½¹Í½±”¹±½œ œôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôœ¤ì(€€€¥¹ÍÑ…±±É…•™Õ±M¡ÕÑ‘½Ý¸ ¤ì(€ô¤ì)ô()ÍÑ…ÉÑM•ÉÙ•È ¤¹…Ñ ¡…Íå¹Œ€¡•ÉÉ½È¤€ôøì(€½¹Í½±”¹•ÉÉ½È m	1,I%tMÑ…ÉÑÕÀ™…¥±•èœ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€¥˜€¡Á½ÍÑÉ•ÍA½½°¤ì(€€€ÑÉäì(€€€€€…Ý…¥ÐÁ½ÍÑÉ•ÍA½½°¹•¹ ¤ì(€€€ô…Ñ €¡±½Í•ÉÉ½È¤ì(€€€€€½¹Í½±”¹•ÉÉ½È m	1,I%tÉÉ½È±½Í¥¹œA½ÍÑÉ•ME0Á½½°…™Ñ•ÈÍÑ…ÉÑÕÀ™…¥±ÕÉ”èœ°±½Í•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€ô(€ô(€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Äì)ô¤ì