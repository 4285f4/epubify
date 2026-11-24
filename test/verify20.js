/* v20 回归：简介页作为真实章节出现在章节树 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9263;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v20-' + Date.now());

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
  '书名：示例书名',
  '作者：示例作者',
  '内容简介',
  '卷首内容。',
  '',
  '第一章 开端',
  '　　正文一。',
  '',
  '第二章 发展',
  '　　正文二。'
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

  console.log('\n【1】导入并填写简介');
  const s1 = await evaluate(`(async () => {
    const blob = new Blob([${JSON.stringify(SAMPLE)}], {type: 'text/plain'});
    __epubify.importFile(new File([blob], '示例.txt', {type: 'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__epubify.state.chapters.length) { clearInterval(iv); res(); } }, 40);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 15000);
    });
    await new Promise(r => setTimeout(r, 300));
    const d = document.getElementById('mDesc');
    d.value = '这是简介文字。';
    d.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 200));
    return {
      rows: document.querySelectorAll('.chapter-row').length,
      cbDisabled: document.getElementById('mInsertIntro').disabled
    };
  })()`);
  ok('初始无简介页', s1.rows === 3, s1.rows);
  ok('开关已可用', s1.cbDisabled === false);

  console.log('\n【2】勾选后章节树出现「简介」');
  const s2 = await evaluate(`(async () => {
    const cb = document.getElementById('mInsertIntro');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    const rows = Array.from(document.querySelectorAll('.chapter-row'));
    return {
      count: rows.length,
      titles: rows.map(r => r.querySelector('.title').textContent),
      badges: rows.map(r => r.querySelector('.chars').textContent.trim()),
      types: __epubify.state.chapters.map(c => c.type)
    };
  })()`);
  ok('章节树多了 1 行', s2.count === 4, s2.count);
  ok('标题为「简介」', s2.titles.indexOf('简介') >= 0, s2.titles);
  ok('显示「简介页」角标', s2.badges.indexOf('简介页') >= 0, s2.badges);
  ok('类型为 intro', s2.types.indexOf('intro') >= 0, s2.types);

  console.log('\n【3】与封面、目录的先后顺序');
  const s3 = await evaluate(`(async () => {
    document.getElementById('mIncludeCover').checked = true;
    document.getElementById('mIncludeCover').dispatchEvent(new Event('change'));
    document.getElementById('mTocPage').checked = true;
    document.getElementById('mTocPage').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 350));
    return {
      types: __epubify.state.chapters.map(c => c.type),
      titles: __epubify.state.chapters.map(c => c.title)
    };
  })()`);
  const head = s3.types.slice(0, 4).join(',');
  ok('顺序为 封面→目录→简介→正文', head === 'cover,toc,intro,text', s3.types);

  console.log('\n【4】预览简介页应显示简介内容');
  const s4 = await evaluate(`(async () => {
    const idx = __epubify.state.chapters.findIndex(c => c.type === 'intro');
    __epubify.state.previewIdx = idx;
    __epubify.refreshPreview();
    await new Promise(r => setTimeout(r, 300));
    const doc = document.getElementById('previewFrame').contentDocument;
    return { text: doc.body.innerText.replace(/\\s+/g, ' ').trim() };
  })()`);
  ok('预览含简介文字', /这是简介文字/.test(s4.text), s4.text.slice(0, 50));

  console.log('\n【5】生成产物的目录顺序');
  const fs = require('fs');
  const dlDir = path.join(__dirname, 'dl');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  const s5 = await evaluate(`(async () => {
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
  for (let i = 0; i < 50; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.epub'));
    if (l.length) { fs.renameSync(path.join(dlDir, l[0]), path.join(__dirname, 'v20-out.epub')); break; }
    await sleep(200);
  }

  console.log('\n【6】取消勾选：标记移除（与封面/目录一致，保留行以便撤回）');
  const s6 = await evaluate(`(async () => {
    const cb = document.getElementById('mInsertIntro');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    const intro = __epubify.state.chapters.find(c => c.type === 'intro');
    const row = document.querySelector('.chapter-row[data-idx="' +
      __epubify.state.chapters.indexOf(intro) + '"]');
    return {
      deleted: intro ? intro.deleted : null,
      hasFront: __epubify.hasFrontChapter('intro'),
      rowCls: row ? row.className : ''
    };
  })()`);
  ok('简介页标记为 drop', s6.deleted === 'drop', s6.deleted);
  ok('不再算作前置页', s6.hasFront === false);
  ok('行显示删除线', /is-deleted/.test(s6.rowCls), s6.rowCls);

  console.log('\n【7】重新分章后简介页应保留');
  const s7 = await evaluate(`(async () => {
    const cb = document.getElementById('mInsertIntro');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 250));
    const before = __epubify.hasFrontChapter('intro');
    await __epubify.resplit(false);
    await new Promise(r => setTimeout(r, 400));
    return {
      before,
      after: __epubify.hasFrontChapter('intro'),
      levels: __epubify.state.chapters.filter(c => c.type !== 'text').map(c => c.level)
    };
  })()`);
  ok('重新分章后仍在', s7.before === true && s7.after === true, s7);
  ok('前置页层级与正文一致', s7.levels.every(l => l === 2), s7.levels);

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
