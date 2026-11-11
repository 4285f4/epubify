/* v4 回归：还原本章（含 blur 先于 click 的真实时序） */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9232;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v4-' + Date.now());

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

  console.log('\n【准备】导入');
  await evaluate(`(async () => {
    const blob = await (await fetch('test/sample.txt')).blob();
    __easypub.importFile(new File([blob], '这游戏也太真实了_晨星LL.txt', {type:'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__easypub.state.chapters.length) { clearInterval(iv); res(); } }, 50);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 30000);
    });
    await new Promise(r => setTimeout(r, 300));
    __easypub.toggleEdit();
  })()`);
  console.log('  完成');

  console.log('\n【1】修改 → 切换章节提交 → 还原（模拟真实 blur→click 时序）');
  const t1 = await evaluate(`(async () => {
    const s = __easypub.state;
    const IDX = 5;
    __easypub.loadChapterToEditor(IDX);
    const c = s.chapters[IDX];
    const orig = s.text.slice(c.start, c.end);
    const nextStartBefore = s.chapters[IDX + 1].start;

    const area = document.getElementById('editArea');
    area.value = area.value + '\\n【MOD-1】';
    area.dispatchEvent(new Event('input'));

    // 切换章节 → 触发提交
    __easypub.loadChapterToEditor(IDX + 1);
    await new Promise(r => setTimeout(r, 100));
    const afterCommit = {
      dirty: s.textDirty,
      changed: s.text.slice(c.start, c.end) !== orig,
      nextShifted: s.chapters[IDX + 1].start - nextStartBefore
    };

    // 回到该章，模拟真实点击：textarea 先 blur，再点按钮
    __easypub.loadChapterToEditor(IDX);
    await new Promise(r => setTimeout(r, 100));
    area.dispatchEvent(new Event('blur'));
    document.getElementById('edRevert').click();
    await new Promise(r => setTimeout(r, 150));

    const restored = s.text.slice(c.start, c.end);
    return {
      afterCommit,
      restoredEqualsOrig: restored === orig,
      restoredLen: restored.length,
      origLen: orig.length,
      nextBack: s.chapters[IDX + 1].start - nextStartBefore,
      dirtyAfter: s.textDirty,
      txtBtnDisabled: document.getElementById('btnDownloadTxt').disabled,
      originalsLeft: Object.keys(s.originals).length,
      stat: document.getElementById('edStat').textContent
    };
  })()`);
  ok('提交后标记为已修改', t1.afterCommit.dirty === true && t1.afterCommit.changed === true, t1.afterCommit);
  ok('还原后内容与原文完全一致', t1.restoredEqualsOrig === true, t1.restoredLen + ' 字符');
  ok('后续章节偏移量正确回退', t1.nextBack === 0, 'delta=' + t1.nextBack);
  ok('还原后 dirty 归零', t1.dirtyAfter === false);
  ok('下载 TXT 按钮重新禁用', t1.txtBtnDisabled === true);
  ok('originals 记录已清除', t1.originalsLeft === 0, t1.stat);

  console.log('\n【2】未提交直接还原');
  const t2 = await evaluate(`(async () => {
    const s = __easypub.state;
    const IDX = 8;
    __easypub.loadChapterToEditor(IDX);
    const c = s.chapters[IDX];
    const orig = s.text.slice(c.start, c.end);
    const area = document.getElementById('editArea');
    area.value = '乱改的内容';
    area.dispatchEvent(new Event('input'));
    document.getElementById('edRevert').click();
    await new Promise(r => setTimeout(r, 120));
    return {
      valueRestored: area.value === orig,
      textRestored: s.text.slice(c.start, c.end) === orig,
      dirty: s.textDirty
    };
  })()`);
  ok('文本框已还原', t2.valueRestored === true);
  ok('原文已还原', t2.textRestored === true);
  ok('未产生脏标记', t2.dirty === false);

  console.log('\n【3】手工改回原样应自动取消 dirty');
  const t3 = await evaluate(`(async () => {
    const s = __easypub.state;
    const IDX = 12;
    __easypub.loadChapterToEditor(IDX);
    const c = s.chapters[IDX];
    const orig = s.text.slice(c.start, c.end);
    const area = document.getElementById('editArea');

    area.value = orig + '\\n【TEMP】';
    area.dispatchEvent(new Event('input'));
    __easypub.commitEditor();
    const dirty1 = s.textDirty;

    area.value = orig;
    area.dispatchEvent(new Event('input'));
    __easypub.commitEditor();
    await new Promise(r => setTimeout(r, 100));
    return { dirty1, dirty2: s.textDirty, identical: s.text.slice(c.start, c.end) === orig };
  })()`);
  ok('改动后 dirty=true', t3.dirty1 === true);
  ok('改回原样后 dirty 自动归零', t3.dirty2 === false, t3);

  console.log('\n【4】多章修改后逐章还原');
  const t4 = await evaluate(`(async () => {
    const s = __easypub.state;
    const idxs = [20, 21, 22];
    const origs = {};
    idxs.forEach(i => { origs[i] = s.text.slice(s.chapters[i].start, s.chapters[i].end); });

    for (const i of idxs) {
      __easypub.loadChapterToEditor(i);
      const area = document.getElementById('editArea');
      area.value = area.value + '\\n【M' + i + '】';
      area.dispatchEvent(new Event('input'));
      __easypub.commitEditor();
    }
    const allDirty = { count: Object.keys(s.originals).length, dirty: s.textDirty };

    const reverted = [];
    for (const i of idxs) {
      __easypub.loadChapterToEditor(i);
      document.getElementById('edRevert').click();
      await new Promise(r => setTimeout(r, 60));
      reverted.push(s.text.slice(s.chapters[i].start, s.chapters[i].end) === origs[i]);
    }
    return { allDirty, reverted, finalDirty: s.textDirty, left: Object.keys(s.originals).length };
  })()`);
  ok('三章分别记录', t4.allDirty.count === 3, t4.allDirty);
  ok('三章逐个还原成功', t4.reverted.every(Boolean), t4.reverted);
  ok('全部还原后 dirty 归零', t4.finalDirty === false && t4.left === 0);

  console.log('\n【5】还原后再修改仍可正常工作');
  const t5 = await evaluate(`(async () => {
    const s = __easypub.state;
    const IDX = 30;
    __easypub.loadChapterToEditor(IDX);
    const c = s.chapters[IDX];
    const orig = s.text.slice(c.start, c.end);
    const area = document.getElementById('editArea');

    area.value = orig + '\\n【A】';
    area.dispatchEvent(new Event('input'));
    __easypub.commitEditor();
    document.getElementById('edRevert').click();
    await new Promise(r => setTimeout(r, 80));

    area.value = s.text.slice(c.start, c.end) + '\\n【B】';
    area.dispatchEvent(new Event('input'));
    __easypub.commitEditor();
    await new Promise(r => setTimeout(r, 80));
    const hasB = s.text.slice(c.start, c.end).indexOf('【B】') >= 0;
    document.getElementById('edRevert').click();
    await new Promise(r => setTimeout(r, 80));
    return { hasB, backToOrig: s.text.slice(c.start, c.end) === orig, dirty: s.textDirty };
  })()`);
  ok('还原后可再次修改', t5.hasB === true);
  ok('再次还原仍有效', t5.backToOrig === true, t5);

  console.log('\n【6】还原后生成 EPUB 不含残留内容');
  const dlDir = path.join(__dirname, 'dl');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  const buildRes = await evaluate(`(async () => {
    __easypub.toggleEdit();
    __easypub.build();
    await new Promise((res, rej) => {
      const iv = setInterval(() => {
        const t = document.getElementById('statusText').textContent;
        if (t.indexOf('完成') === 0 || t.indexOf('失败') === 0) { clearInterval(iv); res(); }
      }, 100);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 60000);
    });
    return document.getElementById('statusText').textContent;
  })()`);
  ok('生成成功', buildRes.indexOf('完成') === 0, buildRes);

  await sleep(600);
  let epub = null;
  for (let i = 0; i < 50; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.epub'));
    if (l.length) { epub = path.join(dlDir, l[0]); break; }
    await sleep(200);
  }
  if (epub) {
    fs.renameSync(epub, path.join(__dirname, 'v4-out.epub'));
    console.log('  已保存 v4-out.epub');
  }

  console.log('\n=== 汇总 ===');
  const pass = results.filter(r => r.pass).length;
  console.log(`${pass}/${results.length} 通过`);
  if (errors.length) {
    console.log('控制台错误:');
    errors.slice(0, 6).forEach(e => console.log('  ✗', String(e).slice(0, 180)));
  } else console.log('无控制台错误');

  ws.close(); chrome.kill();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('测试异常:', e.message); chrome.kill(); process.exit(1); });
