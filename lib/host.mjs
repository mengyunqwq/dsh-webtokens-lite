// lib/host.mjs — 在本机拉起桥接 broker（127.0.0.1:3081）
//
// 关键：直接复用上游插件里那份 broker.js（setup 时按 tag 拉取并逐文件校验过），
//      所以扩展端的协议、校验、自动纠正行为与上游完全一致，不存在"我们自己复刻"的漂移。

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { PLUGIN_DIR, BROKER_TIMEOUT_MS } from './config.mjs';

export async function startBroker({ token, port = 3081, timeoutMs = BROKER_TIMEOUT_MS, onEvent = () => {}, log = () => {} }) {
  const brokerPath = join(PLUGIN_DIR, 'broker.js');
  if (!existsSync(brokerPath)) throw new Error(`找不到 ${brokerPath}：请先运行  npm run setup`);
  const { Broker } = await import(pathToFileURL(brokerPath).href);

  const broker = new Broker({ token, port, timeoutMs, onEvent });
  try {
    await broker.start();
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      throw new Error(
        `端口 ${port} 已被占用：本机只能运行一套网页桥接。\n` +
        '  · 如果这台机器同时跑着 DSH 的网页桥接插件，请先关掉它（本 lite 包与 DSH 插件不能共存于同一端口）；\n' +
        `  · 或者查一下占用者：${process.platform === 'win32' ? `Get-NetTCPConnection -LocalPort ${port} -State Listen` : `lsof -i :${port}`}`
      );
    }
    throw error;
  }
  log(`本机桥接已监听 127.0.0.1:${broker.port}（任务预算 ${Math.round(timeoutMs / 1000)}s）`);
  return broker;
}
