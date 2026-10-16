/**
 * 共用的路径解析：数据在哪、配置在哪、运行时文件在哪。
 * 规则必须和 server.js 保持一致。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const APP_NAME = '学习工作站';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 运行时的端口 / 停止令牌放程序目录里 */
export const RUNTIME_DIR = path.join(ROOT, '.runtime');
export const PORT_FILE = path.join(RUNTIME_DIR, 'server-port');
export const STOP_TOKEN_FILE = path.join(RUNTIME_DIR, 'stop-token');

export const CONFIG_DIR = (() => {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--config-dir='));
  if (arg) {
    const raw = arg.slice('--config-dir='.length).replace(/^"(.*)"$/, '$1').trim();
    if (raw) return path.resolve(raw);
  }
  const base = process.env.APPDATA || process.env.LOCALAPPDATA;
  return base ? path.join(base, APP_NAME) : null;
})();
export const CONFIG_FILE = CONFIG_DIR ? path.join(CONFIG_DIR, 'config.json') : null;

/** 老版本把数据放在程序目录里 */
export const LEGACY_DATA_DIR = path.join(ROOT, 'data');
export const LEGACY_SNAPSHOT_DIR = path.join(ROOT, 'backups');

export function loadConfig() {
  if (!CONFIG_FILE) return {};
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

export function documentsDir() {
  const home = process.env.USERPROFILE || homedir();
  const candidates = [
    path.join(home, 'Documents'),
    path.join(home, 'OneDrive', 'Documents'),
    path.join(home, 'OneDrive', '文档'),
    path.join(home, '文档'),
    home,
  ];
  for (const c of candidates) {
    try { if (statSync(c).isDirectory()) return c; } catch { /* 试下一个 */ }
  }
  return home;
}

export function defaultDataDir() {
  return path.join(documentsDir(), `${APP_NAME}数据`);
}

/** 数据目录：--data 参数 > 配置文件 > 默认位置 */
export function resolveDataDir(argv = process.argv.slice(2)) {
  const arg = argv.find((a) => a.startsWith('--data='));
  if (arg) {
    const raw = arg.slice('--data='.length).replace(/^"(.*)"$/, '$1').trim();
    if (raw) return path.resolve(raw);
  }
  const cfg = loadConfig();
  if (typeof cfg.dataDir === 'string' && cfg.dataDir.trim()) return path.resolve(cfg.dataDir.trim());
  return defaultDataDir();
}

export function fileHasContent(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    const t = s.tasks || {};
    const i = s.inspirations || {};
    const n = s.notes || {};
    const h = s.health || {};
    return (t.tasks || []).length + (t.sessions || []).length + (i.items || []).length
      + (n.notebooks || []).length + (n.notes || []).length
      + (h.weights || []).length + (h.intake || []).length + (h.burn || []).length
      + (h.water || []).length + (h.customFoods || []).length + (h.customBurns || []).length
      + (h.profile ? 1 : 0) + (t.active ? 1 : 0) > 0;
  } catch {
    return false;
  }
}

/** 数据目录里是否已经有内容（用于判断要不要从旧位置搬过来） */
export function dataDirHasContent(dir = resolveDataDir()) {
  return ['tasks.json', 'inspirations.json', 'notes.json', 'health.json']
    .some((f) => fileHasContent(path.join(dir, f)));
}

export function readTrimmed(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

export function exists(p) {
  return existsSync(p);
}
