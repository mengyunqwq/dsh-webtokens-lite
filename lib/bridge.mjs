// lib/bridge.mjs — OpenAI 请求 ⇄ 上游网页桥接协议的转换与调用
//
// 这里同样**复用上游的 protocol.js / remote.js**：prepareRequest 负责把消息+工具
// 编成网页端能懂的提示词（并编译 Ajv 参数校验器），parseReply 负责校验网页回复里的
// request_id / kind / 工具参数。扩展端那套"格式错误自动纠正一次"的机制因此天然生效。

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PLUGIN_DIR, DEFAULT_TIMEOUT_MS } from './config.mjs';

let protocol;
let submitRemote;

export async function loadProtocol() {
  if (!protocol) protocol = await import(pathToFileURL(join(PLUGIN_DIR, 'protocol.js')).href);
  if (!submitRemote) ({ submitRemote } = await import(pathToFileURL(join(PLUGIN_DIR, 'remote.js')).href));
  return protocol;
}

/* ---------------- OpenAI → 桥接 ---------------- */

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
      if (part && part.type === 'image_url') return '[图片已省略：网页桥接首版仅支持文本]';
      return '';
    }).filter(Boolean).join('\n');
  }
  return content == null ? '' : String(content);
}

function toBridgeMessages(messages = [], warnings = []) {
  const out = [];
  const systems = [];
  for (const m of messages) {
    const role = String(m?.role || 'user');
    const text = textOf(m?.content);
    if (role === 'system' || role === 'developer') { if (text) systems.push(text); continue; }
    if (role === 'tool') {
      out.push({ role: 'tool', source: { kind: 'relay' }, content: [{ type: 'text', text: `[工具结果 ${m.tool_call_id || ''}]\n${text}` }] });
      continue;
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((c) => `- ${c?.function?.name || c?.name || '?'}(${c?.function?.arguments || '{}'})`).join('\n');
      out.push({ role: 'assistant', source: { kind: 'relay' }, content: [{ type: 'text', text: [text, '[上一轮请求的工具调用]\n' + calls].filter(Boolean).join('\n') }] });
      continue;
    }
    out.push({ role, source: { kind: 'relay' }, content: [{ type: 'text', text }] });
  }
  if (messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p && p.type === 'image_url'))) {
    warnings.push('请求含图片块：网页桥接仅支持文本，图片已省略');
  }
  return { messages: out, system: systems.join('\n\n') || undefined };
}

function toBridgeTools(tools) {
  return (tools || [])
    .filter((t) => t && (t.type === 'function' || t.function) && t.function && t.function.name)
    .map((t) => ({
      name: String(t.function.name),
      description: String(t.function.description || ''),
      parameters: t.function.parameters && typeof t.function.parameters === 'object' ? t.function.parameters : { type: 'object', properties: {} },
    }));
}

/** 会话键：同一段对话保持稳定，让扩展复用同一个专用网页会话 */
function sessionKeyFor(body) {
  const explicit = body?.session_key || body?.sessionKey || body?.user;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().slice(0, 120);
  const seed = JSON.stringify((body?.messages || []).slice(0, 2));
  return 'lite-' + createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/** 组装一次桥接请求；工具定义非法时降级为纯文本，避免整单失败 */
export async function buildBridgeRequest(body, warnings = [], { enableTools = true } = {}) {
  const { prepareRequest } = await loadProtocol();
  const { messages, system } = toBridgeMessages(body?.messages || [], warnings);
  const tools = enableTools ? toBridgeTools(body?.tools) : [];
  const options = { messages, system, tools, sessionId: sessionKeyFor(body), purpose: 'conversation' };
  try {
    return prepareRequest(options);
  } catch (error) {
    if (tools.length && (error?.code === undefined || /schema|compile|ajv/i.test(String(error?.message)))) {
      warnings.push('工具定义无法用于网页端校验，本次已降级为纯文本：' + error.message);
      return prepareRequest({ ...options, tools: [] });
    }
    throw error;
  }
}

/* ---------------- 调用本机 broker ---------------- */

/**
 * 把一次 OpenAI 请求交给本机桥接执行。
 * @returns {Promise<{reply: object, raw: string, id: string, elapsedMs: number}>}
 */
export async function callBridge({ token, port = 3081, body, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = () => {}, signal, enableTools = true }) {
  const warnings = [];
  const request = await buildBridgeRequest(body, warnings, { enableTools });
  const started = Date.now();
  const raw = await submitRemote({ port, token, timeoutMs }, request, signal, onProgress);
  const { parseReply } = await loadProtocol();
  const reply = parseReply(raw, request);
  return { reply, raw, id: request.id, elapsedMs: Date.now() - started, warnings };
}

/* ---------------- 桥接结果 → OpenAI 响应 ---------------- */

export function toOpenAICompletion(reply, { model, id, created = Math.floor(Date.now() / 1000) } = {}) {
  const base = {
    id: 'chatcmpl-' + (id || 'web'),
    object: 'chat.completion',
    created,
    model: model || 'web-deepseek',
  };
  if (reply.kind === 'tool_calls') {
    return {
      ...base,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: reply.text || null,
          tool_calls: reply.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
        },
        finish_reason: 'tool_calls',
      }],
      // 故意不返回 usage：网页端不提供真实用量，上游也明确拒绝伪造
    };
  }
  return {
    ...base,
    choices: [{ index: 0, message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }],
  };
}
