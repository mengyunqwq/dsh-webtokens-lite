// patches/02-fast-format-recovery.mjs — 把「45 秒才认定格式有问题」改成 8 秒
//
// 上游行为（extension/content.js:76）：只有在
//   `!answer && lastOutput 稳定超过 45000ms && !stopButton()`
// 时才认为"网页输出了内容但没能解析成合法回复"，然后发一条格式纠正。
//
// 问题：这个条件里已经有 `!stopButton()`——**网页明明已经停止生成**，却还要干等 45 秒。
// 失败长尾因此变成 45 秒 + 纠正（最多再 45 秒）≈ 最坏 108 秒。
//
// 补丁：阈值 45000 → 8000。仍然要求停止按钮消失、仍然只纠正一次、失败仍然立刻报错，
// 只是不再凭空等 45 秒。最坏情况从 ~108 秒降到 ~30 秒。
//
// 注意：本客户端已有 FORMAT_GUARD（输出契约写进系统提示词），这类格式跑偏本身就变少了；
// 这条补丁针对的是"偶尔还是跑偏"时**恢复得太慢**的问题。

export default {
  id: 'fast-format-recovery',
  title: '格式问题认定阈值 45s → 8s',
  appliesTo: 'v0.2.15-deepseek',
  why: '条件里已有「停止按钮消失」，说明生成已结束，再等 45 秒纯属浪费；失败长尾 ~108s → ~30s',
  files: {
    'extension/content.js': [
      {
        find: "if (replyIssue || (!answer && lastOutput && Date.now() - outputStableAt > 45000 && !stopButton())) {",
        replace: "if (replyIssue || (!answer && lastOutput && Date.now() - outputStableAt > 8000 && !stopButton())) {   // 补丁：45s → 8s",
        expect: 1,
      },
    ],
  },
};
