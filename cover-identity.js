'use strict';

/*
  BLACKRIDGE CIA - COVER IDENTITY SYSTEM
  Fictional in-game badges / field identities for GTA V Roleplay only.
  These are NOT real government documents.

  Storage: state.cia_cover_badges (array inside the existing JSONB snapshot).
  History: every badge keeps its own permanent `history` array. Revoking a badge
  never deletes the record. The shared audit log (capped at 500 rows) is also written.
  Permissions are always checked here on the server, never only in the UI.
*/

const BADGE_TYPES = Object.freeze({
  MILITARY: { label: 'Military ID', labelAr: 'بادج عسكري' },
  POLICE: { label: 'Police ID', labelAr: 'بادج شرطة' },
  EMS: { label: 'EMS ID', labelAr: 'بادج إسعاف' },
  MEDIA: { label: 'Media ID', labelAr: 'بادج إعلامي' },
  JUSTICE: { label: 'Justice ID', labelAr: 'بادج وزارة العدل' },
  CIVILIAN: { label: 'Civilian ID', labelAr: 'هوية مدنية' }
});

const REVIEW_STATUS = Object.freeze({
  PENDING: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED'
});

const LIMITS = Object.freeze({
  maxActivePerMember: 10,
  maxLifetimeDays: 365,
  ownerRenewDays: 30,
  maxPhotoChars: 350000,
  maxPageSize: 50,
  maxActivityRows: 100,
  expirySweepIntervalMs: 30000
});

const DAY_MS = 24 * 60 * 60 * 1000;
const PHOTO_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,22}[A-Z0-9]$/;
let expirySweepTimer = null;

function text(value, max) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function normalizeBadgeNumber(value) {
  return text(value, 40).toUpperCase().replace(/\s+/g, '-');
}

function parseDate(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : NaN;
}

function approvalStatusOf(badge) {
  const review = badge && badge.review;
  if (!review || !review.decidedAt || !review.decidedBy || review.decidedBy.userId == null) {
    return REVIEW_STATUS.PENDING;
  }
  if ([REVIEW_STATUS.APPROVED, REVIEW_STATUS.REJECTED].includes(review.status)) return review.status;
  return REVIEW_STATUS.PENDING;
}

// An unreviewed legacy ACTIVE badge is treated as pending, never as approved.
function effectiveStatus(badge, nowMs) {
  if (!badge) return 'REVOKED';
  if (badge.status === 'REVOKED') return 'REVOKED';
  if (badge.status === 'DISABLED') return 'DISABLED';
  const approvalStatus = approvalStatusOf(badge);
  if (approvalStatus === REVIEW_STATUS.REJECTED) return 'REJECTED';
  if (approvalStatus !== REVIEW_STATUS.APPROVED) return REVIEW_STATUS.PENDING;
  if (badge.status === 'EXPIRED') return 'EXPIRED';
  const expires = parseDate(badge.expiresAt);
  if (!Number.isFinite(expires) || expires <= nowMs) return 'EXPIRED';
  return 'ACTIVE';
}

function validateBadgeFields(input, options) {
  const opts = options || {};
  const partial = opts.partial === true;
  const errors = [];
  const out = {};
  const source = input && typeof input === 'object' ? input : {};

  const need = (key) => !partial || source[key] !== undefined;

  if (!partial) {
    const type = text(source.type, 20).toUpperCase();
    if (!BADGE_TYPES[type]) errors.push('نوع البادج غير صالح.');
    out.type = type;
  }
  if (need('alias')) {
    out.alias = text(source.alias, 60);
    if (out.alias.length < 2) errors.push('الاسم المستعار مطلوب (حرفان على الأقل).');
  }
  if (need('title')) {
    out.title = text(source.title, 60);
    if (out.title.length < 2) errors.push('الرتبة أو الصفة داخل الهوية مطلوبة.');
  }
  if (need('sector')) {
    out.sector = text(source.sector, 80);
    if (out.sector.length < 2) errors.push('القطاع أو الجهة الظاهرة في الهوية مطلوبة.');
  }
  if (need('purpose')) {
    out.purpose = text(source.purpose, 300);
    if (out.purpose.length < 3) errors.push('سبب إنشاء الهوية أو اسم المهمة مطلوب.');
  }
  if (source.photo !== undefined) {
    const photo = String(source.photo || '');
    if (photo === '') out.photo = '';
    else if (photo.length > LIMITS.maxPhotoChars || !PHOTO_PATTERN.test(photo)) {
      errors.push('الصورة غير صالحة. المسموح PNG أو JPG أو WEBP بحجم أصغر.');
    } else out.photo = photo;
  }
  return { errors, value: out };
}

function createCoverIdentity(ctx) {
  const nowMs = () => (typeof ctx.nowMs === 'function' ? ctx.nowMs() : Date.now());
  const nowIso = () => new Date(nowMs()).toISOString();

  function badges() {
    const state = ctx.getState();
    if (!Array.isArray(state.cia_cover_badges)) state.cia_cover_badges = [];
    return state.cia_cover_badges;
  }

  function codeOf(user) {
    return text(user && user.publicCode, 100).toUpperCase();
  }

  function realNameOf(user) {
    return text((user && user.identity && user.identity.fullName) || (user && user.name) || '', 120);
  }

  function ownerOf(badge) {
    return ctx.getUsers().find((user) => String(user.id) === String(badge.owner && badge.owner.userId)) || null;
  }

  function commandedUnits(actor) {
    const mine = codeOf(actor);
    if (!mine) return [];
    return (ctx.getUnits() || []).filter((unit) =>
      unit &&
      unit.status !== 'ARCHIVED' &&
      text(unit.commanderCode, 100).toUpperCase() === mine
    );
  }

  // A sector leader's access is derived from active assignments, never the badge's user-entered sector.
  function commandedMemberCodes(actor) {
    const mine = codeOf(actor);
    const codes = new Set();
    if (!mine) return codes;
    for (const unit of commandedUnits(actor)) {
      for (const code of Array.isArray(unit.memberCodes) ? unit.memberCodes : []) {
        const normalized = text(code, 100).toUpperCase();
        if (normalized && normalized !== mine) codes.add(normalized);
      }
    }
    return codes;
  }

  function sectorFor(actor) {
    if (!actor) return '';
    if (ctx.isChief(actor) || ctx.isSenior(actor)) return 'القيادة العليا';
    const code = codeOf(actor);
    const units = ctx.isHighCommander(actor)
      ? commandedUnits(actor)
      : (ctx.getUnits() || []).filter((unit) => {
        if (!unit || unit.status === 'ARCHIVED') return false;
        const members = Array.isArray(unit.memberCodes) ? unit.memberCodes : [];
        return [unit.commanderCode, unit.deputyCode, ...members]
          .some((memberCode) => text(memberCode, 100).toUpperCase() === code);
      });
    const sectors = [...new Set(units
      .map((unit) => text(unit.sector || unit.nameAr || unit.nameEn || unit.name || unit.code, 100))
      .filter(Boolean))];
    return sectors.join(' / ') || '';
  }

  // Which badges may this actor look at? ALL (chief, senior) / SECTOR (assigned commander) / OWN only
  function scopeFor(actor) {
    if (!actor) return 'NONE';
    if (ctx.isChief(actor) || ctx.isSenior(actor)) return 'ALL';
    if (ctx.isHighCommander(actor) && commandedMemberCodes(actor).size > 0) return 'SECTOR';
    return 'OWN';
  }

  function canView(actor, badge) {
    if (!actor || !badge) return false;
    if (String(badge.owner.userId) === String(actor.id)) return true;
    const scope = scopeFor(actor);
    if (scope === 'ALL') return true;
    if (scope === 'SECTOR') {
      const owner = ownerOf(badge);
      const ownerCode = owner ? codeOf(owner) : text(badge.owner.militaryCode, 100).toUpperCase();
      return commandedMemberCodes(actor).has(ownerCode);
    }
    return false;
  }

  function isOwner(actor, badge) {
    return !!actor && !!badge && String(badge.owner.userId) === String(actor.id);
  }

  function ownerVisibility(actor, badge) {
    const mine = isOwner(actor, badge);
    return {
      name: mine || ctx.isChief(actor) || ctx.isHighCommander(actor),
      militaryCode: mine || ctx.isChief(actor) || ctx.isSenior(actor),
      rank: mine || ctx.isChief(actor)
    };
  }

  function historyItemForViewer(item, actor, badge) {
    const owner = ownerOf(badge);
    const ownerCode = owner ? codeOf(owner) : text(badge.owner.militaryCode, 100).toUpperCase();
    const authorCode = text(item && item.byCode, 100).toUpperCase();
    const ownerName = owner ? text(owner.name, 120) : text(badge.owner.name, 120);
    const authorName = text(item && item.byName, 120);
    const isOwnerAction = (ownerCode && ownerCode === authorCode) ||
      (!authorCode && ownerName && ownerName === authorName);
    if (!isOwnerAction) return { ...item };
    const visible = ownerVisibility(actor, badge);
    const result = { ...item };
    if (!visible.name) result.byName = '';
    if (!visible.militaryCode) result.byCode = '';
    if (!visible.rank) result.byRank = '';
    return result;
  }

  function canReview(actor, badge) {
    if (!actor || !badge) return false;
    if (ctx.isSenior(actor)) return true;
    if (!ctx.isHighCommander(actor) || isOwner(actor, badge)) return false;
    const owner = ownerOf(badge);
    const ownerCode = owner ? codeOf(owner) : text(badge.owner.militaryCode, 100).toUpperCase();
    return !!ownerCode && commandedMemberCodes(actor).has(ownerCode);
  }

  function reviewRecord(badge) {
    const review = badge && badge.review && typeof badge.review === 'object' ? badge.review : {};
    return {
      status: approvalStatusOf(badge),
      reason: text(review.reason || (review.status === REVIEW_STATUS.REJECTED ? badge.statusReason : ''), 300),
      decidedAt: text(review.decidedAt, 80),
      decidedBy: review.decidedBy && typeof review.decidedBy === 'object' ? { ...review.decidedBy } : null,
      decisions: Array.isArray(review.decisions) ? review.decisions.map((item) => ({ ...item })) : []
    };
  }

  function event(action, actor, note) {
    return {
      id: ctx.makeId('CVH'),
      action,
      at: nowIso(),
      byId: actor ? actor.id : null,
      byName: actor ? realNameOf(actor) : 'SYSTEM',
      byCode: actor ? codeOf(actor) : '',
      byRank: actor ? text(ctx.normalizeRank(actor.rank), 100) : '',
      bySector: actor ? sectorFor(actor) : '',
      note: text(note, 300)
    };
  }

  // Marks stored ACTIVE badges that have passed their end date; keeps the record and writes history once.
  function sweepExpired() {
    let changed = false;
    const current = nowMs();
    for (const badge of badges()) {
      if (badge.status === 'ACTIVE' && approvalStatusOf(badge) === REVIEW_STATUS.APPROVED &&
          effectiveStatus(badge, current) === 'EXPIRED') {
        badge.status = 'EXPIRED';
        badge.updatedAt = nowIso();
        if (!Array.isArray(badge.history)) badge.history = [];
        badge.history.push(event('EXPIRED', null, 'انتهت صلاحية البادج تلقائيًا.'));
        const owner = badge.owner || {};
        ctx.addAuditLog(
          'COVER_BADGE_EXPIRED',
          null,
          { id: owner.userId || null, name: owner.name || '', publicCode: owner.militaryCode || '' },
          'badge=' + badge.badgeNumber
        );
        changed = true;
      }
    }
    return changed;
  }

  function view(badge, actor, options) {
    const opts = options || {};
    const mine = isOwner(actor, badge);
    const review = reviewRecord(badge);
    const status = effectiveStatus(badge, nowMs());
    const ownerAccess = ownerVisibility(actor, badge);
    const canReviewBadge = canReview(actor, badge) &&
      review.status === REVIEW_STATUS.PENDING &&
      !['REVOKED', 'DISABLED'].includes(badge.status);
    const row = {
      id: badge.id,
      badgeNumber: badge.badgeNumber,
      type: badge.type,
      typeLabel: BADGE_TYPES[badge.type] ? BADGE_TYPES[badge.type].labelAr : badge.type,
      alias: badge.alias,
      title: badge.title,
      sector: badge.sector,
      purpose: badge.purpose,
      createdAt: badge.createdAt,
      expiresAt: badge.expiresAt,
      updatedAt: badge.updatedAt,
      status,
      reviewStatus: review.status,
      reviewReason: review.status === REVIEW_STATUS.REJECTED ? review.reason : '',
      review,
      isApproved: review.status === REVIEW_STATUS.APPROVED,
      statusReason: review.status === REVIEW_STATUS.REJECTED ? review.reason : (badge.statusReason || ''),
      hasPhoto: !!badge.photo,
      mine,
      owner: {
        name: ownerAccess.name ? badge.owner.name : '',
        militaryCode: ownerAccess.militaryCode ? badge.owner.militaryCode : '',
        rank: ownerAccess.rank ? badge.owner.rank : ''
      },
      can: {
        edit: mine && !['REVOKED', 'DISABLED'].includes(status),
        renew: (mine || ctx.isChief(actor)) && review.status === REVIEW_STATUS.APPROVED && !['REVOKED', 'DISABLED', REVIEW_STATUS.PENDING, REVIEW_STATUS.REJECTED].includes(status),
        revoke: (mine || ctx.isChief(actor) || ctx.isSenior(actor)) && badge.status !== 'REVOKED',
        disable: (ctx.isChief(actor) || ctx.isSenior(actor)) && review.status === REVIEW_STATUS.APPROVED && ['ACTIVE', 'EXPIRED'].includes(status),
        enable: ctx.isChief(actor) && review.status === REVIEW_STATUS.APPROVED && badge.status === 'DISABLED',
        review: canReviewBadge,
        approve: canReviewBadge && parseDate(badge.expiresAt) > nowMs(),
        reject: canReviewBadge
      }
    };
    if (opts.withPhoto) row.photo = badge.photo || '';
    if (opts.withHistory) {
      row.history = (Array.isArray(badge.history) ? badge.history : []).map((item) => historyItemForViewer(item, actor, badge));
      row.review.decisions = review.decisions;
    } else {
      row.review.decisions = [];
    }
    return row;
  }

  function generateNumber(type) {
    const prefix = { MILITARY: 'MIL', POLICE: 'PD', EMS: 'EMS', MEDIA: 'MED', JUSTICE: 'DOJ', CIVILIAN: 'CIV' }[type] || 'ID';
    const used = new Set(badges().map((badge) => badge.badgeNumber));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const digits = String(Math.floor(100000 + Math.random() * 900000));
      const candidate = prefix + '-' + digits;
      if (!used.has(candidate)) return candidate;
    }
    return prefix + '-' + Date.now().toString().slice(-8);
  }

  async function persist(backup, actor, action, owner, details) {
    const state = ctx.getState();
    const auditBackup = Array.isArray(state.cia_audit_logs) ? state.cia_audit_logs.slice() : null;
    try {
      ctx.addAuditLog(action, actor, owner, details);
      await ctx.saveState();
      return null;
    } catch (error) {
      state.cia_cover_badges = backup;
      if (auditBackup) state.cia_audit_logs = auditBackup;
      return 'تعذر حفظ التغيير. أعد المحاولة.';
    }
  }

  const snapshotBadges = () => badges().map((badge) => ({
    ...badge,
    owner: { ...(badge.owner || {}) },
    history: Array.isArray(badge.history) ? badge.history.map((item) => ({ ...item })) : [],
    review: badge.review && typeof badge.review === 'object'
      ? {
        ...badge.review,
        decidedBy: badge.review.decidedBy ? { ...badge.review.decidedBy } : null,
        decisions: Array.isArray(badge.review.decisions) ? badge.review.decisions.map((item) => ({ ...item })) : []
      }
      : badge.review
  }));

  async function sweepAndPersist() {
    const state = ctx.getState();
    const badgeBackup = snapshotBadges();
    const auditBackup = Array.isArray(state.cia_audit_logs) ? state.cia_audit_logs.slice() : null;
    if (!sweepExpired()) return false;
    try {
      await ctx.saveState();
      return true;
    } catch (_error) {
      state.cia_cover_badges = badgeBackup;
      if (auditBackup) state.cia_audit_logs = auditBackup;
      return false;
    }
  }

  function startExpirySweep() {
    if (expirySweepTimer) return;
    expirySweepTimer = setInterval(() => {
      sweepAndPersist().catch((error) => {
        console.error('[BLACK RIDGE] cover identity expiry sweep failed:', error && error.message);
      });
    }, LIMITS.expirySweepIntervalMs);
    if (expirySweepTimer && typeof expirySweepTimer.unref === 'function') expirySweepTimer.unref();
  }

  function find(id) {
    const wanted = text(id, 120);
    return badges().find((badge) => badge.id === wanted) || null;
  }

  function parseExpiry(value, maxDays, fromMs) {
    const expires = parseDate(value);
    const start = fromMs || nowMs();
    if (!Number.isFinite(expires)) return { error: 'تاريخ انتهاء الصلاحية غير صالح.' };
    if (expires <= nowMs() + 60 * 1000) return { error: 'تاريخ انتهاء الصلاحية يجب أن يكون في المستقبل.' };
    if (expires > start + maxDays * DAY_MS) return { error: 'مدة الصلاحية أطول من الحد المسموح (' + maxDays + ' يومًا).' };
    return { iso: new Date(expires).toISOString() };
  }

  async function decideReview(actor, payload, decision) {
    const badge = find(payload && payload.id);
    if (!badge || !canView(actor, badge)) return { ok: false, message: 'البادج غير موجود.' };
    if (!canReview(actor, badge)) return { ok: false, message: 'لا تملك صلاحية مراجعة هذه الهوية.' };
    if (approvalStatusOf(badge) !== REVIEW_STATUS.PENDING) return { ok: false, message: 'هذه الهوية ليست قيد المراجعة.' };
    if (['REVOKED', 'DISABLED'].includes(badge.status)) return { ok: false, message: 'لا يمكن مراجعة هوية ملغاة أو معطلة.' };

    const reason = decision === REVIEW_STATUS.REJECTED ? text(payload && payload.reason, 300) : '';
    if (decision === REVIEW_STATUS.REJECTED && reason.length < 3) {
      return { ok: false, message: 'اكتب سبب الرفض (ثلاثة أحرف على الأقل).' };
    }
    if (decision === REVIEW_STATUS.APPROVED) {
      const expires = parseDate(badge.expiresAt);
      if (!Number.isFinite(expires) || expires <= nowMs()) {
        return { ok: false, message: 'انتهت صلاحية الهوية؛ أنشئ هوية جديدة قبل طلب اعتمادها.' };
      }
    }

    const backup = snapshotBadges();
    const previousReview = reviewRecord(badge);
    const stamp = nowIso();
    const reviewer = {
      userId: actor.id,
      name: realNameOf(actor),
      militaryCode: codeOf(actor),
      rank: text(ctx.normalizeRank(actor.rank), 100),
      sector: sectorFor(actor)
    };
    const entry = {
      id: ctx.makeId('CVH'),
      action: decision,
      at: stamp,
      byId: reviewer.userId,
      byName: reviewer.name,
      byCode: reviewer.militaryCode,
      byRank: reviewer.rank,
      bySector: reviewer.sector,
      reason,
      note: reason
    };

    badge.review = {
      status: decision,
      reason,
      decidedAt: stamp,
      decidedBy: reviewer,
      decisions: [...previousReview.decisions, entry]
    };
    badge.status = decision === REVIEW_STATUS.APPROVED ? 'ACTIVE' : REVIEW_STATUS.REJECTED;
    badge.statusReason = reason;
    badge.updatedAt = stamp;
    if (!Array.isArray(badge.history)) badge.history = [];
    badge.history.push(entry);

    const action = decision === REVIEW_STATUS.APPROVED ? 'COVER_BADGE_APPROVED' : 'COVER_BADGE_REJECTED';
    const details = [
      'badge=' + badge.badgeNumber,
      'reviewer=' + reviewer.name,
      'code=' + reviewer.militaryCode,
      'rank=' + reviewer.rank,
      'sector=' + reviewer.sector,
      'at=' + stamp,
      reason ? 'reason=' + reason : ''
    ].filter(Boolean).join(' ');
    const failure = await persist(backup, actor, action, ownerOf(badge), details);
    if (failure) return { ok: false, message: failure };
    return { ok: true, badge: view(badge, actor, { withPhoto: true, withHistory: true }) };
  }

  const handlers = {
    meta(actor) {
      const scope = scopeFor(actor);
      return {
        ok: true,
        types: Object.entries(BADGE_TYPES).map(([key, value]) => ({ key, label: value.label, labelAr: value.labelAr })),
        scope,
        canAdmin: scope !== 'OWN',
        isChief: ctx.isChief(actor),
        limits: { ...LIMITS },
        notice: 'وثيقة خيالية للاستخدام داخل BLACKRIDGE CITY ROLEPLAY فقط'
      };
    },

    async create(actor, payload) {
      const checked = validateBadgeFields(payload, {});
      if (checked.errors.length) return { ok: false, message: checked.errors[0] };
      const mineActive = badges().filter((badge) => String(badge.owner.userId) === String(actor.id) &&
        effectiveStatus(badge, nowMs()) === 'ACTIVE').length;
      if (mineActive >= LIMITS.maxActivePerMember) {
        return { ok: false, message: 'وصلت للحد الأقصى من البادجات الفعالة (' + LIMITS.maxActivePerMember + '). ألغِ بادجًا قبل إنشاء آخر.' };
      }
      const expiry = parseExpiry(payload && payload.expiresAt, LIMITS.maxLifetimeDays);
      if (expiry.error) return { ok: false, message: expiry.error };

      let number = normalizeBadgeNumber(payload && payload.badgeNumber);
      if (!number) number = generateNumber(checked.value.type);
      if (!NUMBER_PATTERN.test(number)) return { ok: false, message: 'رقم البادج يقبل حروفًا إنجليزية وأرقامًا وشرطة فقط (4 إلى 24 خانة).' };
      if (badges().some((badge) => badge.badgeNumber === number)) {
        return { ok: false, message: 'رقم البادج مستخدم سابقًا. اختر رقمًا آخر.' };
      }

      const stamp = nowIso();
      const badge = {
        id: ctx.makeId('CVR'),
        badgeNumber: number,
        type: checked.value.type,
        alias: checked.value.alias,
        title: checked.value.title,
        sector: checked.value.sector,
        purpose: checked.value.purpose,
        photo: checked.value.photo || '',
        createdAt: stamp,
        updatedAt: stamp,
        expiresAt: expiry.iso,
        status: REVIEW_STATUS.PENDING,
        statusReason: '',
        review: {
          status: REVIEW_STATUS.PENDING,
          reason: '',
          decidedAt: '',
          decidedBy: null,
          decisions: []
        },
        owner: {
          userId: actor.id,
          name: realNameOf(actor),
          militaryCode: codeOf(actor),
          rank: ctx.normalizeRank(actor.rank)
        },
        history: []
      };
      badge.history.push(event('CREATED', actor, 'إنشاء بادج ' + BADGE_TYPES[badge.type].labelAr + ' برقم ' + number + ' وإرساله للمراجعة.'));

      const backup = snapshotBadges();
      badges().unshift(badge);
      const failure = await persist(backup, actor, 'COVER_BADGE_CREATED', actor, 'badge=' + number + ' type=' + badge.type);
      if (failure) return { ok: false, message: failure };
      return { ok: true, badge: view(badge, actor, { withPhoto: true, withHistory: true }) };
    },

    async update(actor, payload) {
      const badge = find(payload && payload.id);
      if (!badge || !canView(actor, badge)) return { ok: false, message: 'البادج غير موجود.' };
      // A member can never edit another member's identity, command ranks included.
      if (!isOwner(actor, badge)) return { ok: false, message: 'لا يمكنك تعديل هوية عضو آخر.' };
      if (['REVOKED', 'DISABLED'].includes(effectiveStatus(badge, nowMs()))) return { ok: false, message: 'لا يمكن تعديل بادج ملغى أو معطل.' };
      const checked = validateBadgeFields(payload, { partial: true });
      if (checked.errors.length) return { ok: false, message: checked.errors[0] };
      const keys = Object.keys(checked.value);
      if (!keys.length) return { ok: false, message: 'لا توجد تعديلات.' };

      const backup = snapshotBadges();
      for (const key of keys) badge[key] = checked.value[key];
      const previousReview = reviewRecord(badge);
      badge.review = {
        status: REVIEW_STATUS.PENDING,
        reason: '',
        decidedAt: '',
        decidedBy: null,
        decisions: previousReview.decisions
      };
      badge.status = REVIEW_STATUS.PENDING;
      badge.statusReason = '';
      badge.updatedAt = nowIso();
      badge.history.push(event('UPDATED', actor, 'تعديل: ' + keys.join(', ') + '؛ أعيدت الهوية للمراجعة.'));
      const failure = await persist(backup, actor, 'COVER_BADGE_UPDATED', actor, 'badge=' + badge.badgeNumber + ' fields=' + keys.join(','));
      if (failure) return { ok: false, message: failure };
      return { ok: true, badge: view(badge, actor, { withPhoto: true, withHistory: true }) };
    },

    async renew(actor, payload) {
      const badge = find(payload && payload.id);
      if (!badge || !canView(actor, badge)) return { ok: false, message: 'البادج غير موجود.' };
      const mine = isOwner(actor, badge);
      if (!mine && !ctx.isChief(actor)) return { ok: false, message: 'التجديد متاح لصاحب البادج أو CIA CHIEF فقط.' };
      if (approvalStatusOf(badge) !== REVIEW_STATUS.APPROVED) return { ok: false, message: 'لا يمكن تجديد هوية قبل اعتمادها.' };
      if (['REVOKED', 'DISABLED'].includes(badge.status)) return { ok: false, message: 'لا يمكن تجديد بادج ملغى أو معطل.' };
      const maxDays = ctx.isChief(actor) ? LIMITS.maxLifetimeDays : LIMITS.ownerRenewDays;
      const expiry = parseExpiry(payload && payload.expiresAt, maxDays);
      if (expiry.error) return { ok: false, message: expiry.error };

      const backup = snapshotBadges();
      const previous = badge.expiresAt;
      badge.expiresAt = expiry.iso;
      badge.status = 'ACTIVE';
      badge.updatedAt = nowIso();
      badge.history.push(event('RENEWED', actor, 'من ' + previous + ' إلى ' + expiry.iso));
      const failure = await persist(backup, actor, 'COVER_BADGE_RENEWED', ownerOf(badge), 'badge=' + badge.badgeNumber);
      if (failure) return { ok: false, message: failure };
      return { ok: true, badge: view(badge, actor, { withHistory: true }) };
    },

    async revoke(actor, payload) {
      const badge = find(payload && payload.id);
      if (!badge || !canView(actor, badge)) return { ok: false, message: 'البادج غير موجود.' };
      const allowed = isOwner(actor, badge) || ctx.isChief(actor) || ctx.isSenior(actor);
      if (!allowed) return { ok: false, message: 'ليست لديك صلاحية إلغاء هذا البادج.' };
      if (badge.status === 'REVOKED') return { ok: false, message: 'البادج ملغى مسبقًا.' };
      const reason = text(payload && payload.reason, 300);
      if (reason.length < 3) return { ok: false, message: 'اكتب سبب الإلغاء (انتهاء المهمة مثلًا).' };

      const backup = snapshotBadges();
      badge.status = 'REVOKED';
      badge.statusReason = reason;
      badge.revokedAt = nowIso();
      badge.updatedAt = badge.revokedAt;
      badge.history.push(event('REVOKED', actor, reason));
      const failure = await persist(backup, actor, 'COVER_BADGE_REVOKED', ownerOf(badge), 'badge=' + badge.badgeNumber);
      if (failure) return { ok: false, message: failure };
      return { ok: true, badge: view(badge, actor, { withHistory: true }) };
    },

    async disable(actor, payload) {
      const badge = find(payload && payload.id);
      if (!badge || !canView(actor, badge)) return { ok: false, message: 'البادج غير موجود.' };
      if (!ctx.isChief(actor) && !ctx.isSenior(actor)) return { ok: false, message: 'التعطيل متاح للقيادة العليا فقط.' };
      if (approvalStatusOf(badge) !== REVIEW_STATUS.APPROVED) return { ok: false, message: 'لا يمكن تعطيل هوية قبل اعتمادها.' };
      if (!['ACTIVE', 'EXPIRED'].includes(badge.status)) return { ok: false, message: 'لا يمكن تعطيل هذا البادج في حالته الحالية.' };
      const reason = text(payload && payload.reason, 300);
      if (reason.length < 3) return { ok: false, message: 'اكتب سبب التعطيل.' };

      const backup = snapshotBadges();
      badge.status = 'DISABLED';
      badge.statusReason = reason;
      badge.updatedAt = nowIso();
      badge.history.push(event('DISABLED', actor, reason));
      const failure = await persist(backup, actor, 'COVER_BADGE_DISABLED', ownerOf(badge), 'badge=' + badge.badgeNumber);
      if (failure) return { ok: false, message: failure };
      return { ok: true, badge: view(badge, actor, { withHistory: true }) };
    },

    async enable(actor, payload) {
      const badge = find(payload && payload.id);
      if (!badge || !canView(actor, badge)) return { ok: false, message: 'البادج غير موجود.' };
      if (!ctx.isChief(actor)) return { ok: false, message: 'إعادة التفعيل متاحة لـ CIA CHIEF فقط.' };
      if (approvalStatusOf(badge) !== REVIEW_STATUS.APPROVED) return { ok: false, message: 'لا يمكن تفعيل هوية قبل اعتمادها.' };
      if (badge.status !== 'DISABLED') return { ok: false, message: 'البادج غير معطل.' };

      const backup = snapshotBadges();
      badge.status = 'ACTIVE';
      badge.statusReason = '';
      badge.updatedAt = nowIso();
      badge.history.push(event('ENABLED', actor, 'إعادة تفعيل البادج.'));
      const failure = await persist(backup, actor, 'COVER_BADGE_ENABLED', ownerOf(badge), 'badge=' + badge.badgeNumber);
      if (failure) return { ok: false, message: failure };
      return { ok: true, badge: view(badge, actor, { withHistory: true }) };
    },

    async approve(actor, payload) {
      return decideReview(actor, payload, REVIEW_STATUS.APPROVED);
    },

    async reject(actor, payload) {
      return decideReview(actor, payload, REVIEW_STATUS.REJECTED);
    },

    async mine(actor) {
      await sweepAndPersist();
      const rows = badges().filter((badge) => isOwner(actor, badge)).map((badge) => view(badge, actor, { withPhoto: true, withHistory: true }));
      return { ok: true, badges: rows };
    },

    async get(actor, payload) {
      await sweepAndPersist();
      const badge = find(payload && payload.id);
      if (!badge || !canView(actor, badge)) return { ok: false, message: 'البادج غير موجود.' };
      return { ok: true, badge: view(badge, actor, { withPhoto: true, withHistory: true }) };
    },

    async adminList(actor, payload) {
      const scope = scopeFor(actor);
      if (scope === 'OWN' || scope === 'NONE') return { ok: false, message: 'لوحة القيادة متاحة للقيادة فقط.' };
      await sweepAndPersist();
      const query = text(payload && payload.query, 80).toLowerCase();
      const type = text(payload && payload.type, 20).toUpperCase();
      const status = text(payload && payload.status, 20).toUpperCase();
      const limit = Math.max(1, Math.min(LIMITS.maxPageSize, Number(payload && payload.limit) || LIMITS.maxPageSize));
      const offset = Math.max(0, Math.min(100000, Number(payload && payload.offset) || 0));

      let rows = badges().filter((badge) => canView(actor, badge));
      if (BADGE_TYPES[type]) rows = rows.filter((badge) => badge.type === type);
      if (['ACTIVE', 'EXPIRED', 'DISABLED', 'REVOKED', REVIEW_STATUS.PENDING, REVIEW_STATUS.REJECTED].includes(status)) {
        rows = rows.filter((badge) => effectiveStatus(badge, nowMs()) === status);
      }
      if (query) {
        rows = rows.filter((badge) => {
          const visibleOwner = ownerVisibility(actor, badge);
          return [
            badge.badgeNumber, badge.alias,
            visibleOwner.name ? badge.owner.name : '',
            visibleOwner.militaryCode ? badge.owner.militaryCode : '',
            badge.type, BADGE_TYPES[badge.type] ? BADGE_TYPES[badge.type].labelAr : ''
          ].some((field) => String(field || '').toLowerCase().includes(query));
        });
      }
      const total = rows.length;
      const page = rows.slice(offset, offset + limit).map((badge) => view(badge, actor, {}));
      return { ok: true, total, badges: page, scope };
    },

    async adminActivity(actor) {
      const scope = scopeFor(actor);
      if (scope === 'OWN' || scope === 'NONE') return { ok: false, message: 'لوحة القيادة متاحة للقيادة فقط.' };
      await sweepAndPersist();
      const feed = [];
      for (const badge of badges()) {
        if (!canView(actor, badge)) continue;
        for (const item of badge.history) {
          const visibleOwner = ownerVisibility(actor, badge);
          feed.push({
            ...historyItemForViewer(item, actor, badge),
            badgeNumber: badge.badgeNumber,
            type: badge.type,
            alias: badge.alias,
            ownerName: visibleOwner.name ? badge.owner.name : '',
            ownerCode: visibleOwner.militaryCode ? badge.owner.militaryCode : ''
          });
        }
      }
      feed.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return { ok: true, activity: feed.slice(0, LIMITS.maxActivityRows) };
    }
  };

  return { handlers, scopeFor, canView, view, sweepExpired, sweepAndPersist, startExpirySweep };
}

function injectCoverIdentityMarkup(html) {
  let output = String(html || '');
  if (!output.includes('href="/cover-identity.css"')) {
    output = output.replace(
      /<\/head>/i,
      '  <link rel="stylesheet" href="/cover-identity.css">\n</head>'
    );
  }
  if (!output.includes('id="cover-identity-nav"')) {
    const navItem = '<li id="cover-identity-nav" class="nav-btn" style="display: none;" onclick="showPane(\'cover-identity-view\', this)"><i class="fa-solid fa-address-card"></i> الهويات الميدانية</li>';
    output = output.replace(
      /(<li id="chief-nav"[^>]*>[\s\S]*?<\/li>)/i,
      (match) => match + '\n      ' + navItem
    );
  }
  if (!output.includes('src="/cover-identity-client.js"')) {
    output = output.replace(
      /<\/body>/i,
      '  <script src="/cover-identity-client.js"></script>\n</body>'
    );
  }
  return output;
}

function registerCoverIdentitySocket(socket, ctx) {
  const api = createCoverIdentity(ctx);
  api.startExpirySweep();
  const bind = (eventName, handlerName) => {
    socket.on(eventName, async (payload, callback) => {
      const actor = ctx.requireSocketUser(socket);
      if (!actor) return ctx.no(callback, 'يجب تسجيل الدخول.');
      try {
        const result = await api.handlers[handlerName](actor, payload);
        if (result && result.ok) {
          const { ok: _ok, ...rest } = result;
          return ctx.ok(callback, rest);
        }
        return ctx.no(callback, (result && result.message) || 'تعذر تنفيذ الطلب.');
      } catch (error) {
        console.error('[BLACK RIDGE] cover identity error:', error && error.message);
        return ctx.no(callback, 'تعذر تنفيذ الطلب.');
      }
    });
  };
  bind('cover:meta', 'meta');
  bind('cover:mine', 'mine');
  bind('cover:get', 'get');
  bind('cover:create', 'create');
  bind('cover:update', 'update');
  bind('cover:approve', 'approve');
  bind('cover:reject', 'reject');
  bind('cover:renew', 'renew');
  bind('cover:revoke', 'revoke');
  bind('cover:disable', 'disable');
  bind('cover:enable', 'enable');
  bind('cover:admin:list', 'adminList');
  bind('cover:admin:activity', 'adminActivity');
}

module.exports = {
  BADGE_TYPES,
  REVIEW_STATUS,
  LIMITS,
  createCoverIdentity,
  injectCoverIdentityMarkup,
  registerCoverIdentitySocket,
  effectiveStatus,
  normalizeBadgeNumber,
  validateBadgeFields
};
