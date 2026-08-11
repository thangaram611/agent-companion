// Codex app-server adapter — the bridge side of the broker.
//
// Unlike codex-runtime.mjs (single-shot `codex exec`), this adapter talks
// JSON-RPC to the long-lived broker that owns one `codex app-server`, so the
// bridge gains what the exec pipe structurally cannot give:
//   - survival: a subagent returning drops a socket client, not a job,
//   - real sub-turn streaming (`item/*Delta`) instead of one tick per shell call,
//   - mid-flight `turn/steer` and a `turn/interrupt` that leaves the thread live,
//   - `thread/resume` to rejoin a RUNNING thread after a bridge restart,
//   - `thread/read` as an over-RPC salvage channel instead of rollout parsing.
//
// Selected by `CODEX_RUNTIME_ADAPTER=appserver`, mirroring the existing
// `OPENCODE_RUNTIME_ADAPTER=server|cli` switch. `exec` stays the default so
// every existing test and behaviour survives untouched.
//
// Structure mirrors opencode-server-runtime.mjs section for section: adapter
// selection → injectable `_impl` seam → pure accumulator → transport client →
// ensure/health/leases/reaper → session ops → turn watcher. The transport is
// embedded here rather than split into a client module for the same reason it is
// there: this is one adapter, not a new layer.
//
// THREE CONSTRAINTS ARE STRUCTURAL, NOT COMMENTS (docs/RELIABILITY_REMEDIATION.md §2):
//   1. `approvalPolicy: 'never'` is built by `threadParams` and cannot be
//      overridden by a caller or by any env var. A measured `read-only` thread
//      that accepted ONE approval WROTE A FILE — auto-accept escalates past the
//      sandbox, so under `never` no approval request is ever sent and the
//      sandbox is the hard boundary.
//   2. `turn/start` on a thread that already has a running turn SUCCEEDS and
//      returns a second turn id. `startCodexTurn` is the only path that may send
//      it (the connection refuses a raw one), and it checks thread status first.
//   3. `thread not found` from `turn/interrupt`/`turn/steer` means "not loaded
//      into this process", NOT "gone" — the same thread `thread/resume`s fine.
//      The guard is structural: the connection resumes any thread it did not
//      itself start before either method reaches the wire.

import { spawn } from 'node:child_process';
import { connect as connectSocket } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

import {
  fileChangeToolCalls,
  resolveCodexBin,
  resolveCodexSandbox,
  resolveCodexTimeoutMs,
} from './codex-runtime.mjs';
import {
  BROKER_PROTOCOL_VERSION,
  LineReader,
  probeSocketVerdictForError,
} from '../scripts/codex-app-server-broker.mjs';
import { CODEX_PINNED_VERSION, routeNotification } from '../lib/codex-app-server-contract.mjs';
import { logEvent } from '../lib/log.mjs';
import { codexBrokerRegistryPath, codexBrokerSocketPath } from '../lib/runtime-paths.mjs';
import {
  createSharedRuntimeRegistry,
  deriveIdleTtlMs,
  disposalClaimedBy,
  pidAlive,
} from '../lib/shared-runtime-registry.mjs';
import { truncateChars, MAX_SUMMARY_CHARS } from '../lib/text-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Constants ---------------------------------------------------------------

// THE approval policy. Not configurable, by design — see the header. Passed on
// BOTH `thread/start` and `thread/resume`, because resume re-derives its context
// from config and omitting it is the measured silent-de-escalation trap the exec
// transport fell into.
const APPROVAL_POLICY = 'never';

const BROKER_PATH = process.env.CODEX_BROKER_PATH
  || pathResolve(__dirname, '..', 'scripts', 'codex-app-server-broker.mjs');

// The broker boots a `codex app-server` and handshakes with it. Codex starts
// every configured MCP server, so this is not instant (0.2-6.4 s measured for
// the two on this machine) — and the broker allows the handshake 30 s.
const BROKER_BOOT_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 5_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

// One broker per machine, at one fixed socket path.
const SHARED_BROKER_KEY = 'shared';

// Only these mean "nobody is listening, so spawn one". Anything else (EACCES on
// the runtime dir, EMFILE under a wide subagent fan-out) is a failure to ASK,
// not an answer — spawning on it would race a live broker.
const CONNECT_CLASS_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK', 'ETIMEDOUT']);

// A single `aggregated_output` can be a whole build log; the toolCalls entry is
// a digest-facing artifact, not a transcript. Same cap as codex-runtime.mjs.
const MAX_COMMAND_OUTPUT_CHARS = 4_000;

// Identifies this bridge to the BROKER, not to codex: the broker performs the
// one upstream `initialize` on everyone's behalf, so `session_meta.originator`
// carries the broker's name, not this one.
const CLIENT_NAME = 'agent-companion-bridge';

// `turn/start` may only be sent by `startCodexTurn`. A module-private symbol is
// what makes that structural rather than a convention: no call site outside this
// file can name the option that unlocks it.
const INTERNAL = Symbol('codex app-server internal call');

// Methods that must not reach the wire for a thread this connection did not
// itself start or resume. See constraint 3 and probes/codex-app-server/unloaded.mjs.
const ATTACH_BEFORE_METHODS = new Set(['turn/interrupt', 'turn/steer']);

// Responses whose `result.thread.id` means "this connection now owns that
// thread" — the same trigger the broker uses for its implicit subscription.
const OWNERSHIP_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork']);

const JSONRPC_METHOD_NOT_FOUND = -32601;

// ---------------------------------------------------------------------------
// Adapter selection
// ---------------------------------------------------------------------------

export function resolveCodexAdapter(env = process.env) {
  const raw = String(env.CODEX_RUNTIME_ADAPTER || 'exec').trim().toLowerCase();
  return raw === 'appserver' ? 'appserver' : 'exec';
}

export function codexAppServerActive(env = process.env) {
  return resolveCodexAdapter(env) === 'appserver';
}

// The sandbox, translated from the ONE env resolver the exec adapter already
// owns — `AGENT_COMPANION_CODEX_SANDBOX_MODE` must not grow a second parser that
// can disagree with it about what an unrecognised value means.
//
// `bypass` is an exec-transport spelling: on the CLI it is the single flag
// `--dangerously-bypass-approvals-and-sandbox`, which removes the sandbox AND
// the approvals. The app-server splits those into two independent params, and
// `approvalPolicy` is pinned to `never` here, so only the sandbox half carries
// over.
const APP_SERVER_SANDBOX_BY_EXEC_MODE = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'danger-full-access': 'danger-full-access',
  bypass: 'danger-full-access',
};

export function codexAppServerSandbox(env = process.env) {
  const exec = resolveCodexSandbox(env);
  return {
    mode: APP_SERVER_SANDBOX_BY_EXEC_MODE[exec.mode] || 'workspace-write',
    // Reported, deliberately NOT sent. On `codex exec` the network toggle is
    // `-c sandbox_workspace_write.network_access=…`; the app-server's param name
    // for it was never measured (docs/RELIABILITY_REMEDIATION.md §6 lists the
    // sandbox mapping as open), and inventing one would either fail open or fail
    // closed silently. `network_applied: false` says so out loud instead.
    network: exec.network,
    network_applied: false,
    source: exec.source,
  };
}

export function codexAppServerRuntimeInfo(env = process.env) {
  const info = {
    adapter: resolveCodexAdapter(env),
    bin: resolveCodexBin(env),
    socket: codexBrokerSocketPath(),
    broker: BROKER_PATH,
    sandbox: codexAppServerSandbox(env),
    approvalPolicy: APPROVAL_POLICY,
    timeout_ms: resolveCodexTimeoutMs(env),
    pinned_version: CODEX_PINNED_VERSION,
  };
  // Only present once a broker has actually told us. The protocol carries no
  // version field, so this is the sole runtime source, and an absent key is more
  // honest than a guess from `codex --version` we never made.
  if (_lastKnownCodexVersion) info.installed_version = _lastKnownCodexVersion;
  return info;
}

// Same prefix as the exec adapter's `codexPromptId`, so a job's artefacts are
// named by TARGET rather than by transport and nothing downstream has to know
// which adapter ran it. `replyTurn` mirrors openCodeServerPromptId.
export function codexAppServerPromptId(jobId, replyTurn = 0) {
  return replyTurn > 0 ? `codex-${jobId}-r${replyTurn}` : `codex-${jobId}`;
}

// ---------------------------------------------------------------------------
// Injectable I/O seam (defaults use real net/spawn/clock)
// ---------------------------------------------------------------------------

function realConnect(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = connectSocket(socketPath);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      const err = new Error(`timed out connecting to the codex broker at ${socketPath}`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    const onConnect = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.off('error', onError);
      sock.setEncoding('utf8');
      resolve(sock);
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    sock.once('connect', onConnect);
    sock.once('error', onError);
  });
}

// Detached + unref'd + stdio ignored: the whole point is that the broker
// OUTLIVES this bridge. Its own stdio must not be a pipe into a process that is
// about to be SIGINT'd, which is the failure mode the exec adapter has.
function realSpawnBroker({ env }) {
  const child = spawn(process.execPath, [BROKER_PATH], { detached: true, stdio: 'ignore', env });
  child.unref();
  return child;
}

let _impl = {
  now: () => Date.now(),
  connect: realConnect,
  spawnBroker: realSpawnBroker,
  logEvent,
};

export function _setForTest(overrides = {}) {
  _impl = { ..._impl, ...overrides };
}

export function _resetForTest() {
  _impl = { now: () => Date.now(), connect: realConnect, spawnBroker: realSpawnBroker, logEvent };
  brokerRegistry.clearCache();
  _spawnPromise = null;
  _reapPromise = null;
  _lastKnownCodexVersion = null;
  _lastDisposal = null;
}

// ---------------------------------------------------------------------------
// Thread params — where the two non-negotiable fields are built
// ---------------------------------------------------------------------------

// Built once, for `thread/start` AND `thread/resume`. `extra` is spread FIRST so
// a caller cannot overwrite `sandbox` or `approvalPolicy`; nothing here reads an
// env var for the policy, so no env var can relax it either.
//
// `model` is ABSENT unless a job pins one. `~/.codex/config.toml` (gpt-5.6-sol /
// xhigh here) is the single source of truth and inheritance is measured to work;
// passing `model: null` is NOT the same as omitting the key, so this must stay a
// conditional assignment rather than a default value. A pin is an override, and
// overrides get logged.
function threadParams(env, { model = null, ...extra } = {}) {
  const sandbox = codexAppServerSandbox(env);
  const params = { ...extra, sandbox: sandbox.mode, approvalPolicy: APPROVAL_POLICY };
  if (model) {
    params.model = model;
    _impl.logEvent('info', 'codex_appserver_model_pinned', { model, sandbox: sandbox.mode });
  }
  return params;
}

// ---------------------------------------------------------------------------
// Pure accumulator — terminal detection + transcript assembly
// ---------------------------------------------------------------------------
//
// Feed it plain app-server notification objects via push(); it tracks one
// thread's turn and reports a terminal verdict on `turn/completed` (including
// `status:"interrupted"`, which settles with NO answer), on a thread-scoped
// `error`, or on the broker's `broker/appServerDied`. No I/O — unit-testable
// directly, which is the point: this is where the transport's one real advantage
// over `codex exec --json` lives (F7 — that stream emits no deltas at all, so a
// reasoning-only turn produced no progress signal whatsoever).
//
// The summary it emits is the shape the bridge already consumes
// (`{message, thoughts, toolCalls, stopReason, error}`), so writeOpenCodeDigest,
// formatTerminalContent and isEmptyCompletedSummary work unchanged. There is no
// third digest writer here and there must not be one.

export function createCodexTurnAccumulator(threadId) {
  // itemId -> text, so a completed item replaces the deltas that streamed it
  // rather than doubling them. Insertion-ordered, which is what makes "the last
  // message" well defined.
  const messages = new Map();
  const messagePhases = new Map();
  const reasoning = new Map();
  const toolCalls = [];
  const commandEntries = new Map(); // itemId -> the toolCalls entry
  const completedItems = new Set(); // ids folded once (turn/completed replays them)
  let plan = null;
  let turnId = null;
  let errorText = null;
  let terminal = null;
  let sawEvent = false;

  // Does this frame belong to the thread we are watching? Resolved through the
  // pinned contract, never by reading `params.threadId` directly: 51 of 70
  // notifications carry it flat, `thread/started` nests it at
  // `params.thread.id`, and 18 are genuinely global.
  function forThisThread(method, params) {
    const { routing, threadId: id } = routeNotification(method, params);
    if (routing === 'global' || routing === 'unknown') return false;
    return !!id && id === threadId;
  }

  function bucketKey(params) {
    // Deltas that carry no item id all belong to the same streaming item; one
    // shared bucket keeps them in order instead of scattering them.
    return params?.itemId ?? params?.item?.id ?? '_';
  }

  function appendTo(map, key, text) {
    if (typeof text !== 'string' || !text) return;
    map.set(key, (map.get(key) || '') + text);
  }

  function commandEntryFor(item) {
    const id = item?.id == null ? null : String(item.id);
    if (id && commandEntries.has(id)) return commandEntries.get(id);
    // `in_progress` is a bridge-side state — codex has no such status — and is
    // what a turn that dies mid-command leaves behind. Outcome fields live on
    // the ENTRY, never inside `input`, so nothing a command reports back can
    // collide with formatTerminalContent's `tc.input.path` extraction.
    const entry = {
      name: 'shell',
      input: { command: item?.command ?? null },
      status: 'in_progress',
      exit_code: null,
      aggregated_output: null,
    };
    if (id) commandEntries.set(id, entry);
    toolCalls.push(entry);
    return entry;
  }

  function consumeStartedItem(item) {
    if (!item || typeof item !== 'object') return;
    // The only in-flight signal worth keeping. Every other item type reaches its
    // terminal form in one hop, so recording its `started` twin would just
    // double-count toolCalls.
    if (String(item.type || '') !== 'commandExecution') return;
    commandEntryFor(item);
  }

  // Idempotent per item id, because `turn/completed` replays the whole item list
  // — that replay is the salvage path for a bridge that attached mid-turn and
  // missed the live events, so it must add what was missed without duplicating
  // what was not.
  function consumeCompletedItem(item) {
    if (!item || typeof item !== 'object') return;
    const type = String(item.type || '');
    const id = item.id == null ? null : String(item.id);

    if (type === 'agentMessage') {
      const key = id || `msg-${messages.size}`;
      if (typeof item.text === 'string') messages.set(key, item.text);
      if (item.phase) messagePhases.set(key, String(item.phase));
      return;
    }
    if (type === 'reasoning') {
      const key = id || `rsn-${reasoning.size}`;
      if (typeof item.text === 'string' && item.text) reasoning.set(key, item.text);
      return;
    }
    if (type === 'commandExecution') {
      const entry = commandEntryFor(item);
      if (item.command != null) entry.input.command = item.command;
      // A missing `status` names the EVENT ('the item completed'), never the
      // exit outcome — the exit code stays authoritative there. Both spellings
      // are read because the app-server is camelCase where the exec stream was
      // snake_case, and only one of the two has ever been seen per transport.
      const status = item.status ?? item.state;
      entry.status = typeof status === 'string' && status ? status : 'completed';
      entry.exit_code = item.exitCode ?? item.exit_code ?? entry.exit_code ?? null;
      const output = item.aggregatedOutput ?? item.aggregated_output;
      if (typeof output === 'string' && output) {
        entry.aggregated_output = truncateChars(output, MAX_COMMAND_OUTPUT_CHARS);
      }
      return;
    }

    // Everything below has no in-flight twin to fold into, so it needs the
    // replay guard.
    if (id && completedItems.has(id)) return;
    if (id) completedItems.add(id);

    if (type === 'fileChange') {
      for (const change of fileChangeToolCalls(item)) toolCalls.push(change);
      return;
    }
    if (type === 'mcpToolCall') {
      toolCalls.push({ name: item.tool || item.name || 'mcpToolCall', input: item.input || item.args || {} });
      return;
    }
    if (type === 'webSearch') {
      toolCalls.push({ name: 'webSearch', input: { query: item.query ?? null } });
      return;
    }
    if (type === 'error') {
      // Item-level errors are NON-fatal on this protocol exactly as on the exec
      // stream: only `turn/completed` and the thread-scoped `error` notification
      // end a turn. Recorded so the digest can show it.
      errorText = errorText || item.message || item.error || 'codex reported an item error';
    }
    // todoList and anything unrecognised are tolerated without contributing.
  }

  function settle(status, { error = null, reason = null } = {}) {
    if (terminal) return;
    if (error) errorText = errorText || error;
    terminal = { status, reason, error: errorText };
  }

  function onNotification(method, params) {
    switch (method) {
      case 'item/agentMessage/delta':
        appendTo(messages, bucketKey(params), params?.delta ?? params?.text);
        return;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        appendTo(reasoning, bucketKey(params), params?.delta ?? params?.text);
        return;
      case 'item/commandExecution/outputDelta': {
        const entry = commandEntries.get(String(params?.itemId ?? ''));
        if (!entry) return;
        // The payload field name was never captured off the wire (the probes
        // logged this method's params truncated), so read the plausible spellings
        // rather than silently dropping a live command's output.
        const chunk = params?.chunk ?? params?.delta ?? params?.output ?? params?.text;
        if (typeof chunk !== 'string' || !chunk) return;
        entry.aggregated_output = truncateChars(`${entry.aggregated_output || ''}${chunk}`, MAX_COMMAND_OUTPUT_CHARS);
        return;
      }
      case 'item/started':
        consumeStartedItem(params?.item);
        return;
      case 'item/completed':
        consumeCompletedItem(params?.item);
        return;
      case 'turn/plan/updated':
        // Carried into the summary because isEmptyCompletedSummary counts a plan
        // as content: a turn that only replanned must not read as "completed but
        // returned nothing".
        plan = params?.plan ?? params?.steps ?? plan;
        return;
      case 'turn/started':
        turnId = params?.turn?.id ?? params?.turnId ?? turnId;
        return;
      case 'turn/completed': {
        const turn = params?.turn || {};
        turnId = turn.id ?? turnId;
        for (const item of Array.isArray(turn.items) ? turn.items : []) consumeCompletedItem(item);
        const status = String(turn.status || '');
        const failure = turn.error?.message || turn.error || turn.failure || null;
        if (status === 'interrupted') {
          // Settles with no answer — that is the documented shape of a
          // `turn/interrupt`, not a failure.
          settle('cancelled', { reason: 'interrupted' });
        } else if (status === 'completed') {
          settle('completed', { reason: 'turn/completed' });
        } else {
          settle('failed', { reason: status || 'turn/completed', error: failure || `codex turn ended ${status || 'in an unknown state'}` });
        }
        return;
      }
      case 'error':
        settle('failed', { reason: 'error', error: params?.message || params?.error?.message || params?.error || 'codex reported a fatal error' });
        return;
      default:
        // thread/status/changed, tokenUsage, mcpServer/startupStatus and the rest
        // are observability only.
    }
  }

  function resolvedMessage() {
    // `phase` is what makes the exec digest's central problem go away: on that
    // transport every intermediate message was a 211-418 char preamble
    // indistinguishable from the answer. Here the answer says so.
    const finals = [...messages.entries()].filter(([key]) => messagePhases.get(key) === 'final_answer');
    const chosen = finals.length ? finals : [...messages.entries()];
    if (!chosen.length) return '';
    return chosen[chosen.length - 1][1] || '';
  }

  return {
    // Feed one app-server notification frame. Frames for other threads and
    // frames that are not notifications are ignored.
    // Returns whether the frame belonged to this thread, so a caller can skip
    // re-rendering a progress snapshot that cannot have changed.
    push(msg) {
      if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return false;
      const { method, params } = msg;
      if (method === 'broker/appServerDied') {
        // Nothing on that app-server survives; say so rather than waiting out a
        // watch timeout the caller cannot interpret.
        sawEvent = true;
        settle('unreachable', {
          reason: 'app-server-died',
          error: `the codex app-server exited (code=${params?.code ?? 'null'}, signal=${params?.signal ?? 'null'}); the in-flight turn was lost`,
        });
        return true;
      }
      if (!forThisThread(method, params)) return false;
      sawEvent = true;
      onNotification(method, params);
      return true;
    },
    get terminal() { return terminal; },
    get sawEvent() { return sawEvent; },
    get turnId() { return turnId; },
    snapshot() {
      const snap = {
        message: truncateChars(resolvedMessage(), MAX_SUMMARY_CHARS),
        thoughts: truncateChars([...reasoning.values()].filter(Boolean).join('\n'), MAX_SUMMARY_CHARS),
        toolCalls: [...toolCalls],
        error: errorText,
      };
      if (plan != null) snap.plan = plan;
      return snap;
    },
  };
}

// ---------------------------------------------------------------------------
// Transport — a persistent duplex socket to the broker
// ---------------------------------------------------------------------------
//
// NOT daemon-client.mjs's one-shot request/response: notifications stream for
// the whole life of a turn, so the socket has to stay open and multiplex
// responses, notifications and server→client requests over one framing.
//
// `env` is captured for the connection's lifetime because the resume-before-act
// guard fires from inside `call()`, where no caller is present to supply one —
// so the sandbox a re-attached thread gets is the sandbox this connection was
// opened with. Open one connection per job env, not one per bridge.

export async function connectCodexBroker({
  socketPath = null,
  env = process.env,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
} = {}) {
  const path = socketPath || codexBrokerSocketPath();
  const sock = await _impl.connect(path, connectTimeoutMs);
  const conn = createConnection(sock, { socketPath: path, env });

  // The broker answers `initialize` locally — it already handshook upstream on
  // everyone's behalf — so this costs one round-trip on a unix socket and buys
  // the protocol check plus the readiness flags.
  //
  // A handshake that fails must take the socket with it. `probeCodexBrokerHealth`
  // runs on every ensure and on every reaper tick against a path that may hold a
  // wedged listener, and a leaked fd per probe is how a long-lived bridge walks
  // into EMFILE — which is also the verdict that makes the socket hardening
  // refuse to do anything at all.
  let info;
  try {
    info = await conn.call('initialize', { clientInfo: { name: CLIENT_NAME, version: String(BROKER_PROTOCOL_VERSION) } }, { timeoutMs });
  } catch (err) {
    conn.close();
    throw err;
  }
  if (info?.protocol !== BROKER_PROTOCOL_VERSION) {
    conn.close();
    throw new Error(
      `codex broker speaks protocol ${info?.protocol ?? 'unknown'}, this bridge speaks ${BROKER_PROTOCOL_VERSION}. `
      + 'Stop the running broker so the next dispatch spawns a matching one.',
    );
  }
  if (info.codexVersion) _lastKnownCodexVersion = info.codexVersion;
  conn.broker = info;
  return conn;
}

function createConnection(sock, { socketPath, env }) {
  const reader = new LineReader();
  const pending = new Map();          // downstream id -> { resolve, reject, timer, method }
  const handlers = new Set();
  // Threads this connection started or resumed. The resume-before-act guard is
  // a lookup in here, so it cannot be forgotten at a call site.
  const attached = new Set();
  // Threads started here that have not had a turn yet, so their status is known
  // to be idle without asking. `thread/resume` on a thread with no turns has no
  // rollout to read, so not asking is both cheaper and safer.
  const fresh = new Set();
  let nextId = 1;
  let closed = false;
  let closeReason = null;
  let resolveClosed;
  const whenClosed = new Promise((resolve) => { resolveClosed = resolve; });

  function fail(reason) {
    if (closed) return;
    closed = true;
    closeReason = reason;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`codex broker connection closed before ${entry.method} answered: ${reason}`));
    }
    pending.clear();
    resolveClosed(reason);
  }

  sock.on('data', (chunk) => {
    const { lines, dropped } = reader.push(String(chunk));
    // Logged, not fatal — the reader resyncs at the next newline, and tearing
    // the connection down would abandon a live turn over one bad frame. A
    // dropped response still surfaces, as that call's timeout.
    if (dropped) _impl.logEvent('error', 'codex_appserver_frame_dropped', { dropped, socketPath });
    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onFrame(msg);
    }
  });
  sock.on('error', (err) => fail(err.message));
  sock.on('close', () => fail(closeReason || 'the broker closed the socket'));

  function onFrame(msg) {
    if (!msg || typeof msg !== 'object') return;
    const hasId = msg.id !== undefined && msg.id !== null;

    if (hasId && typeof msg.method === 'string') {
      // A server→client request. Under `approvalPolicy: 'never'` no approval is
      // ever sent, so anything arriving here is outside what this bridge
      // implements — and leaving it unanswered would block the app-server's turn
      // forever. Answer -32601, then let observers see it.
      write({ jsonrpc: '2.0', id: msg.id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: `agent-companion bridge does not implement ${msg.method}` } });
      _impl.logEvent('warn', 'codex_appserver_server_request_declined', { method: msg.method });
      notifyHandlers(msg);
      return;
    }
    if (hasId) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        // Every app-server error is JSON-RPC -32600; only the message
        // distinguishes them, so both are carried and neither is interpreted here.
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.code = msg.error.code;
        err.method = entry.method;
        entry.reject(err);
        return;
      }
      noteOwnership(entry.method, msg.result);
      entry.resolve(msg.result);
      return;
    }
    notifyHandlers(msg);
  }

  function noteOwnership(method, result) {
    if (!OWNERSHIP_METHODS.has(method)) return;
    const id = result?.thread?.id;
    if (typeof id === 'string' && id) attached.add(id);
  }

  function notifyHandlers(msg) {
    for (const handler of [...handlers]) {
      try { handler(msg); } catch { /* an observer's exception is not the stream's problem */ }
    }
  }

  function write(frame) {
    if (closed) return false;
    try { sock.write(`${JSON.stringify(frame)}\n`); return true; }
    catch (err) { fail(err.message); return false; }
  }

  function raw(method, params, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
    if (closed) return Promise.reject(new Error(`codex broker connection is closed (${closeReason})`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex broker request timed out after ${timeoutMs} ms (method=${method})`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer, method });
      if (!write({ jsonrpc: '2.0', id, method, params })) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`codex broker connection is closed (${closeReason})`));
      }
    });
  }

  // Resume a thread this connection did not start, so `turn/interrupt` and
  // `turn/steer` never meet the `thread not found` that means "not loaded here".
  // Measured (probes/codex-app-server/unloaded.mjs): a thread whose app-server
  // was SIGKILLed answers `thread not found` to both, while `thread/resume` on
  // the same id succeeds `idle`.
  //
  // No `model` here, unlike the resumes in resumeCodexThread/startCodexTurn.
  // This one is an ATTACH, not a context re-establishment: interrupt cancels,
  // and steer injects into a turn whose model was fixed when that turn started.
  // The sandbox still goes, because it is what the thread is allowed to do.
  async function attach(method, params, opts) {
    const threadId = params?.threadId;
    if (!threadId) throw new Error(`${method} requires params.threadId`);
    if (attached.has(threadId)) return;
    await raw('thread/resume', threadParams(env, { threadId }), opts);
    attached.add(threadId);
  }

  const conn = {
    socketPath,
    broker: null,
    get closed() { return closed; },
    get closeReason() { return closeReason; },
    whenClosed,

    async call(method, params = {}, opts = {}) {
      if (method === 'turn/start') {
        if (opts[INTERNAL] !== true) {
          throw new Error(
            'turn/start must go through startCodexTurn(): a turn/start on a thread that already has a '
            + 'running turn SUCCEEDS and returns a second turn id, so the status check is not optional.',
          );
        }
        const result = await raw(method, params, opts);
        // The thread has had a turn now, so its status is no longer knowable
        // without asking — every later turn on it goes through a real resume.
        if (params?.threadId) fresh.delete(params.threadId);
        return result;
      }
      if (ATTACH_BEFORE_METHODS.has(method)) await attach(method, params, opts);
      return raw(method, params, opts);
    },

    notify(method, params = {}) {
      return write({ jsonrpc: '2.0', method, params });
    },

    // Register a frame observer. Returns the detach function.
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    subscribe(threadId, opts = {}) {
      return raw('broker/subscribe', { threadId }, opts);
    },

    unsubscribe(threadId, opts = {}) {
      return raw('broker/unsubscribe', { threadId }, opts);
    },

    // 'fresh'    started here, no turn yet — status is idle by construction.
    // 'attached' started or resumed here — safe to interrupt/steer directly.
    // 'unknown'  someone else's thread, or one from a previous bridge.
    threadState(threadId) {
      if (fresh.has(threadId)) return 'fresh';
      if (attached.has(threadId)) return 'attached';
      return 'unknown';
    },

    // Called by startCodexThread; kept off `call` so a thread only counts as
    // fresh when this connection is the one that created it.
    _noteFreshThread(threadId) {
      if (threadId) { attached.add(threadId); fresh.add(threadId); }
    },

    close() {
      if (!closed) {
        try { sock.end(); } catch { /* already gone */ }
        try { sock.destroy(); } catch { /* already gone */ }
      }
      fail(closeReason || 'closed by this bridge');
    },
  };
  return conn;
}

// ---------------------------------------------------------------------------
// The shared broker — ONE detached process per machine, at one fixed socket
// ---------------------------------------------------------------------------

// Ownership — leases, stale pruning, the two-phase disposal claim and the idle
// reaper — lives in the runtime-neutral registry module. Only the broker-shaped
// parts are supplied here.
//
// IDENTITY IS PATH + PID, not the path alone. opencode can key on its base URL
// because a replacement server gets a new `--port 0` port; the broker's socket
// path is FIXED, so a broker and the broker that replaced it after a crash would
// be "the same runtime" under a path-only identity — and a disposal claim taken
// against the dead one would then authorise SIGTERMing the live one, and
// `forget()` would erase the replacement's entry and its leases. The pid is what
// distinguishes them. An entry missing either half cannot be reasoned about at
// all, so it identifies as null and the reaper skips it.
const brokerRegistry = createSharedRuntimeRegistry({
  registryPath: codexBrokerRegistryPath,
  key: SHARED_BROKER_KEY,
  identity: (entry) => (entry?.socketPath && entry?.pid ? `${entry.socketPath}#${entry.pid}` : null),
  dispose: (entry) => disposeBroker(entry),
});

let _spawnPromise = null;
let _reapPromise = null;
let _lastKnownCodexVersion = null;
// What `dispose` actually did. The registry's reapIdle reports "the entry was
// claimed and disposed"; ours must report "the broker was stopped", and those
// differ exactly when dispose refuses (see disposeBroker).
let _lastDisposal = null;

// How long the broker may sit unused before this side reaps it. Derived from the
// codex job budget for the same reason opencode's is: two independently chosen
// numbers drift, and a job that simply ran long then looks indistinguishable
// from an idle runtime.
const MIN_IDLE_TTL_MS = 30 * 60 * 1000;
const IDLE_TTL_GRACE_MS = 5 * 60 * 1000;

export function codexBrokerIdleTtlMs(env = process.env) {
  return deriveIdleTtlMs({
    jobTimeoutMs: resolveCodexTimeoutMs(env),
    floorMs: MIN_IDLE_TTL_MS,
    graceMs: IDLE_TTL_GRACE_MS,
  });
}

// Liveness AND readiness in one probe.
//
// Liveness is `broker/status` — the documented probe. Readiness is
// `initialize`'s `appServerInitialized && codexVersionProbed`, and NOT a truthy
// `codexVersion`: null is a legitimate terminal outcome of the async
// `codex --version` probe (an unparseable wrapper banner, a timeout), already
// WARNed by the broker, and a client gating on it would wait out its own timeout
// against a broker that is serving perfectly.
export async function probeCodexBrokerHealth(socketPath = null) {
  const path = socketPath || codexBrokerSocketPath();
  let conn = null;
  try {
    conn = await connectCodexBroker({ socketPath: path, connectTimeoutMs: HEALTH_PROBE_TIMEOUT_MS, timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
    const status = await conn.call('broker/status', {}, { timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
    if (status?.ok !== true) throw new Error(`the codex broker at ${path} answered broker/status without ok:true`);
    const info = conn.broker || {};
    return {
      alive: true,
      ready: !!(info.appServerInitialized && info.codexVersionProbed),
      socketPath: path,
      protocol: info.protocol ?? null,
      brokerPid: info.brokerPid ?? status?.brokerPid ?? null,
      appServerPid: info.appServerPid ?? status?.appServerPid ?? null,
      codexVersion: info.codexVersion ?? null,
      clients: status?.clients ?? null,
      uptimeMs: status?.uptimeMs ?? null,
      error: null,
      code: null,
    };
  } catch (err) {
    return { alive: false, ready: false, socketPath: path, error: err.message, code: err.code || null };
  } finally {
    try { conn?.close(); } catch { /* best effort */ }
  }
}

// Resolve the shared broker, reusing a live one and spawning a detached one
// otherwise. Concurrent callers share ONE spawn — without the mutex two parallel
// dispatches each spawn a broker and race on the socket file, and the loser's
// start-lock refusal is a dispatch failure for no reason.
export async function ensureCodexBroker({ env = process.env } = {}) {
  const socketPath = codexBrokerSocketPath();

  const health = await probeCodexBrokerHealth(socketPath);
  if (health.alive) {
    const ready = health.ready ? health : await waitForReady(socketPath, BROKER_BOOT_TIMEOUT_MS);
    return adopt(ready, { reused: true });
  }
  // Only a connect-class failure means "nobody is home". Anything else is a
  // failure to ask, and spawning on it would race a broker that is very much
  // alive — so it surfaces instead of degrading silently.
  if (!CONNECT_CLASS_CODES.has(health.code)) {
    throw new Error(`could not reach the codex broker at ${socketPath}: ${health.error}`);
  }

  if (_spawnPromise) return _spawnPromise;
  _spawnPromise = spawnAndAdoptBroker(env, socketPath);
  try { return await _spawnPromise; }
  finally { _spawnPromise = null; }
}

// Adopting a broker another bridge has CLAIMED for disposal is safe here, and it
// is worth saying why, because the opencode adapter refuses the equivalent.
// There, a claimed server was about to be disposed and adopting it handed a job
// a runtime that died mid-turn — so it spawned its own instead. It could: its
// address is an ephemeral port. This broker's address is a fixed socket path, so
// "spawn my own" is not available, and it is not needed: recording our adoption
// bumps `lastUsedAt`, which makes the claimer stand down at its own confirm
// step, and `disposeBroker` re-asks `thread/loaded/list` immediately before the
// kill. The residual window is an adopted broker with no thread on it yet, whose
// worst case is one redundant spawn and no lost work. It is reported rather than
// hidden.
function adopt(health, { reused }) {
  if (health.codexVersion) _lastKnownCodexVersion = health.codexVersion;
  const entry = { socketPath: health.socketPath, pid: health.brokerPid, appServerPid: health.appServerPid };

  // Merge only into the SAME broker. A recorded entry with a different pid
  // describes the broker this one replaced, and its `disposing` claim and its
  // leases both belong to that dead process — carrying them over would attach a
  // stale disposal claim to a live broker, and would credit it with leases whose
  // work is long gone. Their owners re-stamp real leases on the next tick.
  const recorded = brokerRegistry.read();
  const same = recorded?.socketPath === entry.socketPath && recorded?.pid === entry.pid;
  const claim = same ? disposalClaimedBy(recorded) : null;
  if (claim) {
    _impl.logEvent('warn', 'codex_appserver_adopted_over_disposal_claim', { pid: health.brokerPid, claimedBy: claim.pid });
  }
  brokerRegistry.setCached(entry);
  brokerRegistry.record(same ? { ...recorded, ...entry } : entry);
  return { socketPath: health.socketPath, pid: health.brokerPid, reused, disposalClaimed: !!claim };
}

async function spawnAndAdoptBroker(env, socketPath) {
  if (!existsSync(BROKER_PATH)) throw new Error(`codex app-server broker not found at ${BROKER_PATH}`);
  // The child must bind the same path this process just probed, whatever `env`
  // the caller passed — otherwise a test (or an operator with an override in
  // process.env only) waits on a socket nobody is going to create.
  const child = _impl.spawnBroker({ env: { ...env, CODEX_BROKER_SOCKET_PATH: socketPath } });
  let exited = null;
  child.on?.('exit', (code, signal) => { exited = { code, signal }; });

  const health = await waitForReady(socketPath, BROKER_BOOT_TIMEOUT_MS, () => exited);
  return adopt(health, { reused: false });
}

// Exponential backoff, fastest case ~50 ms. `exitedProbe` lets the spawn path
// fail fast and say WHY instead of waiting out the whole boot budget on a broker
// that already died (a stolen socket, a missing codex binary).
async function waitForReady(socketPath, budgetMs, exitedProbe = null) {
  const delays = [50, 100, 200, 400, 800];
  const start = _impl.now();
  let attempt = 0;
  for (;;) {
    const exited = exitedProbe?.();
    if (exited) {
      throw new Error(`the codex broker exited before it was ready (code=${exited.code}, signal=${exited.signal}); see the broker log`);
    }
    const health = await probeCodexBrokerHealth(socketPath);
    if (health.alive && health.ready) return health;
    if (_impl.now() - start >= budgetMs) {
      throw new Error(`the codex broker at ${socketPath} did not become ready within ${budgetMs} ms (${health.error || 'app-server handshake incomplete'})`);
    }
    await new Promise((r) => { const t = setTimeout(r, delays[Math.min(attempt, delays.length - 1)]); if (t.unref) t.unref(); });
    attempt += 1;
  }
}

// Stop a broker the reaper has claimed — but only after ASKING it. The registry
// cannot know what the broker is holding: a bridge that died mid-turn leaves no
// lease after LEASE_STALE_MS, and the turn it started is exactly the work this
// transport exists to protect. `thread/loaded/list` is the authoritative answer
// (immune to PID reuse, unlike any pid probe).
//
// A refusal here still lets the registry forget the entry. That is harmless
// precisely because the broker's address is a fixed path, not an ephemeral port:
// the next ensureCodexBroker connect-probes, finds it and re-records it.
async function disposeBroker(entry) {
  _lastDisposal = null;
  let conn = null;
  try {
    conn = await connectCodexBroker({ socketPath: entry.socketPath, connectTimeoutMs: HEALTH_PROBE_TIMEOUT_MS, timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
    const loaded = await listLoadedCodexThreads({ conn, timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
    if (loaded.length > 0) {
      _lastDisposal = 'refused';
      return;
    }
  } catch (err) {
    // ECONNREFUSED/ENOENT: the broker is already gone, nothing to stop. Anything
    // else is a probe that FAILED, which says nothing about liveness — refuse
    // rather than SIGTERM a broker we could not interrogate.
    if (probeSocketVerdictForError(err) !== 'absent') {
      _lastDisposal = 'refused';
      return;
    }
  } finally {
    try { conn?.close(); } catch { /* best effort */ }
  }

  // SIGTERM, not SIGKILL: the broker's handler stops its app-server child and
  // unlinks its own socket, and SIGKILL is what leaves the stale socket file
  // behind that every later start has to connect-probe around.
  if (pidAlive(entry.pid)) {
    try { process.kill(entry.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  _lastDisposal = 'stopped';
}

// Snapshot of the shared broker for status/observability.
export function codexBrokerSnapshot() {
  return brokerRegistry.snapshot();
}

// Publish this process's in-flight app-server jobs as leases on the shared
// broker, and prune every abandoned lease while we hold the file.
export function syncCodexBrokerLeases(jobIds = [], opts = {}) {
  return brokerRegistry.syncLeases(jobIds, opts);
}

// Best-effort idle reaper. Returns true only when the broker was actually
// stopped — `dispose` refuses a broker with threads loaded, and reporting that
// as a reap would tell an operator work was cleaned up when it is still running.
export async function reapIdleCodexBroker({ idleMs, hasLiveJobs = false, now = Date.now() } = {}) {
  // Serialised for the same reason the spawn is: `_lastDisposal` is how the
  // dispose action reports back, and two overlapping reaps in one process would
  // read each other's answer. The reaper runs on a GC tick, so sharing the
  // in-flight result is the correct answer for a second caller, not a compromise.
  if (_reapPromise) return _reapPromise;
  _reapPromise = (async () => {
    _lastDisposal = null;
    const claimed = await brokerRegistry.reapIdle({ idleMs, hasLiveJobs, now });
    return claimed && _lastDisposal === 'stopped';
  })();
  try { return await _reapPromise; }
  finally { _reapPromise = null; }
}

// A broker another bridge has claimed for disposal is about to stop answering
// even though it is healthy right now; adopting it would hand this job a runtime
// that dies underneath it.
export function codexBrokerDisposalClaim(now = Date.now()) {
  return disposalClaimedBy(brokerRegistry.read(), now);
}

// Re-exported because the adapter's own tests reason in lease-staleness terms
// and should not have to know where the machinery lives.
export { LEASE_STALE_MS } from '../lib/shared-runtime-registry.mjs';

// ---------------------------------------------------------------------------
// Thread and turn operations
// ---------------------------------------------------------------------------

export async function startCodexThread({ conn, cwd, env = process.env, model = null, timeoutMs = DEFAULT_CALL_TIMEOUT_MS }) {
  // `ephemeral: false` is the app-server spelling of "never pass --ephemeral":
  // the rollout on disk is the salvage channel of last resort and the only thing
  // that survives a broker death, so a job must never be started without one.
  const params = threadParams(env, { cwd, ephemeral: false, model });
  const result = await conn.call('thread/start', params, { timeoutMs });
  const threadId = result?.thread?.id;
  if (!threadId) throw new Error('codex thread/start returned no thread id');
  conn._noteFreshThread(threadId);
  return { threadId, rolloutPath: result.thread.path ?? null, thread: result.thread };
}

// Resume is BOTH the reattach and the authoritative status read: it rejoins a
// running thread, and its `thread.status` is the only place this protocol
// reports whether a turn is in flight.
//
// `sandbox` and `approvalPolicy` are sent explicitly here, not just on start.
// Resume re-derives its context from config when they are omitted, which on the
// exec transport was measured to silently DE-escalate a workspace-write thread
// to read-only and surface as an unexplained model refusal.
//
// An explicit `model` pin travels with them for the same reason and is treated
// with the same suspicion: whether app-server resume re-derives the model from
// config the way the exec CLI re-derives the sandbox was never measured, and the
// two failure modes are indistinguishable from outside (a job silently served by
// a different model than it asked for). Re-sending a pin the caller already made
// costs one field; not re-sending it costs a silent behaviour change.
export async function resumeCodexThread({ conn, threadId, env = process.env, model = null, timeoutMs = DEFAULT_CALL_TIMEOUT_MS }) {
  const result = await conn.call('thread/resume', threadParams(env, { threadId, model }), { timeoutMs });
  const thread = result?.thread || {};
  return {
    threadId: thread.id || threadId,
    status: String(thread.status?.type || thread.status || 'unknown'),
    flags: thread.status?.flags || [],
    thread,
  };
}

// 'active' | 'idle' | 'notLoaded' | 'systemError' | 'unknown'.
//
// NOT a pure read: on this protocol `thread/resume` IS the status read, so
// asking the question loads the thread into the app-server and attaches this
// connection to it. That is exactly what the callers here want (it is also the
// resume-before-act guard), but it means a status surface must not call this
// speculatively for threads it does not intend to touch.
export async function getCodexThreadStatus({ conn, threadId, env = process.env, model = null, timeoutMs = DEFAULT_CALL_TIMEOUT_MS }) {
  const resumed = await resumeCodexThread({ conn, threadId, env, model, timeoutMs });
  return resumed.status;
}

// The salvage channel. Measured caveat: `thread/read` returns MESSAGES ONLY —
// no commandExecution, no reasoning — even though the rollout for the same
// thread has all three. So this is a complete ANSWER salvage and not a
// tool-activity record, and its summary says so by carrying no toolCalls.
export async function readCodexThread({ conn, threadId, includeTurns = true, timeoutMs = DEFAULT_CALL_TIMEOUT_MS }) {
  const result = await conn.call('thread/read', { threadId, includeTurns }, { timeoutMs });
  const messages = collectAgentMessages(result);
  const finals = messages.filter((m) => m.phase === 'final_answer');
  const chosen = (finals.length ? finals : messages).at(-1);
  return {
    found: messages.length > 0,
    threadId,
    summary: {
      message: truncateChars(chosen?.text || '', MAX_SUMMARY_CHARS),
      thoughts: '',
      toolCalls: [],
      stopReason: 'thread/read',
      error: null,
    },
    raw: result,
  };
}

// The exact envelope `thread/read` returns was never captured off the wire (the
// probe wrote it to a file nobody committed), so this walks whatever nesting it
// arrives in rather than asserting a shape that would break on the first
// reorganisation. Bounded depth, because the payload can be KBs.
function collectAgentMessages(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectAgentMessages(child, out, depth + 1);
    return out;
  }
  if (node.type === 'agentMessage' && typeof node.text === 'string') {
    out.push({ text: node.text, phase: node.phase ? String(node.phase) : null });
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectAgentMessages(value, out, depth + 1);
  }
  return out;
}

export async function listLoadedCodexThreads({ conn, timeoutMs = DEFAULT_CALL_TIMEOUT_MS }) {
  const result = await conn.call('thread/loaded/list', {}, { timeoutMs });
  return Array.isArray(result?.data) ? result.data : [];
}

// THE ONLY path that may send `turn/start` — the connection refuses a raw one.
//
// `turn/start` on a thread that already has a turn in progress SUCCEEDS and
// returns a NEW turn id rather than rejecting, so a caller that does not check
// status first silently double-dispatches the job: two turns, two bills, two
// sets of edits. `active` therefore attaches to the running turn instead.
export async function startCodexTurn({ conn, threadId, prompt, env = process.env, model = null, timeoutMs = DEFAULT_CALL_TIMEOUT_MS }) {
  if (!threadId) throw new Error('startCodexTurn requires a threadId');
  // A thread this connection just created has had no turn, so its status is idle
  // by construction — and resuming it would ask about a rollout that does not
  // exist yet.
  //
  // `model` is forwarded because the status read is a real `thread/resume`: a
  // job's pin has to survive it, exactly as its sandbox does.
  const status = conn.threadState(threadId) === 'fresh'
    ? 'idle'
    : await getCodexThreadStatus({ conn, threadId, env, model, timeoutMs });

  if (status === 'active') {
    return { threadId, turnId: null, attached: true, status };
  }
  const result = await conn.call(
    'turn/start',
    { threadId, input: [{ type: 'text', text: prompt == null ? '' : String(prompt) }] },
    { timeoutMs, [INTERNAL]: true },
  );
  return { threadId, turnId: result?.turn?.id ?? null, attached: false, status };
}

// Mid-flight injection. Applied at the next model boundary, never mid-write:
// measured against an in-flight apply_patch, the patch completed atomically and
// the steer landed 0.14 s later as a userMessage.
export async function steerCodexTurn({ conn, threadId, prompt, expectedTurnId = null, timeoutMs = DEFAULT_CALL_TIMEOUT_MS }) {
  const params = { threadId, input: [{ type: 'text', text: prompt == null ? '' : String(prompt) }] };
  if (expectedTurnId) params.expectedTurnId = expectedTurnId;
  return conn.call('turn/steer', params, { timeoutMs });
}

// Cancels the turn; the THREAD stays live and resumable. The turn settles
// `status:"interrupted"` with no answer, which the accumulator reports as
// cancelled rather than failed.
export async function interruptCodexTurn({ conn, threadId, turnId = null, timeoutMs = DEFAULT_CALL_TIMEOUT_MS }) {
  const params = { threadId };
  if (turnId) params.turnId = turnId;
  return conn.call('turn/interrupt', params, { timeoutMs });
}

// ---------------------------------------------------------------------------
// Turn watcher — subscribe, stream, resolve on terminal
// ---------------------------------------------------------------------------
//
// `openCodexTurnWatcher` is async: it resolves once the thread subscription is
// established, so a caller can safely fire `startCodexTurn` without racing the
// first notification. Detection is level- AND edge-triggered, mirroring the
// opencode watcher:
//   - level: an optional status + `thread/read` check closes the "the turn
//     finished while this bridge was down" race, needed by restart resume;
//   - edge:  the accumulator settles on turn/completed / error / appServerDied;
//   - fallback: a connection that drops without a terminal re-probes the broker
//     to tell "the broker died and took the turn" from "this bridge lost its
//     socket while the turn kept running" — which are opposite verdicts here.

export async function openCodexTurnWatcher({
  conn,
  threadId,
  onEvent = null,
  timeoutMs = null,
  initialLevelCheck = false,
  env = process.env,
}) {
  if (!conn) throw new Error('openCodexTurnWatcher requires a broker connection');
  if (!threadId) throw new Error('openCodexTurnWatcher requires a threadId');

  const acc = createCodexTurnAccumulator(threadId);
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });

  const detach = conn.on((msg) => {
    if (!acc.push(msg)) return;
    if (onEvent) { try { onEvent(acc.snapshot()); } catch { /* observer's problem */ } }
    if (acc.terminal) settle();
  });

  // Idempotent, and it flushes the broker's pre-subscription ring for this
  // thread — the buffer that closes the race where a notification about a new
  // thread reaches the broker before the response that would have subscribed us.
  try {
    await conn.subscribe(threadId);
  } catch (err) {
    detach();
    throw err;
  }

  let preTerminal = null;
  if (initialLevelCheck) preTerminal = await levelTerminal({ conn, threadId, env });

  let timer = null;
  let timedOut = false;
  let closedByCaller = false;

  const done = (async () => {
    try {
      if (preTerminal) return preTerminal;
      if (!acc.terminal) {
        if (timeoutMs && timeoutMs > 0) {
          timer = setTimeout(() => { timedOut = true; settle(); }, timeoutMs);
          if (timer.unref) timer.unref();
        }
        await Promise.race([settled, conn.whenClosed]);
      }
      if (acc.terminal) return finalize(acc, acc.terminal);
      if (timedOut) {
        return finalize(acc, { status: 'timeout', reason: 'timeout', error: `codex turn watch timed out after ${timeoutMs} ms` });
      }
      if (closedByCaller) {
        return finalize(acc, { status: 'unreachable', reason: 'watch-closed', error: 'the codex turn watch was closed before the turn completed' });
      }
      return await connectionLostFallback(acc, { conn, threadId });
    } finally {
      if (timer) clearTimeout(timer);
      detach();
    }
  })();

  return {
    done,
    close() { closedByCaller = true; settle(); },
  };
}

// The turn may already be over — check level state before committing to the
// stream. `active` means keep watching; anything else means ask the transcript.
async function levelTerminal({ conn, threadId, env }) {
  let status;
  try { status = await getCodexThreadStatus({ conn, threadId, env }); }
  catch { return null; }
  if (status === 'active') return null;
  try {
    const transcript = await readCodexThread({ conn, threadId });
    if (!transcript.found) return null;
    return {
      status: 'completed',
      summary: { ...transcript.summary, stopReason: 'thread/read' },
      error: null,
      stdout: transcript.summary.message,
      stderr: '',
    };
  } catch { return null; }
}

// The connection dropped with no terminal frame. The two possibilities have
// OPPOSITE consequences, so the fallback asks rather than guessing: if the
// broker is gone the app-server went with it and the in-flight turn is lost
// (the thread is still resumable from disk); if the broker is alive the turn is
// still running and this bridge is simply no longer watching it — which is the
// detachable-observer property the whole transport was chosen for.
async function connectionLostFallback(acc, { conn, threadId }) {
  const health = await probeCodexBrokerHealth(conn.socketPath);
  if (!health.alive) {
    return finalize(acc, {
      status: 'unreachable',
      reason: 'broker-gone',
      error: `the codex broker is gone; the in-flight turn was lost. Thread ${threadId} is still resumable from its rollout.`,
    });
  }
  return finalize(acc, {
    status: 'unreachable',
    reason: 'connection-lost',
    error: `this bridge lost its broker connection (${conn.closeReason || 'unknown'}); the turn is still running on thread ${threadId} and can be reattached with thread/resume.`,
  });
}

function finalize(acc, { status, reason, error = null }) {
  const snap = acc.snapshot();
  const message = snap.message || '';
  const summary = {
    message,
    thoughts: snap.thoughts || '',
    toolCalls: snap.toolCalls || [],
    stopReason: reason || status,
    error: error || snap.error || null,
  };
  if (snap.plan != null) summary.plan = snap.plan;
  return {
    status,
    summary,
    turnId: acc.turnId,
    error: status === 'failed' || status === 'unreachable' || status === 'timeout' ? (error || snap.error || null) : null,
    stdout: message,
    stderr: '',
  };
}
