/* ============================================================
 * cover.js — 用书名生成封面图（Canvas）
 * ============================================================ */
(function (global) {
  'use strict';

  var FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", sans-serif';

  function wrap(ctx, text, maxWidth) {
    var lines = [];
    var cur = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\n') { lines.push(cur); cur = ''; continue; }
      var test = cur + ch;
      if (ctx.measureText(test).width > maxWidth && cur.length) {
        lines.push(cur);
        cur = ch;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /**
   * @param {object} o { title, author, bg, fg, width, height }
   * @returns {{canvas, dataUrl}}
   */
  function generate(o) {
    o = o || {};
    var W = o.width || 600;
    var H = o.height || 800;
    var bg = o.bg || '#1b2a41';
    var fg = o.fg || '#f2f2f2';
    var title = (o.title || '未命名').trim();
    var author = (o.author || '').trim();

    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');

    // 背景
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 细边框
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.lineWidth = 2;
    ctx.strokeRect(36, 36, W - 72, H - 72);

    // 书名自适应字号
    var size = Math.round(W * 0.115);
    var maxW = W - 140;
    var lines;
    for (var guard = 0; guard < 24; guard++) {
      ctx.font = '600 ' + size + 'px ' + FONT_STACK;
      lines = wrap(ctx, title, maxW);
      if (lines.length * size * 1.35 <= H * 0.46 && size >= 26) break;
      size -= 4;
    }

    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + size + 'px ' + FONT_STACK;
    var lineH = size * 1.35;
    var startY = H * 0.42 - (lines.length - 1) * lineH / 2;
    for (var i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], W / 2, startY + i * lineH);
    }

    // 分隔线 + 作者
    if (author) {
      var by = H * 0.72;
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.beginPath();
      ctx.moveTo(W / 2 - 40, by - 34);
      ctx.lineTo(W / 2 + 40, by - 34);
      ctx.stroke();

      ctx.font = '400 ' + Math.round(W * 0.042) + 'px ' + FONT_STACK;
      ctx.fillText(author, W / 2, by);
    }

    return { canvas: cv, dataUrl: cv.toDataURL('image/jpeg', 0.92) };
  }

  function toBytes(canvas) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        blob.arrayBuffer().then(function (ab) { resolve(new Uint8Array(ab)); });
      }, 'image/jpeg', 0.92);
    });
  }

  global.EasyCover = { generate: generate, toBytes: toBytes };
})(typeof self !== 'undefined' ? self : this);
