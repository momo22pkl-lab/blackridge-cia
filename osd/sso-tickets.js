'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 60 * 1000;
const DEFAULT_MAX_TICKETS = 1000;

function createOsdSsoTicketStore({ ttlMs = DEFAULT_TTL_MS, maxTickets = DEFAULT_MAX_TICKETS, now = Date.now } = {}) {
  const tickets = new Map();

  function digest(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  function pruneExpired() {
    const currentTime = now();
    for (const [key, entry] of tickets) {
      if (entry.expiresAt <= currentTime) tickets.delete(key);
    }
  }

  return Object.freeze({
    issue(userId) {
      const normalizedUserId = String(userId || '').trim();
      if (!normalizedUserId) throw new TypeError('A verified user ID is required.');
      pruneExpired();
      if (tickets.size >= maxTickets) {
        throw Object.assign(new Error('Too many pending OSD sign-ins.'), { status: 429 });
      }
      const ticket = crypto.randomBytes(32).toString('base64url');
      tickets.set(digest(ticket), { userId: normalizedUserId, expiresAt: now() + ttlMs });
      return ticket;
    },

    consume(ticket) {
      if (typeof ticket !== 'string' || ticket.length < 40 || ticket.length > 200) return null;
      const key = digest(ticket);
      const entry = tickets.get(key);
      if (!entry) return null;
      tickets.delete(key);
      if (entry.expiresAt <= now()) return null;
      return Object.freeze({ userId: entry.userId });
    },

    clear() {
      tickets.clear();
    }
  });
}

module.exports = { createOsdSsoTicketStore };
