// start.mjs — 一键启动：本机桥接（127.0.0.1:3081）+ 中转站连接器（长轮询）
//
// 两者在同一个进程里，所以用户只需保持一个窗口；Ctrl+C 一并退出。

import { requireConfig, DEFAULT_TIMEOUT_MS } from './lib/config.mjs';
import { startBroker } from './lib/host.mjs';
import { runAgent, AGENT_VERSION } from './lib/agent.mjs';

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

const config = requireConfig();
const port = Number(config.port ?? 3081);
const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

log(`dsh-webtokens-lite v${AGENT_VERSION} 启动中…`);

const broker = await startBroker({
  token: config.token,
  port,
  timeoutMs: timeoutMs + 20_000,
  onEvent: (event) => {
    // 只打关键事件，避免刷屏；完整事件仍在 broker 内部保留给面板/审计
    if (['queued', 'completed', 'failed', 'reply-validation'].includes(event?.type) && event.type !== 'reply-validation') {
      log(`  [桥接] ${event.type}${event.code ? ' ' + event.code : ''}${event.message ? ' ' + event.message : ''}`);
    }
  },
  log,
});

// 扩展是否连上，直接决定调用会不会成功——启动后提醒一次
setTimeout(async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(4000) });
    const s = await res.json();
    if (s.connected) log(`扩展已连接（worker ${s.workerVersion}）`);
    else log('⚠ 扩展还没连上：请在浏览器扩展页确认「DeepSeek Harness 网页桥接」已加载，并已登录 chat.deepseek.com');
  } catch { /* 忽略 */ }
}, 2000);

// 心跳：每 5 分钟报一次桥接状态，长时间无人调用时也能看出是否还活着
const heartbeat = setInterval(async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(4000) });
    const s = await res.json();
    log(`[心跳] 扩展${s.connected ? '在线' : '离线'} · 排队 ${s.queued} · ${s.worker ?? ''}`);
  } catch { log('[心跳] 本机桥接无响应'); }
}, 300_000);
heartbeat.unref?.();

const shutdown = async (signal) => {
  log(`收到 ${signal}，正在退出…`);
  clearInterval(heartbeat);
  try { await broker.close(); } catch { /* 忽略 */ }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (!config.relay?.deviceId || !config.relay?.deviceToken) {
  log('⚠ 还没配对中转站：本机桥接已在跑（DSH 等本地程序可直接用 3081），但中转站的任务投递需要先配对。');
  log('  去控制台「＋ 添加我的电脑」拿配对码，然后：npm run setup -- --pair <配对码> --server <地址>');
} else {
  await runAgent({
    server: config.relay.server,
    token: config.relay.deviceToken,
    deviceName: config.relay.name,
    localToken: config.token,
    localPort: port,
    timeoutMs,
  });
}
