// lib/config.mjs — 本机配置与路径
//
// 目录约定（全部相对仓库根）：
//   vendor/dsh-web-bridge/   按引用拉取的上游插件（含校验过的 broker.js/protocol.js）
//   chrome/                  setup 生成、给浏览器「加载已解压的扩展程序」用的目录
//   config.json              本机密钥与配置（.gitignore，切勿提交）

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = join(ROOT, 'config.json');
export const VENDOR_DIR = join(ROOT, 'vendor', 'dsh-web-bridge');
export const PLUGIN_DIR = join(VENDOR_DIR, 'plugins', 'dsh-web-bridge');
export const CHROME_DIR = join(ROOT, 'chrome');

/** 桥接配对密钥格式（与上游插件、扩展一致：32 字节 base64url = 43 字符） */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// 桥接实现选择：
//   upstream —— 使用按 tag 拉取并校验过的上游插件（默认，保持现有可用链路不变）
//   own      —— 使用本仓库自研实现（lib/broker.mjs + lib/protocol.mjs + extension/）
// 优先级：环境变量 > config.json 的 bridge 字段 > 默认 upstream。
// **默认不切换**是刻意的：自研扩展必须在浏览器里"加载已解压的扩展"之后才可用，
// 在那之前切过去只会把可用的链路弄坏。
const _modeConfig = (() => {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
})();
export const BRIDGE_MODE = process.env.DSH_WEB_BRIDGE_MODE || (_modeConfig.bridge === 'own' ? 'own' : 'upstream');
export const OWN_EXTENSION_DIR = join(ROOT, 'extension');


// 超时分层（从内到外，必须逐层变大，否则会出现"内层还在等、外层已放弃"）：
//   本机等待网页  240s  →  broker 自身任务计时 260s  →  中转站投递预算 300s（服务端配置）
export const DEFAULT_TIMEOUT_MS = 240_000;
export const BROKER_TIMEOUT_MS = 260_000;

// 停滞看门狗：阶段与推理内容这么久都没变化，就判定网页侧卡住并主动放弃。
// 为什么需要：broker 同一时刻只跑一个任务，一个不产出的任务会占住唯一槽位直到 600s 超时，
// 后面的请求全部排队（实测排队 93s / 104s 后被取消）。主动断开会让 broker 立刻 abort 该任务。
export const STALL_MS = Number(process.env.DSH_WEB_BRIDGE_STALL || 90_000);

// 网页会话策略：固定复用同一个会话，避免每次调用都新建（账号历史被塞满、每轮重读长提示词）。
// 累计字符超过预算就轮换——本客户端没有上游那套分段摘要逻辑，无限膨胀会撑爆网页上下文。
export const SESSION_MODE = process.env.DSH_WEB_BRIDGE_SESSION_MODE || 'fixed';   // fixed | conversation | request
export const SESSION_NAME = process.env.DSH_WEB_BRIDGE_SESSION || 'lite';
export const SESSION_BUDGET = Number(process.env.DSH_WEB_BRIDGE_SESSION_BUDGET || 120_000);

// 输出格式硬约束：网页端偶发把回复写成散文/DSML，扩展认不出来 → 干等 45s → 纠正 → 常以 108s 失败
export const FORMAT_GUARD = process.env.DSH_WEB_BRIDGE_NO_FORMAT_GUARD !== '1';

export function readConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (error) { throw new Error(`config.json 不是合法 JSON：${error.message}`); }
}

export function writeConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return config;
}

export function updateConfig(patch) {
  return writeConfig({ ...(readConfig() ?? {}), ...patch });
}

export function requireConfig() {
  const config = readConfig();
  if (!config) throw new Error('还没初始化：请先运行  npm run setup');
  if (!TOKEN_PATTERN.test(String(config.token ?? ''))) throw new Error('config.json 里的 token 缺失或格式异常：请重新运行  npm run setup');
  return config;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}
