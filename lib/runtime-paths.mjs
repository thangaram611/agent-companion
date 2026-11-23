// Private runtime paths for agent-companion.
//
// Transient IPC and logs live under the
// same per-host 0700 directory as durable state. This avoids predictable shared
// /tmp filenames while keeping env overrides for tests and advanced debugging.

import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { runtimeRoot } from './hosts/runtime.mjs';
import { HOSTS, detectHost } from './hosts/index.mjs';

const DIR_MODE = 0o700;

export { PRIVATE_FILE_MODE, chmodPrivate, writePrivateFile, writePrivateFileAtomic } from './private-files.mjs';

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { chmodSync(dir, DIR_MODE); } catch {}
  return dir;
}

export function runtimeDir() {
  return ensurePrivateDir(runtimeRoot(HOSTS[detectHost()], process.env));
}

export function bridgeLogFile() {
  return process.env.AGENT_BRIDGE_LOG_FILE || join(runtimeDir(), 'agent-bridge.log');
}

export function promptJsonlDir() {
  return process.env.AGENT_PROMPT_JSONL_DIR || ensurePrivateDir(join(runtimeDir(), 'prompts'));
}
