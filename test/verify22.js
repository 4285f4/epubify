/* v22 回归：Shift 连选不应选中章节文字 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9269;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v22-' + Date.now());
const SHIFT = 8;

const SAMPLE = path.join(__dirname, 'bookB.txt');
if (!fs.existsSync(SAMPLE)) {
  console.log('跳过 verify22：缺少 test/bookB.txt');
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
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(1200);

  console.log('\n【1】导入并定位行坐标');
  const s1 = await evaluate(`(async () => {
    const blob = await (await fetch('test/bookB.txt')).blob();
    __epubify.importFile(new File([blob], '乙书.txt', {type: 'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__epubify.state.chapters.length) { clearInterval(iv); res(); } }, 40);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 15000);
    });
    await new Promise(r => setTimeout(r, 400));
    function center(i) {
      const r = document.querySelector('.chapter-row[data-idx="' + i + '"]').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    return { total: __epubify.state.chapters.length, p0: center(0), p4: center(4) };
  })()`);
  ok('已导入', s1.total > 5, s1.total);

  console.log('\n【2】单击第一行，再 Shift 点第五行');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s1.p0.x, y: s1.p0.y, button: 'left', clickCount: 1, modifiers: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s1.p0.x, y: s1.p0.y, button: 'left', clickCount: 1, modifiers: 0 });
  await sleep(200);

  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s1.p4.x, y: s1.p4.y, button: 'left', clickCount: 1, modifiers: SHIFT });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s1.p4.x, y: s1.p4.y, button: 'left', clickCount: 1, modifiers: SHIFT });
  await sleep(300);

  const s2 = await evaluate(`(() => {
    const sel = window.getSelection();
    const text = sel ? sel.toString() : '';
    return {
      selectedText: text,
      selLength: text.length,
      bodySelect: getComputedStyle(document.querySelector('.chapter-row')).userSelect
    };
  })()`);
  ok('真实 Shift 点击后无文字选区', s2.selLength === 0, s2.selectedText.slice(0, 40));
  ok('行样式禁用了选择', s2.bodySelect === 'none', s2.bodySelect);

  // CDP 合成的 click 会丢 shiftKey，连选逻辑改用合成事件验证
  const s2b = await evaluate(`(async () => {
    __epubify.state.selection = {};
    __epubify.state.anchor = -1;
    const rows = document.querySelectorAll('.chapter-row');
    rows[0].dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await new Promise(r => setTimeout(r, 120));
    rows[4].dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: true}));
    await new Promise(r => setTimeout(r, 150));
    return { sel: __epubify.selCount(), text: window.getSelection().toString() };
  })()`);
  ok('Shift 连选 5 项', s2b.sel === 5, s2b.sel);
  ok('连选过程同样无文字选区', s2b.text.length === 0, s2b.text.slice(0, 30));

  console.log('\n【3】拖动过程中也不应选中文字');
  // 批量栏出现后列表位置会变，重新取坐标
  const p3 = await evaluate(`(() => {
    const r = document.querySelector('.chapter-row[data-idx="0"]').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p3.x, y: p3.y, button: 'left', clickCount: 1, modifiers: 0 });
  for (let dy = 4; dy <= 40; dy += 4) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p3.x, y: p3.y + dy, button: 'left', modifiers: 0 });
    await sleep(20);
  }
  const s3 = await evaluate(`(() => {
    const sel = window.getSelection();
    return { len: sel ? sel.toString().length : 0, text: sel ? sel.toString().slice(0,40) : '' };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p3.x, y: p3.y + 40, button: 'left', clickCount: 1, modifiers: 0 });
  await sleep(200);
  ok('拖动中无文字选中', s3.len === 0, s3.len);

  console.log('\n【4】双击改名仍可用');
  const s4 = await evaluate(`(async () => {
    const row = document.querySelector('.chapter-row[data-idx="2"]');
    row.querySelector('.title').dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
    await new Promise(r => setTimeout(r, 300));
    const inp = row.querySelector('input');
    return { hasInput: !!inp, value: inp ? inp.value.slice(0, 20) : '' };
  })()`);
  ok('双击出现输入框', s4.hasInput === true, s4.value);

  console.log('\n=== 汇总 ===');
  const pass = results.filter(r => r.pass).length;
  console.log(`${pass}/${results.length} 通过`);
  if (errors.length) {
    console.log('控制台错误:');
    errors.slice(0, 5).forEach(e => console.log('  ✗', String(e).slice(0, 160)));
  } else console.log('无控制台错误');

  ws.close(); chrome.kill();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('测试异常:', e.message); chrome.kill(); process.exit(1); });
