// patches/01-adaptive-finish.mjs — 自适应结束判定（替换上游写死的「答案 5 秒不变」）
//
// 上游行为（extension/content.js:69 与 :115）：要求 `answer === last` 且
// `Date.now() - stableSince >= 5000` 且停止按钮消失，才接受这条回复。
// 也就是说**每一轮都要凭空多等 5 秒**（实测中位端到端 9.7 秒里，这 5 秒占了大头）。
//
// 为什么可以更快：接受的前提本来就是 `!stopButton()`——网页已经停止生成。
// 5 秒只是"保险"，而不是判断生成是否结束所必需的。于是按内容形态自适应：
//   · 答案是一个**完整 JSON 对象**（括号闭合且能 JSON.parse）→ 0.8 秒稳定即可
//   · 答案以 } 结尾、或以 ``` 围栏收尾 → 1.2 秒
//   · 其它情况 → 2.5 秒（仍比 5 秒省一半）
// 另外把轮询间隔也自适应：生成还在继续时 1000ms（少扫 DOM），生成结束前后收紧到 300ms。
//
// 安全边界（刻意保留）：**停止按钮只要还在，就永不接受**；超时、格式纠正等上游逻辑一律不动。

export default {
  id: 'adaptive-finish',
  title: '自适应结束判定 + 收紧轮询间隔',
  appliesTo: 'v0.2.15-deepseek',
  why: '每轮固定多等 5 秒；停止按钮已消失说明生成确实结束，5 秒是纯保险',
  files: {
    'extension/content.js': [
      {
        // 轮询间隔：生成结束后收紧（原来固定 1000ms，最多多等 1 秒）
        find: "        await sleep(1000);\n        await sendEvent(job, 'status');",
        replace: "        await sleep(stopButton() ? 1000 : 300);   // 补丁：生成结束后收紧轮询，少等最多 1 秒\n        await sendEvent(job, 'status');",
        expect: 1,
      },
      {
        // 校验分支的接受条件
        find: "if (job.replyValidation === 1 && answer && answer === last && Date.now() - stableSince >= 5000 && !stopButton()) {",
        replace: "if (job.replyValidation === 1 && answer && answer === last && dshStableEnough({ text: answer, stableMs: Date.now() - stableSince, hasStopButton: !!stopButton() })) {",
        expect: 1,
      },
      {
        // 回传分支的接受条件
        find: "          if (Date.now() - stableSince >= 5000 && !stopButton()) {",
        replace: "          if (dshStableEnough({ text: answer, stableMs: Date.now() - stableSince, hasStopButton: !!stopButton() })) {",
        expect: 1,
      },
      {
        // 插入纯函数（就放在消息监听的注册之前，仍在 IIFE 内、处于 run() 的作用域里）
        find: "  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {",
        replace: [
          "  /* ===== 本机补丁：自适应结束判定（见 patches/01-adaptive-finish.mjs） ===== */",
          "  // 判定「这段答案是否已经稳定到可以回传」。纯函数，便于单测（tests/finish-rule.test.mjs）。",
          "  function dshAcceptDelay(text) {",
          "    const s = String(text || '').trim();",
          "    if (!s) return Infinity;",
          "    if (dshCompleteJson(s)) return 800;",
          "    if (s.endsWith('}') || /```\\s*$/.test(s)) return 1200;",
          "    return 2500;",
          "  }",
          "  function dshCompleteJson(text) {",
          "    const s = String(text || '');",
          "    let depth = 0, start = -1, inStr = false, esc = false;",
          "    for (let i = 0; i < s.length; i++) {",
          "      const ch = s[i];",
          "      if (inStr) {",
          "        if (esc) { esc = false; continue; }",
          "        if (ch === '\\\\') { esc = true; continue; }",
          "        if (ch === '\"') inStr = false;",
          "        continue;",
          "      }",
          "      if (ch === '\"') { inStr = true; continue; }",
          "      if (ch === '{') { if (depth === 0) start = i; depth++; continue; }",
          "      if (ch === '}') {",
          "        if (depth > 0) {",
          "          depth--;",
          "          if (depth === 0 && start >= 0) {",
          "            try {",
          "              const o = JSON.parse(s.slice(start, i + 1));",
          "              if (o && typeof o === 'object' && !Array.isArray(o)) return true;",
          "            } catch { /* 不是完整 JSON，继续往后找 */ }",
          "            start = -1;",
          "          }",
          "        }",
          "      }",
          "    }",
          "    return false;",
          "  }",
          "  function dshStableEnough({ text, stableMs, hasStopButton }) {",
          "    if (hasStopButton) return false;                       // 还在生成 → 永不接受",
          "    return stableMs >= dshAcceptDelay(text);",
          "  }",
          "",
          "  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {",
        ].join('\n'),
        expect: 1,
      },
    ],
  },
};
