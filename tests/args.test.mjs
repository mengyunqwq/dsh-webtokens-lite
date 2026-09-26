// tests/args.test.mjs —— 参数解析回归测试
//
// 背景（真实事故）：`setup.mjs` 的 value() 只认 `--name value`，不认 `--name=value`，
// 而文档与中转站安装器用的都是等号写法。结果是 `--bridge=own` 被静默忽略、回退成 upstream：
// 用户以为装的是自研实现，实际装出来的是上游扩展（还会去 GitHub 拉上游代码）。
// 静默回退比报错危险得多，所以这里把两种写法与"给了但认不出"都钉住。
//
// 注意：子进程输出**重定向到文件**而不是管道 —— 某些受限环境（沙箱/CI）里管道 stdio
// 会直接 EPERM，用文件就都正常（这个坑实测踩过）。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); } else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); } };

/** 跑 setup.mjs，把输出写进文件（不用管道），返回 { code, out } */
function runSetup(args) {
  const dir = mkdtempSync(join(tmpdir(), 'lite-args-'));
  const outFile = join(dir, 'out.txt');
  const fd = require('node:fs').openSync(outFile, 'w');
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'setup.mjs'), ...args], { cwd: ROOT, stdio: ['ignore', fd, fd], timeout: 60_000 });
    return { code: r.status, out: readFileSync(outFile, 'utf8') };
  } finally { try { require('node:fs').closeSync(fd); } catch { /* ignore */ } }
}

// require 在 ESM 里没有 —— 用 createRequire 拿到 fs 的同步 API
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

console.log('=== 1) 值解析：两种写法都要认 ===');
{
  const text = readFileSync(join(ROOT, 'setup.mjs'), 'utf8');
  check('value() 支持 --name=value 的等号写法', /startsWith\('--' \+ name \+ '='\)/.test(text));
  check('给了 --bridge 却认不出时会报错（不静默回退）', /没有认出 --bridge 的值/.test(text));
  check('mode 解析顺序含环境变量 DSH_WEB_BRIDGE_MODE', /modeArg \|\| process\.env\.DSH_WEB_BRIDGE_MODE/.test(text));
}

console.log('\n=== 2) 非法值要明确失败（而不是继续装）===');
{
  const r = runSetup(['--bridge=bogus', '--doctor']);
  check('--bridge=bogus 退出码非 0', r.code !== 0, 'code=' + r.code);
  check('提示只说 own / upstream', /只能是 own 或 upstream/.test(r.out), r.out.trim().split('\n').slice(-3).join(' ').slice(0, 80));
}

console.log('\n=== 3) --doctor 在 own 模式下如实报告实现（不联网、不拉上游）===');
{
  const r = runSetup(['--doctor', '--bridge=own']);
  check('--doctor 退出码 0', r.code === 0, 'code=' + r.code);
  check('明确写出"自研（own）"', /自研（own）/.test(r.out));
  check('没有去下载上游', !/下载上游/.test(r.out), '（own 模式不该出现"下载上游"）');
}

console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
