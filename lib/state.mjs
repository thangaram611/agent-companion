// agent-companion state layer (v6.1).
//
// Everything user-visible outside of transient process memory lives as a flat
// file under ~/.claude/agent-companion/ or $CODEX_HOME/agent-companion/:
//
//   default-model                     — optional one-line model id
//   default-target                    — optional one-line companion target id
//   threads/<thread-name>.sid         — persisted companion session ids (Copilot ACP
//                                       session, codex app-server thread)
//
// Writes are atomic (tmp + rename) with 0600 perms so concurrent reads never
// observe a half-written file and nothing leaks across local accounts.
//
// Session tracking and pause gating were removed in v6.1. Bridge process
// lifetime is owned by the host (agent-local on Claude, plugin/session-scoped
// on Codex), so there is no separate activation lifecycle to track here.

import { readFileSync, writeFileSync, unlinkSync,
         readdirSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import { companionHomeDir, detectHost, refuseRealHomeUnderTest } from './host.mjs';

// AGENT_COMPANION_HOME explicit override wins (used by tests for sandboxing).
// Otherwise route through lib/host.mjs so Codex installs land under
// ~/.codex/agent-companion/ instead of inheriting Claude's path. Binds at
// import, so under `node --test` an unsandboxed import throws right here —
// which is the point: a suite touching state must set the env and then
// `await import()` (see CLAUDE.md), and one that forgot now fails at the
// import instead of writing into the operator's live state.
export const BASE_DIR     = refuseRealHomeUnderTest(
  process.env.AGENT_COMPANION_HOME || companionHomeDir(detectHost()),
  'state dir',
);
export const MODEL_FILE   = join(BASE_DIR, 'default-model');
export const TARGET_FILE  = join(BASE_DIR, 'default-target');
export const THREADS_DIR  = join(BASE_DIR, 'threads');
export const JOBS_DIR     = join(BASE_DIR, 'jobs');

// Copilot CLI model ids documented by GitHub's CLI reference. This gates the
// target-side default-model config.
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
// Single-line files. Empty or missing means inherit the companion configuration.
// Callers get back { model, source } so they can explain where the value
// came from when something goes wrong.

const MODEL_ENV = { codex: 'AGENT_COMPANION_CODEX_MODEL', opencode: 'AGENT_COMPANION_OPENCODE_MODEL' };
function modelFile(companion) {
  if (!['copilot', 'codex', 'opencode', 'antigravity'].includes(companion)) throw new Error('unknown companion');
  return companion === 'copilot' ? MODEL_FILE : join(BASE_DIR, `default-model-${companion}`);
}

export function readDefaultModel(companion = 'copilot', env = process.env) {
  const override = String(env[MODEL_ENV[companion]] || '').trim();
  if (override) return { model: override, source: 'env' };
  const model = readFileSafe(modelFile(companion))?.trim();
  return model ? { model, source: 'config' } : { model: null, source: 'unset' };
}

export function writeDefaultModel(id, companion = 'copilot') {
  const clean = String(id ?? '').trim();
  if (!clean) throw new Error('writeDefaultModel: empty id');
  atomicWrite(modelFile(companion), clean + '\n');
}

export function clearDefaultModel(companion = 'copilot') {
  try { unlinkSync(modelFile(companion)); } catch {}
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

// Model validation is companion-specific. An omitted model inherits configuration.
export function isModelAllowedFor(companionId, model) {
  const id = String(companionId || '').trim().toLowerCase();
  const m = String(model || '').trim();
  if (!m) return true;
  if (id === 'copilot') return ALLOWED_MODELS.has(m);
  if (id === 'opencode') return /^[^/]+\/.+$/.test(m);
  // Codex ids are bare (e.g. "gpt-5.6-sol", no mandatory slash) and the
  // catalog churns roughly monthly, so a curated set would go stale. Codex
  // validates the id itself at spawn, so the gate here only rejects the
  // structurally impossible (embedded whitespace).
  if (id === 'codex') return /^\S+$/.test(m);
  // Antigravity ids are bare too (`gemini-3.7-flash-high`, `gemini-pro-agent`)
  // and the server validates the id itself on `session/set_config_option`,
  // answering -32602 with the ids it has — so the gate only rejects whitespace.
  if (id === 'antigravity') return /^\S+$/.test(m);
  return false;
}

// --------------------------------------------------------- threads/
//
// `name` is a short slug picked by the caller (or auto-generated by the
// bridge as `companion-<jobId>`). Each thread maps to a single Copilot ACP
// session id, captured on first send and reused on subsequent sends via
// --session=<sid>.

function threadPath(name, suffix = '.sid') {
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name))
    throw new Error('invalid thread name (allowed: [a-zA-Z0-9._-])');
  return join(THREADS_DIR, `${name}${suffix}`);
}

function assertUnambiguousThread(name) {
  const conflict = readFileSafe(threadPath(name, '.ambiguous'));
  if (!conflict) return;
  let sources = conflict.trim();
  try { sources = JSON.parse(sources).map((r) => r.source).join(', '); } catch {}
  throw new Error(`thread ${name} has ambiguous legacy histories: ${sources}. Start a new companion conversation or resolve the conflicting histories explicitly.`);
}

const threadSidCache = new Map();

export function readThreadSid(name) {
  assertUnambiguousThread(name);
  if (threadSidCache.has(name)) return threadSidCache.get(name);
  const sid = readFileSafe(threadPath(name))?.trim() || null;
  threadSidCache.set(name, sid);
  return sid;
}

export function writeThreadSid(name, sid) {
  assertUnambiguousThread(name);
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
  try {
    return [...new Set(readdirSync(THREADS_DIR)
      .filter((f) => /\.(sid|ambiguous)$/.test(f))
      .map((f) => f.replace(/\.(sid|ambiguous)$/, '')))];
  } catch { return []; }
}

export function clearAllThreads() {
  for (const name of listThreads()) {
    clearThread(name);
    try { unlinkSync(threadPath(name, '.ambiguous')); } catch {}
  }
  threadSidCache.clear();
}

// The only legacy profiles.json read: one-shot at bridge startup. Environment
// defaults take precedence over migrated files, and the user's source is kept.
export function migrateLegacyState({ env = process.env, log = () => {} } = {}) {
  const marker = join(BASE_DIR, 'phase1-migrated');
  if (readFileSafe(marker) !== null) return;
  let profiles = {};
  try { profiles = JSON.parse(readFileSafe(join(BASE_DIR, 'profiles.json')) || '{}'); }
  catch { log('WARN', 'phase1 migration: invalid profiles.json; source preserved'); }
  const entries = Array.isArray(profiles?.profiles) ? profiles.profiles : [];
  const byId = (id) => entries.find((p) => p?.id === id);
  const selected = byId(profiles?.defaultProfile);
  if (selected?.model && ['copilot', 'opencode', 'codex', 'antigravity'].includes(selected.companion)
      && !readDefaultModel(selected.companion, env).model) {
    writeDefaultModel(selected.model, selected.companion);
    log('INFO', `phase1 migration: carried default model to ${selected.companion}`);
  }

  const histories = new Map();
  const add = (thread, source, sid, target = null) => {
    if (!sid) return;
    if (!histories.has(thread)) histories.set(thread, []);
    histories.get(thread).push({ source, sid, target });
  };
  let files = [];
  try { files = readdirSync(THREADS_DIR); } catch {}
  for (const file of files.filter((f) => f.endsWith('.sid'))) {
    const name = file.slice(0, -4);
    // A profile id may itself contain `__`, so prefer the longest known id that
    // ends the file name; otherwise split at the first separator (host-named
    // threads never contain one).
    const known = entries.filter((p) => p?.id && name.length > p.id.length + 2 && name.endsWith(`__${p.id}`))
      .sort((a, b) => b.id.length - a.id.length)[0];
    const sep = name.indexOf('__');
    const profile = known ? known.id : (sep > 0 ? name.slice(sep + 2) : null);
    const thread = known ? name.slice(0, -(profile.length + 2)) : (sep > 0 ? name.slice(0, sep) : name);
    add(thread, file, readFileSafe(join(THREADS_DIR, file))?.trim(), byId(profile)?.companion);
  }
  // Include sessions whose bridge died before it could persist the thread file.
  // Never rewrite a legacy job: its running worker still owns that record.
  let jobFiles = [];
  try { jobFiles = readdirSync(JOBS_DIR); } catch {}
  const latest = new Map();
  for (const file of jobFiles.filter((f) => f.endsWith('.json'))) {
    const job = readJob(file.slice(0, -5));
    if (!job?.profileId || !job.thread) continue;
    const key = `${job.thread}__${job.profileId}`;
    if (!latest.has(key) || (job.startedAt || 0) > (latest.get(key).startedAt || 0)) latest.set(key, job);
  }
  for (const [key, job] of latest) {
    if (!files.includes(`${key}.sid`) && !job.sessionRetired) {
      add(job.thread, `profile ${job.profileId}`, job.companionSessionId || job.sessionId, job.target);
    }
  }
  for (const [thread, records] of histories) {
    const sessions = new Set(records.map((r) => r.sid));
    const targets = new Set(records.map((r) => r.target).filter(Boolean));
    if (sessions.size > 1 || targets.size > 1) {
      atomicWrite(threadPath(thread, '.ambiguous'), JSON.stringify(records) + '\n');
      log('WARN', `phase1 migration: ambiguous thread ${thread}`);
    } else {
      writeThreadSid(thread, records[0].sid);
    }
  }
  // Namespaced files are superseded by the canonical sid or conflict marker.
  for (const file of files.filter((f) => f.endsWith('.sid') && f.includes('__'))) {
    unlinkSync(join(THREADS_DIR, file));
  }
  atomicWrite(marker, new Date().toISOString() + '\n');
  log('INFO', 'phase1 migration complete; profiles.json preserved and no longer read');
}

export function readTargetChecks() {
  try { return JSON.parse(readFileSafe(join(BASE_DIR, 'target-checks.json')) || '{}'); }
  catch { return {}; }
}

export function writeTargetChecks(checks) {
  atomicWrite(join(BASE_DIR, 'target-checks.json'), JSON.stringify(checks) + '\n');
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
