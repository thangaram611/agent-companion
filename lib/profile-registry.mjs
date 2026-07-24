// Strength-routed companion profile registry — the single producer.
//
// `loadProfiles({env})` is the ONLY reader of profiles.json (it goes through
// state.mjs's `readProfilesRaw` primitive). Every consumer — resolveRouting,
// doctor, status, onboard, diagnostics — projects from its normalized return
// value; nothing else opens the file. The single-producer guard test
// (test/profile-registry-guard.test.mjs) greps the repo and fails on any other
// `PROFILES_FILE` / `readProfilesRaw` reference outside lib/state.mjs and this
// module.
//
// A profile is { id, companion (∈ TARGET_IDS), model?, strengths[], adapter? }.
// Profiles INHERIT capabilities from their companion via getTarget() — they
// never re-declare capability booleans. Capability is companion/adapter-level;
// model is profile-level and does not change capabilities. For an opencode
// profile with adapter:'server', capability resolution overlays
// OPENCODE_RUNTIME_ADAPTER=server synthetically (never mutating process.env).
//
// No on-disk schema version: the format is plain unversioned profiles.json. A
// whole-file parse error degrades to the synthesized-from-defaults back-compat
// path (never throws). A per-profile field violation DROPS that profile with a
// loadError surfaced by doctor.

import {
  readProfilesRaw,
  pickDefaultProfile,
  readDefaultTarget,
  readDefaultModel,
} from './state.mjs';
import { TARGET_IDS, getTarget } from './target-registry.mjs';

// The closed strength vocabulary. Single-sourced here; validation.mjs imports
// only this set (never loadProfiles) so the validator stays socket/process/
// file-free.
export const VALID_STRENGTHS = new Set(['reviewer', 'web_researcher', 'planner', 'fast_executor']);

// Per-strength statically-knowable capability requirements. v1 ships an empty
// map (no strength intrinsically demands reply/resume/streaming/parallel). The
// map is fully wired into the capability gate (server STEP C) and doctor
// (inspectProfile) but is a no-op until a list is populated — doing so later
// enforces a requirement pre-spawn with zero other changes.
export const STRENGTH_CAPABILITY_REQUIREMENTS = {
  reviewer: [],
  web_researcher: [],
  planner: [],
  fast_executor: [],
};

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SYNTHESIZED_ID = '__default__';

// Resolve the capabilities a profile inherits from its companion. opencode
// adapter:'server' overlays OPENCODE_RUNTIME_ADAPTER for THIS profile only.
// Returns null for an unconfigured/unknown companion.
export function resolveProfileCapabilities(profile, env = process.env) {
  if (!profile || !profile.companion) return null;
  const overlayEnv = (profile.companion === 'opencode' && profile.adapter === 'server')
    ? { ...env, OPENCODE_RUNTIME_ADAPTER: 'server' }
    : env;
  const target = getTarget(profile.companion, overlayEnv);
  return target ? target.capabilities : null;
}

// Validate + normalize one raw profile entry. Returns { profile } on success or
// { error } (a per-profile loadError) on a field violation → caller drops it.
function normalizeProfile(raw, env) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: { scope: 'profile', id: null, message: 'profile entry must be an object' } };
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || !PROFILE_ID_RE.test(id)) {
    return { error: { scope: 'profile', id: id || null, message: `invalid profile id "${raw.id}" (must match ${PROFILE_ID_RE})` } };
  }

  const companion = typeof raw.companion === 'string' ? raw.companion.trim().toLowerCase() : '';
  if (!companion) {
    return { error: { scope: 'profile', id, message: `profile "${id}" is missing required "companion"` } };
  }
  if (!TARGET_IDS.has(companion)) {
    return { error: { scope: 'profile', id, message: `profile "${id}" has unknown companion "${companion}" (supported: ${[...TARGET_IDS].join(', ')})` } };
  }

  let model = null;
  if (raw.model !== undefined && raw.model !== null) {
    if (typeof raw.model !== 'string') {
      return { error: { scope: 'profile', id, message: `profile "${id}" model must be a string` } };
    }
    model = raw.model.trim() || null;
  }

  let adapter = null;
  if (raw.adapter !== undefined && raw.adapter !== null) {
    if (typeof raw.adapter !== 'string' || !['cli', 'server'].includes(raw.adapter.trim().toLowerCase())) {
      return { error: { scope: 'profile', id, message: `profile "${id}" adapter must be "cli" or "server"` } };
    }
    adapter = raw.adapter.trim().toLowerCase();
    if (companion !== 'opencode') {
      return { error: { scope: 'profile', id, message: `profile "${id}" sets adapter on companion "${companion}" — adapter is opencode-only` } };
    }
  }

  // strengths: lowercase + de-dupe; an unknown label is dropped (with a
  // loadError) but the profile survives with its valid strengths.
  const strengths = [];
  const labelErrors = [];
  if (raw.strengths !== undefined && raw.strengths !== null) {
    if (!Array.isArray(raw.strengths)) {
      return { error: { scope: 'profile', id, message: `profile "${id}" strengths must be an array` } };
    }
    for (const entry of raw.strengths) {
      const label = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
      if (!label || !VALID_STRENGTHS.has(label)) {
        labelErrors.push({ scope: 'strength', id, message: `profile "${id}" drops unknown strength "${entry}" (valid: ${[...VALID_STRENGTHS].join(', ')})` });
        continue;
      }
      if (!strengths.includes(label)) strengths.push(label);
    }
  }

  const profile = {
    id,
    companion,
    model,
    strengths,
    adapter,
    synthesized: false,
  };
  profile.capabilities = resolveProfileCapabilities(profile, env);
  return { profile, labelErrors };
}

// Build one degenerate __default__ profile mirroring the legacy bare-target
// semantics exactly (copilot model from default-model, opencode model from env,
// capabilities inherited). companion may be null when no default-target is
// configured — resolveRouting turns that into TARGET_UNCONFIGURED. profileId is
// null downstream (legacy sid path).
export function buildSynthesizedProfile(companion, env = process.env) {
  let model = null;
  if (companion === 'copilot') model = readDefaultModel().model;
  else if (companion === 'opencode') model = String(env.AGENT_COMPANION_OPENCODE_MODEL || '').trim() || null;
  else if (companion === 'codex') model = String(env.AGENT_COMPANION_CODEX_MODEL || '').trim() || null;
  const profile = {
    id: SYNTHESIZED_ID,
    companion,
    model,
    strengths: [],
    adapter: null,
    synthesized: true,
  };
  profile.capabilities = resolveProfileCapabilities(profile, env);
  return profile;
}

// Build the synthesized-from-defaults registry used when profiles.json is
// absent or corrupt, wrapping the degenerate __default__ profile
// (companion = default-target) in a registry view.
function synthesizeRegistry(env) {
  const companion = readDefaultTarget(env).target; // may be null
  const profile = buildSynthesizedProfile(companion, env);
  const byId = new Map([[SYNTHESIZED_ID, profile]]);
  return {
    profiles: [profile],
    byId,
    byStrength: new Map(),
    defaultProfile: { value: SYNTHESIZED_ID, source: 'synthesized' },
    loadErrors: [],
    synthesized: true,
  };
}

// The single producer. Reads profiles.json once and returns a fully normalized,
// deterministic, side-effect-free registry view.
export function loadProfiles({ env = process.env } = {}) {
  const raw = readProfilesRaw();
  if (raw == null) return synthesizeRegistry(env);

  const loadErrors = [];
  const entries = Array.isArray(raw.profiles) ? raw.profiles : null;
  if (entries == null && raw.profiles !== undefined) {
    loadErrors.push({ scope: 'file', id: null, message: 'profiles.json "profiles" must be an array' });
  }

  const byId = new Map();
  const profiles = [];
  for (const entry of entries || []) {
    const { profile, error, labelErrors } = normalizeProfile(entry, env);
    if (error) { loadErrors.push(error); continue; }
    if (labelErrors?.length) loadErrors.push(...labelErrors);
    if (byId.has(profile.id)) {
      loadErrors.push({ scope: 'profile', id: profile.id, message: `duplicate profile id "${profile.id}" (later entries dropped)` });
      continue;
    }
    byId.set(profile.id, profile);
    profiles.push(profile);
  }

  const byStrength = new Map();
  for (const profile of profiles) {
    for (const strength of profile.strengths) {
      if (!byStrength.has(strength)) byStrength.set(strength, []);
      byStrength.get(strength).push(profile.id);
    }
  }

  const defaultProfile = pickDefaultProfile(env, raw.defaultProfile);
  if (defaultProfile.value && !byId.has(defaultProfile.value)) {
    loadErrors.push({
      scope: 'defaultProfile',
      id: defaultProfile.value,
      message: `defaultProfile "${defaultProfile.value}" (${defaultProfile.source}) names no configured profile`,
    });
  }

  return { profiles, byId, byStrength, defaultProfile, loadErrors, synthesized: false };
}

// --- Projections (every consumer uses these; nobody re-reads the file) -------

// All normalized profiles, including the synthesized one.
export function listProfiles(load) {
  return load.profiles.slice();
}

// Public, operator-facing view: excludes the synthesized profile, exposes only
// ids / model names / strength labels (never secrets).
export function listProfilesPublic(load) {
  return load.profiles
    .filter((p) => !p.synthesized)
    .map((p) => ({ id: p.id, companion: p.companion, model: p.model, strengths: p.strengths.slice(), adapter: p.adapter }));
}

export function getProfile(load, id) {
  if (id == null) return null;
  return load.byId.get(String(id).trim()) || null;
}

// Resolve a strength label to exactly one profile id. Cardinality:
//   0 claimants → { status: 'unconfigured' }
//   1 claimant  → { status: 'ok', profileId }
//   >1          → defaultProfile wins ONLY if it claims this strength; else
//                 { status: 'ambiguous', candidates } (never a silent winner).
export function resolveStrength(load, label) {
  const ids = load.byStrength.get(label) || [];
  if (ids.length === 0) return { status: 'unconfigured' };
  if (ids.length === 1) return { status: 'ok', profileId: ids[0] };
  const dp = load.defaultProfile?.value || null;
  if (dp && ids.includes(dp)) return { status: 'ok', profileId: dp };
  return { status: 'ambiguous', candidates: ids.slice() };
}

// Id-free, harness-facing strength view: one entry per VALID_STRENGTHS member
// with { name, ready, reason }. `isReady(profileId)` injects per-profile
// readiness (defaults to registry-only "configured ⇒ ready"). The reason string
// is deliberately id-free (the harness must never learn companion/model/profile
// ids) — the broadened leak test scans this whole payload.
export function flatStrengths(load, isReady = () => true) {
  return [...VALID_STRENGTHS].map((name) => {
    const ids = load.byStrength.get(name) || [];
    if (ids.length === 0) return { name, ready: false, reason: 'no profile declares this strength' };
    const resolution = resolveStrength(load, name);
    if (resolution.status === 'ambiguous') {
      return { name, ready: false, reason: 'multiple profiles declare this strength with no defaultProfile tiebreak' };
    }
    if (!isReady(resolution.profileId)) {
      return { name, ready: false, reason: 'no ready profile declares this strength' };
    }
    return { name, ready: true, reason: null };
  });
}
