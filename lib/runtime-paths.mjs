// Private runtime paths for agent-companion.
//
// Transient IPC, logs, prompt streams, heartbeats, and digests live under the
// same per-host 0700 directory as durable state. This avoids predictable shared
// /tmp filenames while keeping env overrides for tests and advanced debugging.

import { mkdirSync, chmodSync, writeFileSync, appendFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';

import { companionHomeDir, detectHost, refuseRealHomeUnderTest } from './host.mjs';

const DIR_MODE = 0o700;

export const PRIVATE_FILE_MODE = 0o600;

export function chmodPrivate(path) {
  try { chmodSync(path, PRIVATE_FILE_MODE); } catch {}
}

export function writePrivateFile(path, content) {
  writeFileSync(path, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  chmodPrivate(path);
}

// Atomic replace, for files that one process rewrites while others read them.
// `writePrivateFile` truncates and then writes, so a concurrent reader can
// observe a half-written file; rename(2) is atomic within a filesystem, so a
// reader sees either the whole old file or the whole new one.
//
// The temp file goes in the target's own directory to keep the rename
// intra-filesystem — via os.tmpdir() it can land on another volume, where node
// degrades to copy+unlink and reopens the very window this closes. Same
// reasoning as lib/state.mjs's writer.
export function writePrivateFileAtomic(path, content) {
  const dir = dirname(path);
  const tmp = join(dir, `.agent-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    try { chmodSync(tmp, PRIVATE_FILE_MODE); } catch {}
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  chmodPrivate(path);
}

export function appendPrivateFile(path, content) {
  appendFileSync(path, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  chmodPrivate(path);
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { chmodSync(dir, DIR_MODE); } catch {}
  return dir;
}

function cleanSegment(value, label) {
  const clean = String(value || '').trim();
  if (!clean || !/^[a-zA-Z0-9._-]+$/.test(clean)) {
    throw new Error(`${label} must match [a-zA-Z0-9._-]+`);
  }
  return clean;
}

export function runtimeDir() {
  // Every transient path funnels through here, so this is where a test that
  // forgot to sandbox is stopped (see refuseRealHomeUnderTest).
  const dir = process.env.AGENT_RUNTIME_DIR || join(companionHomeDir(detectHost()), 'runtime');
  return ensurePrivateDir(refuseRealHomeUnderTest(dir, 'runtime dir'));
}

export function queuePath() {
  return process.env.AGENT_QUEUE_PATH || join(runtimeDir(), 'completions.jsonl');
}

// One ACP daemon per companion, each with its own socket, log and prompt
// streams under the same runtime dir. Every path is keyed by the companion id,
// and the per-companion env override carries the companion's own prefix —
// `COPILOT_SOCKET_PATH` keeps meaning exactly what it did before the daemon
// went generic; `<COMPANION>_SOCKET_PATH` is the twin any later companion gets.
// Copilot is the default so the pre-existing callers (and their on-disk paths)
// are byte-identical.
export const DEFAULT_ACP_COMPANION = 'copilot';

function companionSegment(companion) {
  return cleanSegment(companion, 'companion');
}

function companionEnv(companion, suffix) {
  const prefix = companionSegment(companion).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return process.env[`${prefix}_${suffix}`];
}

export function daemonSocketPath(companion = DEFAULT_ACP_COMPANION) {
  return companionEnv(companion, 'SOCKET_PATH') || join(runtimeDir(), `${companionSegment(companion)}-acp.sock`);
}

export function daemonLogFile(companion = DEFAULT_ACP_COMPANION) {
  return companionEnv(companion, 'DAEMON_LOG_FILE') || join(runtimeDir(), `${companionSegment(companion)}-acp-daemon.log`);
}

// Ownership record for the ACP daemons: one entry per companion, holding the
// daemon's socket path, pid, leases, `lastUsedAt` and the two-phase disposal
// claim — the codex broker's `runtime/codex-broker.json`, keyed by companion.
// Bookkeeping, not an address book: the socket path above is a constant per
// companion, so a bridge that loses this file connect-probes and re-adopts.
export function acpDaemonRegistryPath() {
  return process.env.AGENT_ACP_DAEMON_REGISTRY || join(runtimeDir(), 'acp-daemons.json');
}

export function bridgeLogFile() {
  return process.env.AGENT_BRIDGE_LOG_FILE || join(runtimeDir(), 'agent-bridge.log');
}

// The codex app-server broker's UDS, beside the copilot daemon's. Unix socket
// paths are truncated at SUN_LEN (~104 bytes on darwin) with no error worth
// reading, so the default deliberately lives in the short runtime dir; an
// override pointing at a deep scratch path will bind a silently truncated name.
export function codexBrokerSocketPath() {
  return process.env.CODEX_BROKER_SOCKET_PATH || join(runtimeDir(), 'codex-app-server.sock');
}

export function codexBrokerLogFile() {
  return process.env.CODEX_BROKER_LOG_FILE || join(runtimeDir(), 'codex-app-server-broker.log');
}

export function heartbeatDir() {
  return process.env.AGENT_HEARTBEAT_DIR || ensurePrivateDir(join(runtimeDir(), 'heartbeats'));
}

export function promptJsonlDir() {
  return process.env.AGENT_PROMPT_JSONL_DIR || ensurePrivateDir(join(runtimeDir(), 'prompts'));
}

export function digestDir() {
  return process.env.AGENT_DIGEST_DIR || ensurePrivateDir(join(runtimeDir(), 'digests'));
}

export function otelTracesPath() {
  return process.env.COPILOT_OTEL_TRACES_PATH || join(runtimeDir(), 'copilot-otel-traces.jsonl');
}

// Registry of long-lived `opencode serve` processes the server-mode adapter
// pools by working directory. Survives bridge restarts so a respawned bridge
// reattaches to a still-listening server instead of spawning a duplicate.
export function openCodeServerRegistryPath() {
  return process.env.AGENT_OPENCODE_SERVER_REGISTRY || join(runtimeDir(), 'opencode-servers.json');
}

// Ownership record for the codex app-server broker: leases, `lastUsedAt` and
// the two-phase disposal claim, exactly as the opencode registry above.
//
// One difference worth stating, because it changes how much losing this file
// costs: the opencode registry holds the ONLY record of an ephemeral `--port 0`
// address, so losing it strands a live server. The broker's address is the fixed
// socket path above, so a bridge that loses this file simply connect-probes the
// socket, re-adopts the broker and re-records it. This file is bookkeeping, not
// an address book.
export function codexBrokerRegistryPath() {
  return process.env.AGENT_CODEX_BROKER_REGISTRY || join(runtimeDir(), 'codex-broker.json');
}

export function promptEventsPath(promptId, companion = DEFAULT_ACP_COMPANION) {
  return join(promptJsonlDir(), `${companionSegment(companion)}-acp-${cleanSegment(promptId, 'promptId')}.jsonl`);
}

export function digestPathForJob(jobId) {
  return join(digestDir(), `agent-digest-${cleanSegment(jobId, 'jobId')}.md`);
}
