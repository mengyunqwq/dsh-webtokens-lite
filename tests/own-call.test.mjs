// own 模式的端到端测试（不需要浏览器）：
// 真起一个自研 broker，用一个"假扩展"长轮询领任务并回报，验证
// callBridge → 组装提示词 → broker → 假扩展 → 回传原文 → 本机解析 → OpenAI 响应 这条链路。
// 同时覆盖：重试（第一次让扩展报错）、工具调用、参数剥字段、取消/超时。
import { createBroker } from '../lib/broker.mjs';
import { callBridgeOwn } from '../lib/bridge.mjs';
import { toOpenAICompletion } from '../lib/protocol.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'tk_own_' + Math.random().toString(16).slice(2).padEnd(40, 'x').slice(0, 43);
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); } else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); } };

const broker = createBroker({ token: TOKEN, port: 0, timeoutMs: 6000, stallMs: 4000, log: () => {} });
await broker.start();
const PORT = broker.port;
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN };

/** 假扩展：长轮询领任务，按 reply 决定回什么（reply 可以是函数：拿到 prompt 再决定） */
async function fakeExtension(reply, { polls = 1 } = {}) {
  const seen = [];
  for (let i = 0; i < polls; i++) {
    const res = await fetch(`http://127.0.0.1:${PORT}/ext/poll`, { method: 'POST', headers: H, body: JSON.stringify({ clientId: 'fake-ext', version: '1.0.0', state: '测试' }) });
    const body = await res.json();
    if (!body.task) { seen.push({ empty: true }); continue; }
    const { id, lease, prompt } = body.task;
    const out = typeof reply === 'function' ? reply(prompt, i) : reply;
    if (out?.phase) await fetch(`http://127.0.0.1:${PORT}/ext/progress`, { method: 'POST', headers: H, body: JSON.stringify({ taskId: id, lease, phase: out.phase }) });
    await fetch(`http://127.0.0.1:${PORT}/ext/result`, { method: 'POST', headers: H, body: JSON.stringify({ taskId: id, lease, ok: out?.ok !== false, text: out?.text ?? '', error: out?.error ?? '', metrics: { chars: String(out?.text ?? '').length } }) });
    seen.push({ prompt, id });
  }
  return seen;
}

console.log('=== 1) 文本答复：组装 → 派发 → 回传 → 解析 ===');
{
  const ext = fakeExtension((prompt) => {
    const id = /"request_id":"([^"]+)"/.exec(prompt)?.[1] ?? '?';
    return { phase: '网页正在生成回复', text: '```json\n' + JSON.stringify({ request_id: id, kind: 'final', text: '北京的天气是晴' }) + '\n```' };
  }, { polls: 1 });
  const progress = [];
  const out = await callBridgeOwn({
    token: TOKEN, port: PORT, timeoutMs: 5000, onProgress: (p) => progress.push(p.phase),
    body: { model: 'web-deepseek', messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '北京天气？' }] },
  });
  await ext;
  check('拿到 final 答复', out.reply.kind === 'final' && out.reply.text === '北京的天气是晴');
  check('提示词里带上了系统指令与输出契约', /你是助手/.test((await ext)[0].prompt) && /request_id/.test((await ext)[0].prompt));
  check('进度被透传', progress.some((p) => /生成/.test(p)), JSON.stringify(progress));
  check('带回了耗时与阶段', out.elapsedMs >= 0 && Array.isArray(out.phases));
  const completion = toOpenAICompletion(out.reply, { model: 'web-deepseek', id: out.id });
  check('转成 OpenAI 响应正确', completion.choices[0].message.content === '北京的天气是晴' && completion.choices[0].finish_reason === 'stop');
}

console.log('\n=== 2) 工具调用 + 参数剥字段 ===');
{
  const ext = fakeExtension((prompt) => {
    const id = /"request_id":"([^"]+)"/.exec(prompt)?.[1] ?? '?';
    return { text: JSON.stringify({ request_id: id, kind: 'tool_calls', calls: [{ name: 'get_weather', arguments: { city: '北京', extra: '多写的字段' } }] }) };
  }, { polls: 1 });
  const out = await callBridgeOwn({
    token: TOKEN, port: PORT, timeoutMs: 5000,
    body: {
      model: 'web-deepseek',
      messages: [{ role: 'user', content: '查北京天气' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } }],
    },
  });
  await ext;
  check('拿到 tool_calls', out.reply.kind === 'tool_calls' && out.reply.calls[0].name === 'get_weather');
  check('参数里的多余字段被剥掉', JSON.parse(out.reply.calls[0].arguments).city === '北京' && !('extra' in JSON.parse(out.reply.calls[0].arguments)));
  check('产生了剥字段的提示', out.warnings.some((w) => /多余字段/.test(w)));
  const completion = toOpenAICompletion(out.reply, { model: 'web-deepseek', id: out.id });
  check('OpenAI 响应里 finish_reason=tool_calls', completion.choices[0].finish_reason === 'tool_calls' && completion.choices[0].message.tool_calls.length === 1);
}

console.log('\n=== 3) 第一次答成散文（本机解析失败，可重试）→ 自动重试一次（换新 request_id）===');
{
  // 注意：这里**故意**不用"网页侧失败"来测重试——网页侧失败（如页面重载）是不能重试的，
  // 重发会让用户账号里出现两条一样的提问。可以安全重试的是"答复解析失败"。
  const ids = [];
  const ext = fakeExtension((prompt, i) => {
    const id = /"request_id":"([^"]+)"/.exec(prompt)?.[1] ?? '?';
    ids.push(id);
    return i === 0
      ? { text: '这轮我直接说人话了，没有 JSON。' }
      : { text: JSON.stringify({ request_id: id, kind: 'final', text: '第二次成功' }) };
  }, { polls: 2 });
  const out = await callBridgeOwn({ token: TOKEN, port: PORT, timeoutMs: 5000, body: { messages: [{ role: 'user', content: 'hi' }] }, onProgress: () => {} });
  await ext;
  check('重试后成功', out.reply.text === '第二次成功' && out.attempts === 2, 'attempts=' + out.attempts);
  check('两次尝试用了不同的 request_id（避免撞上重复 id）', ids.length === 2 && ids[0] !== ids[1]);
}

console.log('\n=== 4) 网页答成散文 → 报可重试的错误，且不猜内容 ===');
{
  const ext = fakeExtension(() => ({ text: '我觉得今天天气不错，就不输出 JSON 了。' }), { polls: 2 });
  let error = null;
  try { await callBridgeOwn({ token: TOKEN, port: PORT, timeoutMs: 5000, body: { messages: [{ role: 'user', content: 'x' }] } }); }
  catch (e) { error = e; }
  await ext;
  check('抛出解析类错误', !!error && /JSON/.test(error.message), error?.message?.slice(0, 40));
  check('错误码标成 WEB_REPLY_JSON（可重试）', error?.code === 'WEB_REPLY_JSON', String(error?.code));
}

console.log('\n=== 5) 扩展完全不响应 → 排队/超时按人话报错（不会静默卡住）===');
{
  let error = null;
  const t0 = Date.now();
  try { await callBridgeOwn({ token: TOKEN, port: PORT, timeoutMs: 1200, body: { messages: [{ role: 'user', content: 'x' }] } }); }
  catch (e) { error = e; }
  const took = Date.now() - t0;
  check('超时后报错而不是一直等', !!error, error?.message?.slice(0, 46));
  check('错误里点明"没有取走任务"', /没有取走/.test(error?.message || ''));
  check('用时接近设定预算（没有无限等）', took < 6000, took + 'ms');
}

await broker.close();
console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
