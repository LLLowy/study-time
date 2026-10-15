/**
 * 冒烟测试：把三大模块的主要接口串一遍。
 * 用法：先启动 server.js，然后 node tools/smoke-test.mjs [端口]
 */

const PORT = Number(process.argv[2] || 7788);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let failed = 0;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.ok === false) {
    throw new Error(`${method} ${path} -> ${res.status} ${json ? json.error : ''}`);
  }
  return json.data;
}

function check(label, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, `（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

async function main() {
  console.log(`\n对 ${BASE} 运行冒烟测试\n`);

  // 取基线：测试对已有数据保持增量断言，可反复运行
  const base = await call('GET', '/api/all');
  if (base.active) {
    console.error(`\n当前有正在进行的计时（任务：${base.active.taskTitle}，剩余 ${base.active.remainingSec} 秒）。`);
    console.error('测试需要独占倒计时接口，请先在界面上结束它，然后重新运行测试。\n');
    process.exit(1);
  }
  const baseNotebooks = base.notebooks.length;
  const baseNotes = base.notes.length;
  const baseTasks = base.tasks.length;
  const baseSessions = base.sessions.length;

  /* ---------- 1. 笔记本与笔记 ---------- */
  console.log('【笔记：树形笔记本】');
  const math = (await call('POST', '/api/notebooks', { name: '数学' })).notebook;
  const linalg = (await call('POST', '/api/notebooks', { name: '线性代数', parentId: math.id })).notebook;
  const eigen = (await call('POST', '/api/notebooks', { name: '特征值', parentId: linalg.id })).notebook;
  let all = await call('GET', '/api/all');
  eq('三级笔记本建立成功', all.notebooks.length - baseNotebooks, 3);

  const note = (await call('POST', '/api/notes', {
    title: '特征值随记',
    content: '# 特征值\n\n- 定义：Av = λv\n- **重点**：行列式 |A - λI| = 0\n',
    notebookId: eigen.id,
  })).note;
  eq('笔记归属正确', note.notebookId, eigen.id);

  const fetched = await call('GET', `/api/notes/${note.id}`);
  check('笔记正文可读取', fetched.note.content.includes('Av = λv'));

  const patched = await call('PATCH', `/api/notes/${note.id}`, { title: '特征值与特征向量', content: '# 特征值\n\n更新后的正文\n' });
  eq('笔记标题可更新', patched.note.title, '特征值与特征向量');
  check('笔记正文可更新', patched.note.content.includes('更新后的正文'));
  check('更新时间被刷新', patched.note.updatedAt >= note.updatedAt);

  await call('PATCH', `/api/notebooks/${eigen.id}`, { name: '特征值分解' });
  all = await call('GET', '/api/all');
  eq('笔记本可重命名', all.notebooks.find((n) => n.id === eigen.id).name, '特征值分解');

  let cycleBlocked = false;
  try {
    await call('PATCH', `/api/notebooks/${math.id}`, { parentId: eigen.id });
  } catch {
    cycleBlocked = true;
  }
  check('拒绝把父笔记本移进自己的子孙里（防成环）', cycleBlocked);

  /* ---------- 2. 灵感 ---------- */
  console.log('\n【灵感：速记与转笔记】');
  const insp = (await call('POST', '/api/inspirations', { text: '矩阵的秩是不是就是线性无关的行数？', pinned: true })).item;
  check('灵感已保存', insp.text.includes('矩阵的秩'));
  eq('置顶生效', insp.pinned, true);

  let blankBlocked = false;
  try { await call('POST', '/api/inspirations', { text: '   ' }); } catch { blankBlocked = true; }
  check('拒绝保存空白灵感', blankBlocked);

  const converted = await call('POST', `/api/inspirations/${insp.id}/to-note`, { notebookId: linalg.id });
  check('灵感一键转成笔记', converted.note.content.includes('矩阵的秩'));
  eq('新笔记落在指定笔记本', converted.note.notebookId, linalg.id);

  all = await call('GET', '/api/all');
  eq('灵感记录了已转换的目标', all.inspirations.find((i) => i.id === insp.id).convertedNoteId, converted.note.id);
  eq('笔记总数增加 2 篇', all.notes.length - baseNotes, 2);

  await call('PATCH', `/api/inspirations/${insp.id}`, { pinned: false });
  all = await call('GET', '/api/all');
  eq('取消置顶生效', all.inspirations.find((i) => i.id === insp.id).pinned, false);

  /* ---------- 3. 任务与倒计时 ---------- */
  console.log('\n【专注：任务与倒计时】');
  const task = (await call('POST', '/api/tasks', { title: '背 30 个单词', minutes: 25, noteId: note.id })).task;
  eq('任务时长正确', task.minutes, 25);
  eq('任务关联笔记正确', task.noteId, note.id);

  let doubleStart = false;
  await call('POST', '/api/timer/start', { taskId: task.id });
  try { await call('POST', '/api/timer/start', { taskId: task.id }); } catch { doubleStart = true; }
  check('拒绝同时开启两个计时', doubleStart);

  let active = (await call('GET', '/api/all')).active;
  check('计时中剩余时间约为 1500 秒', Math.abs(active.remainingSec - 1500) <= 2, `（实际 ${active.remainingSec}）`);
  check('计时中带出任务名', active.taskTitle === '背 30 个单词');

  await new Promise((r) => setTimeout(r, 1100));
  const beforePause = (await call('GET', '/api/all')).active.remainingSec;
  check('计时在走（剩余时间减少）', beforePause < 1500, `剩余 ${beforePause}`);

  await new Promise((r) => setTimeout(r, 800));
  const paused = (await call('POST', '/api/timer/pause')).active;
  await new Promise((r) => setTimeout(r, 700));
  const stillPaused = await call('GET', '/api/all');
  eq('暂停后剩余时间不再变化', stillPaused.active.remainingSec, paused.remainingSec);
  eq('暂停期间不计入已专注时长', stillPaused.active.elapsedSec, paused.elapsedSec);

  let doublePause = false;
  try { await call('POST', '/api/timer/pause'); } catch { doublePause = true; }
  check('拒绝重复暂停', doublePause);

  const resumed = (await call('POST', '/api/timer/resume')).active;
  check('继续后恢复计时', resumed.pausedRemainingSec === null);
  const snap = await call('GET', '/api/all');
  check('继续后剩余时间在预设值附近', Math.abs(snap.active.remainingSec - paused.remainingSec) <= 2, `${snap.active.remainingSec} vs ${paused.remainingSec}`);
  const byEndsAt = Math.round((snap.active.endsAt - snap.serverTime) / 1000);
  check('前端按 endsAt 推算的剩余时间与服务端一致', Math.abs(byEndsAt - snap.active.remainingSec) <= 1, `（endsAt 推算 ${byEndsAt}，服务端 ${snap.active.remainingSec}）`);

  const extended = (await call('POST', '/api/timer/extend', { minutes: 5 })).active;
  eq('延长 5 分钟后总时长 1800 秒', extended.durationSec, 1800);

  const finished = await call('POST', '/api/timer/extend', { minutes: 1 }).then(() => call('GET', '/api/all'));
  eq('延长后仍在计时中', finished.active !== null, true);

  const session = (await call('POST', '/api/timer/stop', { outcome: 'stopped', note: '只背了 20 个，明天继续', actualSec: 300 })).session;
  eq('产生了学习记录', session.outcome, 'stopped');
  eq('记录里的实际时长正确', session.actualSec, 300);
  eq('记录里保存了心得', session.note, '只背了 20 个，明天继续');
  eq('记录关联了笔记', session.noteId, note.id);

  all = await call('GET', '/api/all');
  eq('结束后没有进行中的计时', all.active, null);
  eq('学习记录已入库', all.sessions.length - baseSessions, 1);

  /* ---------- 3b. 计时精度：暂停时间不能算进去 ---------- */
  console.log('\n【计时精度】');
  const tmp = (await call('POST', '/api/tasks', { title: '精度测试任务', minutes: 10 })).task;
  await call('POST', '/api/timer/start', { taskId: tmp.id });
  await new Promise((r) => setTimeout(r, 1200));       // 真正专注 1.2 秒
  await call('POST', '/api/timer/pause');
  await new Promise((r) => setTimeout(r, 1500));       // 暂停发呆 1.5 秒
  const pausedSnap = (await call('GET', '/api/all')).active;
  check('暂停时已专注约 1 秒', pausedSnap.elapsedSec >= 1 && pausedSnap.elapsedSec <= 2, `（实际 ${pausedSnap.elapsedSec}）`);
  await call('POST', '/api/timer/resume');
  const acc = (await call('POST', '/api/timer/stop', { outcome: 'stopped', note: '' })).session;
  check('不传实际时长时，暂停的 1.5 秒没有被算进学习记录', acc.actualSec <= 3, `（实际 ${acc.actualSec} 秒）`);
  await call('DELETE', `/api/tasks/${tmp.id}`);
  all = await call('GET', '/api/all');
  eq('精度测试数据已清理', all.sessions.length - baseSessions, 2);

  /* ---------- 4. 删除与级联 ---------- */
  console.log('\n【删除与级联】');
  await call('DELETE', `/api/tasks/${task.id}`);
  all = await call('GET', '/api/all');
  eq('任务已删除', all.tasks.length - baseTasks, 0);
  eq('学习记录保留', all.sessions.length - baseSessions, 2);

  await call('DELETE', `/api/notes/${note.id}`);
  all = await call('GET', '/api/all');
  eq('笔记已删除', all.notes.some((n) => n.id === note.id), false);
  eq('删掉 1 篇后只剩灵感转出的那篇', all.notes.length - baseNotes, 1);

  const cascade = await call('DELETE', `/api/notebooks/${math.id}`, {});
  eq('级联删除了 3 个笔记本', cascade.removedNotebooks, 3);
  all = await call('GET', '/api/all');
  eq('其下笔记一并删除', all.notes.length - baseNotes, 0);
  eq('笔记本回到基线数量', all.notebooks.length - baseNotebooks, 0);

  await call('DELETE', `/api/inspirations/${insp.id}`);
  all = await call('GET', '/api/all');
  eq('灵感已清理', all.inspirations.some((i) => i.id === insp.id), false);

  /* ---------- 5. 身体管理 ---------- */
  console.log('\n【身体管理：档案与基础代谢】');
  // 这一块需要从空白开始，所以先把已有身体数据挪走，测完再原样放回去
  const h0 = (await call('GET', '/api/all')).health;
  const hadCount = h0.weights.length + h0.intake.length + h0.burn.length + h0.water.length + (h0.profile ? 1 : 0);
  if (hadCount) console.log(`  （检测到已有身体数据 ${hadCount} 条，测试会临时清空，结束时还原）`);
  for (const r of h0.weights) await call('DELETE', `/api/health/weights/${r.id}`);
  for (const r of h0.intake) await call('DELETE', `/api/health/intake/${r.id}`);
  for (const r of h0.burn) await call('DELETE', `/api/health/burn/${r.id}`);
  for (const r of h0.water) await call('DELETE', `/api/health/water/${r.id}`);
  await call('DELETE', '/api/health/profile');

  let needProfile = false;
  try { await call('POST', '/api/health/weights', { kg: 70 }); } catch { needProfile = true; }
  check('没填档案时拒绝记录体重', needProfile);

  const prof = (await call('PUT', '/api/health/profile', {
    gender: 'male', age: 20, heightCm: 175, activity: 'moderate',
    targetWeightKg: 60, weightKg: 65.5,
  })).health;
  const expectBmrMale = Math.round(10 * 65.5 + 6.25 * 175 - 5 * 20 + 5);
  eq('男性基础代谢（Mifflin-St Jeor）正确', prof.computed.bmr, expectBmrMale);
  eq('每日总消耗 = BMR × 活动系数 1.55', prof.computed.tdee, Math.round(expectBmrMale * 1.55));
  eq('BMI 正确', prof.computed.bmi, Math.round((65.5 / (1.75 * 1.75)) * 10) / 10);
  eq('BMI 分类正确', prof.computed.bmiLabel, '正常');
  eq('距目标体重差值正确', prof.computed.targetRemainKg, 5.5);
  eq('活动强度档位齐全', prof.activityLevels.length, 5);

  const female = (await call('PUT', '/api/health/profile', {
    gender: 'female', age: 20, heightCm: 175, activity: 'sedentary', weightKg: 65.5,
  })).health;
  eq('女性基础代谢比男性低 166', female.computed.bmr, expectBmrMale - 166);
  eq('久坐的活动系数是 1.2', female.computed.activityFactor, 1.2);

  const levels = female.activityLevels.map((l) => l.factor);
  check('活动系数从 1.2 递增到 1.9', levels[0] === 1.2 && levels[4] === 1.9);

  let badGender = false;
  try { await call('PUT', '/api/health/profile', { gender: 'x', age: 20, heightCm: 175 }); } catch { badGender = true; }
  check('拒绝无效性别', badGender);
  let badHeight = false;
  try { await call('PUT', '/api/health/profile', { gender: 'male', age: 20, heightCm: 400 }); } catch { badHeight = true; }
  check('拒绝离谱身高', badHeight);

  console.log('\n【身体管理：体重记录与曲线数据】');
  for (const r of (await call('GET', '/api/all')).health.weights) {
    await call('DELETE', `/api/health/weights/${r.id}`);
  }
  await call('POST', '/api/health/weights', { kg: 66, date: '2026-01-01', note: '起点' });
  await call('POST', '/api/health/weights', { kg: 64.5, date: '2026-01-08', note: '早上空腹' });
  let wh = (await call('GET', '/api/all')).health;
  eq('体重记录按日期升序返回', wh.weights[wh.weights.length - 1].kg, 64.5);
  eq('最新体重被采用', wh.computed.latestWeightKg, 64.5);
  eq('体重变化量正确', wh.computed.weightDelta, -1.5);
  const sameDay = await call('POST', '/api/health/weights', { kg: 64, date: '2026-01-08' });
  eq('同一天重复记录会覆盖原记录', sameDay.weight.id, wh.weights[wh.weights.length - 1].id);
  wh = (await call('GET', '/api/all')).health;
  eq('覆盖后记录条数不变', wh.weights.length, 2);

  console.log('\n【身体管理：摄入 / 消耗 / 喝水】');
  const before = (await call('GET', '/api/all')).health;
  const i1 = (await call('POST', '/api/health/intake', { name: '米饭 1 碗', kcal: 200 })).record;
  await call('POST', '/api/health/intake', { name: '鸡胸肉 100g', kcal: 133 });
  const b1 = (await call('POST', '/api/health/burn', { name: '慢跑 30分钟', kcal: 240, minutes: 30 })).record;
  await call('POST', '/api/health/water', { ml: 250 });
  await call('POST', '/api/health/water', { ml: 500 });
  const hh = (await call('GET', '/api/all')).health;
  eq('今日摄入合计正确', hh.today.intakeKcal, 333);
  eq('今日消耗合计正确', hh.today.burnKcal, 240);
  eq('今日净摄入 = 摄入 − 消耗', hh.today.netKcal, 93);
  eq('今日喝水合计正确', hh.today.waterMl, 750);
  eq('消耗记录保留分钟数', b1.minutes, 30);
  check('还能吃多少 = TDEE + 运动消耗 − 已摄入',
    hh.today.intakeLeftKcal === hh.computed.tdee + 240 - 333,
    `（${hh.today.intakeLeftKcal}）`);
  check('喝水还差多少正确', hh.today.waterLeftMl === Math.max(0, hh.goals.waterMl - 750), `（${hh.today.waterLeftMl}）`);
  eq('近 7 天统计里有 7 天', hh.week.days.length, 7);

  let badKcal = false;
  try { await call('POST', '/api/health/intake', { kcal: -5 }); } catch { badKcal = true; }
  check('拒绝负数热量', badKcal);
  let badMl = false;
  try { await call('POST', '/api/health/water', { ml: 0 }); } catch { badMl = true; }
  check('拒绝 0 毫升喝水', badMl);

  const goals = (await call('PATCH', '/api/health/goals', { waterMl: 1500, burnKcal: 300 })).health;
  eq('喝水目标可修改', goals.goals.waterMl, 1500);
  eq('运动消耗目标可修改', goals.goals.burnKcal, 300);
  eq('目标修改后剩余量同步', goals.today.waterLeftMl, 750);

  await call('DELETE', `/api/health/intake/${i1.id}`);
  eq('摄入记录可删除', (await call('GET', '/api/all')).health.today.intakeKcal, 133);

  // 清理测试产生的东西，并把之前挪走的数据放回去
  const after = (await call('GET', '/api/all')).health;
  for (const r of after.intake) await call('DELETE', `/api/health/intake/${r.id}`);
  for (const r of after.burn) await call('DELETE', `/api/health/burn/${r.id}`);
  for (const r of after.water) await call('DELETE', `/api/health/water/${r.id}`);
  for (const r of after.weights) await call('DELETE', `/api/health/weights/${r.id}`);
  await call('DELETE', '/api/health/profile');
  await call('PATCH', '/api/health/goals', { waterMl: h0.goals.waterMl, burnKcal: h0.goals.burnKcal });
  if (h0.profile) {
    await call('PUT', '/api/health/profile', {
      gender: h0.profile.gender,
      age: h0.profile.age,
      heightCm: h0.profile.heightCm,
      activity: h0.profile.activity,
      targetWeightKg: h0.profile.targetWeightKg,
    });
  }
  for (const w of h0.weights) await call('POST', '/api/health/weights', { kg: w.kg, date: w.date, note: w.note });
  for (const r of h0.intake) await call('POST', '/api/health/intake', { name: r.name, kcal: r.kcal, date: r.date });
  for (const r of h0.burn) await call('POST', '/api/health/burn', { name: r.name, kcal: r.kcal, minutes: r.minutes, date: r.date });
  for (const r of h0.water) await call('POST', '/api/health/water', { ml: r.ml, date: r.date });
  const cleaned = (await call('GET', '/api/all')).health;
  eq('测试数据已清理（体重）', cleaned.weights.length, h0.weights.length);
  eq('测试数据已清理（摄入）', cleaned.intake.length, h0.intake.length);
  eq('测试数据已清理（喝水）', cleaned.water.length, h0.water.length);
  eq('原有档案已还原', Boolean(cleaned.profile), Boolean(h0.profile));
  void before;

  /* ---------- 6. 学习记录删除 ---------- */
  console.log('\n【学习记录】');
  const rtask = (await call('POST', '/api/tasks', { title: '记录测试任务', minutes: 1 })).task;
  await call('POST', '/api/timer/start', { taskId: rtask.id });
  const rec = (await call('POST', '/api/timer/stop', { outcome: 'completed', note: '测试用', actualSec: 60 })).session;
  eq('完成的记录 outcome 为 completed', rec.outcome, 'completed');
  const rec2 = await call('POST', '/api/timer/start', { taskId: rtask.id })
    .then(() => call('POST', '/api/timer/stop', { outcome: 'stopped', note: '', actualSec: 20 }))
    .then((r) => r.session);
  eq('中途结束的记录 outcome 为 stopped', rec2.outcome, 'stopped');
  const sess = (await call('GET', '/api/all')).sessions;
  check('两种记录都能区分出来',
    sess.some((s) => s.id === rec.id && s.outcome === 'completed')
    && sess.some((s) => s.id === rec2.id && s.outcome === 'stopped'));
  await call('DELETE', `/api/sessions/${rec.id}`);
  await call('DELETE', `/api/sessions/${rec2.id}`);
  await call('DELETE', `/api/tasks/${rtask.id}`);
  eq('记录可以删除', (await call('GET', '/api/all')).sessions.length - baseSessions, 2);
  let badSession = false;
  try { await call('DELETE', '/api/sessions/nope'); } catch { badSession = true; }
  check('删除不存在的记录会报错', badSession);

  /* ---------- 7. 灵感转笔记：标题与追加 ---------- */
  console.log('\n【灵感转笔记】');
  const nb = (await call('POST', '/api/notebooks', { name: '转笔记测试' })).notebook;
  const ins2 = (await call('POST', '/api/inspirations', {
    text: '第一行是灵感摘要\n第二行才是真正的内容\n第三行补充',
  })).item;

  const conv = await call('POST', `/api/inspirations/${ins2.id}/to-note`, { title: '第一行是灵感摘要', notebookId: nb.id });
  eq('新建的笔记用了指定标题', conv.note.title, '第一行是灵感摘要');
  check('标题与正文开头不再重复', !conv.note.content.startsWith('第一行是灵感摘要'),
    `（正文开头：${JSON.stringify(conv.note.content.slice(0, 16))}）`);
  check('正文保留下面的内容', conv.note.content.includes('第二行才是真正的内容'));

  const ins3 = (await call('POST', '/api/inspirations', { text: '这条要追加到已有笔记里' })).item;
  const appended = await call('POST', `/api/inspirations/${ins3.id}/append-to-note`, { noteId: conv.note.id });
  check('追加的内容进了笔记末尾', appended.note.content.includes('这条要追加到已有笔记里'));
  check('追加时保留了原有内容', appended.note.content.includes('第二行才是真正的内容'));
  const all3 = await call('GET', '/api/all');
  eq('两条灵感都标记了去向',
    all3.inspirations.filter((i) => i.id === ins2.id || i.id === ins3.id).every((i) => i.convertedNoteId === conv.note.id),
    true);
  eq('追加不会新建笔记', all3.notes.length - baseNotes, 1);

  let needNoteId = false;
  try { await call('POST', `/api/inspirations/${ins3.id}/append-to-note`, {}); } catch { needNoteId = true; }
  check('追加时必须指定目标笔记', needNoteId);

  await call('DELETE', `/api/notebooks/${nb.id}`, {});
  await call('DELETE', `/api/inspirations/${ins2.id}`);
  await call('DELETE', `/api/inspirations/${ins3.id}`);

  /* ---------- 8. 校验与错误处理 ---------- */
  console.log('\n【输入校验】');
  let badMinutes = false;
  try { await call('POST', '/api/tasks', { title: '测试', minutes: 0 }); } catch { badMinutes = true; }
  check('拒绝 0 分钟', badMinutes);

  let badTitle = false;
  try { await call('POST', '/api/tasks', { title: '  ', minutes: 25 }); } catch { badTitle = true; }
  check('拒绝空任务名', badTitle);

  let notFound = false;
  try { await call('GET', '/api/notes/nope'); } catch { notFound = true; }
  check('不存在的笔记返回错误', notFound);

  const staticRes = await fetch(`${BASE}/`);
  const html = await staticRes.text();
  check('首页可以访问', staticRes.ok && html.includes('学习工作站'));
  const cssRes = await fetch(`${BASE}/app.css`);
  check('样式表可以访问', cssRes.ok);
  const jsRes = await fetch(`${BASE}/app.js`);
  check('脚本可以访问', jsRes.ok);
  const mdRes = await fetch(`${BASE}/markdown.js`);
  check('Markdown 渲染器可以访问', mdRes.ok);
  const html2 = await (await fetch(`${BASE}/`)).text();
  check('首页引用了 Markdown 渲染器', html2.includes('/markdown.js'));
  const trav = await fetch(`${BASE}/../server.js`);
  check('阻止目录穿越读取', trav.status === 404 || trav.status === 403, `状态 ${trav.status}`);

  console.log(`\n结果：${pass} 项通过，${failed} 项失败\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n测试中断：', err.message, '\n');
  process.exit(1);
});
