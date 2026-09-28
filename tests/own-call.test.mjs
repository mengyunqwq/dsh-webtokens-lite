// own 模式的端到端测试（不需要浏览器）：
// 真起一个自研 broker，用一个"假扩展"长轮询领任务并回报，验证
// callBridge → 组装提示词 → broker → 假扩展 → 回传原文 → 本机解析 → OpenAI 响应 这条链路。
// 同时覆盖：重试（第一次让扩展报错）、工具调用、参数剥字段、取消/超时。
import { createBroker } from '../lib/broker.mjs';
import { callBridgeOwn, retryable } from '../lib/bridge.mjs';
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
    const { id, lease, prompt, requestId } = body.task;
    const out = typeof reply === 'function' ? reply(prompt, i, requestId) : reply;
    if (out?.phase) await fetch(`http://127.0.0.1:${PORT}/ext/progress`, { method: 'POST', headers: H, body: JSON.stringify({ taskId: id, lease, phase: out.phase }) });
    await fetch(`http://127.0.0.1:${PORT}/ext/result`, { method: 'POST', headers: H, body: JSON.stringify({ taskId: id, lease, ok: out?.ok !== false, text: out?.text ?? '', error: out?.error ?? '', metrics: { chars: String(out?.text ?? '').length } }) });
    seen.push({ prompt, id });
  }
  return seen;
}

console.log('=== 1) 文本答复：组装 → 派发 → 回传 → 解析 ===');
{
  const ext = fakeExtension((prompt, i, requestId) => {
    // 真扩展是**直接用 broker 下发的 requestId**（不解析提示词）——夹具也必须这样：
    // 提示词里那段输出契约示例用的是占位编号（req-示例编号），从提示词里抠编号会抠到占位值，
    // 于是答复被当成"只有示例"而判失败（实测踩到）。
    const id = requestId;
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
  const ext = fakeExtension((prompt, i, requestId) => {
    const id = requestId;
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

console.log('\n=== 2b) 只用 inputSchema 声明参数的工具也要剥多余字段（A-10）===');
{
  // 有些调用方（MCP / OpenAI custom 风格）用 inputSchema 而不是 parameters 声明参数。
  // 少了这个兜底时，工具调用回来**不会剥多余字段**，调用方会拿到契约之外的键。
  const ext = fakeExtension((prompt, i, requestId) => ({
    text: JSON.stringify({ request_id: requestId, kind: 'tool_calls', calls: [{ name: 'lookup', arguments: { q: '北京', junk: '多写的' } }] }),
  }), { polls: 1 });
  const out = await callBridgeOwn({
    token: TOKEN, port: PORT, timeoutMs: 5000,
    body: {
      model: 'web-deepseek',
      messages: [{ role: 'user', content: '查一下' }],
      tools: [{ type: 'function', function: { name: 'lookup', description: '查询', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }],
    },
  });
  await ext;
  const args = JSON.parse(out.reply.calls[0].arguments);
  check('inputSchema 声明的参数也能剥掉多余字段', args.q === '北京' && !('junk' in args), JSON.stringify(args));
}

console.log('\n=== 3) 散文答复 → 不自动重试（问题5 折中：避免账号里出现第二条提问）===');
{
  // 旧行为：散文会换新 request_id 自动重发一轮。2026-09-28 决策后**只重试"缺必需参数"**，
  // 其余格式类失败只报错——它们都是"提示词已提交"，重发会在用户账号里多一条一样的提问。
  // ⚠ clientId 必须复用同一个：/ext/poll 遇到未送达的取消通知会按 clientId 重复投递，
  //   新 clientId 会一直拿到通知而登记不成等待者（实测踩到）。
  const ids = [];
  const ext = fakeExtension((prompt, i, requestId) => {
    ids.push(requestId);
    return { text: '这轮我直接说人话了，没有 JSON。' };
  }, { polls: 2 });
  let error = null;
  try { await callBridgeOwn({ token: TOKEN, port: PORT, timeoutMs: 5000, body: { messages: [{ role: 'user', content: 'hi' }] }, onProgress: () => {} }); }
  catch (e) { error = e; }
  await ext;
  check('散文答复只提交了一次（不再自动重发）', ids.length === 1, '提交次数=' + ids.length);
  check('报 WEB_REPLY_JSON 且不可重试', error?.code === 'WEB_REPLY_JSON' && retryable(error) === false, String(error?.code));
}

console.log('\n=== 4) 网页答成散文 → 报错（不再自动重试），且不猜内容 ===');
{
  const ext = fakeExtension(() => ({ text: '我觉得今天天气不错，就不输出 JSON 了。' }), { polls: 1 });
  let error = null;
  try { await callBridgeOwn({ token: TOKEN, port: PORT, timeoutMs: 5000, body: { messages: [{ role: 'user', content: 'x' }] } }); }
  catch (e) { error = e; }
  await ext;
  check('抛出解析类错误', !!error && /JSON/.test(error.message), error?.message?.slice(0, 40));
  check('错误码标成 WEB_REPLY_JSON（不再重试，避免账号里第二条提问）', error?.code === 'WEB_REPLY_JSON' && retryable(error) === false, String(error?.code));
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

console.log('\n=== 6) 重试边界：提示词可能已提交的失败一律不重试 ===');
{
  // 这是本项目的第一号安全约束：重发会在用户自己的 DeepSeek 账号里留下第二条一模一样的提问。
  // 原先的名单里混进了 WEB_ABORTED / WEB_PAGE_ERROR / WEB_DISCONNECTED / WEB_TRANSPORT_ERROR，
  // 还有一个"错误文案里出现 aborted/stalled 就重试"的正则兜底 —— 这些都可能发生在提示词
  // 已经进了网页输入框之后。这里把边界钉死。
  check('排队超时可重试（没人取走任务，提示词根本没发出去）', retryable({ code: 'WEB_TIMEOUT' }) === true);
  check('已派发后超时不重试（提示词可能已提交）', retryable({ code: 'WEB_TIMEOUT_AFTER_DISPATCH' }) === false);
  check('调用方取消不重试', retryable({ code: 'WEB_ABORTED' }) === false);
  check('页面重载/断线不重试', retryable({ code: 'WEB_PAGE_ERROR' }) === false && retryable({ code: 'WEB_DISCONNECTED' }) === false);
  check('传输中断不重试', retryable({ code: 'WEB_TRANSPORT_ERROR' }) === false);
  check('网页侧停滞不重试', retryable({ code: 'WEB_STALL' }) === false);
  check('读到上一轮旧答复不重试', retryable({ code: 'WEB_REQUEST_ID' }) === false);
  check('文案里带 aborted/stalled 也不再被误判为可重试', retryable({ message: 'socket hang up / aborted / stalled' }) === false);
  check('协议类失败中只有"缺必需参数"仍可重试（问题5 折中）',
    retryable({ code: 'WEB_REPLY_JSON' }) === false && retryable({ code: 'WEB_TOOL_MISSING_ARGS' }) === true);
}

console.log('\n=== 9) 问题5（折中）：只有"缺必需参数"仍自动重试一次 ===');
{
  // 有界轮询（超时断开，不留"抢下一节任务"的长轮询）
  const pollBounded = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/ext/poll`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ clientId: 'ext-1', version: '1.0.0', state: 'x' }),
        signal: AbortSignal.timeout(3000),
      });
      return await r.json();
    } catch { return null; }
  };
  await fetch(`http://127.0.0.1:${PORT}/ext/poll`, { method: 'POST', headers: H, body: JSON.stringify({ clientId: 'ext-1', version: '1.0.0', state: 'x', busy: true }) }).then((r) => r.json()).catch(() => null);
  await sleep(60);

  const missing = [];
  const collector = (async () => {
    for (let i = 0; i < 4 && missing.length < 2; i++) {
      const job = await pollBounded();
      if (!job?.task) continue;
      missing.push(job.task.requestId);
      const text = missing.length === 1
        ? '{"kind":"tool_calls","calls":[{"name":"get_weather","arguments":{}}]}'
        : JSON.stringify({ request_id: job.task.requestId, kind: 'final', text: '第二次好了' });
      await fetch(`http://127.0.0.1:${PORT}/ext/result`, { method: 'POST', headers: H, body: JSON.stringify({ taskId: job.task.id, lease: job.task.lease, ok: true, text }) });
    }
  })();
  const schema = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
  const out = await callBridgeOwn({ token: TOKEN, port: PORT, timeoutMs: 6000, body: { messages: [{ role: 'user', content: '查天气' }], tools: schema } });
  await Promise.race([collector, sleep(12000)]);
  check('缺必需参数仍自动重试一次（共两次提交）', missing.length === 2, '提交次数=' + missing.length);
  check('两次尝试用了不同的 request_id', missing.length === 2 && missing[0] !== missing[1]);
  check('第二次的答复被采纳', out.reply.text === '第二次好了');
}

await broker.close();
console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
