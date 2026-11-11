/* 无头验证：用真实 766 万字 txt 走完整链路，产出 epub */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..');
const ctx = {
  console, TextEncoder, TextDecoder, CompressionStream, Response, Blob,
  Date, Math, Uint8Array, Int32Array, Array, Object, String, Number, Promise, RegExp, JSON, parseInt, isNaN
};
ctx.self = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['zip.js', 'text.js', 'epub.js']) {
  vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'), ctx, { filename: f });
}
const { EasyText, EasyEpub } = ctx;

(async () => {
  const SRC = path.join(WEB, '..', '这游戏也太真实了_晨星LL.txt');
  const buf = fs.readFileSync(SRC);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  let t0 = Date.now();
  const { text, encoding } = EasyText.decodeBuffer(ab);
  console.log(`解码: ${encoding}, ${text.length} 字符, ${Date.now() - t0} ms`);

  t0 = Date.now();
  const chapters = EasyText.parseChapters(text, {});
  console.log(`分章: ${chapters.length} 章, ${Date.now() - t0} ms`);
  console.log(`  首章: "${chapters[0].title}" (${chapters[0].chars} 字) lv${chapters[0].level}`);
  console.log(`  次章: "${chapters[1].title}" (${chapters[1].chars} 字) lv${chapters[1].level}`);
  console.log(`  末章: "${chapters[chapters.length - 1].title}" (${chapters[chapters.length - 1].chars} 字)`);
  const emptyish = chapters.filter(c => c.chars < 100).length;
  console.log(`  疑似空章(<100字): ${emptyish} 个`);

  // 组装章节 HTML（剔除首行标题）
  t0 = Date.now();
  const items = chapters.map(c => {
    const raw = text.slice(c.start, c.end);
    const nl = raw.indexOf('\n');
    const bodyText = nl >= 0 ? raw.slice(nl + 1) : '';
    return { title: c.title, level: c.level, html: EasyText.toXHTML(bodyText, { indent: true }) };
  });
  console.log(`正文转换: ${Date.now() - t0} ms`);

  const coverBytes = fs.existsSync(path.join(WEB, '..', 'cover.jpg')) ? new Uint8Array(fs.readFileSync(path.join(WEB, '..', 'cover.jpg'))) : null;

  t0 = Date.now();
  const blob = await EasyEpub.buildEPUB({
    meta: { title: '这游戏也太真实了', author: '晨星LL', language: 'zh-CN', subject: '小说' },
    chapters: items,
    cover: coverBytes ? { bytes: coverBytes, mime: 'image/jpeg', width: 600, height: 800 } : null,
    tocPage: true,
    cssOpt: {}
  });
  const out = path.join(__dirname, 'out.epub');
  fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
  const size = fs.statSync(out).size;
  console.log(`打包: ${Date.now() - t0} ms, 输出 ${(size / 1048576).toFixed(2)} MB`);
  console.log(`deflate 可用: ${ctx.EasyZip.hasDeflate()}`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
