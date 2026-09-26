// lib/upstream.mjs — 按引用拉取上游插件并逐文件校验
//
// 为什么这么做（而不是把上游文件复制进本仓库）：
//   上游仓库 xinyuquan985-coder/DSH-webtokens **没有声明任何开源许可证**
//   （无 LICENSE 文件、package.json 无 license 字段、扩展 manifest 也无声明）。
//   没有许可证 = 默认保留所有权利，因此本仓库**不再分发**其任何代码，
//   改为在 setup 时按固定 tag 下载，并用上游自带的 SOURCE.json 逐个校验 SHA-256。
//   这样既避免再分发，又拿到完整性证明。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { VENDOR_DIR, PLUGIN_DIR, TOKEN_PATTERN } from './config.mjs';
import { verifyPatched } from './patches.mjs';

export const UPSTREAM = {
  repo: 'xinyuquan985-coder/DSH-webtokens',
  tag: 'v0.2.15-deepseek',
  // 上游 SOURCE.json 里记录的基线提交（用作人读的对照；权威校验靠下面的逐文件哈希）
  baselineCommit: '82440ec209d50d5e8063119cc5e19c84ac9f0ebc',
  chromeVersion: '0.2.19',
  coreVersion: '0.2.15',
};

const TARBALL_URL = `https://codeload.github.com/${UPSTREAM.repo}/tar.gz/refs/tags/${UPSTREAM.tag}`;

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 校验已拉取的 vendor 是否与上游 SOURCE.json 完全一致 */
export function verifyVendor() {
  const manifestPath = join(VENDOR_DIR, 'SOURCE.json');
  if (!existsSync(manifestPath)) return { ok: false, reason: '缺少 SOURCE.json（vendor 未拉取或不完整）' };
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (error) { return { ok: false, reason: 'SOURCE.json 不是合法 JSON：' + error.message }; }
  const entries = Object.entries(manifest.sha256 ?? {});
  if (!entries.length) return { ok: false, reason: 'SOURCE.json 里没有 sha256 清单' };
  const mismatched = [];
  for (const [file, expected] of entries) {
    const full = join(VENDOR_DIR, file);
    if (!existsSync(full)) { mismatched.push(file + '（缺失）'); continue; }
    if (sha256(full) !== expected) mismatched.push(file + '（哈希不一致）');
  }

  // 反向检查：**会被加载/执行**的目录里不应出现清单之外的文件。
  // 为什么只盯这两个目录：上游仓库根下的 README、tests/、scripts/、包元数据等本来就不在
  // SOURCE.json 的覆盖范围内（实测 54 个文件 vs 清单 43 个），一律报会天天误报；
  // 而 extension/ 与 plugins/ 是真正跑起来的代码，多一个未列文件值得警惕。
  // （注意：manifest.json 本身在清单里，所以"新增一个扩展脚本并让它被加载"必然要先改
  //   manifest.json → 哈希立刻不符；这里再多一道防线。）
  const watchedPrefixes = ['extension/', 'plugins/'];
  const listed = new Set(entries.map(([f]) => String(f).replace(/\\/g, '/')));
  const extraFiles = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? prefix + '/' + name : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else if (watchedPrefixes.some((p) => rel.startsWith(p)) && !listed.has(rel)) extraFiles.push(rel);
    }
  };
  if (existsSync(VENDOR_DIR)) walk(VENDOR_DIR, '');

  return {
    ok: mismatched.length === 0,
    total: entries.length,
    commit: manifest.sourceCommit ?? UPSTREAM.baselineCommit,
    mismatched,
    extraFiles,
    reason: mismatched.length ? `有 ${mismatched.length} 个文件与上游清单不符` : undefined,
  };
}

function extractTar(tarball, destDir) {
  // Windows 10+/macOS/Linux 都自带 bsdtar；没有就回退到 git clone
  const tar = spawnSync('tar', ['-xzf', tarball, '-C', destDir], { stdio: 'pipe' });
  if (tar.status === 0) return 'tar';
  const git = spawnSync('git', ['clone', '--depth', '1', '--branch', UPSTREAM.tag, `https://github.com/${UPSTREAM.repo}.git`, destDir], { stdio: 'pipe' });
  if (git.status === 0) return 'git';
  throw new Error(
    '解压上游失败：既没有可用的 tar，也没有可用的 git。\n' +
    `  tar: ${String(tar.stderr || '').trim().split('\n')[0] || '不可用'}\n` +
    `  git: ${String(git.stderr || '').trim().split('\n')[0] || '不可用'}\n` +
    `  也可以手动下载后解压到：${VENDOR_DIR}\n  ${TARBALL_URL}`
  );
}

/**
 * 拉取（或复用）上游插件。
 * @param {{force?: boolean, log?: (msg: string) => void}} options
 */
export async function fetchUpstream({ force = false, log = () => {} } = {}) {
  if (!force && existsSync(join(PLUGIN_DIR, 'broker.js'))) {
    const check = verifyVendor();
    if (check.ok) { log(`已存在可信的上游副本：${check.total} 个文件校验通过（基线 ${String(check.commit).slice(0, 12)}）`); return { reused: true, ...check }; }
    // 打过补丁的副本必然与上游清单不再逐字节相同 —— 先看补丁记录是否一致。
    // 不看的话，每次 setup 都会因为"哈希不符"而整份重下（白费流量，也让人以为出了问题）。
    const patched = verifyPatched(VENDOR_DIR);
    if (patched.ok === true) {
      log(`已存在可信的上游副本：原版 + ${patched.patches} 处本机补丁（补丁后 ${patched.checked} 个文件哈希一致），跳过下载`);
      return { reused: true, patched: true, ...check };
    }
    log(`已存在的副本校验失败（${patched.ok === false ? patched.reason : check.reason}），重新拉取…`);
  }

  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });
  const tmpDir = VENDOR_DIR + '.tmp';
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const tarball = join(tmpDir, 'upstream.tar.gz');
  log(`下载上游 ${UPSTREAM.repo}@${UPSTREAM.tag} …`);
  const res = await fetch(TARBALL_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载上游失败：HTTP ${res.status} ${res.statusText}\n  ${TARBALL_URL}`);
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  log(`已下载 ${(statSync(tarball).size / 1024 / 1024).toFixed(1)} MB，解压…`);

  const stage = join(tmpDir, 'stage');
  mkdirSync(stage, { recursive: true });
  const via = extractTar(tarball, stage);
  log(`解压完成（${via}）`);

  // 解压出来是 DSH-webtokens-<sha>/ 单层目录 → 落成 vendor/dsh-web-bridge/
  const top = readdirSync(stage).map((n) => join(stage, n)).filter((p) => statSync(p).isDirectory());
  if (top.length !== 1) throw new Error(`解压结果异常：期望单层目录，实际 ${top.length} 个`);
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  renameSync(top[0], VENDOR_DIR);
  rmSync(tmpDir, { recursive: true, force: true });

  const check = verifyVendor();
  if (!check.ok) throw new Error(`上游整性校验失败：${check.reason}\n  不符文件：${(check.mismatched ?? []).slice(0, 10).join(', ')}`);
  log(`完整性校验通过：${check.total} 个文件 SHA-256 全部一致（基线提交 ${String(check.commit).slice(0, 12)}）`);
  return { reused: false, ...check };
}

/** vendor 里扩展的文件清单（与上游 setup 一致：manifest/package/popup + 全部 .js） */
export function extensionFiles() {
  const dir = join(VENDOR_DIR, 'extension');
  if (!existsSync(dir)) throw new Error('找不到上游 extension 目录：请先运行  npm run setup');
  return readdirSync(dir)
    .filter((name) => name === 'manifest.json' || name === 'package.json' || name === 'popup.html' || name.endsWith('.js'))
    .map((name) => join(dir, name));
}

export { TOKEN_PATTERN };
