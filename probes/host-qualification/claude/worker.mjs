// Adapted from the passive 4 Nov worker: no cancellation/EOF propagation or reaper.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log, readJSON, writeJSON, recordPID } from './common.mjs';

const [dir, executionId, role = 'worker'] = process.argv.slice(2);
const state = readJSON(path.join(dir, 'executions', executionId + '.json'));
const fields = { executionId, role, owner: state.owner, channel: state.channel, ppid: process.ppid, cwd: process.cwd() };
const emit = (event, extra = {}) => log(dir, 'events.jsonl', event, { ...fields, ...extra });
recordPID(dir, process.pid, role, fields);
emit('worker_start');
if (role !== 'grandchild') {
  const next = role === 'worker' ? 'leaf' : 'grandchild';
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), dir, executionId, next],
    { stdio: 'ignore', detached: next === 'grandchild' });
  recordPID(dir, child.pid, next, { ...fields, role: next, parent: process.pid });
  child.unref();
  child.on('error', error => emit('spawn_error', { role: next, error: error.message }));
}
let sequence = 0;
const beat = () => {
  log(dir, 'heartbeats.jsonl', 'heartbeat', { ...fields, sequence: ++sequence });
  if (role === 'worker' && sequence % 4 === 1) {
    writeJSON(path.join(dir, 'executions', executionId + '.partial.json'),
      { executionId, historyId: state.historyId, sequence, t: Date.now(), fake: true });
  }
};
beat();
setInterval(beat, 250);
// Planned fake completion only. Every process exits on its own timer, never by tree cleanup.
setTimeout(() => {
  if (role === 'worker') writeJSON(path.join(dir, 'executions', executionId + '.result.json'),
    { executionId, historyId: state.historyId, fake: true, result: 'finished', t: Date.now() });
  emit('planned_finish');
  process.exit(0);
}, Math.max(1, state.finishAt - Date.now()));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {
  emit('worker_signal', { signal });
  process.exit(0);
});
process.on('exit', code => emit('worker_exit', { code }));
