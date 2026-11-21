/**
 * 准备部署产物：把运行必需的文件复制到 dist/
 *
 * 为什么不直接把项目根作为 assets 目录：
 * Wrangler 在 assets.directory 指向项目根时不会读取 .assetsignore，
 * 会把 .git、test/ 一并上传（.git 暴露等于公开全部提交历史）。
 *
 * 同时生成 js/version.js（版本号 / 构建时间 / 提交哈希），
 * 供「关于」弹窗展示，用于确认线上运行的是哪一次部署。
 *
 * 用法：node scripts/build-assets.mjs
 */
import { cp, rm, mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const ENTRIES = ['index.html', 'css', 'js', 'LICENSE'];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

let count = 0;
for (const name of ENTRIES) {
  const from = path.join(root, name);
  try {
    await stat(from);
  } catch {
    console.warn(`跳过（不存在）: ${name}`);
    continue;
  }
  await cp(from, path.join(dist, name), { recursive: true });
  count++;
}

/* ---- 版本信息 ---- */
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const now = new Date();
const p2 = n => String(n).padStart(2, '0');
const buildTime =
  `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ` +
  `${p2(now.getHours())}:${p2(now.getMinutes())}`;

let commit = '';
try {
  commit = execSync('git rev-parse --short HEAD', {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore']
  }).toString().trim();
} catch {
  // 非 git 环境（例如直接解压发布包）时留空
}

const repo = pkg.repository
  ? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url)
  : '';

const versionJs =
  '/* 由 scripts/build-assets.mjs 生成，请勿手动修改 */\n' +
  'window.__BUILD_INFO = ' +
  JSON.stringify({ version: pkg.version, buildTime, commit, repo }, null, 2) +
  ';\n';

await writeFile(path.join(dist, 'js', 'version.js'), versionJs, 'utf8');

/* ---- 把 version.js 引入 dist 的 index.html ---- */
const idxPath = path.join(dist, 'index.html');
let html = await readFile(idxPath, 'utf8');
if (html.indexOf('js/version.js') < 0) {
  html = html.replace(
    '<script src="js/app.js"></script>',
    '<script src="js/version.js"></script>\n<script src="js/app.js"></script>'
  );
  await writeFile(idxPath, html, 'utf8');
}

console.log(
  `已复制 ${count} 项到 dist/，版本 ${pkg.version}` +
  (commit ? ` (${commit})` : '') +
  `，构建于 ${buildTime}`
);
