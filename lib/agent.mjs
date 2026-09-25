// lib/agent.mjs — 与中转站的「本机连接器」通道对接，用你自己的浏览器服务 web_prompt 任务
//
// 走的正是中转站已有的连接器协议（无需服务器端新增通道）：
//   配对：POST {server}/agent/runner/pair     { code, name, platform }            → { token, deviceId }
//   取活：POST {server}/agent/runner/poll     x-agent-token 头，长轮询             → { job }
//   回报：POST {server}/agent/runner/result   { jobId, ok, output, error, meta }
//
// 本机只处理一种任务：web_prompt —— 参数里带原始 OpenAI 请求体，
// 由本进程调用本机 3081 桥接完成，回传一个 OpenAI 格式的完整响应。

import os from 'node:os';
import { callBridge, toOpenAICompletion } from './bridge.mjs';
import { DEFAULT_TIMEOUT_MS } from './config.mjs';

export const AGENT_VERSION = '0.1.0';
const POLL_HOLD_MS = 25_000;
const POLL_RETRY_MS = 5_000;

function log(...args) { console.log(new Date().toISOString().slice(11, 19), ...args); }

function platformTag() {
  return `${os.platform()}-${os.arch()}`;
}

/** 用配对码把本机注册成中转站的一台设备 */
export async function pair({ server, code, name }) {
  const url = String(server).replace(/\/+$/, '') + '/agent/runner/pair';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(code).trim().toUpperCase(), name: name || `${os.hostname()} · 网页桥接`, platform: platformTag() }),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok || !data?.token) throw new Error(`配对失败（HTTP ${res.status}）：${data?.error || text.slice(0, 300)}`);
  return data; // { token, deviceId, name }
}

async function poll(baseUrl, token, deviceName) {
  const res = await fetch(baseUrl + '/agent/runner/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': token },
    body: JSON.stringify({ holdMs: POLL_HOLD_MS, name: deviceName, platform: platformTag(), version: AGENT_VERSION }),
  });
  if (res.status === 401) throw Object.assign(new Error('设备令牌无效：请重新配对（可能是控制台里把这台设备删了）'), { fatal: true });
  if (res.status === 403) throw Object.assign(new Error('这台设备已被停用：请到中转站控制台重新启用'), { fatal: true });
  if (!res.ok) throw new Error(`轮询失败 HTTP ${res.status}`);
  return res.json();
}

async function submit(baseUrl, token, payload) {
  const res = await fetch(baseUrl + '/agent/runner/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': token },
    body: JSON.stringify(payload),
  });
  if (!res.ok) log(`回报结果失败 HTTP ${res.status}`);
}

/**
 * 启动长轮询循环。永不 resolve（除非致命错误），断线自动退避重连。
 * @param {{server: string, token: string, deviceName: string, localToken: string, localPort?: number, timeoutMs?: number, enableTools?: boolean}} options
 */
export async function runAgent({ server, token, deviceName, localToken, localPort = 3081, timeoutMs = DEFAULT_TIMEOUT_MS, enableTools = true }) {
  const baseUrl = String(server).replace(/\/+$/, '');
  log(`连接器已启动：设备「${deviceName}」→ ${baseUrl}`);
  let backoff = POLL_RETRY_MS;

  for (;;) {
    let payload;
    try {
      payload = await poll(baseUrl, token, deviceName);
      backoff = POLL_RETRY_MS;
    } catch (error) {
      if (error.fatal) { log('致命：' + error.message); throw error; }
      log(`轮询出错，${Math.round(backoff / 1000)}s 后重试：${error.message}`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }

    const job = payload?.job;
    if (!job) continue;

    // 本机只认 web_prompt：其它工具一律明确报错，绝不静默吞掉任务
    if (job.name !== 'web_prompt') {
      log(`收到不支持的任务 ${job.name}（本连接器只处理 web_prompt）`);
      await submit(baseUrl, token, {
        jobId: job.jobId, ok: false,
        error: `这台电脑只运行了网页桥接连接器，不支持工具 ${job.name}。请把这类任务投给完整版连接器，或检查中转站的设备选择。`,
        meta: { agent: AGENT_VERSION, kind: 'unsupported-tool' },
      });
      continue;
    }

    const body = job.args?.body ?? job.args ?? null;
    const budget = Number(job.args?.timeoutMs) > 0 ? Number(job.args.timeoutMs) : timeoutMs;
    const promptChars = JSON.stringify(body?.messages ?? '').length;
    log(`开始处理任务 ${job.jobId}（输入 ${promptChars} 字符，预算 ${Math.round(budget / 1000)}s）`);

    try {
      if (!body || !Array.isArray(body.messages) || !body.messages.length) throw new Error('任务参数缺少 body.messages');
      const { reply, elapsedMs, warnings } = await callBridge({
        token: localToken, port: localPort, body, timeoutMs: budget, enableTools,
        onProgress: (p) => { if (p?.phase) log(`  阶段：${p.phase}`); },
      });
      const completion = toOpenAICompletion(reply, { model: body.model, id: job.jobId });
      if (warnings?.length) log('  警告：' + warnings.join('；'));
      log(`任务完成 ${job.jobId}：${reply.kind}${reply.kind === 'tool_calls' ? `（${reply.calls.length} 个工具调用）` : ''}，${elapsedMs}ms`);
      await submit(baseUrl, token, {
        jobId: job.jobId, ok: true, output: JSON.stringify(completion), error: '',
        meta: { agent: AGENT_VERSION, kind: reply.kind, elapsedMs, warnings: warnings?.length ? warnings : undefined },
      });
    } catch (error) {
      log(`任务失败 ${job.jobId}：${error.code || ''} ${error.message}`);
      await submit(baseUrl, token, {
        jobId: job.jobId, ok: false, error: String(error.message || error).slice(0, 900),
        meta: { agent: AGENT_VERSION, code: error.code || null },
      });
    }
  }
}
