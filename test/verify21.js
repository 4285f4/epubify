/* v21 回归：组合预设（混排格式的书） */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9267;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v21-' + Date.now());

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

  // 混排样本：（一）与第X章交替
  const TEXT = [
    '（一）', '正文一。',
    '第一章 开端', '正文二。',
    '第二章 发展', '正文三。',
    '（二）', '正文四。',
    '第三章 转折', '正文五。'
  ].join('\n');

  console.log('\n【1】切换到组合模式');
  const s1 = await evaluate(`(async () => {
    const sel = document.getElementById('rulePreset');
    sel.value = 'combo';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 250));
    return {
      wrapHidden: document.getElementById('comboWrap').hidden,
      mode: (document.querySelector('#splitMode button.active') || {}).dataset.val,
      regex: document.getElementById('fullRegex').value
    };
  })()`);
  ok('勾选组已显示', s1.wrapHidden === false, s1.wrapHidden);
  ok('切到正则模式', s1.mode === 'regex', s1.mode);
  ok('默认只勾了「第X章」', /第\[0-9/.test(s1.regex) && !/（/.test(s1.regex), s1.regex);

  console.log('\n【2】只勾「第X章」：括号行不识别的预期');
  const s2 = await evaluate(`(() => {
    const lines = ${JSON.stringify(TEXT)}.split(String.fromCharCode(10));
    const re = document.getElementById('fullRegex').value;
    const list = EasyText.parseChapters(lines.join(String.fromCharCode(10)), { mode: 'regex', fullRegex: re });
    return list.filter(c => !c.fixedTitle).map(c => c.title);
  })()`);
  ok('识别 3 章（不含括号行）', s2.length === 3 && s2.every(t => /^第/.test(t)), s2);

  console.log('\n【3】再加上括号序号');
  const s3 = await evaluate(`(async () => {
    const cb = document.querySelector('#comboWrap input[data-combo="paren"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 250));
    const re = document.getElementById('fullRegex').value;
    const lines = ${JSON.stringify(TEXT)}.split(String.fromCharCode(10));
    const list = EasyText.parseChapters(lines.join(String.fromCharCode(10)), { mode: 'regex', fullRegex: re });
    return {
      regex: re,
      titles: list.filter(c => !c.fixedTitle).map(c => c.title)
    };
  })()`);
  ok('正则含两个分支', s3.regex.split('|').length - 1 === 1, s3.regex);
  ok('识别 5 章（两种格式都认）', s3.titles.length === 5, s3.titles);
  ok('括号与第X章都在', s3.titles.indexOf('（一）') >= 0 && s3.titles.indexOf('第三章 转折') >= 0, s3.titles);

  console.log('\n【4】同时勾「卷名前置」不应把普通章节拆开');
  const s4 = await evaluate(`(async () => {
    const cb = document.querySelector('#comboWrap input[data-combo="prefix"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 250));
    const re = document.getElementById('fullRegex').value;
    const lines = ['第一卷 第1章 开端','正文甲','第一卷 第2章 发展','正文乙','（三）','正文丙'].join(String.fromCharCode(10));
    const list = EasyText.parseChapters(lines, { mode: 'regex', fullRegex: re });
    return list.filter(c => !c.fixedTitle).map(c => c.title);
  })()`);
  ok('卷名前置 + 括号同时生效', s4.length === 3, s4);

  console.log('\n【5】全部取消勾选时给出空正则');
  const s5 = await evaluate(`(async () => {
    document.querySelectorAll('#comboWrap input[data-combo]').forEach(b => { b.checked = false; });
    document.querySelectorAll('#comboWrap input[data-combo]')[0].dispatchEvent(new Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 250));
    return { regex: document.getElementById('fullRegex').value };
  })()`);
  ok('正则为空', s5.regex === '', s5.regex);

  console.log('\n【6】切回其他预设应隐藏勾选组');
  const s6 = await evaluate(`(async () => {
    const sel = document.getElementById('rulePreset');
    sel.value = 'cn';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    return { hidden: document.getElementById('comboWrap').hidden };
  })()`);
  ok('勾选组已隐藏', s6.hidden === true);

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
