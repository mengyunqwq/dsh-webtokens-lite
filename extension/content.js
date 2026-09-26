// extension/content.js — 页面驱动：把提示词提交到 DeepSeek 网页，再把答复原文带回来
//
// 职责边界（与上游最大的不同）：**只搬运文本，不解析、不校验、不纠正格式**。
// JSON 解析、工具参数校验、格式约束与重试都在客户端（lib/protocol.mjs）——
// 好处是扩展更薄，而且协议要改时不用让用户重新加载扩展。
//
// 刻意保留的两条安全性质（都来自真实故障教训）：
//   ① 发送前先在 sessionStorage 落一个标记：万一页面在"已提交、还没拿到结果"时被刷新，
//      醒过来只报错、**绝不重发**——否则用户账号里会出现两条一模一样的提问；
//   ② 12 秒内没等到"网页确认收到"（输入框被清空或出现停止按钮）就判失败，同样不重发。

(() => {
  const D = globalThis.DSHOwnDom;
  const VERSION = '1.0.1';   // 改动扩展行为时请一起改这里 + manifest.version，便于确认浏览器里加载的是哪一版
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let active = null;

  const banner = (text) => {
    try {
      let el = document.getElementById('dsh-own-banner');
      if (!el) {
        el = document.createElement('div');
        el.id = 'dsh-own-banner';
        el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#1f2937;color:#e5e7eb;font:12px/1.6 system-ui;padding:6px 10px;border-radius:8px;opacity:.92;pointer-events:none;max-width:46vw';
        document.body.appendChild(el);
      }
      el.textContent = text;
    } catch { /* 页面结构不允许也不影响搬运 */ }
  };

  const nativeSetValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const pressEnter = (input) => {
    for (const type of ['keydown', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  };

  async function run(job) {
    if (active) throw new Error('网页上已有桥接任务在跑');
    active = { id: job.id, cancelled: false, lease: job.lease };
    const sentKey = 'dsh-own-sent-' + job.id;
    const started = Date.now();
    // 第一件事就留个痕迹：否则"任务被派发了但页面侧什么都没做"这种情况，
    // 外部看起来和"跑了但没回报"完全一样，无法定位（实测踩到：120 秒静默超时）。
    report('progress', { phase: '内容脚本已接手，正在准备提交' }, job.id);
    try {
      if (!D.findComposer(document)) throw new Error('找不到网页输入框：请确认已登录 chat.deepseek.com 且页面加载完成');
      if (D.findStop(document)) throw new Error('网页正在生成别的回答，请等它结束再试');
      const draft = D.findComposer(document);
      if (draft && String(draft.value || '').trim()) throw new Error('网页输入框里已有内容，为避免覆盖已停止本轮');

      const baseline = D.captureBaseline(document);
      let input = D.findComposer(document);
      if (!input) throw new Error('找不到网页输入框');
      // ① 落标记：之后任何重载都只报错、不重发
      sessionStorage.setItem(sentKey, 'sending');
      banner('Harness 专用会话 · 正在提交');
      input.focus();
      nativeSetValue(input, job.prompt);
      await sleep(150);
      if (job.cancelled) { sessionStorage.removeItem(sentKey); return; }
      if (!D.findComposer(document)?.value) throw new Error('提示词没有进入网页输入框，为避免重复提交已停止');
      pressEnter(input);
      sessionStorage.setItem(sentKey, 'sent');
      const sentAt = Date.now();

      // ② 等网页确认收到
      let confirmed = false;
      let lastPhase = '';
      let lastText = '';
      let stableSince = 0;
      let reasoning = '';
      while (!job.cancelled && Date.now() - started < 590000) {
        await sleep(D.pollDelay(!!D.findStop(document)));
        if (job.cancelled) break;
        if (!D.findComposer(document) && /登录|Log in|Sign in/.test(String(document.body?.innerText || '').slice(-4000))) {
          throw new Error('DeepSeek 登录失效，请重新登录后再发起任务');
        }
        const snap = D.scan(document, baseline);
        if (snap.reasoning && snap.reasoning !== reasoning) reasoning = snap.reasoning;
        const composerNow = D.findComposer(document);
        if (!confirmed && ((composerNow && !String(composerNow.value || '').trim()) || snap.generating)) confirmed = true;
        if (!confirmed && Date.now() - sentAt > 12000) throw new Error('网页未确认收到这条消息，为避免重复提交已停止；请检查专用标签页');

        const phase = D.phaseOf({ text: snap.text, reasoning, generating: snap.generating, sent: confirmed });
        if (phase !== lastPhase) { lastPhase = phase; report('progress', { phase }); }
        if (snap.text !== lastText) { lastText = snap.text; stableSince = Date.now(); }
        if (confirmed && snap.changed && D.stableEnough({ text: snap.text, stableMs: Date.now() - stableSince, hasStop: snap.generating })) {
          const text = snap.text;
          if (!text.trim()) throw new Error('网页停止生成但没有可读的答复内容');
          sessionStorage.removeItem(sentKey);
          banner('Harness 专用会话 · 答复已回传');
          report('result', { text, reasoning, metrics: { chars: text.length, ms: Date.now() - started, rows: snap.rowCount } });
          return;
        }
        banner('Harness 专用会话 · ' + phase);
      }
      if (job.cancelled) { sessionStorage.removeItem(sentKey); return; }
      throw new Error('等待网页答复超时（10 分钟）');
    } finally {
      active = null;
    }
  }

  // taskId 显式传入：出错时若依赖 active?.id，而 active 已经被清掉或还是上一轮的对象，
  // 上报就会带错 id，被后台判为"过期"直接丢掉——外部表现为任务静默消失（实测踩到）。
  const report = (type, payload, taskId = active?.id) => {
    try { chrome.runtime.sendMessage({ type, taskId, ...payload }).catch?.(() => {}); } catch { /* 后台已休眠，下一轮 poll 会同步状态 */ }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 只接受来自本扩展后台的消息
    if (sender?.id && sender.id !== chrome.runtime.id) { sendResponse({ error: '不受信任的发送方' }); return; }
    if (message?.type === 'health') {
      sendResponse({
        ok: true, version: VERSION,
        ready: !!D.findComposer(document),
        generating: !!D.findStop(document),
        hasDraft: !!String(D.findComposer(document)?.value || '').trim(),
        activeId: active?.id ?? null,
        visibility: document.visibilityState,
      });
      return;
    }
    if (message?.type === 'cancel') {
      if (active) { active.cancelled = true; try { D.findStop(document)?.click(); } catch { /* ignore */ } banner('Harness 专用会话 · 已请求停止'); }
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'run') {
      if (active) { sendResponse({ error: '网页已有运行中的桥接任务' }); return; }
      // 页面重载后如果还留着"已发送"标记，说明上一轮悬空了 —— 只报告，绝不重发
      const job = message.job || {};
      const stuck = sessionStorage.getItem('dsh-own-sent-' + job.id);
      if (stuck === 'sent') { sessionStorage.removeItem('dsh-own-sent-' + job.id); sendResponse({ error: '页面在上一轮提交后重载过，为避免重复提问已停止本轮（不会重发）' }); return; }
      run(job).catch((error) => report('error', { error: error?.message || String(error) }, job.id));
      sendResponse({ ok: true });
      return;
    }
  });

  // 让 MV3 的服务工作线程保持醒来（网页侧心跳）
  setInterval(() => { try { chrome.runtime.sendMessage({ type: 'tick' }).catch?.(() => {}); } catch { /* ignore */ } }, 3000);
})();
