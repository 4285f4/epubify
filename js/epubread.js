/* ============================================================
 * epubread.js — 把 EPUB 提炼成「纯文本 + 层级标题」
 *
 * 设计目标：只取文字，丢弃样式、插图、内嵌字体。
 * 输出 blocks（每块带 level）交给现有 TXT 流程重新生成，
 * 因此产物风格与直接导入 TXT 完全一致。
 * ============================================================ */
(function (global) {
  'use strict';

  var BLOCK_SEL = 'h1, h2, h3, h4, p';

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/[\u00a0\u3000]/g, ' ')   // 全角空格与 nbsp 统一成半角
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 规范化包内路径：base 为所在目录，href 可能含 ../ 或 #fragment */
  function resolvePath(base, href) {
    href = String(href || '').split('#')[0];
    try { href = decodeURIComponent(href); } catch (e) { /* 保留原样 */ }
    var raw = (base ? base.replace(/\/?$/, '/') : '') + href;
    var parts = raw.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    return out.join('/');
  }

  function dirOf(path) {
    var i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i + 1);
  }

  /** 按 localName 取元素，兼容带命名空间前缀的 OPF */
  function byLocal(root, name) {
    var out = [];
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].localName === name) out.push(all[i]);
    }
    return out;
  }

  function parseXML(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      // 个别 EPUB 的 XML 不严格，退回 HTML 解析再取元素
      doc = new DOMParser().parseFromString(text, 'text/html');
    }
    return doc;
  }

  /**
   * 从单个 XHTML 提取文本块
   * 注意 h2 里可能嵌套 div/p（精排版式），只取最外层的块级元素
   */
  function extractBlocks(htmlText) {
    var doc = new DOMParser().parseFromString(htmlText, 'text/html');
    var body = doc.body;
    if (!body) return [];

    var docTitle = '';
    var t = doc.getElementsByTagName('title')[0];
    if (t) docTitle = clean(t.textContent);

    var els = body.querySelectorAll(BLOCK_SEL);
    var blocks = [];

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      // 跳过被其他块级元素包含的嵌套块（如 h2 > div > p）
      var outer = el.closest(BLOCK_SEL);
      if (outer && outer !== el) continue;
      // 隐藏元素（如 <h1 style="display:none">）不取
      if (el.getAttribute('style') && /display\s*:\s*none/i.test(el.getAttribute('style'))) continue;

      var text = clean(el.textContent);
      if (!text) {
        // 精排常见：<h1 title="第一卷 《黄雀》"></h1>，文字在属性里
        var attr = el.getAttribute('title');
        if (attr) text = clean(attr);
      }
      if (!text && /^H[1-4]$/.test(el.tagName) && docTitle) text = docTitle;
      if (!text) continue;

      var lv = 0;
      if (el.tagName === 'H1') lv = 1;
      else if (el.tagName === 'H2') lv = 2;
      else if (el.tagName === 'H3' || el.tagName === 'H4') lv = 3;

      // 同名标题连续出现时去重（部分书 h1 与内部 div 都会命中）
      // 仅对标题生效：正文里连续出现相同的短句（如两个「……」）是正常内容，不能删
      var last = blocks[blocks.length - 1];
      if (lv > 0 && last && last.level === lv && last.text === text) continue;

      blocks.push({ level: lv, text: text });
    }
    return blocks;
  }

  function mimeOf(path) {
    if (/\.png$/i.test(path)) return 'image/png';
    if (/\.gif$/i.test(path)) return 'image/gif';
    if (/\.webp$/i.test(path)) return 'image/webp';
    if (/\.svg$/i.test(path)) return 'image/svg+xml';
    return 'image/jpeg';
  }

  /**
   * 解析 EPUB
   * @returns {Promise<{title,author,cover,blocks,stats}>}
   */
  async function read(arrayBuffer, onProgress) {
    var zip = global.EasyUnzip.open(arrayBuffer);
    var progress = onProgress || function () {};

    /* --- 1. container.xml 定位 OPF --- */
    var opfPath = '';
    if (zip.has('META-INF/container.xml')) {
      var cont = parseXML(await zip.readText('META-INF/container.xml'));
      var rf = byLocal(cont, 'rootfile')[0];
      if (rf) opfPath = rf.getAttribute('full-path') || '';
    }
    if (!opfPath) {
      // 兜底：随便找一个 .opf
      opfPath = zip.names().filter(function (n) { return /\.opf$/i.test(n); })[0] || '';
    }
    if (!opfPath) throw new Error('包里没有找到 OPF 文件，可能不是标准 EPUB');

    var opfDir = dirOf(opfPath);
    var opf = parseXML(await zip.readText(opfPath));

    /* --- 2. 元数据 --- */
    function metaOf(tag) {
      var el = byLocal(opf, tag)[0];
      return el ? clean(el.textContent) : '';
    }
    var title = metaOf('title');
    var author = metaOf('creator');
    var language = metaOf('language');

    /* --- 3. manifest / spine --- */
    var manifest = {};
    var items = byLocal(opf, 'item');
    items.forEach(function (el) {
      manifest[el.getAttribute('id')] = {
        id: el.getAttribute('id'),
        href: el.getAttribute('href'),
        type: el.getAttribute('media-type') || '',
        properties: el.getAttribute('properties') || ''
      };
    });

    var spineEl = byLocal(opf, 'spine')[0];
    var spine = [];
    if (spineEl) {
      byLocal(spineEl, 'itemref').forEach(function (el) {
        var it = manifest[el.getAttribute('idref')];
        if (it) spine.push(it);
      });
    }
    if (!spine.length) throw new Error('EPUB 的 spine 为空，无法确定阅读顺序');

    /* --- 4. 封面图 --- */
    var coverMeta = '';
    byLocal(opf, 'meta').forEach(function (m) {
      if ((m.getAttribute('name') || '') === 'cover') coverMeta = m.getAttribute('content') || '';
    });

    var coverItem = null;
    items.forEach(function (el) {
      if ((el.getAttribute('properties') || '').indexOf('cover-image') >= 0) {
        coverItem = manifest[el.getAttribute('id')];
      }
    });
    if (!coverItem && coverMeta && manifest[coverMeta]) coverItem = manifest[coverMeta];

    var coverHref = '';
    if (coverItem) {
      coverHref = resolvePath(opfDir, coverItem.href);
    } else {
      // 退回：spine 前几页里第一张图
      for (var ci = 0; ci < Math.min(4, spine.length); ci++) {
        if (!/xhtml|html/i.test(spine[ci].type || '')) continue;
        try {
          var h = await zip.readText(resolvePath(opfDir, spine[ci].href));
          var m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(h);
          if (m) { coverHref = resolvePath(dirOf(resolvePath(opfDir, spine[ci].href)), m[1]); break; }
        } catch (e) { /* 跳过读不出的页 */ }
      }
    }

    var cover = null;
    if (coverHref && zip.has(coverHref)) {
      try {
        cover = { bytes: await zip.read(coverHref), mime: mimeOf(coverHref), name: coverHref.split('/').pop() };
      } catch (e) { cover = null; }
    }

    /* --- 5. 逐页提取文本 --- */
    var blocks = [];
    var stats = { files: 0, empty: 0, volumes: 0, chapters: 0 };

    for (var si = 0; si < spine.length; si++) {
      var it = spine[si];
      if (it.type && !/xhtml|html/i.test(it.type)) continue;   // 跳过图片类条目
      var pagePath = resolvePath(opfDir, it.href);
      var html = '';
      try {
        html = await zip.readText(pagePath);
      } catch (e) {
        stats.empty++;
        continue;
      }
      var bs = extractBlocks(html);
      stats.files++;
      if (!bs.length) { stats.empty++; continue; }

      for (var bi = 0; bi < bs.length; bi++) {
        if (bs[bi].level === 1) stats.volumes++;
        else if (bs[bi].level === 2) stats.chapters++;
        blocks.push(bs[bi]);
      }

      if (si % 25 === 0) progress(si / spine.length);
      // 让出主线程，避免大书解析时页面卡死
      if (si % 10 === 9) await new Promise(function (r) { setTimeout(r, 0); });
    }

    progress(1);

    return {
      title: title,
      author: author,
      language: language,
      cover: cover,
      blocks: blocks,
      stats: stats
    };
  }

  /** blocks → 供现有分章流程使用的纯文本（段落间空行） */
  function toText(blocks) {
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      out.push(blocks[i].text);
    }
    return out.join('\n\n');
  }

  global.EasyEpubRead = {
    read: read,
    toText: toText,
    extractBlocks: extractBlocks   // 暴露给测试
  };
})(typeof self !== 'undefined' ? self : this);
