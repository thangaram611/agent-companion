import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const readJSON = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
export function writeJSON(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function log(dir, file, event, fields = {}) {
  const row = { t: Date.now(), monoNs: process.hrtime.bigint().toString(),
    iso: new Date().toISOString(), pid: process.pid, event, ...fields };
  fs.appendFileSync(path.join(dir, file), JSON.stringify(row) + '\n', { mode: 0o600 });
  return row;
}
export function rows(dir, file) {
  let text;
  try { text = fs.readFileSync(path.join(dir, file), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  // A killed writer can leave a partial final line. Preserve that fact for analysis.
  return text.split('\n').flatMap((line, i, all) => {
    if (!line) return [];
    try { return [{ ...JSON.parse(line), source: `${file}:${i + 1}` }]; }
    catch { return [{ event: 'parse_error', source: `${file}:${i + 1}`, partialTail: i === all.length - 1 }]; }
  });
}
export function processInfo(pid) {
  if (!Number.isInteger(pid) || pid < 2) return { state: 'invalid' };
  try { process.kill(pid, 0); }
  catch (error) { return { state: error.code === 'ESRCH' ? 'absent' : 'unknown' }; }
  try {
    const text = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'stat=',
      '-o', 'pgid=', '-o', 'command='], { encoding: 'utf8', timeout: 2000,
      env: { ...process.env, LC_ALL: 'C' } }).trim();
    const match = text.match(/^(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(\d+)\s+([\s\S]+)$/);
    if (!match) return { state: 'unknown' };
    return { state: match[2].includes('Z') ? 'zombie' : 'alive', birth: match[1],
      pgid: Number(match[3]), command: match[4] };
  } catch (error) { return { state: error.status === 1 ? 'absent' : 'unknown' }; }
}
export function recordPID(dir, pid, role, extra = {}) {
  const info = processInfo(pid);
  return log(dir, 'pids.jsonl', 'spawn', { target: pid, role, birth: info.birth ?? null,
    pgid: info.pgid ?? null, ...extra });
}
export function pidRecords(dir) {
  const records = new Map();
  for (const row of rows(dir, 'pids.jsonl').filter(x => x.event === 'spawn')) {
    const old = records.get(row.target);
    if (!old || (!old.birth && row.birth)) records.set(row.target, row);
  }
  return [...records.values()];
}
export function inspectPID(dir, record) {
  const info = processInfo(record.target);
  if (info.state !== 'alive') return { ...record, state: info.state };
  const matches = !!record.birth && info.birth === record.birth && info.command.includes(dir);
  return { ...record, state: matches ? 'alive' : 'identity-unverified' };
}
export function signalPID(dir, record, signal, reason) {
  if (!pidRecords(dir).some(p => p.target === record.target && p.t === record.t))
    return { ...record, state: 'not-in-spawn-ledger' };
  const checked = inspectPID(dir, record);
  if (checked.state !== 'alive') return checked;
  log(dir, 'controller.jsonl', 'signal_sent', { target: record.target, role: record.role, signal, reason });
  try { process.kill(record.target, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  return checked;
}
export async function cleanup(dir) {
  log(dir, 'controller.jsonl', 'cleanup_start');
  const before = pidRecords(dir).map(p => inspectPID(dir, p));
  // Re-read the spawn ledger: a leaf may have been starting when cleanup began.
  for (let pass = 0; pass < 12; pass++) {
    const records = pidRecords(dir);
    for (const record of records) signalPID(dir, record, pass < 4 ? 'SIGTERM' : 'SIGKILL', 'cleanup');
    await sleep(250);
    if (pass >= 2 && pidRecords(dir).every(p => ['absent', 'zombie'].includes(inspectPID(dir, p).state))) break;
  }
  const after = pidRecords(dir).map(p => inspectPID(dir, p));
  const result = { before, after, allGone: after.every(p => ['absent', 'zombie'].includes(p.state)),
    note: 'Zombie means exited but awaiting reaping; identity-unverified is never signalled or counted gone.' };
  writeJSON(path.join(dir, 'cleanup.json'), result);
  log(dir, 'controller.jsonl', 'cleanup_end', { allGone: result.allGone });
  return result;
}
export function phaseAt(events, hooks, t, owner = null, channel = 'fixture') {
  const phases = events.filter(x => x.event === 'phase' && x.t <= t && x.channel === channel && (!owner || x.owner === owner));
  const phase = phases.at(-1);
  if (phase) return { phase: phase.phase, owner: phase.owner, executionId: phase.executionId, since: phase.t };
  const start = hooks.find(x => x.t <= t && x.payload?.hook_event_name === 'SubagentStart' &&
    (!owner || x.payload.agent_id === owner));
  return { phase: start ? 'startup' : 'not-started', owner: owner ?? start?.payload.agent_id ?? null, since: start?.t ?? null };
}
export function snapshot(dir, reason) {
  return log(dir, 'samples.jsonl', 'sample', { reason,
    processes: pidRecords(dir).map(p => {
      const { target, role, executionId, channel, state } = inspectPID(dir, p);
      return { pid: target, role, executionId, channel, state };
    }) });
}
export function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
