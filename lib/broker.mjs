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
import { randomBytes } from 'node:crypto';

const POLL_HOLD_MS = 20_000;
const BODY_LIMIT = 8 * 1024 * 1024;   // 单个请求体上限（提示词可能很长，但总得有个边）

const now = () => Date.now();
const newId = (p) => p + randomBytes(6).toString('hex');
const newLease = () => randomBytes(12).toString('hex');

/** node:http 的 ServerResponse 没有 res.json（那是 Express 的 API）——踩过：调用它抛
 *  TypeError 会让任务永远发不出去、客户端一直挂等。统一走这个助手，并且**失败要能被看见**
 *  （静默 catch 让我多花了一轮才定位到问题）。 */
function sendJson(res, obj, status = 200, log = () => {}) {
  try {
    res.writeHead(status, { 'content-type': 'application/json' });
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

  const event = (type, data = {}) => { try { onEvent({ type, at: now(), ...data }); } catch { /* 事件回调不许影响主流程 */ } };

  function workerConnected() {
    return !!worker && now() - worker.seenAt < 45_000;
  }

  function status() {
    return {
      ok: true,
      version: '1.0.0',
      connected: workerConnected(),
      // workerVersion 与上游 /status 同名字段：安装器、连接器、面板都可能读它，平铺一份省得改各处
      workerVersion: worker?.version ?? null,
      workerState: worker?.state ?? null,
      worker: worker ? { version: worker.version, state: worker.state, clientId: worker.clientId, seenAgoMs: now() - worker.seenAt } : null,
      queued: queue.length,
      active: active ? { id: active, phases: (tasks.get(active)?.phases || []).slice(-3) } : null,
      tasks: tasks.size,
      mode: 'own',
    };
  }

  /* ---------------- 任务生命周期 ---------------- */

  function dispatchNext() {
    if (active || !queue.length || !pollers.length) return;
    const id = queue.shift();
    const task = tasks.get(id);
    if (!task || task.state !== 'queued') return;
    const poller = pollers.shift();
    clearTimeout(poller.timer);
    task.state = 'sent';
    task.lease = newLease();
    task.dispatchedAt = now();
    task.deadline = now() + (task.timeoutMs || timeoutMs);
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
    sendJson(poller.res, { task: { id, lease: task.lease, prompt: task.prompt, timeoutMs: task.timeoutMs || timeoutMs } });
  }

  function finishTask(task, { ok, text = '', error = '', code = '', metrics = null, cancelled = false }) {
    if (task.done) return false;
    task.done = true;
    task.state = cancelled ? 'cancelled' : (ok ? 'done' : 'failed');
    task.result = { ok, text, error, code, metrics, cancelled };
    clearInterval(task.stallTimer);
    clearTimeout(task.timer);
    if (active === task.id) active = null;
    for (const p of task.progressWriters) {
      try { p.write(JSON.stringify({ type: 'result', ...task.result, durationMs: now() - task.createdAt, queuedMs: task.dispatchedAt ? task.dispatchedAt - task.createdAt : null, executedMs: task.dispatchedAt ? now() - task.dispatchedAt : null, phases: task.phases }) + '\n'); } catch { /* 客户端已断开 */ }
      try { p.end(); } catch { /* ignore */ }
    }
    task.progressWriters = [];
    if (cancelled) lastCancelled = { taskId: task.id, at: now(), toldTo: null };   // 让扩展在下次 poll 时立刻停下
    event('task_finished', { taskId: task.id, ok, code, cancelled });
    // 完成一个就尝试派下一个：单 worker 串行
    setImmediate(dispatchNext);
    // 收尾清理（给正在读流的客户端一点时间）
    setTimeout(() => tasks.delete(task.id), 30_000).unref?.();
    return true;
  }

  function createTask({ prompt, timeoutMs: taskTimeout, streamRes }) {
    const id = newId('task_');
    const task = {
      id, prompt, timeoutMs: taskTimeout || timeoutMs,
      state: 'queued', phases: [], progressWriters: streamRes ? [streamRes] : [],
      createdAt: now(), lastActivityAt: now(), lease: null, done: false,
    };
    task.timer = setTimeout(() => {
      finishTask(task, {
        ok: false, code: 'WEB_TIMEOUT',
        error: task.state === 'queued'
          ? `网页桥接 ${Math.round((task.timeoutMs) / 1000)} 秒内没有取走这个任务（扩展可能没在运行，或浏览器/电脑休眠）。`
          : `网页侧 ${Math.round((task.timeoutMs) / 1000)} 秒内没有返回结果（命令可能仍在执行）。`,
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
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cancelledTaskId: notice.taskId }));
        return;
      }
      // 仍在跑但已被取消的任务
      const cancelledTaskId = active && tasks.get(active)?.state === 'cancelled' ? active : null;
      if (cancelledTaskId) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cancelledTaskId }));
        return;
      }
      // 单 worker：已经有在跑的任务就不再派新活
      if (active || !queue.length) {
        const poller = {
          res,
          timer: setTimeout(() => {
            const i = pollers.indexOf(poller);
            if (i >= 0) pollers.splice(i, 1);
            try { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); } catch { /* ignore */ }
          }, POLL_HOLD_MS),
        };
        poller.timer.unref?.();
        pollers.push(poller);
        dispatchNext();
        return;
      }
      dispatchNext();
      return;
    }

    if (req.method === 'POST' && (path === '/ext/progress' || path === '/ext/result')) {
      const b = await readBody(req);
      const task = tasks.get(String(b.taskId || ''));
      // 顺序：**先判"已取消"**再判"已结束"——取消的任务要回 {cancelled:true}（扩展据此点停止），
      // 回 {stale:true} 会让它以为只是过期，语义不对（实测踩到）。
      if (task && task.state === 'cancelled') { sendJson(res, { cancelled: true }); return; }
      if (!task || task.done) { sendJson(res, { ok: false, stale: true }); return; }
      if (!b.lease || b.lease !== task.lease) { sendJson(res, { ok: false, stale: true, reason: 'lease 不匹配' }); return; }
      task.lastActivityAt = now();
      if (path === '/ext/progress') {
        const phase = String(b.phase || '').slice(0, 200);
        if (phase) {
          task.state = 'generating';
          task.phases.push(phase);
          if (task.phases.length > 12) task.phases.shift();
          for (const p of task.progressWriters) { try { p.write(JSON.stringify({ type: 'progress', phase }) + '\n'); } catch { /* ignore */ } }
          event('task_progress', { taskId: task.id, phase });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      finishTask(task, { ok: !!b.ok, text: String(b.text ?? ''), error: String(b.error ?? ''), code: String(b.code ?? ''), metrics: b.metrics || null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && path === '/task') {
      const b = await readBody(req);
      const prompt = String(b.prompt || '');
      if (!prompt) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'prompt 不能为空' })); return; }
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const task = createTask({ prompt, timeoutMs: Number(b.timeoutMs) || timeoutMs, streamRes: res });
      // 客户端断开（刷新/断网/取消）→ 立刻取消任务，并让扩展停下（绝不继续跑一轮没人要的对话）
      res.on('close', () => {
        if (task.done) return;
        task.progressWriters = [];
        finishTask(task, { ok: false, error: '客户端已断开，任务已取消', code: 'WEB_ABORTED', cancelled: true });
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '没有这个端点：' + path }));
  }

  return {
    get port() { return server?.address()?.port ?? port; },
    status,
    /** 供测试与诊断：当前任务表快照 */
    snapshot() {
      return {
        active,
        queued: queue.slice(),
        tasks: [...tasks.values()].map((t) => ({ id: t.id, state: t.state, phases: t.phases, done: t.done })),
        pollers: pollers.length,
        worker: worker ? { ...worker } : null,
      };
    },
    async start() {
      if (server) return this;
      server = createServer((req, res) => {
        handle(req, res).catch((error) => {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(error?.message || error) })); } catch { /* ignore */ }
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
      server.unref?.();
      log(`自研桥接已监听 ${host}:${this.port}`);
      return this;
    },
    async close() {
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
