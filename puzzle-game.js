'use strict';

(function attachBlackridgePuzzleGame(global) {
  function loadImage(source) {
    if (typeof Blob !== 'undefined' && source instanceof Blob && typeof global.createImageBitmap === 'function') {
      return global.createImageBitmap(source, { imageOrientation: 'from-image' })
        .catch(() => global.createImageBitmap(source));
    }
    return new Promise((resolve, reject) => {
      const image = new Image();
      let objectUrl = '';
      const releaseUrl = () => {
        if (!objectUrl) return;
        global.URL.revokeObjectURL(objectUrl);
        objectUrl = '';
      };
      image.onload = () => { releaseUrl(); resolve(image); };
      image.onerror = () => { releaseUrl(); reject(new Error('تعذر فتح الصورة المحددة.')); };
      if (typeof Blob !== 'undefined' && source instanceof Blob && global.URL?.createObjectURL) {
        objectUrl = global.URL.createObjectURL(source);
        image.src = objectUrl;
      } else {
        image.src = source;
      }
    });
  }

  function randomEdge() {
    return Math.random() < 0.5 ? -1 : 1;
  }

  function edgeGrid(rows, cols) {
    const horizontal = Array.from({ length: rows + 1 }, (_, row) =>
      Array.from({ length: cols }, () => row === 0 || row === rows ? 0 : randomEdge()));
    const vertical = Array.from({ length: rows }, () =>
      Array.from({ length: cols + 1 }, (_, col) => col === 0 || col === cols ? 0 : randomEdge()));
    return { horizontal, vertical };
  }

  function traceEdge(context, startX, startY, endX, endY, normalX, normalY, bump, amplitude) {
    if (!bump) {
      context.lineTo(endX, endY);
      return;
    }
    const dx = endX - startX;
    const dy = endY - startY;
    const length = Math.hypot(dx, dy);
    const tangentX = dx / length;
    const tangentY = dy / length;
    const point = (along, outward) => [
      startX + tangentX * length * along + normalX * amplitude * bump * outward,
      startY + tangentY * length * along + normalY * amplitude * bump * outward
    ];
    const curve = (controlAlong, controlOut, endAlong, endOut) => {
      const control = point(controlAlong, controlOut);
      const end = point(endAlong, endOut);
      context.quadraticCurveTo(control[0], control[1], end[0], end[1]);
    };
    context.lineTo(...point(0.29, 0));
    curve(0.34, 0, 0.39, 0.18);
    curve(0.42, 0.37, 0.47, 0.40);
    curve(0.50, 0.43, 0.53, 0.40);
    curve(0.58, 0.37, 0.61, 0.18);
    curve(0.66, 0, 0.71, 0);
    context.lineTo(endX, endY);
  }

  function tracePiece(context, cellWidth, cellHeight, bleed, edges, row, col, amplitude) {
    const left = bleed;
    const top = bleed;
    const right = bleed + cellWidth;
    const bottom = bleed + cellHeight;
    context.beginPath();
    context.moveTo(left, top);
    traceEdge(context, left, top, right, top, 0, -1, row === 0 ? 0 : -edges.horizontal[row][col], amplitude);
    traceEdge(context, right, top, right, bottom, 1, 0, col === edges.vertical[row].length - 1 ? 0 : edges.vertical[row][col + 1], amplitude);
    traceEdge(context, right, bottom, left, bottom, 0, 1, row === edges.horizontal.length - 1 ? 0 : edges.horizontal[row + 1][col], amplitude);
    traceEdge(context, left, bottom, left, top, -1, 0, col === 0 ? 0 : -edges.vertical[row][col], amplitude);
    context.closePath();
  }

  async function preparePieces(source, rows, cols) {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2 || rows * cols > 36) {
      throw new Error('عدد القطع غير صالح.');
    }
    const image = await loadImage(source);
    try {
      const sourceWidth = Number(image.naturalWidth || image.width);
      const sourceHeight = Number(image.naturalHeight || image.height);
      if (!sourceWidth || !sourceHeight) throw new Error('أبعاد الصورة غير صالحة.');

      let maxEdge = 800;
      while (maxEdge >= 400) {
        const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
        const board = document.createElement('canvas');
        board.width = Math.max(100, Math.round(sourceWidth * scale));
        board.height = Math.max(100, Math.round(sourceHeight * scale));
        const boardContext = board.getContext('2d', { alpha: false });
        if (!boardContext) throw new Error('تعذر تجهيز الصورة في هذا المتصفح.');
        boardContext.drawImage(image, 0, 0, board.width, board.height);
        const imageData = board.toDataURL('image/jpeg', 0.84);
        if (imageData.length > 1_850_000) {
          maxEdge = Math.floor(maxEdge * 0.82);
          continue;
        }

        const cellWidth = board.width / cols;
        const cellHeight = board.height / rows;
        const amplitude = Math.max(5, Math.min(cellWidth, cellHeight) * 0.19);
        const bleed = Math.ceil(amplitude + 2);
        const edges = edgeGrid(rows, cols);
        const pieces = [];
        let oversizedPiece = false;
        for (let row = 0; row < rows && !oversizedPiece; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(cellWidth + bleed * 2);
            canvas.height = Math.ceil(cellHeight + bleed * 2);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('تعذر تقسيم الصورة في هذا المتصفح.');
            tracePiece(context, cellWidth, cellHeight, bleed, edges, row, col, amplitude);
            context.save();
            context.clip();
            context.drawImage(board, bleed - col * cellWidth, bleed - row * cellHeight, board.width, board.height);
            context.restore();
            context.save();
            context.strokeStyle = 'rgba(18, 20, 23, .8)';
            context.lineWidth = 1.15;
            tracePiece(context, cellWidth, cellHeight, bleed, edges, row, col, amplitude);
            context.stroke();
            context.restore();
            const id = global.crypto && typeof global.crypto.randomUUID === 'function'
              ? global.crypto.randomUUID()
              : `piece_${Date.now().toString(36)}_${row}_${col}_${Math.random().toString(36).slice(2, 8)}`;
            const imageUrl = canvas.toDataURL('image/png');
            if (imageUrl.length > 340_000) { oversizedPiece = true; break; }
            pieces.push({ id, row, col, width: canvas.width, height: canvas.height, image: imageUrl });
          }
        }
        const requestEstimate = new TextEncoder().encode(JSON.stringify({ image: imageData, imageWidth: board.width, imageHeight: board.height, rows, cols, bleed, pieces })).length + 12_000;
        if (oversizedPiece || requestEstimate > 5_200_000) {
          maxEdge = Math.floor(maxEdge * 0.82);
          continue;
        }
        return { image: imageData, imageWidth: board.width, imageHeight: board.height, rows, cols, bleed, pieces };
      }
      throw new Error('تعذر ضغط الصورة والقطع إلى الحجم المسموح. جرّب عدد قطع أقل أو صورة أصغر.');
    } finally {
      if (typeof image.close === 'function') image.close();
    }
  }

  global.BlackridgePuzzleGame = Object.freeze({ preparePieces });
})(window);
