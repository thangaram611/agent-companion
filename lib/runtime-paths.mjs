// Private runtime paths for agent-companion.
//
// Transient IPC and logs live under the
// same per-host 0700 directory as durable state. This avoids predictable shared
// /tmp filenames while keeping env overrides for tests and advanced debugging.

import { mkdirSync, chmodSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';

import { runtimeRoot } from './hosts/runtime.mjs';
import { HOSTS, detectHost } from './hosts/index.mjs';

const DIR_MODE = 0o700;

export const PRIVATE_FILE_MODE = 0o600;

export function chmodPrivate(path) {
  try { chmodSync(path, PRIVATE_FILE_MODE); } catch {}
}

export function writePrivateFile(path, content, flag = 'w') {
  writeFileSync(path, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag });
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
