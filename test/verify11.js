/* v11 回归：EPUB 导入（精简精排本） */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9246;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v11-' + Date.now());

// 13 MB 的样本不入库，缺失时跳过而不是报错
if (!fs.existsSync(path.join(__dirname, 'book.epub'))) {
  console.log('跳过 verify11：缺少 test/book.epub（EPUB 导入测试样本，需自行准备）');
  process.exit(0);
}

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

  console.log('\n【1】导入 EPUB');
  const t0 = Date.now();
  const imp = await evaluate(`(async () => {
    const blob = await (await fetch('test/book.epub')).blob();
    __epubify.importFile(new File([blob], '天才俱乐部.epub', {type: 'application/epub+zip'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => {
        const st = document.getElementById('statusText').textContent;
        if (st.indexOf('已从 EPUB') === 0 || st.indexOf('失败') === 0) { clearInterval(iv); res(); }
      }, 100);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 120000);
    });
    return {
      status: document.getElementById('statusText').textContent,
      chars: __epubify.state.text.length,
      chapters: __epubify.state.chapters.length
    };
  })()`);
  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  ok('导入完成', imp.status.indexOf('已从 EPUB') === 0, { 状态: imp.status, 耗时: cost + 's' });
  ok('提取出正文', imp.chars > 2500000, imp.chars);

  console.log('\n【2】元数据与封面');
  const s2 = await evaluate(`({
    title: __epubify.state.meta.title,
    author: __epubify.state.meta.author,
    coverMode: __epubify.state.cover.mode,
    coverSize: __epubify.state.cover.uploaded ? __epubify.state.cover.uploaded.bytes.length : 0,
    coverMime: __epubify.state.cover.uploaded ? __epubify.state.cover.uploaded.mime : '',
    coverW: __epubify.state.cover.uploaded ? __epubify.state.cover.uploaded.w : 0,
    coverH: __epubify.state.cover.uploaded ? __epubify.state.cover.uploaded.h : 0
  })`);
  ok('书名来自 OPF', s2.title === '天才俱乐部', s2.title);
  ok('作者来自 OPF', s2.author === '城城与蝉', s2.author);
  ok('封面已提取', s2.coverMode === 'upload' && s2.coverSize > 0, {
    模式: s2.coverMode, 大小: s2.coverSize, 类型: s2.coverMime, 尺寸: s2.coverW + 'x' + s2.coverH
  });
  ok('封面已规范化为 JPEG', s2.coverMime === 'image/jpeg', s2.coverMime);

  console.log('\n【3】章节结构');
  const s3 = await evaluate(`(() => {
    const ch = __epubify.state.chapters;
    const texts = ch.filter(c => c.type === 'text');
    const lv1 = texts.filter(c => c.level === 1);
    const lv2 = texts.filter(c => c.level === 2);
    return {
      total: ch.length,
      lv1: lv1.length,
      lv2: lv2.length,
      vols: lv1.slice(0, 4).map(c => c.title),
      firstChaps: lv2.slice(0, 3).map(c => c.title)
    };
  })()`);
  ok('识别出卷级标题', s3.lv1 >= 8, { 卷: s3.lv1, 样本: s3.vols });
  ok('识别出章节', s3.lv2 > 500, { 章: s3.lv2, 样本: s3.firstChaps });

  console.log('\n【4】内容完整性抽查');
  const s4 = await evaluate(`(() => {
    const t = __epubify.state.text;
    return {
      hasCh67: t.indexOf('第67章 天才俱乐部') >= 0,
      hasBody: t.indexOf('天才俱乐部……章程？') >= 0,
      hasVol1: t.indexOf('第一卷') >= 0,
      noImgTag: t.indexOf('<img') < 0,
      noHtmlTag: t.indexOf('<p>') < 0,
      sample: t.slice(t.indexOf('林弦从上到下'), t.indexOf('林弦从上到下') + 40)
    };
  })()`);
  ok('章节标题保留', s4.hasCh67 === true, s4.hasCh67);
  ok('正文内容保留', s4.hasBody === true, s4.hasBody);
  ok('卷标题保留', s4.hasVol1 === true, s4.hasVol1);
  ok('无残留 HTML 标签', s4.noImgTag && s4.noHtmlTag, { img: s4.noImgTag, p: s4.noHtmlTag });

  console.log('\n【5】生成 EPUB');
  const dlDir = path.join(__dirname, 'dl');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  const buildRes = await evaluate(`(async () => {
    __epubify.build();
    await new Promise((res, rej) => {
      const iv = setInterval(() => {
        const t = document.getElementById('statusText').textContent;
        if (t.indexOf('完成') === 0 || t.indexOf('失败') === 0) { clearInterval(iv); res(); }
      }, 100);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 90000);
    });
    return document.getElementById('statusText').textContent;
  })()`);
  ok('生成成功', buildRes.indexOf('完成') === 0, buildRes);

  await sleep(700);
  let ep = null;
  for (let i = 0; i < 60; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.epub'));
    if (l.length) { ep = path.join(dlDir, l[0]); break; }
    await sleep(200);
  }
  if (ep) {
    fs.renameSync(ep, path.join(__dirname, 'v11-out.epub'));
    const sz = fs.statSync(path.join(__dirname, 'v11-out.epub')).size;
    console.log('  v11-out.epub  ' + (sz / 1024 / 1024).toFixed(2) + ' MB  (原书 13.2 MB)');
    ok('产物体积显著缩小', sz < 13.2 * 1024 * 1024 * 0.7, (sz / 1024 / 1024).toFixed(2) + ' MB');
  }

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
