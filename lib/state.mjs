// Companion defaults and one-shot legacy state migration.
// BASE_DIR is host-routed and bound at import. Current conversation, execution,
// lease, result and completion records belong to controller/records.mjs;
// hooks/stop-owner.sh writes advisory stops/<owner>.json there.
// Legacy threads/ and jobs/ remain migration inputs, never live-work adoption.
// Both hosts own a plugin/session-scoped bridge. Writes here are atomic/private.

import { readFileSync, writeFileSync, unlinkSync,
         readdirSync, mkdirSync, renameSync, chmodSync, lstatSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
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
export const THREADS_DIR  = join(BASE_DIR, 'threads');
export const JOBS_DIR     = join(BASE_DIR, 'jobs');

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

// Shared settings. Only execution/history records are routed by host.
const MODEL_ENV = {
  copilot: null,
  codex: 'AGENT_COMPANION_CODEX_MODEL',
  opencode: 'AGENT_COMPANION_OPENCODE_MODEL',
  antigravity: null,
  claude: 'AGENT_COMPANION_CLAUDE_MODEL',
};
const COMPANIONS = Object.keys(MODEL_ENV);

function settingsPath(env) {
  const dir = env.AGENT_COMPANION_HOME || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'agent-companion');
  return refuseRealHomeUnderTest(resolve(dir, 'settings.json'), 'settings file');
}

function loadSettings(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const isObject = entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry);
    const optionalString = entry => entry === undefined || (typeof entry === 'string' && entry.trim().length > 0);
    if (!isObject(value) || !optionalString(value.target)) throw new Error('invalid settings structure');
    if (value.companions !== undefined) {
      if (!isObject(value.companions)) throw new Error('invalid companions object');
      for (const entry of Object.values(value.companions)) {
        if (!isObject(entry) || !optionalString(entry.model) || !optionalString(entry.effort)) {
          throw new Error('invalid companion settings');
        }
      }
    }
    return value;
  } catch (err) {
    if (err.code === 'ENOENT' && !lstatSync(path, { throwIfNoEntry: false })) return undefined;
    throw new Error(`Cannot read ${path}: ${err.code || (err instanceof SyntaxError ? 'invalid JSON' : err.message)}`, { cause: err });
  }
}

function readSettings(path, log) {
  try { return loadSettings(path); }
  catch (err) {
    log('WARN', `${err.message}. Treating settings as empty.`);
    return {};
  }
}

function saveSettings(path, settings) {
  atomicWrite(path, JSON.stringify(settings, null, 2) + '\n');
}

// The rename keeps readers whole. Writers are the person's own saves, and two
// migrations racing write the same content, so there is no lock.
function updateSettings(env, update) {
  const path = settingsPath(env);
  let settings;
  try { settings = loadSettings(path) ?? {}; }
  catch (err) { throw new Error(`Refusing to overwrite settings. ${err.message}`, { cause: err }); }
  const before = JSON.stringify(settings);
  update(settings);
  if (JSON.stringify(settings) === before) return false;
  saveSettings(path, settings);
  return true;
}

function checkCompanion(companion) {
  if (!COMPANIONS.includes(companion)) throw new Error('unknown companion');
}

export function readDefaultModel(companion = 'copilot', env = process.env, log = console.warn, settings) {
  checkCompanion(companion);
  const knob = MODEL_ENV[companion];
  const override = knob && String(env[knob] || '').trim();
  if (override) return { model: override, source: 'env' };
  const saved = settings ?? readSettings(settingsPath(env), log);
  const model = saved?.companions?.[companion]?.model?.trim();
  return model ? { model, source: 'config' } : { model: null, source: 'unset' };
}

function setModel(settings, companion, model) {
  settings.companions ??= {};
  const entry = settings.companions[companion] ??= {};
  entry.model = model;
}

export function writeDefaultModel(id, companion = 'copilot', env = process.env) {
  checkCompanion(companion);
  const clean = String(id ?? '').trim();
  if (!clean) throw new Error('writeDefaultModel: empty id');
  updateSettings(env, settings => setModel(settings, companion, clean));
}

export function clearDefaultModel(companion = 'copilot', env = process.env) {
  checkCompanion(companion);
  updateSettings(env, settings => {
    const entry = settings.companions?.[companion];
    if (!entry) return;
    delete entry.model;
    if (!Object.keys(entry).length) delete settings.companions[companion];
    if (!Object.keys(settings.companions).length) delete settings.companions;
  });
}

export function readDefaultTarget(env = process.env, log = console.warn, settings) {
  const override = String(env.AGENT_COMPANION_DEFAULT_TARGET || '').trim();
  if (override) return { target: override.toLowerCase(), source: 'env' };
  const saved = settings ?? readSettings(settingsPath(env), log);
  const target = saved?.target?.trim().toLowerCase();
  return target ? { target, source: 'config' } : { target: null, source: 'unset' };
}

export function writeDefaultTarget(id, env = process.env) {
  const clean = String(id ?? '').trim().toLowerCase();
  if (!clean) throw new Error('writeDefaultTarget: empty id');
  updateSettings(env, settings => { settings.target = clean; });
}

export function clearDefaultTarget(env = process.env) {
  updateSettings(env, settings => { delete settings.target; });
}

function legacyDefaults(env, log) {
  const hosts = env.AGENT_COMPANION_HOME ? [env.AGENT_COMPANION_HOST || 'claude'] : ['claude', 'codex'];
  const dirs = hosts.map(host => [host, refuseRealHomeUnderTest(
    resolve(env.AGENT_COMPANION_HOME || companionHomeDir(host, env)), 'legacy state dir')]);
  const settings = {}, conflicts = [], migrated = [];
  for (const companion of [null, ...COMPANIONS]) {
    const setting = companion ? `companions.${companion}.model` : 'target';
    const name = companion === null ? 'default-target' : companion === 'copilot' ? 'default-model' : `default-model-${companion}`;
    const entries = [];
    for (const [host, dir] of dirs) {
      const path = join(dir, name);
      try {
        const value = readFileSync(path, 'utf8').trim();
        entries.push({ setting, host, value, path });
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    const values = new Set(entries.map(e => e.value).filter(Boolean));
    if (values.size > 1) {
      conflicts.push(...entries);
      log?.('WARN', `Conflicting legacy ${setting}: ${entries.map(e => `${e.host}=${e.value}`).join(', ')}. Both files preserved.`);
      continue;
    }
    const [value] = values;
    if (value && companion) setModel(settings, companion, value);
    else if (value) settings.target = value.toLowerCase();
    migrated.push(...entries);
  }
  return { settings, conflicts, migrated };
}

export function legacyDefaultConflicts(env = process.env) {
  return legacyDefaults(env).conflicts;
}

// Onboarding previews read the same prospective settings without writing or
// consuming the one-shot migration. Normal readers only consult settings.json.
export function previewDefaults({ env = process.env, log = console.warn } = {}) {
  return readSettings(settingsPath(env), log) ?? legacyDefaults(env, log).settings;
}

export function migrateDefaults({ env = process.env, log = console.warn } = {}) {
  const path = settingsPath(env);
  const existing = readSettings(path, log);
  if (existing !== undefined) return existing;
  const { settings, migrated } = legacyDefaults(env, log);
  saveSettings(path, settings);
  for (const { path: source } of migrated) {
    try { rmSync(source, { force: true }); }
    catch (err) { log('WARN', `Migrated settings, but could not remove ${source}: ${err.code}`); }
  }
  return settings;
}

// Model validation is companion-specific. An omitted model inherits configuration.
export function isModelAllowedFor(companionId, model) {
  const id = String(companionId || '').trim().toLowerCase();
  const m = String(model || '').trim();
  if (!m) return true;
  if (id === 'opencode') return /^[^/]+\/.+$/.test(m);
  // These companions validate model availability themselves.
  if (['codex', 'claude', 'copilot', 'antigravity'].includes(id)) return /^\S+$/.test(m);
  return false;
}

// --------------------------------------------------------- threads/
//
// Legacy thread helpers retained for migration and its regression fixtures.
// New conversations use host-supplied owner ids and controller records.

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
  const profileModel = String(selected?.model ?? '').trim();
  if (profileModel && COMPANIONS.includes(selected.companion)) {
    // Import newer per-host choices before a profile can create settings.json.
    migrateDefaults({ env, log });
    const id = selected.companion;
    if (!readDefaultModel(id, env, log).model && !legacyDefaultConflicts(env).some(e => e.setting === `companions.${id}.model`)) {
      try {
        const carried = updateSettings(env, settings => {
          if (!settings.companions?.[id]?.model) setModel(settings, id, profileModel);
        });
        if (carried) log('INFO', `phase1 migration: carried default model to ${id}`);
      } catch (err) { log('WARN', `phase1 migration: ${err.message}; profile model preserved in profiles.json`); }
    }
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
// Historical job readers for migration. The shipped controller never rehydrates
// a live legacy runtime; provider identity must be established before cold load.

function jobPath(jobId) {
  if (!jobId || !/^[a-zA-Z0-9._-]+$/.test(jobId))
    throw new Error('invalid job id (allowed: [a-zA-Z0-9._-])');
  return join(JOBS_DIR, `${jobId}.json`);
}

export function readJob(jobId) {
  const raw = readFileSafe(jobPath(jobId));
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function listJobsForSession(claudeSessionId) {
  if (!claudeSessionId) return [];
  let files;
  try { files = readdirSync(JOBS_DIR); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const jobId = f.slice(0, -5);
    const data = readJob(jobId);
    if (data && data.claudeSessionId === claudeSessionId) out.push(data);
  }
  return out;
}
