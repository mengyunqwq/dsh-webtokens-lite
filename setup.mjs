// setup.mjs — 一次性初始化
//
//   1) 按固定 tag 拉取上游插件，并逐文件校验 SHA-256（本仓库不分发上游代码）
//   2) 生成本机桥接配对密钥
//   3) 铺出给浏览器「加载已解压的扩展程序」用的目录 chrome/
//   4) 可选：用中转站给的配对码把本机注册成一台设备（--pair）
//
// 用法：
//   npm run setup
//   npm run setup -- --pair ABCD-EFGH --server https://panel.mengyun.xyz
//   npm run setup -- --doctor

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { CHROME_DIR, CONFIG_PATH, VENDOR_DIR, OWN_EXTENSION_DIR, TOKEN_PATTERN, ensureDir, readConfig, writeConfig, updateConfig, PLUGIN_DIR } from './lib/config.mjs';
import { fetchUpstream, verifyVendor, extensionFiles, UPSTREAM } from './lib/upstream.mjs';
import { applyPatches, verifyPatched, readManifest } from './lib/patches.mjs';
import { pair, AGENT_VERSION } from './lib/agent.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
/**
 * 取单个参数的值，**两种写法都支持**：`--name=value` 与 `--name value`。
 *
 * 为什么必须支持等号写法：文档与安装器用的都是 `--bridge=own`，而这里原来只认空格写法，
 * 于是 modeArg 静默变成 undefined、回退到 upstream —— 用户以为装的是自研实现，实际装出来
 * 的是上游扩展（还会去 GitHub 拉上游代码）。这种"静默回退"比报错危险得多，所以下面还加了
 * 一层"给了 --bridge 却没解析出来就报错"的兜底。
 */
const value = (name) => {
  const inline = args.find((a) => a.startsWith('--' + name + '='));
  if (inline) return inline.slice(('--' + name + '=').length);
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * 统一解析"用哪种实现"：`--bridge` > 环境变量 `DSH_WEB_BRIDGE_MODE` > `config.json.bridge` > upstream。
 * 两条路径（doctor 与真正的安装）必须共用这一处 —— 原来 doctor 自己另写了一套、且不看 `--bridge`，
 * 于是 `setup --doctor --bridge=own` 会照着 upstream 的状态汇报，等于骗人。
 */
function resolveMode() {
  const modeArg = value('bridge');
  if (modeArg && !['own', 'upstream'].includes(modeArg)) die('--bridge 只能是 own 或 upstream');
  // 防静默回退：明明给了 --bridge 却没解析出值 —— 宁可停下报错，也不要把用户装成另一种实现
  if (!modeArg && args.some((a) => a === '--bridge' || a.startsWith('--bridge='))) {
    die('没有认出 --bridge 的值（两种写法都可以：--bridge=own 或 --bridge own）');
  }
  return modeArg || process.env.DSH_WEB_BRIDGE_MODE || readConfig()?.bridge || 'upstream';
}

function log(...a) { console.log(...a); }
function die(message) { console.error('\n✗ ' + message + '\n'); process.exit(1); }

function copyToClipboard(text) {
  try {
    if (process.platform === 'win32') spawnSync('clip', { input: text, shell: true });
    else if (process.platform === 'darwin') spawnSync('pbcopy', { input: text });
    else spawnSync('xclip', ['-selection', 'clipboard'], { input: text });
  } catch { /* 剪贴板失败不影响流程 */ }
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) die(`需要 Node.js 22 及以上，当前是 ${process.versions.node}。请先升级 Node。`);
}

function buildExtensionDir(token, mode = 'upstream') {
  ensureDir(CHROME_DIR);
  // own 模式：直接铺本仓库 extension/ 里我们自己的扩展（不碰 vendor/，也不需要上游）
  const files = mode === 'own' ? ownExtensionFiles() : extensionFiles();
  for (const file of files) copyFileSync(file, join(CHROME_DIR, basename(file)));
  writeFileSync(join(CHROME_DIR, 'local-config.json'), JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 });
  return files.length;
}

/** 自研扩展的文件清单（扩展目录平铺，本地配置文件另写） */
function ownExtensionFiles() {
  const dir = OWN_EXTENSION_DIR;
  if (!existsSync(join(dir, 'manifest.json'))) die(`找不到自研扩展目录：${dir}`);
  return readdirSync(dir).filter((f) => f !== 'local-config.json').map((f) => join(dir, f));
}

function readManifestField(field) {
  try { return JSON.parse(readFileSync(join(CHROME_DIR, 'manifest.json'), 'utf8'))[field] ?? null; }
  catch { return null; }
}

function readManifestVersion() {
  return readManifestField('version');
}

async function doctor() {
  log('=== 自检 ===');
  checkNode();
  log(`✓ Node ${process.versions.node}`);

  const mode = resolveMode();
  if (mode === 'own') {
    const files = ownExtensionFiles().filter((f) => existsSync(f));
    log(`✓ 实现：自研（own）—— 扩展 ${files.length} 个文件，来自本仓库 extension/（不使用上游、不需要 vendor/）`);
    log('  · 首次使用需在浏览器扩展页「加载已解压的扩展程序」指向 ' + CHROME_DIR);
    log('  · 回退到上游实现：npm run setup -- --bridge=upstream');
  } else {
    const check = existsSync(join(PLUGIN_DIR, 'broker.js')) ? verifyVendor() : { ok: false, reason: 'vendor 未拉取' };
    // 打了补丁之后，文件必然与上游清单不再逐字节相同 —— 所以先看「原版+补丁」的记录，
    // 记录一致就说明这份副本是我们预期的状态（原版可信 + 补丁是我们打的那几条）。
    const patched = verifyPatched(VENDOR_DIR);
    if (patched.ok === true) {
      log(`✓ 上游原版 + ${patched.patches} 处本机补丁：补丁后 ${patched.checked} 个文件哈希一致`);
      for (const p of readManifest(VENDOR_DIR)?.patches || []) log(`    · ${p.id}：${p.title}`);
    } else if (patched.ok === false) {
      log(`✗ 补丁状态异常：${patched.reason} → 重新 setup（或 npm run setup -- --no-patch 用原版）`);
    } else if (check.ok) {
      log(`✓ 上游副本可信：${check.total} 个文件 SHA-256 一致（${UPSTREAM.repo}@${UPSTREAM.tag}，基线 ${String(check.commit).slice(0, 12)}）`);
    } else {
      log(`✗ 上游副本不可信：${check.reason} → 运行  npm run setup`);
    }
    // 反向检查：真正会被加载的目录（extension/、plugins/）里不该有清单之外的文件
    if (check.extraFiles?.length) {
      const extra = check.extraFiles.filter((f) => f !== 'PATCHES.json');
      if (extra.length) {
        log(`⚠ 上游副本里有 ${extra.length} 个清单之外的代码文件（不会被扩展加载，但建议核对）：`);
        for (const f of extra.slice(0, 8)) log('    ' + f);
      }
    }
  }

  const config = readConfig();
  if (!config) log('✗ 未初始化（无 config.json）→ 运行  npm run setup');
  else {
    log(TOKEN_PATTERN.test(String(config.token)) ? '✓ 本机配对密钥已生成' : '✗ 本机配对密钥格式异常 → 重新 setup');
    let chromeToken = null;
    try { chromeToken = JSON.parse(readFileSync(join(CHROME_DIR, 'local-config.json'), 'utf8')).token; } catch { /* 缺失 */ }
    if (chromeToken === config.token) log(`✓ 扩展目录已就绪（扩展版本 ${readManifestVersion() ?? '未知'}）`);
    else log('✗ 扩展目录的配对文件与本机密钥不一致 → 重新 setup，然后在扩展页点「重新加载」');
    if (config.relay?.deviceId) log(`✓ 已配对中转站设备 #${config.relay.deviceId}（${config.relay.name}）@ ${config.relay.server}`);
    else log('· 尚未配对中转站：用  npm run setup -- --pair <配对码> --server <地址>');
  }

  const port = config?.port ?? 3081;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(4000) });
    const status = await res.json();
    log(`✓ 本机桥接在跑：${port}，扩展${status.connected ? '已连接' : '未连接'}（worker ${status.workerVersion ?? '—'}），排队 ${status.queued}`);
    if (!status.connected) log('  ⚠ 扩展未连接：请在浏览器扩展页确认「DeepSeek Harness 网页桥接」已加载并已登录 chat.deepseek.com');
  } catch {
    log(`· 本机桥接未在 ${port} 运行（启动它：npm start）`);
  }
  log('');
}

async function main() {
  if (flag('doctor')) return doctor();

  log('=== dsh-webtokens-lite 初始化 ===');
  checkNode();

  // 0) 实现选择：--bridge=own 用自研实现（不下载上游）；解析规则见 resolveMode()
  const mode = resolveMode();

  // 1) 上游（按引用拉取 + 校验原版）——own 模式完全跳过，这正是重写的意义之一
  if (mode === 'own') {
    log('  · own 模式：使用本仓库自研实现（lib/broker.mjs + lib/protocol.mjs + extension/），不下载上游');
  } else {
    await fetchUpstream({ force: flag('force'), log: (m) => log('  ' + m) });
    // 1b) 在原版之上应用本机补丁（--no-patch / DSH_WEB_BRIDGE_NO_PATCH=1 可跳过）
    const noPatch = flag('no-patch') || process.env.DSH_WEB_BRIDGE_NO_PATCH === '1';
    if (noPatch) {
      log('  · 已按 --no-patch 跳过补丁（使用上游原版；每轮会多等 5 秒、格式问题要等 45 秒）');
    } else {
      const pr = await applyPatches({ vendorDir: VENDOR_DIR, tag: UPSTREAM.tag, log: (m) => log('  ' + m) });
      if (pr.problems.length) {
        log('  ⚠ 补丁未全部应用（上游版本可能变了）：');
        for (const p of pr.problems) log('      ' + p);
        log('    可以改用 --no-patch 跑上游原版；或更新 patches/ 里的锚点');
      }
      for (const a of pr.applied) log(`  ✓ 补丁已应用：${a.id}（${a.edits} 处修改）——${a.title}`);
      for (const s of pr.skipped) log(`  · 补丁跳过：${s.id}（${s.reason}）`);
      if (pr.patched?.ok) log(`  ✓ 补丁后完整性：${pr.patched.checked} 个文件哈希与记录一致`);
    }
  }

  // 2) 本机配对密钥
  let config = readConfig();
  if (!config || !TOKEN_PATTERN.test(String(config.token ?? ''))) {
    config = { ...(config ?? {}), token: randomBytes(32).toString('base64url'), port: config?.port ?? 3081 };
    writeConfig(config);
    log('  ✓ 已生成本机配对密钥（config.json，勿外传）');
  } else {
    log('  · 复用已有的本机配对密钥');
  }

  // 3) 扩展目录
  const count = buildExtensionDir(config.token, mode);
  log(`  ✓ 已铺出扩展目录（${count} 个文件）→ ${CHROME_DIR}`);

  // 4) 记录来源与实现选择，便于排查"这份扩展是哪来的"
  writeConfig({
    ...config,
    bridge: mode,
    vendor: mode === 'own'
      ? { mode: 'own', extensionVersion: readManifestVersion() }
      : { repo: UPSTREAM.repo, tag: UPSTREAM.tag, pluginVersion: UPSTREAM.coreVersion, chromeVersion: UPSTREAM.chromeVersion, patched: !flag('no-patch') },
    agentVersion: AGENT_VERSION,
    updatedAt: new Date().toISOString(),
  });

  // 5) 可选：配对中转站
  const code = value('pair');
  const server = value('server');
  if (code) {
    if (!server) die('--pair 需要同时给 --server（例如 https://panel.mengyun.xyz）');
    log(`  正在配对中转站 ${server} …`);
    try {
      const r = await pair({ server, code, name: value('name') });
      updateConfig({ relay: { server: server.replace(/\/+$/, ''), deviceToken: r.token, deviceId: r.deviceId, name: r.name } });
      log(`  ✓ 配对成功：设备 #${r.deviceId}「${r.name}」`);
    } catch (error) {
      die(error.message);
    }
  }

  copyToClipboard(CHROME_DIR);
  const cfg = readConfig();
  log('');
  log('=== 接下来只有两件人工的事 ===');
  log('');
  log(`① 把扩展装进浏览器（路径已复制到剪贴板）：`);
  log(`     ${CHROME_DIR}`);
  log(`   打开  edge://extensions  或  chrome://extensions  →  打开「开发人员模式」`);
  log(`   →  点「加载解压缩的扩展」→ 选上面这个目录`);
  // 卡片名/版本按**实际铺出的 manifest** 显示：own 模式是我们的「DeepSeek 网页桥接（自研）」，
  // 上游模式是上游那张卡 —— 写死任何一个都会在另一种模式下骗人（实测就是这么错的）
  log(`   →  确认卡片名为「${readManifestField('name') || '（见 manifest）'}」、版本 ${readManifestVersion() || '?'}`);
  log(`   注意：同一个浏览器配置里只装一份；别去加载仓库里的 extension 目录（缺少配对文件）`);
  log('');
  log('② 在那个浏览器里打开 https://chat.deepseek.com/ 并登录（保持登录）');
  log('');
  log('然后启动：');
  log('     npm start');
  if (!cfg?.relay?.deviceId) {
    log('');
    log('若要接入中转站：到控制台「＋ 添加我的电脑」拿配对码，然后');
    log('     npm run setup -- --pair <配对码> --server https://panel.mengyun.xyz');
  }
  log('');
}

main().catch((error) => die(error?.stack || String(error)));
