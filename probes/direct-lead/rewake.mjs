// Background hook for the wake probe: waits, then exits 2 with a message on stderr.
// Usage (as a PostToolUse hook with asyncRewake): node rewake.mjs RUN_DIR SECONDS KB
import fs from 'node:fs';
import { report } from './fixture-report.mjs';
const [run, seconds, kb] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4] || 0)];
const payload = fs.readFileSync(0, 'utf8');
const log = (event, data = {}) => fs.appendFileSync(run + '/rewake.jsonl', JSON.stringify({ t: Date.now(), event, pid: process.pid, ...data }) + '\n');
log('started', { seconds, kb, payloadChars: payload.length });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { log('signal', { signal }); process.exit(0); });
setTimeout(() => {
  const body = kb ? report(kb) : 'END no-body';
  fs.writeFileSync(run + '/rewake-result.txt', body);
  const text = `WAKE-MARKER companion job job-1 finished (status completed). Result file: ${run}/rewake-result.txt\n${body}`;
  log('exiting', { chars: text.length });
  process.stderr.write(text, () => process.exit(2));
}, seconds * 1000);
