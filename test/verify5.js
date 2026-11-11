/* v5 回归：换书后编辑状态隔离 + 退出编辑保存 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9234;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v5-' + Date.now());

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

  // 工具函数注入页面
  await evaluate(`
    window.__load = async (url, name) => {
      const blob = await (await fetch(url)).blob();
      __easypub.importFile(new File([blob], name, {type:'text/plain'}));
      await new Promise((res, rej) => {
        const iv = setInterval(() => { if (__easypub.state.chapters.length) { clearInterval(iv); res(); } }, 40);
        setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 30000);
      });
      await new Promise(r => setTimeout(r, 250));
      return __easypub.state.chapters.length;
    };
  `);

  console.log('\n【1】退出编辑 → 换书 → 再进编辑');
  const s1 = await evaluate(`(async () => {
    await __load('test/sample.txt', '甲书.txt');
    __easypub.toggleEdit();
    __easypub.loadChapterToEditor(3);
    const inA = document.getElementById('editArea').value.indexOf('楚光') >= 0;
    __easypub.toggleEdit();                       // 退出
    const idle = { editMode: __easypub.state.editMode, idx: __easypub.state.editingIndex };

    await __load('test/bookB.txt', '乙书.txt');
    const afterLoad = {
      idx: __easypub.state.editingIndex,
      areaLen: document.getElementById('editArea').value.length,
      chapterCount: __easypub.state.chapters.length
    };

    __easypub.toggleEdit();                       // 再进编辑
    await new Promise(r => setTimeout(r, 250));
    const v = document.getElementById('editArea').value;
    return {
      inA, idle, afterLoad,
      hasB: v.indexOf('测试乙书') >= 0,
      hasA: v.indexOf('楚光') >= 0,
      pos: document.getElementById('edPos').textContent.slice(0, 40)
    };
  })()`);
  ok('甲书编辑时内容正确', s1.inA === true);
  ok('退出后标志归位', s1.idle.editMode === false, s1.idle);
  ok('换书后编辑索引重置', s1.afterLoad.idx === -1, s1.afterLoad);
  ok('换书后编辑器已清空', s1.afterLoad.areaLen === 0);
  ok('再进编辑显示乙书内容', s1.hasB === true && s1.hasA === false, s1.pos);

  console.log('\n【2】乙书原文未被甲书污染');
  const s2 = await evaluate(`(() => {
    const s = __easypub.state;
    const bad = [];
    s.chapters.forEach((c, i) => {
      const t = s.text.slice(c.start, c.end);
      if (t.indexOf('楚光') >= 0 || t.indexOf('这游戏也太真实了') >= 0 || t.length > 2000) {
        bad.push({ i: i, len: t.length, head: t.slice(0, 18) });
      }
    });
    return { polluted: bad.length, sample: bad.slice(0, 2), textLen: s.text.length };
  })()`);
  ok('乙书正文零污染', s2.polluted === 0, s2);

  console.log('\n【3】编辑模式下直接导入新书');
  const s3 = await evaluate(`(async () => {
    // 先在乙书里编辑一章（保持编辑模式开启）
    __easypub.loadChapterToEditor(2);
    const area = document.getElementById('editArea');
    area.value = area.value + '\\n【乙书修改】';
    area.dispatchEvent(new Event('input'));
    __easypub.commitEditor();
    const dirtyB = __easypub.state.textDirty;

    // 不退出编辑，直接导入甲书
    await __load('test/sample.txt', '甲书.txt');
    const after = {
      editMode: __easypub.state.editMode,
      maskHidden: document.getElementById('editorMask').hidden,
      btnText: document.getElementById('btnEdit').textContent,
      idx: __easypub.state.editingIndex,
      areaLen: document.getElementById('editArea').value.length,
      dirty: __easypub.state.textDirty,
      chapters: __easypub.state.chapters.length
    };

    // 再进编辑应是甲书内容
    __easypub.toggleEdit();
    await new Promise(r => setTimeout(r, 250));
    const v = document.getElementById('editArea').value;
    return { dirtyB, after, hasA: v.indexOf('这游戏') >= 0 || v.indexOf('楚光') >= 0, vHead: v.slice(0, 20) };
  })()`);
  ok('乙书修改被标记', s3.dirtyB === true);
  ok('换书自动退出编辑模式', s3.after.editMode === false && s3.after.maskHidden === true, s3.after);
  ok('按钮文案复位', s3.after.btnText === '编辑原文');
  ok('编辑器被清空', s3.after.areaLen === 0);
  ok('换书后 dirty 归零', s3.after.dirty === false);
  ok('再进编辑显示甲书内容', s3.hasA === true, s3.vHead);

  console.log('\n【4】退出编辑时最后修改必须保存');
  const s4 = await evaluate(`(async () => {
    __easypub.loadChapterToEditor(6);
    const c = __easypub.state.chapters[6];
    const area = document.getElementById('editArea');
    area.value = area.value + '\\n【退出前最后一句】';
    area.dispatchEvent(new Event('input'));

    __easypub.toggleEdit();   // 直接退出（无 blur）
    await new Promise(r => setTimeout(r, 120));
    return {
      saved: __easypub.state.text.slice(c.start, c.end).indexOf('【退出前最后一句】') >= 0,
      editMode: __easypub.state.editMode,
      dirty: __easypub.state.textDirty
    };
  })()`);
  ok('退出时的修改已落盘', s4.saved === true);
  ok('退出后 dirty 正确', s4.dirty === true && s4.editMode === false, s4);

  console.log('\n【5】同书重新分章保留「已编辑」状态');
  const s5 = await evaluate(`(async () => {
    __easypub.resplit(false);
    await new Promise(r => setTimeout(r, 400));
    return {
      dirty: __easypub.state.textDirty,
      txtDisabled: document.getElementById('btnDownloadTxt').disabled,
      keepEdit: __easypub.state.text.indexOf('【退出前最后一句】') >= 0
    };
  })()`);
  ok('重新分章后内容保留', s5.keepEdit === true);
  ok('已编辑状态保留', s5.dirty === true && s5.txtDisabled === false, s5);

  console.log('\n【6】重新导入同一本书 = 视为换书');
  const s6 = await evaluate(`(async () => {
    await __load('test/sample.txt', '甲书.txt');
    return {
      dirty: __easypub.state.textDirty,
      txtDisabled: document.getElementById('btnDownloadTxt').disabled,
      idx: __easypub.state.editingIndex,
      clean: __easypub.state.text.indexOf('【退出前最后一句】') < 0
    };
  })()`);
  ok('重新导入后 dirty 归零', s6.dirty === false && s6.txtDisabled === true, s6);
  ok('重新导入后回到原始内容', s6.clean === true);

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
