/* ===================== 学习工作站 · 前端逻辑 ===================== */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

const RING_LEN = 2 * Math.PI * 98;

const S = {
  tasks: [],
  active: null,
  sessions: [],
  inspirations: [],
  notebooks: [],
  notes: [],
  clockOffset: 0,
  activeNoteId: null,
  editing: null,          // 当前打开的完整笔记
  nbFilter: 'all',        // 'all' | 'none' | notebookId
  collapsed: new Set(),
  noteSearch: '',
  inspireSearch: '',
  onlyUnconverted: false,
  finishHandled: false,
  saveTimer: null,
  dirty: false,
};

/* ---------------------------------------------------------------- */
/* 基础工具                                                          */
/* ---------------------------------------------------------------- */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !payload || payload.ok === false) {
    const msg = (payload && payload.error) || `请求失败（${res.status}）`;
    throw new Error(msg);
  }
  return payload.data;
}

function toast(message, kind = '') {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, 2200);
}

function fail(err) {
  console.error(err);
  toast(err.message || '出错了', 'err');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtMinutes(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtRelative(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
  return fmtDate(ts).slice(0, 10);
}

function todaySeconds() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return S.sessions
    .filter((s) => s.endedAt >= start.getTime())
    .reduce((sum, s) => sum + (s.actualSec || 0), 0);
}

/** 用 WebAudio 播放一声提示音，不需要任何音频文件。 */
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = [880, 1174.7, 1568];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + idx * 0.18;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.36);
    });
    setTimeout(() => ctx.close(), 1400);
  } catch { /* 无关紧要 */ }
}

/* ---------------------------------------------------------------- */
/* 弹窗                                                              */
/* ---------------------------------------------------------------- */

function openModal(html) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal">${html}</div>`;
  root.classList.remove('hidden');
  const first = root.querySelector('input, textarea, select');
  if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
  return root.querySelector('.modal');
}

function closeModal() {
  const root = $('#modalRoot');
  root.classList.add('hidden');
  root.innerHTML = '';
}

function modalShell({ title, body, okText = '确定', cancelText = '取消', okClass = 'primary', extra = '' }) {
  return `
    <div class="modal-head">${esc(title)}</div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">
      ${extra}
      ${cancelText ? `<button class="btn" data-modal="cancel">${esc(cancelText)}</button>` : ''}
      <button class="btn ${okClass}" data-modal="ok">${esc(okText)}</button>
    </div>`;
}

function askConfirm({ title, message, okText = '确定', okClass = 'danger', extra = '' }) {
  return new Promise((resolve) => {
    const modal = openModal(modalShell({
      title,
      body: `<div class="modal-hint">${message}</div>`,
      okText,
      okClass,
      extra,
    }));
    modal.addEventListener('click', (e) => {
      const act = e.target.closest('[data-modal]');
      if (!act) return;
      const which = act.dataset.modal;
      if (which === 'cancel') { closeModal(); resolve('cancel'); }
      else if (which === 'ok') { closeModal(); resolve('ok'); }
      else { closeModal(); resolve(which); }
    });
  });
}

/* ---------------------------------------------------------------- */
/* 数据加载                                                          */
/* ---------------------------------------------------------------- */

async function refresh({ keepNote = true } = {}) {
  const data = await api('GET', '/api/all');
  S.clockOffset = data.serverTime - Date.now();
  S.tasks = data.tasks;
  S.active = data.active;
  S.sessions = data.sessions;
  S.inspirations = data.inspirations;
  S.notebooks = data.notebooks;
  S.notes = data.notes;
  if (!keepNote) S.editing = null;
  renderAll();
}

function renderAll() {
  renderTasks();
  renderTimer();
  renderInspirations();
  renderNotebooks();
  renderNoteList();
  renderEditor();
  $('#todayStat').textContent = `今日 ${Math.round(todaySeconds() / 60)} 分钟`;
}

/* ---------------------------------------------------------------- */
/* 视图切换                                                          */
/* ---------------------------------------------------------------- */

function switchView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  if (!location.hash.startsWith(`#${name}`)) setHash(`#${name}`);
  if (name === 'notes') renderEditor();
}

function setHash(hash) {
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

/** 摘要：把 Markdown 记号去掉，只留正文，便于列表里扫一眼。 */
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

/* ---------------------------------------------------------------- */
/* 任务与计时                                                        */
/* ---------------------------------------------------------------- */

function sessionCountOf(taskId) {
  return S.sessions.filter((s) => s.taskId === taskId).length;
}

function renderTasks() {
  const ul = $('#taskList');
  const tasks = S.tasks;
  $('#taskEmpty').classList.toggle('hidden', tasks.length > 0);
  ul.innerHTML = tasks.map((t) => {
    const running = S.active && S.active.taskId === t.id;
    const note = t.noteId ? S.notes.find((n) => n.id === t.noteId) : null;
    const count = sessionCountOf(t.id);
    return `
      <li class="task-item ${running ? 'is-running' : ''}" data-id="${t.id}">
        <div class="task-main">
          <div class="task-title">${esc(t.title)}</div>
          <div class="task-sub">
            <span>${t.minutes} 分钟</span>
            ${count ? `<span>· 已完成 ${count} 次</span>` : ''}
            ${note ? `<span>· 📄 ${esc(note.title)}</span>` : ''}
            ${running ? '<span>· 进行中…</span>' : ''}
          </div>
        </div>
        <div class="row-actions">
          <button class="mini" data-act="edit">编辑</button>
          <button class="mini danger" data-act="del">删除</button>
        </div>
        <button class="btn primary sm" data-act="start" ${S.active ? 'disabled' : ''}>
          ${running ? '进行中' : '开始'}
        </button>
      </li>`;
  }).join('');

  const list = $('#sessionList');
  $('#sessionCount').textContent = S.sessions.length ? `（共 ${S.sessions.length} 次）` : '';
  if (!S.sessions.length) {
    list.innerHTML = '<div class="modal-hint" style="padding:6px 2px">还没有记录。完成一次专注后会自动出现在这里。</div>';
    return;
  }
  list.innerHTML = S.sessions.slice(0, 60).map((s) => `
    <div>
      <div class="session-item">
        <span class="tag">${s.outcome === 'completed' ? '完成' : '中断'}</span>
        <span class="s-title">${esc(s.title)}</span>
        <span class="s-time">${fmtMinutes(s.actualSec || 0)} · ${fmtDate(s.endedAt).slice(5, 16)}</span>
      </div>
      ${s.note ? `<div class="session-note">💭 ${esc(s.note)}</div>` : ''}
    </div>`).join('');
}

function remainingNow() {
  const a = S.active;
  if (!a) return 0;
  if (a.pausedRemainingSec !== null && a.pausedRemainingSec !== undefined) return a.pausedRemainingSec;
  const nowServer = Date.now() + S.clockOffset;
  return Math.max(0, Math.round((a.endsAt - nowServer) / 1000));
}

function renderTimer() {
  const idle = $('#timerIdle');
  const active = $('#timerActive');
  if (!S.active) {
    idle.classList.remove('hidden');
    active.classList.add('hidden');
    document.title = '学习工作站';
    return;
  }
  idle.classList.add('hidden');
  active.classList.remove('hidden');
  $('#timerTaskTitle').textContent = S.active.taskTitle;
  const paused = S.active.pausedRemainingSec !== null && S.active.pausedRemainingSec !== undefined;
  $('#btnPause').textContent = paused ? '继续' : '暂停';
  const ext = S.active.extensionSec || 0;
  $('#timerFoot').textContent =
    `计划 ${Math.round(S.active.durationSec / 60)} 分钟`
    + (ext ? `（含延长 ${Math.round(ext / 60)} 分钟）` : '')
    + ` · 开始于 ${fmtDate(S.active.startedAt).slice(5, 16)}`;
  tickTimer();
}

function tickTimer() {
  if (!S.active) return;
  const paused = S.active.pausedRemainingSec !== null && S.active.pausedRemainingSec !== undefined;
  const rem = remainingNow();
  const ring = $('#ringFg');
  const ratio = S.active.durationSec > 0 ? Math.min(1, rem / S.active.durationSec) : 0;
  ring.style.strokeDashoffset = String(RING_LEN * (1 - ratio));
  ring.classList.toggle('is-paused', paused);
  ring.classList.toggle('is-done', rem <= 0 && !paused);
  $('#timeText').textContent = fmtClock(rem);
  $('#timeHint').textContent = paused ? '已暂停' : (rem <= 0 ? '时间到' : '剩余时间');
  document.title = `${fmtClock(rem)} · ${S.active.taskTitle}`;

  if (rem <= 0 && !paused && !S.finishHandled) {
    S.finishHandled = true;
    beep();
    openRecordModal('completed');
  }
}

async function startTask(taskId, minutes) {
  try {
    await api('POST', '/api/timer/start', { taskId, minutes });
    S.finishHandled = false;
    await refresh();
    toast('开始专注，加油！', 'ok');
  } catch (err) { fail(err); }
}

function taskModal(task) {
  const isEdit = Boolean(task);
  const t = task || { title: '', minutes: 25, noteId: null };
  const noteOptions = S.notes
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, 'zh'))
    .map((n) => `<option value="${n.id}" ${t.noteId === n.id ? 'selected' : ''}>${esc(n.title)}</option>`)
    .join('');
  const presets = [5, 15, 25, 45, 60, 90];
  const modal = openModal(modalShell({
    title: isEdit ? '编辑任务' : '新建任务',
    okText: isEdit ? '保存' : '创建',
    body: `
      <div class="field">
        <label>要做什么</label>
        <input class="input" id="mTitle" maxlength="200" placeholder="例如：背 30 个单词 / 看完第三章" value="${esc(t.title)}">
      </div>
      <div class="field">
        <label>需要的时间（分钟）</label>
        <input class="input" id="mMinutes" type="number" min="1" max="1440" value="${t.minutes}">
        <div class="preset-row" id="mPresets">
          ${presets.map((p) => `<button type="button" class="preset ${p === t.minutes ? 'is-active' : ''}" data-min="${p}">${p} 分钟</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>关联笔记（可选）</label>
        <select class="select" id="mNote">
          <option value="">不关联</option>
          ${noteOptions}
        </select>
        <span class="modal-hint">关联后，计时结束可以把这次的学习记录直接追加到这篇笔记里。</span>
      </div>`,
  }));

  modal.querySelector('#mPresets').addEventListener('click', (e) => {
    const b = e.target.closest('.preset');
    if (!b) return;
    modal.querySelector('#mMinutes').value = b.dataset.min;
    $$('.preset', modal).forEach((p) => p.classList.toggle('is-active', p === b));
  });

  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    const title = modal.querySelector('#mTitle').value.trim();
    const minutes = Number(modal.querySelector('#mMinutes').value);
    const noteId = modal.querySelector('#mNote').value || null;
    if (!title) { toast('请填写任务名称', 'err'); return; }
    if (!Number.isFinite(minutes) || minutes < 1) { toast('请填写有效的分钟数', 'err'); return; }
    try {
      if (isEdit) await api('PATCH', `/api/tasks/${task.id}`, { title, minutes, noteId });
      else await api('POST', '/api/tasks', { title, minutes, noteId });
      closeModal();
      await refresh();
      toast(isEdit ? '已保存' : '任务已创建', 'ok');
    } catch (err) { fail(err); }
  });

  modal.querySelector('#mTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modal.querySelector('[data-modal="ok"]').click();
  });
}

function openRecordModal(outcome) {
  const a = S.active;
  if (!a) return;
  const plannedSec = a.durationSec;
  const actualSec = outcome === 'completed'
    ? plannedSec
    : Math.max(0, Math.min(plannedSec, a.elapsedSec || 0));
  const linked = a.noteId ? S.notes.find((n) => n.id === a.noteId) : null;

  const modal = openModal(modalShell({
    title: outcome === 'completed' ? '⏰ 时间到，记录一下这次学习' : '结束这次专注',
    okText: '保存记录',
    cancelText: '跳过记录',
    body: `
      <div class="modal-hint">
        任务：<b>${esc(a.taskTitle)}</b>　·　实际专注 ${fmtMinutes(actualSec)}
        ${outcome === 'completed' ? '（已完成计划）' : ''}
      </div>
      <div class="field">
        <label>这次学到了什么 / 做到哪一步了？（可不填）</label>
        <textarea class="input" id="rNote" rows="4" placeholder="例如：第 3 章看完，但矩阵秩的定义还有点模糊"></textarea>
      </div>
      ${linked ? `<label class="check"><input type="checkbox" id="rAppend" checked> 把这段记录追加到笔记「${esc(linked.title)}」末尾</label>` : ''}`,
  }));

  let done = false;
  const finish = async (note, append) => {
    if (done) return;
    done = true;
    try {
      await api('POST', '/api/timer/stop', { outcome, note, actualSec });
      if (append && note && linked) {
        const full = await api('GET', `/api/notes/${linked.id}`);
        const stamp = fmtDate(Date.now());
        const block = `\n\n---\n\n**${stamp} · 学习记录（${fmtMinutes(actualSec)}）**\n\n${note}\n`;
        await api('PATCH', `/api/notes/${linked.id}`, { content: (full.note.content || '') + block });
      }
      closeModal();
      S.finishHandled = false;
      await refresh();
      toast(outcome === 'completed' ? '这次专注已完成 🎉' : '已结束并记录', 'ok');
    } catch (err) { done = false; fail(err); }
  };

  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    const noteEl = modal.querySelector('#rNote');
    const appendEl = modal.querySelector('#rAppend');
    const note = noteEl ? noteEl.value.trim() : '';
    if (act.dataset.modal === 'cancel') await finish(note, appendEl ? appendEl.checked : false);
    else await finish(note, appendEl ? appendEl.checked : false);
  });
}

/* ---------------------------------------------------------------- */
/* 灵感                                                              */
/* ---------------------------------------------------------------- */

function renderInspirations() {
  const box = $('#inspireList');
  const kw = S.inspireSearch.trim().toLowerCase();
  let items = S.inspirations.slice();
  if (kw) items = items.filter((i) => i.text.toLowerCase().includes(kw));
  if (S.onlyUnconverted) items = items.filter((i) => !i.convertedNoteId || !S.notes.some((n) => n.id === i.convertedNoteId));
  items.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.createdAt - a.createdAt;
  });

  $('#inspireEmpty').classList.toggle('hidden', items.length > 0 || S.inspirations.length > 0);
  $('#inspireEmpty').textContent = S.inspirations.length
    ? '没有符合条件的灵感。'
    : '还没有灵感记录。想到什么就往上写，一句话也行。';

  box.innerHTML = items.map((i) => {
    const linked = i.convertedNoteId ? S.notes.find((n) => n.id === i.convertedNoteId) : null;
    return `
      <div class="insp-card ${i.pinned ? 'is-pinned' : ''}" data-id="${i.id}">
        <div class="insp-text" data-role="text">${esc(i.text)}</div>
        <div class="insp-foot">
          ${i.pinned ? '<span class="tag">置顶</span>' : ''}
          <span>${fmtRelative(i.createdAt)}</span>
          ${linked ? `<span class="tag-done">✓ 已转成笔记「${esc(linked.title)}」</span>` : ''}
          <span class="spacer"></span>
          <button class="mini" data-act="edit">编辑</button>
          <button class="mini" data-act="pin">${i.pinned ? '取消置顶' : '置顶'}</button>
          <button class="mini" data-act="copy">复制</button>
          <button class="mini" data-act="tonote">转为笔记</button>
          <button class="mini danger" data-act="del">删除</button>
        </div>
      </div>`;
  }).join('');
}

async function saveInspiration() {
  const input = $('#inspireInput');
  const text = input.value.trim();
  if (!text) { toast('先写点什么吧', 'err'); return; }
  try {
    await api('POST', '/api/inspirations', { text, pinned: $('#inspirePin').checked });
    input.value = '';
    $('#inspirePin').checked = false;
    await refresh();
    toast('已记下', 'ok');
  } catch (err) { fail(err); }
}

function toNoteModal(item) {
  const options = S.notebooks
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    .map((nb) => `<option value="${nb.id}">${esc(nb.name)}</option>`)
    .join('');
  const defaultTitle = item.text.split('\n')[0].slice(0, 40);
  const modal = openModal(modalShell({
    title: '把灵感转成笔记',
    okText: '创建笔记',
    body: `
      <div class="field">
        <label>笔记标题</label>
        <input class="input" id="tTitle" maxlength="200" value="${esc(defaultTitle)}">
      </div>
      <div class="field">
        <label>放到哪个笔记本</label>
        <select class="select" id="tNb">
          <option value="">未分类</option>
          ${options}
        </select>
      </div>
      <div class="modal-hint">灵感原文会作为笔记正文。转好之后会自动跳到笔记页面打开它。</div>`,
  }));

  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    try {
      const res = await api('POST', `/api/inspirations/${item.id}/to-note`, {
        title: modal.querySelector('#tTitle').value.trim(),
        notebookId: modal.querySelector('#tNb').value || null,
      });
      closeModal();
      await refresh();
      S.nbFilter = res.note.notebookId || 'none';
      switchView('notes');
      await openNote(res.note.id);
      toast('已生成笔记，可以继续补充了', 'ok');
    } catch (err) { fail(err); }
  });
}

/* ---------------------------------------------------------------- */
/* 笔记本                                                            */
/* ---------------------------------------------------------------- */

function notebookPath(id) {
  const parts = [];
  let cur = S.notebooks.find((n) => n.id === id);
  let guard = 0;
  while (cur && guard++ < 50) {
    parts.unshift(cur.name);
    cur = cur.parentId ? S.notebooks.find((n) => n.id === cur.parentId) : null;
  }
  return parts.join(' / ');
}

function renderNotebooks() {
  const box = $('#notebookTree');
  const direct = {};
  for (const n of S.notes) {
    const key = n.notebookId || '__none__';
    direct[key] = (direct[key] || 0) + 1;
  }
  const children = {};
  for (const nb of S.notebooks) {
    const key = nb.parentId || '__root__';
    (children[key] = children[key] || []).push(nb);
  }
  const totalOf = (id) => {
    let sum = direct[id] || 0;
    for (const c of (children[id] || [])) sum += totalOf(c.id);
    return sum;
  };

  const rows = [];
  const walk = (parentKey, depth) => {
    const list = (children[parentKey] || []).slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const nb of list) {
      const kids = children[nb.id] || [];
      const collapsed = S.collapsed.has(nb.id);
      rows.push(`
        <div class="nb-row ${S.nbFilter === nb.id ? 'is-active' : ''}" data-id="${nb.id}" style="padding-left:${8 + depth * 14}px">
          <span class="nb-caret" data-act="toggle">${kids.length ? (collapsed ? '▸' : '▾') : ''}</span>
          <span class="nb-name" title="${esc(notebookPath(nb.id))}">${esc(nb.name)}</span>
          <span class="nb-count">${totalOf(nb.id) || ''}</span>
          <span class="row-actions">
            <button class="mini" data-act="addsub" title="新建子笔记本">＋</button>
            <button class="mini" data-act="rename" title="重命名">✎</button>
            <button class="mini danger" data-act="del" title="删除">✕</button>
          </span>
        </div>`);
      if (!collapsed) walk(nb.id, depth + 1);
    }
  };
  walk('__root__', 0);

  const uncat = direct.__none__ || 0;
  const empty = !rows.length;
  box.innerHTML = (empty
    ? '<div class="modal-hint" style="padding:14px 8px">还没有笔记本。点右上角「+ 新建」，先建一个大学科，例如「数学」。</div>'
    : rows.join(''))
    + (uncat || S.nbFilter === 'none' ? `
    <div class="nb-row ${S.nbFilter === 'none' ? 'is-active' : ''}" data-id="__none__" style="padding-left:8px">
      <span class="nb-caret"></span>
      <span class="nb-name">未分类</span>
      <span class="nb-count">${uncat}</span>
    </div>` : '');
  $('#btnAllNotes').style.color = S.nbFilter === 'all' ? 'var(--brand)' : '';
  $('#btnAllNotes').style.borderColor = S.nbFilter === 'all' ? 'var(--brand)' : '';
}

function notebookModal({ parentId = null, notebook = null } = {}) {
  const isEdit = Boolean(notebook);
  const options = S.notebooks
    .filter((nb) => nb.id !== (notebook && notebook.id))
    .map((nb) => `<option value="${nb.id}" ${(notebook ? notebook.parentId : parentId) === nb.id ? 'selected' : ''}>${esc(notebookPath(nb.id))}</option>`)
    .join('');
  const modal = openModal(modalShell({
    title: isEdit ? '重命名 / 移动笔记本' : (parentId ? '新建子笔记本' : '新建笔记本'),
    okText: isEdit ? '保存' : '创建',
    body: `
      <div class="field">
        <label>名称</label>
        <input class="input" id="nbName" maxlength="100" value="${esc(notebook ? notebook.name : '')}" placeholder="例如：线性代数">
      </div>
      <div class="field">
        <label>上级笔记本</label>
        <select class="select" id="nbParent">
          <option value="">（顶层）</option>
          ${options}
        </select>
      </div>`,
  }));

  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    const name = modal.querySelector('#nbName').value.trim();
    const parent = modal.querySelector('#nbParent').value || null;
    if (!name) { toast('请填写名称', 'err'); return; }
    try {
      if (isEdit) await api('PATCH', `/api/notebooks/${notebook.id}`, { name, parentId: parent });
      else await api('POST', '/api/notebooks', { name, parentId: parent });
      closeModal();
      await refresh();
      toast('已保存', 'ok');
    } catch (err) { fail(err); }
  });
}

async function deleteNotebook(id) {
  const nb = S.notebooks.find((n) => n.id === id);
  const answer = await askConfirm({
    title: '删除笔记本',
    message: `确定删除笔记本「${esc(nb.name)}」吗？它下面的子笔记本也会一起删除。`,
    okText: '连带笔记一起删除',
    extra: '<button class="btn" data-modal="keepnotes">只删笔记本，笔记移到未分类</button>',
  });
  if (answer === 'cancel') return;
  try {
    const res = await api('DELETE', `/api/notebooks/${id}`, { keepNotes: answer === 'keepnotes' });
    if (S.nbFilter === id) S.nbFilter = 'all';
    await refresh();
    toast(res.removedNotes ? `已删除，含 ${res.removedNotes} 篇笔记` : '已删除', 'ok');
  } catch (err) { fail(err); }
}

/* ---------------------------------------------------------------- */
/* 笔记                                                              */
/* ---------------------------------------------------------------- */

function visibleNotes() {
  let list = S.notes.slice();
  if (S.nbFilter === 'none') list = list.filter((n) => !n.notebookId);
  else if (S.nbFilter !== 'all') {
    const ids = new Set([S.nbFilter]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const nb of S.notebooks) {
        if (nb.parentId && ids.has(nb.parentId) && !ids.has(nb.id)) { ids.add(nb.id); grew = true; }
      }
    }
    list = list.filter((n) => n.notebookId && ids.has(n.notebookId));
  }
  const kw = S.noteSearch.trim().toLowerCase();
  if (kw) list = list.filter((n) => (n.title || '').toLowerCase().includes(kw) || (n.excerpt || '').toLowerCase().includes(kw));
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

function renderNoteList() {
  const list = visibleNotes();
  $('#noteListTitle').textContent = S.nbFilter === 'all' ? '全部笔记'
    : S.nbFilter === 'none' ? '未分类' : notebookPath(S.nbFilter);
  const box = $('#noteList');
  if (!list.length) {
    box.innerHTML = '<div class="modal-hint" style="padding:14px 6px">这里还没有笔记。</div>';
    return;
  }
  box.innerHTML = list.map((n) => `
    <div class="note-card ${S.activeNoteId === n.id ? 'is-active' : ''}" data-id="${n.id}">
      <div class="nc-title">${esc(n.title || '未命名笔记')}</div>
      <div class="nc-ex">${esc(n.excerpt || '（空白）')}</div>
      <div class="nc-date">${fmtRelative(n.updatedAt)}</div>
    </div>`).join('');
}

function renderEditor() {
  const has = Boolean(S.editing);
  $('#editorEmpty').classList.toggle('hidden', has);
  $('#editorBody').classList.toggle('hidden', !has);
  if (!has) return;
  const n = S.editing;
  const titleEl = $('#noteTitle');
  const contentEl = $('#noteContent');
  if (document.activeElement !== titleEl) titleEl.value = n.title || '';
  if (document.activeElement !== contentEl) contentEl.value = n.content || '';

  const sel = $('#noteNotebook');
  sel.innerHTML = '<option value="">未分类</option>' + S.notebooks
    .slice()
    .sort((a, b) => notebookPath(a.id).localeCompare(notebookPath(b.id), 'zh'))
    .map((nb) => `<option value="${nb.id}" ${n.notebookId === nb.id ? 'selected' : ''}>${esc(notebookPath(nb.id))}</option>`)
    .join('');

  const src = n.sourceInspirationId ? S.inspirations.find((i) => i.id === n.sourceInspirationId) : null;
  $('#noteMeta').innerHTML = [
    `创建于 ${fmtDate(n.createdAt)}`,
    `更新于 ${fmtRelative(n.updatedAt)}`,
    src ? '💡 来自灵感速记' : '',
  ].filter(Boolean).join(' · ');
  const previewing = !$('#notePreview').classList.contains('hidden');
  if (previewing) $('#notePreview').innerHTML = mdToHtml(n.content || '');
}

async function openNote(id) {
  await flushSave();
  try {
    const res = await api('GET', `/api/notes/${id}`);
    S.editing = res.note;
    S.activeNoteId = id;
    setHash(`#notes/${id}`);
    renderNoteList();
    renderEditor();
  } catch (err) { fail(err); }
}

function scheduleSave() {
  S.dirty = true;
  $('#saveHint').textContent = '正在输入…';
  $('#saveHint').classList.remove('is-saving');
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(flushSave, 700);
}

async function flushSave() {
  clearTimeout(S.saveTimer);
  S.saveTimer = null;
  if (!S.dirty || !S.editing) return;
  const note = S.editing;
  const title = $('#noteTitle').value;
  const content = $('#noteContent').value;
  S.dirty = false;
  $('#saveHint').textContent = '保存中…';
  $('#saveHint').classList.add('is-saving');
  try {
    const res = await api('PATCH', `/api/notes/${note.id}`, { title, content });
    note.title = res.note.title;
    note.content = res.note.content;
    note.updatedAt = res.note.updatedAt;
    const summary = S.notes.find((n) => n.id === note.id);
    if (summary) {
      summary.title = res.note.title;
      summary.updatedAt = res.note.updatedAt;
      summary.excerpt = excerptOf(content);
    }
    $('#saveHint').textContent = '已保存';
    $('#saveHint').classList.remove('is-saving');
    renderNoteList();
    if (!$('#notePreview').classList.contains('hidden')) $('#notePreview').innerHTML = mdToHtml(content);
  } catch (err) {
    S.dirty = true;
    $('#saveHint').textContent = '保存失败';
    fail(err);
  }
}

async function createNote() {
  try {
    const notebookId = S.nbFilter === 'all' || S.nbFilter === 'none' ? null : S.nbFilter;
    const res = await api('POST', '/api/notes', {
      title: '未命名笔记',
      content: '',
      notebookId,
    });
    await refresh();
    await openNote(res.note.id);
    $('#noteTitle').focus();
    $('#noteTitle').select();
  } catch (err) { fail(err); }
}

/* Markdown 渲染见 public/markdown.js（挂载为全局 mdToHtml，可单测） */

/* ---------------------------------------------------------------- */
/* 事件绑定                                                          */
/* ---------------------------------------------------------------- */

function bind() {
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchView(tab.dataset.view);
  });

  $('#btnHelp').addEventListener('click', () => {
    openModal(modalShell({
      title: '使用说明',
      okText: '知道了',
      cancelText: '',
      body: `<div class="kbd-help">
        <p><b>专注</b>点「+ 新建任务」，写下要做的事和需要的分钟数，然后点「开始」。</p>
        <p><b>计时中</b>可以暂停、+5 分钟、结束并记录，或直接放弃。</p>
        <p><b>灵感</b>想到什么就直接写，<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 快速保存。</p>
        <p><b>转笔记</b>灵感右下角的「转为笔记」可以一键变成正式笔记。</p>
        <p><b>笔记</b>左侧先建笔记本（可层层嵌套），再在里面写笔记，自动保存。</p>
        <p><b>关联</b>新建任务时可以选一篇笔记，计时结束的记录能追加进去。</p>
        <p><b>数据</b>全部保存在程序目录的 <code>data</code> 文件夹里，复制走就是备份。</p>
        <p class="maker-line">✦ 本软件由 WUST 的 qwwz 定制</p>
      </div>`,
    })).addEventListener('click', (e) => {
      if (e.target.closest('[data-modal]')) closeModal();
    });
  });

  $('#modalRoot').addEventListener('mousedown', (e) => {
    if (e.target.id === 'modalRoot') closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement === $('#inspireInput')) {
      e.preventDefault(); saveInspiration();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (S.editing) flushSave().then(() => toast('已保存', 'ok'));
    }
  });

  /* --- 专注 --- */
  $('#btnNewTask').addEventListener('click', () => taskModal(null));
  $('#taskList').addEventListener('click', async (e) => {
    const li = e.target.closest('.task-item');
    if (!li) return;
    const task = S.tasks.find((t) => t.id === li.dataset.id);
    const act = e.target.closest('[data-act]');
    const action = act ? act.dataset.act : 'start';
    if (action === 'edit') return taskModal(task);
    if (action === 'del') {
      const yes = await askConfirm({
        title: '删除任务',
        message: `确定删除任务「${esc(task.title)}」吗？已经产生的学习记录会保留。`,
        okText: '删除',
      });
      if (yes !== 'ok') return;
      try { await api('DELETE', `/api/tasks/${task.id}`); await refresh(); toast('已删除', 'ok'); } catch (err) { fail(err); }
      return;
    }
    if (S.active) { toast('已经有正在进行的计时了', 'err'); return; }
    return startTask(task.id);
  });

  $('#btnPause').addEventListener('click', async () => {
    if (!S.active) return;
    const paused = S.active.pausedRemainingSec !== null && S.active.pausedRemainingSec !== undefined;
    try {
      await api('POST', paused ? '/api/timer/resume' : '/api/timer/pause');
      await refresh();
    } catch (err) { fail(err); }
  });

  $('#btnExtend').addEventListener('click', async () => {
    try { await api('POST', '/api/timer/extend', { minutes: 5 }); await refresh(); toast('已延长 5 分钟', 'ok'); } catch (err) { fail(err); }
  });

  $('#btnFinish').addEventListener('click', () => { if (S.active) openRecordModal('stopped'); });
  $('#btnAbandon').addEventListener('click', async () => {
    if (!S.active) return;
    const yes = await askConfirm({
      title: '放弃这次计时',
      message: '这次专注不会计入学习记录，确定放弃吗？',
      okText: '放弃',
    });
    if (yes !== 'ok') return;
    try {
      await api('POST', '/api/timer/stop', { outcome: 'stopped', note: '', actualSec: 0 });
      S.finishHandled = false;
      await refresh();
      toast('已放弃');
    } catch (err) { fail(err); }
  });

  /* --- 灵感 --- */
  $('#btnSaveInspire').addEventListener('click', saveInspiration);
  $('#inspireSearch').addEventListener('input', (e) => { S.inspireSearch = e.target.value; renderInspirations(); });
  $('#onlyUnconverted').addEventListener('change', (e) => { S.onlyUnconverted = e.target.checked; renderInspirations(); });

  $('#inspireList').addEventListener('click', async (e) => {
    const card = e.target.closest('.insp-card');
    if (!card) return;
    const item = S.inspirations.find((i) => i.id === card.dataset.id);
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const action = act.dataset.act;
    if (action === 'pin') {
      try { await api('PATCH', `/api/inspirations/${item.id}`, { pinned: !item.pinned }); await refresh(); } catch (err) { fail(err); }
    } else if (action === 'del') {
      try { await api('DELETE', `/api/inspirations/${item.id}`); await refresh(); toast('已删除', 'ok'); } catch (err) { fail(err); }
    } else if (action === 'copy') {
      try { await navigator.clipboard.writeText(item.text); toast('已复制到剪贴板', 'ok'); } catch { toast('复制失败，请手动选中', 'err'); }
    } else if (action === 'tonote') {
      toNoteModal(item);
    } else if (action === 'edit') {
      const div = card.querySelector('[data-role="text"]');
      const modal = openModal(modalShell({
        title: '编辑灵感',
        okText: '保存',
        body: `<textarea class="input" id="iText" rows="6">${esc(item.text)}</textarea>`,
      }));
      modal.addEventListener('click', async (ev) => {
        const a = ev.target.closest('[data-modal]');
        if (!a) return;
        if (a.dataset.modal === 'cancel') { closeModal(); return; }
        const text = modal.querySelector('#iText').value.trim();
        if (!text) { toast('内容不能为空', 'err'); return; }
        try { await api('PATCH', `/api/inspirations/${item.id}`, { text }); closeModal(); await refresh(); toast('已保存', 'ok'); } catch (err) { fail(err); }
      });
      void div;
    }
  });

  /* --- 笔记本 --- */
  $('#btnNewNotebook').addEventListener('click', () => notebookModal({}));
  $('#btnAllNotes').addEventListener('click', () => { S.nbFilter = 'all'; renderNotebooks(); renderNoteList(); });
  $('#notebookTree').addEventListener('click', async (e) => {
    const row = e.target.closest('.nb-row');
    if (!row) return;
    const id = row.dataset.id;
    const act = e.target.closest('[data-act]');
    const action = act ? act.dataset.act : 'open';

    if (id === '__none__') { S.nbFilter = 'none'; renderNotebooks(); renderNoteList(); return; }
    const nb = S.notebooks.find((n) => n.id === id);
    if (!nb) return;

    if (action === 'toggle') {
      if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
      renderNotebooks();
      return;
    }
    if (action === 'addsub') { notebookModal({ parentId: id }); return; }
    if (action === 'rename') { notebookModal({ notebook: nb }); return; }
    if (action === 'del') { await deleteNotebook(id); return; }
    S.nbFilter = id;
    renderNotebooks();
    renderNoteList();
  });

  /* --- 笔记 --- */
  $('#btnNewNote').addEventListener('click', createNote);
  $('#noteSearch').addEventListener('input', (e) => { S.noteSearch = e.target.value; renderNoteList(); });
  $('#noteList').addEventListener('click', (e) => {
    const card = e.target.closest('.note-card');
    if (card) openNote(card.dataset.id);
  });
  $('#noteTitle').addEventListener('input', scheduleSave);
  $('#noteContent').addEventListener('input', scheduleSave);
  $('#noteNotebook').addEventListener('change', async (e) => {
    if (!S.editing) return;
    try {
      await flushSave();
      await api('PATCH', `/api/notes/${S.editing.id}`, { notebookId: e.target.value || null });
      await refresh();
      toast('已移动', 'ok');
    } catch (err) { fail(err); }
  });
  $('#btnPreview').addEventListener('click', () => {
    if (!S.editing) return;
    const pv = $('#notePreview');
    const showing = !pv.classList.contains('hidden');
    if (showing) {
      pv.classList.add('hidden');
      $('#noteContent').classList.remove('hidden');
      $('#btnPreview').textContent = '预览';
    } else {
      pv.innerHTML = mdToHtml($('#noteContent').value);
      pv.classList.remove('hidden');
      $('#noteContent').classList.add('hidden');
      $('#btnPreview').textContent = '编辑';
    }
  });
  $('#btnDeleteNote').addEventListener('click', async () => {
    if (!S.editing) return;
    const yes = await askConfirm({
      title: '删除笔记',
      message: `确定删除笔记「${esc(S.editing.title)}」吗？此操作不可撤销。`,
      okText: '删除',
    });
    if (yes !== 'ok') return;
    try {
      S.dirty = false;
      await api('DELETE', `/api/notes/${S.editing.id}`);
      S.editing = null;
      S.activeNoteId = null;
      await refresh();
      toast('已删除', 'ok');
    } catch (err) { fail(err); }
  });

  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

/* ---------------------------------------------------------------- */
/* 启动                                                              */
/* ---------------------------------------------------------------- */

async function boot() {
  bind();
  try {
    await refresh();
  } catch (err) {
    fail(err);
    return;
  }
  const wanted = (location.hash || '').replace('#', '');
  const view = wanted.split('/')[0];
  if (['focus', 'inspire', 'notes'].includes(view)) switchView(view);
  const wantedNote = wanted.startsWith('notes/') ? wanted.slice('notes/'.length) : '';
  if (wantedNote) await openNote(wantedNote);
  setInterval(tickTimer, 250);
  setInterval(async () => {
    // 每 60 秒和服务端对一次表，多标签页/服务器重启后也能保持同步
    try {
      const data = await api('GET', '/api/all');
      const hadActive = S.active && S.active.id;
      const hasActive = data.active && data.active.id;
      S.clockOffset = data.serverTime - Date.now();
      if (!hadActive && hasActive && !S.activeNoteId) {
        await refresh();
      } else if (hadActive !== hasActive || (hadActive && S.active.id !== data.active.id)) {
        S.active = data.active;
        S.sessions = data.sessions;
        S.finishHandled = false;
        renderTimer();
        renderTasks();
        $('#todayStat').textContent = `今日 ${Math.round(todaySeconds() / 60)} 分钟`;
      }
    } catch { /* 网络抖动忽略 */ }
  }, 60000);
}

boot();
