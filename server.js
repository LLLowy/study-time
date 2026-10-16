'use strict';

/**
 * 学习工作站 —— 本地服务器
 * 零第三方依赖，只使用 Node.js 内置模块。
 *
 * 数据默认存在「文档\学习工作站数据」里（在代码目录外面），
 * 所以替换、重装、甚至删掉整个程序目录，数据都不会受影响。
 * 位置可以改：运行「更改数据位置.vbs」，或启动时加 --data=<目录>。
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const APP_NAME = '学习工作站';
const MAX_BACKUPS = 30;
const MAX_BODY = 4 * 1024 * 1024; // 4MB

/** 前端用它判断「浏览器里的页面」和「正在跑的服务」是不是同一版本。 */
const API_VERSION = 3;

/* ------------------------------------------------------------------ */
/* 数据放在哪                                                          */
/* ------------------------------------------------------------------ */

/** 「数据在哪」的设置文件，放在 %APPDATA% 里，同样在代码目录外面。 */
function configDir() {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--config-dir='));
  if (arg) {
    const raw = arg.slice('--config-dir='.length).replace(/^"(.*)"$/, '$1').trim();
    if (raw) return path.resolve(raw);
  }
  const base = process.env.APPDATA || process.env.LOCALAPPDATA;
  return base ? path.join(base, APP_NAME) : null;
}
const CONFIG_DIR = configDir();
const CONFIG_FILE = CONFIG_DIR ? path.join(CONFIG_DIR, 'config.json') : null;

function loadConfig() {
  if (!CONFIG_FILE) return {};
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  if (!CONFIG_FILE) throw new Error('找不到 %APPDATA%，无法保存设置');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  return CONFIG_FILE;
}

/** 找「文档」目录（OneDrive 重定向过的机器上 Documents 可能在 OneDrive 里）。 */
function documentsDir() {
  const home = process.env.USERPROFILE || os.homedir();
  const candidates = [
    path.join(home, 'Documents'),
    path.join(home, 'OneDrive', 'Documents'),
    path.join(home, 'OneDrive', '文档'),
    path.join(home, '文档'),
    home,
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch { /* 试下一个 */ }
  }
  return home;
}

function defaultDataDir() {
  return path.join(documentsDir(), `${APP_NAME}数据`);
}

/** 数据目录优先级：--data 参数 > 配置文件 > 文档里的默认位置。 */
function resolveDataDir() {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--data='));
  if (arg) {
    const raw = arg.slice('--data='.length).replace(/^"(.*)"$/, '$1').trim();
    if (raw) return path.resolve(raw);
  }
  const cfg = loadConfig();
  if (typeof cfg.dataDir === 'string' && cfg.dataDir.trim()) {
    return path.resolve(cfg.dataDir.trim());
  }
  return defaultDataDir();
}

const DATA_DIR = resolveDataDir();
/** 老版本把数据放在程序目录里的 data/，首次启动时会自动复制到新位置。 */
const LEGACY_DATA_DIR = path.join(ROOT, 'data');
const LEGACY_SNAPSHOT_DIR = path.join(ROOT, 'backups');

const BACKUP_DIR = path.join(DATA_DIR, '_backup');
const SNAPSHOT_ROOT = path.join(DATA_DIR, '_快照');

/** 运行时的端口 / 停止令牌放程序目录里 —— 它们不是用户数据，不跟着数据搬。 */
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const PORT_FILE = path.join(RUNTIME_DIR, 'server-port');
const STOP_TOKEN_FILE = path.join(RUNTIME_DIR, 'stop-token');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 停止令牌：「停止.vbs」读它来调用 /api/shutdown。
 * 这样别的程序（或浏览器里打开的任意网页）没法随便把你的程序关掉。
 */
const STOP_TOKEN = crypto.randomBytes(24).toString('hex');

async function writeStopToken() {
  await fsp.mkdir(RUNTIME_DIR, { recursive: true });
  await fsp.writeFile(STOP_TOKEN_FILE, STOP_TOKEN, 'utf8');
}

async function removeStopToken() {
  try { await fsp.rm(STOP_TOKEN_FILE, { force: true }); } catch { /* ignore */ }
}

/** 实际监听的端口号写在 .runtime\server-port 里，启动/停止脚本读它，就不用挨个端口试探。 */
async function writePortFile(port) {
  await fsp.mkdir(RUNTIME_DIR, { recursive: true });
  await fsp.writeFile(PORT_FILE, String(port), 'utf8');
}

async function removePortFile() {
  try { await fsp.rm(PORT_FILE, { force: true }); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 快照备份：和数据放在同一个目录下，整包拷走就是完整备份                  */
/* ------------------------------------------------------------------ */

const SNAPSHOT_MARKER = path.join(SNAPSHOT_ROOT, '.last-fingerprint');
const MAX_SNAPSHOTS = 40;

/** 一份解析好的数据里有没有值得备份的内容。 */
function stateHasContent(s) {
  if (!s) return false;
  const t = s.tasks || {};
  const i = s.inspirations || {};
  const n = s.notes || {};
  const h = s.health || {};
  return (t.tasks || []).length > 0 || (t.sessions || []).length > 0 || Boolean(t.active)
    || (i.items || []).length > 0
    || (n.notebooks || []).length > 0 || (n.notes || []).length > 0
    || Boolean(h.profile) || (h.weights || []).length > 0 || (h.intake || []).length > 0
    || (h.burn || []).length > 0 || (h.water || []).length > 0
    || (h.customFoods || []).length > 0 || (h.customBurns || []).length > 0;
}

/** 有没有值得备份的内容（全新空库就不必存了）。 */
function hasContent() {
  return stateHasContent(state);
}

/** 读一个 json 文件并判断里面有没有内容。 */
function fileHasContent(file) {
  try {
    return stateHasContent(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return false;
  }
}

/**
 * 这个文件看起来「被用过」吗？
 * 只看文件大小、不看能不能解析 —— 免得旧数据恰好坏掉时被静默跳过，
 * 那样用户会以为数据丢了。坏文件也照搬，搬过去后程序会保留现场。
 */
function fileLooksUsed(file) {
  try {
    return fs.statSync(file).size > 20;
  } catch {
    return false;
  }
}

let lastSnapshotDir = null;

/**
 * 把当前全部数据整份快照到 backups/<时间>/ 下。
 * 内容没变就不重复存；只保留最近 MAX_SNAPSHOTS 份。
 */
async function snapshotData({ force = false, quiet = true } = {}) {
  try {
    if (!force && !hasContent()) return null;
    const payload = JSON.stringify({
      tasks: state.tasks,
      inspirations: state.inspirations,
      notes: state.notes,
      health: state.health,
    });
    const fingerprint = crypto.createHash('sha1').update(payload).digest('hex');

    if (!force) {
      try {
        const last = (await fsp.readFile(SNAPSHOT_MARKER, 'utf8')).trim();
        if (last === fingerprint) return null;
      } catch { /* 还没存过 */ }
    }

    await fsp.mkdir(SNAPSHOT_ROOT, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const dir = path.join(SNAPSHOT_ROOT, stamp);
    await fsp.mkdir(dir, { recursive: true });

    for (const [key, file] of Object.entries(FILE_OF)) {
      await fsp.writeFile(path.join(dir, file), JSON.stringify(state[key], null, 2), 'utf8');
    }
    await fsp.writeFile(SNAPSHOT_MARKER, fingerprint, 'utf8');
    lastSnapshotDir = dir;

    const entries = (await fsp.readdir(SNAPSHOT_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - MAX_SNAPSHOTS))) {
      await fsp.rm(path.join(SNAPSHOT_ROOT, old), { recursive: true, force: true });
    }

    if (!quiet) console.log(`   已备份到 backups\\${stamp}\\`);
    return dir;
  } catch (err) {
    console.error('[备份] 快照失败：', err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 数据存储                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_STATE = () => ({
  tasks: { version: 1, tasks: [], active: null, sessions: [] },
  inspirations: { version: 1, items: [] },
  notes: { version: 1, notebooks: [], notes: [], meta: { seeded: false } },
  health: {
    version: 1,
    profile: null,
    weights: [],
    intake: [],
    burn: [],
    water: [],
    customFoods: [],
    customBurns: [],
    goals: {
      waterMl: 2000,
      intakeKcal: null,
      burnKcal: null,
      macros: { proteinG: null, carbsG: null, fatG: null },
    },
  },
});

const FILE_OF = {
  tasks: 'tasks.json',
  inspirations: 'inspirations.json',
  notes: 'notes.json',
  health: 'health.json',
};

const state = DEFAULT_STATE();
let writeChain = Promise.resolve();

function newId(prefix) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
}

/**
 * 首次用新位置时，把程序目录里旧 data\ 的内容【复制】过去（原件一律保留）。
 * 只有在两边都为空 / 新位置已有内容时才不动。
 */
async function migrateLegacyData() {
  const files = Object.values(FILE_OF);
  const newHas = files.some((f) => fileLooksUsed(path.join(DATA_DIR, f)));
  if (newHas) return null;

  const legacyHas = files.some((f) => fileLooksUsed(path.join(LEGACY_DATA_DIR, f)));
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!legacyHas) return null;

  let copied = 0;
  for (const f of files) {
    const src = path.join(LEGACY_DATA_DIR, f);
    if (fs.existsSync(src)) {
      await fsp.copyFile(src, path.join(DATA_DIR, f));
      copied += 1;
    }
  }

  // 旧位置的整份快照也一起搬过来，历史不丢
  let snapshots = 0;
  try {
    if (fs.existsSync(LEGACY_SNAPSHOT_DIR)) {
      await fsp.mkdir(SNAPSHOT_ROOT, { recursive: true });
      for (const e of await fsp.readdir(LEGACY_SNAPSHOT_DIR, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const from = path.join(LEGACY_SNAPSHOT_DIR, e.name);
        const to = path.join(SNAPSHOT_ROOT, e.name);
        if (!fs.existsSync(to)) {
          await fsp.cp(from, to, { recursive: true });
          snapshots += 1;
        }
      }
    }
  } catch (err) {
    console.error('[迁移] 旧快照复制失败（不影响数据）：', err.message);
  }

  return { copied, snapshots, from: LEGACY_DATA_DIR, to: DATA_DIR };
}

async function loadState() {
  await ensureDirs();
  const migration = await migrateLegacyData();
  const defaults = DEFAULT_STATE();
  for (const key of Object.keys(FILE_OF)) {
    const file = path.join(DATA_DIR, FILE_OF[key]);
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      state[key] = Object.assign({}, defaults[key], parsed);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const broken = `${file}.broken-${Date.now()}`;
        try {
          await fsp.rename(file, broken);
          console.error(`[数据] ${FILE_OF[key]} 解析失败，已重命名为 ${path.basename(broken)}`);
        } catch { /* ignore */ }
      }
      state[key] = defaults[key];
      await persist(key);
    }
  }
  return migration;
}

async function backup(key) {
  const file = path.join(DATA_DIR, FILE_OF[key]);
  try {
    await fsp.access(file);
  } catch {
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(BACKUP_DIR, `${key}.${stamp}.json`);
  try {
    await fsp.copyFile(file, target);
    const entries = (await fsp.readdir(BACKUP_DIR))
      .filter((n) => n.startsWith(`${key}.`))
      .sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - MAX_BACKUPS))) {
      await fsp.rm(path.join(BACKUP_DIR, old), { force: true });
    }
  } catch (err) {
    console.error('[备份] 失败：', err.message);
  }
}

/** 原子写入：先写临时文件再改名，避免中途断电产生半截文件。 */
function persist(key) {
  writeChain = writeChain.then(async () => {
    await backup(key);
    const file = path.join(DATA_DIR, FILE_OF[key]);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state[key], null, 2), 'utf8');
    await fsp.rename(tmp, file);
  }).catch((err) => {
    console.error('[保存] 失败：', err.message);
  });
  return writeChain;
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function str(v, { max = 20000, field = '文本' } = {}) {
  if (typeof v !== 'string') throw new HttpError(400, `${field} 必须是字符串`);
  if (v.length > max) throw new HttpError(400, `${field} 过长（上限 ${max} 字）`);
  return v;
}

function cleanText(v, opts) {
  return str(v, opts).replace(/\r\n/g, '\n').trim();
}

function num(v, { min = 0, max = 100000, field = '数值' } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} 必须是数字`);
  if (n < min || n > max) throw new HttpError(400, `${field} 必须在 ${min} 到 ${max} 之间`);
  return n;
}

function findOr404(list, id, label) {
  const item = list.find((x) => x.id === id);
  if (!item) throw new HttpError(404, `${label}不存在（${id}）`);
  return item;
}

const now = () => Date.now();

/** 本地日期，形如 2026-10-13。用于按天分组记录（跟使用者的时区一致）。 */
function localDate(at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 列表摘要：去掉 Markdown 记号，只留正文。 */
function excerptOf(content) {
  return String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_`>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/* ------------------------------------------------------------------ */
/* 定时器逻辑                                                          */
/* ------------------------------------------------------------------ */

function remainingSeconds(active, at = now()) {
  if (!active) return 0;
  if (active.pausedRemainingSec !== null && active.pausedRemainingSec !== undefined) {
    return Math.max(0, Math.round(active.pausedRemainingSec));
  }
  return Math.max(0, Math.round(active.durationSec - elapsedSeconds(active, at)));
}

/** 本次计时已真正走过的秒数（暂停期间不算）。 */
function elapsedSeconds(active, at = now()) {
  if (!active) return 0;
  const paused = active.pausedRemainingSec !== null && active.pausedRemainingSec !== undefined;
  const ref = paused ? (active.pausedAt || at) : at;
  return Math.max(0, Math.round((ref - active.startedAt) / 1000 - (active.pausedTotalSec || 0)));
}

function publicActive(active) {
  if (!active) return null;
  const task = state.tasks.tasks.find((t) => t.id === active.taskId) || null;
  const paused = active.pausedRemainingSec !== null && active.pausedRemainingSec !== undefined;
  return {
    ...active,
    paused,
    remainingSec: remainingSeconds(active),
    elapsedSec: elapsedSeconds(active),
    endsAt: paused ? null : active.startedAt + active.durationSec * 1000
      + (active.pausedTotalSec || 0) * 1000,
    taskTitle: task ? task.title : '（任务已删除）',
    noteId: task ? task.noteId || null : null,
  };
}

function finishSession({ outcome, note, actualSec }) {
  const active = state.tasks.active;
  if (!active) throw new HttpError(400, '当前没有正在进行的计时');
  const task = state.tasks.tasks.find((t) => t.id === active.taskId) || null;
  const session = {
    id: newId('s'),
    taskId: active.taskId,
    title: task ? task.title : '（任务已删除）',
    noteId: task ? task.noteId || null : null,
    plannedSec: active.durationSec,
    actualSec: typeof actualSec === 'number'
      ? Math.max(0, Math.round(actualSec))
      : elapsedSeconds(active),
    startedAt: active.startedAt,
    endedAt: now(),
    outcome: outcome === 'completed' ? 'completed' : 'stopped',
    note: note ? cleanText(note, { max: 4000, field: '学习记录' }) : '',
  };
  state.tasks.sessions.unshift(session);
  if (state.tasks.sessions.length > 2000) state.tasks.sessions.length = 2000;
  state.tasks.active = null;
  persist('tasks');
  return session;
}

/* ------------------------------------------------------------------ */
/* 身体管理：基础代谢与每日统计                                        */
/* ------------------------------------------------------------------ */

/** 活动强度系数（乘在基础代谢上得到每日总消耗 TDEE）。 */
const ACTIVITY_LEVELS = {
  sedentary: { label: '久坐（几乎不运动）', factor: 1.2 },
  light: { label: '轻度（每周运动 1-3 次）', factor: 1.375 },
  moderate: { label: '中度（每周运动 3-5 次）', factor: 1.55 },
  active: { label: '高度（每周运动 6-7 次）', factor: 1.725 },
  athlete: { label: '极高（体力劳动 / 一天两练）', factor: 1.9 },
};

/** 中国成人 BMI 分类。 */
function bmiLabelOf(bmi) {
  if (!Number.isFinite(bmi)) return '';
  if (bmi < 18.5) return '偏瘦';
  if (bmi < 24) return '正常';
  if (bmi < 28) return '超重';
  return '肥胖';
}

/**
 * 基础代谢率（Mifflin-St Jeor 公式），单位 kcal/天。
 * 男：10×体重 + 6.25×身高 − 5×年龄 + 5
 * 女：10×体重 + 6.25×身高 − 5×年龄 − 161
 */
function bmrOf({ gender, age, heightCm, weightKg }) {
  if (![age, heightCm, weightKg].every((n) => Number.isFinite(n) && n > 0)) return null;
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(gender === 'female' ? base - 161 : base + 5);
}

function sumKcal(list, date) {
  return Math.round(list.filter((r) => r.date === date).reduce((s, r) => s + (r.kcal || 0), 0));
}

function sumMl(list, date) {
  return Math.round(list.filter((r) => r.date === date).reduce((s, r) => s + (r.ml || 0), 0));
}

/** 每克营养素的热量：蛋白质 4、碳水 4、脂肪 9。 */
const KCAL_PER_G = { proteinG: 4, carbsG: 4, fatG: 9 };

function sumMacros(list, date) {
  const out = { proteinG: 0, carbsG: 0, fatG: 0 };
  for (const r of list) {
    if (r.date !== date) continue;
    out.proteinG += r.proteinG || 0;
    out.carbsG += r.carbsG || 0;
    out.fatG += r.fatG || 0;
  }
  return {
    proteinG: Math.round(out.proteinG * 10) / 10,
    carbsG: Math.round(out.carbsG * 10) / 10,
    fatG: Math.round(out.fatG * 10) / 10,
  };
}

/**
 * 按体重和每日总消耗给一套建议目标：
 * 蛋白质 1.6 g/kg，脂肪占总热量 25%，剩下的给碳水。
 */
function suggestMacros(weightKg, tdee) {
  if (!weightKg || !tdee) return null;
  const proteinG = Math.round(weightKg * 1.6);
  const fatG = Math.round((tdee * 0.25) / KCAL_PER_G.fatG);
  const carbsG = Math.max(0, Math.round((tdee - proteinG * 4 - fatG * 9) / 4));
  return { proteinG, carbsG, fatG };
}

/** 用户自己设了就用自己的，没设就用建议值。 */
function resolveMacroTargets(suggested) {
  const g = (state.health.goals && state.health.goals.macros) || {};
  const pick = (key) => (g[key] === null || g[key] === undefined ? (suggested ? suggested[key] : null) : g[key]);
  const custom = ['proteinG', 'carbsG', 'fatG'].some((k) => g[k] !== null && g[k] !== undefined);
  return {
    proteinG: pick('proteinG'),
    carbsG: pick('carbsG'),
    fatG: pick('fatG'),
    source: custom ? 'custom' : (suggested ? 'suggested' : 'none'),
  };
}

function publicHealth() {
  const h = state.health;
  const profile = h.profile;
  const sorted = h.weights.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
  const latest = sorted.length ? sorted[sorted.length - 1] : null;
  const first = sorted.length ? sorted[0] : null;

  const today = localDate();
  const weekAgo = localDate(Date.now() - 6 * 86400000);

  let computed = null;
  if (profile && latest) {
    const bmr = bmrOf({
      gender: profile.gender,
      age: profile.age,
      heightCm: profile.heightCm,
      weightKg: latest.kg,
    });
    const factor = (ACTIVITY_LEVELS[profile.activity] || ACTIVITY_LEVELS.sedentary).factor;
    const tdee = bmr ? Math.round(bmr * factor) : null;
    const heightM = profile.heightCm / 100;
    const bmi = heightM > 0 ? latest.kg / (heightM * heightM) : null;
    computed = {
      bmr,
      tdee,
      activityFactor: factor,
      bmi: bmi ? Math.round(bmi * 10) / 10 : null,
      bmiLabel: bmiLabelOf(bmi),
      latestWeightKg: latest.kg,
      latestWeightDate: latest.date,
      firstWeightKg: first.kg,
      weightDelta: Math.round((latest.kg - first.kg) * 10) / 10,
      targetWeightKg: profile.targetWeightKg ?? null,
      targetRemainKg: profile.targetWeightKg != null
        ? Math.round((latest.kg - profile.targetWeightKg) * 10) / 10
        : null,
    };
  }

  const todayIntake = sumKcal(h.intake, today);
  const todayBurn = sumKcal(h.burn, today);
  const todayWater = sumMl(h.water, today);
  const todayMacros = sumMacros(h.intake, today);

  const suggested = computed ? suggestMacros(computed.latestWeightKg, computed.tdee) : null;
  const macroTargets = resolveMacroTargets(suggested);

  // 饼图按「各大营养素贡献的热量」算占比
  const macroKcal = {
    proteinG: Math.round(todayMacros.proteinG * KCAL_PER_G.proteinG),
    carbsG: Math.round(todayMacros.carbsG * KCAL_PER_G.carbsG),
    fatG: Math.round(todayMacros.fatG * KCAL_PER_G.fatG),
  };
  const macroKcalTotal = macroKcal.proteinG + macroKcal.carbsG + macroKcal.fatG;
  const macroStatus = ['proteinG', 'carbsG', 'fatG'].map((key) => {
    const target = macroTargets[key];
    const actual = todayMacros[key];
    return {
      key,
      label: key === 'proteinG' ? '蛋白质' : key === 'carbsG' ? '碳水化合物' : '脂肪',
      actualG: actual,
      targetG: target,
      percent: target ? Math.round((actual / target) * 100) : null,
      reached: target ? actual >= target : null,
      remainG: target ? Math.max(0, Math.round((target - actual) * 10) / 10) : null,
    };
  });

  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = localDate(Date.now() - i * 86400000);
    days.push({
      date: d,
      intakeKcal: sumKcal(h.intake, d),
      burnKcal: sumKcal(h.burn, d),
      waterMl: sumMl(h.water, d),
    });
  }

  return {
    profile,
    goals: h.goals,
    activityLevels: Object.entries(ACTIVITY_LEVELS).map(([id, v]) => ({ id, label: v.label, factor: v.factor })),
    weights: sorted,
    intake: h.intake.slice(0, 1000),
    burn: h.burn.slice(0, 1000),
    water: h.water.slice(0, 2000),
    customFoods: h.customFoods || [],
    customBurns: h.customBurns || [],
    computed,
    macros: {
      today: todayMacros,
      targets: macroTargets,
      suggested,
      kcal: macroKcal,
      kcalTotal: macroKcalTotal,
      status: macroStatus,
      allReached: macroStatus.every((s) => s.reached !== false) && macroStatus.some((s) => s.targetG),
    },
    today: {
      date: today,
      intakeKcal: todayIntake,
      burnKcal: todayBurn,
      waterMl: todayWater,
      netKcal: todayIntake - todayBurn,
      intakeLeftKcal: computed && computed.tdee != null ? computed.tdee + todayBurn - todayIntake : null,
      waterLeftMl: Math.max(0, (h.goals.waterMl || 0) - todayWater),
    },
    week: {
      from: weekAgo,
      to: today,
      intakeKcal: days.reduce((s, d) => s + d.intakeKcal, 0),
      burnKcal: days.reduce((s, d) => s + d.burnKcal, 0),
      waterMl: days.reduce((s, d) => s + d.waterMl, 0),
      avgIntakeKcal: Math.round(days.reduce((s, d) => s + d.intakeKcal, 0) / 7),
      days,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

/* --- 数据存放位置 --- */

function snapshotCount() {
  try {
    return fs.readdirSync(SNAPSHOT_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

function storageInfo() {
  const cfg = loadConfig();
  const fromConfig = typeof cfg.dataDir === 'string' && cfg.dataDir.trim() ? cfg.dataDir.trim() : null;
  const fromArg = process.argv.slice(2).find((a) => a.startsWith('--data='));
  return {
    dataDir: DATA_DIR,
    defaultDataDir: defaultDataDir(),
    configFile: CONFIG_FILE,
    isCustom: Boolean(fromConfig || fromArg),
    configuredDir: fromConfig,
    fromCommandLine: Boolean(fromArg),
    isProjectLocal: path.resolve(DATA_DIR) === path.resolve(LEGACY_DATA_DIR),
    snapshotCount: snapshotCount(),
    legacyDataDir: LEGACY_DATA_DIR,
    legacyHasData: Object.values(FILE_OF).some((f) => fileLooksUsed(path.join(LEGACY_DATA_DIR, f))),
  };
}

/** 立刻存一份整份快照。 */
route('POST', '/api/storage/backup', async () => {
  const dir = await snapshotData({ force: true, quiet: false });
  if (!dir) throw new HttpError(500, '备份失败，请看程序窗口里的提示');
  return { dir, name: path.basename(dir), storage: storageInfo() };
});

/** 在资源管理器里打开数据文件夹 —— 路径来自配置，不接受用户输入。 */
route('POST', '/api/storage/open', async () => {
  const dir = DATA_DIR;
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    throw new HttpError(500, '打不开资源管理器，请手动打开：' + dir);
  }
  return { dir };
});

/**
 * 换数据位置。只写配置，重启后才生效 ——
 * 下次启动时会把当前数据复制过去，原位置保留。
 */
route('POST', '/api/storage/dir', async (_p, body) => {
  const raw = String(body.dir || '').trim();
  if (!raw) throw new HttpError(400, '请填写目录路径');
  const target = path.resolve(raw);
  if (target === path.resolve(DATA_DIR)) throw new HttpError(400, '这就是当前的位置');

  // 能建目录、能写文件才算可用
  try {
    await fsp.mkdir(target, { recursive: true });
    const probe = path.join(target, '.write-test');
    await fsp.writeFile(probe, 'ok', 'utf8');
    await fsp.rm(probe, { force: true });
  } catch (err) {
    throw new HttpError(400, `这个位置不能写入：${err.message}`);
  }

  const cfg = loadConfig();
  cfg.dataDir = target;
  cfg.updatedAt = now();
  saveConfig(cfg);
  return {
    dataDir: target,
    needRestart: true,
    message: '已记录新位置。重启程序后生效，数据会自动复制过去，原位置的文件保留。',
  };
});

/** 改回「文档」里的默认位置。 */
route('POST', '/api/storage/reset', async () => {
  const cfg = loadConfig();
  delete cfg.dataDir;
  cfg.updatedAt = now();
  saveConfig(cfg);
  return { dataDir: defaultDataDir(), needRestart: true };
});

/* --- 概览 --- */
route('GET', '/api/all', async () => ({
  apiVersion: API_VERSION,
  serverTime: now(),
  today: localDate(),
  storage: storageInfo(),
  tasks: state.tasks.tasks,
  active: publicActive(state.tasks.active),
  sessions: state.tasks.sessions.slice(0, 300),
  inspirations: state.inspirations.items,
  notebooks: state.notes.notebooks,
  notes: state.notes.notes.map((n) => ({
    id: n.id, notebookId: n.notebookId, title: n.title, updatedAt: n.updatedAt,
    createdAt: n.createdAt, sourceInspirationId: n.sourceInspirationId || null,
    excerpt: excerptOf(n.content),
  })),
  health: publicHealth(),
}));

route('GET', '/api/notes/:id', async (_p, _b, params) => {
  const note = findOr404(state.notes.notes, params.id, '笔记');
  return { note: { ...note, content: note.content || '' } };
});

/* --- 任务 --- */
route('POST', '/api/tasks', async (_p, body) => {
  const title = cleanText(body.title, { max: 200, field: '任务名称' });
  if (!title) throw new HttpError(400, '任务名称不能为空');
  const minutes = num(body.minutes, { min: 1, max: 1440, field: '时长（分钟）' });
  const task = {
    id: newId('t'),
    title,
    minutes,
    noteId: body.noteId ? String(body.noteId) : null,
    createdAt: now(),
  };
  if (task.noteId && !state.notes.notes.some((n) => n.id === task.noteId)) task.noteId = null;
  state.tasks.tasks.push(task);
  persist('tasks');
  return { task };
});

route('PATCH', '/api/tasks/:id', async (_p, body, params) => {
  const task = findOr404(state.tasks.tasks, params.id, '任务');
  if (body.title !== undefined) {
    const title = cleanText(body.title, { max: 200, field: '任务名称' });
    if (!title) throw new HttpError(400, '任务名称不能为空');
    task.title = title;
  }
  if (body.minutes !== undefined) {
    task.minutes = num(body.minutes, { min: 1, max: 1440, field: '时长（分钟）' });
  }
  if (body.noteId !== undefined) {
    const id = body.noteId ? String(body.noteId) : null;
    task.noteId = id && state.notes.notes.some((n) => n.id === id) ? id : null;
  }
  if (state.tasks.active && state.tasks.active.taskId === task.id && body.minutes !== undefined) {
    // 正在计时时同步调整目标时长，并保持已走的进度不变
    const active = state.tasks.active;
    const nextSec = task.minutes * 60;
    const delta = nextSec - active.durationSec;
    active.durationSec = nextSec;
    if (active.pausedRemainingSec !== null && active.pausedRemainingSec !== undefined) {
      active.pausedRemainingSec = Math.max(0, active.pausedRemainingSec + delta);
    }
  }
  persist('tasks');
  return { task };
});

route('DELETE', '/api/tasks/:id', async (_p, _b, params) => {
  const idx = state.tasks.tasks.findIndex((t) => t.id === params.id);
  if (idx < 0) throw new HttpError(404, '任务不存在');
  state.tasks.tasks.splice(idx, 1);
  if (state.tasks.active && state.tasks.active.taskId === params.id) state.tasks.active = null;
  persist('tasks');
  return { ok: true };
});

/* --- 倒计时 --- */
route('POST', '/api/timer/start', async (_p, body) => {
  if (state.tasks.active) throw new HttpError(409, '已有正在进行的计时，请先结束它');
  const task = findOr404(state.tasks.tasks, String(body.taskId || ''), '任务');
  const durationSec = body.minutes !== undefined
    ? num(body.minutes, { min: 1, max: 1440, field: '时长（分钟）' }) * 60
    : task.minutes * 60;
  state.tasks.active = {
    id: newId('a'),
    taskId: task.id,
    startedAt: now(),
    durationSec,
    pausedRemainingSec: null,
    pausedAt: null,
    pausedTotalSec: 0,
    extensionSec: 0,
  };
  persist('tasks');
  return { active: publicActive(state.tasks.active) };
});

route('POST', '/api/timer/pause', async () => {
  const active = state.tasks.active;
  if (!active) throw new HttpError(400, '当前没有正在进行的计时');
  if (active.pausedRemainingSec !== null && active.pausedRemainingSec !== undefined) {
    throw new HttpError(400, '计时已经暂停');
  }
  active.pausedRemainingSec = remainingSeconds(active);
  active.pausedAt = now();
  persist('tasks');
  return { active: publicActive(active) };
});

route('POST', '/api/timer/resume', async () => {
  const active = state.tasks.active;
  if (!active) throw new HttpError(400, '当前没有正在进行的计时');
  if (active.pausedRemainingSec === null || active.pausedRemainingSec === undefined) {
    throw new HttpError(400, '计时没有暂停');
  }
  active.pausedTotalSec = (active.pausedTotalSec || 0) + Math.max(0, (now() - (active.pausedAt || now())) / 1000);
  active.startedAt = now() - (active.durationSec - active.pausedRemainingSec + active.pausedTotalSec) * 1000;
  active.pausedRemainingSec = null;
  active.pausedAt = null;
  persist('tasks');
  return { active: publicActive(active) };
});

route('POST', '/api/timer/extend', async (_p, body) => {
  const active = state.tasks.active;
  if (!active) throw new HttpError(400, '当前没有正在进行的计时');
  const minutes = num(body.minutes, { min: 1, max: 600, field: '延长分钟数' });
  active.durationSec += minutes * 60;
  active.extensionSec = (active.extensionSec || 0) + minutes * 60;
  if (active.pausedRemainingSec !== null && active.pausedRemainingSec !== undefined) {
    active.pausedRemainingSec += minutes * 60;
  }
  persist('tasks');
  return { active: publicActive(active) };
});

route('POST', '/api/timer/stop', async (_p, body) => {
  const session = finishSession({
    outcome: body.outcome,
    note: body.note,
    actualSec: body.actualSec,
  });
  return { session };
});

route('DELETE', '/api/sessions/:id', async (_p, _b, params) => {
  const idx = state.tasks.sessions.findIndex((s) => s.id === params.id);
  if (idx < 0) throw new HttpError(404, '学习记录不存在');
  state.tasks.sessions.splice(idx, 1);
  persist('tasks');
  return { ok: true };
});

/* --- 灵感 --- */
route('POST', '/api/inspirations', async (_p, body) => {
  const text = cleanText(body.text, { max: 8000, field: '灵感内容' });
  if (!text) throw new HttpError(400, '灵感内容不能为空');
  const item = {
    id: newId('i'),
    text,
    createdAt: now(),
    updatedAt: now(),
    pinned: Boolean(body.pinned),
    convertedNoteId: null,
  };
  state.inspirations.items.unshift(item);
  persist('inspirations');
  return { item };
});

route('PATCH', '/api/inspirations/:id', async (_p, body, params) => {
  const item = findOr404(state.inspirations.items, params.id, '灵感');
  if (body.text !== undefined) {
    const text = cleanText(body.text, { max: 8000, field: '灵感内容' });
    if (!text) throw new HttpError(400, '灵感内容不能为空');
    item.text = text;
  }
  if (body.pinned !== undefined) item.pinned = Boolean(body.pinned);
  item.updatedAt = now();
  persist('inspirations');
  return { item };
});

route('DELETE', '/api/inspirations/:id', async (_p, _b, params) => {
  const idx = state.inspirations.items.findIndex((x) => x.id === params.id);
  if (idx < 0) throw new HttpError(404, '灵感不存在');
  state.inspirations.items.splice(idx, 1);
  persist('inspirations');
  return { ok: true };
});

route('POST', '/api/inspirations/:id/to-note', async (_p, body, params) => {
  const item = findOr404(state.inspirations.items, params.id, '灵感');
  let notebookId = body.notebookId ? String(body.notebookId) : null;
  if (notebookId && !state.notes.notebooks.some((nb) => nb.id === notebookId)) {
    throw new HttpError(404, '目标笔记本不存在');
  }
  const title = (body.title ? cleanText(body.title, { max: 200, field: '标题' }) : '')
    || item.text.split('\n')[0].slice(0, 40)
    || '未命名笔记';
  // 正文默认是灵感原文；如果标题就是从第一行取的，避免标题和正文开头重复
  let content = item.text;
  const firstLine = item.text.split('\n')[0].trim();
  if (firstLine && title === firstLine && item.text.includes('\n')) {
    content = item.text.slice(item.text.indexOf('\n') + 1).replace(/^\s+/, '');
  }
  const note = {
    id: newId('n'),
    notebookId,
    title,
    content,
    createdAt: now(),
    updatedAt: now(),
    sourceInspirationId: item.id,
  };
  state.notes.notes.push(note);
  item.convertedNoteId = note.id;
  persist('notes');
  persist('inspirations');
  return { note: { id: note.id, notebookId: note.notebookId, title: note.title, content: note.content } };
});

/** 把灵感追加到一篇已有笔记的末尾（而不是新建笔记）。 */
route('POST', '/api/inspirations/:id/append-to-note', async (_p, body, params) => {
  const item = findOr404(state.inspirations.items, params.id, '灵感');
  const note = findOr404(state.notes.notes, String(body.noteId || ''), '笔记');
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
  const block = `\n\n---\n\n**${stamp} · 来自灵感速记**\n\n${item.text}\n`;
  note.content = (note.content || '') + block;
  note.updatedAt = now();
  item.convertedNoteId = note.id;
  persist('notes');
  persist('inspirations');
  return { note: { id: note.id, notebookId: note.notebookId, title: note.title, content: note.content } };
});

/* --- 笔记本 --- */
route('POST', '/api/notebooks', async (_p, body) => {
  const name = cleanText(body.name, { max: 100, field: '笔记本名称' });
  if (!name) throw new HttpError(400, '笔记本名称不能为空');
  let parentId = body.parentId ? String(body.parentId) : null;
  if (parentId && !state.notes.notebooks.some((nb) => nb.id === parentId)) {
    throw new HttpError(404, '上级笔记本不存在');
  }
  const nb = { id: newId('nb'), name, parentId, createdAt: now() };
  state.notes.notebooks.push(nb);
  persist('notes');
  return { notebook: nb };
});

route('PATCH', '/api/notebooks/:id', async (_p, body, params) => {
  const nb = findOr404(state.notes.notebooks, params.id, '笔记本');
  if (body.name !== undefined) {
    const name = cleanText(body.name, { max: 100, field: '笔记本名称' });
    if (!name) throw new HttpError(400, '笔记本名称不能为空');
    nb.name = name;
  }
  if (body.parentId !== undefined) {
    const parentId = body.parentId ? String(body.parentId) : null;
    if (parentId === nb.id) throw new HttpError(400, '不能把笔记本移动到它自己里面');
    if (parentId) {
      if (!state.notes.notebooks.some((x) => x.id === parentId)) {
        throw new HttpError(404, '上级笔记本不存在');
      }
      // 防止形成环
      let cursor = state.notes.notebooks.find((x) => x.id === parentId);
      while (cursor) {
        if (cursor.id === nb.id) throw new HttpError(400, '不能移动到自己的子笔记本里');
        cursor = cursor.parentId ? state.notes.notebooks.find((x) => x.id === cursor.parentId) : null;
      }
    }
    nb.parentId = parentId;
  }
  persist('notes');
  return { notebook: nb };
});

/** 删除笔记本：默认连带删除子笔记本与其下笔记，由前端二次确认。 */
route('DELETE', '/api/notebooks/:id', async (_p, body, params) => {
  const root = findOr404(state.notes.notebooks, params.id, '笔记本');
  const doomed = new Set([root.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const nb of state.notes.notebooks) {
      if (nb.parentId && doomed.has(nb.parentId) && !doomed.has(nb.id)) {
        doomed.add(nb.id);
        grew = true;
      }
    }
  }
  const removedNotes = state.notes.notes.filter((n) => n.notebookId && doomed.has(n.notebookId));
  state.notes.notebooks = state.notes.notebooks.filter((nb) => !doomed.has(nb.id));
  if (body && body.keepNotes) {
    for (const n of removedNotes) n.notebookId = null;
  } else {
    const removedIds = new Set(removedNotes.map((n) => n.id));
    state.notes.notes = state.notes.notes.filter((n) => !removedIds.has(n.id));
  }
  persist('notes');
  return { removedNotebooks: doomed.size, removedNotes: body && body.keepNotes ? 0 : removedNotes.length };
});

/* --- 笔记 --- */
route('POST', '/api/notes', async (_p, body) => {
  const title = cleanText(body.title || '未命名笔记', { max: 200, field: '标题' });
  const content = typeof body.content === 'string' ? body.content : '';
  let notebookId = body.notebookId ? String(body.notebookId) : null;
  if (notebookId && !state.notes.notebooks.some((nb) => nb.id === notebookId)) notebookId = null;
  const note = {
    id: newId('n'),
    notebookId,
    title,
    content,
    createdAt: now(),
    updatedAt: now(),
    sourceInspirationId: null,
  };
  state.notes.notes.push(note);
  persist('notes');
  return { note };
});

route('PATCH', '/api/notes/:id', async (_p, body, params) => {
  const note = findOr404(state.notes.notes, params.id, '笔记');
  if (body.title !== undefined) {
    note.title = cleanText(body.title, { max: 200, field: '标题' }) || '未命名笔记';
  }
  if (body.content !== undefined) {
    note.content = str(body.content, { max: 400000, field: '笔记内容' });
  }
  if (body.notebookId !== undefined) {
    const id = body.notebookId ? String(body.notebookId) : null;
    note.notebookId = id && state.notes.notebooks.some((nb) => nb.id === id) ? id : null;
  }
  note.updatedAt = now();
  persist('notes');
  return { note };
});

route('DELETE', '/api/notes/:id', async (_p, _b, params) => {
  const idx = state.notes.notes.findIndex((n) => n.id === params.id);
  if (idx < 0) throw new HttpError(404, '笔记不存在');
  state.notes.notes.splice(idx, 1);
  for (const t of state.tasks.tasks) if (t.noteId === params.id) t.noteId = null;
  persist('notes');
  persist('tasks');
  return { ok: true };
});

/* --- 身体管理 --- */

/** 校验并规整一个日期参数，缺省为今天。 */
function dateArg(v) {
  if (v === undefined || v === null || v === '') return localDate();
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
  return s;
}

route('PUT', '/api/health/profile', async (_p, body) => {
  const gender = body.gender === 'female' ? 'female' : body.gender === 'male' ? 'male' : null;
  if (!gender) throw new HttpError(400, '请选择性别');
  const heightCm = num(body.heightCm, { min: 80, max: 250, field: '身高（厘米）' });
  const age = num(body.age, { min: 5, max: 120, field: '年龄' });
  const activity = ACTIVITY_LEVELS[body.activity] ? String(body.activity) : 'sedentary';
  let targetWeightKg = null;
  if (body.targetWeightKg !== undefined && body.targetWeightKg !== null && body.targetWeightKg !== '') {
    targetWeightKg = num(body.targetWeightKg, { min: 20, max: 300, field: '目标体重（公斤）' });
  }
  const profile = {
    gender,
    heightCm: Math.round(heightCm * 10) / 10,
    age: Math.round(age),
    activity,
    targetWeightKg,
    updatedAt: now(),
  };
  state.health.profile = profile;
  // 首次设置档案时，如果还没有任何体重记录，顺手把当前体重记上
  if (body.weightKg !== undefined && body.weightKg !== null && body.weightKg !== '') {
    const kg = num(body.weightKg, { min: 20, max: 300, field: '体重（公斤）' });
    const date = dateArg(body.date);
    const exist = state.health.weights.find((w) => w.date === date);
    if (exist) exist.kg = kg;
    else {
      state.health.weights.push({ id: newId('w'), date, kg, note: '', createdAt: now() });
    }
  }
  persist('health');
  return { health: publicHealth() };
});

route('POST', '/api/health/weights', async (_p, body) => {
  if (!state.health.profile) throw new HttpError(400, '请先填写身高体重等基本档案');
  const kg = num(body.kg, { min: 20, max: 300, field: '体重（公斤）' });
  const date = dateArg(body.date);
  const note = body.note ? cleanText(body.note, { max: 200, field: '备注' }) : '';
  const exist = state.health.weights.find((w) => w.date === date);
  let weight;
  if (exist) {
    exist.kg = kg;
    exist.note = note;
    exist.createdAt = now();
    weight = exist;
  } else {
    weight = { id: newId('w'), date, kg, note, createdAt: now() };
    state.health.weights.push(weight);
  }
  persist('health');
  return { weight, health: publicHealth() };
});

route('PATCH', '/api/health/goals', async (_p, body) => {
  const g = state.health.goals;
  if (!g.macros) g.macros = { proteinG: null, carbsG: null, fatG: null };
  if (body.waterMl !== undefined) g.waterMl = num(body.waterMl, { min: 0, max: 10000, field: '每日喝水目标' });
  if (body.intakeKcal !== undefined) {
    g.intakeKcal = body.intakeKcal === null || body.intakeKcal === ''
      ? null
      : num(body.intakeKcal, { min: 0, max: 20000, field: '每日摄入目标' });
  }
  if (body.burnKcal !== undefined) {
    g.burnKcal = body.burnKcal === null || body.burnKcal === ''
      ? null
      : num(body.burnKcal, { min: 0, max: 20000, field: '每日消耗目标' });
  }
  // 三大营养素目标：传 null 表示改回「用系统建议值」
  if (body.macros !== undefined) {
    const m = body.macros || {};
    for (const key of ['proteinG', 'carbsG', 'fatG']) {
      if (m[key] === undefined) continue;
      g.macros[key] = m[key] === null || m[key] === ''
        ? null
        : num(m[key], { min: 0, max: 2000, field: '营养素目标（克）' });
    }
  }
  persist('health');
  return { goals: g, health: publicHealth() };
});

/** 体重 / 摄入 / 消耗 / 喝水 四类记录 + 自定义标签 共用一套删除逻辑。 */
const HEALTH_KINDS = {
  weights: { key: 'weights', label: '体重记录' },
  intake: { key: 'intake', label: '摄入记录' },
  burn: { key: 'burn', label: '消耗记录' },
  water: { key: 'water', label: '喝水记录' },
  foods: { key: 'customFoods', label: '自定义食物标签' },
  exercises: { key: 'customBurns', label: '自定义运动标签' },
};

/** 解析可选的三项营养素输入，缺省算 0。 */
function macroArgs(body) {
  const pick = (key, label) => {
    const v = body[key];
    if (v === undefined || v === null || v === '') return 0;
    return Math.round(num(v, { min: 0, max: 2000, field: label }) * 10) / 10;
  };
  return {
    proteinG: pick('proteinG', '蛋白质（克）'),
    carbsG: pick('carbsG', '碳水（克）'),
    fatG: pick('fatG', '脂肪（克）'),
  };
}

route('POST', '/api/health/intake', async (_p, body) => {
  const name = cleanText(body.name || '手动填写', { max: 60, field: '名称' });
  const kcal = num(body.kcal, { min: 0, max: 10000, field: '热量（千卡）' });
  const rec = {
    id: newId('fi'),
    date: dateArg(body.date),
    name,
    kcal: Math.round(kcal),
    ...macroArgs(body),
    createdAt: now(),
  };
  state.health.intake.unshift(rec);
  if (state.health.intake.length > 5000) state.health.intake.length = 5000;
  persist('health');
  return { record: rec, health: publicHealth() };
});

route('POST', '/api/health/burn', async (_p, body) => {
  const name = cleanText(body.name || '手动填写', { max: 60, field: '名称' });
  const kcal = num(body.kcal, { min: 0, max: 10000, field: '热量（千卡）' });
  const minutes = body.minutes === undefined || body.minutes === ''
    ? null
    : num(body.minutes, { min: 0, max: 1440, field: '时长（分钟）' });
  const rec = {
    id: newId('fb'),
    date: dateArg(body.date),
    name,
    kcal: Math.round(kcal),
    minutes: minutes === null ? null : Math.round(minutes),
    createdAt: now(),
  };
  state.health.burn.unshift(rec);
  if (state.health.burn.length > 5000) state.health.burn.length = 5000;
  persist('health');
  return { record: rec, health: publicHealth() };
});

/* --- 自定义标签：自己常用的食物 / 运动，存下来下次一键记录 --- */

route('POST', '/api/health/foods', async (_p, body) => {
  const name = cleanText(body.name, { max: 60, field: '标签名称' });
  if (!name) throw new HttpError(400, '标签名称不能为空');
  const kcal = num(body.kcal, { min: 0, max: 10000, field: '热量（千卡）' });
  const food = {
    id: newId('cf'),
    name,
    kcal: Math.round(kcal),
    ...macroArgs(body),
    createdAt: now(),
  };
  if (!state.health.customFoods) state.health.customFoods = [];
  state.health.customFoods.push(food);
  persist('health');
  return { food, health: publicHealth() };
});

route('POST', '/api/health/exercises', async (_p, body) => {
  const name = cleanText(body.name, { max: 60, field: '标签名称' });
  if (!name) throw new HttpError(400, '标签名称不能为空');
  const kcal = num(body.kcal, { min: 0, max: 10000, field: '热量（千卡）' });
  const minutes = body.minutes === undefined || body.minutes === ''
    ? null
    : num(body.minutes, { min: 0, max: 1440, field: '时长（分钟）' });
  const ex = {
    id: newId('ce'),
    name,
    kcal: Math.round(kcal),
    minutes: minutes === null ? null : Math.round(minutes),
    createdAt: now(),
  };
  if (!state.health.customBurns) state.health.customBurns = [];
  state.health.customBurns.push(ex);
  persist('health');
  return { exercise: ex, health: publicHealth() };
});

route('POST', '/api/health/water', async (_p, body) => {
  const ml = num(body.ml, { min: 1, max: 5000, field: '水量（毫升）' });
  const rec = { id: newId('dr'), date: dateArg(body.date), ml: Math.round(ml), createdAt: now() };
  state.health.water.unshift(rec);
  if (state.health.water.length > 5000) state.health.water.length = 5000;
  persist('health');
  return { record: rec, health: publicHealth() };
});

route('DELETE', '/api/health/:kind/:id', async (_p, _b, params) => {
  const kind = HEALTH_KINDS[params.kind];
  if (!kind) throw new HttpError(404, `没有这一类记录：${params.kind}`);
  const list = state.health[kind.key];
  const idx = list.findIndex((r) => r.id === params.id);
  if (idx < 0) throw new HttpError(404, `${kind.label}不存在`);
  list.splice(idx, 1);
  persist('health');
  return { health: publicHealth() };
});

route('DELETE', '/api/health/profile', async () => {
  // 只清空档案，体重与饮食记录保留（供用户重新测量后重填）
  state.health.profile = null;
  persist('health');
  return { health: publicHealth() };
});

/* ------------------------------------------------------------------ */
/* HTTP 层                                                             */
/* ------------------------------------------------------------------ */

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const rp = r.pattern.split('/');
    const pp = pathname.split('/');
    if (rp.length !== pp.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rp.length; i += 1) {
      if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(pp[i]);
      else if (rp[i] !== pp[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) throw new Error('dir');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 找不到该文件');
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(parsed.pathname);
  try {
    // 优雅停止：需要 data/.stop-token 里的令牌，避免被网页随便关掉
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      if (req.headers['x-stop-token'] !== STOP_TOKEN) {
        throw new HttpError(403, '停止令牌不正确');
      }
      sendJson(res, 200, { ok: true, data: { message: '正在关闭' } });
      setTimeout(async () => {
        await removeStopToken();
        console.log('\n已停止。数据均已保存到 data 目录。');
        process.exit(0);
      }, 250);
      return;
    }

    if (pathname.startsWith('/api/')) {
      const m = matchRoute(req.method, pathname);
      if (!m) throw new HttpError(404, `接口不存在：${req.method} ${pathname}`);
      const body = req.method === 'GET' || req.method === 'DELETE' ? await readBody(req) : await readBody(req);
      const result = await m.handler(parsed.searchParams, body, m.params);
      sendJson(res, 200, { ok: true, data: result });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[错误]', err);
    sendJson(res, status, { ok: false, error: err.message || '服务器内部错误' });
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打不开浏览器不影响使用，手动访问即可 */ }
}

async function listen(port, attempts = 25) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && attempts > 0) {
        server.removeListener('error', onError);
        listen(port + 1, attempts - 1).then(resolve, reject);
      } else {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(port);
    });
  });
}

async function main() {
  const argPort = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1]);
  const startPort = Number.isInteger(argPort) && argPort > 0 ? argPort : 7788;
  const noOpen = process.argv.includes('--no-open');

  const migration = await loadState();
  const port = await listen(startPort);
  await writeStopToken();
  await writePortFile(port);
  const snap = await snapshotData();
  const url = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │            学习工作站 已启动                 │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  console.log(`   访问地址：${url}`);
  console.log(`   数据目录：${DATA_DIR}`);
  if (migration) {
    console.log('');
    console.log(`   ℹ 已把原来的数据从 ${migration.from}`);
    console.log(`     复制到新位置（复制了 ${migration.copied} 个文件${migration.snapshots ? `、${migration.snapshots} 份备份` : ''}）。`);
    console.log('     原来的文件原地保留，确认没问题后可以自己删掉。');
  }
  if (snap) console.log(`   已快照备份：${path.basename(snap)}`);
  console.log('');
  console.log('   数据放在代码目录外面，以后替换程序文件不会影响你的记录。');
  console.log('   想换位置：双击「更改数据位置.vbs」。');
  console.log('');
  console.log('   本软件由 WUST 的 qwwz 定制');
  console.log('');
  console.log('   程序在后台运行，关掉浏览器或任何窗口都不会中断。');
  console.log('   要停止请双击「停止.vbs」（或按 Ctrl+C）。');
  console.log('');

  // 每 5 分钟看一次，有变化就再存一份快照
  const snapshotTimer = setInterval(() => { snapshotData(); }, 5 * 60 * 1000);
  snapshotTimer.unref();

  if (!noOpen) openBrowser(url);
}

async function shutdown(code) {
  await snapshotData({ force: true });
  await removeStopToken();
  await removePortFile();
  process.exit(code);
}

process.on('SIGINT', () => {
  console.log('\n已停止。数据都已保存到：' + DATA_DIR);
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  try { fs.rmSync(STOP_TOKEN_FILE, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(PORT_FILE, { force: true }); } catch { /* ignore */ }
});

main().catch((err) => {
  console.error('启动失败：', err.message);
  process.exit(1);
});
