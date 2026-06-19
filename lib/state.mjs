// agent-companion state layer (v6.1).
//
// Everything user-visible outside of transient process memory lives as a
// flat file under ~/.claude/agent-companion/:
//
//   default-model                     — optional one-line model id
//   default-target                    — optional one-line target adapter id
//   threads/<thread-name>.sid         — persisted Copilot session ids
//
// Writes are atomic (tmp + rename) with 0600 perms so concurrent reads never
// observe a half-written file and nothing leaks across local accounts.
//
// Session tracking and pause gating were removed in v6.1: the bridge is now
// spawned inline per subagent invocation, so there is no separate activation
// lifecycle to track.

import { readFileSync, writeFileSync, unlinkSync,
         readdirSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import { companionHomeDir, detectHost } from './host.mjs';

// AGENT_COMPANION_HOME explicit override wins (used by tests for sandboxing).
// Otherwise route through lib/host.mjs so Codex installs land under
// ~/.codex/agent-companion/ instead of inheriting Claude's path.
export const BASE_DIR     = process.env.AGENT_COMPANION_HOME
  || companionHomeDir(detectHost());
export const MODEL_FILE   = join(BASE_DIR, 'default-model');
export const TARGET_FILE  = join(BASE_DIR, 'default-target');
export const THREADS_DIR  = join(BASE_DIR, 'threads');
export const JOBS_DIR     = join(BASE_DIR, 'jobs');
// host_session_id → companion thread name. Used on Codex (where the
// subagent has no MY_THREAD comment trick — the bridge resolves thread
// continuity server-side keyed by Codex's session id from MCP _meta) and
// is harmless on Claude (the agent always passes its remembered
// MY_THREAD on subsequent sends, so the lookup never fires).
export const HOST_SESSION_THREADS_DIR = join(BASE_DIR, 'threads', 'by-host-session');

export const DEFAULT_MODEL = 'gpt-5.5';

// Centralised allow-list — the authoritative list lived only in docs before.
export const ALLOWED_MODELS = new Set([
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-opus-4.5',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-haiku-4.5',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.4-mini',
  'gpt-5-mini',
  'gpt-4.1',
]);

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWrite(path, content) {
  // Write the tmp file in the same directory as the target so the rename is
  // always intra-filesystem and atomic. Using os.tmpdir() races when /tmp is
  // on a different volume than $HOME — node falls back to copy+unlink,
  // opening a TOCTOU window where a partial-content file is briefly readable
  // at the target path.
  const dir = dirname(path);
  ensureDir(dir);
  const tmp = join(dir, `.agent-${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch {}
}

function readFileSafe(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// ------------------------------------------------------ default-model
//
// Single-line file. Empty or missing → `DEFAULT_MODEL` fallback.
// Callers get back { model, source } so they can explain where the value
// came from when something goes wrong.

export function readDefaultModel() {
  const raw = readFileSafe(MODEL_FILE);
  if (raw == null) return { model: DEFAULT_MODEL, source: 'fallback' };
  const model = raw.trim();
  if (!model) return { model: DEFAULT_MODEL, source: 'fallback' };
  return { model, source: 'config' };
}

export function writeDefaultModel(id) {
  const clean = String(id ?? '').trim();
  if (!clean) throw new Error('writeDefaultModel: empty id');
  atomicWrite(MODEL_FILE, clean + '\n');
}

export function clearDefaultModel() {
  try { unlinkSync(MODEL_FILE); } catch {}
}

export function isModelAllowed(id) {
  return ALLOWED_MODELS.has(String(id || '').trim());
}

// ------------------------------------------------------ default-target
//
// Single-line file, or AGENT_COMPANION_DEFAULT_TARGET env override. There is
// no silent fallback: an unconfigured target resolves to { target: null,
// source: 'unset' } so callers fail loudly with onboarding guidance instead
// of guessing. Onboarding (`scripts/onboard.mjs`) is the way to set this.

export function readDefaultTarget(env = process.env) {
  const envTarget = String(env.AGENT_COMPANION_DEFAULT_TARGET || '').trim();
  if (envTarget) return { target: envTarget.toLowerCase(), source: 'env' };
  const raw = readFileSafe(TARGET_FILE);
  if (raw == null) return { target: null, source: 'unset' };
  const target = raw.trim();
  if (!target) return { target: null, source: 'unset' };
  return { target: target.toLowerCase(), source: 'config' };
}

export function writeDefaultTarget(id) {
  const clean = String(id ?? '').trim();
  if (!clean) throw new Error('writeDefaultTarget: empty id');
  atomicWrite(TARGET_FILE, clean + '\n');
}

export function clearDefaultTarget() {
  try { unlinkSync(TARGET_FILE); } catch {}
}

// --------------------------------------------------------- threads/
//
// `name` is a short slug picked by the caller (or auto-generated by the
// bridge as `companion-<jobId>`). Each thread maps to a single Copilot ACP
// session id, captured on first send and reused on subsequent sends via
// --session=<sid>.

function threadPath(name) {
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name))
    throw new Error('invalid thread name (allowed: [a-zA-Z0-9._-])');
  return join(THREADS_DIR, `${name}.sid`);
}

// Thread sid is read on every `send` that uses a thread (hot path, once per
// delegation) and written exactly once per Copilot session rotation (rare).
// An in-memory cache eliminates the read syscall in the common case where a
// long-lived thread reuses the same sid for hundreds of turns. Cache is
// invalidated on writeThreadSid / clearThread.
const threadSidCache = new Map();

export function readThreadSid(name) {
  if (threadSidCache.has(name)) return threadSidCache.get(name);
  const raw = readFileSafe(threadPath(name));
  const sid = raw ? raw.trim() || null : null;
  threadSidCache.set(name, sid);
  return sid;
}

export function writeThreadSid(name, sid) {
  const clean = String(sid ?? '').trim();
  if (!clean) throw new Error('writeThreadSid: empty sid');
  atomicWrite(threadPath(name), clean + '\n');
  threadSidCache.set(name, clean);
}

export function clearThread(name) {
  try { unlinkSync(threadPath(name)); } catch {}
  threadSidCache.delete(name);
}

export function listThreads() {
  ensureDir(THREADS_DIR);
  return readdirSync(THREADS_DIR)
    .filter((f) => f.endsWith('.sid'))
    .map((f) => f.slice(0, -4));
}

export function clearAllThreads() {
  for (const name of listThreads()) clearThread(name);
}

// --------------------------------------------------------- jobs/
//
// One file per in-flight or recently-terminal bridge job. Lets a respawned
// bridge reconcile in-flight work with the still-living daemon (the daemon
// retains prompts for an hour). Each entry includes claudeSessionId so a
// rehydrating bridge only claims jobs belonging to its own Claude Code
// session — cross-session takeover would re-leak the bug we just fixed.

function jobPath(jobId) {
  if (!jobId || !/^[a-zA-Z0-9._-]+$/.test(jobId))
    throw new Error('invalid job id (allowed: [a-zA-Z0-9._-])');
  return join(JOBS_DIR, `${jobId}.json`);
}

export function writeJob(jobId, data) {
  if (!data || typeof data !== 'object') throw new Error('writeJob: data must be an object');
  atomicWrite(jobPath(jobId), JSON.stringify(data) + '\n');
}

export function readJob(jobId) {
  const raw = readFileSafe(jobPath(jobId));
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function listJobsForSession(claudeSessionId) {
  if (!claudeSessionId) return [];
  ensureDir(JOBS_DIR);
  const out = [];
  for (const f of readdirSync(JOBS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const jobId = f.slice(0, -5);
    const data = readJob(jobId);
    if (data && data.claudeSessionId === claudeSessionId) out.push(data);
  }
  return out;
}

export function deleteJob(jobId) {
  try { unlinkSync(jobPath(jobId)); } catch {}
}

// ----------------------------------------- threads/by-host-session/
//
// One file per (host session id → thread name) mapping. The bridge writes
// this on every send so a future send from the same host session — even
// after a respawn that wiped process memory — can resume the same Copilot
// thread without the agent having to remember anything.
//
// Codex routes here by default (its subagent doesn't carry the MY_THREAD
// HTML comment); Claude can use it too but rarely does because its
// subagent already round-trips MY_THREAD via its own transcript.
//
// The session id is the caller's responsibility to sanitize via
// `sanitizeHostSessionId` from lib/host.mjs — this module reuses the same
// `[a-zA-Z0-9._-]+` allowlist the thread-name validator enforces.

function hostSessionThreadPath(sid) {
  if (!sid || !/^[a-zA-Z0-9._-]+$/.test(sid))
    throw new Error('invalid host session id (allowed: [a-zA-Z0-9._-])');
  return join(HOST_SESSION_THREADS_DIR, `${sid}.thread`);
}

const hostSessionThreadCache = new Map();

export function readHostSessionThread(sid) {
  if (hostSessionThreadCache.has(sid)) return hostSessionThreadCache.get(sid);
  const raw = readFileSafe(hostSessionThreadPath(sid));
  const name = raw ? raw.trim() || null : null;
  hostSessionThreadCache.set(sid, name);
  return name;
}

export function writeHostSessionThread(sid, threadName) {
  const clean = String(threadName ?? '').trim();
  if (!clean) throw new Error('writeHostSessionThread: empty thread name');
  if (!/^[a-zA-Z0-9._-]+$/.test(clean))
    throw new Error('invalid thread name (allowed: [a-zA-Z0-9._-])');
  atomicWrite(hostSessionThreadPath(sid), clean + '\n');
  hostSessionThreadCache.set(sid, clean);
}

export function clearHostSessionThread(sid) {
  try { unlinkSync(hostSessionThreadPath(sid)); } catch {}
  hostSessionThreadCache.delete(sid);
}
