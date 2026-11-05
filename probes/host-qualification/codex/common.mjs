import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const stamp = () => ({ time: Date.now(), mono_ms: Number(process.hrtime.bigint()) / 1e6 });
export function log(dir, file, type, data = {}) {
  const row = { ...stamp(), pid: process.pid, type, ...data };
  fs.appendFileSync(path.join(dir, file), JSON.stringify(row) + '\n', { mode: 0o600 });
  return row;
}
export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function rows(dir, file) {
  let text;
  try { text = fs.readFileSync(path.join(dir, file), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  // A concurrent writer or a killed process may leave only the last line incomplete.
  const lines = text.split('\n');
  return lines.flatMap((line, i) => {
    if (!line) return [];
    try { return [JSON.parse(line)]; }
    catch (e) { if (i === lines.length - 1) return []; throw e; }
  });
}
export function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
export function identity(pid) {
  if (!Number.isInteger(pid) || pid < 2) throw new Error('Invalid owned PID');
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'pgid=', '-o', 'stat='],
      { encoding: 'utf8', timeout: 2000 }).trim();
    const match = value.match(/^(.*?)\s+(\d+)\s+(\S+)$/);
    if (!match) throw new Error(`Cannot read birth identity for PID ${pid}`);
    return { birth: match[1], pgid: Number(match[2]), stat: match[3] };
  } catch (e) {
    if (!alive(pid)) return null;
    throw e; // Never turn a permissions/ps failure into exit proof.
  }
}
export function register(dir, pid, role, extra = {}) {
  const id = identity(pid);
  return log(dir, 'pids.jsonl', 'spawn', { owned_pid: pid, role, ...id, ...extra });
}
export function owned(dir) {
  return [...new Map(rows(dir, 'pids.jsonl').map(r => [`${r.owned_pid}:${r.birth}`, r])).values()];
}
export function signalOwned(dir, entry, signal, cause) {
  const current = identity(entry.owned_pid);
  if (!current) return 'absent';
  if (!entry.birth || current.birth !== entry.birth || entry.owned_pid === process.pid) {
    log(dir, 'supervisor.jsonl', 'signal_refused', { entry, current, cause });
    return 'identity_mismatch';
  }
  try { process.kill(entry.owned_pid, signal); }
  catch (e) { if (e.code !== 'ESRCH') throw e; }
  log(dir, 'supervisor.jsonl', 'signal_sent', { target_pid: entry.owned_pid, role: entry.role, signal, cause });
  return 'sent';
}
export function snapshot(dir) {
  return owned(dir).map(p => ({ pid: p.owned_pid, role: p.role, execution_id: p.execution_id,
    alive: alive(p.owned_pid), heartbeat: readJSON(path.join(dir, `heartbeat-${p.owned_pid}.json`)) }));
}
export async function cleanup(dir) {
  log(dir, 'supervisor.jsonl', 'external_cleanup_started', { processes: snapshot(dir) });
  // Freeze launchers first. Only individual recorded PIDs; a new process group is not missed.
  const order = ['host', 'pty-driver', 'hook', 'server', 'worker', 'command', 'grandchild'];
  const allowed = new Set(order);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const deadline = performance.now() + 3000;
    const signalled = new Set();
    do {
      const entries = owned(dir).sort((a, b) =>
        order.indexOf(a.role) - order.indexOf(b.role));
      for (const entry of entries) {
        const key = `${entry.owned_pid}:${entry.birth}`;
        if (allowed.has(entry.role) && !signalled.has(key)) {
          signalOwned(dir, entry, signal, 'external_cleanup'); signalled.add(key);
        }
      }
      await sleep(100);
      if (owned(dir).every(p => !alive(p.owned_pid))) break;
    } while (performance.now() < deadline);
  }
  const verification = owned(dir).map(p => {
    const current = identity(p.owned_pid);
    return { pid: p.owned_pid, role: p.role, execution_id: p.execution_id, birth: p.birth,
      current, absent: current === null, same_process: !!current && p.birth === current.birth };
  });
  const result = { ...stamp(), all_absent: verification.every(p => p.absent), processes: verification };
  writeJSON(path.join(dir, 'cleanup-verification.json'), result);
  log(dir, 'supervisor.jsonl', 'cleanup_complete', { all_absent: result.all_absent });
  return result;
}
