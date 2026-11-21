/* v10 回归：关于弹窗与版本信息 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9245;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v10-' + Date.now());

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

  console.log('\n【1】未构建时（直接打开源码）');
  const s1 = await evaluate(`(async () => {
    document.getElementById('btnAbout').click();
    await new Promise(r => setTimeout(r, 250));
    return {
      hidden: document.getElementById('aboutMask').hidden,
      version: document.getElementById('aboutVersion').textContent,
      build: document.getElementById('aboutBuild').textContent,
      commit: document.getElementById('aboutCommit').textContent,
      repo: document.getElementById('aboutRepo').textContent,
      href: document.getElementById('aboutRepo').getAttribute('href')
    };
  })()`);
  ok('弹窗可打开', s1.hidden === false, s1.hidden);
  ok('无构建信息时显示开发版', /开发版/.test(s1.version), s1.version);
  ok('仓库地址默认可用', /github\.com/.test(s1.href), s1.href);

  console.log('\n【2】注入构建信息后（模拟部署版）');
  const s2 = await evaluate(`(async () => {
    document.getElementById('aboutClose').click();
    await new Promise(r => setTimeout(r, 150));
    window.__BUILD_INFO = {
      version: '1.0.3',
      buildTime: '2026-11-21 12:26',
      commit: '39eb1f4',
      repo: 'https://github.com/4285f4/epubify'
    };
    document.getElementById('btnAbout').click();
    await new Promise(r => setTimeout(r, 250));
    return {
      version: document.getElementById('aboutVersion').textContent,
      build: document.getElementById('aboutBuild').textContent,
      commit: document.getElementById('aboutCommit').textContent,
      repo: document.getElementById('aboutRepo').textContent
    };
  })()`);
  ok('显示版本号', s2.version === 'v1.0.3', s2.version);
  ok('显示构建时间', s2.build === '2026-11-21 12:26', s2.build);
  ok('显示提交哈希', s2.commit === '39eb1f4', s2.commit);
  ok('仓库显示为短地址', s2.repo === 'github.com/4285f4/epubify', s2.repo);

  console.log('\n【3】三种关闭方式');
  const s3 = await evaluate(`(async () => {
    const mask = document.getElementById('aboutMask');
    const isOpen = () => !mask.hidden;

    document.getElementById('aboutClose').click();
    const byButton = !isOpen();

    document.getElementById('btnAbout').click();
    await new Promise(r => setTimeout(r, 150));
    mask.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    const byMask = !isOpen();

    document.getElementById('btnAbout').click();
    await new Promise(r => setTimeout(r, 150));
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    const byEsc = !isOpen();

    return { byButton, byMask, byEsc };
  })()`);
  ok('点关闭按钮可关', s3.byButton === true, s3);
  ok('点遮罩可关', s3.byMask === true, s3);
  ok('Esc 可关', s3.byEsc === true, s3);

  console.log('\n【4】弹窗不影响主流程');
  const s4 = await evaluate(`(async () => {
    document.getElementById('btnAbout').click();
    await new Promise(r => setTimeout(r, 150));
    const openState = !document.getElementById('aboutMask').hidden;
    document.getElementById('aboutClose').click();
    await new Promise(r => setTimeout(r, 150));
    return {
      openState,
      closed: document.getElementById('aboutMask').hidden,
      buildEnabled: document.getElementById('btnBuild').disabled,
      importVisible: !!document.getElementById('btnImport')
    };
  })()`);
  ok('开关后主界面完好', s4.closed === true && s4.importVisible === true, s4);

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
