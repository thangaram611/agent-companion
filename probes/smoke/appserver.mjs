// End-to-end proof that the app-server transport eliminates the F1 incident.
//
// This is the same shape as orphan.mjs — bridge A dispatches a real codex job,
// A is SIGKILLed mid-run, bridge B starts on the same host session and hydrates
// — with the transport flipped to `CODEX_RUNTIME_ADAPTER=appserver`. Under the
// exec adapter that sequence is unavoidable destruction: the codex child dies of
// EPIPE at its next stdout write, and orphan.mjs asserts the honest verdict
// (`target_child_orphaned_by_bridge_restart`) because an honest verdict is the
// best that transport can do. Here the job is expected to FINISH, with the work
// done while no bridge was alive at all.
//
// The property being proved is that the bridge is a detachable observer: the
// broker owns the turn, so A's death costs a socket client, not ~4 minutes of
// paid work (docs/RELIABILITY_REMEDIATION.md §1 F1, §2 "Two-tier durability").
//
// It spends real tokens — the turn is deliberately kept to three short shell
// sleeps and one fixed word.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.AGENT_COMPANION_REPO
  || fileURLToPath(new URL('../..', import.meta.url));

// The probe reads the broker through the adapter's own primitives rather than
// re-deriving them: `probeCodexBrokerHealth` is a real connect + `broker/status`
// (socket presence is not liveness), and `thread/loaded/list` is the
// authoritative liveness answer that no pid probe can give.
//
// Deliberately NOT used here: `thread/resume`. Resume
// is the status read on this protocol, and subscribing DRAINS the broker's
// pre-subscription ring for that thread — so asking the question from the probe
// would swallow the very events bridge B is about to hydrate on.
const { probeCodexBrokerHealth, connectCodexBroker, listLoadedCodexThreads } =
  await import(join(REPO, 'bridge-server/codex-app-server-runtime.mjs'));
const { pidAlive } = await import(join(REPO, 'lib/shared-runtime-registry.mjs'));

const SID = `appserver-${Date.now().toString(36)}`;
const ANSWER = 'PERSIMMON';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ledger = (id) => join(homedir(), '.claude/agent-companion/jobs', `${id}.json`);
const digestPath = (id) => join(homedir(), '.claude/agent-companion/runtime/digests', `agent-digest-${id}.md`);
const readLedger = (id) => (existsSync(ledger(id)) ? JSON.parse(readFileSync(ledger(id), 'utf8')) : null);
const readDigest = (id) => (existsSync(digestPath(id)) ? readFileSync(digestPath(id), 'utf8') : '');

// The streamed assistant text a bridge left in the digest. This is what W1.4′
// protects: every render is a full replacement, so a fresh bridge re-rendering
// from its own empty accumulator would destroy the dead bridge's only record.
const assistantSection = (text) =>
  /^#{2,3} Final \/ partial assistant message\n+([\s\S]*?)(?=\n#{2,3} |$)/m.exec(text)?.[1]?.trim() || '';

function startBridge(tag) {
  const p = spawn(process.execPath, [join(REPO, 'bridge-server/server.mjs')], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: SID,
      // THE flip under test. Everything else about this probe is orphan.mjs.
      CODEX_RUNTIME_ADAPTER: 'appserver',
      AGENT_COMPANION_LOG_LEVEL: 'INFO',
      // One log file per bridge, inside this run's temp dir. The restart-resume
      // assertion reads B's log, so it must not have to pick B's lines out of
      // A's; and a token-spending probe has no business interleaving itself
      // into the operator's real `runtime/agent-bridge.log`.
      AGENT_BRIDGE_LOG_FILE: bridgeLogPath(tag),
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

// Descendants of the `codex app-server`, walked from `ps`. The turn's shell
// commands run as its children, so a live `sleep` under that pid is direct
// evidence the turn is still EXECUTING with no bridge attached — the thing the
// exec transport cannot do, where the child is doomed at its next stdout write.
function descendantsOf(rootPid) {
  let rows;
  try { rows = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8' }); }
  catch { return []; }
  const byParent = new Map();
  for (const line of rows.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const entry = { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] };
    if (!byParent.has(entry.ppid)) byParent.set(entry.ppid, []);
    byParent.get(entry.ppid).push(entry);
  }
  const out = [];
  const walk = (pid, depth) => {
    if (depth > 6) return;
    for (const child of byParent.get(pid) || []) { out.push(child); walk(child.pid, depth + 1); }
  };
  walk(rootPid, 0);
  return out;
}

const work = mkdtempSync(join(tmpdir(), 'agentco-appserver-'));
writeFileSync(join(work, 'README.md'), '# appserver smoke\n');
const bridgeLogPath = (tag) => join(work, `bridge-${tag}.log`);
const readBridgeLog = (tag) => (existsSync(bridgeLogPath(tag)) ? readFileSync(bridgeLogPath(tag), 'utf8') : '');

let A = null, B = null;
let brokerPid = null;
let ourThreadId = null;
try {
  A = startBridge('A'); await A.init();
  log('bridge A pid', A.proc.pid);

  // One short opening message, three short sequential shell sleeps, then a fixed
  // word. Sixty seconds of shell is long enough that the turn is provably still
  // running after A dies — and the sleeps are where the wall time goes, so the
  // token cost is two short messages.
  //
  // The opening message is ASKED FOR, not hoped for. F7 and W1.4′ both need
  // assistant text to exist mid-turn, and codex's preamble is the model's
  // choice: a measured run went straight to the first tool call and left the
  // digest with no assistant section at all, so both checks failed on the
  // model's terseness rather than on anything the transport did. Requesting the
  // message makes those two assertions measure the transport, which is what
  // they claim to measure.
  const send = await A.tool('agent_send', {
    task: 'Before you run anything, send a short one-line message saying you are starting. '
      + 'That is a message to me, not a tool call. '
      + 'Then run these three shell commands one after another, each as its own command: '
      + '`sleep 20 && echo STEP1`, then `sleep 20 && echo STEP2`, then `sleep 20 && echo STEP3`. '
      + `When all three have finished, reply with ONLY the word ${ANSWER} — that final message must contain nothing else.`,
    cwd: work, mode: 'EXECUTE', template: 'general', parallel: 'never', max_wait_sec: 5,
  });
  const jobId = send.job_id || send.jobId;
  check('bridge A dispatched a codex job on the app-server adapter', !!jobId, `job=${jobId}`);
  if (!jobId) throw new Error(JSON.stringify(send).slice(0, 400));

  // --- W1.1: the thread id must be banked WHILE RUNNING. On this transport it
  // arrives from `thread/start` BEFORE the model does anything, so it is in the
  // ledger long before there is any work to lose.
  // Bounded at 30 s, not "until streamed": the kill has to land while the turn
  // still has work left, so a turn that never emits a preamble must fail the
  // streaming check honestly rather than push the kill past the sleeps.
  let row = null;
  let streamed = '';
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    row = readLedger(jobId);
    // Wait for streamed content too: a digest with no assistant section yet
    // would make the no-clobber assertion below vacuous.
    streamed = assistantSection(readDigest(jobId));
    if (row?.companionSessionId && !row.terminalAt && streamed) break;
  }
  check('W1.1 thread id persisted to the ledger while the job is still running',
    !!row?.companionSessionId && !row?.terminalAt, `thread=${row?.companionSessionId} adapter=${row?.codexAdapter}`);
  check('the job records the transport it started under (codexAdapter)',
    row?.codexAdapter === 'appserver', `codexAdapter=${row?.codexAdapter}`);
  ourThreadId = row?.companionSessionId || null;
  if (!ourThreadId) throw new Error('no thread id was ever persisted');

  // F7 on this transport: `codex exec --json` emits no deltas at all, so a
  // digest with streamed assistant text mid-turn is itself a transport claim.
  const digestBefore = readDigest(jobId);
  check('sub-turn streaming reached the digest before the kill (F7)',
    !!streamed, `${digestBefore.length} bytes, ${streamed.length} streamed chars`);

  const liveStatus = await A.tool('agent_status', { job_id: jobId, verbose: true });
  check('agent_status reports reply_available/resume_available true while running',
    liveStatus?.reply_available === true && liveStatus?.resume_available === true,
    `reply=${liveStatus?.reply_available} resume=${liveStatus?.resume_available} session=${liveStatus?.session_id}`);

  const brokerBefore = await probeCodexBrokerHealth(row?.brokerSocket || null);
  brokerPid = brokerBefore.brokerPid;
  log(`broker pid=${brokerBefore.brokerPid} app-server pid=${brokerBefore.appServerPid} clients=${brokerBefore.clients}`);

  // ---- THE INCIDENT: the owning subagent returns and the host tears its
  // bridge down. SIGKILL is the harsher form, and the one orphan.mjs uses.
  log('SIGKILL bridge A');
  A.proc.kill('SIGKILL');
  const killedAt = Date.now();
  await sleep(1500);

  // --- The property that does not exist on the exec transport.
  const brokerAfter = await probeCodexBrokerHealth(row?.brokerSocket || null);
  check('the broker and its `codex app-server` outlived the bridge',
    brokerAfter.alive && pidAlive(brokerAfter.brokerPid) && pidAlive(brokerAfter.appServerPid),
    `broker=${brokerAfter.brokerPid} app-server=${brokerAfter.appServerPid} alive=${brokerAfter.alive}`);

  let loaded = [];
  if (brokerAfter.alive) {
    const conn = await connectCodexBroker({ socketPath: brokerAfter.socketPath });
    try { loaded = await listLoadedCodexThreads({ conn }); } finally { conn.close(); }
  }
  check('the thread is still loaded on the broker with no bridge attached',
    loaded.includes(ourThreadId), `loaded=${loaded.length} thread=${ourThreadId}`);

  // The turn is not merely resumable — it is still doing work. Poll briefly,
  // because there is a model-thinking gap between the three commands.
  // Matched on OUR marker, never on `sleep`: the broker is machine-wide by
  // design and every loaded thread's shell children hang off the same
  // `codex app-server` pid, so a bare `\bsleep\b` would happily report another
  // session's turn as evidence that ours survived. `STEP1|2|3` comes from this
  // probe's own task string, so it can only be this run.
  let running = null;
  for (let i = 0; i < 20 && !running; i++) {
    running = descendantsOf(brokerAfter.appServerPid).find((d) => /STEP[123]/.test(d.command)) || null;
    if (!running) await sleep(1000);
  }
  check('the turn is STILL RUNNING with zero bridges alive (exec cannot do this)',
    !!running, running ? `pid=${running.pid} ${running.command.slice(0, 90)}` : 'no shell descendant of the app-server');

  // --- Bridge B, same host session. Its first tool call adopts the sid, which
  // hydrates the ledger; hydrate then dispatches `resume_available` jobs to
  // `thread/resume` instead of retiring them.
  B = startBridge('B'); await B.init();
  log('bridge B pid', B.proc.pid);
  await B.tool('agent_status', { job_id: jobId });

  let final = null;
  for (let i = 0; i < 6 && !final; i++) {
    const w = await B.tool('agent_wait', { job_id: jobId, max_wait_sec: 60 });
    log('wait ->', w?.status);
    if (w?.status && w.status !== 'running' && w.status !== 'still_running') final = w;
  }
  const recoveredMs = Date.now() - killedAt;
  check('bridge B drove the job to a terminal status after the restart', !!final, `status=${final?.status}`);
  // The recovery time is part of the claim, not decoration: the turn had ~50 s
  // of sleeps left when A died, so a job that settled instantly would mean the
  // level check harvested a dead turn rather than the broker finishing it.
  check('the job COMPLETED — zero work lost, no re-prompting',
    final?.status === 'completed', `status=${final?.status} detail=${final?.meta?.detail ?? ''} recovered_in=${(recoveredMs / 1000).toFixed(1)}s`);
  // Asserted against the ASSISTANT MESSAGE, never the terminal envelope: the
  // task string names the expected word, so `content` contains it whether or
  // not the model ever answered. The first section is B's live render; the
  // carried body below it is demoted to `###`.
  //
  // Two clauses, because the assistant section can hold the ECHO rather than
  // the answer by two measured routes, and both reproduce A's pre-kill text:
  //   1. `resolvedMessage()` (codex-app-server-runtime.mjs) falls back to the
  //      LAST assistant message when nothing carries `phase: 'final_answer'`,
  //      so a lost final item renders the preamble into this exact section;
  //   2. an empty summary drops the `## ` section entirely
  //      (writeOpenCodeDigest), so the regex's first hit becomes the carried
  //      `### ` body — A's preamble, verbatim.
  // `answered !== streamed` closes both, since A's pre-kill section is by
  // construction not the post-restart answer. The anchor closes the third:
  // "I'll run the sleeps, then reply with PERSIMMON" is a preamble that a
  // substring test cannot tell from an answer.
  const answered = assistantSection(readDigest(jobId));
  check(`the answer survived the bridge restart (${ANSWER})`,
    answered !== streamed && new RegExp(`^\\W*${ANSWER}\\W*$`, 'i').test(answered.trim()),
    answered.slice(0, 160) || '(no assistant message)');

  const after = readLedger(jobId);
  // Evidence bridge B produced, not a value this probe already held.
  // `companionSessionId` is written exactly once — by A, from `thread/start` —
  // and nothing on the resume side writes it, so re-reading it proves only that
  // A wrote it. `codex-appserver resume: <jobId> thread=<id>` is logged by
  // `resumeCodexAppServerJob` and by nothing else in the tree, so B's own log
  // naming OUR thread id is what makes this a measurement.
  const resumeLine = readBridgeLog('B').split('\n')
    .find((l) => l.includes(`codex-appserver resume: ${jobId}`)) || '';
  check('B resumed the SAME thread rather than starting a new one',
    resumeLine.includes(`thread=${ourThreadId}`) && after?.companionSessionId === ourThreadId,
    resumeLine.slice(-140) || 'bridge B never logged a codex-appserver resume');
  // The exec transport's honest verdict is the wrong verdict here: nothing was
  // orphaned, because nothing the bridge owned was running the work.
  check('the verdict is NOT the exec transport\'s orphan detail',
    after?.detail !== 'target_child_orphaned_by_bridge_restart'
    && after?.detail !== 'bridge_transport_closed'
    && after?.detail !== 'thread_not_resumable',
    `detail=${after?.detail ?? 'null'}`);

  // --- W1.4′: hydrate must not rewrite the digest of a job it did not start.
  // Measured regression: a fresh bridge re-rendering from `adapterResult ||
  // null` shrank a live 11,754-byte digest to a 228-byte header stub. The
  // streamed text either survives verbatim under "Carried forward from the
  // previous bridge" or is subsumed by the completed render — writeJobDigest
  // carries it forward exactly when the incoming render does not already hold it.
  const digestAfter = readDigest(jobId);
  // A prefix, not the whole section: the carried body is truncated at 12 KB and
  // its `## ` headers are demoted to `### `, and a header-only stub contains
  // none of it either way. Both spellings are accepted for the same reason.
  const marker = streamed.slice(0, 200);
  const survived = !!marker
    && (digestAfter.includes(marker) || digestAfter.includes(marker.replace(/^## /gm, '### ')));
  check('W1.4′ B\'s hydrate did not clobber the digest A streamed',
    digestAfter.length >= digestBefore.length && survived,
    `${digestBefore.length} -> ${digestAfter.length} bytes, streamed text ${survived ? 'preserved' : 'LOST'}`);

  // --- The sandbox the turn actually ran under, read from codex's own record.
  //
  // `turn/start`'s `sandboxPolicy` is the ONLY place the network decision can go
  // on this transport (`thread/start`'s `sandbox` is the bare mode enum), and
  // "the server accepted the field" is not "the turn ran with it". The rollout's
  // `turn_context` is codex's own account of what the turn was given, so this
  // asserts APPLIED, not accepted — the same distinction the steer confirmation
  // makes. Its path came from `thread/start` and is already in the ledger.
  //
  // `network_access: true` is the exec adapter's default carried onto this
  // transport; before it was wired, every broker-originated rollout on this
  // machine recorded `false` while `codex_exec`'s recorded `true` — i.e. the
  // adapter a job ran on changed what it could reach. `model`/`effort` are
  // asserted alongside because the same call could have pinned them: they must
  // still come from ~/.codex/config.toml.
  const rolloutPath = after?.rolloutPath || row?.rolloutPath || null;
  let turnContext = null;
  if (rolloutPath && existsSync(rolloutPath)) {
    for (const line of readFileSync(rolloutPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry = null;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type === 'turn_context' && entry.payload?.sandbox_policy) { turnContext = entry.payload; break; }
    }
  }
  const policy = turnContext?.sandbox_policy || null;
  check('the turn/start sandboxPolicy was APPLIED, not merely accepted',
    policy?.type === 'workspace-write' && policy?.network_access === true,
    `sandbox_policy=${JSON.stringify(policy)} rollout=${rolloutPath || 'unknown'}`);
  check('applying the sandbox did not pin the model or effort (config stays authoritative)',
    !!turnContext && turnContext.approval_policy === 'never'
    && !!turnContext.model && !!turnContext.effort,
    `approval=${turnContext?.approval_policy} model=${turnContext?.model} effort=${turnContext?.effort}`);

  const doneStatus = await B.tool('agent_status', { job_id: jobId, verbose: true });
  // Truthful, not merely true: reply needs a live turn and this one is over,
  // while the THREAD is still resumable — `thread/resume` reloads it from the
  // rollout even after the broker dies.
  check('agent_status reports reply_available/resume_available truthfully at terminal',
    doneStatus?.reply_available === false && doneStatus?.resume_available === true,
    `reply=${doneStatus?.reply_available} resume=${doneStatus?.resume_available}`);
} catch (e) {
  check('appserver run completed without throwing', false, e.message);
} finally {
  for (const b of [A, B]) { try { b?.proc?.stdin?.end(); b?.proc?.kill(); } catch {} }

  // The broker is REAPED DELIBERATELY, not left running. It is detached and
  // machine-wide by design, and the bridge-side idle reaper would refuse while
  // this probe's thread is still loaded (`disposeBroker` refuses on a non-empty
  // `thread/loaded/list`) — so a probe that just exited would leave a daemon
  // behind for its 15-minute inactivity timeout.
  //
  // SIGTERM, never SIGKILL: the broker's handler stops its `codex app-server`
  // child and unlinks its own socket. SIGKILL skips that handler, and the stale
  // socket file it leaves is exactly what a later run has to connect-probe
  // around (measured — see probes/README.md).
  //
  // Only ever OUR broker, and only when nobody else is on it: another session's
  // live codex job would be on the same socket. A run that dies before it learns
  // the broker pid reaps nothing — there is no way to tell that broker apart
  // from someone else's — and falls back to the broker's own idle timer.
  //
  // Both of the broker's own idle gates, not just the strong one. `clients` is
  // the gate `_cheapGatesHold` checks first, precisely because a bridge can be
  // connected and inside `thread/start` with nothing loaded yet: SIGTERM there
  // kills a turn that is one round-trip from existing. `probeCodexBrokerHealth`
  // connects, so ITS OWN connection is inside the count it reports — "somebody
  // else" is `clients - 1`, never `clients`, and gating on `clients > 0` would
  // skip the reap on every run. Our two bridges were killed just above and the
  // broker drops a client when the socket closes, so this waits briefly for
  // that to land rather than reading a count that is stale by milliseconds.
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
        const foreign = loaded.filter((id) => id !== ourThreadId);
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
console.log(`\n===== APP-SERVER RESTART PROOF: ${results.length - bad.length}/${results.length} passed =====`);
for (const f of bad) console.log(`  FAIL: ${f.n} — ${f.d}`);
process.exit(bad.length ? 1 : 0);
