'use strict';

const { inspectMessage } = require('./security-moderation');

const DEFAULT_BLOCK_MESSAGE = 'تم منع حفظ النص لأنه يحتوي على لفظ مسيء أو مخالف. عدّل النص ثم أعد المحاولة.';
const SCAN_FAILURE_MESSAGE = 'تعذّر التحقق من النص؛ لم تُحفظ العملية. أعد المحاولة بنص أقصر أو بعدد حقول أقل.';

// Legacy and unusual Socket.IO event names that do not contain a write action.
// Most write events are also covered by the fail-closed action-name fallback below.
const SOCKET_TEXT_FIELDS = Object.freeze({
  'auth:claimChief': ['name', 'hobbies', 'loginName'],
  'radio:message': ['text', 'message', 'body'],
  'chat:global': ['text', 'message'],
  'chat:private': ['text', 'message'],
  'social:accounts:manual': ['platform', 'username', 'profileUrl'],
  'admin:updateSelf': ['publicCode'],
  'admin:updateMember': ['publicCode'],
  'operation:updateStatus': ['status'],
  'admin:action': ['name', 'hobbies', 'reason', 'message', 'note', 'description', 'bio', 'rejectionMessage', 'text', 'comment'],
  'character:admin:action': ['name', 'characterName', 'reason', 'message', 'note'],
  'admin:kickMember': ['reason', 'message'],
  'admin:kickUser': ['reason', 'message'],
  'admin:reactivateMember': ['reason', 'message'],
  'security:suspendMember': ['reason', 'note'],
  'security:deleteOwnManualIncidentReason': ['reason'],
  'bank:manage': ['reason', 'note', 'description'],
  'cover:reject': ['reason'],
  'cover:disable': ['reason'],
  'sos:updateStatus': ['status', 'note', 'reason'],
  'ibp:phase2:area': ['name', 'label', 'description', 'notes', 'text'],
  'ibp:phase2:location': ['name', 'label', 'description', 'notes', 'text'],
  'operation:addDrawing': ['label', 'description', 'note'],
  'operation:addMarker': ['label', 'description', 'note'],
  'sos:broadcast': ['text', 'message', 'note', 'status', 'dangerStatus', 'location', 'location.label', 'location.name']
});

const ALREADY_MODERATED_SOCKET_EVENTS = new Set([
  'morse:translate',
  'radio:text',
  'radio:code',
  'chat:send',
  'support:send',
  'support:reply'
]);

const SHARED_TEXT_KEYS = new Set([
  'cia_chats',
  'cia_reports',
  'cia_cases',
  'cia_map_locations',
  'cia_hq_locations'
]);

const NON_CONTENT_KEYS = new Set([
  'id', 'key', 'code', 'publiccode', 'militarycode', 'targetcode', 'fromcode', 'tocode',
  'actorcode', 'membercode', 'password', 'passwordconfirmation', 'secret', 'secretcode',
  'token', 'accesstoken', 'refreshtoken', 'recoverycode', 'otp', 'totp', 'mfa',
  'signatureimage', 'image', 'imageurl', 'avatar', 'avatarurl', 'photo', 'file', 'pdf',
  'filedata', 'thumbnaildata', 'filename', 'contenttype', 'filesize', 'sha256',
  'icon', 'color', 'createdat', 'updatedat', 'expiresat',
  'issuedat', 'signedat', 'timestamp', 'latitude', 'longitude', 'coordinates',
  'enabled', 'verified', 'quantity', 'amount', 'bytes', 'mimetype'
]);

const WRITE_ACTIONS = new Set([
  'create', 'save', 'update', 'send', 'reply', 'request', 'broadcast', 'add',
  'respond', 'submit', 'amend', 'revoke', 'set', 'edit', 'upload', 'action',
  'adjust', 'reject', 'disable', 'manual', 'message', 'area', 'location'
]);

function isNonContentKey(key) {
  const normalized = String(key || '').toLowerCase();
  return NON_CONTENT_KEYS.has(normalized) ||
    /(?:id|code|token|password|secret|image|avatar|photo|signature|timestamp)(?:s)?$/.test(normalized);
}

function collectUserTextValues(value, options = {}) {
  const values = [];
  const maxValues = Number.isInteger(options.maxValues) ? options.maxValues : 20000;
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 12;
  const maxStringLength = Number.isInteger(options.maxStringLength) ? options.maxStringLength : 8 * 1024 * 1024;
  const skipControlFields = options.skipControlFields !== false;
  let overflow = false;

  function visit(current, key, depth) {
    if (overflow || current == null) return;
    if (depth > maxDepth) {
      overflow = true;
      return;
    }
    if (typeof current === 'string') {
      if (skipControlFields && isNonContentKey(key)) return;
      if (values.length >= maxValues || current.length > maxStringLength) {
        overflow = true;
        return;
      }
      const text = current;
      if (text.trim()) values.push(text);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, key, depth + 1);
      return;
    }
    if (typeof current !== 'object') return;
    for (const [childKey, childValue] of Object.entries(current)) {
      if (skipControlFields && isNonContentKey(childKey)) continue;
      visit(childValue, childKey, depth + 1);
      if (overflow) break;
    }
  }

  visit(value, '', 0);
  if (overflow) {
    const error = new Error('The text moderation scan exceeded its safe input limit.');
    error.code = 'TEXT_MODERATION_SCAN_LIMIT';
    throw error;
  }
  return values;
}

function valuesAtPath(value, path) {
  const parts = path.split('.');
  let current = [value];
  for (const part of parts) {
    const next = [];
    for (const item of current) {
      if (item == null) continue;
      if (part === '*') {
        if (Array.isArray(item)) next.push(...item);
        else if (typeof item === 'object') next.push(...Object.values(item));
      } else if (Array.isArray(item)) {
        for (const child of item) {
          if (child && typeof child === 'object' && child[part] !== undefined) next.push(child[part]);
        }
      } else if (typeof item === 'object' && item[part] !== undefined) {
        next.push(item[part]);
      }
    }
    current = next;
  }
  return current.flatMap((item) => collectUserTextValues(item, { skipControlFields: false }));
}

function isMutatingSocketEvent(eventName) {
  const segments = String(eventName || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1:$2')
    .split(/[:_-]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
  return segments.some((segment) => WRITE_ACTIONS.has(segment));
}

function getSocketTextInputs(eventName, payload) {
  const event = String(eventName || '');
  if (ALREADY_MODERATED_SOCKET_EVENTS.has(event)) return [];

  if (event === 'shared:data:seed') {
    const source = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    if (!source || typeof source !== 'object') return [];
    return [...new Set(Object.entries(source)
      .filter(([key]) => SHARED_TEXT_KEYS.has(key))
      .flatMap(([, value]) => collectUserTextValues(value)))];
  }
  if (event === 'shared:data:set') {
    const key = String(payload?.key || '');
    return SHARED_TEXT_KEYS.has(key) ? collectUserTextValues(payload?.value) : [];
  }

  const fields = SOCKET_TEXT_FIELDS[event];
  if (fields) {
    const values = fields.flatMap((field) => valuesAtPath(payload, field));
    if (isMutatingSocketEvent(event)) values.push(...collectUserTextValues(payload));
    return [...new Set(values)];
  }
  if (!isMutatingSocketEvent(event)) return [];
  return collectUserTextValues(payload);
}

function replyBlocked(socket, callback, message) {
  const result = { ok: false, message: message || DEFAULT_BLOCK_MESSAGE };
  if (typeof callback === 'function') callback(result);
  else if (socket && typeof socket.emit === 'function') socket.emit('security:moderation:blocked', result);
}

function installSocketModerationBoundary(socket, { getActor = () => null, moderateOutgoingText } = {}) {
  if (!socket || typeof socket.use !== 'function') throw new TypeError('A Socket.IO socket is required.');
  const moderate = typeof moderateOutgoingText === 'function'
    ? moderateOutgoingText
    : async (_actor, value) => inspectMessage(value) || false;

  socket.use((packet, next) => {
    const eventName = String(packet?.[0] || '');
    const payload = packet?.[1];
    let texts;
    try {
      texts = getSocketTextInputs(eventName, payload);
    } catch {
      const callback = typeof packet[packet.length - 1] === 'function' ? packet[packet.length - 1] : null;
      replyBlocked(socket, callback, SCAN_FAILURE_MESSAGE);
      return;
    }
    if (!texts.length) return next();
    const callback = typeof packet[packet.length - 1] === 'function' ? packet[packet.length - 1] : null;

    (async () => {
      for (const text of texts) {
        const result = await moderate(getActor(socket), text, `SOCKET_${eventName}`);
        if (result) {
          replyBlocked(socket, callback, result.message || DEFAULT_BLOCK_MESSAGE);
          return;
        }
      }
      next();
    })().catch(() => {
      replyBlocked(socket, callback, 'تعذّر التحقق من النص؛ لم تُحفظ العملية. أعد المحاولة لاحقًا.');
    });
  });
}

function createHttpTextModerationMiddleware({ moderateOutgoingText, getActor = () => null } = {}) {
  const moderate = typeof moderateOutgoingText === 'function'
    ? moderateOutgoingText
    : async (_actor, value) => inspectMessage(value) || false;

  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase())) return next();
    let texts;
    try {
      texts = collectUserTextValues(req.body);
    } catch {
      res.status(413).json({ error: SCAN_FAILURE_MESSAGE });
      return;
    }
    if (!texts.length) return next();

    (async () => {
      for (const text of texts) {
        const result = await moderate(getActor(req), text, `HTTP_${req.method}_${req.path}`);
        if (result) {
          res.status(400).json({ error: result.message || DEFAULT_BLOCK_MESSAGE });
          return;
        }
      }
      next();
    })().catch(() => {
      res.status(503).json({ error: 'تعذّر التحقق من النص؛ لم تُحفظ العملية. أعد المحاولة لاحقًا.' });
    });
  };
}

module.exports = {
  DEFAULT_BLOCK_MESSAGE,
  SOCKET_TEXT_FIELDS,
  collectUserTextValues,
  createHttpTextModerationMiddleware,
  getSocketTextInputs,
  installSocketModerationBoundary,
  isMutatingSocketEvent
};
