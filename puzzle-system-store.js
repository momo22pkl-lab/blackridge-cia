'use strict';

const crypto = require('node:crypto');

const MAX_IMAGE_BYTES = 1_400_000;
const MAX_PIECE_BYTES = 260_000;
const MAX_PIECE_COUNT = 36;
const MAX_REQUEST_BYTES = 5_500_000;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS blackridge_puzzles (
    id TEXT PRIMARY KEY,
    share_token TEXT NOT NULL UNIQUE,
    creator_user_id TEXT NOT NULL,
    creator_code TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    clue TEXT NOT NULL,
    answer_text TEXT NOT NULL,
    answer_salt TEXT NOT NULL,
    answer_hash TEXT NOT NULL,
    solution_note TEXT NOT NULL DEFAULT '',
    image_mime TEXT NOT NULL,
    image_data BYTEA NOT NULL,
    image_width SMALLINT NOT NULL,
    image_height SMALLINT NOT NULL,
    rows SMALLINT NOT NULL,
    cols SMALLINT NOT NULL,
    piece_bleed SMALLINT NOT NULL,
    pieces JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active BOOLEAN NOT NULL DEFAULT TRUE
  )`,
  'CREATE INDEX IF NOT EXISTS idx_blackridge_puzzles_created ON blackridge_puzzles (created_at DESC)',
  `CREATE TABLE IF NOT EXISTS blackridge_puzzle_creator_permissions (
    agent_user_id TEXT PRIMARY KEY,
    agent_code TEXT NOT NULL DEFAULT '',
    granted_by_user_id TEXT NOT NULL,
    granted_by_code TEXT NOT NULL DEFAULT '',
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS blackridge_puzzle_permission_audit (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT NOT NULL,
    actor_code TEXT NOT NULL DEFAULT '',
    target_user_id TEXT NOT NULL,
    target_code TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL CHECK (action IN ('GRANTED', 'REVOKED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_blackridge_puzzle_permission_audit_created ON blackridge_puzzle_permission_audit (created_at DESC)'
];

function clean(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizeAnswer(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/\u0640/g, '')
    .toLocaleLowerCase('ar')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function hashAnswer(value, salt) {
  return crypto.scryptSync(normalizeAnswer(value), salt, 32).toString('hex');
}

function verifyAnswer(puzzle, value) {
  if (!puzzle || !puzzle.answer_salt || !puzzle.answer_hash) return false;
  const expected = Buffer.from(String(puzzle.answer_hash), 'hex');
  const actual = Buffer.from(hashAnswer(value, puzzle.answer_salt), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function hasImageSignature(buffer, mime) {
  if (mime === 'image/png') {
    return buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mime === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/webp') {
    return buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function decodeImageDataUrl(value, maxBytes = MAX_IMAGE_BYTES) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(String(value || ''));
  if (!match) throw new Error('الصورة غير صالحة؛ ارفع JPEG أو PNG أو WebP.');
  const mime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > maxBytes) throw new Error('حجم الصورة أكبر من الحد المسموح.');
  if (buffer.toString('base64') !== match[2] || !hasImageSignature(buffer, mime)) {
    throw new Error('تعذر التحقق من محتوى الصورة.');
  }
  return { mime, buffer };
}

function normalizePuzzlePayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('بيانات اللغز غير مكتملة.');
  const rows = Number(input.rows);
  const cols = Number(input.cols);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2 || rows * cols > MAX_PIECE_COUNT) {
    throw new Error('عدد قطع البازل غير صالح.');
  }
  const title = clean(input.title, 100);
  const clue = clean(input.clue, 800);
  const answer = clean(input.answer, 120);
  const hint = clean(input.hint, 300);
  const solutionNote = clean(input.solutionNote, 500);
  if (!title || !clue || normalizeAnswer(answer).length < 2) {
    throw new Error('أدخل عنوانًا ولغزًا وإجابة صحيحة.');
  }
  const image = decodeImageDataUrl(input.image, MAX_IMAGE_BYTES);
  const imageWidth = Number(input.imageWidth);
  const imageHeight = Number(input.imageHeight);
  const bleed = Number(input.bleed);
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight) ||
      imageWidth < 100 || imageHeight < 100 || imageWidth > 1400 || imageHeight > 1400 ||
      !Number.isInteger(bleed) || bleed < 2 || bleed > 100) {
    throw new Error('أبعاد الصورة غير صالحة.');
  }
  if (!Array.isArray(input.pieces) || input.pieces.length !== rows * cols) {
    throw new Error('تعذر تجهيز قطع البازل كاملة.');
  }

  const occupied = new Set();
  const ids = new Set();
  let pieceBytes = 0;
  const pieces = input.pieces.map((piece) => {
    if (!piece || typeof piece !== 'object') throw new Error('إحدى قطع البازل غير صالحة.');
    const id = clean(piece.id, 80);
    const row = Number(piece.row);
    const col = Number(piece.col);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id) ||
        !Number.isInteger(row) || row < 0 || row >= rows ||
        !Number.isInteger(col) || col < 0 || col >= cols ||
        ids.has(id) || occupied.has(`${row}:${col}`)) {
      throw new Error('ترتيب قطع البازل غير صالح.');
    }
    ids.add(id);
    occupied.add(`${row}:${col}`);
    const decoded = decodeImageDataUrl(piece.image, MAX_PIECE_BYTES);
    if (decoded.mime !== 'image/png') throw new Error('تعذر تجهيز إحدى قطع البازل.');
    pieceBytes += decoded.buffer.length;
    return {
      id,
      row,
      col,
      width: Math.max(1, Math.min(800, Number(piece.width) || 1)),
      height: Math.max(1, Math.min(800, Number(piece.height) || 1)),
      image: decoded.buffer.toString('base64')
    };
  });
  if (pieceBytes > 3_800_000) throw new Error('إجمالي حجم القطع أكبر من الحد المسموح؛ اختر صورة أصغر.');
  const requestSize = Buffer.byteLength(JSON.stringify(input), 'utf8');
  if (requestSize > MAX_REQUEST_BYTES) throw new Error('حجم بيانات البازل أكبر من الحد المسموح.');

  return {
    title,
    hint,
    clue,
    answer,
    solutionNote,
    image,
    imageWidth,
    imageHeight,
    bleed,
    rows,
    cols,
    pieces
  };
}

function parsePieces(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function puzzleSummary(row) {
  return {
    id: row.id,
    shareToken: row.share_token,
    title: row.title,
    hint: row.hint || '',
    creatorCode: row.creator_code || '',
    rows: Number(row.rows) || 0,
    cols: Number(row.cols) || 0,
    bleed: Number(row.piece_bleed) || 0,
    pieceCount: (Number(row.rows) || 0) * (Number(row.cols) || 0),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function safeSharedPuzzle(row) {
  const pieces = parsePieces(row.pieces).map((piece) => ({
    id: piece.id,
    width: Number(piece.width) || 1,
    height: Number(piece.height) || 1,
    image: `data:image/png;base64,${piece.image}`
  }));
  return {
    id: row.id,
    title: row.title,
    hint: row.hint || '',
    imageWidth: Number(row.image_width),
    imageHeight: Number(row.image_height),
    rows: Number(row.rows),
    cols: Number(row.cols),
    bleed: Number(row.piece_bleed),
    pieces
  };
}

class PuzzleSystemStore {
  constructor(pool, options = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('A PostgreSQL pool with query() and connect() is required for puzzles.');
    }
    this.pool = pool;
    this.makeId = typeof options.makeId === 'function'
      ? options.makeId
      : () => `PUZ-${crypto.randomUUID()}`;
    this.makeShareToken = typeof options.makeShareToken === 'function'
      ? options.makeShareToken
      : () => crypto.randomBytes(32).toString('hex');
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

  async hasCreatorPermission(userId) {
    const result = await this.pool.query(
      'SELECT agent_user_id FROM blackridge_puzzle_creator_permissions WHERE agent_user_id = $1',
      [clean(userId, 120)]
    );
    return Boolean(result.rows?.length);
  }

  async createPuzzle({ actor, input, isLeadership = false }) {
    const actorId = clean(actor?.id, 120);
    if (!actorId) return { ok: false, message: 'تعذر التحقق من حساب منشئ البازل.' };
    let puzzle;
    try {
      puzzle = normalizePuzzlePayload(input);
    } catch (error) {
      return { ok: false, message: error.message };
    }

    return this.withTransaction(async (client) => {
      if (!isLeadership) {
        const permission = await client.query(
          'SELECT agent_user_id FROM blackridge_puzzle_creator_permissions WHERE agent_user_id = $1 FOR SHARE',
          [actorId]
        );
        if (!permission.rows?.length) return { ok: false, message: 'لا تملك صلاحية إنشاء الألغاز.' };
      }

      const id = this.makeId();
      const shareToken = this.makeShareToken();
      const salt = crypto.randomBytes(16).toString('hex');
      const answerHash = hashAnswer(puzzle.answer, salt);
      const result = await client.query(
        `INSERT INTO blackridge_puzzles
         (id, share_token, creator_user_id, creator_code, title, hint, clue, answer_text,
          answer_salt, answer_hash, solution_note, image_mime, image_data, image_width,
          image_height, rows, cols, piece_bleed, pieces)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb)
         RETURNING id, share_token, title, hint, creator_code, rows, cols, piece_bleed, created_at`,
        [
          id,
          shareToken,
          actorId,
          clean(actor.publicCode, 100),
          puzzle.title,
          puzzle.hint,
          puzzle.clue,
          puzzle.answer,
          salt,
          answerHash,
          puzzle.solutionNote,
          puzzle.image.mime,
          puzzle.image.buffer,
          puzzle.imageWidth,
          puzzle.imageHeight,
          puzzle.rows,
          puzzle.cols,
          puzzle.bleed,
          JSON.stringify(puzzle.pieces)
        ]
      );
      const row = result.rows?.[0];
      if (!row) throw new Error('لم يتم حفظ البازل في قاعدة البيانات.');
      return { ok: true, puzzle: { ...puzzleSummary(row), shareToken } };
    });
  }

  async listPuzzles(limit = 100, { actorId = '', isLeadership = false } = {}) {
    const result = await this.pool.query(
      `SELECT id, share_token, title, hint, creator_code, creator_user_id, rows, cols, created_at
       FROM blackridge_puzzles
       WHERE active = TRUE
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [Math.max(1, Math.min(200, Number(limit) || 100))]
    );
    const userId = clean(actorId, 120);
    return (result.rows || []).map((row) => ({
      ...puzzleSummary(row),
      canDelete: isLeadership === true || (Boolean(userId) && String(row.creator_user_id || '') === userId)
    }));
  }

  async deletePuzzle({ actor, puzzleId, isLeadership = false } = {}) {
    const actorId = clean(actor?.id, 120);
    const id = clean(puzzleId, 120);
    if (!actorId || !id) return { ok: false, message: 'تعذر التحقق من صاحب طلب الحذف.' };

    const result = await this.pool.query(
      `DELETE FROM blackridge_puzzles
       WHERE id = $1 AND active = TRUE
         AND (creator_user_id = $2 OR $3::boolean = TRUE)
       RETURNING id`,
      [id, actorId, isLeadership === true]
    );
    const deleted = result.rows?.[0];
    if (!deleted) return { ok: false, message: 'هذا اللغز غير موجود أو لا تملك صلاحية حذفه.' };
    return { ok: true, puzzleId: deleted.id };
  }

  async getByShareToken(token) {
    const value = clean(token, 80);
    if (!/^[a-f0-9]{64}$/.test(value)) return null;
    const result = await this.pool.query(
      `SELECT id, share_token, title, hint, clue, answer_text, answer_salt, answer_hash,
              solution_note, image_mime, image_data, image_width, image_height, rows, cols, piece_bleed, pieces
       FROM blackridge_puzzles
       WHERE share_token = $1 AND active = TRUE
       LIMIT 1`,
      [value]
    );
    return result.rows?.[0] || null;
  }

  async listCreatorPermissions() {
    const result = await this.pool.query(
      `SELECT agent_user_id, agent_code, granted_by_user_id, granted_by_code, granted_at
       FROM blackridge_puzzle_creator_permissions
       ORDER BY granted_at DESC, agent_user_id`
    );
    return (result.rows || []).map((row) => ({
      userId: row.agent_user_id,
      publicCode: row.agent_code || '',
      grantedByUserId: row.granted_by_user_id,
      grantedByCode: row.granted_by_code || '',
      grantedAt: row.granted_at instanceof Date ? row.granted_at.toISOString() : row.granted_at
    }));
  }

  async listPermissionAudit(limit = 100) {
    const result = await this.pool.query(
      `SELECT actor_user_id, actor_code, target_user_id, target_code, action, created_at
       FROM blackridge_puzzle_permission_audit
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [Math.max(1, Math.min(200, Number(limit) || 100))]
    );
    return (result.rows || []).map((row) => ({
      actorUserId: row.actor_user_id,
      actorCode: row.actor_code || '',
      targetUserId: row.target_user_id,
      targetCode: row.target_code || '',
      action: row.action,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
    }));
  }

  async grantCreatorPermission({ actor, target }) {
    const actorId = clean(actor?.id, 120);
    const targetId = clean(target?.id, 120);
    if (!actorId || !targetId) return { ok: false, message: 'تعذر تحديد العضو أو صاحب الصلاحية.' };
    return this.withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO blackridge_puzzle_creator_permissions
         (agent_user_id, agent_code, granted_by_user_id, granted_by_code)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (agent_user_id) DO NOTHING
         RETURNING agent_user_id`,
        [targetId, clean(target.publicCode, 100), actorId, clean(actor.publicCode, 100)]
      );
      if (!inserted.rows?.length) return { ok: true, changed: false, message: 'الصلاحية ممنوحة مسبقًا.' };
      await client.query(
        `INSERT INTO blackridge_puzzle_permission_audit
         (id, actor_user_id, actor_code, target_user_id, target_code, action)
         VALUES ($1, $2, $3, $4, $5, 'GRANTED')`,
        [this.makeId(), actorId, clean(actor.publicCode, 100), targetId, clean(target.publicCode, 100)]
      );
      return { ok: true, changed: true };
    });
  }

  async revokeCreatorPermission({ actor, target }) {
    const actorId = clean(actor?.id, 120);
    const targetId = clean(target?.id, 120);
    if (!actorId || !targetId) return { ok: false, message: 'تعذر تحديد العضو أو صاحب الصلاحية.' };
    return this.withTransaction(async (client) => {
      const removed = await client.query(
        `DELETE FROM blackridge_puzzle_creator_permissions
         WHERE agent_user_id = $1
         RETURNING agent_user_id, agent_code`,
        [targetId]
      );
      if (!removed.rows?.length) return { ok: true, changed: false, message: 'لا توجد صلاحية إنشاء لهذا العضو.' };
      await client.query(
        `INSERT INTO blackridge_puzzle_permission_audit
         (id, actor_user_id, actor_code, target_user_id, target_code, action)
         VALUES ($1, $2, $3, $4, $5, 'REVOKED')`,
        [
          this.makeId(),
          actorId,
          clean(actor.publicCode, 100),
          targetId,
          clean(removed.rows[0].agent_code || target.publicCode, 100)
        ]
      );
      return { ok: true, changed: true };
    });
  }
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_PIECE_BYTES,
  MAX_PIECE_COUNT,
  MAX_REQUEST_BYTES,
  SCHEMA_SQL,
  PuzzleSystemStore,
  clean,
  decodeImageDataUrl,
  hashAnswer,
  normalizeAnswer,
  normalizePuzzlePayload,
  parsePieces,
  safeSharedPuzzle,
  verifyAnswer
};
