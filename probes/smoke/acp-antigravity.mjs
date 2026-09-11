// End-to-end smoke for the generic ACP transport with Google's Antigravity ACP
// server as the companion (docs/MVP_TRACKER.md item 8): drive the REAL bridge
// over MCP stdio as a client would, against the REAL detached
// `acp-daemon --companion antigravity` and a real `agy_acp_server.par`.
// Spends about six Antigravity turns.
//
// Needs the server installed and signed in:
// `node scripts/install-antigravity-acp.mjs --login`. Run
// `node scripts/onboard.mjs --list-targets` first; it reads the credential
// state without spending a turn.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.AGENT_COMPANION_REPO
  || fileURLToPath(new URL('../..', import.meta.url));
const SID = `agysmoke-${Date.now().toString(36)}`;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const work = mkdtempSync(join(tmpdir(), 'agentco-antigravity-smoke-'));
writeFileSync(join(work, 'README.md'), '# smoke\nThe magic word is BANANA.\n');

const runtimeDir = join(homedir(), '.claude/agent-companion/runtime');
const ledgerDir = join(homedir(), '.claude/agent-companion/jobs');
const digestDir = join(runtimeDir, 'digests');

// One MCP client per bridge process; the restart scenario needs two.
function startBridge(label) {
  const srv = spawn(process.execPath, [join(REPO, 'bridge-server/server.mjs')], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: SID, AGENT_COMPANION_LOG_LEVEL: 'INFO' },
  });
  srv.stderr.on('data', (c) => { const s = c.toString().trim(); if (s) log(`${label}-stderr:`, s.slice(0, 300)); });
  srv.on('close', (code, sig) => log(`${label} exited code=${code} sig=${sig}`));
  let nextId = 1;
  const pending = new Map();
  const rpc = (method, params) => {
    const id = nextId++;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  let buf = '';
  srv.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    }
  });
  const callTool = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: { ...args, host_session_id: SID } });
    const text = r?.content?.find((c) => c.type === 'text')?.text ?? '';
    try { return { parsed: JSON.parse(text), raw: r }; } catch { return { parsed: null, text, raw: r }; }
  };
  const init = async () => {
    const r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'antigravity-smoke', version: '1.0.0' } });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    return r;
  };
  const waitTerminal = async (jobId, { rounds = 12, sec = 60 } = {}) => {
    let final = null;
    for (let i = 0; i < rounds && !final; i++) {
      const w = await callTool('agent_wait', { job_id: jobId, max_wait_sec: sec });
      const s = w.parsed?.status;
      log(`${label} wait ->`, s);
      if (s && s !== 'running' && s !== 'still_running') final = w.parsed;
    }
    return final;
  };
  return { srv, rpc, callTool, init, waitTerminal };
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const bodyOf = (final) => JSON.stringify(final?.content ?? final ?? '');
const readLedger = (jobId) => (existsSync(join(ledgerDir, `${jobId}.json`)) ? JSON.parse(readFileSync(join(ledgerDir, `${jobId}.json`), 'utf8')) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let A = startBridge('A');
let B = null;
try {
  await A.init();

  // --- 1. A real Antigravity job: send, ledger while running, no usage on this surface.
  log('dispatching a real antigravity job into', work);
  const send = await A.callTool('agent_send', {
    target: 'antigravity', cwd: work, mode: 'ANALYZE', template: 'general', parallel: 'never', max_wait_sec: 5,
    task: 'Read README.md in the current directory and reply with ONLY the magic word it names. No preamble, no punctuation.',
  });
  const jobId = send.parsed?.job_id;
  const thread = send.parsed?.thread;
  check('agent_send(target: antigravity) accepted and returned a job_id', !!jobId, `job_id=${jobId} thread=${thread}`);
  if (!jobId) throw new Error('no job id: ' + JSON.stringify(send.parsed || send.text).slice(0, 600));

  let earlySid = null;
  for (let i = 0; i < 40 && !earlySid; i++) {
    await sleep(500);
    const row = readLedger(jobId);
    if (row?.companionSessionId && !row.terminalAt) earlySid = row.companionSessionId;
    if (row?.terminalAt) break;
  }
  check('the ACP session id is in the ledger while the job is still running', !!earlySid, `sessionId=${earlySid}`);

  const final = await A.waitTerminal(jobId);
  check('the antigravity job COMPLETED end to end', final?.status === 'completed', `status=${final?.status} detail=${final?.meta?.detail ?? ''}`);
  check('the companion did the work (BANANA from README.md)', /BANANA/i.test(bodyOf(final)), bodyOf(final).slice(0, 160));
  check('terminal meta carries NO usage key — the ACP surface reports none, and nothing is zeroed in its place',
    !('usage' in (final?.meta || {})), JSON.stringify(final?.meta?.usage ?? null));
  check('terminal meta.session_id names the ACP session', !!final?.meta?.session_id && final.meta.session_id === (earlySid || final.meta.session_id), `session=${final?.meta?.session_id}`);
  const digestPath = join(digestDir, `agent-digest-${jobId}.md`);
  const digest = existsSync(digestPath) ? readFileSync(digestPath, 'utf8') : '';
  check('the digest is headed by the companion and carries content', /^# Google Antigravity job /.test(digest) && digest.length > 300, `${digest.length} bytes`);
  check('the antigravity daemon owns its own socket and log', existsSync(join(runtimeDir, 'antigravity-acp.sock')) && existsSync(join(runtimeDir, 'antigravity-acp-daemon.log')));
  const prompts = readdirSync(join(runtimeDir, 'prompts')).filter((f) => f.startsWith('antigravity-acp-'));
  check('the prompt stream is keyed by companion', prompts.length > 0, prompts.slice(0, 2).join(','));
  const status = await A.callTool('agent_status', {});
  const reg = status.parsed?.acp_daemons?.antigravity;
  check('acp-daemons.json records the antigravity daemon this bridge adopted', !!reg?.pid && reg.socketPath === join(runtimeDir, 'antigravity-acp.sock'), JSON.stringify(reg));
  const daemonPid = reg?.pid;

  // --- 2. Thread continuity: the second send lands on the same ACP session.
  const send2 = await A.callTool('agent_send', {
    target: 'antigravity', cwd: work, thread, mode: 'ANALYZE', template: 'general', parallel: 'never', max_wait_sec: 5,
    task: 'What magic word did you report a moment ago? Reply with ONLY that word, from memory — do not read any file.',
  });
  const final2 = await A.waitTerminal(send2.parsed?.job_id);
  check('round two on the same thread completed', final2?.status === 'completed', `status=${final2?.status}`);
  check('round two rode the SAME ACP session (no rebirth)',
    final2?.meta?.session_id === final?.meta?.session_id && final2?.meta?.session_reborn === undefined,
    `session=${final2?.meta?.session_id} reborn=${final2?.meta?.session_reborn}`);
  check('round two remembered round one without re-reading the file', /BANANA/i.test(bodyOf(final2)), bodyOf(final2).slice(0, 160));

  // --- 3. Reply: cancel + re-prompt on the same session, said so, follow-up wins.
  const send3 = await A.callTool('agent_send', {
    target: 'antigravity', cwd: work, mode: 'EXECUTE', template: 'general', parallel: 'never', max_wait_sec: 5,
    task: 'Run the shell command `sleep 40` (wait for it to finish), then reply with ONLY the word SLEPT.',
  });
  const job3 = send3.parsed?.job_id;
  let running3 = false;
  for (let i = 0; i < 40 && !running3; i++) { await sleep(500); const row = readLedger(job3); running3 = row?.status === 'running' && !!row.promptId; }
  await sleep(4000);
  const reply = await A.callTool('agent_reply', { job_id: job3, message: 'Stop waiting for the sleep. Reply with ONLY the word PIVOT.' });
  check('agent_reply is accepted and says the turn was cancelled and re-prompted — no steer claimed',
    reply.parsed?.ok === true && /cancelled/.test(reply.parsed?.hint || '') && /no mid-turn steer/.test(reply.parsed?.hint || ''),
    JSON.stringify(reply.parsed).slice(0, 300));
  const final3 = await A.waitTerminal(job3);
  check('the replied job completed and the follow-up won', final3?.status === 'completed' && /PIVOT/i.test(bodyOf(final3)), `status=${final3?.status} ${bodyOf(final3).slice(0, 120)}`);

  // --- 4. Cancel settles cancelled.
  const send4 = await A.callTool('agent_send', {
    target: 'antigravity', cwd: work, mode: 'EXECUTE', template: 'general', parallel: 'never', max_wait_sec: 5,
    task: 'Run the shell command `sleep 45`, then reply with ONLY the word FINISHED.',
  });
  const job4 = send4.parsed?.job_id;
  for (let i = 0; i < 40; i++) { await sleep(500); const row = readLedger(job4); if (row?.status === 'running' && row.promptId) break; }
  await sleep(3000);
  const cancel = await A.callTool('agent_cancel', { job_id: job4 });
  const final4 = cancel.parsed?.status && !['cancelling'].includes(cancel.parsed.status) ? cancel.parsed : await A.waitTerminal(job4, { rounds: 4, sec: 30 });
  check('agent_cancel settles the job cancelled', final4?.status === 'cancelled', `status=${final4?.status}`);

  // --- 5. Restart survival: bridge A SIGKILLed mid-turn, bridge B rejoins the same prompt.
  const send5 = await A.callTool('agent_send', {
    target: 'antigravity', cwd: work, mode: 'EXECUTE', template: 'general', parallel: 'never', max_wait_sec: 5,
    task: 'Run the shell command `sleep 30` (wait for it to finish), then reply with ONLY the word SURVIVED.',
  });
  const job5 = send5.parsed?.job_id;
  let promptId5 = null;
  for (let i = 0; i < 60 && !promptId5; i++) { await sleep(500); const row = readLedger(job5); if (row?.status === 'running' && row.promptId) promptId5 = row.promptId; }
  check('the restart job registered its prompt on the daemon before the kill', !!promptId5, `promptId=${promptId5}`);
  await sleep(3000);
  A.srv.kill('SIGKILL');
  log('bridge A SIGKILLed mid-turn');
  await sleep(1500);
  const regAfter = existsSync(join(runtimeDir, 'acp-daemons.json')) ? JSON.parse(readFileSync(join(runtimeDir, 'acp-daemons.json'), 'utf8')).antigravity : null;
  let daemonAlive = false;
  try { process.kill(daemonPid, 0); daemonAlive = true; } catch {}
  check('the antigravity daemon outlives the bridge', daemonAlive && regAfter?.pid === daemonPid, `pid=${daemonPid}`);

  B = startBridge('B');
  await B.init();
  const st5 = await B.callTool('agent_status', { job_id: job5 });
  check('bridge B hydrated the in-flight job as running, resumable, same prompt id',
    st5.parsed?.status === 'running' && st5.parsed?.resume_available === true && st5.parsed?.prompt_id === promptId5,
    `status=${st5.parsed?.status} resume=${st5.parsed?.resume_available} prompt=${st5.parsed?.prompt_id}`);
  const final5 = await B.waitTerminal(job5);
  check('the job completed on bridge B with no re-prompt (same prompt id, the answer intact)',
    final5?.status === 'completed' && final5?.meta?.prompt_id === promptId5 && /SURVIVED/i.test(bodyOf(final5)),
    `status=${final5?.status} prompt=${final5?.meta?.prompt_id} ${bodyOf(final5).slice(0, 100)}`);
  check('the restart verdict is not a bridge-lifecycle retirement', !['bridge_lifecycle'].includes(final5?.meta?.failure_class) && final5?.meta?.detail !== 'rehydrate_no_promptid', `class=${final5?.meta?.failure_class ?? '-'}`);

  // --- 6. A model pin reaches the session as `session/set_config_option`. Sent
  // straight to the daemon socket (what the bridge sends for a profile model),
  // so no profile is written into the operator's real state.
  const { sendToSocket } = await import(join(REPO, 'bridge-server/daemon-client.mjs'));
  const pinned = await sendToSocket({ command: 'prompt-bg', cwd: work, text: 'Reply with ONLY the word PINNED.', model: 'gemini-3.8-flash-low' }, 60000, 'antigravity');
  check('the daemon accepts a prompt with a model pin', pinned?.ok === true, JSON.stringify(pinned).slice(0, 200));
  let pinnedFinal = null;
  for (let i = 0; i < 6 && !pinnedFinal; i++) {
    const w = await sendToSocket({ command: 'watch', promptId: pinned?.data?.promptId, since: 0, raw: false, wait: 30, summaryOnly: true }, 45000, 'antigravity');
    if (w?.data?.status && !['running', 'pending'].includes(w.data.status)) pinnedFinal = w.data;
  }
  check('the pinned prompt completed', pinnedFinal?.status === 'completed', `status=${pinnedFinal?.status}`);
  const daemonLog = readFileSync(join(runtimeDir, 'antigravity-acp-daemon.log'), 'utf8');
  check('the daemon log shows session/set_config_option applied with the pinned model',
    /session\/set_config_option ok:.*gemini-3\.8-flash-low/.test(daemonLog), (daemonLog.match(/session\/set_config_option ok:[^\n]*/g) || []).slice(-1).join(''));
} catch (err) {
  check('smoke run completed without throwing', false, err.message);
} finally {
  try { A.srv.stdin.end(); A.srv.kill(); } catch {}
  try { B?.srv.stdin.end(); B?.srv.kill(); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ANTIGRAVITY ACP SMOKE RESULT: ${results.length - failed.length}/${results.length} passed =====`);
for (const f of failed) console.log(`  FAIL: ${f.name} — ${f.detail}`);
process.exit(failed.length ? 1 : 0);
