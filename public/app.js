/* ===================== 学习工作站 · 前端逻辑 ===================== */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

const RING_LEN = 2 * Math.PI * 98;

/** 前端期望的服务端接口版本。对不上说明「页面」和「服务」不是同一版。 */
const EXPECTED_API_VERSION = 3;

const S = {
  tasks: [],
  active: null,
  sessions: [],
  inspirations: [],
  notebooks: [],
  notes: [],
  health: null,
  storage: null,
  versionMismatch: false,
  clockOffset: 0,
  activeNoteId: null,
  editing: null,          // 当前打开的完整笔记
  nbFilter: 'all',        // 'all' | 'none' | notebookId
  collapsed: new Set(),
  noteSearch: '',
  inspireSearch: '',
  onlyUnconverted: false,
  recordRange: 'today',   // 'today' | 'week' | 'all'
  fullscreen: false,
  setupGender: 'male',
  setupEditing: false,
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
  S.tasks = data.tasks || [];
  S.active = data.active || null;
  S.sessions = data.sessions || [];
  S.inspirations = data.inspirations || [];
  S.notebooks = data.notebooks || [];
  S.notes = data.notes || [];
  S.health = data.health || null;
  S.storage = data.storage || null;
  checkApiVersion(data);
  if (!keepNote) S.editing = null;
  renderAll();
}

/**
 * 页面和服务不是同一版时，旧服务缺字段会让页面直接崩。
 * 这里统一拦一道，给出人话提示，而不是抛一堆 undefined 报错。
 */
function checkApiVersion(data) {
  const got = data.apiVersion;
  if (got === EXPECTED_API_VERSION) {
    $('#versionWarn').classList.add('hidden');
    S.versionMismatch = false;
    return;
  }
  S.versionMismatch = true;
  const warn = $('#versionWarn');
  warn.classList.remove('hidden');
  $('#versionWarnText').innerHTML = got === undefined
    ? '检测到<b>程序还在跑旧版本</b>：请双击桌面的「停止学习工作站」，再双击「学习工作站」重启一次，页面就能正常用了。'
    : `页面版本（${EXPECTED_API_VERSION}）和正在运行的服务版本（${got}）不一致，请重启程序。`;
}

function renderAll() {
  renderTasks();
  renderTimer();
  renderRecords();
  renderInspirations();
  renderNotebooks();
  renderNoteList();
  renderEditor();
  renderBody();
  $('#todayStat').textContent = `今日 ${Math.round(todaySeconds() / 60)} 分钟`;
}

function switchView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  if (!location.hash.startsWith(`#${name}`)) setHash(`#${name}`);
  if (name === 'notes') renderEditor();
  if (name === 'body') renderBody();
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

/** 只有倒计时走完（outcome === 'completed'）才算完成一次；中断的不计入。 */
function sessionCountOf(taskId) {
  return S.sessions.filter((s) => s.taskId === taskId && s.outcome === 'completed').length;
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
}

/* ---------------- 学习记录 ---------------- */

function recordsInRange() {
  const list = S.sessions;
  if (S.recordRange === 'all') return list;
  if (S.recordRange === 'today') {
    const t = localDateStr();
    return list.filter((s) => localDateStr(new Date(s.endedAt)) === t);
  }
  const from = Date.now() - 6 * 86400000;
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  return list.filter((s) => s.endedAt >= start.getTime());
}

function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function renderRecords() {
  const all = recordsInRange();
  const list = $('#sessionList');
  const totalSec = all.reduce((s, x) => s + (x.actualSec || 0), 0);
  const doneCount = all.filter((x) => x.outcome === 'completed').length;
  const stopCount = all.length - doneCount;

  $('#sessionCount').textContent = S.sessions.length ? `（全部 ${S.sessions.length} 条）` : '';
  $('#recordStats').innerHTML = all.length ? `
    <div class="stat"><span class="stat-num">${fmtMinutes(totalSec)}</span><span class="stat-label">累计时长</span></div>
    <div class="stat"><span class="stat-num">${all.length}</span><span class="stat-label">记录条数</span></div>
    <div class="stat"><span class="stat-num" style="color:#1f8a5b">${doneCount}</span><span class="stat-label">完整完成</span></div>
    <div class="stat"><span class="stat-num" style="color:#b4762a">${stopCount}</span><span class="stat-label">中途中断</span></div>
  ` : '<div class="stat"><span class="stat-label">这个时间段还没有记录。</span></div>';

  if (!all.length) {
    list.innerHTML = '<div class="record-day" style="border:0">完成一次专注后，记录会自动出现在这里。</div>';
    return;
  }

  let html = '';
  let lastDay = '';
  for (const s of all) {
    const day = localDateStr(new Date(s.endedAt));
    if (day !== lastDay) {
      lastDay = day;
      html += `<div class="record-day">${day}　${'周' + '日一二三四五六'[new Date(s.endedAt).getDay()]}</div>`;
    }
    const done = s.outcome === 'completed';
    html += `
      <div class="record-row" data-id="${s.id}">
        <span class="r-badge ${done ? 'done' : 'stop'}">${done ? '完成' : '中断'}</span>
        <div class="r-main">
          <div class="r-title">${esc(s.title)}</div>
          ${s.note ? `<div class="r-note">💭 ${esc(s.note)}</div>` : ''}
        </div>
        <span class="r-time">${fmtMinutes(s.actualSec || 0)} · ${fmtDate(s.endedAt).slice(11, 16)}</span>
      </div>`;
  }
  list.innerHTML = html;
}

function recordDetailModal(session) {
  const task = S.tasks.find((t) => t.id === session.taskId);
  const note = session.noteId ? S.notes.find((n) => n.id === session.noteId) : null;
  const done = session.outcome === 'completed';
  const modal = openModal(modalShell({
    title: '学习记录详情',
    okText: '关闭',
    cancelText: '',
    body: `
      <div class="metric-grid" style="padding:0;grid-template-columns:repeat(2,1fr)">
        <div class="metric"><span class="m-label">结果</span><span class="m-value" style="font-size:15px;color:${done ? '#1f8a5b' : '#b4762a'}">${done ? '完整完成' : '中途中断'}</span></div>
        <div class="metric"><span class="m-label">实际专注</span><span class="m-value" style="font-size:15px">${fmtMinutes(session.actualSec || 0)}</span></div>
        <div class="metric"><span class="m-label">计划时长</span><span class="m-value" style="font-size:15px">${fmtMinutes(session.plannedSec || 0)}</span></div>
        <div class="metric"><span class="m-label">开始时间</span><span class="m-value" style="font-size:15px">${fmtDate(session.startedAt).slice(5, 16)}</span></div>
      </div>
      <div class="field"><label>任务</label><div>${esc(session.title)}</div></div>
      ${task ? `<div class="modal-hint">这个任务目前完整完成 ${sessionCountOf(task.id)} 次。</div>` : ''}
      <div class="field"><label>当时写下的心得</label><div class="detail-note">${session.note ? esc(session.note) : '（没写）'}</div></div>
      ${note ? `<div class="field"><label>关联笔记</label><div><a href="#notes/${note.id}" data-open-note="${note.id}">📄 ${esc(note.title)}</a></div></div>` : ''}`,
  }));
  modal.addEventListener('click', (e) => {
    const link = e.target.closest('[data-open-note]');
    if (link) {
      e.preventDefault();
      closeModal();
      switchView('notes');
      openNote(link.dataset.openNote);
      return;
    }
    if (e.target.closest('[data-modal]')) closeModal();
  });
}

async function deleteRecord(session) {
  const yes = await askConfirm({
    title: '删除这条学习记录',
    message: `确定删除「${esc(session.title)}」这条记录吗？删掉后它不再计入统计。`,
    okText: '删除',
  });
  if (yes !== 'ok') return;
  try {
    await api('DELETE', `/api/sessions/${session.id}`);
    await refresh();
    toast('记录已删除', 'ok');
  } catch (err) { fail(err); }
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
  const fs = $('#fullscreenTimer');
  if (!S.active) {
    idle.classList.remove('hidden');
    active.classList.add('hidden');
    document.title = '学习工作站';
    if (S.fullscreen) exitFullscreenTimer();
    return;
  }
  idle.classList.add('hidden');
  active.classList.remove('hidden');
  $('#timerTaskTitle').textContent = S.active.taskTitle;
  const paused = S.active.pausedRemainingSec !== null && S.active.pausedRemainingSec !== undefined;
  $('#btnPause').textContent = paused ? '继续' : '暂停';
  $('#fsPause').textContent = paused ? '继续' : '暂停';
  $('#fsTask').textContent = S.active.taskTitle;
  const ext = S.active.extensionSec || 0;
  $('#timerFoot').textContent =
    `计划 ${Math.round(S.active.durationSec / 60)} 分钟`
    + (ext ? `（含延长 ${Math.round(ext / 60)} 分钟）` : '')
    + ` · 开始于 ${fmtDate(S.active.startedAt).slice(5, 16)}`;
  fs.classList.toggle('hidden', !S.fullscreen);
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

  if (S.fullscreen) {
    $('#fsTime').textContent = fmtClock(rem);
    $('#fsHint').textContent = paused ? '已暂停' : (rem <= 0 ? '时间到' : `计划 ${Math.round(S.active.durationSec / 60)} 分钟`);
    const spent = 1 - ratio;
    const bar = $('#fsBar');
    bar.style.width = `${Math.max(0, Math.min(100, spent * 100))}%`;
    bar.classList.toggle('is-paused', paused);
  }

  if (rem <= 0 && !paused && !S.finishHandled) {
    S.finishHandled = true;
    beep();
    openRecordModal('completed');
  }
}

function enterFullscreenTimer() {
  if (!S.active) { toast('先开始一个任务再全屏吧', 'err'); return; }
  S.fullscreen = true;
  $('#fullscreenTimer').classList.remove('hidden');
  tickTimer();
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => { /* 用户拒绝也没关系，页面内全屏照样用 */ });
}

function exitFullscreenTimer() {
  S.fullscreen = false;
  $('#fullscreenTimer').classList.add('hidden');
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
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
    .map((nb) => `<option value="${nb.id}">${esc(notebookPath(nb.id))}</option>`)
    .join('');
  const noteOptions = S.notes
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((n) => `<option value="${n.id}">${esc(n.title)}${n.notebookId ? `（${esc(notebookPath(n.notebookId))}）` : ''}</option>`)
    .join('');
  const suggested = item.text.split('\n')[0].slice(0, 40);

  const modal = openModal(modalShell({
    title: '把灵感处理成笔记',
    okText: '确定',
    body: `
      <div class="seg" id="tMode" style="align-self:flex-start">
        <button class="seg-btn is-active" data-mode="new">新建一篇笔记</button>
        <button class="seg-btn" data-mode="append">追加到已有笔记</button>
      </div>

      <div id="tPaneNew">
        <div class="field">
          <label>笔记标题 <span style="color:var(--red)">*</span></label>
          <input class="input" id="tTitle" maxlength="200" placeholder="自己起一个标题，别和正文一样">
          <span class="modal-hint">建议写「这件事叫什么」，而不是把正文原样抄一遍。</span>
        </div>
        <div class="field">
          <label>放到哪个笔记本</label>
          <select class="select" id="tNb">
            <option value="">未分类</option>
            ${options}
          </select>
        </div>
      </div>

      <div id="tPaneAppend" class="hidden">
        <div class="field">
          <label>追加到哪篇笔记的末尾 <span style="color:var(--red)">*</span></label>
          <select class="select" id="tNote">
            <option value="">— 请选择一篇笔记 —</option>
            ${noteOptions}
          </select>
          <span class="modal-hint">灵感原文会带上时间戳追加到这篇笔记结尾，适合把零散想法归到同一个主题下。</span>
        </div>
      </div>

      <div class="field">
        <label>正文预览</label>
        <div class="detail-note">${esc(item.text)}</div>
      </div>`,
  }));

  let mode = 'new';
  $('#tMode', modal).addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    mode = b.dataset.mode;
    $$('.seg-btn', $('#tMode', modal)).forEach((x) => x.classList.toggle('is-active', x === b));
    $('#tPaneNew', modal).classList.toggle('hidden', mode !== 'new');
    $('#tPaneAppend', modal).classList.toggle('hidden', mode !== 'append');
    modal.querySelector('[data-modal="ok"]').textContent = mode === 'new' ? '创建笔记' : '追加过去';
  });

  // 标题留空时给出建议值，点一下就能填上
  const titleEl = $('#tTitle', modal);
  titleEl.addEventListener('focus', () => {
    if (!titleEl.dataset.touched && !titleEl.value) {
      titleEl.placeholder = `例如：${suggested}`;
    }
  });
  titleEl.addEventListener('input', () => { titleEl.dataset.touched = '1'; });

  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    try {
      if (mode === 'new') {
        const title = titleEl.value.trim();
        if (!title) { toast('请先给笔记起一个标题', 'err'); titleEl.focus(); return; }
        const res = await api('POST', `/api/inspirations/${item.id}/to-note`, {
          title,
          notebookId: $('#tNb', modal).value || null,
        });
        closeModal();
        await refresh();
        S.nbFilter = res.note.notebookId || 'none';
        switchView('notes');
        await openNote(res.note.id);
        toast('已生成笔记，可以继续补充了', 'ok');
      } else {
        const noteId = $('#tNote', modal).value;
        if (!noteId) { toast('请选择要追加到的笔记', 'err'); return; }
        const res = await api('POST', `/api/inspirations/${item.id}/append-to-note`, { noteId });
        closeModal();
        await refresh();
        S.nbFilter = res.note.notebookId || 'none';
        switchView('notes');
        await openNote(res.note.id);
        toast('已追加到笔记末尾', 'ok');
      }
    } catch (err) { fail(err); }
  });

  titleEl.focus();
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
/* 身体管理                                                          */
/* ---------------------------------------------------------------- */

/**
 * 常见食物参考值（千卡 + 三大营养素克数）。
 * 数值为常见份量的近似值；蛋白质/碳水按 4 kcal/g、脂肪按 9 kcal/g 折算后与总热量大致吻合。
 */
const FOOD_PRESETS = [
  { name: '米饭 1 碗', kcal: 200, proteinG: 4, carbsG: 44, fatG: 0.4 },
  { name: '馒头 1 个', kcal: 220, proteinG: 7, carbsG: 47, fatG: 1 },
  { name: '面条 1 碗', kcal: 280, proteinG: 9, carbsG: 55, fatG: 2 },
  { name: '包子 1 个', kcal: 200, proteinG: 7, carbsG: 30, fatG: 5 },
  { name: '鸡蛋 1 个', kcal: 70, proteinG: 6, carbsG: 0.5, fatG: 5 },
  { name: '牛奶 250ml', kcal: 135, proteinG: 7, carbsG: 10, fatG: 7 },
  { name: '豆浆 1 杯', kcal: 80, proteinG: 5, carbsG: 6, fatG: 3 },
  { name: '酸奶 1 杯', kcal: 100, proteinG: 5, carbsG: 12, fatG: 3 },
  { name: '鸡胸肉 100g', kcal: 133, proteinG: 25, carbsG: 0, fatG: 3 },
  { name: '炒青菜 1 份', kcal: 120, proteinG: 3, carbsG: 8, fatG: 8 },
  { name: '苹果 1 个', kcal: 90, proteinG: 0.4, carbsG: 23, fatG: 0.3 },
  { name: '香蕉 1 根', kcal: 90, proteinG: 1, carbsG: 22, fatG: 0.3 },
  { name: '全麦面包 1 片', kcal: 80, proteinG: 4, carbsG: 14, fatG: 1 },
  { name: '奶茶 1 杯', kcal: 350, proteinG: 3, carbsG: 60, fatG: 11 },
  { name: '薯条 中份', kcal: 320, proteinG: 4, carbsG: 40, fatG: 15 },
  { name: '可乐 330ml', kcal: 140, proteinG: 0, carbsG: 35, fatG: 0 },
];

/** 常见运动的 MET 值（代谢当量）。消耗 = MET × 体重kg × 小时数。 */
const EXERCISE_PRESETS = [
  { name: '快走', met: 3.5 },
  { name: '慢跑', met: 7.0 },
  { name: '跑步 8km/h', met: 8.3 },
  { name: '骑车', met: 6.8 },
  { name: '游泳', met: 6.0 },
  { name: '跳绳', met: 12.3 },
  { name: '力量训练', met: 5.0 },
  { name: 'HIIT', met: 8.0 },
  { name: '瑜伽', met: 2.5 },
  { name: '拉伸', met: 2.3 },
  { name: '羽毛球', met: 5.5 },
  { name: '篮球', met: 6.5 },
  { name: '爬楼梯', met: 8.8 },
  { name: '乒乓球', met: 4.0 },
];

const PRESET_MINUTES = 30;

/** 三大营养素展示配置。饼图按「各自贡献的热量」算占比。 */
const MACROS = [
  { key: 'proteinG', label: '蛋白质', color: '#3f6ef0', kcalPerG: 4 },
  { key: 'carbsG', label: '碳水', color: '#d99326', kcalPerG: 4 },
  { key: 'fatG', label: '脂肪', color: '#d9534f', kcalPerG: 9 },
];

function foodKcal(p) { return p.kcal; }
function exerciseKcal(met, weightKg, minutes = PRESET_MINUTES) {
  if (!weightKg) return 0;
  return Math.round(met * weightKg * (minutes / 60));
}

/** 内置食物标签 + 自己存的食物标签，统一成一种结构。 */
function allFoodTags() {
  const custom = (S.health && S.health.customFoods) || [];
  return [
    ...FOOD_PRESETS.map((p, i) => ({ ...p, id: `builtin-${i}`, builtin: true, customIndex: null })),
    ...custom.map((p, i) => ({
      id: p.id,
      name: p.name,
      kcal: p.kcal,
      proteinG: p.proteinG || 0,
      carbsG: p.carbsG || 0,
      fatG: p.fatG || 0,
      builtin: false,
      customIndex: i,
    })),
  ];
}

function allExerciseTags() {
  const custom = (S.health && S.health.customBurns) || [];
  const w = S.health && S.health.computed ? S.health.computed.latestWeightKg : null;
  return [
    ...EXERCISE_PRESETS.map((p, i) => ({
      id: `builtin-${i}`,
      name: p.name,
      kcal: exerciseKcal(p.met, w),
      minutes: PRESET_MINUTES,
      met: p.met,
      builtin: true,
      customIndex: null,
    })),
    ...custom.map((p, i) => ({
      id: p.id,
      name: p.name,
      kcal: p.kcal,
      minutes: p.minutes,
      builtin: false,
      customIndex: i,
    })),
  ];
}

/* ---------------- 档案 ---------------- */

function setupGenderSet(g) {
  S.setupGender = g;
  $$('#setupGender .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.gender === g));
}

function fillActivityOptions(selected) {
  const sel = $('#setupActivity');
  const levels = (S.health && S.health.activityLevels) || [];
  sel.innerHTML = levels.map((l) => `<option value="${l.id}" ${l.id === selected ? 'selected' : ''}>${esc(l.label)}　×${l.factor}</option>`).join('');
}

function openSetup(editing) {
  S.setupEditing = editing;
  const p = (S.health && S.health.profile) || null;
  $('#setupTitle').textContent = editing ? '编辑基本档案' : '先花 30 秒，填一下你的基本情况';
  $('#setupHint').textContent = editing
    ? '改了身高、体重、年龄、性别都会立刻影响基础代谢和每日总消耗的计算结果。'
    : '身高、体重用来算基础代谢和 BMI；性别和年龄是基础代谢公式必需的参数。这些数据只存在你自己电脑上。';
  $('#bodySetup').classList.remove('hidden');
  $('#bodyMain').classList.add('hidden');
  $('#btnSetupCancel').classList.toggle('hidden', !editing);

  setupGenderSet(p ? p.gender : 'male');
  $('#setupAge').value = p ? p.age : '';
  $('#setupHeight').value = p ? p.heightCm : '';
  $('#setupWeight').value = '';
  $('#setupTarget').value = p && p.targetWeightKg != null ? p.targetWeightKg : '';
  fillActivityOptions(p ? p.activity : 'sedentary');
  if (editing && S.health && S.health.computed) {
    $('#setupWeight').placeholder = `当前 ${S.health.computed.latestWeightKg} 公斤，改了会新增一条记录`;
  } else {
    $('#setupWeight').placeholder = '例如 65.5';
  }
  setTimeout(() => $('#setupAge').focus(), 30);
}

async function saveSetup() {
  const age = Number($('#setupAge').value);
  const heightCm = Number($('#setupHeight').value);
  const weightRaw = $('#setupWeight').value.trim();
  const target = $('#setupTarget').value.trim();
  if (!Number.isFinite(age) || age < 5 || age > 120) { toast('请填写有效年龄', 'err'); return; }
  if (!Number.isFinite(heightCm) || heightCm < 80 || heightCm > 250) { toast('请填写有效身高（厘米）', 'err'); return; }
  if (!S.setupEditing && !weightRaw) { toast('请填写当前体重', 'err'); return; }
  try {
    await api('PUT', '/api/health/profile', {
      gender: S.setupGender,
      age,
      heightCm,
      activity: $('#setupActivity').value,
      targetWeightKg: target === '' ? null : Number(target),
      weightKg: weightRaw === '' ? undefined : Number(weightRaw),
    });
    await refresh();
    toast(S.setupEditing ? '档案已更新' : '档案已保存，开始记录吧', 'ok');
  } catch (err) { fail(err); }
}

/* ---------------- 概览 ---------------- */

function renderMetrics() {
  const h = S.health;
  const c = h.computed;
  const box = $('#metricGrid');
  if (!c) {
    box.innerHTML = '<div class="metric" style="grid-column:1/-1"><span class="m-label">还没有体重记录，先记一次体重就能算出基础代谢。</span></div>';
    $('#goalBars').innerHTML = '';
    return;
  }
  const t = h.today;
  const netVsTdee = c.tdee != null ? t.netKcal - c.tdee : null;
  box.innerHTML = `
    <div class="metric is-primary">
      <span class="m-label">基础代谢 BMR</span>
      <span class="m-value">${c.bmr ?? '—'}<small>千卡/天</small></span>
      <span class="m-sub">躺着不动也要消耗的</span>
    </div>
    <div class="metric">
      <span class="m-label">每日总消耗 TDEE</span>
      <span class="m-value">${c.tdee ?? '—'}<small>千卡</small></span>
      <span class="m-sub">BMR × 活动系数 ${c.activityFactor}</span>
    </div>
    <div class="metric">
      <span class="m-label">BMI</span>
      <span class="m-value">${c.bmi ?? '—'}<small>${esc(c.bmiLabel)}</small></span>
      <span class="m-sub">${c.latestWeightKg} kg / 身高 ${h.profile.heightCm} cm</span>
    </div>
    <div class="metric">
      <span class="m-label">今日净摄入</span>
      <span class="m-value">${t.netKcal}<small>千卡</small></span>
      <span class="m-sub">摄入 ${t.intakeKcal} − 消耗 ${t.burnKcal}</span>
    </div>
    <div class="metric">
      <span class="m-label">对比每日总消耗</span>
      <span class="m-value" style="color:${netVsTdee == null ? '' : netVsTdee > 0 ? 'var(--red)' : 'var(--green)'}">
        ${netVsTdee == null ? '—' : (netVsTdee > 0 ? '+' : '') + netVsTdee}<small>千卡</small>
      </span>
      <span class="m-sub">${netVsTdee == null ? '需要档案' : netVsTdee > 0 ? '今天盈余了' : '今天有缺口'}</span>
    </div>
    <div class="metric">
      <span class="m-label">体重变化</span>
      <span class="m-value" style="color:${c.weightDelta > 0 ? 'var(--red)' : c.weightDelta < 0 ? 'var(--green)' : ''}">
        ${c.weightDelta > 0 ? '+' : ''}${c.weightDelta}<small>kg</small>
      </span>
      <span class="m-sub">${c.targetRemainKg == null ? `起始 ${c.firstWeightKg} kg` : (c.targetRemainKg > 0 ? `距目标还差 ${c.targetRemainKg} kg` : '已达成目标 🎉')}</span>
    </div>`;

  const tdeeGoal = c.tdee != null ? c.tdee + t.burnKcal : null;
  const bars = [];
  if (tdeeGoal) {
    const pct = Math.min(100, Math.round((t.intakeKcal / tdeeGoal) * 100));
    bars.push(`
      <div class="goal-bar">
        <div class="gb-head"><span>今日摄入</span><span>${t.intakeKcal} / ${tdeeGoal} 千卡（还能吃 ${t.intakeLeftKcal}）</span></div>
        <div class="gb-track"><div class="gb-fill ${t.intakeKcal > tdeeGoal ? 'is-over' : ''}" style="width:${pct}%"></div></div>
      </div>`);
  }
  const wGoal = h.goals.waterMl || 0;
  if (wGoal > 0) {
    const pct = Math.min(100, Math.round((t.waterMl / wGoal) * 100));
    bars.push(`
      <div class="goal-bar">
        <div class="gb-head"><span>今日喝水</span><span>${t.waterMl} / ${wGoal} ml</span></div>
        <div class="gb-track"><div class="gb-fill ${t.waterMl >= wGoal ? 'is-ok' : ''}" style="width:${pct}%"></div></div>
      </div>`);
  }
  if (h.goals.burnKcal) {
    const pct = Math.min(100, Math.round((t.burnKcal / h.goals.burnKcal) * 100));
    bars.push(`
      <div class="goal-bar">
        <div class="gb-head"><span>今日运动消耗</span><span>${t.burnKcal} / ${h.goals.burnKcal} 千卡</span></div>
        <div class="gb-track"><div class="gb-fill ${t.burnKcal >= h.goals.burnKcal ? 'is-ok' : ''}" style="width:${pct}%"></div></div>
      </div>`);
  }
  $('#goalBars').innerHTML = bars.join('');
}

/* ---------------- 体重曲线 ---------------- */

function renderWeightChart() {
  const box = $('#weightChart');
  const list = S.health.weights;
  if (list.length < 2) {
    box.innerHTML = `<div class="chart-empty">
      ${list.length ? '再记一次体重就能看到变化曲线了。' : '还没有体重记录，点右上角「+ 记录体重」。'}
    </div>`;
    $('.chart-legend') && ($('.chart-legend').innerHTML = '');
    return;
  }

  const W = 620; const H = 190;
  const padL = 42; const padR = 14; const padT = 16; const padB = 26;
  const vals = list.map((w) => w.kg);
  const target = S.health.computed ? S.health.computed.targetWeightKg : null;
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (target != null) { min = Math.min(min, target); max = Math.max(max, target); }
  if (max - min < 1) { max += 0.5; min -= 0.5; }
  const span = max - min;
  min -= span * 0.12;
  max += span * 0.12;

  const n = list.length;
  const xOf = (i) => padL + (n === 1 ? 0 : (i * (W - padL - padR)) / (n - 1));
  const yOf = (kg) => padT + (1 - (kg - min) / (max - min)) * (H - padT - padB);

  const pts = list.map((w, i) => `${xOf(i).toFixed(1)},${yOf(w.kg).toFixed(1)}`);
  const area = `${padL},${H - padB} ${pts.join(' ')} ${xOf(n - 1).toFixed(1)},${H - padB}`;

  const gridLines = [0, 0.5, 1].map((f) => {
    const kg = min + (max - min) * f;
    const y = yOf(kg);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#eef0f3" stroke-width="1"/>
            <text x="${padL - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#98a1b0">${kg.toFixed(1)}</text>`;
  }).join('');

  const targetLine = target == null ? '' : `
    <line x1="${padL}" y1="${yOf(target).toFixed(1)}" x2="${W - padR}" y2="${yOf(target).toFixed(1)}"
          stroke="#2ea36b" stroke-width="1.5" stroke-dasharray="5 4"/>
    <text x="${W - padR}" y="${(yOf(target) - 5).toFixed(1)}" text-anchor="end" font-size="11" fill="#2ea36b">目标 ${target} kg</text>`;

  const dots = list.map((w, i) => `
    <circle cx="${xOf(i).toFixed(1)}" cy="${yOf(w.kg).toFixed(1)}" r="3.4" fill="#fff" stroke="#3f6ef0" stroke-width="2">
      <title>${w.date}　${w.kg} kg${w.note ? '　' + w.note : ''}</title>
    </circle>`).join('');

  const last = list[n - 1];
  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="体重变化曲线">
      ${gridLines}
      <polygon points="${area}" fill="#3f6ef0" opacity="0.09"/>
      <polyline points="${pts.join(' ')}" fill="none" stroke="#3f6ef0" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      ${targetLine}
      ${dots}
      <text x="${padL}" y="${H - 7}" font-size="11" fill="#98a1b0">${list[0].date}</text>
      <text x="${W - padR}" y="${H - 7}" text-anchor="end" font-size="11" fill="#98a1b0">${last.date}</text>
    </svg>`;
}

function renderWeightList() {
  const list = S.health.weights.slice().reverse();
  const box = $('#weightList');
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = list.map((w, i) => {
    const prev = list[i + 1];
    const delta = prev ? Math.round((w.kg - prev.kg) * 10) / 10 : null;
    return `
      <div class="weight-row" data-id="${w.id}">
        <span class="w-date">${w.date.slice(5)}</span>
        <span class="w-kg">${w.kg} kg</span>
        ${delta !== null && delta !== 0 ? `<span class="w-delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}</span>` : ''}
        <span class="w-note">${esc(w.note || '')}</span>
        <button class="mini danger" data-act="del">删除</button>
      </div>`;
  }).join('');
}

/* ---------------- 摄入 / 消耗 / 喝水 ---------------- */

/** 标签：点一下记账；自己存的标签（非内置）右上角有个小 × 可以删掉。 */
function chipHtml(tag, kind) {
  const attr = kind === 'food' ? `data-food="${tag.id}"` : `data-ex="${tag.id}"`;
  const macros = kind === 'food'
    ? `蛋白 ${tag.proteinG}g · 碳水 ${tag.carbsG}g · 脂肪 ${tag.fatG}g`
    : `${tag.minutes || PRESET_MINUTES} 分钟`;
  const title = `${tag.name}　${tag.kcal} 千卡　${macros}`;
  const del = tag.builtin
    ? ''
    : `<span class="chip-del" data-del-tag="${tag.id}" data-kind="${kind}" title="删除这个自定义标签">×</span>`;
  return `<button class="chip${tag.builtin ? '' : ' is-custom'}" ${attr} title="${esc(title)}">${esc(tag.name)}<span class="chip-kcal">${tag.kcal}</span>${del}</button>`;
}

function renderPresetChips() {
  $('#foodPresets').innerHTML = allFoodTags().map((t) => chipHtml(t, 'food')).join('');
  $('#burnPresets').innerHTML = allExerciseTags().map((t) => chipHtml(t, 'exercise')).join('');
}

/* ---------------- 三大营养素饼图 ---------------- */

function renderMacros() {
  const m = S.health && S.health.macros;
  const box = $('#macroChart');
  if (!box) return;
  if (!m) {
    // 服务是旧版本时不会有 macros，这里给出提示而不是报错
    box.innerHTML = '<div class="chart-empty">程序需要重启一次才能显示营养素面板</div>';
    const st = $('#macroStatus');
    if (st) st.innerHTML = '<div class="macro-source">检测到正在运行的服务是旧版本，请双击桌面「停止学习工作站」后再双击「学习工作站」重新打开。</div>';
    return;
  }

  const total = m.kcalTotal;
  const R = 54;
  const CX = 62;
  const CY = 62;
  const STROKE = 22;

  if (!total) {
    box.innerHTML = `
      <svg viewBox="0 0 124 124" class="donut">
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#eef0f3" stroke-width="${STROKE}"/>
        <text x="${CX}" y="${CY - 2}" text-anchor="middle" font-size="15" font-weight="700" fill="#98a1b0">—</text>
        <text x="${CX}" y="${CY + 15}" text-anchor="middle" font-size="10" fill="#98a1b0">还没有摄入</text>
      </svg>`;
  } else {
    const circumference = 2 * Math.PI * R;
    let offset = 0;
    const slices = MACROS.map((mac) => {
      const val = m.kcal[mac.key] || 0;
      const frac = val / total;
      const len = frac * circumference;
      const seg = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none"
          stroke="${mac.color}" stroke-width="${STROKE}"
          stroke-dasharray="${len.toFixed(2)} ${(circumference - len).toFixed(2)}"
          stroke-dashoffset="${(-offset).toFixed(2)}"
          transform="rotate(-90 ${CX} ${CY})"><title>${mac.label} ${val} 千卡（${Math.round(frac * 100)}%）</title></circle>`;
      offset += len;
      return seg;
    }).join('');
    const pct = MACROS.map((mac) => {
      const p = Math.round(((m.kcal[mac.key] || 0) / total) * 100);
      return `<span class="macro-pct"><i style="background:${mac.color}"></i>${mac.label} ${p}%</span>`;
    }).join('');
    box.innerHTML = `
      <svg viewBox="0 0 124 124" class="donut" role="img" aria-label="三大营养素供能占比">
        ${slices}
        <text x="${CX}" y="${CY - 1}" text-anchor="middle" font-size="16" font-weight="700" fill="#1f2430">${total}</text>
        <text x="${CX}" y="${CY + 14}" text-anchor="middle" font-size="9.5" fill="#98a1b0">千卡来自三大营养素</text>
      </svg>
      <div class="macro-percent">${pct}</div>`;
  }

  // 图表下面：达标情况
  const status = m.status;
  const targets = m.targets;
  const sourceLabel = targets.source === 'custom' ? '你设定的目标'
    : targets.source === 'suggested' ? '系统按体重和消耗给你算的建议值'
    : '还没有目标';
  const hasTarget = ['proteinG', 'carbsG', 'fatG'].some((k) => targets[k] != null);

  const rows = status.map((s) => {
    const pct = s.percent == null ? null : Math.min(100, s.percent);
    const cls = s.reached == null ? '' : (s.reached ? 'is-ok' : 'is-low');
    const right = s.targetG == null
      ? `${s.actualG} g`
      : `${s.actualG} / ${s.targetG} g　<span class="macro-tag ${s.reached ? 'ok' : 'low'}">${s.reached ? '已达标' : `还差 ${s.remainG} g`}</span>`;
    return `
      <div class="macro-row">
        <div class="macro-head">
          <span>${s.label}</span>
          <span>${right}</span>
        </div>
        <div class="gb-track"><div class="gb-fill ${cls}" style="width:${pct == null ? 0 : pct}%"></div></div>
      </div>`;
  }).join('');

  $('#macroStatus').innerHTML = `
    <div class="macro-source">${sourceLabel}${hasTarget ? '' : '（点「设定目标」可以自己填）'}
      ${hasTarget && m.allReached ? '<b style="color:#1f8a5b">　🎉 三大营养素今天都达标了</b>' : ''}
    </div>
    ${rows}`;
}

function renderLogs() {
  const t = S.health.today.date;
  const intake = S.health.intake.filter((r) => r.date === t);
  const burn = S.health.burn.filter((r) => r.date === t);

  $('#intakeToday').textContent = `（今天 ${S.health.today.intakeKcal} 千卡）`;
  $('#burnToday').textContent = `（今天 ${S.health.today.burnKcal} 千卡）`;
  const left = S.health.today.intakeLeftKcal;
  $('#intakeLeft').textContent = left == null ? '' : (left >= 0 ? `还能吃 ${left}` : `超出 ${-left}`);
  $('#intakeLeft').style.background = left == null ? '' : left >= 0 ? 'var(--brand-soft)' : 'var(--red-soft)';
  $('#intakeLeft').style.color = left == null ? '' : left >= 0 ? 'var(--brand)' : 'var(--red)';

  $('#intakeList').innerHTML = intake.length ? intake.map((r) => {
    const mac = [];
    if (r.proteinG) mac.push(`蛋 ${r.proteinG}`);
    if (r.carbsG) mac.push(`碳 ${r.carbsG}`);
    if (r.fatG) mac.push(`脂 ${r.fatG}`);
    return `
    <div class="log-row" data-kind="intake" data-id="${r.id}">
      <span class="l-name">${esc(r.name)}${mac.length ? `<span class="l-macros">${mac.join(' · ')}</span>` : ''}</span>
      <span class="l-kcal">${r.kcal} 千卡</span>
      <button class="mini danger" data-act="del">删除</button>
    </div>`;
  }).join('') : '<div class="log-empty">今天还没记录摄入。点上面的食物标签，或点「手动记录」。</div>';

  $('#burnList').innerHTML = burn.length ? burn.map((r) => `
    <div class="log-row" data-kind="burn" data-id="${r.id}">
      <span class="l-name">${esc(r.name)}${r.minutes ? ` · ${r.minutes} 分钟` : ''}</span>
      <span class="l-kcal burn">−${r.kcal} 千卡</span>
      <button class="mini danger" data-act="del">删除</button>
    </div>`).join('') : '<div class="log-empty">今天还没记录运动。点上面的运动标签，或手动填写。</div>';
}

function renderWater() {
  const goal = S.health.goals.waterMl || 2000;
  const drank = S.health.today.waterMl;
  const cupMl = 250;
  const cupCount = Math.max(1, Math.ceil(goal / cupMl));
  let remaining = drank;
  const cups = [];
  for (let i = 0; i < cupCount; i += 1) {
    const inCup = Math.max(0, Math.min(cupMl, remaining));
    remaining -= inCup;
    const ratio = inCup / cupMl;
    const h = 25 * ratio;
    const y = 31 - h;
    const id = `cupclip${i}`;
    cups.push(`
      <div class="cup" title="第 ${i + 1} 杯 · ${inCup}/${cupMl} ml">
        <svg viewBox="0 0 26 34">
          <clipPath id="${id}"><path d="M4 6 H22 L20 31 H6 Z"/></clipPath>
          <path d="M4 6 H22 L20 31 H6 Z" fill="#f4f7fb" stroke="#d8dee9" stroke-width="1.2"/>
          ${h > 0 ? `<rect class="cup-fill" x="0" y="${y.toFixed(1)}" width="26" height="${h.toFixed(1)}" fill="#5aa9e6" clip-path="url(#${id})"/>` : ''}
        </svg>
      </div>`);
  }
  $('#waterCups').innerHTML = cups.join('');
  const leftMl = Math.max(0, goal - drank);
  $('#waterToday').textContent = `（今天 ${drank} / ${goal} ml）`;
  const tip = $('#waterTip');
  if (tip) tip.textContent = leftMl > 0 ? `再喝 ${leftMl} ml 就达标了` : '今天的水喝够了 👍';
}

function renderBody() {
  if (!S.health) return;
  if (!S.health.profile) {
    if (!S.setupEditing) openSetup(false);
    return;
  }
  if (!S.setupEditing) {
    $('#bodySetup').classList.add('hidden');
    $('#bodyMain').classList.remove('hidden');
  }
  try {
    renderMetrics();
    renderMacros();
    renderWeightChart();
    renderWeightList();
    renderPresetChips();
    renderLogs();
    renderWater();
  } catch (err) {
    console.error('身体板块渲染失败：', err);
    if (!S.versionMismatch) {
      toast('身体板块渲染出错，可能需要重启程序', 'err');
    }
  }
}

/* ---------------- 设置：数据位置与备份 ---------------- */

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function settingsModal() {
  const st = S.storage || {};

  const modal = openModal(modalShell({
    title: '设置',
    okText: '关闭',
    cancelText: '',
    body: `
      <div class="field">
        <label>数据存放位置</label>
        <div class="storage-box" id="stBox">
          正在读取…
        </div>
      </div>
      <div class="storage-actions">
        <button class="btn sm primary" id="stBackupNow">立即备份一份</button>
        <button class="btn sm" id="stOpenFolder">打开数据文件夹</button>
        <button class="btn sm" id="stChangeDir">更改位置</button>
        ${st.isCustom ? '<button class="btn sm" id="stResetDir">改回默认位置</button>' : ''}
      </div>
      <div class="modal-hint" id="stHint"></div>`,
  }));

  const box = $('#stBox', modal);
  const paint = (info) => {
    const tag = info.fromCommandLine ? '（本次由启动参数指定）' : (info.isCustom ? '（你自定义的位置）' : '（默认位置）');
    box.innerHTML = `
      <div>当前：<code>${esc(info.dataDir || '未知')}</code>　<b>${tag}</b></div>
      <div>快照备份：<b>${info.snapshotCount || 0}</b> 份，和上面这个文件夹放在一起</div>
      <div>位置设置记在：<code>${esc(info.configFile || '（不可用）')}</code></div>
      ${info.legacyHasData ? `<div style="color:#b4762a">⚠ 程序目录里的旧 <code>data</code> 还有内容，重启后会自动复制到当前位置（原件保留，确认无误后可自行删除）。</div>` : ''}`;
  };
  if (st && st.dataDir) paint(st); else box.textContent = '读取失败，请重启程序后再试';

  $('#stBackupNow', modal).addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/storage/backup');
      await refresh();
      paint(S.storage || {});
      toast(`已备份到 _快照\\${r.name}`, 'ok');
    } catch (err) { fail(err); }
  });

  $('#stOpenFolder', modal).addEventListener('click', async () => {
    try {
      await api('POST', '/api/storage/open');
      toast('已在资源管理器里打开', 'ok');
    } catch (err) { fail(err); }
  });

  $('#stChangeDir', modal).addEventListener('click', () => {
    closeModal();
    changeDirModal();
  });

  const reset = $('#stResetDir', modal);
  if (reset) {
    reset.addEventListener('click', async () => {
      const yes = await askConfirm({
        title: '改回默认位置',
        message: '数据会重新存回「文档\\学习工作站数据」。当前位置的文件不会被删除，重启后生效。',
        okText: '改回默认',
      });
      if (yes !== 'ok') return;
      try {
        await api('POST', '/api/storage/reset');
        closeModal();
        await refresh();
        toast('已改回默认位置，重启程序后生效', 'ok');
      } catch (err) { fail(err); }
    });
  }
}

function changeDirModal() {
  const cur = (S.storage && S.storage.dataDir) || '';
  const def = (S.storage && S.storage.defaultDataDir) || '';
  const modal = openModal(modalShell({
    title: '更改数据存放位置',
    okText: '保存并重启提示',
    body: `
      <div class="field">
        <label>新位置（完整路径）</label>
        <input class="input" id="cdDir" placeholder="例如 D:\\我的学习数据" value="">
        <span class="modal-hint">
          当前：<code>${esc(cur)}</code><br>
          不填就直接用默认位置：<code>${esc(def)}</code>
        </span>
      </div>
      <div class="modal-hint">
        保存后<b>重启程序才生效</b>。重启时会把现在的数据<b>复制</b>到新位置，<b>原来位置的文件不会被删</b>，确认没问题后你可以自己清理。
      </div>
      <div class="preset-row">
        <button type="button" class="preset" id="cdUseDefault">用默认位置（文档里）</button>
      </div>`,
  }));
  setTimeout(() => $('#cdDir', modal).focus(), 40);
  $('#cdUseDefault', modal).addEventListener('click', () => { $('#cdDir', modal).value = def; });

  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    const dir = $('#cdDir', modal).value.trim();
    if (!dir) { toast('请填写路径，或点「用默认位置」', 'err'); return; }
    try {
      const r = await api('POST', '/api/storage/dir', { dir });
      closeModal();
      await refresh();
      toast(r.message || '已保存，重启程序后生效', 'ok');
    } catch (err) { fail(err); }
  });
}

/* ---------------- 身体管理的操作 ---------------- */

function addWeightModal() {
  const today = localDateStr();
  const modal = openModal(modalShell({
    title: '记录体重',
    okText: '保存',
    body: `
      <div class="row-inline">
        <div class="field">
          <label>体重（公斤）</label>
          <input class="input" id="wKg" type="number" step="0.1" min="20" max="300" placeholder="例如 64.8">
        </div>
        <div class="field">
          <label>日期</label>
          <input class="input" id="wDate" type="date" value="${today}">
        </div>
      </div>
      <div class="field">
        <label>备注（可不填）</label>
        <input class="input" id="wNote" maxlength="200" placeholder="例如：早上空腹">
      </div>
      <div class="modal-hint">同一天再记一次会覆盖当天的记录。体重变化曲线会随记录自动更新。</div>`,
  }));
  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    const kg = Number($('#wKg', modal).value);
    if (!Number.isFinite(kg) || kg < 20 || kg > 300) { toast('请填写有效体重', 'err'); return; }
    try {
      await api('POST', '/api/health/weights', {
        kg,
        date: $('#wDate', modal).value || today,
        note: $('#wNote', modal).value.trim(),
      });
      closeModal();
      await refresh();
      toast('体重已记录', 'ok');
    } catch (err) { fail(err); }
  });
  setTimeout(() => $('#wKg', modal).focus(), 40);
}

async function addIntake(name, kcal, macros) {
  try {
    await api('POST', '/api/health/intake', {
      name,
      kcal,
      proteinG: (macros && macros.proteinG) || 0,
      carbsG: (macros && macros.carbsG) || 0,
      fatG: (macros && macros.fatG) || 0,
    });
    await refresh();
    toast(`已记录 ${name} ${kcal} 千卡`, 'ok');
  } catch (err) { fail(err); }
}

async function addBurn(name, kcal, minutes) {
  try {
    await api('POST', '/api/health/burn', { name, kcal, minutes });
    await refresh();
    toast(`已记录 ${name} −${kcal} 千卡`, 'ok');
  } catch (err) { fail(err); }
}

async function addWater(ml) {
  try {
    await api('POST', '/api/health/water', { ml });
    await refresh();
    const t = S.health.today;
    if (t.waterMl >= (S.health.goals.waterMl || 0)) toast(`喝了 ${ml} ml，今天达标啦 💧`, 'ok');
    else toast(`喝了 ${ml} ml，还差 ${t.waterLeftMl} ml`, 'ok');
  } catch (err) { fail(err); }
}

function waterCustomModal() {
  const modal = openModal(modalShell({
    title: '自定义喝水量',
    okText: '记录',
    body: `<div class="field"><label>喝了多少毫升</label>
      <input class="input" id="wMl" type="number" min="1" max="5000" placeholder="例如 350"></div>`,
  }));
  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    const ml = Number($('#wMl', modal).value);
    if (!Number.isFinite(ml) || ml < 1) { toast('请填写有效水量', 'err'); return; }
    closeModal();
    await addWater(Math.round(ml));
  });
  setTimeout(() => $('#wMl', modal).focus(), 40);
}

function goalsModal() {
  const g = S.health.goals;
  const gm = g.macros || {};
  const sug = S.health.macros.suggested;
  const m = S.health.macros.targets;
  const modal = openModal(modalShell({
    title: '设定每日目标',
    okText: '保存',
    body: `
      <div class="field"><label>每日喝水目标（毫升）</label>
        <input class="input" id="gWater" type="number" min="0" max="10000" value="${g.waterMl ?? 2000}"></div>
      <div class="field"><label>每日运动消耗目标（千卡，可不填）</label>
        <input class="input" id="gBurn" type="number" min="0" max="20000" value="${g.burnKcal ?? ''}"></div>

      <div class="field">
        <label>三大营养素每日目标（克）</label>
        <div class="row-inline">
          <div class="field"><input class="input" id="gProtein" type="number" min="0" max="2000" placeholder="蛋白质" value="${gm.proteinG ?? ''}"></div>
          <div class="field"><input class="input" id="gCarbs" type="number" min="0" max="2000" placeholder="碳水" value="${gm.carbsG ?? ''}"></div>
          <div class="field"><input class="input" id="gFat" type="number" min="0" max="2000" placeholder="脂肪" value="${gm.fatG ?? ''}"></div>
        </div>
        <div class="preset-row">
          <button type="button" class="preset" id="gAuto">用系统建议值${sug ? `（蛋白 ${sug.proteinG} / 碳水 ${sug.carbsG} / 脂肪 ${sug.fatG}）` : ''}</button>
        </div>
        <span class="modal-hint">
          留空 = 用系统建议值。当前生效：蛋白质 ${m.proteinG ?? '—'} g、碳水 ${m.carbsG ?? '—'} g、脂肪 ${m.fatG ?? '—'} g。
          ${sug ? '系统建议值按体重 ×1.6 g 蛋白质、脂肪占总热量 25%、其余给碳水来算。' : '填了体重和档案后才有系统建议值。'}
        </span>
      </div>
      <div class="modal-hint">热量摄入目标默认用你的每日总消耗 TDEE，不需要单独填。</div>`,
  }));

  $('#gAuto', modal).addEventListener('click', () => {
    if (!sug) { toast('先填好档案和体重才有建议值', 'err'); return; }
    $('#gProtein', modal).value = sug.proteinG;
    $('#gCarbs', modal).value = sug.carbsG;
    $('#gFat', modal).value = sug.fatG;
  });

  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    const macroVal = (id) => {
      const v = $(id, modal).value.trim();
      return v === '' ? null : Number(v);
    };
    try {
      await api('PATCH', '/api/health/goals', {
        waterMl: Number($('#gWater', modal).value) || 0,
        burnKcal: $('#gBurn', modal).value === '' ? null : Number($('#gBurn', modal).value),
        macros: {
          proteinG: macroVal('#gProtein'),
          carbsG: macroVal('#gCarbs'),
          fatG: macroVal('#gFat'),
        },
      });
      closeModal();
      await refresh();
      toast('目标已保存', 'ok');
    } catch (err) { fail(err); }
  });
}

/* ---------------- 自定义标签 ---------------- */

function foodTagModal(existing) {
  const isEdit = Boolean(existing);
  const t = existing || { name: '', kcal: '', proteinG: '', carbsG: '', fatG: '' };
  const modal = openModal(modalShell({
    title: isEdit ? '编辑常用食物标签' : '新建常用食物标签',
    okText: '保存标签',
    body: `
      <div class="field">
        <label>标签名称</label>
        <input class="input" id="fName" maxlength="60" placeholder="例如：食堂三两米饭 / 妈妈做的红烧肉" value="${esc(t.name)}">
      </div>
      <div class="field">
        <label>热量（千卡）</label>
        <input class="input" id="fKcal" type="number" min="0" max="10000" placeholder="例如 250" value="${t.kcal === 0 ? '' : esc(String(t.kcal ?? ''))}">
      </div>
      <div class="field">
        <label>三大营养素含量（克，可不填）</label>
        <div class="row-inline">
          <div class="field"><input class="input" id="fProtein" type="number" step="0.1" min="0" placeholder="蛋白质" value="${t.proteinG === 0 ? '' : esc(String(t.proteinG ?? ''))}"></div>
          <div class="field"><input class="input" id="fCarbs" type="number" step="0.1" min="0" placeholder="碳水" value="${t.carbsG === 0 ? '' : esc(String(t.carbsG ?? ''))}"></div>
          <div class="field"><input class="input" id="fFat" type="number" step="0.1" min="0" placeholder="脂肪" value="${t.fatG === 0 ? '' : esc(String(t.fatG ?? ''))}"></div>
        </div>
        <span class="modal-hint">按 蛋白质/碳水 4 kcal/g、脂肪 9 kcal/g 折算。保存后这个标签会一直留在「常见食物」那一排，下次点一下就记账。</span>
      </div>`,
  }));
  setTimeout(() => $('#fName', modal).focus(), 40);

  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    const name = $('#fName', modal).value.trim();
    const kcal = Number($('#fKcal', modal).value);
    if (!name) { toast('请填写标签名称', 'err'); return; }
    if (!Number.isFinite(kcal) || kcal < 0 || $('#fKcal', modal).value === '') { toast('请填写热量', 'err'); return; }
    if (isEdit) {
      // 编辑＝先删旧的再存新的，保持接口简单
      try {
        await api('DELETE', `/api/health/foods/${existing.id}`);
      } catch { /* 旧的可能已经没了 */ }
    }
    try {
      await api('POST', '/api/health/foods', {
        name,
        kcal: Math.round(kcal),
        proteinG: $('#fProtein', modal).value || 0,
        carbsG: $('#fCarbs', modal).value || 0,
        fatG: $('#fFat', modal).value || 0,
      });
      closeModal();
      await refresh();
      toast('标签已保存，以后点一下就能记账', 'ok');
    } catch (err) { fail(err); }
  });
}

function exerciseTagModal(existing) {
  const isEdit = Boolean(existing);
  const t = existing || { name: '', kcal: '', minutes: 30 };
  const modal = openModal(modalShell({
    title: isEdit ? '编辑常用运动标签' : '新建常用运动标签',
    okText: '保存标签',
    body: `
      <div class="field">
        <label>标签名称</label>
        <input class="input" id="eName" maxlength="60" placeholder="例如：游泳 1000 米 / 羽毛球双打" value="${esc(t.name)}">
      </div>
      <div class="row-inline">
        <div class="field">
          <label>消耗（千卡）</label>
          <input class="input" id="eKcal" type="number" min="0" max="10000" placeholder="例如 260" value="${t.kcal === 0 ? '' : esc(String(t.kcal ?? ''))}">
        </div>
        <div class="field">
          <label>时长（分钟，可不填）</label>
          <input class="input" id="eMin" type="number" min="0" max="1440" placeholder="例如 40" value="${t.minutes ?? ''}">
        </div>
      </div>
      <span class="modal-hint">保存后这个标签会一直留在「常见运动」那一排，下次点一下就记账。</span>`,
  }));
  setTimeout(() => $('#eName', modal).focus(), 40);

  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    const name = $('#eName', modal).value.trim();
    const kcal = Number($('#eKcal', modal).value);
    if (!name) { toast('请填写标签名称', 'err'); return; }
    if (!Number.isFinite(kcal) || kcal < 0 || $('#eKcal', modal).value === '') { toast('请填写消耗热量', 'err'); return; }
    if (isEdit) {
      try { await api('DELETE', `/api/health/exercises/${existing.id}`); } catch { /* ignore */ }
    }
    try {
      await api('POST', '/api/health/exercises', {
        name,
        kcal: Math.round(kcal),
        minutes: $('#eMin', modal).value === '' ? null : Number($('#eMin', modal).value),
      });
      closeModal();
      await refresh();
      toast('标签已保存', 'ok');
    } catch (err) { fail(err); }
  });
}

async function deleteTag(kind, id) {
  const label = kind === 'food' ? '这个食物标签' : '这个运动标签';
  const yes = await askConfirm({
    title: '删除自定义标签',
    message: `确定删除${label}吗？已经记下的账不会受影响，只是以后这一排里不再显示它。`,
    okText: '删除',
  });
  if (yes !== 'ok') return;
  try {
    await api('DELETE', `/api/health/${kind === 'food' ? 'foods' : 'exercises'}/${id}`);
    await refresh();
    toast('标签已删除', 'ok');
  } catch (err) { fail(err); }
}

/* ---------------- 手动记录（可同时存成常用标签） ---------------- */

function intakeModal() {
  const modal = openModal(modalShell({
    title: '手动记录摄入',
    okText: '记录',
    body: `
      <div class="field">
        <label>吃了什么</label>
        <input class="input" id="mName" maxlength="60" placeholder="例如：食堂的番茄炒蛋">
      </div>
      <div class="field">
        <label>热量（千卡）</label>
        <input class="input" id="mKcal" type="number" min="0" max="10000" placeholder="例如 220">
      </div>
      <div class="field">
        <label>三大营养素含量（克，可不填）</label>
        <div class="row-inline">
          <div class="field"><input class="input" id="mProtein" type="number" step="0.1" min="0" placeholder="蛋白质"></div>
          <div class="field"><input class="input" id="mCarbs" type="number" step="0.1" min="0" placeholder="碳水"></div>
          <div class="field"><input class="input" id="mFat" type="number" step="0.1" min="0" placeholder="脂肪"></div>
        </div>
      </div>
      <label class="check"><input type="checkbox" id="mSaveTag"> 同时存成常用标签，下次点一下就能记</label>`,
  }));
  setTimeout(() => $('#mName', modal).focus(), 40);

  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    const name = $('#mName', modal).value.trim() || '手动填写';
    const kcalRaw = $('#mKcal', modal).value;
    const kcal = Number(kcalRaw);
    if (kcalRaw === '' || !Number.isFinite(kcal) || kcal < 0) { toast('请填写热量', 'err'); return; }
    const macros = {
      proteinG: $('#mProtein', modal).value || 0,
      carbsG: $('#mCarbs', modal).value || 0,
      fatG: $('#mFat', modal).value || 0,
    };
    try {
      if ($('#mSaveTag', modal).checked) {
        await api('POST', '/api/health/foods', { name, kcal: Math.round(kcal), ...macros });
      }
      await api('POST', '/api/health/intake', { name, kcal: Math.round(kcal), ...macros });
      closeModal();
      await refresh();
      toast(`已记录 ${name} ${Math.round(kcal)} 千卡`, 'ok');
    } catch (err) { fail(err); }
  });
}

function burnModal() {
  const modal = openModal(modalShell({
    title: '手动记录消耗',
    okText: '记录',
    body: `
      <div class="field">
        <label>做了什么运动</label>
        <input class="input" id="bName" maxlength="60" placeholder="例如：打了一小时球">
      </div>
      <div class="row-inline">
        <div class="field">
          <label>消耗（千卡）</label>
          <input class="input" id="bKcal" type="number" min="0" max="10000" placeholder="例如 320">
        </div>
        <div class="field">
          <label>时长（分钟，可不填）</label>
          <input class="input" id="bMin" type="number" min="0" max="1440" placeholder="例如 60">
        </div>
      </div>
      <label class="check"><input type="checkbox" id="bSaveTag"> 同时存成常用标签</label>`,
  }));
  setTimeout(() => $('#bName', modal).focus(), 40);

  modal.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-modal]');
    if (!act) return;
    if (act.dataset.modal === 'cancel') { closeModal(); return; }
    const name = $('#bName', modal).value.trim() || '手动填写';
    const kcalRaw = $('#bKcal', modal).value;
    const kcal = Number(kcalRaw);
    if (kcalRaw === '' || !Number.isFinite(kcal) || kcal < 0) { toast('请填写消耗热量', 'err'); return; }
    const minutes = $('#bMin', modal).value === '' ? null : Number($('#bMin', modal).value);
    try {
      if ($('#bSaveTag', modal).checked) {
        await api('POST', '/api/health/exercises', { name, kcal: Math.round(kcal), minutes });
      }
      await api('POST', '/api/health/burn', { name, kcal: Math.round(kcal), minutes });
      closeModal();
      await refresh();
      toast(`已记录 ${name} −${Math.round(kcal)} 千卡`, 'ok');
    } catch (err) { fail(err); }
  });
}

async function deleteHealthRecord(kind, id) {
  try {
    await api('DELETE', `/api/health/${kind}/${id}`);
    await refresh();
    toast('已删除', 'ok');
  } catch (err) { fail(err); }
}

/* ---------------------------------------------------------------- */
/* 事件绑定                                                          */
/* ---------------------------------------------------------------- */

function bind() {
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchView(tab.dataset.view);
  });

  $('#btnSettings').addEventListener('click', settingsModal);
  $('#btnVersionWarnClose').addEventListener('click', () => {
    $('#versionWarn').classList.add('hidden');
  });

  $('#btnHelp').addEventListener('click', () => {
    openModal(modalShell({
      title: '使用说明',
      okText: '知道了',
      cancelText: '',
      body: `<div class="kbd-help">
        <p><b>专注</b>点「+ 新建任务」，写下要做的事和需要的分钟数，然后点「开始」。</p>
        <p><b>计时中</b>可以暂停、+5 分钟、结束并记录，或直接放弃；点「⛶ 全屏」进入大屏倒计时（按 Esc 退出）。</p>
        <p><b>记录</b>右下角能按今天 / 近 7 天 / 全部查看，点任意一条看详情。<b>只有倒计时走完才算「完成」</b>，中途结束的标为「中断」，不计入任务的完成次数。</p>
        <p><b>灵感</b>想到什么就直接写，<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 快速保存。</p>
        <p><b>转笔记</b>「转为笔记」时可以自己起标题，也可以选择追加到某一篇已有笔记的末尾。</p>
        <p><b>笔记</b>左侧先建笔记本（可层层嵌套），再在里面写笔记，自动保存，<kbd>Ctrl</kbd>+<kbd>S</kbd> 手动保存。</p>
        <p><b>身体</b>填一次身高体重性别年龄，就能算出基础代谢和每日总消耗；体重曲线、运动消耗、饮食摄入、喝水都能记。</p>
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

  /* --- 全屏倒计时 --- */
  $('#btnFullscreen').addEventListener('click', enterFullscreenTimer);
  $('#fsExit').addEventListener('click', exitFullscreenTimer);
  $('#fsPause').addEventListener('click', () => $('#btnPause').click());
  $('#fsExtend').addEventListener('click', () => $('#btnExtend').click());
  $('#fsFinish').addEventListener('click', () => {
    if (S.active) { exitFullscreenTimer(); openRecordModal('stopped'); }
  });
  document.addEventListener('fullscreenchange', () => {
    // 用户按 Esc 退出系统全屏时，同步收起页面内的大屏倒计时
    if (!document.fullscreenElement && S.fullscreen) {
      S.fullscreen = false;
      $('#fullscreenTimer').classList.add('hidden');
    }
  });

  /* --- 学习记录 --- */
  $('#recordRange').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    S.recordRange = b.dataset.range;
    $$('#recordRange .seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
    renderRecords();
  });
  $('#sessionList').addEventListener('click', (e) => {
    const row = e.target.closest('.record-row');
    if (!row) return;
    const s = S.sessions.find((x) => x.id === row.dataset.id);
    if (s) recordDetailModal(s);
  });

  /* --- 身体管理 --- */
  $('#setupGender').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (b) setupGenderSet(b.dataset.gender);
  });
  $('#btnSetupSave').addEventListener('click', saveSetup);
  $('#btnSetupCancel').addEventListener('click', () => {
    S.setupEditing = false;
    renderBody();
  });
  $('#btnEditProfile').addEventListener('click', () => openSetup(true));
  $('#btnAddWeight').addEventListener('click', addWeightModal);
  $('#btnWaterGoal').addEventListener('click', goalsModal);
  $('#btnWaterCustom').addEventListener('click', waterCustomModal);

  $('.water-actions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ml]');
    if (b) addWater(Number(b.dataset.ml));
  });

  $('#btnWaterUndo').addEventListener('click', async () => {
    const today = S.health.today.date;
    const latest = S.health.water.find((r) => r.date === today);
    if (!latest) { toast('今天还没有喝水记录', 'err'); return; }
    await deleteHealthRecord('water', latest.id);
  });

  $('#foodPresets').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-tag]');
    if (del) { e.stopPropagation(); deleteTag('food', del.dataset.delTag); return; }
    const b = e.target.closest('[data-food]');
    if (!b) return;
    const tag = allFoodTags().find((t) => t.id === b.dataset.food);
    if (tag) addIntake(tag.name, tag.kcal, tag);
  });

  $('#burnPresets').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-tag]');
    if (del) { e.stopPropagation(); deleteTag('exercise', del.dataset.delTag); return; }
    const b = e.target.closest('[data-ex]');
    if (!b) return;
    const tag = allExerciseTags().find((t) => t.id === b.dataset.ex);
    if (!tag) return;
    if (!tag.builtin && !tag.kcal) { /* 自定义标签自带热量，直接用 */ }
    const w = S.health.computed ? S.health.computed.latestWeightKg : null;
    const kcal = tag.builtin ? exerciseKcal(tag.met, w) : tag.kcal;
    if (!kcal) { toast('先记录一次体重才能估算消耗', 'err'); return; }
    addBurn(tag.name, kcal, tag.minutes);
  });

  $('#btnNewFoodTag').addEventListener('click', () => foodTagModal(null));
  $('#btnManualIntake').addEventListener('click', intakeModal);
  $('#btnNewExerciseTag').addEventListener('click', () => exerciseTagModal(null));
  $('#btnManualBurn').addEventListener('click', burnModal);

  $('#intakeList').addEventListener('click', (e) => {
    const row = e.target.closest('.log-row');
    if (row && e.target.closest('[data-act="del"]')) deleteHealthRecord('intake', row.dataset.id);
  });
  $('#burnList').addEventListener('click', (e) => {
    const row = e.target.closest('.log-row');
    if (row && e.target.closest('[data-act="del"]')) deleteHealthRecord('burn', row.dataset.id);
  });
  $('#weightList').addEventListener('click', (e) => {
    const row = e.target.closest('.weight-row');
    if (row && e.target.closest('[data-act="del"]')) deleteHealthRecord('weights', row.dataset.id);
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
  if (['focus', 'inspire', 'notes', 'body'].includes(view)) switchView(view);
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
        renderRecords();
        $('#todayStat').textContent = `今日 ${Math.round(todaySeconds() / 60)} 分钟`;
      }
    } catch { /* 网络抖动忽略 */ }
  }, 60000);
}

boot();
