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

console.log('\n=== 4f) N3：page-tail 必须出现"本轮契约对象"，提示词自己不算 ===');
{
  // 提示词最后一行含本轮编号（"request_id 必须是 req-abc"），且提示词里还有一段完整 JSON 示例。
  // 只按"文本含编号"认账会把提示词当答复；要求"可解析且编号/kind 都对"才能排除它。
  const promptTail = '【对话】\n用户问：天气\n{"request_id":"req-示例编号","kind":"final","text":"给用户的最终回答"}\n【现在开始】只输出那个 JSON 对象，request_id 必须是 "req-abc"。';
  check('提示词尾部：含编号但不含本轮契约对象 → false', D.hasContractAnswer(promptTail, 'req-abc') === false);
  check('而 looksLikeAnswer 仍会误认为"像答复"（这正是要再加一道门的原因）', D.looksLikeAnswer(promptTail, 'req-abc') === true);

  const answered = '提示词…\n```json\n{"request_id":"req-abc","kind":"final","text":"晴"}\n```';
  check('真答复（本轮编号 + kind=final）→ true', D.hasContractAnswer(answered, 'req-abc') === true);
  const answeredCalls = '{"request_id":"req-abc","kind":"tool_calls","calls":[{"name":"t","arguments":{}}]}';
  check('真答复（tool_calls）→ true', D.hasContractAnswer(answeredCalls, 'req-abc') === true);
  check('编号对但 kind 非法 → false（留给客户端报 kind 错）', D.hasContractAnswer('{"request_id":"req-abc","kind":"answer"}', 'req-abc') === false);
  check('只有别的轮次编号 → false', D.hasContractAnswer('{"request_id":"req-xyz","kind":"final","text":"x"}', 'req-abc') === false);
  // 2026-09-28 真机踩到：模型漏写 request_id 时，旧判据（必须等于本轮编号）会把一条**合法答复**
  // 判成"不是本轮答复"，扩展于是在页面上一直等、直到 90 秒 WEB_STALL 被掐断。
  // 现在与 parseReply 的容忍度对齐：kind 合法 + 未写编号 → 认；写了别的编号 → 不认。
  check('kind 合法但漏写编号 → true（与 parseReply 对齐，避免白等到停滞）', D.hasContractAnswer('{"kind":"final","text":"晴"}', 'req-abc') === true);
  check('没给 requestId → false（宁可多等）', D.hasContractAnswer('{"kind":"final","text":"x"}', '') === false);
}

console.log('\n=== 4g) N1：clock.js 的开关必须有人写（否则渲染时钟补丁是死代码）===');
{
  const clock = readFileSync(join(ROOT, 'extension', 'clock.js'), 'utf8');
  const content = readFileSync(join(ROOT, 'extension', 'content.js'), 'utf8');
  check('clock.js 读的是 dataset.dshOwnActive（data-dsh-own-active）', /dataset\?\.\[FLAG\]|dataset\[FLAG\]/.test(clock) && /FLAG\s*=\s*'dshOwnActive'/.test(clock));
  check('content.js 真的写这个标志（任务开始时置 1）', /dataset\.dshOwnActive\s*=\s*'1'/.test(content), 'content.js 写 dataset.dshOwnActive');
  check('任务结束会清掉标志（普通浏览走原生时序）', /delete\s+document\.documentElement\.dataset\.dshOwnActive/.test(content));
}

console.log('\n=== 5a) 输入框读写按形态无关（contenteditable 支持）===');
{
  // content.js 依赖 dom.js 这一对函数：textarea 读 .value，contenteditable 读 textContent。
  // 以前 content.js 自己写了一份只认 HTMLTextAreaElement 的 setter —— contenteditable 时
  // 提交前校验永远读到 undefined，直接抛「提示词没有进入网页输入框」。
  check('dom.js 导出了 composerText 与 setComposerText', typeof D.composerText === 'function' && typeof D.setComposerText === 'function');
  const fakeDoc = {
    execCommand: () => false,
    querySelectorAll: () => [],
  };
  const editable = makeEl({ text: '', matches: ['[contenteditable="true"]'] });
  editable.tagName = 'DIV';
  editable.contentEditable = 'true';
  editable.focus = () => {};
  editable.dispatchEvent = () => {};
  // execCommand 失败 → 退化路径写 textContent（假 DOM 无 setter，直接赋值）
  try {
    D.setComposerText(fakeDoc, editable, '提示词正文');
    check('contenteditable 写入失败时退化到 textContent', String(editable.textContent || '').includes('提示词正文'));
  } catch (e) {
    check('contenteditable 写入失败时退化到 textContent', false, '抛错：' + e.message);
  }
  editable.textContent = '已经写进去的提示词';
  check('composerText 按 textContent 读到 contenteditable 的内容', D.composerText(editable).includes('已经写进去的提示词'));
  const ta = composer('写进 textarea 的提示词');
  ta.tagName = 'TEXTAREA';
  check('composerText 对 textarea 读 .value', D.composerText(ta) === '写进 textarea 的提示词');
}

console.log('\n=== 5) 状态行文案 ===');check('生成中且已有文本 → 说明正在生成', D.phaseOf({ text: 'abc', generating: true, sent: true }) === '网页正在生成回复');
check('只有思考 → 说明正在思考', D.phaseOf({ text: '', reasoning: '想', generating: true, sent: true }) === '网页正在思考');
check('还没确认发送 → 说明在提交', D.phaseOf({ text: '', reasoning: '', generating: false, sent: false }) === '正在把提示词提交到网页');
check('已停止且有文本 → 说明在回传', D.phaseOf({ text: 'abc', generating: false, sent: true }) === '网页已生成完毕，正在回传');
check('没有停止按钮但也没内容 → 不说成"已停止生成"（实测那只是会话页切换期）', D.phaseOf({ text: '', generating: false, sent: true }) === '已提交，网页尚未渲染出答复（可能在切换会话页）');

console.log('\n=== 4h) background.js 真的能在假 chrome 环境里加载（防 DEFAULTS is not defined 这类） ===');
{
  // 为什么要有这一节：2026-09-28 的真实事故 —— 有人改 background.js 的版本号时，把上一行的
  // `const DEFAULTS = { base: ... }` 一起删掉了，于是 configPromise 里的 `{ ...DEFAULTS, ...cfg }`
  // 抛 ReferenceError: DEFAULTS is not defined → 扩展解析不到配置、永远连不上 broker（用户侧
  // 表现只是"卡片在、但一直未连接"）。而**当时所有测试全绿**，因为 background.js 只被"检查文件
  // 存在"，从不被执行 —— 线上分发的整包里就是这份坏代码。
  const { createContext, runInContext } = await import('node:vm');
  const src = readFileSync(join(ROOT, 'extension', 'background.js'), 'utf8');
  const noop = () => {};
  const states = [];
  const rejections = [];
  const onRejection = (e) => rejections.push(String(e?.message || e));
  process.on('unhandledRejection', onRejection);
  const ctx = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    AbortSignal,
    crypto: { randomUUID: () => 'uuid-for-test' },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ token: 'x'.repeat(43), base: 'http://127.0.0.1:3081' }) }),
    chrome: {
      runtime: {
        id: 'test-ext', getURL: (p) => 'file:///ext/' + p, getManifest: () => ({ version: 'test' }),
        onMessage: { addListener: noop }, onStartup: { addListener: noop }, onInstalled: { addListener: noop },
      },
      storage: {
        local: {
          get: async () => ({ clientId: 'cid-for-test' }),
          set: async (o) => { if (o && o.state) states.push(String(o.state)); },
          remove: async () => {},
        },
      },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      tabs: {
        query: async () => [], sendMessage: async () => null, create: async () => ({ id: 1 }),
        update: async () => {}, get: async () => ({ status: 'complete' }),
        onUpdated: { addListener: noop, removeListener: noop }, reload: async () => {},
      },
      alarms: { create: noop, onAlarm: { addListener: noop } },
    },
  };
  createContext(ctx);
  let loadError = null;
  try { runInContext(src, ctx); } catch (e) { loadError = e; }
  check('background.js 能在假 chrome 环境里加载（没有同步抛错）', !loadError, loadError ? loadError.message : '');
  await new Promise((r) => setTimeout(r, 150));
  process.off('unhandledRejection', onRejection);
  check('加载后没有未处理的 Promise 拒绝（例如 DEFAULTS is not defined）', rejections.length === 0, rejections.slice(0, 2).join(' | '));
  const badStates = states.filter((s) => /is not defined|ReferenceError|local-config/.test(s));
  check('没有把"配置解析失败"写进状态（写了就意味着扩展连不上 broker）', badStates.length === 0, badStates.slice(0, 2).join(' | '));
  check('background.js 里用到的 DEFAULTS 必须有声明', /const DEFAULTS\s*=/.test(src));
}

console.log('\n=== 6) 扩展清单自检 ===');
{
  const manifest = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  check('MV3', manifest.manifest_version === 3);
  // 端口不再写死在 manifest 里（改端口不需要重排扩展），只要覆盖 127.0.0.1 各端口即可
  check('host_permissions 覆盖本机任意端口 + DeepSeek',
    manifest.host_permissions.some((h) => h === 'http://127.0.0.1/*' || h === 'http://localhost/*')
    && manifest.host_permissions.some((h) => h.includes('chat.deepseek.com')),
    JSON.stringify(manifest.host_permissions));
  check('内容脚本顺序正确（dom.js 在 content.js 之前）', JSON.stringify(manifest.content_scripts[1].js) === JSON.stringify(['dom.js', 'content.js']));
  check('时钟补丁注入 MAIN world 且在 document_start', manifest.content_scripts[0].world === 'MAIN' && manifest.content_scripts[0].run_at === 'document_start');
  for (const f of ['background.js', 'content.js', 'dom.js', 'clock.js', 'popup.html', 'popup.js']) {
    check('文件存在：' + f, readFileSync(join(ROOT, 'extension', f), 'utf8').length > 0);
  }
}

console.log('\n=== 4i) content.js 的 best-effort 兜底（畸形 JSON 不再空转 90 秒） ===');
{
  // 2026-09-28 真机：模型写畸形 JSON（未转义内层引号 / Windows 路径非法转义）时，扩展那道"形态门"
  // 同样要 JSON.parse，于是**永远不通过** → 内容脚本一直不回报 → 客户端干等 90 秒报 WEB_STALL，
  // 用户完全拿不到原因。修法：确认答完且文本稳定但仍过不了门时，超期把原文照样回报（带 bestEffort）。
  const src = readFileSync(join(ROOT, 'extension', 'content.js'), 'utf8');
  check('定义了 BEST_EFFORT_MS 期限', /const BEST_EFFORT_MS\s*=/.test(src));
  check('回报时带 bestEffort 标记', /bestEffort:\s*true/.test(src));
  check('兜底分支排在正常接受判定之后（正常路径优先）',
    src.indexOf("rows: snap.rowCount, source: snap.source } })") < src.indexOf('bestEffort: true'));
  check('兜底前提：已确认收到 + 看到本轮答复 + 有变化 + 已停止生成 + 有文本',
    /confirmed && snap\.answerSeen && snap\.changed && !snap\.generating && snap\.text\.trim\(\)/.test(src));
  const beIdx = src.indexOf('bestEffort: true');
  const rmIdx = src.lastIndexOf('sessionStorage.removeItem(sentKey)', beIdx);
  check('兜底路径也先清 sentKey（绝不重复提交）', rmIdx > 0 && rmIdx < beIdx);
}

console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
