// Private runtime paths for agent-companion.
//
// Transient IPC, logs, prompt streams, heartbeats, and digests live under the
// same per-host 0700 directory as durable state. This avoids predictable shared
// /tmp filenames while keeping env overrides for tests and advanced debugging.

import { mkdirSync, chmodSync, writeFileSync, appendFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';

import { companionHomeDir, detectHost } from './host.mjs';

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
  return ensurePrivateDir(process.env.AGENT_RUNTIME_DIR || join(companionHomeDir(detectHost()), 'runtime'));
}

export function queuePath() {
  return process.env.AGENT_QUEUE_PATH || join(runtimeDir(), 'completions.jsonl');
}

export function daemonSocketPath() {
  return process.env.COPILOT_SOCKET_PATH || join(runtimeDir(), 'copilot-acp.sock');
}

export function daemonLogFile() {
  return process.env.COPILOT_DAEMON_LOG_FILE || join(runtimeDir(), 'copilot-acp-daemon.log');
}

export function bridgeLogFile() {
  return process.env.AGENT_BRIDGE_LOG_FILE || join(runtimeDir(), 'agent-bridge.log');
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

export function promptEventsPath(promptId) {
  return join(promptJsonlDir(), `copilot-acp-${cleanSegment(promptId, 'promptId')}.jsonl`);
}

export function digestPathForJob(jobId) {
  return join(digestDir(), `agent-digest-${cleanSegment(jobId, 'jobId')}.md`);
}
