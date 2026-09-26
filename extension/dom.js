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
    // 助手消息行：优先语义属性，退化到 DeepSeek 的 markdown 容器
    rows: ['[data-message-role="assistant"]', '[data-role="assistant"]', '.ds-markdown'],
    // 思考过程容器：取答复文本时必须排除，否则"思考"里的 JSON 会污染解析
    think: ['.ds-think-content', '[class*="thinking"]', '[data-role="thinking"]', '[class*="think-content"]'],
    composer: ['textarea'],
    // 停止按钮：生成中才存在，是我们判断"是否还在生成"的唯一可靠信号
    stopText: /^\s*(停止生成|停止|Stop generating|Stop\b)/i,
    sendButton: ['[data-testid="send-button"]', 'button[type="submit"]', 'div[role="button"][aria-label*="发送"]'],
  };

  const all = (doc, selector) => { try { return [...doc.querySelectorAll(selector)]; } catch { return []; } };

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

  /** 取一段文本，排除思考容器与代码块之外的噪音；代码块内容要保留（答复本身可能是 JSON 围栏） */
  function textOf(el, { keepCode = true } = {}) {
    if (!el) return '';
    const clone = cloneWithoutThink(el);
    let text = '';
    try { text = clone.innerText ?? clone.textContent ?? ''; } catch { text = ''; }
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

  globalThis.DSHOwnDom = {
    SELECTORS, isVisible, findComposer, findStop, findSend, rows, textOf, reasoningOf,
    captureBaseline, scan, completeJson, acceptDelay, stableEnough, pollDelay, phaseOf,
  };
})();
