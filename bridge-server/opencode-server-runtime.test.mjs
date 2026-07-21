import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveOpenCodeAdapter,
  openCodeServerActive,
  resolveOpenCodeServerModel,
  openCodeServerPromptId,
  createTurnAccumulator,
  ensureOpenCodeServer,
  createOpenCodeSession,
  startOpenCodeServerPrompt,
  abortOpenCodeSession,
  getOpenCodeSessionStatus,
  loadOpenCodeTranscript,
  openOpenCodeTurnWatcher,
  openCodeServerPoolSnapshot,
  reapIdleOpenCodeServer,
  syncOpenCodeServerLeases,
  openCodeServerIdleTtlMs,
  LEASE_STALE_MS,
  _setForTest,
  _resetForTest,
} from './opencode-server-runtime.mjs';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolveOpenCodeTimeoutMs } from './opencode-runtime.mjs';

let regDir;
beforeEach(() => {
  regDir = mkdtempSync(join(tmpdir(), 'oc-server-reg-'));
  process.env.AGENT_OPENCODE_SERVER_REGISTRY = join(regDir, 'servers.json');
  _resetForTest();
});
afterEach(() => {
  _resetForTest();
  delete process.env.AGENT_OPENCODE_SERVER_REGISTRY;
  rmSync(regDir, { recursive: true, force: true });
});

const SID = 'ses_abc';

// An async-iterable SSE source matching the real openEventStream contract
// (async function returning an async iterable of decoded text chunks).
function sseStream(frames) {
  return async () => (async function* () {
    for (const f of frames) yield f;
  })();
}
function frame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// --- adapter selection / model ---------------------------------------------

test('adapter resolves cli by default and server when configured', () => {
  assert.equal(resolveOpenCodeAdapter({}), 'cli');
  assert.equal(openCodeServerActive({}), false);
  assert.equal(resolveOpenCodeAdapter({ OPENCODE_RUNTIME_ADAPTER: 'server' }), 'server');
  assert.equal(openCodeServerActive({ OPENCODE_RUNTIME_ADAPTER: 'SERVER' }), true);
  assert.equal(resolveOpenCodeAdapter({ OPENCODE_RUNTIME_ADAPTER: 'nonsense' }), 'cli');
});

test('model splits provider/model and rejects malformed values', () => {
  assert.equal(resolveOpenCodeServerModel({}), null);
  assert.deepEqual(resolveOpenCodeServerModel({ AGENT_COMPANION_OPENCODE_MODEL: 'ollama-cloud/gpt-oss:120b' }), { providerID: 'ollama-cloud', modelID: 'gpt-oss:120b' });
  assert.equal(resolveOpenCodeServerModel({ AGENT_COMPANION_OPENCODE_MODEL: 'noslash' }), null);
  assert.equal(resolveOpenCodeServerModel({ AGENT_COMPANION_OPENCODE_MODEL: '/leading' }), null);
  assert.equal(resolveOpenCodeServerModel({ AGENT_COMPANION_OPENCODE_MODEL: 'trailing/' }), null);
});

test('promptId encodes reply generation', () => {
  assert.equal(openCodeServerPromptId('j1'), 'opencode-j1');
  assert.equal(openCodeServerPromptId('j1', 2), 'opencode-j1-r2');
});

// --- pure accumulator ------------------------------------------------------

function feed(acc, frames) {
  for (const f of frames) acc.push(f);
  acc.flush();
}

test('accumulator assembles assistant text and resolves completed on session.idle', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.updated', properties: { sessionID: SID, info: { role: 'assistant', id: 'msg1' } } }),
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'msg1', type: 'text', text: 'Hello ' } } }),
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p2', messageID: 'msg1', type: 'text', text: 'world' } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  assert.deepEqual(acc.terminal, { status: 'completed' });
  assert.equal(acc.snapshot().message, 'Hello world');
});

test('accumulator keeps tool-only turn non-empty via toolCalls', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 't1', messageID: 'msg1', type: 'tool', tool: 'bash', state: { input: { cmd: 'ls' } } } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  assert.equal(acc.terminal.status, 'completed');
  const snap = acc.snapshot();
  assert.equal(snap.message, '');
  assert.equal(snap.toolCalls.length, 1);
  assert.equal(snap.toolCalls[0].name, 'bash');
});

test('accumulator routes reasoning to thoughts, not message', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'r1', messageID: 'msg1', type: 'reasoning', text: 'thinking...' } } }),
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'msg1', type: 'text', text: 'answer' } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  const snap = acc.snapshot();
  assert.equal(snap.message, 'answer');
  assert.equal(snap.thoughts, 'thinking...');
});

test('accumulator maps abort to cancelled', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.updated', properties: { sessionID: SID, info: { role: 'assistant', id: 'msg1', error: { name: 'MessageAbortedError', message: 'aborted' } } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  assert.equal(acc.terminal.status, 'cancelled');
});

test('accumulator maps session.error to failed', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'session.error', properties: { sessionID: SID, error: { name: 'ProviderAuthError', message: 'no key' } } }),
  ]);
  assert.equal(acc.terminal.status, 'failed');
  assert.equal(acc.snapshot().error, 'no key');
});

test('accumulator ignores foreign sessions and global noise', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'server.heartbeat', properties: {} }),
    frame({ type: 'message.part.updated', properties: { sessionID: 'ses_other', part: { id: 'x', messageID: 'm', type: 'text', text: 'NOPE' } } }),
    frame({ type: 'session.idle', properties: { sessionID: 'ses_other' } }),
  ]);
  assert.equal(acc.terminal, null);
  assert.equal(acc.snapshot().message, '');
});

test('accumulator parses split frames across push boundaries', () => {
  const acc = createTurnAccumulator(SID);
  const f = frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'msg1', type: 'text', text: 'chunked' } } });
  acc.push(f.slice(0, 10));
  acc.push(f.slice(10));
  acc.push(frame({ type: 'session.idle', properties: { sessionID: SID } }));
  acc.flush();
  assert.equal(acc.terminal.status, 'completed');
  assert.equal(acc.snapshot().message, 'chunked');
});

// --- server pool -----------------------------------------------------------

function fakeChild(lines) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.unref = () => {};
  setImmediate(() => { for (const l of lines) child.stdout.emit('data', Buffer.from(l)); });
  return child;
}

test('ensureOpenCodeServer spawns once, parses boot URL, then reuses on healthy probe', async () => {
  let spawns = 0;
  _setForTest({
    spawnServer: () => { spawns++; return fakeChild(['Warning: unsecured\n', 'opencode server listening on http://127.0.0.1:4096\n']); },
    fetchJson: async (url) => url.includes('/global/health') ? { ok: true, data: { healthy: true } } : { ok: true, data: {} },
  });
  const a = await ensureOpenCodeServer();
  assert.equal(a.baseUrl, 'http://127.0.0.1:4096');
  assert.equal(spawns, 1);
  const b = await ensureOpenCodeServer();
  assert.equal(b.reused, true);
  assert.equal(spawns, 1); // healthy cache → no second spawn
  const snap = openCodeServerPoolSnapshot();
  assert.equal(snap.baseUrl, 'http://127.0.0.1:4096');
});

test('ensureOpenCodeServer rejects when the server exits before listening', async () => {
  _setForTest({
    spawnServer: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('close', 1));
      return child;
    },
  });
  await assert.rejects(() => ensureOpenCodeServer(), /exited before listening/);
});

// --- session ops (directory-scoped) ----------------------------------------

test('session ops thread the directory query param', async () => {
  const calls = [];
  _setForTest({
    fetchJson: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body });
      if (url.includes('/session/status')) return { ok: true, data: { [SID]: { type: 'busy' } } };
      if (url.endsWith('/session?directory=' + encodeURIComponent('/work'))) return { ok: true, data: { id: SID } };
      if (url.includes('/abort')) return { ok: true, data: true };
      return { ok: true, data: {} };
    },
  });
  const sid = await createOpenCodeSession({ baseUrl: 'http://h', directory: '/work', title: 't' });
  assert.equal(sid, SID);
  await startOpenCodeServerPrompt({ baseUrl: 'http://h', sessionId: SID, directory: '/work', prompt: 'hi', model: { providerID: 'p', modelID: 'm' } });
  const ab = await abortOpenCodeSession({ baseUrl: 'http://h', sessionId: SID, directory: '/work' });
  assert.equal(ab.aborted, true);
  const status = await getOpenCodeSessionStatus({ baseUrl: 'http://h', sessionId: SID, directory: '/work' });
  assert.equal(status, 'busy');
  assert.ok(calls.every((c) => c.url.includes('directory=')), 'every scoped call carries ?directory=');
  const prompt = calls.find((c) => c.url.includes('prompt_async'));
  assert.deepEqual(prompt.body.parts, [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(prompt.body.model, { providerID: 'p', modelID: 'm' });
});

test('session status reports idle when the session is absent from the map', async () => {
  _setForTest({ fetchJson: async () => ({ ok: true, data: {} }) });
  assert.equal(await getOpenCodeSessionStatus({ baseUrl: 'http://h', sessionId: SID }), 'idle');
});

test('loadOpenCodeTranscript extracts completed assistant text and tools', async () => {
  _setForTest({
    fetchJson: async () => ({ ok: true, data: [
      { info: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'q' }] },
      { info: { role: 'assistant', time: { created: 2, completed: 3 } }, parts: [
        { type: 'reasoning', text: 'hmm' },
        { type: 'tool', tool: 'edit', state: { input: { path: 'a' } } },
        { type: 'text', text: 'final answer' },
      ] },
    ] }),
  });
  const t = await loadOpenCodeTranscript({ baseUrl: 'http://h', sessionId: SID, directory: '/w' });
  assert.equal(t.completed, true);
  assert.equal(t.summary.message, 'final answer');
  assert.equal(t.summary.thoughts, 'hmm');
  assert.equal(t.summary.toolCalls.length, 1);
});

// --- watcher: edge / level / drop ------------------------------------------

test('watcher resolves completed from the SSE edge (session.idle)', async () => {
  _setForTest({
    openEventStream: sseStream([
      frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'm1', type: 'text', text: 'done' } } }),
      frame({ type: 'session.idle', properties: { sessionID: SID } }),
    ]),
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w' });
  const result = await watcher.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.message, 'done');
});

test('watcher level-check resolves terminal from transcript without waiting for SSE', async () => {
  // Stream yields nothing terminal; the level-check finds an already-completed turn.
  _setForTest({
    openEventStream: sseStream([]),
    fetchJson: async (url) => {
      if (url.includes('/session/status')) return { ok: true, data: {} }; // idle
      if (url.includes('/message')) return { ok: true, data: [
        { info: { role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{ type: 'text', text: 'already done' }] },
      ] };
      return { ok: true, data: {} };
    },
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w', initialLevelCheck: true });
  const result = await watcher.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.message, 'already done');
});

test('watcher stream-drop falls back to transcript when the session is idle', async () => {
  _setForTest({
    openEventStream: sseStream([
      frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'm1', type: 'text', text: 'partial' } } }),
      // stream ends WITHOUT session.idle
    ]),
    fetchJson: async (url) => {
      if (url.includes('/session/status')) return { ok: true, data: {} }; // idle
      if (url.includes('/message')) return { ok: true, data: [
        { info: { role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{ type: 'text', text: 'recovered' }] },
      ] };
      if (url.includes('/global/health')) return { ok: true, data: { healthy: true } };
      return { ok: true, data: {} };
    },
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w' });
  const result = await watcher.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.message, 'recovered');
});

test('watcher stream-drop maps a dead server to unreachable', async () => {
  _setForTest({
    openEventStream: sseStream([]),
    fetchJson: async (url) => {
      if (url.includes('/session/status')) return { ok: false, data: null };
      if (url.includes('/global/health')) return { ok: false, data: null };
      return { ok: false, data: null };
    },
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w' });
  const result = await watcher.done;
  assert.equal(result.status, 'unreachable');
});

test('watcher maps abort SSE to cancelled', async () => {
  _setForTest({
    openEventStream: sseStream([
      frame({ type: 'message.updated', properties: { sessionID: SID, info: { role: 'assistant', id: 'm1', error: { name: 'MessageAbortedError', message: 'stop' } } } }),
      frame({ type: 'session.idle', properties: { sessionID: SID } }),
    ]),
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w' });
  const result = await watcher.done;
  assert.equal(result.status, 'cancelled');
});

test('watcher honors timeout when no terminal arrives', async () => {
  _setForTest({
    // an open stream that never yields a terminal and never ends
    openEventStream: async () => (async function* () {
      await new Promise((r) => setTimeout(r, 1000));
    })(),
    fetchJson: async () => ({ ok: true, data: {} }),
  });
  const watcher = await openOpenCodeTurnWatcher({ baseUrl: 'http://h', sessionId: SID, directory: '/w', timeoutMs: 30 });
  const result = await watcher.done;
  assert.equal(result.status, 'timeout');
});

// --- shared-server idle reaper: machine-wide liveness ----------------------
//
// `opencode serve` is ONE process shared by every bridge on the machine, but a
// bridge is spawned per subagent. The reaper's old liveness check only looked
// at the calling process's own job map, so bridge B — idle, empty job map —
// would happily dispose the server out from under bridge A's running turn.
// Leases record liveness where the resource lives: on disk, next to the server.

const REG_KEY = 'shared';

function regPath() { return process.env.AGENT_OPENCODE_SERVER_REGISTRY; }
function seedRegistry(entry) { writeFileSync(regPath(), JSON.stringify({ [REG_KEY]: entry })); }
function readReg() { return JSON.parse(readFileSync(regPath(), 'utf8'))[REG_KEY]; }

// A pid that is definitely alive and definitely not us.
function foreignLivePid() { return process.ppid; }

// A pid that is definitely dead: spawn, wait for exit, reuse the number.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((r) => child.on('close', r));
  return pid;
}

function disposeTracker() {
  const calls = [];
  _setForTest({
    fetchJson: async (url, opts) => { calls.push(url); return { ok: true, status: 200, data: {} }; },
  });
  return calls;
}

test('idle reaper disposes an unused server with no leases', async () => {
  const calls = disposeTracker();
  seedRegistry({ baseUrl: 'http://127.0.0.1:5000', pid: 1234, lastUsedAt: Date.now() - 60 * 60_000 });
  const reaped = await reapIdleOpenCodeServer({ idleMs: 30 * 60_000 });
  assert.equal(reaped, true);
  assert.ok(calls.some((u) => u.endsWith('/global/dispose')));
});

test('idle reaper refuses to dispose a server another live bridge holds a lease on', async () => {
  const calls = disposeTracker();
  const other = foreignLivePid();
  seedRegistry({
    baseUrl: 'http://127.0.0.1:5000',
    pid: 1234,
    // Long past the idle TTL, and this process has no jobs of its own — exactly
    // the state in which the old reaper killed someone else's in-flight turn.
    lastUsedAt: Date.now() - 60 * 60_000,
    leases: { [`${other}:opencode-job-a`]: { pid: other, jobId: 'opencode-job-a', renewedAt: Date.now() } },
  });
  const reaped = await reapIdleOpenCodeServer({ idleMs: 30 * 60_000, hasLiveJobs: false });
  assert.equal(reaped, false);
  assert.deepEqual(calls, [], 'must not have called dispose');
  assert.ok(readReg().leases[`${other}:opencode-job-a`], 'a live lease must survive the prune');
});

test('idle reaper reclaims a lease whose owning bridge died', async () => {
  const calls = disposeTracker();
  const gone = await deadPid();
  seedRegistry({
    baseUrl: 'http://127.0.0.1:5000',
    pid: 1234,
    lastUsedAt: Date.now() - 60 * 60_000,
    leases: { [`${gone}:opencode-job-a`]: { pid: gone, jobId: 'opencode-job-a', renewedAt: Date.now() } },
  });
  const reaped = await reapIdleOpenCodeServer({ idleMs: 30 * 60_000 });
  assert.equal(reaped, true, 'a hard-killed bridge must not pin the server forever');
  assert.ok(calls.some((u) => u.endsWith('/global/dispose')));
});

test('idle reaper reclaims a lease that stopped being renewed', async () => {
  const calls = disposeTracker();
  const other = foreignLivePid();
  seedRegistry({
    baseUrl: 'http://127.0.0.1:5000',
    pid: 1234,
    lastUsedAt: Date.now() - 60 * 60_000,
    // Owner is alive but wedged — it has not renewed in well over the window.
    leases: { [`${other}:opencode-job-a`]: { pid: other, jobId: 'opencode-job-a', renewedAt: Date.now() - (LEASE_STALE_MS + 60_000) } },
  });
  const reaped = await reapIdleOpenCodeServer({ idleMs: 30 * 60_000 });
  assert.equal(reaped, true);
  assert.ok(calls.some((u) => u.endsWith('/global/dispose')));
});

test('a job outliving the idle TTL keeps the server alive via lease renewal', async () => {
  const calls = disposeTracker();
  // Server last touched at job start, 35min ago; TTL is 30min. Under the old
  // code this job — still running, well inside its 40min budget — would have
  // had its server disposed underneath it.
  seedRegistry({ baseUrl: 'http://127.0.0.1:5000', pid: 1234, lastUsedAt: Date.now() - 35 * 60_000 });
  syncOpenCodeServerLeases(['opencode-long-job']);
  const reaped = await reapIdleOpenCodeServer({ idleMs: 30 * 60_000, hasLiveJobs: false });
  assert.equal(reaped, false);
  assert.deepEqual(calls, []);
  // Renewal also refreshes lastUsedAt, so the server reads as in-use, not idle.
  assert.ok(Date.now() - readReg().lastUsedAt < 60_000);
});

test('lease sync drops our finished jobs but never another bridge\'s', () => {
  const other = foreignLivePid();
  const otherKey = `${other}:opencode-theirs`;
  seedRegistry({
    baseUrl: 'http://127.0.0.1:5000',
    pid: 1234,
    lastUsedAt: Date.now(),
    leases: { [otherKey]: { pid: other, jobId: 'opencode-theirs', renewedAt: Date.now() } },
  });

  syncOpenCodeServerLeases(['opencode-mine-1', 'opencode-mine-2']);
  let leases = readReg().leases;
  assert.ok(leases[`${process.pid}:opencode-mine-1`]);
  assert.ok(leases[`${process.pid}:opencode-mine-2`]);
  assert.ok(leases[otherKey], 'another bridge\'s lease must be left alone');

  // Job 1 went terminal; a full reconcile must retire exactly that lease.
  syncOpenCodeServerLeases(['opencode-mine-2']);
  leases = readReg().leases;
  assert.equal(leases[`${process.pid}:opencode-mine-1`], undefined);
  assert.ok(leases[`${process.pid}:opencode-mine-2`]);
  assert.ok(leases[otherKey]);

  // All our jobs done — only the other bridge's lease remains, so the server
  // stays protected for them but is free for us to stop counting.
  syncOpenCodeServerLeases([]);
  leases = readReg().leases;
  assert.deepEqual(Object.keys(leases), [otherKey]);
});

test('an idle bridge does not rewrite the registry on its heartbeat', () => {
  // Every bridge on the machine runs this on every GC tick and reads the same
  // file. An unconditional write would be pure contention for no content change.
  seedRegistry({ baseUrl: 'http://127.0.0.1:5000', pid: 1234, lastUsedAt: 42 });
  const before = readFileSync(regPath(), 'utf8');
  syncOpenCodeServerLeases([]);
  assert.equal(readFileSync(regPath(), 'utf8'), before, 'idle heartbeat must not touch the file');

  // ...but a bridge that HAS jobs must write, so its lease and the refreshed
  // lastUsedAt become visible to the other bridges.
  syncOpenCodeServerLeases(['opencode-j']);
  assert.notEqual(readFileSync(regPath(), 'utf8'), before);
});

test('registry writes are atomic so a concurrent reader never sees a partial file', () => {
  // readRegistry() treats unparseable JSON as "no server registered", and that
  // makes ensureOpenCodeServer spawn a SECOND `opencode serve` instead of
  // reattaching. A truncate-then-write would expose exactly that window.
  seedRegistry({ baseUrl: 'http://127.0.0.1:5000', pid: 1234, lastUsedAt: Date.now() });
  const dir = regDir;
  const before = new Set(readdirSync(dir));
  syncOpenCodeServerLeases(['opencode-j']);
  // The write must have gone through a temp file that no longer exists...
  assert.deepEqual(new Set(readdirSync(dir)), before, 'no temp file may be left behind');
  // ...and the visible file must always be complete, parseable JSON.
  assert.doesNotThrow(() => JSON.parse(readFileSync(regPath(), 'utf8')));
  assert.ok(readReg().leases[`${process.pid}:opencode-j`]);
});

test('lease sync is a no-op when no server is registered', () => {
  writeFileSync(regPath(), JSON.stringify({}));
  assert.deepEqual(syncOpenCodeServerLeases(['opencode-x']), { leases: {}, mine: 0 });
});

test('idle TTL is derived from the job timeout, never below it', () => {
  // The original bug: a 30min TTL under a 40min job budget.
  assert.ok(
    openCodeServerIdleTtlMs({}) > resolveOpenCodeTimeoutMs({}),
    'idle TTL must exceed the longest a single job may hold the server',
  );
  // Raising the job budget must raise the TTL with it.
  const long = { AGENT_COMPANION_OPENCODE_TIMEOUT_MS: String(3 * 60 * 60_000) };
  assert.ok(openCodeServerIdleTtlMs(long) > resolveOpenCodeTimeoutMs(long));
  // ...but a tiny job budget must not collapse the TTL to something silly.
  assert.equal(openCodeServerIdleTtlMs({ AGENT_COMPANION_OPENCODE_TIMEOUT_MS: '1000' }), 30 * 60_000);
});

// Reuses the fakeChild boot-line shape from the pool tests above.
function fakeServerChild(baseUrl) {
  return fakeChild([`opencode server listening on ${baseUrl}\n`]);
}

// --- disposal handshake ----------------------------------------------------
//
// A lease can only exist once a job exists, so leases alone cannot protect the
// window between "the reaper decided this server is idle" and "the dispose
// request lands". A bridge adopting the server in that window would have its
// turn killed. The reaper therefore publishes its intent before disposing, and
// an adopter refuses a server that is being disposed.

test('a server claimed for disposal is not adopted, even though it is healthy', async () => {
  let spawned = 0;
  _setForTest({
    fetchJson: async (url) => ({ ok: true, status: 200, data: { healthy: true } }),
    spawnServer: () => { spawned += 1; return fakeServerChild('http://127.0.0.1:6001'); },
  });
  seedRegistry({
    baseUrl: 'http://127.0.0.1:5000',
    pid: 1234,
    lastUsedAt: Date.now(),
    // Another bridge's reaper is mid-dispose right now.
    disposing: { pid: foreignLivePid(), at: Date.now() },
  });

  const got = await ensureOpenCodeServer({ env: {} });
  assert.notEqual(got.baseUrl, 'http://127.0.0.1:5000', 'must not adopt a server that is about to be disposed');
  assert.equal(got.reused, false);
  assert.equal(spawned, 1, 'it must spawn its own server instead');
});

test('an expired disposal claim does not block adoption forever', async () => {
  let spawned = 0;
  _setForTest({
    fetchJson: async () => ({ ok: true, status: 200, data: { healthy: true } }),
    spawnServer: () => { spawned += 1; return fakeServerChild('http://127.0.0.1:6002'); },
  });
  // A reaper that died mid-dispose must not make the server permanently
  // unadoptable, so claims age out.
  seedRegistry({
    baseUrl: 'http://127.0.0.1:5000',
    pid: 1234,
    lastUsedAt: Date.now(),
    disposing: { pid: foreignLivePid(), at: Date.now() - 10 * 60_000 },
  });

  const got = await ensureOpenCodeServer({ env: {} });
  assert.equal(got.baseUrl, 'http://127.0.0.1:5000');
  assert.equal(got.reused, true);
  assert.equal(spawned, 0);
});

test('two reapers do not both dispose the same server', async () => {
  const calls = disposeTracker();
  seedRegistry({
    baseUrl: 'http://127.0.0.1:5000',
    pid: 1234,
    lastUsedAt: Date.now() - 60 * 60_000,
    disposing: { pid: foreignLivePid(), at: Date.now() },
  });
  const reaped = await reapIdleOpenCodeServer({ idleMs: 30 * 60_000 });
  assert.equal(reaped, false, 'another reaper already owns this disposal');
  assert.deepEqual(calls, []);
});

test('the reaper publishes its disposal claim before sending dispose', async () => {
  let claimAtDisposeTime = null;
  _setForTest({
    fetchJson: async (url) => {
      if (url.endsWith('/global/dispose')) claimAtDisposeTime = readReg()?.disposing || null;
      return { ok: true, status: 200, data: {} };
    },
  });
  seedRegistry({ baseUrl: 'http://127.0.0.1:5000', pid: 1234, lastUsedAt: Date.now() - 60 * 60_000 });

  assert.equal(await reapIdleOpenCodeServer({ idleMs: 30 * 60_000 }), true);
  assert.ok(claimAtDisposeTime, 'the claim must be visible to other bridges BEFORE the dispose is sent');
  assert.equal(claimAtDisposeTime.pid, process.pid);
});

test('disposing an old server never erases a replacement registered meanwhile', async () => {
  // Another bridge saw the old server go away, spawned its own, and registered
  // it with a live lease — all while our dispose was in flight. Blind-deleting
  // the entry here would erase that bridge's server AND its lease.
  const other = foreignLivePid();
  _setForTest({
    fetchJson: async (url) => {
      if (url.endsWith('/global/dispose')) {
        writeFileSync(regPath(), JSON.stringify({
          shared: {
            baseUrl: 'http://127.0.0.1:7777',
            pid: 999,
            lastUsedAt: Date.now(),
            leases: { [`${other}:opencode-new`]: { pid: other, jobId: 'opencode-new', renewedAt: Date.now() } },
          },
        }));
      }
      return { ok: true, status: 200, data: {} };
    },
  });
  seedRegistry({ baseUrl: 'http://127.0.0.1:5000', pid: 1234, lastUsedAt: Date.now() - 60 * 60_000 });

  await reapIdleOpenCodeServer({ idleMs: 30 * 60_000 });
  const after = readReg();
  assert.ok(after, 'the replacement entry must survive');
  assert.equal(after.baseUrl, 'http://127.0.0.1:7777');
  assert.ok(after.leases[`${other}:opencode-new`], 'the replacement\'s lease must survive');
});
