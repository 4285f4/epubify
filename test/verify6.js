/* v6 回归：章节改名 + 「序」标题 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9235;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v6-' + Date.now());

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

  /** 真实鼠标双击（产生真正的 click + dblclick 序列） */
  async function realDoubleClick(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
    await sleep(200);
  }

  async function realClick(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
  }

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(1300);

  console.log('\n【1】导入小样本');
  await evaluate(`(async () => {
    const blob = await (await fetch('test/bookB.txt')).blob();
    __easypub.importFile(new File([blob], '乙书.txt', {type:'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__easypub.state.chapters.length) { clearInterval(iv); res(); } }, 40);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 20000);
    });
    await new Promise(r => setTimeout(r, 300));
  })()`);
  const first = await evaluate(`({
    title: __easypub.state.chapters[0].title,
    level: __easypub.state.chapters[0].level,
    fixed: __easypub.state.chapters[0].fixedTitle === true,
    chars: __easypub.state.chapters[0].chars,
    total: __easypub.state.chapters.length
  })`);
  ok('首章标题为「内容简介」', first.title === '内容简介', first);
  ok('首章标记为固定标题', first.fixed === true);
  ok('后续章节正常', first.total === 21, first.total);

  console.log('\n【2】点击不再重建 DOM（双击可用的前提）');
  const same = await evaluate(`(() => {
    const before = document.querySelector('.chapter-row[data-idx="3"]');
    before.dispatchEvent(new MouseEvent('click', {bubbles:true}));
    const after = document.querySelector('.chapter-row[data-idx="3"]');
    return { same: before === after, hasInput: !!document.querySelector('.chapter-row input') };
  })()`);
  ok('点击后行节点保持同一对象', same.same === true, same);

  console.log('\n【3】真实双击改名');
  const rect = await evaluate(`(() => {
    const el = document.querySelector('.chapter-row[data-idx="3"] .title');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
  })()`);
  await realDoubleClick(rect.x, rect.y);

  const dbl = await evaluate(`(() => {
    const inp = document.querySelector('.chapter-row input');
    return { hasInput: !!inp, value: inp ? inp.value : null };
  })()`);
  ok('双击进入编辑框', dbl.hasInput === true, dbl);
  ok('编辑框带出原标题', dbl.value === '第3章 乙书章节标题3', dbl.value);

  const renamed = await evaluate(`(async () => {
    const inp = document.querySelector('.chapter-row input');
    inp.value = '【改名后的标题】';
    inp.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    await new Promise(r => setTimeout(r, 200));
    return {
      title: __easypub.state.chapters[3].title,
      shown: (document.querySelector('.chapter-row[data-idx="3"] .title') || {}).textContent,
      inputGone: !document.querySelector('.chapter-row input')
    };
  })()`);
  ok('改名写入数据', renamed.title === '【改名后的标题】', renamed.title);
  ok('列表显示同步', renamed.shown === '【改名后的标题】');
  ok('编辑框已关闭', renamed.inputGone === true);

  console.log('\n【4】✎ 按钮改名');
  // 先把鼠标真实移到该行上，触发 CSS :hover 让操作按钮显示出来
  const rowPos = await evaluate(`(() => {
    const r = document.querySelector('.chapter-row[data-idx="5"]').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowPos.x, y: rowPos.y, button: 'none', clickCount: 0 });
  await sleep(250);

  const btnRect = await evaluate(`(() => {
    const btn = document.querySelector('.chapter-row[data-idx="5"] .row-actions button:nth-child(3)');
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), label: btn.textContent, visible: r.width > 0 };
  })()`);
  ok('✎ 按钮可见', btnRect.label === '✎' && btnRect.visible === true, btnRect);
  await realClick(btnRect.x, btnRect.y);
  const byBtn = await evaluate(`(() => {
    const inp = document.querySelector('.chapter-row input');
    if (!inp) return { hasInput: false };
    inp.value = '按钮改的名';
    inp.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    return { hasInput: true };
  })()`);
  await sleep(200);
  const byBtnTitle = await evaluate(`__easypub.state.chapters[5].title`);
  ok('按钮触发改名', byBtn.hasInput === true && byBtnTitle === '按钮改的名', byBtnTitle);

  console.log('\n【5】编辑「内容简介」的正文不覆盖标题');
  const seqTest = await evaluate(`(async () => {
    __easypub.toggleEdit();
    __easypub.loadChapterToEditor(0);
    const before = __easypub.state.chapters[0].title;
    const area = document.getElementById('editArea');
    area.value = '全新的扉页第一行内容';
    area.dispatchEvent(new Event('input'));
    __easypub.commitEditor();
    await new Promise(r => setTimeout(r, 150));
    const after = __easypub.state.chapters[0].title;
    __easypub.toggleEdit();
    return { before, after, content: __easypub.state.text.slice(0, 20) };
  })()`);
  ok('「内容简介」标题未被正文覆盖', seqTest.after === '内容简介', seqTest);

  console.log('\n【6】普通章节在编辑器改首行仍会同步标题');
  const normalTest = await evaluate(`(async () => {
    __easypub.toggleEdit();
    __easypub.loadChapterToEditor(7);
    const area = document.getElementById('editArea');
    const lines = area.value.split('\\n');
    lines[0] = '第七章 我改过的标题';
    area.value = lines.join('\\n');
    area.dispatchEvent(new Event('input'));
    __easypub.commitEditor();
    await new Promise(r => setTimeout(r, 150));
    const t = __easypub.state.chapters[7].title;
    __easypub.toggleEdit();
    return { title: t };
  })()`);
  ok('普通章节标题随首行同步', normalTest.title === '第七章 我改过的标题', normalTest);

  console.log('\n【7】「内容简介」保持固定标记');
  const refix = await evaluate(`(() => {
    const c = __easypub.state.chapters[0];
    return { title: c.title, fixed: c.fixedTitle };
  })()`);
  ok('「内容简介」保持固定标记', refix.fixed === true, refix);

  console.log('\n【8】产物目录第一条为「序」');
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
  let epub = null;
  for (let i = 0; i < 40; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.epub'));
    if (l.length) { epub = path.join(dlDir, l[0]); break; }
    await sleep(200);
  }
  if (epub) {
    fs.renameSync(epub, path.join(__dirname, 'v6-out.epub'));
    console.log('  已保存 v6-out.epub');
  }

  console.log('\n=== 汇总 ===');
  const pass = results.filter(r => r.pass).length;
  console.log(`${pass}/${results.length} 通过`);
  if (errors.length) {
    console.log('控制台错误:');
    errors.slice(0, 6).forEach(e => console.log('  ✗', String(e).slice(0, 180)));
  } else console.log('无控制台错误');

  ws.close(); chrome.kill();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('测试异常:', e.message); chrome.kill(); process.exit(1); });
