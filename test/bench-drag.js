/* 性能实测：766 万字下拖动章节的真实开销 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9239;
const profile = path.join(os.tmpdir(), 'cdp-perf-' + Date.now());
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1500,940',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  let id = 0; const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/index.html' });
  await sleep(1300);

  console.log('导入 766 万字…');
  await evaluate(`(async () => {
    const blob = await (await fetch('test/sample.txt')).blob();
    __easypub.importFile(new File([blob], '甲书.txt', {type:'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__easypub.state.chapters.length) { clearInterval(iv); res(); } }, 40);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 30000);
    });
    await new Promise(r => setTimeout(r, 400));
  })()`);

  const res = await evaluate(`(async () => {
    const s = __easypub.state;
    const out = { chars: s.text.length, chapters: s.chapters.length };

    // 1) 纯 rebuildText 耗时（重排全文并重算 1076 个偏移）
    let t = performance.now();
    __easypub.rebuildText();
    out.rebuildText = Math.round(performance.now() - t);

    // 2) 一次完整拖动：移动第 500 章到第 501 位
    t = performance.now();
    __easypub.moveChapter(500, 501);
    out.moveChapter = Math.round(performance.now() - t);
    await new Promise(r => setTimeout(r, 50));

    // 3) 连续 10 次移动（模拟连续拖放）
    t = performance.now();
    for (let i = 0; i < 10; i++) {
      __easypub.moveChapter(300 + i, 305 + i);
    }
    out.tenMoves = Math.round(performance.now() - t);
    await new Promise(r => setTimeout(r, 50));

    // 4) dragover 期间的列表重绘（拖动时每 45ms 触发一次）
    t = performance.now();
    for (let i = 0; i < 20; i++) {
      document.getElementById('chapterList').scrollTop = i * 100;
      document.getElementById('chapterList').dispatchEvent(new Event('scroll'));
      await new Promise(r => requestAnimationFrame(r));
    }
    out.scrollRedraw20 = Math.round(performance.now() - t);

    // 5) 正文完整性
    out.textLenAfter = s.text.length;
    out.firstChap = s.chapters.filter(c => c.type === 'text')[0].title;
    return out;
  })()`);

  console.log('\n=== 766 万字性能实测 ===');
  console.log('  正文长度:', res.chars, '字符 /', res.chapters, '章节');
  console.log('  单次重排全文(rebuildText):', res.rebuildText, 'ms');
  console.log('  一次完整拖动(moveChapter):', res.moveChapter, 'ms');
  console.log('  连续 10 次拖动:', res.tenMoves, 'ms  (平均', Math.round(res.tenMoves / 10), 'ms/次)');
  console.log('  拖动中滚动重绘 20 帧:', res.scrollRedraw20, 'ms  (平均', (res.scrollRedraw20 / 20).toFixed(1), 'ms/帧)');
  console.log('  拖动后正文长度:', res.textLenAfter, '(是否无损:', res.textLenAfter === res.chars, ')');
  console.log('  首章仍为:', res.firstChap);

  ws.close(); chrome.kill(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); chrome.kill(); process.exit(1); });
