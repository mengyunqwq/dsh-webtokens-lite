// extension/background.js — 服务工作线程：与本机 broker（127.0.0.1:3081）对接
//
// 流程：长轮询 /ext/poll 领任务 → 交给页面驱动跑 → 把进度与结果回报 /ext/progress、/ext/result。
// 安全性质（与上游一致，都是踩过坑才留下的）：
//   · 每个任务带 lease 租约，回报必须带对，防止旧实例把结果写进新任务；
//   · **先记"已派发"再让页面提交**：页面/服务工作线程被重载时，只要已经派发过，
//     就报错而不是重发（用户账号里不会出现两条一样的提问）；
//   · 取消（broker 回 cancelled 或用户点停止）会传给页面驱动，让它点网页的停止按钮。

const DEFAULTS = { base: 'http://127.0.0.1:3081' };
const VERSION = '1.0.11';   // 改动扩展行为时请一起改这里 + manifest.version，便于确认浏览器里加载的是哪一版
let pumping = false;

const configPromise = (async () => {
  try {
    const res = await fetch(chrome.runtime.getURL('local-config.json'));
    const cfg = await res.json();
    return { ...DEFAULTS, ...cfg };
  } catch { return { ...DEFAULTS, token: '' }; }
})();

const clientIdPromise = (async () => {
  const { clientId } = await chrome.storage.local.get('clientId');
  if (clientId) return clientId;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ clientId: fresh });
  return fresh;
})();

async function api(path, body, timeoutMs = 25_000) {
  const config = await configPromise;
  if (!config.token) throw new Error('扩展目录缺少 local-config.json（重跑 npm run setup）');
  const res = await fetch(config.base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token },
    body: JSON.stringify({ ...body, clientId: await clientIdPromise }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || ('本机桥接 HTTP ' + res.status));
  return json;
}

async function setState(state, patch = {}) {
  await chrome.storage.local.set({ state, stateAt: Date.now(), ...patch });
  const badge = /错误/.test(state) ? '!' : /等待|已提交|生成/.test(state) ? '…' : '连';
  try {
    await chrome.action.setBadgeText({ text: badge });
    await chrome.action.setBadgeBackgroundColor({ color: /错误/.test(state) ? '#c43636' : '#4361ee' });
  } catch { /* ignore */ }
}

/** 找到（或打开）一个 DeepSeek 标签页 */
async function ensureTab() {
  const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  // 按"上次选定 → 逐个问健康 → 跳过登录页"来挑一个**真正可用**的标签页。
  // 为什么不能只取第一个：同一域名下可能有多个标签页，其中一个停在登录页或已被丢弃。
  // 实测踩到：扩展一直在驱动一个停在登录页的旧标签页，而用户看的是另一个能正常回答的
  // 标签页 —— 于是"页面上明明有答复，内容脚本却报命中 0 行"。
  const { bridgeTabId } = await chrome.storage.local.get('bridgeTabId');
  const ordered = [...tabs].sort((a, b) => (a.id === bridgeTabId ? -1 : b.id === bridgeTabId ? 1 : 0));
  for (const tab of ordered) {
    if (/sign[_-]?in|login|register/i.test(String(tab.url || ''))) continue;
    const health = await ask(tab.id, { type: 'health' });
    if (health?.ready) {
      await chrome.storage.local.set({ bridgeTabId: tab.id });
      try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch { /* ignore */ }
      return tab;
    }
  }
  if (tabs.length) {
    const tab = tabs.find((t) => !/sign[_-]?in|login|register/i.test(String(t.url || ''))) || tabs[0];
    await chrome.storage.local.set({ bridgeTabId: tab.id });
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch { /* ignore */ }
    return tab;
  }
  const created = await chrome.tabs.create({ url: 'https://chat.deepseek.com/', active: false });
  try { await chrome.tabs.update(created.id, { autoDiscardable: false }); } catch { /* ignore */ }
  await waitForComplete(created.id);   // 等它加载完，否则后面发消息一定没人应答
  await chrome.storage.local.set({ bridgeTabId: created.id });
  return created;
}

/** 等到这个标签页加载完成（新建的标签页默认还在加载，立刻发消息必然没人应答） */
function waitForComplete(tabId, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // 有可能在注册监听之前就加载完了，补一次查询
    chrome.tabs.get(tabId).then((tab) => { if (tab?.status === 'complete') finish(true); }).catch(() => finish(false));
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等内容脚本报 ready（输入框出现）。页面刚加载完到输入框可用之间有一段空窗。 */
async function waitForReady(tabId, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await ask(tabId, { type: 'health' });
    if (health?.ready) return health;
    if (Date.now() > deadline) return health || null;
    await pause(500);
  }
}

/**
 * 拿到内容脚本的健康状态；必要时**重载一次标签页**再重试。
 * 为什么需要：内容脚本只在页面加载时注入。如果标签页是在扩展安装/更新**之前**打开的
 * （非常常见：先登录、后装扩展），那个页面上根本没有内容脚本，任何消息都没人应答。
 * 重载一次是无害的——此时还没提交过任何提示词，不会造成重复提问。
 * ⚠ 任务进行中**绝不能**走这条路（会丢掉正在生成的答复），所以由调用方用 allowReload 控制。
 */
async function ensureContentScript(tabId, { allowReload = true } = {}) {
  let health = await ask(tabId, { type: 'health' });
  if (health) return health;
  if (!allowReload) return null;
  try { await chrome.tabs.reload(tabId); } catch { return null; }
  await waitForComplete(tabId);
  for (let i = 0; i < 12; i++) {
    health = await ask(tabId, { type: 'health' });
    if (health) return health;
    await pause(500);
  }
  return null;
}

const ask = (tabId, message) => chrome.tabs.sendMessage(tabId, message).catch(() => null);

async function fail(active, error, code) {
  await api('/ext/result', { taskId: active.id, lease: active.lease, ok: false, error, code }).catch(() => {});
  await chrome.storage.local.remove('active');
  await setState('错误：' + error, { lastError: { at: Date.now(), error } });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    // 先把上一轮没送出去的结果补上（哪怕这次 poll 还没开始）
    await flushPendingResult();
    const { active, state } = await chrome.storage.local.get(['active', 'state']);
    // 桥接恢复后，别让"等待本机桥接：…"这条过期错误一直挂在状态里（排查时会被误导）
    if (!active && /^等待本机桥接/.test(String(state || ''))) await setState('已连接，等待任务');

    // ---- 自我保护：清理"卡死的 active" ----
    // 如果上一轮任务超过预算还没结束（例如 broker 早就超时了，而取消通知因为超过 60 秒
    // 没能送到扩展），后台会一直以为自己 busy，于是**再也接不了新任务**——外部表现是
    // "桥接突然全都不动了"。实测踩到：/status 显示 active 为空，扩展却一直上报"等待网页答复"。
    if (active) {
      const age = Date.now() - (active.startedAt || 0);
      const budget = (active.timeoutMs || 240_000) + 30_000;
      if (age > budget) {
        await ask(active.tabId, { type: 'cancel', id: active.id });
        await chrome.storage.local.remove('active');
        await setState('已连接，上一轮超时已自动清理，可接新任务', { lastError: { at: Date.now(), error: '上一轮超过预算未结束，已自动清理' } });
        return;
      }
    }

    const poll = await api('/ext/poll', { busy: !!active, version: VERSION, state: state ?? '已连接，等待任务' }, 30_000);

    // broker 明确说它手里没有活动任务，而我们还留着一个 → 这是残留，清掉（加 10 秒保护期，
    // 避免刚派发、尚未开始执行的瞬间被误清）
    if (active && poll.activeTaskId === null && Date.now() - (active.startedAt || 0) > 10_000) {
      await chrome.storage.local.remove('active');
      await setState('已连接，上一轮已结束（服务端已无此任务），可接新任务');
      return;
    }

    // 取消通知：可能在任务开始前、也可能在派发之后
    if (poll.cancelledTaskId) {
      if (active?.id === poll.cancelledTaskId) {
        await ask(active.tabId, { type: 'cancel', id: active.id });
        await chrome.storage.local.remove('active');
        await setState('已连接，任务已取消');
      }
      return;
    }

    if (poll.task && !active) {
      const job = { id: poll.task.id, lease: poll.task.lease, prompt: poll.task.prompt, timeoutMs: poll.task.timeoutMs };
      // 一级确认：**立刻**告诉 broker「我收到了」，赶在找标签页/自愈重载之前。
      // 这样"页面正在加载"这段合法的慢就不会被误判成丢件而重发（重发意味着同一提示词
      // 有被提交两次的风险）。真正的"接手"仍由内容脚本的第一份进度证明——两层缺一不可。
      await api('/ext/progress', {
        taskId: job.id, lease: job.lease, stage: 'receipt',
        phase: '扩展已收到任务，正在准备标签页',
      }).catch(() => { /* 确认失败不影响正事：真正的接手进度还会再报一次 */ });
      const tab = await ensureTab();
      // 先记"已派发"，再让它提交：任何中途重载都不会导致重复提问
      await chrome.storage.local.set({ active: { ...job, tabId: tab.id, dispatched: true, startedAt: Date.now() } });
      const health = await ensureContentScript(tab.id);
      // 输入框要等页面渲染完才出现（尤其扩展刚重载、自愈又把页面重载了一次的时候）。
      // 早先只查一次就判死 —— 实测报成"未登录"，其实只是页面还在加载。
      const ready = health?.ready ? health : await waitForReady(tab.id);
      if (ready?.isSignIn) {
        await fail({ ...job }, `扩展选中的标签页停在登录页（${String(ready.href || '').slice(0, 60)}）——请在**已登录**的那个 chat.deepseek.com 标签页上重试，或把其他 DeepSeek 标签页关掉只留一个`, 'WEB_SIGN_IN_PAGE');
        return;
      }
      if (!ready?.ready) {
        await fail({ ...job }, ready ? '专用标签页还没准备好（可能未登录 chat.deepseek.com，或页面还在加载）' : '专用标签页没有响应扩展（已在安装后重载过一次仍无应答，请确认该页面能正常打开）', 'WEB_PAGE_NOT_READY');
        return;
      }
      const sent = await ask(tab.id, { type: 'run', job });
      // 关键：**没有应答不等于成功**。早先这里把 null 当成"已提交"，于是任务被悬空——
      // 扩展侧什么都没做，broker 却一直等（实测：120 秒静默超时，日志里只有 dispatched、
      // 没有任何 progress）。现在明确判失败，且因为提示词还没提交，可以安全重试。
      if (!sent) { await fail(job, '专用标签页没有接手这个任务（内容脚本无应答）。网页没有收到提示词，可安全重试。', 'WEB_SCRIPT_SILENT'); return; }
      if (sent.error) { await fail(job, sent.error, 'WEB_PAGE_BUSY'); return; }
      await setState('已提交到网页，等待答复');
      return;
    }

    if (active) {
      // 注意：这里**故意**用 ask 而不是 ensureContentScript——任务进行中一旦重载页面，
      // 正在生成的答复就丢了（还可能让用户看到半截回答）。宁可报错也不敢重载。
      const health = await ask(active.tabId, { type: 'health' });
      if (!health) {
        // 页面被关掉/导航走了：已派发过就报错，绝不重发
        await fail(active, '专用标签页已关闭或跳转，本次任务无法确认结果（不会重发）', 'WEB_PAGE_GONE');
        return;
      }
      if (active.dispatched && !health.activeId) {
        const waited = Date.now() - (active.startedAt || 0);
        if (waited > 8000) {
          await fail(active, '页面在提交后重载过，无法确认这轮结果（不会重发，请自行确认网页里是否已有答复）', 'WEB_PAGE_RELOADED');
          return;
        }
      }
      await setState(health.generating ? 'DeepSeek 正在生成答复' : '等待网页答复');
    }
  } catch (error) {
    // 本机 broker 没起来 / 网络抖动：只更新状态，不打扰用户
    await setState('等待本机桥接：' + (error?.message || error));
  } finally {
    pumping = false;
  }
}

/** 把结果回传给 broker；**先落盘再回传**，成功才清除。
 *  为什么：服务工作线程随时可能被浏览器回收，一旦"结果"这一跳丢了，用户会白等到超时
 *  （实测：答复 5 秒就读到了，结果 99 秒后才送到）。落盘之后每次 poll 都会补发。 */
async function flushPendingResult() {
  const { pendingResult } = await chrome.storage.local.get('pendingResult');
  if (!pendingResult) return true;
  const res = await api('/ext/result', pendingResult).catch(() => null);
  if (res && res.ok !== false) {
    const waited = Date.now() - (pendingResult.firstAt || Date.now());
    if (waited > 3000) await setState(`结果延迟 ${Math.round(waited / 1000)} 秒后已补发`);
    await chrome.storage.local.remove(['pendingResult', 'active']);
    return true;
  }
  // broker 说这个任务已经不在它手里（过期/已结束）→ 丢弃，别无限补发
  if (res && res.stale) { await chrome.storage.local.remove(['pendingResult', 'active']); return true; }
  return false;   // 网络/服务不可用 → 留着，下一次唤醒再试
}

/** 页面驱动上报的进度与结果 → 转成 broker 的接口 */
async function forward(message) {
  const { active } = await chrome.storage.local.get('active');
  if (!active || (message.taskId && message.taskId !== active.id)) return { ok: false, stale: true };
  if (message.type === 'progress') {
    const r = await api('/ext/progress', { taskId: active.id, lease: active.lease, phase: message.phase }).catch(() => ({}));
    if (r?.cancelled) { await ask(active.tabId, { type: 'cancel', id: active.id }); await chrome.storage.local.remove('active'); await setState('已连接，任务已取消'); }
    else await setState(String(message.phase || '网页正在处理'));
    return { ok: true };
  }
  if (message.type === 'result') {
    // ① 先落盘：结果一旦读到就不能再丢（丢了用户只能白等到超时）
    await chrome.storage.local.set({
      pendingResult: {
        taskId: active.id, lease: active.lease, ok: true,
        text: message.text,
        metrics: { ...(message.metrics || {}), reasoning: (message.reasoning || '').length },
        firstAt: Date.now(),
      },
    });
    // ② 立即尝试回传；失败就留在盘上，由下一次 poll（每 1.5 秒一次）补发
    const sent = await flushPendingResult();
    if (sent) await setState('已完成，等待下一轮');
    else await setState('结果已拿到，正在重试回传');
    return { ok: true };
  }
  if (message.type === 'error') {
    await fail(active, message.error || '网页侧失败');
    return { ok: true };
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 只信任：本扩展自己的页面驱动、以及本扩展的 popup
  if (sender?.id !== chrome.runtime.id) { sendResponse({ error: '不受信任的发送方' }); return true; }
  if (message?.type === 'tick') { sendResponse({ ok: true }); return true; }
  if (sender.tab && !String(sender.tab.url || '').startsWith('https://chat.deepseek.com/')) { sendResponse({ error: '不受信任的来源页面' }); return true; }
  if (['progress', 'result', 'error'].includes(message?.type)) {
    forward(message).then((r) => sendResponse(r)).catch((e) => sendResponse({ error: e.message }));
    return true;   // 异步
  }
  sendResponse({ ok: false });
  return true;
});

chrome.alarms.create('bridge-pump', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => pump());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') pump(); });
chrome.runtime.onStartup.addListener(() => pump());
chrome.runtime.onInstalled.addListener(() => pump());
setInterval(pump, 1500);
pump();
