// 自研 broker 测试：用「假扩展 + 假客户端」跑完整生命周期（无需浏览器）
import { request as httpRequest } from 'node:http';
import { createBroker } from '../lib/broker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); } else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); } };
// 硬看门狗：脚本自身绝不能挂住（上次就是卡在 broker.close() 上，导致命令一直不返回）
const watchdog = setTimeout(() => { console.log('\n⏱ 测试自身超时（60s）——说明还有地方会挂住'); process.exit(3); }, 60_000);

const TOKEN = 'tk_test_' + Math.random().toString(16).slice(2);
// 注意：确认窗口（ackTimeoutMs / handoffTimeoutMs）显式放大，让"停滞看门狗"先触发——
// 否则 1.5 秒的确认窗口会先把任务重新派发，第 6 节就测不到想测的东西（实测踩到）。
const broker = createBroker({ token: TOKEN, port: 0, timeoutMs: 3000, stallMs: 1200, ackTimeoutMs: 20_000, handoffTimeoutMs: 20_000, log: () => {} });
await broker.start();
const BASE = `http://127.0.0.1:${broker.port}`;
console.log(`  broker 起在 ${BASE}`);
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN };
const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}) });

/** 读 NDJSON 流，把每条解析出来交给回调；返回一个 promise，收到 result 行后 resolve */
function readNdjson(res) {
  const events = [];
  let done = null;
  const finished = new Promise((resolve) => { done = resolve; });
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        events.push(ev);
        if (ev.type === 'result') done(ev);
      }
    }
    done(events.find((e) => e.type === 'result') || null);
  })().catch(() => done(null));
  return { events, finished };
}

async function poll(body) { return (await post('/ext/poll', body)).json(); }

console.log('\n=== 1) 鉴权与 Host 校验 ===');
{
  const s = await (await fetch(BASE + '/status')).json();
  check('/status 不需要密钥即可读', s.ok === true && s.connected === false, JSON.stringify(s.worker));
  const bad = await fetch(BASE + '/task', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{"prompt":"x"}' });
  check('密钥不对 → 401', bad.status === 401);
  const viaWrongHost = await new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: broker.port, path: '/status', method: 'GET', headers: { Host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0)); req.end();
  });
  check('Host 不是本机端口 → 403（挡 DNS rebinding）', viaWrongHost === 403, 'HTTP ' + viaWrongHost);
}

console.log('\n=== 2) 完整生命周期：扩展长轮询领活 → 客户端拿进度与结果 ===');
{
  const pollP = poll({ clientId: 'ext-1', version: '1.0.0', state: '已连接' });      // 扩展开始长轮询
  await sleep(80);
  const s1 = (await (await fetch(BASE + '/status')).json());
  check('扩展 poll 后 /status 显示已连接', s1.connected === true, JSON.stringify(s1.worker));

  const taskRes = await post('/task', { prompt: '把这句话交给网页', timeoutMs: 3000 });
  check('客户端 /task 返回 200 且是 NDJSON', taskRes.status === 200 && String(taskRes.headers.get('content-type')).includes('ndjson'));
  const { events, finished } = readNdjson(taskRes);

  const job = await pollP;
  check('扩展领到了任务', !!job.task && job.task.prompt === '把这句话交给网页' && typeof job.task.lease === 'string', JSON.stringify(job.task && { id: job.task.id, lease: job.task.lease?.slice(0, 6) + '…' }));
  const taskId = job.task.id, lease = job.task.lease;

  const p1 = await (await post('/ext/progress', { taskId, lease, phase: '正在提交到网页' })).json();
  check('扩展上报进度被接受', p1.ok === true);
  await post('/ext/progress', { taskId, lease, phase: '网页正在生成' });
  const res1 = await (await post('/ext/result', { taskId, lease, ok: true, text: '{"kind":"final","text":"网页的回答"}' })).json();
  check('扩展回报结果被接受', res1.ok === true);

  const final = await finished;
  check('客户端收到 result', !!final && final.ok === true && final.text.includes('网页的回答'));
  check('客户端收到两条进度', events.filter((e) => e.type === 'progress').map((e) => e.phase).join('|') === '正在提交到网页|网页正在生成');
  check('result 带上了阶段与耗时分解', Array.isArray(final.phases) && final.queuedMs !== null && final.executedMs !== null, `queued=${final.queuedMs} exec=${final.executedMs}`);
}

console.log('\n=== 3) 租约不匹配的回报被丢弃（旧实例写不进新任务）===');
{
  const pollP = poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  await sleep(50);
  const taskRes = await post('/task', { prompt: 'P2', timeoutMs: 3000 });
  const { finished } = readNdjson(taskRes);
  const job = (await pollP).task;
  const stale = await (await post('/ext/result', { taskId: job.id, lease: 'wrong-lease', ok: true, text: '伪造结果' })).json();
  check('lease 不对 → 拒绝', stale.ok === false && stale.stale === true, JSON.stringify(stale));
  const okRes = await (await post('/ext/result', { taskId: job.id, lease: job.lease, ok: true, text: '真结果' })).json();
  check('lease 正确 → 接受', okRes.ok === true);
  const final = await finished;
  check('客户端拿到的是真结果', final.text === '真结果');
}

console.log('\n=== 4) 单 worker 串行：第二个任务要等第一个跑完才派发 ===');
{
  const pollP1 = poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  await sleep(50);
  const t1 = await post('/task', { prompt: 'A', timeoutMs: 4000 });
  const r1 = readNdjson(t1);
  const jobA = (await pollP1).task;
  // 第一个还在跑：再起一个 poll 与一个任务
  const pollP2 = poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  const t2 = await post('/task', { prompt: 'B', timeoutMs: 4000 });
  const r2 = readNdjson(t2);
  await sleep(150);
  const snap = broker.snapshot();
  check('同时只派发一个（另一个在排队）', snap.active === jobA.id && snap.queued.length === 1, JSON.stringify({ active: snap.active === jobA.id, queued: snap.queued.length }));
  await post('/ext/result', { taskId: jobA.id, lease: jobA.lease, ok: true, text: 'A 完成' });
  await r1.finished;
  const jobB = (await pollP2).task;
  check('第一个完成后才派发第二个', !!jobB && jobB.prompt === 'B');
  await post('/ext/result', { taskId: jobB.id, lease: jobB.lease, ok: true, text: 'B 完成' });
  const fb = await r2.finished;
  check('第二个也正常完成', fb.text === 'B 完成');
}

console.log('\n=== 5) 客户端断开 → 任务取消，并且扩展会被告知停下 ===');
{
  const pollP = poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  await sleep(50);
  const ac = new AbortController();
  const taskRes = await fetch(BASE + '/task', { method: 'POST', headers: H, body: JSON.stringify({ prompt: '会被取消', timeoutMs: 5000 }), signal: ac.signal });
  const job = (await pollP).task;
  ac.abort();                                  // 模拟客户端刷新/断网
  await sleep(200);
  const p = await (await post('/ext/progress', { taskId: job.id, lease: job.lease, phase: '还在跑' })).json();
  check('取消后扩展上报进度 → 得到 cancelled', p.cancelled === true, JSON.stringify(p));
  const again = await poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  check('取消后扩展再 poll → 被告知停止哪条任务', !!(again.cancelledTaskId || !again.task), JSON.stringify(again).slice(0, 90));
}

console.log('\n=== 6) 停滞看门狗：派发后毫无进展 → 主动失败 ===');
{
  const pollP = poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  await sleep(50);
  const taskRes = await post('/task', { prompt: '会停滞', timeoutMs: 8000 });
  const r = readNdjson(taskRes);
  const job = (await pollP).task;
  const final = await Promise.race([r.finished, sleep(4000).then(() => null)]);
  check('停滞时客户端拿到失败结果', !!final && final.ok === false && /停滞/.test(final.error), final ? final.error.slice(0, 60) : '（超时未返回）');
  check('失败码是 WEB_STALL', final?.code === 'WEB_STALL');
}

console.log('\n=== 7) 没人来取任务 → 总超时后按"未被取走"报错 ===');
{
  const taskRes = await post('/task', { prompt: '没人取', timeoutMs: 300 });
  const r = readNdjson(taskRes);
  const final = await Promise.race([r.finished, sleep(3000).then(() => null)]);
  check('超时失败且指出是没人取走', !!final && final.ok === false && /没有取走/.test(final.error), final ? final.error.slice(0, 70) : '（超时未返回）');
}

await broker.close();
clearTimeout(watchdog);
console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
