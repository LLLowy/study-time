/**
 * 命令行停止服务：node tools/stop.mjs
 * 跟双击「停止.vbs」做的是同一件事——读端口和令牌，调用优雅停止接口。
 */
import { PORT_FILE, STOP_TOKEN_FILE, readTrimmed } from './paths.mjs';

async function alive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/all`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return false;
    const json = await res.json();
    return Boolean(json && json.data && json.data.notes);
  } catch { return false; }
}

const candidates = [];
const fromFile = Number(readTrimmed(PORT_FILE));
if (Number.isInteger(fromFile) && fromFile > 0) candidates.push(fromFile);
for (let p = 7788; p <= 7793; p += 1) if (!candidates.includes(p)) candidates.push(p);

let port = 0;
for (const p of candidates) {
  if (await alive(p)) { port = p; break; }
}

if (!port) {
  console.log('学习工作站当前没有在运行。');
  process.exit(0);
}

const token = readTrimmed(STOP_TOKEN_FILE);
if (!token) {
  console.error(`服务在端口 ${port} 上运行，但找不到停止令牌（.runtime/stop-token）。`);
  console.error('可以按 Ctrl+Shift+Esc 打开任务管理器，结束 node.exe 进程。');
  process.exit(1);
}

try {
  const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: 'POST',
    headers: { 'X-Stop-Token': token },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.log(`已停止学习工作站（端口 ${port}）。数据都已保存。`);
} catch (err) {
  console.error('停止失败：' + err.message);
  process.exit(1);
}
