// daemon-client.mjs
// Minimal in-process client for the ACP daemons (scripts/acp-daemon.mjs, one
// per companion). Talks the same newline-delimited JSON protocol as
// scripts/copilot-acp-client.mjs but skips the node-subprocess overhead — the
// bridge server worker calls these functions directly inside the same process.
//
// Exported:
//   sendToSocket(message, timeoutMs?, companion?) — round-trip one IPC request
//   ensureDaemon({reqId?, companion?}) — adopt the live daemon for that
//     companion, or spawn one detached when its socket does not answer
//   syncAcpDaemonLeases / reapIdleAcpDaemon / acpDaemonSnapshot /
//     acpDaemonIdleTtlMs — the shared-runtime registry side, per companion
//
// The daemon is a detached shared runtime in the sense docs/ARCHITECTURE.md
// gives the codex broker: every bridge on the machine that resolves to the
// same host home shares the one daemon per companion, and the bridge is
// spawned per subagent. So "does anyone still need it?" is answered by the
// on-disk registry (lib/shared-runtime-registry.mjs) — leases renewed from the
// bridge GC tick, a two-phase disposal claim, and a `stop` sent only after the
// registry's final confirmation — with the daemon's own inactivity reaper as
// the second reaper, exactly the broker's shape.
//
// v6.1: optional reqId is appended to outbound messages so the daemon can
// stamp every log line with the same correlation id.

import { connect as connectSocket } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

import { daemonSocketPath, acpDaemonRegistryPath, DEFAULT_ACP_COMPANION } from '../lib/runtime-paths.mjs';
import { createSharedRuntimeRegistry, deriveIdleTtlMs } from '../lib/shared-runtime-registry.mjs';
import { ACP_PROMPT_TIMEOUT_MS } from '../scripts/acp-daemon.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DAEMON_PATH = process.env.AGENT_ACP_DAEMON_PATH
  || pathResolve(__dirname, '..', 'scripts', 'acp-daemon.mjs');
const DAEMON_BOOT_TIMEOUT_MS = Number(process.env.AGENT_ACP_DAEMON_BOOT_MS) || 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 6 * 60 * 1000;
const STATUS_PROBE_TIMEOUT_MS = 2_000;

// The daemon's terminal prompt statuses, restated here only to read a status
// answer; the daemon's TERMINAL_STATUSES is the definition.
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'stuck']);

function socketEnvName(companion) {
  return `${String(companion).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_SOCKET_PATH`;
}

function realSendToSocket(message, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, companion = DEFAULT_ACP_COMPANION) {
  return new Promise((resolve, reject) => {
    const sock = connectSocket(daemonSocketPath(companion));
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      const err = new Error('client request timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify(message));
      sock.end();
    });
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => (buf += chunk));
    sock.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(buf.trim())); }
      catch (err) { reject(new Error(`invalid response from daemon: ${err.message}`)); }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// The daemon's status answer when it is alive, else null.
async function probeDaemon(companion, timeoutMs = STATUS_PROBE_TIMEOUT_MS, reqId = undefined) {
  try {
    const r = await sendToSocket({ command: 'status', reqId }, timeoutMs, companion);
    return r && r.ok === true ? (r.data || {}) : null;
  } catch {
    return null;
  }
}

// --- Shared-runtime registry, one entry per companion ------------------------
//
// IDENTITY IS PATH + PID, as for the codex broker: the socket path is fixed
// per companion, so a daemon and the daemon that replaced it after a crash
// would be "the same runtime" under a path-only identity, and a disposal claim
// taken against the dead one would then stop the live one. A daemon that
// predates pid reporting (no `daemonPid` on its status) identifies as null and
// the reaper skips it — its own inactivity timer still retires it.

const registries = new Map();

function registryFor(companion) {
  if (!registries.has(companion)) {
    registries.set(companion, createSharedRuntimeRegistry({
      registryPath: acpDaemonRegistryPath,
      key: companion,
      identity: (entry) => (entry?.socketPath && entry?.pid ? `${entry.socketPath}#${entry.pid}` : null),
      dispose: (entry, ctx) => disposeDaemon(companion, entry, ctx),
    }));
  }
  return registries.get(companion);
}

// Stop a daemon the reaper has claimed — after asking it two questions and the
// registry a third, the broker's protocol: is the pid still this daemon (the OS
// recycles pids), is it holding a live prompt (a bridge that died mid-turn
// leaves no lease after LEASE_STALE_MS, and the turn it started is exactly the
// work the daemon exists to keep), and did anyone adopt it while we asked
// (`confirmDisposal`, the registry's final look at the claim).
async function disposeDaemon(companion, entry, { confirmDisposal }) {
  const status = await probeDaemon(companion);
  if (!status) return false;
  if (status.daemonPid !== entry.pid) return false;
  const active = (status.inFlightPrompts || []).some((p) => !TERMINAL.has(p.status));
  if (active) return false;
  if (!confirmDisposal()) return false;
  try { await sendToSocket({ command: 'stop' }, STATUS_PROBE_TIMEOUT_MS, companion); }
  catch { /* the daemon exits 50 ms after answering, and may have gone first */ }
  return true;
}

// Record the daemon this bridge just found (or spawned) as the one for this
// companion. Merges only into the SAME daemon: an entry with another pid
// describes the daemon this one replaced, and its claim and leases belong to
// that dead process.
function adopt(companion, status, { reused }) {
  const entry = {
    socketPath: daemonSocketPath(companion),
    pid: status?.daemonPid ?? null,
    agentPid: status?.pid ?? null,
  };
  const registry = registryFor(companion);
  const recorded = registry.read();
  const same = recorded?.socketPath === entry.socketPath && recorded?.pid === entry.pid;
  registry.record(same ? { ...recorded, ...entry } : { ...entry, startedAt: Date.now() });
  return { companion, socketPath: entry.socketPath, pid: entry.pid, reused };
}

// Spawn mutex: concurrent ensureDaemon() callers for one companion must share
// the same in-flight spawn promise. Without this two parallel `send` actions
// would each try to spawn a daemon, racing on the socket file.
const spawnPromises = new Map();

async function spawnDaemon(companion) {
  if (spawnPromises.has(companion)) return spawnPromises.get(companion);
  const promise = (async () => {
    if (!existsSync(DAEMON_PATH)) {
      throw new Error(`daemon not found at ${DAEMON_PATH}`);
    }
    const socketPath = daemonSocketPath(companion);
    // The child must bind the same path this process just probed, whatever
    // env the caller runs under — the broker pins its socket the same way.
    const child = spawn(process.execPath, [DAEMON_PATH, '--companion', companion], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [socketEnvName(companion)]: socketPath },
    });
    child.unref();
    // Exponential backoff probe — fastest case ~50 ms, capped at the boot
    // timeout. Old fixed-100 ms loop wasted ~6× boot latency.
    const delays = [50, 100, 200, 400, 800];
    let i = 0;
    const start = Date.now();
    while (Date.now() - start < DAEMON_BOOT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
      i++;
      const status = await probeDaemon(companion);
      if (status) return adopt(companion, status, { reused: false });
    }
    throw new Error(`${companion} acp daemon failed to start within timeout`);
  })();
  spawnPromises.set(companion, promise);
  try { return await promise; }
  finally { spawnPromises.delete(companion); }
}

async function realEnsureDaemon({ reqId, companion = DEFAULT_ACP_COMPANION } = {}) {
  // Try a short probe first — if the daemon is already up the cost is one
  // round-trip on the socket. Skip the longer status timeout since "alive"
  // here means "socket accepts a connection", not "everything healthy".
  try {
    const r = await sendToSocket({ command: 'status', reqId }, 1500, companion);
    if (r && r.ok === true) return adopt(companion, r.data, { reused: true });
  } catch (err) {
    // Only auto-spawn on connect-class failures. Anything else (parse
    // errors, server-side rejection) bubbles up so callers can decide.
    if (!err || !['ECONNREFUSED', 'ENOENT', 'ETIMEDOUT'].includes(err.code)) {
      throw err;
    }
  }
  return spawnDaemon(companion);
}

// Publish this process's in-flight prompts on a companion's daemon as leases,
// and prune abandoned ones while holding the file. Call on the GC tick.
export function syncAcpDaemonLeases(companion, jobIds = [], opts = {}) {
  return registryFor(companion).syncLeases(jobIds, opts);
}

// Best-effort idle reaper for one companion's daemon. `hasLiveJobs` is this
// process's own view; leases make the decision cross-process.
export function reapIdleAcpDaemon(companion, opts = {}) {
  return registryFor(companion).reapIdle(opts);
}

export function acpDaemonSnapshot(companion) {
  return registryFor(companion).snapshot();
}

// The idle TTL, derived from the daemon's own prompt budget the way the other
// two shared runtimes derive theirs from their job budgets: a prompt that
// simply runs long must never look like an idle daemon.
const MIN_IDLE_TTL_MS = 30 * 60 * 1000;
const IDLE_TTL_GRACE_MS = 5 * 60 * 1000;

export function acpDaemonIdleTtlMs() {
  return deriveIdleTtlMs({ jobTimeoutMs: ACP_PROMPT_TIMEOUT_MS, floorMs: MIN_IDLE_TTL_MS, graceMs: IDLE_TTL_GRACE_MS });
}

// Module-local impl pointers — tests can swap these via _setForTest without
// touching the real socket / spawn. server.mjs imports the public wrappers
// below as named bindings, so the indirection has to live here (ESM named
// imports can't be rebound from outside).
let _sendToSocketImpl = realSendToSocket;
let _ensureDaemonImpl = realEnsureDaemon;

export function sendToSocket(message, timeoutMs, companion) {
  return _sendToSocketImpl(message, timeoutMs, companion);
}

export function ensureDaemon(opts) {
  return _ensureDaemonImpl(opts);
}

export function _setForTest({ sendToSocket: sendStub, ensureDaemon: ensureStub } = {}) {
  if (sendStub) _sendToSocketImpl = sendStub;
  if (ensureStub) _ensureDaemonImpl = ensureStub;
}

export function _resetForTest() {
  _sendToSocketImpl = realSendToSocket;
  _ensureDaemonImpl = realEnsureDaemon;
}
