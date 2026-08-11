// scripts/codex-app-server-broker.test.mjs
//
// Zero real codex: every test that needs an app-server drives a fake one via
// CODEX_BIN (the idiom in bridge-server/codex-runtime.test.mjs), and the routing
// tests drive the Broker directly with a stub connection and stub sockets. No
// test starts a turn, so no test spends a token.
//
// The load-bearing case is `notifications are filtered by threadId` — the
// prototype broadcast, which leaked every job's events into every bridge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer, connect as connectSocket } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Socket paths are truncated at SUN_LEN (~104 bytes). Keep every temp root
// short — the runtime dir plus `codex-app-server.sock` has to fit.
const RUNTIME_SANDBOX = mkdtempSync(join(tmpdir(), 'cxb-'));
process.env.AGENT_RUNTIME_DIR = RUNTIME_SANDBOX;
process.env.AGENT_HEARTBEAT_DIR = join(RUNTIME_SANDBOX, 'hb');
mkdirSync(process.env.AGENT_HEARTBEAT_DIR, { recursive: true });

const {
  AppServerConnection,
  BROKER_PROTOCOL_VERSION,
  Broker,
  BrokerServer,
  LineReader,
  SubscriptionTable,
  probeSocketAlive,
  probeSocketVerdictForError,
  _resetForTest,
  _setForTest,
} = await import('./codex-app-server-broker.mjs');

const BROKER_PATH = fileURLToPath(new URL('./codex-app-server-broker.mjs', import.meta.url));

test.after(() => {
  rmSync(RUNTIME_SANDBOX, { recursive: true, force: true });
  delete process.env.AGENT_RUNTIME_DIR;
  delete process.env.AGENT_HEARTBEAT_DIR;
});

test('module import does not require a codex binary on PATH', async () => {
  const { spawnSync } = await import('node:child_process');
  const moduleUrl = new URL('./codex-app-server-broker.mjs', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import ${JSON.stringify(moduleUrl)};`],
    { encoding: 'utf8', env: { ...process.env, PATH: '', CODEX_BIN: '' } },
  );
  assert.equal(result.status, 0,
    `importing the broker must not resolve or spawn codex\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

// --- fixtures ----------------------------------------------------------------

// A fake `codex app-server`. Answers the handful of methods the broker itself
// calls, and takes orders from the test through three `fake/*` methods that the
// broker forwards like any other unknown method:
//   fake/emit      write these raw frames to stdout (notifications, server→client requests)
//   fake/setLoaded set what `thread/loaded/list` reports
//   fake/die       exit, to exercise the app-server-death path
// Every inbound frame is appended to $CODEX_FAKE_TRACE so a test can assert
// exactly how many upstream `initialize` frames the broker ever sent.
const FAKE_APP_SERVER = `
import { appendFileSync } from 'node:fs';

const TRACE = process.env.CODEX_FAKE_TRACE || '';
const VERSION = process.env.CODEX_FAKE_VERSION || '0.147.0';
const INIT_DELAY_MS = Number(process.env.CODEX_FAKE_INIT_DELAY_MS || 0);

if (process.argv[2] === '--version') {
  // CODEX_FAKE_VERSION_FAIL reproduces the wrapper/timeout case: the probe
  // finishes, but no version is ever learned.
  if (process.env.CODEX_FAKE_VERSION_FAIL) {
    process.stderr.write('codex: not today\\n');
    process.exit(3);
  }
  process.stdout.write('codex-cli ' + VERSION + '\\n');
  process.exit(0);
}
if (process.argv[2] !== 'app-server') {
  process.stderr.write('fake codex: unsupported argv\\n');
  process.exit(2);
}

let loaded = [];
let threadSeq = 0;
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const trace = (obj) => { if (TRACE) { try { appendFileSync(TRACE, JSON.stringify(obj) + '\\n'); } catch {} } };

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function handle(msg) {
  trace(msg);
  if (typeof msg.method !== 'string') return; // a client answering a server request
  const reply = (result) => { if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, result }); };
  switch (msg.method) {
    case 'initialize':
      if (INIT_DELAY_MS > 0) setTimeout(() => reply({ userAgent: 'fake-app-server' }), INIT_DELAY_MS);
      else reply({ userAgent: 'fake-app-server' });
      return;
    case 'initialized': return;
    case 'fake/emit': {
      const frames = msg.params && msg.params.frames ? msg.params.frames : [];
      for (const frame of frames) out(frame);
      reply({ ok: true, emitted: frames.length });
      return;
    }
    case 'fake/setLoaded': loaded = (msg.params && msg.params.ids) || []; reply({ ok: true }); return;
    case 'fake/die': process.exit((msg.params && msg.params.code) || 7); return;
    case 'thread/loaded/list': reply({ data: loaded }); return;
    case 'thread/start': {
      const id = (msg.params && msg.params.threadId) || 'T' + (++threadSeq);
      loaded.push(id);
      reply({ thread: { id } });
      return;
    }
    case 'thread/resume': reply({ thread: { id: msg.params && msg.params.threadId } }); return;
    default: reply({ echo: msg.method }); return;
  }
}
`;

function fakeCodexBin(dir) {
  const bin = join(dir, 'codex-fake.mjs');
  writeFileSync(bin, `#!/usr/bin/env node\n${FAKE_APP_SERVER}`, { mode: 0o700 });
  chmodSync(bin, 0o700);
  return bin;
}

// Stand-in for a client socket: collects the frames the broker writes, and
// `feed()` plays a client frame back in.
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.frames = [];
    this.ended = false;
  }
  setEncoding() {}
  write(text) {
    for (const line of String(text).split('\n')) {
      if (line.trim()) this.frames.push(JSON.parse(line));
    }
    return true;
  }
  end() { this.ended = true; }
  feed(obj) { this.emit('data', `${JSON.stringify(obj)}\n`); }
  close() { this.emit('close'); }
  methods() { return this.frames.map((f) => f.method).filter(Boolean); }
}

function fakeConnection({ initialized = true, loadedThreads = [] } = {}) {
  return {
    pid: 4242,
    initialized,
    dead: false,
    codexVersion: '0.147.0',
    versionProbed: true,
    killed: false,
    sent: [],
    _nextId: 1,
    nextId() { return this._nextId++; },
    isAlive() { return true; },
    send(msg) { this.sent.push(msg); return true; },
    async request(method) {
      if (method === 'thread/loaded/list') return { data: loadedThreads };
      throw new Error(`unstubbed request ${method}`);
    },
    kill() { this.killed = true; },
  };
}

function makeBroker(opts) {
  const connection = fakeConnection(opts);
  const broker = new Broker({ connection });
  return { broker, connection };
}

function attach(broker) {
  const sock = new FakeSocket();
  broker.attachClient(sock);
  return sock;
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

// --- LineReader --------------------------------------------------------------

test('LineReader reassembles frames across chunk boundaries and discards over-cap lines', () => {
  const reader = new LineReader();
  assert.deepEqual(reader.push('{"a":1}\n{"b":').lines, ['{"a":1}']);
  assert.deepEqual(reader.push('2}\n').lines, ['{"b":2}']);
  // Blank lines are not frames.
  assert.deepEqual(reader.push('\n\n').lines, []);

  const capped = new LineReader({ maxLineBytes: 16 });
  assert.deepEqual(capped.push('x'.repeat(40)).lines, []);
  // The tail of the over-cap line is discarded up to the next newline; the
  // frame after it survives, so a single bad peer frame does not desync.
  const after = capped.push(`${'x'.repeat(40)}\n{"ok":1}\n`);
  assert.equal(after.dropped, 1);
  assert.deepEqual(after.lines, ['{"ok":1}']);

  // The case that escapes a cap applied only to the residual buffer: an
  // over-cap line that arrives COMPLETE inside one chunk, newline and all.
  const whole = new LineReader({ maxLineBytes: 16 });
  const single = whole.push(`${'x'.repeat(40)}\n{"ok":1}\n`);
  assert.equal(single.dropped, 1, 'a complete over-cap line must be dropped, not delivered');
  assert.deepEqual(single.lines, ['{"ok":1}']);
});

// --- SubscriptionTable -------------------------------------------------------

test('SubscriptionTable keeps the earliest still-connected subscriber as primary', () => {
  const table = new SubscriptionTable();
  table.subscribe('T1', 1);
  table.subscribe('T1', 2);
  assert.equal(table.primary('T1'), 1);
  assert.deepEqual(table.subscribers('T1'), [1, 2]);

  table.dropClient(1);
  assert.equal(table.primary('T1'), 2);

  assert.deepEqual(table.dropClient(2), ['T1']);
  assert.equal(table.primary('T1'), null);
  assert.equal(table.threadCount(), 0);
});

test('the pre-subscription ring is bounded by depth, by age, and drains exactly once', () => {
  const table = new SubscriptionTable({ ringCap: 3, ttlMs: 1_000, maxThreads: 2 });
  const clock = { t: 1_000 };
  _setForTest({ now: () => clock.t });
  try {
    for (const n of [1, 2, 3, 4, 5]) table.buffer('T1', { n });
    assert.equal(table.bufferedCount('T1'), 3);
    // Oldest dropped first.
    assert.deepEqual(table.drain('T1'), [{ n: 3 }, { n: 4 }, { n: 5 }]);
    // Drain clears: a second subscriber gets the live stream, never a replay.
    assert.deepEqual(table.drain('T1'), []);

    table.buffer('T2', { n: 'old' });
    clock.t += 5_000;
    table.buffer('T2', { n: 'new' });
    assert.deepEqual(table.drain('T2'), [{ n: 'new' }]);

    // Distinct-thread cap: the oldest ring is evicted rather than growing.
    table.buffer('A', {});
    table.buffer('B', {});
    table.buffer('C', {});
    assert.equal(table.bufferedCount('A'), 0);
    assert.equal(table.bufferedCount('C'), 1);
  } finally {
    _resetForTest();
  }
});

// --- handshake ---------------------------------------------------------------

test('initialize is answered locally for every client and never forwarded upstream', () => {
  const { broker, connection } = makeBroker();
  const a = attach(broker);
  const b = attach(broker);

  a.feed(rpc(1, 'initialize', { clientInfo: { name: 'bridge-a' } }));
  b.feed(rpc(1, 'initialize', { clientInfo: { name: 'bridge-b' } }));

  for (const sock of [a, b]) {
    assert.equal(sock.frames.length, 1);
    assert.deepEqual(sock.frames[0].result, {
      brokered: true,
      protocol: BROKER_PROTOCOL_VERSION,
      brokerPid: process.pid,
      appServerPid: 4242,
      appServerInitialized: true,
      codexVersion: '0.147.0',
      codexVersionProbed: true,
    });
  }
  // Not one initialize reached the app-server: the broker did that once, at boot.
  assert.deepEqual(connection.sent, []);

  // `initialized` is swallowed, not forwarded.
  a.feed({ jsonrpc: '2.0', method: 'initialized', params: {} });
  assert.deepEqual(connection.sent, []);
});

test('broker/status reports the liveness fields the client probes on', () => {
  const { broker } = makeBroker();
  const a = attach(broker);
  a.feed(rpc(9, 'broker/subscribe', { threadId: 'T1' }));
  a.feed(rpc(10, 'broker/status'));
  const status = a.frames.at(-1).result;
  assert.equal(status.ok, true);
  assert.equal(status.protocol, BROKER_PROTOCOL_VERSION);
  assert.equal(status.brokerPid, process.pid);
  assert.equal(status.appServerPid, 4242);
  assert.equal(status.clients, 1);
  assert.equal(status.subscriptions, 1);
  assert.equal(typeof status.uptimeMs, 'number');
});

// --- id remapping ------------------------------------------------------------

test('two clients using the same downstream ids get their own responses, never crossed', () => {
  const { broker, connection } = makeBroker();
  const a = attach(broker);
  const b = attach(broker);

  a.feed(rpc(1, 'thread/read', { threadId: 'TA' }));
  b.feed(rpc(1, 'thread/read', { threadId: 'TB' }));

  assert.equal(connection.sent.length, 2);
  const [upA, upB] = connection.sent.map((f) => f.id);
  assert.notEqual(upA, upB);

  // Answer B first — routing is by the remapped id, not by arrival order.
  broker._onUpstreamMessage({ jsonrpc: '2.0', id: upB, result: { who: 'B' } });
  assert.deepEqual(b.frames, [{ jsonrpc: '2.0', id: 1, result: { who: 'B' } }]);
  assert.deepEqual(a.frames, []);

  broker._onUpstreamMessage({ jsonrpc: '2.0', id: upA, result: { who: 'A' } });
  assert.deepEqual(a.frames, [{ jsonrpc: '2.0', id: 1, result: { who: 'A' } }]);
  assert.equal(b.frames.length, 1);
});

test('client requests sent before the upstream handshake are queued, then flushed in order', () => {
  const { broker, connection } = makeBroker({ initialized: false });
  const a = attach(broker);

  a.feed(rpc(1, 'thread/start', { cwd: '/tmp' }));
  a.feed({ jsonrpc: '2.0', method: 'thread/unsubscribe', params: {} });
  assert.deepEqual(connection.sent, []);

  connection.initialized = true;
  broker.flushPreInit();
  assert.deepEqual(connection.sent.map((f) => f.method), ['thread/start', 'thread/unsubscribe']);
});

test('a frame with an explicit null id is a notification, not a request that can never be answered', () => {
  const { broker, connection } = makeBroker();
  const a = attach(broker);
  a.feed({ jsonrpc: '2.0', id: null, method: 'thread/unsubscribe', params: { threadId: 'T1' } });
  assert.deepEqual(connection.sent, [{ jsonrpc: '2.0', method: 'thread/unsubscribe', params: { threadId: 'T1' } }]);
  assert.equal(broker.pending.size, 0);
  assert.deepEqual(a.frames, []);
});

// --- notification routing ----------------------------------------------------

test('a thread notification reaches that thread subscriber only — the leak the prototype had', () => {
  const { broker } = makeBroker();
  const a = attach(broker);
  const b = attach(broker);

  a.feed(rpc(1, 'broker/subscribe', { threadId: 'T1' }));
  b.feed(rpc(1, 'broker/subscribe', { threadId: 'T2' }));
  assert.deepEqual(a.frames.at(-1).result, { ok: true, threadId: 'T1', flushed: 0 });

  const delta = { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'T1', delta: 'hi' } };
  broker._onUpstreamMessage(delta);

  assert.deepEqual(a.frames.at(-1), delta);
  assert.deepEqual(b.methods(), []);

  // `thread/started` is the one notification that nests the id under
  // params.thread.id; the contract resolves it without a special case here.
  const started = { jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'T2' } } };
  broker._onUpstreamMessage(started);
  assert.deepEqual(b.frames.at(-1), started);
  assert.deepEqual(a.frames.at(-1), delta);

  // Unsubscribing stops delivery.
  a.feed(rpc(2, 'broker/unsubscribe', { threadId: 'T1' }));
  broker._onUpstreamMessage(delta);
  assert.equal(a.frames.at(-1).result.ok, true);
});

test('global notifications reach every client; drift and legally-absent ids fall back to global', () => {
  const { broker } = makeBroker();
  const a = attach(broker);
  const b = attach(broker);
  a.feed(rpc(1, 'broker/subscribe', { threadId: 'T1' }));

  const rate = { jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { rate: 1 } };
  broker._onUpstreamMessage(rate);
  assert.deepEqual(a.frames.at(-1), rate);
  assert.deepEqual(b.frames.at(-1), rate);

  // `warning` is one of the three notifications whose threadId the schema
  // declares optional — no id means it belongs to no thread, so it fans out.
  const warning = { jsonrpc: '2.0', method: 'warning', params: { message: 'x' } };
  broker._onUpstreamMessage(warning);
  assert.deepEqual(a.frames.at(-1), warning);
  assert.deepEqual(b.frames.at(-1), warning);

  // A method the pinned contract has never seen is drift: fan out rather than
  // guess a thread, because guessing wrong misroutes one job into another.
  const drifted = { jsonrpc: '2.0', method: 'brand/new/notification', params: { threadId: 'T1' } };
  broker._onUpstreamMessage(drifted);
  assert.deepEqual(a.frames.at(-1), drifted);
  assert.deepEqual(b.frames.at(-1), drifted);
});

test('a notification for an unsubscribed thread is buffered and flushed on subscribe', () => {
  const { broker } = makeBroker();
  const a = attach(broker);

  const early = { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'T1', delta: 'early' } };
  broker._onUpstreamMessage(early);
  assert.deepEqual(a.methods(), []);

  a.feed(rpc(1, 'broker/subscribe', { threadId: 'T1' }));
  // Flushed BEFORE the ack, so the client never mistakes replayed events for
  // events that arrived after it subscribed.
  assert.deepEqual(a.frames[0], early);
  assert.deepEqual(a.frames[1].result, { ok: true, threadId: 'T1', flushed: 1 });

  // A second subscriber gets the live stream, not a replay.
  const b = attach(broker);
  b.feed(rpc(1, 'broker/subscribe', { threadId: 'T1' }));
  assert.deepEqual(b.frames[0].result, { ok: true, threadId: 'T1', flushed: 0 });
});

test('a successful thread/start response subscribes the asking client with no subscribe call', () => {
  const { broker, connection } = makeBroker();
  const a = attach(broker);
  const b = attach(broker);

  a.feed(rpc(7, 'thread/start', { cwd: '/tmp' }));
  const upstreamId = connection.sent.at(-1).id;

  // The event race the buffer exists for: T1's first delta beats the
  // thread/start response that would have subscribed the client.
  const early = { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'T1', delta: 'first' } };
  broker._onUpstreamMessage(early);
  assert.deepEqual(a.methods(), []);

  broker._onUpstreamMessage({ jsonrpc: '2.0', id: upstreamId, result: { thread: { id: 'T1' } } });
  // Response first (it is what tells the client the thread id), buffer second.
  assert.deepEqual(a.frames[0], { jsonrpc: '2.0', id: 7, result: { thread: { id: 'T1' } } });
  assert.deepEqual(a.frames[1], early);

  const later = { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'T1', delta: 'later' } };
  broker._onUpstreamMessage(later);
  assert.deepEqual(a.frames.at(-1), later);
  assert.deepEqual(b.methods(), []);
});

test('a failed thread/start response subscribes nobody', () => {
  const { broker, connection } = makeBroker();
  const a = attach(broker);
  a.feed(rpc(1, 'thread/start', { cwd: '/nope' }));
  broker._onUpstreamMessage({
    jsonrpc: '2.0',
    id: connection.sent.at(-1).id,
    error: { code: -32600, message: 'cwd does not exist' },
  });
  assert.equal(broker.subscriptions.threadCount(), 0);
});

// --- server → client requests ------------------------------------------------

test('a server request goes to exactly one client, and only that client may answer it', () => {
  const { broker, connection } = makeBroker();
  const a = attach(broker);
  const b = attach(broker);
  a.feed(rpc(1, 'broker/subscribe', { threadId: 'T1' }));
  b.feed(rpc(1, 'broker/subscribe', { threadId: 'T1' }));

  const approval = {
    jsonrpc: '2.0',
    id: 77,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'T1', command: 'rm -rf /' },
  };
  broker._onUpstreamMessage(approval);

  // Primary only — two clients answering the same approval is the hazard.
  assert.deepEqual(a.frames.at(-1), approval);
  assert.deepEqual(b.methods(), []);

  // The non-owner's answer is dropped rather than forwarded.
  b.feed({ jsonrpc: '2.0', id: 77, result: { decision: 'accept' } });
  assert.deepEqual(connection.sent, []);

  a.feed({ jsonrpc: '2.0', id: 77, result: { decision: 'decline' } });
  assert.deepEqual(connection.sent, [{ jsonrpc: '2.0', id: 77, result: { decision: 'decline' } }]);

  // Answered once; a replay is no longer routable.
  a.feed({ jsonrpc: '2.0', id: 77, result: { decision: 'accept' } });
  assert.equal(connection.sent.length, 1);
});

test('the legacy conversationId approval requests still resolve to their thread', () => {
  const { broker } = makeBroker();
  const a = attach(broker);
  a.feed(rpc(1, 'broker/subscribe', { threadId: 'T9' }));
  const legacy = { jsonrpc: '2.0', id: 5, method: 'execCommandApproval', params: { conversationId: 'T9', command: 'ls' } };
  broker._onUpstreamMessage(legacy);
  assert.deepEqual(a.frames.at(-1), legacy);
});

test('an unroutable server request is answered -32601 by the broker, never left hanging', () => {
  const { broker, connection } = makeBroker();
  attach(broker);

  // No subscriber for the thread.
  broker._onUpstreamMessage({ jsonrpc: '2.0', id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'T404' } });
  // Carries no thread at all.
  broker._onUpstreamMessage({ jsonrpc: '2.0', id: 2, method: 'attestation/generate', params: {} });
  // Contract drift.
  broker._onUpstreamMessage({ jsonrpc: '2.0', id: 3, method: 'brand/new/request', params: {} });

  assert.deepEqual(connection.sent.map((f) => [f.id, f.error.code]), [[1, -32601], [2, -32601], [3, -32601]]);
});

// --- disconnect --------------------------------------------------------------

test('dropping a client drops its subscriptions and pending ids and disturbs nobody else', () => {
  const { broker, connection } = makeBroker();
  const a = attach(broker);
  const b = attach(broker);
  a.feed(rpc(1, 'broker/subscribe', { threadId: 'T1' }));
  b.feed(rpc(1, 'broker/subscribe', { threadId: 'T2' }));
  a.feed(rpc(2, 'thread/read', { threadId: 'T1' }));
  const pendingId = connection.sent.at(-1).id;

  const approval = { jsonrpc: '2.0', id: 88, method: 'item/commandExecution/requestApproval', params: { threadId: 'T1' } };
  broker._onUpstreamMessage(approval);
  connection.sent.length = 0;

  a.close();

  assert.equal(broker.clients.size, 1);
  assert.deepEqual(broker.subscriptions.subscribers('T1'), []);
  assert.equal(broker.pending.has(pendingId), false);
  // The app-server was waiting on an approval the departed client owed it.
  assert.deepEqual(connection.sent.map((f) => [f.id, f.error.code]), [[88, -32601]]);
  // The child is untouched — a bridge going away is not a reason to stop work.
  assert.equal(connection.killed, false);

  // B still works.
  const delta = { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'T2', delta: 'ok' } };
  broker._onUpstreamMessage(delta);
  assert.deepEqual(b.frames.at(-1), delta);

  // A late response for the departed client is dropped, not misrouted.
  const before = b.frames.length;
  broker._onUpstreamMessage({ jsonrpc: '2.0', id: pendingId, result: { late: true } });
  assert.equal(b.frames.length, before);
});

// --- app-server death --------------------------------------------------------

test('app-server death notifies every client and exits non-zero', async () => {
  const exits = [];
  _setForTest({ exit: (code) => exits.push(code) });
  try {
    const { broker, connection } = makeBroker();
    const a = attach(broker);
    const b = attach(broker);
    connection.onExit(7, null);
    for (const sock of [a, b]) {
      assert.equal(sock.frames.at(-1).method, 'broker/appServerDied');
      assert.deepEqual(sock.frames.at(-1).params, { code: 7, signal: null });
    }
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(exits, [1]);
  } finally {
    _resetForTest();
  }
});

// --- idle reaper -------------------------------------------------------------

function heartbeatFile(name) {
  return join(process.env.AGENT_HEARTBEAT_DIR, name);
}

test('the reaper refuses to exit while a client, a loaded thread, or a live host remains', async () => {
  const exits = [];
  _setForTest({ exit: (code) => exits.push(code) });
  try {
    // A client is connected.
    {
      const { broker } = makeBroker();
      attach(broker);
      assert.equal(await broker._onInactivityTick(), false);
      broker.shutdown();
    }
    // A thread is still loaded — the case that would destroy a live turn.
    {
      const { broker } = makeBroker({ loadedThreads: ['T1'] });
      assert.equal(await broker._onInactivityTick(), false);
      broker.shutdown();
    }
    // A host session is still beating.
    {
      writeFileSync(heartbeatFile('sid-live.heartbeat'), '');
      const { broker } = makeBroker();
      assert.equal(await broker._onInactivityTick(), false);
      broker.shutdown();
      rmSync(heartbeatFile('sid-live.heartbeat'));
    }
    // thread/loaded/list did not answer: unknown is not idle.
    {
      const connection = fakeConnection();
      connection.request = async () => { throw new Error('timeout'); };
      const broker = new Broker({ connection });
      assert.equal(await broker._onInactivityTick(), false);
      broker.shutdown();
    }
    assert.deepEqual(exits, []);

    // All three clear.
    const { broker, connection } = makeBroker();
    assert.equal(await broker._onInactivityTick(), true);
    assert.deepEqual(exits, [0]);
    assert.equal(connection.killed, true);
  } finally {
    _resetForTest();
  }
});

test('the reaper re-reads the cheap gates after the loaded-thread RPC, not before it', async () => {
  const exits = [];
  _setForTest({ exit: (code) => exits.push(code) });
  try {
    // `thread/loaded/list` is allowed 10 s. Hold it open and let a bridge
    // connect inside that window — it connect-probed a LIVE socket, so no
    // replacement broker was spawned, and exiting on the pre-await snapshot
    // would kill the app-server under the turn it is about to start.
    const connection = fakeConnection();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    connection.request = async (method) => {
      assert.equal(method, 'thread/loaded/list');
      await held;
      return { data: [] };
    };
    const broker = new Broker({ connection });
    const tick = broker._onInactivityTick();
    const late = attach(broker);
    release();

    assert.equal(await tick, false, 'a client that arrived during the RPC must veto the exit');
    assert.deepEqual(exits, []);
    assert.equal(connection.killed, false, 'the app-server must survive');
    assert.equal(late.ended, false, 'the newly-connected client must not be hung up on');
    broker.shutdown();

    // Same window, same staleness, via the heartbeat gate.
    const other = fakeConnection();
    let releaseHb;
    const heldHb = new Promise((resolve) => { releaseHb = resolve; });
    other.request = async () => { await heldHb; return { data: [] }; };
    const hbBroker = new Broker({ connection: other });
    const hbTick = hbBroker._onInactivityTick();
    writeFileSync(heartbeatFile('sid-late.heartbeat'), '');
    releaseHb();
    assert.equal(await hbTick, false, 'a host that checked in during the RPC must veto the exit too');
    assert.deepEqual(exits, []);
    hbBroker.shutdown();
    rmSync(heartbeatFile('sid-late.heartbeat'));
  } finally {
    _resetForTest();
  }
});

// --- socket hardening --------------------------------------------------------

function shortSocketDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cxs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a socket file whose owner is gone is unlinked and rebound', async (t) => {
  const dir = shortSocketDir(t);
  const socketPath = join(dir, 'b.sock');

  // SIGKILL skips the unlink handler, which is exactly how a stale socket file
  // outlives its broker. Reproduce it rather than faking it with a plain file.
  const holder = spawn(process.execPath, [
    '-e',
    `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  assert.equal(existsSync(socketPath), true, 'the stale socket file should survive SIGKILL');
  assert.equal(await probeSocketAlive(socketPath), false);

  const { broker } = makeBroker();
  const server = new BrokerServer(broker, { socketPath });
  await server.start();
  t.after(() => { server.cleanup(); broker.shutdown(); });
  assert.equal(await probeSocketAlive(socketPath), true);
});

test('a socket with a live broker makes the second broker refuse rather than steal it', async (t) => {
  const dir = shortSocketDir(t);
  const socketPath = join(dir, 'b.sock');

  const incumbent = createServer(() => {});
  await new Promise((resolve) => incumbent.listen(socketPath, resolve));
  t.after(() => { try { incumbent.close(); } catch {} });

  const { broker } = makeBroker();
  const server = new BrokerServer(broker, { socketPath });
  await assert.rejects(() => server.start(), (err) => err.code === 'BROKER_ALREADY_RUNNING');
  broker.shutdown();

  // And it must not have taken the incumbent's socket down on its way out —
  // cleanup only ever unlinks a socket this server actually bound.
  server.cleanup();
  assert.equal(existsSync(socketPath), true);
  assert.equal(await probeSocketAlive(socketPath), true);
});

test('a symlinked socket path is refused outright, dangling or not', async (t) => {
  const dir = shortSocketDir(t);
  const { symlinkSync } = await import('node:fs');

  const socketPath = join(dir, 'link.sock');
  const target = join(dir, 'real');
  writeFileSync(target, '');
  symlinkSync(target, socketPath);

  const { broker } = makeBroker();
  const server = new BrokerServer(broker, { socketPath });
  await assert.rejects(() => server.start(), (err) => err.code === 'BROKER_SOCKET_SYMLINK');
  broker.shutdown();

  // The case a guard behind existsSync() cannot see: existsSync FOLLOWS the
  // link, so a dangling one reports false and skips the check entirely — and
  // listen() then creates the real socket at the link's target, outside the
  // 0700 runtime dir, where cleanup unlinks the link and orphans the socket.
  const danglingPath = join(dir, 'dangle.sock');
  const missing = join(dir, 'nowhere.sock');
  symlinkSync(missing, danglingPath);
  assert.equal(existsSync(danglingPath), false, 'existsSync must not see a dangling link (that is the trap)');

  const { broker: broker2 } = makeBroker();
  const server2 = new BrokerServer(broker2, { socketPath: danglingPath });
  await assert.rejects(() => server2.start(), (err) => err.code === 'BROKER_SOCKET_SYMLINK');
  assert.equal(existsSync(missing), false, 'no socket may be created at the link target');
  broker2.shutdown();
});

test('two brokers racing one stale socket: exactly one binds, and the loser refuses', async (t) => {
  const dir = shortSocketDir(t);
  const socketPath = join(dir, 'b.sock');

  const holder = spawn(process.execPath, [
    '-e',
    `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));

  // Both probe the stale file, both see ECONNREFUSED. Without the start lock
  // both unlink and both bind, and the first one to exit deletes the other's
  // socket — two app-servers, and then no reachable broker at all.
  const { broker: brokerA } = makeBroker();
  const { broker: brokerB } = makeBroker();
  const servers = [new BrokerServer(brokerA, { socketPath }), new BrokerServer(brokerB, { socketPath })];
  const results = await Promise.allSettled(servers.map((s) => s.start()));
  t.after(() => { for (const s of servers) s.cleanup(); brokerA.shutdown(); brokerB.shutdown(); });

  assert.equal(servers.filter((s) => s.bound).length, 1, 'exactly one broker may own the socket');
  const rejected = results.find((r) => r.status === 'rejected');
  assert.equal(rejected?.reason?.code, 'BROKER_START_CONTENDED');
  assert.equal(await probeSocketAlive(socketPath), true);
  assert.equal(existsSync(`${socketPath}.lock`), false, 'the start lock is released, win or lose');

  // The loser going away must not take the winner's socket with it.
  const loser = servers.find((s) => !s.bound);
  loser.cleanup();
  assert.equal(await probeSocketAlive(socketPath), true, 'the winner must still be reachable');
});

test('a stale start lock left by a dead holder is broken rather than obeyed forever', async (t) => {
  const dir = shortSocketDir(t);
  const socketPath = join(dir, 'b.sock');
  const lockPath = `${socketPath}.lock`;

  // A broker SIGKILLed inside probe→unlink→listen leaves this behind. Lock
  // presence is no more proof of liveness than socket presence is.
  const dead = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  dead.kill('SIGKILL');
  await new Promise((resolve) => dead.once('exit', resolve));
  writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, at: Date.now() }));

  const { broker } = makeBroker();
  const server = new BrokerServer(broker, { socketPath });
  await server.start();
  t.after(() => { server.cleanup(); broker.shutdown(); });
  assert.equal(await probeSocketAlive(socketPath), true);
  assert.equal(existsSync(lockPath), false);
});

test('the exit-handler unlink only ever removes the socket THIS server bound', async (t) => {
  const dir = shortSocketDir(t);
  const socketPath = join(dir, 'b.sock');

  const { broker } = makeBroker();
  const server = new BrokerServer(broker, { socketPath });
  await server.start();
  // Both listeners have to be released even if an assertion below throws, or
  // the runner never exits. Closing either one unlinks the path (libuv does it
  // on close), which is why this runs after the assertions, not before them.
  t.after(() => { try { server.server?.close(); } catch {} broker.shutdown(); });

  // Whatever put it there, the file at the path is now somebody else's socket.
  // `bound` is only "I bound A socket here once" — the inode is what says mine.
  rmSync(socketPath);
  const incumbent = createServer(() => {});
  await new Promise((resolve) => incumbent.listen(socketPath, resolve));
  t.after(() => { try { incumbent.close(); } catch {} });

  server.unlinkOwnedSocket();
  assert.equal(existsSync(socketPath), true, 'a socket we did not bind must survive our exit handler');
  assert.equal(await probeSocketAlive(socketPath), true);
});

test('an indeterminate connect probe is not evidence that nobody is home', () => {
  // ECONNREFUSED/ENOENT/ENOTSOCK really do mean the path is free. EMFILE under
  // a wide subagent fan-out, EACCES, EAGAIN mean the probe failed — treating
  // those as "absent" unlinks a LIVE broker's socket with no concurrency at all.
  for (const code of ['ECONNREFUSED', 'ENOENT', 'ENOTSOCK']) {
    assert.equal(probeSocketVerdictForError({ code }), 'absent', code);
  }
  for (const code of ['EMFILE', 'EACCES', 'EAGAIN', 'ENFILE']) {
    assert.equal(probeSocketVerdictForError({ code }), code, code);
  }
  assert.equal(probeSocketVerdictForError(undefined), 'EUNKNOWN');
});

test('an indeterminate probe makes start() refuse rather than unlink a live socket', async (t) => {
  const dir = shortSocketDir(t);
  const socketPath = join(dir, 'b.sock');
  const incumbent = createServer(() => {});
  await new Promise((resolve) => incumbent.listen(socketPath, resolve));
  t.after(() => { try { incumbent.close(); } catch {} });

  // A long session with many subagents pushes the process past its fd limit,
  // so the connect probe fails EMFILE instead of ECONNREFUSED. Reading that as
  // "nobody is home" unlinks a live broker's socket — split brain with no
  // concurrency involved at all.
  _setForTest({ probeSocket: async () => 'EMFILE' });
  try {
    const { broker } = makeBroker();
    const server = new BrokerServer(broker, { socketPath });
    await assert.rejects(() => server.start(), (err) => err.code === 'BROKER_SOCKET_INDETERMINATE');
    assert.equal(server.bound, false);
    broker.shutdown();
  } finally {
    _resetForTest();
  }
  assert.equal(existsSync(socketPath), true, 'a live socket must survive a probe that could not tell');
  assert.equal(await probeSocketAlive(socketPath), true);
});

test('a plain file left at the socket path is still safe to unlink and rebind', async (t) => {
  const dir = shortSocketDir(t);
  const socketPath = join(dir, 'b.sock');
  writeFileSync(socketPath, 'not a socket');

  const { broker } = makeBroker();
  const server = new BrokerServer(broker, { socketPath });
  await server.start();
  t.after(() => { server.cleanup(); broker.shutdown(); });
  assert.equal(await probeSocketAlive(socketPath), true);
});

// --- end to end over a real socket, against the fake app-server --------------

class TestClient {
  constructor(socketPath) {
    this.sock = connectSocket(socketPath);
    this.sock.setEncoding('utf8');
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.nextId = 1;
    let buf = '';
    this.sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && typeof msg.method === 'string') { this.serverRequests.push(msg); continue; }
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (p) (msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result));
          continue;
        }
        this.notifications.push(msg);
      }
    });
    this.ready = new Promise((resolve, reject) => {
      this.sock.once('connect', resolve);
      this.sock.once('error', reject);
    });
  }
  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  answer(id, result) { this.sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
  close() { try { this.sock.destroy(); } catch {} }
}

async function waitFor(predicate, { timeoutMs = 20_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function startRealBroker(t, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cxr-'));
  const socketPath = join(dir, 'b.sock');
  const tracePath = join(dir, 'trace.jsonl');
  const child = spawn(process.execPath, [BROKER_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGENT_RUNTIME_DIR: dir,
      CODEX_BROKER_SOCKET_PATH: socketPath,
      CODEX_BROKER_LOG_LEVEL: 'DEBUG',
      CODEX_BIN: fakeCodexBin(dir),
      CODEX_FAKE_TRACE: tracePath,
      ...extraEnv,
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => existsSync(socketPath) || (child.exitCode !== null ? Promise.reject(new Error(`broker exited: ${stderr}`)) : false), { label: 'the broker socket' });
  const upstream = () => (existsSync(tracePath)
    ? readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  return { child, dir, socketPath, tracePath, upstream, logPath: join(dir, 'codex-app-server-broker.log') };
}

test('end to end: one upstream handshake, brokered initialize, implicit subscription, no cross-talk', async (t) => {
  const broker = await startRealBroker(t);

  const a = new TestClient(broker.socketPath);
  const b = new TestClient(broker.socketPath);
  await Promise.all([a.ready, b.ready]);
  t.after(() => { a.close(); b.close(); });

  const initA = await waitFor(async () => {
    const r = await a.call('initialize', { clientInfo: { name: 'bridge-a', version: '1' } });
    // THE readiness gate, polled exactly as a client should: both boot steps
    // FINISHED — the upstream handshake, and the async `codex --version` probe.
    // Never `r.codexVersion`: null is a legitimate terminal outcome of that
    // probe, so gating on it would hang against a perfectly healthy broker.
    return r.codexVersionProbed && r.appServerInitialized ? r : false;
  }, { label: 'the broker to finish booting' });
  const initB = await b.call('initialize', { clientInfo: { name: 'bridge-b', version: '1' } });
  for (const init of [initA, initB]) {
    assert.equal(init.brokered, true);
    assert.equal(init.protocol, BROKER_PROTOCOL_VERSION);
    assert.equal(init.appServerInitialized, true);
    assert.equal(init.codexVersion, '0.147.0');
    assert.ok(init.appServerPid > 0);
  }
  assert.equal(broker.upstream().filter((m) => m.method === 'initialize').length, 1,
    'the broker must handshake upstream exactly once, on everyone\'s behalf');

  // Implicit subscription: no broker/subscribe anywhere in this exchange.
  const started = await a.call('thread/start', { threadId: 'T1', cwd: '/tmp', approvalPolicy: 'never' });
  assert.equal(started.thread.id, 'T1');
  await b.call('thread/start', { threadId: 'T2', cwd: '/tmp', approvalPolicy: 'never' });

  await a.call('fake/emit', {
    frames: [
      { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'T1', delta: 'for-a' } },
      { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'T2', delta: 'for-b' } },
      { jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { used: 1 } },
    ],
  });

  await waitFor(() => a.notifications.length >= 2 && b.notifications.length >= 2, { label: 'notifications' });
  assert.deepEqual(a.notifications.map((n) => n.params.delta ?? n.method), ['for-a', 'account/rateLimits/updated']);
  assert.deepEqual(b.notifications.map((n) => n.params.delta ?? n.method), ['for-b', 'account/rateLimits/updated']);

  // A server→client request lands on the thread's only subscriber, and its
  // answer reaches the app-server verbatim.
  await a.call('fake/emit', {
    frames: [{ jsonrpc: '2.0', id: 9001, method: 'item/commandExecution/requestApproval', params: { threadId: 'T2', command: 'ls' } }],
  });
  await waitFor(() => b.serverRequests.length === 1, { label: 'the approval request' });
  assert.equal(a.serverRequests.length, 0);
  b.answer(9001, { decision: 'decline' });
  await waitFor(() => broker.upstream().some((m) => m.id === 9001 && m.result?.decision === 'decline'),
    { label: 'the approval answer upstream' });

  // Disconnecting a client leaves the other one working and the child alive.
  b.close();
  await a.call('fake/emit', {
    frames: [{ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'T1', delta: 'still-here' } }],
  });
  await waitFor(() => a.notifications.some((n) => n.params?.delta === 'still-here'), { label: 'post-disconnect delivery' });
  const status = await a.call('broker/status');
  assert.equal(status.ok, true);
  assert.equal(status.clients, 1);
});

test('end to end: the app-server dying tells every client and takes the broker down non-zero', async (t) => {
  const broker = await startRealBroker(t);
  const a = new TestClient(broker.socketPath);
  await a.ready;
  t.after(() => a.close());
  await a.call('initialize', { clientInfo: { name: 'bridge-a', version: '1' } });

  a.sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'fake/die', params: { code: 7 } })}\n`);

  await waitFor(() => a.notifications.some((n) => n.method === 'broker/appServerDied'), { label: 'broker/appServerDied' });
  const code = await waitFor(() => (broker.child.exitCode === null ? false : broker.child.exitCode), { label: 'the broker to exit' });
  assert.notEqual(code, 0, 'the broker must exit non-zero so the next ensureBroker spawns a clean one');
  assert.equal(existsSync(broker.socketPath), false, 'the socket must not outlive a clean exit');
});

test('a codex whose version differs from the pinned contract warns and still serves', async (t) => {
  const broker = await startRealBroker(t, { CODEX_FAKE_VERSION: '9.9.9' });
  const a = new TestClient(broker.socketPath);
  await a.ready;
  t.after(() => a.close());

  const init = await waitFor(async () => {
    const r = await a.call('initialize', { clientInfo: { name: 'bridge-a', version: '1' } });
    return r.codexVersionProbed && r.appServerInitialized ? r : false;
  }, { label: 'the broker to finish booting' });
  assert.equal(init.codexVersion, '9.9.9');
  assert.equal(init.appServerInitialized, true, 'a version skew is advisory, never a hard fail');

  const logged = await waitFor(() => {
    const text = existsSync(broker.logPath) ? readFileSync(broker.logPath, 'utf8') : '';
    return text.includes('[WARN]') && text.includes('9.9.9') ? text : false;
  }, { label: 'the version WARN' });
  assert.match(logged, /pinned to codex-cli/);
});

test('end to end: a request sent before the handshake lands is queued and answered, not lost', async (t) => {
  // The socket starts listening BEFORE the child is spawned and handshook, so
  // this window is real and is the one a bridge hits: ensureBroker connect-
  // probes, finds a live socket, connects and immediately sends `thread/start`.
  // The delay makes the window deterministic instead of a millisecond of luck —
  // remove the flushPreInit() call site and this test hangs.
  const broker = await startRealBroker(t, { CODEX_FAKE_INIT_DELAY_MS: '750' });
  const a = new TestClient(broker.socketPath);
  await a.ready;
  t.after(() => a.close());

  // No readiness poll, no broker/status: the very first frame is a forwarded
  // request, sent while the upstream handshake is still in flight.
  const started = await a.call('thread/start', { threadId: 'TQ', cwd: '/tmp', approvalPolicy: 'never' });
  assert.equal(started.thread.id, 'TQ');
  assert.equal(broker.upstream().filter((m) => m.method === 'initialize').length, 1);

  // And it was queued rather than raced through: the handshake reached the
  // app-server before the request it was holding.
  const order = broker.upstream().map((m) => m.method);
  assert.ok(order.indexOf('initialize') < order.indexOf('thread/start'),
    `the handshake must precede the queued request, got ${JSON.stringify(order)}`);

  // The implicit subscription still lands, so the queue is not a side channel.
  await a.call('fake/emit', {
    frames: [{ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'TQ', delta: 'queued-ok' } }],
  });
  await waitFor(() => a.notifications.some((n) => n.params?.delta === 'queued-ok'), { label: 'the queued thread\'s events' });
});

test('a codex whose --version probe fails still reports itself ready', async (t) => {
  // The readiness gate B2 polls is `appServerInitialized && codexVersionProbed`.
  // If it were `codexVersion` instead, a broker that is serving perfectly would
  // look permanently un-ready — and the symptom (every delegation blocks until
  // the client's own timeout) points nowhere near `codex --version`.
  const broker = await startRealBroker(t, { CODEX_FAKE_VERSION_FAIL: '1' });
  const a = new TestClient(broker.socketPath);
  await a.ready;
  t.after(() => a.close());

  const init = await waitFor(async () => {
    const r = await a.call('initialize', { clientInfo: { name: 'bridge-a', version: '1' } });
    return r.codexVersionProbed && r.appServerInitialized ? r : false;
  }, { label: 'the broker to finish booting without a version' });
  assert.equal(init.codexVersion, null, 'unknown stays honestly unknown');
  assert.equal(init.brokered, true);

  // Ready means ready: it serves.
  const started = await a.call('thread/start', { threadId: 'TV', cwd: '/tmp', approvalPolicy: 'never' });
  assert.equal(started.thread.id, 'TV');
});

// AppServerConnection is exported so the spawn + handshake can be driven
// without the socket layer at all.
test('AppServerConnection performs exactly one handshake against a real child process', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cxc-'));
  const tracePath = join(dir, 'trace.jsonl');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const connection = new AppServerConnection({
    env: { ...process.env, CODEX_BIN: fakeCodexBin(dir), CODEX_FAKE_TRACE: tracePath },
  });
  connection.spawn();
  t.after(() => connection.kill());
  const result = await connection.initialize();
  assert.equal(result.userAgent, 'fake-app-server');
  assert.equal(connection.initialized, true);

  const frames = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(frames.map((f) => f.method), ['initialize', 'initialized']);

  const loaded = await connection.request('thread/loaded/list', {});
  assert.deepEqual(loaded, { data: [] });
});
