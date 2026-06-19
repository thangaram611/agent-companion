// Private runtime paths for agent-companion.
//
// Transient IPC, logs, prompt streams, heartbeats, and digests live under the
// same per-host 0700 directory as durable state. This avoids predictable shared
// /tmp filenames while keeping env overrides for tests and advanced debugging.

import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { companionHomeDir, detectHost } from './host.mjs';

const DIR_MODE = 0o700;

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

export function promptEventsPath(promptId) {
  return join(promptJsonlDir(), `copilot-acp-${cleanSegment(promptId, 'promptId')}.jsonl`);
}

export function digestPathForJob(jobId) {
  return join(digestDir(), `agent-digest-${cleanSegment(jobId, 'jobId')}.md`);
}
