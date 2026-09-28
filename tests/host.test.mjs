// tests/host.test.mjs —— 覆盖本轮修复的两条连接器/宿主行为（不需要浏览器、不需要中转站）
//   A-1  端口被占用时 own 分支也要给人话（而不是裸 EADDRINUSE 栈）
//   A-12 执行期间要发 /agent/runner/heartbeat（否则长回答期间设备被判离线）
import { createServer } from 'node:http';
import { startBroker } from '../lib/host.mjs';
import { heartbeat } from '../lib/agent.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); } else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); } };
const token = (c) => 'tk_' + c.repeat(43).slice(0, 43);

console.log('=== 1) A-12：执行期心跳打到正确端点、带认证与身份信息 ===');
{
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, token: req.headers['x-agent-token'], body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  await heartbeat(base, 'tk_heartbeat', '我的电脑 · 网页桥接');
  await sleep(50);
  server.close();

  check('打到 /agent/runner/heartbeat（不是 /poll，避免把队列里的任务拿走）', seen.length === 1 && seen[0].url === '/agent/runner/heartbeat', JSON.stringify(seen.map((s) => s.url)));
  check('是 POST 且带 x-agent-token', seen[0]?.method === 'POST' && seen[0]?.token === 'tk_heartbeat');
  check('心跳体带 platform 与 version（服务器据此刷新设备信息）', /"platform"/.test(seen[0]?.body || '') && /"version"/.test(seen[0]?.body || ''));
  // 尽力而为：服务器不可达时不能抛错（否则会把整个任务循环带崩）
  let threw = false;
  try { await heartbeat('http://127.0.0.1:1', 'x', 'y'); } catch { threw = true; }
  check('心跳失败绝不上抛（尽力而为）', threw === false);
}

console.log('\n=== 2) A-1：端口被占用时报人话，而不是裸 EADDRINUSE ===');
{
  const first = await startBroker({ token: token('a'), port: 0, log: () => {} });
  const port = first.port;
  let message = '';
  try {
    await startBroker({ token: token('b'), port, log: () => {} });
  } catch (error) {
    message = String(error?.message || error);
  }
  await first.close();

  check('提示里点明端口与"已被占用"', /端口 \d+ 已被占用/.test(message), message.split('\n')[0]);
  check('不再把裸 listen EADDRINUSE 抛给用户', !/^\s*listen EADDRINUSE/.test(message), message.slice(0, 40));
  check('提示里给了排查占用者的办法', /Get-NetTCPConnection|lsof/.test(message));
}

console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
