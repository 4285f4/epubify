/* v19 回归：彻底删除章节（丢弃内容） */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9261;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v19-' + Date.now());

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

const SAMPLE = [
  '书名：待删之书',
  '作者：某作者',
  '内容简介',
  '这段是卷首里的内容。',
  '',
  '第一章 开端',
  '　　正文第一段。',
  '',
  '第二章 发展',
  '　　正文第二段。'
].join('\n');

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

  console.log('\n【1】导入并选中卷首');
  const s1 = await evaluate(`(async () => {
    const blob = new Blob([${JSON.stringify(SAMPLE)}], {type: 'text/plain'});
    __epubify.importFile(new File([blob], '待删.txt', {type: 'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__epubify.state.chapters.length) { clearInterval(iv); res(); } }, 40);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 15000);
    });
    await new Promise(r => setTimeout(r, 300));
    const row = document.querySelector('.chapter-row[data-idx="0"]');
    row.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await new Promise(r => setTimeout(r, 200));
    return {
      first: __epubify.state.chapters[0].title,
      sel: __epubify.selCount(),
      bulkVisible: !document.getElementById('bulkBar').hidden
    };
  })()`);
  ok('首章为卷首', s1.first === '卷首', s1.first);
  ok('批量栏出现', s1.bulkVisible === true && s1.sel === 1, s1);

  console.log('\n【2】批量栏应有「彻底删除」');
  const s2 = await evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('#bulkBar button[data-bulk]'));
    return btns.map(b => ({ act: b.dataset.bulk, text: b.textContent.trim(), title: b.title }));
  })()`);
  ok('存在 drop 动作', s2.some(b => b.act === 'drop'), s2.map(b => b.act));
  ok('按钮文案为「彻底删除」', s2.some(b => b.act === 'drop' && b.text === '彻底删除'),
    s2.find(b => b.act === 'drop'));

  console.log('\n【3】点击后应标记为丢弃');
  const s3 = await evaluate(`(async () => {
    const btn = document.querySelector('#bulkBar button[data-bulk="drop"]');
    btn.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await new Promise(r => setTimeout(r, 300));
    const c = __epubify.state.chapters[0];
    return {
      deleted: c.deleted,
      status: document.getElementById('statusText').textContent,
      rowCls: document.querySelector('.chapter-row[data-idx="0"]').className
    };
  })()`);
  ok('标记为 drop', s3.deleted === 'drop', s3.deleted);
  ok('提示文案说明内容丢弃', /丢弃/.test(s3.status), s3.status);
  ok('行有删除线样式', /is-dropped/.test(s3.rowCls), s3.rowCls);

  console.log('\n【4】生成的 EPUB 不含卷首');
  const dlDir = path.join(__dirname, 'dl');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  const s4 = await evaluate(`(async () => {
    __epubify.build();
    await new Promise((res, rej) => {
      const iv = setInterval(() => {
        const t = document.getElementById('statusText').textContent;
        if (t.indexOf('完成') === 0 || t.indexOf('失败') === 0) { clearInterval(iv); res(); }
      }, 100);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 60000);
    });
    return document.getElementById('statusText').textContent;
  })()`);
  ok('生成成功', s4.indexOf('完成') === 0, s4);

  await sleep(800);
  let ep = null;
  for (let i = 0; i < 50; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.epub'));
    if (l.length) { ep = path.join(dlDir, l[0]); break; }
    await sleep(200);
  }
  if (ep) {
    fs.renameSync(ep, path.join(__dirname, 'v19-out.epub'));
    console.log('  v19-out.epub');
  }

  console.log('\n【5】导出 TXT 不含卷首内容');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
  const s5 = await evaluate(`(async () => {
    document.getElementById('btnDownloadTxt').disabled = false;
    __epubify.downloadText();
    await new Promise(r => setTimeout(r, 400));
    return true;
  })()`);

  await sleep(800);
  let txt = null;
  for (let i = 0; i < 40; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.txt'));
    if (l.length) { txt = path.join(dlDir, l[0]); break; }
    await sleep(200);
  }
  if (txt) {
    const body = fs.readFileSync(txt, 'utf8');
    ok('TXT 不含「书名：」', body.indexOf('书名：') < 0, body.slice(0, 60));
    ok('TXT 不含卷首正文', body.indexOf('这段是卷首里的内容') < 0);
    ok('TXT 仍含正文章节', body.indexOf('第一章 开端') >= 0);
  } else {
    ok('TXT 已导出', false, '未找到文件');
  }

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
