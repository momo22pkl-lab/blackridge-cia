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
const { createOsdRouter } = require('./osd/server');
const { NotificationsStore } = require('./notifications-store');
const { canRestoreSecurityMember, inspectMessage, normalizeMessage, parseBlockedTerms } = require('./security-moderation');
const { isProfanityDetection, normalizeProfanityStrikes, registerProfanityStrike, resetProfanityStrikes } = require('./profanity-strikes');
const { registerPages } = require('./ibp/pages');
const { registerIBPSocket } = require('./ibp/handlers');
const { readChiefBootstrapConfig, withoutBootstrapCodes } = require('./chief-bootstrap');
const { registerOfficialWarnings } = require('./official-warnings');
const { WebPushStore, createWebPushTransport, injectMobilePushMarkup, registerMobilePushSocket } = require('./mobile-push');
const { createRadioIceConfig } = require('./radio-ice-config');
const {
  accountIdentity,
  normalizeSocialContactName,
  normalizeSocialAccounts,
  normalizePlatformName,
  createManualSocialAccount,
  createDiscordSocialAccount,
  upsertSocialAccount,
  findDuplicateSocialAccountOwner
} = require('./social-accounts');

const ARABIC_PROFANITY_TERMS = Object.freeze([
  "ÙƒØ³Ù…Ùƒ",
  "ÙƒØ³ Ø§Ù…Ùƒ",
  "ÙƒØ³",
  "ÙƒØ³Ø®ØªÙƒ",
  "ÙƒØ³Ø¹ÙŠÙ„ØªÙƒ",
  "ÙƒØ³ Ø§Ø®ØªÙƒ",
  "Ø²Ø¨",
  "Ù…Øµ",
  "Ù†ÙŠÙƒ",
  "ÙØ´Ø®",
  "Ù†ÙƒØ­",
  "Ø§Ø±ÙƒØ¨ Ø¹Ù„ÙŠÙ‡",
  "Ø§Ø±ÙƒØ¨ Ø¹Ù„Ù‰ Ø²Ø¨ÙŠ",
  "ÙŠÙØ¶Ø­",
  "ÙŠÙØ¶Ø­ Ø¹Ø±Ø¶Ùƒ",
  "ÙŠÙØ¶Ø­ Ø¹ÙŠÙ„ØªÙƒ",
  "ÙŠÙØ¶Ø­ Ø§Ù…Ùƒ",
  "ÙŠØ¶ÙØ­ Ø§Ø®ØªÙƒ",
  "Ø§Ù…Ùƒ Ù…Ù†ÙŠÙˆÙƒØ©",
  "Ø§Ø®ØªÙƒ Ù…Ù†ÙŠÙˆÙƒØ©",
  "ÙŠÙ„Ø¹Ù† Ø§Ù…Ùƒ",
  "ÙŠÙ„Ø¹Ù† Ø§Ø®ØªÙƒ",
  "ÙŠÙ„Ø¹Ù† Ø´Ø±ÙÙƒ",
  "Ø§Ù…Ùƒ",
  "Ø§Ø¨ÙˆÙƒ",
  "Ø§Ø®ØªÙƒ",
  "Ø³ØªÙƒ",
  "Ø¹ÙŠÙ„ØªÙƒ",
  "ÙŠØ§ Ø§Ø¨Ù†",
  "ÙŠØ§ Ø§Ø¨Ù† Ø§Ù„Ø¹Ø±Øµ",
  "ÙŠØ§Ù…ÙØªØ²Ø­",
  "ÙŠØ§ Ù…ÙØªØ²Ø­",
  "ÙŠØ§ Ø´Ø±Ù…ÙˆØ·",
  "ÙŠØ§ Ù‚Ø­Ø¨Ø©",
  "Ù‚Ø­Ø¨",
  "Ø´Ø±Ù…ÙˆØ·",
  "ÙŠØ§ Ø§Ø¨Ù† Ø§Ù„Ù†Ø§ÙŠÙ…Ø©",
  "ÙŠÙØ¶Ø­ Ø´Ø±ÙÙƒ",
  "Ù…Ù„Ù‡Ù‰ Ù„ÙŠÙ„ÙŠ",
  "Ø§Ù…Ùƒ ØªÙ…Øµ",
  "ÙŠÙ„Ø¹Ù† Ø§Ø¨Ùˆ Ø§Ù„ÙŠ Ø®Ù„ÙÙƒ Ø¹Ø±Øµ"
]);

const DEFAULT_SECURITY_BLOCKED_TERMS = Object.freeze([...ARABIC_PROFANITY_TERMS, 'Ø®Ø±Ø§']);
const SECURITY_BLOCKED_TERM_LIMIT = 250;

function normalizeSecurityBlockedTerms(value) {
  const terms = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const term = normalizeMessage(String(entry == null ? '' : entry));
    if ([...term].length < 2 || [...term].length > 80 || !/^[\p{L}\p{N}]+(?:[ '\u2019-][\p{L}\p{N}]+)*$/u.test(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= SECURITY_BLOCKED_TERM_LIMIT) break;
  }
  return terms;
}

function getSecurityBlockedTerms() {
  if (!state.systemConfig || typeof state.systemConfig !== 'object' || Array.isArray(state.systemConfig)) state.systemConfig = {};
  const terms = normalizeSecurityBlockedTerms(state.systemConfig.securityBlockedTerms ?? DEFAULT_SECURITY_BLOCKED_TERMS);
  state.systemConfig.securityBlockedTerms = terms;
  return terms;
}

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
let mobilePushStore = null;
let appEntryHtml = null;
const mobilePushTransport = createWebPushTransport();

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
const osdRouter = createOsdRouter({
  getPool: () => postgresPool,
  getPersonnel: () => state.cia_users.map((person) => ({
    id: person.id,
    militaryCode: clean(person.publicCode, 100).toUpperCase(),
    displayName: clean(person.identity?.fullName || person.name || '', 120),
    rank: normalizeRank(person.rank),
    active: person.approved !== false &&
      person.serviceApproved !== false &&
      person.suspended !== true &&
      person.securityStatus === 'ACTIVE'
  }))
});
const osdPublicFiles = new Set([
  '/', '/index.html', '/styles.css', '/app.js', '/qr-code.js',
  '/share.html', '/share.css', '/share.js'
]);
const osdStatic = express.static(path.join(__dirname, 'osd'), { index: 'index.html' });
app.use('/osd', (req, res, next) => {
  if (!osdPublicFiles.has(req.path)) return res.sendStatus(404);
  return osdStatic(req, res, next);
});
app.use('/api/osd', osdRouter);

// Serve the standalone warning prototype without changing the main CIA or OSD entry points.
app.get('/blackridge-warning-prototype', (req, res) => {
  const entryPoint = path.join(__dirname, 'blackridge-warning-prototype', 'index.html');
  if (!fs.existsSync(entryPoint)) return res.status(404).send('BLACKRIDGE warning prototype not found.');
  return res.sendFile(entryPoint);
});

const publicAssets = Object.freeze({
  '/notifications.css': 'notifications.css',
  '/notifications-client.js': 'notifications-client.js',
  '/mobile-push-client.js': 'mobile-push-client.js',
  '/mobile-push-alert-sound.js': 'mobile-push-alert-sound.js',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/blackridge-push-icon-192.png': 'blackridge-push-icon-192.png',
  '/blackridge-push-icon-512.png': 'blackridge-push-icon-512.png',
  '/blackridge-notification-icon-192.png': 'blackridge-notification-icon-192.png',
  '/blackridge-notification-banner.png': 'blackridge-notification-banner.png',
  '/official-warnings.css': 'official-warnings.css',
  '/official-warnings-client.js': 'official-warnings-client.js',
  '/blackridge-cipher.css': 'blackridge-cipher.css',
  '/blackridge-cipher.js': 'blackridge-cipher.js',
  '/sos-alert-sound.js': 'sos-alert-sound.js',
  '/radio-signal-policy.js': 'radio-signal-policy.js',
  '/radio-audio-health.js': 'radio-audio-health.js',
  '/sos-alert.mp3': 'sos-alert.mp3',
  '/ibp/ibp.css': path.join('ibp', 'ibp.css'),
  '/ibp/ibp.js': path.join('ibp', 'ibp.js'),
  '/ibp/los-santos-map-reference.jpg': path.join('ibp', 'los-santos-map-reference.jpg'),
  '/brand-seal.jpg': path.join('blackridge-personnel-module', 'public', 'blackridge-official-seal.jpg'),
  '/warning-alert.mp3': 'warning-alert.mp3'
});

for (const [route, file] of Object.entries(publicAssets)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
}

app.get('/service-worker.js', (req, res) => {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Service-Worker-Allowed': '/',
    'X-Content-Type-Options': 'nosniff'
  });
  return res.sendFile(path.join(__dirname, 'service-worker.js'));
});

app.get(['/', '/index.html'], (req, res) => {
  const entryPoint = path.join(__dirname, 'index.html');
  if (!fs.existsSync(entryPoint)) {
    return res.status(404).send('BLACK RIDGE CIA: index.html not found.');
  }
  try {
    if (appEntryHtml === null) appEntryHtml = fs.readFileSync(entryPoint, 'utf8');
    return res.status(200).type('html').send(injectMobilePushMarkup(appEntryHtml));
  } catch (_error) {
    return res.status(500).send('BLACK RIDGE CIA: index.html could not be loaded.');
  }
});

registerPages(app);

const now = () => new Date().toISOString();
const clean = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const redactSecurityReason = (value) => clean(value, 300)
  .replace(/\b(password|passcode|secret(?:\s+code)?|api[\s-]*key|access[\s-]*token|token)\s*(?::|=|\bis\b)\s*[^\s,;]+/giu, '$1=[REDACTED]')
  .replace(/(ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±|ÙƒÙ„Ù…Ù‡ Ø§Ù„Ù…Ø±ÙˆØ±|Ø±Ù…Ø² Ø§Ù„Ø¯Ø®ÙˆÙ„|Ø§Ù„ÙƒÙˆØ¯ Ø§Ù„Ø³Ø±ÙŠ)\s*(?::|=|Ù‡Ùˆ)?\s*[^\s,;]+/gu, '$1=[Ù…Ø­Ø¬ÙˆØ¨]');
const lower = (value) => clean(value, 200).toLowerCase();
const makeId = (prefix = 'ID') => `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
const RADIO_MAIN_CHANNELS = Object.freeze([
  { id: 'CH-1', name: 'Ø§Ù„Ù‚Ù†Ø§Ø© Ø§Ù„Ø¹Ø§Ù…Ø©', frequency: '104.50' },
  { id: 'TAC-1', name: 'Ù‚Ù†Ø§Ø© Ø§Ù„Ù…Ø·Ø§Ø±Ø¯Ø§Øª', frequency: '108.20' },
  { id: 'CH-3', name: 'Ø§Ù„Ù‚ÙŠØ§Ø¯Ø© Ø§Ù„Ù…Ø´ÙØ±Ø©', frequency: '112.90' }
]);
const RADIO_MAIN_CHANNEL_IDS = new Set(RADIO_MAIN_CHANNELS.map((channel) => channel.id));
const RADIO_CUSTOM_CHANNEL_PREFIX = 'CUSTOM:';
const RADIO_CUSTOM_CHANNEL_LIMIT = 500;

function normalizeCustomRadioLabel(value) {
  const raw = String(value ?? '').normalize('NFKC');
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(raw)) return '';
  const label = raw.trim().replace(/\s+/gu, ' ');
  if (!label || label.length > 43) return '';
  return label;
}

function customRadioChannelKey(value) {
  const label = normalizeCustomRadioLabel(value);
  return label ? RADIO_CUSTOM_CHANNEL_PREFIX + label.toLowerCase() : '';
}

function isCustomRadioChannel(value) {
  return String(value ?? '').startsWith(RADIO_CUSTOM_CHANNEL_PREFIX);
}

function isPrivateRadioChannel(value) {
  const channel = String(value || 'CH-1');
  return !RADIO_MAIN_CHANNEL_IDS.has(channel);
}

function normalizeCustomRadioChannels(value) {
  const channels = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const source = entry && typeof entry === 'object' ? entry.label : entry;
    const label = normalizeCustomRadioLabel(source);
    const id = customRadioChannelKey(label);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const allowedUserIds = [];
    const allowedSet = new Set();
    for (const value of Array.isArray(entry?.allowedUserIds) ? entry.allowedUserIds : []) {
      const userId = clean(value, 120);
      if (!userId || allowedSet.has(userId)) continue;
      allowedSet.add(userId);
      allowedUserIds.push(userId);
      if (allowedUserIds.length >= 1000) break;
    }
    channels.push({
      id,
      label,
      createdAt: clean(entry?.createdAt, 40) || null,
      accessMode: entry?.accessMode === 'restricted' ? 'restricted' : 'open',
      allowedUserIds
    });
    if (channels.length >= RADIO_CUSTOM_CHANNEL_LIMIT) break;
  }
  return channels;
}

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
  cia_custom_radio_channels: [],
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
  cia_web_push_subscriptions: [],
  cia_battalions: [],
  ibp_deployments: [],
  ibp_operations: [],
  ibp_intelligence: [],
  ibp_reports: [],
  ibp_messages: [],
  settings: {
    publicSalary: SYSTEM.defaultSalary,
    rankSalaries: {
      AGENT: SYSTEM.defaultSalary,
      'HIGH COMMANDER': SYSTEM.defaultSalary,
      'SUPREME COMMANDER': SYSTEM.defaultSalary,
      'CIA CHIEF': SYSTEM.defaultSalary
    }
  },
  systemConfig: { securityBlockedTerms: [...DEFAULT_SECURITY_BLOCKED_TERMS] }
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
      ...(parsed.systemConfig || {}),
      securityBlockedTerms: normalizeSecurityBlockedTerms(
        parsed.systemConfig?.securityBlockedTerms ?? base.systemConfig.securityBlockedTerms
      )
    }),
    cia_chats: {
      global: Array.isArray(parsed.cia_chats?.global) ? parsed.cia_chats.global : [],
      private: parsed.cia_chats?.private && typeof parsed.cia_chats.private === 'object' ? parsed.cia_chats.private : {}
    },
    cia_custom_radio_channels: normalizeCustomRadioChannels(parsed.cia_custom_radio_channels)
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
    'cia_notifications', 'cia_web_push_subscriptions', 'ibp_deployments', 'ibp_operations', 'ibp_intelligence', 'ibp_reports', 'ibp_messages'
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
const discordOAuthStates = new Map();
const accountCharacterLoginFailures = new Map();
const socketToUser = new Map();
const radioChannels = new Map();
const radioTalkers = new Map();
const radioIceConfigCache = new Map();
const radioIceConfigPending = new Map();
const pendingRequestSockets = new Map();
const supportThreadSockets = new Map();

async function getRadioIceConfigForSocket(socketId) {
  const cached = radioIceConfigCache.get(socketId);
  if (cached && cached.expiresAt > Date.now()) return cached.config;
  const pending = radioIceConfigPending.get(socketId);
  if (pending) return pending;
  const request = createRadioIceConfig(socketId).then((config) => {
    const cacheMs = config.turnStatus === 'configured' ? 50 * 60 * 1000 : 30000;
    radioIceConfigCache.set(socketId, { config, expiresAt: Date.now() + cacheMs });
    return config;
  }).finally(() => radioIceConfigPending.delete(socketId));
  radioIceConfigPending.set(socketId, request);
  return request;
}

function notificationCanReach(user, details) {
  if (!user || user.suspended || user.securityStatus !== 'ACTIVE' || user.approved === false || user.serviceApproved === false) return false;
  const targetUserId = details.targetUserId ? String(details.targetUserId) : '';
  const sourceUserId = details.sourceUserId ? String(details.sourceUserId) : '';
  if (details.type === 'SECURITY' && details.leadershipOnly === true) return details.chiefOnly === true ? isChief(user) : isSecuritySupervisor(user);
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
    message: clean(details.message || '', ['WARNING', 'WARNING_RESPONSE'].includes(String(details.type || '').toUpperCase()) ? 3000 : 1000),
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
  user.socialContactName = normalizeSocialContactName(user.socialContactName);
  user.socialAccounts = normalizeSocialAccounts(user.socialAccounts);

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
  const privateRadio = isPrivateRadioChannel(user.radioChannel);
  const canSeeRadioChannel = self || isChief(viewer) || !privateRadio;

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
      canSeeRadioChannel ? (user.radioChannel || 'CH-1') : null,

    ibpLanguage:
      user.ibpLanguage === 'en' ? 'en' : 'ar',

    radioOnline:
      canSeeRadioChannel && !!user.radioOnline
  };

  if (self || canManageMember(viewer, user)) {
    result.socialAccounts = normalizeSocialAccounts(user.socialAccounts);
    result.socialContactName = normalizeSocialContactName(user.socialContactName);
  }

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

function isProfanitySecurityIncident(incident) {
  return !!incident && isProfanityDetection({ type: incident.type });
}

function isProfanitySeparation(incident) {
  return isProfanitySecurityIncident(incident) &&
    incident.action === 'MEMBER_SUSPENDED' &&
    incident.status === 'SUSPENDED' &&
    Number(incident.profanityStrikeCount) >= 3;
}

function securityIncidentCanBeViewed(incident, viewer) {
  if (!incident || !viewer || incident.securityCenterHiddenAt) return false;
  return isChief(viewer) || (isSecuritySupervisor(viewer) && isProfanitySeparation(incident));
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
  profanityStrikeCount = null,
  profanityTerm = null
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
    ...(Number.isFinite(profanityStrikeCount) ? { profanityStrikeCount } : {}),
    ...(isProfanitySecurityIncident({ type }) && typeof profanityTerm === 'string' && clean(profanityTerm, 80)
      ? { profanityTerm: clean(profanityTerm, 80) }
      : {})
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
    if (viewer && securityIncidentCanBeViewed(incident, viewer)) {
      const visibleIncident = securityEventForViewer(incident, viewer);
      if (visibleIncident) targetSocket.emit('security:incident', visibleIncident);
    }
  }
  return incident;
}

function securityEventForViewer(incident, viewer) {
  if (!securityIncidentCanBeViewed(incident, viewer)) return null;
  const result = {
    id: incident.id,
    publicCode: incident.publicCode,
    rank: incident.rank,
    timestamp: incident.timestamp || incident.at,
    type: incident.type,
    level: incident.level,
    action: incident.action,
    status: incident.status,
    relatedId: incident.relatedId || null,
    ...(Number.isFinite(incident.profanityStrikeCount) ? { profanityStrikeCount: incident.profanityStrikeCount } : {})
  };
  if (isChief(viewer)) {
    result.userId = incident.userId;
    result.userName = incident.userName;
    result.actorId = incident.actorId;
    result.actorName = incident.actorName;
    result.actorCode = incident.actorCode || '';
    result.actorRank = incident.actorRank || '';
    if (isProfanitySecurityIncident(incident) && incident.profanityTerm) {
      result.profanityTerm = clean(incident.profanityTerm, 80);
    }
    result.severity = incident.severity;
    if (Number.isFinite(incident.notificationCount)) result.notificationCount = incident.notificationCount;
    const suspendedMember = incident.type === 'MANUAL_REVIEW' && incident.action === 'MEMBER_SUSPENDED'
      ? state.cia_users.find((user) => user.id === incident.userId)
      : null;
    result.reason = redactSecurityReason(incident.reason || suspendedMember?.suspensionReason || '');
  }
  return result;
}

async function notifySecurityLeadership(incident, options = {}) {
  const profanitySeparation = isProfanitySeparation(incident);
  const priority = incident.level === 'LEVEL 4' || incident.level === 'LEVEL 3'
    ? 'CRITICAL'
    : incident.level === 'LEVEL 2' ? 'HIGH' : 'NOTICE';
  const notifications = await publishNotifications(state.cia_users, {
    type: 'SECURITY',
    title: 'SECURITY ALERT',
    message: clean(options.message || `${incident.publicCode ? `#${incident.publicCode}` : 'Ø¹Ø¶Ùˆ'} â€” ${incident.type} â€” ${incident.level} â€” ${incident.action}`, 500),
    priority,
    sourceUserId: incident.userId,
    sourceCode: incident.publicCode,
    relatedId: incident.id,
    leadershipOnly: true,
    chiefOnly: !profanitySeparation,
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
    const memberMessage = strike.count === 1
      ? 'ØªØ­Ø°ÙŠØ± Ø£ÙˆÙ„ÙŠ Ø±Ø³Ù…ÙŠ Ù…Ù† Ø§Ù„Ù‚ÙŠØ§Ø¯Ø© Ø¨Ø³Ø¨Ø¨ Ø§Ø³ØªØ®Ø¯Ø§Ù… Ø£Ù„ÙØ§Ø¸ Ù…Ø³ÙŠØ¦Ø©. ØªÙ… Ø­Ø¸Ø± Ø±Ø³Ø§Ù„ØªÙƒ. Ø§Ù„Ù…Ø®Ø§Ù„ÙØ© 1/3.'
      : strike.count === 2
        ? 'ØªØ­Ø°ÙŠØ± Ø«Ø§Ù†ÙˆÙŠ Ø±Ø³Ù…ÙŠ Ù…Ù† Ø§Ù„Ù‚ÙŠØ§Ø¯Ø© Ø¨Ø³Ø¨Ø¨ ØªÙƒØ±Ø§Ø± Ø§Ø³ØªØ®Ø¯Ø§Ù… Ø£Ù„ÙØ§Ø¸ Ù…Ø³ÙŠØ¦Ø©. ØªÙ… Ø­Ø¸Ø± Ø±Ø³Ø§Ù„ØªÙƒ. Ø§Ù„Ù…Ø®Ø§Ù„ÙØ© 2/3ØŒ ÙˆØ§Ù„ØªÙƒØ±Ø§Ø± Ø§Ù„ØªØ§Ù„ÙŠ ÙŠØ¤Ø¯ÙŠ Ø¥Ù„Ù‰ ÙØµÙ„Ùƒ Ù…Ù† Ø§Ù„Ø®Ø¯Ù…Ø©.'
        : 'ØªØ­Ø°ÙŠØ± Ù†Ù‡Ø§Ø¦ÙŠ: ØªÙ… ÙØµÙ„Ùƒ Ù…Ù† Ø§Ù„Ø®Ø¯Ù…Ø© Ø¨Ø³Ø¨Ø¨ ØªÙƒØ±Ø§Ø± Ø§Ù„Ù…Ø®Ø§Ù„ÙØ§Øª Ø§Ù„Ù„ÙØ¸ÙŠØ© Ù„Ù„Ù…Ø±Ø© Ø§Ù„Ø«Ø§Ù„Ø«Ø© (3/3). ÙŠØ­Ù‚ Ù„Ù„Ù‚Ø§Ø¦Ø¯ ÙÙ‚Ø· Ø¥Ø¹Ø§Ø¯ØªÙƒ Ù„Ù„Ø®Ø¯Ù…Ø©.';
    const reason = `PROFANITY_STRIKE_${strike.count}${separated ? '_AUTO_SEPARATION' : ''} // ${detection.reason} // CHANNEL_${channelName}`;

    const incident = recordSecurityEvent({
      actor,
      target: actor,
      action: separated ? 'MEMBER_SUSPENDED' : 'PROFANITY_WARNING',
      type: detection.type,
      level: separated ? 3 : 1,
      reason,
      status: separated ? 'SUSPENDED' : 'REVIEW_REQUIRED',
      profanityStrikeCount: strike.count,
      profanityTerm: detection.matchedTerm || null
    });
    const leadershipMessage = separated
      ? `ØªÙ… ÙØµÙ„ #${clean(actor.publicCode || 'â€”', 100)} Ø¨Ø¹Ø¯ Ø§Ù„Ù…Ø®Ø§Ù„ÙØ© ${strike.count}/3 Ø¨Ø³Ø¨Ø¨ Ø¥Ø³Ø§Ø¡Ø© Ù„ÙØ¸ÙŠØ© ÙÙŠ ${channelName}.`
      : undefined;

    await saveState();
    emitState();
    if (!separated) {
      const warningId = makeId('WRN');
      await publishNotifications([actor], {
        type: 'WARNING',
        title: 'ØªØ­Ø°ÙŠØ± Ø±Ø³Ù…ÙŠ Ù…Ù† Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©',
        message: memberMessage,
        priority: 'CRITICAL',
        targetUserId: actor.id,
        sourceCode: 'CIA COMMAND',
        relatedId: warningId,
        metadata: {
          warningId,
          warningType: 'Ø³Ù„ÙˆÙƒÙŠ',
          warningContent: memberMessage,
          allowJustification: false,
          recipientCode: actor.publicCode || '',
          recipientName: actor.identity?.fullName || actor.name || '',
          recipientRank: rankLabel(actor.rank),
          autoGenerated: true,
          profanityStrikeCount: strike.count,
          strikeLimit: 3
        }
      });
    }
    if (separated) endRestrictedSessions(actor, memberMessage);
    await notifySecurityLeadership(incident, leadershipMessage ? { message: leadershipMessage } : {});
    await saveState();

    return {
      blocked: true,
      message: memberMessage,
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

const DEFAULT_ENGLISH_PROFANITY_TERMS = Object.freeze(['fuck', 'shit', 'bitch', 'asshole', 'motherfucker']);
const PROFANITY_LEET_MAP = Object.freeze({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g' });
const PROFANITY_ARABIZI_MAP = Object.freeze({ '2': 'Ø¡', '3': 'Ø¹', '5': 'Ø®', '6': 'Ø·', '7': 'Ø­', '9': 'Øµ' });

function findMatchedProfanityTerm(value, detection) {
  const source = detection && detection.decodedText ? detection.decodedText : String(value == null ? '' : value);
  const normalized = normalizeMessage(source);
  if (!normalized) return '';

  const terms = [...new Set([
    ...DEFAULT_ENGLISH_PROFANITY_TERMS,
    ...getSecurityBlockedTerms(),
    ...parseBlockedTerms(process.env.CIA_SECURITY_BLOCKED_TERMS || '').map((rule) => rule.term)
  ].map((term) => normalizeMessage(term)).filter(Boolean))];
  const candidates = new Set([normalized]);
  const punctuationCollapsed = normalized
    .split(/\s+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .join(' ')
    .trim();
  if (punctuationCollapsed) candidates.add(punctuationCollapsed);

  const addWordForms = (word) => {
    const forms = new Set([word]);
    const collapsed = word.replace(/(.)\1{2,}/gu, '$1');
    forms.add(collapsed);
    if (/[a-z]/u.test(word) && /\d/u.test(word)) {
      forms.add(word.replace(/[01345789]/gu, (digit) => PROFANITY_LEET_MAP[digit] || digit));
      forms.add(word.replace(/[235679]/gu, (digit) => PROFANITY_ARABIZI_MAP[digit] || digit));
    }
    for (const form of forms) {
      candidates.add(form);
      if ([...form].length >= 4) candidates.add([...form].reverse().join(''));
    }
  };
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  for (const word of words) addWordForms(word);
  let singleLetterRun = '';
  const flushSingleLetters = () => {
    if ([...singleLetterRun].length >= 4) addWordForms(singleLetterRun);
    singleLetterRun = '';
  };
  for (const piece of normalized.split(/[^\p{L}\p{N}]+/gu).filter(Boolean)) {
    if ([...piece].length === 1) singleLetterRun += piece;
    else flushSingleLetters();
  }
  flushSingleLetters();

  const wordSequence = (candidate) => normalizeMessage(candidate).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (const term of terms) {
    const paddedTerm = ' ' + wordSequence(term) + ' ';
    for (const candidate of candidates) {
      if ((' ' + wordSequence(candidate) + ' ').includes(paddedTerm)) return term;
    }
  }
  return '';
}

async function moderateOutgoingText(actor, text, channel) {
  const configuredTerms = [
    getSecurityBlockedTerms().join('\n'),
    process.env.CIA_SECURITY_BLOCKED_TERMS || ''
  ].filter(Boolean).join('\n');
  const detection = inspectMessage(text, configuredTerms);
  if (!detection) return false;
  if (isProfanityDetection(detection)) {
    detection.matchedTerm = findMatchedProfanityTerm(text, detection);
  }
  if (actor && isChief(actor) && isProfanityDetection(detection)) return false;
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
function ibpPersonnelBattalionFor(person) {
  const wanted = clean(person?.publicCode, 100).toUpperCase();
  if (!wanted) return null;
  const units = Array.isArray(state.cia_battalions) ? state.cia_battalions : [];
  const match = units.find((unit) => {
    if (!unit || unit.status === 'ARCHIVED') return false;
    const members = Array.isArray(unit.memberCodes) ? unit.memberCodes : [];
    return members.some((code) => clean(code, 100).toUpperCase() === wanted) ||
      [unit.commanderCode, unit.deputyCode].some((code) => clean(code, 100).toUpperCase() === wanted);
  });
  return match ? {
    id: clean(match.id, 120),
    code: clean(match.code || match.id, 32),
    name: clean(match.nameAr || match.nameEn || match.name || match.code, 100)
  } : null;
}
function ibpPersonnelInScope(actor, target) {
  if (!actor || !target) return false;
  if (String(actor.id) === String(target.id) || isLeadership(actor)) return true;
  if (target.suspended || target.approved === false || target.serviceApproved === false) return false;
  const viewerCode = clean(actor.publicCode, 100).toUpperCase();
  const targetCode = clean(target.publicCode, 100).toUpperCase();
  if (!viewerCode || !targetCode) return false;
  return (Array.isArray(state.cia_battalions) ? state.cia_battalions : []).some((unit) => {
    if (!unit || unit.status === 'ARCHIVED') return false;
    const memberCodes = Array.isArray(unit.memberCodes) ? unit.memberCodes : [];
    const unitCodes = [
      ...memberCodes,
      unit.commanderCode,
      unit.deputyCode,
      unit.seniorCommanderCode
    ].map((code) => clean(code, 100).toUpperCase()).filter(Boolean);
    return unitCodes.includes(viewerCode) && unitCodes.includes(targetCode);
  });
}
function ibpPersonnelStatus(person) {
  if (person?.suspended === true || person?.securityStatus === 'SUSPENDED') return 'SUSPENDED';
  if (person?.securityStatus === 'SECURITY_RESTRICTED') return 'RESTRICTED';
  if (person?.approved === false || person?.serviceApproved === false || person?.serviceApprovalPending === true || person?.identityApprovalPending === true || (person?.identityRequired === true && person?.identityApproved !== true)) return 'PENDING APPROVAL';
  if (person?.activeService === true) return 'ON DUTY';
  if (person?.online === true) return 'ONLINE';
  return 'OFF DUTY';
}
function ibpPersonnelRecordForViewer(person, viewer) {
  const canManage = canManageMember(viewer, person);
  const canEditCode = canManage && person.serviceApproved !== false;
  const canEditName = isChief(viewer) && canManage;
  const editableRanks = canManage
    ? ['AGENT', 'HIGH COMMANDER', 'SUPREME COMMANDER'].filter((rank) => canChangeRank(viewer, person, rank))
    : [];
  const canEditBattalion = canManageIBPBattalions(viewer) && !!person.publicCode;
  const isSelf = String(viewer?.id) === String(person?.id);
  const canSeeName = isChief(viewer);
  const unit = ibpPersonnelBattalionFor(person);
  const record = {
    id: clean(person.id, 120),
    publicCode: clean(person.publicCode, 100),
    rank: normalizeRank(person.rank),
    rankLabel: rankLabel(person.rank),
    name: canSeeName ? clean(person.identity?.fullName || person.name, 120) : '',
    battalion: unit,
    statusLabel: ibpPersonnelStatus(person),
    online: person.online === true,
    activeService: person.activeService === true,
    serviceApproved: person.serviceApproved !== false,
    identityApproved: person.identityApproved === true,
    createdAt: person.createdAt || person.joinedAt || null,
    lastLoginAt: isLeadership(viewer) || isSelf ? (person.lastLoginAt || null) : null,
    canEditName,
    canEditCode,
    canEditBattalion,
    editableRanks
  };
  return record;
}
function updateIBPPersonnelBattalion(person, requestedId) {
  const wantedCode = clean(person?.publicCode, 100).toUpperCase();
  const requested = clean(requestedId, 120);
  if (!wantedCode) return 'The personnel record has no military code to assign.';
  const activeUnits = (Array.isArray(state.cia_battalions) ? state.cia_battalions : []).filter((unit) => unit && unit.status !== 'ARCHIVED');
  const selected = requested ? activeUnits.find((unit) => String(unit.id) === requested) : null;
  if (requested && !selected) return 'The selected active battalion does not exist.';
  const assignedUnits = activeUnits.filter((unit) => {
    const members = Array.isArray(unit.memberCodes) ? unit.memberCodes : [];
    return members.some((code) => clean(code, 100).toUpperCase() === wantedCode) ||
      [unit.commanderCode, unit.deputyCode, unit.seniorCommanderCode].some((code) => clean(code, 100).toUpperCase() === wantedCode);
  });
  const roleTransfer = assignedUnits.find((unit) => String(unit.id) !== String(selected?.id || '') &&
    [unit.commanderCode, unit.deputyCode, unit.seniorCommanderCode].some((code) => clean(code, 100).toUpperCase() === wantedCode));
  if (roleTransfer) return 'A battalion commander or deputy assignment must be changed in the battalion command workflow first.';
  const duplicateUnit = assignedUnits.find((unit) => String(unit.id) !== String(selected?.id || '') &&
    (Array.isArray(unit.memberCodes) ? unit.memberCodes : []).some((code) => clean(code, 100).toUpperCase() === wantedCode));
  if (duplicateUnit && selected) return 'This person is already linked to another active battalion; resolve the existing assignment first.';
  for (const unit of activeUnits) {
    const current = Array.isArray(unit.memberCodes) ? unit.memberCodes : [];
    if (String(unit.id) === String(selected?.id || '')) {
      if (!current.some((code) => clean(code, 100).toUpperCase() === wantedCode)) unit.memberCodes = [...current, person.publicCode];
    } else if (current.some((code) => clean(code, 100).toUpperCase() === wantedCode)) {
      unit.memberCodes = current.filter((code) => clean(code, 100).toUpperCase() !== wantedCode);
    }
  }
  return null;
}
function replaceIBPPersonnelCode(oldCode, newCode) {
  const oldValue = clean(oldCode, 100).toUpperCase();
  const newValue = clean(newCode, 100);
  if (!oldValue || !newValue) return;
  const replace = (value) => clean(value, 100).toUpperCase() === oldValue ? newValue : value;
  const replaceArray = (value) => {
    if (!Array.isArray(value)) return value;
    return [...new Set(value.map(replace))];
  };
  for (const unit of Array.isArray(state.cia_battalions) ? state.cia_battalions : []) {
    if (unit.status === 'ARCHIVED') continue;
    unit.memberCodes = replaceArray(unit.memberCodes);
    for (const key of ['commanderCode', 'deputyCode', 'seniorCommanderCode']) {
      if (clean(unit[key], 100).toUpperCase() === oldValue) unit[key] = newValue;
    }
  }
  for (const collection of [state.cia_operations, state.ibp_operations]) {
    for (const operation of Array.isArray(collection) ? collection : []) {
      if (['COMPLETE', 'COMPLETED', 'CANCELLED', 'ARCHIVED'].includes(clean(operation.status, 40).toUpperCase())) continue;
      operation.memberCodes = replaceArray(operation.memberCodes);
      if (clean(operation.commanderCode, 100).toUpperCase() === oldValue) operation.commanderCode = newValue;
    }
  }
  for (const deployment of Array.isArray(state.ibp_deployments) ? state.ibp_deployments : []) {
    if (['COMPLETE', 'COMPLETED', 'CANCELLED', 'ARCHIVED'].includes(clean(deployment.status, 40).toUpperCase())) continue;
    deployment.assignedCodes = replaceArray(deployment.assignedCodes);
  }
  for (const caseItem of Array.isArray(state.cia_cases) ? state.cia_cases : []) {
    if (['CLOSED', 'RESOLVED', 'COMPLETE', 'COMPLETED', 'ARCHIVED'].includes(clean(caseItem.status, 40).toUpperCase())) continue;
    if (clean(caseItem.assignedCode, 100).toUpperCase() === oldValue) caseItem.assignedCode = newValue;
  }
  const mapLocations = state.cia_map_locations;
  if (mapLocations && !Array.isArray(mapLocations) && typeof mapLocations === 'object') {
    const oldKey = Object.keys(mapLocations).find((key) => key.toUpperCase() === oldValue);
    if (oldKey) {
      if (!Object.prototype.hasOwnProperty.call(mapLocations, newValue)) mapLocations[newValue] = mapLocations[oldKey];
      delete mapLocations[oldKey];
    }
  }
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

  const hasOtherLiveSession =
    [...set].some(
      (sessionId) => sessionId !== socket.id && io.sockets.sockets.has(sessionId)
    );
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
    (options.resumeService === true || hasOtherLiveSession) &&
    user.serviceApproved !== false &&
    user.activeService === true;
  if (!resumeService) {
    user.activeService = false;
    user.status = 'Ø®Ø§Ø±Ø¬ Ø§Ù„Ø®Ø¯Ù…Ø©';
  }
  if (!hasOtherLiveSession) user.radioOnline = false;

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
  releaseRadioTransmission(socket.id);
  removeRadioMember(socket.id);
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

function resolveRadioChannel(value) {
  const candidate = clean(value, 50);
  if (!candidate) return null;
  if (RADIO_MAIN_CHANNEL_IDS.has(candidate)) {
    return { id: candidate, label: candidate, custom: false };
  }

  const label = normalizeCustomRadioLabel(
    isCustomRadioChannel(candidate)
      ? candidate.slice(RADIO_CUSTOM_CHANNEL_PREFIX.length)
      : candidate
  );
  if (!label) return null;

  const id = customRadioChannelKey(label);
  let channel = state.cia_custom_radio_channels.find((item) => item.id === id);
  if (!channel) {
    if (state.cia_custom_radio_channels.length >= RADIO_CUSTOM_CHANNEL_LIMIT) return null;
    channel = { id, label, createdAt: now(), accessMode: 'open', allowedUserIds: [] };
    state.cia_custom_radio_channels.push(channel);
  }
  return { id: channel.id, label: channel.label, custom: true };
}

function findCustomRadioChannelById(value) {
  const channelId = clean(value, 50);
  if (!isCustomRadioChannel(channelId)) return null;
  return state.cia_custom_radio_channels.find((channel) => channel.id === channelId) || null;
}

function radioCustomChannelAllows(channelId, userId) {
  const channel = findCustomRadioChannelById(channelId);
  if (!channel) return false;
  if (channel.accessMode !== 'restricted') return true;
  return channel.allowedUserIds.includes(String(userId || ''));
}

function radioAdminDirectoryMembers() {
  return state.cia_users
    .filter((user) =>
      user.approved !== false &&
      user.serviceApproved !== false &&
      user.suspended !== true &&
      user.securityStatus === 'ACTIVE'
    )
    .map((user) => ({
      id: String(user.id),
      name: clean(user.identity?.fullName || user.name || '', 160),
      publicCode: clean(user.publicCode, 100),
      rank: rankLabel(user.rank)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function enforceCustomRadioAllowlist(channel) {
  if (!channel || channel.accessMode !== 'restricted') return;
  const revokedUsers = new Set();
  for (const socketId of radioTargets(channel.id)) {
    const targetSocket = io.sockets.sockets.get(socketId);
    const user = targetSocket ? requireSocketUser(targetSocket) : null;
    if (user && radioCustomChannelAllows(channel.id, user.id)) continue;
    if (user) revokedUsers.add(String(user.id));
    releaseRadioTransmission(socketId);
    removeRadioMember(socketId, false);
    if (user && user.radioChannel === channel.id) user.radioChannel = 'CH-1';
    if (targetSocket) {
      targetSocket.emit('radio:access-revoked', {
        channel: channel.id,
        message: 'ØªÙ… ØªØ­Ø¯ÙŠØ« ØµÙ„Ø§Ø­ÙŠØ§Øª Ø§Ù„Ù…ÙˆØ¬Ø©ØŒ ÙˆÙ„Ù… ØªØ¹Ø¯ Ø¶Ù…Ù† Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø£Ø¹Ø¶Ø§Ø¡ Ø§Ù„Ù…Ø³Ù…ÙˆØ­ Ù„Ù‡Ù….'
      });
    }
  }
  for (const userId of revokedUsers) {
    const user = getUserById(userId);
    if (user) user.radioOnline = hasOtherRadioMemberForUser(userId);
  }
  if (revokedUsers.size) {
    saveState();
    emitState();
  }
  emitRadioAdminState();
}

function removeRadioMember(
  socketId,
  notifyAdmin = true
) {
  for (const [channel, members] of radioChannels.entries()) {
    if (!members.delete(socketId)) continue;
    emitRadioToChannel(channel, 'radio:voice:peer-left', { channel, socketId });
    if (members.size === 0) radioChannels.delete(channel);
  }
  const targetSocket = io.sockets.sockets.get(socketId);
  if (targetSocket) {
    targetSocket.radioOnline = false;
    targetSocket.radioChannel = '';
  }
  const userId = socketToUser.get(socketId);
  const user = userId ? getUserById(userId) : null;
  if (user) user.radioOnline = hasOtherRadioMemberForUser(userId, socketId);
  if (notifyAdmin) emitRadioAdminState();
}

function hasOtherRadioMemberForUser(userId, excludingSocketId = '') {
  const wantedUserId = String(userId || '');
  if (!wantedUserId) return false;
  for (const socketId of sessions.get(userId) || []) {
    if (String(socketId) === String(excludingSocketId)) continue;
    if (String(socketToUser.get(socketId) || '') !== wantedUserId) continue;
    const targetSocket = io.sockets.sockets.get(socketId);
    if (!targetSocket || targetSocket.radioOnline !== true || !targetSocket.radioChannel) continue;
    if (radioChannels.get(targetSocket.radioChannel)?.has(socketId)) return true;
  }
  return false;
}

function removeUserRadioMembers(userId) {
  const wantedUserId = String(userId || '');
  if (!wantedUserId) return;
  const socketIds = new Set(sessions.get(userId) || []);
  for (const members of radioChannels.values()) {
    for (const socketId of members) {
      if (String(socketToUser.get(socketId) || '') === wantedUserId) socketIds.add(socketId);
    }
  }
  for (const socketId of socketIds) {
    releaseRadioTransmission(socketId);
    removeRadioMember(socketId, false);
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.radioOnline = false;
      targetSocket.radioChannel = '';
      targetSocket.emit('radio:service-ended', { stopped: true });
    }
  }
  const user = getUserById(userId);
  if (user) user.radioOnline = false;
  emitRadioAdminState();
}

function radioTargets(channel) {
  const members =
    radioChannels.get(channel);

  return members
    ? [...members]
    : [];
}

function getRadioTalkers(channel, create = false) {
  let talkers = radioTalkers.get(channel);
  if (!talkers && create) {
    talkers = new Map();
    radioTalkers.set(channel, talkers);
  }
  return talkers || null;
}

function announceActiveRadioTalkers(channel, joiningSocketId) {
  const joiningSocket = io.sockets.sockets.get(joiningSocketId);
  for (const talker of getRadioTalkers(channel)?.values() || []) {
    if (talker.socketId === joiningSocketId) continue;
    const talkerSocket = io.sockets.sockets.get(talker.socketId);
    if (talkerSocket) talkerSocket.emit('radio:voice:peer', { channel, peerId: joiningSocketId });
    if (joiningSocket) {
      joiningSocket.emit('radio:state', {
        channel, userCode: talker.userCode, socketId: talker.socketId, ptt: true,
        statusHtml: 'Ø¬Ø§Ø±ÙŠ Ø§Ù„Ø¨Ø« Ø§Ù„ØµÙˆØªÙŠ...'
      });
    }
  }
}

function emitRadioToChannel(channel, event, payload) {
  for (const socketId of radioTargets(channel)) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) targetSocket.emit(event, payload);
  }
}

function radioSocketIsEligible(socketId, channel) {
  if (!radioChannels.get(channel)?.has(socketId)) return false;
  const targetSocket = io.sockets.sockets.get(socketId);
  const user = targetSocket ? requireSocketUser(targetSocket) : null;
  return !!user && targetSocket.radioOnline === true && targetSocket.radioChannel === channel &&
    user.activeService === true && user.suspended !== true && user.securityStatus === 'ACTIVE';
}

function radioAdminMembers(channel) {
  const membersByUser = new Map();
  for (const socketId of radioTargets(channel)) {
    if (!radioSocketIsEligible(socketId, channel)) continue;
    const targetSocket = io.sockets.sockets.get(socketId);
    const user = targetSocket ? requireSocketUser(targetSocket) : null;
    if (!user) continue;
    const key = String(user.id);
    let member = membersByUser.get(key);
    if (!member) {
      member = {
        name: clean(user.identity?.fullName || user.name, 160),
        publicCode: clean(user.publicCode, 100),
        rank: rankLabel(user.rank),
        connectionStatus: 'Ù…ØªØµÙ„',
        connections: 0
      };
      membersByUser.set(key, member);
    }
    if (targetSocket.connected) member.connections += 1;
  }
  return [...membersByUser.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function radioAdminChannelList() {
  const directory = radioAdminDirectoryMembers();
  const directoryById = new Map(directory.map((member) => [member.id, member]));
  const main = RADIO_MAIN_CHANNELS.map((channel) => {
    const members = radioAdminMembers(channel.id);
    return {
      id: channel.id,
      name: channel.id,
      description: channel.name,
      frequency: channel.frequency,
      type: 'main',
      memberCount: members.length,
      members
    };
  });
  const custom = normalizeCustomRadioChannels(state.cia_custom_radio_channels)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((channel) => {
      const members = radioAdminMembers(channel.id);
      const allowedMembers = channel.allowedUserIds
        .map((userId) => directoryById.get(String(userId)))
        .filter(Boolean);
      return {
        id: channel.id,
        name: channel.label,
        description: 'Ù…ÙˆØ¬Ø© Ù…Ø®ØµØµØ©',
        frequency: '',
        type: 'custom',
        accessMode: channel.accessMode,
        allowedMembers,
        eligibleMembers: directory,
        memberCount: members.length,
        members
      };
    });
  return [...main, ...custom];
}

function emitRadioAdminState() {
  const channels = radioAdminChannelList();
  for (const targetSocket of io.sockets.sockets.values()) {
    const viewer = requireSocketUser(targetSocket);
    if (targetSocket.radioAdminSubscribed === true && isChief(viewer)) {
      targetSocket.emit('radio:admin:state', { channels });
    }
  }
}

function releaseRadioTransmission(socketId) {
  for (const [channel, talkers] of radioTalkers.entries()) {
    const speaker = talkers.get(socketId);
    if (!speaker) continue;
    talkers.delete(socketId);
    if (talkers.size === 0) radioTalkers.delete(channel);
    emitRadioToChannel(channel, 'radio:state', {
      channel, userCode: speaker.userCode || '', socketId, ptt: false, statusHtml: 'Ø§Ù†ØªÙ‡Ù‰ Ø§Ù„Ø¨Ø«.'
    });
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
      },
      notifyWarningRecipient: (userId, event, payload) => {
        for (const socketId of sessions.get(userId) || []) {
          const targetSocket = io.sockets.sockets.get(socketId);
          if (targetSocket) targetSocket.emit(event, payload);
        }
      }
    });

    registerMobilePushSocket(socket, {
      requireSocketUser,
      isLeadership,
      getUsers: () => state.cia_users,
      getUnits: () => state.cia_battalions,
      store: mobilePushStore,
      transport: mobilePushTransport,
      makeId,
      addAuditLog,
      saveState
    });

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
          ...(isChief(actor) ? { blockedTerms: getSecurityBlockedTerms() } : {}),
          incidents: state.cia_security_incidents
            .filter((incident) => securityIncidentCanBeViewed(incident, actor))
            .slice(0, 300)
            .map((incident) => securityEventForViewer(incident, actor))
            .filter(Boolean),
          unreadSecurityNotifications: counts.unreadSecurity || 0
        };
        socket.emit('security:logs:result', response);
        return ok(cb, response);
      } catch (error) {
        console.error('[BLACK RIDGE] Security center read failed:', error.message);
        return no(cb, 'ØªØ¹Ø°Ø± ØªØ­Ù…ÙŠÙ„ Ø³Ø¬Ù„ Ø§Ù„Ø£Ù…Ù†.');
      }
    });

    socket.on('security:manageBlockedTerm', async (payload, cb) => {
      const actor = requireSocketUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
      if (!isChief(actor)) {
        const incident = recordSecurityEvent({
          actor,
          target: actor,
          action: 'UNAUTHORIZED_DICTIONARY_EDIT',
          type: 'ACCESS_CONTROL',
          level: 3,
          reason: 'ONLY_CIA_CHIEF_CAN_EDIT_PROFANITY_DICTIONARY',
          status: 'BLOCKED'
        });
        await notifySecurityLeadership(incident);
        return no(cb, 'Ø¥Ø¯Ø§Ø±Ø© Ù…Ø¹Ø¬Ù… Ø§Ù„ÙƒÙ„Ù…Ø§Øª Ù…ØªØ§Ø­Ø© Ù„Ù€ CIA CHIEF ÙÙ‚Ø·.');
      }

      const action = String(payload?.action || '').trim().toLowerCase();
      const term = normalizeMessage(String(payload?.term || ''));
      if (!['add', 'remove'].includes(action)) return no(cb, 'Ø§Ø®ØªØ± Ø¥Ø¶Ø§ÙØ© ÙƒÙ„Ù…Ø© Ø£Ùˆ Ø¥Ø²Ø§Ù„ØªÙ‡Ø§.');
      if ([...term].length < 2 || [...term].length > 80 || !/^[\p{L}\p{N}]+(?:[ '\u2019-][\p{L}\p{N}]+)*$/u.test(term)) {
        return no(cb, 'Ø§ÙƒØªØ¨ ÙƒÙ„Ù…Ø© Ø£Ùˆ Ø¹Ø¨Ø§Ø±Ø© Ù…Ù† Ø­Ø±ÙÙŠÙ† Ø¥Ù„Ù‰ 80 Ø­Ø±ÙÙ‹Ø§ØŒ Ù…Ù† Ø¯ÙˆÙ† Ø±Ù…ÙˆØ².');
      }

      const current = getSecurityBlockedTerms();
      const exists = current.includes(term);
      let updated;
      if (action === 'add') {
        if (exists) return ok(cb, { ok: true, action, blockedTerms: current, message: 'Ù‡Ø°Ù‡ Ø§Ù„ÙƒÙ„Ù…Ø© Ù…ÙˆØ¬ÙˆØ¯Ø© Ø¨Ø§Ù„ÙØ¹Ù„ ÙÙŠ Ø§Ù„Ù…Ø¹Ø¬Ù….' });
        if (current.length >= SECURITY_BLOCKED_TERM_LIMIT) return no(cb, 'ÙˆØµÙ„ Ø§Ù„Ù…Ø¹Ø¬Ù… Ø¥Ù„Ù‰ Ø§Ù„Ø­Ø¯ Ø§Ù„Ø£Ù‚ØµÙ‰ Ù„Ù„ÙƒÙ„Ù…Ø§Øª.');
        updated = [...current, term];
      } else {
        if (!exists) return no(cb, 'Ø§Ù„ÙƒÙ„Ù…Ø© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø© ÙÙŠ Ø§Ù„Ù…Ø¹Ø¬Ù….');
        updated = current.filter((entry) => entry !== term);
      }

      state.systemConfig.securityBlockedTerms = updated;
      try {
        await saveState();
      } catch (error) {
        state.systemConfig.securityBlockedTerms = current;
        console.error('[BLACK RIDGE] Failed to save profanity dictionary:', error.message);
        return no(cb, 'ØªØ¹Ø°Ø± Ø­ÙØ¸ Ø§Ù„ØªØºÙŠÙŠØ± ÙÙŠ Ù…Ø¹Ø¬Ù… Ø§Ù„ÙƒÙ„Ù…Ø§Øª.');
      }
      return ok(cb, {
        ok: true,
        action,
        blockedTerms: updated,
        message: action === 'add' ? 'ØªÙ…Øª Ø¥Ø¶Ø§ÙØ© Ø§Ù„ÙƒÙ„Ù…Ø© Ø¥Ù„Ù‰ Ø§Ù„Ù…Ø¹Ø¬Ù….' : 'ØªÙ…Øª Ø¥Ø²Ø§Ù„Ø© Ø§Ù„ÙƒÙ„Ù…Ø© Ù…Ù† Ø§Ù„Ù…Ø¹Ø¬Ù….'
      });
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
      resetProfanityStrikes(target);
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

    socket.on('security:deleteProfanityIncident', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
      if (!isChief(actor)) return no(cb, 'Ø­Ø°Ù Ø³Ø¬Ù„Ø§Øª Ø§Ù„Ù…Ø®Ø§Ù„ÙØ§Øª Ø§Ù„Ù„ÙØ¸ÙŠØ© Ù…ØªØ§Ø­ Ù„Ù„Ù‚Ø§Ø¦Ø¯ ÙÙ‚Ø·.');
      const incident = state.cia_security_incidents.find((item) =>
        item.id === clean(payload?.incidentId, 120) &&
        isProfanitySecurityIncident(item) &&
        !item.securityCenterHiddenAt
      );
      if (!incident) return no(cb, 'Ø³Ø¬Ù„ Ø§Ù„Ù…Ø®Ø§Ù„ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯ Ø£Ùˆ ØºÙŠØ± Ù‚Ø§Ø¨Ù„ Ù„Ù„Ø­Ø°Ù.');
      incident.securityCenterHiddenAt = now();
      incident.securityCenterHiddenBy = actor.id;
      const target = state.cia_users.find((user) => user.id === incident.userId) || null;
      addAuditLog(
        'Ø¥Ø®ÙØ§Ø¡ Ø³Ø¬Ù„ Ù…Ø®Ø§Ù„ÙØ© Ù„ÙØ¸ÙŠØ© Ù…Ù† Ù…Ø±ÙƒØ² Ø§Ù„Ø£Ù…Ù†',
        actor,
        target,
        `incident=${incident.id} // strike=${incident.profanityStrikeCount || 0}/3`
      );
      await saveState();
      emitState();
      return ok(cb, {
        ok: true,
        incidentId: incident.id,
        message: 'ØªÙ… Ø­Ø°Ù Ø³Ø¬Ù„ Ø§Ù„Ù…Ø®Ø§Ù„ÙØ© Ù…Ù† Ù…Ø±ÙƒØ² Ø§Ù„Ø£Ù…Ù† Ù…Ø¹ Ø§Ù„Ø§Ø­ØªÙØ§Ø¸ Ø¨Ø£Ø«Ø± Ø§Ù„Ø¥Ø¬Ø±Ø§Ø¡ ÙÙŠ Ø³Ø¬Ù„ Ø§Ù„ØªØ¯Ù‚ÙŠÙ‚.'
      });
    });

    socket.on('security:deleteOwnManualIncidentReason', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„.');
      if (!isChief(actor)) return no(cb, 'Ø­Ø°Ù Ø£Ø³Ø¨Ø§Ø¨ Ø§Ù„Ø¥ÙŠÙ‚Ø§Ù Ù…ØªØ§Ø­ Ù„Ù„Ù‚Ø§Ø¦Ø¯ ÙÙ‚Ø·.');

      const incident = state.cia_security_incidents.find((item) =>
        item.id === clean(payload?.incidentId, 120) &&
        item.actorId === actor.id &&
        item.type === 'MANUAL_REVIEW' &&
        item.action === 'MEMBER_SUSPENDED' &&
        !item.securityCenterHiddenAt
      );
      if (!incident) return no(cb, 'Ø§Ù„Ø³Ø¨Ø¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯ Ø£Ùˆ Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø­Ø°ÙÙ‡.');

      const target = state.cia_users.find((user) => user.id === incident.userId) || null;
      const originalReason = incident.reason || target?.suspensionReason || '';
      if (!originalReason) return no(cb, 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø³Ø¨Ø¨ Ù…Ø­ÙÙˆØ¸ Ù„Ù‡Ø°Ø§ Ø§Ù„Ø³Ø¬Ù„.');

      incident.reason = '';
      incident.reasonDeletedAt = now();
      incident.reasonDeletedBy = actor.id;
      if (target && target.suspensionReason === originalReason) target.suspensionReason = '';
      addAuditLog(
        'Ø­Ø°Ù Ø³Ø¨Ø¨ Ø¥ÙŠÙ‚Ø§Ù Ø£Ù…Ù†ÙŠ Ù…Ù† Ù…Ø±ÙƒØ² Ø§Ù„Ø£Ù…Ù†',
        actor,
        target,
        `incident=${incident.id} // reason_removed=true`
      );
      await saveState();
      emitState();
      return ok(cb, {
        ok: true,
        incidentId: incident.id,
        message: 'ØªÙ… Ø­Ø°Ù Ø§Ù„Ø³Ø¨Ø¨ Ù…Ù† Ù…Ø±ÙƒØ² Ø§Ù„Ø£Ù…Ù† Ù…Ø¹ Ø§Ù„Ø§Ø­ØªÙØ§Ø¸ Ø¨Ø§Ù„Ø³Ø¬Ù„ Ø§Ù„Ø£Ù…Ù†ÙŠ ÙˆØ£Ø«Ø± Ø§Ù„Ø­Ø°Ù ÙÙŠ Ø³Ø¬Ù„ Ø§Ù„ØªØ¯Ù‚ÙŠÙ‚.'
      });
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

    socket.on('account:characters:login', async (payload, cb) => {
      if (socket.userId) return no(cb, 'Ø³Ø¬Ù‘Ù„ Ø§Ù„Ø®Ø±ÙˆØ¬ Ù…Ù† Ø§Ù„Ø¬Ù„Ø³Ø© Ø§Ù„Ø­Ø§Ù„ÙŠØ© Ø£ÙˆÙ„Ø§Ù‹.');
      const loginName = lower(clean(payload?.loginName, 100));
      const password = String(payload?.password || '');
      const attemptKey = String(socket.handshake?.address || socket.request?.socket?.remoteAddress || socket.id || 'unknown').slice(0, 160);
      const currentAttempts = accountCharacterLoginFailures.get(attemptKey);
      if (currentAttempts && Date.now() - currentAttempts.startedAt >= 15 * 60 * 1000) accountCharacterLoginFailures.delete(attemptKey);
      const activeAttempts = accountCharacterLoginFailures.get(attemptKey);
      if (activeAttempts && activeAttempts.count >= 5) return no(cb, 'Ù…Ø­Ø§ÙˆÙ„Ø§Øª ÙƒØ«ÙŠØ±Ø©. Ø­Ø§ÙˆÙ„ Ù…Ø¬Ø¯Ø¯Ù‹Ø§ Ø¨Ø¹Ø¯ 15 Ø¯Ù‚ÙŠÙ‚Ø©.');

      const account = loginName ? state.cia_accounts.find((item) => lower(item.loginName) === loginName) : null;
      const suppliedDigest = crypto.createHash('sha256').update(password, 'utf8').digest();
      const storedDigest = account ? Buffer.from(String(account.passwordHash || ''), 'hex') : Buffer.alloc(0);
      const passwordMatches = !!account && storedDigest.length === suppliedDigest.length && crypto.timingSafeEqual(storedDigest, suppliedDigest);
      if (!loginName || password.length < 4 || password.length > 4096 || !passwordMatches) {
        const prior = accountCharacterLoginFailures.get(attemptKey);
        accountCharacterLoginFailures.set(attemptKey, { startedAt: prior?.startedAt || Date.now(), count: (prior?.count || 0) + 1 });
        if (accountCharacterLoginFailures.size > 1000) {
          const cutoff = Date.now() - 15 * 60 * 1000;
          for (const [key, value] of accountCharacterLoginFailures) if (value.startedAt < cutoff) accountCharacterLoginFailures.delete(key);
          if (accountCharacterLoginFailures.size > 1000) accountCharacterLoginFailures.delete(accountCharacterLoginFailures.keys().next().value);
        }
        return no(cb, 'Ø§Ø³Ù… Ø§Ù„Ø­Ø³Ø§Ø¨ Ø£Ùˆ ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ØºÙŠØ± ØµØ­ÙŠØ­ÙŠÙ†.');
      }
      accountCharacterLoginFailures.delete(attemptKey);

      if (account.status === 'PENDING_APPROVAL' || (!account.status && account.pendingPrimary)) return no(cb, 'Ø­Ø³Ø§Ø¨Ùƒ Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.');
      if (account.status && account.status !== 'APPROVED') return no(cb, 'Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨ ØºÙŠØ± Ù†Ø´Ø·.');
      const primary = (account.characterId && getUserById(account.characterId)) || state.cia_users.find((user) => user.accountId === account.id && user.characterType !== 'secondary');
      if (!primary || (primary.accountId !== account.id && account.characterId !== primary.id) || primary.suspended === true || primary.securityStatus !== 'ACTIVE' || primary.approved === false) {
        return no(cb, 'ØªØ¹Ø°Ø± ÙØªØ­ Ø§Ù„Ø´Ø®ØµÙŠØ§Øª Ù„Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨.');
      }
      if (primary.serviceApproved === false) return no(cb, 'Ø­Ø³Ø§Ø¨Ùƒ Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„Ø®Ø¯Ù…Ø© Ù…Ù† Ø§Ù„Ù‚ÙŠØ§Ø¯Ø©.');

      markLogin(socket, primary);
      const result = {
        ok: true,
        user: publicUser(primary, primary),
        needsIdentity: primary.identityRequired !== false && !primary.identity,
        serviceApproved: primary.serviceApproved !== false,
        serviceRequired: primary.activeService !== true || primary.serviceApproved === false
      };
      socket.emit('auth:login:result', result);
      if (typeof cb === 'function') cb(result);
      try { await sendNotificationCounts(primary.id); } catch (_error) {}
      emitState();
      return result;
    });

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

    socket.on('social:discord:start', (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø£ÙˆÙ„Ø§Ù‹.');
      const config = getDiscordOAuthConfig();
      if (!config) {
        return no(cb, 'Ø±Ø¨Ø· Discord ØºÙŠØ± Ù…Ù‡ÙŠØ£ Ø¨Ø¹Ø¯. ÙŠØ¬Ø¨ Ø¥Ø¹Ø¯Ø§Ø¯ DISCORD_CLIENT_ID ÙˆDISCORD_CLIENT_SECRET ÙˆDISCORD_REDIRECT_URI Ø¹Ù„Ù‰ Ø§Ù„Ø®Ø§Ø¯Ù….');
      }

      pruneDiscordOAuthStates();
      if (discordOAuthStates.size >= 1000) return no(cb, 'ØªØ¹Ø°Ø± Ø¨Ø¯Ø¡ Ø§Ù„Ø±Ø¨Ø· Ø§Ù„Ø¢Ù†. Ø­Ø§ÙˆÙ„ Ù…Ø±Ø© Ø£Ø®Ø±Ù‰ Ø¨Ø¹Ø¯ Ù‚Ù„ÙŠÙ„.');

      const stateToken = crypto.randomBytes(32).toString('base64url');
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      discordOAuthStates.set(stateToken, {
        userId: actor.id,
        codeVerifier,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        expiresAt: Date.now() + 10 * 60 * 1000
      });

      const authorizationUrl = new URL('https://discord.com/oauth2/authorize');
      authorizationUrl.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: 'identify',
        state: stateToken,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'consent'
      }).toString();
      return ok(cb, { authorizationUrl: authorizationUrl.toString() });
    });

    socket.on('social:contact-name:save', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø£ÙˆÙ„Ø§Ù‹.');

      const contactName = normalizeSocialContactName(payload?.socialContactName);
      if (!contactName) return no(cb, 'Ø§ÙƒØªØ¨ Ø§Ø³Ù… Ø§Ù„ØªÙˆØ§ØµÙ„ Ù‚Ø¨Ù„ Ø§Ù„Ø­ÙØ¸.');

      const previousContactName = actor.socialContactName;
      const previousAuditLogs = Array.isArray(state.cia_audit_logs) ? state.cia_audit_logs.slice() : [];
      actor.socialContactName = contactName;
      addAuditLog('ØªØ­Ø¯ÙŠØ« Ø§Ø³Ù… Ø§Ù„ØªÙˆØ§ØµÙ„', actor, actor, 'ØªÙ… ØªØ­Ø¯ÙŠØ« Ø§Ù„Ø§Ø³Ù… Ø§Ù„Ø¨Ø¯ÙŠÙ„ Ù„Ù„ØªÙˆØ§ØµÙ„ Ù…Ù† Ù…Ù„Ù Ø§Ù„Ø¹Ø¶Ùˆ.');
      try {
        await saveState();
      } catch (_error) {
        actor.socialContactName = previousContactName;
        state.cia_audit_logs = previousAuditLogs;
        return no(cb, 'ØªØ¹Ø°Ø± Ø­ÙØ¸ Ø§Ø³Ù… Ø§Ù„ØªÙˆØ§ØµÙ„ ÙÙŠ Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª. Ù„Ù… ÙŠØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„ØªØºÙŠÙŠØ±.');
      }

      emitState();
      return ok(cb, { socialContactName: actor.socialContactName });
    });

    socket.on('social:accounts:manual', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø£ÙˆÙ„Ø§Ù‹.');

      try {
        const candidate = createManualSocialAccount(payload);
        const duplicateOwner = findDuplicateSocialAccountOwner(state.cia_users, candidate, actor.id);
        if (duplicateOwner) return no(cb, 'Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨ Ø§Ù„Ø®Ø§Ø±Ø¬ÙŠ Ù…Ø±ØªØ¨Ø· Ø¨Ø¹Ø¶ÙˆÙŠØ© Ø£Ø®Ø±Ù‰ Ø¨Ø§Ù„ÙØ¹Ù„.');

        const accounts = normalizeSocialAccounts(actor.socialAccounts);
        const sameIdentity = accounts.find((account) => accountIdentity(account) === accountIdentity(candidate));
        const samePlatform = accounts.find((account) =>
          account.provider === 'manual' &&
          normalizePlatformName(account.platform) === normalizePlatformName(candidate.platform)
        );
        if (sameIdentity && sameIdentity !== samePlatform) {
          return no(cb, 'Ù‡Ø°Ø§ Ø§Ù„Ø­Ø³Ø§Ø¨ Ù…Ø±ØªØ¨Ø· Ø¨Ø§Ù„ÙØ¹Ù„ Ø¨Ù…Ù†ØµØ© Ø£Ø®Ø±Ù‰ ÙÙŠ Ù…Ù„ÙÙƒ.');
        }

        const nextAccounts = upsertSocialAccount(accounts, candidate);
        const previousAccounts = actor.socialAccounts;
        const previousAuditLogs = Array.isArray(state.cia_audit_logs) ? state.cia_audit_logs.slice() : [];
        actor.socialAccounts = nextAccounts;
        addAuditLog('Ø±Ø¨Ø· Ø­Ø³Ø§Ø¨ ØªÙˆØ§ØµÙ„ ÙŠØ¯ÙˆÙŠ', actor, actor, `Ø§Ù„Ù…Ù†ØµØ©: ${candidate.platform} // ØºÙŠØ± Ù…ÙˆØ«Ù‘Ù‚`);
        try {
          await saveState();
        } catch (_error) {
          actor.socialAccounts = previousAccounts;
          state.cia_audit_logs = previousAuditLogs;
          return no(cb, 'ØªØ¹Ø°Ø± Ø­ÙØ¸ Ø­Ø³Ø§Ø¨ Ø§Ù„ØªÙˆØ§ØµÙ„ ÙÙŠ Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª. Ù„Ù… ÙŠØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„ØªØºÙŠÙŠØ±.');
        }
        emitState();
        return ok(cb, { socialAccounts: normalizeSocialAccounts(actor.socialAccounts) });
      } catch (error) {
        return no(cb, error.message || 'ØªØ¹Ø°Ø± Ø±Ø¨Ø· Ø­Ø³Ø§Ø¨ Ø§Ù„ØªÙˆØ§ØµÙ„.');
      }
    });

    socket.on('social:accounts:remove', async (payload, cb) => {
      const actor = requireAuthenticatedUser(socket);
      if (!actor) return no(cb, 'ÙŠØ¬Ø¨ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø£ÙˆÙ„Ø§Ù‹.');
      const accountId = clean(payload?.accountId, 160);
      const accounts = normalizeSocialAccounts(actor.socialAccounts);
      if (!accountId || !accounts.some((account) => account.id === accountId)) {
        return no(cb, 'Ø­Ø³Ø§Ø¨ Ø§Ù„ØªÙˆØ§ØµÙ„ Ø§Ù„Ù…Ø·Ù„ÙˆØ¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯ ÙÙŠ Ù…Ù„ÙÙƒ.');
      }

      const previousAccounts = actor.socialAccounts;
      const previousAuditLogs = Array.isArray(state.cia_audit_logs) ? state.cia_audit_logs.slice() : [];
      actor.socialAccounts = accounts.filter((account) => account.id !== accountId);
      addAuditLog('ÙØµÙ„ Ø­Ø³Ø§Ø¨ ØªÙˆØ§ØµÙ„', actor, actor, 'ØªÙ… ÙØµÙ„ Ø­Ø³Ø§Ø¨ ØªÙˆØ§ØµÙ„ Ù…Ù† Ù…Ù„Ù Ø§Ù„Ø¹Ø¶Ùˆ.');
      try {
        await saveState();
      } catch (_error) {
        actor.socialAccounts = previousAccounts;
        state.cia_audit_logs = previousAuditLogs;
        return no(cb, 'ØªØ¹Ø°Ø± Ø­ÙØ¸ ÙØµÙ„ Ø§Ù„Ø­Ø³Ø§Ø¨ ÙÙŠ Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª. Ù„Ù… ÙŠØªÙ… Ø§Ø¹ØªÙ…Ø§Ø¯ Ø§Ù„ØªØºÙŠÙŠØ±.');
      }
      emitState();
      return ok(cb, { socialAccounts: normalizeSocialAccounts(actor.socialAccounts) });
    });

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
        .filter((user) => user.suspended !== true && !user.separatedAt && user.approved !== false && user.serviceApproved !== false && user.securityStatus === 'ACTIVE')
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

      addAuditLog('Ø¥Ø¯Ø§Ø±Ø© Ø­Ø³Ø§Ø¨ Ø¨Ù†ÙƒÙŠ', actor, tarræ–BÇÂ–ÆöCòç&W÷'D–BÂ#“°¢6öç7BW†—7G2Ò7FFRæ6–÷&W÷'G2ç6öÖR‚‡&W÷'B’Óâ7G&–ær‡&W÷'Bæ–B’ÓÓÒ7G&–ær†–B’“°¢–b‚W†—7G2’&WGW&âæò†6"Â}Š}˜MŠ­˜-‹˜­‹‹­˜­‹˜]˜ŠÍ˜Šòâr“°¢7FFRæ6–÷&W÷'G2Ò7FFRæ6–÷&W÷'G2æf–ÇFW"‚‡&W÷'B’Óâ7G&–ær‡&W÷'Bæ–B’ÓÒ7G&–ær†–B’“°¢FDVF—DÆör‚}Šİ‹˜Š­˜-‹˜­‹rÂ7F÷"ÂçVÆÂÂŠ­˜RŠİ‹˜Š}˜MŠ­˜-‹˜­‹G¶–GÒæ“°¢6fU7FFR‚“°¢VÖ—E7FFR‚“°¢&WGW&âö²†6"Â²–BÒ“°¢Ò“° ¢6ö6¶WBæöâ‚vGWG“§7F'BrÂ‡–ÆöBÂ6"’Óâ°¢6öç7B7F÷"Ò&WV—&TWF†VçF–6FVEW6W"‡6ö6¶WB“°¢–b‚7F÷"’&WGW&âæò†6"Â}˜­ŠÍŠ‚Š­‹=ŠÍ˜­˜BŠ}˜MŠıŠí˜˜Bâr“°¢–b†7F÷"ç6W'f–6T&÷fVBÓÒG'VR’°¢&WGW&âæò†6"Â}˜­˜M‹-˜R˜-Š˜˜BŠ}˜M‹MŠí‹]˜­Š’˜Š}‹Š­˜]Š}ŠòŠ}˜M˜}˜˜­Š’˜‹}˜MŠ‚ŠıŠí˜˜BŠ}˜MŠíŠı˜]Š’˜-Š˜B˜]ŠŠ}‹M‹Š’Š}˜MŠíŠı˜]Š’âr“°¢Ğ¢–b‚7F÷"çV&Æ–46öFRbb—4ÆVFW'6†—†7F÷"’’°¢&WGW&âæò†6"Â}˜M˜R˜­‹]Šı‹Š}˜M˜=˜ŠòŠ}˜M‹‹=˜=‹˜¢Š‹Šı‰²Š}‹}˜MŠ‚˜]˜b4”4„”TbŠ]˜=˜]Š}˜BŠ}‹Š­˜]Š}ŠòŠıŠí˜˜BŠ}˜MŠíŠı˜]Š’âr“°¢Ğ¢–b†7F÷"æ7F—fU6W'f–6RÓÓÒG'VR’°¢&WGW&âö²†6"Â²GFVæFæ6S¢çVÆÂÂW6W#¢V&Æ–5W6W"†7F÷"Â7F÷"’Ò“°¢Ğ¢6öç7BF”¶W’Òæ÷r‚’ç6Æ–6RƒÂ“°¢6öç7B7W'&VçBÒ‡7FFRæ6–öGFVæFæ6RÇÂµÒ’æf–æB€¢†—FVÒ’Óâ—FVÒçW6W$–BÓÓÒ7F÷"æ–Bbb—FVÒæF”¶W’ÓÓÒF”¶W’bb—FVÒæVæFVD@¢“°¢–b†7W'&VçB’°¢7F÷"æ7F—fU6W'f–6RÒG'VS°¢7F÷"æöæÆ–æRÒG'VS°¢7F÷"ç7FGW2Ò}˜˜¢Š}˜MŠíŠı˜]Š’s°¢6fU7FFR‚“°¢VÖ—E7FFR‚“°¢&WGW&âö²†6"Â²GFVæFæ6S¢7W'&VçBÂW6W#¢V&Æ–5W6W"†7F÷"Â7F÷"’Ò“°¢Ğ¢6öç7BGFVæFæ6RÒ°¢–C¢Ö¶T–B‚tEUE’r’À¢W6W$–C¢7F÷"æ–BÀ¢W6W$6öFS¢7F÷"çV&Æ–46öFRÀ¢W6W$æÖS¢7F÷"ææÖRÀ¢F”¶W’À¢7F'FVDC¢æ÷r‚’À¢VæFVDC¢çVÆÂÀ¢6Æ'•–C¢fÇ6P¢Ó°¢7FFRæ6–öGFVæFæ6RçVç6†–gB†GFVæFæ6R“°¢7F÷"æ7F—fU6W'f–6RÒG'VS°¢7F÷"æöæÆ–æRÒG'VS°¢7F÷"ç7FGW2Ò}˜˜¢Š}˜MŠíŠı˜]Š’s°¢6fU7FFR‚“°¢VÖ—E7FFR‚“°¢&WGW&âö²†6"Â²GFVæFæ6RÂW6W#¢V&Æ–5W6W"†7F÷"Â7F÷"’Ò“°¢Ò“° ¢6ö6¶WBæöâ‚vGWG“¦VæBrÂ‡–ÆöBÂ6"’Óâ°¢6öç7B7F÷"Ò&WV—&TWF†VçF–6FVEW6W"‡6ö6¶WB“°¢–b‚7F÷"’&WGW&âæò†6"Â}˜­ŠÍŠ‚Š­‹=ŠÍ˜­˜BŠ}˜MŠıŠí˜˜Bâr“°¢6öç7B7W'&VçBÒ‡7FFRæ6–öGFVæFæ6RÇÂµÒ’æf–æB€¢†—FVÒ’Óâ—FVÒçW6W$–BÓÓÒ7F÷"æ–Bbb—FVÒæVæFVD@¢“°¢–b†7W'&VçB’7W'&VçBæVæFVDBÒæ÷r‚“°¢&VÖ÷fUW6W%&F–ôÖVÖ&W'2†7F÷"æ–B“°¢7F÷"ç&F–ôöæÆ–æRÒfÇ6S°¢7F÷"æ7F—fU6W'f–6RÒfÇ6S°¢7F÷"ç7FGW2Ò}ŠíŠ}‹ŠÂŠ}˜MŠíŠı˜]Š’s°¢6fU7FFR‚“°¢VÖ—E7FFR‚“°¢&WGW&âö²†6"Â²GFVæFæ6S¢7W'&VçBÂW6W#¢V&Æ–5W6W"†7F÷"Â7F÷"’Ò“°¢Ò“° ¢6ö6¶WBæöâ‚v÷W&F–öã§WFFU7FGW2rÂ7–æ2‡–ÆöBÂ6"’Óâ°¢6öç7B7F÷"Ò&WV—&U6ö6¶WEW6W"‡6ö6¶WB“°¢–b‚7F÷"’&WGW&âæò†6"Â6ö6¶WE&WV—&VÖVçDÖW76vR‡6ö6¶WB’“°¢6öç7B–BÒ6ÆVâ‡–ÆöCòæ÷W&F–öä–BÇÂ–ÆöCòæ–BÂ#“°¢6öç7B÷W&F–öâÒ7FFRæ6–ö÷W&F–öç2æf–æB‚†—FVÒ’Óâ7G&–ær†—FVÒæ–B’ÓÓÒ7G&–ær†–B’“°¢–b‚÷W&F–öâ’&WGW&âæò†6"Â}Š}˜M˜]˜}˜]Š’‹­˜­‹˜]˜ŠÍ˜ŠıŠ’âr“°¢–b‚6äÖævT÷W&F–öç2†7F÷"’’°¢&WGW&âæò†6"Â}Š­ŠİŠı˜­Š²Š}˜M˜]˜}˜]Š’˜]Š­Š}ŠÒ˜M˜M‹Š­Š‚Š}˜M‹˜M˜­ŠrŠ}˜MŠ½˜MŠ}Š²˜˜-‹râr“°¢Ğ¢6öç7B&Wf–÷W57FGW2Ò÷W&F–öâç7FGW3°¢÷W&F–öâç7FGW2Ò6ÆVâ‡–ÆöCòç7FGW2Â’ÇÂ÷W&F–öâç7FGW3°¢FD÷W&F–öå7FGW4†—7F÷'’†÷W&F–öâÂ7F÷"Â&Wf–÷W57FGW2“°¢÷W&F–öâçWFFVDBÒæ÷r‚“°¢6fU7FFR‚“°¢v—BV&Æ—6„æ÷F–f–6F–öç2‡7FFRæ6–÷W6W'2Â°¢G—S¢tõU$D”ôârÀ¢F—FÆS¢tõU$D”ôâ5DEU24„ätRrÀ¢ÖW76vS¢Š­‹­˜­‹Š¢ŠİŠ}˜MŠ’Š}˜M‹˜]˜M˜­Š’G¶÷W&F–öâæÖ—76–öäçVÖ&W'Ó¢G·&Wf–÷W57FGW7Ò(iG¶÷W&F–öâç7FGW7ÒæÀ¢&–÷&—G“¢÷W&F–öâç&—6²ÓÓÒt„”t‚rÇÂ÷W&F–öâç&—6²ÓÓÒt5$•D”4Âròt„”t‚r¢täõD”4RrÀ¢6÷W&6UW6W$–C¢7F÷"æ–BÀ¢&VÆFVD–C¢÷W&F–öâæ–BÀ¢ÖVÖ&W$6öFW3¢÷W&F–öâæÖVÖ&W$6öFW2À¢ÖWFFF¢²Ö—76–öäçVÖ&W#¢÷W&F–öâæÖ—76–öäçVÖ&W"Â7FGW3¢÷W&F–öâç7FGW2Â&—6³¢÷W&F–öâç&—6²Ğ¢Ò“°¢VÖ—D÷W&F–öå7FFR‚“°¢&WGW&âö²†6"Â²÷W&F–öã¢÷W&F–öå6æ—F—¦R†÷W&F–öâÂ7F÷"’Ò“°¢Ò“° ¢6ö6¶WBæöâ‚v6†C§6VæBrÂ7–æ2‡–ÆöBÂ6"’Óâ°¢6öç7B7F÷"Ò&WV—&U6ö6¶WEW6W"‡6ö6¶WB“°¢–b‚7F÷"’&WGW&âæò†6"Â}˜­ŠÍŠ‚Š­‹=ŠÍ˜­˜BŠ}˜MŠıŠí˜˜Bâr“°¢6öç7BÖöFRÒ–ÆöCòæÖöFRÓÓÒw&—fFRròw&—fFRr¢vvÆö&Âs°¢6öç7BFW‡BÒ6ÆVâ‡–ÆöCòçFW‡BÇÂ–ÆöCòæÖW76vRÂC“°¢6öç7B–ÖvRÒ6ÆVâ‡–ÆöCòæ–ÖvRÂ‚¢#B¢#B“°¢–b‚FW‡Bbb–ÖvR’&WGW&âæò†6"Â}Š}˜M‹‹=Š}˜MŠ’˜Š}‹‹­Š’âr“°¢6öç7BÖöFW&F–öâÒFW‡@¢òv—BÖöFW&FT÷WFvö–æuFW‡B†7F÷"ÂFW‡BÂÖöFRÓÓÒw&—fFRròu$•dDUô4„Br¢t4„Br¢¢fÇ6S°¢–b†ÖöFW&F–öâ’°¢&WGW&âæò†6"ÂÖöFW&F–öâæÖW76vRÇÂ}Š­˜RŠİ‹‹Š}˜M‹‹=Š}˜MŠ’Š˜Š}‹=‹}Š’˜]‹˜=‹"Š}˜MŠ=˜]˜bâr“°¢Ğ ¢6öç7BÖW76vRÒ°¢–C¢Ö¶T–B†ÖöFRÓÓÒw&—fFRròu4„Br¢t4„Br’À¢6VæFW$6öFS¢7F÷"çV&Æ–46öFRÀ¢6VæFW$æÖS¢7F÷"ææÖRÀ¢g&öÔ6öFS¢7F÷"çV&Æ–46öFRÀ¢g&öÔæÖS¢7F÷"ææÖRÀ¢F&vWD6öFS¢6ÆVâ‡–ÆöCòçF&vWD6öFRÂ’À¢FW‡BÀ¢–ÖvRÀ¢F–ÖW7F×¢æ÷r‚’À¢C¢æ÷r‚¢Ó°¢ÆWB&—fFU&V6—–VçBÒçVÆÃ°¢–b†ÖöFRÓÓÒw&—fFRr’°¢6öç7BF&vWBÒvWEW6W$'•V&Æ–46öFR†ÖW76vRçF&vWD6öFR“°¢–b‚F&vWB’&WGW&âæò†6"Â}Š}˜M˜]‹=Š­ŠíŠı˜RŠ}˜M˜]‹=Š­˜}Šı˜‹­˜­‹˜]˜ŠÍ˜Šòâr“°¢&—fFU&V6—–VçBÒF&vWC°¢6öç7B¶W’Ò6†D¶W’†7F÷"çV&Æ–46öFRÂF&vWBçV&Æ–46öFR“°¢7FFRæ6–ö6†G2ç&—fFU¶¶W•ÒÒ7FFRæ6–ö6†G2ç&—fFU¶¶W•ÒÇÂµÓ°¢7FFRæ6–ö6†G2ç&—fFU¶¶W•ÒçW6‚†ÖW76vR“°¢7FFRæ6–ö6†G2ç&—fFU¶¶W•ÒÒ7FFRæ6–ö6†G2ç&—fFU¶¶W•Òç6Æ–6R‚ÓS“°¢6öç7BF&vWG2ÒæWr6WB…²âââ‡6W76–öç2ævWB†7F÷"æ–B’ÇÂµÒ’Ââââ‡6W76–öç2ævWB‡F&vWBæ–B’ÇÂµÒ•Ò“°¢f÷"†6öç7B6ö6¶WD–BöbF&vWG2’°¢6öç7BF&vWE6ö6¶WBÒ–òç6ö6¶WG2ç6ö6¶WG2ævWB‡6ö6¶WD–B“°¢–b‡F&vWE6ö6¶WB’F&vWE6ö6¶WBæVÖ—B‚v6†C§&—fFRrÂÖW76vR“°¢Ğ¢ÒVÇ6R°¢7FFRæ6–ö6†G2ævÆö&ÂçW6‚†ÖW76vR“°¢7FFRæ6–ö6†G2ævÆö&ÂÒ7FFRæ6–ö6†G2ævÆö&Âç6Æ–6R‚Ó“°¢–òæVÖ—B‚v6†C¦vÆö&ÂrÂÖW76vR“°¢Ğ¢6fU7FFR‚“°¢–b‡&—fFU&V6—–VçBbb&—fFU&V6—–VçBæ–BÓÒ7F÷"æ–B’°¢v—BV&Æ—6„æ÷F–f–6F–öç2…·&—fFU&V6—–VçEÒÂ°¢G—S¢tÔU54tRrÀ¢F—FÆS¢täUrÔU54tRrÀ¢ÖW76vS¢˜‹]˜MŠ­˜2‹‹=Š}˜MŠ’ŠíŠ}‹]Š’˜]˜bG¶7F÷"çV&Æ–46öFRÇÂtvVçBwÒæÀ¢&–÷&—G“¢täõD”4RrÀ¢6÷W&6UW6W$–C¢7F÷"æ–BÀ¢F&vWEW6W$–C¢&—fFU&V6—–VçBæ–BÀ¢6÷W&6TæÖUf—6–&ÆS¢G'VRÀ¢&VÆFVD–C¢ÖW76vRæ–BÀ¢ÖWFFF¢²6VæFW$6öFS¢7F÷"çV&Æ–46öFRĞ¢Ò“°¢Ğ¢VÖ—E7FFR‚“°¢&WGW&âö²†6"Â²ÖW76vRÒ“°¢Ò“° ¢6ö6¶WBæöâ‚v6†C¦FVÆWFRrÂ‡–ÆöBÂ6"’Óâ°¢6öç7B7F÷"Ò&WV—&U6ö6¶WEW6W"‡6ö6¶WB“°¢–b‚7F÷"’&WGW&âæò†6"Â}˜­ŠÍŠ‚Š­‹=ŠÍ˜­˜BŠ}˜MŠıŠí˜˜Bâr“°¢6öç7BÖW76vT–BÒ6ÆVâ‡–ÆöCòæÖW76vT–BÇÂ–ÆöCòæ–BÂ#“°¢6öç7BFÖ–âÒ–ÆöCòæFÖ–âÓÓÒG'VS°¢–b†FÖ–âbb—4ÆVFW'6†—†7F÷"’’&WGW&âæò†6"Â}˜MŠrŠ­˜]˜M˜2‹]˜MŠ}Šİ˜­Š’Š}˜MŠİ‹˜Š}˜MŠ]ŠıŠ}‹˜¢âr“°¢ÆWB&VÖ÷fVBÒfÇ6S°¢–b‡–ÆöCòæÖöFRÓÓÒw&—fFRr’°¢f÷"†6öç7B¶W’öbö&¦V7Bæ¶W—2‡7FFRæ6–ö6†G2ç&—fFRÇÂ·Ò’’°¢6öç7B&Vf÷&RÒ7FFRæ6–ö6†G2ç&—fFU¶¶W•ÒæÆVæwFƒ°¢7FFRæ6–ö6†G2ç&—fFU¶¶W•ÒÒ7FFRæ6–ö6†G2ç&—fFU¶¶W•Òæf–ÇFW"€¢†ÖW76vR’Óâ7G&–ær†ÖW76vRæ–B’ÓÒ7G&–ær†ÖW76vT–B’ÇÀ¢‚FÖ–âbbÖW76vRç6VæFW$6öFRÓÒ7F÷"çV&Æ–46öFR¢“°¢&VÖ÷fVBÒ&VÖ÷fVBÇÂ&Vf÷&RÓÒ7FFRæ6–ö6†G2ç&—fFU¶¶W•ÒæÆVæwFƒ°¢Ğ¢ÒVÇ6R°¢6öç7B&Vf÷&RÒ7FFRæ6–ö6†G2ævÆö&ÂæÆVæwFƒ°¢7FFRæ6–ö6†G2ævÆö&ÂÒ7FFRæ6–ö6†G2ævÆö&Âæf–ÇFW"€¢†ÖW76vR’Óâ7G&–ær†ÖW76vRæ–B’ÓÒ7G&–ær†ÖW76vT–B¢“°¢&VÖ÷fVBÒ&Vf÷&RÓÒ7FFRæ6–ö6†G2ævÆö&ÂæÆVæwFƒ°¢Ğ¢–b‚&VÖ÷fVB’&WGW&âæò†6"Â}Š}˜M‹‹=Š}˜MŠ’‹­˜­‹˜]˜ŠÍ˜ŠıŠ’Š=˜‚˜MŠrŠ­˜]˜M˜2‹]˜MŠ}Šİ˜­Š’Šİ‹˜˜}Šrâr“°¢6fU7FFR‚“°¢VÖ—E7FFR‚“°¢&WGW&âö²†6"Â²–C¢ÖW76vT–BÒ“°¢Ò“° ¢6ö6¶WBæöâ‚w7W÷'C§6VæBrÂ7–æ2‡–ÆöBÂ6"’Óâ°¢6öç7B7F÷"Ò&WV—&TWF†VçF–6FVEW6W"‡6ö6¶WB“°¢6öç7B6VæFW$æÖRÒ7F÷ ¢ò7F÷"ææÖP¢¢6ÆVâ‡–ÆöCòææÖRÇÂ–ÆöCòæ6†&7FW$æÖRÇÂ}‹MŠí‹]˜­Š’‹­˜­‹˜]‹Š­˜]ŠıŠ’rÂ#“°¢6öç7BFW‡BÒ6ÆVâ‡–ÆöCòçFW‡BÇÂ–ÆöCòæÖW76vRÂ3“°¢–b‚FW‡B’&WGW&âæò†6"Â}Š}˜=Š­Š‚Š}˜MŠ}‹=Š­˜‹=Š}‹Š=˜˜MŠ}˜²âr“°¢6öç7BÖöFW&F–öâÒv—BÖöFW&FT÷WFvö–æuFW‡B†7F÷"ÂFW‡BÂu5Uõ%Br“°¢–b†ÖöFW&F–öâ’°¢&WGW&âæò†6"ÂÖöFW&F–öâæÖW76vRÇÂ}Š­˜RŠİ‹‹Š}˜MŠ}‹=Š­˜‹=Š}‹Š˜Š}‹=‹}Š’˜]‹˜=‹"Š}˜MŠ=˜]˜bâr“°¢Ğ ¢ÆWBF‡&VD–BÒ6ÆVâ‡–ÆöCòçF‡&VD–BÂ#“°¢ÆWB÷væW%Fö¶VâÒ6ÆVâ‡–ÆöCòæ÷væW%Fö¶VâÂ#“°¢ÆWB÷&–v–æÂÒçVÆÃ°¢–b‡F‡&VD–B’°¢÷&–v–æÂÒ7FFRæ6–÷7W÷'Bæf–æB‚†—FVÒ’Óâ—FVÒçF‡&VD–BÓÓÒF‡&VD–Bbb—FVÒç&WÇ’ÓÒG'VR“°¢6öç7B7WÆ–VD†6‚Ò÷væW%Fö¶Và¢ò7'—Fòæ7&VFT†6‚‚w6†#Sbr’çWFFR†÷væW%Fö¶Vâ’æF–vW7B‚v†W‚r¢¢rs°¢–b‚÷&–v–æÃòæ÷væW%Fö¶Vä†6‚ÇÂ7WÆ–VD†6‚ÓÒ÷&–v–æÂæ÷væW%Fö¶Vä†6‚’°¢&WGW&âæò†6"Â}Š­‹‹‹Š]Š½ŠŠ}Š¢˜]˜M˜=˜­Š’˜]ŠİŠ}ŠıŠ½Š’Š}˜MŠ}‹=Š­˜‹=Š}‹âr“°¢Ğ¢ÒVÇ6R°¢F‡&VD–BÒD…$TBÒG¶7'—Fòç&æFöÔ'—FW2ƒ#B’çFõ7G&–ær‚v†W‚r—Ö°¢÷væW%Fö¶VâÒ7'—Fòç&æFöÔ'—FW2ƒ3"’çFõ7G&–ær‚v†W‚r“°¢Ğ ¢6öç7BÖW76vRÒ°¢–C¢Ö¶T–B‚u5Uõ%Br’À¢F‡&VD–BÀ¢6VæFW$6öFS¢7F÷#òçV&Æ–46öFRÇÂrrÀ¢6VæFW$æÖRÀ¢6VæFW%&æ³¢7F÷"ò&æ´Æ&VÂ†7F÷"ç&æ²’¢tvVçB˜-˜­ŠòŠ}˜MŠ}‹Š­˜]Š}ŠòrÀ¢FW‡BÀ¢C¢æ÷r‚’À¢&WÇ“¢fÇ6RÀ¢÷væW%W6W$–C¢÷&–v–æÃòæ÷væW%W6W$–BÇÂ7F÷#òæ–BÇÂçVÆÂÀ¢âââ‚÷&–v–æÂò°¢÷væW%Fö¶Vä†6ƒ¢7'—Fòæ7&VFT†6‚‚w6†#Sbr’çWFFR†÷væW%Fö¶Vâ’æF–vW7B‚v†W‚r¢Ò¢·Ò¢Ó°¢7W÷'EF‡&VE6ö6¶WG2ç6WB†ÖW76vRçF‡&VD–BÂ6ö6¶WBæ–B“°¢7FFRæ6–÷7W÷'BçW6‚†ÖW76vR“°¢7FFRæ6–÷7W÷'BÒ7FFRæ6–÷7W÷'Bç6Æ–6R‚ÓS“°¢6fU7FFR‚“° ¢f÷"†6öç7BF&vWE6ö6¶WBöb–òç6ö6¶WG2ç6ö6¶WG2çfÇVW2‚’’°¢6öç7BF&vWEW6W"ÒF&vWE6ö6¶WBçW6W$–BòvWEW6W$'”–B‡F&vWE6ö6¶WBçW6W$–B’¢çVÆÃ°¢–b‡F&vWEW6W"bb—4ÆVFW'6†—‡F&vWEW6W"’’°¢F&vWE6ö6¶WBæVÖ—B‚w7W÷'C¦ÖW76vRrÂÖW76vR“°¢Ğ¢Ğ¢&WGW&âö²†6"Â²ÖW76vRÂF‡&VD–C¢ÖW76vRçF‡&VD–BÂ÷væW%Fö¶VâÒ“°¢Ò“° ¢6ö6¶WBæöâ‚w7W÷'C¦†—7F÷'’rÂ‡–ÆöBÂ6"’Óâ°¢6öç7BF‡&VD–BÒ6ÆVâ‡–ÆöCòçF‡&VD–BÂ#“°¢6öç7B÷væW%Fö¶VâÒ6ÆVâ‡–ÆöCòæ÷væW%Fö¶VâÂ#“°¢6öç7B÷&–v–æÂÒ7FFRæ6–÷7W÷'Bæf–æB‚†—FVÒ’Óâ—FVÒçF‡&VD–BÓÓÒF‡&VD–Bbb—FVÒç&WÇ’ÓÒG'VR“°¢6öç7B7WÆ–VD†6‚Ò÷væW%Fö¶Và¢ò7'—Fòæ7&VFT†6‚‚w6†#Sbr’çWFFR†÷væW%Fö¶Vâ’æF–vW7B‚v†W‚r¢¢rs°¢–b‚÷&–v–æÃòæ÷væW%Fö¶Vä†6‚ÇÂ7WÆ–VD†6‚ÓÒ÷&–v–æÂæ÷væW%Fö¶Vä†6‚’°¢&WGW&âæò†6"Â}Š­‹‹‹Š]Š½ŠŠ}Š¢˜]˜M˜=˜­Š’˜]ŠİŠ}ŠıŠ½Š’Š}˜MŠ}‹=Š­˜‹=Š}‹âr“°¢Ğ¢7W÷'EF‡&VE6ö6¶WG2ç6WB‡F‡&VD–BÂ6ö6¶WBæ–B“°¢6öç7BÖW76vW2Ò7FFRæ6–÷7W÷'Bæf–ÇFW"‚†—FVÒ’Óâ—FVÒçF‡&VD–BÓÓÒF‡&VD–B“°¢&WGW&âö²†6"Â²F‡&VD–BÂÖW76vW2Ò“°¢Ò“° ¢6ö6¶WBæöâ‚w7W÷'C§&WÇ’rÂ7–æ2‡–ÆöBÂ6"’Óâ°¢6öç7B7F÷"Ò&WV—&U6ö6¶WEW6W"‡6ö6¶WB“°¢–b‚7F÷"ÇÂ—4ÆVFW'6†—†7F÷"’’°¢&WGW&âæò†6"Â}Š}˜M‹Šò‹˜M˜’Š}‹=Š­˜‹=Š}‹Š}Š¢Š}˜MŠ}‹Š­˜]Š}Šò˜]Š­Š}ŠÒ˜M˜M˜-Š}ŠmŠò˜…6Væ–÷"6öÖÖæFW"4”˜˜-‹râr“°¢Ğ¢6öç7BFW‡BÒ6ÆVâ‡–ÆöCòçFW‡BÇÂ–ÆöCòæÖW76vRÂ3“°¢6öç7BF‡&VD–BÒ6ÆVâ‡–ÆöCòçF‡&VD–BÂ#“°¢–b‚FW‡BÇÂF‡&VD–B’&WGW&âæò†6"Â}Š˜­Š}˜mŠ}Š¢Š}˜M‹Šò‹­˜­‹˜]˜=Š­˜]˜MŠ’âr“°¢6öç7BÖöFW&F–öâÒv—BÖöFW&FT÷WFvö–æuFW‡B†7F÷"ÂFW‡BÂu5Uõ%Eõ$UÅ’r“°¢–b†ÖöFW&F–öâ’°¢&WGW&âæò†6"ÂÖöFW&F–öâæÖW76vRÇÂ}Š­˜RŠİ‹‹Š}˜M‹ŠòŠ˜Š}‹=‹}Š’˜]‹˜=‹"Š}˜MŠ=˜]˜bâr“°¢Ğ¢6öç7B÷&–v–æÂÒ7FFRæ6–÷7W÷'Bæf–æB‚†—FVÒ’Óâ—FVÒçF‡&VD–BÓÓÒF‡&VD–Bbb—FVÒç&WÇ’ÓÒG'VR“°¢–b‚÷&–v–æÂ’&WGW&âæò†6"Â}˜]ŠİŠ}ŠıŠ½Š’Š}˜MŠ}‹=Š­˜‹=Š}‹‹­˜­‹˜]˜ŠÍ˜ŠıŠ’âr“°¢6öç7BÖW76vRÒ°¢–C¢Ö¶T–B‚u5Uõ%Br’À¢F‡&VD–BÀ¢6VæFW$6öFS¢7F÷"çV&Æ–46öFRÀ¢6VæFW$æÖS¢7F÷"ææÖRÀ¢6VæFW%&æ³¢&æ´Æ&VÂ†7F÷"ç&æ²’À¢FW‡BÀ¢C¢æ÷r‚’À¢&WÇ“¢G'VP¢Ó°¢7FFRæ6–÷7W÷'BçW6‚†ÖW76vR“°¢7FFRæ6–÷7W÷'BÒ7FFRæ6–÷7W÷'Bç6Æ–6R‚ÓS“°¢6fU7FFR‚“°¢f÷"†6öç7BF&vWE6ö6¶WBöb–òç6ö6¶WG2ç6ö6¶WG2çfÇVW2‚’’°¢6öç7BF&vWEW6W"ÒF&vWE6ö6¶WBçW6W$–BòvWEW6W$'”–B‡F&vWE6ö6¶WBçW6W$–B’¢çVÆÃ°¢–b‡F&vWEW6W"bb—4ÆVFW'6†—‡F&vWEW6W"’’F&vWE6ö6¶WBæVÖ—B‚w7W÷'C¦ÖW76vRrÂÖW76vR“°¢Ğ¢6öç7B&WVW7FW$–G2ÒæWr6WB‚“°¢–b†÷&–v–æÂæ÷væW%W6W$–B’°¢f÷"†6öç7B6ö6¶WD–Böb6W76–öç2ævWB†÷&–v–æÂæ÷væW%W6W$–B’ÇÂµÒ’&WVW7FW$–G2æFB‡6ö6¶WD–B“°¢Ğ¢6öç7B7F—fT÷væW%6ö6¶WBÒ7W÷'EF‡&VE6ö6¶WG2ævWB‡F‡&VD–B“°¢–b†7F—fT÷væW%6ö6¶WB’&WVW7FW$–G2æFB†7F—fT÷væW%6ö6¶WB“°¢f÷"†6öç7B6ö6¶WD–Böb&WVW7FW$–G2’°¢6öç7B&WVW7FW%6ö6¶WBÒ–òç6ö6¶WG2ç6ö6¶WG2ævWB‡6ö6¶WD–B“°¢–b‡&WVW7FW%6ö6¶WB’&WVW7FW%6ö6¶WBæVÖ—B‚w7W÷'C§&—fFR×&WÇ’rÂ²F‡&VD–BÂÖW76vRÒ“°¢Ğ¢&WGW&âö²†6"Â²ÖW76vRÒ“°¢Ò“° ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢D•44ôääT5@¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¢6ö6¶WBæöâ€¢vF—66öææV7BrÀ¢‚’Óâ°¢&F–ô–6T6öæf–t66†RæFVÆWFR‡6ö6¶WBæ–B“°¢&VÆV6U&F–õG&ç6Ö—76–öâ‡6ö6¶WBæ–B“°¢&VÖ÷fU&F–ôÖVÖ&W"€¢6ö6¶WBæ–@¢“° ¢Ö&´Æöv÷WB‡6ö6¶WB“°¢Ğ¢“°¢Ğ¢“° ¦–òæöâ‚v6öææV7F–öârÂ‡6ö6¶WB’Óâ°¢6ö6¶WBæöâ‚v''s¦–çFVÆÆ–vVæ6S¦÷fW'f–WrrÂ‡–ÆöBÂ6ÆÆ&6²’Óâ°¢6öç7B&WÇ’ÒG—Vöb6ÆÆ&6²ÓÓÒvgVæ7F–öârò6ÆÆ&6²¢‚’Óâ·Ó°¢6öç7B7F÷"Ò&WV—&U6ö6¶WEW6W"‡6ö6¶WB“°¢–b‚7F÷"’&WGW&â&WÇ’‡²ö³¢fÇ6RÂÖW76vS¢tWF†VçF–6F–öâ—2&WV—&VBFòf–Wr–çFVÆÆ–vVæ6RârÒ“°¢6öç7B&æ²Ò&æ´ÆWfVÂ†7F÷"ç&æ²“°¢6öç7B6Væ–÷"Ò—46†–Vb†7F÷"’ÇÂ—56Væ–÷"†7F÷"“°¢6öç7B7F÷$6öFRÒ6ÆVâ†7F÷"çV&Æ–46öFRÂ’çFõWW$66R‚“°¢6öç7BÆÅVæ—G2Ò'&’æ—4'&’‡7FFRæ6–ö&GFÆ–öç2’ò7FFRæ6–ö&GFÆ–öç2¢µÓ°¢6öç7BVæ—D–å66÷RÒ‡Væ—B’Óâ°¢–b‚Væ—B’&WGW&âfÇ6S°¢–b‡6Væ–÷"’&WGW&âG'VS°¢–b‚7F÷$6öFR’&WGW&âfÇ6S°¢6öç7BÖVÖ&W'2Ò'&’æ—4'&’‡Væ—BæÖVÖ&W$6öFW2’òVæ—BæÖVÖ&W$6öFW2¢µÓ°¢6öç7BÖVÖ&W$ÖF6‚ÒÖVÖ&W'2ç6öÖR‚†6öFR’Óâ6ÆVâ†6öFRÂ’çFõWW$66R‚’ÓÓÒ7F÷$6öFR“°¢–b†ÖVÖ&W$ÖF6‚ÇÂ6ÆVâ‡Væ—Bæ6öÖÖæFW$6öFRÂ’çFõWW$66R‚’ÓÓÒ7F÷$6öFR’&WGW&âG'VS°¢&WGW&â&æ²ãÒ"bb·Væ—Bæ6öÖÖæFW$6öFRÂVæ—Bç6Væ–÷$6öÖÖæFW$6öFUÒç6öÖR‚†6öFR’Óâ6ÆVâ†6öFRÂ’çFõWW$66R‚’ÓÓÒ7F÷$6öFR“°¢Ó°¢6öç7Bf—6–&ÆUVæ—G2ÒÆÅVæ—G2æf–ÇFW"‚‡Væ—B’ÓâVæ—Bbb7G&–ær‡Væ—Bç7FGW2ÇÂrr’çFõWW$66R‚’ÓÒt$4„•dTBrbbVæ—D–å66÷R‡Væ—B’“°¢6öç7Bf—6–&ÆUVæ—D–G2ÒæWr6WB‡f—6–&ÆUVæ—G2æÖ‚‡Væ—B’Óâ7G&–ær‡Væ—Bæ–B’’“°¢6öç7B6Æ76–f–6F–öä÷&FW"Ò²uT$Ä”2rÂt”åDU$äÂrÂt4ôäd”DTåD”ÂrÂu4T5$UBrÂuDõ4T5$UBuÓ°¢6öç7B6Æ76–f–6F–öäÆWfVÂÒ²T$Ä”3¢Â”åDU$äÃ¢Â4ôäd”DTåD”Ã¢"Â4T5$UC¢2ÂuDõ4T5$UBs¢BÓ°¢6öç7B6ÆV&æ6RÒ—46†–Vb†7F÷"’òB¢—56Væ–÷"†7F÷"’ò2¢ÖF‚æÖ–âƒ"Â&æ²“°¢6öç7B6Æ76–f–6F–öç2Ò6Æ76–f–6F–öä÷&FW"æf–ÇFW"‚‡fÇVR’Óâ6Æ76–f–6F–öäÆWfVÅ·fÇVUÒÃÒ6ÆV&æ6R“°¢6öç7B&V6÷&G2Ò'&’æ—4'&’‡7FFRæ–'ö–çFVÆÆ–vVæ6R’ò7FFRæ–'ö–çFVÆÆ–vVæ6R¢µÓ°¢6öç7Bf—6–&ÆU&V6÷&G2Ò&V6÷&G2æf–ÇFW"‚†—FVÒ’Óâ°¢6öç7B6Æ76–f–6F–öâÒ7G&–ær†—FVÒbb—FVÒæ6Æ76–f–6F–öâÇÂt”åDU$äÂr’ç&WÆ6R‚õòörÂrr’çFõWW$66R‚“°¢&WGW&â—FVÒbb6Æ76–f–6F–öäÆWfVÅ¶6Æ76–f–6F–öåÒÓÒVæFVf–æVBbb6Æ76–f–6F–öäÆWfVÅ¶6Æ76–f–6F–öåÒÃÒ6ÆV&æ6Rbb‚—FVÒæ&GFÆ–öä–BÇÂf—6–&ÆUVæ—D–G2æ†2…7G&–ær†—FVÒæ&GFÆ–öä–B’’“°¢Ò’ç6÷'B‚†Â"’Óâ7G&–ær†"æ7&VFVDBÇÂ"æBÇÂrr’æÆö6ÆT6ö×&R…7G&–ær†æ7&VFVDBÇÂæBÇÂrr’’“°¢6öç7B&GFÆ–öç2Òf—6–&ÆUVæ—G2æÖ‚‡Væ—B’Óâ‡°¢–C¢6ÆVâ‡Væ—Bæ–BÂ#’À¢6öFS¢6ÆVâ‡Væ—Bæ6öFRÇÂVæ—BææÖRÇÂVæ—Bæ–BÂC‚’À¢6äÖævS¢6Væ–÷"ÇÂ‡&æ²ãÒ"bbVæ—D–å66÷R‡Væ—B’¢Ò’“°¢6öç7B—FV×2Òf—6–&ÆU&V6÷&G2ç6Æ–6RƒÂS’æÖ‚†—FVÒ’Óâ°¢6öç7BVæ—BÒf—6–&ÆUVæ—G2æf–æB‚†6æF–FFR’Óâ7G&–ær†6æF–FFRæ–B’ÓÓÒ7G&–ær†—FVÒæ&GFÆ–öä–B’“°¢&WGW&â°¢–C¢6ÆVâ†—FVÒæ–BÂ#’À¢F—FÆS¢6ÆVâ†—FVÒçF—FÆRÂC’À¢G—S¢6ÆVâ†—FVÒçG—RÇÂt”åDTÄÄ”tTä4RrÂƒ’À¢6Æ76–f–6F–öã¢7G&–ær†—FVÒæ6Æ76–f–6F–öâÇÂt”åDU$äÂr’ç&WÆ6R‚õòörÂrr’çFõWW$66R‚’À¢&GFÆ–öä–C¢—FVÒæ&GFÆ–öä–Bò6ÆVâ†—FVÒæ&GFÆ–öä–BÂ#’¢rrÀ¢&GFÆ–öä6öFS¢6ÆVâ†—FVÒæ&GFÆ–öä6öFRÇÂVæ—Bbb‡Væ—Bæ6öFRÇÂVæ—BææÖR’ÇÂrrÂC‚’À¢7VÖÖ'“¢6ÆVâ†—FVÒç7VÖÖ'’ÇÂrrÂƒ’À¢WF†÷$6öFS¢6ÆVâ†—FVÒæWF†÷$6öFRÇÂrrÂ’À¢7&VFVDC¢—FVÒæ7&VFVDBÇÂ—FVÒæBÇÂrp¢Ó°¢Ò“°¢6öç7B÷W&F–öç2Ò„'&’æ—4'&’‡7FFRæ–'ö÷W&F–öç2’ò7FFRæ–'ö÷W&F–öç2¢µÒ’æf–ÇFW"‚†÷W&F–öâ’Óâ°¢–b‚÷W&F–öâ’&WGW&âfÇ6S°¢6öç7BVæ—BÒÆÅVæ—G2æf–æB‚†6æF–FFR’Óâ7G&–ær†6æF–FFRæ–B’ÓÓÒ7G&–ær†÷W&F–öâæ&GFÆ–öä–B’“°¢6öç7BÖVÖ&W'2Ò'&’æ—4'&’†÷W&F–öâæÖVÖ&W$6öFW2’ò÷W&F–öâæÖVÖ&W$6öFW2¢µÓ°¢&WGW&â‡Væ—BbbVæ—D–å66÷R‡Væ—B’’ÇÂ†7F÷$6öFRbbÖVÖ&W'2ç6öÖR‚†6öFR’Óâ6ÆVâ†6öFRÂ’çFõWW$66R‚’ÓÓÒ7F÷$6öFR’’ÇÂ†7F÷$6öFRbb6ÆVâ†÷W&F–öâæ6öÖÖæFW$6öFRÂ’çFõWW$66R‚’ÓÓÒ7F÷$6öFR“°¢Ò’æÖ‚†÷W&F–öâ’Óâ‡°¢–C¢6ÆVâ†÷W&F–öâæ–BÂ#’À¢7FGW3¢6ÆVâ†÷W&F–öâç7FGW2ÇÂuÄääTBrÂC’çFõWW$66R‚’À¢&–÷&—G“¢6ÆVâ†÷W&F–öâç&–÷&—G’ÇÂtäõ$ÔÂrÂC’çFõWW$66R‚’À¢&GFÆ–öä–C¢÷W&F–öâæ&GFÆ–öä–Bò6ÆVâ†÷W&F–öâæ&GFÆ–öä–BÂ#’¢rp¢Ò’“°¢&WGW&â&WÇ’‡²ö³¢G'VRÂ—FV×2ÂF÷FÄ–çFVÃ¢f—6–&ÆU&V6÷&G2æÆVæwF‚Â÷W&F–öç2Â&GFÆ–öç2Â6Æ76–f–6F–öç2Â6ä7&VFS¢&æ²ãÒ"Ò“°¢Ò“°§Ò“° ¦–òæöâ‚v6öææV7F–öârÂ‡6ö6¶WB’Óâ°¢&Vv—7FW$”%6ö6¶WB‡6ö6¶WBÂ°¢vWE7FFS¢‚’Óâ7FFRÀ¢&WV—&U6ö6¶WEW6W"À¢6ÆVâÀ¢&æ´ÆWfVÂÀ¢æ÷&ÖÆ—¦U&æ²À¢&æ´Æ&VÂÀ¢—46†–VbÀ¢—56Væ–÷"À¢—4ÆVFW'6†—À¢6äÖævT”%&GFÆ–öç2À¢–'&W6öÇfT6öFRÀ¢–'&GFÆ–öäf÷%f–WvW"À¢V&Æ–5W6W"À¢æ÷rÀ¢Ö¶T–BÀ¢FDVF—DÆörÀ¢6fU7FFRÀ¢VÖ—E7FFRÀ¢Ö&´Æöv–âÀ¢Ö&´Æöv÷WBÀ¢6ö6¶WEFõW6W ¢Ò“°§Ò“° ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢…EE4U%dU"5D%@£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦gVæ7F–öâ–ç7FÆÅW'6—7FVæ6TVÖ—D&'&–W'2‚’°¢6öç7B÷&–v–æÄ–ôVÖ—BÒ–òæVÖ—Bæ&–æB†–ò“°¢–òæVÖ—BÒgVæ7F–öâ†WfVçBÂââæ&w2’°¢–b‚7FFU7F÷&R’&WGW&â÷&–v–æÄ–ôVÖ—B†WfVçBÂââæ&w2“°¢7FFU7F÷&RæfÇW6‚‚’çF†Vâ‚‚’Óâ÷&–v–æÄ–ôVÖ—B†WfVçBÂââæ&w2’’æ6F6‚‚†W'&÷"’Óâ°¢6öç6öÆRæW'&÷"‚u´$Ä4²$”DtUÒ'&öF67B6¶—VB&V6W6RW'6—7FVæ6Rf–ÆVC¢rÂW'&÷"æÖW76vR“°¢Ò“°¢&WGW&â–ó°¢Ó°§Ğ ¦7–æ2gVæ7F–öâ–æ—F–Æ—¦UW'6—7FVæ6R‚’°¢–b„DD$4UõU$Â’°¢6öç7B²ööÂÒÒ&WV—&R‚wrr“°¢÷7Fw&W5ööÂÒæWrööÂ‡°¢6öææV7F–öå7G&–æs¢DD$4UõU$ÂÀ¢Öƒ¢RÀ¢6öææV7F–öåF–ÖV÷WDÖ–ÆÆ—3¢À¢–FÆUF–ÖV÷WDÖ–ÆÆ—3¢3 ¢Ò“°¢÷7Fw&W5ööÂæöâ‚vW'&÷"rÂ†W'&÷"’Óâ°¢6öç6öÆRæW'&÷"‚u´$Ä4²$”DtUÒ–FÆR÷7Fw&U5Â6öææV7F–öâW'&÷#¢rÂW'&÷"æÖW76vR“°¢Ò“°¢v—B÷7Fw&W5ööÂçVW'’‚u4TÄT5Br“°¢7FFU7F÷&RÒæWr÷7Fw&W57FFU7F÷&R‡÷7Fw&W5ööÂ“°¢7FFRÒv—B7FFU7F÷&RæÆöB‡°¢–æ—F–Å7FFS¢TÕE•õ5DDRÀ¢vWDÆVv7•7FFS¢‚’Óâ°¢6öç7BÆVv7’Ò&VDÆVv7•7FFTf–ÆR‚“°¢–b†ÆVv7’’6öç6öÆRæÆör‚u´$Ä4²$”DtUÒ–×÷'F–ærÆVv7’¥4ôâFFg&öÒr²ÆVv7’æf–ÆR“°¢&WGW&âÆVv7’òÆVv7’ç7FFR¢çVÆÃ°¢ÒÀ¢æ÷&ÖÆ—¦U7FFS¢‡fÇVR’Óâæ÷&ÖÆ—¦UW'6—7FVE7FFR‡fÇVRÂu÷7Fw&U5Â7FFRr¢Ò“°¢æ÷F–f–6F–öç57F÷&RÒæWræ÷F–f–6F–öç57F÷&R‡÷7Fw&W5ööÂÂ°¢vWE&÷w3¢‚’Óâ7FFRæ6–öæ÷F–f–6F–öç2ÇÂµÒÀ¢6WE&÷w3¢‡&÷w2’Óâ°¢7FFRæ6–öæ÷F–f–6F–öç2Ò&÷w3°¢6fU7FFR‚“°¢Ğ¢Ò“°¢v—Bæ÷F–f–6F–öç57F÷&Ræ–æ—F–Æ—¦R‚“°¢Öö&–ÆUW6…7F÷&RÒæWrvV%W6…7F÷&R‡÷7Fw&W5ööÂ“°¢v—BÖö&–ÆUW6…7F÷&Ræ–æ—F–Æ—¦R‚“°¢–ç7FÆÅW'6—7FVæ6TVÖ—D&'&–W'2‚“°¢6öç6öÆRæÆör‚u´$Ä4²$”DtUÒ÷7Fw&U5Â7FFR7F÷&R&VG’âr“°¢6öç6öÆRæÆör‚u´$Ä4²$”DtUÒ÷7Fw&U5Âæ÷F–f–6F–öâ7F÷&R&VG’âr“°¢&WGW&ã°¢Ğ ¢–b„•5õ$TäDU%õ%TåD”ÔR’°¢6öç6öÆRçv&â‚u´$Ä4²$”DtUÒDD$4UõU$Â—2æ÷B6öæf–wW&VC²W6–ærFV×÷&'’¥4ôâ7FFRBr²DDôd”ÄR²râ7FFRÖ’&RÆ÷7Böâ&W7F'B÷"&VFWÆ÷’âr“°¢Ğ ¢&W&Tf–ÆU7F÷&vR‚“°¢7FFRÒÆöE7FFR‚“°¢æ÷F–f–6F–öç57F÷&RÒæWræ÷F–f–6F–öç57F÷&R†çVÆÂÂ°¢vWE&÷w3¢‚’Óâ7FFRæ6–öæ÷F–f–6F–öç2ÇÂµÒÀ¢6WE&÷w3¢‡&÷w2’Óâ°¢7FFRæ6–öæ÷F–f–6F–öç2Ò&÷w3°¢6fU7FFR‚“°¢Ğ¢Ò“°¢v—Bæ÷F–f–6F–öç57F÷&Ræ–æ—F–Æ—¦R‚“°¢Öö&–ÆUW6…7F÷&RÒæWrvV%W6…7F÷&R†çVÆÂÂ°¢vWE&÷w3¢‚’Óâ7FFRæ6–÷vV%÷W6…÷7V'67&—F–öç2ÇÂµÒÀ¢6WE&÷w3¢7–æ2‡&÷w2’Óâ°¢7FFRæ6–÷vV%÷W6…÷7V'67&—F–öç2Ò&÷w3°¢v—B6fU7FFR‚“°¢Ğ¢Ò“°¢v—BÖö&–ÆUW6…7F÷&Ræ–æ—F–Æ—¦R‚“°¢6öç6öÆRæÆör‚„•5õ$TäDU%õ%TåD”ÔRòu´$Ä4²$”DtUÒ&VæFW"FV×÷&'’¥4ôâ7FFR7F÷&R&VG“¢r¢u´$Ä4²$”DtUÒÆö6Â¥4ôâ7FFR7F÷&R&VG“¢r’²DDôd”ÄR“°§Ğ ¦gVæ7F–öâvWDF—66÷&DôWF„6öæf–r‚’°¢6öç7B6Æ–VçD–BÒ6ÆVâ‡&ö6W72æVçbäD•44õ$Eô4Ä”TåEô”BÂ#“°¢6öç7B6Æ–VçE6V7&WBÒ6ÆVâ‡&ö6W72æVçbäD•44õ$Eô4Ä”TåEõ4T5$UBÂS“°¢6öç7B&VF—&V7EW&’Ò6ÆVâ‡&ö6W72æVçbäD•44õ$Eõ$TD•$T5EõU$’Â“°¢–b‚6Æ–VçD–BÇÂ6Æ–VçE6V7&WBÇÂ&VF—&V7EW&’’&WGW&âçVÆÃ° ¢ÆWB'6VC°¢G'’°¢'6VBÒæWrU$Â‡&VF—&V7EW&’“°¢Ò6F6‚…öW'&÷"’°¢&WGW&âçVÆÃ°¢Ğ¢6öç7BÆö6Ä†÷7BÒ²vÆö6Æ†÷7BrÂs#rãããrÂu³££ÒuÒæ–æ6ÇVFW2‡'6VBæ†÷7FæÖRçFôÆ÷vW$66R‚’“°¢–b€¢‚Æö6Ä†÷7Bbb'6VBç&÷Fö6öÂÓÒv‡GG3¢r’ÇÀ¢†Æö6Ä†÷7Bbb²v‡GG¢rÂv‡GG3¢uÒæ–æ6ÇVFW2‡'6VBç&÷Fö6öÂ’’ÇÀ¢'6VBçF†æÖRÓÒröWF‚öF—66÷&Bö6ÆÆ&6²rÇÀ¢'6VBç6V&6‚ÇÀ¢'6VBæ†6‚ÇÀ¢'6VBçW6W&æÖRÇÀ¢'6VBç77v÷&@¢’°¢&WGW&âçVÆÃ°¢Ğ¢&WGW&â²6Æ–VçD–BÂ6Æ–VçE6V7&WBÂ&VF—&V7EW&“¢'6VBçFõ7G&–ær‚’Ó°§Ğ ¦gVæ7F–öâ'VæTF—66÷&DôWF…7FFW2‚’°¢6öç7B7W'&VçEF–ÖRÒFFRææ÷r‚“°¢f÷"†6öç7B·7FFUFö¶VâÂVæF–æuÒöbF—66÷&DôWF…7FFW2’°¢–b‚VæF–ærÇÂVæF–æræW‡—&W4BÃÒ7W'&VçEF–ÖR’F—66÷&DôWF…7FFW2æFVÆWFR‡7FFUFö¶Vâ“°¢Ğ§Ğ ¦gVæ7F–öâ6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2Â7V66W72ÂÖW76vRÂ7FGW2Ò#’°¢6öç7Bæöæ6RÒ7'—Fòç&æFöÔ'—FW2ƒ‚’çFõ7G&–ær‚v&6ScBr“°¢6öç7B–ÆöBÒ¥4ôâç7G&–æv–g’‡°¢G—S¢v&Æ6·&–FvS¦F—66÷&BÖöWF‚rÀ¢ö³¢7V66W72ÓÓÒG'VRÀ¢ÖW76vS¢6ÆVâ†ÖW76vRÂƒ¢Ò’ç&WÆ6R‚óÂörÂuÅÇS62r“°¢&W2ç7FGW2‡7FGW2’ç6WB‡°¢t66†RÔ6öçG&öÂs¢væò×7F÷&RrÀ¢t6öçFVçBÕ6V7W&—G’ÕöÆ–7’s¢FVfVÇB×7&2væöæRs²67&—B×7&2væöæ6RÒG¶æöæ6WÒs²7G–ÆR×7&2wVç6fRÖ–æÆ–æRs²g&ÖRÖæ6W7F÷'2væöæRs²&6R×W&’væöæRvÀ¢u&VfW'&W"ÕöÆ–7’s¢væò×&VfW'&W"rÀ¢u‚Ô6öçFVçBÕG—RÔ÷F–öç2s¢væ÷6æ–fbp¢Ò’çG—R‚v‡FÖÂr’ç6VæB†ÂFö7G—R‡FÖÃãÆ‡FÖÂÆæsÒ&""F—#Ò''FÂ#ãÆÖWF6†'6WCÒ'WFbÓ‚#ãÆÖWFæÖSÒ'f–Ww÷'B"6öçFVçCÒ'v–GFƒÖFWf–6R×v–GF‚Æ–æ—F–Â×66ÆSÓ#ãÇF—FÆSí‹Š‹rF—66÷&CÂ÷F—FÆSãÆ&öG’7G–ÆSÒ&Ö&v–ã£¶Ö–âÖ†V–v‡C£fƒ¶F—7Æ“¦w&–C·Æ6RÖ—FV×3¦6VçFW#¶&6¶w&÷VæC¢3“C3¶6öÆ÷#¢6S†VFc¶föçC£g‚7—7FVÒ×V’Ç6ç2×6W&–b#ãÆÖ–â7G–ÆSÒ&Ö‚×v–GFƒ£C#ƒ·FF–æs£#Gƒ·FW‡BÖÆ–vã¦6VçFW"#ãÆƒ7G–ÆSÒ&6öÆ÷#¢6Cf#cƒ¶föçB×6—¦S£#‚#í‹Š‹rF—66÷&CÂöƒãÇâG·7V66W72ò}Š­˜R‹Š‹rŠ}˜MŠİ‹=Š}Š‚â˜­˜]˜=˜m˜2Š]‹­˜MŠ}˜"˜}‹˜rŠ}˜M˜mŠ}˜‹Š’âr¢}Š­‹‹‹Š]˜=˜]Š}˜B‹Š‹rŠ}˜MŠİ‹=Š}Š‚âŠ}‹ŠÍ‹’Š]˜M˜’Š}˜M˜]˜˜-‹’˜ŠİŠ}˜˜B˜]‹Š’Š=Ší‹˜’âwÓÂ÷ãÆ'WGFöâ–CÒ&6Æ÷6R×v–æF÷r"G—SÒ&'WGFöâ"7G–ÆSÒ'FF–æs£‚gƒ¶&÷&FW#£‚6öÆ–B6Cf#cƒ¶&÷&FW"×&F—W3£Gƒ¶&6¶w&÷VæC¢3ƒ#s¶6öÆ÷#¢6S†VFc¶7W'6÷#§ö–çFW"#íŠ]‹­˜MŠ}˜"Š}˜M˜mŠ}˜‹Š“Âö'WGFöããÂöÖ–ããÇ67&—Bæöæ6SÒ"G¶æöæ6WÒ#çG'—¶–b‡v–æF÷ræ÷VæW"—v–æF÷ræ÷VæW"ç÷7DÖW76vR‚G·–ÆöGÒÇv–æF÷ræÆö6F–öâæ÷&–v–â—Ö6F6‚…öW'&÷"—·ÖFö7VÖVçBævWDVÆVÖVçD'”–B‚v6Æ÷6R×v–æF÷rr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÆgVæ7F–öâ‚—·v–æF÷ræ6Æ÷6R‚—Ò“·G'—·v–æF÷ræ6Æ÷6R‚—Ö6F6‚…öW'&÷"—·ÓÂ÷67&—CãÂö&öG“ãÂö‡FÖÃæ“°§Ğ ¦ævWB‚röWF‚öF—66÷&Bö6ÆÆ&6²rÂ7–æ2‡&WÂ&W2’Óâ°¢6öç7B7FFUFö¶VâÒ6ÆVâ‡&WçVW'“òç7FFRÂ#‚“°¢6öç7BVæF–ærÒ7FFUFö¶VâòF—66÷&DôWF…7FFW2ævWB‡7FFUFö¶Vâ’¢çVÆÃ°¢–b‡7FFUFö¶Vâ’F—66÷&DôWF…7FFW2æFVÆWFR‡7FFUFö¶Vâ“°¢–b‚VæF–ærÇÂVæF–æræW‡—&W4BÃÒFFRææ÷r‚’’°¢&WGW&â6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2ÂfÇ6RÂ}Š}˜mŠ­˜}Š¢‹]˜MŠ}Šİ˜­Š’ŠÍ˜M‹=Š’Š}˜M‹Š‹rŠ=˜‚˜M˜RŠ­‹Šò‹]Š}˜MŠİŠ’ârÂC“°¢Ğ¢–b‡&WçVW'“òæW'&÷"’°¢&WGW&â6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2ÂfÇ6RÂ}Š­˜RŠ]˜M‹­Š}Š‹Š‹rF—66÷&BŠ=˜‚‹˜‹m˜râr“°¢Ğ ¢6öç7BWF†÷&—¦F–öä6öFRÒ6ÆVâ‡&WçVW'“òæ6öFRÂ#C‚“°¢–b‚WF†÷&—¦F–öä6öFR’°¢&WGW&â6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2ÂfÇ6RÂ}˜M˜R˜­‹]˜B‹˜]‹"Š}˜MŠ­˜˜˜­‹b˜]˜bF—66÷&BârÂC“°¢Ğ ¢6öç7BW6W"ÒvWEW6W$'”–B‡VæF–ærçW6W$–B“°¢6öç7BÆ—fU6W76–öç2ÒW6W"ò6W76–öç2ævWB‡W6W"æ–B’¢çVÆÃ°¢6öç7B†4Æ—fU6W76–öâÒÆ—fU6W76–öç2bb²ââæÆ—fU6W76–öç5Òç6öÖR‚‡6ö6¶WD–B’Óâ–òç6ö6¶WG2ç6ö6¶WG2æ†2‡6ö6¶WD–B’“°¢–b‚W6W"ÇÂ†4Æ—fU6W76–öâÇÂW6W"æ&÷fVBÓÓÒfÇ6RÇÂW6W"ç7W7VæFVBÓÓÒG'VRÇÂW6W"ç6V7W&—G•7FGW2ÓÒt5D•dRr’°¢&WGW&â6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2ÂfÇ6RÂ}Š}˜mŠ­˜}Š¢ŠÍ˜M‹=Š’Š}˜M˜]˜˜-‹’â‹=ŠÍ™˜BŠ}˜MŠıŠí˜˜B˜]ŠÍŠıŠıŠ}˜²Š½˜RŠ}ŠŠıŠ2Š}˜M‹Š‹r˜]‹Š’Š=Ší‹˜’ârÂC2“°¢Ğ ¢6öç7B6öæf–rÒvWDF—66÷&DôWF„6öæf–r‚“°¢–b‚6öæf–rÇÂ6öæf–ræ6Æ–VçD–BÓÒVæF–æræ6Æ–VçD–BÇÂ6öæf–rç&VF—&V7EW&’ÓÒVæF–ærç&VF—&V7EW&’’°¢&WGW&â6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2ÂfÇ6RÂ}Š]‹ŠıŠ}ŠıŠ}Š¢‹Š‹rF—66÷&B‹­˜­‹˜]˜=Š­˜]˜MŠ’Š=˜‚Š­‹­˜­‹Š¢Š=Š½˜mŠ}ŠŠ}˜M‹˜]˜M˜­Š’ârÂS2“°¢Ğ ¢ÆWB&Wf–÷W466÷VçG2ÒçVÆÃ°¢ÆWB&Wf–÷W4VF—DÆöw2ÒçVÆÃ°¢G'’°¢6öç7BFö¶Vå&W7öç6RÒv—BfWF6‚‚v‡GG3¢òöF—66÷&Bæ6öÒö’ööWFƒ"÷Fö¶VârÂ°¢ÖWF†öC¢uõ5BrÀ¢&VF—&V7C¢vW'&÷"rÀ¢†VFW'3¢°¢66WC¢vÆ–6F–öâö§6öârÀ¢t6öçFVçBÕG—Rs¢vÆ–6F–öâ÷‚×wwrÖf÷&Ò×W&ÆVæ6öFVBp¢ÒÀ¢&öG“¢æWrU$Å6V&6…&×2‡°¢6Æ–VçEö–C¢6öæf–ræ6Æ–VçD–BÀ¢6Æ–VçE÷6V7&WC¢6öæf–ræ6Æ–VçE6V7&WBÀ¢w&çE÷G—S¢vWF†÷&—¦F–öåö6öFRrÀ¢6öFS¢WF†÷&—¦F–öä6öFRÀ¢&VF—&V7E÷W&“¢6öæf–rç&VF—&V7EW&’À¢6öFU÷fW&–f–W#¢VæF–æræ6öFUfW&–f–W ¢Ò’À¢6–væÃ¢&÷'E6–væÂçF–ÖV÷WBƒ¢Ò“°¢6öç7BFö¶Vå&W7VÇBÒv—BFö¶Vå&W7öç6Ræ§6öâ‚’æ6F6‚‚‚’ÓâçVÆÂ“°¢–b‚Fö¶Vå&W7öç6Ræö²ÇÂFö¶Vå&W7VÇBÇÂG—VöbFö¶Vå&W7VÇBæ66W75÷Fö¶VâÓÒw7G&–ærrÇÂFö¶Vå&W7VÇBæ66W75÷Fö¶Vâ’°¢&WGW&â6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2ÂfÇ6RÂ}‹˜‹bF—66÷&BŠ]Š­˜]Š}˜RŠ}˜MŠ­˜˜˜­‹bâŠ=‹ŠòŠ}˜M˜]ŠİŠ}˜˜MŠ’âr“°¢Ğ ¢6öç7B&öf–ÆU&W7öç6RÒv—BfWF6‚‚v‡GG3¢òöF—66÷&Bæ6öÒö’÷W6W'2ôÖRrÂ°¢ÖWF†öC¢ttUBrÀ¢&VF—&V7C¢vW'&÷"rÀ¢†VFW'3¢°¢66WC¢vÆ–6F–öâö§6öârÀ¢WF†÷&—¦F–öã¢&V&W"G·Fö¶Vå&W7VÇBæ66W75÷Fö¶VçÖ ¢ÒÀ¢6–væÃ¢&÷'E6–væÂçF–ÖV÷WBƒ¢Ò“°¢6öç7B&öf–ÆRÒv—B&öf–ÆU&W7öç6Ræ§6öâ‚’æ6F6‚‚‚’ÓâçVÆÂ“°¢–b‚&öf–ÆU&W7öç6Ræö²ÇÂ&öf–ÆRÇÂ&öf–ÆRæ–B’°¢&WGW&â6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2ÂfÇ6RÂ}Š­‹‹‹Š}˜MŠ­Šİ˜-˜"˜]˜bŠİ‹=Š}Š‚F—66÷&BâŠ=‹ŠòŠ}˜M˜]ŠİŠ}˜˜MŠ’âr“°¢Ğ ¢6öç7B66÷VçBÒ7&VFTF—66÷&E6ö6–Ä66÷VçB‡&öf–ÆRÂæ÷r‚’“°¢6öç7BGWÆ–6FT÷væW"Òf–æDGWÆ–6FU6ö6–Ä66÷VçD÷væW"‡7FFRæ6–÷W6W'2Â66÷VçBÂW6W"æ–B“°¢–b†GWÆ–6FT÷væW"’°¢&WGW&â6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2ÂfÇ6RÂ}Šİ‹=Š}Š‚F—66÷&B˜}‹Šr˜]‹Š­Š‹rŠ‹‹m˜˜­Š’Š=Ší‹˜’ŠŠ}˜M˜‹˜Bâr“°¢Ğ ¢6öç7BæW‡D66÷VçG2ÒW6W'E6ö6–Ä66÷VçB‡W6W"ç6ö6–Ä66÷VçG2Â66÷VçB“°¢&Wf–÷W466÷VçG2ÒW6W"ç6ö6–Ä66÷VçG3°¢&Wf–÷W4VF—DÆöw2Ò'&’æ—4'&’‡7FFRæ6–öVF—EöÆöw2’ò7FFRæ6–öVF—EöÆöw2ç6Æ–6R‚’¢µÓ°¢W6W"ç6ö6–Ä66÷VçG2ÒæW‡D66÷VçG3°¢FDVF—DÆör‚}‹Š‹rF—66÷&BrÂW6W"ÂW6W"Â}Š­˜RŠ}˜MŠ­Šİ˜-˜"˜]˜bŠ}˜MŠİ‹=Š}Š‚‹Š‹ôWFƒ"âr“°¢G'’°¢v—B6fU7FFR‚“°¢Ò6F6‚…öW'&÷"’°¢W6W"ç6ö6–Ä66÷VçG2Ò&Wf–÷W466÷VçG3°¢7FFRæ6–öVF—EöÆöw2Ò&Wf–÷W4VF—DÆöw3°¢&WGW&â6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2ÂfÇ6RÂ}Š­‹‹‹Šİ˜‹‚Šİ‹=Š}Š‚F—66÷&B˜˜¢˜-Š}‹ŠıŠ’Š}˜MŠ˜­Š}˜mŠ}Š¢â˜M˜R˜­Š­˜RŠ}‹Š­˜]Š}ŠòŠ}˜MŠ­‹­˜­˜­‹ârÂS“°¢Ğ ¢VÖ—E7FFR‚“°¢f÷"†6öç7B6ö6¶WD–Böb6W76–öç2ævWB‡W6W"æ–B’ÇÂµÒ’°¢6öç7BF&vWE6ö6¶WBÒ–òç6ö6¶WG2ç6ö6¶WG2ævWB‡6ö6¶WD–B“°¢–b‡F&vWE6ö6¶WB’F&vWE6ö6¶WBæVÖ—B‚w6ö6–Ã¦F—66÷&C¦6ö×ÆWFRrÂ²ö³¢G'VRÒ“°¢Ğ¢&WGW&â6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2ÂG'VRÂ}Š­˜R‹Š‹rŠİ‹=Š}Š‚F—66÷&BŠ˜mŠÍŠ}ŠÒâr“°¢Ò6F6‚…öW'&÷"’°¢–b‡&Wf–÷W466÷VçG2ÓÒçVÆÂ’W6W"ç6ö6–Ä66÷VçG2Ò&Wf–÷W466÷VçG3°¢–b‡&Wf–÷W4VF—DÆöw2ÓÒçVÆÂ’7FFRæ6–öVF—EöÆöw2Ò&Wf–÷W4VF—DÆöw3°¢&WGW&â6VæDF—66÷&DôWF„6ÆÆ&6µvR‡&W2ÂfÇ6RÂ}ŠİŠıŠ²Ší‹}Š2Š=Š½˜mŠ}Š‹Š‹rF—66÷&Bâ˜M˜R˜­Š­˜RŠİ˜‹‚Š˜­Š}˜mŠ}Š¢Š}˜MŠ­˜˜˜­‹bârÂS"“°¢Ğ§Ò“° ¦ÆWB6‡WFF÷vå&öÖ—6RÒçVÆÃ°¦gVæ7F–öâ–ç7FÆÄw&6VgVÅ6‡WFF÷vâ‚’°¢6öç7B6‡WFF÷vâÒ‡6–væÂ’Óâ°¢–b‡6‡WFF÷vå&öÖ—6R’&WGW&â6‡WFF÷vå&öÖ—6S°¢6‡WFF÷vå&öÖ—6RÒ†7–æ2‚’Óâ°¢6öç6öÆRæÆör‚u´$Ä4²$”DtUÒr²6–væÂ²r&V6V—fVC²G&–æ–ær6öææV7F–öç2æB6fVB×7FFRw&—FW2âr“°¢6öç7Bf÷&6TW†—EF–ÖW"Ò6WEF–ÖV÷WB‚‚’Óâ°¢6öç6öÆRæW'&÷"‚u´$Ä4²$”DtUÒ6‡WFF÷vâF–ÖVB÷WBv†–ÆRG&–æ–ær7FFRw&—FW2âr“°¢&ö6W72æW†—Bƒ“°¢ÒÂ#S“°¢–b‡G—Vöbf÷&6TW†—EF–ÖW"çVç&VbÓÓÒvgVæ7F–öâr’f÷&6TW†—EF–ÖW"çVç&Vb‚“° ¢G'’°¢v—BæWr&öÖ—6R‚‡&W6öÇfR’Óâ–òæ6Æ÷6R‡&W6öÇfR’“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u´$Ä4²$”DtUÒW'&÷"6Æ÷6–ær6ö6¶WBä”ó¢rÂW'&÷"æÖW76vR“°¢&ö6W72æW†—D6öFRÒ°¢Ğ¢G'’°¢–b‡7FFU7F÷&R’v—B7FFU7F÷&RæfÇW6‚‚“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u´$Ä4²$”DtUÒVæF–ær÷7Fw&U5Âw&—FW2F–Bæ÷Bf–æ—6‚6ÆVæÇ“¢rÂW'&÷"æÖW76vR“°¢&ö6W72æW†—D6öFRÒ°¢Ğ¢G'’°¢–b‡÷7Fw&W5ööÂ’v—B÷7Fw&W5ööÂæVæB‚“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u´$Ä4²$”DtUÒW'&÷"6Æ÷6–ær÷7Fw&U5ÂööÃ¢rÂW'&÷"æÖW76vR“°¢&ö6W72æW†—D6öFRÒ°¢Òf–æÆÇ’°¢6ÆV%F–ÖV÷WB†f÷&6TW†—EF–ÖW"“°¢Ğ¢Ò’‚“°¢&WGW&â6‡WFF÷vå&öÖ—6S°¢Ó° ¢&ö6W72æöæ6R‚u4”uDU$ÒrÂ‚’Óâ²fö–B6‡WFF÷vâ‚u4”uDU$Òr“²Ò“°¢&ö6W72æöæ6R‚u4”t”åBrÂ‚’Óâ²fö–B6‡WFF÷vâ‚u4”t”åBr“²Ò“°§Ğ ¦7–æ2gVæ7F–öâ7F'E6W'fW"‚’°¢v—B–æ—F–Æ—¦UW'6—7FVæ6R‚“°¢G'’°¢v—B÷6E&÷WFW"æ–æ—F–Æ—¦R‚“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u´õ4EÒ66†VÖ–æ—F–Æ—¦F–öâf–ÆVC²F†R’v–ÆÂ&WG'’öâ—G2æW‡B&WVW7C¢rÂW'&÷"æÖW76vR“°¢Ğ¢‡GG6W'fW"æÆ—7FVâ…õ%BÂ‚’Óâ°¢6öç6öÆRæÆör‚rr“°¢6öç6öÆRæÆör‚sÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒr“°¢6öç6öÆRæÆör‚r$Ä4²$”DtR4•E’4”5•5DTÒr“°¢6öç6öÆRæÆör‚rõ%C¢r²õ%B“°¢6öç6öÆRæÆör‚r5DEU3¢ôäÄ”äRr“°¢6öç6öÆRæÆör‚rÄôt”âòÄTDU%4„•ò$D”òò4õ3¢$TE’r“°¢6öç6öÆRæÆör‚sÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒr“°¢–ç7FÆÄw&6VgVÅ6‡WFF÷vâ‚“°¢Ò“°§Ğ §7F'E6W'fW"‚’æ6F6‚†7–æ2†W'&÷"’Óâ°¢6öç6öÆRæW'&÷"‚u´$Ä4²$”DtUÒ7F'GWf–ÆVC¢rÂW'&÷"æÖW76vR“°¢–b‡÷7Fw&W5ööÂ’°¢G'’°¢v—B÷7Fw&W5ööÂæVæB‚“°¢Ò6F6‚†6Æ÷6TW'&÷"’°¢6öç6öÆRæW'&÷"‚u´$Ä4²$”DtUÒW'&÷"6Æ÷6–ær÷7Fw&U5ÂööÂgFW"7F'GWf–ÇW&S¢rÂ6Æ÷6TW'&÷"æÖW76vR“°¢Ğ¢Ğ¢&ö6W72æW†—D6öFRÒ°§Ò“° 