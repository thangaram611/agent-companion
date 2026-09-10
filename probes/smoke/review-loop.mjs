// End-to-end proof that the review loop is first-class on the app-server
// transport — against the REAL `codex app-server`, through the real broker,
// driven through the real bridge's MCP surface.
//
// The loop under test is the only workflow the Claude-host ledger shows in use
// (docs/DIRECTION_ASSESSMENT.md §2): the parent asks Codex for a read-only
// review with a verdict, acts on the findings, and asks again. Before this
// probe each round opened a COLD codex thread, so round two had to be told
// everything round one found. Two properties are asserted here:
//
//   1. `template: "review"` ends in a verdict the bridge PARSES — `meta.verdict`
//      is `disagree` for a planted defect, without the parent reading prose.
//   2. A follow-up send on the same thread RESUMES the same codex thread
//      (`thread/resume`, not `thread/start`): round two names round one's
//      finding although its task never restates it, both turns sit on one
//      thread in `thread/read`, and the bridge that ran round one was SIGKILLed
//      in between — the `.sid` and the rollout are what carry the thread, not
//      bridge memory.
//
// A SIBLING of appserver-control.mjs for the same reason that one is a sibling
// of appserver.mjs: each probe fails for one reason. It spends real tokens: two
// short read-only review turns over a three-line repository.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.AGENT_COMPANION_REPO
  || fileURLToPath(new URL('../..', import.meta.url));

// `thread/read` is not an attach-first method: it neither resumes nor
// subscribes, so reading the thread back cannot drain a ring a live watcher is
// reading — and by the time this probe reads anything both jobs are terminal.
const {
  probeCodexBrokerHealth, connectCodexBroker, listLoadedCodexThreads, readCodexThread,
} = await import(join(REPO, 'bridge-server/codex-app-server-runtime.mjs'));
const { pidAlive } = await import(join(REPO, 'lib/shared-runtime-registry.mjs'));

const SID = `review-loop-${Date.now().toString(36)}`;
const THREAD = `review-loop-${Date.now().toString(36)}`;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOME = join(homedir(), '.claude/agent-companion');
const ledger = (id) => join(HOME, 'jobs', `${id}.json`);
const readLedger = (id) => (existsSync(ledger(id)) ? JSON.parse(readFileSync(ledger(id), 'utf8')) : null);
// The sid is profile-namespaced (`<thread>__<profile>.sid`) when a profile is
// configured and bare otherwise, so match on the thread name rather than
// guessing which install this machine has.
const readThreadSidFile = () => {
  const dir = join(HOME, 'threads');
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.endsWith('.sid') && (f === `${THREAD}.sid` || f.startsWith(`${THREAD}__`)));
  return file ? readFileSync(join(dir, file), 'utf8').trim() : null;
};

// The repository under review: one claim, one function, one planted defect.
const work = mkdtempSync(join(tmpdir(), 'agentco-review-'));
writeFileSync(join(work, 'README.md'),
  '# sumlib\n\n`sum(a, b)` in `sum.mjs` returns the arithmetic sum of its two arguments.\n');
writeFileSync(join(work, 'sum.mjs'), 'export function sum(a, b) {\n  return a - b;\n}\n');

function startBridge(tag) {
  const p = spawn(process.execPath, [join(REPO, 'bridge-server/server.mjs')], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: SID,
      CODEX_RUNTIME_ADAPTER: 'appserver',
      AGENT_COMPANION_LOG_LEVEL: 'INFO',
      AGENT_BRIDGE_LOG_FILE: join(work, `bridge-${tag}.log`),
    },
  });
  p.stderr.on('data', (c) => { const s = c.toString().trim(); if (s) log(`${tag}-stderr:`, s.slice(0, 220)); });
  let id = 1; const pending = new Map(); let buf = '';
  p.stdout.on('data', (chunk) => {
    buf += chunk.toString(); const ls = buf.split('\n'); buf = ls.pop() || '';
    for (const l of ls) { if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { const q = pending.get(m.id); pending.delete(m.id);
        m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); } }
  });
  const rpc = (method, params) => new Promise((res, rej) => {
    const i = id++; pending.set(i, { res, rej });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
  const tool = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: { ...args, host_session_id: SID } });
    const text = r?.content?.find((c) => c.type === 'text')?.text ?? '';
    try { return JSON.parse(text); } catch { return { _raw: text }; }
  };
  return { proc: p, rpc, tool, async init() {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: tag, version: '1' } });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  } };
}

async function untilTerminal(bridge, jobId, iterations = 8) {
  for (let i = 0; i < iterations; i++) {
    const w = await bridge.tool('agent_wait', { job_id: jobId, max_wait_sec: 60 });
    log('wait ->', w?.status);
    if (w?.status && w.status !== 'running' && w.status !== 'still_running') return w;
  }
  return null;
}

const bridgeLog = (tag) => (existsSync(join(work, `bridge-${tag}.log`)) ? readFileSync(join(work, `bridge-${tag}.log`), 'utf8') : '');
// The one log line the worker emits when it opens a thread, and nothing else
// does — `resumed=` is the fact under test, so it is read off the bridge's own
// record rather than inferred from the ledger.
const threadLine = (tag, jobId) => bridgeLog(tag).split('\n').find((l) => l.includes('codex-appserver thread:') && l.includes(jobId)) || '';

let A = null;
let B = null;
let brokerPid = null;
let threadId = null;
try {
  A = startBridge('A'); await A.init();
  log('bridge A pid', A.proc.pid);

  // ======================================================================
  // Round one: a review of a false claim ends in a parsed `disagree`.
  // ======================================================================
  const send1 = await A.tool('agent_send', {
    task: 'Review the claim in README.md that `sum()` in sum.mjs returns the arithmetic sum of its two arguments. Verify it against the code.',
    cwd: work, mode: 'ANALYZE', template: 'review', parallel: 'never', thread: THREAD, max_wait_sec: 5,
  });
  const job1 = send1.job_id;
  check('round one dispatched with template=review', !!job1, `job=${job1} err=${(send1.error || '').slice(0, 160)}`);
  if (!job1) throw new Error(JSON.stringify(send1).slice(0, 400));

  const final1 = await untilTerminal(A, job1);
  check('round one completed', final1?.status === 'completed', `status=${final1?.status} detail=${final1?.meta?.detail ?? ''}`);
  check('round one verdict was PARSED into meta.verdict = disagree',
    final1?.meta?.verdict === 'disagree',
    `verdict=${JSON.stringify(final1?.meta?.verdict)} reason=${final1?.meta?.verdict_reason ?? ''}`);
  const body1 = String(final1?.content || '');
  check('round one names the planted defect in the body',
    /sum\.mjs/.test(body1) && /(subtract|a - b|minus|difference)/i.test(body1),
    body1.replace(/\s+/g, ' ').slice(0, 200));

  const row1 = readLedger(job1);
  threadId = row1?.companionSessionId || null;
  check('round one opened a FRESH codex thread (no prior sid on this thread)',
    !!threadId && /resumed=false/.test(threadLine('A', job1)),
    `thread=${threadId} line=${threadLine('A', job1).slice(-120)}`);
  check('the codex thread id was persisted as the thread sid, the way Copilot\'s is',
    !!threadId && readThreadSidFile() === threadId,
    `sid_file=${readThreadSidFile()} ledger=${threadId}`);

  // ======================================================================
  // Between rounds: the parent acts on the finding, and the bridge dies.
  // ======================================================================
  writeFileSync(join(work, 'sum.mjs'), 'export function sum(a, b) {\n  return a + b;\n}\n');
  log('SIGKILL bridge A');
  A.proc.kill('SIGKILL');
  await sleep(500);
  B = startBridge('B'); await B.init();
  log('bridge B pid', B.proc.pid);

  // ======================================================================
  // Round two: the same thread, a task that never restates finding one.
  // ======================================================================
  const send2 = await B.tool('agent_send', {
    task: 'Finding 1 has been addressed in the working tree; re-verdict.',
    cwd: work, mode: 'ANALYZE', template: 'review', parallel: 'never', thread: THREAD, max_wait_sec: 5,
  });
  const job2 = send2.job_id;
  check('round two dispatched on the same thread from a fresh bridge', !!job2 && send2.thread === THREAD,
    `job=${job2} thread=${send2.thread} err=${(send2.error || '').slice(0, 160)}`);
  if (!job2) throw new Error(JSON.stringify(send2).slice(0, 400));

  const final2 = await untilTerminal(B, job2);
  check('round two completed', final2?.status === 'completed', `status=${final2?.status} detail=${final2?.meta?.detail ?? ''}`);
  check('round two verdict was parsed (agree|disagree, never guessed)',
    final2?.meta?.verdict === 'agree' || final2?.meta?.verdict === 'disagree',
    `verdict=${JSON.stringify(final2?.meta?.verdict)} reason=${final2?.meta?.verdict_reason ?? ''}`);

  const row2 = readLedger(job2);
  check('round two RESUMED round one\'s codex thread — same companionSessionId',
    !!threadId && row2?.companionSessionId === threadId,
    `round1=${threadId} round2=${row2?.companionSessionId}`);
  check('bridge B logged the resume, not a fresh thread/start',
    /resumed=true/.test(threadLine('B', job2)), threadLine('B', job2).slice(-120) || 'no thread line logged');
  const body2 = String(final2?.content || '');
  check('round two refers to round one\'s subject without the task restating it',
    /sum/i.test(body2) && /(finding|README|claim)/i.test(body2),
    body2.replace(/\s+/g, ' ').slice(0, 200));

  // Both turns on ONE thread, read back over RPC from the broker.
  const health = await probeCodexBrokerHealth(row2?.brokerSocket || null);
  brokerPid = health.brokerPid;
  let transcript = null;
  if (health.alive) {
    const conn = await connectCodexBroker({ socketPath: health.socketPath });
    try { transcript = await readCodexThread({ conn, threadId }); } finally { conn.close(); }
  }
  const turns = transcript?.raw?.thread?.turns || [];
  const turnsText = JSON.stringify(turns);
  check('thread/read shows both rounds as turns of one codex thread',
    turns.length >= 2 && turnsText.includes('README.md') && turnsText.includes('re-verdict'),
    `turns=${turns.length}`);

  const status2 = await B.tool('agent_status', { job_id: job2, verbose: true });
  check('agent_status stays truthful at terminal: not repliable, still resumable',
    status2?.reply_available === false && status2?.resume_available === true,
    `reply=${status2?.reply_available} resume=${status2?.resume_available}`);
} catch (e) {
  check('review-loop run completed without throwing', false, e.message);
} finally {
  for (const b of [A, B]) { try { b?.proc?.stdin?.end(); b?.proc?.kill(); } catch {} }

  // Same reap discipline as the other app-server probes: SIGTERM only, only
  // OUR broker, only when nobody else is on it and no foreign thread is loaded.
  if (brokerPid) {
    try {
      let health = await probeCodexBrokerHealth();
      for (let i = 0; i < 8 && health.alive && (health.clients ?? 1) > 1; i++) {
        await sleep(500);
        health = await probeCodexBrokerHealth();
      }
      const others = health.alive ? (health.clients ?? 1) - 1 : 0;
      if (!health.alive || health.brokerPid !== brokerPid) {
        log('broker reap skipped: it is no longer the one this run used');
      } else if (others > 0) {
        log(`broker reap skipped: ${others} other client(s) still connected`);
      } else {
        const conn = await connectCodexBroker({ socketPath: health.socketPath });
        let loaded = [];
        try { loaded = await listLoadedCodexThreads({ conn }); } finally { conn.close(); }
        const foreign = loaded.filter((id) => id !== threadId);
        if (foreign.length) {
          log(`broker reap skipped: ${foreign.length} thread(s) from another session are loaded`);
        } else {
          process.kill(brokerPid, 'SIGTERM');
          await sleep(1000);
          log(`broker reaped (SIGTERM ${brokerPid}); alive=${pidAlive(brokerPid)}`);
        }
      }
    } catch (err) { log('broker reap failed:', err.message); }
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n===== REVIEW LOOP PROOF: ${results.length - bad.length}/${results.length} passed =====`);
for (const f of bad) console.log(`  FAIL: ${f.n} — ${f.d}`);
process.exit(bad.length ? 1 : 0);
