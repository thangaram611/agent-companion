// What does a FRESH `codex app-server` say about a thread that is on disk but not
// loaded into this process? That is the broker-restart case, and `errs.mjs` could
// not answer it: every call there uses the all-zero id, a thread that exists
// nowhere, so it measured "unknown thread" and not "known thread, wrong process".
//
//   node probes/codex-app-server/unloaded.mjs /tmp/somedir
//
// Costs one tiny turn ("reply OK"). The turn is REQUIRED: a thread with no turns
// has no rollout on disk at all, so an earlier version of this probe that only
// called `thread/start` measured the empty-disk case by accident and told us
// nothing. Measured 2026-08-10 on codex-cli 0.147.0:
//
//   thread/loaded/list  -> []                       not loaded here
//   thread/read         -> OK, full transcript      it IS a disk reader
//   turn/interrupt      -> -32600 thread not found
//   turn/steer          -> -32600 thread not found
//   thread/resume       -> OK, status idle          fully recoverable
//   turn/interrupt      -> -32600 no active turn to interrupt   (after resume)
//
// Two consequences, both load-bearing: `thread not found` must NEVER be classified
// as an unrecoverable thread (see classifyUnreachable), and the adapter must always
// `thread/resume` before `turn/interrupt`/`turn/steer` on a thread it did not start.
import { spawn } from 'node:child_process';
const cwd = process.argv[2];
function server(tag) {
  const p = spawn('/opt/homebrew/bin/codex', ['app-server'], { stdio: ['pipe','pipe','pipe'] });
  let id = 1, buf = ''; const pend = new Map(); const notes = [];
  p.stdout.on('data', c => { buf += c; const ls = buf.split('\n'); buf = ls.pop() || '';
    for (const l of ls) { if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
        const q = pend.get(m.id); pend.delete(m.id);
        if (q) m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result);
      } else if (m.method) notes.push(m); } });
  const call = (method, params) => new Promise((res, rej) => {
    const i = id++; pend.set(i, { res, rej });
    p.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:i, method, params }) + '\n'); });
  return { p, call, notes };
}
const t = async (label, fn) => { try { const r = await fn(); console.log(`OK   ${label}: ${JSON.stringify(r).slice(0,200)}`); return r; }
                                 catch (e) { console.log(`ERR  ${label}: ${e.message.slice(0,200)}`); return null; } };
const A = server('A');
await A.call('initialize', { clientInfo: { name: 'unloaded-probe', version: '1' } });
A.p.stdin.write(JSON.stringify({ jsonrpc:'2.0', method:'initialized', params:{} }) + '\n');
const th = await A.call('thread/start', { cwd, sandbox:'read-only', approvalPolicy:'never', ephemeral:false });
const tid = th.thread.id;
console.log('thread:', tid);
await A.call('turn/start', { threadId: tid, input: [{ type:'text', text:'Reply with exactly the word OK and nothing else.' }] });
await new Promise(res => { const iv = setInterval(() => {
  if (A.notes.find(n => n.method === 'turn/completed')) { clearInterval(iv); res(); } }, 250);
  setTimeout(() => { clearInterval(iv); res(); }, 90000); });
console.log('turn done; rollout should now exist on disk');
A.p.kill('SIGKILL');
await new Promise(r => setTimeout(r, 1500));
const B = server('B');
await B.call('initialize', { clientInfo: { name: 'unloaded-probe-B', version: '1' } });
B.p.stdin.write(JSON.stringify({ jsonrpc:'2.0', method:'initialized', params:{} }) + '\n');
console.log('--- FRESH server. thread is on disk, NOT loaded in this process ---');
await t('thread/loaded/list', () => B.call('thread/loaded/list', {}));
await t('thread/read  (unloaded)', () => B.call('thread/read', { threadId: tid, includeTurns: true }));
await t('turn/interrupt (unloaded)', () => B.call('turn/interrupt', { threadId: tid, turnId: tid }));
await t('turn/steer (unloaded)', () => B.call('turn/steer', { threadId: tid, expectedTurnId: tid, input:[{type:'text',text:'x'}] }));
const r = await t('thread/resume (unloaded)', () => B.call('thread/resume', { threadId: tid }));
console.log('   resume status ->', JSON.stringify(r?.thread?.status));
await t('thread/read  (after resume)', () => B.call('thread/read', { threadId: tid, includeTurns: true }));
await t('turn/interrupt (after resume, thread idle)', () => B.call('turn/interrupt', { threadId: tid, turnId: tid }));
await t('turn/steer (after resume, thread idle)', () => B.call('turn/steer', { threadId: tid, expectedTurnId: tid, input:[{type:'text',text:'x'}] }));
B.p.kill('SIGKILL'); process.exit(0);
