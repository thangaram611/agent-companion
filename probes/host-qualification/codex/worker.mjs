// Extended from the 4 Nov worker.cjs: no signal/EOF cascade, plus a detached grandchild.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log, readJSON, register, writeJSON } from './common.mjs';

const [dir, execution_id, role = 'worker'] = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
const entry = register(dir, process.pid, role, { execution_id, ppid: process.ppid });
const state = readJSON(path.join(dir, `${execution_id}.json`));
let ending = false;
function end(reason) {
  if (ending) return;
  ending = true;
  log(dir, 'heartbeats.jsonl', 'exit', { execution_id, role, reason });
  if (role === 'worker') writeJSON(path.join(dir, `${execution_id}.result.json`),
    { execution_id, reason, answer: reason === 'finished' ? 'fake provider result' : null });
  // Each process exits independently. Killing one is never credited as killing the tree.
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => end(signal));
if (role !== 'grandchild') {
  const next = role === 'worker' ? 'command' : 'grandchild';
  const child = spawn(process.execPath, [self, dir, execution_id, next],
    { stdio: 'ignore', detached: next === 'grandchild' });
  register(dir, child.pid, next, { execution_id, ppid: process.pid });
  child.on('error', e => log(dir, 'heartbeats.jsonl', 'spawn_error', { role: next, error: e.message }));
  child.unref();
}
function tick() {
  const beat = log(dir, 'heartbeats.jsonl', 'heartbeat',
    { execution_id, role, ppid: process.ppid, pgid: entry.pgid, cwd: process.cwd() });
  writeJSON(path.join(dir, `heartbeat-${process.pid}.json`), beat);
  if (fs.existsSync(path.join(dir, `${execution_id}.stop`))) end('explicit_stop');
  if (Date.now() >= state.finish_at) end('finished');
}
tick(); setInterval(tick, 500);
