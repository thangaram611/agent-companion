// Companion defaults and one-shot legacy state migration.
// BASE_DIR is host-routed and bound at import. Current thread, job,
// result and completion records belong to controller/records.mjs.
// Both hosts own a plugin/session-scoped bridge. Writes here are atomic/private.

import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, rmSync, linkSync } from 'node:fs';
import { getCompanionById, COMPANION_IDS, LEGACY_MODEL_COMPANION, legacyModelIds } from './companion-registry.mjs';
import { loadSettings, readSettings, settingsPath } from './settings.mjs';
export { readDefaultCompanion, readSettings, settingsPath } from './settings.mjs';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { companionHomeDir, detectHost, refuseRealHomeUnderTest, stateDirs } from './hosts/index.mjs';

// AGENT_COMPANION_HOME explicit override wins (used by tests for sandboxing).
// Otherwise route through lib/hosts/index.mjs so Codex installs land under
// ~/.codex/agent-companion/ instead of inheriting Claude's path. Binds at
// import, so under `node --test` an unsandboxed import throws right here —
// which is the point: a suite touching state must set the env and then
// `await import()` (see CLAUDE.md), and one that forgot now fails at the
// import instead of writing into the operator's live state.
export const BASE_DIR     = refuseRealHomeUnderTest(
  process.env.AGENT_COMPANION_HOME || companionHomeDir(detectHost()),
  'state dir',
);

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

// Shared settings. Only job/history records are routed by host.
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
  moveDefaultCompanion(settings);
  update(settings);
  if (JSON.stringify(settings) === before) return false;
  saveSettings(path, settings);
  return true;
}

function checkCompanion(companion) {
  if (!COMPANION_IDS.has(companion)) throw new Error('unknown companion');
}

export function readDefaultModel(companion = LEGACY_MODEL_COMPANION, env = process.env, log = console.warn, settings) {
  checkCompanion(companion);
  const knob = getCompanionById(companion).runtime.modelEnv;
  const override = knob && String(env[knob] || '').trim();
  if (override) return { model: override, source: 'env' };
  const saved = settings ?? readSettings(settingsPath(env), log);
  const model = saved?.companions?.[companion]?.model?.trim();
  return model ? { model, source: 'config' } : { model: null, source: 'unset' };
}

export function readDefaultEffort(companion = LEGACY_MODEL_COMPANION, env = process.env, log = console.warn, settings) {
  checkCompanion(companion);
  const saved = settings ?? readSettings(settingsPath(env), log);
  const effort = saved?.companions?.[companion]?.effort?.trim();
  return effort ? { effort, source: 'config' } : { effort: null, source: 'unset' };
}

function setCompanionSetting(settings, companion, key, value) {
  settings.companions ??= {};
  const entry = settings.companions[companion] ??= {};
  entry[key] = value;
}

// A model and its effort can be edited together in one rename. Null clears
// that field. Omitted fields keep their current values.
export function writeCompanionDefaults(companion, changes, env = process.env) {
  checkCompanion(companion);
  updateSettings(env, settings => {
    for (const key of ['model', 'effort']) {
      if (!Object.hasOwn(changes, key)) continue;
      if (changes[key] === null) {
        delete settings.companions?.[companion]?.[key];
      } else {
        const clean = String(changes[key] ?? '').trim();
        if (!clean) throw new Error(key === 'model' ? 'empty id' : 'empty effort');
        setCompanionSetting(settings, companion, key, clean);
      }
    }
    const entry = settings.companions?.[companion];
    if (entry && !Object.keys(entry).length) {
      delete settings.companions[companion];
      if (!Object.keys(settings.companions).length) delete settings.companions;
    }
  });
}

export function writeDefaultModel(id, companion = LEGACY_MODEL_COMPANION, env = process.env) {
  writeCompanionDefaults(companion, { model: id ?? '' }, env);
}

export function writeDefaultEffort(effort, companion = LEGACY_MODEL_COMPANION, env = process.env) {
  writeCompanionDefaults(companion, { effort: effort ?? '' }, env);
}

export function clearDefaultModel(companion = LEGACY_MODEL_COMPANION, env = process.env) {
  writeCompanionDefaults(companion, { model: null }, env);
}

export function clearDefaultEffort(companion = LEGACY_MODEL_COMPANION, env = process.env) {
  writeCompanionDefaults(companion, { effort: null }, env);
}

export function writeDefaultCompanion(id, env = process.env) {
  const clean = String(id ?? '').trim().toLowerCase();
  if (!clean) throw new Error('default companion: empty id');
  updateSettings(env, settings => { settings.companion = clean; });
}

export function clearDefaultCompanion(env = process.env) {
  updateSettings(env, settings => {
    delete settings.companion;
    delete settings.target;
  });
}

function legacyDefaults(env, log) {
  const dirs = stateDirs(env).map(({ host, dir }) => [host, refuseRealHomeUnderTest(resolve(dir), 'legacy state dir')]);
  const settings = {}, conflicts = [], migrated = [];
  for (const companion of [null, ...legacyModelIds]) {
    const setting = companion ? `companions.${companion}.model` : 'companion';
    const name = companion === null ? 'default-target' : companion === LEGACY_MODEL_COMPANION ? 'default-model' : `default-model-${companion}`;
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
    if (value && companion) setCompanionSetting(settings, companion, 'model', value);
    else if (value) settings.companion = value.toLowerCase();
    migrated.push(...entries);
  }
  return { settings, conflicts, migrated };
}

export function legacyDefaultConflicts(env = process.env) {
  return legacyDefaults(env).conflicts;
}

function moveDefaultCompanion(settings) {
  if (!Object.hasOwn(settings, 'target') || Object.hasOwn(settings, 'companion')) return false;
  settings.companion = settings.target;
  delete settings.target;
  return true;
}

// Onboarding previews read the same prospective settings without writing or
// consuming the one-shot migration. Normal readers only consult settings.json.
export function previewDefaults({ env = process.env, log = console.warn } = {}) {
  const settings = readSettings(settingsPath(env), log) ?? legacyDefaults(env, log).settings;
  moveDefaultCompanion(settings);
  return settings;
}

export function migrateDefaults({ env = process.env, log = console.warn } = {}) {
  const path = settingsPath(env);
  for (const { dir } of stateDirs(env)) {
    const old = refuseRealHomeUnderTest(resolve(dir, 'target-checks.json'), 'legacy checks file');
    try {
      // Publish without replacing a newer check, including one written concurrently.
      linkSync(old, join(dir, 'companion-checks.json'));
      rmSync(old, { force: true });
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EEXIST') throw err;
    }
  }
  const existing = readSettings(path, log);
  if (existing !== undefined) {
    if (moveDefaultCompanion(existing)) saveSettings(path, existing);
    return existing;
  }
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
  const m = String(model || '').trim();
  if (!m) return true;
  const companion = getCompanionById(companionId);
  return !!companion && (companion.runtime.modelPattern ?? /^\S+$/).test(m);
}

export function readCompanionChecks() {
  try { return JSON.parse(readFileSafe(join(BASE_DIR, 'companion-checks.json')) || '{}'); }
  catch { return {}; }
}

export function writeCompanionChecks(checks) {
  atomicWrite(join(BASE_DIR, 'companion-checks.json'), JSON.stringify(checks) + '\n');
}
