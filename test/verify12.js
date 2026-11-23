/* v12 回归：EPUB 导入第二本（结构不同的书）
 *
 * 与第一本样本的差异：
 *  - 章节标题用 h3（不是 h2），无卷结构
 *  - 标题内用 <br/> 分隔章号与标题
 *  - 89 张插图（14 MB），figcaption 类结构未知
 * 用于验证层级归一化与 <br> 处理是否通用。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9247;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v12-' + Date.now());

const SAMPLE = path.join(__dirname, 'book2.epub');
if (!fs.existsSync(SAMPLE)) {
  console.log('跳过 verify12：缺少 test/book2.epub（EPUB 导入测试样本，需自行准备）');
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

  console.log('\n【1】导入第二本书');
  const t0 = Date.now();
  const imp = await evaluate(`(async () => {
    const blob = await (await fetch('test/book2.epub')).blob();
    __epubify.importFile(new File([blob], 'sample2_author.epub', {type: 'application/epub+zip'}));
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
      total: __epubify.state.chapters.length
    };
  })()`);
  ok('导入完成', imp.status.indexOf('已从 EPUB') === 0, { 状态: imp.status, 耗时: ((Date.now() - t0) / 1000).toFixed(1) + 's' });

  console.log('\n【2】元数据与封面');
  const s2 = await evaluate(`({
    title: __epubify.state.meta.title,
    author: __epubify.state.meta.author,
    cover: __epubify.state.cover.mode,
    coverW: __epubify.state.cover.uploaded ? __epubify.state.cover.uploaded.w : 0
  })`);
  ok('书名非空', !!s2.title && s2.title.length >= 2, s2.title);
  // 该样本 OPF 未写 dc:creator，作者应来自「书名_作者.epub」文件名
  ok('作者非空（文件名兜底）', !!s2.author && s2.author.length >= 2, s2.author);
  ok('封面已提取', s2.cover === 'upload' && s2.coverW > 0, s2);

  console.log('\n【3】层级归一化（这本只有 h3，不应落到三级标题）');
  const s3 = await evaluate(`(() => {
    const ch = __epubify.state.chapters.filter(c => c.type === 'text');
    const byLevel = {};
    ch.forEach(c => { byLevel[c.level] = (byLevel[c.level] || 0) + 1; });
    return {
      total: ch.length,
      byLevel: byLevel,
      samples: ch.slice(0, 5).map(c => c.title),
      levelOfFirst: ch[0].level
    };
  })()`);
  ok('全部章节平级（无错误嵌套）', s3.byLevel[1] === undefined && s3.byLevel[2] > 400, s3.byLevel);
  ok('章节数量合理', s3.total > 400, s3.total);

  console.log('\n【4】<br/> 分隔的标题是否补了空格');
  const s4 = await evaluate(`(() => {
    const ch = __epubify.state.chapters.filter(c => c.type === 'text' && /^第\\d+章/.test(c.title));
    const glued = ch.filter(c => /^第\\d+章[^\\s]/.test(c.title));
    return {
      total: ch.length,
      glued: glued.length,
      samples: ch.slice(0, 4).map(c => c.title),
      gluedSamples: glued.slice(0, 3).map(c => c.title)
    };
  })()`);
  ok('标题章号与名称之间有空格', s4.glued === 0, {
    检查: s4.total, 粘连: s4.glued, 样本: s4.samples
  });

  console.log('\n【5】内容结构校验（不依赖具体文字）');
  const s5 = await evaluate(`(() => {
    const t = __epubify.state.text;
    const paras = t.split('\\n\\n');
    return {
      noTag: t.indexOf('<img') < 0 && t.indexOf('<p>') < 0,
      chars: t.length,
      paraCount: paras.length,
      avgParaLen: Math.round(t.length / (paras.length || 1))
    };
  })()`);
  ok('无 HTML 残留', s5.noTag === true);
  ok('段落切分合理', s5.avgParaLen > 10 && s5.avgParaLen < 300, {
    段落数: s5.paraCount, 平均长度: s5.avgParaLen
  });

  console.log('\n【6】生成并检查资源清理');
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
    fs.renameSync(ep, path.join(__dirname, 'v12-out.epub'));
    const sz = fs.statSync(path.join(__dirname, 'v12-out.epub')).size;
    console.log('  v12-out.epub  ' + (sz / 1024 / 1024).toFixed(2) + ' MB  (原书 17.5 MB)');
    ok('体积缩小', sz < 17.5 * 1024 * 1024 * 0.5, (sz / 1024 / 1024).toFixed(2) + ' MB');
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
