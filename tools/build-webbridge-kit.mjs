// tools/build-webbridge-kit.mjs —— 构建中转站下发的「网页桥接整包」（public/agent/webbridge.zip）
//
// 为什么需要：安装器 webbridge.ps1 会从中转站下载这个包解压到用户目录。历史上那个包
// 依赖**上游插件**（安装时再按 tag 去 GitHub 拉取并校验 43 个 SHA-256）。现在改为自研实现：
// 包里直接带上我们自己的扩展 + broker + 连接器，安装时**不联网拉上游、不需要 npm install**。
//
// 用法：node tools/build-webbridge-kit.mjs [--out <zip路径>] [--relay <中转站根>] [--check]
//   --check  走完整流程（组装 → 压缩 → 解压自证 → 重算指纹）但**不写入中转站目录**，
//            用来确认"当前源码打出来的包能自证通过"。以前的 --check 打印一句就退出、
//            恰好跳过了自证，等于什么都没查（C-4）。
//
// 刻意**不打包**的东西：
//   vendor/        上游插件副本（自研模式完全不需要，且是无许可证代码，绝不能随包分发）
//   patches/       针对上游源码的补丁（同上）
//   chrome/        给浏览器加载的目录：到用户机器上由 setup.mjs 现场铺（含各自的配对密钥）
//   config.json    **含本机配对密钥**，只能由用户机器现场生成
//   node_modules/  自研实现零依赖，不需要
//   tests/         开发用（6 个测试）。**绝不能进用户包**：用户拿到测试没有意义。
//   tools/         只保留**运行时**脚本（autostart.vbs / hide-run.vbs，安装器与快捷方式要用），
//                  打包器自身（build-webbridge-kit.mjs）必须排除——它历史上硬编码了开发机的
//                  `D:/Users/Administrator/llm-relay` 路径，发到每个用户机器上是明确的信息泄露（C-1）。

import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync, readFileSync, writeFileSync, statSync, readdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const LITE = resolve(HERE, '..');                    // 连接器仓库根
const RELAY = process.env.WEBBRIDGE_RELAY || 'D:/Users/Administrator/llm-relay';  // 中转站仓库根（可用 --relay 覆盖）
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const check = argv.includes('--check');
const relayRoot = arg('--relay', RELAY);
const finalZip = arg('--out', join(relayRoot, 'public', 'agent', 'webbridge.zip'));

const INCLUDE_FILES = ['setup.mjs', 'start.mjs', 'start.cmd', 'start.sh', 'package.json', 'README.md', 'LICENSE'];
const INCLUDE_DIRS = ['lib', 'extension', 'docs', 'tools'];
const EXCLUDE_NAMES = new Set(['vendor', 'patches', 'chrome', 'config.json', 'node_modules', '.git']);
// 开发用文件（即使落在 INCLUDE_DIRS 里也要排除）。tests/ 整个目录由 INCLUDE_DIRS 不包含它来排除。
const EXCLUDE_FILES = new Set(['tools/build-webbridge-kit.mjs']);

function log(m) { console.log(m); }
function die(m) { console.error('[FAIL] ' + m); process.exit(1); }

/** 路径归一化：指纹与文件集合比较都基于 `/` 分隔，避免 Windows 反斜杠导致的平台差异 */
const norm = (rel) => rel.replace(/\\/g, '/');

/**
 * 整包指纹：对**所有将打包的文件**做一次哈希。只比"扩展版本"是不够的——
 * 万一只改了 broker/protocol（扩展版本没动），安装器的版本对比就发现不了，
 * 用户重跑安装器仍然拿到旧代码（真机就在这类地方吃过亏）。
 *
 * 与旧实现的区别（C-5，都是"拼接歧义"类缺陷）：
 *   · 路径、内容都带长度前缀 + 分隔符 → `a/b` 与 `ab/` 这类拼接不会再撞成同一串；
 *   · 先归一化路径再排序 → 同一份内容在 Windows/Linux 上得到同一指纹；
 *   · 不再截断到 64bit（16 hex）→ 用完整 sha256，避免碰撞面被人为缩小。
 */
function fingerprintOf(rootDir, rels) {
  const h = createHash('sha256');
  for (const rel of rels.map(norm).sort()) {
    h.update(Buffer.byteLength(rel) + ':' + rel + '\0');
    const data = readFileSync(join(rootDir, rel));
    h.update(data.length + '\0');
    h.update(data);
  }
  return h.digest('hex');
}

/** 列出目录下所有文件（相对路径、反斜杠分隔），用于"解压后的文件集合是否与清单一致" */
function walkFiles(rootDir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(rootDir, rel), { withFileTypes: true })) {
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walkFiles(rootDir, r)); else out.push(r);
  }
  return out;
}

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
      if (EXCLUDE_NAMES.has(e.name) || EXCLUDE_FILES.has(norm(r))) continue;
      if (e.isDirectory()) walk(r); else items.push(r);
    }
  };
  walk(d);
}
// C-1 保险丝：测试与打包器本身一旦混进包就报错（而不是靠人记得没改清单）
const devLeak = items.filter((i) => /^(tests)[\\/]/.test(norm(i)) || norm(i) === 'tools/build-webbridge-kit.mjs');
if (devLeak.length) die(`开发文件不该进用户包：${devLeak.slice(0, 5).join(', ')}（INCLUDE_DIRS=${JSON.stringify(INCLUDE_DIRS)} EXCLUDE_FILES=${JSON.stringify([...EXCLUDE_FILES])}）`);

const manifest = JSON.parse(readFileSync(join(LITE, 'extension', 'manifest.json'), 'utf8'));

// 2) 组装到临时目录（先删后建，避免把上一次的残留打进去）
const stage = join(tmpdir(), 'webbridge-kit-stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const rel of items) cpSync(join(LITE, rel), join(stage, rel), { recursive: true });

// 3) 指纹基于**已组装好的目录**计算（而不是打包前的源目录）：
//    中间任何一步改了文件，指纹都会跟着变；解压后再算一次能直接对上（C-6/C-7）。
const fingerprint = fingerprintOf(stage, items);
const kit = {
  mode: 'own',
  extensionName: manifest.name,
  extensionVersion: manifest.version,
  kitVersion: JSON.parse(readFileSync(join(LITE, 'package.json'), 'utf8')).version,
  fingerprint,
  builtAt: new Date().toISOString(),
  note: '自研实现：扩展 + broker + 连接器；不需要上游插件、不需要 npm install',
};
writeFileSync(join(stage, 'kit.json'), JSON.stringify(kit, null, 2) + '\n');
log(`整包版本：kit=${kit.kitVersion}  extension=${kit.extensionName} ${kit.extensionVersion}  指纹=${fingerprint}  (mode=${kit.mode})`);
log(`将打包 ${items.length} 个文件 + kit.json：`);
for (const d of INCLUDE_DIRS) log(`  ${d.padEnd(10)} ${items.filter((i) => norm(i).startsWith(d + '/')).length} 个`);
log(`  根文件     ${items.filter((i) => !norm(i).includes('/')).length} 个`);

// 4) 压缩：始终先压到临时 zip（--check 与正式构建共用同一条路径，保证 check 真的查了）
const stagingZip = join(tmpdir(), 'webbridge-kit-build.zip');
if (existsSync(stagingZip)) rmSync(stagingZip);
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${stage}\\*' -DestinationPath '${stagingZip}' -Force`], { stdio: 'inherit' });

// 5) 自证：解压回来**逐文件比对 + 重算指纹**（不通过就报错，避免把坏包发出去）。
//    C-6：旧实现只 existsSync 查存在性——内容被改/被截断的包能混过去；现在重算指纹即可发现。
const verify = join(tmpdir(), 'webbridge-kit-verify');
rmSync(verify, { recursive: true, force: true });
mkdirSync(verify, { recursive: true });
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Expand-Archive -Path '${stagingZip}' -DestinationPath '${verify}' -Force`], { stdio: 'inherit' });

const extracted = walkFiles(verify);
const expected = new Set([...items.map(norm), 'kit.json']);
const gotSet = new Set(extracted.map(norm));
const missing = [...expected].filter((r) => !gotSet.has(r));
if (missing.length) die(`解压后缺少 ${missing.length} 个文件：${missing.slice(0, 5).join(', ')}`);
const unexpected = [...gotSet].filter((r) => !expected.has(r));
if (unexpected.length) die(`解压后多出 ${unexpected.length} 个文件：${unexpected.slice(0, 5).join(', ')}`);

const kitInside = JSON.parse(readFileSync(join(verify, 'kit.json'), 'utf8'));
const verifyFingerprint = fingerprintOf(verify, items);
if (kitInside.fingerprint !== fingerprint || verifyFingerprint !== fingerprint) {
  die(`自证失败：指纹不一致（kit.json=${kitInside.fingerprint} 解压后重算=${verifyFingerprint} 期望=${fingerprint}）`);
}
if (kitInside.extensionVersion !== kit.extensionVersion) die('自证失败：包内 kit.json 的扩展版本与源码不一致');

// 绝不能出现在包里的东西 / 密钥
const forbidden = ['vendor', 'patches', 'chrome', 'config.json', 'tests'];
const leaked = forbidden.filter((f) => existsSync(join(verify, f)));
if (leaked.length) die(`包里不该出现这些：${leaked.join(', ')}`);
const cfgLike = extracted.filter((i) => /(^|\/)config\.json$/.test(norm(i)) || /local-config\.json$/.test(norm(i)));
if (cfgLike.length) die(`包里含疑似密钥文件：${cfgLike.join(', ')}`);
log(`[OK] 自证通过：解压后 ${extracted.length} 个文件齐备，指纹重算一致，且不含 vendor/patches/chrome/config.json/tests（tools 只含运行时 vbs）`);

if (check) {
  rmSync(stagingZip, { force: true });
  rmSync(stage, { recursive: true, force: true });
  log('[check] 演练完成（含自证），未写入中转站目录');
  process.exit(0);
}

// 6) 正式发布：先替换 zip，再写 sidecar；sidecar 写失败要**回滚 zip 并报错**。
//    旧实现在 sidecar 失败时只 [WARN] 然后照常发布 → "新 zip + 旧指纹"，
//    而安装器靠指纹判断"已是最新" → 用户永远升不上来（C-7）。
mkdirSync(dirname(finalZip), { recursive: true });
if (existsSync(finalZip)) rmSync(finalZip);
// 临时目录在 C:、目标可能在中转站的 D: —— rename 跨卷会抛 EXDEV，所以复制后删源
copyFileSync(stagingZip, finalZip);
rmSync(stagingZip, { force: true });
log(`[OK] 已生成 ${finalZip}（${(statSync(finalZip).size / 1024).toFixed(1)}KB）`);

const sidecar = join(dirname(finalZip), 'webbridge-kit.json');
const sidecarTmp = sidecar + '.tmp';
try {
  writeFileSync(sidecarTmp, JSON.stringify(kit, null, 2) + '\n');
  if (existsSync(sidecar)) rmSync(sidecar);
  renameSync(sidecarTmp, sidecar);
  log(`[OK] 已写出 ${sidecar}（供安装器做版本对比）`);
} catch (error) {
  rmSync(finalZip, { force: true });   // 回滚：宁可没有新包，也不能出现"新包配旧指纹"
  die(`sidecar 写出失败，已回滚 zip，避免"新包配旧指纹"导致用户永远升不上来：${error.message}`);
}
