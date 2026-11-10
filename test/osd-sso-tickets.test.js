'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOsdSsoTicketStore } = require('../osd/sso-tickets');

test('OSD SSO tickets are opaque, short-lived, and usable only once', () => {
  let now = 1_000;
  const tickets = createOsdSsoTicketStore({ ttlMs: 60_000, now: () => now });
  const ticket = tickets.issue('verified-chief');

  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(tickets.consume(ticket), { userId: 'verified-chief' });
  assert.equal(tickets.consume(ticket), null);

  const expiring = tickets.issue('verified-chief');
  now += 60_000;
  assert.equal(tickets.consume(expiring), null);
});

test('OSD SSO tickets reject missing identities and cap pending sign-ins', () => {
  const tickets = createOsdSsoTicketStore({ maxTickets: 1 });
  assert.throws(() => tickets.issue(''), /verified user ID/);
  tickets.issue('first-chief');
  assert.throws(() => tickets.issue('second-chief'), { status: 429 });
  assert.equal(tickets.consume('short'), null);
});
