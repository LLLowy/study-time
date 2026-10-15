/**
 * 手动备份 / 查看备份：node tools/backup-data.mjs [list|now]
 *
 * 备份存在项目下的 backups\<时间>\ 目录里，和 data 分开存，
 * 所以就算 data 被误删，也从备份里拿回来。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SNAP = path.join(ROOT, 'backups');
const FILES = ['tasks.json', 'inspirations.json', 'notes.json', 'health.json'];
const KEEP = 40;

const cmd = process.argv[2] || 'now';

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

function hasContent() {
  const t = readJson(path.join(DATA, 'tasks.json')) || {};
  const n = readJson(path.join(DATA, 'notes.json')) || {};
  const i = readJson(path.join(DATA, 'inspirations.json')) || {};
  const h = readJson(path.join(DATA, 'health.json')) || {};
  return (t.tasks || []).length + (t.sessions || []).length + (n.notebooks || []).length
    + (n.notes || []).length + (i.items || []).length + (h.weights || []).length
    + (h.intake || []).length + (h.burn || []).length + (h.water || []).length > 0;
}

if (cmd === 'list') {
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
  for (const d of dirs) {
    console.log(`  ${d}   ${summarize(path.join(SNAP, d))}`);
  }
  console.log('\n要恢复某一份，把对应目录里的 json 文件复制回 data\\ 即可。');
  process.exit(0);
}

// 默认：立刻备份
if (!existsSync(DATA)) {
  console.error('找不到 data 目录，没有可备份的数据。');
  process.exit(1);
}
if (!hasContent()) {
  console.log('data 目录里没有任何内容，跳过备份。');
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
console.log(`已备份 ${copied} 个文件到 backups\\${stamp}\\`);
console.log(`  ${summarize(dir)}`);

const dirs = readdirSync(SNAP, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
for (const old of dirs.slice(0, Math.max(0, dirs.length - KEEP))) {
  rmSync(path.join(SNAP, old), { recursive: true, force: true });
}
void statSync;
