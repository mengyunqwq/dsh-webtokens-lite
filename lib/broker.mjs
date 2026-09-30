// lib/broker.mjs — 自研本机桥接服务（默认 127.0.0.1:3081）
//
// 它只做四件事：收客户端的 /task（NDJSON 流回进度与结果）、把任务交给扩展（/ext/poll 长轮询）、
// 收扩展的进度与结果（/ext/progress、/ext/result）、对外报状态（/status）。
//
// 与上游 broker 的关系：**它是替代品**（见 docs/own-bridge.md）。保留的安全性质：
//   · Bearer 配对密钥鉴权；
//   · Host 必须指向本机端口（挡 DNS rebinding）；
//   · 每个任务带 lease 租约，扩展回报必须带对，防止旧实例把结果写进新任务；
//   · 单 worker 串行（一个网页会话一次只跑一轮），准入控制在连接器/中转站侧做；
//   · 停滞看门狗 + 总超时 + 客户端断开即取消。
//
// 与上游不同的取舍：**扩展只负责提交提示词与取回答复原文**，解析与校验在客户端
// （lib/protocol.mjs），所以这里对 prompt 内容完全不理解，只做搬运与生命周期管理。

import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
// OpenAI 兼容面复用同一套协议实现（拼提示词 / 解析答复 / 组装 completion），
// 避免中转站那边再抄一份 —— 抄一份的后果实测过：中转站的 web-bridge-openai.js
// 直接 import 上游插件的协议模块，等于把中转站焊死在上游实现上。
import { buildTask, parseReply, schemasOf, replyChunks, toOpenAICompletion, implIdentity, implTag } from './protocol.mjs';

const POLL_HOLD_MS = 20_000;
// 交付确认窗口与最大交付次数（见 checkDeliveryAcks）：窗口要明显小于用户的耐心，
// 又不能小到把「扩展正忙、马上会接手」误判成丢件。一级窗口现在 3 秒——健康的扩展
// 收到任务后几十毫秒就确认了（实测 5~50ms），3 秒足够；而丢件时用户只白等 3 秒。
const ACK_TIMEOUT_MS = 1_500;
const MAX_DELIVERIES = 3;
// 二级窗口：扩展"收到了"但内容脚本一直没接手（页面在自愈重载、标签页没响应）多久算丢件。
// 比一级窗口长一些：自愈重载要等页面加载完，那段是合法的慢。
const HANDOFF_TIMEOUT_MS = 12_000;
const BODY_LIMIT = 8 * 1024 * 1024;   // 单个请求体上限（提示词可能很长，但总得有个边）

const now = () => Date.now();
const newId = (p) => p + randomBytes(6).toString('hex');
const newLease = () => randomBytes(12).toString('hex');

/** node:http 的 ServerResponse 没有 res.json（那是 Express 的 API）——踩过：调用它抛
 *  TypeError 会让任务永远发不出去、客户端一直挂等。统一走这个助手，并且**失败要能被看见**
 *  （静默 catch 让我多花了一轮才定位到问题）。 */
function sendJson(res, obj, status = 200, log = () => {}) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
    return true;
  } catch (error) {
    log(`sendJson 失败（status=${status}）：${error?.message || error}`);
    return false;
  }
}

export function createBroker({
  token,
  port = 3081,
  host = '127.0.0.1',
  timeoutMs = 240_000,
  stallMs = 90_000,
  ackTimeoutMs = ACK_TIMEOUT_MS,
  maxDeliveries = MAX_DELIVERIES,
  handoffTimeoutMs = HANDOFF_TIMEOUT_MS,
  log = () => {},
  onEvent = () => {},
} = {}) {
  if (!token) throw new Error('broker 需要配对密钥（token）');

  const tasks = new Map();     // id -> task
  const queue = [];            // 待派发的任务 id（FIFO）
  const pollers = [];          // 正在长轮询的扩展连接
  let active = null;           // 当前已派发给扩展的任务 id
  let worker = null;           // { clientId, version, state, seenAt, busy }
  let lastCancelled = null;    // { taskId, at, toldTo }：取消通知要活到任务被清理之后，扩展才能及时停下
  let server = null;
  let ackTimer = null;

  const event = (type, data = {}) => { try { onEvent({ type, at: now(), ...data }); } catch { /* 事件回调不许影响主流程 */ } };

  function workerConnected() {
    return !!worker && now() - worker.seenAt < 45_000;
  }

  function status() {
    return {
      ok: true,
      // 真实实现版本（以前这里硬编码 '1.0.0'，排查时误导过：看不出在跑哪一版、重载有没有生效）
      version: implIdentity().version,
      impl: implTag(),
      connected: workerConnected(),
      // workerVersion 与上游 /status 同名字段：安装器、连接器、面板都可能读它，平铺一份省得改各处
      workerVersion: worker?.version ?? null,
      workerState: worker?.state ?? null,
      workerBusy: worker?.busy ?? null,
      worker: worker ? { version: worker.version, state: worker.state, clientId: worker.clientId, seenAgoMs: now() - worker.seenAt } : null,
      queued: queue.length,
      active: active ? { id: active, phases: (tasks.get(active)?.phases || []).slice(-3) } : null,
      tasks: tasks.size,
      mode: 'own',
    };
  }

  /* ---------------- 交付确认：没人接手就重新派发 ---------------- */

  /**
   * 定期检查"已派发但迟迟没有任何进展"的任务，把它们放回队列重新派发。
   * 这一条解决了整类问题：扩展的服务工作线程被杀、连接中断、页面正在重载、
   * 任务被写进没人读的响应对象……外部表现都一样：派发成功之后彻底静默。
   * 超过最大交付次数才判失败（避免无限重投一个根本没人接的桥接）。
   */
  function checkDeliveryAcks() {
    for (const task of tasks.values()) {
      if (task.done || task.state !== 'sent') continue;
      // 一级：连"收到"都没有 → 这次交付根本没落到活人手里（服务工作线程被杀、连接中断）
      const receiptOverdue = task.awaitingAckSince !== null && now() - task.awaitingAckSince >= ackTimeoutMs;
      // 二级：收到了但一直没人接手（内容脚本没给出第一份进度）→ 也要重发
      const handoffOverdue = task.awaitingAckSince === null && !task.handoffProven && now() - task.dispatchedAt >= handoffTimeoutMs;
      if (!receiptOverdue && !handoffOverdue) continue;
      const why = receiptOverdue ? '交付没有回应' : '扩展收到后一直没接手';
      task.awaitingAckSince = null;
      if (task.attempts >= maxDeliveries) {
        finishTask(task, {
          ok: false,
          error: `连续 ${task.attempts} 次交付都${receiptOverdue ? '没有得到响应' : '没有人接手'}（扩展或标签页可能不稳定，或浏览器把它的服务工作线程杀了）。`,
          code: 'WEB_NO_ACK',
        });
        continue;
      }
      const lastPhase = task.phases.slice(-1)[0] || '（还没有阶段）';
      const note = `第 ${task.attempts} 次${why}，正在重新派发（最后阶段：${lastPhase}）`;
      task.phases.push(note);
      event('task_redeliver', { taskId: task.id, attempt: task.attempts, lastPhase, why });
      for (const p of task.progressWriters) { try { p.write(JSON.stringify({ type: 'progress', phase: note }) + '\n'); } catch { /* ignore */ } }
      try { task.onProgress?.(note); } catch { /* ignore */ }
      if (active === task.id) active = null;
      clearInterval(task.stallTimer);
      task.state = 'queued';         // 总预算计时器**不动**：重新派发也还在原来的预算里
      task.lease = null;
      queue.unshift(task.id);        // 放回队首：它本来就该先做
      dispatchNext();
    }
  }

  /* ---------------- 任务生命周期 ---------------- */

  function dispatchNext() {
    if (active || !queue.length) return;
    // 先取一个**真正待派发**的任务：队列里可能夹着已完成/已取消的残留 id（超时与取消
    // 只改任务状态，不把它从 queue 数组里摘掉）。旧实现 shift 一次发现不是 queued 就直接
    // return —— 残留 id 会卡住它后面的任务，直到下一次派发触发才被顺带清掉（表现为莫名延迟）。
    let id = null;
    let task = null;
    while (queue.length) {
      const candidate = queue.shift();
      const t = tasks.get(candidate);
      if (t && t.state === 'queued') { id = candidate; task = t; break; }
    }
    if (!task) return;
    // N2：**别派给自称忙的等待者**。扩展在忙时会照常长轮询（保持在线），但它的
    // `if (poll.task && !active)` 会**静默忽略**收到的任务——这次交付就凭空消失，
    // 白白烧掉 3 次重投中的一次，最后报 WEB_NO_ACK。这里只从"不忙"的等待者里挑人；
    // 全都在忙就把任务放回队首，等某个等待者下一次以 busy:false 回来再派。
    let picked = -1;
    for (let i = pollers.length - 1; i >= 0; i--) { if (!pollers[i].busy) { picked = i; break; } }
    if (picked < 0) { queue.unshift(id); return; }
    // **后进先出**：优先派给最近注册的那个（不忙的）等待者。
    // 为什么不是先进先出：MV3 的服务工作线程被浏览器回收后，那条长轮询的 socket 往往还开着
    // （fetch 由浏览器进程持有），但已经没人处理响应了。服务端看它是个"活着的等待者"，
    // 派进去的任务就凭空消失。**死掉的等待者一定是最旧的**，所以取最新的那个能绕开它们；
    // 旧的会在 socket 关闭或长轮询到期时被清掉。
    const poller = pollers.splice(picked, 1)[0];
    clearTimeout(poller.timer);
    task.state = 'sent';
    task.lease = newLease();
    task.dispatchedAt = now();
    task.deadline = now() + (task.timeoutMs || timeoutMs);
    // 交付确认分两级（缺一不可，见 checkDeliveryAcks）：
    //   一级 awaitingAckSince —— 扩展**收到**任务就该立刻确认（消除"页面正在重载导致接手慢"的误重发）；
    //   二级 handoffProven  —— 内容脚本真的**接手**了（给出第一份进度）才算交付成功。
    // 只做一级会把重发保护一起关掉（确认了却没人干活，任务就真的没人管了）。
    task.attempts = (task.attempts || 0) + 1;
    task.awaitingAckSince = now();
    task.handoffProven = false;
    active = id;
    // 停滞看门狗：派发后既没有进度也没有结果 → 判定网页侧卡住，主动失败并让扩展停下。
    // 检查间隔随 stallMs 缩放（1~5 秒）：写死 5 秒会让小于 5 秒的 stallMs 形同虚设，
    // 也会让生产配置（90 秒）最坏多等 5 秒才发现卡住（实测：测试里 stallMs=1.2s 时压根不触发）。
    const stallCheckMs = Math.max(1000, Math.min(5000, Math.floor(stallMs / 3)));
    task.stallTimer = setInterval(() => {
      if (task.state === 'sent' || task.state === 'generating') {
        if (now() - (task.lastActivityAt || task.dispatchedAt) > stallMs) {
          finishTask(task, { ok: false, error: `网页侧停滞：${Math.round(stallMs / 1000)} 秒内没有任何进展（最后阶段：${task.phases.slice(-1)[0] || '未知'}）。`, code: 'WEB_STALL', cancelled: true });
        }
      }
    }, stallCheckMs);
    task.stallTimer.unref?.();
    event('task_dispatched', { taskId: id, lease: task.lease });
    sendJson(poller.res, { task: { id, lease: task.lease, prompt: task.prompt, requestId: task.requestId, timeoutMs: task.timeoutMs || timeoutMs }, activeTaskId: id });
  }

  function finishTask(task, { ok, text = '', error = '', code = '', metrics = null, cancelled = false, reasoning = '' }) {
    if (task.done) return false;
    task.done = true;
    task.state = cancelled ? 'cancelled' : (ok ? 'done' : 'failed');
    // 耗时分解放进 result 本体（而不是只在 HTTP 那一行里拼），这样进程内调用
    // （DSH 插件那条路）也能拿到"排队等了多久 / 执行用了多久"——否则两边看到的字段不一样。
    task.result = {
      ok, text, error, code, metrics, cancelled, reasoning,
      durationMs: now() - task.createdAt,
      queuedMs: task.dispatchedAt ? task.dispatchedAt - task.createdAt : null,
      executedMs: task.dispatchedAt ? now() - task.dispatchedAt : null,
    };
    clearInterval(task.stallTimer);
    clearTimeout(task.timer);
    if (active === task.id) active = null;
    for (const p of task.progressWriters) {
      try { p.write(JSON.stringify({ type: 'result', ...task.result, phases: task.phases }) + '\n'); } catch { /* 客户端已断开 */ }
      try { p.end(); } catch { /* ignore */ }
    }
    task.progressWriters = [];
    // 进程内调用（DSH 插件那条路）用回调收尾，不必自己 HTTP 打自己
    try { task.onFinish?.(task.result); } catch { /* 调用方的问题不该影响 broker */ }
    if (cancelled) lastCancelled = { taskId: task.id, at: now(), toldTo: null };   // 让扩展在下次 poll 时立刻停下
    event('task_finished', { taskId: task.id, ok, code, cancelled });
    // 完成一个就尝试派下一个：单 worker 串行
    setImmediate(dispatchNext);
    // 收尾清理（给正在读流的客户端一点时间）
    setTimeout(() => tasks.delete(task.id), 30_000).unref?.();
    return true;
  }

  function createTask({ prompt, requestId = '', timeoutMs: taskTimeout, streamRes, onProgress = null, onFinish = null }) {
    const id = newId('task_');
    const task = {
      id, prompt, requestId, timeoutMs: taskTimeout || timeoutMs,
      state: 'queued', phases: [], progressWriters: streamRes ? [streamRes] : [],
      onProgress, onFinish,
      createdAt: now(), lastActivityAt: now(), lease: null, done: false,
    };
    task.timer = setTimeout(() => {
      const queued = task.state === 'queued';
      finishTask(task, {
        ok: false,
        // 两个超时**必须给不同错误码**：排队超时说明"没人取走"，提示词肯定没发出去，重试安全；
        // 已派发后超时说明**提示词可能已经提交到网页**，重试就会在用户账号里留下第二条一样的
        // 提问。调用方的 retryable() 只把前者当可重试。
        code: queued ? 'WEB_TIMEOUT' : 'WEB_TIMEOUT_AFTER_DISPATCH',
        error: queued
          ? `网页桥接 ${Math.round((task.timeoutMs) / 1000)} 秒内没有取走这个任务（扩展可能没在运行，或浏览器/电脑休眠）。`
          : `网页侧 ${Math.round((task.timeoutMs) / 1000)} 秒内没有返回结果。提示词可能已经提交到网页，请先在网页里确认结果，不要直接重试。`,
        cancelled: true,
      });
    }, task.timeoutMs);
    task.timer.unref?.();
    tasks.set(id, task);
    queue.push(id);
    event('task_queued', { taskId: id, queued: queue.length });
    dispatchNext();
    return task;
  }

  /* ---------------- HTTP ---------------- */

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > BODY_LIMIT) { reject(new Error('请求体过大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON：' + e.message)); }
      });
      req.on('error', reject);
    });
  }

  /** Host 校验：必须是本机端口（挡 DNS rebinding——恶意域名解析到 127.0.0.1 来打我 API） */
  function hostAllowed(req, res) {
    const hostHeader = String(req.headers.host || '');
    const okHost = new RegExp(`^(${host}|localhost):${server?.address()?.port ?? port}$`).test(hostHeader);
    if (!okHost) sendJson(res, { error: 'Host 不被允许' }, 403);
    return okHost;
  }

  /** 密钥校验（只对需要它的端点做） */
  function tokenAllowed(req, res) {
    const auth = String(req.headers.authorization || '');
    if (auth !== 'Bearer ' + token) { sendJson(res, { error: '配对密钥不正确' }, 401); return false; }
    return true;
  }

  /**
   * 进程内跑一轮（HTTP /v1 与插件 run() 共用同一条派发、租约、看门狗、取消逻辑）。
   * 返回原始结果对象（不抛错）：调用方自己决定怎么表达失败。
   */
  function runOnce({ prompt, requestId = '', timeoutMs: budget, signal, onProgress = () => {} }) {
    return new Promise((resolve) => {
      const task = createTask({ prompt, requestId, timeoutMs: budget, onProgress, onFinish: (result) => resolve(result) });
      if (signal) {
        const abort = () => { if (!task.done) finishTask(task, { ok: false, error: '调用方已取消（上游/DSH 侧中断）', code: 'WEB_ABORTED', cancelled: true }); };
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      }
    });
  }

  /**
   * 哪些失败可以自动重发一轮？
   * **只剩"缺必需参数"这一类**（用户 2026-09-28 的决策：折中方案）。
   * 理由：这类失败靠一句 nudge 提醒基本能救回来，是唯一值得自动重发的场景；而其余格式类
   * 失败（散文 / kind 不对 / 空文本 / 没有 calls）**按定义都是"提示词已提交"**——重试会把
   * 整段提示词再发一遍，用户自己的 DeepSeek 账号里就会出现第二条一模一样的提问，
   * 这是本项目最高级别的红线。那几类现在只报错，由人或上层决定是否重试。
   */
  const RETRYABLE_CODES = new Set(['WEB_TOOL_MISSING_ARGS']);
  const RETRY_NUDGE = '上一轮你的工具调用缺少必需参数。这次请把 parameters 里 required 列出的字段'
    + '**全部填上**，不要交空对象，也不要多写其它字段。';

  /**
   * 跑一轮对话并解析成 OpenAI 的 reply 结构（含一次"带提醒重试"）。
   * 每轮用**新的 requestId**：页面上的答复里带着它，既用于定位（扩展侧的认账门），
   * 也用于防止把上一轮的旧答复当成本轮结果。
   */
  async function chatOnce({ messages, tools = [], timeoutMs: budget, signal, onProgress = () => {} }) {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const requestId = 'req-' + randomUUID().replace(/-/g, '').slice(0, 10);
      const built = buildTask({ messages, tools, requestId, nudge: attempt === 2 ? RETRY_NUDGE : '' });
      const result = await runOnce({ prompt: built.prompt, requestId, timeoutMs: budget, signal, onProgress });
      if (result.ok) {
        try {
          return { reply: parseReply(result.text, { id: requestId, schemas: schemasOf(tools) }), requestId, metrics: result.metrics || null, reasoning: result.reasoning || '' };
        } catch (error) {
          lastError = error;
        }
      } else {
        lastError = Object.assign(new Error(result.error || '网页侧失败'), { code: result.code || 'WEB_FAILED', cancelled: result.cancelled });
      }
      if (!RETRYABLE_CODES.has(String(lastError?.code || ''))) break;
    }
    throw lastError || new Error('网页桥接失败');
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const path = url.pathname;

    // 顺序很重要：**Host 校验对所有端点先行**
    // （实测踩到：/status 曾排在检查之前，于是绕过了 DNS rebinding 防护）；密钥只对需要的端点校验。
    if (!hostAllowed(req, res)) return;

    // 状态查询不需要密钥（安装器/中转站的健康检查会打它），但不上报任何提示词内容
    if (req.method === 'GET' && path === '/status') {
      sendJson(res, status());
      return;
    }

    if (!tokenAllowed(req, res)) return;

    if (req.method === 'POST' && path === '/ext/poll') {
      const b = await readBody(req);
      worker = { clientId: String(b.clientId || 'unknown'), version: String(b.version || ''), state: String(b.state || ''), seenAt: now(), busy: !!b.busy };
      // 已经结束的取消通知仍要送达（否则扩展会继续跑一轮没人要的对话）：
      // 用 toldTo 记住已经通知过谁，避免同一条通知反复触发。
      const notice = lastCancelled && now() - lastCancelled.at < 60_000 && lastCancelled.toldTo !== worker.clientId ? lastCancelled : null;
      if (notice) {
        notice.toldTo = worker.clientId;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ cancelledTaskId: notice.taskId }));
        return;
      }
      // 仍在跑但已被取消的任务
      const cancelledTaskId = active && tasks.get(active)?.state === 'cancelled' ? active : null;
      if (cancelledTaskId) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ cancelledTaskId }));
        return;
      }
      // **无论有没有现成任务，都先把这次 poll 登记成等待者，再尝试派发。**
      // 为什么：dispatchNext() 是从 pollers 里"取人"来派活的。早先写成
      // 「有任务就只调 dispatchNext()、不登记」，于是"任务先入队、扩展随后 poll"这条
      // 很常见的路径永远派不出去——要等本轮 20 秒长轮询超时、靠下一次 poll 才救回来
      // （实测被测试抓到：任务 4 秒后按"没有取走"超时，而扩展明明在轮询）。
      const poller = {
        res,
        // N2：把"扩展自称忙"记在等待者身上，dispatchNext() 只挑不忙的派活。
        // 扩展在忙时仍会轮询（保活），若把任务派给它会被静默忽略、交付凭空消失。
        busy: !!b.busy,
        timer: setTimeout(() => {
          const i = pollers.indexOf(poller);
          if (i >= 0) pollers.splice(i, 1);
          try { sendJson(res, { activeTaskId: active }); } catch { /* ignore */ }
        }, POLL_HOLD_MS),
      };
      poller.timer.unref?.();
      pollers.push(poller);
      // 客户端断开（浏览器杀掉服务工作线程、网络中断、页面在重载）→ 立刻把这个等待者摘掉。
      // 否则 broker 会把任务写进一个**已经没人读的响应对象**：服务端看起来"派发成功"，
      // 实际任务凭空消失——这正是我们观察到的 120 秒静默超时的一种成因。
      res.on('close', () => {
        const at = pollers.indexOf(poller);
        if (at >= 0) pollers.splice(at, 1);
      });
      dispatchNext();   // 有任务会被立刻派给这次 poll；没有就挂在等待者里
      return;
    }

    if (req.method === 'POST' && (path === '/ext/progress' || path === '/ext/result')) {
      const b = await readBody(req);
      const task = tasks.get(String(b.taskId || ''));
      // 顺序：**先判"已取消"**再判"已结束"——取消的任务要回 {cancelled:true}（扩展据此点停止），
      // 回 {stale:true} 会让它以为只是过期，语义不对（实测踩到）。
      if (task && task.state === 'cancelled') { sendJson(res, { cancelled: true }); return; }
      if (!task || task.done) { event('task_report_rejected', { taskId: String(b.taskId || ''), path, why: task ? '任务已结束' : '未知任务' }); sendJson(res, { ok: false, stale: true }); return; }
      if (!b.lease || b.lease !== task.lease) { event('task_report_rejected', { taskId: task.id, path, why: 'lease 不匹配' }); sendJson(res, { ok: false, stale: true, reason: 'lease 不匹配' }); return; }
      task.lastActivityAt = now();
      task.awaitingAckSince = null;   // 收到任何回报都算「这次交付落到了活人手里」，撤销一级重投计时
      if (path === '/ext/progress') {
        const phase = String(b.phase || '').slice(0, 1600);   // 诊断行较长（含文本块样本），别把它截断（实测被截断过）
        // stage='receipt' 是扩展"我收到了"的一级确认：它只证明有活人接到，
        // **不算接手**（delivery 仍要靠内容脚本的第一份进度来证明）——所以不置 handoffProven、
        // 也不把状态推进到 generating（否则停滞看门狗会误判成"已在生成"）。
        const isReceipt = b.stage === 'receipt';
        if (phase) {
          if (!isReceipt) {
            task.handoffProven = true;
            task.state = 'generating';
          }
          task.phases.push(phase);
          if (task.phases.length > 12) task.phases.shift();
          for (const p of task.progressWriters) { try { p.write(JSON.stringify({ type: 'progress', phase }) + '\n'); } catch { /* ignore */ } }
          try { task.onProgress?.(phase); } catch { /* ignore */ }
          event(isReceipt ? 'task_receipt' : 'task_progress', { taskId: task.id, phase });
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      finishTask(task, { ok: !!b.ok, text: String(b.text ?? ''), error: String(b.error ?? ''), code: String(b.code ?? ''), metrics: b.metrics || null, reasoning: String(b.reasoningText ?? b.reasoning ?? '') });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && path === '/task') {
      const b = await readBody(req);
      const prompt = String(b.prompt || '');
      if (!prompt) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'prompt 不能为空' })); return; }
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const task = createTask({ prompt, requestId: String(b.requestId || ''), timeoutMs: Number(b.timeoutMs) || timeoutMs, streamRes: res });
      // 客户端断开（刷新/断网/取消）→ 立刻取消任务，并让扩展停下（绝不继续跑一轮没人要的对话）
      res.on('close', () => {
        if (task.done) return;
        task.progressWriters = [];
        finishTask(task, { ok: false, error: '客户端已断开，任务已取消', code: 'WEB_ABORTED', cancelled: true });
      });
      return;
    }

    // ── OpenAI 兼容面：把本机桥接直接当成一个"上游"给本机程序用 ──────────────────────
    // 为什么要有：中转站原来那份 web-bridge-openai.js 是 import **上游插件**的协议模块、打上游的
    // /adapter/stream —— 等于把中转站焊死在上游实现上（上游一改版就废）。有了这两个端点，
    // 中转站只要把 baseUrl 填成 http://127.0.0.1:<port>/v1、apiKey 填本机配对密钥即可，
    // 与本机桥接的版本彻底解耦（协议、解析、带提醒重试都在这一份实现里）。
    if (req.method === 'GET' && path === '/v1/models') {
      sendJson(res, { object: 'list', data: [{ id: 'web-deepseek', object: 'model', created: 0, owned_by: 'web-bridge' }] });
      return;
    }

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      const b = await readBody(req);
      const messages = Array.isArray(b.messages) ? b.messages : [];
      const tools = Array.isArray(b.tools) ? b.tools : [];
      if (!messages.length) {
        sendJson(res, { error: { message: 'messages 不能为空', type: 'invalid_request_error' } }, 400);
        return;
      }
      const model = String(b.model || 'web-deepseek');
      const stream = b.stream === true;
      const id = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 20);
      const budget = Number(b.timeout_ms || b.timeoutMs) || timeoutMs;
      // 阶段透传：流式时用 SSE 注释行带上网页侧的真实阶段（调用方/日志都能看到卡在哪一步）
      const onProgress = (p) => {
        // 注意：onProgress 收到的是字符串 phase（runOnce 的 onProgress 回调形如 (phase)），不是对象
        if (stream && p) { try { res.write(`: ${p}\n\n`); } catch { /* 客户端已断开 */ } }
      };
      // **非流式必须等 chatOnce 成功后再 writeHead**：先发 200 再失败的话，headers 已经出去，
      // 失败分支再 sendJson(502) 就只会被吞掉、res 永远不 end——客户端挂死到超时。
      // 流式没有这个问题：SSE 本来就要先发头，失败也走"data: error"事件。
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      }
      // 客户端断开 → 取消任务（不能让网页继续跑一轮没人要的对话）
      let aborted = false;
      const controller = new AbortController();
      res.on('close', () => { aborted = true; controller.abort(); });
      // 保活（2026-09-29）：网页模型一轮要"想 + 写"，可能几十秒；而**非流式**请求在此之前
      // 一个字节都不发 ✗ —— 调用方若设了"空闲读取超时"，就会先断开，结果我们拿到了答复却送不出去
      // （用户侧表现："网页端有结果，我这边收不到/显示已完成但没内容"✗）。
      // 做法：非流式每 10 秒写一个换行 —— 对 JSON 是**合法空白**，JSON.parse 完全容忍 ✓；
      //       流式写 SSE 注释行（`: keepalive`），标准 SSE 客户端会忽略 ✓。
      const keepAlive = setInterval(() => {
        if (aborted) return;
        try { res.write(stream ? ': keepalive\n\n' : '\n'); } catch { /* 对端已关，交给 close 处理 */ }
      }, 10_000);
      if (keepAlive.unref) keepAlive.unref();
      try {
        const { reply, reasoning } = await chatOnce({ messages, tools, timeoutMs: budget, signal: controller.signal, onProgress });
        const completion = toOpenAICompletion(reply, { model, id, reasoning });
        if (!stream) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(completion));
          return;
        }
        for (const chunk of replyChunks(reply, 0)) res.write(`data: ${JSON.stringify({ ...chunk, id, model })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (error) {
        if (aborted) { try { res.end(); } catch { /* ignore */ } return; }
        const code = String(error?.code || 'WEB_FAILED');
        if (!stream) {
          // 此时 headers 还没发（writeHead 在成功路径上才执行），错误状态码能真正到达客户端
          sendJson(res, { error: { message: String(error?.message || error), type: 'web_bridge_error', code } }, /ABORTED/.test(code) ? 499 : /TIMEOUT/.test(code) ? 504 : 502);
          return;
        }
        res.write(`data: ${JSON.stringify({ error: { message: String(error?.message || error), type: 'web_bridge_error', code } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } finally {
        clearInterval(keepAlive);
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '没有这个端点：' + path }));
  }

  return {
    get port() { return server?.address()?.port ?? port; },
    /**
     * 进程内直接跑一轮（给 DSH 插件用）：不必自己 HTTP 打自己，省一层往返与错误面。
     * 与 HTTP 路径共用同一套排队/租约/停滞看门狗/取消逻辑，行为一致。
     */
    run({ prompt, requestId = '', timeoutMs: budget, signal, onProgress = () => {} }) {
      return runOnce({ prompt, requestId, timeoutMs: budget, signal, onProgress }).then((result) => {
        if (result.ok) return result;
        throw Object.assign(new Error(result.error || '网页侧失败'), { code: result.code || 'WEB_FAILED', cancelled: result.cancelled });
      });
    },
    status,
    /** 取消当前任务（面板用）：让网页侧立刻停下，并让等待方立刻失败 */
    cancel(taskId) {
      const id = taskId || active;
      const task = id ? tasks.get(id) : null;
      if (!task || task.done) return false;
      finishTask(task, { ok: false, error: '用户已取消这一轮', code: 'WEB_ABORTED', cancelled: true });
      return true;
    },
    /** 供测试与诊断：当前任务表快照 */
    snapshot() {
      return {
        active,
        queued: queue.slice(),
        tasks: [...tasks.values()].map((t) => ({
          id: t.id, state: t.state, phases: t.phases, done: t.done,
          // 诊断用：交付确认的两个计时点（否则只能靠日志猜"为什么重发了"）
          attempts: t.attempts || 0,
          awaitingReceipt: t.awaitingAckSince !== null && t.awaitingAckSince !== undefined,
          handoffProven: !!t.handoffProven,
          sinceDispatchMs: t.dispatchedAt ? now() - t.dispatchedAt : null,
        })),
        pollers: pollers.length,
        busyPollers: pollers.filter((p) => p.busy).length,   // N2 诊断：有几个等待者自称忙
        worker: worker ? { ...worker } : null,
      };
    },
    async start() {
      if (server) return this;
      server = createServer((req, res) => {
        handle(req, res).catch((error) => {
          try { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(error?.message || error) })); } catch { /* ignore */ }
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
      // 注意：**不要**在这里 server.unref()。unref 之后这个服务不维持进程存活，
      // 独立启动时会"起来又立刻退出"（实测：后台跑 broker 的进程 exit 0，端口根本没留下）。
      // 服务的生命周期交给调用方：DSH 插件挂在 ctx.effect 上、lite 客户端挂在 start.mjs 上，
      // 都靠显式 close() 收尾。
      ackTimer = setInterval(checkDeliveryAcks, Math.max(200, Math.floor(ackTimeoutMs / 4)));
      ackTimer.unref?.();
      log(`自研桥接已监听 ${host}:${this.port}`);
      return this;
    },
    async close() {
      clearInterval(ackTimer);
      for (const poller of pollers) { clearTimeout(poller.timer); try { poller.res.end('{}'); } catch { /* ignore */ } }
      pollers.length = 0;
      for (const task of tasks.values()) { clearInterval(task.stallTimer); clearTimeout(task.timer); }
      await new Promise((resolve) => {
        if (!server) return resolve();
        // 必须先断开已存在的连接：server.close() 只是停止接受新连接，会一直等旧连接结束，
        // 而 HTTP keep-alive（fetch/undici 默认开启）不会主动关 → close 回调永不触发、
        // 停止桥接时卡死（实测：测试脚本就卡在这里，永远到不了 process.exit）。
        server.closeAllConnections?.();
        server.closeIdleConnections?.();
        server.close(() => resolve());
      });
      server = null;
    },
  };
}
