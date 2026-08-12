#!/usr/bin/env node
// codex-app-server-broker.mjs
//
// Long-lived broker that owns ONE `codex app-server` over stdio (the stable
// transport) and exposes it to short-lived bridge processes over a Unix socket.
//
// Why a broker at all, measured rather than assumed: a bare `codex app-server`
// child dies with its stdio parent, and its in-flight turn ends `turn_aborted`
// — the exact failure `codex exec` already had. stdio buys no survival on its
// own. What buys survival is that the app-server's parent is this process,
// which outlives every bridge: a subagent returning drops a socket client, not
// a job. (probes/codex-app-server/probeA.mjs, bclient.mjs;
// docs/RELIABILITY_REMEDIATION.md §2.)
//
// The wire protocol is documented at `Broker._onClientLine` and is a binding
// contract with bridge-server's client side — both halves are written against
// it, so it is not extended here casually.
//
// Grown from probes/codex-app-server/broker.mjs, whose id-remapping and
// single-handshake design survive intact. That prototype had two deliberate
// gaps, and closing them is most of this file: notifications were BROADCAST
// (so every bridge saw every job's events), and there was no idle reaper.

import { spawn, execFile } from 'node:child_process';
import { createServer, connect as connectSocket } from 'node:net';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveCodexBin } from '../bridge-server/codex-runtime.mjs';
import {
  CODEX_PINNED_VERSION,
  codexVersionMismatchMessage,
  parseCodexVersion,
  routeNotification,
  routeRequest,
  // The methods whose response implicitly subscribes the asking client. Imported,
  // not restated: the adapter reads the same set to decide when a connection may
  // interrupt or steer, and the two must not drift apart.
  THREAD_OWNERSHIP_METHODS as IMPLICIT_SUBSCRIBE_METHODS,
} from '../lib/codex-app-server-contract.mjs';
import { HEARTBEAT_STALE_AFTER_MS, HOST_LIVENESS_TTL_MS, scanLiveHeartbeat } from '../lib/heartbeat.mjs';
// `pidAlive`, not a local `process.kill(pid, 0)` wrapper: it is the repo's one
// definition of the predicate (EPERM means alive, and a pid <= 0 is not a pid —
// `kill(0, 0)` signals our own process GROUP and would read a torn lock file's
// `{"pid":0}` as a live holder). Imported bare rather than through the
// registry's `_impl`, so another suite's stub cannot reach this daemon.
import { pidAlive } from '../lib/shared-runtime-registry.mjs';
import {
  appendPrivateFile,
  codexBrokerLogFile,
  codexBrokerSocketPath,
  heartbeatDir,
  writePrivateFile,
} from '../lib/runtime-paths.mjs';

// --- Constants ---------------------------------------------------------------

// The broker's own protocol revision, reported by `initialize` and
// `broker/status`. Nothing to do with the codex app-server protocol (which
// carries no version field at all — see CODEX_PINNED_VERSION). Bump only on a
// breaking change to the client-facing contract below.
export const BROKER_PROTOCOL_VERSION = 1;
export const BROKER_CLIENT_NAME = 'agent-companion-broker';

// The methods this broker answers ITSELF, in one place because two code paths
// have to agree about them: the id-bearing `switch` in `_onClientLine` routes
// them locally, and the id-LESS branch above it has to refuse the same names
// instead of forwarding them. Forwarding either kind is a real failure, not a
// cosmetic one — `initialize` would re-handshake a shared app-server that
// already handshook once for everybody, and codex has never heard of `broker/*`,
// so it answers -32600 for a call the client believes it made locally. A drift
// test in the suite holds this set to the switch's own case labels.
export const BROKER_LOCAL_METHODS = new Set([
  'initialize',
  'broker/status',
  'broker/subscribe',
  'broker/unsubscribe',
]);

const LOG_MAX_BYTES = 1024 * 1024; // 1 MB, same as the copilot daemon

// A single frame can legitimately be large: `thread/read{includeTurns:true}`
// returns the whole transcript, and rollout lines of 34-46 KB are on record.
// The cap is not a size policy, it is an OOM guard against a peer that never
// sends a newline; an over-cap line is discarded up to the next newline.
const MAX_LINE_BYTES = 8 * 1024 * 1024;

// Pre-subscription ring. A thread-scoped notification with no current
// subscriber is held here and flushed on subscribe — see `SubscriptionTable`.
const PRESUB_RING_CAP = 200;
const PRESUB_TTL_MS = 30_000;
const PRESUB_MAX_THREADS = 64;

// Frames a client sent before the upstream handshake finished. The window is
// milliseconds at boot, but `broker/status` answers locally and immediately, so
// a client that probes for liveness and then sends can land inside it.
const PREINIT_QUEUE_CAP = 512;

const APP_SERVER_INIT_TIMEOUT_MS = 30_000;
const LOADED_LIST_TIMEOUT_MS = 10_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;

// Idle reaper, mirroring the copilot daemon's shape and constants. The two
// heartbeat TTLs are IMPORTED, not restated: both daemons sweep (and unlink
// from) the same heartbeat directory, so a locally-tuned copy in one of them
// would delete files the other still counts as live — and the broker would then
// reap itself under an active host session. One owner for the walk and its
// predicate: lib/heartbeat.mjs.
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const INACTIVITY_RECHECK_MS = 60 * 1000;

const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

// --- Test seam ---------------------------------------------------------------
//
// One module-local record, swapped wholesale by `_setForTest` and restored by
// `_resetForTest` — the same seam idiom as opencode-server-runtime.mjs and
// shared-runtime-registry.mjs. `exit` is in here because the reaper's whole
// contract is "when do you exit", which a test cannot assert if the assertion
// kills the test runner.

const realNow = () => Date.now();
const realExit = (code) => process.exit(code);

// `probeSocket` is in here because the interesting verdicts are the ones a test
// cannot provoke on demand: fd exhaustion, EACCES, EAGAIN. Those are exactly the
// verdicts on which the broker must refuse instead of unlinking.
let _impl = { now: realNow, exit: realExit, probeSocket };

export function _setForTest(overrides = {}) {
  _impl = { ..._impl, ...overrides };
}

export function _resetForTest() {
  _impl = { now: realNow, exit: realExit, probeSocket };
}

function now() {
  return _impl.now();
}

// --- Logger ------------------------------------------------------------------
//
// Same level gating and size rotation as the copilot daemon's, against its own
// file. DEBUG carries every routing decision, which is the only way to answer
// "why did this bridge not see that event" after the fact; it is off by default
// because a streaming turn emits hundreds of delta notifications a second.

const LOG_LEVEL = (process.env.CODEX_BROKER_LOG_LEVEL || 'INFO').toUpperCase();
// APP_SERVER_STDERR is a real level with a real rank, not a bare string. The
// copilot daemon lets any unknown level bypass the gate, which means the child's
// stderr keeps writing after an operator lowers the level to ERROR — and since
// the log rotates by truncation at 1 MB, that traffic scrolls away the very
// records they asked to keep. Ranking it at INFO keeps the default behaviour
// (child stderr is captured) and makes `CODEX_BROKER_LOG_LEVEL=WARN` mean it.
const LOG_LEVEL_RANK = { DEBUG: 10, INFO: 20, APP_SERVER_STDERR: 20, WARN: 30, ERROR: 40, FATAL: 50 };
const LOG_THRESHOLD = LOG_LEVEL_RANK[LOG_LEVEL] ?? LOG_LEVEL_RANK.INFO;

function log(level, ...args) {
  const rank = LOG_LEVEL_RANK[level];
  if (rank !== undefined && rank < LOG_THRESHOLD) return;
  try {
    const logFile = codexBrokerLogFile();
    if (existsSync(logFile) && statSync(logFile).size > LOG_MAX_BYTES) {
      writePrivateFile(logFile, '');
    }
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    appendPrivateFile(logFile, `${new Date().toISOString()} [${level}] ${msg}\n`);
  } catch {
    // best-effort logging
  }
}

// --- LineReader --------------------------------------------------------------

// Newline-delimited JSON framing, used for both directions: the app-server's
// stdout and every client socket. Chunk boundaries fall anywhere, so the
// partial tail is carried across pushes.
//
// `maxLineBytes` is measured in UTF-16 code units rather than bytes. That
// under-counts multi-byte text by up to 3x, which is the safe direction for a
// guard whose only job is to stop an unterminated stream from eating the heap.
export class LineReader {
  constructor({ maxLineBytes = MAX_LINE_BYTES } = {}) {
    this.maxLineBytes = maxLineBytes;
    this.buf = '';
    // True while discarding the tail of an over-cap line: everything up to the
    // next newline belongs to a frame we already gave up on.
    this.overflow = false;
  }

  push(chunk) {
    const lines = [];
    let dropped = 0;
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (this.overflow) {
        this.overflow = false;
        dropped += 1;
        continue;
      }
      // A complete over-cap line has to be dropped here too. Capping only the
      // residual buffer below would let a frame that arrived whole inside one
      // chunk through at any size — the guard would hold only for lines that
      // happened to straddle a chunk boundary.
      if (line.length > this.maxLineBytes) {
        dropped += 1;
        continue;
      }
      if (line.trim()) lines.push(line);
    }
    if (this.buf.length > this.maxLineBytes) {
      this.buf = '';
      this.overflow = true;
    }
    return { lines, dropped };
  }
}

// --- SubscriptionTable -------------------------------------------------------

// Which client hears about which thread — and what happens to a thread's events
// before anyone has said they want them.
//
// Both halves live in one class because they are one question. The prototype
// broadcast every notification to every client, so a bridge running job A also
// received job B's deltas, approvals and completions; filtering by threadId is
// the fix, and the buffer exists only because filtering opens an ordering race
// against the response that establishes the subscription.
export class SubscriptionTable {
  constructor({ ringCap = PRESUB_RING_CAP, ttlMs = PRESUB_TTL_MS, maxThreads = PRESUB_MAX_THREADS } = {}) {
    this.ringCap = ringCap;
    this.ttlMs = ttlMs;
    this.maxThreads = maxThreads;
    // threadId -> Set(clientId). Set iteration is insertion-ordered, which is
    // what makes "the earliest still-connected subscriber" the primary without
    // a second structure: dropped clients are removed, so the first survivor is
    // the earliest survivor.
    this.byThread = new Map();
    this.byClient = new Map(); // clientId -> Set(threadId)
    this.rings = new Map();    // threadId -> [{ at, payload }]
  }

  subscribe(threadId, clientId) {
    if (!this.byThread.has(threadId)) this.byThread.set(threadId, new Set());
    const set = this.byThread.get(threadId);
    const added = !set.has(clientId);
    set.add(clientId);
    if (!this.byClient.has(clientId)) this.byClient.set(clientId, new Set());
    this.byClient.get(clientId).add(threadId);
    return added;
  }

  unsubscribe(threadId, clientId) {
    const set = this.byThread.get(threadId);
    if (set) {
      set.delete(clientId);
      if (set.size === 0) this.byThread.delete(threadId);
    }
    const mine = this.byClient.get(clientId);
    if (mine) {
      mine.delete(threadId);
      if (mine.size === 0) this.byClient.delete(clientId);
    }
  }

  // Drop everything a departing client held. Returns the threads it was
  // subscribed to, for logging.
  dropClient(clientId) {
    const threads = [...(this.byClient.get(clientId) || [])];
    for (const threadId of threads) this.unsubscribe(threadId, clientId);
    this.byClient.delete(clientId);
    return threads;
  }

  subscribers(threadId) {
    return [...(this.byThread.get(threadId) || [])];
  }

  // The one client a server→client request goes to. Fanning an approval out to
  // every subscriber would have two bridges answering the same request, and the
  // app-server would act on whichever landed first.
  primary(threadId) {
    for (const clientId of this.byThread.get(threadId) || []) return clientId;
    return null;
  }

  // Distinct threads with at least one subscriber — what `broker/status`
  // reports as `subscriptions`.
  threadCount() {
    return this.byThread.size;
  }

  // Hold a notification for a thread nobody is subscribed to yet. Bounded three
  // ways (per-thread depth, age, distinct threads) because the producer is the
  // app-server and the consumer may never arrive.
  buffer(threadId, payload) {
    this.sweep();
    if (!this.rings.has(threadId)) {
      if (this.rings.size >= this.maxThreads) {
        // Oldest ring first: Map iteration is insertion-ordered.
        const oldest = this.rings.keys().next().value;
        this.rings.delete(oldest);
        log('WARN', 'presub ring evicted (too many buffered threads):', oldest);
      }
      this.rings.set(threadId, []);
    }
    const ring = this.rings.get(threadId);
    ring.push({ at: now(), payload });
    while (ring.length > this.ringCap) ring.shift();
    return ring.length;
  }

  // Flush-and-clear. Clearing is what makes delivery at-most-once: a second
  // subscriber joining the same thread gets the live stream and no replay of
  // events the first subscriber already consumed. Duplicated deltas would be
  // double-counted by an accumulator; a gap the client can see is strictly
  // better than a duplicate it cannot.
  drain(threadId) {
    this.sweep();
    const ring = this.rings.get(threadId) || [];
    this.rings.delete(threadId);
    return ring.map((entry) => entry.payload);
  }

  sweep(nowMs = now()) {
    for (const [threadId, ring] of this.rings) {
      while (ring.length && nowMs - ring[0].at > this.ttlMs) ring.shift();
      if (ring.length === 0) this.rings.delete(threadId);
    }
  }

  bufferedCount(threadId) {
    return (this.rings.get(threadId) || []).length;
  }
}

// --- AppServerConnection -----------------------------------------------------

// The `codex app-server` child: spawn, the ONE upstream handshake, framing, and
// the broker's own request bookkeeping (the reaper's `thread/loaded/list`).
// Routing of everything else belongs to `Broker` — this class never looks at a
// client.
//
// The child is NOT detached. It must die with the broker: a detached app-server
// whose broker is gone owns live threads nobody can reach and no one will reap.
// Measured: SIGKILLing the broker takes the app-server with it (its stdio pipe
// closes) leaving no orphan, and a fresh broker then resumes those threads from
// disk. Detachment belongs one level up — the BRIDGE spawns the broker
// detached, which is what makes the broker outlive it.
export class AppServerConnection {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.child = null;
    this.pid = null;
    this.initialized = false;
    this.dead = false;
    this.codexVersion = null;
    // "the version probe has finished", which is NOT "the version is known".
    // A wrapper binary that prints an unparseable banner, or a `--version` that
    // times out, leaves codexVersion null forever — and a client gating
    // readiness on a truthy codexVersion would then wait out its own timeout
    // against a broker that is serving perfectly. Readiness gates on this flag;
    // `codexVersion: null` stays the honest "unknown, already warned" value.
    this.versionProbed = false;
    this.reader = new LineReader();
    this._nextId = 1;
    this._own = new Map(); // upstream id -> { resolve, reject, timer } for the broker's own calls
    // Wired by the Broker.
    this.onMessage = () => {};
    this.onExit = () => {};
  }

  nextId() {
    return this._nextId++;
  }

  isAlive() {
    return this.child !== null && !this.dead && this.child.exitCode === null;
  }

  spawn() {
    const bin = resolveCodexBin(this.env);
    log('INFO', 'spawning codex app-server:', bin);
    this.child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env: this.env });
    this.pid = this.child.pid || null;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr.on('data', (chunk) => log('APP_SERVER_STDERR', String(chunk).trim().slice(0, 500)));
    this.child.on('error', (err) => {
      log('ERROR', 'codex app-server spawn error:', err.message);
      this.dead = true;
      this._failOwn(`codex app-server spawn error: ${err.message}`);
      this.onExit(null, null, err);
    });
    this.child.on('close', (code, signal) => {
      this.dead = true;
      this._failOwn(`codex app-server exited (code=${code}, signal=${signal})`);
      this.onExit(code, signal, null);
    });
    this._probeVersion(bin);
    return this.child;
  }

  // Advisory only, and asynchronous: the protocol carries no version field, so
  // a CLI upgrade surfaces as a shape mismatch at runtime and this WARN is the
  // only early notice. It must never block or fail the boot — a broker that
  // refuses to start on a version bump takes every delegation down with it.
  _probeVersion(bin) {
    execFile(bin, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err, stdout) => {
      // Set on BOTH paths: the probe is over either way, and a client waiting
      // for the broker to finish booting must not wait on an answer that is
      // never coming.
      this.versionProbed = true;
      if (err) {
        log('WARN', 'could not read `codex --version`:', err.message);
        return;
      }
      const installed = parseCodexVersion(stdout);
      this.codexVersion = installed;
      if (installed && installed === CODEX_PINNED_VERSION) {
        log('INFO', 'codex version matches the pinned contract:', installed);
        return;
      }
      log('WARN', codexVersionMismatchMessage(installed));
    });
  }

  _onStdout(chunk) {
    const { lines, dropped } = this.reader.push(chunk);
    if (dropped) log('ERROR', 'dropped', String(dropped), 'oversized app-server frame(s)');
    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); }
      catch { log('WARN', 'non-json line from app-server:', line.slice(0, 200)); continue; }
      // The broker's own calls resolve here and are never shown to a client.
      if (msg && msg.id !== undefined && msg.method === undefined && this._own.has(msg.id)) {
        const pending = this._own.get(msg.id);
        this._own.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
        continue;
      }
      this.onMessage(msg);
    }
  }

  _failOwn(reason) {
    for (const [, pending] of this._own) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._own.clear();
  }

  send(msg) {
    if (!this.child || this.dead) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
      return true;
    } catch (err) {
      log('ERROR', 'write to app-server failed:', err.message);
      return false;
    }
  }

  request(method, params, timeoutMs = 60_000) {
    if (!this.isAlive()) return Promise.reject(new Error('codex app-server is not alive'));
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._own.delete(id);
        reject(new Error(`app-server request timeout (method=${method})`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this._own.set(id, { resolve, reject, timer });
      if (!this.send({ jsonrpc: '2.0', id, method, params })) {
        this._own.delete(id);
        clearTimeout(timer);
        reject(new Error('codex app-server is not writable'));
      }
    });
  }

  // The ONE upstream handshake, performed on behalf of every client that ever
  // connects. A shared app-server must not be re-initialized per bridge, so
  // clients get a local answer instead (see Broker._onClientLine).
  async initialize() {
    const result = await this.request(
      'initialize',
      { clientInfo: { name: BROKER_CLIENT_NAME, version: String(BROKER_PROTOCOL_VERSION) } },
      APP_SERVER_INIT_TIMEOUT_MS,
    );
    this.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    this.initialized = true;
    log('INFO', 'app-server initialized by broker; pid', String(this.pid));
    return result;
  }

  kill() {
    if (this.child && this.child.exitCode === null) {
      try { this.child.kill('SIGTERM'); } catch {}
    }
    this.dead = true;
    this._failOwn('broker shutting down');
  }
}

// --- Broker ------------------------------------------------------------------

export class Broker {
  // No `subscriptions` injection point: this module's one test seam is the
  // `_impl` record above, and a second, parallel one that no caller ever
  // supplied is the layering that idiom exists to avoid. A test wanting a
  // tiny ring assigns `broker.subscriptions` after construction; the ring cap
  // and TTL are exercised on `SubscriptionTable` directly.
  constructor({ connection }) {
    this.connection = connection;
    this.subscriptions = new SubscriptionTable();
    this.startedAt = now();
    this.clients = new Map(); // clientId -> client record
    this._nextClientId = 1;
    // upstream id -> { clientId, downstreamId, method }
    this.pending = new Map();
    // upstream request id (server→client) -> clientId that owes the answer
    this.outstandingServerRequests = new Map();
    this._preInitQueue = [];
    this.idleTimer = null;
    this.shuttingDown = false;

    if (connection) {
      connection.onMessage = (msg) => this._onUpstreamMessage(msg);
      connection.onExit = (code, signal) => this._onAppServerDeath(code, signal);
    }
  }

  // ---- client lifecycle ----

  attachClient(sock) {
    const client = {
      id: this._nextClientId++,
      sock,
      reader: new LineReader(),
      connectedAt: now(),
      closed: false,
    };
    this.clients.set(client.id, client);
    log('INFO', 'client connected:', String(client.id), 'total', String(this.clients.size));
    sock.setEncoding?.('utf8');
    sock.on('data', (chunk) => {
      const { lines, dropped } = client.reader.push(String(chunk));
      if (dropped) log('WARN', 'dropped', String(dropped), 'oversized frame(s) from client', String(client.id));
      for (const line of lines) this._onClientLine(client, line);
    });
    sock.on('close', () => this.dropClient(client));
    sock.on('error', (err) => {
      log('DEBUG', 'client socket error:', String(client.id), err.message);
      this.dropClient(client);
    });
    this._resetIdleTimer();
    return client;
  }

  // Dropping a client must disturb nothing else: not another client, and above
  // all not the app-server child. That detachable-observer property is the
  // entire reason this process exists.
  dropClient(client) {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client.id);
    const threads = this.subscriptions.dropClient(client.id);

    // Pending responses for a gone client have nowhere to go. Forget the map
    // entries so a long-lived broker does not accumulate them; the app-server
    // still completes the work, which is the point.
    let orphanedResponses = 0;
    for (const [upstreamId, entry] of this.pending) {
      if (entry.clientId !== client.id) continue;
      this.pending.delete(upstreamId);
      orphanedResponses += 1;
    }

    // A server→client request this client never answered would otherwise leave
    // the app-server waiting forever. Answer it ourselves.
    for (const [requestId, clientId] of this.outstandingServerRequests) {
      if (clientId !== client.id) continue;
      this.outstandingServerRequests.delete(requestId);
      log('WARN', 'client', String(client.id), 'disconnected owing an answer to server request', String(requestId), '— answering -32601');
      this._answerUpstreamNotSupported(requestId, 'subscriber disconnected before answering');
    }

    log('INFO', 'client gone:', String(client.id), 'total', String(this.clients.size),
      'threads', JSON.stringify(threads), 'orphanedResponses', String(orphanedResponses));
    this._resetIdleTimer();
  }

  // ---- client → broker ----

  // THE WIRE PROTOCOL (binding; bridge-server's client codes against exactly
  // this). Newline-delimited JSON in both directions.
  //
  //   {id, method:'initialize'}          answered LOCALLY, never forwarded — the
  //                                      broker already handshook upstream for
  //                                      everyone. Its result carries the
  //                                      readiness gate: poll until
  //                                      `appServerInitialized &&
  //                                      codexVersionProbed`, NOT until
  //                                      `codexVersion` is truthy.
  //   {method:'initialized'}             swallowed.
  //   {id, method:'broker/status'}       local liveness probe.
  //   {id, method:'broker/subscribe'}    local; flushes the pre-subscription
  //                                      ring for that thread to this client.
  //   {id, method:'broker/unsubscribe'}  local.
  //   {id, method, params}               id-remapped into the broker's upstream
  //                                      id space and forwarded.
  //   {id, result|error}                 this client answering a server→client
  //                                      request; forwarded upstream verbatim.
  //   {method, params} (no id)           forwarded upstream — UNLESS it names one
  //                                      of BROKER_LOCAL_METHODS, which is
  //                                      dropped: a local call with no id is a
  //                                      question the broker cannot answer, and
  //                                      sending it on would put a `broker/*`
  //                                      frame in front of codex.
  _onClientLine(client, line) {
    let msg;
    try { msg = JSON.parse(line); }
    catch { log('WARN', 'non-json line from client', String(client.id), line.slice(0, 200)); return; }
    if (!msg || typeof msg !== 'object') {
      log('WARN', 'non-object frame from client', String(client.id));
      return;
    }

    // `null` counts as absent. A frame with `id: null` expects no response in
    // JSON-RPC, and `null` is also the sentinel `_sendUpstream` reads for "do
    // not allocate an upstream id" — letting the two mean different things is
    // how a request quietly becomes an unanswerable notification.
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === 'initialized') return; // the client's half of a handshake it never made
      if (typeof msg.method !== 'string') {
        log('WARN', 'client', String(client.id), 'sent a frame with neither id nor method');
        return;
      }
      if (BROKER_LOCAL_METHODS.has(msg.method)) {
        // Dropped, loudly. The alternative is what this branch used to do:
        // forward it, so a client's own `broker/unsubscribe` reached codex as an
        // unknown method and the subscription it meant to drop stayed put.
        log('WARN', 'client', String(client.id), 'sent local method as a notification; dropped', msg.method);
        return;
      }
      this._forwardUpstream(client, null, { jsonrpc: '2.0', method: msg.method, params: msg.params });
      return;
    }

    if (typeof msg.method !== 'string') {
      // Has an id and no method: a response to a server→client request.
      this._answerUpstream(client, msg);
      return;
    }

    switch (msg.method) {
      case 'initialize':
        // THE READINESS GATE, for the client half: poll this until
        // `appServerInitialized && codexVersionProbed`. Do NOT gate on
        // `codexVersion` being truthy — null is a legitimate terminal value
        // (unparseable or unavailable `codex --version`, already WARNed) and a
        // client that waits for it would block forever on a healthy broker.
        this._reply(client, msg.id, {
          brokered: true,
          protocol: BROKER_PROTOCOL_VERSION,
          brokerPid: process.pid,
          appServerPid: this.connection?.pid ?? null,
          appServerInitialized: !!this.connection?.initialized,
          codexVersion: this.connection?.codexVersion ?? null,
          codexVersionProbed: !!this.connection?.versionProbed,
        });
        return;
      case 'broker/status':
        this._reply(client, msg.id, this.status());
        return;
      case 'broker/subscribe':
        this._handleSubscribe(client, msg);
        return;
      case 'broker/unsubscribe':
        this._handleUnsubscribe(client, msg);
        return;
      default:
        this._forwardUpstream(client, msg.id, { jsonrpc: '2.0', method: msg.method, params: msg.params });
    }
  }

  status() {
    return {
      ok: true,
      protocol: BROKER_PROTOCOL_VERSION,
      brokerPid: process.pid,
      appServerPid: this.connection?.pid ?? null,
      uptimeMs: now() - this.startedAt,
      clients: this.clients.size,
      subscriptions: this.subscriptions.threadCount(),
    };
  }

  _handleSubscribe(client, msg) {
    const threadId = msg.params?.threadId;
    if (typeof threadId !== 'string' || !threadId) {
      this._replyError(client, msg.id, JSONRPC_INVALID_PARAMS, 'broker/subscribe requires params.threadId');
      return;
    }
    this.subscriptions.subscribe(threadId, client.id);
    // Flush BEFORE answering: the buffer exists precisely because a
    // notification about this thread can reach the broker before the client
    // knows the thread exists, and a client that sees the ack first would
    // reasonably treat what follows as live-only.
    const flushed = this._flushBuffered(client, threadId);
    log('DEBUG', 'subscribe:', 'client', String(client.id), 'thread', threadId, 'flushed', String(flushed));
    this._reply(client, msg.id, { ok: true, threadId, flushed });
  }

  _handleUnsubscribe(client, msg) {
    const threadId = msg.params?.threadId;
    if (typeof threadId !== 'string' || !threadId) {
      this._replyError(client, msg.id, JSONRPC_INVALID_PARAMS, 'broker/unsubscribe requires params.threadId');
      return;
    }
    this.subscriptions.unsubscribe(threadId, client.id);
    log('DEBUG', 'unsubscribe:', 'client', String(client.id), 'thread', threadId);
    this._reply(client, msg.id, { ok: true, threadId });
  }

  _flushBuffered(client, threadId) {
    const buffered = this.subscriptions.drain(threadId);
    for (const payload of buffered) this._write(client, payload);
    return buffered.length;
  }

  // Forward a client frame upstream, remapping its id into the broker's own id
  // space so two clients numbering from 1 never collide.
  _forwardUpstream(client, downstreamId, frame) {
    if (!this.connection || this.connection.dead) {
      log('WARN', 'dropping', frame.method, 'from client', String(client.id), '— the app-server is gone');
      if (downstreamId !== null) {
        this._replyError(client, downstreamId, JSONRPC_INTERNAL_ERROR, 'codex app-server is not running');
      }
      return;
    }

    // `thread/start` and `thread/resume` carry the approval policy. The broker
    // never rewrites client params, but a policy other than `never` is worth a
    // WARN: auto-accepting an approval is measured to escalate PAST the sandbox
    // (a read-only thread that accepted one approval wrote a file). The broker's
    // own -32601 answer to unroutable approvals is the hard backstop.
    const policy = frame.params?.approvalPolicy;
    if (policy !== undefined && policy !== 'never') {
      log('WARN', 'client', String(client.id), 'sent', frame.method, 'with approvalPolicy', JSON.stringify(policy),
        '— only `never` keeps the sandbox authoritative');
    }

    if (!this.connection.initialized) {
      if (this._preInitQueue.length >= PREINIT_QUEUE_CAP) {
        log('ERROR', 'pre-init queue full; dropping', frame.method, 'from client', String(client.id));
        if (downstreamId !== null) {
          this._replyError(client, downstreamId, JSONRPC_INTERNAL_ERROR, 'broker upstream handshake has not completed');
        }
        return;
      }
      this._preInitQueue.push({ client, downstreamId, frame });
      log('DEBUG', 'queued until handshake:', frame.method, 'client', String(client.id));
      return;
    }

    this._sendUpstream(client, downstreamId, frame);
  }

  _sendUpstream(client, downstreamId, frame) {
    if (downstreamId === null) {
      this.connection.send(frame);
      log('DEBUG', 'forward notification:', frame.method, 'client', String(client.id));
      return;
    }
    const upstreamId = this.connection.nextId();
    this.pending.set(upstreamId, { clientId: client.id, downstreamId, method: frame.method });
    this.connection.send({ ...frame, id: upstreamId });
    log('DEBUG', 'forward request:', frame.method, 'client', String(client.id),
      'down', JSON.stringify(downstreamId), 'up', String(upstreamId));
  }

  // Called once the upstream handshake lands.
  flushPreInit() {
    const queued = this._preInitQueue;
    this._preInitQueue = [];
    for (const { client, downstreamId, frame } of queued) {
      if (client.closed) continue;
      this._sendUpstream(client, downstreamId, frame);
    }
    if (queued.length) log('INFO', 'flushed', String(queued.length), 'frame(s) queued before the handshake');
  }

  // A client answering a server→client request. Only the client the request was
  // routed to may answer it, and only once — otherwise a second bridge could
  // answer another bridge's approval, which is the same hazard as fanning the
  // request out in the first place.
  _answerUpstream(client, msg) {
    const owner = this.outstandingServerRequests.get(msg.id);
    if (owner === undefined) {
      log('WARN', 'client', String(client.id), 'answered unknown server request id', JSON.stringify(msg.id), '— dropped');
      return;
    }
    if (owner !== client.id) {
      log('WARN', 'client', String(client.id), 'answered server request', JSON.stringify(msg.id),
        'owned by client', String(owner), '— dropped');
      return;
    }
    this.outstandingServerRequests.delete(msg.id);
    this.connection?.send(msg);
    log('DEBUG', 'client answer forwarded upstream:', 'client', String(client.id), 'id', JSON.stringify(msg.id));
  }

  // ---- broker → client ----

  _onUpstreamMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    // `id: null` reads as absent in both directions — see _onClientLine.
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && typeof msg.method === 'string') {
      this._routeServerRequest(msg);
      return;
    }
    if (hasId) {
      this._routeResponse(msg);
      return;
    }
    if (typeof msg.method === 'string') {
      this._routeNotification(msg);
      return;
    }
    log('WARN', 'unroutable frame from app-server:', JSON.stringify(msg).slice(0, 200));
  }

  _routeResponse(msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) {
      log('WARN', 'response for unknown upstream id', JSON.stringify(msg.id), '— dropped');
      return;
    }
    this.pending.delete(msg.id);
    const client = this.clients.get(entry.clientId);
    if (!client || client.closed) {
      log('DEBUG', 'response for departed client', String(entry.clientId), 'method', entry.method, '— dropped');
      return;
    }
    this._write(client, { ...msg, id: entry.downstreamId });
    log('DEBUG', 'response routed:', entry.method, 'client', String(entry.clientId), 'up', JSON.stringify(msg.id));

    // Implicit subscription. The response is written first so the client learns
    // the thread id before any of its events arrive; the buffered tail follows
    // immediately, which is the ordering a fresh accumulator expects.
    if (!IMPLICIT_SUBSCRIBE_METHODS.has(entry.method)) return;
    const threadId = msg.result?.thread?.id;
    if (msg.error !== undefined || typeof threadId !== 'string' || !threadId) return;
    const added = this.subscriptions.subscribe(threadId, client.id);
    const flushed = this._flushBuffered(client, threadId);
    log('DEBUG', 'implicit subscribe via', entry.method, 'client', String(client.id), 'thread', threadId,
      'new', String(added), 'flushed', String(flushed));
  }

  _routeNotification(msg) {
    const { routing, threadId, optional } = routeNotification(msg.method, msg.params);

    if (routing === 'unknown') {
      // The installed codex emitted a method the pinned contract has never
      // seen. That is schema drift, and guessing a thread for it would misroute
      // one job's events into another job's bridge — so it fans out, loudly.
      log('WARN', 'unknown notification method (contract drift):', msg.method, '— treated as global');
      this._broadcast(msg);
      return;
    }

    if (routing === 'global') {
      this._broadcast(msg);
      log('DEBUG', 'global notification:', msg.method, 'clients', String(this.clients.size));
      return;
    }

    if (!threadId) {
      // Thread-routable with no id. Three notifications on 0.147.0 declare the
      // id optional (a `warning` that applies to no thread, for instance) and
      // are legitimately global; anything else means the id moved and the
      // contract needs regenerating.
      if (!optional) {
        log('WARN', 'notification', msg.method, 'is thread-routable but carried no threadId (contract drift) — treated as global');
      } else {
        log('DEBUG', 'notification', msg.method, 'carried no threadId (optional) — treated as global');
      }
      this._broadcast(msg);
      return;
    }

    const subscribers = this.subscriptions.subscribers(threadId);
    if (subscribers.length === 0) {
      const depth = this.subscriptions.buffer(threadId, msg);
      log('DEBUG', 'buffered notification:', msg.method, 'thread', threadId, 'depth', String(depth));
      return;
    }
    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client && !client.closed) this._write(client, msg);
    }
    log('DEBUG', 'thread notification:', msg.method, 'thread', threadId, 'to', JSON.stringify(subscribers));
  }

  _routeServerRequest(msg) {
    const { routing, threadId } = routeRequest(msg.method, msg.params);

    if (routing === 'unknown') {
      log('WARN', 'unknown server request method (contract drift):', msg.method, '— answering -32601');
      this._answerUpstreamNotSupported(msg.id, `unknown method ${msg.method}`);
      return;
    }

    // `attestation/generate` and `account/chatgptAuthTokens/refresh` carry no
    // thread, so there is no bridge they belong to. Answer them ourselves
    // rather than picking a client at random or leaving the app-server blocked.
    if (routing === 'global' || !threadId) {
      log('WARN', 'server request', msg.method, 'has no owning thread — answering -32601');
      this._answerUpstreamNotSupported(msg.id, `${msg.method} is not brokered`);
      return;
    }

    const primary = this.subscriptions.primary(threadId);
    const client = primary === null ? null : this.clients.get(primary);
    if (!client || client.closed) {
      log('WARN', 'server request', msg.method, 'for thread', threadId, 'has no subscriber — answering -32601');
      this._answerUpstreamNotSupported(msg.id, `no client is subscribed to thread ${threadId}`);
      return;
    }

    // Forwarded verbatim, id and all: JSON-RPC gives each direction its own id
    // space, and a remap would have to be undone on the way back with no extra
    // safety bought. The id IS tracked, so only the client we asked can answer.
    this.outstandingServerRequests.set(msg.id, client.id);
    this._write(client, msg);
    log('DEBUG', 'server request routed:', msg.method, 'thread', threadId, 'client', String(client.id),
      'id', JSON.stringify(msg.id));
  }

  _answerUpstreamNotSupported(id, detail) {
    this.connection?.send({
      jsonrpc: '2.0',
      id,
      error: { code: JSONRPC_METHOD_NOT_FOUND, message: `broker: ${detail}` },
    });
  }

  _broadcast(msg) {
    for (const client of this.clients.values()) {
      if (!client.closed) this._write(client, msg);
    }
  }

  _write(client, msg) {
    if (client.closed) return;
    try { client.sock.write(`${JSON.stringify(msg)}\n`); }
    catch (err) { log('DEBUG', 'write to client', String(client.id), 'failed:', err.message); }
  }

  _reply(client, id, result) {
    this._write(client, { jsonrpc: '2.0', id, result });
  }

  _replyError(client, id, code, message) {
    this._write(client, { jsonrpc: '2.0', id, error: { code, message } });
  }

  // ---- app-server death ----

  // Nothing here can be salvaged: the threads died with the process. Tell every
  // client so an in-flight `agent_wait` fails honestly instead of hanging to its
  // timeout, then exit non-zero so the next ensureBroker spawns a clean one
  // rather than adopting a broker with no app-server behind it.
  _onAppServerDeath(code, signal) {
    if (this.shuttingDown) return;
    log('FATAL', 'codex app-server exited:', JSON.stringify({ code, signal }));
    this._broadcast({ jsonrpc: '2.0', method: 'broker/appServerDied', params: { code, signal } });
    this.shuttingDown = true;
    // A beat for the socket writes to flush before the process goes away.
    setTimeout(() => _impl.exit(1), 50);
  }

  // ---- idle reaper ----

  // unref'd deliberately: the listening socket is what keeps the broker alive,
  // so the reaper never needs to hold the loop open — and a unit test that
  // exercises a Broker without a socket then exits instead of waiting out the
  // 15-minute timer.
  _resetIdleTimer(delayMs = INACTIVITY_TIMEOUT_MS) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this._onInactivityTick(); }, delayMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  startIdleReaper() {
    this._resetIdleTimer();
  }

  // Exit only when ALL THREE hold: no connected client, no host session still
  // beating, and no thread loaded in the app-server. Any one of them false — or
  // simply unknown, which is why a failed `thread/loaded/list` reschedules —
  // means reschedule, never exit. A broker that exits under a live turn
  // destroys exactly the work this transport exists to protect, and the cost of
  // being wrong the other way is one idle process for another minute.
  //
  // Order is cheapest-first: the client count is in memory, the heartbeat scan
  // is a readdir, and only then do we spend an RPC on the app-server.
  async _onInactivityTick() {
    if (this.shuttingDown) return false;

    if (this._cheapGatesHold()) return false;

    let loaded;
    try {
      const result = await this.connection.request('thread/loaded/list', {}, LOADED_LIST_TIMEOUT_MS);
      loaded = Array.isArray(result?.data) ? result.data : [];
    } catch (err) {
      log('WARN', 'idle tick: thread/loaded/list failed, assuming the app-server is busy:', err.message);
      this._resetIdleTimer(INACTIVITY_RECHECK_MS);
      return false;
    }
    if (loaded.length > 0) {
      log('INFO', 'idle tick:', String(loaded.length), 'thread(s) still loaded — extending');
      this._resetIdleTimer(INACTIVITY_RECHECK_MS);
      return false;
    }

    // The two cheap gates were read BEFORE the RPC above. `thread/loaded/list`
    // usually answers in about a millisecond but is allowed ten seconds, and a
    // bridge that connect-probes the socket inside that window finds a live
    // broker, connects, and sends `thread/start` — all invisible to a decision
    // made on the pre-await snapshot. Re-read them: exiting on a stale "nobody
    // is here" kills the app-server under a live turn, which is the one failure
    // this whole transport exists to prevent.
    if (this.shuttingDown) return false;
    if (this._cheapGatesHold()) return false;

    log('INFO', 'idle: no clients, no live host, no loaded threads — shutting down');
    this.shutdown();
    _impl.exit(0);
    return true;
  }

  // The two in-memory/readdir gates. `true` means something says "not idle" and
  // the timer has been rescheduled; the caller must not exit.
  _cheapGatesHold() {
    if (this.clients.size > 0) {
      log('DEBUG', 'idle tick: clients connected, reschedule');
      this._resetIdleTimer(INACTIVITY_RECHECK_MS);
      return true;
    }
    const liveSid = scanLiveHeartbeat(heartbeatDir(), {
      nowMs: now(),
      liveTtlMs: HOST_LIVENESS_TTL_MS,
      staleAfterMs: HEARTBEAT_STALE_AFTER_MS,
    });
    if (liveSid) {
      log('INFO', `idle tick: host ${liveSid} still active (heartbeat fresh) — extending`);
      this._resetIdleTimer(INACTIVITY_RECHECK_MS);
      return true;
    }
    return false;
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const client of [...this.clients.values()]) {
      try { client.sock.end?.(); } catch {}
      client.closed = true;
    }
    this.clients.clear();
    this.connection?.kill();
  }
}

// --- BrokerServer ------------------------------------------------------------

// The UDS. Startup hardening is the copilot daemon's, for the reason measured
// in the broker probe: SIGKILL skips the unlink handler, so a stale socket file
// outlives its broker and SOCKET PRESENCE IS NOT LIVENESS. The only safe test is
// a connect probe — ECONNREFUSED means safe to unlink, an accepted connection
// means a live broker we must not steal from.
//
// Probe-then-unlink-then-listen is not by itself safe against a SECOND broker
// running the same sequence: both see the same stale socket, both unlink, and
// the second one deletes the file the first is already serving on. So the whole
// sequence runs under an O_EXCL lock file beside the socket, and the bind is
// remembered by inode — the two hardenings are independent, and both are needed
// (the lock stops the double-bind, the inode stops one broker unlinking
// another's socket if a lock is ever bypassed or broken).
export class BrokerServer {
  constructor(broker, { socketPath = null } = {}) {
    this.broker = broker;
    this.socketPath = socketPath || codexBrokerSocketPath();
    this.lockPath = `${this.socketPath}.lock`;
    this.server = null;
    // Set only once WE bound the socket. The copilot daemon's exit handler
    // unlinks unconditionally, which means a second daemon that correctly
    // refuses to steal the socket deletes the live one's socket on its way out.
    this.bound = false;
    // …and `bound` alone is only "I bound A socket here once", which is not
    // ownership of whatever file is at the path NOW. The inode is.
    this.boundIno = null;
  }

  async start() {
    const socketPath = this.socketPath;
    const lock = acquireStartLock(this.lockPath);
    try {
      // lstat, not existsSync: existsSync FOLLOWS a symlink, so a DANGLING one
      // reports false and skips this entire block — and `listen()` then happily
      // creates the real socket at the link's target, outside the 0700 runtime
      // dir, where cleanup() would unlink the link and leave the socket behind.
      let st = null;
      try { st = lstatSync(socketPath); } catch { st = null; }

      if (st?.isSymbolicLink()) {
        const err = new Error(`socket path is a symlink; refusing to use it: ${socketPath}`);
        err.code = 'BROKER_SOCKET_SYMLINK';
        log('ERROR', err.message);
        throw err;
      }

      if (st) {
        const verdict = await _impl.probeSocket(socketPath);
        if (verdict === 'alive') {
          const err = new Error(`a broker is already listening at ${socketPath}`);
          err.code = 'BROKER_ALREADY_RUNNING';
          log('ERROR', err.message);
          throw err;
        }
        if (verdict !== 'absent') {
          // "I could not tell" — EMFILE under a wide fan-out, EACCES, EAGAIN.
          // Unlinking here would delete a LIVE broker's socket on evidence that
          // says nothing about liveness. Refusing is always the recoverable
          // direction: the caller re-probes and finds the incumbent.
          const err = new Error(`could not determine whether a broker owns ${socketPath} (${verdict})`);
          err.code = 'BROKER_SOCKET_INDETERMINATE';
          log('ERROR', err.message);
          throw err;
        }
        log('INFO', 'unlinking stale socket (connect probe refused):', socketPath);
        try { unlinkSync(socketPath); } catch {}
      }

      this.server = createServer((sock) => this.broker.attachClient(sock));
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(socketPath, () => {
          this.bound = true;
          try { this.boundIno = statSync(socketPath).ino; } catch { this.boundIno = null; }
          // Lock the socket to the owning user; the default umask leaves it 0666.
          try { chmodSync(socketPath, 0o600); }
          catch (err) { log('WARN', 'chmod socket failed:', err.message); }
          log('INFO', 'listening on', socketPath);
          resolve();
        });
      });
    } finally {
      lock.release();
    }
  }

  cleanup() {
    if (this.server) {
      // Note that libuv unlinks the pipe path itself on a graceful close, so
      // this half is by-path regardless of what we do — which is precisely why
      // the start lock, not the unlink, is what keeps two brokers off one path.
      try { this.server.close(); } catch {}
      this.server = null;
    }
    this.unlinkOwnedSocket();
  }

  // The backstop for every path that calls process.exit() outright (the idle
  // reaper, app-server death, the synchronous `process.on('exit')` handler),
  // where no graceful close ever runs.
  unlinkOwnedSocket() {
    if (!this.bound) return;
    this.bound = false;
    // Only the file we actually bound. If someone else's socket is at the path
    // now, deleting it would take a live broker off the air and leave its
    // clients connected to an inode nobody new can reach.
    try {
      if (this.boundIno !== null && statSync(this.socketPath).ino !== this.boundIno) {
        log('WARN', 'socket at', this.socketPath, 'is no longer the one we bound — leaving it alone');
        return;
      }
    } catch {
      return; // already gone
    }
    try { unlinkSync(this.socketPath); } catch {}
  }
}

// Serialise probe→unlink→listen across brokers. O_EXCL create is the only
// primitive that is atomic across processes on every filesystem we care about.
// The critical section is milliseconds, so contention means "another broker is
// booting right now" — refuse and let the caller re-probe, rather than wait.
const START_LOCK_STALE_MS = 30_000;

export function acquireStartLock(lockPath, { staleMs = START_LOCK_STALE_MS } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch {}
      closeSync(fd);
      return {
        path: lockPath,
        release() { try { unlinkSync(lockPath); } catch {} },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // A lock file is no more proof of liveness than a socket file is: a
      // SIGKILL inside the critical section leaves one behind forever.
      if (attempt === 0 && breakStaleStartLock(lockPath, staleMs)) continue;
      const contended = new Error(`another broker is starting; lock held at ${lockPath}`);
      contended.code = 'BROKER_START_CONTENDED';
      log('ERROR', contended.message);
      throw contended;
    }
  }
  /* c8 ignore next */
  throw new Error(`could not acquire the broker start lock at ${lockPath}`);
}

// Remove a start lock whose holder is demonstrably gone: a dead pid, or an age
// past `staleMs` (which also covers pid reuse and an unreadable lock file).
export function breakStaleStartLock(lockPath, staleMs = START_LOCK_STALE_MS) {
  let holder = null;
  let ageMs = Infinity;
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (typeof holder?.at === 'number') ageMs = Date.now() - holder.at;
  } catch {
    try { ageMs = Date.now() - statSync(lockPath).mtimeMs; } catch { ageMs = Infinity; }
  }
  const holderPid = Number.isInteger(holder?.pid) ? holder.pid : null;
  const holderAlive = holderPid !== null && holderPid !== process.pid && pidAlive(holderPid);
  if (holderAlive && ageMs <= staleMs) return false;
  if (holderPid === process.pid && ageMs <= staleMs) return false; // our own live critical section
  log('WARN', 'breaking a stale broker start lock:', lockPath, JSON.stringify({ holderPid, ageMs }));
  try { unlinkSync(lockPath); } catch {}
  return true;
}

// Connect-probe a socket path:
//   'alive'   something accepted the connection — a live broker, do not touch.
//   'absent'  ECONNREFUSED (stale socket file), ENOENT, ENOTSOCK (a plain file
//             left at the path) — nobody is home, safe to unlink.
//   otherwise the error code itself: EMFILE, EACCES, EAGAIN and friends mean
//             "the probe failed", NOT "nobody is home", and the caller must
//             refuse rather than unlink on that evidence.
const PROBE_ABSENT_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK']);

export function probeSocketVerdictForError(err) {
  return PROBE_ABSENT_CODES.has(err?.code) ? 'absent' : (err?.code || 'EUNKNOWN');
}

export function probeSocket(socketPath) {
  return new Promise((resolve) => {
    const probe = connectSocket(socketPath);
    probe.on('connect', () => { probe.destroy(); resolve('alive'); });
    probe.on('error', (err) => { probe.destroy(); resolve(probeSocketVerdictForError(err)); });
  });
}

// Boolean convenience: `true` means a live broker answered. Anything else —
// including an indeterminate probe — is false, so callers that must not unlink
// on a maybe use `probeSocket` instead.
export async function probeSocketAlive(socketPath) {
  return (await probeSocket(socketPath)) === 'alive';
}

// --- Main --------------------------------------------------------------------

// Same realpath-based isMain detection as server.mjs and the copilot daemon, so
// a symlinked argv[1] still matches. Everything above is importable and
// unit-drivable without opening a socket or spawning a codex.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

export async function main() {
  const connection = new AppServerConnection();
  const broker = new Broker({ connection });
  const server = new BrokerServer(broker);

  let exiting = false;
  const cleanupAndExit = (code) => {
    if (exiting) return;
    exiting = true;
    log('INFO', 'shutting down', JSON.stringify({ code }));
    broker.shutdown();
    server.cleanup();
    process.exit(code);
  };

  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));
  process.on('uncaughtException', (err) => {
    log('FATAL', 'uncaughtException:', err?.stack || String(err));
    cleanupAndExit(1);
  });
  process.on('unhandledRejection', (err) => {
    log('FATAL', 'unhandledRejection:', err?.stack || String(err));
  });
  // Synchronous backstop for anything that calls process.exit() directly — the
  // idle reaper, the app-server-death path. Only unlinks a socket we bound.
  process.on('exit', () => {
    try { broker.connection?.kill(); } catch {}
    server.unlinkOwnedSocket();
  });

  await server.start();
  connection.spawn();
  await connection.initialize();
  broker.flushPreInit();
  broker.startIdleReaper();
  log('INFO', 'broker ready:', JSON.stringify(broker.status()));
}

if (isMain) {
  main().catch((err) => {
    log('FATAL', 'failed to start broker:', err?.stack || String(err));
    console.error('failed to start codex app-server broker:', err?.message || err);
    process.exit(1);
  });
}
