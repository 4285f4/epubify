/**
 * 准备部署产物：把运行必需的文件复制到 dist/
 *
 * 为什么不直接把项目根作为 assets 目录：
 * Wrangler 在 assets.directory 指向项目根时不会读取 .assetsignore，
 * 会把 .git、test/ 一并上传（.git 暴露等于公开全部提交历史）。
 *
 * 用法：node scripts/build-assets.mjs
 */
import { cp, rm, mkdir, stat } from 'node:fs/promises';
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

console.log(`已复制 ${count} 项到 dist/，可直接用 wrangler 部署`);
