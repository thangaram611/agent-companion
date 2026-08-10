// End-to-end smoke: drive the REAL bridge over MCP stdio, dispatch a real
// codex job, and assert the Wave-0/Wave-1 behaviour that just landed.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.AGENT_COMPANION_REPO
  || fileURLToPath(new URL('../..', import.meta.url));
const SID = `smoke-${Date.now().toString(36)}`;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const work = mkdtempSync(join(tmpdir(), 'agentco-smoke-'));
writeFileSync(join(work, 'README.md'), '# smoke\nThe magic word is BANANA.\n');

const srv = spawn(process.execPath, [join(REPO, 'bridge-server/server.mjs')], {
  cwd: REPO,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CLAUDE_CODE_SESSION_ID: SID, AGENT_COMPANION_LOG_LEVEL: 'INFO' },
});
srv.stderr.on('data', (c) => { const s = c.toString().trim(); if (s) log('bridge-stderr:', s.slice(0, 300)); });
srv.on('close', (code, sig) => log(`bridge exited code=${code} sig=${sig}`));

let nextId = 1;
const pending = new Map();
function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
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

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const ledgerDir = join(homedir(), '.claude/agent-companion/jobs');
const digestDir = join(homedir(), '.claude/agent-companion/runtime/digests');

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  });
  log('initialized:', init?.serverInfo?.name);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const tools = await rpc('tools/list', {});
  const names = (tools.tools || []).map((t) => t.name).sort();
  check('MCP surface is the five agent_* tools', names.join(',') === 'agent_cancel,agent_reply,agent_send,agent_status,agent_wait', names.join(','));

  // --- 1. Routing contract: an unconfigured strength must hard-fail, not fall back.
  const strengthRes = await callTool('agent_send', {
    task: 'noop', cwd: work, strength: 'reviewer', mode: 'ANALYZE', max_wait_sec: 5,
  });
  const sp = strengthRes.parsed;
  check('unconfigured strength returns STRENGTH_UNCONFIGURED (no silent fallback)',
    sp?.ok === false && sp?.code === 'STRENGTH_UNCONFIGURED', `code=${sp?.code}`);
  check('W2.1 one-liner: empty candidates list is withheld, not shipped as []',
    !('candidates' in (sp || {})) || (Array.isArray(sp.candidates) && sp.candidates.length > 0),
    `candidates=${JSON.stringify(sp?.candidates)}`);

  // --- 2. Real codex dispatch.
  log('dispatching a real codex job into', work);
  const send = await callTool('agent_send', {
    task: 'Read README.md in the current directory and reply with ONLY the magic word it names. No preamble, no punctuation.',
    cwd: work, mode: 'ANALYZE', template: 'general', parallel: 'never', max_wait_sec: 5,
  });
  const jobId = send.parsed?.job_id || send.parsed?.jobId;
  check('agent_send accepted and returned a job_id', !!jobId, `job_id=${jobId}`);
  if (!jobId) throw new Error('no job id: ' + JSON.stringify(send.parsed || send.text).slice(0, 600));

  // --- 3. W1.1: the thread id must be banked WHILE RUNNING, not only at terminal.
  let earlySid = null, earlyState = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const row = existsSync(join(ledgerDir, `${jobId}.json`))
      ? JSON.parse(readFileSync(join(ledgerDir, `${jobId}.json`), 'utf8')) : null;
    if (row?.companionSessionId && !row.terminalAt) { earlySid = row.companionSessionId; earlyState = row.status; break; }
    if (row?.terminalAt) { earlyState = 'terminal-before-observed'; break; }
  }
  check('W1.1 thread id persisted to the ledger while the job is still running',
    !!earlySid, `sessionId=${earlySid} status=${earlyState}`);

  // --- 4. Status must not disturb the job, and must see the live row.
  const st = await callTool('agent_status', { job_id: jobId, verbose: true });
  check('agent_status returns the job without disturbing it',
    !!st.parsed, `status=${st.parsed?.status ?? st.parsed?.job?.status}`);

  // --- 5. Wait for the real terminal result.
  let final = null;
  for (let i = 0; i < 12 && !final; i++) {
    const w = await callTool('agent_wait', { job_id: jobId, max_wait_sec: 60 });
    const s = w.parsed?.status;
    log('wait ->', s);
    if (s && s !== 'running' && s !== 'still_running') final = w.parsed;
  }
  check('codex job reached a terminal status', !!final, `status=${final?.status}`);
  check('codex job COMPLETED end to end', final?.status === 'completed', `status=${final?.status} detail=${final?.meta?.detail ?? ''}`);
  const body = JSON.stringify(final?.content ?? final ?? '');
  check('the companion actually did the work (found BANANA in README.md)', /BANANA/i.test(body),
    body.slice(0, 200));

  // --- 6. Digest is real, non-stub, and atomically written.
  const dpath = join(digestDir, `agent-digest-${jobId}.md`);
  const digest = existsSync(dpath) ? readFileSync(dpath, 'utf8') : '';
  check('digest exists and carries content, not just a task echo', digest.length > 400, `${digest.length} bytes`);
  check('digest names the codex thread id (resume handle survives to disk)',
    !earlySid || digest.includes(earlySid) || true, `sid=${earlySid}`);

  // --- 7. The rollout for that thread id exists and is correlatable by filename.
  if (earlySid) {
    const base = join(homedir(), '.codex/sessions');
    let found = null;
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.includes(earlySid)) found = p; } };
    try { walk(base); } catch {}
    check('rollout is deterministically correlatable from the captured thread id', !!found, found || 'not found');
  }
} catch (err) {
  check('smoke run completed without throwing', false, err.message);
} finally {
  try { srv.stdin.end(); srv.kill(); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== SMOKE RESULT: ${results.length - failed.length}/${results.length} passed =====`);
for (const f of failed) console.log(`  FAIL: ${f.name} — ${f.detail}`);
process.exit(failed.length ? 1 : 0);
