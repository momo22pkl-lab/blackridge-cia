'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_SQL,
  PuzzleSystemStore,
  hashAnswer,
  normalizeAnswer,
  normalizePuzzlePayload,
  safeSharedPuzzle,
  verifyAnswer
} = require('../puzzle-system-store');
const { injectPuzzleMarkup, registerPuzzleSocket } = require('../puzzle-system');

const JPEG = 'data:image/jpeg;base64,/9j/2Q==';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2r8AAAAASUVORK5CYII=';

function makePayload() {
  const pieces = [];
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      pieces.push({
        id: `piece_${row}_${col}_0000`,
        row,
        col,
        width: 180,
        height: 180,
        image: PNG
      });
    }
  }
  return {
    title: 'Harbor Signal',
    hint: 'Look near the water.',
    clue: 'Where does the road meet the old pier?',
    answer: 'Elysian Island',
    solutionNote: 'The location is beside the east gate.',
    rows: 2,
    cols: 2,
    bleed: 18,
    image: JPEG,
    imageWidth: 400,
    imageHeight: 300,
    pieces
  };
}

class FakeSocket {
  constructor(id) {
    this.id = id;
    this.handlers = new Map();
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  trigger(event, payload = {}) {
    const handler = this.handlers.get(event);
    assert.equal(typeof handler, 'function', `handler registered for ${event}`);
    return new Promise((resolve) => handler(payload, resolve));
  }
}

function makeStoredPuzzle() {
  const payload = makePayload();
  const salt = 'fixture-salt';
  return {
    id: 'PUZ-fixture',
    title: payload.title,
    hint: payload.hint,
    clue: payload.clue,
    answer_text: payload.answer,
    answer_salt: salt,
    answer_hash: hashAnswer(payload.answer, salt),
    solution_note: payload.solutionNote,
    image_mime: 'image/jpeg',
    image_data: Buffer.from('/9j/2Q==', 'base64'),
    image_width: payload.imageWidth,
    image_height: payload.imageHeight,
    rows: payload.rows,
    cols: payload.cols,
    piece_bleed: payload.bleed,
    pieces: payload.pieces.map((piece) => ({
      ...piece,
      image: Buffer.from(piece.image.split(',')[1], 'base64').toString('base64')
    }))
  };
}

test('answer normalization accepts harmless formatting differences', () => {
  assert.equal(normalizeAnswer('  إِلْيزيان—آيلاند  '), 'اليزيان ايلاند');
  const stored = { answer_salt: 'test-salt', answer_hash: hashAnswer('Elysian Island', 'test-salt') };
  assert.equal(verifyAnswer(stored, '  ELYSIAN   ISLAND! '), true);
  assert.equal(verifyAnswer(stored, 'Vespucci Beach'), false);
});

test('puzzle creation validates a complete grid of safe image pieces', () => {
  const normalized = normalizePuzzlePayload(makePayload());
  assert.equal(normalized.pieces.length, 4);
  assert.equal(normalized.image.mime, 'image/jpeg');
  assert.equal(normalized.pieces[0].image, Buffer.from(PNG.split(',')[1], 'base64').toString('base64'));

  const duplicateCell = makePayload();
  duplicateCell.pieces[1].row = 0;
  duplicateCell.pieces[1].col = 0;
  assert.throws(() => normalizePuzzlePayload(duplicateCell), /ترتيب قطع البازل غير صالح/);

  const unsafeImage = makePayload();
  unsafeImage.pieces[0].image = 'data:image/svg+xml;base64,PHN2Zz4=';
  assert.throws(() => normalizePuzzlePayload(unsafeImage), /JPEG أو PNG أو WebP/);
});

test('public puzzle data hides the original image, answer, clue, and piece positions', () => {
  const publicData = safeSharedPuzzle(makeStoredPuzzle());
  assert.equal(publicData.pieces.length, 4);
  assert.equal(publicData.imageWidth, 400);
  assert.equal(publicData.bleed, 18);
  assert.equal('clue' in publicData, false);
  assert.equal('answer_text' in publicData, false);
  assert.equal('image_data' in publicData, false);
  assert.equal('row' in publicData.pieces[0], false);
  assert.equal('col' in publicData.pieces[0], false);
});

test('injected puzzle view adds the nav and assets once', () => {
  const source = '<html><head></head><body><ul class="nav-list">\n    </ul>\n    <div style="padding: 15px; border-top: 1px solid var(--border);"></div>\n  <div class="content-area"></div></body></html>';
  const injected = injectPuzzleMarkup(source);
  assert.match(injected, /id="puzzles-nav"/);
  assert.match(injected, /id="puzzles-view"/);
  assert.match(injected, /puzzle-player|puzzle-game\.js/);
  assert.equal(injectPuzzleMarkup(injected), injected);
});

test('public player must place every piece before receiving the full photo or clue', async () => {
  const storedPuzzle = makeStoredPuzzle();
  const store = {
    async getByShareToken() { return storedPuzzle; }
  };
  const socket = new FakeSocket('player-1');
  registerPuzzleSocket(socket, { getStore: () => store, requireUser: () => null });

  const loaded = await socket.trigger('puzzles:share:load', { shareToken: 'a'.repeat(64) });
  assert.equal(loaded.ok, true);
  assert.equal('clue' in loaded.puzzle, false);
  assert.equal('answer_text' in loaded.puzzle, false);
  assert.equal('image_data' in loaded.puzzle, false);
  assert.equal('row' in loaded.puzzle.pieces[0], false);

  const early = await socket.trigger('puzzles:share:complete', { shareToken: 'a'.repeat(64) });
  assert.equal(early.ok, false);
  assert.equal('image' in early, false);

  const wrong = await socket.trigger('puzzles:share:place', {
    shareToken: 'a'.repeat(64),
    pieceId: storedPuzzle.pieces[0].id,
    row: 1,
    col: 1
  });
  assert.equal(wrong.correct, false);

  let last;
  for (const piece of storedPuzzle.pieces) {
    last = await socket.trigger('puzzles:share:place', {
      shareToken: 'a'.repeat(64),
      pieceId: piece.id,
      row: piece.row,
      col: piece.col
    });
    assert.equal(last.correct, true);
  }
  assert.equal(last.complete, true);

  const assembled = await socket.trigger('puzzles:share:complete', { shareToken: 'a'.repeat(64) });
  assert.equal(assembled.ok, true);
  assert.equal(assembled.clue, storedPuzzle.clue);
  assert.match(assembled.image, /^data:image\/jpeg;base64,/);
  assert.equal('answer' in assembled, false);

  const wrongAnswer = await socket.trigger('puzzles:share:answer', {
    shareToken: 'a'.repeat(64),
    answer: 'Wrong place'
  });
  assert.equal(wrongAnswer.correct, false);
  const rightAnswer = await socket.trigger('puzzles:share:answer', {
    shareToken: 'a'.repeat(64),
    answer: storedPuzzle.answer_text
  });
  assert.equal(rightAnswer.correct, true);
  assert.equal(rightAnswer.answer, storedPuzzle.answer_text);
  assert.equal(rightAnswer.solutionNote, storedPuzzle.solution_note);
});

test('Agent creation is denied unless a leader has granted the database permission', async () => {
  let createCalled = false;
  const store = {
    async hasCreatorPermission() { return false; },
    async createPuzzle() { createCalled = true; return { ok: true }; }
  };
  const agent = { id: 'agent-1', rank: 'AGENT' };
  const socket = new FakeSocket('agent-socket');
  registerPuzzleSocket(socket, {
    getStore: () => store,
    getState: () => ({ cia_users: [] }),
    requireUser: () => agent,
    isLeadership: () => false
  });
  const result = await socket.trigger('puzzles:create', makePayload());
  assert.equal(result.ok, false);
  assert.equal(createCalled, false);
});

test('leader permission changes are restricted to Agents and write through the store', async () => {
  let grantedTarget = null;
  const leader = { id: 'leader-1', publicCode: 'HC-1', rank: 'HIGH COMMANDER' };
  const agent = { id: 'agent-1', publicCode: 'AG-1', rank: 'AGENT' };
  const otherLeader = { id: 'leader-2', publicCode: 'SC-1', rank: 'SUPREME COMMANDER' };
  const store = {
    async grantCreatorPermission({ target }) { grantedTarget = target.id; return { ok: true, changed: true }; },
    async revokeCreatorPermission({ target }) { grantedTarget = target.id; return { ok: true, changed: true }; }
  };
  const socket = new FakeSocket('leader-socket');
  registerPuzzleSocket(socket, {
    getStore: () => store,
    getState: () => ({ cia_users: [agent, otherLeader] }),
    requireUser: () => leader,
    normalizeRank: (rank) => String(rank || '').toUpperCase(),
    isLeadership: (user) => ['CIA CHIEF', 'SUPREME COMMANDER', 'HIGH COMMANDER'].includes(user.rank)
  });
  const allowed = await socket.trigger('puzzles:permission:grant', { targetUserId: agent.id });
  assert.equal(allowed.ok, true);
  assert.equal(grantedTarget, agent.id);

  const denied = await socket.trigger('puzzles:permission:grant', { targetUserId: otherLeader.id });
  assert.equal(denied.ok, false);
  assert.equal(grantedTarget, agent.id);
});

test('PostgreSQL schema and creation store image pieces outside browser storage', async () => {
  assert.ok(SCHEMA_SQL.some((sql) => /image_data BYTEA/i.test(sql)));
  assert.ok(SCHEMA_SQL.some((sql) => /blackridge_puzzle_permission_audit/i.test(sql)));
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO blackridge_puzzles/i.test(sql)) {
        return { rows: [{
          id: params[0],
          share_token: params[1],
          title: params[4],
          hint: params[5],
          creator_code: params[3],
          rows: params[15],
          cols: params[16],
          piece_bleed: params[17],
          created_at: '2026-11-15T00:00:00.000Z'
        }] };
      }
      return { rows: [] };
    },
    async connect() {
      return { query: this.query.bind(this), release() {} };
    }
  };
  const store = new PuzzleSystemStore(pool, { makeId: () => 'PUZ-1', makeShareToken: () => 'b'.repeat(64) });
  const result = await store.createPuzzle({
    actor: { id: 'leader-1', publicCode: 'CHIEF-1' },
    input: makePayload(),
    isLeadership: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.puzzle.shareToken, 'b'.repeat(64));
  const insert = calls.find((entry) => /INSERT INTO blackridge_puzzles/i.test(entry.sql));
  assert.ok(Buffer.isBuffer(insert.params[12]));
  assert.equal(JSON.parse(insert.params[18]).length, 4);
});
