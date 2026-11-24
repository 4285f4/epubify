/* v17 回归：括号序号 / 卷名前置两个新预设 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9257;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v17-' + Date.now());

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

  // 选预设并解析一段构造文本，返回识别到的标题
  async function runPreset(preset, text) {
    return evaluate(`(async () => {
      document.querySelectorAll('#presetMenu input').forEach(b => {
        b.checked = (b.value === '${preset}');
      });
      document.querySelector('#presetMenu input[value="${preset}"]')
        .dispatchEvent(new Event('change', {bubbles: true}));
      await new Promise(r => setTimeout(r, 200));
      const re = document.getElementById('fullRegex').value;
      const list = EasyText.parseChapters(${JSON.stringify(text)}, { mode: 'regex', fullRegex: re });
      return { regex: re, titles: list.filter(c => !c.fixedTitle).map(c => c.title), levels: list.filter(c => !c.fixedTitle).map(c => c.level) };
    })()`);
  }

  console.log('\n【1】括号序号（全角/半角、中文/阿拉伯数字）');
  const t1 = '（一）\n正文甲\n\n（0）\n正文乙\n\n(0)\n正文丙\n\n（十二）附带标题\n正文丁';
  const r1 = await runPreset('paren', t1);
  ok('识别出 4 个括号标题', r1.titles.length === 4, { 正则: r1.regex, 识别: r1.titles });
  ok('全角/半角都覆盖', r1.titles.some(t => /（一）/.test(t)) &&
    r1.titles.some(t => /（0）/.test(t)) && r1.titles.some(t => /\(0\)/.test(t)), r1.titles);
  ok('括号后带标题也能识别', r1.titles.some(t => /（十二）附带标题/.test(t)), r1.titles);

  console.log('\n【2】卷名前置');
  const t2 = '第一卷 第1章 开端\n正文甲\n\n第一卷 第2章 发展\n正文乙\n\n（二）上卷 第3章 转折\n正文丙';
  const r2 = await runPreset('prefix', t2);
  ok('识别出 3 个标题', r2.titles.length === 3, { 正则: r2.regex, 识别: r2.titles });
  ok('卷名 + 第X章 可识别', r2.titles.some(t => /第一卷 第1章/.test(t)), r2.titles);

  console.log('\n【3】正文里的括号与章号不应误判');
  const t3 = '（一）这是正文句子，用来测试过滤。\n正文甲\n\n他说（二）这个方案可以。\n正文乙\n\n这一章讲的是 第3章 的内容，很长的一句话用来测试长度限制是否会过滤掉它。';
  const r3 = await runPreset('paren', t3);
  ok('带标点的括号行被过滤', r3.titles.length === 0, r3.titles);

  console.log('\n【4】旧预设不受影响（默认规则走 simple 模式）');
  const r4 = await evaluate(`(() => {
    const list = EasyText.parseChapters('第一章 开端\\n正文甲\\n\\n第二章 发展\\n正文乙');
    return list.filter(c => !c.fixedTitle).map(c => c.title);
  })()`);
  ok('中文网文预设仍正常', r4.length === 2, r4);

  const r5 = await evaluate(`(() => {
    const list = EasyText.parseChapters('（一）\\n正文甲\\n\\n（0）\\n正文乙');
    return list.filter(c => !c.fixedTitle).map(c => c.title);
  })()`);
  ok('默认预设不认括号序号（隔离）', r5.length === 0, r5);

  console.log('\n【5】预设下拉含新选项');
  const opts = await evaluate(`Array.from(document.querySelectorAll('#presetMenu input')).map(o => o.value)`);
  ok('选项已加入', opts.indexOf('paren') >= 0 && opts.indexOf('prefix') >= 0, opts);

  console.log('\n【6】额外关键词：默认值不被空输入框覆盖');
  const s6 = await evaluate(`(() => {
    const box = document.getElementById('extraKeywords');
    const lines = ['简介：这是介绍', '', '正文甲', '', '第一章 开端', '正文乙'];
    const list = EasyText.parseChapters(lines.join(String.fromCharCode(10) + String.fromCharCode(10)));
    return {
      uiValue: box.value,
      titles: list.filter(c => !c.fixedTitle).map(c => c.title)
    };
  })()`);
  ok('输入框带出默认关键词', s6.uiValue.length > 5 && s6.uiValue.indexOf('|') > 0, s6.uiValue);
  ok('关键词生效（简介行被识别）', s6.titles.some(t => /简介/.test(t)), s6.titles);

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
