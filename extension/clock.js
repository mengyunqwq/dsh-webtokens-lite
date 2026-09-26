// extension/clock.js — MAIN world 注入：任务进行中时给网页的渲染时钟"续火"
//
// 为什么需要：标签页不在前台时，浏览器会节流 requestAnimationFrame / 定时器，
// 网页自己的流式渲染会变慢，于是"看起来网页卡住了"。上游为此也做了时钟补丁。
//
// 本实现刻意保持"最小且无害"：
//   · 只在有桥接任务进行中时生效（由内容脚本写 <html data-dsh-own-active="1"> 协调）；
//   · 只做一件事：任务期间持续用 requestAnimationFrame 维持一次渲染循环，
//     任务结束后立刻停手，普通浏览完全走原生时序；
//   · 不接触任何页面数据、不读凭据、不发网络请求。
//
// 诚实说明：这只能缓解、不能根治后台节流。最稳的做法仍是让浏览器窗口正常打开
// （不要最小化）。若发现后台时答复明显变慢，可以把专用标签页单独拖到一个窗口。

(() => {
  const FLAG = 'dshOwnActive';
  let rafId = 0;
  let ticking = false;
  const nativeRaf = window.requestAnimationFrame.bind(window);

  const isActive = () => {
    try { return document.documentElement?.dataset?.[FLAG] === '1'; } catch { return false; }
  };

  const loop = () => {
    if (!isActive()) { ticking = false; rafId = 0; return; }
    rafId = nativeRaf(loop);
  };

  const start = () => { if (!ticking && isActive()) { ticking = true; rafId = nativeRaf(loop); } };

  // 内容脚本会改这个属性；MutationObserver 让 MAIN world 立刻感知
  try {
    new MutationObserver(start).observe(document.documentElement, { attributes: true, attributeFilter: ['data-dsh-own-active'] });
  } catch { /* ignore */ }
  start();
})();
