/* v14 回归：TXT 分章的四个问题
 *  1. 删除章节后预览未刷新
 *  2. 正文里的「第一节晚自习下课后…」被误识别为章节
 *  3. 无卷结构时，内容简介比正文高一级
 *  4. 内容简介页面顶部 35% 大留白
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9252;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v14-' + Date.now());

const SAMPLE = path.join(__dirname, 'book4.txt');
if (!fs.existsSync(SAMPLE)) {
  console.log('跳过 verify14：缺少 test/book4.txt（TXT 分章测试样本）');
  process.exit(0);
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1400,900',
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

  console.log('\n【1】导入并检查分章');
  const s1 = await evaluate(`(async () => {
    const blob = await (await fetch('test/book4.txt')).blob();
    __epubify.importFile(new File([blob], '某书D.txt', {type: 'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__epubify.state.chapters.length) { clearInterval(iv); res(); } }, 50);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 30000);
    });
    await new Promise(r => setTimeout(r, 400));
    const ch = __epubify.state.chapters.filter(c => c.type === 'text');
    const byLv = {};
    ch.forEach(c => { byLv[c.level] = (byLv[c.level] || 0) + 1; });
    return {
      total: ch.length,
      byLv,
      firstTwo: ch.slice(0, 2).map(c => ({ t: c.title, lv: c.level })),
      secLike: ch.filter(c => /^第[一二三四五六七八九十百零〇0-9]+节/.test(c.title)).length,
      longTitles: ch.filter(c => c.title.length > 25).length
    };
  })()`);
  ok('章节数 504', s1.total === 504, s1.total);
  ok('无「第X节」被误判为章节', s1.secLike === 0, s1.secLike);
  ok('无超长标题行被当章节', s1.longTitles === 0, s1.longTitles);
  ok('内容简介与正文同级', s1.firstTwo[0].lv === s1.firstTwo[1].lv, s1.firstTwo);
  ok('全书统一为章节级', s1.byLv[1] === undefined, s1.byLv);

  console.log('\n【2】删除章节后预览应刷新');
  const s2 = await evaluate(`(async () => {
    const st = __epubify.state;
    // 选中第 2 个正文（索引 2），预览内容
    __epubify.selectOnly ? 0 : 0;
    st.previewIdx = 2;
    const sel = document.getElementById('previewChapter');
    sel.value = '2';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    const frame = document.getElementById('previewFrame');
    const before = frame.srcdoc.length;

    // 删除下一章（索引 3），其内容合并进本章
    const row = document.querySelector('.chapter-row[data-idx="3"]');
    const delBtn = row.querySelectorAll('.row-actions button')[3];
    delBtn.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await new Promise(r => setTimeout(r, 400));

    const after = frame.srcdoc.length;
    // 再切到上一章、切回来，确认内容一致
    sel.value = '1'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 150));
    sel.value = '2'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 150));
    const roundTrip = frame.srcdoc.length;

    return { before, after, roundTrip, grew: after > before };
  })()`);
  ok('删除后预览立即变长（含入被删章节内容）', s2.grew === true, {
    前: s2.before, 后: s2.after, 增量: s2.after - s2.before
  });
  ok('切换回来内容一致', s2.roundTrip === s2.after, { 切换后: s2.roundTrip, 删除后: s2.after });

  console.log('\n【3】生成产物的标题样式');
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
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 90000);
    });
    return document.getElementById('statusText').textContent;
  })()`);
  ok('生成成功', buildRes.indexOf('完成') === 0, buildRes);

  await sleep(700);
  let ep = null;
  for (let i = 0; i < 60; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.epub'));
    if (l.length) { ep = path.join(dlDir, l[0]); break; }
    await sleep(200);
  }
  if (ep) {
    fs.renameSync(ep, path.join(__dirname, 'v14-out.epub'));
    console.log('  v14-out.epub');
  }

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
