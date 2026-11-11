/* 端到端验证 v2：覆盖批量选择、自定义 CSS、文件名、规则构建器 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9225;
const URL = 'http://127.0.0.1:8848/index.html';
const profile = path.join(os.tmpdir(), 'cdp-v2-' + Date.now());

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--window-size=1500,940',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const pg = list.find(t => t.type === 'page');
      if (pg) return pg.webSocketDebuggerUrl;
    } catch (e) { /* wait */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (detail ? '  → ' + JSON.stringify(detail) : ''));
}

(async () => {
  const ws = new WebSocket(await getWsUrl());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const errors = [];

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text);
    }
  };

  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(1500);

  console.log('\n【1】页面初始化');
  const boot = await evaluate(`({
    status: document.getElementById('statusText').textContent,
    tabs: document.querySelectorAll('.tab').length,
    reg: document.getElementById('effectiveReg').textContent,
    name: document.getElementById('namePreview').textContent
  })`);
  ok('页面加载', boot.status.indexOf('就绪') === 0, boot);
  ok('六个 tab 就位', boot.tabs === 6, boot.tabs);
  ok('默认正则已生成', boot.reg.indexOf('第') > 0, boot.reg.slice(0, 70));

  console.log('\n【2】导入 766 万字 TXT');
  const imp = await evaluate(`(async () => {
    const t0 = performance.now();
    const blob = await (await fetch('test/sample.txt')).blob();
    __easypub.importFile(new File([blob], '这游戏也太真实了_晨星LL.txt', {type:'text/plain'}));
    await new Promise((res, rej) => {
      const iv = setInterval(() => { if (__easypub.state.chapters.length) { clearInterval(iv); res(); } }, 50);
      setTimeout(() => { clearInterval(iv); rej(new Error('超时')); }, 30000);
    });
    await new Promise(r => setTimeout(r, 300));
    return { ms: Math.round(performance.now() - t0), n: __easypub.state.chapters.length,
             title: __easypub.state.meta.title, author: __easypub.state.meta.author };
  })()`);
  ok('分章 1076 章', imp.n === 1076, imp);
  ok('元数据自动填充', imp.title === '这游戏也太真实了' && imp.author === '晨星LL');

  console.log('\n【3】文件名规则');
  const nm = await evaluate(`({
    preview: document.getElementById('namePreview').textContent,
    actual: __easypub.outputName()
  })`);
  ok('文件名 = 书名_作者.epub', nm.actual === '这游戏也太真实了_晨星LL.epub', nm);

  const nmOff = await evaluate(`(() => {
    const cb = document.getElementById('nameWithAuthor');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    const r = document.getElementById('namePreview').textContent;
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    return { off: r, on: document.getElementById('namePreview').textContent };
  })()`);
  ok('可切换为纯书名', nmOff.off === '这游戏也太真实了.epub', nmOff);

  console.log('\n【4】分章规则：可视化构建器');
  const ruleTest = await evaluate(`(async () => {
    const before = document.getElementById('effectiveReg').textContent;
    // 取消「卷」后缀，只留章/回
    const chip = document.querySelector('#suffixChips .chip[data-v="卷"]');
    chip.click();
    await new Promise(r => setTimeout(r, 500));
    const after = document.getElementById('effectiveReg').textContent;
    const box = document.getElementById('rulePreview').textContent;
    chip.click();
    await new Promise(r => setTimeout(r, 500));
    return { before, after, afterBox: box, restored: document.getElementById('effectiveReg').textContent };
  })()`);
  ok('chip 变化即时改写正则', ruleTest.before !== ruleTest.after, {
    前: ruleTest.before.slice(0, 60), 后: ruleTest.after.slice(0, 60)
  });
  ok('实时显示预计识别数', /预计识别 \d+ 章/.test(ruleTest.afterBox), ruleTest.afterBox);

  const presetTest = await evaluate(`(async () => {
    const sel = document.getElementById('rulePreset');
    sel.value = 'en';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
    const enReg = document.getElementById('effectiveReg').textContent;
    const enBox = document.getElementById('rulePreview').textContent;
    sel.value = 'cn';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
    const cnBox = document.getElementById('rulePreview').textContent;
    return { enReg, enBox, cnBox };
  })()`);
  ok('英文预设生成 Chapter 正则', /Chapter/i.test(presetTest.enReg), presetTest.enReg.slice(0, 60));
  ok('切换预设刷新识别数', /\d+/.test(presetTest.cnBox), presetTest.cnBox);

  console.log('\n【5】批量选择');
  const selTest = await evaluate(`(async () => {
    const list = document.getElementById('chapterList');
    list.scrollTop = 0;
    await new Promise(r => setTimeout(r, 100));
    const click = (idx, mod) => {
      const row = document.querySelector('.chapter-row[data-idx="' + idx + '"]');
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', Object.assign({bubbles:true}, mod||{})));
      return true;
    };
    click(0);
    const single = __easypub.selCount();
    click(5, {ctrlKey:true});
    const ctrl = __easypub.selCount();
    click(10, {shiftKey:true});
    const shift = __easypub.selCount();
    const barVisible = !document.getElementById('bulkBar').hidden;
    const selectedRows = document.querySelectorAll('.chapter-row.is-selected').length;
    return { single, ctrl, shift, barVisible, selectedRows, bulkCount: document.getElementById('bulkCount').textContent };
  })()`);
  ok('单击选中 1 章', selTest.single === 1, selTest.single);
  ok('Ctrl 加选 → 2 章', selTest.ctrl === 2, selTest.ctrl);
  ok('Shift 连选 → 7 章(锚点5 → 0,5..10)', selTest.shift === 7, selTest.shift);
  ok('批量条自动出现', selTest.barVisible === true);

  console.log('\n【6】批量设置层级');
  const lvlTest = await evaluate(`(async () => {
    const before = __easypub.state.chapters.map(c => c.level).slice(0, 11);
    __easypub.applyBulk('level-1');
    await new Promise(r => setTimeout(r, 100));
    const after = __easypub.state.chapters.map(c => c.level).slice(0, 11);
    const selIdx = Object.keys(__easypub.state.selection).map(Number);
    const allOne = selIdx.every(i => __easypub.state.chapters[i].level === 1);
    const untouched = __easypub.state.chapters[3].level === before[3];
    // 还原
    selIdx.forEach(i => { __easypub.state.chapters[i].level = 2; });
    __easypub.applyBulk('clear');
    return { allOne, untouched, before, after, cleared: __easypub.selCount() };
  })()`);
  ok('批量全部设为 1 级', lvlTest.allOne === true, lvlTest.after);
  ok('未选中的章节不受影响', lvlTest.untouched === true);
  ok('取消选择生效', lvlTest.cleared === 0);

  console.log('\n【7】自定义 CSS');
  const cssTest = await evaluate(`(async () => {
    const ta = document.getElementById('customCss');
    ta.value = 'p { text-indent: 0; }\\nh2.titlel2std { color: #c00; }';
    ta.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 500));
    const merged = __easypub.finalCSS();
    const status = document.getElementById('cssStatus').textContent;
    return {
      hasCustom: merged.indexOf('#c00') > 0,
      hasBase: merged.indexOf('Generated by EasyPub') > 0,
      status,
      len: merged.length
    };
  })()`);
  ok('追加模式保留基础样式', cssTest.hasBase === true);
  ok('自定义规则写入 style.css', cssTest.hasCustom === true, cssTest.status);

  const replaceTest = await evaluate(`(async () => {
    document.querySelector('#cssMode button[data-val="replace"]').click();
    await new Promise(r => setTimeout(r, 200));
    const only = __easypub.finalCSS();
    document.querySelector('#cssMode button[data-val="append"]').click();
    await new Promise(r => setTimeout(r, 200));
    return { replaceHasBase: only.indexOf('Generated by EasyPub') >= 0, len: only.length };
  })()`);
  ok('替换模式剥离基础样式', replaceTest.replaceHasBase === false, replaceTest.len + ' 字符');

  console.log('\n【8】生成 EPUB');
  const dlDir = path.join(__dirname, 'dl');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

  const buildRes = await evaluate(`(async () => {
    const t0 = performance.now();
    __easypub.build();
    await new Promise((res, rej) => {
      const iv = setInterval(() => {
        const t = document.getElementById('statusText').textContent;
        if (t.indexOf('完成') === 0 || t.indexOf('失败') === 0) { clearInterval(iv); res(); }
      }, 100);
      setTimeout(() => { clearInterval(iv); rej(new Error('生成超时')); }, 60000);
    });
    return { ms: Math.round(performance.now() - t0), status: document.getElementById('statusText').textContent };
  })()`);
  ok('生成成功', buildRes.status.indexOf('完成') === 0, buildRes.status);

  let file = null;
  for (let i = 0; i < 60; i++) {
    const list = fs.readdirSync(dlDir).filter(f => f.endsWith('.epub'));
    if (list.length) { file = path.join(dlDir, list[0]); break; }
    await sleep(200);
  }
  ok('下载文件名为 书名_作者.epub', file && path.basename(file) === '这游戏也太真实了_晨星LL.epub',
    file ? path.basename(file) : '无文件');

  if (file) {
    const target = path.join(__dirname, 'v2-out.epub');
    fs.renameSync(file, target);
    console.log('  文件:', path.basename(target), (fs.statSync(target).size / 1048576).toFixed(2), 'MB');
  }

  console.log('\n【9】截图');
  await evaluate(`document.querySelector('.tab[data-tab="split"]').click()`);
  await sleep(400);
  const s1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, 'v2-split.png'), Buffer.from(s1.data, 'base64'));

  await evaluate(`document.querySelector('.tab[data-tab="style"]').click()`);
  await sleep(400);
  const s2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, 'v2-style.png'), Buffer.from(s2.data, 'base64'));

  await evaluate(`document.querySelector('.tab[data-tab="meta"]').click();
    const r = document.querySelector('.chapter-row[data-idx="5"]'); if (r) r.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));`);
  await sleep(400);
  const s3 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, 'v2-bulk.png'), Buffer.from(s3.data, 'base64'));
  console.log('  已保存 v2-split.png / v2-style.png / v2-bulk.png');

  console.log('\n=== 汇总 ===');
  const pass = results.filter(r => r.pass).length;
  console.log(`${pass}/${results.length} 通过`);
  if (errors.length) {
    console.log('控制台错误:');
    errors.slice(0, 8).forEach(e => console.log('  ✗', String(e).slice(0, 200)));
  } else {
    console.log('无控制台错误');
  }

  ws.close();
  chrome.kill();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  console.error('测试异常:', e.message);
  chrome.kill();
  process.exit(1);
});
