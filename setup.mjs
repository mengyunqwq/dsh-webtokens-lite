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
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { CHROME_DIR, CONFIG_PATH, TOKEN_PATTERN, ensureDir, readConfig, writeConfig, updateConfig, PLUGIN_DIR } from './lib/config.mjs';
import { fetchUpstream, verifyVendor, extensionFiles, UPSTREAM } from './lib/upstream.mjs';
import { pair, AGENT_VERSION } from './lib/agent.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
const value = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};

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

function buildExtensionDir(token) {
  ensureDir(CHROME_DIR);
  const files = extensionFiles();
  for (const file of files) copyFileSync(file, join(CHROME_DIR, basename(file)));
  writeFileSync(join(CHROME_DIR, 'local-config.json'), JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 });
  return files.length;
}

function readManifestVersion() {
  try { return JSON.parse(readFileSync(join(CHROME_DIR, 'manifest.json'), 'utf8')).version; }
  catch { return null; }
}

async function doctor() {
  log('=== 自检 ===');
  checkNode();
  log(`✓ Node ${process.versions.node}`);

  const check = existsSync(join(PLUGIN_DIR, 'broker.js')) ? verifyVendor() : { ok: false, reason: 'vendor 未拉取' };
  if (check.ok) log(`✓ 上游副本可信：${check.total} 个文件 SHA-256 一致（${UPSTREAM.repo}@${UPSTREAM.tag}，基线 ${String(check.commit).slice(0, 12)}）`);
  else log(`✗ 上游副本不可信：${check.reason} → 运行  npm run setup`);
  // 反向检查：真正会被加载的目录（extension/、plugins/）里不该有清单之外的文件
  if (check.extraFiles?.length) {
    log(`⚠ 上游副本里有 ${check.extraFiles.length} 个清单之外的代码文件（不会被扩展加载，但建议核对）：`);
    for (const f of check.extraFiles.slice(0, 8)) log('    ' + f);
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

  // 1) 上游（按引用拉取 + 校验）
  await fetchUpstream({ force: flag('force'), log: (m) => log('  ' + m) });

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
  const count = buildExtensionDir(config.token);
  log(`  ✓ 已铺出扩展目录（${count} 个文件）→ ${CHROME_DIR}`);

  // 4) 记录来源，便于排查"这份扩展是哪来的"
  writeConfig({
    ...config,
    vendor: { repo: UPSTREAM.repo, tag: UPSTREAM.tag, pluginVersion: UPSTREAM.coreVersion, chromeVersion: UPSTREAM.chromeVersion },
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
  log(`   →  确认卡片名为「DeepSeek Harness 网页桥接」、版本 ${UPSTREAM.chromeVersion}`);
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
