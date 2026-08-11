// End-to-end proof that `agent_reply` and `agent_cancel` actually work on the
// app-server transport — against the REAL `codex app-server`, through the real
// broker, driven through the real bridge's MCP surface.
//
// This is the probe that was missing. `appserver.mjs` proves the transport's
// survival property and went 15/15 while `turn/steer` and `turn/interrupt` were
// BOTH unconditionally broken: the adapter omitted `expectedTurnId` / `turnId`,
// which are `required`, and every fake answered anyway. Nothing in the tree
// exercised either control path against a server that would refuse.
//
// A SIBLING, not an extension of appserver.mjs, for three reasons:
//   1. its assertions hang off a SIGKILL landing mid-turn, and interleaving two
//      more control operations would make each one's timing depend on the
//      other's;
//   2. it asserts the job COMPLETED — the cancel case must end `cancelled`, on
//      the same job, which is a contradiction rather than an extra check;
//   3. each probe then fails for one reason, which is what makes a probe worth
//      running at all.
//
// It spends real tokens: two turns of short shell sleeps and one fixed word
// each. The sleeps are where the wall time goes.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.AGENT_COMPANION_REPO
  || fileURLToPath(new URL('../..', import.meta.url));

// The adapter's own primitives, exactly as appserver.mjs uses them: a real
// connect plus `broker/status` (socket presence is not liveness), and
// `thread/loaded/list` as the authoritative liveness answer no pid probe gives.
//
// `resumeCodexThread` IS used here, unlike in appserver.mjs — subscribing drains
// the broker's pre-subscription ring for that thread, which would swallow events
// a live watcher needs, and by the time this probe resumes anything the job is
// already terminal and nothing is watching.
const {
  probeCodexBrokerHealth, connectCodexBroker, listLoadedCodexThreads,
  resumeCodexThread, readCodexThread, resolveCodexTurnId,
} = await import(join(REPO, 'bridge-server/codex-app-server-runtime.mjs'));
const { pidAlive } = await import(join(REPO, 'lib/shared-runtime-registry.mjs'));

const SID = `appserver-control-${Date.now().toString(36)}`;
const STEER_WORD = 'PINEAPPLE';
const ORIGINAL_WORD = 'BANANA';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ledger = (id) => join(homedir(), '.claude/agent-companion/jobs', `${id}.json`);
const digestPath = (id) => join(homedir(), '.claude/agent-companion/runtime/digests', `agent-digest-${id}.md`);
const readLedger = (id) => (existsSync(ledger(id)) ? JSON.parse(readFileSync(ledger(id), 'utf8')) : null);
const readDigest = (id) => (existsSync(digestPath(id)) ? readFileSync(digestPath(id), 'utf8') : '');
const assistantSection = (text) =>
  /^#{2,3} Final \/ partial assistant message\n+([\s\S]*?)(?=\n#{2,3} |$)/m.exec(text)?.[1]?.trim() || '';

const work = mkdtempSync(join(tmpdir(), 'agentco-control-'));
writeFileSync(join(work, 'README.md'), '# appserver control smoke\n');

function startBridge(tag) {
  const p = spawn(process.execPath, [join(REPO, 'bridge-server/server.mjs')], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: SID,
      CODEX_RUNTIME_ADAPTER: 'appserver',
      AGENT_COMPANION_LOG_LEVEL: 'INFO',
      // The steer lands at the NEXT MODEL BOUNDARY, and this probe's turn is
      // sitting inside a shell `sleep` when the reply is sent — so the default
      // 5 s window would time out on the sleep rather than on anything about
      // the steer. Widened past one sleep so the confirmation measures what it
      // claims to: whether the injected message came back.
      AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: '45000',
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

// Two short sequential shell sleeps, then one fixed word. Long enough that the
// control operation provably lands mid-turn, short enough to be cheap.
const task = (word) =>
  'Run these two shell commands one after another, each as its own command: '
  + '`sleep 15 && echo S1`, then `sleep 15 && echo S2`. '
  + `When both have finished, reply with ONLY the word ${word} — that final message must contain nothing else.`;

// Wait until the job is running AND the bridge has banked the turn id. That id
// is the whole subject of this probe: `turn/interrupt` and `turn/steer` require
// it, and it arrives from `turn/start` before the model does anything.
async function untilTurnBanked(jobId, seconds = 40) {
  let row = null;
  for (let i = 0; i < seconds; i++) {
    await sleep(1000);
    row = readLedger(jobId);
    if (row?.companionSessionId && row?.turnId && !row.terminalAt) return row;
  }
  return row;
}

let A = null;
let brokerPid = null;
let steerThreadId = null;
let cancelThreadId = null;
try {
  A = startBridge('A'); await A.init();
  log('bridge pid', A.proc.pid);

  // ======================================================================
  // 1. agent_reply steers a RUNNING turn, and the turn obeys the new order.
  // ======================================================================
  const send1 = await A.tool('agent_send', {
    task: task(ORIGINAL_WORD), cwd: work, mode: 'EXECUTE', template: 'general', parallel: 'never', max_wait_sec: 5,
  });
  const steerJob = send1.job_id || send1.jobId;
  check('a codex job dispatched on the app-server adapter', !!steerJob, `job=${steerJob}`);
  if (!steerJob) throw new Error(JSON.stringify(send1).slice(0, 400));

  const row1 = await untilTurnBanked(steerJob);
  steerThreadId = row1?.companionSessionId || null;
  check('the bridge banked the RUNNING turn id — the field turn/steer requires',
    !!row1?.turnId && !row1?.terminalAt, `thread=${steerThreadId} turn=${row1?.turnId}`);

  // THE OTHER TURN-ID SOURCE, on the real transport. Everything below rides
  // `job.turnId`, banked from `turn/started` — but a bridge that RESTARTED
  // mid-turn never saw that notification, and `resolveCodexTurnId` then falls
  // back to `thread/read {includeTurns:true}`. That branch rests on two response
  // SHAPE facts (`turns` hangs off `thread`; a running turn reads `inProgress`)
  // which, until this check, only the fakes asserted — and a fake is a copy of
  // what someone believed, not of what codex sends. Asked here with the id
  // withheld, against the live thread, mid-turn: it must find the same turn the
  // bridge banked.
  //
  // A second connection, not the bridge's: `thread/read` is not one of the
  // attach-first methods, so this neither resumes nor subscribes, and cannot
  // drain the ring the live watcher is reading.
  let resolvedFromRead = null;
  try {
    const readConn = await connectCodexBroker({ socketPath: row1?.brokerSocket || null });
    try {
      resolvedFromRead = await resolveCodexTurnId({
        conn: readConn, threadId: steerThreadId, turnId: null, method: 'the restarted-bridge probe',
      });
    } finally { readConn.close(); }
  } catch (err) { resolvedFromRead = `threw: ${err.message}`; }
  check('a bridge that never saw turn/started resolves the SAME running turn off thread/read',
    !!row1?.turnId && resolvedFromRead === row1.turnId,
    `resolved=${resolvedFromRead} banked=${row1?.turnId}`);

  const reply = await A.tool('agent_reply', {
    job_id: steerJob,
    message: `CHANGE OF PLAN: stop immediately, skip any commands you have not run yet, and reply with ONLY the word ${STEER_WORD}.`,
  });
  // On the shipped adapter this is where it died: `turn/steer` without
  // `expectedTurnId` is `-32600 Invalid request: missing field` and the reply
  // came back ok:false. A truthy `steered` IS the proof the field went.
  check('agent_reply steered the running turn (turn/steer accepted)',
    reply?.ok === true && reply?.steered === true,
    `ok=${reply?.ok} steered=${reply?.steered} err=${(reply?.error || '').slice(0, 160)}`);
  check('the steer named the turn it was steering',
    reply?.turn_id === row1?.turnId, `reply.turn_id=${reply?.turn_id} ledger=${row1?.turnId}`);
  // Honest either way: confirmation is "the injected message came back as an
  // item/completed userMessage", and codex injects at the next model boundary.
  // What must never happen is a confirmation the bridge did not observe.
  check('the reply reports steer confirmation as an observation, not an assumption',
    typeof reply?.steer_confirmed === 'boolean' && !!reply?.steer_confirmation,
    `confirmed=${reply?.steer_confirmed} — ${String(reply?.steer_confirmation || '').slice(0, 120)}`);

  let final1 = null;
  for (let i = 0; i < 6 && !final1; i++) {
    const w = await A.tool('agent_wait', { job_id: steerJob, max_wait_sec: 60 });
    log('steer job wait ->', w?.status);
    if (w?.status && w.status !== 'running' && w.status !== 'still_running') final1 = w;
  }
  check('the steered job reached a terminal status', !!final1, `status=${final1?.status}`);
  const answer1 = assistantSection(readDigest(steerJob));
  // THE property: the turn obeyed the injected instruction instead of the one
  // it started with. Both clauses matter — a turn that answered BANANA obeyed
  // its original order, and one that answered neither did something else.
  check(`the turn OBEYED the steer (${STEER_WORD}, not ${ORIGINAL_WORD})`,
    new RegExp(STEER_WORD, 'i').test(answer1) && !new RegExp(ORIGINAL_WORD, 'i').test(answer1),
    answer1.slice(0, 160) || '(no assistant message)');

  // ======================================================================
  // 2. agent_cancel interrupts a RUNNING turn — and the THREAD survives.
  // ======================================================================
  const send2 = await A.tool('agent_send', {
    task: task(ORIGINAL_WORD), cwd: work, mode: 'EXECUTE', template: 'general', parallel: 'never', max_wait_sec: 5,
  });
  const cancelJob = send2.job_id || send2.jobId;
  check('a second codex job dispatched for the cancel case', !!cancelJob, `job=${cancelJob}`);
  if (!cancelJob) throw new Error(JSON.stringify(send2).slice(0, 400));

  const row2 = await untilTurnBanked(cancelJob);
  cancelThreadId = row2?.companionSessionId || null;
  check('the second job banked its own turn id on its own thread',
    !!row2?.turnId && cancelThreadId !== steerThreadId,
    `thread=${cancelThreadId} turn=${row2?.turnId}`);

  const cancel = await A.tool('agent_cancel', { job_id: cancelJob });
  // Two shapes are both correct here, and which one arrives is a race: cancel
  // waits up to 5 s for the job to settle, so an interrupt this fast usually
  // comes back as the TERMINAL wait envelope rather than the `cancelling` one.
  // Either way `ok` is what separates "the interrupt was accepted" from the
  // `-32600` this probe exists to catch.
  check('agent_cancel interrupted the running turn (turn/interrupt accepted)',
    cancel?.ok === true && (cancel?.cancelled === true || cancel?.status === 'cancelled'),
    `ok=${cancel?.ok} status=${cancel?.status} err=${(cancel?.error || '').slice(0, 160)}`);
  // …so the id it sent is asserted on the bridge's own log line, which the
  // cancel path emits and nothing else does. Reading it back off the ledger
  // would only prove the WORKER banked an id, not that the interrupt used it.
  const interruptLine = readFileSync(join(work, 'bridge-A.log'), 'utf8').split('\n')
    .find((l) => l.includes('agent:cancel codex-appserver interrupt') && l.includes(cancelJob)) || '';
  check('the interrupt named the turn it was cancelling',
    interruptLine.includes(`turn=${row2?.turnId}`),
    interruptLine.slice(-160) || 'the bridge never logged a codex-appserver interrupt');

  let final2 = null;
  for (let i = 0; i < 6 && !final2; i++) {
    const w = await A.tool('agent_wait', { job_id: cancelJob, max_wait_sec: 30 });
    log('cancel job wait ->', w?.status);
    if (w?.status && w.status !== 'running' && w.status !== 'still_running' && w.status !== 'cancelling') final2 = w;
  }
  check('the cancelled job settled `cancelled`', final2?.status === 'cancelled',
    `status=${final2?.status} detail=${final2?.meta?.detail ?? readLedger(cancelJob)?.detail ?? ''}`);

  // --- The property that makes this transport worth its cost. The exec adapter
  // SIGTERMs the process and the thread is gone; here only the TURN ends.
  const health = await probeCodexBrokerHealth(row2?.brokerSocket || null);
  brokerPid = health.brokerPid;
  let loaded = [];
  let resumed = null;
  let transcript = null;
  if (health.alive) {
    const conn = await connectCodexBroker({ socketPath: health.socketPath });
    try {
      loaded = await listLoadedCodexThreads({ conn });
      resumed = await resumeCodexThread({ conn, threadId: cancelThreadId });
      transcript = await readCodexThread({ conn, threadId: cancelThreadId });
    } finally { conn.close(); }
  }
  check('the thread is STILL LOADED on the broker after the interrupt',
    loaded.includes(cancelThreadId), `loaded=${loaded.length} thread=${cancelThreadId}`);
  check('the cancelled thread RESUMES — idle, not lost',
    resumed?.status === 'idle', `status=${resumed?.status} last_turn=${JSON.stringify(resumed?.lastTurn)}`);
  // The turn's own status, from the thread the interrupt left behind. This is
  // the interrupt's fingerprint: `interrupted`, with no answer.
  check('the interrupted turn is recorded as `interrupted` on the surviving thread',
    resumed?.lastTurn?.status === 'interrupted',
    `last_turn=${JSON.stringify(resumed?.lastTurn)}`);
  // `thread/read` over RPC is the salvage channel, and it still answers for a
  // thread whose turn was interrupted. Asserted on the TURNS, not on
  // `found` — `found` means "an assistant message exists", and a turn cancelled
  // seconds in legitimately has none. What must survive is the history: the
  // cancelled turn, by id, still carrying the task it was given.
  const readTurns = transcript?.raw?.thread?.turns || [];
  check('the surviving thread reads its history back over RPC (thread/read)',
    readTurns.some((t) => t.id === row2?.turnId) && JSON.stringify(readTurns).includes('sleep 15'),
    `turns=${readTurns.length} has_message=${transcript?.found}`);

  const doneStatus = await A.tool('agent_status', { job_id: cancelJob, verbose: true });
  check('agent_status reports the cancelled job as resumable but not repliable',
    doneStatus?.reply_available === false && doneStatus?.resume_available === true,
    `reply=${doneStatus?.reply_available} resume=${doneStatus?.resume_available}`);
} catch (e) {
  check('control run completed without throwing', false, e.message);
} finally {
  try { A?.proc?.stdin?.end(); A?.proc?.kill(); } catch {}

  // Reaped deliberately, with the same discipline appserver.mjs uses: SIGTERM
  // only (the handler stops the app-server child and unlinks the socket;
  // SIGKILL leaves the stale socket every later start has to probe around),
  // only OUR broker, and only when nobody else is on it — the broker is
  // machine-wide by design. `probeCodexBrokerHealth` connects, so its own
  // connection is inside the count it reports: "somebody else" is `clients - 1`.
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
        const foreign = loaded.filter((id) => id !== steerThreadId && id !== cancelThreadId);
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
console.log(`\n===== APP-SERVER CONTROL PROOF: ${results.length - bad.length}/${results.length} passed =====`);
for (const f of bad) console.log(`  FAIL: ${f.n} — ${f.d}`);
process.exit(bad.length ? 1 : 0);
