'use strict';

const crypto = require('node:crypto');

const WEAPON_LIMIT = 3;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS weapon_armory_catalog (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image_url TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT 'fa-gun',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS weapon_armory_sector_stock (
    sector_id TEXT NOT NULL,
    weapon_id TEXT NOT NULL REFERENCES weapon_armory_catalog(id) ON DELETE RESTRICT,
    available_quantity INTEGER NOT NULL DEFAULT 0 CHECK (available_quantity >= 0),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    return_allowed BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sector_id, weapon_id)
  )`,
  'ALTER TABLE weapon_armory_sector_stock ADD COLUMN IF NOT EXISTS return_allowed BOOLEAN NOT NULL DEFAULT FALSE',
  `CREATE TABLE IF NOT EXISTS weapon_armory_member_locks (
    member_id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS weapon_armory_issues (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    member_name TEXT NOT NULL DEFAULT '',
    member_code TEXT NOT NULL DEFAULT '',
    sector_id TEXT NOT NULL,
    weapon_id TEXT NOT NULL REFERENCES weapon_armory_catalog(id) ON DELETE RESTRICT,
    weapon_name TEXT NOT NULL,
    return_allowed_at_issue BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL CHECK (status IN ('ISSUED', 'RETURNED')),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    returned_at TIMESTAMPTZ
  )`,
  'ALTER TABLE weapon_armory_issues ADD COLUMN IF NOT EXISTS return_allowed_at_issue BOOLEAN NOT NULL DEFAULT FALSE',
  `CREATE TABLE IF NOT EXISTS weapon_armory_audit (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_name TEXT NOT NULL DEFAULT '',
    actor_code TEXT NOT NULL DEFAULT '',
    member_id TEXT,
    member_name TEXT NOT NULL DEFAULT '',
    member_code TEXT NOT NULL DEFAULT '',
    sector_id TEXT,
    weapon_id TEXT,
    weapon_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'ERROR')),
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (actor_user_id, request_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_weapon_armory_stock_sector_enabled ON weapon_armory_sector_stock (sector_id, enabled, weapon_id)',
  "CREATE INDEX IF NOT EXISTS idx_weapon_armory_issues_member_active ON weapon_armory_issues (member_id, issued_at DESC) WHERE status = 'ISSUED'",
  'CREATE INDEX IF NOT EXISTS idx_weapon_armory_issues_sector_created ON weapon_armory_issues (sector_id, issued_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_weapon_armory_issues_member_code ON weapon_armory_issues (member_code)',
  'CREATE INDEX IF NOT EXISTS idx_weapon_armory_audit_sector_created ON weapon_armory_audit (sector_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_weapon_armory_audit_member_code ON weapon_armory_audit (member_code)',
  'CREATE INDEX IF NOT EXISTS idx_weapon_armory_audit_weapon ON weapon_armory_audit (weapon_id, created_at DESC)'
];

function clean(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function decodeJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function safeImageUrl(value) {
  const input = clean(value, 500);
  if (!input) return '';
  if (input.startsWith('/') && !input.startsWith('//')) return input;
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch (_error) {
    return '';
  }
}

function actorFields(actor = {}) {
  return {
    actorUserId: clean(actor.id, 120),
    actorName: clean(actor.name || actor.identity?.fullName, 120),
    actorCode: clean(actor.publicCode, 100)
  };
}

function validRequestId(value) {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(clean(value, 128));
}

function normalizeSectors(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => clean(value, 120))
    .filter(Boolean))];
}

class WeaponArmoryStore {
  constructor(pool, options = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('A PostgreSQL pool with connect() is required for the weapon armory.');
    }
    this.pool = pool;
    this.makeId = typeof options.makeId === 'function'
      ? options.makeId
      : (prefix) => `${prefix}-${crypto.randomUUID()}`;
  }

  async initialize() {
    for (const sql of SCHEMA_SQL) await this.pool.query(sql);
  }

  async withTransaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  }

  async lockActor(client, actorUserId) {
    await client.query(
      `INSERT INTO weapon_armory_member_locks (member_id)
       VALUES ($1)
       ON CONFLICT (member_id) DO NOTHING`,
      [actorUserId]
    );
    await client.query(
      'SELECT member_id FROM weapon_armory_member_locks WHERE member_id = $1 FOR UPDATE',
      [actorUserId]
    );
  }

  async findRequest(client, actorUserId, requestId) {
    const result = await client.query(
      `SELECT outcome, result
       FROM weapon_armory_audit
       WHERE actor_user_id = $1 AND request_id = $2`,
      [actorUserId, requestId]
    );
    const row = result.rows?.[0];
    return row ? decodeJson(row.result, { ok: row.outcome === 'SUCCESS' }) : null;
  }

  async writeAudit(client, entry) {
    const actor = actorFields(entry.actor);
    const member = entry.member || {};
    const result = entry.result && typeof entry.result === 'object' ? entry.result : {};
    await client.query(
      `INSERT INTO weapon_armory_audit
       (id, request_id, actor_user_id, actor_name, actor_code, member_id, member_name,
        member_code, sector_id, weapon_id, weapon_name, action, quantity, reason, outcome, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
      [
        this.makeId('WAUDIT'),
        entry.requestId,
        actor.actorUserId,
        actor.actorName,
        actor.actorCode,
        clean(member.id, 120) || null,
        clean(member.name, 120),
        clean(member.code, 100),
        clean(entry.sectorId, 120) || null,
        clean(entry.weaponId, 120) || null,
        clean(entry.weaponName, 120),
        clean(entry.action, 40).toUpperCase(),
        Number.isInteger(entry.quantity) ? entry.quantity : 0,
        clean(entry.reason, 500),
        entry.outcome,
        JSON.stringify(result)
      ]
    );
  }

  async finishDenied(client, entry, message, extra = {}) {
    const result = { ok: false, message, ...extra };
    await this.writeAudit(client, { ...entry, outcome: 'DENIED', result });
    return result;
  }

  async memberSnapshot({ member, sectorId }) {
    const memberId = clean(member?.id, 120);
    const sector = clean(sectorId, 120);
    if (!memberId || !sector) return { ok: false, message: 'تعذر تحديد العضو أو القطاع.' };

    return this.withTransaction(async (client) => {
      const weaponsResult = await client.query(
        `SELECT c.id, c.name, c.image_url, c.icon, s.return_allowed,
                s.available_quantity
         FROM weapon_armory_catalog c
         JOIN weapon_armory_sector_stock s ON s.weapon_id = c.id
         WHERE s.sector_id = $1 AND s.enabled = TRUE AND c.active = TRUE
         ORDER BY c.name, c.id`,
        [sector]
      );
      const issuesResult = await client.query(
        `SELECT i.id, i.weapon_id, i.weapon_name, i.sector_id, i.issued_at,
                i.return_allowed_at_issue AS return_allowed
         FROM weapon_armory_issues i
         WHERE i.member_id = $1 AND i.status = 'ISSUED'
         ORDER BY i.issued_at DESC, i.id DESC`,
        [memberId]
      );
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM weapon_armory_issues
         WHERE member_id = $1 AND status = 'ISSUED'`,
        [memberId]
      );
      const activeCount = Number(countResult.rows?.[0]?.count) || 0;
      return {
        ok: true,
        limit: WEAPON_LIMIT,
        activeCount,
        weapons: (weaponsResult.rows || []).map((row) => ({
          id: row.id,
          name: row.name,
          imageUrl: row.image_url || '',
          icon: row.icon || 'fa-gun',
          returnAllowed: row.return_allowed === true,
          availableQuantity: Number(row.available_quantity) || 0
        })),
        issues: (issuesResult.rows || []).map((row) => ({
          id: row.id,
          weaponId: row.weapon_id,
          weaponName: row.weapon_name,
          sectorId: row.sector_id,
          issuedAt: row.issued_at,
          returnAllowed: row.return_allowed === true
        }))
      };
    });
  }

  async saveWeapon({ actor, requestId, weapon = {}, sectorIds = [], returnAllowedSectorIds = null }) {
    const actorId = clean(actor?.id, 120);
    const request = clean(requestId, 128);
    const name = clean(weapon.name, 100);
    const id = clean(weapon.id, 120) || this.makeId('WPN');
    const sectors = normalizeSectors(sectorIds);
    const returnAllowedSectors = new Set(
      Array.isArray(returnAllowedSectorIds)
        ? normalizeSectors(returnAllowedSectorIds)
        : (weapon.returnAllowed === true ? sectors : [])
    );
    const imageUrl = safeImageUrl(weapon.imageUrl);
    const icon = /^fa-[a-z0-9-]{2,48}$/i.test(clean(weapon.icon, 52))
      ? clean(weapon.icon, 52)
      : 'fa-gun';
    if (!actorId || !validRequestId(request)) {
      return { ok: false, message: 'بيانات السلاح أو القطاعات غير مكتملة.' };
    }
    if (!name || !sectors.length) {
      return this.recordDenied({
        actor, requestId: request, action: weapon.id ? 'WEAPON_UPDATED' : 'WEAPON_CREATED',
        weaponId: id, reason: 'بيانات السلاح أو القطاعات غير مكتملة.'
      });
    }
    if (weapon.imageUrl && !imageUrl) {
      return this.recordDenied({
        actor, requestId: request, action: weapon.id ? 'WEAPON_UPDATED' : 'WEAPON_CREATED',
        weaponId: id, reason: 'رابط الصورة يجب أن يكون HTTPS أو مسارًا محليًا آمنًا.'
      });
    }

    return this.withTransaction(async (client) => {
      await this.lockActor(client, actorId);
      const previous = await this.findRequest(client, actorId, request);
      if (previous) return previous;

      let action = 'WEAPON_CREATED';
      const existing = await client.query(
        'SELECT id FROM weapon_armory_catalog WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (existing.rows?.length) {
        action = 'WEAPON_UPDATED';
        await client.query(
          `UPDATE weapon_armory_catalog
           SET name = $2, image_url = $3, icon = $4,
               active = TRUE, updated_at = NOW()
           WHERE id = $1`,
          [id, name, imageUrl, icon]
        );
      } else {
        await client.query(
          `INSERT INTO weapon_armory_catalog
           (id, name, image_url, icon, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, name, imageUrl, icon, actorId]
        );
      }

      await client.query(
        `UPDATE weapon_armory_sector_stock
         SET enabled = (sector_id = ANY($2::text[])), updated_at = NOW()
         WHERE weapon_id = $1`,
        [id, sectors]
      );
      for (const sector of sectors) {
        await client.query(
          `INSERT INTO weapon_armory_sector_stock
           (sector_id, weapon_id, available_quantity, enabled, return_allowed)
           VALUES ($1, $2, 0, TRUE, $3)
           ON CONFLICT (sector_id, weapon_id)
           DO UPDATE SET enabled = TRUE, return_allowed = EXCLUDED.return_allowed, updated_at = NOW()`,
          [sector, id, returnAllowedSectors.has(sector)]
        );
      }

      const result = {
        ok: true,
        weapon: { id, name, imageUrl, icon },
        sectorIds: sectors,
        returnAllowedSectorIds: sectors.filter((sector) => returnAllowedSectors.has(sector))
      };
      await this.writeAudit(client, {
        actor, requestId: request, action, weaponId: id, weaponName: name,
        quantity: 0, reason: '', outcome: 'SUCCESS', result
      });
      return result;
    });
  }

  async adjustStock({ actor, requestId, sectorId, weaponId, delta, reason }) {
    const actorId = clean(actor?.id, 120);
    const request = clean(requestId, 128);
    const sector = clean(sectorId, 120);
    const weapon = clean(weaponId, 120);
    const amount = Number(delta);
    const note = clean(reason, 500);
    if (!actorId || !validRequestId(request)) {
      return { ok: false, message: 'أدخل كمية صحيحة وسببًا واضحًا لتعديل المخزون.' };
    }
    if (!sector || !weapon || !Number.isInteger(amount) || amount === 0 || note.length < 3) {
      return this.recordDenied({
        actor, requestId: request, action: 'STOCK_ADJUSTED', sectorId: sector,
        weaponId: weapon, quantity: Number.isInteger(amount) ? amount : 0,
        reason: note || 'بيانات تعديل المخزون غير مكتملة.'
      });
    }

    return this.withTransaction(async (client) => {
      await this.lockActor(client, actorId);
      const previous = await this.findRequest(client, actorId, request);
      if (previous) return previous;

      const stock = await client.query(
        `SELECT s.available_quantity, c.name
         FROM weapon_armory_sector_stock s
         JOIN weapon_armory_catalog c ON c.id = s.weapon_id
         WHERE s.sector_id = $1 AND s.weapon_id = $2
         FOR UPDATE OF s`,
        [sector, weapon]
      );
      const auditBase = { actor, requestId: request, action: 'STOCK_ADJUSTED', sectorId: sector, weaponId: weapon, reason: note, quantity: amount };
      if (!stock.rows?.length) return this.finishDenied(client, auditBase, 'السلاح غير مفعّل لهذا القطاع.');
      const available = Number(stock.rows[0].available_quantity) || 0;
      if (available + amount < 0) {
        return this.finishDenied(client, { ...auditBase, weaponName: stock.rows[0].name }, 'لا يمكن خفض المخزون إلى أقل من صفر.', { availableQuantity: available });
      }

      const updated = await client.query(
        `UPDATE weapon_armory_sector_stock
         SET available_quantity = available_quantity + $3, updated_at = NOW()
         WHERE sector_id = $1 AND weapon_id = $2
         RETURNING available_quantity`,
        [sector, weapon, amount]
      );
      const availableQuantity = Number(updated.rows?.[0]?.available_quantity) || 0;
      const result = { ok: true, sectorId: sector, weaponId: weapon, availableQuantity, delta: amount };
      await this.writeAudit(client, { ...auditBase, weaponName: stock.rows[0].name, outcome: 'SUCCESS', result });
      return result;
    });
  }

  async issue({ actor, requestId, sectorId, weaponId }) {
    const actorId = clean(actor?.id, 120);
    const request = clean(requestId, 128);
    const sector = clean(sectorId, 120);
    const weapon = clean(weaponId, 120);
    if (!actorId || !validRequestId(request)) {
      return { ok: false, message: 'تعذر التحقق من طلب الاستلام.' };
    }
    if (!sector || !weapon) {
      return this.recordDenied({
        actor, requestId: request, action: 'ISSUE', sectorId: sector,
        weaponId: weapon, quantity: 1, reason: 'بيانات طلب الاستلام غير مكتملة.'
      });
    }

    return this.withTransaction(async (client) => {
      await this.lockActor(client, actorId);
      const previous = await this.findRequest(client, actorId, request);
      if (previous) return previous;

      const member = { id: actorId, name: clean(actor.identity?.fullName || actor.name, 120), code: clean(actor.publicCode, 100) };
      const auditBase = { actor, member, requestId: request, action: 'ISSUE', sectorId: sector, weaponId: weapon, quantity: 1 };
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM weapon_armory_issues
         WHERE member_id = $1 AND status = 'ISSUED'`,
        [actorId]
      );
      const activeCount = Number(countResult.rows?.[0]?.count) || 0;
      if (activeCount >= WEAPON_LIMIT) {
        return this.finishDenied(client, auditBase, 'وصلت إلى الحد الأقصى وهو 3 أسلحة.', { activeCount, limit: WEAPON_LIMIT });
      }

      const stock = await client.query(
        `SELECT c.id, c.name, c.active, s.return_allowed, s.available_quantity
         FROM weapon_armory_sector_stock s
         JOIN weapon_armory_catalog c ON c.id = s.weapon_id
         WHERE s.sector_id = $1 AND s.weapon_id = $2 AND s.enabled = TRUE
         FOR UPDATE OF s, c`,
        [sector, weapon]
      );
      if (!stock.rows?.length || stock.rows[0].active !== true) {
        return this.finishDenied(client, auditBase, 'هذا السلاح غير متاح لقطاعك.');
      }
      const available = Number(stock.rows[0].available_quantity) || 0;
      if (available < 1) {
        return this.finishDenied(client, { ...auditBase, weaponName: stock.rows[0].name }, 'لا توجد كمية متاحة في المخزون.', { availableQuantity: 0 });
      }

      await client.query(
        `UPDATE weapon_armory_sector_stock
         SET available_quantity = available_quantity - 1, updated_at = NOW()
         WHERE sector_id = $1 AND weapon_id = $2 AND available_quantity > 0`,
        [sector, weapon]
      );
      const issueId = this.makeId('WISSUE');
      await client.query(
        `INSERT INTO weapon_armory_issues
         (id, request_id, member_id, member_name, member_code, sector_id, weapon_id, weapon_name, return_allowed_at_issue, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ISSUED')`,
        [issueId, request, actorId, member.name, member.code, sector, weapon, stock.rows[0].name, stock.rows[0].return_allowed === true]
      );
      const result = {
        ok: true,
        issue: { id: issueId, weaponId: weapon, weaponName: stock.rows[0].name, sectorId: sector, issuedAt: new Date().toISOString() },
        activeCount: activeCount + 1,
        limit: WEAPON_LIMIT,
        availableQuantity: available - 1
      };
      await this.writeAudit(client, { ...auditBase, weaponName: stock.rows[0].name, outcome: 'SUCCESS', result });
      return result;
    });
  }

  async returnIssue({ actor, requestId, issueId }) {
    const actorId = clean(actor?.id, 120);
    const request = clean(requestId, 128);
    const issue = clean(issueId, 120);
    if (!actorId || !validRequestId(request)) {
      return { ok: false, message: 'تعذر التحقق من طلب الإرجاع.' };
    }
    if (!issue) {
      return this.recordDenied({
        actor, requestId: request, action: 'RETURN', quantity: 1,
        reason: 'معرّف السلاح المطلوب إرجاعه غير صالح.'
      });
    }

    return this.withTransaction(async (client) => {
      await this.lockActor(client, actorId);
      const previous = await this.findRequest(client, actorId, request);
      if (previous) return previous;

      const member = { id: actorId, name: clean(actor.identity?.fullName || actor.name, 120), code: clean(actor.publicCode, 100) };
      const record = await client.query(
        `SELECT i.id, i.member_id, i.member_name, i.member_code, i.sector_id,
                i.weapon_id, i.weapon_name, i.status,
                i.return_allowed_at_issue AS return_allowed
         FROM weapon_armory_issues i
         WHERE i.id = $1
         FOR UPDATE OF i`,
        [issue]
      );
      const row = record.rows?.[0];
      const auditBase = {
        actor, member: row ? { id: row.member_id, name: row.member_name, code: row.member_code } : member,
        requestId: request, action: 'RETURN', sectorId: row?.sector_id,
        weaponId: row?.weapon_id, weaponName: row?.weapon_name, quantity: 1
      };
      if (!row || row.member_id !== actorId || row.status !== 'ISSUED') {
        return this.finishDenied(client, auditBase, 'السلاح غير موجود ضمن عهدتك الحالية.');
      }
      if (row.return_allowed !== true) {
        return this.finishDenied(client, auditBase, 'سياسة هذا القطاع لا تسمح بإرجاع السلاح.');
      }

      await client.query(
        `UPDATE weapon_armory_sector_stock
         SET available_quantity = available_quantity + 1, updated_at = NOW()
         WHERE sector_id = $1 AND weapon_id = $2`,
        [row.sector_id, row.weapon_id]
      );
      await client.query(
        `UPDATE weapon_armory_issues
         SET status = 'RETURNED', returned_at = NOW()
         WHERE id = $1 AND member_id = $2 AND status = 'ISSUED'`,
        [issue, actorId]
      );
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM weapon_armory_issues
         WHERE member_id = $1 AND status = 'ISSUED'`,
        [actorId]
      );
      const result = { ok: true, issueId: issue, activeCount: Number(countResult.rows?.[0]?.count) || 0, limit: WEAPON_LIMIT };
      await this.writeAudit(client, { ...auditBase, outcome: 'SUCCESS', result });
      return result;
    });
  }

  async recordDenied({ actor, requestId, action, sectorId, weaponId, weaponName, quantity = 0, reason, member }) {
    const actorId = clean(actor?.id, 120);
    const request = clean(requestId, 128);
    if (!actorId || !validRequestId(request)) return { ok: false, message: 'تعذر تسجيل المحاولة.' };
    return this.withTransaction(async (client) => {
      await this.lockActor(client, actorId);
      const previous = await this.findRequest(client, actorId, request);
      if (previous) return previous;
      return this.finishDenied(client, {
        actor, member, requestId: request, action: clean(action, 40).toUpperCase(),
        sectorId, weaponId, weaponName, quantity, reason: clean(reason, 500)
      }, clean(reason, 500) || 'هذه العملية غير مسموحة.');
    });
  }

  async adminSnapshot({ sectorIds, filters = {}, includeGlobalAudit = false, globalMemberCounts = false }) {
    const sectors = normalizeSectors(sectorIds);
    if (!sectors.length) return { ok: true, weapons: [], issues: [], audit: [] };
    return this.withTransaction(async (client) => {
      const weapons = await client.query(
        `SELECT c.id, c.name, c.image_url, c.icon, c.active,
                s.sector_id, s.available_quantity, s.enabled, s.return_allowed
         FROM weapon_armory_sector_stock s
         JOIN weapon_armory_catalog c ON c.id = s.weapon_id
         WHERE s.sector_id = ANY($1::text[])
         ORDER BY s.sector_id, c.name, c.id`,
        [sectors]
      );
      const { sql: issueFilterSql, values: issueValues } = buildSearchFilters(sectors, filters, 'i');
      const issueCountScope = globalMemberCounts ? '' : 'WHERE sector_id = ANY($1::text[])';
      const issues = await client.query(
        `WITH issue_counts AS (
           SELECT member_id, COUNT(*)::int AS member_weapon_count,
                  COUNT(*) FILTER (WHERE status = 'ISSUED')::int AS member_active_count
           FROM weapon_armory_issues
           ${issueCountScope}
           GROUP BY member_id
         )
         SELECT i.id, i.member_id, i.member_name, i.member_code, i.sector_id,
                i.weapon_id, i.weapon_name, i.status, i.issued_at, i.returned_at,
                counts.member_weapon_count, counts.member_active_count
         FROM weapon_armory_issues i
         JOIN issue_counts counts ON counts.member_id = i.member_id
         WHERE ${issueFilterSql}
         ORDER BY i.issued_at DESC, i.id DESC
         LIMIT $${issueValues.length + 1}`,
        [...issueValues, 200]
      );
      const { sql: auditFilterSql, values: auditValues } = buildSearchFilters(sectors, filters, 'a', includeGlobalAudit);
      const audit = await client.query(
        `SELECT a.id, a.request_id, a.actor_user_id, a.actor_name, a.actor_code, a.member_id,
                a.member_name, a.member_code, a.sector_id, a.weapon_id, a.weapon_name,
                a.action, a.quantity, a.reason, a.outcome, a.result, a.created_at
         FROM weapon_armory_audit a
         WHERE ${auditFilterSql}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT $${auditValues.length + 1}`,
        [...auditValues, 200]
      );
      return {
        ok: true,
        weapons: (weapons.rows || []).map((row) => ({
          id: row.id, name: row.name, imageUrl: row.image_url || '', icon: row.icon,
          returnAllowed: row.return_allowed === true, active: row.active === true,
          sectorId: row.sector_id, availableQuantity: Number(row.available_quantity) || 0,
          enabled: row.enabled === true
        })),
        issues: (issues.rows || []).map((row) => ({
          id: row.id, memberId: row.member_id, memberName: row.member_name,
          memberCode: row.member_code, sectorId: row.sector_id, weaponId: row.weapon_id,
          weaponName: row.weapon_name, status: row.status, issuedAt: row.issued_at,
          returnedAt: row.returned_at, memberWeaponCount: Number(row.member_weapon_count) || 0,
          memberActiveCount: Number(row.member_active_count) || 0
        })),
        audit: (audit.rows || []).map((row) => ({
          id: row.id, requestId: row.request_id, actorUserId: row.actor_user_id, actorName: row.actor_name,
          actorCode: row.actor_code, memberId: row.member_id, memberName: row.member_name,
          memberCode: row.member_code, sectorId: row.sector_id, weaponId: row.weapon_id,
          weaponName: row.weapon_name, action: row.action, quantity: Number(row.quantity) || 0,
          reason: row.reason, outcome: row.outcome, result: decodeJson(row.result, {}),
          createdAt: row.created_at
        }))
      };
    });
  }
}

function buildSearchFilters(sectors, filters, alias, includeGlobal = false) {
  const values = [sectors];
  const clauses = [includeGlobal
    ? `(${alias}.sector_id = ANY($1::text[]) OR ${alias}.sector_id IS NULL)`
    : `${alias}.sector_id = ANY($1::text[])`];
  const search = clean(filters.search, 120).toLocaleLowerCase();
  if (search) {
    values.push(`%${search}%`);
    const index = values.length;
    clauses.push(`(
      LOWER(COALESCE(${alias}.member_name, '')) LIKE $${index}
      OR LOWER(COALESCE(${alias}.member_code, '')) LIKE $${index}
      OR LOWER(COALESCE(${alias}.weapon_name, '')) LIKE $${index}
    )`);
  }
  const from = clean(filters.from, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    values.push(from);
    clauses.push(`${alias}.${alias === 'i' ? 'issued_at' : 'created_at'} >= $${values.length}::date`);
  }
  const to = clean(filters.to, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    values.push(to);
    clauses.push(`${alias}.${alias === 'i' ? 'issued_at' : 'created_at'} < ($${values.length}::date + INTERVAL '1 day')`);
  }
  return { sql: clauses.join(' AND '), values };
}

module.exports = {
  WEAPON_LIMIT,
  SCHEMA_SQL,
  WeaponArmoryStore,
  buildSearchFilters,
  normalizeSectors,
  safeImageUrl,
  validRequestId
};
