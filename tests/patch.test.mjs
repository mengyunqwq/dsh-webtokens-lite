// 补丁机制测试：锚点精确性、应用、幂等、回滚（字节级）、版本守卫、锚点失效保护
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyPatches, revertPatches, verifyPatched, readManifest, loadPatches, manifestPath } from '../lib/patches.mjs';
import { VENDOR_DIR } from '../lib/config.mjs';

const TAG = 'v0.2.15-deepseek';
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); } else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); } };

console.log('=== 1) 补丁定义 ===');
const patches = await loadPatches();
check('载入了补丁', patches.length >= 2, patches.map((p) => p.id).join(', '));
check('每个补丁都声明了适用版本与理由', patches.every((p) => p.appliesTo && p.why));

console.log('\n=== 2) 对真实上游副本的锚点检查（不写文件）===');
{
  const r = await applyPatches({ vendorDir: VENDOR_DIR, tag: TAG, dryRun: true });
  check('锚点全部精确匹配（零问题）', r.problems.length === 0, r.problems.join(' | '));
  const edits = r.applied.reduce((n, a) => n + a.edits, 0);
  check('会改动 5 处（自适应结束判定 4 处 + 格式阈值 1 处）', edits === 5, '实际 ' + edits);
}

console.log('\n=== 3) 在临时副本上应用 → 校验 → 幂等 → 回滚 ===');
const tmp = mkdtempSync(join(tmpdir(), 'patch-test-'));
const rel = 'extension/content.js';
mkdirSync(join(tmp, 'extension'), { recursive: true });
copyFileSync(join(VENDOR_DIR, rel), join(tmp, rel));
const originalHash = sha(join(tmp, rel));

{
  const r = await applyPatches({ vendorDir: tmp, tag: TAG });
  check('应用成功且无问题', r.problems.length === 0 && r.applied.length === 2, JSON.stringify(r.applied.map((a) => a.id)));
  const text = readFileSync(join(tmp, rel), 'utf8');
  check('文件里出现了自适应判定函数', text.includes('function dshStableEnough(') && text.includes('function dshAcceptDelay('));
  check('两处 5 秒阈值都被替换', !text.includes('stableSince >= 5000') && (text.match(/dshStableEnough\(\{ text: answer/g) || []).length === 2);
  check('45 秒阈值变成 8 秒', text.includes('outputStableAt > 8000') && !text.includes('outputStableAt > 45000'));
  check('轮询间隔改为自适应', text.includes('await sleep(stopButton() ? 1000 : 300)'));
  check('停止按钮仍在时永不接受（安全边界保留）', text.includes('if (hasStopButton) return false;'));
  const m = readManifest(tmp);
  check('写下了补丁记录 PATCHES.json', !!m && m.patches.length === 2 && m.upstreamTag === TAG, JSON.stringify(m?.patches?.map((p) => p.id)));
  const v = verifyPatched(tmp);
  check('补丁后哈希校验通过', v.ok === true && v.checked === 2, 'checked=' + v.checked);   // 两个补丁都改同一个文件 → 记录 2 条
}

{
  const before = sha(join(tmp, rel));
  const r = await applyPatches({ vendorDir: tmp, tag: TAG });
  check('重复应用是幂等的（跳过、不改文件）', r.applied.length === 0 && r.skipped.length === 2, JSON.stringify(r.skipped));
  check('幂等应用后文件哈希未变', sha(join(tmp, rel)) === before);
}

{
  await revertPatches({ vendorDir: tmp });
  check('回滚后与原始文件**逐字节一致**', sha(join(tmp, rel)) === originalHash, 'sha ' + originalHash.slice(0, 12));
}

console.log('\n=== 4) 版本守卫与锚点失效保护 ===');
{
  const r = await applyPatches({ vendorDir: tmp, tag: 'v9.9.9-not-this-one', dryRun: true });
  check('版本不符时跳过（不误打）', r.applied.length === 0 && r.skipped.every((s) => /面向/.test(s.reason)), JSON.stringify(r.skipped[0]));
}
{
  // 破坏锚点：把上游那行改掉一个字符，模拟"上游改版"
  const text = readFileSync(join(tmp, rel), 'utf8').replace('job.replyValidation === 1', 'job.replyValidation === 2');
  writeFileSync(join(tmp, rel), text, 'utf8');
  const before = sha(join(tmp, rel));
  const r = await applyPatches({ vendorDir: tmp, tag: TAG, only: ['adaptive-finish'] });
  check('锚点找不到时报错而不是乱改', r.problems.length > 0 && r.applied.length === 0, String(r.problems[0]).slice(0, 80));
  check('报错时文件未被改动', sha(join(tmp, rel)) === before);
  check('问题描述里点明了上游版本可能变了', String(r.problems[0]).includes('上游版本可能变了'));
}

console.log('\n=== 5) 没有补丁记录时的状态（供 doctor 用）===');
{
  const fresh = mkdtempSync(join(tmpdir(), 'patch-fresh-'));
  mkdirSync(join(fresh, 'extension'), { recursive: true });
  copyFileSync(join(VENDOR_DIR, rel), join(fresh, rel));
  check('未打补丁 → ok=null（doctor 走"上游原版可信"分支）', verifyPatched(fresh).ok === null);
  check('没有 PATCHES.json', !existsSync(manifestPath(fresh)));
  rmSync(fresh, { recursive: true, force: true });
}

rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
