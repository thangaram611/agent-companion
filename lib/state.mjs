// Companion defaults and readiness checks.
// BASE_DIR is host-routed and bound at import. Current thread, job,
// result and completion records belong to controller/records.mjs.
// Each host owns a plugin/session-scoped bridge. Writes here are atomic/private.

import { readFileSync, mkdirSync } from 'node:fs';
import { getCompanionById, COMPANION_IDS } from './companion-registry.mjs';
import { loadSettings, readSettings, settingsPath } from './settings.mjs';
export { readDefaultCompanion, readSettings, settingsPath } from './settings.mjs';
import { join, dirname } from 'node:path';
import { writePrivateFileAtomic } from './private-files.mjs';

import { companionHomeDir, detectHost, refuseRealHomeUnderTest } from './hosts/index.mjs';

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

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(path, content);
}

function readFileSafe(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// Shared settings. Only job/history records are routed by host.
function updateSettings(env, update) {
  const path = settingsPath(env);
  let settings;
  try { settings = loadSettings(path) ?? {}; }
  catch (err) { throw new Error(`Refusing to overwrite settings. ${err.message}`, { cause: err }); }
  const before = JSON.stringify(settings);
  update(settings);
  if (JSON.stringify(settings) === before) return false;
  atomicWrite(path, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

function checkCompanion(companion) {
  if (!COMPANION_IDS.has(companion)) throw new Error('unknown companion');
}

export function readDefaultModel(companion, env = process.env, log = console.warn, settings) {
  checkCompanion(companion);
  const knob = getCompanionById(companion).runtime.modelEnv;
  const override = knob && String(env[knob] || '').trim();
  if (override) return { model: override, source: 'env' };
  const saved = settings ?? readSettings(settingsPath(env), log);
  const model = saved?.companions?.[companion]?.model?.trim();
  return model ? { model, source: 'config' } : { model: null, source: 'unset' };
}

export function readDefaultEffort(companion, env = process.env, log = console.warn, settings) {
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

export function writeDefaultModel(id, companion, env = process.env) {
  writeCompanionDefaults(companion, { model: id ?? '' }, env);
}

export function writeDefaultEffort(effort, companion, env = process.env) {
  writeCompanionDefaults(companion, { effort: effort ?? '' }, env);
}

export function clearDefaultModel(companion, env = process.env) {
  writeCompanionDefaults(companion, { model: null }, env);
}

export function clearDefaultEffort(companion, env = process.env) {
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
  });
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
