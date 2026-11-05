// server.mjs must be importable from tests without attaching to stdio and
// must expose enough seams to validate bridge behavior without a real daemon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const STATE_SANDBOX = mkdtempSync(join(tmpdir(), 'copilot-state-server-'));
process.env.AGENT_COMPANION_HOME = STATE_SANDBOX;
// runtimeDir() is pinned rather than the bridge log alone: AGENT_COMPANION_HOME
// does not reach it (lib/host.mjs derives the companion home from the HOST, not
// from that var), and the bridge log is not the only artifact a fake job leaves
// behind. Measured for one run of this file against the operator's live
// ~/.claude/agent-companion/runtime: 31,396 bytes of agent-bridge.log, 22,031
// bytes of completions.jsonl — the ledger a restarted bridge HYDRATES JOBS FROM,
// so fabricated jobs came back as real ones — and 19 digest files. One knob
// moves all of them (lib/runtime-paths.test.mjs pins that invariant). Never
// unset it in teardown: clearing it is exactly what re-points a straggler at the
// real path. Short dir name because a unix socket path over SUN_LEN (~104 bytes
// on darwin) binds a silently truncated name.
const RUNTIME_SANDBOX = mkdtempSync(join(tmpdir(), 'ac-rt-srv-'));
process.env.AGENT_RUNTIME_DIR = RUNTIME_SANDBOX;
process.env.AGENT_COMPANION_DEFAULT_TARGET = 'copilot';
const TEST_CWD = tmpdir();
const EXACT_TASK = '  First line.\n\nSecond line: `quoted` — keep whitespace.  \n';

const { Records } = await import('./controller/records.mjs');

test.after(() => {
  rmSync(STATE_SANDBOX, { recursive: true, force: true });
  rmSync(RUNTIME_SANDBOX, { recursive: true, force: true });
});

async function bridge() {
  return import('./server.mjs');
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

async function withEnv(key, value, fn) {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return await fn(); }
  finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

async function withQueue(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'copilot-queue-test-'));
  const queueFile = join(tmp, 'completions.jsonl');
  const oldQ = process.env.AGENT_QUEUE_PATH;
  process.env.AGENT_QUEUE_PATH = queueFile;
  try { return await fn(queueFile); }
  finally {
    if (oldQ === undefined) delete process.env.AGENT_QUEUE_PATH;
    else process.env.AGENT_QUEUE_PATH = oldQ;
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readQueue(queueFile) {
  return readFileSync(queueFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function withDaemonStubs(stubs, body) {
  const daemonClient = await import('./daemon-client.mjs');
  daemonClient._setForTest(stubs);
  try { return await body(); }
  finally { daemonClient._resetForTest(); }
}

function terminalJob(jobId, status, extra = {}) {
  return {
    jobId,
    target: 'copilot',
    status,
    task: 'X',
    durationMs: 1000,
    failedTools: [],
    startedAt: Date.now() - 1000,
    terminalAt: Date.now(),
    retentionExpiresAt: Date.now() + 60_000,
    ...extra,
  };
}


test('wait-budget clamping keeps the existing bounds', async () => {
  const { clampWaitSec } = await bridge();
  assert.equal(clampWaitSec(700), 700);
  assert.equal(clampWaitSec(1200), 1200);
  assert.equal(clampWaitSec(1500), 1200);
  for (const value of [undefined, null, 0, 'not a number']) assert.equal(clampWaitSec(value), 480);
  assert.equal(clampWaitSec(0.4), 1);
});


test('buildJobResponse and session-reborn content preserve bridge-owned status/detail metadata', async () => {
  const { buildJobResponse, formatTerminalContent } = await bridge();
  assert.equal(buildJobResponse(
    terminalJob('j1', 'timeout'),
    { status: 'failed', stuckReason: null },
  ).status, 'timeout');
  assert.equal(buildJobResponse(
    terminalJob('j2', 'unreachable', { detail: 'bridge_daemon_unreachable' }),
    { status: 'completed', summary: { message: 'oops' } },
  ).status, 'unreachable');
  assert.equal(buildJobResponse(
    terminalJob('j2-class', 'unreachable', {
      target: 'codex', detail: 'codex_code_mode_host_unavailable',
    }),
  ).failure_class, 'runtime_unavailable');
  assert.equal(buildJobResponse({ jobId: 'j3', status: 'starting', startedAt: Date.now() }, { status: 'running' }).status, 'running');
  assert.equal(buildJobResponse(terminalJob('j4', 'unreachable', { detail: 'bridge_timeout' })).detail, 'bridge_timeout');
  assert.equal(buildJobResponse(terminalJob('j5', 'completed')).detail, null);
  assert.equal(buildJobResponse(terminalJob('j6', 'completed', { detail: null }), { status: 'completed', detail: 'spurious' }).detail, null);
  assert.equal(buildJobResponse(terminalJob('j-rb', 'completed', { sessionReborn: true })).session_reborn, true);
  assert.equal(buildJobResponse(terminalJob('j-ret', 'timeout', { sessionRetired: true })).session_retired, true);
  assert.equal(buildJobResponse(terminalJob('j-norm', 'completed')).session_reborn, false);

  const content = formatTerminalContent({
    jobId: 'jr1', status: 'completed', task: 'continue thread',
    durationMs: 1234,
    summary: { message: 'OK\n\nRUBBER-DUCK: clean.', toolCalls: [] },
    error: null, stuckReason: null, detail: null, failedTools: [],
    promptId: 'p1', sessionReborn: true,
  });
  assert.match(content, /GitHub Copilot CLI session was respawned mid-thread/);
  assert.ok(content.indexOf('respawned mid-thread') < content.indexOf('Task:'));
});


test('emitNotification writes queue rows with status remaps, detail/session metadata and private permissions', async () => {
  const { emitNotification } = await bridge();
  await withQueue(async (queueFile) => {
    await withEnv('CLAUDE_CODE_SESSION_ID', 'cc-test-session-abc', async () => {
      emitNotification({
        jobId: 'j-detail', status: 'unreachable', detail: 'bridge_daemon_unreachable',
        summary: null, error: null, stuckReason: null, duration: 1234,
        task: 'X', cwd: '/tmp',
      });
    });
    let event = readQueue(queueFile).at(-1);
    assert.equal(event.kind, 'terminal');
    assert.equal(event.claudeSessionId, 'cc-test-session-abc');
    assert.equal(event.meta.status, 'unreachable');
    assert.equal(event.meta.detail, 'bridge_daemon_unreachable');
    assert.equal(event.meta.failure_class, 'runtime_unavailable');

    emitNotification({
      jobId: 'j-capi', status: 'completed',
      summary: {
        stopReason: 'end_turn',
        message: 'Info: Request failed due to a transient API error. Retrying...\nError: Execution failed: Error: Failed to get response from the AI model; retried 5 times. Last error: CAPIError: Request timed out.',
      },
      duration: 142383, task: 'X', cwd: '/tmp',
    });
    event = readQueue(queueFile).at(-1);
    assert.equal(event.meta.status, 'failed');
    assert.equal(event.meta.detail, 'copilot_capi_failure');
    assert.equal(event.meta.stop_reason, 'end_turn');

    await withEnv('CLAUDE_CODE_SESSION_ID', undefined, async () => {
      emitNotification({
        jobId: 'j-ok', status: 'completed',
        summary: { stopReason: 'end_turn', message: 'All checks pass.\nRUBBER-DUCK: clean.', toolCalls: [
          { input: { agent_type: 'rubber-duck' }, status: 'completed' },
        ] },
        duration: 2000, task: 'X', cwd: '/tmp',
      });
    });
    event = readQueue(queueFile).at(-1);
    assert.equal(event.claudeSessionId, null);
    assert.equal(event.meta.status, 'completed');
    assert.equal(event.meta.detail, undefined);
    assert.equal(Object.hasOwn(event.meta, 'rubber_duck'), false);
    assert.equal((await import('node:fs')).statSync(queueFile).mode & 0o777, 0o600);

    // Defensive boundary: even a direct/reconciled notification cannot
    // publish this protocol completion as a task verdict.
    emitNotification({
      jobId: 'j-code-host', target: 'codex', status: 'completed',
      summary: {
        stopReason: 'turn/completed', toolCalls: [],
        message: 'I cannot run commands because codex-code-mode-host is missing.',
      },
      duration: 3000, task: 'review', cwd: '/tmp',
    });
    event = readQueue(queueFile).at(-1);
    assert.equal(event.meta.status, 'unreachable');
    assert.equal(event.meta.detail, 'codex_code_mode_host_unavailable');
    assert.equal(event.meta.failure_class, 'runtime_unavailable');
    assert.equal(event.meta.stop_reason, 'turn/completed');
    assert.match(event.content, /app-server was reachable, but its command runner was unavailable/);
    assert.match(event.content, /not a task verdict/);
  });
});


// The host session id reaches the bridge from the host, never from the model:
// Claude Code's bridge inherits CLAUDE_CODE_SESSION_ID, Codex's reads it from
// MCP _meta. There is no argument to forward it in.
test('the host session id comes from the host: inherited env on Claude, _meta on Codex', async () => {
  const { callArgs, getHostSessionId, _resetForTest } = await bridge();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const codex = (sid) => ({ arguments: { job_id: 'missing' }, _meta: { 'x-codex-turn-metadata': { session_id: sid, thread_id: 't', thread_source: 'subagent' } } });

  _resetForTest();
  try {
    process.env.CLAUDE_CODE_SESSION_ID = '${CLAUDE_CODE_SESSION_ID}';
    assert.equal(getHostSessionId(), null);
    process.env.CLAUDE_CODE_SESSION_ID = 'sid-claude-env';
    assert.equal(getHostSessionId(), 'sid-claude-env');

    delete process.env.CLAUDE_CODE_SESSION_ID;
    callArgs('wait', codex('sid-codex-meta'));
    assert.equal(getHostSessionId(), 'sid-codex-meta');
    assert.throws(() => callArgs('wait', codex('sid-other')), (err) => err.code === 'BRIDGE_SID_CONFLICT');
    assert.equal(getHostSessionId(), 'sid-codex-meta');
  } finally {
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

// One agent-companion instance is one companion conversation, so the thread is
// named after the calling agent, never after the host session: four reviewers
// spawned in one session once shared a single codex thread.
test('the host names the companion thread after the calling agent, and a send without one is refused', async () => {
  const { callArgs, getHostSessionId, _resetForTest } = await bridge();
  const send = { task: 'review', cwd: TEST_CWD };
  // Codex sends the caller's own thread id in its turn metadata; session_id is
  // the root session for every child.
  const codex = (threadId, args = send) => ({
    arguments: { ...args },
    _meta: { 'x-codex-turn-metadata': { session_id: 'sid-root', thread_id: threadId, thread_source: 'subagent' } },
  });

  _resetForTest();
  try {
    assert.equal(callArgs('send', codex('child-1')).thread, 'child-1');
    assert.equal(callArgs('send', codex('child-2')).thread, 'child-2');
    assert.equal(callArgs('send', codex('child-1')).thread, 'child-1');
    assert.equal(getHostSessionId(), 'sid-root');
    assert.equal(callArgs('send', codex('child-1', { ...send, thread: 'invented' })).thread, 'child-1');
    assert.equal(callArgs('status', codex('child-1', {})).thread, undefined);

    // Claude: hooks/name-thread.sh has already written the subagent's agent_id.
    assert.equal(callArgs('send', { arguments: { ...send, thread: 'a7aae695fc8e1726b' } }).thread, 'a7aae695fc8e1726b');

    assert.throws(() => callArgs('send', { arguments: { ...send } }), { code: 'NATIVE_OWNER_REQUIRED' });
  } finally {
    _resetForTest();
  }
});

test('all owner-bound MCP calls require a native child owner before adopting a session', async () => {
  const mod = await bridge();
  const call = mod.mcp._requestHandlers.get('tools/call');
  const inputs = { send: { task: 'review', cwd: TEST_CWD }, wait: { job_id: 'missing' }, reply: { job_id: 'missing', message: 'hi' }, cancel: { job_id: 'missing' } };
  await withEnv('CLAUDE_CODE_SESSION_ID', undefined, async () => {
    mod._resetForTest();
    try {
      for (const [action, args] of Object.entries(inputs)) {
        for (const params of [
          { arguments: args },
          { arguments: { ...args, thread: '' } },
          { arguments: { ...args, thread: 'invented' }, _meta: { 'x-codex-turn-metadata': { session_id: 'untrusted-root', thread_id: 'root', thread_source: 'user' } } },
          { arguments: { ...args, thread: 'invented' }, _meta: { 'x-codex-turn-metadata': { thread_id: 'missing-source' } } },
          { arguments: { ...args, thread: 'invented' }, _meta: { 'x-codex-turn-metadata': { thread_source: 'subagent' } } },
        ]) {
          const result = parse(await call({ method: 'tools/call', params: { name: `agent_${action}`, ...params } }));
          assert.equal(result.ok, false);
          assert.equal(result.status, 'NATIVE_OWNER_REQUIRED', `${action}: ${JSON.stringify(result)}`);
          assert.equal(mod.getHostSessionId(), null, 'refusal must precede session adoption/hydration');
        }
        assert.equal(mod.callArgs(action, { arguments: { ...args, thread: 'claude-child' } }).thread, 'claude-child');
        assert.equal(mod.callArgs(action, { arguments: { ...args, thread: 'invented' }, _meta: { 'x-codex-turn-metadata': { thread_source: 'subagent', thread_id: 'codex-child' } } }).thread, 'codex-child');
      }
      for (const args of [{}, { job_id: 'missing' }]) {
        assert.notEqual(parse(await call({ method: 'tools/call', params: { name: 'agent_status', arguments: args } })).status, 'NATIVE_OWNER_REQUIRED');
      }
      assert.equal(mod.callArgs('catalog', { arguments: {} }).action, 'catalog');
      const host = await import('../lib/host.mjs');
      await withEnv('AGENT_COMPANION_HOST', 'codex', async () => {
        host._resetHostCacheForTests();
        try {
          for (const [action, args] of Object.entries(inputs)) {
            assert.throws(() => mod.callArgs(action, { arguments: { ...args, thread: 'fabricated-without-meta' } }), { code: 'NATIVE_OWNER_REQUIRED' });
          }
        } finally { host._resetHostCacheForTests(); }
      });
    } finally { mod._resetForTest(); }
  });
});

for (const trigger of ['SIGINT', 'SIGTERM', 'EOF']) {
  test(`bridge loss: ${trigger} invokes the registered async hook once and waits before exit`, { timeout: 15_000 }, async (t) => {
    const server = new URL('./server.mjs', import.meta.url);
    const preload = `
      import { registerBridgeLossHandler } from ${JSON.stringify(server.href)};
      registerBridgeLossHandler(async () => {
        process.send('loss-start');
        await new Promise(resolve => process.once('message', resolve));
        process.send('loss-finished');
      });
      process.send('ready');
    `;
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(server)], { env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const messages = [];
    child.on('message', (msg) => messages.push(msg));
    let stderr = '';
    child.stderr.on('data', (part) => { stderr += part; });
    const exited = once(child, 'exit');
    const nextMessage = () => Promise.race([
      once(child, 'message').then(([message]) => message),
      exited.then(([code, signal]) => { throw new Error(`bridge exited early (${code ?? signal}): ${stderr}`); }),
    ]);
    assert.equal(await nextMessage(), 'ready');
    const started = nextMessage();
    if (trigger === 'EOF') child.stdin.end();
    else child.kill(trigger);
    assert.equal(await started, 'loss-start');
    // Exercise duplicates and the signal/EOF race while cleanup is awaiting.
    child.kill('SIGINT');
    child.kill('SIGTERM');
    child.stdin.end();
    assert.equal(child.exitCode, null);
    child.send('finish');
    const [code, signal] = await exited;
    assert.equal(signal, null);
    assert.equal(code, { SIGINT: 130, SIGTERM: 143, EOF: 0 }[trigger]);
    assert.deepEqual(messages, ['ready', 'loss-start', 'loss-finished']);
  });
}

test('hydrateJobsFromLedger preserves host/thread continuity and orphan recovery', async () => {
  const mod = await bridge();
  const { jobs, hydrateJobsFromLedger } = mod;
  const state = await import('../lib/state.mjs');

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-hydrate-A';
  try {
    state.writeJob('j-mine-terminal', {
      jobId: 'j-mine-terminal', claudeSessionId: 'sid-hydrate-A',
      target: 'copilot', companionSessionId: 'cop-1', thread: 'thread-restored',
      status: 'completed', startedAt: 1000, terminalAt: 2000,
      retentionExpiresAt: Date.now() + 60_000,
    });
    state.writeJob('j-other-session', {
      jobId: 'j-other-session', claudeSessionId: 'sid-other-B',
      status: 'running', startedAt: 1000,
    });
    state.writeJob('j-orphan', {
      jobId: 'j-orphan', claudeSessionId: 'sid-hydrate-A',
      target: 'copilot', status: 'starting', startedAt: 1000,
    });

    jobs.clear();
    mod._resetForTest();
    hydrateJobsFromLedger();
    assert.equal(jobs.has('j-mine-terminal'), true);
    assert.equal(jobs.has('j-other-session'), false);
    assert.equal(jobs.get('j-mine-terminal').sessionId, 'cop-1');
    assert.equal(state.readThreadSid('thread-restored'), 'cop-1');
    assert.equal(jobs.get('j-orphan').status, 'unreachable');
    assert.equal(jobs.get('j-orphan').detail, 'rehydrate_no_promptid');

    for (const id of ['j-mine-terminal', 'j-other-session', 'j-orphan']) state.deleteJob(id);
    state.clearThread('thread-restored');
    jobs.clear();
  } finally {
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    mod._resetForTest();
  }
});


test('hydrateJobsFromLedger skips a ledger entry with no target (no silent fallback)', async () => {
  const mod = await bridge();
  const { jobs, hydrateJobsFromLedger, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-no-target';
  try {
    _resetForTest();
    jobs.clear();
    state.writeJob('j-no-target', {
      jobId: 'j-no-target', claudeSessionId: 'sid-no-target',
      status: 'running', startedAt: 1000,
    });
    hydrateJobsFromLedger();
    assert.equal(jobs.has('j-no-target'), false);
  } finally {
    state.deleteJob('j-no-target');
    jobs.clear();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('sweepOwnSessionStaleQueueRows drops only stale rows for the current host session', async () => {
  const { sweepOwnSessionStaleQueueRows } = await bridge();
  await withQueue(async (queueFile) => {
    const oldS = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sid-sweep-A';
    try {
      const now = Date.now();
      writeFileSync(queueFile, [
        { ts: now - 90_000, kind: 'alert', jobId: 'j-mine-old', claudeSessionId: 'sid-sweep-A', consumed: false, content: 'mine-old' },
        { ts: now - 30_000, kind: 'alert', jobId: 'j-mine-fresh', claudeSessionId: 'sid-sweep-A', consumed: false, content: 'mine-fresh' },
        { ts: now - 90_000, kind: 'alert', jobId: 'j-other-old', claudeSessionId: 'sid-sweep-B', consumed: false, content: 'other-old' },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n');
      sweepOwnSessionStaleQueueRows(now);
      assert.deepEqual(readQueue(queueFile).map((r) => r.jobId).sort(), ['j-mine-fresh', 'j-other-old']);
    } finally {
      if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    }
  });
});


// --- Codex CLI adapter (bridge-server/codex-runtime.mjs) --------------------
//
// Same fakeBin-subprocess style as the OpenCode CLI tests above, adapted to
// codex's `exec --json` ThreadEvent stream (D10) instead of opencode's
// `run --format json` NDJSON. Per the safety contract, this NEVER invokes a
// real `codex` binary — CODEX_BIN always points at a fake script.


// --- OpenCode server-mode adapter (OPENCODE_RUNTIME_ADAPTER=server) ---------
//
// These drive the bridge through the server-runtime module's `_impl` seam: the
// bridge calls the module wrappers, the wrappers call `_impl.fetchJson` /
// `_impl.openEventStream` / `_impl.spawnServer`, so stubbing the module from the
// test rewires the whole server-mode path with no socket and no real opencode.

import { EventEmitter as _OcEmitter } from 'node:events';

function _ocFrame(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }
function _ocSse(frames) {
  return async () => (async function* () { for (const f of frames) yield f; })();
}
function _ocBootChild() {
  const child = new _OcEmitter();
  child.stdout = new _OcEmitter();
  child.stderr = new _OcEmitter();
  child.pid = 7777;
  child.unref = () => {};
  setImmediate(() => child.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:4096\n')));
  return child;
}

async function withOpenCodeServer(stubs, body) {
  const ocServer = await import('./opencode-server-runtime.mjs');
  const regDir = mkdtempSync(join(tmpdir(), 'oc-srv-reg-'));
  const oldReg = process.env.AGENT_OPENCODE_SERVER_REGISTRY;
  const oldAdapter = process.env.OPENCODE_RUNTIME_ADAPTER;
  process.env.AGENT_OPENCODE_SERVER_REGISTRY = join(regDir, 'servers.json');
  process.env.OPENCODE_RUNTIME_ADAPTER = 'server';
  ocServer._resetForTest();
  ocServer._setForTest({ spawnServer: _ocBootChild, ...stubs });
  try { return await body(ocServer); }
  finally {
    ocServer._resetForTest();
    if (oldReg === undefined) delete process.env.AGENT_OPENCODE_SERVER_REGISTRY; else process.env.AGENT_OPENCODE_SERVER_REGISTRY = oldReg;
    if (oldAdapter === undefined) delete process.env.OPENCODE_RUNTIME_ADAPTER; else process.env.OPENCODE_RUNTIME_ADAPTER = oldAdapter;
    rmSync(regDir, { recursive: true, force: true });
  }
}


test('OpenCode server mode: reply re-steers and bumps the watch generation before aborting', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  let promptIdAtAbort = null;
  try {
    await withOpenCodeServer({
      fetchJson: async (url) => {
        if (url.includes('/abort')) { promptIdAtAbort = jobs.get('opencode-srv-reply')?.promptId; return { ok: true, data: true }; }
        if (url.includes('/session/status')) return { ok: true, data: {} }; // idle after abort
        if (url.includes('/prompt_async')) return { ok: true, data: {} };
        return { ok: true, data: {} };
      },
      openEventStream: _ocSse([_ocFrame({ type: 'session.idle', properties: { sessionID: 'ses_reply' } })]),
    }, async () => {
      jobs.set('opencode-srv-reply', {
        jobId: 'opencode-srv-reply', target: 'opencode', opencodeAdapter: 'server',
        claudeSessionId: 'sid-oc-reply', status: 'running', promptId: 'opencode-srv-reply',
        sessionId: 'ses_reply', baseUrl: 'http://127.0.0.1:4096', task: 't',
        cwd: TEST_CWD, startedAt: Date.now(),
      });
      const reply = parse(await dispatch({ action: 'reply', job_id: 'opencode-srv-reply', message: 'revise' }));
      assert.equal(reply.ok, true);
      assert.equal(reply.target, 'opencode');
      assert.match(reply.new_prompt_id, /-r1$/);
      assert.equal(reply.session_id, 'ses_reply');
      // The generation must be bumped BEFORE the abort fires, so the old watcher
      // discards its (cancelled) terminal instead of resolving waiters.
      for (let i = 0; i < 50 && promptIdAtAbort == null; i++) await new Promise((r) => setImmediate(r));
      assert.match(promptIdAtAbort || '', /-r1$/);
    });
  } finally {
    jobs.delete('opencode-srv-reply');
    _resetForTest();
  }
});


test('OpenCode server mode: per-job status flags reflect reply/resume availability', async () => {
  const mod = await bridge();
  const { jobs, buildJobResponse, _resetForTest } = mod;
  _resetForTest();
  await withOpenCodeServer({}, async () => {
    const live = buildJobResponse({
      jobId: 'oc-live', target: 'opencode', opencodeAdapter: 'server',
      status: 'running', sessionId: 'ses_x', baseUrl: 'http://h', promptId: 'opencode-oc-live', startedAt: Date.now(),
    });
    assert.equal(live.reply_available, true);
    assert.equal(live.resume_available, true);
    // A cli-mode opencode job advertises neither.
    const cli = buildJobResponse({ jobId: 'oc-cli', target: 'opencode', status: 'running', promptId: 'opencode-oc-cli', startedAt: Date.now() });
    assert.equal(cli.reply_available, false);
    assert.equal(cli.resume_available, false);
  });
  _resetForTest();
});

test('OpenCode server mode: hydrate resumes a persisted job from its transcript', async () => {
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  _resetForTest();
  const state = await import('../lib/state.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-oc-hydrate';
  try {
    await withOpenCodeServer({
      fetchJson: async (url) => {
        if (url.includes('/global/health')) return { ok: true, data: { healthy: true } };
        if (url.includes('/session/status')) return { ok: true, data: {} }; // idle
        if (url.includes('/message')) return { ok: true, data: [
          { info: { role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{ type: 'text', text: 'finished while bridge was down' }] },
        ] };
        return { ok: true, data: {} };
      },
      openEventStream: _ocSse([]),
    }, async () => {
      // Persist a non-terminal server-mode job, then drop it from memory.
      jobs.set('opencode-hydrate', {
        jobId: 'opencode-hydrate', target: 'opencode', opencodeAdapter: 'server',
        claudeSessionId: 'sid-oc-hydrate', status: 'running', promptId: 'opencode-hydrate',
        sessionId: 'ses_hyd', baseUrl: 'http://127.0.0.1:4096', task: 't',
        cwd: TEST_CWD, startedAt: Date.now(),
      });
      mod.persistJob('opencode-hydrate');
      jobs.delete('opencode-hydrate');
      mod._resetForTest(); // clears the _hydrated guard; CLAUDE_CODE_SESSION_ID drives the claim

      mod.hydrateJobsFromLedger();
      // resume runs async; poll until terminal
      for (let i = 0; i < 50 && !jobs.get('opencode-hydrate')?.terminalAt; i++) {
        await new Promise((r) => setImmediate(r));
      }
      const job = jobs.get('opencode-hydrate');
      assert.ok(job, 'job claimed from ledger');
      assert.equal(job.status, 'completed');
      assert.match(job.adapterResult?.summary?.message || '', /finished while bridge was down/);
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-oc-hydrate') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

// --- Codex app-server adapter (CODEX_RUNTIME_ADAPTER=appserver) -------------
//
// Same technique as withOpenCodeServer above, one layer lower: the bridge calls
// the adapter's module wrappers, the wrappers call `_impl.connect`, so handing
// them the shared fake broker socket rewires the whole app-server path with no
// broker process, no unix socket and no codex binary. The socket fake is the
// one test/fake-codex-broker-socket.mjs hands the adapter's own suite, so these
// tests cannot pass against a broker that suite never saw.

import { fakeBrokerSocket as _cxSocket } from '../test/fake-codex-broker-socket.mjs';

async function _cxUntil(predicate, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return false;
}

// Wall-clock variant, for the one test that waits on a real process booting
// rather than on this process's own microtasks.
async function withCodexAppServer({ handlers = {}, statuses = {}, turns = {}, connect = null, spawnBroker = null } = {}, body) {
  const cx = await import('./codex-app-server-runtime.mjs');
  const regDir = mkdtempSync(join(tmpdir(), 'cx-srv-reg-'));
  const prior = {
    reg: process.env.AGENT_CODEX_BROKER_REGISTRY,
    sock: process.env.CODEX_BROKER_SOCKET_PATH,
    adapter: process.env.CODEX_RUNTIME_ADAPTER,
  };
  process.env.AGENT_CODEX_BROKER_REGISTRY = join(regDir, 'broker.json');
  process.env.CODEX_BROKER_SOCKET_PATH = join(regDir, 'b.sock');
  process.env.CODEX_RUNTIME_ADAPTER = 'appserver';
  cx._resetForTest();
  const sockets = [];
  const newSocket = () => { const s = _cxSocket({ handlers, statuses, turns }); sockets.push(s); return s; };
  cx._setForTest({
    connect: connect ? async (path, ms) => connect({ path, ms, newSocket, sockets }) : async () => newSocket(),
    // A live broker answers the health probe, so nothing here may spawn one;
    // a test that wants the spawn path asks for it explicitly.
    spawnBroker: spawnBroker || (() => { throw new Error('the bridge spawned a broker instead of reusing the live one'); }),
    // Match the selected installation to the identity reported by the shared
    // fake broker. Upgrade-staleness checks are adapter tests; bridge tests need
    // a stable healthy broker unless they explicitly arrange otherwise.
    inspectCodexInstall: () => ({
      ready: true,
      selected: {
        version: '0.147.0', path: '/fake/codex', realPath: '/fake/codex',
        helperPath: '/fake/codex-code-mode-host', source: 'installed',
        identity: 'fake-codex-0.147.0', quarantined: false,
      },
    }),
    pathExists: () => true,
  });
  try { return await body({ cx, sockets, live: () => sockets[sockets.length - 1] }); }
  finally {
    cx._resetForTest();
    if (prior.reg === undefined) delete process.env.AGENT_CODEX_BROKER_REGISTRY; else process.env.AGENT_CODEX_BROKER_REGISTRY = prior.reg;
    if (prior.sock === undefined) delete process.env.CODEX_BROKER_SOCKET_PATH; else process.env.CODEX_BROKER_SOCKET_PATH = prior.sock;
    if (prior.adapter === undefined) delete process.env.CODEX_RUNTIME_ADAPTER; else process.env.CODEX_RUNTIME_ADAPTER = prior.adapter;
    rmSync(regDir, { recursive: true, force: true });
  }
}

// A realistic digest left behind by a bridge that died mid-turn: multi-KB of
// streamed work carrying a marker string. The size is the point — the W1.4′
// regression is a multi-KB body collapsing to a few hundred bytes, and a
// length-ratio assertion on a 97-byte seed cannot see it.
function _cxDeadBridgeDigest(jobId, marker) {
  const body = Array.from({ length: 60 }, (_, i) => `${marker} streamed line ${i} — work the dead bridge already paid for.`).join('\n');
  return [
    `# codex job ${jobId} - digest`, '',
    '**Updated:** 2026-08-11T00:00:00.000Z', '**Status:** `running`', '',
    '## Task', '', 't', '',
    '## Final / partial assistant message', '', body, '',
  ].join('\n');
}

// Seed a live app-server job the way runCodexAppServerWorker would have.
function _cxLiveJob(jobs, jobId, sid, extra = {}) {
  jobs.set(jobId, {
    jobId, target: 'codex', codexAdapter: 'appserver',
    claudeSessionId: sid, status: 'running', promptId: `codex-${jobId}`,
    // A running app-server job HAS a turn id: the worker records it from
    // `turn/start`'s answer and refreshes it from every `turn/started`. It is
    // what `turn/interrupt` and `turn/steer` require, so a fixture without one
    // models a bridge that restarted mid-turn, not a normal live job — and that
    // case has its own test (`extra: { turnId: null }`).
    turnId: 'TURN1',
    sessionId: 'T1', brokerSocket: process.env.CODEX_BROKER_SOCKET_PATH,
    task: 't', cwd: TEST_CWD, startedAt: Date.now(),
    ...extra,
  });
  return jobs.get(jobId);
}

// A `codex exec` stand-in that emits one D10 thread: enough for the exec worker
// to bank a thread id and settle `completed`. It refuses anything but `exec`,
// so a `resume` or an app-server argv is a loud failure rather than a green run.
const _cxTokens = (input, output, cached, reasoning, total) => ({
  inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningOutputTokens: reasoning, totalTokens: total,
});


test('usage: a turn resumed mid-flight by a fresh bridge reports only what it observed, flagged partial', async () => {
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-partial';
  try {
    await withCodexAppServer({ statuses: { T1: 'active' } }, async ({ sockets }) => {
      _cxLiveJob(jobs, 'codex-partial', 'sid-cx-partial');
      mod.persistJob('codex-partial');
      jobs.delete('codex-partial');
      mod._resetForTest();
      mod.hydrateJobsFromLedger();
      assert.ok(await _cxUntil(() => sockets.length > 0 && sockets.at(-1).wire().includes('broker/subscribe')), 'the resumed watcher subscribed');
      const sock = sockets.at(-1);
      // The thread had already spent 4000/500 before this bridge arrived, and
      // this notification is the first model call it sees.
      sock.notify('thread/tokenUsage/updated', { turnId: 'TURN1', tokenUsage: {
        total: _cxTokens(4300, 540, 3200, 54, 4840), last: _cxTokens(300, 40, 200, 4, 340),
      } });
      sock.notify('turn/completed', { turn: { id: 'TURN1', status: 'completed', items: [
        { id: 'm2', type: 'agentMessage', text: 'tail', phase: 'final_answer' },
      ] } });
      assert.ok(await _cxUntil(() => jobs.get('codex-partial')?.terminalAt), 'the resumed turn settles');
      const job = jobs.get('codex-partial');
      assert.equal(job.status, 'completed');
      assert.equal(job.usage.partial, true);
      assert.equal(job.usage.input_tokens, 300);
      assert.equal(state.readJob('codex-partial').usage.partial, true);
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-partial') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});


test('Codex app-server mode: reply on a running turn steers it — no cancel, no restart, no generation bump', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    // `active` is what `thread/resume` reports for a thread with a turn in
    // flight — and resume IS the status read on this protocol.
    await withCodexAppServer({ statuses: { T1: 'active' } }, async ({ sockets }) => {
      const job = _cxLiveJob(jobs, 'codex-steer', 'sid-cx-steer');
      const reply = parse(await dispatch({ action: 'reply', job_id: 'codex-steer', message: 'actually, use ripgrep' }));
      assert.equal(reply.ok, true);
      assert.equal(reply.target, 'codex');
      assert.equal(reply.steered, true);
      assert.equal(reply.thread_id, 'T1');
      // The watcher already driving the turn is the one that answers, so the
      // generation must NOT move — bumping it would make that watcher discard
      // its own terminal and the job would never settle.
      assert.equal(reply.new_prompt_id, job.promptId);
      assert.equal(jobs.get('codex-steer').promptId, 'codex-codex-steer');
      assert.equal(jobs.get('codex-steer').replyTurn, 1);
      assert.equal(jobs.get('codex-steer').terminalAt, undefined);

      // The lock is held across the RPCs and released on the way out, so the
      // next steer is not locked out by the previous one.
      assert.equal(jobs.get('codex-steer').replyInFlight, false);

      const sock = sockets[sockets.length - 1];
      assert.deepEqual(sock.wire(), ['thread/resume', 'turn/steer'], 'steer only: no interrupt, no second turn/start');
      // `expectedTurnId` is REQUIRED — omitting it was an unconditional -32600
      // on the real server, i.e. every app-server reply failed. The fake
      // enforces the contract, so the field being on the wire is what makes
      // this test pass at all.
      assert.deepEqual(sock.paramsFor('turn/steer')[0], {
        threadId: 'T1', expectedTurnId: 'TURN1', input: [{ type: 'text', text: 'actually, use ripgrep' }],
      });
      assert.equal(reply.turn_id, 'TURN1');
      // Two facts, kept apart: the server accepted it, and the injected message
      // was seen landing in the turn.
      assert.equal(reply.steer_confirmed, true);
      assert.match(reply.steer_confirmation, /item\/completed userMessage/);
    });
  } finally {
    jobs.delete('codex-steer');
    _resetForTest();
  }
});

test('Codex app-server mode: a steer the model has not reached yet is reported unconfirmed, not delivered', async () => {
  // Codex injects a steer at the NEXT MODEL BOUNDARY — measured 0.14 s against
  // an in-flight apply_patch and 130 s against a model mid-reasoning. Claiming
  // delivery because the RPC returned is the thing being fixed; the honest
  // answer is `steered: true, steer_confirmed: false` with the reason.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldWindow = process.env.AGENT_COMPANION_CODEX_STEER_CONFIRM_MS;
  // The default window is 5 s of real waiting; this test only needs the timeout
  // to expire, so it buys the same assertion for 20 ms.
  process.env.AGENT_COMPANION_CODEX_STEER_CONFIRM_MS = '20';
  try {
    await withCodexAppServer({
      statuses: { T1: 'active' },
      // Accepted, never announced — the model is still mid-reasoning.
      handlers: { 'turn/steer': (p) => ({ turn: { id: p.expectedTurnId } }) },
    }, async () => {
      _cxLiveJob(jobs, 'codex-steer-slow', 'sid-cx-steer-slow');
      const reply = parse(await dispatch({
        action: 'reply', job_id: 'codex-steer-slow', message: 'actually, use ripgrep',
      }));
      assert.equal(reply.ok, true);
      assert.equal(reply.steered, true);
      assert.equal(reply.steer_confirmed, false);
      assert.match(reply.steer_confirmation, /next model boundary/);
      // Not a failure: the job is still running and still the same turn.
      assert.equal(jobs.get('codex-steer-slow').terminalAt, undefined);
      assert.equal(jobs.get('codex-steer-slow').turnId, 'TURN1');
    });
  } finally {
    jobs.delete('codex-steer-slow');
    if (oldWindow === undefined) delete process.env.AGENT_COMPANION_CODEX_STEER_CONFIRM_MS;
    else process.env.AGENT_COMPANION_CODEX_STEER_CONFIRM_MS = oldWindow;
    _resetForTest();
  }
});

test('Codex app-server mode: a reply never steers with a turn resume reports as FINISHED', async () => {
  // One rule for every read of `lastTurn`. `resolveCodexTurnId` and
  // `startCodexTurn` both take it only when it says `inProgress`; the reply path
  // used to pass `resumed.lastTurn?.id` ungated, so an `active` thread whose
  // last RECORDED turn had completed (the window between one turn finishing and
  // the next being recorded) would have steered a dead id — measured on the real
  // server as `-32600 expected active turn id … but found …`. Gated, the adapter
  // goes and reads the live turn instead.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    await withCodexAppServer({
      turns: { T1: [{ id: 'TURN_LIVE', status: 'inProgress' }] },
      handlers: {
        'thread/resume': (p) => ({
          thread: { id: p.threadId, status: { type: 'active' }, turns: [{ id: 'TURN_DEAD', status: 'completed' }] },
        }),
      },
    }, async ({ sockets }) => {
      // No live id: this bridge restarted and never saw `turn/started`.
      _cxLiveJob(jobs, 'codex-stale-steer', 'sid-cx-stale', { turnId: null });
      const reply = parse(await dispatch({
        action: 'reply', job_id: 'codex-stale-steer', message: 'actually, use ripgrep',
      }));
      const sock = sockets[sockets.length - 1];
      assert.equal(reply.ok, true);
      assert.equal(reply.steered, true);
      assert.equal(sock.paramsFor('turn/steer')[0].expectedTurnId, 'TURN_LIVE');
      assert.ok(sock.wire().includes('thread/read'), 'the resolver asked the transport rather than trusting a finished turn');
      assert.equal(jobs.get('codex-stale-steer').turnId, 'TURN_LIVE');
    });
  } finally {
    jobs.delete('codex-stale-steer');
    _resetForTest();
  }
});

test('Codex app-server mode: a job that goes terminal DURING the reply RPCs is rejected, not resurrected', async () => {
  // The reply's two round trips (`thread/resume`, then steer or turn/start) are
  // a window the live watcher can settle the job inside. Clearing `terminalAt`
  // afterwards un-settles a result the parent has already been handed and bills
  // a fresh turn for it.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    await withCodexAppServer({
      handlers: {
        'thread/resume': (p) => {
          // Settle the job mid-call, exactly as the watcher's terminal would.
          mod.retainTerminalJob('codex-race-reply', { status: 'completed', summary: { message: 'done' }, terminalAt: Date.now() });
          return { thread: { id: p.threadId, status: { type: 'idle' } } };
        },
      },
    }, async ({ sockets }) => {
      _cxLiveJob(jobs, 'codex-race-reply', 'sid-cx-race');
      const reply = parse(await dispatch({ action: 'reply', job_id: 'codex-race-reply', message: 'follow up' }));
      assert.equal(reply.ok, false);
      assert.match(reply.error, /already completed/);
      const job = jobs.get('codex-race-reply');
      assert.ok(job.terminalAt, 'the terminal survived the reply');
      assert.equal(job.status, 'completed');
      assert.equal(job.replyInFlight, false, 'the reply lock was released');
      // No second billed turn was dispatched on the way out.
      assert.equal(sockets.at(-1).wire().includes('turn/start'), false);
      assert.equal(sockets.at(-1).wire().includes('turn/steer'), false);
    });
  } finally {
    jobs.delete('codex-race-reply');
    _resetForTest();
  }
});

test('Codex app-server mode: two replies in the same tick cannot both dispatch a turn', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    await withCodexAppServer({ statuses: { T1: 'idle' } }, async ({ sockets }) => {
      _cxLiveJob(jobs, 'codex-double-reply', 'sid-cx-double');
      // Fired without awaiting the first: the lock has to be taken before the
      // first await or both calls compute replyTurn 1 and the same `-r1`
      // promptId, and neither watcher can supersede the other.
      const [a, b] = (await Promise.all([
        dispatch({ action: 'reply', job_id: 'codex-double-reply', message: 'first' }),
        dispatch({ action: 'reply', job_id: 'codex-double-reply', message: 'second' }),
      ])).map(parse);
      const accepted = [a, b].filter((r) => r.ok);
      const refused = [a, b].filter((r) => !r.ok);
      assert.equal(accepted.length, 1, `exactly one reply may win: ${JSON.stringify([a, b])}`);
      assert.match(refused[0].error, /reply already in flight/);
      assert.equal(jobs.get('codex-double-reply').replyTurn, 1);
      const starts = () => sockets.flatMap((s) => s.wire()).filter((m) => m === 'turn/start');
      assert.ok(await _cxUntil(() => starts().length > 0), 'the accepted reply dispatched its turn');
      assert.equal(starts().length, 1, 'one billed turn, not two');
    });
  } finally {
    jobs.delete('codex-double-reply');
    _resetForTest();
  }
});

test('Codex app-server mode: reply on an idle thread starts a fresh guarded turn under a bumped generation', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    await withCodexAppServer({
      statuses: { T1: 'idle' },
      // A DIFFERENT id for the replacement turn, so "the job's turn id moved on"
      // is observable rather than coincidental.
      handlers: { 'turn/start': () => ({ turn: { id: 'TURN2' } }) },
    }, async ({ sockets }) => {
      _cxLiveJob(jobs, 'codex-idle-reply', 'sid-cx-idle');
      const reply = parse(await dispatch({ action: 'reply', job_id: 'codex-idle-reply', message: 'follow up' }));
      assert.equal(reply.ok, true);
      assert.equal(reply.steered, false);
      assert.match(reply.new_prompt_id, /-r1$/);
      assert.equal(jobs.get('codex-idle-reply').promptId, reply.new_prompt_id);
      // THE STALE-ID WINDOW. This branch was taken because TURN1 is over, and
      // the replacement's id arrives a few round trips later — the watch below
      // is deliberately not awaited. So the job must not still be advertising
      // TURN1: an `agent_cancel` in here would send it, and the real server
      // answers `-32600 expected active turn id … but found …` while the new
      // turn keeps running. Null instead makes the resolver read the live turn
      // off `thread/read`.
      assert.notEqual(jobs.get('codex-idle-reply').turnId, 'TURN1', 'the finished turn\'s id is not carried forward');
      const sock = sockets[sockets.length - 1];
      assert.ok(await _cxUntil(() => sock.wire().includes('turn/start')), 'a new turn was started');
      assert.ok(await _cxUntil(() => jobs.get('codex-idle-reply')?.turnId === 'TURN2'), 'the replacement turn\'s id lands on the job');
      // An idle thread has no turn to steer, so this path re-prompts — but it
      // still never interrupts, because there is nothing running to interrupt.
      assert.equal(sock.wire().includes('turn/interrupt'), false);
      sock.notify('turn/completed', { turn: { id: 'TURN2', status: 'completed', items: [{ id: 'm9', type: 'agentMessage', text: 'second turn done', phase: 'final_answer' }] } });
      assert.ok(await _cxUntil(() => jobs.get('codex-idle-reply')?.terminalAt), 'the replacement watch settles the job');
      assert.equal(jobs.get('codex-idle-reply').status, 'completed');
    });
  } finally {
    jobs.delete('codex-idle-reply');
    _resetForTest();
  }
});

test('Codex reply/resume availability is per job, not per target', async () => {
  const mod = await bridge();
  const { buildJobResponse, _resetForTest } = mod;
  _resetForTest();
  await withCodexAppServer({}, async () => {
    const live = buildJobResponse({
      jobId: 'cx-live', target: 'codex', codexAdapter: 'appserver',
      status: 'running', sessionId: 'T1', promptId: 'codex-cx-live', startedAt: Date.now(),
    });
    assert.equal(live.reply_available, true);
    assert.equal(live.resume_available, true);
    // An exec-adapter codex job advertises neither, even while the env says
    // appserver — it started on a transport that has no control channel.
    const exec = buildJobResponse({
      jobId: 'cx-exec', target: 'codex', status: 'running',
      sessionId: 'th-exec', promptId: 'codex-cx-exec', pid: 999, startedAt: Date.now(),
    });
    assert.equal(exec.reply_available, false);
    assert.equal(exec.resume_available, false);
    // …and neither does an app-server job that has not opened its thread yet.
    const starting = buildJobResponse({ jobId: 'cx-pre', target: 'codex', codexAdapter: 'appserver', status: 'starting', startedAt: Date.now() });
    assert.equal(starting.reply_available, false);
    assert.equal(starting.resume_available, false);
  });
  _resetForTest();
});

test('Codex app-server mode: hydrate resumes the job instead of retiring it, and does not clobber its digest', async () => {
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-hydrate';
  try {
    await withCodexAppServer({
      handlers: {
        // The turn finished while this bridge was down; `thread/read` serves it
        // back from the rollout.
        'thread/read': (p) => ({ thread: { id: p.threadId }, turns: [{ items: [
          { id: 'm1', type: 'agentMessage', text: 'finished while the bridge was down', phase: 'final_answer' },
        ] }] }),
      },
    }, async () => {
      _cxLiveJob(jobs, 'codex-hydrate', 'sid-cx-hydrate');
      mod.persistJob('codex-hydrate');
      // A REALISTIC dead-bridge digest: multi-KB, with a marker no render on
      // the resume path can reproduce. A short seed proves nothing here — a
      // full replacement by the salvaged answer would still be "longer than
      // half of it", which is how the clobber survived its first test.
      const digest = digestPath('codex-hydrate');
      writeFileSync(digest, _cxDeadBridgeDigest('codex-hydrate', 'MARKER-HYDRATE-TIER1'));
      jobs.delete('codex-hydrate');
      mod._resetForTest();

      mod.hydrateJobsFromLedger();
      assert.ok(await _cxUntil(() => jobs.get('codex-hydrate')?.terminalAt), 'the resumed job settles');
      const job = jobs.get('codex-hydrate');
      // NOT retired: this is the case that destroyed ~4 minutes of paid work
      // twice in the field report.
      assert.equal(job.status, 'completed');
      assert.notEqual(job.detail, 'target_child_orphaned_by_bridge_restart');
      assert.notEqual(job.detail, 'bridge_transport_closed');
      assert.equal(existsSync(digest.replace('agent-digest-', 'agent-retired-')), false, 'no retirement note was written');
      // The digest gained the salvaged answer AND still holds every byte the
      // dead bridge streamed (the W1.4′ invariant orphan.mjs guards).
      const after = readFileSync(digest, 'utf8');
      assert.match(after, /finished while the bridge was down/);
      assert.match(after, /MARKER-HYDRATE-TIER1/, 'the dead bridge\'s streamed work survived the resume');
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-hydrate') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});


test('a hydrated adapterResult does not latch the carry-forward off for the renders after it', async () => {
  // The other side of W1.4'. Hydrate restores `job.adapterResult` from the
  // ledger, so the FIRST render a new bridge makes can be the previous bridge's
  // own completed answer — which the digest on disk already contains. When the
  // carry memoized that verdict, it latched "nothing to carry" for the whole
  // process, and the next render (the resumed watcher's first delta, whose
  // accumulator is empty) rebuilt the digest from nothing: measured 7,507 bytes
  // to 351, the dead bridge's work gone. The salvaged text is memoized now and
  // the containment test runs per render, so the section comes back the moment
  // the incoming render stops containing it.
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  try {
    const jobId = 'codex-carry-latch';
    // The hydrated result IS the dead bridge's answer, byte for byte — that is
    // what makes containment hold on the first render.
    const answer = Array.from({ length: 60 }, (_, i) => `MARKER-CARRY streamed line ${i} — work the dead bridge already paid for.`).join('\n');
    const digest = digestPath(jobId);
    writeFileSync(digest, _cxDeadBridgeDigest(jobId, 'MARKER-CARRY'));
    const priorBytes = readFileSync(digest, 'utf8').length;

    // A new process that hydrated this job: same digest on disk, and the dead
    // bridge's own result restored onto the record.
    _cxLiveJob(jobs, jobId, 'sid-cx-carry');
    const job = jobs.get(jobId);
    job.adapterResult = { stdout: answer, stderr: '', summary: { message: answer } };

    mod.refreshDigestForJob(job);
    // Nothing carried on this render: the render already says it.
    assert.doesNotMatch(readFileSync(digest, 'utf8'), /Carried forward from the previous bridge/);

    // The resumed watcher's first progress render, accumulator still empty.
    job.adapterResult = { stdout: '', stderr: '', summary: { message: '' } };
    mod.refreshDigestForJob(job);
    const after = readFileSync(digest, 'utf8');
    assert.match(after, /MARKER-CARRY/, "the dead bridge's streamed work survived a render that no longer contains it");
    assert.ok(after.length > priorBytes / 2, `digest collapsed to ${after.length} bytes from ${priorBytes}`);
  } finally {
    jobs.delete('codex-carry-latch');
    _resetForTest();
  }
});

test('Codex app-server mode: resuming a STILL-RUNNING turn streams into the digest without destroying what the dead bridge wrote', async () => {
  // The main incident path: broker alive, turn still active, bridge restarted.
  // The resumed watcher's accumulator starts EMPTY, so every progress refresh
  // renders a body far smaller than the one already on disk. That render is a
  // full replacement, which is exactly how a multi-KB digest became a stub.
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-active';
  try {
    await withCodexAppServer({ statuses: { T1: 'active' } }, async ({ sockets }) => {
      _cxLiveJob(jobs, 'codex-active', 'sid-cx-active');
      mod.persistJob('codex-active');
      const digest = digestPath('codex-active');
      writeFileSync(digest, _cxDeadBridgeDigest('codex-active', 'MARKER-ACTIVE-TURN'));
      const before = readFileSync(digest, 'utf8').length;
      jobs.delete('codex-active');
      mod._resetForTest();

      mod.hydrateJobsFromLedger();
      assert.ok(await _cxUntil(() => sockets.length > 0 && sockets.at(-1).wire().includes('broker/subscribe')), 'the resumed watcher subscribed');
      const sock = sockets.at(-1);

      // A mid-turn delta — the first progress refresh this bridge makes.
      sock.notify('item/agentMessage/delta', { itemId: 'm2', delta: 'tail of the answer' });
      assert.ok(await _cxUntil(() => readFileSync(digest, 'utf8').includes('tail of the answer')), 'streaming reached the digest');
      const mid = readFileSync(digest, 'utf8');
      assert.match(mid, /MARKER-ACTIVE-TURN/, 'the dead bridge\'s body survived the streaming refresh');
      assert.ok(mid.length >= before, `digest shrank mid-flight: ${before} -> ${mid.length}`);

      // …and it is still there once the resumed turn settles.
      sock.notify('turn/completed', { turn: { id: 'TURN1', status: 'completed', items: [
        { id: 'm2', type: 'agentMessage', text: 'tail of the answer', phase: 'final_answer' },
      ] } });
      assert.ok(await _cxUntil(() => jobs.get('codex-active')?.terminalAt), 'the resumed turn settles');
      assert.equal(jobs.get('codex-active').status, 'completed');
      const after = readFileSync(digest, 'utf8');
      assert.match(after, /MARKER-ACTIVE-TURN/, 'the dead bridge\'s body survived the terminal render');
      assert.match(after, /tail of the answer/);
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-active') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('Codex app-server mode: hydrate with a DEAD broker resumes from the rollout and reports a lost turn, not a lost thread', async () => {
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-dead';
  // The first two connects are the resume probe and ensureCodexBroker's own
  // probe — both find nothing listening. The spawn then brings a broker up and
  // every later connect succeeds, which is the measured tier-2 shape: the
  // rollout survives the broker.
  let refusals = 2;
  try {
    await withCodexAppServer({
      connect: async ({ newSocket }) => {
        if (refusals-- > 0) { const err = new Error('connect ECONNREFUSED'); err.code = 'ECONNREFUSED'; throw err; }
        return newSocket();
      },
      spawnBroker: () => ({ on: () => {}, unref: () => {} }),
      handlers: {
        'thread/read': (p) => ({ thread: { id: p.threadId }, turns: [{ items: [
          { id: 'm1', type: 'agentMessage', text: 'partial work before the broker died', phase: 'commentary' },
        ] }] }),
      },
    }, async () => {
      _cxLiveJob(jobs, 'codex-dead-broker', 'sid-cx-dead');
      mod.persistJob('codex-dead-broker');
      // Salvage is a `thread/read` summary — messages only, no reasoning and no
      // tool calls — so it is routinely SHORTER than what the dead bridge had
      // already streamed. Writing it over the body is still destruction.
      const digest = digestPath('codex-dead-broker');
      writeFileSync(digest, _cxDeadBridgeDigest('codex-dead-broker', 'MARKER-TIER2-SALVAGE'));
      jobs.delete('codex-dead-broker');
      mod._resetForTest();

      mod.hydrateJobsFromLedger();
      assert.ok(await _cxUntil(() => jobs.get('codex-dead-broker')?.terminalAt), 'the resumed job settles');
      const job = jobs.get('codex-dead-broker');
      assert.equal(job.status, 'unreachable');
      assert.equal(job.detail, 'codex_server_gone');
      // The salvage is real and the message must not claim the thread is gone —
      // `thread_not_resumable` here would report the very case this transport
      // was chosen for as lost work.
      assert.match(job.summary.message, /partial work before the broker died/);
      assert.match(job.error, /in-flight turn was lost/);
      assert.match(job.error, /lost turn, not a lost thread/);
      assert.equal(/thread_not_resumable/.test(job.error), false);
      const after = readFileSync(digest, 'utf8');
      assert.match(after, /partial work before the broker died/, 'the salvage reached the digest');
      assert.match(after, /MARKER-TIER2-SALVAGE/, 'the salvage did not overwrite the dead bridge\'s body');
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-dead') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('Codex app-server mode: a resume that salvages nothing leaves the dead bridge\'s digest alone', async () => {
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-nosalvage';
  let refusals = 2;
  try {
    await withCodexAppServer({
      connect: async ({ newSocket }) => {
        if (refusals-- > 0) { const err = new Error('connect ECONNREFUSED'); err.code = 'ECONNREFUSED'; throw err; }
        return newSocket();
      },
      spawnBroker: () => ({ on: () => {}, unref: () => {} }),
      // The rollout has no assistant message yet — the turn died in reasoning.
    }, async () => {
      await withQueue(async (queueFile) => {
        _cxLiveJob(jobs, 'codex-nosalvage', 'sid-cx-nosalvage');
        mod.persistJob('codex-nosalvage');
        const digest = digestPath('codex-nosalvage');
        writeFileSync(digest, _cxDeadBridgeDigest('codex-nosalvage', 'MARKER-NO-SALVAGE'));
        jobs.delete('codex-nosalvage');
        mod._resetForTest();

        mod.hydrateJobsFromLedger();
        assert.ok(await _cxUntil(() => jobs.get('codex-nosalvage')?.terminalAt), 'the resumed job settles');
        assert.equal(jobs.get('codex-nosalvage').status, 'unreachable');
        // W1.4\u2032's hard constraint: an empty result must never render a
        // header-only stub over content that is the only record of the work.
        assert.match(readFileSync(digest, 'utf8'), /MARKER-NO-SALVAGE/);
        // The outcome is still recorded on disk \u2014 in the sibling note, never in
        // the body.
        const note = digest.replace('agent-digest-', 'agent-retired-');
        assert.equal(existsSync(note), true);
        assert.match(readFileSync(note, 'utf8'), /codex_server_gone/);
        assert.match(readFileSync(note, 'utf8'), /lost turn, not a lost thread/);
        // \u2026and the terminal reaches the completion queue on THIS branch too. A
        // parent that drains instead of blocking would otherwise never hear
        // that the job settled, purely because the rollout happened to be empty.
        assert.ok(await _cxUntil(() => existsSync(queueFile) && readQueue(queueFile).some((r) => r.jobId === 'codex-nosalvage' && r.kind === 'terminal')),
          'the no-salvage resume enqueued its terminal');
      });
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-nosalvage') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('applyAdapterCapabilities flips codex only under the app-server adapter', async () => {
  const registry = await import('../lib/target-registry.mjs');
  const cx = await import('./codex-app-server-runtime.mjs');
  const exec = registry.getTargetById('codex', { CODEX_RUNTIME_ADAPTER: 'exec' });
  assert.equal(exec.capabilities.reply, false);
  assert.equal(exec.capabilities.resume, false);
  assert.equal(exec.capabilities.serverMode, false);
  assert.equal(exec.adapter, undefined);
  const appserver = registry.getTargetById('codex', { CODEX_RUNTIME_ADAPTER: 'appserver' });
  assert.equal(appserver.capabilities.reply, true);
  assert.equal(appserver.capabilities.resume, true);
  assert.equal(appserver.capabilities.serverMode, true);
  assert.equal(appserver.adapter, 'appserver');
  // Unset and unrecognised both stay on the shipped default.
  assert.equal(registry.getTargetById('codex', {}).capabilities.reply, false);
  assert.equal(registry.getTargetById('codex', { CODEX_RUNTIME_ADAPTER: 'server' }).capabilities.reply, false);
  // Selecting codex must not touch opencode, and vice versa.
  assert.equal(registry.getTargetById('opencode', { CODEX_RUNTIME_ADAPTER: 'appserver' }).capabilities.reply, false);
  assert.equal(registry.getTargetById('codex', { OPENCODE_RUNTIME_ADAPTER: 'server' }).capabilities.reply, false);
  // The descriptor's local predicate and the adapter's own resolver must agree
  // about the spelling — two parsers that disagree would advertise a capability
  // the transport does not have.
  for (const env of [{}, { CODEX_RUNTIME_ADAPTER: 'appserver' }, { CODEX_RUNTIME_ADAPTER: 'APPSERVER' }, { CODEX_RUNTIME_ADAPTER: 'exec' }, { CODEX_RUNTIME_ADAPTER: 'nonsense' }]) {
    assert.equal(registry.codexAppServerAdapterSelected(env), cx.codexAppServerActive(env), JSON.stringify(env));
  }
});


test('handleReply rebinds a running job to the replacement prompt and watcher result', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-reply-rebind';
  jobs.set('copilot-reply-1', {
    jobId: 'copilot-reply-1',
    target: 'copilot',
    reqId: 'req-reply-1',
    claudeSessionId: 'sid-reply-rebind',
    thread: 'thread-reply-1',
    task: 'original task',

    status: 'running',
    promptId: 'prompt-old',
    sessionId: 'session-reply-1',
    startedAt: Date.now() - 1000,
    inspectAvailable: true,
  });
  try {
    const body = await withDaemonStubs(
      {
        sendToSocket: async (msg) => {
          if (msg.command === 'reply') {
            assert.equal(msg.promptId, 'prompt-old');
            return {
              ok: true,
              data: {
                ok: true,
                original_prompt_id: 'prompt-old',
                new_prompt_id: 'prompt-new',
                session_id: 'session-reply-1',
              },
            };
          }
          if (msg.command === 'watch') {
            assert.equal(msg.promptId, 'prompt-new');
            return {
              ok: true,
              data: {
                promptId: 'prompt-new',
                sessionId: 'session-reply-1',
                status: 'completed',
                summary: { message: 'replacement done\n\nRUBBER-DUCK: clean.' },
              },
            };
          }
          if (msg.command === 'inspect') return { ok: true, data: {} };
          return { ok: true, data: {} };
        },
      },
      async () => parse(await dispatch({
        action: 'reply',
        job_id: 'copilot-reply-1',
        message: 'use this instead',
      })),
    );
    assert.equal(body.ok, true);
    assert.equal(body.new_prompt_id, 'prompt-new');

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const job = jobs.get('copilot-reply-1');
    assert.equal(job.promptId, 'prompt-new');
    assert.equal(job.status, 'completed');
    assert.equal(job.terminalAt > 0, true);
  } finally {
    jobs.delete('copilot-reply-1');
    _resetForTest();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

// ---- TRACK: acp-generic ----
//
// The bridge's daemon path is keyed on the descriptor (`capabilities.acp`),
// not on the companion id. These pin what every ACP companion gets from the
// bridge — the protocol-mismatch verdict, the honest reply acknowledgement,
// a real detached daemon end to end — on the one shipped ACP companion.

async function withAcpSession(sid, body) {
  const mod = await bridge();
  const state = await import('../lib/state.mjs');
  mod._resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = sid;
  try {
    return await body(mod, state);
  } finally {
    for (const id of [...mod.jobs.keys()]) if (mod.jobs.get(id)?.claudeSessionId === sid) { try { state.deleteJob(id); } catch {} mod.jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    mod._resetForTest();
  }
}


test('acp: the reply acknowledgement says the turn was cancelled and re-prompted — ACP has no mid-turn steer', async () => {
  await withAcpSession('sid-acp-reply', async (mod) => {
    const { dispatch, jobs } = mod;
    jobs.set('acp-reply-1', {
      jobId: 'acp-reply-1', target: 'copilot', reqId: 'req-ar', claudeSessionId: 'sid-acp-reply',
      thread: 'thread-acp-reply', task: 'original task',
      status: 'running', promptId: 'ap-old', sessionId: 'acp-sess-r', startedAt: Date.now() - 1000, inspectAvailable: true,
    });
    const body = await withDaemonStubs({
      sendToSocket: async (msg) => {
        if (msg.command === 'reply') return { ok: true, data: { ok: true, original_prompt_id: 'ap-old', new_prompt_id: 'ap-new', session_id: 'acp-sess-r' } };
        if (msg.command === 'watch') return { ok: true, data: { promptId: 'ap-new', sessionId: 'acp-sess-r', status: 'completed', summary: { message: 'continued\n\nRUBBER-DUCK: clean.', toolCalls: [] } } };
        return { ok: true, data: {} };
      },
    }, async () => parse(await dispatch({ action: 'reply', job_id: 'acp-reply-1', message: 'use this instead' })));
    assert.equal(body.ok, true);
    assert.match(body.hint, /cancelled/);
    assert.match(body.hint, /no mid-turn steer/);
    assert.match(body.hint, /same GitHub Copilot CLI session/);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(jobs.get('acp-reply-1').status, 'completed');
  });
});

test('acp: the agent_send target enum is the registry, not a literal', async () => {
  const { mcp } = await bridge();
  const tools = await mcp._requestHandlers.get('tools/list')({ method: 'tools/list', params: {} });
  const send = tools.tools.find((t) => t.name === 'agent_send');
  assert.deepEqual(send.inputSchema.properties.target.enum, ['opencode', 'copilot', 'codex', 'antigravity']);
});

// End to end through a REAL detached daemon and the fake agent: the bridge
// spawns `scripts/acp-daemon.mjs --companion copilot` under the sandboxed
// runtime dir, the daemon spawns test/fake-acp-agent.mjs as `copilot`
// (COPILOT_BIN), and a send/wait pair settles — no stubs anywhere below the
// bridge. The second send on the same thread reuses the ACP session.


// ---- TRACK: acp-antigravity ----
//
// The shipped second ACP companion (docs/MVP_TRACKER.md item 8). Every
// daemon-path decision is a descriptor read, so these pin what Antigravity
// gets from the bridge (its own daemon socket, the honest reply wording, a
// real detached daemon with `session/load` across a daemon restart) and what
// it does not (usage — the ACP surface carries none, measured 2026-09-11).


// End to end through a REAL detached `acp-daemon --companion antigravity` and
// the fake agent (ANTIGRAVITY_ACP_BIN), no stubs below the bridge — and then
// the daemon is stopped between rounds, so round two on the same thread has
// to `session/load` the recorded session on a fresh daemon: the descriptor
// honours it, the fake advertises it, and the bridge reports the same session
// with no rebirth. Copilot's e2e above can never take this branch.


// ---- TRACK: codex-adapter ----
//
// W1.1 at the worker seam: runSingleShotCliWorker must bank the codex thread
// id the moment `thread.started` arrives, not when the run resolves. Same
// fakeBin discipline as the codex adapter tests above — CODEX_BIN never points
// at a real binary.


// ---- TRACK: hydrate-guard ----
// W1.4′: hydrate must neither mislabel nor overwrite a job it did not start.
// A fresh bridge used to retire every non-terminal, non-copilot ledger row on
// sight and then rewrite its digest from `adapterResult || null` — which is
// null by construction in a fresh process. In the field incident that declared
// two jobs dead 56.1s and 4.1s before their children actually died and shrank a
// live 11,754-byte digest to 228 bytes.

// A long-lived fake companion binary, built the way codex-runtime.test.mjs
// builds its fakes (a node script, never a real `sleep`), spawned so the test
// owns a pid that is unambiguously alive — no PID-reuse exposure, because the
// pid belongs to a child this process holds open for the duration.
async function withLiveFakeChild(body) {
  const { spawn } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'hydrate-guard-bin-'));
  const bin = join(dir, 'codex-fake.mjs');
  writeFileSync(bin, ['#!/usr/bin/env node', 'setInterval(() => {}, 1 << 30);', ''].join('\n'), { mode: 0o700 });
  chmodSync(bin, 0o700);
  const child = spawn(process.execPath, [bin], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  try { return await body(child); }
  finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('hydrate retires an orphaned CLI job honestly and never rewrites a digest it did not write', async () => {
  const mod = await bridge();
  const { jobs, hydrateJobsFromLedger, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  const { pidAlive } = await import('../lib/shared-runtime-registry.mjs');

  await withLiveFakeChild(async (child) => {
    const oldS = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sid-hydrate-guard';
    const digest = digestPath('j-orphan-live');
    // Stand in for the live digest the previous bridge had already written.
    const digestBody = ['# codex job j-orphan-live - digest', '', 'x'.repeat(11_754), ''].join('\n');
    writeFileSync(digest, digestBody);
    const retiredNote = digest.replace(/agent-digest-([^/]+)\.md$/, 'agent-retired-$1.md');
    try {
      _resetForTest();
      jobs.clear();
      state.writeJob('j-orphan-live', {
        jobId: 'j-orphan-live', claudeSessionId: 'sid-hydrate-guard',
        target: 'codex', status: 'running', task: 'long codex turn',
        pid: child.pid, companionSessionId: 'thread-uuid-1',
        startedAt: Date.now() - 60_000,
      });

      // Probe injected (delegating to the real rule) so the assertion is about
      // the guard, not about the scheduler: CI never depends on an unowned pid.
      const probed = [];
      hydrateJobsFromLedger({ pidAlive: (pid) => { probed.push(pid); return pidAlive(pid); } });

      const job = jobs.get('j-orphan-live');
      // (i) not silently mislabelled: the recorded child pid was actually
      // probed, and the verdict names the bridge restart rather than the adapter.
      assert.deepEqual(probed, [child.pid]);
      assert.equal(job.status, 'unreachable');
      assert.equal(job.childPidAlive, true);
      assert.match(job.error, /still running/);
      assert.match(job.error, /orphaned/);
      // (ii) the honest detail, and specifically NOT the blanket adapter verdict.
      assert.equal(job.detail, 'target_child_orphaned_by_bridge_restart');
      assert.notEqual(job.detail, 'target_adapter_non_resumable_after_restart');
      // Salvage pointers, since the digest holds ~0.2% of an aborted turn.
      assert.match(job.error, /thread-uuid-1/);
      assert.ok(job.error.includes(digest), 'the digest path is named as a salvage pointer');
      // (iii) hard constraint: byte-identical digest. The retirement is
      // recorded in a sibling file, never inside the body.
      assert.equal(readFileSync(digest, 'utf8'), digestBody);
      assert.equal(job.retiredNote, retiredNote);
      assert.equal(existsSync(retiredNote), true);
      const note = readFileSync(retiredNote, 'utf8');
      assert.match(note, /target_child_orphaned_by_bridge_restart/);
      assert.match(note, new RegExp(`Child pid:\\*\\* ${child.pid} \\(still alive`));
      // The note must stay OUT of the digest-resource namespace: named
      // `<digest>-retired.md` it would match DIGEST_RESOURCE_FILE_RE and
      // publish a phantom `agent-digest://j-orphan-live-retired` resource
      // describing a job that never existed.
      const uris = mod.listDigestResources().map((r) => r.uri);
      assert.deepEqual(uris.filter((u) => u.includes('j-orphan-live')), ['agent-digest://j-orphan-live']);
    } finally {
      state.deleteJob('j-orphan-live');
      rmSync(digest, { force: true });
      rmSync(retiredNote, { force: true });
      jobs.clear();
      if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = oldS;
      _resetForTest();
    }
  });
});

test('hydrate reports a dead child as a closed bridge transport, still without touching the digest', async () => {
  const mod = await bridge();
  const { jobs, hydrateJobsFromLedger, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-hydrate-guard-dead';
  const digest = digestPath('j-orphan-dead');
  const digestBody = '# codex job j-orphan-dead - digest\n\npartial work\n';
  writeFileSync(digest, digestBody);
  try {
    _resetForTest();
    jobs.clear();
    state.writeJob('j-orphan-dead', {
      jobId: 'j-orphan-dead', claudeSessionId: 'sid-hydrate-guard-dead',
      target: 'codex', status: 'running', task: 't',
      pid: 424242, startedAt: Date.now() - 60_000,
    });
    // Injected false rather than a real reaped pid: asserting "this pid is
    // dead" against the OS is exactly the PID-reuse race CI must not run.
    hydrateJobsFromLedger({ pidAlive: () => false });

    const job = jobs.get('j-orphan-dead');
    assert.equal(job.status, 'unreachable');
    assert.equal(job.detail, 'bridge_transport_closed');
    assert.equal(job.childPidAlive, false);
    assert.match(job.error, /died with the bridge process/);
    assert.equal(readFileSync(digest, 'utf8'), digestBody);
  } finally {
    state.deleteJob('j-orphan-dead');
    rmSync(digest, { force: true });
    rmSync(digest.replace(/agent-digest-([^/]+)\.md$/, 'agent-retired-$1.md'), { force: true });
    jobs.clear();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('hydrate never believes a ledger pid that has been reused by this bridge process', async () => {
  const mod = await bridge();
  const { jobs, hydrateJobsFromLedger, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-hydrate-guard-self';
  try {
    _resetForTest();
    jobs.clear();
    state.writeJob('j-orphan-self', {
      jobId: 'j-orphan-self', claudeSessionId: 'sid-hydrate-guard-self',
      target: 'codex', status: 'running', task: 't',
      pid: process.pid, startedAt: Date.now() - 60_000,
    });
    // The probe would say "alive" (it is us), but a fresh bridge cannot have
    // started this job's child, so the pid must not be believed — and the
    // probe must not even be consulted.
    let probes = 0;
    hydrateJobsFromLedger({ pidAlive: () => { probes++; return true; } });

    const job = jobs.get('j-orphan-self');
    assert.equal(probes, 0);
    assert.equal(job.childPidAlive, false);
    assert.equal(job.detail, 'bridge_transport_closed');
  } finally {
    state.deleteJob('j-orphan-self');
    rmSync(digestPath('j-orphan-self').replace(/agent-digest-([^/]+)\.md$/, 'agent-retired-$1.md'), { force: true });
    jobs.clear();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

// ---- TRACK: failure-classifier ----------------------------------------------
// W1.3′: `unreachable` is rendered by FAILURE CLASS, not by target. The bug the
// class split exists to kill is that a bridge-lifecycle event (this process
// restarted under a live job) inherited `verify CODEX_BIN…` from the target
// descriptor and told the operator to go check a binary that was never involved.

test('Codex command-runner blocker detection is narrow and does not promote prose or failed items', async () => {
  const { isCodexCommandRunnerBlocker } = await bridge();
  const exactIncident = {
    message:
      'Unable to complete the review: every read-only command failed before execution because ' +
      '/opt/homebrew/bin/codex-code-mode-host is missing',
    toolCalls: [], stopReason: 'turn/completed',
  };
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed', summary: exactIncident,
  }), true);
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      message: 'I cannot run commands because the command runner was not found.',
      toolCalls: [], stopReason: 'turn/completed',
    },
  }), true, 'concise self-report');
  for (const [message, stopReason, label] of [
    ['codex-code-mode-host is unavailable.', 'turn/completed', 'literal live runner diagnostic'],
    ['codex-code-mode-host is unavailable.', 'thread/read', 'literal recovered runner diagnostic'],
    [
      'The configured codex-code-mode-host binary path does not exist.',
      'thread/read',
      'configured-path diagnostic recovered from thread/read',
    ],
    [
      'I cannot run commands because the command runner/tool access is unavailable.',
      'turn/completed',
      'live direct runner/tool-access self-report',
    ],
    [
      'I cannot run commands because tool access is unavailable.',
      'thread/read',
      'named access blocker recovered from thread/read',
    ],
  ]) {
    assert.equal(isCodexCommandRunnerBlocker({
      target: 'codex', status: 'completed',
      summary: { message, toolCalls: [], stopReason },
    }), true, label);
  }
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      message: 'Unable to complete the review: all read-only commands failed before execution.',
      toolCalls: [], stopReason: 'turn/completed',
    },
  }), true, 'live universal pre-execution failure does not need to repeat the runner name');

  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      message: 'The review is complete and no commands were needed.',
      toolCalls: [], stopReason: 'turn/completed',
    },
  }), false, 'an ordinary zero-tool answer is valid');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      message: 'For documentation, the old message was: "Unable to complete because codex-code-mode-host is missing."',
      toolCalls: [], stopReason: 'turn/completed',
    },
  }), false, 'quoted examples are not self-reported blockers');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      message: 'The phrase "every command failed before execution" is only an example; the review is complete.',
      toolCalls: [], stopReason: 'turn/completed',
    },
  }), false, 'quoted universal-failure prose is not a self-report');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      message: 'Unable to complete this wording task without quoting "every command failed before execution".',
      toolCalls: [], stopReason: 'turn/completed',
    },
  }), false, 'a self-reported wording task does not promote its quoted universal-failure example');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      message: 'Unable to complete this documentation sentence without quoting "codex-code-mode-host is missing".',
      toolCalls: [], stopReason: 'turn/completed',
    },
  }), false, 'a self-reported documentation task does not promote its quoted runner example');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      message: 'Unable to complete this wording task without quoting "codex-code-mode-host is unavailable".',
      toolCalls: [], stopReason: 'turn/completed',
    },
  }), false, 'quoted unavailable wording is not runtime evidence');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      message: 'Tool access is unavailable in the hypothetical environment, but the requested explanation is complete.',
      toolCalls: [], stopReason: 'turn/completed',
    },
  }), false, 'an ordinary statement about another environment is not a direct runtime diagnostic');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'opencode', status: 'completed', summary: exactIncident,
  }), false, 'other companions are unchanged');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'cancelled', summary: exactIncident,
  }), false, 'cancellation takes precedence');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      ...exactIncident,
      toolCalls: [{ name: 'shell', status: 'failed', input: { command: 'git status' } }],
    },
  }), false, 'a recorded failed item retains the existing completed-turn behavior');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      message: 'Unable to complete because a dependency is missing.',
      toolCalls: [], stopReason: 'turn/completed',
    },
  }), false, 'generic task failures do not implicate the command runner');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed', summary: { ...exactIncident, stopReason: 'thread/read' },
  }), true, 'an exact named-runner blocker survives thread/read recovery');
  assert.equal(isCodexCommandRunnerBlocker({
    target: 'codex', status: 'completed',
    summary: {
      message: 'Unable to complete the review: every command failed before execution.',
      toolCalls: [], stopReason: 'thread/read',
    },
  }), false, 'thread/read lacks tool history, so generic zero-tool inference remains disabled');
});

test('classifyUnreachable keys on failure class, not on which target produced the failure', async () => {
  const { classifyUnreachable } = await bridge();

  // bridge_lifecycle — the bridge lost ownership of its own job. Target-agnostic.
  for (const detail of [
    'target_adapter_non_resumable_after_restart',
    'sdk_adapter_non_resumable_after_restart',
    'rehydrate_no_promptid',
    'target_child_orphaned_by_bridge_restart',
    'bridge_transport_closed',
  ]) {
    for (const target of ['codex', 'copilot', 'opencode']) {
      assert.equal(classifyUnreachable(detail, target), 'bridge_lifecycle', `${detail} @ ${target}`);
    }
  }

  // runtime_unavailable — the binary is genuinely the suspect.
  assert.equal(classifyUnreachable('bridge_daemon_unreachable', 'copilot'), 'runtime_unavailable');
  assert.equal(classifyUnreachable('codex_code_mode_host_unavailable', 'codex'), 'runtime_unavailable');
  assert.equal(classifyUnreachable(null, 'codex', 'spawn codex ENOENT'), 'runtime_unavailable');
  assert.equal(classifyUnreachable(null, 'codex', 'codex exited with code 127'), 'runtime_unavailable');
  assert.equal(classifyUnreachable(null, 'opencode', '/bin/sh: opencode: command not found'), 'runtime_unavailable');

  // runtime_transport — socket/stream flap; the runtime itself may be healthy.
  assert.equal(classifyUnreachable('bridge_timeout', 'copilot'), 'runtime_transport');
  assert.equal(classifyUnreachable('opencode_server_gone', 'opencode'), 'runtime_transport');
  assert.equal(classifyUnreachable('opencode_server_unreachable', 'opencode'), 'runtime_transport');
  assert.equal(classifyUnreachable(null, 'copilot', 'write EPIPE'), 'runtime_transport');
  assert.equal(classifyUnreachable(null, 'copilot', 'socket hang up'), 'runtime_transport');

  // The target prefix is stripped, so the same condition classifies identically
  // whichever companion emitted it — and a target that does NOT own the prefix
  // leaves the detail alone rather than mis-stripping it.
  assert.equal(classifyUnreachable('codex_server_gone', 'codex'), 'runtime_transport');
  assert.equal(classifyUnreachable('opencode_server_gone', 'codex'), 'unknown');

  // thread_not_resumable — codex's resume rejection, keyed on the signature.
  assert.equal(
    classifyUnreachable(null, 'codex', 'ERROR: JSON-RPC error -32600: no rollout found for thread id 0199a1'),
    'thread_not_resumable',
  );
  assert.equal(classifyUnreachable(null, 'codex', 'no rollout found for thread id 0199a1'), 'thread_not_resumable');
  assert.equal(classifyUnreachable('thread_not_resumable', 'codex'), 'thread_not_resumable');
  // A larger number that merely contains 32600 must not trip the signature.
  assert.equal(classifyUnreachable(null, 'codex', 'processed 132600 tokens'), 'unknown');

  // unknown — honest fallback, never a guessed cause.
  assert.equal(classifyUnreachable('codex_worker_error', 'codex', 'boom'), 'unknown');
  assert.equal(classifyUnreachable(null, 'codex', ''), 'unknown');
  assert.equal(classifyUnreachable(undefined, undefined, undefined), 'unknown');
});

// On the `codex app-server` transport EVERY error is JSON-RPC -32600 and only the
// message distinguishes them, so the code itself carries no information. A
// classifier keying on the code would tell an operator whose *steer* failed that
// their live thread is unrecoverable — the misdiagnosis in a new costume.
test('the app-server -32600 family classifies on message text, never on the code', async () => {
  const { classifyUnreachable } = await bridge();

  // Genuinely gone → thread_not_resumable.
  assert.equal(
    classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: no rollout found for thread id 0199a1'),
    'thread_not_resumable',
  );
  // `thread not loaded` is thread/read's wording for the same condition: this
  // app-server has no readable rollout for that id.
  assert.equal(
    classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: thread not loaded: 0199a1'),
    'thread_not_resumable',
  );

  // Alive, and must NOT be called unrecoverable.
  //
  // `thread not found` is the regression this arm exists for: measured in
  // probes/codex-app-server/unloaded.mjs, a thread with a completed turn whose
  // app-server was SIGKILLed answers a FRESH app-server `thread not found` to
  // turn/interrupt and turn/steer — while thread/resume on that same id succeeds
  // with status idle. Calling it unrecoverable would report a broker restart, the
  // case the whole app-server transport was chosen for, as lost work.
  assert.equal(
    classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: thread not found: 0199a1'),
    'unknown',
  );
  assert.equal(
    classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: no active turn to steer'),
    'unknown',
  );
  assert.equal(
    classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: no active turn to interrupt'),
    'unknown',
  );

  // The exec transport's resume rejection is unaffected by dropping the code arm:
  // it carries the human reason alongside -32600, on stderr with an empty stdout.
  assert.equal(
    classifyUnreachable(null, 'codex', 'ERROR: -32600 no rollout found for thread id 0199a1'),
    'thread_not_resumable',
  );

  // And a -32600 with no recognised reason at all stays honest rather than
  // inheriting the resume class from its neighbours.
  assert.equal(classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: Invalid Request'), 'unknown');

  // A set detail still outranks all of it: a steer that failed while the bridge
  // was losing ownership is a lifecycle event, whatever the RPC said.
  assert.equal(
    classifyUnreachable('bridge_transport_closed', 'codex', 'JSON-RPC error -32600: no active turn to steer'),
    'bridge_lifecycle',
  );
});

test('bridge_lifecycle rendering never names the target binary env and points at the digest', async () => {
  const { formatTerminalContent } = await bridge();

  for (const detail of [
    'target_adapter_non_resumable_after_restart',
    'rehydrate_no_promptid',
    'target_child_orphaned_by_bridge_restart',
    'bridge_transport_closed',
  ]) {
    const content = formatTerminalContent({
      jobId: 'jf-life', status: 'unreachable', task: 'delegate something',
      detail, target: 'codex', digestUri: 'agent-digest://jf-life',
    });
    // The regression this whole item exists to kill.
    assert.doesNotMatch(content, /CODEX_BIN/, `${detail} must not name binaryEnv`);
    assert.doesNotMatch(content, /is available/, `${detail} must not tell the operator to verify a CLI`);
    assert.match(content, /\*\*Failure class:\*\* `bridge_lifecycle`/);
    assert.match(content, /lost ownership/);
    // Causally neutral: the bridge says it cannot tell, rather than picking one.
    assert.match(content, /cannot tell which of several outcomes/);
    assert.match(content, /agent-digest:\/\/jf-life/);
  }

  // The SDK detail keeps its specific cause line inside the shared class body.
  const sdk = formatTerminalContent({
    jobId: 'jf-sdk', status: 'unreachable', task: 't',
    detail: 'sdk_adapter_non_resumable_after_restart', target: 'copilot',
  });
  assert.match(sdk, /SDK adapter cannot reattach/);
  assert.match(sdk, /\*\*Failure class:\*\* `bridge_lifecycle`/);

  // With no digestUri the pointer degrades to the runtime dir rather than vanishing.
  const noDigest = formatTerminalContent({
    jobId: 'jf-nod', status: 'unreachable', task: 't',
    detail: 'rehydrate_no_promptid', target: 'codex',
  });
  assert.match(noDigest, /digest\/logs under/);
});

test('runtime_unavailable is the only unreachable class that names descriptor.binaryEnv', async () => {
  const { formatTerminalContent } = await bridge();

  const unavailable = formatTerminalContent({
    jobId: 'jf-una', status: 'unreachable', task: 't', target: 'codex',
    error: 'spawn codex ENOENT',
  });
  assert.match(unavailable, /\*\*Failure class:\*\* `runtime_unavailable`/);
  assert.match(unavailable, /verify `CODEX_BIN` or the `codex` CLI is available/);
  // Today's lead sentence is deliberately preserved for this class.
  assert.match(unavailable, /Bridge could not reach the Codex CLI runtime/);

  // Every other class must stay clear of the binary hint.
  const others = [
    formatTerminalContent({ jobId: 'a', status: 'unreachable', task: 't', target: 'codex', detail: 'bridge_timeout' }),
    formatTerminalContent({ jobId: 'b', status: 'unreachable', task: 't', target: 'codex', detail: 'thread_not_resumable' }),
    formatTerminalContent({ jobId: 'c', status: 'unreachable', task: 't', target: 'codex', detail: 'codex_worker_error' }),
  ];
  for (const content of others) assert.doesNotMatch(content, /CODEX_BIN/);

  assert.match(others[0], /\*\*Failure class:\*\* `runtime_transport`/);
  assert.match(others[0], /transport to the Codex CLI runtime failed mid-job/);
  assert.match(others[1], /\*\*Failure class:\*\* `thread_not_resumable`/);
  assert.match(others[1], /could not be resumed/);
  assert.match(others[2], /\*\*Failure class:\*\* `unknown`/);
  assert.match(others[2], /will not guess a cause/);
});


test('unwrapErrorMessage peels exactly one JSON level and never throws on anything else', async () => {
  const { unwrapErrorMessage, formatTerminalContent } = await bridge();

  // The measured shape: a JSON-encoded string carrying an API error envelope.
  assert.equal(
    unwrapErrorMessage('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"unknown model: gpt-9"}}'),
    'unknown model: gpt-9',
  );
  // A top-level message with no nested `error` object.
  assert.equal(unwrapErrorMessage('{"message":"flat message"}'), 'flat message');
  // Non-JSON, malformed JSON, and JSON without a message all pass through verbatim.
  assert.equal(unwrapErrorMessage('codex exited with code 1'), 'codex exited with code 1');
  assert.equal(unwrapErrorMessage('{not json at all'), '{not json at all');
  assert.equal(unwrapErrorMessage('{"status":500}'), '{"status":500}');
  assert.equal(unwrapErrorMessage('{"error":{"code":"x"}}'), '{"error":{"code":"x"}}');
  // Exactly ONE level: a doubly-encoded payload keeps its inner encoding.
  assert.equal(unwrapErrorMessage('{"error":{"message":"{\\"message\\":\\"inner\\"}"}}'), '{"message":"inner"}');
  // Degenerate inputs.
  assert.equal(unwrapErrorMessage(null), '');
  assert.equal(unwrapErrorMessage(undefined), '');
  assert.equal(unwrapErrorMessage(42), '42');

  // And it is actually wired into the operator-facing failed body.
  const content = formatTerminalContent({
    jobId: 'jf-unwrap', status: 'failed', task: 't', target: 'codex',
    error: '{"type":"error","status":400,"error":{"message":"unsupported model"}}',
  });
  assert.match(content, /job failed: unsupported model/);
  assert.doesNotMatch(content, /invalid_request_error|"type"/);
});

test('a definitive detail outranks free text from the companion\'s own stdout', async () => {
  const { classifyUnreachable, formatTerminalContent } = await bridge();

  // On the opencode server adapter, `adapterResult.stdout` IS the assistant's
  // prose (opencode-server-runtime.mjs `stdout: message`). A model quoting a
  // shell transcript must never reclassify a bridge transport flap as a missing
  // binary — that is the original misdiagnosis, re-entered through the back door.
  const assistantProse = 'I tried to run the build but got: bash: line 1: pnpm: command not found';
  const content = formatTerminalContent({
    jobId: 'jf-prose', status: 'unreachable', task: 't', target: 'opencode',
    detail: 'opencode_server_unreachable',
    error: 'opencode /event stream closed before session.idle',
    adapterResult: { stdout: assistantProse, stderr: '' },
  });
  assert.match(content, /\*\*Failure class:\*\* `runtime_transport`/);
  assert.doesNotMatch(content, /OPENCODE_BIN/);
  assert.doesNotMatch(content, /is available/);
  // The prose is still SHOWN — classification and display are different corpora.
  assert.match(content, /pnpm: command not found/);

  // Same for the other text signatures: a set detail always wins.
  assert.equal(
    classifyUnreachable('opencode_server_gone', 'opencode', 'spawn opencode ENOENT'),
    'runtime_transport',
  );
  assert.equal(
    classifyUnreachable('rehydrate_no_promptid', 'codex', 'no rollout found for thread id 0199a1'),
    'bridge_lifecycle',
  );
  assert.equal(
    classifyUnreachable('bridge_daemon_unreachable', 'copilot', 'socket hang up'),
    'runtime_unavailable',
  );

  // Only stderr + `error` feed the classifier; stdout alone never classifies.
  const stdoutOnly = formatTerminalContent({
    jobId: 'jf-out-only', status: 'unreachable', task: 't', target: 'codex',
    stdout: 'the agent said: spawn foo ENOENT while running your tests', stderr: '',
  });
  assert.match(stdoutOnly, /\*\*Failure class:\*\* `unknown`/);
  assert.doesNotMatch(stdoutOnly, /CODEX_BIN/);
  // ...but the same text on stderr, with no detail set, does.
  const stderrOnly = formatTerminalContent({
    jobId: 'jf-err-only', status: 'unreachable', task: 't', target: 'codex',
    stdout: '', stderr: 'spawn codex ENOENT',
  });
  assert.match(stderrOnly, /\*\*Failure class:\*\* `runtime_unavailable`/);
  assert.match(stderrOnly, /verify `CODEX_BIN`/);
});

test('the queue-drain surface renders the same class and channel excerpts as the wait surface', async () => {
  const mod = await bridge();
  const { emitNotification, jobs } = mod;

  // A codex resume rejection: EMPTY stdout, the reason only on stderr, no detail.
  // Delivered through the drain (the path the parent reads when it did not block
  // on agent_wait) this used to render `unknown` with zero evidence, because
  // emitNotification enumerates its formatTerminalContent fields and dropped
  // adapterResult on the floor.
  jobs.set('jf-drain', terminalJob('jf-drain', 'unreachable', {
    target: 'codex',
    adapterResult: { stdout: '', stderr: 'ERROR: JSON-RPC error -32600: no rollout found for thread id 0199a1' },
  }));
  try {
    await withQueue(async (queueFile) => {
      emitNotification({
        jobId: 'jf-drain', status: 'unreachable', summary: null, error: null,
        stuckReason: null, detail: null, duration: 1000,
        task: 'X', cwd: TEST_CWD, target: 'codex',
      });
      const event = readQueue(queueFile).at(-1);
      assert.equal(event.kind, 'terminal');
      assert.match(event.content, /\*\*Failure class:\*\* `thread_not_resumable`/);
      assert.match(event.content, /\*\*stderr \(tail\):\*\*/);
      assert.match(event.content, /no rollout found for thread id/);

      // And the bad-`-m` mirror image, whose ONLY channel is stdout.
      jobs.set('jf-drain2', terminalJob('jf-drain2', 'failed', {
        target: 'codex',
        adapterResult: { stdout: '{"type":"error","status":400,"error":{"message":"unknown model"}}', stderr: '' },
      }));
      emitNotification({
        jobId: 'jf-drain2', status: 'failed', summary: null,
        error: 'codex exited with code 1', stuckReason: null, detail: null, duration: 1000,
        task: 'X', cwd: TEST_CWD, target: 'codex',
      });
      const failedEvent = readQueue(queueFile).at(-1);
      assert.match(failedEvent.content, /\*\*stdout \(tail\):\*\*/);
      assert.match(failedEvent.content, /unknown model/);
    });
  } finally {
    jobs.delete('jf-drain');
    jobs.delete('jf-drain2');
  }
});

// Phase 3 dispatch contract: fake protocol adapters, real durable records.
import { deferred, until } from '../test/controller/helpers.mjs';
import { mkdirSync, readdirSync, statSync, appendFileSync, realpathSync } from 'node:fs';
import { fakeCodexBin } from '../test/fake-codex-app-server.mjs';
import { note, threadItem } from '../test/codex-wire-frames.mjs';
import { fixtureSupervisor } from '../test/controller/fixture-table.mjs';

async function wireFixture(t, options = {}) {
  const mod = await bridge();
  const dir = realpathSync(mkdtempSync(join(STATE_SANDBOX, 'wire-')));
  const records = new Records({ dir, log: () => {} });
  const adapters = [];
  const create = () => {
    const done = deferred();
    const adapter = {
      capabilities: { followUp: true, loadsHistory: true, modelSelection: true }, done, calls: [],
      async start(args) { this.calls.push(['start', args]); if (options.start) await options.start; },
      async openHistory(args) { this.calls.push(['history', args]); return { historyId: args.historyId || 'native-history', effectiveModel: 'configured' }; },
      async deliver(args) { this.calls.push(['deliver', args]); return { nativeTurnId: 'native-turn' }; },
      observe({ onProgress }) { this.progress = onProgress; return done.promise; },
      async interrupt() {}, async close() {},
    };
    adapters.push(adapter); return adapter;
  };
  const providers = Object.fromEntries(['codex', 'opencode', 'copilot', 'antigravity'].map((target) => [target,
    { enabled: true, ready: true, modelAllowed: (model) => !model.includes('bad'), create }]));
  const active = mod.createBridgeController({ records, providers,
    createSupervisor: () => ({ terminate: async () => ({ gone: true, signals: [], survivors: [] }) }) });
  const call = async (args, request = {}) => (await mod.dispatch(args, { controller: active, ...request })).structuredContent;
  const send = (args = {}, request) => call({ action: 'send', target: 'codex', thread: 'child', task: EXACT_TASK, cwd: dir, ...args }, request);
  t.after(async () => {
    for (const a of [...active.live.values()]) await active.cancel({ owner: a.record.owner, executionId: a.record.executionId });
  });
  return { mod, active, records, adapters, providers, dir, call, send };
}
function wireDisk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).sort().filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => [f, statSync(join(dir, f)).mtimeMs, readFileSync(join(dir, f), 'utf8')]);
}

test('controller dispatch preserves the conversational tools and named refusals', async (t) => {
  const h = await wireFixture(t);
  const tools = (await h.mod.mcp._requestHandlers.get('tools/list')({ method: 'tools/list', params: {} })).tools;
  assert.deepEqual(tools.map((x) => x.name), ['agent_catalog', 'agent_send', 'agent_wait', 'agent_status', 'agent_reply', 'agent_cancel']);
  assert.deepEqual(Object.keys(tools[1].inputSchema.properties).sort(), ['cwd', 'max_wait_sec', 'model', 'target', 'task']);
  assert.equal((await h.send({ thread: null })).code, 'NATIVE_OWNER_REQUIRED');
  assert.equal((await h.send({ cwd: 'relative' })).code, 'INVALID_CWD');
  assert.equal((await h.send({ target: 'unsupported' })).code, 'TARGET_UNSUPPORTED');
  h.providers.codex.ready = false;
  assert.equal((await h.send()).code, 'CAPABILITY_UNAVAILABLE');
  h.providers.codex.ready = true;
  assert.equal((await h.send({ model: 'bad-model' })).code, 'MODEL_NOT_ALLOWED');
  const { clearDefaultTarget } = await import('../lib/state.mjs');
  clearDefaultTarget();
  await withEnv('AGENT_COMPANION_DEFAULT_TARGET', undefined, async () => {
    assert.equal((await h.send({ target: null })).code, 'TARGET_UNCONFIGURED');
  });
  const callTool = h.mod.mcp._requestHandlers.get('tools/call');
  const invalid = (await callTool({ method: 'tools/call', params: { name: 'agent_send', arguments: { task: 'x', thread: 'child', cwd: 'relative' } } })).structuredContent;
  assert.equal(invalid.code, 'INVALID_CWD');
  const malformed = (await callTool({ method: 'tools/call', params: { name: 'agent_status', arguments: { extra: true } } })).structuredContent;
  assert.equal(malformed.code, 'INVALID_ARGUMENTS');
  assert.equal((await h.call({ action: 'wait', job_id: 'missing', thread: 'child' })).status, 'unknown_job');
  assert.equal((await h.call({ action: 'cancel', job_id: 'missing', thread: 'child' })).ok, false);
  assert.equal((await h.call({ action: 'status', job_id: 'missing' })).ok, false);
});

test('all four providers receive exact task text, inherit models, and reattach only identical work', async (t) => {
  const h = await wireFixture(t);
  for (const target of Object.keys(h.providers)) {
    const sent = await h.send({ target, thread: target });
    assert.deepEqual(sent, { ok: true, status: 'still_running', job_id: sent.job_id, thread: target });
    const adapter = h.adapters.at(-1);
    assert.equal(adapter.calls.find(([name]) => name === 'deliver')[1].text, EXACT_TASK);
    assert.equal(Object.hasOwn(adapter.calls[0][1], 'model'), false);
    assert.deepEqual(await h.send({ target, thread: target }), sent);
    const busy = await h.send({ target, thread: target, task: 'new' });
    assert.equal(busy.status, 'thread_busy'); assert.equal(busy.job_id, sent.job_id);
    assert.equal((await h.send({ target, thread: target, model: 'changed' })).status, 'thread_busy');
    assert.equal((await h.send({ target, thread: target, cwd: tmpdir() })).status, 'cwd_mismatch');
    assert.equal((await h.send({ target: target === 'codex' ? 'copilot' : 'codex', thread: target })).status, 'provider_mismatch');
  }
  assert.equal(h.adapters.length, 4);
});

test('starting requests retain cwd and hold attachment through acknowledgement', async (t) => {
  const gate = deferred(); const h = await wireFixture(t, { start: gate.promise });
  const sending = h.send({}, { requestId: 'send-request' });
  await until(() => h.adapters.length === 1);
  const e = h.records.listExecutions()[0];
  assert.equal(e.cwd, h.dir);
  assert.equal(h.records.readLease(e.executionId).attached, true);
  assert.equal((await h.send({ model: 'changed' })).status, 'thread_busy');
  const retry = h.send({}, { requestId: 'retry-request' });
  gate.resolve();
  assert.deepEqual(await retry, await sending);
  assert.equal(h.records.readLease(e.executionId).attached, false);
});

test('wait progress, read-only status, digest resources and immutable terminal queue projection', async (t) => {
  const h = await wireFixture(t);
  await withEnv('CLAUDE_CODE_SESSION_ID', 'wire-session', async () => withQueue(async (queue) => {
    h.mod._resetForTest();
    const sent = await h.send({ model: 'selected' });
    const id = sent.job_id;
    const progress = { lastActivityAt: Date.now(), activeCommand: 'build', retry: { attempt: 2 }, partialText: 'partial answer' };
    h.adapters[0].progress(progress);
    assert.match(h.mod.readDigestResource(`agent-digest://${id}`).contents[0].text, /partial answer/);
    const snapshot = [wireDisk(h.dir), wireDisk(RUNTIME_SANDBOX)];
    for (let i = 0; i < 3; i++) {
      const status = await h.call({ action: 'status', job_id: id, verbose: true, diagnostics: true });
      assert.equal(status.status, 'running'); assert.equal(status.thread, 'child');
      assert.equal(status.lease.attached, false); assert.ok(status.lease.remainingMs > 0);
      assert.equal(status.native_turn_state, 'running'); assert.equal(status.last_native_activity, progress.lastActivityAt);
      assert.equal(status.active_command, 'build'); assert.deepEqual(status.retry, { attempt: 2 });
      assert.equal(status.partial_text, 'partial answer');
      await h.call({ action: 'status' });
    }
    assert.deepEqual([wireDisk(h.dir), wireDisk(RUNTIME_SANDBOX)], snapshot);
    const running = await h.call({ action: 'wait', job_id: id, thread: 'child', max_wait_sec: 1 });
    assert.equal(running.status, 'still_running'); assert.equal(running.current_status, 'running');
    assert.equal(running.thread, 'child'); assert.equal(running.digest_uri, `agent-digest://${id}`);
    const usage = { input_tokens: 12, output_tokens: 3 };
    h.adapters[0].done.resolve({ outcome: 'completed', text: 'final answer', usage, effectiveModel: 'resolved', effectiveEffort: 'high' });
    await until(() => h.records.readResult(id), 'background terminal publication');
    assert.equal(readQueue(queue).find((row) => row.jobId === id).consumed, false);
    const terminal = await h.call({ action: 'wait', job_id: id, thread: 'child', max_wait_sec: 1 });
    assert.equal(terminal.content, 'final answer'); assert.equal(terminal.status, 'completed');
    assert.deepEqual(terminal.meta.usage, usage); assert.equal(terminal.meta.selected_model, 'selected');
    assert.equal(terminal.meta.effective_model, 'resolved'); assert.equal(terminal.meta.effective_effort, 'high');
    assert.equal(terminal.meta.cause, 'native_complete'); assert.equal(terminal.meta.stop_evidence.gone, true);
    assert.equal(terminal.meta.native_refs.historyId, 'native-history');
    assert.equal(terminal.meta.digest_uri, `agent-digest://${id}`);
    const bytes = readFileSync(h.records.path('results', id), 'utf8');
    assert.deepEqual(await h.call({ action: 'wait', job_id: id, thread: 'child' }), terminal);
    await h.mod.recoverController(h.active);
    assert.equal(readFileSync(h.records.path('results', id), 'utf8'), bytes);
    const rows = readQueue(queue).filter((row) => row.jobId === id);
    assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'terminal'); assert.equal(rows[0].consumed, true);
    assert.equal(rows[0].claudeSessionId, 'wire-session'); assert.equal(rows[0].content, terminal.content);
    assert.deepEqual(rows[0].meta, JSON.parse(JSON.stringify(terminal.meta)));
    assert.match(h.mod.readDigestResource(`agent-digest://${id}`).contents[0].text, /final answer/);
    assert.ok(h.mod.listDigestResources().some((r) => r.uri === terminal.meta.digest_uri));
    assert.equal(h.mod.listDigestResourceTemplates()[0].uriTemplate, 'agent-digest://{job_id}');
    assert.throws(() => h.mod.readDigestResource('file:///tmp/invalid'), /unknown digest/);
    assert.equal(statSync(queue).mode & 0o777, 0o600);
    rmSync(queue); // A drain must not make a later bridge re-enqueue the result.
    await h.mod.recoverController(h.active);
    assert.equal(existsSync(queue), false);
  }));
});

for (const [outcome, status] of [['failed', 'failed'], ['interrupted', 'cancelled'], ['stopped', 'cancelled'], ['delivery_unknown', 'failed']]) {
  test(`durable ${outcome} results map to ${status} without rewriting their text`, async (t) => {
    const h = await wireFixture(t);
    const e = h.records.begin({ owner: 'child', provider: 'codex', cwd: h.dir, text: 'task', executionId: 'saved', now: Date.now() }, 0);
    h.records.writeResult({ owner: e.owner, executionId: e.executionId, generation: e.generation,
      outcome, text: 'partial', cause: 'provider_error', detail: 'native detail', stopEvidence: { gone: true }, finishedAt: Date.now() });
    const response = await h.call({ action: 'wait', thread: 'child', job_id: e.executionId });
    assert.equal(response.status, status); assert.equal(response.meta.status, status); assert.equal(response.content, 'partial');
    assert.equal(response.meta.detail, outcome === 'delivery_unknown' ? outcome : 'native detail');
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(response.meta)), 'usage'), false);
  });
}

test('cancel and cancelled owner requests close only their own execution', async (t) => {
  const h = await wireFixture(t);
  const one = await h.send(), sibling = await h.send({ thread: 'sibling' });
  assert.equal((await h.call({ action: 'cancel', job_id: one.job_id, thread: 'sibling' })).status, 'unknown_job');
  const abort = new AbortController();
  const waiting = h.call({ action: 'wait', job_id: one.job_id, thread: 'child', max_wait_sec: 30 }, { requestId: 'wait-request', signal: abort.signal });
  await until(() => h.active.requests.has('wait-request'));
  assert.equal(h.records.readLease(one.job_id).attached, true);
  abort.abort();
  const stopped = await waiting;
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.meta.cause, 'owner_stop');
  assert.equal((await h.call({ action: 'status', job_id: sibling.job_id })).status, 'running');
  const cancel = await h.call({ action: 'cancel', job_id: sibling.job_id, thread: 'sibling' });
  assert.equal(cancel.action, 'cancel'); assert.equal(cancel.status, 'cancelled'); assert.equal(cancel.meta.stop_evidence.gone, true);
  assert.deepEqual(await h.call({ action: 'cancel', job_id: sibling.job_id, thread: 'sibling' }), cancel);
});

test('legacy history requires latest same-target ledger evidence; cold follow-up keeps history', async (t) => {
  const h = await wireFixture(t);
  mkdirSync(join(h.dir, 'threads'));
  writeFileSync(join(h.dir, 'threads', 'child.sid'), 'legacy-history');
  assert.equal((await h.send()).code, 'thread_ambiguous');
  h.records._write('jobs', 'old', { thread: 'child', target: 'codex', startedAt: 1 });
  h.records._write('jobs', 'latest', { thread: 'child', target: 'opencode', startedAt: 2 });
  assert.match((await h.send()).error, /opencode.*codex/);
  h.records._write('jobs', 'latest', { thread: 'child', target: 'codex', startedAt: 2 });
  const first = await h.send();
  assert.equal(h.adapters[0].calls.find(([name]) => name === 'history')[1].historyId, 'legacy-history');
  h.adapters[0].done.resolve({ outcome: 'completed', text: 'first' });
  await h.call({ action: 'wait', job_id: first.job_id, thread: 'child' });
  const second = await h.send({ task: 'follow-up' });
  assert.notEqual(second.job_id, first.job_id);
  assert.equal(h.adapters[1].calls.find(([name]) => name === 'history')[1].historyId, 'legacy-history');
});

test('startup recovery verifies process absence; status never recovers or adopts unknown work', async (t) => {
  const h = await wireFixture(t);
  const e = h.records.begin({ owner: 'child', provider: 'codex', cwd: h.dir, text: 'task', executionId: 'old', now: Date.now() }, 0);
  h.records.writeExecution({ ...e, state: 'running', processes: { pid: 12345 }, progress: { partialText: 'saved' } });
  let absent = false, checks = 0;
  h.active.createSupervisor = () => ({ verifyGone: async () => { checks++; return { gone: absent }; } });
  const before = wireDisk(h.dir);
  assert.equal((await h.call({ action: 'status', job_id: 'old' })).status, 'unknown');
  assert.deepEqual(wireDisk(h.dir), before); assert.equal(checks, 0);
  await h.mod.recoverController(h.active);
  assert.equal(checks, 1); assert.equal(h.records.readResult('old'), null);
  assert.equal((await h.send()).code, 'execution_unknown');
  absent = true; await h.mod.recoverController(h.active);
  const result = await h.call({ action: 'wait', thread: 'child', job_id: 'old' });
  assert.equal(result.status, 'cancelled'); assert.equal(result.meta.cause, 'bridge_loss'); assert.equal(result.content, 'saved');
});

test('dispatch uses codexProvider with a real fake app-server through complete, cancel and bridge-loss handoff', { timeout: 30_000 }, async (t) => {
  const mod = await bridge();
  const dir = mkdtempSync(join(STATE_SANDBOX, 'codex-wire-'));
  const bin = fakeCodexBin(dir);
  writeFileSync(join(dir, 'codex-code-mode-host'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const frame = (status) => note('turn/completed', { threadId: 'T1', turn: { id: 'TURN1', status,
    items: [threadItem('agentMessage', { id: 'answer', text: 'native answer', phase: 'final_answer' })] } });
  appendFileSync(bin, `
if (process.argv[2] === 'app-server') {
  process.send({ rows: [{ pid: process.pid, ppid: process.ppid, pgid: process.pid, birthTime: process.pid + ':' + performance.timeOrigin }] });
  process.stdin.on('end', () => { if (process.connected) process.disconnect(); });
}
const original = handle;
handle = (msg) => {
  original(msg);
  if (msg.method === 'turn/start') {
    out(${JSON.stringify(note('item/agentMessage/delta', { threadId: 'T1', turnId: 'TURN1', itemId: 'part', delta: 'native partial' }))});
    if (msg.params.input[0].text === 'complete') out(${JSON.stringify(frame('completed'))});
  }
  if (msg.method === 'turn/interrupt') out(${JSON.stringify(frame('interrupted'))});
};
`);
  const env = { ...process.env, CODEX_BIN: bin, CODEX_FAKE_TRACE: join(dir, 'trace.jsonl') };
  const { writeTargetChecks } = await import('../lib/state.mjs');
  writeTargetChecks({ codex: { ready: true } });
  const records = new Records({ dir: join(dir, 'records') });
  // Keep production adapters and real child processes. The existing identity
  // fixture replaces ps, which the execution sandbox denies.
  const supervisors = [];
  const createSupervisor = (options) => {
    const supervisor = fixtureSupervisor(options);
    const spawnRuntime = supervisor.spawn.bind(supervisor);
    supervisor.spawn = (argv, opts) => spawnRuntime(argv, { ...opts, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    supervisors.push(supervisor);
    return supervisor;
  };
  const watcherPath = join(dir, 'watcher.mjs');
  writeFileSync(watcherPath, `
import { Records } from ${JSON.stringify(new URL('./controller/records.mjs', import.meta.url).href)};
import { cleanupExecution } from ${JSON.stringify(new URL('../scripts/cleanup-watcher.mjs', import.meta.url).href)};
import { fixtureSupervisor } from ${JSON.stringify(new URL('../test/controller/fixture-table.mjs', import.meta.url).href)};
const records = new Records({ dir: process.argv[2] });
await cleanupExecution({ records, execution: records.readExecution(process.argv[3]), createSupervisor: fixtureSupervisor });
`);
  let watcher;
  const active = mod.createBridgeController({ env, records, createSupervisor,
    launchWatcher: async ({ stateDir, executionId }) => {
      watcher = spawn(process.execPath, [watcherPath, stateDir, executionId], { detached: true, stdio: 'ignore' });
      await once(watcher, 'spawn');
      return { pid: watcher.pid };
    } });
  const call = async (args) => (await mod.dispatch(args, { controller: active })).structuredContent;
  const send = (thread, task) => call({ action: 'send', target: 'codex', cwd: dir, thread, task });
  t.after(async () => {
    for (const supervisor of supervisors) await supervisor.terminate({ graceMs: 0 });
    if (watcher && watcher.exitCode === null) await once(watcher, 'exit');
    mod.registerBridgeLossHandler(() => mod.controller.bridgeLost());
  });
  const completed = await send('complete-child', 'complete');
  const answer = await call({ action: 'wait', thread: 'complete-child', job_id: completed.job_id, max_wait_sec: 5 });
  assert.equal(answer.status, 'completed', JSON.stringify(answer)); assert.equal(answer.content, 'native answer');
  const running = await send('cancel-child', 'wait for cancel');
  const status = await call({ action: 'status', job_id: running.job_id });
  assert.equal(status.status, 'running');
  const cancelled = await call({ action: 'cancel', thread: 'cancel-child', job_id: running.job_id });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.meta.stop_evidence.gone, true);
  const lost = await send('lost-child', 'wait for bridge loss');
  mod.registerBridgeLossHandler(() => active.bridgeLost());
  await mod.onBridgeLoss();
  assert.equal(records.readExecution(lost.job_id).writer, 'watcher');
  await until(() => records.readResult(lost.job_id), 'cleanup watcher result');
  const fresh = mod.createBridgeController({ env, records, createSupervisor });
  await mod.recoverController(fresh);
  const recovered = (await mod.dispatch({ action: 'wait', thread: 'lost-child', job_id: lost.job_id }, { controller: fresh })).structuredContent;
  assert.equal(recovered.meta.cause, 'bridge_loss'); assert.equal(recovered.meta.stop_evidence.gone, true);
  assert.equal(recovered.status, 'cancelled');
  const trace = readQueue(env.CODEX_FAKE_TRACE);
  assert.equal(trace.filter((x) => x.method === 'turn/start').length, 3);
  assert.equal(trace.some((x) => x.method === 'turn/interrupt'), true);
  assert.equal(Object.hasOwn(trace.find((x) => x.method === 'turn/start').params, 'model'), false);
});
