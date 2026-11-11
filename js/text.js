/* ============================================================
 * text.js — 编码识别 + 章节解析 + 正文转 XHTML
 * 浏览器与 Node 共用（挂到 EasyText）
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 编码识别 ---------- */
  function detectEncoding(buffer) {
    var b = new Uint8Array(buffer);
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return { enc: 'utf-8', bom: 3 };
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return { enc: 'utf-16le', bom: 2 };
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return { enc: 'utf-16be', bom: 2 };

    // 严格 UTF-8 试解码
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b);
      return { enc: 'utf-8', bom: 0 };
    } catch (e) {
      /* 非 UTF-8 */
    }
    // 回退 GB18030（GBK 超集，覆盖绝大多数中文 txt）
    return { enc: 'gb18030', bom: 0 };
  }

  function decodeBuffer(buffer) {
    var info = detectEncoding(buffer);
    var bytes = new Uint8Array(buffer);
    var slice = info.bom ? bytes.subarray(info.bom) : bytes;
    var text;
    try {
      text = new TextDecoder(info.enc).decode(slice);
    } catch (e) {
      text = new TextDecoder('utf-8').decode(slice);
      info.enc = 'utf-8';
    }
    return { text: text, encoding: info.enc };
  }

  /* ---------- 章节解析配置 ---------- */
  var DEFAULT_RULES = {
    mode: 'simple',                       // simple | regex
    simpleReg: '^[ \\t\\u3000]*(第[0123456789一二三四五六七八九十零〇百千两]*[章回节集]|第[0123456789一二三四五六七八九十零〇百千两]*[卷部]|(Chapter|CHAPTER)\\s+[0-9IVXLC]+).*$',
    extraKeywords: '简介|序言|序曲|后记|尾声|前言|自序|附录|番外|楔子|引子',
    fullRegex: '',
    levelBySuffix: true,                  // 卷/部 → 1 级，章/回 → 2 级
    levelByIndent: false,                 // 按缩进层级
    minChars: 0,                          // 小于该字数的章节标记为可疑（不删除）
    keepBeforeFirst: true,                // 第一章前的内容单独成篇
    filterProse: true,                    // 识别并跳过"像正文的标题行"
    emptyChapterMode: 'page'              // page=卷名单独成页 / skip=不占正文页
  };

  /* 结构化判定层级：只认「第X卷/部」这类形式，避免"变种人部落""外事部门"误判 */
  var RE_L1 = /^[ \t\u3000]*第\s*[0-9一二三四五六七八九十零〇百千两]+\s*[卷部篇]/;
  var RE_L2 = /^[ \t\u3000]*第\s*[0-9一二三四五六七八九十零〇百千两]+\s*[章回节集话]/;
  var RE_L1_EN = /^[ \t\u3000]*(part|book|volume)\b/i;
  var RE_L2_EN = /^[ \t\u3000]*(chapter|section)\b/i;

  /* 标题行不该像一整句话：出现句号/分号、或多个逗号，判为正文 */
  function looksLikeProse(line) {
    if (/[。；]/.test(line)) return true;
    var commas = (line.match(/[，,]/g) || []).length;
    if (commas >= 2) return true;
    if (/[，,]\s*$/.test(line)) return true;
    return false;
  }

  function classifyLevel(title, rules) {
    if (RE_L1.test(title) || RE_L1_EN.test(title)) return 1;
    if (RE_L2.test(title) || RE_L2_EN.test(title)) return 2;
    return 2;
  }

  /**
   * 逐行扫描识别章节，返回章节元数据数组（不含正文）
   * @returns {Array<{title,level,start,end,chars}>}
   */
  function parseChapters(text, rules) {
    rules = Object.assign({}, DEFAULT_RULES, rules || {});
    var matcher;

    if (rules.mode === 'regex' && rules.fullRegex && rules.fullRegex.trim()) {
      try {
        matcher = new RegExp(rules.fullRegex, 'i');
      } catch (e) {
        matcher = null;
      }
    }
    if (!matcher) {
      try {
        matcher = new RegExp(rules.simpleReg, 'i');
      } catch (e) {
        matcher = /^[ \t\u3000]*第[0123456789一二三四五六七八九十零〇百千两]*[章回节集卷部].*$/i;
      }
    }
    var extra = null;
    if (rules.extraKeywords && rules.extraKeywords.trim()) {
      try {
        extra = new RegExp('^[ \\t\\u3000]*(' + rules.extraKeywords + ').{0,30}$');
      } catch (e) {
        extra = null;
      }
    }

    var marks = [];
    var pos = 0;
    var len = text.length;

    while (pos < len) {
      var nl = text.indexOf('\n', pos);
      if (nl === -1) nl = len;
      var line = text.slice(pos, nl);
      // 去掉行尾 \r
      if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);

      var lineLen = line.length;
      if (lineLen > 0 && lineLen <= 80) {   // 标题不该太长，过滤掉超长行
        var kind = null;
        if (matcher.test(line)) kind = 'main';
        else if (extra && extra.test(line)) kind = 'extra';

        if (kind) {
          /* 信号强度：「第X章/回」与关键词是强信号，直接认；
             「第X部/卷」是弱信号，正文里"第一部分首先揭示了…"极易误命中，需额外收紧 */
          var strong = kind === 'extra' || RE_L2.test(line) || RE_L2_EN.test(line) ||
            /^[ \t\u3000]*第\s*[0-9一二三四五六七八九十零〇百千两]+\s*[章回节集话]/.test(line);
          if (!strong) {
            if (rules.filterProse && looksLikeProse(line)) kind = null;
            else if (line.trim().length > 25) kind = null;   // 卷名不会太长
          }
        }
        if (kind) {
          marks.push({ start: pos, title: line.trim().replace(/^[\u3000\s]+|[\u3000\s]+$/g, ''), rawIndent: indentWidth(line) });
        }
      }
      pos = nl + 1;
    }

    // 构造章节区间
    var chapters = [];
    if (rules.keepBeforeFirst && marks.length && marks[0].start > 0) {
      var head = text.slice(0, marks[0].start);
      if (head.trim()) {
        // 第一个真章节之前的内容（书名/作者/简介）单独成篇。
        // 网文语境里这就是「内容简介」页，fixedTitle 让编辑器不再拿正文首行覆盖它
        chapters.push({
          title: '内容简介',
          level: 1,
          start: 0,
          end: marks[0].start,
          chars: head.trim().length,
          fixedTitle: true
        });
      }
    }

    for (var i = 0; i < marks.length; i++) {
      var start = marks[i].start;
      var end = i + 1 < marks.length ? marks[i + 1].start : len;
      var level;
      if (rules.levelByIndent) {
        level = Math.min(1 + Math.floor(marks[i].rawIndent / 2), 4);
      } else if (rules.levelBySuffix) {
        level = classifyLevel(marks[i].title, rules);
      } else {
        level = 2;
      }
      chapters.push({
        title: marks[i].title,
        level: level,
        start: start,
        end: end,
        chars: text.slice(start, end).trim().length
      });
    }

    // 纯卷名（几乎无正文）处理
    if (rules.emptyChapterMode === 'skip') {
      chapters = chapters.filter(function (c) { return c.chars > 20 || c.level !== 1; });
    }
    return chapters;
  }

  function indentWidth(line) {
    var w = 0;
    for (var i = 0; i < line.length; i++) {
      var c = line.charCodeAt(i);
      if (c === 0x3000) w += 2;
      else if (c === 32) w += 1;
      else if (c === 9) w += 4;
      else break;
    }
    return w;
  }

  /* ---------- 正文转 XHTML ---------- */
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * @param {string} body 章节原文（含标题行）
   * @param {object} opt { indent, dropLeadSpace, rawTag, titleAsHeading }
   */
  function toXHTML(body, opt) {
    opt = opt || {};
    var indent = opt.indent !== false;
    var dropLead = opt.dropLeadSpace !== false;
    var rawTag = (opt.rawTag || '').trim();

    var lines = body.split(/\r\n|\n|\r/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) continue;                       // 空行交由 CSS 段距控制
      var s = dropLead ? line.replace(/^[\u3000 \t]+/, '') : line;
      if (!s) continue;
      if (rawTag && s.indexOf(rawTag) === 0) {          // 原始 HTML 直插（插图等）
        out.push(s.slice(rawTag.length));
        continue;
      }
      out.push('<p' + (indent ? ' class="a"' : '') + '>' + escapeHtml(s) + '</p>');
    }
    return out.join('\n');
  }

  global.EasyText = {
    detectEncoding: detectEncoding,
    decodeBuffer: decodeBuffer,
    parseChapters: parseChapters,
    toXHTML: toXHTML,
    escapeHtml: escapeHtml,
    DEFAULT_RULES: DEFAULT_RULES
  };
})(typeof self !== 'undefined' ? self : this);
