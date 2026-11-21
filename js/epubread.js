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
   * 取元素的纯文本
   * <br> 会被当作空格：如 <h3><span>第17章</span><br/>计划</h3>
   * 直接取 textContent 会粘成「第17章计划」
   */
  function textOf(el) {
    var brs = el.getElementsByTagName('br');
    if (!brs.length) return clean(el.textContent);
    var clone = el.cloneNode(true);
    var list = clone.getElementsByTagName('br');
    for (var i = list.length - 1; i >= 0; i--) {
      var br = list[i];
      if (br.parentNode) br.parentNode.replaceChild(document.createTextNode(' '), br);
    }
    return clean(clone.textContent);
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

      var text = textOf(el);
      if (!text) {
        // 精排常见：<h1 title="第一卷 《黄雀》"></h1>，文字在属性里
        var attr = el.getAttribute('title');
        if (attr) text = clean(attr);
      }
      if (!text && /^H[1-4]$/.test(el.tagName) && docTitle) text = docTitle;
      if (!text) continue;

      var isHeading = /^H[1-4]$/.test(el.tagName);

      // 同名标题连续出现时去重（部分书 h1 与内部 div 都会命中）
      // 仅对标题生效：正文里连续出现相同的短句（如两个「……」）是正常内容，不能删
      var last = blocks[blocks.length - 1];
      if (isHeading && last && last.tag && last.tag === el.tagName && last.text === text) continue;

      blocks.push({
        level: isHeading ? 1 : 0,       // 先占位，稍后按实际用到的标签归一化
        tag: isHeading ? el.tagName : '',
        text: text
      });
    }
    return blocks;
  }

  /**
   * 从标题文字判断层级。
   * 不能只看标签：有的书 h1 是书名页、h3 才是章节，按标签分配会把
   * 几百章全部挂到书名页下面。
   */
  function levelFromTitle(text) {
    var t = String(text || '').trim();
    if (!t) return 0;
    // 明确的分卷标题：第 X 卷 / 部 / 篇
    if (/第\s*[一二三四五六七八九十百千零〇0-9]+\s*[卷部篇]/.test(t)) return 1;
    // 短标题以「卷」结尾，如「番外卷」
    if (t.length <= 8 && /卷$/.test(t)) return 1;
    // 章 / 回 / 节
    if (/第\s*[一二三四五六七八九十百千零〇0-9]+\s*[章回节]/.test(t)) return 2;
    // 常见独立篇目
    if (/^(序|序言|序章|引子|楔子|前言|后记|尾声|尾聲|终章|番外|附录|致谢)/.test(t)) return 2;
    return 0;                     // 无法判断，交给默认值
  }

  /**
   * 层级归一化：以标题内容为主，标签只作兜底。
   * 若判为「卷」的条目占比过半，说明规则误判，全部退回章节级。
   */
  function normalizeLevels(blocks) {
    var vols = 0;
    var total = 0;

    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b.tag) continue;
      var lv = levelFromTitle(b.text);
      b.level = lv || 2;          // 判断不出的一律当普通章节
      total++;
      if (b.level === 1) vols++;
    }

    if (total && vols > total * 0.5) {
      for (var j = 0; j < blocks.length; j++) {
        if (blocks[j].tag) blocks[j].level = 2;
      }
    }
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
        blocks.push(bs[bi]);
      }

      if (si % 25 === 0) progress(si / spine.length);
      // 让出主线程，避免大书解析时页面卡死
      if (si % 10 === 9) await new Promise(function (r) { setTimeout(r, 0); });
    }

    // 全书提取完毕后再归一化层级（需要统计全局用到哪些标题标签）
    normalizeLevels(blocks);
    stats.volumes = 0;
    stats.chapters = 0;
    for (var bi2 = 0; bi2 < blocks.length; bi2++) {
      if (blocks[bi2].level === 1) stats.volumes++;
      else if (blocks[bi2].level === 2) stats.chapters++;
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
