'use strict';

(function startPublicPuzzlePlayer() {
  const byId = (id) => document.getElementById(id);
  const token = window.location.pathname.split('/').filter(Boolean).pop() || '';
  const board = byId('br-player-board');
  const tray = byId('br-player-tray');
  const message = byId('br-player-message');
  const progressBar = byId('br-player-progress-bar');
  const progressText = byId('br-player-progress-text');
  const connection = byId('br-player-connection');
  let puzzle = null;
  let drag = null;
  let placed = 0;
  let complete = false;
  const occupied = new Set();

  function setMessage(text, type = '') {
    message.textContent = String(text || '');
    message.className = `br-player-message${type ? ` is-${type}` : ''}`;
  }

  function call(eventName, payload = {}) {
    return new Promise((resolve) => {
      if (typeof window.io !== 'function') return resolve({ ok: false, message: 'تعذر بدء اتصال اللعب.' });
      const socket = window.blackRidgePuzzleSocket || (window.blackRidgePuzzleSocket = window.io('/public-puzzles'));
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve(result || { ok: false, message: 'لم يصل رد من الخادم.' });
      };
      const send = () => socket.emit(eventName, payload, finish);
      const timeout = setTimeout(() => finish({ ok: false, message: 'انتهت مهلة الاتصال. أعد المحاولة.' }), 20000);
      if (socket.connected) send();
      else {
        socket.once('connect', send);
        socket.once('connect_error', () => finish({ ok: false, message: 'تعذر الاتصال بالخادم.' }));
      }
    });
  }

  function shuffle(items) {
    const values = items.slice();
    for (let index = values.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [values[index], values[swap]] = [values[swap], values[index]];
    }
    return values;
  }

  function updateProgress(count) {
    placed = count;
    const total = puzzle.rows * puzzle.cols;
    progressText.textContent = `${count} / ${total} قطعة`;
    progressBar.style.width = `${Math.round((count / total) * 100)}%`;
    byId('br-player-piece-count').textContent = `${total - count} متبقية`;
  }

  function makeBoard() {
    board.replaceChildren();
    board.style.aspectRatio = `${puzzle.imageWidth} / ${puzzle.imageHeight}`;
    for (let row = 0; row < puzzle.rows; row += 1) {
      for (let col = 0; col < puzzle.cols; col += 1) {
        const cell = document.createElement('div');
        cell.className = 'br-player-cell';
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        cell.style.left = `${col / puzzle.cols * 100}%`;
        cell.style.top = `${row / puzzle.rows * 100}%`;
        cell.style.width = `${100 / puzzle.cols}%`;
        cell.style.height = `${100 / puzzle.rows}%`;
        board.append(cell);
      }
    }
  }

  function makeTray() {
    tray.replaceChildren();
    for (const piece of shuffle(puzzle.pieces)) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'br-player-piece-card';
      card.dataset.pieceId = piece.id;
      card.setAttribute('aria-label', 'اسحب قطعة إلى موضعها في اللوحة');
      const image = document.createElement('img');
      image.src = piece.image;
      image.alt = '';
      image.draggable = false;
      card.append(image);
      tray.append(card);
    }
  }

  function updateBoardPiece(piece, row, col) {
    const image = document.createElement('img');
    image.className = 'br-player-piece-placed';
    image.src = piece.image;
    image.alt = '';
    image.draggable = false;
    const cellWidth = puzzle.imageWidth / puzzle.cols;
    const cellHeight = puzzle.imageHeight / puzzle.rows;
    image.style.left = `${((col * cellWidth - puzzle.bleed) / puzzle.imageWidth) * 100}%`;
    image.style.top = `${((row * cellHeight - puzzle.bleed) / puzzle.imageHeight) * 100}%`;
    image.style.width = `${(piece.width / puzzle.imageWidth) * 100}%`;
    image.style.height = `${(piece.height / puzzle.imageHeight) * 100}%`;
    image.style.zIndex = String(2 + placed);
    board.append(image);
    const cell = board.querySelector(`.br-player-cell[data-row="${row}"][data-col="${col}"]`);
    if (cell) cell.classList.add('is-filled');
  }

  function startDrag(event) {
    const card = event.target.closest('.br-player-piece-card');
    if (!card || complete || drag || event.button > 0) return;
    event.preventDefault();
    const image = card.querySelector('img');
    const rect = card.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'br-player-piece-ghost';
    ghost.style.width = `${Math.max(68, rect.width)}px`;
    ghost.style.height = `${Math.max(68, rect.height)}px`;
    ghost.style.left = `${event.clientX - Math.max(68, rect.width) / 2}px`;
    ghost.style.top = `${event.clientY - Math.max(68, rect.height) / 2}px`;
    const ghostImage = document.createElement('img');
    ghostImage.src = image.src;
    ghostImage.alt = '';
    ghost.append(ghostImage);
    document.body.append(ghost);
    card.classList.add('is-dragging');
    drag = { card, pieceId: card.dataset.pieceId, pointerId: event.pointerId, ghost };
  }

  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const rect = drag.ghost.getBoundingClientRect();
    drag.ghost.style.left = `${event.clientX - rect.width / 2}px`;
    drag.ghost.style.top = `${event.clientY - rect.height / 2}px`;
  }

  async function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const active = drag;
    drag = null;
    active.ghost.remove();
    active.card.classList.remove('is-dragging');
    const rect = board.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;

    const col = Math.min(puzzle.cols - 1, Math.floor((event.clientX - rect.left) / rect.width * puzzle.cols));
    const row = Math.min(puzzle.rows - 1, Math.floor((event.clientY - rect.top) / rect.height * puzzle.rows));
    const cellKey = `${row}:${col}`;
    if (occupied.has(cellKey)) return setMessage('هذه الخانة مشغولة. جرّب خانة أخرى.', 'error');
    active.card.disabled = true;
    const result = await call('puzzles:share:place', { shareToken: token, pieceId: active.pieceId, row, col });
    active.card.disabled = false;
    if (!result.ok) return setMessage(result.message || 'تعذر فحص موضع القطعة.', 'error');
    if (!result.correct) return setMessage('القطعة ليست في مكانها الصحيح.', 'error');

    const piece = puzzle.pieces.find((entry) => entry.id === active.pieceId);
    if (!piece) return setMessage('تعذر العثور على القطعة.', 'error');
    occupied.add(cellKey);
    updateBoardPiece(piece, row, col);
    active.card.remove();
    updateProgress(result.placedCount);
    setMessage('صحيح — ثبتت القطعة في مكانها.', 'success');
    if (result.complete) await finishPuzzle();
  }

  async function finishPuzzle() {
    const result = await call('puzzles:share:complete', { shareToken: token });
    if (!result.ok) return setMessage(result.message || 'تعذر إكمال البازل.', 'error');
    complete = true;
    const image = document.createElement('img');
    image.className = 'br-player-complete-image';
    image.src = result.image;
    image.alt = 'الصورة الكاملة بعد إكمال البازل';
    board.replaceChildren(image);
    byId('br-player-tray-wrap').hidden = true;
    byId('br-player-intro').textContent = 'اكتملت الصورة. اقرأ اللغز وأدخل إجابتك.';
    byId('br-player-clue').textContent = result.clue || '';
    byId('br-player-final-photo').src = result.image;
    byId('br-player-complete').hidden = false;
    byId('br-player-answer').focus({ preventScroll: true });
    setMessage('اكتمل البازل. أدخل إجابتك.', 'success');
  }

  async function checkAnswer(event) {
    event.preventDefault();
    const input = byId('br-player-answer');
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    const result = await call('puzzles:share:answer', { shareToken: token, answer: input.value });
    button.disabled = false;
    if (!result.ok) return setMessage(result.message || 'تعذر التحقق من الإجابة.', 'error');
    if (!result.correct) return setMessage(result.message || 'الإجابة غير صحيحة؛ حاول مرة أخرى.', 'error');
    const reveal = byId('br-player-reveal');
    reveal.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = result.answer;
    reveal.append(heading);
    reveal.hidden = false;
    input.disabled = true;
    button.disabled = true;
    setMessage('إجابة صحيحة.', 'success');
  }

  async function loadPuzzle() {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      byId('br-player-loading').textContent = 'رابط البازل غير صالح.';
      return;
    }
    const result = await call('puzzles:share:load', { shareToken: token });
    if (!result.ok || !result.puzzle) {
      byId('br-player-loading').textContent = result.message || 'تعذر تحميل هذا البازل.';
      return;
    }
    puzzle = result.puzzle;
    byId('br-player-title').textContent = puzzle.title || 'لغز موقع';
    if (puzzle.hint) {
      const hintButton = byId('br-player-hint-toggle');
      hintButton.hidden = false;
      hintButton.addEventListener('click', () => {
        const hint = byId('br-player-hint');
        hint.hidden = !hint.hidden;
        hint.textContent = hint.hidden ? '' : puzzle.hint;
        hintButton.textContent = hint.hidden ? 'إظهار التلميح' : 'إخفاء التلميح';
      });
    }
    makeBoard();
    makeTray();
    byId('br-player-loading').hidden = true;
    byId('br-player-content').hidden = false;
    updateProgress(0);
    tray.addEventListener('pointerdown', startDrag);
    byId('br-player-answer-form').addEventListener('submit', checkAnswer);
    document.addEventListener('pointermove', moveDrag, { passive: false });
    document.addEventListener('pointerup', endDrag, { passive: false });
    document.addEventListener('pointercancel', endDrag, { passive: false });
  }

  if (typeof window.io === 'function') {
    const socket = window.io('/public-puzzles');
    window.blackRidgePuzzleSocket = socket;
    socket.on('connect', () => {
      connection.textContent = 'اتصال مباشر · لا يلزم حساب';
      if (puzzle) {
        puzzle = null;
        complete = false;
        placed = 0;
        occupied.clear();
        byId('br-player-complete').hidden = true;
        byId('br-player-tray-wrap').hidden = false;
        setMessage('أُعيد الاتصال؛ ابدأ البازل من جديد.', 'error');
      }
      void loadPuzzle();
    });
    socket.on('disconnect', () => { connection.textContent = 'انقطع الاتصال — جارٍ إعادة المحاولة'; });
  } else {
    byId('br-player-loading').textContent = 'تعذر بدء اللعبة؛ حدّث الصفحة وحاول مجددًا.';
  }
})();
