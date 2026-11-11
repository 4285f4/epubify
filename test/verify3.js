/* v3 回归：目录页默认值、长串换行、原文编辑与 TXT 导出 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9227;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v3-' + Date.now());

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

  let id = 0;
  const pending = new Map();
  const errors = [];
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

  console.log('\n【1】目录页选项');
  const toc = await evaluate(`({
    checked: document.getElementById('mTocPage').checked,
    label: document.getElementById('mTocPage').parentElement.textContent.trim(),
    stateVal: __easypub.state.meta.tocPage
  })`);
  ok('默认不勾选', toc.checked === false && toc.stateVal === false, toc);
  ok('文案已改', toc.label.indexOf('在正文前插入目录页') >= 0, toc.label);

  console.log('\n【2】长分隔符换行');
  const cssTest = await evaluate(`(() => {
    const css = EasyEpub.buildCSS({});
    const pRule = css.split('\\n').filter(l => /overflow-wrap|word-break/.test(l));
    return { hasWrap: /overflow-wrap:\\s*anywhere/.test(css), rules: pRule.length };
  })()`);
  ok('样式含换行规则', cssTest.hasWrap === true, cssTest);

  console.log('\n【3】导入');
  const imp = await evaluate(`(async () => {
    const blob = await (await fetch('test/sample.txt')).blob();
    __easypub.importFile(new File([blob], '这游戏也太真实了_晨星LL.txt', {type:'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__easypub.state.chapters.length) { clearInterval(iv); res(); } }, 50);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 30000);
    });
    await new Promise(r => setTimeout(r, 300));
    __easypub.loadChapterToEditor(0);   // 确保编辑模块可用
    return { n: __easypub.state.chapters.length,
             editBtn: !document.getElementById('btnEdit').disabled,
             txtBtn: document.getElementById('btnDownloadTxt').disabled };
  })()`);
  ok('导入 1076 章', imp.n === 1076, imp.n);
  ok('编辑按钮可用', imp.editBtn === true);
  ok('TXT 按钮初始禁用', imp.txtBtn === true);

  console.log('\n【4】进入编辑模式');
  const enter = await evaluate(`(async () => {
    __easypub.toggleEdit();
    await new Promise(r => setTimeout(r, 200));
    const area = document.getElementById('editArea');
    return {
      maskOn: document.getElementById('editorMask').classList.contains('on'),
      len: area.value.length,
      pos: document.getElementById('edPos').textContent.slice(0, 50),
      stat: document.getElementById('edStat').textContent,
      matchesChapter: area.value.length === (__easypub.state.chapters[__easypub.state.editingIndex].end - __easypub.state.chapters[__easypub.state.editingIndex].start)
    };
  })()`);
  ok('编辑器已打开', enter.maskOn === true);
  ok('载入单章内容（非全文）', enter.len > 100 && enter.len < 50000, enter.len + ' 字符');
  ok('内容与章节区间一致', enter.matchesChapter === true, enter.stat);

  console.log('\n【5】编辑并验证偏移量平移');
  const editTest = await evaluate(`(async () => {
    const s = __easypub.state;
    const idx = 5;
    __easypub.loadChapterToEditor(idx);
    const c5 = s.chapters[idx];
    const c6 = s.chapters[idx + 1];
    const c6StartBefore = c6.start;
    const c6HeadBefore = s.text.slice(c6.start, c6.start + 30);

    const area = document.getElementById('editArea');
    const MARK = '\\n【手工添加的内容】';
    area.value = area.value + MARK;
    area.dispatchEvent(new Event('input'));
    const statDirty = document.getElementById('edStat').className.indexOf('dirty') >= 0;

    // 切到下一章 → 触发自动保存
    __easypub.loadChapterToEditor(idx + 1);
    await new Promise(r => setTimeout(r, 150));

    const c6After = s.chapters[idx + 1];
    const c6HeadAfter = s.text.slice(c6After.start, c6After.start + 30);
    const delta = c6After.start - c6StartBefore;
    return {
      statDirty,
      delta,
      markInText: s.text.indexOf('【手工添加的内容】') >= 0,
      c6HeadIntact: c6HeadBefore === c6HeadAfter,
      c6HeadBefore: c6HeadBefore.slice(0, 20),
      c6HeadAfter: c6HeadAfter.slice(0, 20),
      txtBtn: document.getElementById('btnDownloadTxt').disabled,
      originals: Object.keys(s.originals).length,
      newLen: c5.end - c5.start
    };
  })()`);
  ok('编辑态标记为已修改', editTest.statDirty === true);
  ok('后续章节偏移量正确平移', editTest.delta === 10, 'delta=' + editTest.delta);
  ok('下一章内容未被破坏', editTest.c6HeadIntact === true, [editTest.c6HeadBefore, editTest.c6HeadAfter]);
  ok('原文已包含新增内容', editTest.markInText === true);
  ok('下载 TXT 按钮变为可用', editTest.txtBtn === false);

  console.log('\n【6】长分隔符不产生横向滚动');
  const overflowTest = await evaluate(`(async () => {
    const s = __easypub.state;
    __easypub.loadChapterToEditor(7);
    const area = document.getElementById('editArea');
    area.value = area.value + '\\n' + '='.repeat(90) + '\\n';
    area.dispatchEvent(new Event('input'));
    __easypub.commitEditor();
    __easypub.toggleEdit();  // 退出编辑

    document.querySelector('.tab[data-tab="preview"]').click();
    document.querySelector('#previewDevice button[data-val="phone"]').click();
    s.previewIdx = 7;
    document.getElementById('previewChapter').value = '7';
    document.getElementById('previewChapter').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 700));

    const doc = document.getElementById('previewFrame').contentDocument;
    const cw = doc.documentElement.clientWidth;
    const wide = Array.prototype.slice.call(doc.querySelectorAll('body *'))
      .filter(function (el) { return el.getBoundingClientRect().right > cw + 0.5; })
      .slice(0, 5)
      .map(function (el) { return el.tagName + '.' + (el.className || '') + '@' + Math.round(el.getBoundingClientRect().right); });
    // 真实判据：能否横向滚动
    doc.documentElement.scrollLeft = 999;
    const scrolledX = doc.documentElement.scrollLeft;
    doc.documentElement.scrollLeft = 0;
    const inner = Array.prototype.slice.call(doc.querySelectorAll('body *'))
      .filter(function (el) { return el.scrollWidth > el.clientWidth + 0.5; })
      .slice(0, 5)
      .map(function (el) {
        var cs = getComputedStyle(el);
        return {
          t: el.tagName + '.' + (el.className || ''),
          sw: el.scrollWidth, cw: el.clientWidth,
          h: Math.round(el.getBoundingClientRect().height),
          fs: cs.fontSize, ti: cs.textIndent, ws: cs.wordWrap + '/' + cs.overflowWrap,
          len: el.textContent.length,
          txt: el.textContent.slice(0, 24)
        };
      });
    return {
      scrollW: doc.documentElement.scrollWidth,
      clientW: cw,
      scrolledX: scrolledX,
      canScrollX: scrolledX > 0,
      hasEq: doc.body.textContent.indexOf('=====') >= 0,
      wide: wide,
      inner: inner,
      bodyW: Math.round(doc.body.getBoundingClientRect().width),
      bodyPad: getComputedStyle(doc.body).padding
    };
  })()`);
  ok('等号串已在预览中', overflowTest.hasEq === true);
  ok('无横向滚动', overflowTest.canScrollX === false, overflowTest);

  console.log('\n【8】导出 TXT');
  const dlDir = path.join(__dirname, 'dl');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  await evaluate(`__easypub.downloadText()`);
  let txtFile = null;
  for (let i = 0; i < 50; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.txt'));
    if (l.length) { txtFile = path.join(dlDir, l[0]); break; }
    await sleep(200);
  }
  ok('导出文件名正确', txtFile && path.basename(txtFile) === '这游戏也太真实了_晨星LL.txt',
    txtFile ? path.basename(txtFile) : '无文件');
  if (txtFile) {
    const content = fs.readFileSync(txtFile, 'utf8');
    ok('导出内容含手工修改', content.indexOf('【手工添加的内容】') >= 0);
    ok('导出内容含长分隔符', content.indexOf('='.repeat(90)) >= 0);
    ok('导出体积合理', content.length > 7600000, (content.length / 1e4).toFixed(0) + ' 万字');
  }

  console.log('\n【9】生成 EPUB（目录页默认关闭）');
  const buildRes = await evaluate(`(async () => {
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
  let epubFile = null;
  for (let i = 0; i < 50; i++) {
    const l = fs.readdirSync(dlDir).filter(f => f.endsWith('.epub'));
    if (l.length) { epubFile = path.join(dlDir, l[0]); break; }
    await sleep(200);
  }
  if (epubFile) {
    fs.renameSync(epubFile, path.join(__dirname, 'v3-out.epub'));
    console.log('  文件已保存 v3-out.epub');
  }

  console.log('\n【10】截图');
  await evaluate(`__easypub.toggleEdit(); __easypub.loadChapterToEditor(5);`);
  await sleep(500);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, 'v3-editor.png'), Buffer.from(shot.data, 'base64'));
  console.log('  v3-editor.png');

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
