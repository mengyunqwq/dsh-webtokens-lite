// 自研协议单测：提示词组装 + 从网页答复原文抠 JSON + 解析成结构化结果
import { buildTask, parseReply, extractJsonObject, FORMAT_GUARD, toOpenAICompletion, ProtocolError } from '../lib/protocol.mjs';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
};
const throwsWith = (fn, code) => { try { fn(); return null; } catch (e) { return e.code === code ? e : null; } };

console.log('=== 1) 提示词组装 ===');
{
  const tools = [{ name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } }];
  const t = buildTask({
    system: '你是简洁助手。',
    messages: [{ role: 'user', content: '北京天气？' }, { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] }, { role: 'tool', tool_call_id: 'c1', content: '晴 25℃' }],
    tools, requestId: 'req-test01',
  });
  check('request_id 用了指定的值', t.id === 'req-test01');
  check('含系统指令', t.prompt.includes('你是简洁助手'));
  check('含输出契约', t.prompt.includes(FORMAT_GUARD.slice(0, 24)));
  check('契约里带上了本轮 REQUEST_ID', t.prompt.includes('"request_id":"req-test01"') && !t.prompt.includes('<本轮 REQUEST_ID>'));
  check('含用户消息', t.prompt.includes('[user] 北京天气？'));
  check('含上一轮工具调用', t.prompt.includes('get_weather({"city":"北京"})'));
  check('含工具结果', t.prompt.includes('[工具结果 c1] 晴 25℃'));
  check('含工具定义', t.prompt.includes('"name": "get_weather"'));
  check('工具 schema 已放宽（无 additionalProperties:false）', !t.prompt.includes('additionalProperties'));
  check('尾声要求只输出 JSON', t.prompt.includes('只输出那个 JSON 对象'));
}
{
  const t = buildTask({ messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'x' } }] }] });
  check('图片块被省略并记警告', t.warnings.some((w) => w.includes('图片')) && t.prompt.includes('看图') && !t.prompt.includes('image_url'));
}
{
  const a = buildTask({ messages: [{ role: 'user', content: 'hi' }] });
  const b = buildTask({ messages: [{ role: 'user', content: 'hi' }] });
  check('未指定 id 时自动生成且互不相同', a.id !== b.id && a.id.startsWith('req-'));
}

console.log('\n=== 2) 从答复原文里抠 JSON ===');
{
  check('代码围栏', extractJsonObject('```json\n{"kind":"final","text":"好"}\n```')?.text === '好');
  check('无语言标记的围栏', extractJsonObject('```\n{"a":1}\n```')?.a === 1);
  check('前后有散文', extractJsonObject('好的，结果如下：\n{"kind":"final","text":"答案"}\n以上。')?.text === '答案');
  check('字符串里的花括号不参与计数', extractJsonObject('前言 {"kind":"final","text":"含 } 和 { 的文本"} 后记')?.text === '含 } 和 { 的文本');
  check('转义引号', extractJsonObject('{"kind":"final","text":"他说\\"你好\\""}')?.text === '他说"你好"');
  check('多个候选取最后一个能解析的', extractJsonObject('{"broken":1,}\n{"kind":"final","text":"第二个"}')?.text === '第二个');
  check('纯散文 → null', extractJsonObject('今天天气不错，没有 JSON。') === null);
  check('空 → null', extractJsonObject('') === null);
}

console.log('\n=== 3) 解析 final ===');
{
  const r = parseReply('```json\n{"request_id":"req-a","kind":"final","text":"你好"}\n```', { id: 'req-a' });
  check('kind/text 正确', r.kind === 'final' && r.text === '你好' && r.calls.length === 0);
  const noId = parseReply('{"kind":"final","text":"没带 id"}', { id: 'req-a' });
  check('缺 request_id 时容忍（不因此失败）', noId.text === '没带 id');
  check('request_id 不匹配 → WEB_REQUEST_ID', !!throwsWith(() => parseReply('{"request_id":"other","kind":"final","text":"x"}', { id: 'req-a' }), 'WEB_REQUEST_ID'));
  check('没有 JSON → WEB_REPLY_JSON', !!throwsWith(() => parseReply('我直接说了答案', { id: 'req-a' }), 'WEB_REPLY_JSON'));
  check('kind 非法 → WEB_REPLY_KIND', !!throwsWith(() => parseReply('{"kind":"answer","text":"x"}', { id: 'req-a' }), 'WEB_REPLY_KIND'));
  check('final 空文本 → WEB_REPLY_TEXT', !!throwsWith(() => parseReply('{"kind":"final","text":"   "}', { id: 'req-a' }), 'WEB_REPLY_TEXT'));
}

console.log('\n=== 4) 解析 tool_calls（含按调用方原始 schema 剥字段）===');
{
  const schemas = new Map([['get_weather', { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }]]);
  const raw = '{"kind":"tool_calls","calls":[{"name":"get_weather","arguments":{"city":"北京","extra":1,"note":"x"}}]}';
  const r = parseReply(raw, { id: 'req-b', schemas });
  check('kind=tool_calls 且 1 个调用', r.kind === 'tool_calls' && r.calls.length === 1);
  check('多余字段被剥掉', JSON.parse(r.calls[0].arguments).city === '北京' && !('extra' in JSON.parse(r.calls[0].arguments)));
  check('产生了剥字段的警告', r.warnings.some((w) => w.includes('多余字段')));
  check('补出了调用 id', typeof r.calls[0].id === 'string' && r.calls[0].id.length > 0);

  const open = new Map([['f', { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true }]]);
  const r2 = parseReply('{"kind":"tool_calls","calls":[{"name":"f","arguments":{"a":"1","b":"2"}}]}', { id: 'req-c', schemas: open });
  check('调用方允许额外字段时保留', JSON.parse(r2.calls[0].arguments).b === '2');

  const asStr = parseReply('{"kind":"tool_calls","calls":[{"name":"g","arguments":"{\\"a\\":1}"}]}', { id: 'req-d' });
  check('arguments 是 JSON 字符串也能收', JSON.parse(asStr.calls[0].arguments).a === 1);

  check('缺少 calls → WEB_REPLY_CALLS', !!throwsWith(() => parseReply('{"kind":"tool_calls"}', { id: 'x' }), 'WEB_REPLY_CALLS'));
  check('调用缺 name → WEB_TOOL_UNKNOWN', !!throwsWith(() => parseReply('{"kind":"tool_calls","calls":[{"arguments":{}}]}', { id: 'x' }), 'WEB_TOOL_UNKNOWN'));
  check('arguments 非法 JSON → WEB_TOOL_ARGUMENTS', !!throwsWith(() => parseReply('{"kind":"tool_calls","calls":[{"name":"g","arguments":"{oops"}]}', { id: 'x' }), 'WEB_TOOL_ARGUMENTS'));
  check('arguments 不是对象 → WEB_TOOL_ARGUMENTS', !!throwsWith(() => parseReply('{"kind":"tool_calls","calls":[{"name":"g","arguments":"[1,2]"}]}', { id: 'x' }), 'WEB_TOOL_ARGUMENTS'));
}

console.log('\n=== 5) 转 OpenAI 响应 ===');
{
  const fin = toOpenAICompletion({ kind: 'final', text: '答案' }, { model: 'web-deepseek', id: 'r1' });
  check('final 形状', fin.object === 'chat.completion' && fin.choices[0].finish_reason === 'stop' && fin.choices[0].message.content === '答案');
  check('final 不带 usage（不伪造用量）', !('usage' in fin));
  const tc = toOpenAICompletion({ kind: 'tool_calls', text: '', calls: [{ id: 'c1', name: 'f', arguments: '{"a":1}' }] }, { model: 'm', id: 'r2' });
  check('tool_calls 形状', tc.choices[0].finish_reason === 'tool_calls' && tc.choices[0].message.tool_calls[0].function.name === 'f');
  check('content 为 null 而不是空串', tc.choices[0].message.content === null);
}

console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
