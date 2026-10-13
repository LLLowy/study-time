'use strict';

/**
 * 学习工作站 —— 本地服务器
 * 零第三方依赖，只使用 Node.js 内置模块。
 * 数据以 JSON 文件形式保存在 ./data 目录下，可随时备份或拷贝到别的电脑。
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, '_backup');
const MAX_BACKUPS = 30;
const MAX_BODY = 4 * 1024 * 1024; // 4MB

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

/* ------------------------------------------------------------------ */
/* 数据存储                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_STATE = () => ({
  tasks: { version: 1, tasks: [], active: null, sessions: [] },
  inspirations: { version: 1, items: [] },
  notes: { version: 1, notebooks: [], notes: [], meta: { seeded: false } },
});

const FILE_OF = {
  tasks: 'tasks.json',
  inspirations: 'inspirations.json',
  notes: 'notes.json',
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

async function loadState() {
  await ensureDirs();
  const defaults = DEFAULT_STATE();
  for (const key of Object.keys(FILE_OF)) {
    const file = path.join(DATA_DIR, FILE_OF[key]);
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
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
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

/* --- 概览 --- */
route('GET', '/api/all', async () => ({
  serverTime: now(),
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
  const note = {
    id: newId('n'),
    notebookId,
    title,
    content: item.text,
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

  await loadState();
  const port = await listen(startPort);
  const url = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │            学习工作站 已启动                 │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  console.log(`   访问地址：${url}`);
  console.log(`   数据目录：${DATA_DIR}`);
  console.log('');
  console.log('   本软件由 WUST 的 qwwz 定制');
  console.log('');
  console.log('   关闭这个窗口（或按 Ctrl+C）即可停止程序。');
  console.log('');
  if (!noOpen) openBrowser(url);
}

process.on('SIGINT', () => {
  console.log('\n已停止。数据均已保存到 data 目录。');
  process.exit(0);
});

main().catch((err) => {
  console.error('启动失败：', err.message);
  process.exit(1);
});
