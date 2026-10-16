/**
 * 更改数据存放位置：node tools/set-data-dir.mjs "<目录>" [--move]
 *
 * - 只写配置文件（%APPDATA%\学习工作站\config.json），重启程序后生效
 * - 加 --move 会立刻把当前数据复制到新位置（原位置保留，不删）
 * - 传 --reset 改回默认位置（文档里的「学习工作站数据」）
 * - 传 --show 只打印当前设置
 */
import { writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT, CONFIG_FILE, CONFIG_DIR, loadConfig, resolveDataDir, defaultDataDir, fileHasContent,
} from './paths.mjs';

const FILES = ['tasks.json', 'inspirations.json', 'notes.json', 'health.json'];
const args = process.argv.slice(2);

function writeConfig(cfg) {
  if (!CONFIG_FILE) throw new Error('找不到 %APPDATA%，无法保存设置');
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function copyData(from, to) {
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of FILES) {
    const src = path.join(from, f);
    if (existsSync(src) && fileHasContent(src)) {
      copyFileSync(src, path.join(to, f));
      n += 1;
    }
  }
  // 快照一起搬
  const snapFrom = path.join(from, '_快照');
  const snapTo = path.join(to, '_快照');
  let snaps = 0;
  if (existsSync(snapFrom)) {
    mkdirSync(snapTo, { recursive: true });
    for (const e of readdirSync(snapFrom, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dst = path.join(snapTo, e.name);
      if (existsSync(dst)) continue;
      mkdirSync(dst, { recursive: true });
      for (const f of readdirSync(path.join(snapFrom, e.name))) {
        copyFileSync(path.join(snapFrom, e.name, f), path.join(dst, f));
      }
      snaps += 1;
    }
  }
  return { files: n, snapshots: snaps };
}

const current = resolveDataDir();

if (args.includes('--show') || args.length === 0) {
  const cfg = loadConfig();
  console.log('当前数据位置：' + current);
  console.log('默认数据位置：' + defaultDataDir());
  console.log('设置文件：  ' + (CONFIG_FILE || '（不可用）'));
  console.log('是否自定义：' + (cfg.dataDir ? '是' : '否'));
  process.exit(0);
}

if (args.includes('--reset')) {
  const cfg = loadConfig();
  delete cfg.dataDir;
  cfg.updatedAt = Date.now();
  writeConfig(cfg);
  const target = defaultDataDir();
  console.log('已改回默认位置：' + target);
  if (target !== current) {
    const r = copyData(current, target);
    console.log(`已把当前数据复制过去（${r.files} 个文件${r.snapshots ? `、${r.snapshots} 份快照` : ''}），原位置保留。`);
  }
  console.log('重启程序后生效。');
  process.exit(0);
}

const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('用法：node tools/set-data-dir.mjs "<目录路径>"');
  process.exit(1);
}

const resolved = path.resolve(target);

// 尽量别把数据放回程序目录里 —— 那样就失去意义了
const projectRoot = ROOT;
if (resolved.toLowerCase().startsWith(projectRoot.toLowerCase())) {
  console.error('这个目录在程序目录里面。数据就是要放在外面才安全，请换一个位置。');
  console.error('程序目录：' + projectRoot);
  process.exit(1);
}

try {
  mkdirSync(resolved, { recursive: true });
  const probe = path.join(resolved, '.write-test');
  writeFileSync(probe, 'ok', 'utf8');
  rmSync(probe, { force: true });
} catch (err) {
  console.error('这个位置不能写入：' + err.message);
  process.exit(1);
}

const cfg = loadConfig();
cfg.dataDir = resolved;
cfg.updatedAt = Date.now();
writeConfig(cfg);

console.log('已记录新的数据位置：' + resolved);
console.log('  设置文件：' + CONFIG_FILE);

if (args.includes('--move')) {
  if (resolved === current) {
    console.log('和当前位置一样，不需要搬。');
  } else {
    const r = copyData(current, resolved);
    console.log(`  已把数据复制过去：${r.files} 个文件${r.snapshots ? `、${r.snapshots} 份快照` : ''}`);
    console.log('  原位置的文件保留，确认没问题后可以自己删掉。');
  }
}

console.log('\n重启程序后生效（双击桌面「停止学习工作站」再双击「学习工作站」）。');
