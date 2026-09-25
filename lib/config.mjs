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

// 超时分层（从内到外，必须逐层变大，否则会出现"内层还在等、外层已放弃"）：
//   本机等待网页  240s  →  broker 自身任务计时 260s  →  中转站投递预算 300s（服务端配置）
export const DEFAULT_TIMEOUT_MS = 240_000;
export const BROKER_TIMEOUT_MS = 260_000;

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
