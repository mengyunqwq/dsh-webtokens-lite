// lib/bridge.mjs — OpenAI 请求 ⇄ 上游网页桥接协议的转换与调用
//
// 这里同样**复用上游的 protocol.js / remote.js**：prepareRequest 负责把消息+工具
// 编成网页端能懂的提示词（并编译 Ajv 参数校验器），parseReply 负责校验网页回复里的
// request_id / kind / 工具参数。扩展端那套"格式错误自动纠正一次"的机制因此天然生效。
//
// 与中转站侧 web-bridge-openai.js 保持同一套加固（实测：某条链路 45% 失败 → 加固后 21%）：
//   1) 工具 schema 送出前放宽 additionalProperties、收回后按调用方原始 schema 剥多余字段
//      （实测故障：模型多写一个字段 → Ajv 判死 → 干等 45s → 纠正 → 75~108s 硬失败）
//   2) 输出格式硬约束：网页端偶发把回复写成散文/DSML，扩展认不出来 → 干等 45s → 纠正 → 失败
//   3) 停滞看门狗：阶段与推理 90s 无变化 → 主动断开（broker 会立刻释放唯一槽位）
//   4) 失败自动重试一次：换新的 request id 重开一轮（校验类失败也重试——扩展那次
//      「格式纠正」已经用掉了，再重试同一轮没有意义，而新开一轮成功只要 ~10s）
//   5) 固定复用同一个网页会话，并按累计体积轮换（防止网页会话膨胀）

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PLUGIN_DIR, DEFAULT_TIMEOUT_MS, STALL_MS, SESSION_MODE, SESSION_NAME, SESSION_BUDGET, FORMAT_GUARD, BRIDGE_MODE } from './config.mjs';
import { buildTask, parseReply } from './protocol.mjs';

let protocol;
let submitRemote;

export async function loadProtocol() {
  if (!protocol) protocol = await import(pathToFileURL(join(PLUGIN_DIR, 'protocol.js')).href);
  if (!submitRemote) ({ submitRemote } = await import(pathToFileURL(join(PLUGIN_DIR, 'remote.js')).href));
  return protocol;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 工具 schema：放宽 + 回收时剥多余字段 ---------------- */

/**
 * 放宽 schema：去掉 additionalProperties:false 这类「封闭对象」约束。
 * 为什么：网页模型常在参数里多写一个字段（例如 description），严格 schema 会让扩展端的
 * Ajv 判死并进入「纠正」长流程（实测 75~108 秒后仍失败）。放宽后能正常拿到工具调用，
 * 多出来的字段由 stripExtras 按调用方**原始** schema 剥掉，调用方契约不受影响。
 */
export function relaxSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(relaxSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' && v === false) continue;
    if (k === 'unevaluatedProperties' && v === false) continue;
    out[k] = relaxSchema(v);
  }
  return out;
}

/** 按调用方原始 schema 剥掉多余字段；看不懂的地方原样保留，绝不猜值 */
export function stripExtras(value, schema) {
  if (!schema || typeof schema !== 'object' || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const items = schema.items && !Array.isArray(schema.items) ? schema.items : null;
    return items ? value.map((v) => stripExtras(v, items)) : value;
  }
  if (typeof value !== 'object') return value;
  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : null;
  if (!props) return value;
  // 调用方**明确允许**额外字段时（additionalProperties 为 true 或一个子 schema），
  // 不能替它删掉——那会破坏它自己的契约。只有它没写、或写了 false 时才收紧。
  const extra = schema.additionalProperties;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!(k in props)) {
      if (extra === true) out[k] = v;
      else if (extra && typeof extra === 'object') out[k] = stripExtras(v, extra);
      continue;
    }
    out[k] = stripExtras(v, props[k]);
  }
  return out;
}

/** 原始（未放宽）的工具 schema，用于回收时剥字段 */
function originalSchemas(tools) {
  const map = new Map();
  for (const t of tools || []) {
    const fn = t?.function ?? t;
    if (fn?.name) map.set(String(fn.name), fn.parameters ?? null);
  }
  return map;
}

/* ---------------- 输出格式硬约束 ---------------- */

export const FORMAT_GUARD_TEXT = [
  '【本机桥接输出格式硬性要求（优先于上文任何风格要求）】',
  '你的整条回复必须且只能是一个 json 代码块，内容形如：',
  '{"request_id":"<本轮 REQUEST_ID>","kind":"final","text":"给用户的最终回答"}',
  '需要调用工具时用 {"request_id":"<本轮 REQUEST_ID>","kind":"tool_calls","calls":[{"name":"工具名","arguments":{…}}]}。',
  '不要在 JSON 之外输出任何解释、标题、前言或结尾；不要使用 DSML/XML 标记；不要用其它格式表达工具调用。',
].join('\n');

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
      parameters: relaxSchema(t.function.parameters && typeof t.function.parameters === 'object' ? t.function.parameters : { type: 'object', properties: {} }),
    }));
}

/* ---------------- 会话策略 ---------------- */

const sessionVolume = new Map();   // name -> { chars, gen }

function fingerprint(body) {
  return createHash('sha256').update(JSON.stringify((body?.messages || []).slice(0, 2))).digest('hex').slice(0, 16);
}

/** 会话键：默认固定复用一个网页会话，累计体积超预算就轮换（本客户端没有插件的分段摘要逻辑） */
export function sessionKeyFor(body, approxChars) {
  const explicit = body?.session_key || body?.sessionKey || body?.user;
  if (typeof explicit === 'string' && explicit.trim()) return 'user-' + explicit.trim().slice(0, 80);
  if (SESSION_MODE === 'request') return 'req-' + createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 12);
  if (SESSION_MODE === 'conversation') return 'conv-' + fingerprint(body);
  const cur = sessionVolume.get(SESSION_NAME) || { chars: 0, gen: 0 };
  if (cur.chars + approxChars > SESSION_BUDGET) { cur.gen += 1; cur.chars = 0; }
  cur.chars += approxChars;
  sessionVolume.set(SESSION_NAME, cur);
  return cur.gen ? `${SESSION_NAME}#${cur.gen}` : SESSION_NAME;
}

/* ---------------- 组装请求 ---------------- */

/** 组装一次桥接请求；工具定义非法时降级为纯文本，避免整单失败 */
export async function buildBridgeRequest(body, warnings = [], { enableTools = true } = {}) {
  const { prepareRequest } = await loadProtocol();
  const { messages, system } = toBridgeMessages(body?.messages || [], warnings);
  const tools = enableTools ? toBridgeTools(body?.tools) : [];
  const guarded = FORMAT_GUARD ? [system, FORMAT_GUARD_TEXT].filter(Boolean).join('\n\n') : system;
  const approxChars = JSON.stringify(messages).length + JSON.stringify(tools).length + (guarded?.length || 0);
  const options = { messages, system: guarded, tools, sessionId: sessionKeyFor(body, approxChars), purpose: 'conversation' };
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

/* ---------------- 提交（含看门狗） ---------------- */

/** 可重试：停滞/超时/传输中断/网页重载，以及协议校验类（纠正已失败，新开一轮才有意义） */
export function retryable(error) {
  const code = error?.code;
  if (['WEB_TIMEOUT', 'WEB_TRANSPORT_ERROR', 'WEB_ABORTED', 'WEB_PAGE_ERROR', 'WEB_DISCONNECTED',
    'WEB_TOOL_ARGUMENTS', 'WEB_TOOL_UNKNOWN', 'WEB_TOOL_MISSING_ARGS', 'WEB_REPLY_JSON', 'WEB_REPLY_KIND', 'WEB_REPLY_TEXT',
    'WEB_REPLY_CALLS', 'WEB_REQUEST_ID', 'WEB_BODY_PROTOCOL'].includes(code)) return true;
  return /stalled|aborted|socket hang up|未返回最终结果|格式纠正|仍未通过校验/.test(String(error?.message || ''));
}

/** 带看门狗的单次提交：阶段+推理长度长时间不变 → 判定停滞并断开（断开即释放唯一槽位） */
function submitWithWatchdog({ token, port, timeoutMs, request, signal, onProgress, phases }) {
  return new Promise((resolve, reject) => {
    // 外层已经取消（调用方断开）：直接失败，别白白占住网页那唯一的处理槽位
    if (signal?.aborted) {
      reject(Object.assign(new Error('请求已被取消，未提交到网页。'), { code: 'WEB_ABORTED' }));
      return;
    }
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    let last = { key: '', at: Date.now() };
    let stalled = false;
    const timer = setInterval(() => {
      if (Date.now() - last.at > STALL_MS) {
        stalled = true;
        clearInterval(timer);   // 先停表：否则 abort 传播期间每 5s 会再判一次、重复报阶段
        onProgress?.({ phase: `停滞 ${Math.round(STALL_MS / 1000)}s 无进展（最后阶段：${phases[phases.length - 1] || '未知'}），已主动放弃以释放槽位` });
        ac.abort();
      }
    }, 5000);
    const settle = (fn) => (value) => { clearInterval(timer); signal?.removeEventListener('abort', onOuterAbort); fn(value); };
    const onProg = (p) => {
      const key = (p?.phase || '') + '|' + (p?.reasoning?.length ?? 0);
      if (key !== last.key) {
        last = { key, at: Date.now() };
        if (p?.phase) { phases.push(p.phase); if (phases.length > 12) phases.shift(); }
      }
      onProgress?.(p);
    };

    let promise;
    try {
      // 防御性：当前上游的 submitRemote 是 `return new Promise(...)` 的非 async 函数，
      // 内部同步抛错会变成 reject（走下面的 then 分支，定时器能正常清），所以这条路径
      // 目前不可达。留它是为了防止日后换版本/换实现时出现「同步抛错 → interval 无人清 →
      // 进程被拖住不退出」这种极难排查的故障。
      promise = Promise.resolve(submitRemote({ port, token, timeoutMs }, request, ac.signal, onProg));
    } catch (error) {
      clearInterval(timer);
      signal?.removeEventListener('abort', onOuterAbort);
      reject(error);
      return;
    }

    promise.then(settle(resolve), settle((error) => {
      if (stalled) {
        reject(Object.assign(new Error(`网页侧停滞：${Math.round(STALL_MS / 1000)} 秒内阶段与推理都没有变化（最后阶段：${phases[phases.length - 1] || '未知'}）。已主动放弃以释放网页处理槽位。`), { code: 'WEB_TIMEOUT', stalled: true }));
      } else reject(error);
    }));
  });
}

/**
 * 把一次 OpenAI 请求交给本机桥接执行（含一次自动重试）。
 * @returns {Promise<{reply: object, raw: string, id: string, elapsedMs: number, attempts: number, phases: string[], warnings: string[]}>}
 */
export async function callBridge({ token, port = 3081, body, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = () => {}, signal, enableTools = true }) {
  // own 模式：走自研协议 + 自研 broker（不读 vendor/ 里的任何文件）
  if (BRIDGE_MODE === 'own') return callBridgeOwn({ token, port, body, timeoutMs, onProgress, signal, enableTools });
  const warnings = [];
  const phases = [];
  const started = Date.now();
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    // 每次尝试都重建请求：换新的 request id，避免撞上 broker 的「重复 id」校验
    let request;
    try {
      request = await buildBridgeRequest(body, warnings, { enableTools });
    } catch (error) {
      // 组装阶段就失败（例如工具定义无法编译且降级也失败）：把阶段带上，调用方仍能诊断
      throw Object.assign(error, { phases, warnings });
    }
    try {
      const raw = await submitWithWatchdog({ token, port, timeoutMs, request, signal, onProgress, phases });
      const { parseReply } = await loadProtocol();
      const reply = parseReply(raw, request);
      // 按调用方原始 schema 剥掉网页模型多写的字段
      if (enableTools && reply.kind === 'tool_calls') {
        const schemas = originalSchemas(body?.tools);
        reply.calls = reply.calls.map((call) => {
          const original = schemas.get(call.name);
          if (!original) return call;
          try {
            const args = JSON.parse(call.arguments || '{}');
            const cleaned = stripExtras(args, original);
            if (JSON.stringify(cleaned) !== JSON.stringify(args)) {
              warnings.push(`已按调用方 schema 剥掉 ${call.name} 参数里的多余字段（网页模型多写了字段）`);
              return { ...call, arguments: JSON.stringify(cleaned) };
            }
          } catch { /* 解析不了就原样传，绝不猜值 */ }
          return call;
        });
      }
      return { reply, raw, id: request.id, elapsedMs: Date.now() - started, attempts: attempt, phases, warnings };
    } catch (error) {
      lastError = error;
      const canRetry = attempt === 1 && !signal?.aborted && retryable(error);
      if (!canRetry) throw Object.assign(error, { phases });
      onProgress({ phase: `第 1 次失败（${error.code || ''} ${error.message}），已断开释放槽位，1.5s 后自动重试一次` });
      await sleep(1500);
    }
  }
  throw Object.assign(lastError, { phases });
}

/* ---------------- own 模式：自研协议 + 自研 broker ---------------- */

/** 读取自研 broker 的 NDJSON 流：progress 行转成 onProgress，result 行作为结果返回 */
async function readOwnStream(res, { phases, onProgress }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let at;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'progress' && event.phase) { phases.push(event.phase); onProgress({ phase: event.phase }); }
      else if (event.type === 'result') result = event;
    }
  }
  return result;
}

/**
 * own 模式的调用：把 OpenAI 请求编成一段提示词交给自研 broker，拿回答复原文后**在本机解析**。
 * 与上游路径的差别：解析与校验都在这里（不在浏览器扩展里），所以协议可以随时升级，
 * 用户不需要重新加载扩展。
 */
export async function callBridgeOwn({ token, port = 3081, body, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = () => {}, signal, enableTools = true }) {
  const phases = [];
  const warnings = [];
  const started = Date.now();
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const built = buildTask({
      messages: body?.messages || [],
      tools: enableTools ? (body?.tools || []) : [],
      guard: FORMAT_GUARD,
      // 重试时补一句提醒：模型上一轮"工具调用缺必需参数"是最常见的失败，
      // 明确点出来比原样重发有效得多（我们仍然绝不替它猜参数值）。
      nudge: attempt > 1 && lastError?.code === 'WEB_TOOL_MISSING_ARGS'
        ? '上一轮你的工具调用缺少必需参数。这次请把 parameters 里 required 列出的字段全部填上，不要交空对象。'
        : '',
    });
    const { id, prompt } = built;
    for (const w of built.warnings || []) warnings.push(w);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ prompt, requestId: built.id, timeoutMs }),
        signal,
      });
      if (!res.ok) throw Object.assign(new Error(`本机桥接 HTTP ${res.status}`), { code: 'WEB_HOST' });
      const result = await readOwnStream(res, { phases, onProgress });
      if (!result) throw Object.assign(new Error('本机桥接没有返回结果'), { code: 'WEB_EMPTY' });
      if (!result.ok) throw Object.assign(new Error(result.error || '网页侧失败'), { code: result.code || 'WEB_FAILED' });
      // schemas 传**调用方原始** schema：parseReply 依据它剥掉网页模型多写的字段
      const reply = parseReply(result.text, { id, schemas: originalSchemas(enableTools ? body?.tools : null) });
      for (const w of reply.warnings || []) warnings.push(w);
      return { reply, raw: result.text, id, elapsedMs: Date.now() - started, attempts: attempt, phases, warnings, metrics: result.metrics || null };
    } catch (error) {
      lastError = error;
      if (attempt === 2 || signal?.aborted || !retryable(error)) throw Object.assign(error, { phases });
      onProgress({ phase: `第 1 次失败（${error.code || ''} ${error.message}），1.5s 后自动重试一次` });
      await sleep(1500);
    }
  }
  throw Object.assign(lastError, { phases });
}

/* ---------------- 桥接结果 → OpenAI 响应 ---------------- */

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
