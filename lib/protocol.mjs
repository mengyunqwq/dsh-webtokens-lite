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

/** 输出契约：要求网页端只回一个 JSON 对象（与旧实现同样的文案，实测能压住散文/DSML）。
 *  注意：示例里的 request_id 用**明显不是本轮编号**的占位（req-示例编号）——
 *  因为现在解析会回落去读"页面尾部整段文本"，而提示词本身也在页面上；
 *  如果示例里写的是真编号，解析器就可能把示例当成答案（返回"给用户的最终回答"）。
 *  真编号在最后那一行单独说明。 */
export const FORMAT_GUARD = [
  '【本机桥接输出格式硬性要求（优先于上文任何风格要求）】',
  '你的整条回复必须且只能是一个 json 代码块，内容形如：',
  '{"request_id":"req-示例编号","kind":"final","text":"给用户的最终回答"}',
  '需要调用工具时用 {"request_id":"req-示例编号","kind":"tool_calls","calls":[{"name":"工具名","arguments":{…}}]}。',
  'text 里若本身含引号、花括号或换行，必须按 JSON 规则转义（引号写成 \\" ，换行写成 \\n）；否则整条回复会变成非法 JSON，本机解析只能报错。',
  '不要在 JSON 之外输出任何解释、标题、前言或结尾；不要使用 DSML/XML 标记；不要用其它格式表达工具调用。',
].join('\n');

/** 示例里的占位编号与示例文案：解析时用来识别"这不是真答案" */
export const EXAMPLE_REQUEST_ID = 'req-示例编号';
export const EXAMPLE_TEXT = '给用户的最终回答';

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
 * @param {{system?:string, messages?:unknown[], tools?:unknown[], requestId?:string, guard?:boolean, nudge?:string}} options
 *   nudge：重试时补的一句提醒（例如"上一轮工具调用缺了必需参数"）。放在最后，最靠近生成位置。
 */
export function buildTask({ system = '', messages = [], tools = [], requestId, guard = true, nudge = '' } = {}) {
  const warnings = [];
  const id = requestId || 'req-' + randomUUID().slice(0, 8);
  const { systems, turns } = renderMessages(messages, warnings);
  const toolDefs = renderTools(tools);

  const blocks = [];
  const allSystem = [system, ...systems].filter(Boolean).join('\n\n');
  if (allSystem) blocks.push('【系统指令】\n' + allSystem);
  if (guard) blocks.push(FORMAT_GUARD);   // 示例里是占位编号；真编号在最后一行单独说明
  if (turns.length) blocks.push('【对话】\n' + turns.join('\n\n'));
  if (toolDefs.length) {
    blocks.push('【本轮可用工具定义（arguments 必须符合对应 parameters）】\n' + JSON.stringify(toolDefs, null, 2));
  }
  if (nudge) blocks.push('【上一轮的问题，这次务必避免】\n' + nudge);
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

  // 3) 文本里扫描平衡的大括号块（字符串感知），取**最后一个**能解析的
  //    为什么要"字符串感知"：JSON 里的中文/花括号出现在字符串里时不能参与括号计数
  const objects = extractJsonObjects(text);
  return objects.length ? objects[0] : null;
}

/**
 * 抠出文本里**所有**能解析的 JSON 对象，从后往前返回。
 * 为什么需要"所有"而不是最后一个：页面尾部整段文本里既有网页的答复，也可能有我们自己
 * 提示词里的**示例**（示例的 request_id 是占位编号）。解析方需要往前多找几个候选，
 * 才能跳过示例、拿到真答案。
 */
export function extractJsonObjects(text) {
  const s = String(text ?? '');
  const out = [];
  if (!s.trim()) return out;
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (const body of fences.reverse()) { const o = tryParse(body); if (o) out.push(o); }
  const whole = tryParse(s.trim());
  if (whole) out.push(whole);
  const candidates = [];
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
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
        if (depth === 0 && start >= 0) { candidates.push(s.slice(start, i + 1)); start = -1; }
      }
    }
  }
  for (const c of candidates.reverse()) { const o = tryParse(c); if (o && !out.includes(o)) out.push(o); }
  return out;
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
 * 容错修复：模型写出的"差一点就合法"的 JSON。两类真实故障（都是真机踩到的）：
 *   ① **非法的反斜杠转义**：写 Windows 路径时用单反斜杠 —— `"command":"Get-ChildItem 'E:\梦云Agent'"`
 *      里的 `\梦` 不是合法 JSON 转义，JSON.parse 直接失败（实测：候选数 0，只能报 WEB_REPLY_JSON，
 *      用户看到的就是"网页答复里没有可解析的 JSON 对象…"）。
 *   ② **text 字段里未转义的引号**：把一段 JSON 塞进 text 却不转义里面的引号。
 * 两步都试，然后交给**同一个候选扫描器**取对象（它会处理 ``` 围栏、前置散文、多对象）。
 * 严格限定：只有"现有候选里没有形态合法对象"时才会被调用；修出来的对象还要过 kind 与本轮编号校验；
 * 修不动就返回 null —— 宁可报错，也不猜。
 */
function repairMalformedReply(raw) {
  let s = String(raw ?? '');
  const fixes = [];
  // ① 非法转义 → 把那个反斜杠本身转义（合法转义 \\ \" \/ \b \f \n \r \t \uXXXX 不受影响）
  const noBadEscape = s.replace(/\\(?![\\"/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\');
  if (noBadEscape !== s) { s = noBadEscape; fixes.push('非法的反斜杠转义'); }
  // ② "text" 里未转义的引号
  const m = /"text"\s*:\s*"/.exec(s);
  const tail = /"\s*\}\s*(?:```)?\s*$/.exec(s);
  if (m && tail && tail.index > m.index + m[0].length) {
    const start = m.index + m[0].length;
    const end = tail.index;
    const value = s.slice(start, end);
    if (value.includes('"')) {
      s = s.slice(0, start) + value.replace(/(^|[^\\])"/g, '$1\\"') + s.slice(end);
      fixes.push('text 里未转义的引号');
    }
  }
  if (!fixes.length) return null;
  const objs = extractJsonObjects(s);
  const obj = objs.find((o) => ['final', 'tool_calls'].includes(String(o?.kind || ''))) || objs[0] || null;
  return obj ? { obj, fixes } : null;
}

/**
 * 解析网页答复。
 * @param {string} raw 网页答复原文
 * @param {{id:string, schemas?:Map<string,object>}} options schemas = 调用方**原始**工具 schema
 * @returns {{kind:'final'|'tool_calls', text:string, calls:Array<{id:string,name:string,arguments:string}>, warnings:string[]}}
 */
export function parseReply(raw, { id, schemas = new Map() } = {}) {
  const warnings = [];
  // 修复只在"现有候选里没有形态合法的"时候才用：模型把一段 JSON 塞进 text 却不转义时，
  // 候选扫描只能捞到里面碎掉的小对象（例如 {"name":"苹果"}），它会被后面的兜底规则选中、
  // 报出误导性的 kind 错 —— 真机就是这样，所以必须先给修复出来的对象一个优先级。
  const hasShape = (o) => ['final', 'tool_calls'].includes(String(o?.kind || ''))
    && (!o?.request_id || String(o.request_id) === String(id));
  let objects = extractJsonObjects(raw);
  if (!objects.some(hasShape)) {
    const rep = repairMalformedReply(raw);
    if (rep && hasShape(rep.obj)) {
      objects = [rep.obj, ...objects];
      warnings.push(`网页答复的 JSON 有格式问题（${rep.fixes.join('、')}），已容错修复后解析（模型没按 JSON 规则转义）`);
    }
  }
  if (!objects.length) {
    // 把网页原文的开头带上：否则这条报错只说"没有 JSON"，用户与排查者都不知道网页到底说了什么
    // （真机踩到：只看到这一句，无法区分是半截回答、散文、还是被模型拒绝）。
    const head = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
    throw new ProtocolError(`网页答复里没有可解析的 JSON 对象（可能写成了散文或 DSML，也可能是半截回答）${head ? `；网页原文开头：${head}` : '；网页原文为空'}`, 'WEB_REPLY_JSON');
  }
  // 选一个"像真答案"的：跳过输出契约里的示例（占位编号 / 示例文案）。
  // 优先级（N3 修复）：**先认"带本轮编号且 kind 合法"的**，再容忍漏写编号但形态合法的，
  // 之后才是"编号对但 kind 不对"（会走到下面的 kind 报错），最后才退回任意候选。
  // 为什么改：原顺序把"没有编号的任意对象"排在"按 kind 回落"之前，页面文本里只要有
  // 提示词自带的工具定义 JSON 或注入对象，就可能被当成答复返回（实测复现过）。
  const isExample = (o) => String(o?.request_id || '') === EXAMPLE_REQUEST_ID || String(o?.text || '') === EXAMPLE_TEXT;
  const usable = objects.filter((o) => !isExample(o));
  if (!usable.length) throw new ProtocolError('网页答复里只有输出契约的示例，没有真正的答复', 'WEB_REPLY_JSON');
  const kindValid = (o) => ['final', 'tool_calls'].includes(String(o?.kind || ''));
  const idOf = (o) => String(o?.request_id || '');
  const obj = usable.find((o) => idOf(o) === String(id) && kindValid(o))
    || usable.find((o) => !o.request_id && kindValid(o))
    || usable.find((o) => idOf(o) === String(id))
    || usable.find(kindValid)
    || usable.find((o) => !o.request_id)
    || usable[0];
  // 严格判定：候选里若**所有**对象都带着"不是本轮"的编号，那就很可能是读到了上一轮的旧答复——
  // 宁可报错（可重试），也不能把旧答复当成这一轮的答案交给调用方。
  if (obj.request_id && String(obj.request_id) !== String(id)) {
    throw new ProtocolError(`网页答复的 request_id 不匹配（收到 ${obj.request_id}，期望 ${id}），可能是上一轮的旧答复`, 'WEB_REQUEST_ID');
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
      // 必需参数缺失 → 判**可重试**错误，让调用方重发一轮（并带上提醒）。
      // 为什么不是"补个默认值"：我们**绝不猜参数值**——一个瞎猜的城市名比一次重试危险得多。
      const required = Array.isArray(original.required) ? original.required : [];
      const missing = required.filter((key) => !(key in args));
      if (missing.length) {
        throw new ProtocolError(`工具 ${name} 的调用缺少必需参数：${missing.join('、')}`, 'WEB_TOOL_MISSING_ARGS');
      }
    }
    return { id: c?.id ? String(c.id) : `web-${id}-${i}`, name, arguments: JSON.stringify(args) };
  });

  const text = typeof obj.text === 'string' ? obj.text : '';
  return { kind: 'tool_calls', text, calls, warnings };
}

/**
 * 从工具定义里取出「名称 → 原始 schema」。
 * 为什么要原始 schema：parseReply 用它把网页模型多写的字段剥掉，而**送出前**那份是放宽过的
 * （relaxSchema 去掉了 additionalProperties:false）。两头用不同的 schema 才不会互相打架。
 * 兼容两种常见形状：{name, parameters} 与 {type:'function', function:{name, parameters}}。
 */
export function schemasOf(tools = []) {
  const map = new Map();
  for (const tool of tools || []) {
    const fn = tool?.function ?? tool;
    if (fn?.name) map.set(fn.name, fn.parameters || fn.inputSchema || { type: 'object', properties: {} });
  }
  return map;
}

/**
 * 把解析结果转成 DSH 的流式分片。
 * 契约（由宿主消费）：block-start → text-delta / tool-call-delta → block-end，最后 finish。
 * **不发 usage 分片**：DeepSeek 网页端不提供可信的用量数字，我们不编造。
 */
export function* replyChunks(reply, index = 0) {
  if (reply.text) {
    yield { type: 'block-start', index, blockType: 'text' };
    yield { type: 'text-delta', index, text: reply.text };
    yield { type: 'block-end', index, block: { type: 'text', text: reply.text } };
    index++;
  }
  for (const call of reply.calls || []) {
    yield { type: 'block-start', index, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments };
    yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } };
    index++;
  }
  yield { type: 'finish', reason: { kind: reply.kind === 'tool_calls' ? 'tool-calls' : 'stop' } };
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
