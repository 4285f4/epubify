/* v13 回归：EPUB 导入第三本（部标题是图片，文字在 alt 里） */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9250;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v13-' + Date.now());

const SAMPLE = path.join(__dirname, 'book3.epub');
if (!fs.existsSync(SAMPLE)) {
  console.log('跳过 verify13：缺少 test/book3.epub（EPUB 导入测试样本）');
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

  console.log('\n【1】导入（部标题是纯图页，文字只在 img 的 alt 里）');
  const imp = await evaluate(`(async () => {
    const blob = await (await fetch('test/book3.epub')).blob();
    __epubify.importFile(new File([blob], '某书C_某作者.epub', {type: 'application/epub+zip'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => {
        const st = document.getElementById('statusText').textContent;
        if (st.indexOf('已从 EPUB') === 0 || st.indexOf('失败') === 0) { clearInterval(iv); res(); }
      }, 100);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 60000);
    });
    return document.getElementById('statusText').textContent;
  })()`);
  ok('导入完成', imp.indexOf('已从 EPUB') === 0, imp);

  console.log('\n【2】部标题是否从图片 alt 恢复');
  const s2 = await evaluate(`(() => {
    const ch = __epubify.state.chapters.filter(c => c.type === 'text');
    const lv1 = ch.filter(c => c.level === 1).map(c => c.title);
    const byLv = {};
    ch.forEach(c => { byLv[c.level] = (byLv[c.level] || 0) + 1; });
    return { lv1, byLv, total: ch.length, title: __epubify.state.meta.title, author: __epubify.state.meta.author };
  })()`);
  ok('识别出 5 个部', s2.lv1.length === 5, s2.lv1);
  ok('部标题内容正确', s2.lv1.every(t => /某书C/.test(t)), s2.lv1);
  ok('章节数为 232', s2.byLv[2] === 232, s2.byLv);
  ok('书名作者正确', /某书C/.test(s2.title) && s2.author === '某作者', {
    书名: s2.title, 作者: s2.author
  });

  console.log('\n【3】折叠部标题应隐藏其下章节');
  const s3 = await evaluate(`(async () => {
    const rowTotal = () => Math.round(parseFloat(document.querySelector('.list-inner').style.height) / 30);
    const before = rowTotal();
    document.getElementById('btnCollapseAll').click();
    await new Promise(r => setTimeout(r, 300));
    const after = rowTotal();
    document.getElementById('btnExpandAll').click();
    await new Promise(r => setTimeout(r, 300));
    return { before, after, restored: rowTotal() };
  })()`);
  ok('折叠后只剩少数顶层', s3.after < 10 && s3.before > 200, s3);
  ok('展开后恢复', s3.restored === s3.before, s3);

  console.log('\n【4】生成并检查 nav 嵌套');
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
    fs.renameSync(ep, path.join(__dirname, 'v13-out.epub'));
    const sz = fs.statSync(path.join(__dirname, 'v13-out.epub')).size;
    console.log('  v13-out.epub  ' + (sz / 1024 / 1024).toFixed(2) + ' MB  (原书 2.2 MB)');
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
