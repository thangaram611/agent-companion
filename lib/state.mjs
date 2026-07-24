// agent-companion state layer (v6.1).
//
// Everything user-visible outside of transient process memory lives as a
// flat file under ~/.claude/agent-companion/:
//
//   default-model                     — optional one-line model id
//   default-target                    — optional one-line companion target id
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
export const PROFILES_FILE = join(BASE_DIR, 'profiles.json');
export const THREADS_DIR  = join(BASE_DIR, 'threads');
export const JOBS_DIR     = join(BASE_DIR, 'jobs');
// host_session_id → companion thread name. Used on Codex (where the
// subagent has no MY_THREAD comment trick — the bridge resolves thread
// continuity server-side keyed by Codex's session id from MCP _meta) and
// is harmless on Claude (the agent always passes its remembered
// MY_THREAD on subsequent sends, so the lookup never fires).
export const HOST_SESSION_THREADS_DIR = join(BASE_DIR, 'threads', 'by-host-session');

export const DEFAULT_MODEL = 'claude-sonnet-4.6';

// Copilot CLI model ids documented by GitHub's CLI reference. This gates the
// target-side default-model config, not Codex's own agent role model.
export const ALLOWED_MODELS = new Set([
  'claude-sonnet-4.6',
  'claude-haiku-4.5',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'mai-code-1-flash',
  'auto',
]);

// Codex role models are validated separately because Codex and Copilot expose
// different model catalogs. The Codex manual currently recommends gpt-5.5 for
// most work and gpt-5.4-mini for lighter subagent work.
export const CODEX_AGENT_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
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

export function isCodexAgentModelAllowed(id) {
  return CODEX_AGENT_MODELS.has(String(id || '').trim());
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

// ------------------------------------------------------ profiles.json
//
// The strength-routed companion profile registry. This module owns the raw
// file primitives ONLY (read/write/clear + the default-profile precedence and
// per-companion model gate). The single PRODUCER of a normalized registry is
// `lib/profile-registry.mjs:loadProfiles` — the single-producer guard test
// enforces that nothing outside this file and that module references
// PROFILES_FILE / readProfilesRaw.
//
// A whole-file parse error degrades to `null` (never throws); the registry
// loader turns null into the synthesized-from-defaults back-compat path.

export function readProfilesRaw() {
  const raw = readFileSafe(PROFILES_FILE);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function writeProfiles(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('writeProfiles: doc must be a plain object');
  }
  atomicWrite(PROFILES_FILE, JSON.stringify(doc, null, 2) + '\n');
}

export function clearProfiles() {
  try { unlinkSync(PROFILES_FILE); } catch {}
}

// Default-profile precedence mirrors readDefaultTarget's env-above-file rule
// (state.mjs:127-128): AGENT_COMPANION_DEFAULT_PROFILE (env) wins over the
// `defaultProfile` key inside profiles.json (file). Pure helper so loadProfiles
// (which already holds the parsed doc) and standalone callers agree.
export function pickDefaultProfile(env, fileValue) {
  const envProfile = String(env?.AGENT_COMPANION_DEFAULT_PROFILE || '').trim();
  if (envProfile) return { value: envProfile, source: 'env' };
  const fileProfile = String(fileValue || '').trim();
  if (fileProfile) return { value: fileProfile, source: 'file' };
  return { value: null, source: 'unset' };
}

// Standalone default-profile reader (env > profiles.json file). Returns the
// same { value, source } no-fallback shape as readDefaultTarget.
export function readDefaultProfile(env = process.env) {
  const raw = readProfilesRaw();
  return pickDefaultProfile(env, raw && typeof raw === 'object' ? raw.defaultProfile : null);
}

// Per-companion model-allowlist gate. Model is a profile-level concern; the
// rules are companion-specific (ALLOWED_MODELS guards Copilot only). An empty
// model means "no pin, use the companion default" and is always allowed. The
// `modelSelection:false` capability gate is enforced separately in the server's
// STEP C (it needs the capability map, which lives in target-registry).
export function isModelAllowedFor(companionId, model) {
  const id = String(companionId || '').trim().toLowerCase();
  const m = String(model || '').trim();
  if (!m) return true;
  if (id === 'copilot') return ALLOWED_MODELS.has(m);
  if (id === 'opencode') return /^[^/]+\/.+$/.test(m);
  // Codex ids are bare (e.g. "gpt-5.6-sol", no mandatory slash) and the
  // catalog churns roughly monthly — a curated set would recreate the exact
  // staleness bug CODEX_AGENT_MODELS already has for the unrelated Codex
  // HOST role. Codex validates the id itself at spawn, so the gate here only
  // rejects the structurally impossible (embedded whitespace).
  if (id === 'codex') return /^\S+$/.test(m);
  return false;
}

// --------------------------------------------------------- threads/
//
// `name` is a short slug picked by the caller (or auto-generated by the
// bridge as `companion-<jobId>`). Each thread maps to a single Copilot ACP
// session id, captured on first send and reused on subsequent sends via
// --session=<sid>.

// The optional `profileId` qualifier namespaces the on-disk sid by profile so
// two strength-routed profiles sharing a thread NAME (the human-facing handle
// stays profile-agnostic) keep distinct Copilot sessions. profileId=null is the
// legacy/synthesized path → byte-identical `<name>.sid` filename (zero
// migration). Non-null → `<name>__<profileId>.sid`.
function threadPath(name, profileId = null) {
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name))
    throw new Error('invalid thread name (allowed: [a-zA-Z0-9._-])');
  if (profileId != null) {
    if (!/^[a-zA-Z0-9._-]+$/.test(profileId))
      throw new Error('invalid profile id (allowed: [a-zA-Z0-9._-])');
    return join(THREADS_DIR, `${name}__${profileId}.sid`);
  }
  return join(THREADS_DIR, `${name}.sid`);
}

function threadCacheKey(name, profileId = null) {
  return profileId != null ? `${name}__${profileId}` : name;
}

// Thread sid is read on every `send` that uses a thread (hot path, once per
// delegation) and written exactly once per Copilot session rotation (rare).
// An in-memory cache eliminates the read syscall in the common case where a
// long-lived thread reuses the same sid for hundreds of turns. Cache is keyed
// by (name, profileId) and invalidated on writeThreadSid / clearThread.
const threadSidCache = new Map();

export function readThreadSid(name, profileId = null) {
  const key = threadCacheKey(name, profileId);
  if (threadSidCache.has(key)) return threadSidCache.get(key);
  const raw = readFileSafe(threadPath(name, profileId));
  const sid = raw ? raw.trim() || null : null;
  threadSidCache.set(key, sid);
  return sid;
}

// Note: profileId is a required positional (pass null for the legacy/synthesized
// path) so the sid is never accidentally written to the legacy filename for a
// real profile. Callers that previously did writeThreadSid(name, sid) must
// migrate to writeThreadSid(name, profileId, sid).
export function writeThreadSid(name, profileId, sid) {
  const clean = String(sid ?? '').trim();
  if (!clean) throw new Error('writeThreadSid: empty sid');
  atomicWrite(threadPath(name, profileId), clean + '\n');
  threadSidCache.set(threadCacheKey(name, profileId), clean);
}

export function clearThread(name, profileId = null) {
  try { unlinkSync(threadPath(name, profileId)); } catch {}
  threadSidCache.delete(threadCacheKey(name, profileId));
}

// Raw sid filenames (minus `.sid`), including any `<name>__<profileId>` suffix.
// Internal — callers that delete files use this; the public listThreads() view
// strips the profile suffix so the human-facing thread NAME stays
// profile-agnostic (handoff: only the sid is namespaced, never the name).
function listThreadFiles() {
  ensureDir(THREADS_DIR);
  return readdirSync(THREADS_DIR)
    .filter((f) => f.endsWith('.sid'))
    .map((f) => f.slice(0, -4));
}

export function listThreads() {
  const names = new Set();
  for (const file of listThreadFiles()) {
    const sep = file.lastIndexOf('__');
    names.add(sep > 0 ? file.slice(0, sep) : file);
  }
  return [...names];
}

export function clearAllThreads() {
  for (const file of listThreadFiles()) {
    try { unlinkSync(join(THREADS_DIR, `${file}.sid`)); } catch {}
  }
  threadSidCache.clear();
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
