// Stop hook for the hold-and-inject probe, the same script on both hosts.
// First stop: hold SECONDS (standing in for "the job is still running"), then refuse the stop with the news on
// stderr and exit 2. Later stops: allow. Usage (as a Stop hook): node stop-inject.mjs RUN_DIR SECONDS KB
import fs from 'node:fs';
import { report } from './fixture-report.mjs';
const [run, seconds, kb] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4] || 0)];
let payload = {}; try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
const log = (event, data = {}) => fs.appendFileSync(run + '/stop-hook.jsonl', JSON.stringify({ t: Date.now(), event, pid: process.pid, ...data }) + '\n');
const brief = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v]));
if (fs.existsSync(run + '/stop-delivered')) { log('allow', { payload: brief }); process.exit(0); }
fs.writeFileSync(run + '/stop-delivered', '1');
log('holding', { seconds, kb, payload: brief });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { log('signal', { signal }); process.exit(0); });
setTimeout(() => {
  const body = kb ? report(kb) : 'END no-body';
  fs.writeFileSync(run + '/stop-result.txt', body);
  const text = `THREAD-NEWS thread t-1: companion job job-1 finished (status completed). Reference: ${run}/stop-result.txt\n${body}`;
  log('refusing', { chars: text.length });
  process.stderr.write(text, () => process.exit(2));
}, seconds * 1000);
