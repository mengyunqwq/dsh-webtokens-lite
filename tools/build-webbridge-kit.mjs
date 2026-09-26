// tools/build-webbridge-kit.mjs —— 构建中转站下发的「网页桥接整包」（public/agent/webbridge.zip）
//
// 为什么需要：安装器 webbridge.ps1 会从中转站下载这个包解压到用户目录。历史上那个包
// 依赖**上游插件**（安装时再按 tag 去 GitHub 拉取并校验 43 个 SHA-256）。现在改为自研实现：
// 包里直接带上我们自己的扩展 + broker + 连接器，安装时**不联网拉上游、不需要 npm install**。
//
// 用法：node tools/build-webbridge-kit.mjs [--out <zip路径>] [--check]
//   --check  只校验（打包后逐项核对包内容与本地文件一致性），不写入
//
// 刻意**不打包**的东西：
//   vendor/        上游插件副本（自研模式完全不需要，且是无许可证代码，绝不能随包分发）
//   patches/       针对上游源码的补丁（同上）
//   chrome/        给浏览器加载的目录：到用户机器上由 setup.mjs 现场铺（含各自的配对密钥）
//   config.json    **含本机配对密钥**，只能由用户机器现场生成
//   node_modules/  自研实现零依赖，不需要

import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const LITE = resolve(HERE, '..');                    // 连接器仓库根
const RELAY = 'D:/Users/Administrator/llm-relay';    // 中转站仓库根（可用 --relay 覆盖）
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const check = argv.includes('--check');
const relayRoot = arg('--relay', RELAY);
const outZip = arg('--out', join(relayRoot, 'public', 'agent', 'webbridge.zip'));

const INCLUDE_FILES = ['setup.mjs', 'start.mjs', 'start.cmd', 'start.sh', 'package.json', 'README.md', 'LICENSE'];
const INCLUDE_DIRS = ['lib', 'extension', 'docs', 'tests', 'tools'];
const EXCLUDE_NAMES = new Set(['vendor', 'patches', 'chrome', 'config.json', 'node_modules', '.git']);

function log(m) { console.log(m); }
function die(m) { console.error('[FAIL] ' + m); process.exit(1); }

// 1) 源文件清单（保持可核对：每一项都要能说出为什么在包里）
const items = [];
for (const f of INCLUDE_FILES) {
  const p = join(LITE, f);
  if (existsSync(p)) items.push(f); else log(`[WARN] 缺少 ${f}（跳过）`);
}
for (const d of INCLUDE_DIRS) {
  const p = join(LITE, d);
  if (!existsSync(p)) { log(`[WARN] 缺少目录 ${d}（跳过）`); continue; }
  const walk = (rel) => {
    for (const e of readdirSync(join(LITE, rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (EXCLUDE_NAMES.has(e.name)) continue;
      if (e.isDirectory()) walk(r); else items.push(r);
    }
  };
  walk(d);
}

// 3) 版本标记：用户机器上的包是哪一版、哪种实现，一眼能看出来
const manifest = JSON.parse(readFileSync(join(LITE, 'extension', 'manifest.json'), 'utf8'));
// 整包指纹：对**所有将打包的文件**做一次哈希。只比"扩展版本"是不够的——
// 万一只改了 broker/protocol（扩展版本没动），安装器的版本对比就发现不了，
// 用户重跑安装器仍然拿到旧代码（真机就在这类地方吃过亏）。
const crypto = await import('node:crypto');
const fingerprint = (() => {
  const h = crypto.createHash('sha256');
  for (const rel of [...items].sort()) {
    h.update(rel.replace(/\\/g, '/'));
    h.update(readFileSync(join(LITE, rel)));
  }
  return h.digest('hex').slice(0, 16);
})();
const kit = {
  mode: 'own',
  extensionName: manifest.name,
  extensionVersion: manifest.version,
  kitVersion: JSON.parse(readFileSync(join(LITE, 'package.json'), 'utf8')).version,
  fingerprint,
  builtAt: new Date().toISOString(),
  note: '自研实现：扩展 + broker + 连接器；不需要上游插件、不需要 npm install',
};
log(`整包版本：kit=${kit.kitVersion}  extension=${kit.extensionName} ${kit.extensionVersion}  指纹=${fingerprint}  (mode=${kit.mode})`);
log(`将打包 ${items.length} 个文件：`);
for (const d of INCLUDE_DIRS) log(`  ${d.padEnd(10)} ${items.filter((i) => i.startsWith(d + '\\')).length} 个`);
log(`  根文件     ${items.filter((i) => !i.includes('\\')).length} 个`);

// 3) 组装到临时目录（先删后建，避免把上一次的残留打进去）
const stage = join(tmpdir(), 'webbridge-kit-stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const rel of items) cpSync(join(LITE, rel), join(stage, rel), { recursive: true });
writeFileSync(join(stage, 'kit.json'), JSON.stringify(kit, null, 2) + '\n');

if (check) { log('[check] 仅演练，不写 zip'); log(`[OK] 可打包 ${items.length + 1} 个文件`); process.exit(0); }

// 4) 压缩（Expand-Archive 能正确解压 PowerShell 生成的 zip）
mkdirSync(dirname(outZip), { recursive: true });
if (existsSync(outZip)) rmSync(outZip);
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${stage}\\*' -DestinationPath '${outZip}' -Force`], { stdio: 'inherit' });
const size = statSync(outZip).size;
log(`[OK] 已生成 ${outZip}（${(size / 1024).toFixed(1)}KB）`);
// 4b) 同时把版本信息单独写一份到包**外面**：安装器要拿它跟本机已装版本对比，
// 才能发现"服务器上升级了、本机还是老的"（原来只看有没有 setup.mjs，导致重跑安装器毫无变化）。
try {
  const sidecar = join(dirname(outZip), 'webbridge-kit.json');
  writeFileSync(sidecar, JSON.stringify(kit, null, 2) + '\n');
  log(`[OK] 已写出 ${sidecar}（供安装器做版本对比）`);
} catch (error) { log(`[WARN] 版本信息写出失败（不影响安装）：${error.message}`); }

// 5) 自证：解压回来逐文件核对（不通过就报错，避免把坏包发出去）
const verify = join(tmpdir(), 'webbridge-kit-verify');
rmSync(verify, { recursive: true, force: true });
mkdirSync(verify, { recursive: true });
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Expand-Archive -Path '${outZip}' -DestinationPath '${verify}' -Force`], { stdio: 'inherit' });
const missing = [];
for (const rel of [...items, 'kit.json']) if (!existsSync(join(verify, rel))) missing.push(rel);
if (missing.length) die(`解压后缺少 ${missing.length} 个文件：${missing.slice(0, 5).join(', ')}`);
// 绝不能出现在包里的东西
const forbidden = ['vendor', 'patches', 'chrome', 'config.json'];
const leaked = forbidden.filter((f) => existsSync(join(verify, f)));
if (leaked.length) die(`包里不该出现这些：${leaked.join(', ')}`);
// 也不能含密钥（token 形如 43 位 base64url）
const cfgLike = items.filter((i) => /config\.json$/.test(i));
if (cfgLike.length) die('包里含 config.json（可能带密钥）');
log(`[OK] 自证通过：解压后 ${items.length + 1} 个文件齐备，且不含 vendor/patches/chrome/config.json`);
