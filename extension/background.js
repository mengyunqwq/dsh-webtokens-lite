// extension/background.js — 服务工作线程：与本机 broker（127.0.0.1:3081）对接
//
// 流程：长轮询 /ext/poll 领任务 → 交给页面驱动跑 → 把进度与结果回报 /ext/progress、/ext/result。
// 安全性质（与上游一致，都是踩过坑才留下的）：
//   · 每个任务带 lease 租约，回报必须带对，防止旧实例把结果写进新任务；
//   · **先记"已派发"再让页面提交**：页面/服务工作线程被重载时，只要已经派发过，
//     就报错而不是重发（用户账号里不会出现两条一样的提问）；
//   · 取消（broker 回 cancelled 或用户点停止）会传给页面驱动，让它点网页的停止按钮。

const DEFAULTS = { base: 'http://127.0.0.1:3081' };
const VERSION = '1.0.0';
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
  if (tabs.length) {
    const tab = tabs[0];
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch { /* ignore */ }
    return tab;
  }
  const created = await chrome.tabs.create({ url: 'https://chat.deepseek.com/', active: false });
  try { await chrome.tabs.update(created.id, { autoDiscardable: false }); } catch { /* ignore */ }
  return created;
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
    const { active, state } = await chrome.storage.local.get(['active', 'state']);
    const poll = await api('/ext/poll', { busy: !!active, version: VERSION, state: state ?? '已连接，等待任务' }, 30_000);

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
      const tab = await ensureTab();
      const job = { id: poll.task.id, lease: poll.task.lease, prompt: poll.task.prompt, timeoutMs: poll.task.timeoutMs };
      // 先记"已派发"，再让它提交：任何中途重载都不会导致重复提问
      await chrome.storage.local.set({ active: { ...job, tabId: tab.id, dispatched: true, startedAt: Date.now() } });
      const health = await ask(tab.id, { type: 'health' });
      if (!health?.ready) {
        await fail({ ...job }, health ? '专用标签页还没准备好（可能未登录 chat.deepseek.com）' : '专用标签页没有响应扩展（刷新一下该页面再试）', 'WEB_PAGE_NOT_READY');
        return;
      }
      const sent = await ask(tab.id, { type: 'run', job });
      if (sent?.error) { await fail(job, sent.error, 'WEB_PAGE_BUSY'); return; }
      await setState('已提交到网页，等待答复');
      return;
    }

    if (active) {
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
    await api('/ext/result', {
      taskId: active.id, lease: active.lease, ok: true, text: message.text, metrics: { ...(message.metrics || {}), reasoning: (message.reasoning || '').length },
    }).catch(() => {});
    await chrome.storage.local.remove('active');
    await setState('已完成，等待下一轮');
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
