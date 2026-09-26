// extension/dom.js — 网页识别的纯逻辑（不依赖 chrome.* API，可脱离浏览器单测）
//
// 为什么单独一个文件：MV3 的 content script 不能用 ES module 导入，所以这里挂到全局；
// 而所有"怎么认页面"的判断都写成纯函数（传入 doc/element 即可），这样能在 Node 里用
// 假 DOM 做判定表测试（tests/extension-logic.test.mjs），不必真的开浏览器。
//
// 关于来源：本文件是**独立编写**的实现，行为逻辑参考了"把网页当模型用"这件事的通行做法
// （输入框、停止按钮、答复容器这些是网页的事实）。本仓库不分发上游任何代码。
//
// 与上游做法的三个刻意差别：
//   ① 结束判定自适应（不再固定等 5 秒）——见 acceptDelay()；
//   ② 只负责"提交提示词 + 取回答复原文"，不做 JSON 解析与工具参数校验（那些在客户端做），
//      所以这里不需要校验器，也不需要格式纠正流程；
//   ③ 认页面用"最后一条助手消息 + 基线对比"两条腿，任一可用即可（网页改版时更耐）。

(() => {
  const SELECTORS = {
    // 助手消息行：优先语义属性，退化到 DeepSeek 的 markdown 容器。
    // 注意顺序：**先具体后宽泛**。最后两个是兜底——实测"全新会话"里前面几个都可能一个都不命中，
    // 于是读到 0 字（现场只能靠 diagnose() 报出来的命中数定位）。
    rows: [
      '[data-message-role="assistant"]',
      '[data-role="assistant"]',
      '.ds-markdown',
      '[class*="markdown"]',
      '[class*="assistant"]',
    ],
    // 思考过程容器：取答复文本时必须排除，否则"思考"里的 JSON 会污染解析
    think: ['.ds-think-content', '[class*="thinking"]', '[data-role="thinking"]', '[class*="think-content"]'],
    composer: ['textarea'],
    // 停止按钮：生成中才存在，是我们判断"是否还在生成"的唯一可靠信号
    stopText: /^\s*(停止生成|停止|Stop generating|Stop\b)/i,
    sendButton: ['[data-testid="send-button"]', 'button[type="submit"]', 'div[role="button"][aria-label*="发送"]'],
  };

  const all = (doc, selector) => deepQueryAll(doc, selector);

  /**
   * 递归查询，**穿过 Shadow DOM**。
   * 为什么需要：`querySelectorAll` 不会进入 shadow root，`textContent` 也不包含 shadow 子树。
   * 若站点把聊天区渲染在 web component 里，表现就是"用户看得见内容，扩展却一个选择器都命中不了、
   * 文本长度为 0"——正是实测遇到的那种现象。深度限制 6 层、每层最多 200 个宿主，避免病态页面拖死。
   * 普通页面（没有 shadowRoot）行为与直接 querySelectorAll 完全一致。
   */
  function deepQueryAll(root, selector, out = [], depth = 0) {
    if (!root || depth > 6) return out;
    try { for (const el of root.querySelectorAll(selector)) out.push(el); } catch { /* ignore */ }
    let hosts = [];
    try { hosts = [...root.querySelectorAll('*')].filter((el) => el.shadowRoot).slice(0, 200); } catch { hosts = []; }
    for (const host of hosts) deepQueryAll(host.shadowRoot, selector, out, depth + 1);
    return out;
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      if (el.disabled) return false;
      const style = el.style || {};
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (el.hidden === true) return false;
      if (el.getClientRects && el.getClientRects().length === 0 && el.offsetParent === null) return false;
      return true;
    } catch { return false; }
  }

  /** 输入框：可见且未禁用的 textarea */
  function findComposer(doc) {
    return all(doc, SELECTORS.composer.join(',')).find((el) => isVisible(el) && !el.readOnly) || null;
  }

  /** 停止按钮：可见的 button/[role=button] 且文本是"停止生成"一类 */
  function findStop(doc) {
    const candidates = all(doc, 'button,[role="button"]');
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = String(el.textContent || el.getAttribute?.('aria-label') || '').trim();
      if (SELECTORS.stopText.test(text)) return el;
    }
    return null;
  }

  /** 发送按钮（Enter 不可用时的兜底） */
  function findSend(doc) {
    for (const sel of SELECTORS.sendButton) {
      const el = all(doc, sel).find(isVisible);
      if (el) return el;
    }
    return null;
  }

  const isThinkNode = (el) => SELECTORS.think.some((sel) => { try { return el.matches?.(sel) || el.closest?.(sel); } catch { return false; } });

  /** 助手消息行（去掉嵌套在思考容器里的那些） */
  function rows(doc) {
    for (const sel of SELECTORS.rows) {
      const found = all(doc, sel).filter((el) => !isThinkNode(el));
      if (found.length) return found;
    }
    return [];
  }

  /** 取一段文本，排除思考容器；代码块内容要保留（答复本身可能是 JSON 围栏） */
  function textOf(el, { keepCode = true } = {}) {
    if (!el) return '';
    const clone = cloneWithoutThink(el);
    let text = '';
    try {
      if (clone === el) {
        // 没克隆成功（拿到的是活节点）→ innerText 才可靠
        text = el.innerText ?? el.textContent ?? '';
      } else {
        // **必须用 textContent**：clone 是脱离文档的节点，Chromium 对脱离文档节点的 innerText
        // 返回**空串**（是空串而不是 undefined，所以 `??` 兜不住）。实测表现：答复文本永远为空、
        // 一直停在"正在确认是否有答复"直到 120 秒超时。textContent 不依赖渲染，脱离文档也能读。
        text = clone.textContent ?? '';
      }
    } catch { text = ''; }
    return keepCode ? String(text) : String(text).replace(/```[\s\S]*?```/g, '');
  }

  /** 复制一份去掉思考子树的元素（真实 DOM 里用 cloneNode；假 DOM 里退化为原元素） */
  function cloneWithoutThink(el) {
    if (typeof el.cloneNode !== 'function') return el;
    let clone;
    try { clone = el.cloneNode(true); } catch { return el; }
    for (const sel of SELECTORS.think) {
      for (const node of [...(clone.querySelectorAll?.(sel) || [])]) node.remove?.();
    }
    return clone;
  }

  /** 思考文本（用于阶段提示，不参与答复解析） */
  function reasoningOf(doc) {
    const parts = [];
    for (const sel of SELECTORS.think) {
      for (const el of all(doc, sel)) { const t = textOf(el); if (t && t.trim()) parts.push(t.trim()); }
      if (parts.length) break;
    }
    return parts.join('\n');
  }

  /** 提交前的基线：记住"当时最后一条助手消息是谁、文本多长" */
  function captureBaseline(doc) {
    const list = rows(doc);
    const lastEl = list[list.length - 1] || null;
    return {
      count: list.length,
      lastText: lastEl ? textOf(lastEl) : '',
      at: Date.now(),
    };
  }

  /**
   * 读当前答复。返回 { text, reasoning, generating, changed }
   * changed：相对基线是否已经出现"新的助手消息"（行数变多，或最后一条文本变了）
   */
  function scan(doc, baseline) {
    const list = rows(doc);
    const lastEl = list[list.length - 1] || null;
    const text = lastEl ? textOf(lastEl) : '';
    const changed = list.length > (baseline?.count ?? 0) || (!!text && text !== (baseline?.lastText ?? ''));
    return {
      text,
      reasoning: reasoningOf(doc),
      generating: !!findStop(doc),
      changed,
      rowCount: list.length,
    };
  }

  /** 文本里是否含一个**完整**的 JSON 对象（括号闭合且能解析；字符串里的括号不参与计数） */
  function completeJson(text) {
    const s = String(text || '');
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
      if (ch === '}') {
        if (depth > 0) {
          depth--;
          if (depth === 0 && start >= 0) {
            try {
              const o = JSON.parse(s.slice(start, i + 1));
              if (o && typeof o === 'object' && !Array.isArray(o)) return true;
            } catch { /* 不是完整 JSON，继续往后找 */ }
            start = -1;
          }
        }
      }
    }
    return false;
  }

  /**
   * 结束判定（本实现的核心改进）。
   * 前提：**停止按钮还在 → 永不接受**（网页确实还在生成）。
   * 停止按钮消失后，按内容形态决定还要稳多久：
   *   · 完整 JSON 对象      → 800ms（结构化输出一旦闭合就不会再变）
   *   · 以 } 或 ``` 收尾    → 1200ms
   *   · 其它（散文/中途）   → 2500ms
   * 对比上游固定 5 秒：中位端到端因此少等约 3~4 秒。
   */
  function acceptDelay(text) {
    const s = String(text || '').trim();
    if (!s) return Infinity;
    if (completeJson(s)) return 800;
    if (s.endsWith('}') || /```\s*$/.test(s)) return 1200;
    return 2500;
  }

  function stableEnough({ text, stableMs, hasStop }) {
    if (hasStop) return false;
    return stableMs >= acceptDelay(text);
  }

  /** 轮询间隔：生成中慢一点（少扫 DOM），生成结束后收紧（少等） */
  const pollDelay = (hasStop) => (hasStop ? 1000 : 300);

  /** 由答复文本与阶段生成一句人话（给用户看的状态行） */
  function phaseOf({ text, reasoning, generating, sent }) {
    if (!sent) return '正在把提示词提交到网页';
    if (generating) return text ? '网页正在生成回复' : (reasoning ? '网页正在思考' : '已提交，等待网页开始输出');
    if (!text) return '网页已停止生成，正在确认是否有答复';
    return '网页已生成完毕，正在回传';
  }

  /** 这个文档是不是登录/注册页（同一个域名，所以光靠 URL 匹配区分不出来） */
  function isSignInPage(doc) {
    try {
      const href = String(doc.location?.href || '');
      if (/sign[_-]?in|login|register/i.test(href)) return true;
      const text = String(doc.body?.textContent || '').slice(0, 3000);
      // 登录页的典型特征：有"登录/注册"文案，但没有聊天容器
      if (/登录|注册|Sign in|Log in/i.test(text) && doc.querySelectorAll('[class*="markdown"]').length === 0) return true;
      return false;
    } catch { return false; }
  }

  /**
   * 现场诊断：读不到答复时，把"页面上到底有什么"压缩成一行带回去。
   * 为什么需要：只有"命中 0 行"这一句时完全无法定位（是选择器不对？页面没渲染？还在加载？
   * 还是——**驱动的根本不是用户在看的那一个标签页**）。URL 与标题必须放最前面：
   * 实测就是靠它才发现扩展在驱动另一个停在登录页的标签页。
   */
  function diagnose(doc) {
    const candidates = ['[data-message-role]', '[data-role]', '.ds-markdown', '[class*="markdown"]', '[class*="message"]', '[class*="assistant"]', 'main', 'article'];
    const counts = candidates.map((sel) => {
      try { return sel + '=' + doc.querySelectorAll(sel).length; } catch { return sel + '=?'; }
    }).join(' ');
    let ready = '?';
    try { ready = doc.readyState || '?'; } catch { /* ignore */ }
    let where = '?';
    try { where = String(doc.location?.href || '?').slice(0, 80) + ' | ' + String(doc.title || '').slice(0, 24); } catch { /* ignore */ }
    // 结构性事实（回答"为什么明明有内容却一个选择器都命中不了"）：
    //   textLen —— body 文本长度。若接近 0 而用户看得见内容 → 内容在 Shadow DOM 里
    //             （textContent 不包含 shadow 子树，querySelectorAll 也穿不透它）
    //   shadowRoots —— 有多少元素挂了 shadowRoot，直接印证上面那条
    //   divs / frames —— 页面规模与 iframe 数（内容可能在 iframe 里，而内容脚本只在顶层）
    //   classes —— 真实类名的前几个（若像 _a1b2c3 这种哈希名，就知道不能按类名写选择器）
    let textLen = '?', shadowRoots = '?', divs = '?', frames = '?', classes = '?';
    try {
      textLen = String((doc.body?.textContent || '').length);
      const all = [...doc.querySelectorAll('*')].slice(0, 4000);
      shadowRoots = String(all.filter((el) => el.shadowRoot).length);
      divs = String(all.filter((el) => String(el.tagName).toLowerCase() === 'div').length);
      frames = String(doc.querySelectorAll('iframe').length);
      const names = new Set();
      for (const el of all) { for (const c of String(el.className || '').split(/\s+/)) { if (c && names.size < 12) names.add(c.slice(0, 24)); } }
      classes = [...names].join(',');
    } catch { /* ignore */ }
    // 穿透 shadow 后的命中数：与上面的 counts 对照，就能区分"选择器不对"与"内容在 Shadow DOM 里"
    let deepHits = '?';
    try { deepHits = String(deepQueryAll(doc, '[class*="markdown"], .ds-markdown, [data-message-role], article').length); } catch { /* ignore */ }
    return `[诊断 url=${where} 登录页=${isSignInPage(doc) ? '是' : '否'} ${counts} 穿透shadow后=${deepHits} readyState=${ready} body文本长度=${textLen} 有shadowRoot的元素=${shadowRoots} div数=${divs} iframe数=${frames} 类名样本=${classes}]`;
  }

  globalThis.DSHOwnDom = {
    SELECTORS, isVisible, findComposer, findStop, findSend, rows, textOf, reasoningOf,
    captureBaseline, scan, completeJson, acceptDelay, stableEnough, pollDelay, phaseOf, diagnose, isSignInPage,
  };
})();
