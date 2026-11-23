/* v15 回归：点击章节跳预览 + 按设备自动选择预览宽度 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9253;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v15-' + Date.now());

const SAMPLE = path.join(__dirname, 'bookB.txt');
if (!fs.existsSync(SAMPLE)) {
  console.log('跳过 verify15：缺少 test/bookB.txt');
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

  console.log('\n【1】桌面环境下默认铺满');
  await send('Page.navigate', { url: URL });
  await sleep(1200);
  const s1 = await evaluate(`({
    device: (document.querySelector('#previewDevice button.active') || {}).dataset?.val,
    frameCls: document.getElementById('previewFrame').className,
    width: window.innerWidth
  })`);
  ok('桌面选择「铺满」', s1.device === 'full', s1);

  console.log('\n【2】导入后点击章节自动切到预览');
  const s2 = await evaluate(`(async () => {
    const blob = await (await fetch('test/bookB.txt')).blob();
    __epubify.importFile(new File([blob], '乙书.txt', {type: 'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__epubify.state.chapters.length) { clearInterval(iv); res(); } }, 50);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 20000);
    });
    await new Promise(r => setTimeout(r, 300));

    // 先切到「书籍信息」，模拟用户在其他面板
    document.querySelector('.tab[data-tab="meta"]').click();
    await new Promise(r => setTimeout(r, 100));
    const before = document.querySelector('.tab.active').dataset.tab;

    // 单击第 3 行
    const row = document.querySelector('.chapter-row[data-idx="2"]');
    row.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await new Promise(r => setTimeout(r, 250));
    const after = document.querySelector('.tab.active').dataset.tab;

    return {
      before, after,
      previewIdx: __epubify.state.previewIdx,
      paneActive: !!document.querySelector('.tab-pane[data-pane="preview"].active')
    };
  })()`);
  ok('点击前在书籍信息页', s2.before === 'meta', s2.before);
  ok('点击后自动切到预览', s2.after === 'preview', s2.after);
  ok('预览面板已激活', s2.paneActive === true);
  ok('预览章节已更新', s2.previewIdx === 2, s2.previewIdx);

  console.log('\n【3】Ctrl 多选不打断当前面板');
  const s3 = await evaluate(`(async () => {
    document.querySelector('.tab[data-tab="meta"]').click();
    await new Promise(r => setTimeout(r, 100));
    const row = document.querySelector('.chapter-row[data-idx="4"]');
    row.dispatchEvent(new MouseEvent('click', {bubbles: true, ctrlKey: true}));
    await new Promise(r => setTimeout(r, 200));
    return {
      tab: document.querySelector('.tab.active').dataset.tab,
      selected: Object.keys(__epubify.state.selection).length
    };
  })()`);
  ok('Ctrl 点击停留在原面板', s3.tab === 'meta', s3.tab);
  ok('多选仍然生效', s3.selected > 0, s3.selected);

  console.log('\n【4】手机设备识别');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await send('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  await send('Page.navigate', { url: URL });
  await sleep(1200);
  const s4 = await evaluate(`({
    device: (document.querySelector('#previewDevice button.active') || {}).dataset?.val,
    frameCls: document.getElementById('previewFrame').className,
    width: window.innerWidth
  })`);
  ok('手机选择「手机」', s4.device === 'phone', s4);
  ok('iframe 应用 phone 样式', /phone/.test(s4.frameCls), s4.frameCls);

  console.log('\n【5】平板设备识别');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 820, height: 1180, deviceScaleFactor: 2, mobile: true
  });
  await send('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  await send('Page.navigate', { url: URL });
  await sleep(1200);
  const s5 = await evaluate(`({
    device: (document.querySelector('#previewDevice button.active') || {}).dataset?.val,
    frameCls: document.getElementById('previewFrame').className
  })`);
  ok('平板选择「平板」', s5.device === 'tablet', s5);
  ok('iframe 应用 tablet 样式', /tablet/.test(s5.frameCls), s5.frameCls);

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
