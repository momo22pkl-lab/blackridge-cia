'use strict';

const path = require('node:path');
const {
  PuzzleSystemStore,
  clean,
  safeSharedPuzzle,
  verifyAnswer
} = require('./puzzle-system-store');

const publicProgress = new Map();
const PUBLIC_ASSETS = Object.freeze({
  '/puzzle-system.js': 'puzzle-system-client.js',
  '/puzzle-game.js': 'puzzle-game.js',
  '/puzzle-system.css': 'puzzle-system.css',
  '/puzzle-player.html': 'puzzle-player.html',
  '/puzzle-player.js': 'puzzle-player.js'
});

function injectPuzzleMarkup(html) {
  if (typeof html !== 'string' || html.includes('data-blackridge-puzzle-system')) return html;
  const navMarker = '    </ul>\n    <div style="padding: 15px; border-top: 1px solid var(--border);">';
  const navItem = '      <li id="puzzles-nav" class="nav-btn" onclick="openBlackridgePuzzles(this)"><i class="fa-solid fa-puzzle-piece"></i> ألغاز المواقع</li>\n';
  const contentMarker = '  <div class="content-area">';
  const pane = `
    <div id="puzzles-view" class="view-pane br-puzzle-page" aria-label="ألغاز المواقع">
      <section class="br-puzzle-shell" dir="rtl">
        <header class="br-puzzle-header">
          <div>
            <div class="br-puzzle-eyebrow">BLACKRIDGE CIA / FIELD CHALLENGES</div>
            <h1>ألغاز المواقع</h1>
            <p>ركّب صورة الموقع، ثم حلّ لغز الوكيل.</p>
          </div>
          <span id="br-puzzle-db-status" class="br-puzzle-status">جارٍ الاتصال بقاعدة البيانات…</span>
        </header>
        <div id="br-puzzle-message" class="br-puzzle-message" role="status" aria-live="polite"></div>
        <section id="br-puzzle-create-panel" class="br-puzzle-card" hidden>
          <div class="br-puzzle-card-head">
            <div><span class="br-puzzle-kicker">PUZZLE CONSTRUCTION</span><h2>إنشاء بازل جديد</h2></div>
            <span class="br-puzzle-seal"><i class="fa-solid fa-location-crosshairs"></i></span>
          </div>
          <form id="br-puzzle-create-form" class="br-puzzle-form">
            <label class="br-puzzle-field br-puzzle-upload">
              <span>صورة الموقع من GTA</span>
              <input id="br-puzzle-image-file" name="image" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required>
              <small>اختر لقطة للمكان فقط؛ حجم الصورة يُخفّض تلقائيًا قبل الحفظ.</small>
            </label>
            <label class="br-puzzle-field"><span>عنوان اللغز</span><input name="title" maxlength="100" required placeholder="مثال: أثر عند الميناء"></label>
            <label class="br-puzzle-field"><span>تلميح اختياري</span><input name="hint" maxlength="300" placeholder="يظهر للاعب قبل البدء"></label>
            <label class="br-puzzle-field br-puzzle-field-wide"><span>اللغز الذي يظهر بعد تركيب الصورة</span><textarea name="clue" maxlength="800" required rows="3" placeholder="اكتب السؤال أو الملاحظة التي تقود إلى الموقع"></textarea></label>
            <label class="br-puzzle-field"><span>الإجابة الصحيحة</span><input name="answer" maxlength="120" required autocomplete="off" placeholder="لا تظهر للاعب قبل الحل"></label>
            <label class="br-puzzle-field"><span>رسالة/موقع يظهر بعد الإجابة</span><input name="solutionNote" maxlength="500" placeholder="اختياري"></label>
            <label class="br-puzzle-field"><span>عدد القطع</span>
              <select name="pieceCount"><option value="9">9 قطع — سهل</option><option value="16" selected>16 قطعة — متوسط</option><option value="25">25 قطعة — صعب</option><option value="36">36 قطعة — خبير</option></select>
            </label>
            <div class="br-puzzle-form-actions br-puzzle-field-wide">
              <button id="br-puzzle-preview-button" type="button" class="br-puzzle-button br-puzzle-button-quiet">معاينة البازل</button>
              <button id="br-puzzle-create-button" type="submit" class="br-puzzle-button" disabled>حفظ وإنشاء رابط المشاركة</button>
            </div>
          </form>
          <div id="br-puzzle-preview" class="br-puzzle-preview" hidden></div>
        </section>
        <section id="br-puzzle-permissions-panel" class="br-puzzle-card" hidden>
          <div class="br-puzzle-card-head"><div><span class="br-puzzle-kicker">AGENT ACCESS</span><h2>صلاحيات إنشاء الألغاز</h2></div></div>
          <p class="br-puzzle-muted">يمكن للرتب القيادية منح Agent صلاحية الإنشاء أو سحبها. كل تغيير يُسجّل باسم الرتبة والوقت.</p>
          <div id="br-puzzle-agent-list" class="br-puzzle-agent-list"></div>
          <div class="br-puzzle-audit-head">سجل منح وسحب الصلاحيات</div>
          <div id="br-puzzle-permission-audit" class="br-puzzle-audit-list"></div>
        </section>
        <section class="br-puzzle-card">
          <div class="br-puzzle-card-head"><div><span class="br-puzzle-kicker">SHARED CHALLENGES</span><h2>الألغاز المتاحة</h2></div><button id="br-puzzle-refresh" type="button" class="br-puzzle-icon-button" aria-label="تحديث الألغاز"><i class="fa-solid fa-rotate"></i></button></div>
          <div id="br-puzzle-list" class="br-puzzle-list"><div class="br-puzzle-empty">سجّل الدخول إلى قسم الألغاز لتحميل القائمة.</div></div>
        </section>
      </section>
    </div>`;

  let output = html;
  if (output.includes(navMarker)) output = output.replace(navMarker, `${navItem}${navMarker}`);
  if (output.includes(contentMarker)) output = output.replace(contentMarker, `${contentMarker}${pane}`);
  const styles = '<link rel="stylesheet" href="/puzzle-system.css" data-blackridge-puzzle-system>';
  const scripts = '<script src="/puzzle-game.js" data-blackridge-puzzle-system defer></script><script src="/puzzle-system.js" data-blackridge-puzzle-system defer></script>';
  if (output.includes('</head>')) output = output.replace('</head>', `${styles}\n</head>`);
  if (output.includes('</body>')) output = output.replace('</body>', `${scripts}\n</body>`);
  return output;
}

function registerPuzzleRoutes(app, { getStore, directory = __dirname } = {}) {
  for (const [route, file] of Object.entries(PUBLIC_ASSETS)) {
    app.get(route, (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      return res.sendFile(path.join(directory, file));
    });
  }

  app.get('/puzzles/:shareToken', async (req, res) => {
    const token = clean(req.params?.shareToken, 80);
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).send('رابط البازل غير صالح.');
    const store = typeof getStore === 'function' ? getStore() : null;
    if (!store) return res.status(503).send('نظام الألغاز غير متاح لأن قاعدة البيانات غير متصلة.');
    try {
      const puzzle = await store.getByShareToken(token);
      if (!puzzle) return res.status(404).send('هذا البازل غير موجود أو لم يعد متاحًا.');
      res.set({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.sendFile(path.join(directory, 'puzzle-player.html'));
    } catch (_error) {
      return res.status(503).send('تعذر تحميل البازل الآن. حاول مرة أخرى لاحقًا.');
    }
  });
}

function registerPuzzleSocket(socket, {
  getStore,
  getState = () => ({}),
  requireUser = () => null,
  normalizeRank = (rank) => String(rank || '').toUpperCase(),
  isLeadership = () => false
} = {}) {
  const reply = (callback, result) => {
    if (typeof callback === 'function') callback(result);
  };
  const storeForRequest = () => typeof getStore === 'function' ? getStore() : null;
  const activeUser = () => {
    try { return requireUser(socket); } catch (_error) { return null; }
  };
  const leadership = (user) => {
    try { return isLeadership(user) === true; } catch (_error) { return false; }
  };
  const unavailable = () => ({ ok: false, message: 'خدمة الألغاز تتطلب اتصال PostgreSQL؛ لم يُحفظ أي شيء محليًا.' });
  const run = async (callback, task) => {
    try {
      const result = await task();
      reply(callback, result);
    } catch (_error) {
      reply(callback, { ok: false, message: 'تعذر إكمال العملية. لم يتم اعتماد التغيير.' });
    }
  };
  const progressKey = (token) => `${socket.id}:${token}`;

  socket.on('puzzles:overview', (payload, callback) => run(callback, async () => {
    const actor = activeUser();
    if (!actor) return { ok: false, message: 'سجّل الدخول إلى الموقع أولًا.' };
    const store = storeForRequest();
    if (!store) return unavailable();
    const isLeader = leadership(actor);
    const canCreate = isLeader || await store.hasCreatorPermission(actor.id);
    const puzzles = await store.listPuzzles(100);
    let agents = [];
    let permissionAudit = [];
    if (isLeader) {
      const roster = Array.isArray(getState()?.cia_users) ? getState().cia_users : [];
      const grants = await store.listCreatorPermissions();
      const grantedIds = new Set(grants.map((entry) => entry.userId));
      agents = roster
        .filter((person) => person && normalizeRank(person.rank) === 'AGENT')
        .slice(0, 2000)
        .map((person) => ({
          userId: clean(person.id, 120),
          publicCode: clean(person.publicCode, 100),
          granted: grantedIds.has(String(person.id))
        }));
      permissionAudit = await store.listPermissionAudit(100);
    }
    return { ok: true, canCreate, canManagePermissions: isLeader, puzzles, agents, permissionAudit };
  }));

  socket.on('puzzles:create', (payload, callback) => run(callback, async () => {
    const actor = activeUser();
    if (!actor) return { ok: false, message: 'سجّل الدخول إلى الموقع أولًا.' };
    const store = storeForRequest();
    if (!store) return unavailable();
    const isLeader = leadership(actor);
    if (!isLeader && !(await store.hasCreatorPermission(actor.id))) {
      return { ok: false, message: 'إنشاء الألغاز متاح للقيادة ولـ Agents الذين مُنحوا الصلاحية.' };
    }
    return store.createPuzzle({ actor, input: payload, isLeadership: isLeader });
  }));

  const changePermission = (action) => (payload, callback) => run(callback, async () => {
    const actor = activeUser();
    if (!actor) return { ok: false, message: 'سجّل الدخول إلى الموقع أولًا.' };
    if (!leadership(actor)) return { ok: false, message: 'إدارة صلاحيات الألغاز متاحة للرتب القيادية فقط.' };
    const store = storeForRequest();
    if (!store) return unavailable();
    const targetId = clean(payload?.targetUserId, 120);
    const roster = Array.isArray(getState()?.cia_users) ? getState().cia_users : [];
    const target = roster.find((person) => person && String(person.id) === targetId);
    if (!target || normalizeRank(target.rank) !== 'AGENT') {
      return { ok: false, message: 'يمكن منح الصلاحية أو سحبها من Agent فقط.' };
    }
    const details = { id: target.id, publicCode: clean(target.publicCode, 100) };
    const result = action === 'GRANT'
      ? await store.grantCreatorPermission({ actor, target: details })
      : await store.revokeCreatorPermission({ actor, target: details });
    return { ...result, targetUserId: targetId };
  });
  socket.on('puzzles:permission:grant', changePermission('GRANT'));
  socket.on('puzzles:permission:revoke', changePermission('REVOKE'));

  socket.on('puzzles:share:load', (payload, callback) => run(callback, async () => {
    const token = clean(payload?.shareToken, 80);
    const store = storeForRequest();
    if (!store) return unavailable();
    const puzzle = await store.getByShareToken(token);
    if (!puzzle) return { ok: false, message: 'هذا البازل غير موجود أو لم يعد متاحًا.' };
    const pieces = Array.isArray(puzzle.pieces) ? puzzle.pieces : [];
    if (!pieces.length) return { ok: false, message: 'ملفات قطع البازل غير مكتملة.' };
    publicProgress.set(progressKey(token), { puzzle, placed: new Set(), complete: false });
    return { ok: true, puzzle: safeSharedPuzzle(puzzle) };
  }));

  socket.on('puzzles:share:place', (payload, callback) => run(callback, async () => {
    const token = clean(payload?.shareToken, 80);
    const session = publicProgress.get(progressKey(token));
    if (!session) return { ok: false, message: 'أعد تحميل رابط البازل قبل اللعب.' };
    const pieceId = clean(payload?.pieceId, 80);
    const row = Number(payload?.row);
    const col = Number(payload?.col);
    const piece = session.puzzle.pieces.find((entry) => entry && entry.id === pieceId);
    if (!piece || !Number.isInteger(row) || !Number.isInteger(col)) {
      return { ok: false, message: 'تعذر التحقق من موضع القطعة.' };
    }
    const correct = Number(piece.row) === row && Number(piece.col) === col;
    if (correct) session.placed.add(pieceId);
    const total = Number(session.puzzle.rows) * Number(session.puzzle.cols);
    return {
      ok: true,
      correct,
      placedCount: session.placed.size,
      totalPieces: total,
      complete: correct && session.placed.size === total
    };
  }));

  socket.on('puzzles:share:complete', (payload, callback) => run(callback, async () => {
    const token = clean(payload?.shareToken, 80);
    const session = publicProgress.get(progressKey(token));
    if (!session) return { ok: false, message: 'أعد تحميل رابط البازل قبل إكماله.' };
    const total = Number(session.puzzle.rows) * Number(session.puzzle.cols);
    if (session.placed.size !== total) return { ok: false, message: 'أكمل تركيب كل القطع أولًا.' };
    session.complete = true;
    const image = Buffer.isBuffer(session.puzzle.image_data)
      ? session.puzzle.image_data
      : Buffer.from(session.puzzle.image_data || []);
    return {
      ok: true,
      clue: session.puzzle.clue,
      image: `data:${session.puzzle.image_mime};base64,${image.toString('base64')}`
    };
  }));

  socket.on('puzzles:share:answer', (payload, callback) => run(callback, async () => {
    const token = clean(payload?.shareToken, 80);
    const session = publicProgress.get(progressKey(token));
    if (!session || !session.complete) return { ok: false, message: 'ركّب الصورة كاملة قبل إدخال الإجابة.' };
    if (!verifyAnswer(session.puzzle, payload?.answer)) {
      return { ok: true, correct: false, message: 'الإجابة غير صحيحة؛ حاول مرة أخرى.' };
    }
    return {
      ok: true,
      correct: true,
      answer: session.puzzle.answer_text,
      solutionNote: session.puzzle.solution_note || ''
    };
  }));

  socket.on('disconnect', () => {
    const prefix = `${socket.id}:`;
    for (const key of publicProgress.keys()) if (key.startsWith(prefix)) publicProgress.delete(key);
  });
}

module.exports = {
  PuzzleSystemStore,
  injectPuzzleMarkup,
  registerPuzzleRoutes,
  registerPuzzleSocket
};
