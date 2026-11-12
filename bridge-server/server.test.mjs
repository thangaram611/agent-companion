// server.mjs must be importable from tests without attaching to stdio and
// must expose enough seams to validate bridge behavior without a real provider.

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
const { claudeProvider, ClaudeAdapter } = await import('./adapters/claude.mjs');
const { writeTargetChecks } = await import('../lib/state.mjs');

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

test('wait-budget clamping keeps the existing bounds', async () => {
  const { clampWaitSec } = await bridge();
  assert.equal(clampWaitSec(700), 700);
  assert.equal(clampWaitSec(1200), 1200);
  assert.equal(clampWaitSec(1500), 1200);
  for (const value of [undefined, null, 0, 'not a number']) assert.equal(clampWaitSec(value), 480);
  assert.equal(clampWaitSec(0.4), 1);
});


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
  const providers = Object.fromEntries(['codex', 'opencode', 'copilot', 'antigravity', 'claude'].map((target) => [target,
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
  assert.match(tools.find((x) => x.name === 'agent_reply').inputSchema.properties.message.description, /reply_unavailable/);
  assert.deepEqual(Object.keys(tools[1].inputSchema.properties).sort(), ['cwd', 'effort', 'max_wait_sec', 'model', 'target', 'task']);
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

test('configured model defaults survive cold follow-up for OpenCode and Claude', async (t) => {
  const h = await wireFixture(t);
  for (const [target, model] of [['opencode', 'ollama-cloud/configured'], ['claude', 'haiku']]) {
    let first, adapter;
    await withEnv(`AGENT_COMPANION_${target.toUpperCase()}_MODEL`, model, async () => {
      first = await h.send({ target, thread: target });
      adapter = h.adapters.at(-1);
      assert.equal(adapter.calls[0][1].model, model);
      adapter.done.resolve({ outcome: 'completed', text: 'ok' });
      await h.call({ action: 'wait', job_id: first.job_id, thread: target, max_wait_sec: 5 });
    });
    const again = await h.send({ target, thread: target, task: 'second question' });
    assert.notEqual(again.job_id, first.job_id);
    const next = h.adapters.at(-1);
    assert.notEqual(next, adapter, 'follow-up creates a fresh adapter');
    assert.equal(next.calls[0][1].model, model, 'stored override survives when the knob is gone');
    assert.equal(next.calls.find(([name]) => name === 'history')[1].historyId, 'native-history');
    next.done.resolve({ outcome: 'completed', text: 'ok' });
    await h.call({ action: 'wait', job_id: again.job_id, thread: target, max_wait_sec: 5 });
  }
});

test('a send whose omitted model was normalized to null still applies the configured default', async (t) => {
  // validation.mjs normalizes an omitted model to null before dispatch; the
  // configured default must apply to that shape, not only to undefined.
  const h = await wireFixture(t);
  await withEnv('AGENT_COMPANION_CLAUDE_MODEL', 'haiku', async () => {
    const sent = await h.send({ target: 'claude', thread: 'claude-null', model: null });
    const adapter = h.adapters.at(-1);
    assert.equal(adapter.calls[0][1].model, 'haiku');
    adapter.done.resolve({ outcome: 'completed', text: 'ok' });
    await h.call({ action: 'wait', job_id: sent.job_id, thread: 'claude-null', max_wait_sec: 5 });
  });
});

test('all five providers receive exact task text, inherit models, and reattach only identical work', async (t) => {
  const h = await wireFixture(t);
  for (const target of Object.keys(h.providers)) {
    const sent = await h.send({ target, thread: target });
    assert.deepEqual(sent, { ok: true, status: 'still_running', job_id: sent.job_id, thread: target, target,
      selected_model: null, selected_effort: null, effective_model: 'configured', effective_effort: null,
      permission_mode: ({ codex: 'workspace-write', claude: 'bypassPermissions', antigravity: 'all' })[target] || 'managed' });
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
  assert.equal(h.adapters.length, 5);
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
  assert.equal((await h.send()).code, 'previous_execution_unverified');
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

import { codexDispatchFixture } from '../test/controller/codex-dispatch-fixture.mjs';

test('controller reply steers the acknowledged native turn and confirms injection while holding the owner lease', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  assert.equal((await h.call({ action: 'status', job_id })).reply_available, true);
  const reply = h.call({ action: 'reply', thread: 'child', job_id, message: 'use ripgrep' }, { requestId: 'steer-request' });
  await until(() => h.frames().some((f) => f.method === 'turn/steer'), 'native steer');
  assert.deepEqual(h.records.readLease(job_id).requestIds, ['steer-request']);
  await h.clock.advance(4000); // Exceeds detached grace; reply still owns it.
  assert.equal(h.records.readResult(job_id), null);
  await h.emit(job_id, [note('item/completed', { threadId: 'T1', turnId: 'TURN1',
    item: threadItem('userMessage', { id: 'steer', content: [{ type: 'text', text: 'use ripgrep' }] }) })]);
  const response = await reply;
  assert.equal(response.ok, true);
  assert.equal(response.accepted, true);
  assert.equal(response.confirmed, true);
  assert.equal(response.nativeTurnId, 'TURN1');
  assert.equal(response.job_id, job_id);
  assert.equal(h.active.requests.size, 0);
  assert.equal(h.records.readLease(job_id).attached, false);
  assert.deepEqual(h.frames().filter((f) => f.method === 'turn/steer').map((f) => f.params), [
    { threadId: 'T1', expectedTurnId: 'TURN1', input: [{ type: 'text', text: 'use ripgrep' }] },
  ]);
  assert.equal(h.frames().filter((f) => f.method === 'turn/start').length, 1);
  assert.equal(h.frames().some((f) => f.method === 'turn/interrupt'), false);
  await h.complete(job_id, 'steered answer');
  assert.equal((await h.call({ action: 'wait', thread: 'child', job_id })).content, 'steered answer');
});

test('controller reply reports acknowledgement without claiming unobserved injection', async (t) => {
  const h = codexDispatchFixture(t);
  h.env.AGENT_COMPANION_CODEX_STEER_CONFIRM_MS = '1';
  const { job_id } = await h.send();
  const response = await h.call({ action: 'reply', thread: 'child', job_id, message: 'later boundary' });
  assert.equal(response.ok, true);
  assert.equal(response.accepted, true);
  assert.equal(response.confirmed, false);
  assert.equal((await h.call({ action: 'status', job_id })).reply_available, true);
  assert.equal(h.records.readLease(job_id).attached, false);
});

test('controller reply refuses completed, foreign, missing and unowned executions without a new native turn', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  assert.equal((await h.call({ action: 'reply', thread: 'other', job_id, message: 'x' })).status, 'unknown_job');
  assert.equal((await h.call({ action: 'reply', job_id, message: 'x' })).code, 'NATIVE_OWNER_REQUIRED');
  assert.equal((await h.call({ action: 'reply', thread: 'child', job_id: 'missing', message: 'x' })).status, 'unknown_job');
  await h.complete(job_id);
  const before = wireDisk(h.records.dir);
  const response = await h.call({ action: 'reply', thread: 'child', job_id, message: 'new work' });
  assert.equal(response.ok, false);
  assert.equal(response.status, 'reply_unavailable');
  assert.equal(response.reason, 'state');
  assert.equal((await h.call({ action: 'status', job_id })).reply_available, false);
  assert.deepEqual(wireDisk(h.records.dir), before);
  assert.equal(h.frames().filter((f) => f.method === 'turn/start').length, 1);
});

test('controller reply refuses providers without steer capability without invoking their protocol', async (t) => {
  const h = await wireFixture(t);
  for (const target of ['opencode', 'copilot', 'antigravity', 'claude']) {
    const { job_id } = await h.send({ target, thread: target });
    const adapter = h.adapters.at(-1);
    adapter.capabilities.steer = false;
    adapter.steer = () => assert.fail('unsupported steer must not run');
    const before = wireDisk(h.dir);
    const response = await h.call({ action: 'reply', thread: target, job_id, message: 'revise' });
    assert.equal(response.ok, false);
    assert.equal(response.status, 'reply_unavailable');
    assert.equal(response.reason, 'capability');
    assert.equal((await h.call({ action: 'status', job_id })).reply_available, false);
    assert.deepEqual(wireDisk(h.dir), before);
  }
});

test('cancelled controller reply stops its execution and releases its owner request', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  const abort = new AbortController();
  const reply = h.call({ action: 'reply', thread: 'child', job_id, message: 'pending' }, { requestId: 'cancel-reply', signal: abort.signal });
  await until(() => h.frames().some((f) => f.method === 'turn/steer'), 'pending steer');
  abort.abort();
  const response = await reply;
  assert.equal(response.accepted, true);
  assert.equal(response.confirmed, false);
  await until(() => h.records.readResult(job_id), 'reply cancellation cleanup');
  assert.equal(h.records.readResult(job_id).cause, 'owner_stop');
  assert.equal(h.records.readResult(job_id).stopEvidence.gone, true);
  assert.equal(h.active.requests.size, 0);
  assert.equal((await h.call({ action: 'status', job_id })).reply_available, false);
});

test('owner-attached execution survives forty minutes and retired timeout knobs; status advertises no cutoff', async (t) => {
  const h = codexDispatchFixture(t);
  h.env.AGENT_COMPANION_CODEX_TIMEOUT_MS = '1';
  h.env.AGENT_COMPANION_OPENCODE_TIMEOUT_MS = '1';
  const { job_id } = await h.send();
  for (let i = 0; i < 3; i++) {
    const waiting = h.call({ action: 'wait', thread: 'child', job_id, max_wait_sec: 1201 });
    await until(() => h.active.requests.size === 1, 'bounded owner wait');
    await h.clock.advance(1_200_000);
    assert.equal((await waiting).status, 'still_running');
  }
  assert.equal(h.records.readResult(job_id), null);
  assert.equal((await h.call({ action: 'status', job_id })).status, 'running');
  const status = await h.call({ action: 'status' });
  assert.doesNotMatch(JSON.stringify(status), /timeout_ms|timeoutEnv|40 minutes|AGENT_COMPANION_(CODEX|OPENCODE)_TIMEOUT_MS/);
});


import { fakeClaudeBin } from '../test/fake-claude-stream.mjs';

test('Claude provider uses cached readiness, accepts aliases and creates independent adapters', () => {
  writeTargetChecks({ claude: { ready: false } });
  const provider = claudeProvider({ env: { CLAUDE_BIN: '/missing-claude', PATH: '' } });
  assert.equal(provider.enabled, true);
  assert.equal(provider.ready, false);
  writeTargetChecks({ claude: { ready: true } });
  assert.equal(provider.ready, true, 'readiness getter observes updated cached evidence without probing');
  assert.equal(provider.modelAllowed('haiku'), true);
  assert.equal(provider.modelAllowed('bad model'), false);
  assert.ok(provider.create() instanceof ClaudeAdapter);
  assert.notEqual(provider.create(), provider.create());
  writeTargetChecks({});
  assert.equal(provider.ready, false);
});

test('dispatch wires the Claude provider through fake native send and cold resume', async (t) => {
  const mod = await bridge();
  const dir = mkdtempSync(join(STATE_SANDBOX, 'claude-wire-'));
  const env = { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'), CLAUDE_BIN: fakeClaudeBin(dir),
    FAKE_CLAUDE_TRACE: join(dir, 'trace.jsonl'), AGENT_COMPANION_CLAUDE_PERMISSION: 'plan' };
  writeTargetChecks({ claude: { ready: true } });
  const supervisors = [];
  const active = mod.createBridgeController({ env, records: new Records({ dir: join(dir, 'records') }), createSupervisor: (options) => {
    const supervisor = fixtureSupervisor(options), spawn = supervisor.spawn.bind(supervisor);
    supervisor.spawn = (argv, opts) => spawn(argv, { ...opts, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    supervisors.push(supervisor);
    return supervisor;
  } });
  t.after(async () => {
    for (const live of [...active.live.values()]) await active.cancel({ owner: live.record.owner, executionId: live.record.executionId });
    for (const supervisor of supervisors) await supervisor.terminate({ graceMs: 0 });
    writeTargetChecks({});
  });
  const call = async (args) => (await mod.dispatch(args, { controller: active })).structuredContent;
  const answers = [];
  for (const task of [EXACT_TASK, 'follow-up']) {
    const sent = await call({ action: 'send', target: 'claude', thread: 'claude-child', cwd: dir, task, effort: task === EXACT_TASK ? 'low' : null });
    assert.equal(sent.ok, true);
    assert.equal(sent.effective_model, 'claude-haiku-5-5');
    assert.equal(sent.selected_effort, 'low');
    assert.equal(sent.effective_effort, null);
    assert.equal(sent.permission_mode, 'plan');
    const catalog = await call({ action: 'catalog' });
    assert.equal(catalog.targets.find((target) => target.id === 'claude').permission.mode, sent.permission_mode);
    const answer = await call({ action: 'wait', thread: 'claude-child', job_id: sent.job_id, max_wait_sec: 5 });
    assert.equal(answer.status, 'completed');
    assert.equal(answer.content, 'alpha');
    answers.push(answer);
  }
  assert.notEqual(supervisors[0].child.pid, supervisors[1].child.pid);
  assert.equal(answers[0].meta.native_refs.historyId, answers[1].meta.native_refs.historyId);
  const frames = readFileSync(env.FAKE_CLAUDE_TRACE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(frames.filter((f) => f.type === 'user').map((f) => f.message.content), [EXACT_TASK, 'follow-up']);
  const argv = frames.filter((f) => f.type === 'argv').map((f) => f.args);
  assert.ok(argv[0].includes('--session-id'));
  assert.ok(argv[1].includes('--resume'));
  assert.equal(argv.some((args) => args.includes('--model')), false);
  assert.ok(argv.every((args) => args[args.indexOf('--effort') + 1] === 'low'));
  assert.ok(answers.every((answer) => answer.meta.selected_effort === 'low' && answer.meta.effective_effort === null));
});

test('effort refusals precede startup and acknowledgement/status/result retain launch selections', async (t) => {
  const h = await wireFixture(t);
  for (const target of ['opencode', 'copilot', 'antigravity']) {
    const refusal = await h.send({ target, effort: 'low' });
    assert.equal(refusal.code, 'CAPABILITY_UNAVAILABLE');
    assert.match(refusal.error, /cannot select effort/);
  }
  const invalid = await h.send({ target: 'claude', effort: 'invalid' });
  assert.equal(invalid.code, 'EFFORT_NOT_ALLOWED');
  assert.equal(invalid.effort, 'invalid');
  assert.match(invalid.hint, /low, medium, high, xhigh, max/);
  assert.equal(h.adapters.length, 0);
  const sent = await h.send({ target: 'claude', model: 'haiku', effort: 'low' });
  assert.equal(sent.selected_model, 'haiku'); assert.equal(sent.selected_effort, 'low');
  assert.equal(sent.effective_model, 'configured'); assert.equal(sent.effective_effort, null);
  assert.equal(sent.permission_mode, 'bypassPermissions');
  assert.equal((await h.send({ target: 'claude', effort: 'high' })).status, 'thread_busy');
  assert.deepEqual(await h.send({ target: 'claude', model: null, effort: null }), sent);
  const status = await h.call({ action: 'status', job_id: sent.job_id });
  assert.equal(status.selected_effort, 'low'); assert.equal(status.permission_mode, sent.permission_mode);
  h.active.env = { ...h.active.env, AGENT_COMPANION_CLAUDE_PERMISSION: 'plan' };
  assert.equal((await h.call({ action: 'catalog' })).targets.find((target) => target.id === 'claude').permission.mode, 'plan');
  assert.equal((await h.call({ action: 'status', job_id: sent.job_id })).permission_mode, sent.permission_mode);
  h.adapters[0].done.resolve({ outcome: 'completed', text: 'ok' });
  const result = await h.call({ action: 'wait', job_id: sent.job_id, thread: 'child', max_wait_sec: 5 });
  assert.equal(result.meta.selected_effort, 'low'); assert.equal(result.meta.effective_effort, null);
  const next = await h.send({ target: 'claude', task: 'follow-up', effort: null });
  assert.equal(next.selected_effort, 'low');
});

test('mismatch hints name the bound conversation and the normalized requested companion', async (t) => {
  const h = await wireFixture(t);
  await h.send({ target: 'claude' });
  const mismatch = await h.call(h.mod.callArgs('send', { arguments: { target: ' CODEX ', thread: 'child', task: EXACT_TASK, cwd: h.dir } }));
  assert.equal(mismatch.hint, `This conversation is bound to claude in ${h.dir}. To use codex, spawn a new agent-companion and restate the task.`);
  const configured = await h.send({ target: null });
  assert.match(configured.hint, /To use copilot, spawn a new agent-companion/);
  const cwd = await h.send({ target: 'claude', cwd: tmpdir() });
  assert.equal(cwd.hint, `This conversation is bound to ${h.dir}. Use that path, or spawn a new agent-companion for the other repo.`);
});

test('status activity uses native state or command/text fallback and clears at terminal', async (t) => {
  const h = await wireFixture(t), sent = await h.send();
  const status = () => h.call({ action: 'status', job_id: sent.job_id });
  assert.equal((await status()).activity, null);
  for (const [progress, expected] of [
    [{ partialText: 'some text' }, 'responding'],
    [{ activeCommand: 'npm test' }, 'running npm test'],
    [{ activity: 'thinking' }, 'thinking'],
    [{ activity: null }, null],
  ]) {
    h.adapters[0].progress(progress);
    assert.equal((await status()).activity, expected);
  }
  h.adapters[0].done.resolve({ outcome: 'completed', text: 'done' });
  await h.call({ action: 'wait', job_id: sent.job_id, thread: 'child', max_wait_sec: 5 });
  assert.equal((await status()).activity, null);
});

test('Codex accepts effort and exposes adapter refusals through send, status and saved results', async (t) => {
  const h = codexDispatchFixture(t);
  const send = (effort, thread) => h.call({ action: 'send', target: 'codex', cwd: h.dir, task: 'original', effort, thread });
  const accepted = await send('low', 'accepted');
  assert.equal(accepted.status, 'still_running');
  assert.equal(accepted.selected_effort, 'low');
  assert.equal(accepted.effective_effort, 'low');
  await h.complete(accepted.job_id);
  for (const [effort, thread, code, message] of [
    ['ultra', 'not-allowed', 'EFFORT_NOT_ALLOWED', /configured-model.*Use one of: low, medium, high, xhigh, max/],
    ['low', 'ignored', 'CAPABILITY_UNAVAILABLE', /did not apply effort "low"/],
  ]) {
    if (thread === 'ignored') h.env.CODEX_FAKE_IGNORE_EFFORT = '1';
    const refused = await send(effort, thread);
    assert.equal(refused.status, 'failed');
    assert.equal(refused.action, 'send');
    assert.equal(refused.meta.detail, code);
    assert.match(refused.content, message);
    assert.equal(refused.meta.selected_effort, effort);
    assert.equal(refused.meta.native_refs.historyId, undefined);
    const status = await h.call({ action: 'status', job_id: refused.job_id });
    assert.equal(status.detail, code);
    assert.equal(status.partial_text, refused.content);
    const waited = await h.call({ action: 'wait', job_id: refused.job_id, thread });
    assert.deepEqual(waited, { ...refused, action: 'wait' });
    assert.equal(new Records({ dir: h.records.dir }).readResult(refused.job_id).text, refused.content);
    if (code === 'EFFORT_NOT_ALLOWED') t.diagnostic('EFFORT_NOT_ALLOWED send result: ' + JSON.stringify(refused));
  }
  assert.equal(h.frames().filter((frame) => frame.method === 'turn/start').length, 1);
});
