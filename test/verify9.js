/* v9 回归：封面格式规范化 + 章节树折叠 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9240;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v9-' + Date.now());

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1500,940',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : ''));
}

(async () => {
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pg = list.find(t => t.type === 'page');
      if (pg) { wsUrl = pg.webSocketDebuggerUrl; break; }
    } catch (e) {}
    await sleep(250);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  };
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(1300);

  console.log('\n【1】导入带卷层级的样本');
  await evaluate(`(async () => {
    const blob = await (await fetch('test/sample.txt')).blob();
    __epubify.importFile(new File([blob], '甲书.txt', {type:'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__epubify.state.chapters.length) { clearInterval(iv); res(); } }, 40);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 30000);
    });
    await new Promise(r => setTimeout(r, 400));
  })()`);
  const s1 = await evaluate(`(() => {
    const s = __epubify.state;
    const withKids = [];
    s.childCounts.forEach((n, i) => { if (n > 0) withKids.push({ i: i, title: s.chapters[i].title, kids: n }); });
    return { total: s.chapters.length, withKids: withKids.slice(0, 5), kidCount: withKids.length };
  })()`);
  ok('存在含下级的条目', s1.kidCount > 0, s1);

  console.log('\n【2】折叠单个卷');
  const s2 = await evaluate(`(async () => {
    const s = __epubify.state;
    const idx = s.childCounts.findIndex(n => n > 0);
    const rowTotal = () => Math.round(parseFloat(document.querySelector('.list-inner').style.height) / 30);
    const before = rowTotal();
    const kidsBefore = s.childCounts[idx];
    // 点击该行的折叠三角
    const row = document.querySelector('.chapter-row[data-idx="' + idx + '"]');
    const tog = row.querySelector('.toggle');
    const hasKidsClass = tog.classList.contains('has-kids');
    tog.dispatchEvent(new MouseEvent('click', {bubbles:true}));
    await new Promise(r => setTimeout(r, 250));
    const after = Math.round(parseFloat(document.querySelector('.list-inner').style.height) / 30);
    return {
      idx, kidsBefore, hasKidsClass,
      visibleBefore: before, visibleAfter: after,
      collapsed: !!s.collapsed[s.chapters[idx].id],
      toggleText: document.querySelector('.chapter-row[data-idx="' + idx + '"] .toggle').textContent
    };
  })()`);
  ok('折叠三角仅对有下级的行显示', s2.hasKidsClass === true, s2);
  ok('折叠后隐藏了下级', s2.visibleAfter < s2.visibleBefore, {
    前: s2.visibleBefore, 后: s2.visibleAfter, 下级数: s2.kidsBefore
  });
  ok('三角变为 ▸', s2.toggleText === '▸', s2.toggleText);

  console.log('\n【3】展开恢复');
  const s3 = await evaluate(`(async () => {
    const row = document.querySelector('.chapter-row[data-idx="${s2.idx}"]');
    row.querySelector('.toggle').dispatchEvent(new MouseEvent('click', {bubbles:true}));
    await new Promise(r => setTimeout(r, 250));
    const inner = document.querySelector('.list-inner');
    return {
      visible: Math.round(parseFloat(inner.style.height) / 30),
      collapsed: Object.keys(__epubify.state.collapsed).length
    };
  })()`);
  ok('展开后行数恢复', s3.visible === s2.visibleBefore, s3);
  ok('折叠记录已清除', s3.collapsed === 0, s3.collapsed);

  console.log('\n【4】全部折叠 / 全部展开');
  const s4 = await evaluate(`(async () => {
    document.getElementById('btnCollapseAll').click();
    await new Promise(r => setTimeout(r, 250));
    const rt = () => Math.round(parseFloat(document.querySelector('.list-inner').style.height) / 30);
    const collapsedRows = rt();
    const n = Object.keys(__epubify.state.collapsed).length;
    document.getElementById('btnExpandAll').click();
    await new Promise(r => setTimeout(r, 250));
    return { collapsedRows, collapsedCount: n, expandedRows: rt() };
  })()`);
  ok('全部折叠生效', s4.collapsedCount > 0 && s4.collapsedRows < s1.total, s4);
  ok('全部展开恢复完整', s4.expandedRows > s4.collapsedRows, s4);

  console.log('\n【5】搜索时忽略折叠');
  const s5 = await evaluate(`(async () => {
    document.getElementById('btnCollapseAll').click();
    await new Promise(r => setTimeout(r, 200));
    const box = document.getElementById('searchBox');
    box.value = '第一章';
    box.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 250));
    const hits = document.querySelectorAll('.chapter-row').length;
    box.value = '';
    box.dispatchEvent(new Event('input'));
    document.getElementById('btnExpandAll').click();
    await new Promise(r => setTimeout(r, 200));
    return { hits };
  })()`);
  ok('折叠状态下仍能搜到被隐藏的章', s5.hits > 0, s5);

  console.log('\n【6】WebP 封面转码为 JPEG');
  const s6 = await evaluate(`(async () => {
    // 用 canvas 现场生成一张 WebP
    const c = document.createElement('canvas');
    c.width = 300; c.height = 400;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3366cc'; ctx.fillRect(0, 0, 300, 400);
    ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif'; ctx.fillText('TEST', 90, 200);
    const blob = await new Promise(res => c.toBlob(res, 'image/webp', 0.9));
    const file = new File([blob], 'cover.webp', { type: 'image/webp' });

    // 选择「上传图片」并塞进 file input
    document.querySelector('#coverMode button[data-val="upload"]').click();
    const inp = document.getElementById('coverFile');
    const dt = new DataTransfer();
    dt.items.add(file);
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change'));

    await new Promise(r => setTimeout(r, 1200));

    const up = __epubify.state.cover.uploaded;
    if (!up || !up.bytes) return { ok: false };
    const head = Array.from(up.bytes.slice(0, 3)).map(b => b.toString(16).toUpperCase().padStart(2, '0'));
    return {
      ok: true,
      sourceType: file.type,
      finalMime: up.mime,
      head: head.join(' '),
      isJpeg: head[0] === 'FF' && head[1] === 'D8' && head[2] === 'FF',
      bytes: up.bytes.length,
      w: up.w, h: up.h,
      status: document.getElementById('statusText').textContent
    };
  })()`);
  ok('WebP 已被转码', s6.ok === true && s6.finalMime === 'image/jpeg', s6);
  ok('字节确为 JPEG（FF D8 FF）', s6.isJpeg === true, s6.head);
  ok('转码提示已给出', /转为 JPEG/.test(s6.status || ''), s6.status);

  console.log('\n【7】勾选封面页后生成');
  const s6b = await evaluate(`(async () => {
    const cb = document.getElementById('mIncludeCover');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    const ch = __epubify.state.chapters;
    return { first: ch[0] && ch[0].title, type: ch[0] && ch[0].type, mode: __epubify.state.cover.mode };
  })()`);
  ok('封面页章节已插入', s6b.type === 'cover', s6b);
  ok('封面模式仍为上传', s6b.mode === 'upload', s6b.mode);

  const dlDir = path.join(__dirname, 'dl');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  const buildRes = await evaluate(`(async () => {
    __epubify.build();
    await new Promise((res, rej) => {
      const iv = setInterval(() => {
        const t = document.getElementById('statusText').textContent;
        if (t.indexOf('完成') === 0 || t.indexOf('失败') === 0) { clearInterval(iv); res(); }
      }, 100);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 60000);
    });
    return document.getElementById('statusText').textContent;
  })()`);
  ok('生成成功', buildRes.indexOf('完成') === 0, buildRes);

  await sleep(600);
  let ep = null;
  for (let i = 0; i < 50; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.epub'));
    if (l.length) { ep = path.join(dlDir, l[0]); break; }
    await sleep(200);
  }
  if (ep) { fs.renameSync(ep, path.join(__dirname, 'v9-out.epub')); console.log('  v9-out.epub'); }

  console.log('\n=== 汇总 ===');
  const pass = results.filter(r => r.pass).length;
  console.log(`${pass}/${results.length} 通过`);
  if (errors.length) {
    console.log('控制台错误:');
    errors.slice(0, 6).forEach(e => console.log('  ✗', String(e).slice(0, 200)));
  } else console.log('无控制台错误');

  ws.close(); chrome.kill();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('测试异常:', e.message); chrome.kill(); process.exit(1); });
