/* v16 回归：构建时间的时区处理
 *
 * 构建时间统一存 UTC（Cloudflare 构建机是 UTC，本地是 +8），
 * 前端按访问者所在时区显示，避免两处差几小时。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9255;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v16-' + Date.now());

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

  // 固定一个 UTC 时刻：2026-11-23 13:00Z
  const FIXED_ISO = '2026-11-23T13:00:00.000Z';

  async function readBuild(tz) {
    await send('Emulation.setTimezoneOverride', { timezoneId: tz });
    return evaluate(`(async () => {
      window.__BUILD_INFO = {
        version: '1.0.3',
        buildTime: '${FIXED_ISO}',
        commit: 'abc1234',
        repo: 'https://github.com/x/y'
      };
      const mask = document.getElementById('aboutMask');
      if (!mask.hidden) document.getElementById('aboutClose').click();
      await new Promise(r => setTimeout(r, 120));
      document.getElementById('btnAbout').click();
      await new Promise(r => setTimeout(r, 220));
      const el = document.getElementById('aboutBuild');
      return { text: el.textContent, title: el.title, offset: new Date().getTimezoneOffset() };
    })()`);
  }

  console.log('\n【1】UTC 原值应为 13:00');
  const tzShanghai = await readBuild('Asia/Shanghai');
  ok('上海显示 21:00', tzShanghai.text === '2026-11-23 21:00', {
    显示: tzShanghai.text, 时区偏移: tzShanghai.offset
  });
  ok('提示保留 UTC 原值', /2026-11-23T13:00/.test(tzShanghai.title), tzShanghai.title);

  console.log('\n【2】其他时区');
  const tzUTC = await readBuild('UTC');
  ok('UTC 显示 13:00', tzUTC.text === '2026-11-23 13:00', tzUTC.text);

  const tzNY = await readBuild('America/New_York');
  ok('纽约显示 08:00（EST = UTC-5）', tzNY.text === '2026-11-23 08:00', tzNY.text);

  const tzTokyo = await readBuild('Asia/Tokyo');
  ok('东京显示 22:00', tzTokyo.text === '2026-11-23 22:00', tzTokyo.text);

  console.log('\n【3】旧格式兼容（无时区后缀的字符串）');
  const legacy = await evaluate(`(async () => {
    window.__BUILD_INFO = { version: '1.0.2', buildTime: '2026-11-21 12:26', commit: 'x', repo: '' };
    document.getElementById('aboutClose').click();
    await new Promise(r => setTimeout(r, 120));
    document.getElementById('btnAbout').click();
    await new Promise(r => setTimeout(r, 200));
    return document.getElementById('aboutBuild').textContent;
  })()`);
  ok('旧格式不报错、可读', /^2026-11-21/.test(legacy), legacy);

  console.log('\n【4】缺失构建时间');
  const empty = await evaluate(`(async () => {
    window.__BUILD_INFO = { version: '1.0.0' };
    document.getElementById('aboutClose').click();
    await new Promise(r => setTimeout(r, 120));
    document.getElementById('btnAbout').click();
    await new Promise(r => setTimeout(r, 200));
    return document.getElementById('aboutBuild').textContent;
  })()`);
  ok('无值显示占位符', empty === '—', empty);

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
