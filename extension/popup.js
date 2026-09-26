// extension/popup.js — 状态面板：让用户一眼看出"卡在哪一环"
const $ = (id) => document.getElementById(id);

async function load() {
  const { state, active, lastError } = await chrome.storage.local.get(['state', 'active', 'lastError']);
  $('state').textContent = state || '（还没有状态：本机桥接可能没启动）';

  let token = '';
  try { token = (await (await fetch(chrome.runtime.getURL('local-config.json'))).json()).token || ''; } catch { /* ignore */ }
  $('broker').textContent = token ? '密钥已就绪' : '缺少 local-config.json（重跑 npm run setup）';
  try {
    const res = await fetch('http://127.0.0.1:3081/status', { signal: AbortSignal.timeout(2500) });
    const s = await res.json();
    $('broker').textContent = (s.connected ? '已连接' : '未连接') + '（排队 ' + (s.queued ?? 0) + '）';
  } catch { $('broker').textContent = '连不上 127.0.0.1:3081'; }

  const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  $('tab').textContent = tabs.length ? ('已打开 ' + tabs.length + ' 个') : '未打开';
  $('task').textContent = active ? (active.id + (active.dispatched ? '（已派发）' : '')) : '空闲';
  $('error').textContent = lastError ? new Date(lastError.at).toLocaleTimeString() + ' ' + lastError.error : '—';
}

$('open').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  if (tabs.length) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url: 'https://chat.deepseek.com/' });
  window.close();
});

load();
setInterval(load, 1500);
