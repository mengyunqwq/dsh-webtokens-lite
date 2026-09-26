// 自研扩展的纯逻辑测试（不需要浏览器）
// 覆盖：JSON 完整性、自适应结束判定、基线扫描（必须排除"思考"文本）、轮询间隔、输入框/停止按钮识别
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// dom.js 是 classic script（MV3 的 content script 不能 import），直接求值后从全局取
new Function(readFileSync(join(ROOT, 'extension', 'dom.js'), 'utf8'))();
const D = globalThis.DSHOwnDom;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); } else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); } };

/* ---------- 假 DOM：只实现 dom.js 用到的那点接口 ---------- */
function makeEl({ text = '', matches = [], children = [], hidden = false, disabled = false, readOnly = false, value = '', detached = false } = {}) {
  const node = {
    textContent: text,
    // 模拟 Chromium 的真实行为：**脱离文档的节点 innerText 返回空串**（不是 undefined，
    // 所以 `?? textContent` 兜不住）。克隆出来的节点都标记 detached=true —— 这样
    // "用 innerText 读克隆节点"的写法会读到空，正好复现真机那个 bug（答复文本永远为空）。
    innerText: detached ? '' : text,
    children,
    value,
    disabled,
    readOnly,
    hidden,
    style: {},
    offsetParent: hidden ? null : {},
    getClientRects: () => (hidden ? [] : [{}]),
    matches: (sel) => matches.includes(sel),
    closest(sel) { let cur = node; while (cur) { if (cur.matches?.(sel)) return cur; cur = cur.parent || null; } return null; },
    querySelectorAll(sel) {
      const wanted = String(sel).split(',').map((s) => s.trim());
      const out = [];
      const walk = (n) => { for (const c of n.children || []) { if (wanted.some((w) => c.matches?.(w))) out.push(c); walk(c); } };
      walk(node);
      return out;
    },
    cloneNode() {
      // detached: true —— 克隆节点脱离文档，innerText 为空（模拟 Chromium）
      const copy = makeEl({ text, matches, hidden, disabled, readOnly, value, detached: true });
      copy.children = (children || []).map((c) => { const cc = c.cloneNode(); cc.parent = copy; return cc; });
      return copy;
    },
    remove() {
      if (!node.parent) return;
      const i = node.parent.children.indexOf(node);
      if (i >= 0) node.parent.children.splice(i, 1);
    },
    parent: null,
  };
  for (const c of children) c.parent = node;
  return node;
}
const row = (text, extraChildren = []) => makeEl({ text, matches: ['[data-message-role="assistant"]', '.ds-markdown'], children: extraChildren });
const think = (text) => makeEl({ text, matches: ['.ds-think-content', '[class*="thinking"]'] });
const stopBtn = () => makeEl({ text: '停止生成', matches: ['button', '[role="button"]'] });
const sendBtn = () => makeEl({ text: '发送', matches: ['button', '[role="button"]'] });
const composer = (value = '', opts = {}) => makeEl({ matches: ['textarea'], value, ...opts });
const doc = (children) => makeEl({ children });

console.log('=== 1) JSON 完整性判断（决定"能不能立刻收工"）===');
check('完整对象 → true', D.completeJson('{"kind":"final","text":"好"}') === true);
check('缺少右括号 → false', D.completeJson('{"kind":"final"') === false);
check('字符串里的花括号不干扰', D.completeJson('{"text":"含 } 和 { 的文本"}') === true);
check('数组不算（我们要的是对象）', D.completeJson('[1,2,3]') === false);
check('散文 + 后面跟完整对象 → true', D.completeJson('好的：\n{"a":1}') === true);
check('空串 → false', D.completeJson('') === false);

console.log('\n=== 2) 自适应结束判定（核心改进）===');
check('完整 JSON → 只等 800ms', D.acceptDelay('{"kind":"final","text":"x"}') === 800);
check('以 } 收尾但非法 JSON → 1200ms', D.acceptDelay('结论如下 }') === 1200);
check('围栏收尾但内容不是 JSON → 1200ms', D.acceptDelay('```\n还没写完\n```') === 1200);
check('普通散文 → 2500ms', D.acceptDelay('这是一段还在继续的说明文字') === 2500);
check('空文本 → 永不接受', D.acceptDelay('   ') === Infinity);
check('停止按钮还在 → 永不接受（10 秒也不收）', D.stableEnough({ text: '{"a":1}', stableMs: 10000, hasStop: true }) === false);
check('已停止 + 完整 JSON + 稳 900ms → 接受', D.stableEnough({ text: '{"a":1}', stableMs: 900, hasStop: false }) === true);
check('已停止 + 散文 + 稳 900ms → 还不收（怕没写完）', D.stableEnough({ text: '正在说明', stableMs: 900, hasStop: false }) === false);
check('已停止 + 散文 + 稳 2600ms → 接受', D.stableEnough({ text: '正在说明', stableMs: 2600, hasStop: false }) === true);
{
  const oldRuleMs = 5000, newRuleMs = D.acceptDelay('{"kind":"final","text":"x"}');
  check('相比上游固定 5 秒，结构化答复每轮少等 ≥4 秒', oldRuleMs - newRuleMs >= 4000, `省 ${(oldRuleMs - newRuleMs) / 1000} 秒`);
}
check('生成中轮询 1000ms、结束后收紧到 300ms', D.pollDelay(true) === 1000 && D.pollDelay(false) === 300);

console.log('\n=== 3) 认页面：输入框与停止按钮 ===');
{
  const d = doc([composer('', { hidden: true }), composer(''), sendBtn()]);
  check('跳过隐藏的 textarea，选中可见那个', D.findComposer(d)?.value === '' && D.findComposer(d) !== null);
  const d2 = doc([composer('', { disabled: true })]);
  check('禁用的输入框不算可用', D.findComposer(d2) === null);
  const d3 = doc([sendBtn()]);
  check('没有输入框时返回 null', D.findComposer(d3) === null);
  check('识别「停止生成」', !!D.findStop(doc([stopBtn()])));
  check('「发送」不会被误判成停止', D.findStop(doc([sendBtn()])) === null);
  check('隐藏的停止按钮不算（还在生成时才可见）', D.findStop(doc([makeEl({ text: '停止生成', matches: ['button'], hidden: true })])) === null);
}

console.log('\n=== 4) 基线扫描：只认新答复，且排除"思考"文本 ===');
{
  const before = doc([row('上一轮的回答')]);
  const baseline = D.captureBaseline(before);
  check('基线记录了已有的 1 条助手消息', baseline.count === 1 && baseline.lastText === '上一轮的回答');

  // 还没提交出去：没有新消息
  const same = D.scan(before, baseline);
  check('没有新消息时 changed=false', same.changed === false && same.rowCount === 1);

  // 提交后：出现第 2 条助手消息，且它内部含"思考"子树
  const after = doc([
    row('上一轮的回答'),
    row('网页正在写', [think('思考：我需要输出 {"kind":"tool_calls"} 这样的结构')]),
  ]);
  const snap = D.scan(after, baseline);
  check('出现新消息 → changed=true', snap.changed === true && snap.rowCount === 2);
  check('思考文本被排除在答复之外', !snap.text.includes('思考：我需要输出'), JSON.stringify(snap.text));
  check('思考文本单独取出来（用于状态提示）', snap.reasoning.includes('思考：我需要输出'));
  check('答复正文保留', snap.text.includes('网页正在写'));
}
{
  // 答复里带代码块（我们靠它拿 JSON），必须保留
  const d = doc([row('```json\n{"kind":"final","text":"好"}\n```')]);
  const snap = D.scan(d, { count: 0, lastText: '' });
  check('代码块内容要保留（JSON 就在里面）', snap.text.includes('{"kind":"final","text":"好"}'));
  check('于是能被判定为"完整 JSON"→ 800ms 收工', D.completeJson(snap.text) === true && D.acceptDelay(snap.text) === 800);
}

console.log('\n=== 4b) 读文本必须用 textContent（脱离文档的克隆节点 innerText 为空）===');
{
  const withThink = row('答复正文', [think('思考内容')]);
  check('能读到答复正文（真机曾在这里读成空 → 一直停在"正在确认是否有答复"直到超时）', D.textOf(withThink).includes('答复正文'), JSON.stringify(D.textOf(withThink)));
  check('思考子树的内容仍被排除', !D.textOf(withThink).includes('思考内容'));
  check('整段扫描也能拿到文本', D.scan(doc([withThink]), { count: 0, lastText: '' }).text.includes('答复正文'));
  check('代码块内容保留（JSON 就在里面）', D.textOf(row('```json\n{"a":1}\n```')).includes('{"a":1}'));
}

console.log('\n=== 4c) 现场诊断（读不到答复时用来自证"页面到底有什么"）===');
{
  const d = doc([row('已有回答')]);
  const line = D.diagnose(d);
  check('诊断行含各候选选择器的命中数', /\[data-message-role\]=/.test(line) && /\.ds-markdown=/.test(line), line.slice(0, 90));
  check('诊断行含 readyState、页面 URL 与是否登录页', /readyState=/.test(line) && /url=/.test(line) && /登录页=/.test(line), line.slice(0, 120));
  check('命中数确实反映 DOM（.ds-markdown 命中 1）', /\.ds-markdown=1/.test(line));
  check('能识别登录页（同域名，光靠 URL 匹配区分不出来）', D.isSignInPage({ location: { href: 'https://chat.deepseek.com/sign_in' }, querySelectorAll: () => [], body: { textContent: '登录 / 注册' } }) === true);
  check('正常聊天页不误判为登录页', D.isSignInPage({ location: { href: 'https://chat.deepseek.com/a/chat/s/xx' }, querySelectorAll: () => [1], body: { textContent: '登录' } }) === false);
}

console.log('\n=== 4d) 类名失效时的兜底：只在页面尾部出现本轮 request_id 时才算答复 ===');
{
  // 类名哈希化之后行选择器可能一个都不命中，所以 scan 会退回"整页尾部文本"；
  // 但**必须**等本轮 request_id 出现，否则提示词自己（也含 JSON 示例）会被当成答复。
  const makeDoc = (bodyText) => ({
    querySelectorAll: () => [],
    querySelector: () => null,
    body: { innerText: bodyText, textContent: bodyText },
    location: { href: 'https://chat.deepseek.com/a/chat/s/x' },
    title: 'DeepSeek',
    readyState: 'complete',
  });
  const baseline = { count: 0, lastText: '', requestId: 'req-abc123' };

  const promptOnly = D.scan(makeDoc('【本机桥接输出格式硬性要求】…{"request_id":"req-示例编号",…}'), baseline);
  check('只有提示词时：识别为"还没看到答复"', promptOnly.answerSeen === false && promptOnly.source === 'none', JSON.stringify({ source: promptOnly.source, seen: promptOnly.answerSeen }));

  const withAnswer = D.scan(makeDoc('…提示词…\n{"request_id":"req-abc123","kind":"final","text":"你好"}'), baseline);
  check('页面尾部出现本轮编号时：识别为答复', withAnswer.answerSeen === true && withAnswer.source === 'page-tail');
  check('尾部文本能被解析出正确结果', D.completeJson(withAnswer.text) && withAnswer.text.includes('req-abc123'));
  check('没有 requestId 时绝不认账（防止把提示词当答案）', D.scan(makeDoc('随便什么文本'), { count: 0, lastText: '' }).answerSeen === false);
}

console.log('\n=== 4e) 认账门：必须看到本轮编号或契约字段 kind（防半截回答）===');
{
  // 真机踩到：网页先渲染思考过程/半截回答，扩展只按"文本稳定"就认账 → 回传半截文本 →
  // 客户端报「网页答复里没有可解析的 JSON 对象」。所以认账前必须能看出"这是本轮的答复"。
  check('含本轮 request_id → 认账', D.looksLikeAnswer('前言 {"request_id":"req-abc","kind":"final","text":"好"}', 'req-abc') === true);
  check('含契约字段 kind → 认账（模型漏写编号时也不至于死等）', D.looksLikeAnswer('{"kind":"tool_calls","calls":[]}', 'req-abc') === true);
  check('思考过程/半截回答 → 不认账', D.looksLikeAnswer('让我想想…用户问的是天气，我需要先查一下城市。', 'req-abc') === false);
  check('空文本 → 不认账', D.looksLikeAnswer('', 'req-abc') === false);
  check('没给 requestId 时只认 kind 字段', D.looksLikeAnswer('一段散文，没有任何字段', '') === false);
}

console.log('\n=== 5) 状态行文案 ===');check('生成中且已有文本 → 说明正在生成', D.phaseOf({ text: 'abc', generating: true, sent: true }) === '网页正在生成回复');
check('只有思考 → 说明正在思考', D.phaseOf({ text: '', reasoning: '想', generating: true, sent: true }) === '网页正在思考');
check('还没确认发送 → 说明在提交', D.phaseOf({ text: '', reasoning: '', generating: false, sent: false }) === '正在把提示词提交到网页');
check('已停止且有文本 → 说明在回传', D.phaseOf({ text: 'abc', generating: false, sent: true }) === '网页已生成完毕，正在回传');
check('没有停止按钮但也没内容 → 不说成"已停止生成"（实测那只是会话页切换期）', D.phaseOf({ text: '', generating: false, sent: true }) === '已提交，网页尚未渲染出答复（可能在切换会话页）');

console.log('\n=== 6) 扩展清单自检 ===');
{
  const manifest = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  check('MV3', manifest.manifest_version === 3);
  check('只申请本机桥接与 DeepSeek 两个域', manifest.host_permissions.length === 2 && manifest.host_permissions.some((h) => h.includes('127.0.0.1:3081')));
  check('内容脚本顺序正确（dom.js 在 content.js 之前）', JSON.stringify(manifest.content_scripts[1].js) === JSON.stringify(['dom.js', 'content.js']));
  check('时钟补丁注入 MAIN world 且在 document_start', manifest.content_scripts[0].world === 'MAIN' && manifest.content_scripts[0].run_at === 'document_start');
  for (const f of ['background.js', 'content.js', 'dom.js', 'clock.js', 'popup.html', 'popup.js']) {
    check('文件存在：' + f, readFileSync(join(ROOT, 'extension', f), 'utf8').length > 0);
  }
}

console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
