// lib/host.mjs — 在本机拉起桥接 broker（127.0.0.1:3081）
//
// 关键：直接复用上游插件里那份 broker.js（setup 时按 tag 拉取并逐文件校验过），
//      所以扩展端的协议、校验、自动纠正行为与上游完全一致，不存在"我们自己复刻"的漂移。

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { PLUGIN_DIR, BROKER_TIMEOUT_MS, BRIDGE_MODE, STALL_MS } from './config.mjs';

/** 端口被占用时的统一人话提示（own / upstream 两条分支共用，避免只在一处修） */
function addrInUseError(error, port) {
  if (error?.code !== 'EADDRINUSE') return null;
  return new Error(
    `端口 ${port} 已被占用：本机只能运行一套网页桥接。\n` +
    '  · 如果这台机器同时跑着 DSH 的网页桥接插件，请先关掉它（本 lite 包与 DSH 插件不能共存于同一端口）；\n' +
    `  · 或者查一下占用者：${process.platform === 'win32' ? `Get-NetTCPConnection -LocalPort ${port} -State Listen` : `lsof -i :${port}`}`
  );
}

export async function startBroker({ token, port = 3081, timeoutMs = BROKER_TIMEOUT_MS, onEvent = () => {}, log = () => {} }) {
  // own 模式：本仓库自研 broker（lib/broker.mjs）。不依赖 vendor/ 里的任何上游代码。
  if (BRIDGE_MODE === 'own') {
    const { createBroker } = await import('./broker.mjs');
    const own = createBroker({ token, port, timeoutMs, stallMs: STALL_MS, log: (m) => log(m), onEvent });
    try {
      await own.start();
    } catch (error) {
      // A-1：own 分支原来直接把 EADDRINUSE 裸栈抛给用户（upstream 分支才有中文提示）。
      const friendly = addrInUseError(error, port);
      throw friendly || error;
    }
    log(`本机桥接（自研）已监听 127.0.0.1:${own.port}（任务预算 ${Math.round(timeoutMs / 1000)}s，停滞 ${Math.round(STALL_MS / 1000)}s）`);
    return own;
  }
  const brokerPath = join(PLUGIN_DIR, 'broker.js');
  if (!existsSync(brokerPath)) throw new Error(`找不到 ${brokerPath}：请先运行  npm run setup`);
  const { Broker } = await import(pathToFileURL(brokerPath).href);

  const broker = new Broker({ token, port, timeoutMs, onEvent });
  try {
    await broker.start();
  } catch (error) {
    const friendly = addrInUseError(error, port);
    throw friendly || error;
  }
  log(`本机桥接已监听 127.0.0.1:${broker.port}（任务预算 ${Math.round(timeoutMs / 1000)}s）`);
  return broker;
}
