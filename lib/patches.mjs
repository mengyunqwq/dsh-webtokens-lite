// lib/patches.mjs — 在「已校验的上游原版」之上应用本机补丁
//
// 设计要点（都是为了不把事情搞糟）：
//   ① **先校验原版、再打补丁**：补丁只在 `verifyVendor()` 通过之后应用，保证我们改的是那一版；
//   ② **锚点必须唯一**：每条替换都声明 expect，出现次数不符就整条失败并给出人话
//      （上游改版时你会看到"锚点找不到"，而不是悄悄改错地方）；
//   ③ **幂等**：找不到 find、但能找到 replace 时视为"已打过"，跳过；重复运行无害；
//   ④ **记录补丁后哈希**：写入 vendor/PATCHES.json，doctor 据此判断"原版+补丁"是否仍然一致；
//   ⑤ **可回滚**：revertPatches() 反向替换，不需要重下上游。
//
// 为什么用「JS 规格 + 精确替换」而不是 .patch 文件：.patch 需要 git 才能应用，
// 而用户机器上不一定有 git；精确替换只依赖 Node，且能做到"锚点唯一"的强校验。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PATCH_DIR = join(ROOT, 'patches');
export const MANIFEST_NAME = 'PATCHES.json';

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 载入 patches/*.mjs（按文件名排序，序号即应用顺序） */
export async function loadPatches() {
  if (!existsSync(PATCH_DIR)) return [];
  const files = readdirSync(PATCH_DIR).filter((f) => f.endsWith('.mjs')).sort();
  const out = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(PATCH_DIR, f)).href);
    if (mod.default) out.push({ ...mod.default, source: f });
  }
  return out;
}

export const manifestPath = (vendorDir) => join(vendorDir, MANIFEST_NAME);

/** 读取「已应用补丁」的记录（没有则 null） */
export function readManifest(vendorDir) {
  const p = manifestPath(vendorDir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { broken: true }; }
}

/**
 * 校验「上游原版 + 补丁」是否仍然是我们打过的那份。
 * @returns {{ok:boolean|null, reason?:string, checked?:number, mismatched?:string[], patches?:number}}
 */
export function verifyPatched(vendorDir) {
  const m = readManifest(vendorDir);
  if (!m) return { ok: null, reason: '没有补丁记录（尚未打过补丁）' };
  if (m.broken) return { ok: false, reason: `${MANIFEST_NAME} 不是合法 JSON` };
  const mismatched = [];
  let checked = 0;
  for (const p of m.patches || []) {
    for (const f of p.files || []) {
      const full = join(vendorDir, f.path);
      checked++;
      if (!existsSync(full)) { mismatched.push(f.path + '（缺失）'); continue; }
      if (sha256(full) !== f.sha256) mismatched.push(f.path + '（哈希不一致）');
    }
  }
  return {
    ok: mismatched.length === 0,
    checked,
    patches: (m.patches || []).length,
    tag: m.upstreamTag,
    mismatched,
    reason: mismatched.length ? `补丁后文件与记录不符：${mismatched.join('、')}` : undefined,
  };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at < 0) break;
    n++; i = at + needle.length;
  }
  return n;
}

/**
 * 应用补丁。幂等、可 dryRun（只检查锚点，不写文件）。
 * @param {{vendorDir:string, tag?:string, log?:Function, dryRun?:boolean, only?:string[]}} options
 */
export async function applyPatches({ vendorDir, tag = '', log = () => {}, dryRun = false, only = null } = {}) {
  const patches = (await loadPatches()).filter((p) => !only || only.includes(p.id));
  const applied = [];
  const skipped = [];
  const problems = [];
  const touched = new Map();   // 相对路径 -> 内容

  for (const patch of patches) {
    if (patch.appliesTo && tag && patch.appliesTo !== tag) {
      skipped.push({ id: patch.id, reason: `补丁面向 ${patch.appliesTo}，当前是 ${tag}` });
      continue;
    }
    const edits = [];
    let failed = false;
    for (const [rel, list] of Object.entries(patch.files || {})) {
      const full = join(vendorDir, rel);
      if (!existsSync(full)) { problems.push(`${patch.id}: 找不到文件 ${rel}`); failed = true; break; }
      let text = touched.has(rel) ? touched.get(rel) : readFileSync(full, 'utf8');
      for (const edit of list) {
        const expect = edit.expect ?? 1;
        const found = countOccurrences(text, edit.find);
        const already = countOccurrences(text, edit.replace);
        // 幂等判据用**替换结果**而不是锚点：插入型补丁的锚点行在插入之后依然存在
        // （实测踩到：第二次应用会再插一遍辅助函数，导致重复定义）。
        if (already === 1) { edits.push({ rel, action: 'already' }); continue; }
        if (already > 1) {
          problems.push(`${patch.id}: ${rel} 的补丁结果出现了 ${already} 次（疑似重复应用，或上游已含相同代码）——为避免叠加已跳过`);
          failed = true;
          break;
        }
        if (found === expect) {
          if (!dryRun) text = text.split(edit.find).join(edit.replace);
          edits.push({ rel, action: 'apply' });
          continue;
        }
        problems.push(`${patch.id}: ${rel} 的锚点出现 ${found} 次（期望 ${expect}）——上游版本可能变了，补丁未应用`);
        failed = true;
        break;
      }
      if (failed) break;
      if (!dryRun) touched.set(rel, text);
    }
    if (failed) continue;
    const realEdits = edits.filter((e) => e.action === 'apply');
    if (!realEdits.length) skipped.push({ id: patch.id, reason: '已应用过' });
    else applied.push({ id: patch.id, title: patch.title, edits: realEdits.length });
  }

  if (dryRun) return { dryRun: true, applied, skipped, problems, wouldTouch: [...touched.keys()] };

  // 写回文件
  for (const [rel, text] of touched) writeFileSync(join(vendorDir, rel), text, 'utf8');

  // 记录补丁后哈希（每次重算，保证记录与磁盘一致）
  if (applied.length) {
    const prev = readManifest(vendorDir);
    const byId = new Map((prev?.patches || []).map((p) => [p.id, p]));
    for (const a of applied) {
      const patch = patches.find((p) => p.id === a.id);
      byId.set(a.id, {
        id: a.id, title: patch.title, why: patch.why,
        files: Object.keys(patch.files || {}).map((rel) => ({ path: rel, sha256: sha256(join(vendorDir, rel)) })),
      });
    }
    writeFileSync(manifestPath(vendorDir), JSON.stringify({
      upstreamTag: tag || null,
      appliedAt: new Date().toISOString(),
      patches: [...byId.values()],
    }, null, 2) + '\n', 'utf8');
  }

  return { applied, skipped, problems, patched: verifyPatched(vendorDir) };
}

/** 反向替换：把补丁撤掉（不需要重下上游） */
export async function revertPatches({ vendorDir, log = () => {} } = {}) {
  const patches = await loadPatches();
  const reverted = [];
  const touched = new Map();
  for (const patch of patches) {
    for (const [rel, list] of Object.entries(patch.files || {})) {
      const full = join(vendorDir, rel);
      if (!existsSync(full)) continue;
      let text = touched.has(rel) ? touched.get(rel) : readFileSync(full, 'utf8');
      let changed = false;
      for (const edit of [...list].reverse()) {
        if (countOccurrences(text, edit.replace) >= 1) { text = text.split(edit.replace).join(edit.find); changed = true; }
      }
      if (changed) { touched.set(rel, text); reverted.push({ id: patch.id, rel }); }
    }
  }
  for (const [rel, text] of touched) writeFileSync(join(vendorDir, rel), text, 'utf8');
  const mp = manifestPath(vendorDir);
  if (existsSync(mp)) { try { writeFileSync(mp, JSON.stringify({ upstreamTag: null, appliedAt: null, patches: [] }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ } }
  log(`已撤销补丁：${reverted.length} 处文件改动`);
  return reverted;
}
