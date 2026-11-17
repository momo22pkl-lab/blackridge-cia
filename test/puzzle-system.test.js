'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  SCHEMA_SQL,
  PuzzleSystemStore,
  hashAnswer,
  normalizeAnswer,
  normalizePuzzlePayload,
  safeSharedPuzzle,
  verifyAnswer
} = require('../puzzle-system-store');
const { injectPuzzleMarkup, registerPuzzleRoutes, registerPuzzleSocket, registerPublicPuzzleSocket } = require('../puzzle-system');
const puzzleClientSource = readFileSync(path.join(__dirname, '../puzzle-system-client.js'), 'utf8');
const puzzleGameSource = readFileSync(path.join(__dirname, '../puzzle-game.js'), 'utf8');
const puzzlePlayerSource = readFileSync(path.join(__dirname, '../puzzle-player.js'), 'utf8');
const puzzlePlayerHtml = readFileSync(path.join(__dirname, '../puzzle-player.html'), 'utf8');
const puzzleSystemSource = readFileSync(path.join(__dirname, '../puzzle-system.js'), 'utf8');
const serverSource = readFileSync(path.join(__dirname, '../server.js'), 'utf8');

const JPEG = 'data:image/jpeg;base64,/9j/2Q==';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2r8AAAAASUVORK5CYII=';

test('public puzzle asks only for the answer and does not expose notes', () => {
  assert.doesNotMatch(puzzlePlayerHtml, /ما الموقع\؟/);
  assert.match(puzzlePlayerHtml, /aria-label="الإجابة"/);
  assert.doesNotMatch(puzzlePlayerSource, /result\.solutionNote|الموقع:/);
  assert.doesNotMatch(puzzleSystemSource, /name="solutionNote"/);
  assert.doesNotMatch(puzzleClientSource, /solutionNote/);
});

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

  const missingBleed = makePayload();
  delete missingBleed.bleed;
  assert.throws(() => normalizePuzzlePayload(missingBleed), /أبعاد الصورة غير صالحة/);
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

test('public and authenticated sockets expose separate puzzle event surfaces', () => {
  const publicSocket = new FakeSocket('public-only');
  registerPublicPuzzleSocket(publicSocket, { getStore: () => null });
  assert.deepEqual([...publicSocket.handlers.keys()].sort(), [
    'disconnect',
    'puzzles:share:answer',
    'puzzles:share:complete',
    'puzzles:share:load',
    'puzzles:share:place'
  ]);

  const memberSocket = new FakeSocket('member-only');
  registerPuzzleSocket(memberSocket, { getStore: () => null });
  assert.equal([...memberSocket.handlers.keys()].some((event) => event.startsWith('puzzles:share:')), false);
  assert.equal(memberSocket.handlers.has('puzzles:create'), true);
});

test('gallery, create payload, and public namespace remain wired', () => {
  const injected = injectPuzzleMarkup('<html><head></head><body>\n  <div class="content-area"></div>\n</body></html>');
  assert.match(injected, /accept="\.jpg,\.jpeg,\.png,\.webp,image\/jpeg,image\/png,image\/webp"/);
  assert.doesNotMatch(injected, /\bcapture\b/);
  assert.match(puzzleClientSource, /bleed:\s*preparedPuzzle\.bleed/);
  assert.match(puzzleClientSource, /shareToken = response\?\.puzzle\?\.shareToken/);
  assert.match(puzzlePlayerSource, /window\.io\(['"]\/public-puzzles['"]\)/);
  assert.match(serverSource, /io\.of\(['"]\/public-puzzles['"]\)/);
  assert.doesNotMatch(puzzlePlayerHtml, /<a[^>]+href=["']\/["']/i);
});

test('puzzle deletion UI is visible only to managers and asks for confirmation', () => {
  assert.match(puzzleClientSource, /renderPuzzles\(response\.puzzles, response\.canManagePuzzles === true\)/);
  assert.match(puzzleClientSource, /if \(canManagePuzzles\)/);
  assert.match(puzzleClientSource, /window\.confirm\(/);
  assert.match(puzzleClientSource, /call\('puzzles:delete'/);
  assert.match(puzzleSystemSource, /id="br-puzzle-delete-audit"/);
});

test('normal and large image files are orientation-normalized and scaled before slicing', async () => {
  for (const sample of [{ width: 640, height: 480, side: 3 }, { width: 6000, height: 4000, side: 4 }]) {
    let seenOrientation = '';
    let closed = false;
    let pieceId = 0;
    const drawing = {
      drawImage() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
      quadraticCurveTo() {}, closePath() {}, clip() {}, stroke() {}
    };
    const documentMock = { createElement() {
      return {
        width: 0, height: 0,
        getContext() { return drawing; },
        toDataURL(type) {
          return type === 'image/jpeg'
            ? 'data:image/jpeg;base64,' + 'A'.repeat(50000)
            : 'data:image/png;base64,' + 'A'.repeat(2000);
        }
      };
    } };
    const windowMock = {
      crypto: { randomUUID() { pieceId += 1; return 'piece_' + String(pieceId).padStart(8, '0'); } },
      async createImageBitmap(_file, options) {
        seenOrientation = options?.imageOrientation || '';
        return { width: sample.width, height: sample.height, close() { closed = true; } };
      }
    };
    const context = vm.createContext({ window: windowMock, Blob, document: documentMock, TextEncoder, Image: function Image() {} });
    vm.runInContext(puzzleGameSource, context, { filename: 'puzzle-game.js' });
    const prepared = await windowMock.BlackridgePuzzleGame.preparePieces(new Blob(['photo'], { type: 'image/jpeg' }), sample.side, sample.side);
    assert.equal(seenOrientation, 'from-image');
    assert.equal(prepared.pieces.length, sample.side * sample.side);
    assert.ok(prepared.imageWidth <= 800 && prepared.imageHeight <= 800);
    assert.ok(prepared.bleed >= 2);
    assert.equal(closed, true);
  }
});

test('public player must place every piece before receiving the full photo or clue', async () => {
  const storedPuzzle = makeStoredPuzzle();
  const store = {
    async getByShareToken() { return storedPuzzle; }
  };
  const socket = new FakeSocket('player-1');
  registerPublicPuzzleSocket(socket, { getStore: () => store });

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
  assert.equal('solutionNote' in rightAnswer, false);
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

test('only puzzle managers can delete, and deleting invalidates open and refreshed share links', async () => {
  const shareToken = 'a'.repeat(64);
  const storedPuzzle = { ...makeStoredPuzzle(), id: 'PUZ-delete', share_token: shareToken };
  let exists = true;
  let deleteCalls = 0;
  const store = {
    async hasCreatorPermission(userId) { return userId === 'authorized-agent'; },
    async deletePuzzle({ puzzleId }) {
      deleteCalls += 1;
      assert.equal(puzzleId, storedPuzzle.id);
      exists = false;
      return { ok: true, puzzleId, shareToken };
    },
    async getByShareToken(token) {
      return exists && token === shareToken ? storedPuzzle : null;
    }
  };

  const publicSocket = new FakeSocket('public-delete-check');
  registerPublicPuzzleSocket(publicSocket, { getStore: () => store });
  const beforeDelete = await publicSocket.trigger('puzzles:share:load', { shareToken });
  assert.equal(beforeDelete.ok, true);

  const unauthorizedSocket = new FakeSocket('unauthorized-delete');
  registerPuzzleSocket(unauthorizedSocket, {
    getStore: () => store,
    requireUser: () => ({ id: 'unauthorized-agent', rank: 'AGENT' }),
    isLeadership: () => false
  });
  const denied = await unauthorizedSocket.trigger('puzzles:delete', { puzzleId: storedPuzzle.id });
  assert.equal(denied.ok, false);
  assert.equal(deleteCalls, 0);

  const managerSocket = new FakeSocket('authorized-delete');
  registerPuzzleSocket(managerSocket, {
    getStore: () => store,
    requireUser: () => ({ id: 'authorized-agent', publicCode: 'AG-1', rank: 'AGENT' }),
    isLeadership: () => false
  });
  const deleted = await managerSocket.trigger('puzzles:delete', { puzzleId: storedPuzzle.id });
  assert.deepEqual(deleted, { ok: true, puzzleId: storedPuzzle.id });
  assert.equal(deleteCalls, 1);
  assert.equal((await store.getByShareToken(shareToken)), null);

  const activeSession = await publicSocket.trigger('puzzles:share:place', {
    shareToken,
    pieceId: storedPuzzle.pieces[0].id,
    row: 0,
    col: 0
  });
  assert.equal(activeSession.ok, false);

  let sharedPageStatus = 200;
  let sharedPageHandler;
  const fakeApp = { get(route, handler) { if (route === '/puzzles/:shareToken') sharedPageHandler = handler; } };
  registerPuzzleRoutes(fakeApp, { getStore: () => store });
  const response = {
    status(code) { sharedPageStatus = code; return this; },
    send() { return this; },
    set() { return this; },
    sendFile() { return this; }
  };
  await sharedPageHandler({ params: { shareToken } }, response);
  assert.equal(sharedPageStatus, 404);
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

test('hard deletion removes only the selected puzzle and records an audit entry', async () => {
  assert.ok(SCHEMA_SQL.some((sql) => /CREATE TABLE IF NOT EXISTS blackridge_puzzle_audit/i.test(sql)));
  const shareTokens = ['b'.repeat(64), 'c'.repeat(64)];
  const puzzles = [
    { id: 'PUZ-remove', share_token: shareTokens[0], title: 'Remove this one', hint: '', creator_code: 'AG-1', rows: 2, cols: 2, piece_bleed: 12, created_at: '2026-11-15T00:00:00.000Z', active: true },
    { id: 'PUZ-keep', share_token: shareTokens[1], title: 'Keep this one', hint: '', creator_code: 'AG-2', rows: 2, cols: 2, piece_bleed: 12, created_at: '2026-11-14T00:00:00.000Z', active: true }
  ];
  const audit = [];
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/^DELETE FROM blackridge_puzzles/i.test(sql)) {
      const index = puzzles.findIndex((puzzle) => puzzle.id === params[0] && puzzle.active);
      return { rows: index < 0 ? [] : [puzzles.splice(index, 1)[0]] };
    }
    if (/INSERT INTO blackridge_puzzle_audit/i.test(sql)) {
      audit.push({
        id: params[0],
        actor_user_id: params[1],
        actor_code: params[2],
        puzzle_id: params[3],
        puzzle_title: params[4],
        action: 'DELETED',
        created_at: '2026-11-17T00:00:00.000Z'
      });
      return { rows: [] };
    }
    if (/FROM blackridge_puzzles/i.test(sql) && /WHERE active = TRUE/i.test(sql)) {
      return { rows: puzzles.filter((puzzle) => puzzle.active).slice(0, params[0]) };
    }
    if (/FROM blackridge_puzzles/i.test(sql) && /WHERE share_token = \$1/i.test(sql)) {
      return { rows: puzzles.filter((puzzle) => puzzle.share_token === params[0] && puzzle.active) };
    }
    if (/FROM blackridge_puzzle_audit/i.test(sql)) return { rows: audit };
    return { rows: [] };
  };
  const pool = {
    query,
    async connect() { return { query, release() {} }; }
  };
  const store = new PuzzleSystemStore(pool, { makeId: () => 'AUDIT-1' });

  const result = await store.deletePuzzle({
    actor: { id: 'agent-1', publicCode: 'AG-1' },
    puzzleId: 'PUZ-remove'
  });
  assert.deepEqual(result, { ok: true, puzzleId: 'PUZ-remove', shareToken: shareTokens[0] });
  assert.deepEqual((await store.listPuzzles()).map((puzzle) => puzzle.id), ['PUZ-keep']);
  assert.equal(await store.getByShareToken(shareTokens[0]), null);
  assert.equal((await store.getByShareToken(shareTokens[1])).id, 'PUZ-keep');
  assert.deepEqual(await store.listPuzzleAudit(), [{
    actorUserId: 'agent-1',
    actorCode: 'AG-1',
    puzzleId: 'PUZ-remove',
    puzzleTitle: 'Remove this one',
    action: 'DELETED',
    createdAt: '2026-11-17T00:00:00.000Z'
  }]);
  assert.match(calls.find((entry) => /^DELETE FROM blackridge_puzzles/i.test(entry.sql)).sql, /WHERE id = \$1 AND active = TRUE/);
  assert.equal(calls.filter((entry) => /^DELETE FROM blackridge_puzzles/i.test(entry.sql)).length, 1);
});
