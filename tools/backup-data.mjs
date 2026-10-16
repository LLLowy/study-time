/**
 * 手动备份 / 查看备份：node tools/backup-data.mjs [list|now|where]
 *
 * 备份存在数据目录下的 _快照\<时间>\ 里，和数据放在一起，
 * 所以整个数据目录拷走就是完整备份。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolveDataDir, fileHasContent } from './paths.mjs';

const DATA = resolveDataDir();
const SNAP = path.join(DATA, '_快照');
const FILES = ['tasks.json', 'inspirations.json', 'notes.json', 'health.json'];
const KEEP = 40;

const cmd = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'now';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function summarize(dir) {
  const parts = [];
  const t = readJson(path.join(dir, 'tasks.json'));
  if (t) {
    const done = (t.sessions || []).filter((s) => s.outcome === 'completed').length;
    parts.push(`任务 ${(t.tasks || []).length} 个`);
    parts.push(`记录 ${(t.sessions || []).length} 条（完成 ${done}）`);
  }
  const n = readJson(path.join(dir, 'notes.json'));
  if (n) parts.push(`笔记本 ${(n.notebooks || []).length} / 笔记 ${(n.notes || []).length}`);
  const i = readJson(path.join(dir, 'inspirations.json'));
  if (i) parts.push(`灵感 ${(i.items || []).length}`);
  const h = readJson(path.join(dir, 'health.json'));
  if (h) parts.push(`体重 ${(h.weights || []).length} / 摄入 ${(h.intake || []).length} / 消耗 ${(h.burn || []).length} / 喝水 ${(h.water || []).length}`);
  return parts.join('　');
}

if (cmd === 'where') {
  console.log(DATA);
  process.exit(0);
}

if (cmd === 'list') {
  console.log('数据目录：' + DATA + '\n');
  if (!existsSync(SNAP)) {
    console.log('还没有任何备份。运行 node tools/backup-data.mjs now 可以立刻备份一份。');
    process.exit(0);
  }
  const dirs = readdirSync(SNAP, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  if (!dirs.length) {
    console.log('还没有任何备份。');
    process.exit(0);
  }
  console.log(`共 ${dirs.length} 份备份（最新的在前面）：\n`);
  for (const d of dirs) console.log(`  ${d}   ${summarize(path.join(SNAP, d))}`);
  console.log('\n要恢复某一份，把对应目录里的 json 文件复制回数据目录即可。');
  process.exit(0);
}

// 默认：立刻备份
if (!existsSync(DATA)) {
  console.error('找不到数据目录：' + DATA);
  process.exit(1);
}
if (!FILES.some((f) => fileHasContent(path.join(DATA, f)))) {
  console.log('数据目录里还没有任何内容，跳过备份。');
  console.log('数据目录：' + DATA);
  process.exit(0);
}

mkdirSync(SNAP, { recursive: true });
const d = new Date();
const p = (x) => String(x).padStart(2, '0');
const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
const dir = path.join(SNAP, stamp);
mkdirSync(dir, { recursive: true });

let copied = 0;
for (const f of FILES) {
  const src = path.join(DATA, f);
  if (existsSync(src)) {
    writeFileSync(path.join(dir, f), readFileSync(src));
    copied += 1;
  }
}
console.log(`已备份 ${copied} 个文件到 _快照\\${stamp}\\`);
console.log(`  ${summarize(dir)}`);
console.log(`  数据目录：${DATA}`);

const dirs = readdirSync(SNAP, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
for (const old of dirs.slice(0, Math.max(0, dirs.length - KEEP))) {
  rmSync(path.join(SNAP, old), { recursive: true, force: true });
}
