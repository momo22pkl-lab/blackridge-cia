'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SCHEMA_SQL,
  WeaponArmoryStore,
  buildSearchFilters,
  safeImageUrl
} = require('../weapon-armory-store');
const {
  adminScope,
  activeSectors,
  injectWeaponArmoryMarkup,
  memberSector,
  registerWeaponArmorySocket
} = require('../weapon-armory-server');

class AsyncMutex {
  constructor() {
    this.locked = false;
    this.queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      const grant = () => {
        this.locked = true;
        resolve(() => {
          const next = this.queue.shift();
          if (next) next();
          else this.locked = false;
        });
      };
      if (this.locked) this.queue.push(grant);
      else grant();
    });
  }
}

function cloneState(state) {
  return {
    locks: new Map(state.locks),
    catalog: new Map([...state.catalog].map(([key, value]) => [key, { ...value }])),
    stock: new Map([...state.stock].map(([key, value]) => [key, { ...value }])),
    issues: new Map([...state.issues].map(([key, value]) => [key, { ...value }])),
    audit: new Map([...state.audit].map(([key, value]) => [key, { ...value }]))
  };
}

class FakePostgres {
  constructor() {
    this.state = { locks: new Map(), catalog: new Map(), stock: new Map(), issues: new Map(), audit: new Map() };
    this.mutex = new AsyncMutex();
    this.releaseTransaction = null;
    this.backup = null;
  }

  stockKey(sectorId, weaponId) {
    return `${sectorId}::${weaponId}`;
  }

  async query(sql, params = []) {
    return this.execute(sql, params);
  }

  async connect() {
    return {
      query: (sql, params) => this.execute(sql, params),
      release: () => {}
    };
  }

  async execute(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim().toUpperCase();
    if (normalized === 'BEGIN') {
      this.releaseTransaction = await this.mutex.acquire();
      this.backup = cloneState(this.state);
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'COMMIT') {
      this.backup = null;
      if (this.releaseTransaction) this.releaseTransaction();
      this.releaseTransaction = null;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'ROLLBACK') {
      if (this.backup) this.state = this.backup;
      this.backup = null;
      if (this.releaseTransaction) this.releaseTransaction();
      this.releaseTransaction = null;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('INSERT INTO WEAPON_ARMORY_MEMBER_LOCKS')) {
      this.state.locks.set(params[0], true);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT MEMBER_ID FROM WEAPON_ARMORY_MEMBER_LOCKS')) {
      return { rows: this.state.locks.has(params[0]) ? [{ member_id: params[0] }] : [], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT OUTCOME, RESULT FROM WEAPON_ARMORY_AUDIT')) {
      const row = [...this.state.audit.values()].find((item) => item.actor_user_id === params[0] && item.request_id === params[1]);
      return { rows: row ? [{ outcome: row.outcome, result: row.result }] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith('SELECT ID FROM WEAPON_ARMORY_CATALOG WHERE ID = $1 FOR UPDATE')) {
      return { rows: this.state.catalog.has(params[0]) ? [{ id: params[0] }] : [], rowCount: this.state.catalog.has(params[0]) ? 1 : 0 };
    }
    if (normalized.startsWith('UPDATE WEAPON_ARMORY_CATALOG')) {
      const weapon = this.state.catalog.get(params[0]);
      if (weapon) Object.assign(weapon, { name: params[1], image_url: params[2], icon: params[3], active: true });
      return { rows: [], rowCount: weapon ? 1 : 0 };
    }
    if (normalized.startsWith('INSERT INTO WEAPON_ARMORY_CATALOG')) {
      const [id, name, image_url, icon, created_by_user_id] = params;
      this.state.catalog.set(id, { id, name, image_url, icon, active: true, created_by_user_id });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE WEAPON_ARMORY_SECTOR_STOCK SET ENABLED = (SECTOR_ID = ANY($2::TEXT[]))')) {
      const [weaponId, sectors] = params;
      for (const item of this.state.stock.values()) {
        if (item.weapon_id === weaponId) item.enabled = sectors.includes(item.sector_id);
      }
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO WEAPON_ARMORY_SECTOR_STOCK')) {
      const [sector_id, weapon_id, return_allowed] = params;
      const key = this.stockKey(sector_id, weapon_id);
      const item = this.state.stock.get(key);
      if (item) {
        item.enabled = true;
        item.return_allowed = return_allowed;
      } else {
        this.state.stock.set(key, { sector_id, weapon_id, available_quantity: 0, enabled: true, return_allowed });
      }
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT COUNT(*)::INT AS COUNT FROM WEAPON_ARMORY_ISSUES')) {
      const count = [...this.state.issues.values()].filter((item) => item.member_id === params[0] && item.status === 'ISSUED').length;
      return { rows: [{ count }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT C.ID, C.NAME, C.ACTIVE, S.RETURN_ALLOWED, S.AVAILABLE_QUANTITY')) {
      const item = this.state.stock.get(this.stockKey(params[0], params[1]));
      const weapon = this.state.catalog.get(params[1]);
      return { rows: item && weapon ? [{ id: weapon.id, name: weapon.name, active: weapon.active, return_allowed: item.return_allowed, available_quantity: item.available_quantity }] : [], rowCount: item ? 1 : 0 };
    }
    if (normalized.startsWith('SELECT S.AVAILABLE_QUANTITY, C.NAME FROM WEAPON_ARMORY_SECTOR_STOCK')) {
      const item = this.state.stock.get(this.stockKey(params[0], params[1]));
      const weapon = this.state.catalog.get(params[1]);
      return { rows: item && weapon ? [{ available_quantity: item.available_quantity, name: weapon.name }] : [], rowCount: item ? 1 : 0 };
    }
    if (normalized.startsWith('UPDATE WEAPON_ARMORY_SECTOR_STOCK SET AVAILABLE_QUANTITY = AVAILABLE_QUANTITY - 1')) {
      const item = this.state.stock.get(this.stockKey(params[0], params[1]));
      if (item && item.available_quantity > 0) item.available_quantity -= 1;
      return { rows: [], rowCount: item ? 1 : 0 };
    }
    if (normalized.startsWith('UPDATE WEAPON_ARMORY_SECTOR_STOCK SET AVAILABLE_QUANTITY = AVAILABLE_QUANTITY + 1')) {
      const item = this.state.stock.get(this.stockKey(params[0], params[1]));
      if (item) item.available_quantity += 1;
      return { rows: [], rowCount: item ? 1 : 0 };
    }
    if (normalized.startsWith('UPDATE WEAPON_ARMORY_SECTOR_STOCK SET AVAILABLE_QUANTITY = AVAILABLE_QUANTITY + $3')) {
      const item = this.state.stock.get(this.stockKey(params[0], params[1]));
      if (item) item.available_quantity += params[2];
      return { rows: item ? [{ available_quantity: item.available_quantity }] : [], rowCount: item ? 1 : 0 };
    }
    if (normalized.startsWith('INSERT INTO WEAPON_ARMORY_ISSUES')) {
      const [id, requestId, memberId, memberName, memberCode, sectorId, weaponId, weaponName, returnAllowedAtIssue] = params;
      this.state.issues.set(id, { id, request_id: requestId, member_id: memberId, member_name: memberName, member_code: memberCode, sector_id: sectorId, weapon_id: weaponId, weapon_name: weaponName, return_allowed_at_issue: returnAllowedAtIssue, status: 'ISSUED', issued_at: new Date().toISOString(), returned_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT I.ID, I.MEMBER_ID, I.MEMBER_NAME, I.MEMBER_CODE, I.SECTOR_ID')) {
      const issue = this.state.issues.get(params[0]);
      return { rows: issue ? [{ ...issue, return_allowed: issue.return_allowed_at_issue }] : [], rowCount: issue ? 1 : 0 };
    }
    if (normalized.startsWith("UPDATE WEAPON_ARMORY_ISSUES SET STATUS = 'RETURNED'")) {
      const issue = this.state.issues.get(params[0]);
      if (issue && issue.member_id === params[1] && issue.status === 'ISSUED') {
        issue.status = 'RETURNED';
        issue.returned_at = new Date().toISOString();
      }
      return { rows: [], rowCount: issue ? 1 : 0 };
    }
    if (normalized.startsWith('INSERT INTO WEAPON_ARMORY_AUDIT')) {
      const [id, requestId, actorId, actorName, actorCode, memberId, memberName, memberCode, sectorId, weaponId, weaponName, action, quantity, reason, outcome, result] = params;
      this.state.audit.set(id, { id, request_id: requestId, actor_user_id: actorId, actor_name: actorName, actor_code: actorCode, member_id: memberId, member_name: memberName, member_code: memberCode, sector_id: sectorId, weapon_id: weaponId, weapon_name: weaponName, action, quantity, reason, outcome, result: JSON.parse(result) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`FakePostgres does not support: ${normalized}`);
  }
}

function makeStore() {
  const pool = new FakePostgres();
  let id = 0;
  const store = new WeaponArmoryStore(pool, { makeId: (prefix) => `${prefix}-${++id}` });
  pool.state.catalog.set('weapon-1', {
    id: 'weapon-1',
    name: 'Training Rifle',
    image_url: '',
    icon: 'fa-gun',
    return_allowed: true,
    active: true
  });
  pool.state.stock.set(pool.stockKey('north', 'weapon-1'), {
    sector_id: 'north',
    weapon_id: 'weapon-1',
    available_quantity: 10,
    enabled: true,
    return_allowed: true
  });
  return { store, pool };
}

function actor(id, code = id) {
  return { id, publicCode: code, identity: { fullName: `Agent ${id}` } };
}

test('weapon armory injection adds the nav, pane, stylesheet and client only once', () => {
  const html = '<html><head></head><body><ul class="nav-list"><li id="ibp-nav">IBP</li></ul><div id="dashboard" class="view-pane active"></div></body></html>';
  const injected = injectWeaponArmoryMarkup(html);
  assert.match(injected, /id="weapon-armory-nav"/);
  assert.match(injected, /id="weapon-armory"/);
  assert.match(injected, /href="\/weapon-armory\.css"/);
  assert.match(injected, /src="\/weapon-armory-client\.js"/);
  const reinjected = injectWeaponArmoryMarkup(injected);
  assert.equal(reinjected.match(/id="weapon-armory-nav"/g).length, 1);
  assert.equal(reinjected.match(/id="weapon-armory"/g).length, 1);
  assert.equal(reinjected.match(/src="\/weapon-armory-client\.js"/g).length, 1);
  assert.equal(injectWeaponArmoryMarkup('<main>incomplete'), '<main>incomplete');
});

test('the current Black Ridge page receives the armory at its existing navigation and pane anchors', () => {
  const appHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const injected = injectWeaponArmoryMarkup(appHtml);
  assert.match(injected, /id="weapon-armory-nav"[^>]*onclick="showPane\('weapon-armory', this\)"/);
  assert.match(injected, /id="weapon-armory" class="view-pane weapon-armory-page"/);
  assert.equal((injected.match(/id="weapon-armory-nav"/g) || []).length, 1);
  assert.equal((injected.match(/id="weapon-armory"/g) || []).length, 1);
});

test('sector policy excludes archived units and resolves only an unambiguous active sector', () => {
  const state = {
    cia_battalions: [
      { id: 'one', sector: 'North', memberCodes: ['N-1'] },
      { id: 'two', sector: ' NORTH ', memberCodes: ['N-2'] },
      { id: 'old', sector: 'South', status: 'ARCHIVED', memberCodes: ['N-1'] }
    ]
  };
  assert.deepEqual(activeSectors(state).map((item) => item.id), ['north']);
  assert.equal(memberSector({ publicCode: 'N-1' }, state).id, 'north');
  assert.equal(memberSector({ publicCode: 'NO-SUCH-MEMBER' }, state), null);
  assert.equal(memberSector({ publicCode: 'N-1' }, { cia_battalions: [
    { sector: 'North', memberCodes: ['N-1'] },
    { sector: 'South', memberCodes: ['N-1'] }
  ] }), null);
});

test('sector commanders can read only their current sector while senior leadership can view all active sectors', () => {
  const state = { cia_battalions: [
    { sector: 'North', commanderCode: 'CMD-1', memberCodes: ['N-1'] },
    { sector: 'South', commanderCode: 'CMD-2', memberCodes: ['S-1'] },
    { sector: 'Old', commanderCode: 'CMD-1', status: 'ARCHIVED' }
  ] };
  const context = {
    isLeadership: (user) => user?.rank === 'SUPREME COMMANDER',
    rankLevel: (rank) => rank === 'SECTOR COMMANDER' ? 2 : 1
  };
  const local = adminScope({ publicCode: 'CMD-1', rank: 'SECTOR COMMANDER' }, state, context);
  assert.equal(local.canView, true);
  assert.equal(local.canManage, false);
  assert.deepEqual(local.sectors.map((sector) => sector.id), ['north']);
  const senior = adminScope({ rank: 'SUPREME COMMANDER' }, state, context);
  assert.equal(senior.canManage, true);
  assert.deepEqual(senior.sectors.map((sector) => sector.id), ['north', 'south']);
});

test('image URLs and admin search filters reject unsafe input and bind values', () => {
  assert.equal(safeImageUrl('https://example.test/weapon.png'), 'https://example.test/weapon.png');
  assert.equal(safeImageUrl('/assets/weapon.png'), '/assets/weapon.png');
  assert.equal(safeImageUrl('javascript:alert(1)'), '');
  assert.equal(safeImageUrl('http://example.test/weapon.png'), '');

  const filters = buildSearchFilters(['north'], { search: "%' OR TRUE --", from: '2026-01-01', to: '2026-01-31' }, 'a', true);
  assert.match(filters.sql, /sector_id = ANY/);
  assert.match(filters.sql, /sector_id IS NULL/);
  assert.match(filters.sql, /LOWER\(COALESCE\(a\.member_name/);
  assert.ok(filters.sql.includes('$2'));
  assert.deepEqual(filters.values, [['north'], "%%' or true --%", '2026-01-01', '2026-01-31']);
});

test('PostgreSQL schema enforces nonnegative stock, append-only issue history, and scoped indexes', () => {
  const schema = SCHEMA_SQL.join('\n');
  assert.match(schema, /available_quantity INTEGER NOT NULL DEFAULT 0 CHECK \(available_quantity >= 0\)/);
  assert.match(schema, /return_allowed BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(schema, /status TEXT NOT NULL CHECK \(status IN \('ISSUED', 'RETURNED'\)\)/);
  assert.match(schema, /UNIQUE \(actor_user_id, request_id\)/);
  assert.match(schema, /idx_weapon_armory_issues_member_active/);
  assert.match(schema, /idx_weapon_armory_audit_sector_created/);
});

test('concurrent issue requests cannot exceed three per member or consume stock below zero', async () => {
  const { store, pool } = makeStore();
  pool.state.stock.get(pool.stockKey('north', 'weapon-1')).available_quantity = 10;
  const member = actor('member-1', 'N-100');
  const results = await Promise.all(Array.from({ length: 5 }, (_value, index) => store.issue({
    actor: member,
    requestId: `issue-000${index}`,
    sectorId: 'north',
    weaponId: 'weapon-1'
  })));
  assert.equal(results.filter((result) => result.ok).length, 3);
  assert.equal(results.filter((result) => !result.ok).length, 2);
  assert.equal([...pool.state.issues.values()].filter((issue) => issue.status === 'ISSUED').length, 3);
  assert.equal(pool.state.stock.get(pool.stockKey('north', 'weapon-1')).available_quantity, 7);
  assert.equal(pool.state.audit.size, 5);
  assert.ok([...pool.state.audit.values()].some((entry) => entry.outcome === 'DENIED'));
});

test('simultaneous members cannot claim the last weapon and a denied issue is audited', async () => {
  const { store, pool } = makeStore();
  pool.state.stock.get(pool.stockKey('north', 'weapon-1')).available_quantity = 1;
  const results = await Promise.all([
    store.issue({ actor: actor('member-a'), requestId: 'issue-member-a', sectorId: 'north', weaponId: 'weapon-1' }),
    store.issue({ actor: actor('member-b'), requestId: 'issue-member-b', sectorId: 'north', weaponId: 'weapon-1' })
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.equal(pool.state.stock.get(pool.stockKey('north', 'weapon-1')).available_quantity, 0);
  assert.equal([...pool.state.audit.values()].filter((entry) => entry.outcome === 'DENIED').length, 1);
});

test('replayed issue request is idempotent and does not decrement stock twice', async () => {
  const { store, pool } = makeStore();
  const input = { actor: actor('member-1'), requestId: 'issue-idempotent', sectorId: 'north', weaponId: 'weapon-1' };
  const first = await store.issue(input);
  const replay = await store.issue(input);
  assert.equal(first.ok, true);
  assert.deepEqual(replay, first);
  assert.equal(pool.state.stock.get(pool.stockKey('north', 'weapon-1')).available_quantity, 9);
  assert.equal(pool.state.issues.size, 1);
  assert.equal(pool.state.audit.size, 1);
});

test('return permission is sector-specific and stays fixed on an issued weapon record', async () => {
  const { store, pool } = makeStore();
  const manager = actor('manager-1');
  await store.saveWeapon({
    actor: manager,
    requestId: 'weapon-policy-save',
    weapon: { id: 'weapon-1', name: 'Training Rifle', icon: 'fa-gun' },
    sectorIds: ['north', 'south'],
    returnAllowedSectorIds: ['north']
  });
  await store.adjustStock({ actor: manager, requestId: 'stock-south-add', sectorId: 'south', weaponId: 'weapon-1', delta: 1, reason: 'sector test' });

  const southMember = actor('south-member');
  const southIssue = await store.issue({ actor: southMember, requestId: 'issue-south-policy', sectorId: 'south', weaponId: 'weapon-1' });
  const southReturn = await store.returnIssue({ actor: southMember, requestId: 'return-south-policy', issueId: southIssue.issue.id });
  assert.equal(southReturn.ok, false);
  assert.equal(pool.state.stock.get(pool.stockKey('south', 'weapon-1')).available_quantity, 0);

  const northMember = actor('north-member');
  const northIssue = await store.issue({ actor: northMember, requestId: 'issue-north-policy', sectorId: 'north', weaponId: 'weapon-1' });
  await store.saveWeapon({
    actor: manager,
    requestId: 'weapon-policy-change',
    weapon: { id: 'weapon-1', name: 'Training Rifle', icon: 'fa-gun' },
    sectorIds: ['north', 'south'],
    returnAllowedSectorIds: ['south']
  });
  const northReturn = await store.returnIssue({ actor: northMember, requestId: 'return-north-policy', issueId: northIssue.issue.id });
  assert.equal(northReturn.ok, true);
});

test('issue is sector-scoped; returns require ownership and use the policy set at issue time', async () => {
  const { store, pool } = makeStore();
  const user = actor('member-1', 'N-100');
  const unavailable = await store.issue({ actor: user, requestId: 'issue-wrong-sector', sectorId: 'south', weaponId: 'weapon-1' });
  assert.equal(unavailable.ok, false);
  assert.equal(pool.state.stock.get(pool.stockKey('north', 'weapon-1')).available_quantity, 10);

  const issued = await store.issue({ actor: user, requestId: 'issue-valid-sector', sectorId: 'north', weaponId: 'weapon-1' });
  const wrongOwner = await store.returnIssue({ actor: actor('other-member'), requestId: 'return-wrong-owner', issueId: issued.issue.id });
  assert.equal(wrongOwner.ok, false);
  assert.equal(pool.state.stock.get(pool.stockKey('north', 'weapon-1')).available_quantity, 9);
  pool.state.catalog.get('weapon-1').return_allowed = false;

  const returned = await store.returnIssue({ actor: user, requestId: 'return-valid-issue', issueId: issued.issue.id });
  assert.equal(returned.ok, true);
  assert.equal(pool.state.stock.get(pool.stockKey('north', 'weapon-1')).available_quantity, 10);
  assert.equal(pool.state.issues.get(issued.issue.id).status, 'RETURNED');
  assert.equal([...pool.state.audit.values()].filter((entry) => entry.action === 'RETURN' && entry.outcome === 'SUCCESS').length, 1);
});

test('stock adjustments require a reason, reject underflow, and preserve the audit details', async () => {
  const { store, pool } = makeStore();
  const admin = actor('admin-1', 'CIA-1');
  const missingReason = await store.adjustStock({
    actor: admin, requestId: 'stock-bad-reason', sectorId: 'north', weaponId: 'weapon-1', delta: 2, reason: ''
  });
  assert.equal(missingReason.ok, false);
  assert.equal(pool.state.stock.get(pool.stockKey('north', 'weapon-1')).available_quantity, 10);
  assert.equal([...pool.state.audit.values()].find((entry) => entry.request_id === 'stock-bad-reason').outcome, 'DENIED');

  const added = await store.adjustStock({
    actor: admin, requestId: 'stock-adjust-add', sectorId: 'north', weaponId: 'weapon-1', delta: 4, reason: 'توريد مخزون'
  });
  assert.equal(added.ok, true);
  assert.equal(added.availableQuantity, 14);
  const underflow = await store.adjustStock({
    actor: admin, requestId: 'stock-adjust-underflow', sectorId: 'north', weaponId: 'weapon-1', delta: -15, reason: 'محاولة خفض غير صالحة'
  });
  assert.equal(underflow.ok, false);
  assert.equal(pool.state.stock.get(pool.stockKey('north', 'weapon-1')).available_quantity, 14);
  const audit = [...pool.state.audit.values()].find((entry) => entry.request_id === 'stock-adjust-add');
  assert.equal(audit.reason, 'توريد مخزون');
  assert.equal(audit.quantity, 4);
});

test('socket handlers derive the member sector server-side and deny non-leadership administration', async () => {
  const registered = new Map();
  const socket = { on: (event, callback) => registered.set(event, callback) };
  const calls = [];
  const store = {
    memberSnapshot: async (input) => { calls.push(['member', input]); return { ok: true, weapons: [], issues: [], activeCount: 0, limit: 3 }; },
    issue: async (input) => { calls.push(['issue', input]); return { ok: true }; },
    recordDenied: async (input) => { calls.push(['denied', input]); return { ok: false }; },
    adminSnapshot: async (input) => ({ ok: true, ...input })
  };
  let user = actor('member-1', 'N-100');
  registerWeaponArmorySocket(socket, {
    getStore: () => store,
    getState: () => ({ cia_battalions: [
      { sector: 'North', commanderCode: 'N-100', memberCodes: ['N-100'] },
      { sector: 'South', commanderCode: 'S-100', memberCodes: ['S-100'] }
    ] }),
    requireUser: () => user,
    isLeadership: (candidate) => candidate?.id === 'leader-1',
    rankLevel: (rank) => rank === 'SECTOR COMMANDER' ? 2 : 1
  });

  let issueReply;
  await registered.get('weapon-armory:issue')({ requestId: 'member-issue-1', weaponId: 'weapon-1', sectorId: 'south' }, (result) => { issueReply = result; });
  assert.equal(issueReply.ok, true);
  assert.equal(calls.find((entry) => entry[0] === 'issue')[1].sectorId, 'north');

  let deniedReply;
  await registered.get('weapon-armory:stock:adjust')({
    requestId: 'member-stock-1', sectorId: 'north', weaponId: 'weapon-1', delta: 50, reason: 'غير مسموح'
  }, (result) => { deniedReply = result; });
  assert.equal(deniedReply.ok, false);
  assert.equal(calls.some((entry) => entry[0] === 'denied'), true);

  user = actor('leader-1', 'CIA-1');
  user.rank = 'SECTOR COMMANDER';
  let adminReply;
  await registered.get('weapon-armory:admin:get')({}, (result) => { adminReply = result; });
  assert.equal(adminReply.canView, true);
  assert.equal(adminReply.canManage, true);
  assert.deepEqual(adminReply.sectors.map((sector) => sector.id), ['north', 'south']);

  user = actor('unit-commander', 'N-100');
  user.rank = 'SECTOR COMMANDER';
  await registered.get('weapon-armory:admin:get')({}, (result) => { adminReply = result; });
  assert.equal(adminReply.canView, true);
  assert.equal(adminReply.canManage, false);
  assert.deepEqual(adminReply.sectors.map((sector) => sector.id), ['north']);
});

test('armory frontend uses server socket events and does not persist inventory in browser storage', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'weapon-armory-client.js'), 'utf8');
  assert.match(client, /weapon-armory:issue/);
  assert.match(client, /weapon-armory:return/);
  assert.match(client, /weapon-armory:admin:search/);
  assert.doesNotMatch(client, /localStorage|sessionStorage/);
});
