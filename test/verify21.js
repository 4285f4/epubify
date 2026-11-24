/* v21 回归：预设方案多选（混排格式的书） */
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

  await evaluate(`(async () => {
    const txt = ['（一）','正文一。','第一章 开端','正文二。','（二）','正文三。','第二章 发展','正文四。'].join(String.fromCharCode(10));
    const blob = new Blob([txt], {type: 'text/plain'});
    __epubify.importFile(new File([blob], '混排.txt', {type: 'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__epubify.state.chapters.length) { clearInterval(iv); res(); } }, 40);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 15000);
    });
    await new Promise(r => setTimeout(r, 300));
    document.querySelector('.tab[data-tab="split"]').click();
    await new Promise(r => setTimeout(r, 250));
  })()`);

  console.log('\n【1】默认状态：单选中文网文，走可视化构建器');
  const s1 = await evaluate(`({
    checked: Array.from(document.querySelectorAll('#presetMenu input:checked')).map(b => b.value),
    total: document.querySelectorAll('#presetMenu input').length,
    summary: document.getElementById('presetSummary').textContent,
    menuHidden: document.getElementById('presetMenu').hidden,
    mode: (document.querySelector('#splitMode button.active') || {}).dataset ? (document.querySelector('#splitMode button.active') || {}).dataset.val : ''
  })`);
  ok('共 6 个预设', s1.total === 6, s1.total);
  ok('默认不勾任何预设（用内置规则）', s1.checked.length === 0, s1.checked);
  ok('摘要说明是默认规则', /默认/.test(s1.summary), s1.summary);
  ok('面板默认收起', s1.menuHidden === true);
  ok('单选时用可视化构建', s1.mode === 'simple', s1.mode);

  console.log('\n【2】点击展开');
  const s2 = await evaluate(`(async () => {
    document.getElementById('presetTrigger').click();
    await new Promise(r => setTimeout(r, 200));
    return {
      hidden: document.getElementById('presetMenu').hidden,
      expanded: document.getElementById('presetTrigger').getAttribute('aria-expanded')
    };
  })()`);
  ok('面板展开', s2.hidden === false && s2.expanded === 'true', s2);

  console.log('\n【3】加勾括号序号 → 自动切正则并合并');
  const s3 = await evaluate(`(async () => {
    const cn = document.querySelector('#presetMenu input[value="cn"]');
    cn.checked = true;
    cn.dispatchEvent(new Event('change', {bubbles: true}));
    const c = document.querySelector('#presetMenu input[value="paren"]');
    c.checked = true;
    c.dispatchEvent(new Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 300));
    const re = document.getElementById('fullRegex').value;
    const lines = ['（一）','正文一。','第一章 开端','正文二。','（二）','正文三。','第二章 发展','正文四。'].join(String.fromCharCode(10));
    const list = EasyText.parseChapters(lines, { mode: 'regex', fullRegex: re });
    return {
      summary: document.getElementById('presetSummary').textContent,
      mode: (document.querySelector('#splitMode button.active') || {}).dataset.val,
      regex: re,
      titles: list.filter(c => !c.fixedTitle).map(c => c.title)
    };
  })()`);
  ok('摘要列出两项', /中文网文.*\+.*括号序号/.test(s3.summary), s3.summary);
  ok('自动切到正则模式', s3.mode === 'regex', s3.mode);
  ok('正则含两个分支', s3.regex.split('|').length - 1 === 1, s3.regex);
  ok('两种格式都识别（4 章）', s3.titles.length === 4, s3.titles);

  console.log('\n【4】取消全部勾选 → 回到默认规则');
  const s4 = await evaluate(`(async () => {
    document.querySelectorAll('#presetMenu input').forEach(b => { b.checked = false; });
    document.querySelector('#presetMenu input').dispatchEvent(new Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 250));
    return {
      mode: (document.querySelector('#splitMode button.active') || {}).dataset.val,
      summary: document.getElementById('presetSummary').textContent,
      suffixes: Array.from(document.querySelectorAll('#suffixChips .chip.active')).map(b => b.dataset.v)
    };
  })()`);
  ok('回到可视化构建', s4.mode === 'simple', s4.mode);
  ok('摘要说明默认', /默认/.test(s4.summary), s4.summary);
  ok('后缀恢复全集', s4.suffixes.length >= 6, s4.suffixes);

  console.log('\n【5】改回单选英文 → 回到可视化构建器');
  const s5 = await evaluate(`(async () => {
    document.querySelectorAll('#presetMenu input').forEach(b => { b.checked = (b.value === 'en'); });
    document.querySelector('#presetMenu input[value="en"]').dispatchEvent(new Event('change', {bubbles: true}));
    await new Promise(r => setTimeout(r, 300));
    return {
      mode: (document.querySelector('#splitMode button.active') || {}).dataset.val,
      effective: document.getElementById('effectiveReg').textContent,
      summary: document.getElementById('presetSummary').textContent
    };
  })()`);
  ok('切回简单模式', s5.mode === 'simple', s5.mode);
  ok('生效正则含 Chapter', /chapter/i.test(s5.effective), s5.effective.slice(0, 70));

  console.log('\n【6】点面板外部收起');
  const s6 = await evaluate(`(async () => {
    document.getElementById('presetMenu').hidden = true;   // 先确保收起
    await new Promise(r => setTimeout(r, 80));
    document.getElementById('presetTrigger').click();
    await new Promise(r => setTimeout(r, 150));
    const opened = !document.getElementById('presetMenu').hidden;
    document.querySelector('.tab-pane[data-pane="split"]').click();
    await new Promise(r => setTimeout(r, 200));
    return { opened, closed: document.getElementById('presetMenu').hidden };
  })()`);
  ok('点击外部后收起', s6.opened === true && s6.closed === true, s6);

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
