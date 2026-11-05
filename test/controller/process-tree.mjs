import { fork } from 'node:child_process';

const role = process.argv[2] || 'root';
const ignore = process.argv.includes('ignore');
const birthTime = `${process.pid}:${performance.timeOrigin}`;
const row = { pid: process.pid, ppid: process.ppid, pgid: role === 'leaf' ? process.ppid : process.pid, birthTime };
if (ignore) process.on('SIGTERM', () => {});
// An IPC handle keeps the fake alive without a wall-clock heartbeat/timer.
process.on('message', (message) => { if (message === 'exit') process.exit(0); });
process.on('disconnect', () => { process.stdin.resume(); });
if (role === 'root') {
  const leaf = fork(import.meta.filename, ['leaf', ...(ignore ? ['ignore'] : [])], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
  leaf.on('message', (message) => process.send?.({ leaf: leaf.pid, ...message, rows: [row, ...message.rows] }));
} else if (role === 'leaf') {
  const grandchild = fork(import.meta.filename, ['grandchild', ...(ignore ? ['ignore'] : [])], { detached: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
  grandchild.on('message', (message) => process.send?.({ grandchild: grandchild.pid, rows: [row, ...message.rows] }));
} else {
  process.send?.({ ready: true, rows: [row] });
}
