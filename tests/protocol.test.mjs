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
  check('契约示例用占位编号，真编号只在最后一行说明', t.prompt.includes('req-示例编号') && t.prompt.includes('req-test01') && !t.prompt.includes('<本轮 REQUEST_ID>'), '（这样"读页面尾部整段文本"时示例不会被误当答案）');
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

console.log('\n=== 3b) N3：页面文本里的其它 JSON 不能被当成答复 ===');
{
  // 真机/实验场景：page-tail 兜底时，页面文本里会有提示词自带的**工具定义 JSON**。
  // 修复前 `usable.find(o => !o.request_id)` 会先命中它，于是拿工具定义当"答复"去解析。
  const toolDefs = '【工具定义】[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object"}}}]';
  const err = throwsWith(() => parseReply(toolDefs, { id: 'req-a' }), 'WEB_REPLY_KIND');
  check('只有工具定义 JSON → 不会当成合法答复（报 kind 错）', !!err);
  const injected = toolDefs + '\n' + '{"request_id":"req-other","kind":"final","text":"上一轮的旧答复"}';
  check('混入"非本轮编号"的对象 → WEB_REQUEST_ID（不返回旧答复）', !!throwsWith(() => parseReply(injected, { id: 'req-a' }), 'WEB_REQUEST_ID'));
  const real = toolDefs + '\n' + '{"request_id":"req-a","kind":"final","text":"本轮真答案"}';
  const ok = parseReply(real, { id: 'req-a' });
  check('同时存在工具定义与本轮答复 → 优先取本轮编号那条', ok.text === '本轮真答案', JSON.stringify(ok.text));
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

console.log('\n=== 6) 必需参数缺失 → 判可重试（绝不猜参数值）===');{
  const schemas = new Map([['get_weather', { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }]]);
  check('缺必需参数 → WEB_TOOL_MISSING_ARGS', !!throwsWith(() => parseReply('{"kind":"tool_calls","calls":[{"name":"get_weather","arguments":{}}]}', { id: 'r', schemas }), 'WEB_TOOL_MISSING_ARGS'));
  check('必需参数齐了 → 正常通过', parseReply('{"kind":"tool_calls","calls":[{"name":"get_weather","arguments":{"city":"北京"}}]}', { id: 'r', schemas }).calls.length === 1);
  check('没有 required 声明时不误判', parseReply('{"kind":"tool_calls","calls":[{"name":"f","arguments":{}}]}', { id: 'r', schemas: new Map([['f', { type: 'object', properties: {} }]]) }).calls.length === 1);
  check('错误文案点明缺哪个参数', /city/.test(String(throwsWith(() => parseReply('{"kind":"tool_calls","calls":[{"name":"get_weather","arguments":{}}]}', { id: 'r', schemas }), 'WEB_TOOL_MISSING_ARGS')?.message)));
}

console.log('\n=== 7) 重试时能带上提醒（nudge）===');
{
  const plain = buildTask({ messages: [{ role: 'user', content: 'x' }] });
  const nudged = buildTask({ messages: [{ role: 'user', content: 'x' }], nudge: '上一轮缺少必需参数，这次请把 required 全部填上。' });
  check('不传 nudge 时提示词里没有该段', !plain.prompt.includes('上一轮的问题'));
  check('传了 nudge 会写进提示词', nudged.prompt.includes('上一轮的问题') && nudged.prompt.includes('required 全部填上'));
  check('提醒排在输出契约之后（更靠近生成位置）', nudged.prompt.indexOf('上一轮的问题') > nudged.prompt.indexOf('本机桥接输出格式硬性要求'));
}

console.log('\n=== 8) 模型把 JSON 塞进 text 却不转义 → 解析侧容错修复 ===');
{
  // 真机原文（同一模型连续两次都这么写）：text 是一段 JSON 数组，里面的引号没有转义
  const broken = '{"request_id":"req-fix01","kind":"final","text":"[{"name":"苹果"},{"name":"香蕉"}]"}';
  const fixed = parseReply(broken, { id: 'req-fix01' });
  check('修复后能解析并给出 text', fixed.kind === 'final' && fixed.text.includes('苹果'), fixed.text.slice(0, 30));
  check('留下"曾修复"的警告（不静默吞掉）', fixed.warnings.some((w) => /容错修复/.test(w) && /未转义的引号/.test(w)), fixed.warnings.join(' | ').slice(0, 60));
  check('围栏代码块里的同种写法也能修', parseReply('```json\n' + broken + '\n```', { id: 'req-fix01' }).text.includes('香蕉'));
  const wrongId = throwsWith(() => parseReply(broken.replace('req-fix01', 'req-old'), { id: 'req-fix01' }), 'WEB_REPLY_JSON');
  check('修完编号不是本轮 → 仍然报错（绝不当成答案）', !!wrongId, String(wrongId?.code));
  check('没有 text 字段的半截 JSON → 仍然报 WEB_REPLY_JSON', !!throwsWith(() => parseReply('{"request_id":"req-fix01","kind":"final"', { id: 'req-fix01' }), 'WEB_REPLY_JSON'));
  check('正常 JSON 不受影响（不触发修复、无警告）', parseReply('{"request_id":"req-fix01","kind":"final","text":"普通答复"}', { id: 'req-fix01' }).warnings.length === 0);

  // 真机 2026-09-28（"让他检查梦云 agent 做得怎么样"那次）：模型写 Windows 路径用**单反斜杠**，
  // `\梦` 不是合法 JSON 转义 → JSON.parse 直接失败，用户只看到"网页答复里没有可解析的 JSON 对象…"。
  // 原文（480 字符）从扩展存储里捞出来复现过，这里用同种写法的精简版做回归。
  const pathRaw = '{"request_id":"req-fix01","kind":"tool_calls","calls":[{"name":"pwsh","arguments":{"command":"Get-ChildItem -Force \'E:\\梦云Agent\' | Out-String"}}]}';
  const pathOk = parseReply(pathRaw, { id: 'req-fix01' });
  check('非法反斜杠转义（\'E:\\梦云Agent\'）→ 容错后能解析出工具调用', pathOk.kind === 'tool_calls' && pathOk.calls.length === 1, pathOk.calls[0]?.name);
  check('并说明修的是"非法的反斜杠转义"', pathOk.warnings.some((w) => /非法的反斜杠转义/.test(w)));
  const pathArgs = typeof pathOk.calls[0].arguments === 'string' ? JSON.parse(pathOk.calls[0].arguments) : pathOk.calls[0].arguments;
  check('路径还原正确（单反斜杠，没有多补成两个）', String(pathArgs.command).includes('梦云Agent') && !String(pathArgs.command).includes('\\\\梦'), String(pathArgs.command).slice(0, 56));

  // 真机 2026-09-28 第二次报障（req-ff9b0bf5，原文 289 字符）：同一个答复里**两个缺陷并存** ——
  // command 值里有未转义的双引号（"E:\梦云Agent\src"），且 \梦 是非法转义。
  const cmdRaw = '{"request_id":"req-fix01","kind":"tool_calls","calls":[{"name":"pwsh","arguments":{"command":"cmd /c dir /b /s "E:\\梦云Agent\\src"","description":"List src files with cmd dir"}}]}';
  const cmdOk = parseReply(cmdRaw, { id: 'req-fix01' });
  check('command 里未转义的双引号 → 容错后可解析出工具调用', cmdOk.kind === 'tool_calls' && cmdOk.calls.length === 1, cmdOk.calls[0]?.name);
  check('并说明修了"未转义的双引号"', cmdOk.warnings.some((w) => /未转义的双引号/.test(w)), cmdOk.warnings.join('|').slice(0, 46));
  const cmdArgs = typeof cmdOk.calls[0].arguments === 'string' ? JSON.parse(cmdOk.calls[0].arguments) : cmdOk.calls[0].arguments;
  check('命令还原正确（内层引号与路径都保留）', /cmd \/c dir \/b \/s "E:\\梦云Agent\\src"/.test(String(cmdArgs.command)), String(cmdArgs.command).slice(0, 56));
}

console.log('\n=== 9) 报错自带身份（哪一个实现、哪一版、哪个任务）===');
{
  // 2026-09-28 真机教训：多份实现的报错文案完全一样，出了事无法判断是谁在解析、版本是否已更新，
  // 排查成本极高（"修复明明发了、任务仍失败"）。现在报错第一段就是身份标签 + 本次 request_id。
  const e = throwsWith(() => parseReply('这不是 JSON，只是一段散文。', { id: 'req-idtest' }), 'WEB_REPLY_JSON');
  check('报错带 <包名>@<版本> 身份标签', /〔[^〕]+@\d+\.\d+\.\d+〕/.test(String(e?.message)), String(e?.message).slice(0, 34));
  check('报错带本次 request_id（可与扩展存储对账）', String(e?.message).includes('request_id=req-idtest'));
}

console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
