/* ============================================================
 * app.js — EasyPub Web 主逻辑
 * ============================================================ */
(function () {
  'use strict';

  var ROW_H = 30;
  var BATCH = 60;               // 每批处理章节数，批间让出主线程
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    text: '',
    encoding: '',
    fileName: '',
    chapters: [],              // {title, level, start, end, chars, deleted}
    selection: {},             // idx -> true
    anchor: -1,
    rules: Object.assign({}, EasyText.DEFAULT_RULES),
    builder: {
      prefixes: ['第'],
      numberMode: 'any',
      suffixes: ['章', '回', '节', '集', '卷', '部', '篇']
    },
    cssOpt: {
      fontSize: 100, lineHeight: 150, indentEm: 2, paraMargin: 0.35,
      textAlign: 'justify', marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0
    },
    customCss: '',
    cssMode: 'append',
    nameWithAuthor: true,
    meta: { title: '', author: '', language: 'zh-CN', subject: '', description: '', publisher: '', tocPage: false },
    cover: { mode: 'none', bg: '#1b2a41', fg: '#f2f2f2', uploaded: null, mime: 'image/jpeg' },
    previewIdx: 0,
    editMode: false,
    editingIndex: -1,
    originals: {},             // idx -> 该章导入时的原始内容（仅记录被改过的章，用于还原）
    textDirty: false,          // 原文是否有未导出的修改
    bookSeq: 0,                // 每导入一本新书 +1，用于识别编辑上下文是否已失效
    editBookSeq: -1,           // 当前编辑器打开的是第几本书
    pendingDirty: false,       // 重新分章后仍保留的「有编辑」状态（无还原点时用）
    lineEnding: 'lf',          // 原始文件的换行风格，导出 TXT 时还原
    chapterSeq: 0              // 章节 id 自增序号
  };

  /* ---------------- 工具 ---------------- */
  function fmtChars(n) {
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }
  function fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    return (n / 1024).toFixed(0) + ' KB';
  }
  function setStatus(s) { $('statusText').textContent = s; }
  function setProgress(p) {
    var box = document.querySelector('.progress');
    if (p == null) { box.classList.remove('on'); $('progressBar').style.width = '0%'; return; }
    box.classList.add('on');
    $('progressBar').style.width = Math.round(p * 100) + '%';
  }
  function nextTick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function selCount() { return Object.keys(state.selection).length; }
  function selIndexes() { return Object.keys(state.selection).map(Number); }
  function clearSelection() { state.selection = {}; state.anchor = -1; }

  /* ---------------- 导入 ---------------- */
  function importFile(file) {
    if (!file) return;
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext !== 'txt' && !/text/.test(file.type)) {
      if (!confirm('这不是 .txt 文件，仍要尝试导入吗？')) return;
    }
    setStatus('读取中…');
    setProgress(0.05);
    file.arrayBuffer().then(function (ab) {
      var hadEdits = state.textDirty;      // 换书前是否有未导出的修改
      var res = EasyText.decodeBuffer(ab);
      // 统一换成 LF：textarea 的 value 会把 CRLF 规范化为 LF，
      // 不统一的话编辑往返会被误判成「内容被改过」，进而改写正文、覆盖章节标题
      state.lineEnding = res.text.indexOf('\r') >= 0 ? 'crlf' : 'lf';
      state.text = state.lineEnding === 'crlf' ? res.text.replace(/\r\n?/g, '\n') : res.text;
      state.encoding = res.encoding;
      state.fileName = file.name;
      state.bookSeq++;                 // 换书：旧的编辑上下文立即失效

      var meta = extractMeta(res.text, file.name);
      state.meta.title = meta.title || state.meta.title;
      state.meta.author = meta.author || state.meta.author;
      state.meta.description = meta.desc || state.meta.description;

      syncMetaToUI();
      updateNamePreview();
      setProgress(0.3);
      return nextTick().then(function () { return resplit(true); });
    }).catch(function (e) {
      console.error(e);
      setStatus('导入失败：' + e.message);
      setProgress(null);
    });
  }

  function extractMeta(text, fileName) {
    var head = text.slice(0, 4000);
    var out = { title: '', author: '', desc: '' };

    var m = head.match(/《([^》\n]{1,40})》/);
    if (m) out.title = m[1].trim();

    m = head.match(/作\s*者\s*[：:]\s*([^\n\r《》]{1,30})/);
    if (m) out.author = m[1].trim();

    m = head.match(/内容简介\s*[：:]\s*([\s\S]*?)(?:\n\s*\n\s*\n|$)/);
    if (m) out.desc = m[1].trim().replace(/^[\u3000\s]+/gm, '');

    if (!out.title || !out.author) {
      var base = fileName.replace(/\.[^.]+$/, '');
      var parts = base.split(/[_\-\u2014]/);
      if (!out.title) out.title = (parts[0] || '').trim();
      if (!out.author && parts.length > 1) out.author = parts[1].trim();
    }
    return out;
  }

  /* ---------------- 分章 ---------------- */
  function resplit(isNewBook) {
    if (!state.text) return;
    var wasDirty = state.textDirty;      // 上一本书（或重新分章前）是否有未导出修改
    setStatus('分章中…');
    setProgress(0.45);
    return nextTick().then(function () {
      syncRules();
      var list = EasyText.parseChapters(state.text, state.rules);
      var texts = list.map(function (c) {
        return {
          id: newChapterId(),
          type: 'text',
          title: c.title, level: c.level, start: c.start, end: c.end,
          chars: c.chars, deleted: null, fixedTitle: !!c.fixedTitle
        };
      });
      // 封面页、目录页也是章节；重新分章时保留它们的存在状态
      var wantCover = hasFrontChapter('cover');
      var wantToc = hasFrontChapter('toc');
      var fronts = [];
      if (wantCover) fronts.push(makeFrontChapter('cover'));
      if (wantToc) fronts.push(makeFrontChapter('toc'));
      state.chapters = fronts.concat(texts);
      clearSelection();
      state.previewIdx = 0;
      state.originals = {};
      // 换书：编辑痕迹全部作废；同书重新分章：内容没变，保留「已编辑」状态以便导出 TXT
      state.pendingDirty = isNewBook ? false : wasDirty;
      refreshDirtyUi();

      // 换书后彻底重置编辑上下文：索引、编辑器内容、编辑模式
      state.editingIndex = -1;
      state.editBookSeq = -1;
      var ea = $('editArea');
      if (ea) ea.value = '';
      var ep = $('edPos');
      if (ep) ep.textContent = '—';
      if (state.editMode) {
        state.editMode = false;
        setEditModeUI();
      }
      setProgress(0.7);
      renderFileCard();
      renderList();
      fillPreviewSelect();
      refreshPreview();
      setProgress(null);
      setStatus('分章完成，共 ' + state.chapters.length + ' 章' +
        (isNewBook && wasDirty ? ' · 上一本书的未导出修改已丢弃' : ''));
      $('btnBuild').disabled = false;
      $('searchBox').disabled = false;
      $('btnResplit').disabled = false;
      $('btnEdit').disabled = false;
    });
  }

  /* ---------------- 规则构建器 ---------------- */
  function chipsOf(id) {
    var nodes = document.querySelectorAll('#' + id + ' .chip.active');
    return Array.prototype.map.call(nodes, function (b) { return b.dataset.v; });
  }
  function chipOf(id) {
    var b = document.querySelector('#' + id + ' .chip.active');
    return b ? b.dataset.v : null;
  }

  function buildSimpleReg(b) {
    var NUM = b.numberMode === 'arabic'
      ? '0-9'
      : b.numberMode === 'cjk'
        ? '一二三四五六七八九十零〇百千两'
        : '0123456789一二三四五六七八九十零〇百千两';
    var branches = [];

    var cnPrefixes = b.prefixes.filter(function (p) { return p !== 'Chapter'; });
    if (cnPrefixes.length) {
      var sufs = b.suffixes.length ? b.suffixes : ['章', '回', '节', '集', '卷', '部', '篇'];
      var preCls = '[' + cnPrefixes.join('') + ']';
      var sufCls = '[' + sufs.join('') + ']';
      branches.push(preCls + '\\s*[' + NUM + ']+\\s*' + sufCls);
    }
    if (b.prefixes.indexOf('Chapter') >= 0) {
      branches.push('(?:Chapter|CHAPTER|chapter)\\s*[0-9IVXLCivxlc]+');
    }
    if (!branches.length) branches.push('第\\s*[' + NUM + ']+\\s*章');

    return '^[ \\t\\u3000]*(?:' + branches.join('|') + ').*$';
  }

  function syncRules() {
    state.builder.prefixes = chipsOf('prefixChips');
    state.builder.suffixes = chipsOf('suffixChips');
    state.builder.numberMode = chipOf('numChips') || 'any';
    state.rules.simpleReg = buildSimpleReg(state.builder);
    state.rules.fullRegex = $('fullRegex').value;
    state.rules.extraKeywords = $('extraKeywords').value;
    state.rules.levelBySuffix = $('levelBySuffix').checked;
    state.rules.filterProse = $('filterProse').checked;
    state.rules.emptyChapterMode = $('emptyMode').value;
    var act = $('splitMode').querySelector('button.active');
    state.rules.mode = act ? act.dataset.val : 'simple';
  }

  function effectiveRegex() {
    var act = $('splitMode').querySelector('button.active');
    var mode = act ? act.dataset.val : 'simple';
    if (mode === 'regex') return $('fullRegex').value || '（空）';
    return buildSimpleReg({
      prefixes: chipsOf('prefixChips'),
      suffixes: chipsOf('suffixChips'),
      numberMode: chipOf('numChips') || 'any'
    });
  }

  var previewTimer = null;
  function scheduleRulePreview() {
    $('effectiveReg').textContent = effectiveRegex();
    clearTimeout(previewTimer);
    if (!state.text) { $('rulePreview').textContent = '导入文件后可预览识别结果'; return; }
    $('rulePreview').className = 'rule-preview';
    $('rulePreview').textContent = '正在计算…';
    previewTimer = setTimeout(runRulePreview, 240);
  }

  function runRulePreview() {
    if (!state.text) return;
    syncRules();
    var box = $('rulePreview');
    var list;
    try {
      list = EasyText.parseChapters(state.text, state.rules);
    } catch (e) {
      box.className = 'rule-preview bad';
      box.textContent = '正则无效：' + e.message;
      return;
    }
    if (!list.length) {
      box.className = 'rule-preview bad';
      box.textContent = '预计识别 0 章 — 规则可能太严，检查前缀/后缀或改用正则模式';
      return;
    }
    var lv1 = list.filter(function (c) { return c.level === 1; }).length;
    var emptyish = list.filter(function (c) { return c.chars < 50; }).length;
    box.className = emptyish > list.length * 0.05 ? 'rule-preview warn' : 'rule-preview';
    box.textContent = '预计识别 ' + list.length + ' 章（一级目录 ' + lv1 + ' 个）' +
      (emptyish ? ' · 其中 ' + emptyish + ' 章几乎无正文，确认是否误判' : '') +
      ' · 当前已应用 ' + state.chapters.length + ' 章';
  }

  /* ---------------- 文件卡 ---------------- */
  function renderFileCard() {
    var alive = state.chapters.filter(function (c) { return !c.deleted; });
    var total = alive.reduce(function (a, c) { return a + c.chars; }, 0);
    var el = $('fileCard');
    el.textContent = '';

    var name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = state.fileName;
    el.appendChild(name);

    syncFrontCheckboxes();
    var meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.innerHTML = '编码 <b>' + state.encoding.toUpperCase() + '</b> · ' +
      '正文 <b>' + fmtChars(total) + '</b> 字 · ' +
      '有效 <b>' + alive.length + '</b> / ' + state.chapters.length + ' 章';
    el.appendChild(meta);
  }

  /* ---------------- 前置页章节（封面 / 目录） ---------------- */
  function newChapterId() {
    return 'ch' + (++state.chapterSeq);
  }

  function makeFrontChapter(type) {
    return {
      id: newChapterId(),
      type: type,
      title: type === 'cover' ? '封面' : '目录',
      level: 1,
      start: -1,
      end: -1,
      chars: 0,
      deleted: null,
      fixedTitle: true
    };
  }

  /** 插入前置页章节：封面插最前，目录插在封面之后 */
  function insertFrontChapter(type) {
    var ch = makeFrontChapter(type);
    if (type === 'cover') {
      state.chapters.unshift(ch);
    } else {
      var ci = -1;
      for (var i = 0; i < state.chapters.length; i++) {
        if (state.chapters[i].type === 'cover') { ci = i; break; }
      }
      state.chapters.splice(ci >= 0 ? ci + 1 : 0, 0, ch);
    }
    return ch;
  }

  function hasFrontChapter(type) {
    return state.chapters.some(function (c) { return c.type === type && c.deleted !== 'drop'; });
  }

  /** 复选框与「章节是否存在」双向对齐（列表里删除封面页后，勾选也要取消） */
  function syncFrontCheckboxes() {
    var c = $('mIncludeCover');
    var t = $('mTocPage');
    if (c) c.checked = hasFrontChapter('cover');
    if (t) t.checked = hasFrontChapter('toc');
  }

  /** 开关前置页：存在则标记删除，不存在则插入 */
  function setFrontChapter(type, on) {
    var existing = null;
    for (var i = 0; i < state.chapters.length; i++) {
      if (state.chapters[i].type === type) { existing = state.chapters[i]; break; }
    }
    if (on) {
      if (existing) existing.deleted = null;
      else insertFrontChapter(type);
    } else if (existing) {
      existing.deleted = 'drop';
    }
    renderList();
    renderFileCard();
  }

  /* ---------------- 虚拟列表 ---------------- */
  var listEl, innerEl, filteredCache = null;

  function getFiltered() {
    var q = ($('searchBox').value || '').trim().toLowerCase();
    if (!q) return state.chapters.map(function (c, i) { return { c: c, i: i }; });
    return state.chapters
      .map(function (c, i) { return { c: c, i: i }; })
      .filter(function (o) { return o.c.title.toLowerCase().indexOf(q) >= 0; });
  }

  function renderList() {
    filteredCache = getFiltered();
    var rows = filteredCache;
    innerEl.style.height = (rows.length * ROW_H) + 'px';
    if (!rows.length) {
      innerEl.innerHTML = '';
      var hint = document.createElement('div');
      hint.className = 'list-hint';
      hint.textContent = state.chapters.length
        ? '没有匹配的章节'
        : (state.text ? '未识别到章节，检查分章规则' : '导入 TXT 后在此编辑章节');
      innerEl.appendChild(hint);
      updateBulkBar();
      return;
    }
    paintRows();
    updateBulkBar();
  }

  function paintRows() {
    var rows = filteredCache;
    if (!rows) return;
    var scrollTop = listEl.scrollTop;
    var viewH = listEl.clientHeight;
    var start = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
    var end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 4);

    var frag = document.createDocumentFragment();
    for (var k = start; k < end; k++) {
      frag.appendChild(buildRow(rows[k].c, rows[k].i, k));
    }
    innerEl.textContent = '';
    innerEl.appendChild(frag);
    markDraggingRow();          // 拖动中重建列表后重新标记

    var st = $('listStats');
    st.textContent = '';
    var a = document.createElement('span'); a.innerHTML = '显示 <b>' + rows.length + '</b>';
    var b = document.createElement('span'); b.innerHTML = '总 <b>' + state.chapters.length + '</b>';
    st.appendChild(a); st.appendChild(b);
    if (rows.length !== state.chapters.length) {
      var c = document.createElement('span'); c.textContent = '（已筛选）';
      st.appendChild(c);
    }
  }

  function buildRow(ch, idx, visualIdx) {
    var isFront = ch.type !== 'text';
    var row = document.createElement('div');
    row.className = 'chapter-row lv' + Math.min(ch.level, 4) +
      (isFront ? ' is-front' : '') +
      (state.selection[idx] ? ' is-selected' : '') +
      (ch.deleted ? ' is-deleted' : '');
    row.style.top = (visualIdx * ROW_H) + 'px';
    row.dataset.idx = idx;
    row.dataset.visual = visualIdx;

    var i1 = document.createElement('span');
    i1.className = 'idx';
    i1.textContent = idx + 1;

    var t = document.createElement('span');
    t.className = 'title';
    t.textContent = ch.title;
    t.title = ch.title;
    t.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      inlineRename(idx, ch);
    });

    var ch2 = document.createElement('span');
    ch2.className = 'chars' + (isFront ? ' front-badge' : '');
    ch2.textContent = ch.type === 'cover' ? '封面页'
      : (ch.type === 'toc' ? '目录页' : fmtChars(ch.chars));

    var acts = document.createElement('span');
    acts.className = 'row-actions';
    acts.appendChild(mkBtn('−', '降为下级', function (e) { e.stopPropagation(); nudgeLevel([idx], -1); }));
    acts.appendChild(mkBtn('+', '升为上级', function (e) { e.stopPropagation(); nudgeLevel([idx], 1); }));
    acts.appendChild(mkBtn('✎', '重命名（也可双击标题）', function (e) { e.stopPropagation(); inlineRename(idx, ch); }));
    acts.appendChild(mkBtn(ch.deleted ? '↺' : '×', ch.deleted ? '恢复' : '删除（Shift 点彻底删除）',
      function (e) { e.stopPropagation(); toggleDelete([idx], e.shiftKey); }, !ch.deleted ? 'del' : ''));

    row.appendChild(i1); row.appendChild(t); row.appendChild(ch2); row.appendChild(acts);

    row.addEventListener('mousedown', function (e) { startRowDrag(e, idx, row); });
    row.addEventListener('click', function (e) {
      if (justDragged) return;          // 刚拖动过，不当作点击
      handleRowClick(e, idx);
    });
    return row;
  }

  function mkBtn(label, tip, fn, cls) {
    var b = document.createElement('button');
    b.textContent = label;
    b.title = tip;
    b.className = cls || '';
    b.addEventListener('click', fn);
    return b;
  }

  /* ---------------- 拖动排序（自定义鼠标实现，兼容虚拟列表重建） ---------------- */
  var dragCtx = null;
  var dragLine = null;
  var justDragged = false;

  function startRowDrag(e, idx, row) {
    if (e.button !== 0) return;
    if (e.target.closest('button') || e.target.closest('input')) return;
    if (!state.chapters.length) return;
    // 筛选状态下拖动语义不清，直接禁用
    if (($('searchBox').value || '').trim()) return;

    dragCtx = {
      idx: idx,
      visualFrom: Number(row.dataset.visual),
      startX: e.clientX,
      startY: e.clientY,
      lastY: e.clientY,
      active: false,
      targetVisual: -1,
      scrollSpeed: 0,
      timer: null
    };
    document.addEventListener('mousemove', onRowDragMove);
    document.addEventListener('mouseup', onRowDragEnd);
  }

  function onRowDragMove(e) {
    if (!dragCtx) return;
    var dy = e.clientY - dragCtx.startY;
    var dx = e.clientX - dragCtx.startX;

    if (!dragCtx.active) {
      if (Math.abs(dy) < 5 && Math.abs(dx) < 5) return;
      if (Math.abs(dx) > Math.abs(dy) * 2) { cleanupDrag(); return; }   // 更像横向选择，忽略
      dragCtx.active = true;
      beginDragVisual();
    }

    e.preventDefault();
    dragCtx.lastY = e.clientY;
    updateDropTarget(e.clientY);
  }

  function beginDragVisual() {
    dragLine = document.createElement('div');
    dragLine.className = 'drop-line';
    innerEl.appendChild(dragLine);
    document.body.classList.add('row-dragging');
    setStatus('拖到目标位置后松开鼠标');
    markDraggingRow();
  }

  function markDraggingRow() {
    if (!dragCtx || !dragCtx.active) return;
    var r = innerEl.querySelector('.chapter-row[data-idx="' + dragCtx.idx + '"]');
    if (r) r.classList.add('dragging');
  }

  function visualFromY(clientY) {
    var rect = innerEl.getBoundingClientRect();
    var n = (filteredCache || []).length;
    var v = Math.round((clientY - rect.top) / ROW_H);
    return Math.max(0, Math.min(n, v));
  }

  function updateDropTarget(clientY) {
    var v = visualFromY(clientY);
    dragCtx.targetVisual = v;
    if (dragLine) dragLine.style.top = (v * ROW_H) + 'px';

    var lr = listEl.getBoundingClientRect();
    if (clientY < lr.top + 44) dragCtx.scrollSpeed = -14;
    else if (clientY > lr.bottom - 44) dragCtx.scrollSpeed = 14;
    else dragCtx.scrollSpeed = 0;

    if (dragCtx.scrollSpeed && !dragCtx.timer) {
      dragCtx.timer = setInterval(function () {
        if (!dragCtx || !dragCtx.active) return;
        listEl.scrollTop += dragCtx.scrollSpeed;
        paintRows();
        markDraggingRow();
        var vv = visualFromY(dragCtx.lastY);
        dragCtx.targetVisual = vv;
        if (dragLine) dragLine.style.top = (vv * ROW_H) + 'px';
      }, 45);
    } else if (!dragCtx.scrollSpeed && dragCtx.timer) {
      clearInterval(dragCtx.timer);
      dragCtx.timer = null;
    }
  }

  function onRowDragEnd() {
    if (!dragCtx) return;
    var ctx = dragCtx;
    var wasActive = ctx.active;
    var fromVisual = ctx.visualFrom;
    var toVisual = ctx.targetVisual;
    cleanupDrag();

    if (!wasActive) return;                 // 只是单击，交给 click 处理
    justDragged = true;
    setTimeout(function () { justDragged = false; }, 0);

    if (toVisual < 0) return;
    if (toVisual === fromVisual || toVisual === fromVisual + 1) return;   // 位置没变

    var insertAt = toVisual > fromVisual ? toVisual - 1 : toVisual;
    moveChapter(ctx.idx, insertAt);
  }

  function cleanupDrag() {
    if (dragCtx && dragCtx.timer) clearInterval(dragCtx.timer);
    document.removeEventListener('mousemove', onRowDragMove);
    document.removeEventListener('mouseup', onRowDragEnd);
    document.body.classList.remove('row-dragging');
    if (dragLine && dragLine.parentNode) dragLine.parentNode.removeChild(dragLine);
    dragLine = null;
    var r = innerEl.querySelector('.chapter-row.dragging');
    if (r) r.classList.remove('dragging');
    dragCtx = null;
  }

  /** 把 chapters[from] 移动到 insertAt 位置，并同步重排正文 */
  function moveChapter(from, to) {
    if (from === to || from < 0 || from >= state.chapters.length) return;
    to = Math.max(0, Math.min(state.chapters.length - 1, to));
    if (from === to) return;

    var moved = state.chapters.splice(from, 1)[0];
    state.chapters.splice(to, 0, moved);

    var touchedText = moved.type === 'text' ||
      state.chapters.slice(Math.min(from, to), Math.max(from, to) + 1)
        .some(function (c) { return c.type === 'text'; });

    if (touchedText) rebuildText();

    clearSelection();
    state.previewIdx = 0;
    renderList();
    renderFileCard();
    fillPreviewSelect();
    setStatus('已移动「' + moved.title + '」到第 ' + (to + 1) + ' 位');
  }

  /**
   * 按当前章节顺序重建正文：内容跟着章节走，重算所有区间偏移。
   * 同时把「删除」标记就地固化（合并的内容真正并入上一章）。
   */
  function rebuildText() {
    var pieces = [];
    state.chapters.forEach(function (c) {
      if (c.type !== 'text') return;
      if (c.deleted === 'drop') return;
      var seg = state.text.slice(c.start, c.end);
      if (c.deleted === 'merge') {
        if (pieces.length) pieces[pieces.length - 1].text += seg;
        else pieces.push({ chapter: null, text: seg });
        return;
      }
      pieces.push({ chapter: c, text: seg });
    });

    var pos = 0;
    var buf = [];
    pieces.forEach(function (p) {
      if (p.chapter) {
        p.chapter.start = pos;
        p.chapter.end = pos + p.text.length;
        p.chapter.chars = p.text.trim().length;
      }
      pos += p.text.length;
      buf.push(p.text);
    });
    state.text = buf.join('');

    // 删除标记已固化，清掉它们，避免二次应用
    state.chapters = state.chapters.filter(function (c) {
      return c.type !== 'text' || !c.deleted;
    });
  }

  /* ---------------- 选择 ---------------- */
  /** 只刷新选中样式，不重建 DOM —— 否则双击时元素被替换，dblclick 永远触发不了 */
  function updateSelectionClasses() {
    var rows = innerEl.querySelectorAll('.chapter-row');
    for (var i = 0; i < rows.length; i++) {
      var on = !!state.selection[Number(rows[i].dataset.idx)];
      if (on !== rows[i].classList.contains('is-selected')) {
        rows[i].classList.toggle('is-selected', on);
      }
    }
  }

  function handleRowClick(e, idx) {
    if (e.shiftKey && state.anchor >= 0) {
      var a = Math.min(state.anchor, idx);
      var b = Math.max(state.anchor, idx);
      for (var i = a; i <= b; i++) state.selection[i] = true;
    } else if (e.ctrlKey || e.metaKey) {
      if (state.selection[idx]) delete state.selection[idx];
      else state.selection[idx] = true;
      state.anchor = idx;
    } else {
      clearSelection();
      state.selection[idx] = true;
      state.anchor = idx;
    }
    state.previewIdx = idx;
    var sel = $('previewChapter');
    if (sel.querySelector('option[value="' + idx + '"]')) sel.value = String(idx);

    updateSelectionClasses();     // 不重建 DOM，保证双击改名可用
    updateBulkBar();
    refreshPreview();
    if (state.editMode) loadChapterToEditor(idx);
  }

  function updateBulkBar() {
    var n = selCount();
    $('bulkBar').hidden = n === 0;
    $('bulkCount').textContent = n;
  }

  function inlineRename(idx, ch) {
    var row = innerEl.querySelector('.chapter-row[data-idx="' + idx + '"]');
    if (!row) return;
    var t = row.querySelector('.title');
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = ch.title;
    inp.className = 'input';
    inp.style.height = '22px';
    inp.style.fontSize = '12.5px';
    inp.style.padding = '0 6px';
    inp.style.width = '100%';
    row.replaceChild(inp, t);
    inp.focus();
    inp.select();

    var committed = false;
    var commit = function () {
      if (committed) return;          // blur 与 Enter 可能接连触发，确保只提交一次
      committed = true;
      var v = inp.value.trim();
      if (v && v !== ch.title) {
        ch.title = v;
        ch.fixedTitle = false;        // 用户主动改过名，不再视为固定标题
      }
      renderList();
      fillPreviewSelect();
      refreshPreview();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { inp.value = ch.title; commit(); }
    });
  }

  /* ---------------- 批量操作 ---------------- */
  function nudgeLevel(idxs, delta) {
    idxs.forEach(function (i) {
      var c = state.chapters[i];
      if (c) c.level = Math.max(1, Math.min(4, c.level + delta));
    });
    renderList();
  }

  function setLevel(idxs, level) {
    idxs.forEach(function (i) {
      var c = state.chapters[i];
      if (c) c.level = level;
    });
    renderList();
  }

  function toggleDelete(idxs, hard) {
    var anyAlive = idxs.some(function (i) { return state.chapters[i] && !state.chapters[i].deleted; });
    idxs.forEach(function (i) {
      var c = state.chapters[i];
      if (!c) return;
      if (anyAlive) c.deleted = (hard || c.type !== 'text') ? 'drop' : 'merge';
      else c.deleted = null;
    });
    setStatus((anyAlive ? '已删除 ' : '已恢复 ') + idxs.length + ' 章' +
      (anyAlive && hard ? '（内容丢弃）' : anyAlive ? '（内容并入上一章）' : ''));
    renderFileCard();
    renderList();
    fillPreviewSelect();
  }

  function applyBulk(action) {
    var idxs = selIndexes();
    if (!idxs.length) return;
    switch (action) {
      case 'level-up': nudgeLevel(idxs, -1); setStatus('已提升 ' + idxs.length + ' 章层级'); break;
      case 'level-down': nudgeLevel(idxs, 1); setStatus('已降低 ' + idxs.length + ' 章层级'); break;
      case 'level-1': setLevel(idxs, 1); setStatus('已设为一级：' + idxs.length + ' 章'); break;
      case 'level-2': setLevel(idxs, 2); setStatus('已设为二级：' + idxs.length + ' 章'); break;
      case 'level-3': setLevel(idxs, 3); setStatus('已设为三级：' + idxs.length + ' 章'); break;
      case 'del': toggleDelete(idxs, false); break;
      case 'restore':
        idxs.forEach(function (i) { if (state.chapters[i]) state.chapters[i].deleted = null; });
        renderFileCard(); renderList(); fillPreviewSelect();
        setStatus('已恢复 ' + idxs.length + ' 章');
        break;
      case 'clear': clearSelection(); paintRows(); updateBulkBar(); break;
    }
  }

  /* ---------------- 原文编辑 ---------------- */
  function refreshDirtyUi() {
    // textDirty 由「还有哪些章与原文不同」推导，重新分章后无还原点时兜底靠 pendingDirty
    state.textDirty = Object.keys(state.originals).length > 0 || state.pendingDirty;
    $('btnDownloadTxt').disabled = !state.textDirty;
  }

  function firstAliveIndex() {
    for (var i = 0; i < state.chapters.length; i++) {
      if (!state.chapters[i].deleted) return i;
    }
    return 0;
  }

  function findNextAlive(from, dir) {
    var i = from + dir;
    while (i >= 0 && i < state.chapters.length) {
      if (!state.chapters[i].deleted) return i;
      i += dir;
    }
    return -1;
  }

  function setEditModeUI() {
    var mask = $('editorMask');
    mask.classList.toggle('on', state.editMode);
    mask.hidden = !state.editMode;
    $('btnEdit').textContent = state.editMode ? '退出编辑' : '编辑原文';
  }

  function toggleEdit() {
    if (state.editMode) {
      // 必须先提交（此刻 editMode 仍为 true，commitEditor 才会真正执行），再切回非编辑态
      var saved = commitEditor();
      state.editMode = false;
      setEditModeUI();
      setStatus(saved ? '修改已保存，已退出编辑模式' : '已退出编辑模式');
      return;
    }
    if (!state.chapters.length) return;
    state.editMode = true;
    setEditModeUI();
    var idx = selCount() ? Number(selIndexes()[0]) : firstAliveIndex();
    loadChapterToEditor(idx);
    $('editArea').focus();
    setStatus('编辑模式：点击左侧章节切换，修改后自动保存');
  }

  function loadChapterToEditor(idx) {
    commitEditor();                       // 先提交上一章
    var c = state.chapters[idx];
    if (!c) return;

    state.editingIndex = idx;
    state.editBookSeq = state.bookSeq;
    state.selection = {};
    state.selection[idx] = true;
    state.anchor = idx;
    state.previewIdx = idx;

    $('editArea').value = state.text.slice(c.start, c.end);
    $('editArea').scrollTop = 0;
    $('edPos').textContent = '第 ' + (idx + 1) + ' / ' + state.chapters.length + ' 章　' + c.title;

    var opt = $('previewChapter').querySelector('option[value="' + idx + '"]');
    if (opt) $('previewChapter').value = String(idx);

    updateEdStat();
    updateSelectionClasses();
    updateBulkBar();
  }

  function updateEdStat() {
    var el = $('edStat');
    var val = $('editArea').value;
    var idx = state.editingIndex;
    var c = state.chapters[idx];
    if (!c) { el.textContent = '—'; return; }
    // 与「导入时的原文」比较；从未改过的章，原文就是当前区间内容
    var orig = state.originals[c.id] !== undefined ? state.originals[c.id] : state.text.slice(c.start, c.end);
    var changed = val !== orig;
    el.className = 'ed-stat' + (changed ? ' dirty' : '');
    if (changed) {
      var d = val.trim().length - orig.trim().length;
      el.textContent = '已修改 · ' + val.trim().length + ' 字' + (d ? '（' + (d > 0 ? '+' : '') + d + '）' : '');
    } else {
      el.textContent = val.trim().length + ' 字 · 未修改';
    }
  }

  /**
   * 把编辑器内容写回原文，并平移后续章节的偏移量
   * @returns {boolean} 是否产生了改动
   */
  function applyChapterEdit(idx, newVal) {
    var c = state.chapters[idx];
    if (!c || newVal == null) return false;
    newVal = String(newVal).replace(/\r\n?/g, '\n');   // 防御：编辑器可能带回 CR
    var oldVal = state.text.slice(c.start, c.end);
    if (oldVal === newVal) return false;

    // 首次改动时留存该章导入时的原文，作为「还原本章」的依据
    if (state.originals[c.id] === undefined) state.originals[c.id] = oldVal;

    var delta = newVal.length - oldVal.length;
    state.text = state.text.slice(0, c.start) + newVal + state.text.slice(c.end);

    c.end = c.start + newVal.length;
    c.chars = newVal.trim().length;

    // 首行仍像标题时同步章节名（正文句子不会超过 40 字且通常带句末标点）
    // fixedTitle 的章节（「序」）标题固定，不吃正文首行
    var firstLine = (newVal.split('\n')[0] || '').trim();
    if (!c.fixedTitle && firstLine && firstLine !== c.title &&
        firstLine.length <= 40 && !/[。；，、]$/.test(firstLine)) {
      c.title = firstLine;
    }

    for (var i = idx + 1; i < state.chapters.length; i++) {
      state.chapters[i].start += delta;
      state.chapters[i].end += delta;
    }

    // 手工改回与原文完全一致时，不再算作已修改
    if (newVal === state.originals[c.id]) {
      delete state.originals[c.id];
      if (!c.fixedTitle) c.title = (newVal.split('\n')[0] || '').trim() || c.title;
    }
    return true;
  }

  function commitEditor() {
    if (state.editingIndex < 0 || !state.editMode) return false;
    if (state.editBookSeq !== state.bookSeq) return false;   // 编辑器里是上一本书的内容，禁止写回
    var changed = applyChapterEdit(state.editingIndex, $('editArea').value);
    if (changed) {
      updateEdStat();
      refreshDirtyUi();
      renderList();
      renderFileCard();
    }
    return changed;
  }

  function revertChapter() {
    var idx = state.editingIndex;
    if (state.editBookSeq !== state.bookSeq) return;
    var c = state.chapters[idx];
    if (!c) return;
    var cur = state.text.slice(c.start, c.end);

    // 尚未提交过的修改：直接丢弃文本框内容即可，原文本来就没变
    if (state.originals[c.id] === undefined) {
      $('editArea').value = cur;
      updateEdStat();
      setStatus('已还原为原文（未保存的修改已丢弃）');
      return;
    }

    var orig = state.originals[c.id];
    if (cur !== orig) {
      var delta = orig.length - cur.length;
      state.text = state.text.slice(0, c.start) + orig + state.text.slice(c.end);
      c.end = c.start + orig.length;
      c.chars = orig.trim().length;
      for (var i = idx + 1; i < state.chapters.length; i++) {
        state.chapters[i].start += delta;
        state.chapters[i].end += delta;
      }
      var firstLine = (orig.split('\n')[0] || '').trim();
      if (!c.fixedTitle && firstLine) c.title = firstLine;
    }

    delete state.originals[c.id];
    $('editArea').value = orig;
    updateEdStat();
    refreshDirtyUi();
    renderList();
    renderFileCard();
    setStatus('已还原为导入时的原文');
  }

  function stepChapter(dir) {
    var next = findNextAlive(state.editingIndex, dir);
    if (next < 0) { setStatus(dir > 0 ? '已经是最后一章' : '已经是第一章'); return; }
    loadChapterToEditor(next);
  }

  function downloadText() {
    var name = outputName().replace(/\.epub$/i, '.txt');
    // 还原原始换行风格，Windows 记事本打开更友好
    var out = state.lineEnding === 'crlf' ? state.text.replace(/\n/g, '\r\n') : state.text;
    var blob = new Blob(['\uFEFF' + out], { type: 'text/plain;charset=utf-8' });
    download(blob, name);
    setStatus('已导出 TXT：' + name + ' · ' + fmtBytes(blob.size));
  }

  function bindEditor() {
    $('btnEdit').addEventListener('click', toggleEdit);
    $('edDone').addEventListener('click', toggleEdit);
    $('edPrev').addEventListener('click', function () { stepChapter(-1); });
    $('edNext').addEventListener('click', function () { stepChapter(1); });
    $('edRevert').addEventListener('click', revertChapter);
    $('btnDownloadTxt').addEventListener('click', downloadText);
    $('editArea').addEventListener('input', updateEdStat);
    $('editArea').addEventListener('blur', function () { commitEditor(); });

    document.addEventListener('keydown', function (e) {
      if (!state.editMode) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setStatus(commitEditor() ? '本章已保存' : '本章无改动');
      }
      if (e.key === 'Escape') {
        var tag = (document.activeElement && document.activeElement.tagName) || '';
        if (tag === 'TEXTAREA') { commitEditor(); toggleEdit(); }
      }
    });
  }

  /* ---------------- 预览 ---------------- */
  function fillPreviewSelect() {
    var sel = $('previewChapter');
    sel.textContent = '';
    state.chapters.forEach(function (c, i) {
      if (c.deleted) return;
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = (i + 1) + '. ' + c.title;
      sel.appendChild(o);
    });
    if (sel.options.length) {
      var target = String(state.previewIdx);
      sel.value = sel.querySelector('option[value="' + target + '"]') ? target : sel.options[0].value;
      state.previewIdx = parseInt(sel.value, 10);
    }
  }

  function chapterBody(c) {
    var raw = state.text.slice(c.start, c.end);
    var nl = raw.indexOf('\n');
    var bodyText = nl >= 0 ? raw.slice(nl + 1) : raw;
    return EasyText.toXHTML(bodyText, {
      indent: state.cssOpt.indentEm > 0,
      dropLeadSpace: $('dropLeadSpace').checked
    });
  }

  /* 最终写入 EPUB 的样式：自动生成 + 用户自定义 */
  function finalCSS() {
    var base = EasyEpub.buildCSS(state.cssOpt);
    var custom = (state.customCss || '').trim();
    if (!custom) return base;
    if (state.cssMode === 'replace') return custom + '\n';
    return base + '\n\n/* ===== 自定义样式（追加）===== */\n' + custom + '\n';
  }

  function refreshPreview() {
    var frame = $('previewFrame');
    var c = state.chapters[state.previewIdx];
    if (!c) { frame.srcdoc = '<body style="font-family:sans-serif;color:#999;padding:24px">暂无内容</body>'; return; }

    var css = finalCSS();
    var lv = Math.min(Math.max(c.level, 1), 3);
    var cls = lv === 1 ? 'titlel1std' : (lv === 2 ? 'titlel2std' : 'titlel3std');
    var body = '<h2 class="' + cls + '">' + EasyEpub.escape(c.title) + '</h2>' + chapterBody(c);

    frame.srcdoc = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<style>' + css + ' body{padding: 18px 4px;}</style></head><body>' + body + '</body></html>';
  }

  /* ---------------- 生成 ---------------- */
  function collectChapters() {
    var out = [];
    var pendingStart = null;
    for (var i = 0; i < state.chapters.length; i++) {
      var c = state.chapters[i];

      // 封面页 / 目录页：不作为正文区间，但同样参与 spine 与 nav 排序
      if (c.type !== 'text') {
        if (!c.deleted) out.push({ type: c.type, title: c.title, level: c.level });
        continue;
      }

      if (c.deleted === 'drop') continue;
      if (c.deleted === 'merge') {
        var prev = null;
        for (var k = out.length - 1; k >= 0; k--) {
          if (out[k].type === 'text') { prev = out[k]; break; }
        }
        if (prev) prev.end = c.end;
        else pendingStart = c.start;
        continue;
      }
      out.push({
        type: 'text',
        title: c.title,
        level: c.level,
        start: pendingStart != null ? pendingStart : c.start,
        end: c.end
      });
      pendingStart = null;
    }
    return out;
  }

  function buildHTML(list, onProgress) {
    var res = [];
    var i = 0;
    function step() {
      var stop = Math.min(i + BATCH, list.length);
      for (; i < stop; i++) {
        var c = list[i];
        if (c.type !== 'text') {
          res.push({ type: c.type, title: c.title, level: c.level });
          continue;
        }
        res.push({ type: 'text', title: c.title, level: c.level, html: chapterBody(c) });
      }
      onProgress(i / list.length);
      if (i < list.length) return nextTick().then(step);
      return Promise.resolve();
    }
    return nextTick().then(step).then(function () { return res; });
  }

  function getCover() {
    if (!hasFrontChapter('cover')) return Promise.resolve(null);
    if (state.cover.mode === 'none') return Promise.resolve(null);
    if (state.cover.mode === 'upload') {
      if (!state.cover.uploaded) return Promise.resolve(null);
      return Promise.resolve({
        bytes: state.cover.uploaded.bytes,
        mime: state.cover.uploaded.mime,
        width: state.cover.uploaded.w,
        height: state.cover.uploaded.h
      });
    }
    var g = EasyCover.generate({
      title: state.meta.title || '未命名',
      author: state.meta.author,
      bg: state.cover.bg,
      fg: state.cover.fg
    });
    return EasyCover.toBytes(g.canvas).then(function (bytes) {
      return { bytes: bytes, mime: 'image/jpeg', width: 600, height: 800 };
    });
  }

  function sanitize(s) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
  }

  function outputName() {
    var t = sanitize(state.meta.title) || 'book';
    var a = sanitize(state.meta.author);
    return (state.nameWithAuthor && a ? t + '_' + a : t) + '.epub';
  }

  function updateNamePreview() {
    $('namePreview').textContent = outputName();
  }

  function build() {
    if (!state.chapters.length) return;
    commitEditor();
    var list = collectChapters();
    if (!list.length) { setStatus('没有可输出的章节'); return; }

    $('btnBuild').disabled = true;
    setProgress(0.05);
    setStatus('转换正文…');

    var t0 = performance.now();
    buildHTML(list, function (p) { setProgress(0.05 + p * 0.55); })
      .then(function (items) {
        setStatus('准备封面…');
        setProgress(0.65);
        return getCover().then(function (cover) {
          setStatus('打包 EPUB…');
          setProgress(0.72);
          return EasyEpub.buildEPUB({
            meta: {
              title: state.meta.title || '未命名',
              author: state.meta.author,
              language: state.meta.language,
              subject: state.meta.subject,
              description: state.meta.description,
              publisher: state.meta.publisher
            },
            chapters: items,
            cover: cover,
            cssOpt: state.cssOpt,
            css: finalCSS()
          });
        });
      })
      .then(function (blob) {
        setProgress(1);
        var ms = Math.round(performance.now() - t0);
        var name = outputName();
        download(blob, name);
        setStatus('完成：' + name + ' · ' + fmtBytes(blob.size) + ' · ' + list.length + ' 章 · 耗时 ' + (ms / 1000).toFixed(2) + ' 秒');
        setTimeout(function () { setProgress(null); }, 1200);
        $('btnBuild').disabled = false;
      })
      .catch(function (e) {
        console.error(e);
        setStatus('生成失败：' + e.message);
        setProgress(null);
        $('btnBuild').disabled = false;
      });
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);
  }

  /* ---------------- 表单同步 ---------------- */
  function syncMetaToUI() {
    $('mTitle').value = state.meta.title;
    $('mAuthor').value = state.meta.author;
    $('mLang').value = state.meta.language;
    $('mSubject').value = state.meta.subject;
    $('mDesc').value = state.meta.description;
    $('mPublisher').value = state.meta.publisher;
    syncFrontCheckboxes();
    $('nameWithAuthor').checked = state.nameWithAuthor;
  }

  function bindMeta() {
    $('mTitle').addEventListener('input', function () {
      state.meta.title = this.value; updateCoverPreview(); updateNamePreview();
    });
    $('mAuthor').addEventListener('input', function () {
      state.meta.author = this.value; updateCoverPreview(); updateNamePreview();
    });
    $('mLang').addEventListener('change', function () { state.meta.language = this.value; });
    $('mSubject').addEventListener('input', function () { state.meta.subject = this.value; });
    $('mDesc').addEventListener('input', function () { state.meta.description = this.value; });
    $('mPublisher').addEventListener('input', function () { state.meta.publisher = this.value; });
    $('mIncludeCover').addEventListener('change', function () {
      setFrontChapter('cover', this.checked);
      if (this.checked && state.cover.mode === 'none') {
        // 勾了封面页却还没设封面图，自动切到「书名单色封面」
        var genBtn = document.querySelector('#coverMode button[data-val="gen"]');
        if (genBtn) genBtn.click();
      }
      updateCoverPreview();
    });
    $('mTocPage').addEventListener('change', function () {
      setFrontChapter('toc', this.checked);
    });
    $('nameWithAuthor').addEventListener('change', function () {
      state.nameWithAuthor = this.checked; updateNamePreview();
    });
  }

  function bindSplit() {
    // chips 初始状态
    state.builder.prefixes.forEach(function (v) {
      var b = document.querySelector('#prefixChips .chip[data-v="' + v + '"]');
      if (b) b.classList.add('active');
    });
    state.builder.suffixes.forEach(function (v) {
      var b = document.querySelector('#suffixChips .chip[data-v="' + v + '"]');
      if (b) b.classList.add('active');
    });
    var nb = document.querySelector('#numChips .chip[data-v="' + state.builder.numberMode + '"]');
    if (nb) nb.classList.add('active');

    ['prefixChips', 'suffixChips'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        var c = e.target.closest('.chip');
        if (!c) return;
        c.classList.toggle('active');
        scheduleRulePreview();
      });
    });
    $('numChips').addEventListener('click', function (e) {
      var c = e.target.closest('.chip');
      if (!c) return;
      Array.prototype.forEach.call(this.querySelectorAll('.chip'), function (x) { x.classList.remove('active'); });
      c.classList.add('active');
      scheduleRulePreview();
    });

    $('splitMode').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      var isReg = b.dataset.val === 'regex';
      $('builderWrap').style.display = isReg ? 'none' : '';
      $('fullRegWrap').style.display = isReg ? '' : 'none';
      scheduleRulePreview();
    });

    $('rulePreset').addEventListener('change', function () { applyPreset(this.value); });

    $('fullRegex').addEventListener('input', scheduleRulePreview);
    $('extraKeywords').addEventListener('input', scheduleRulePreview);
    $('filterProse').addEventListener('change', scheduleRulePreview);
    $('levelBySuffix').addEventListener('change', scheduleRulePreview);
    $('emptyMode').addEventListener('change', scheduleRulePreview);

    $('btnResplit').addEventListener('click', function () { resplit(false); });

    $('effectiveReg').textContent = effectiveRegex();
    $('rulePreview').textContent = '导入文件后可预览识别结果';
  }

  function applyPreset(name) {
    function setChips(id, values) {
      Array.prototype.forEach.call(document.querySelectorAll('#' + id + ' .chip'), function (b) {
        b.classList.toggle('active', values.indexOf(b.dataset.v) >= 0);
      });
    }
    function setMode(m) {
      Array.prototype.forEach.call($('splitMode').querySelectorAll('button'), function (b) {
        b.classList.toggle('active', b.dataset.val === m);
      });
      $('builderWrap').style.display = m === 'regex' ? 'none' : '';
      $('fullRegWrap').style.display = m === 'regex' ? '' : 'none';
    }

    if (name === 'cn') {
      setChips('prefixChips', ['第']);
      setChips('suffixChips', ['章', '回']);
      setChips('numChips', ['any']);
      setMode('simple');
    } else if (name === 'vol') {
      setChips('prefixChips', ['第', '卷']);
      setChips('suffixChips', ['章', '回', '卷', '部', '篇']);
      setChips('numChips', ['any']);
      setMode('simple');
    } else if (name === 'en') {
      setChips('prefixChips', ['Chapter']);
      setChips('suffixChips', ['章']);
      setChips('numChips', ['arabic']);
      setMode('simple');
    } else if (name === 'num') {
      setMode('regex');
      $('fullRegex').value = '^[ \\t\\u3000]*[0-9]+[\\.、]\\s*\\S.*$';
    } else {
      setMode('regex');
    }
    scheduleRulePreview();
  }

  function bindLayout() {
    var map = [
      ['rFontSize', 'fontSize', 'vFontSize'],
      ['rLineHeight', 'lineHeight', 'vLineHeight'],
      ['rIndent', 'indentEm', 'vIndent'],
      ['rPara', 'paraMargin', 'vPara']
    ];
    map.forEach(function (m) {
      var el = $(m[0]), label = $(m[2]);
      el.value = state.cssOpt[m[1]];
      label.textContent = state.cssOpt[m[1]];
      el.addEventListener('input', function () {
        var v = parseFloat(this.value);
        state.cssOpt[m[1]] = v;
        label.textContent = v;
        refreshPreview();
      });
    });

    setSegmented('alignMode', state.cssOpt.textAlign, function (v) {
      state.cssOpt.textAlign = v;
      refreshPreview();
    });

    [['nMarginTop', 'marginTop'], ['nMarginBottom', 'marginBottom'],
     ['nMarginLeft', 'marginLeft'], ['nMarginRight', 'marginRight']].forEach(function (m) {
      var el = $(m[0]);
      el.value = state.cssOpt[m[1]];
      el.addEventListener('input', function () {
        state.cssOpt[m[1]] = parseInt(this.value, 10) || 0;
        refreshPreview();
      });
    });

    $('dropLeadSpace').addEventListener('change', refreshPreview);
  }

  /* ---------------- 自定义 CSS ---------------- */
  function updateCssStatus() {
    var st = $('cssStatus');
    var len = (state.customCss || '').trim().length;
    if (!len) {
      st.className = 'css-status';
      st.textContent = '未添加自定义样式';
    } else {
      st.className = 'css-status on';
      st.textContent = (state.cssMode === 'replace' ? '完全替换模式' : '追加覆盖模式') +
        ' · ' + len + ' 字符已启用';
    }
  }

  function bindStyle() {
    var ta = $('customCss');
    var timer = null;
    ta.addEventListener('input', function () {
      state.customCss = this.value;
      updateCssStatus();
      clearTimeout(timer);
      timer = setTimeout(refreshPreview, 300);
    });

    setSegmented('cssMode', state.cssMode, function (v) {
      state.cssMode = v;
      updateCssStatus();
      refreshPreview();
    });

    $('btnLoadCss').addEventListener('click', function () {
      ta.value = EasyEpub.buildCSS(state.cssOpt);
      state.customCss = ta.value;
      updateCssStatus();
      refreshPreview();
      setStatus('已载入当前生成的 CSS，可在此基础上修改');
    });

    $('btnClearCss').addEventListener('click', function () {
      ta.value = '';
      state.customCss = '';
      updateCssStatus();
      refreshPreview();
    });

    $('btnUploadCss').addEventListener('click', function () { $('cssFile').click(); });
    $('cssFile').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        ta.value = String(reader.result || '');
        state.customCss = ta.value;
        updateCssStatus();
        refreshPreview();
        setStatus('已载入样式文件：' + f.name);
      };
      reader.readAsText(f, 'utf-8');
      this.value = '';
    });

    updateCssStatus();
  }

  function bindCover() {
    setSegmented('coverMode', state.cover.mode, function (v) {
      state.cover.mode = v;
      $('genCoverOpts').style.display = v === 'gen' ? '' : 'none';
      $('uploadCoverOpts').style.display = v === 'upload' ? '' : 'none';
      updateCoverPreview();
    });

    $('coverBg').addEventListener('input', function () { state.cover.bg = this.value; updateCoverPreview(); });
    $('coverFg').addEventListener('input', function () { state.cover.fg = this.value; updateCoverPreview(); });

    $('coverFile').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var img = new Image();
      var url = URL.createObjectURL(f);
      img.onload = function () {
        state.cover.uploaded = {
          bytes: null, mime: f.type || 'image/jpeg',
          w: img.naturalWidth, h: img.naturalHeight, url: url
        };
        f.arrayBuffer().then(function (ab) {
          state.cover.uploaded.bytes = new Uint8Array(ab);
          updateCoverPreview();
        });
      };
      img.src = url;
    });

    updateCoverPreview();

    $('previewChapter').addEventListener('change', function () {
      state.previewIdx = parseInt(this.value, 10) || 0;
      refreshPreview();
    });

    setSegmented('previewDevice', 'phone', function (v) {
      var f = $('previewFrame');
      f.className = 'preview-frame ' + v;
    });
  }

  function updateCoverPreview() {
    var box = $('coverPreview');
    box.textContent = '';
    if (state.cover.mode === 'none') {
      var ph = document.createElement('div');
      ph.className = 'cover-ph';
      ph.textContent = '未设置封面';
      box.appendChild(ph);
      return;
    }
    var url;
    if (state.cover.mode === 'upload') {
      if (!state.cover.uploaded) { box.innerHTML = '<div class="cover-ph">请选择图片</div>'; return; }
      url = state.cover.uploaded.url;
    } else {
      var g = EasyCover.generate({
        title: state.meta.title || '未命名',
        author: state.meta.author,
        bg: state.cover.bg, fg: state.cover.fg,
        width: 300, height: 400
      });
      url = g.dataUrl;
    }
    var img = document.createElement('img');
    img.src = url;
    box.appendChild(img);
  }

  /* ---------------- segmented 通用 ---------------- */
  function setSegmented(id, value, onChange) {
    var box = $(id);
    var btns = box.querySelectorAll('button');
    Array.prototype.forEach.call(btns, function (b) {
      b.classList.toggle('active', b.dataset.val === value);
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(btns, function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        onChange(b.dataset.val);
      });
    });
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    listEl = $('chapterList');
    listEl.textContent = '';          // 清掉 HTML 里的静态提示，避免与虚拟列表叠加
    innerEl = document.createElement('div');
    innerEl.className = 'list-inner';
    listEl.appendChild(innerEl);
    renderList();

    bindMeta();
    bindSplit();
    bindLayout();
    bindStyle();
    bindCover();
    bindEditor();

    $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function () {
      importFile(this.files && this.files[0]);
      this.value = '';
    });
    $('btnBuild').addEventListener('click', build);

    $('searchBox').addEventListener('input', function () { renderList(); });
    listEl.addEventListener('scroll', function () {
      if (!listEl._raf) {
        listEl._raf = requestAnimationFrame(function () {
          listEl._raf = null;
          paintRows();
        });
      }
    });

    // 批量操作条
    $('bulkBar').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-bulk]');
      if (!b) return;
      applyBulk(b.dataset.bulk);
    });

    // 键盘
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        var tag = (document.activeElement && document.activeElement.tagName) || '';
        if (/INPUT|TEXTAREA/.test(tag)) return;
        if (!filteredCache || !filteredCache.length) return;
        e.preventDefault();
        clearSelection();
        filteredCache.forEach(function (o) { state.selection[o.i] = true; });
        paintRows(); updateBulkBar();
        setStatus('已全选 ' + selCount() + ' 章');
      }
      if (e.key === 'Escape' && selCount()) {
        clearSelection(); paintRows(); updateBulkBar();
      }
    });

    // tabs
    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (!b) return;
      Array.prototype.forEach.call(this.querySelectorAll('.tab'), function (t) { t.classList.remove('active'); });
      b.classList.add('active');
      Array.prototype.forEach.call(document.querySelectorAll('.tab-pane'), function (p) {
        p.classList.toggle('active', p.dataset.pane === b.dataset.tab);
      });
      if (b.dataset.tab === 'preview') refreshPreview();
    });

    // 拖拽导入：只认「文件」，页面内部拖动（选文字、拖章节等）不触发
    var dz = $('dropzone');
    var dragDepth = 0;
    function hasFiles(e) {
      var dt = e.dataTransfer;
      if (!dt) return false;
      var types = dt.types;
      if (!types) return false;
      for (var i = 0; i < types.length; i++) {
        if (types[i] === 'Files') return true;
      }
      return false;
    }
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      dz.classList.add('on');
    });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth--;
      if (dragDepth <= 0) { dragDepth = 0; dz.classList.remove('on'); }
    });
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      dz.classList.remove('on');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importFile(f);
    });

    updateNamePreview();
    setStatus('就绪 · 拖入或导入 TXT 开始');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* 调试/自动化钩子（不影响正常使用） */
  window.__easypub = {
    state: state,
    importFile: importFile,
    resplit: resplit,
    build: build,
    collectChapters: collectChapters,
    finalCSS: finalCSS,
    outputName: outputName,
    applyBulk: applyBulk,
    selCount: selCount,
    toggleEdit: toggleEdit,
    loadChapterToEditor: loadChapterToEditor,
    commitEditor: commitEditor,
    downloadText: downloadText,
    applyChapterEdit: applyChapterEdit,
    hasFrontChapter: hasFrontChapter,
    setFrontChapter: setFrontChapter,
    moveChapter: moveChapter,
    rebuildText: rebuildText
  };
})();
