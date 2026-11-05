'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'missing function ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('Unclosed function ' + name);
}

function createElements() {
  const elements = new Map();
  return {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          id,
          style: { display: '' },
          value: '',
          innerText: '',
          textContent: '',
          focused: false,
          focus() { this.focused = true; }
        });
      }
      return elements.get(id);
    }
  };
}

function characterListFunction(users) {
  const start = serverJs.indexOf('function characterListForUser(');
  const end = serverJs.indexOf('/* ---------------------------------------------------------', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return vm.runInNewContext(serverJs.slice(start, end) + '\ncharacterListForUser', {
    state: { cia_users: users }
  });
}

function roleFunctions() {
  const start = serverJs.indexOf('function normalizeRank(');
  const end = serverJs.indexOf('function ensureBank(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return vm.runInNewContext(serverJs.slice(start, end) +
    '\n({ normalizeRank, isChief, isSenior, isHighCommander, isLeadership })', {
      clean(value, max) { return String(value == null ? '' : value).trim().slice(0, max || 100); }
    });
}

function makeMilitaryFixture(rank) {
  const actor = {
    id: 'TEST-MILITARY-PRIMARY',
    accountId: 'TEST-MILITARY-ACCOUNT',
    characterOwnerId: 'TEST-MILITARY-OWNER',
    name: 'Test Commander',
    rank,
    approved: true,
    serviceApproved: true,
    suspended: false,
    separatedAt: null,
    securityStatus: 'ACTIVE'
  };
  return {
    actor,
    users: [
      actor,
      {
        id: 'TEST-MILITARY-SECONDARY',
        accountId: actor.accountId,
        characterOwnerId: actor.characterOwnerId,
        name: 'Test Secondary',
        rank: 'AGENT',
        approved: true,
        serviceApproved: true,
        suspended: false,
        separatedAt: null,
        securityStatus: 'ACTIVE'
      },
      {
        id: 'OTHER-ACCOUNT-CHARACTER',
        accountId: 'OTHER-TEST-ACCOUNT',
        characterOwnerId: 'OTHER-TEST-OWNER',
        name: 'Other Test User',
        rank: 'AGENT',
        approved: true,
        serviceApproved: true,
        suspended: false,
        separatedAt: null,
        securityStatus: 'ACTIVE'
      }
    ]
  };
}

function installOpenManagerHarness(actor, users) {
  const document = createElements();
  const window = {
    __blackridgeCharactersOpenAfterLogin: false,
    setTimeout(fn) { fn(); return 1; }
  };
  const events = [];
  let rendered = null;
  const listForActor = characterListFunction(users);
  const socket = {
    connected: true,
    emit(event, payload, callback) {
      events.push(event);
      if (event === 'auth:me') return callback({ ok: true, user: actor });
      if (event === 'character:list') {
        const characters = listForActor(actor).filter((user) =>
          user.suspended !== true && !user.separatedAt && user.approved !== false &&
          user.serviceApproved !== false && user.securityStatus === 'ACTIVE'
        );
        return callback({ ok: true, owner: { id: actor.characterOwnerId }, characters, limit: 10 });
      }
      throw new Error('Unexpected socket event: ' + event);
    }
  };
  const context = {
    window,
    document,
    currentUser: actor,
    ciaSessionAuthenticated: true,
    ciaSocket: socket,
    renderCharactersManager(result) { rendered = result; },
    alert() {}
  };
  const functions = [
    extractFunction(indexHtml, 'requestMilitaryLoginForCharacters'),
    extractFunction(indexHtml, 'openCharactersManager')
  ].join('\n');
  vm.runInNewContext(functions, context);
  return { context, document, events, get rendered() { return rendered; } };
}

test('signed-in military session loads only the authenticated account fixture', () => {
  const fixture = makeMilitaryFixture('AGENT');
  const harness = installOpenManagerHarness(fixture.actor, fixture.users);
  harness.context.openCharactersManager();
  assert.deepEqual(harness.events, ['auth:me', 'character:list']);
  assert.deepEqual(Array.from(harness.rendered.characters, (user) => user.id), [
    'TEST-MILITARY-PRIMARY', 'TEST-MILITARY-SECONDARY'
  ]);
  assert.equal(harness.rendered.characters.some((user) => user.accountId === 'OTHER-TEST-ACCOUNT'), false);
});

test('signed-out click returns to the existing military login and requests no account password', () => {
  const document = createElements();
  const window = { __blackridgeCharactersOpenAfterLogin: false, setTimeout(fn) { fn(); return 1; } };
  const events = [];
  const context = {
    window,
    document,
    currentUser: null,
    ciaSessionAuthenticated: false,
    ciaSocket: { connected: true, emit(event) { events.push(event); } },
    renderCharactersManager() {},
    alert() {}
  };
  vm.runInNewContext([
    extractFunction(indexHtml, 'requestMilitaryLoginForCharacters'),
    extractFunction(indexHtml, 'openCharactersManager')
  ].join('\n'), context);
  context.openCharactersManager();
  assert.equal(window.__blackridgeCharactersOpenAfterLogin, true);
  assert.equal(document.getElementById('characters-modal').style.display, 'none');
  assert.equal(document.getElementById('characters-auth-fields').style.display, 'none');
  assert.equal(document.getElementById('passcode-modal').style.display, 'flex');
  assert.equal(document.getElementById('entry-name').focused, true);
  assert.match(document.getElementById('auth-msg').innerText, /الطريقة العسكرية المعتادة|بياناتك العسكرية المعتادة/);
  assert.deepEqual(events, []);
  assert.equal(indexHtml.includes('id="characters-account-password"'), false);
  assert.equal(indexHtml.includes('account:characters:login'), false);
});

test('successful existing military login automatically opens the current account list', () => {
  const fixture = makeMilitaryFixture('SUPREME COMMANDER');
  const harness = installOpenManagerHarness(fixture.actor, fixture.users);
  harness.context.currentUser = null;
  harness.context.ciaSessionAuthenticated = false;
  harness.context.openCharactersManager();
  harness.context.currentUser = fixture.actor;
  harness.context.ciaSessionAuthenticated = true;
  const afterLogin = extractFunction(indexHtml, 'openPendingCharactersAfterMilitaryLogin');
  vm.runInNewContext(afterLogin, harness.context);
  harness.context.openPendingCharactersAfterMilitaryLogin({ ok: true, serviceApproved: true });
  assert.equal(harness.context.window.__blackridgeCharactersOpenAfterLogin, false);
  assert.deepEqual(harness.events, ['auth:me', 'character:list']);
  assert.deepEqual(Array.from(harness.rendered.characters, (user) => user.id), [
    'TEST-MILITARY-PRIMARY', 'TEST-MILITARY-SECONDARY'
  ]);
  assert.equal(indexHtml.includes('openPendingCharactersAfterMilitaryLogin(result);'), true);
});

test('agent, High Commander, Senior Commander, and CIA CHIEF remain account-scoped', () => {
  const role = roleFunctions();
  assert.equal(role.isChief({ rank: 'CIA CHIEF' }), true);
  assert.equal(role.isChief({ rank: 'SUPREME COMMANDER' }), false);
  assert.equal(role.isLeadership({ rank: 'CIA CHIEF' }), true);
  assert.equal(role.isLeadership({ rank: 'Senior Commander CIA' }), true);
  assert.equal(role.isLeadership({ rank: 'HIGH COMMANDER' }), false);
  assert.equal(role.isHighCommander({ rank: 'HIGH COMMANDER' }), true);

  for (const rank of ['AGENT', 'HIGH COMMANDER', 'Senior Commander CIA', 'CIA CHIEF']) {
    const fixture = makeMilitaryFixture(rank);
    const listForActor = characterListFunction(fixture.users);
    assert.deepEqual(Array.from(listForActor(fixture.actor), (user) => user.id), [
      'TEST-MILITARY-PRIMARY', 'TEST-MILITARY-SECONDARY'
    ], rank + ' cannot read another account');
  }

  const listStart = serverJs.indexOf("socket.on('character:list'");
  const listEnd = serverJs.indexOf("socket.on('character:request'", listStart);
  const handler = serverJs.slice(listStart, listEnd);
  assert.equal(handler.includes('requireSocketUser(socket)'), true);
  assert.equal(handler.includes('characterListForUser(actor)'), true);
});
