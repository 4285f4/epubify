/* v18 回归：卷首命名、首行保留、书名提取、简介页开关 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9259;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v18-' + Date.now());

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

// 用户报告的那种开头格式
const SAMPLE = [
  '书名：测试之书',
  '作者：测试某人',
  '内容简介',
  '这是简介正文。',
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

  console.log('\n【1】导入「书名：…　作者：…」格式的开头');
  const s1 = await evaluate(`(async () => {
    const blob = new Blob([${JSON.stringify(SAMPLE)}], {type: 'text/plain'});
    __epubify.importFile(new File([blob], '无信息文件名.txt', {type: 'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__epubify.state.chapters.length) { clearInterval(iv); res(); } }, 40);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 15000);
    });
    await new Promise(r => setTimeout(r, 300));
    const ch = __epubify.state.chapters.filter(c => c.type === 'text');
    return {
      title: __epubify.state.meta.title,
      author: __epubify.state.meta.author,
      firstTitle: ch[0].title,
      firstFixed: !!ch[0].fixedTitle,
      titles: ch.map(c => c.title)
    };
  })()`);
  ok('书名从「书名：」提取', s1.title === '测试之书', s1.title);
  ok('作者提取', s1.author === '测试某人', s1.author);
  ok('前置章节命名为「卷首」', s1.firstTitle === '卷首', s1.firstTitle);
  ok('后续章节正常', s1.titles.length === 3, s1.titles);

  console.log('\n【2】卷首首行不能被吞掉');
  const s2 = await evaluate(`(async () => {
    const idx = __epubify.state.chapters.findIndex(c => c.fixedTitle);
    __epubify.state.previewIdx = idx;
    __epubify.refreshPreview();
    await new Promise(r => setTimeout(r, 300));
    const doc = document.getElementById('previewFrame').contentDocument;
    return {
      text: doc.body.innerText.replace(/\\s+/g, ' ').trim(),
      hasTitleLine: doc.body.innerText.indexOf('书名：测试之书') >= 0,
      hasAuthorLine: doc.body.innerText.indexOf('作者：测试某人') >= 0,
      hasDesc: doc.body.innerText.indexOf('这是简介正文') >= 0
    };
  })()`);
  ok('首行「书名：…」保留', s2.hasTitleLine === true, s2.text.slice(0, 60));
  ok('「作者：…」保留', s2.hasAuthorLine === true);
  ok('简介段落保留', s2.hasDesc === true);

  console.log('\n【3】普通章节仍应跳过标题行（不重复）');
  const s3 = await evaluate(`(async () => {
    const idx = __epubify.state.chapters.findIndex(c => c.title === '第一章 开端');
    __epubify.state.previewIdx = idx;
    __epubify.refreshPreview();
    await new Promise(r => setTimeout(r, 250));
    const doc = document.getElementById('previewFrame').contentDocument;
    const h2 = doc.querySelector('h2');
    const body = doc.body.innerText;
    return {
      heading: h2 ? h2.textContent : '',
      occurrences: (body.match(/第一章 开端/g) || []).length
    };
  })()`);
  ok('标题只出现一次（h2，不在正文里重复）', s3.occurrences === 1, s3);

  console.log('\n【4】简介页开关：无简介时禁用');
  const s4 = await evaluate(`(async () => {
    const cb = document.getElementById('mInsertIntro');
    document.getElementById('mDesc').value = '';
    document.getElementById('mDesc').dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 120));
    const empty = { disabled: cb.disabled, checked: cb.checked, tip: document.getElementById('introWrap').title };

    document.getElementById('mDesc').value = '这是我在元数据里写的简介。';
    document.getElementById('mDesc').dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 120));
    const filled = { disabled: cb.disabled, checked: cb.checked };
    return { empty, filled };
  })()`);
  ok('简介为空时开关禁用', s4.empty.disabled === true && s4.empty.checked === false, s4.empty);
  ok('禁用时给出提示', /简介/.test(s4.empty.tip), s4.empty.tip);
  ok('填写简介后可用', s4.filled.disabled === false, s4.filled);

  console.log('\n【5】勾选后产物应含简介页');
  const dlDir = path.join(__dirname, 'dl');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  const s5 = await evaluate(`(async () => {
    const cb = document.getElementById('mInsertIntro');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    // 同步到 state.meta.title 等，避免生成时字段为空
    __epubify.state.meta.description = document.getElementById('mDesc').value;
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
  ok('生成成功', s5.indexOf('完成') === 0, s5);

  await sleep(800);
  let ep = null;
  for (let i = 0; i < 50; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.epub'));
    if (l.length) { ep = path.join(dlDir, l[0]); break; }
    await sleep(200);
  }
  if (ep) {
    fs.renameSync(ep, path.join(__dirname, 'v18-out.epub'));
    console.log('  v18-out.epub');
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
