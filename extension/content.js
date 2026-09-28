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
  // 版本号单一来源是 manifest.json（content script 同样能 getManifest），不再手抄。
  // 兜底值：万一读取失败也能报出版本，便于排查看的是哪一版加载的。
  let VERSION = '1.1.3';
  try { VERSION = chrome.runtime.getManifest().version; } catch { /* 兜底值 */ }
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

  // 提交/读输入框统一走 dom.js 的实现（textarea 与 contenteditable 两种形态都要支持）。
  // 以前这里自己写了一份只认 HTMLTextAreaElement 的 setter，而新版网页的输入框是
  // contenteditable 富文本容器——.value 赋值无效、提交前校验也永远读不到内容，
  // 表现为「提示词没有进入网页输入框」直接判死。dom.js 的 setComposerText/composerText
  // 对两种形态都处理过，这里不再养第二份实现。
  const writeComposer = (input, text) => { D.setComposerText(document, input, text); return D.composerText(input); };
  const composerValue = (el) => D.composerText(el);

  const pressEnter = (input) => {
    for (const type of ['keydown', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  };

  // N1：clock.js（MAIN world）靠 <html data-dsh-own-active="1"> 判断"任务进行中"，
  // 只有为真时才维持渲染时钟。全仓库此前**没有任何地方写这个属性** → 那个补丁是死代码，
  // 后台标签页节流完全没被缓解（表现：标签页不在前台时答复变慢/卡住且无报错）。
  // 这里在任务开始/结束时同步该属性（dataset.dshOwnActive ⇔ data-dsh-own-active）。
  const setRenderClockHint = (on) => {
    try {
      if (on) document.documentElement.dataset.dshOwnActive = '1';
      else delete document.documentElement.dataset.dshOwnActive;
    } catch { /* 页面结构不允许也不影响搬运 */ }
  };

  async function run(job) {
    if (active) throw new Error('网页上已有桥接任务在跑');
    // ⚠ active 必须直接引用 job 本体（而不是再包一层新对象）：取消监听器改的是
    // active.cancelled，而 run 的循环全在检查 job.cancelled——两个对象各改各的话，
    // 取消通知永远到不了循环，截断的半截答复会被当成完整结果回传（触发宿主重试 →
    // 用户账号里出现两条一样的提问，正是这套机制要拦的第一号事故）。
    // 共用同一引用后，取消只需要改一处，循环下一拍立刻看见。
    active = job;
    job.cancelled = false;
    setRenderClockHint(true);   // N1：任务期间让 MAIN world 的 clock.js 维持渲染时钟
    const sentKey = 'dsh-own-sent-' + job.id;
    const started = Date.now();
    // 第一件事就留个痕迹：否则"任务被派发了但页面侧什么都没做"这种情况，
    // 外部看起来和"跑了但没回报"完全一样，无法定位（实测踩到：120 秒静默超时）。
    report('progress', { phase: '内容脚本已接手，正在准备提交' }, job.id);
    try {
      if (!D.findComposer(document)) throw new Error('找不到网页输入框：请确认已登录 chat.deepseek.com 且页面加载完成');
      if (D.findStop(document)) throw new Error('网页正在生成别的回答，请等它结束再试');
      const draft = D.findComposer(document);
      // 用 composerText（按形态读 value 或 textContent），不再只认 textarea 的 .value
      if (draft && composerValue(draft).trim()) throw new Error('网页输入框里已有内容，为避免覆盖已停止本轮');

      const baseline = D.captureBaseline(document, job.requestId);
      let input = D.findComposer(document);
      if (!input) throw new Error('找不到网页输入框');
      // ① 落标记：之后任何重载都只报错、不重发
      sessionStorage.setItem(sentKey, 'sending');
      banner('Harness 专用会话 · 正在提交');
      input.focus();
      // 写入并立刻验证（返回值为 DOM 形态无关的输入框文本）：
      // 写 csv/contenteditable 或 textarea 都走 dom.js 同一套逻辑
      const written = writeComposer(input, job.prompt);
      await sleep(150);
      if (job.cancelled) { sessionStorage.removeItem(sentKey); return; }
      // 提交前验证也要按形态读（contenteditable 没有 .value）：
      if (!written.trim() || !composerValue(D.findComposer(document) || input).trim()) {
        throw new Error('提示词没有进入网页输入框，为避免重复提交已停止');
      }
      pressEnter(input);
      sessionStorage.setItem(sentKey, 'sent');
      const sentAt = Date.now();

      // ② 等网页确认收到
      let confirmed = false;
      let lastPhase = '';
      let lastText = '';
      let stableSince = 0;
      let reasoning = '';
      let stoppedEmptySince = 0;   // 停止生成却读不到文本的起始时刻（用于快速失败）
      while (!job.cancelled && Date.now() - started < 590000) {
        await sleep(D.pollDelay(!!D.findStop(document)));
        if (job.cancelled) break;
        if (!D.findComposer(document) && /登录|Log in|Sign in/.test(String(document.body?.innerText || '').slice(-4000))) {
          throw new Error('DeepSeek 登录失效，请重新登录后再发起任务');
        }
        const snap = D.scan(document, baseline);
        if (snap.reasoning && snap.reasoning !== reasoning) reasoning = snap.reasoning;
        const composerNow = D.findComposer(document);
        // "输入框被清空 = 网页确认收到"：textarea 读 .value，contenteditable 读 textContent
        if (!confirmed && ((composerNow && !D.composerText(composerNow).trim()) || snap.generating)) confirmed = true;
        if (!confirmed && Date.now() - sentAt > 12000) throw new Error('网页未确认收到这条消息，为避免重复提交已停止；请检查专用标签页');

        const phase = D.phaseOf({ text: snap.text, reasoning, generating: snap.generating, sent: confirmed });
        // 停止生成却读不到文本时，把"我到底看到了什么"一起报出来：否则外部只能看到"卡住了"，
        // 无法区分是选择器没命中、页面没渲染完、还是文本在别的容器里（实测就这样白等了 120 秒）。
        const diag = (confirmed && !snap.generating && !snap.text)
          ? `（命中 ${snap.rowCount} 行，读到 ${String(snap.text || '').length} 字）${D.diagnose(document)}`
          : '';
        const phaseLine = phase + diag;
        if (phaseLine !== lastPhase) { lastPhase = phaseLine; report('progress', { phase: phaseLine }); }
        // 不再无限等，但也不能催太急：**实测长提示词网页要 ~20 秒才渲染出答复**
        // （有一次 20.1 秒才读到），25 秒的窗口正好踩在边界上，会把"慢答复"误判成"读不到"。
        // 上限仍然要有：真遇到结构变化时，不该静默等到客户端的 240 秒预算。
        if (confirmed && !snap.generating && !snap.text) {
          if (!stoppedEmptySince) stoppedEmptySince = Date.now();
          else if (Date.now() - stoppedEmptySince > 60_000) {
            // 用**不可重试**的错误码：提示词已经发出去了（confirmed=true），让调用方自动重试
            // 就会在用户账号里留下第二条一样的提问。宁可把它交给用户/宿主去判断。
            throw Object.assign(
              new Error(`提交后 ${Math.round((Date.now() - stoppedEmptySince) / 1000)} 秒仍读不到答复文本（命中 ${snap.rowCount} 行）——页面可能一直在渲染，或页面结构变了`),
              { code: 'WEB_NO_REPLY_AFTER_SEND' },
            );
          }
        } else stoppedEmptySince = 0;
        if (snap.text !== lastText) { lastText = snap.text; stableSince = Date.now(); }
        // 只有"确实看到了本轮答复"才走进接受判定：
        //   rows → 行选择器命中；page-tail → 整页尾部文本里出现了本轮 request_id。
        // 少了 answerSeen 这道门，提示词自己（含 JSON 示例）会被当成答复，还可能引发重复提交。
        //
        // 再加一道 looksLikeAnswer：正文里必须出现本轮 request_id 或契约字段 "kind"。
        // 真机踩到：网页会先渲染**思考过程/半截回答**，只按"文本稳定 2.5 秒"就认账会把半截文本
        // 回传，客户端解析不到 JSON → 报「网页答复里没有可解析的 JSON 对象」并重试一次
        // （用户看到的就是那条报错）。宁可多等一会儿，也不要回传半截内容。
        const looksLike = D.looksLikeAnswer(snap.text, job.requestId);
        // N3：page-tail 兜底路径还要更严——必须真的出现**本轮契约对象**（可解析、request_id 为本轮、
        // kind 合法），而不是"文本里出现过本轮编号"。因为用户刚提交的提示词最后一行就写着
        // `request_id 必须是 "req-xxx"`，只按编号认账会把提示词本身当成答复回传（进而触发重试）。
        const contractOk = snap.source !== 'page-tail' || D.hasContractAnswer(snap.text, job.requestId);
        if (confirmed && snap.answerSeen && looksLike && contractOk && snap.changed && D.stableEnough({ text: snap.text, stableMs: Date.now() - stableSince, hasStop: snap.generating })) {
          const text = snap.text;
          if (!text.trim()) throw new Error('网页停止生成但没有可读的答复内容');
          sessionStorage.removeItem(sentKey);
          banner('Harness 专用会话 · 答复已回传');
          report('result', { text, reasoning, metrics: { chars: text.length, ms: Date.now() - started, rows: snap.rowCount, source: snap.source } });
          return;
        }
        banner('Harness 专用会话 · ' + phase);
      }
      if (job.cancelled) { sessionStorage.removeItem(sentKey); return; }
      throw new Error('等待网页答复超时（10 分钟）');
    } finally {
      setRenderClockHint(false);   // N1：任务结束立刻停手，普通浏览走原生时序
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
        // 按形态读草稿：textarea 读 .value，contenteditable 读 textContent（.value 恒为 undefined）
        hasDraft: !!composerValue(D.findComposer(document)).trim(),
        activeId: active?.id ?? null,
        visibility: document.visibilityState,
        // 让后台能区分"这个标签页停在登录页"——同域名，光靠 URL 匹配区分不出来
        isSignIn: D.isSignInPage(document),
        href: String(location.href || '').slice(0, 120),
      });
      return;
    }
    if (message?.type === 'cancel') {
      // active 现在就是 job 本体（run() 里共享同一引用），改这一处循环立刻能看见
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
