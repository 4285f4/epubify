/* v8 回归：前置页作为章节 + 拖动排序 + nav 完整性 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9238;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v8-' + Date.now());

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

  console.log('\n【1】导入样本');
  await evaluate(`(async () => {
    const blob = await (await fetch('test/bookB.txt')).blob();
    __easypub.importFile(new File([blob], '乙书.txt', {type:'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__easypub.state.chapters.length) { clearInterval(iv); res(); } }, 40);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 20000);
    });
    await new Promise(r => setTimeout(r, 300));
  })()`);
  const s1 = await evaluate(`({
    total: __easypub.state.chapters.length,
    first: __easypub.state.chapters[0].title,
    firstType: __easypub.state.chapters[0].type,
    hasCover: __easypub.hasFrontChapter('cover'),
    hasToc: __easypub.hasFrontChapter('toc')
  })`);
  ok('首章为「内容简介」', s1.first === '内容简介' && s1.firstType === 'text', s1);
  ok('默认无封面页/目录页', s1.hasCover === false && s1.hasToc === false);
  ok('总章数 21', s1.total === 21, s1.total);

  console.log('\n【2】勾选封面页');
  const s2 = await evaluate(`(async () => {
    const cb = document.getElementById('mIncludeCover');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 350));
    const ch = __easypub.state.chapters;
    return {
      total: ch.length,
      first: ch[0].title, firstType: ch[0].type,
      second: ch[1].title,
      coverMode: __easypub.state.cover.mode,
      rows: document.querySelectorAll('.chapter-row').length
    };
  })()`);
  ok('封面页成为第 1 个章节', s2.first === '封面' && s2.firstType === 'cover', s2);
  ok('自动启用书名单色封面', s2.coverMode === 'gen', s2.coverMode);
  ok('内容简介顺延到第 2', s2.second === '内容简介', s2.second);

  console.log('\n【3】勾选目录页');
  const s3 = await evaluate(`(async () => {
    const cb = document.getElementById('mTocPage');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    const ch = __easypub.state.chapters;
    return {
      total: ch.length,
      types: ch.slice(0, 4).map(c => c.type),
      titles: ch.slice(0, 4).map(c => c.title)
    };
  })()`);
  ok('顺序为 封面→目录→内容简介', s3.types.slice(0, 3).join(',') === 'cover,toc,text', s3);

  console.log('\n【4】拖动调整顺序（目录到最前）');
  const s4 = await evaluate(`(async () => {
    __easypub.moveChapter(1, 0);
    await new Promise(r => setTimeout(r, 200));
    const ch = __easypub.state.chapters;
    return {
      types: ch.slice(0, 3).map(c => c.type),
      titles: ch.slice(0, 3).map(c => c.title),
      textIntact: ch.filter(c => c.type === 'text').length
    };
  })()`);
  ok('目录页移到最前', s4.types.join(',') === 'toc,cover,text', s4);
  ok('正文章节数量未变', s4.textIntact === 21, s4.textIntact);

  console.log('\n【5】改前置页名称');
  const s5 = await evaluate(`(async () => {
    const row = document.querySelector('.chapter-row[data-idx="0"]');
    row.querySelector('.title').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
    await new Promise(r => setTimeout(r, 120));
    const inp = document.querySelector('.chapter-row input');
    if (!inp) return { hasInput: false };
    inp.value = '目次';
    inp.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    await new Promise(r => setTimeout(r, 220));
    return {
      hasInput: true,
      title: __easypub.state.chapters[0].title,
      inputClosed: !document.querySelector('.chapter-row input')
    };
  })()`);
  ok('前置页可双击改名', s5.hasInput === true && s5.title === '目次' && s5.inputClosed === true, s5);

  console.log('\n【6】真实鼠标拖动');
  const before = await evaluate(`__easypub.state.chapters.map(c => c.type + ':' + c.title)`);
  const s6 = await evaluate(`(() => {
    const rows = document.querySelectorAll('.chapter-row');
    const a = rows[0].getBoundingClientRect();
    const b = rows[2].getBoundingClientRect();
    return {
      fromY: Math.round(a.top + a.height / 2),
      toY: Math.round(b.top + b.height / 2),
      x: Math.round(a.left + 120)
    };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s6.x, y: s6.fromY, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s6.x, y: s6.fromY, button: 'left', clickCount: 1 });
  await sleep(60);
  for (let dy = 0; dy <= (s6.toY - s6.fromY) + 20; dy += 10) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s6.x, y: s6.fromY + dy, button: 'left', clickCount: 0 });
    await sleep(16);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s6.x, y: s6.toY + 20, button: 'left', clickCount: 1 });
  await sleep(400);

  const s6b = await evaluate(`({
    order: __easypub.state.chapters.map(c => c.type + ':' + c.title),
    total: __easypub.state.chapters.length
  })`);
  ok('真实鼠标拖动改变了顺序', s6b.order.join('|') !== before.join('|'), {
    前: before.slice(0, 3), 后: s6b.order.slice(0, 3)
  });
  ok('拖动后章节总数不变', s6b.total === 23, s6b.total);

  console.log('\n【7】生成并检查 nav');
  const dlDir = path.join(__dirname, 'dl');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  const buildRes = await evaluate(`(async () => {
    __easypub.build();
    await new Promise((res, rej) => {
      const iv = setInterval(() => {
        const t = document.getElementById('statusText').textContent;
        if (t.indexOf('完成') === 0 || t.indexOf('失败') === 0) { clearInterval(iv); res(); }
      }, 100);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 40000);
    });
    return document.getElementById('statusText').textContent;
  })()`);
  ok('生成成功', buildRes.indexOf('完成') === 0, buildRes);

  await sleep(500);
  let ep = null;
  for (let i = 0; i < 40; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.epub'));
    if (l.length) { ep = path.join(dlDir, l[0]); break; }
    await sleep(200);
  }
  if (ep) { fs.renameSync(ep, path.join(__dirname, 'v8-out.epub')); console.log('  v8-out.epub'); }

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
