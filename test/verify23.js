/* v23 回归：反复导入 + 生成，检查状态与资源是否泄漏 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9277;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v23-' + Date.now());

const SMALL = path.join(__dirname, 'bookB.txt');
if (!fs.existsSync(SMALL)) {
  console.log('跳过 verify23：缺少 test/bookB.txt');
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

  const dlDir = path.join(__dirname, 'dl');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  // 导入一本并等分章完成
  async function importOnce(file, name) {
    return evaluate(`(async () => {
      const blob = await (await fetch('test/${file}')).blob();
      __epubify.importFile(new File([blob], '${name}', {type: 'text/plain'}));
      await new Promise((res, rej) => {
        const iv = setInterval(() => {
          if (__epubify.state.chapters.length) { clearInterval(iv); res(); }
        }, 50);
        setTimeout(() => { clearInterval(iv); rej(new Error('导入超时')); }, 30000);
      });
      await new Promise(r => setTimeout(r, 200));
      return {
        n: __epubify.state.chapters.length,
        chars: __epubify.state.text.length,
        title: __epubify.state.meta.title,
        mode: __epubify.state.rules.mode,
        regex: __epubify.state.rules.fullRegex,
        extras: __epubify.state.rules.extraKeywords
      };
    })()`);
  }

  async function buildOnce() {
    return evaluate(`(async () => {
      __epubify.build();
      await new Promise((res, rej) => {
        const iv = setInterval(() => {
          const t = document.getElementById('statusText').textContent;
          if (t.indexOf('完成') === 0 || t.indexOf('失败') === 0) { clearInterval(iv); res(t); }
        }, 100);
        setTimeout(() => { clearInterval(iv); rej(new Error('生成超时')); }, 60000);
      });
      return document.getElementById('statusText').textContent;
    })()`);
  }

  console.log('\n【1】连续 6 轮：导入 → 生成');
  const rounds = [];
  for (let i = 1; i <= 6; i++) {
    const imp = await importOnce('bookB.txt', '乙书.txt');
    const st = await buildOnce();
    rounds.push({ i, n: imp.n, chars: imp.chars, ok: st.indexOf('完成') === 0, title: imp.title });
    console.log(`     第 ${i} 轮：${imp.n} 章 / ${imp.chars} 字 / ${imp.title || '(无书名)'} / ${st.slice(0, 20)}`);
  }
  const counts = rounds.map(r => r.n);
  ok('每轮章节数一致', new Set(counts).size === 1, counts);
  ok('每轮都生成成功', rounds.every(r => r.ok), rounds.map(r => r.ok));
  ok('章节数不为 0', counts.every(n => n > 0), counts);

  console.log('\n【2】反复导入后规则不应漂移');
  const rule = await evaluate(`({
    mode: __epubify.state.rules.mode,
    regex: __epubify.state.rules.fullRegex,
    extras: __epubify.state.rules.extraKeywords,
    chips: Array.from(document.querySelectorAll('#suffixChips .chip.active')).map(b => b.dataset.v)
  })`);
  ok('额外关键词未丢失', (rule.extras || '').indexOf('简介') >= 0, rule.extras);
  ok('后缀 chip 未被清空', rule.chips.length >= 5, rule.chips);

  console.log('\n【3】换一本不同的书仍能识别');
  const another = await evaluate(`(async () => {
    const txt = ['（一）','正文一。','（二）','正文二。','（三）','正文三。'].join(String.fromCharCode(10));
    const blob = new Blob([txt], {type: 'text/plain'});
    __epubify.importFile(new File([blob], '括号书.txt', {type: 'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__epubify.state.chapters.length) { clearInterval(iv); res(); } }, 40);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 15000);
    });
    await new Promise(r => setTimeout(r, 300));
    return {
      n: __epubify.state.chapters.length,
      titles: __epubify.state.chapters.filter(c => c.type === 'text').map(c => c.title)
    };
  })()`);
  ok('格式不符时自动换规则', another.n >= 3, { 章数: another.n, 标题: another.titles });

  console.log('\n【4】内存与对象清理');
  const mem = await evaluate(`(() => {
    const s = __epubify.state;
    return {
      chapters: s.chapters.length,
      textLen: s.text.length,
      originals: Object.keys(s.originals).length,
      selection: Object.keys(s.selection).length,
      editMode: s.editMode,
      bookSeq: s.bookSeq,
      // 下载用的 blob URL 是否残留
      perf: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1
    };
  })()`);
  ok('编辑记录已清空', mem.originals === 0, mem.originals);
  ok('选择状态已清空', mem.selection === 0, mem.selection);
  ok('不在编辑模式', mem.editMode === false);
  ok('bookSeq 正常递增', mem.bookSeq > 0, mem.bookSeq);
  if (mem.perf > 0) console.log(`     JS 堆占用：${mem.perf} MB`);

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
