// lib/protocol.mjs — 自研桥接协议：把 OpenAI 请求编成提示词，把网页答复原文解析回结构化结果
//
// 与上游的分工差别（见 docs/own-bridge.md）：**解析与校验留在客户端**，扩展只负责
// "把提示词提交到网页、把答复原文取回来"。带来的好处：
//   · 扩展从约 1200 行缩到几百行；
//   · 协议迭代不需要用户重新加载扩展（解析逻辑在我们这边升级即可）；
//   · 解析可以脱离浏览器做单测（本文件就是纯函数，没有任何浏览器 API）。
//
// 这里**不用 Ajv**：schema 在送出前放宽（relaxSchema）、收回来按原始 schema 剥多余字段
// （stripExtras），两头夹住就不需要一台严格校验器（也省掉一个运行时依赖）。

import { randomUUID } from 'node:crypto';
import { relaxSchema, stripExtras } from './schema.mjs';

/** 输出契约：要求网页端只回一个 JSON 对象（与旧实现同样的文案，实测能压住散文/DSML） */
export const FORMAT_GUARD = [
  '【本机桥接输出格式硬性要求（优先于上文任何风格要求）】',
  '你的整条回复必须且只能是一个 json 代码块，内容形如：',
  '{"request_id":"<本轮 REQUEST_ID>","kind":"final","text":"给用户的最终回答"}',
  '需要调用工具时用 {"request_id":"<本轮 REQUEST_ID>","kind":"tool_calls","calls":[{"name":"工具名","arguments":{…}}]}。',
  '不要在 JSON 之外输出任何解释、标题、前言或结尾；不要使用 DSML/XML 标记；不要用其它格式表达工具调用。',
].join('\n');

/** 把各种形态的 content 折成纯文本（图片等非文本块明确省略并记一条警告） */
export function textOfContent(content, warnings = []) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') { parts.push(part); continue; }
      if (!part) continue;
      if (part.type === 'text' && typeof part.text === 'string') { parts.push(part.text); continue; }
      if (part.type === 'image_url') { warnings.push('请求含图片块：网页桥接仅支持文本，图片已省略'); continue; }
    }
    return parts.filter(Boolean).join('\n');
  }
  return content == null ? '' : String(content);
}

function renderMessages(messages = [], warnings = []) {
  const systems = [];
  const turns = [];
  for (const m of messages) {
    const role = String(m?.role || 'user');
    const text = textOfContent(m?.content, warnings);
    if (role === 'system' || role === 'developer') { if (text) systems.push(text); continue; }
    if (role === 'tool') { turns.push(`[工具结果 ${m.tool_call_id || ''}] ${text}`); continue; }
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls
        .map((c) => `- ${c?.function?.name || c?.name || '?'}(${c?.function?.arguments || '{}'})`)
        .join('\n');
      turns.push([text, '[上一轮请求的工具调用]\n' + calls].filter(Boolean).join('\n'));
      continue;
    }
    turns.push(`[${role}] ${text}`);
  }
  return { systems, turns };
}

function renderTools(tools = []) {
  return tools.map((t) => ({ name: t.name, description: t.description || '', parameters: relaxSchema(t.parameters || { type: 'object', properties: {} }) }));
}

/**
 * 组装一次任务。返回 { id, prompt }：prompt 是给网页的**一整段**文本（扩展只负责原样提交）。
 * @param {{system?:string, messages?:unknown[], tools?:unknown[], requestId?:string, guard?:boolean}} options
 */
export function buildTask({ system = '', messages = [], tools = [], requestId, guard = true } = {}) {
  const warnings = [];
  const id = requestId || 'req-' + randomUUID().slice(0, 8);
  const { systems, turns } = renderMessages(messages, warnings);
  const toolDefs = renderTools(tools);

  const blocks = [];
  const allSystem = [system, ...systems].filter(Boolean).join('\n\n');
  if (allSystem) blocks.push('【系统指令】\n' + allSystem);
  if (guard) blocks.push(FORMAT_GUARD.replace(/<本轮 REQUEST_ID>/g, id));
  if (turns.length) blocks.push('【对话】\n' + turns.join('\n\n'));
  if (toolDefs.length) {
    blocks.push('【本轮可用工具定义（arguments 必须符合对应 parameters）】\n' + JSON.stringify(toolDefs, null, 2));
  }
  blocks.push(`【现在开始】只输出那个 JSON 对象，request_id 必须是 "${id}"。`);
  return { id, prompt: blocks.join('\n\n'), warnings };
}

/**
 * 从答复原文里抠出 JSON 对象。容忍：```json 围栏、前后散文、DSML 残留、多个候选（取最后一个像样的）。
 * 返回解析出的对象，找不到返回 null。导出以便单测。
 */
export function extractJsonObject(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return null;

  // 1) 优先代码围栏
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (const body of fences.reverse()) {
    const obj = tryParse(body);
    if (obj) return obj;
  }
  // 2) 整体就是一个 JSON
  const whole = tryParse(text.trim());
  if (whole) return whole;

  // 3) 文本里扫描平衡的大括号块（字符串感知），从后往前取第一个能解析的
  //    为什么要"字符串感知"：JSON 里的中文/花括号出现在字符串里时不能参与括号计数
  const candidates = [];
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) { candidates.push(text.slice(start, i + 1)); start = -1; }
      }
    }
  }
  for (const c of candidates.reverse()) {
    const obj = tryParse(c);
    if (obj) return obj;
  }
  return null;
}

function tryParse(s) {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

export class ProtocolError extends Error {
  constructor(message, code) { super(message); this.name = 'ProtocolError'; this.code = code; }
}

/**
 * 解析网页答复。
 * @param {string} raw 网页答复原文
 * @param {{id:string, schemas?:Map<string,object>}} options schemas = 调用方**原始**工具 schema
 * @returns {{kind:'final'|'tool_calls', text:string, calls:Array<{id:string,name:string,arguments:string}>, warnings:string[]}}
 */
export function parseReply(raw, { id, schemas = new Map() } = {}) {
  const warnings = [];
  const obj = extractJsonObject(raw);
  if (!obj) {
    throw new ProtocolError('网页答复里没有可解析的 JSON 对象（可能写成了散文或 DSML）', 'WEB_REPLY_JSON');
  }
  if (obj.request_id && String(obj.request_id) !== String(id)) {
    throw new ProtocolError(`网页答复的 request_id 不匹配（收到 ${obj.request_id}，期望 ${id}）`, 'WEB_REQUEST_ID');
  }
  const kind = String(obj.kind || '');
  if (kind === 'final') {
    const text = typeof obj.text === 'string' ? obj.text : (obj.text == null ? '' : String(obj.text));
    if (!text.trim()) throw new ProtocolError('网页答复 kind=final 但 text 为空', 'WEB_REPLY_TEXT');
    return { kind: 'final', text, calls: [], warnings };
  }
  if (kind !== 'tool_calls') {
    throw new ProtocolError(`网页答复 kind 必须是 final 或 tool_calls（收到 ${JSON.stringify(obj.kind)}）`, 'WEB_REPLY_KIND');
  }
  const rawCalls = Array.isArray(obj.calls) ? obj.calls : null;
  if (!rawCalls || !rawCalls.length) throw new ProtocolError('网页答复 kind=tool_calls 但没有 calls', 'WEB_REPLY_CALLS');

  const calls = rawCalls.map((c, i) => {
    const name = String(c?.name || '');
    if (!name) throw new ProtocolError(`第 ${i + 1} 个工具调用缺少 name`, 'WEB_TOOL_UNKNOWN');
    let args = c?.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args || '{}'); }
      catch { throw new ProtocolError(`工具 ${name} 的 arguments 不是合法 JSON`, 'WEB_TOOL_ARGUMENTS'); }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new ProtocolError(`工具 ${name} 的 arguments 必须是对象`, 'WEB_TOOL_ARGUMENTS');
    }
    const original = schemas.get(name);
    if (original) {
      const cleaned = stripExtras(args, original);
      if (JSON.stringify(cleaned) !== JSON.stringify(args)) {
        warnings.push(`已按调用方 schema 剥掉 ${name} 参数里的多余字段（网页模型多写了字段）`);
        args = cleaned;
      }
    }
    return { id: c?.id ? String(c.id) : `web-${id}-${i}`, name, arguments: JSON.stringify(args) };
  });

  const text = typeof obj.text === 'string' ? obj.text : '';
  return { kind: 'tool_calls', text, calls, warnings };
}

/** 把解析结果转成 OpenAI 风格的 completion（与旧实现同形，调用方无需改动） */
export function toOpenAICompletion(reply, { model, id, created = Math.floor(Date.now() / 1000) } = {}) {
  const base = { id: 'chatcmpl-' + (id || 'web'), object: 'chat.completion', created, model: model || 'web-deepseek' };
  if (reply.kind === 'tool_calls') {
    return {
      ...base,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: reply.text || null,
          tool_calls: reply.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        },
        finish_reason: 'tool_calls',
      }],
      // 故意不返回 usage：网页端不提供真实用量，不伪造
    };
  }
  return { ...base, choices: [{ index: 0, message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }] };
}
