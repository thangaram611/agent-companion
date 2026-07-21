// Target readiness diagnostics.
//
// Answers "is this user's machine ready to delegate to <target>?" without
// spending AI quota or running a task. Readiness is deliberately explicit:
//
//   installed   — binary resolves and a version command succeeds.
//   authenticated — proven cheaply (true), proven-not-configured (false), or
//                   unprovable-without-a-task ('unknown'). Never false-green.
//   permission.readyForNonInteractive — can the bridge run unattended without
//                   hanging on an approval prompt?
//   ready       — usable by agent_send with no hard blockers.
//
// `run` and `env` are injectable so tests can simulate any machine state.

import { execFileSync } from 'node:child_process';

import {
  getTargetById,
  listTargetIds,
  TARGET_IDS,
} from './target-registry.mjs';
import { readDefaultTarget, isModelAllowedFor } from './state.mjs';
import {
  loadProfiles,
  getProfile,
  resolveStrength,
  STRENGTH_CAPABILITY_REQUIREMENTS,
} from './profile-registry.mjs';

// Every diagnostics probe in the plugin funnels through this one function —
// target readiness, profile inspection and the doctor report all use it — so
// the timeout below cannot be present on one probe path and missing on another.
//
// The timeout is load-bearing, not hygiene. `execFileSync` blocks the calling
// thread, and the bridge only has one: a companion binary that hangs (stalled
// on a TTY auth prompt, a wedged network call, a half-dead daemon socket)
// would otherwise wedge `agent_status({diagnostics:true})` forever and take
// every in-flight job on that bridge down with it. Both agent templates tell
// the subagent to call that tool, so it is a routine call, not a rare one.
//
// 120s matches the smoke budget in scripts/onboard.mjs, which shells out to the
// same class of binary.
export const PROBE_TIMEOUT_MS = 120_000;

export function probeCommand(cmd, args = [], { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    return {
      ok: true,
      output: execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        // SIGKILL, not the default SIGTERM. `timeout` does not abandon the
        // child — it signals it and keeps blocking until it actually exits, so
        // with a catchable signal a process that traps SIGTERM (or whose
        // shutdown path is itself wedged, which is the failure we are guarding
        // against) blocks for its full lifetime while still reporting
        // ETIMEDOUT. That is the original hang with a reassuring label on it.
        // SIGKILL cannot be caught, so the budget is a real bound.
        killSignal: 'SIGKILL',
      }).trim(),
    };
  } catch (err) {
    // A timed-out child is killed by signal, so it carries no stderr and its
    // message is the opaque `spawnSync <cmd> ETIMEDOUT`. Say what happened, or
    // the doctor report renders a hung binary identically to a missing one.
    if (err.code === 'ETIMEDOUT') {
      return { ok: false, timedOut: true, output: `\`${cmd}\` did not respond within ${timeoutMs}ms and was killed` };
    }
    return { ok: false, output: String(err.stderr || err.message || '').trim() };
  }
}

// Collapse repeat probes of the same (cmd, args) within a single diagnostics
// pass. Doctor inspects each target once and then again for every profile that
// routes to it, so an N-profile install used to pay N+1 × `opencode --version`
// + `opencode models`. With a per-probe timeout that repetition is no longer
// just wasted time — it multiplies the worst-case stall by the profile count.
export function memoizeProbe(run) {
  const cache = new Map();
  return (cmd, args = [], opts) => {
    // NUL-joined: a space separator would make ('a b', []) and ('a', ['b'])
    // collide into one cache entry. `opts` is part of the key because
    // probeCommand takes a per-call timeout, and two probes of the same command
    // under different budgets are not interchangeable results.
    const key = [cmd, ...args].join('\u0000') + (opts ? `\u0000${JSON.stringify(opts)}` : '');
    if (!cache.has(key)) cache.set(key, run(cmd, args, opts));
    return cache.get(key);
  };
}

const defaultRun = probeCommand;

// Resolve which binary name(s) to probe: an explicit env override wins,
// otherwise every known candidate name is tried in order.
function binaryCandidates(descriptor, env) {
  const override = String(env[descriptor.binaryEnv] || '').trim();
  if (override) return { candidates: [override], source: 'env' };
  return { candidates: descriptor.binaryNames.slice(), source: 'path' };
}

function probeInstall(descriptor, env, run) {
  const { candidates, source } = binaryCandidates(descriptor, env);
  for (const name of candidates) {
    const res = run(name, descriptor.versionArgs || ['--version']);
    if (res.ok) {
      return {
        installed: true,
        binary: name,
        binarySource: source,
        version: res.output.split('\n')[0] || null,
      };
    }
  }
  return { installed: false, binary: null, binarySource: source, version: null };
}

// OpenCode: `opencode models` lists configured provider models. Output means
// authenticated; empty/failure means a provider still needs connecting.
// Copilot: no cheap probe, so we stay honest with 'unknown'.
function probeAuth(descriptor, env, run, install) {
  if (!install.installed) return { authenticated: 'unknown', detail: null };
  const checks = descriptor.auth?.checkCommands || [];
  if (checks.length === 0) return { authenticated: 'unknown', detail: null };
  for (const [cmd, args] of checks) {
    // A checkCommand that invokes the target's own binary must use the
    // resolved binary (which may be an OPENCODE_BIN override), not the bare
    // PATH name baked into the descriptor — otherwise an override that isn't
    // on PATH makes the auth check spuriously fail.
    const bin = cmd === descriptor.binaryNames[0] ? install.binary : cmd;
    const res = run(bin, args);
    if (res.ok && res.output) return { authenticated: true, detail: null };
  }
  return { authenticated: false, detail: 'check command returned no configured result' };
}

function probePermission(descriptor, env) {
  const perm = descriptor.permission || {};
  if (!perm.bridgeEnv) {
    // Target manages permissions itself (Copilot trust/approvals).
    return { mode: 'managed', readyForNonInteractive: 'unknown', risk: 'normal' };
  }
  const mode = String(env[perm.bridgeEnv] || '').trim().toLowerCase();
  if (mode === perm.dangerousMode || mode === 'skip' || mode === 'dangerously-skip') {
    return { mode: 'skip', readyForNonInteractive: true, risk: 'dangerous' };
  }
  // Default mode: unattended runs may stop on a permission prompt unless the
  // user configured OpenCode's own permission rules (which we can't detect).
  return { mode: 'default', readyForNonInteractive: 'unknown', risk: 'normal' };
}

export function inspectTarget(id, { run = defaultRun, env = process.env } = {}) {
  const descriptor = getTargetById(id);
  if (!descriptor) {
    return {
      id: String(id || '').trim().toLowerCase() || null,
      displayName: null,
      ready: false,
      installed: false,
      blockers: [{ code: 'unknown_target', message: `Unknown target "${id}". Supported: ${[...TARGET_IDS].join(', ')}.` }],
      warnings: [],
      nextSteps: [],
    };
  }

  const { target: configured } = readDefaultTarget(env);
  const configuredDefault = configured === descriptor.id;

  const install = probeInstall(descriptor, env, run);
  const auth = probeAuth(descriptor, env, run, install);
  const permission = probePermission(descriptor, env);

  const blockers = [];
  const warnings = [];
  const nextSteps = [];

  if (!install.installed) {
    blockers.push({
      code: 'missing_binary',
      message: `${descriptor.displayName} is not installed. Install it: ${descriptor.install.commands[0]} (${descriptor.install.docs})`,
    });
    nextSteps.push(...descriptor.install.commands.map((c) => c));
  }

  if (install.installed && auth.authenticated === false) {
    blockers.push({
      code: descriptor.id === 'opencode' ? 'needs_provider' : 'needs_auth',
      message: `${descriptor.displayName} has no configured ${descriptor.id === 'opencode' ? 'provider/model' : 'authentication'}. See ${descriptor.auth.docs}`,
    });
    nextSteps.push(...(descriptor.auth.nextSteps || []));
  }

  if (install.installed && auth.authenticated === 'unknown') {
    warnings.push({
      code: 'auth_unknown',
      message: `${descriptor.displayName} authentication could not be verified without starting a task. See ${descriptor.auth.docs}`,
    });
    nextSteps.push(...(descriptor.auth.nextSteps || []));
  }

  if (install.installed && permission.risk === 'dangerous') {
    warnings.push({
      code: 'dangerous_permissions',
      message: `${descriptor.displayName} is set to skip permission prompts (dangerous auto-approval via ${descriptor.permission.bridgeEnv}=skip).`,
    });
  } else if (install.installed && permission.mode === 'default' && descriptor.permission?.bridgeEnv) {
    warnings.push({
      code: 'interactive_permissions',
      message: `Unattended ${descriptor.displayName} runs may stop on a permission prompt unless you configure its permission rules (${descriptor.permission.docs}).`,
    });
  }

  const ready = install.installed && auth.authenticated !== false;

  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    configuredDefault,
    installed: install.installed,
    binary: install.binary,
    binarySource: install.binarySource,
    version: install.version,
    authenticated: auth.authenticated,
    permission,
    smoke: {
      supported: true,
      run: false,
      passed: null,
      safeByDefault: !!descriptor.smoke?.safeByDefault,
    },
    ready,
    blockers,
    warnings,
    nextSteps: [...new Set(nextSteps)],
  };
}

export function inspectTargets({ run = defaultRun, env = process.env } = {}) {
  const out = {};
  for (const id of listTargetIds()) out[id] = inspectTarget(id, { run, env });
  return out;
}

export function targetReadinessSummary(report) {
  if (!report) return 'unknown target';
  const name = report.displayName || report.id || 'target';
  if (report.ready) {
    const warn = report.warnings?.length ? ` (${report.warnings.length} warning${report.warnings.length > 1 ? 's' : ''})` : '';
    return `${name}: ready${warn}`;
  }
  if (!report.installed) return `${name}: not installed`;
  const blocker = report.blockers?.[0]?.message || 'not ready';
  return `${name}: not ready — ${blocker}`;
}

// --------------------------------------------------------- profile readiness
//
// A profile inherits its companion's install/auth/permission readiness (via
// inspectTarget — tri-state `authenticated` is preserved, never false-green)
// and layers profile-level gates on top: model validity, adapter coherence, and
// the (v1 no-op) strength capability requirements. The synthesized legacy
// profile is never inspected or listed.

// Verify an opencode `provider/model` pin against `opencode models` output (the
// same cheap auth probe the target uses). true = listed, false = not listed,
// 'unknown' = could not probe.
function opencodeModelListed(model, companionReport, run) {
  if (!companionReport.installed || !companionReport.binary) return 'unknown';
  const res = run(companionReport.binary, ['models']);
  if (!res.ok || !res.output) return 'unknown';
  return res.output.split('\n').some((line) => line.trim() === model || line.includes(model));
}

export function inspectProfile(profileId, { run = defaultRun, env = process.env, load = null } = {}) {
  const registry = load || loadProfiles({ env });
  const profile = getProfile(registry, profileId);
  if (!profile || profile.synthesized) {
    return {
      id: profileId, companion: null, model: null, adapter: null, strengths: [],
      installed: false, authenticated: 'unknown', modelValid: 'unknown', adapterCoherent: true,
      ready: false,
      blockers: [{ code: 'unknown_profile', message: `Unknown profile "${profileId}".` }],
      warnings: [],
    };
  }

  const companion = inspectTarget(profile.companion, { run, env });
  const blockers = [...(companion.blockers || [])];
  const warnings = [...(companion.warnings || [])];

  // (b) model validity.
  let modelValid = 'unknown';
  if (profile.model) {
    if (!isModelAllowedFor(profile.companion, profile.model)) {
      modelValid = false;
      blockers.push({
        code: 'model_invalid',
        message: profile.companion === 'copilot'
          ? `model "${profile.model}" is not a documented Copilot model.`
          : `model "${profile.model}" is not a valid provider/model pin.`,
      });
    } else if (profile.companion === 'opencode') {
      const listed = opencodeModelListed(profile.model, companion, run);
      if (listed === true) modelValid = true;
      else {
        modelValid = 'unknown';
        warnings.push({ code: 'model_unverified', message: `model "${profile.model}" not found in \`opencode models\`; cannot confirm it is configured.` });
      }
    } else {
      // copilot: documented id, but availability is unprovable without a turn.
      modelValid = 'unknown';
    }
  }

  // (c) adapter coherence (opencode server profile needs serverMode available).
  const caps = profile.capabilities || {};
  let adapterCoherent = true;
  if (profile.adapter === 'server' && !caps.serverMode) {
    adapterCoherent = false;
    blockers.push({ code: 'adapter_unavailable', message: 'adapter:"server" requested but server mode is unavailable in this environment.' });
  }

  // (d) strength capability requirements (no-op under the v1 empty map).
  let strengthCapsSatisfied = true;
  for (const strength of profile.strengths) {
    for (const reqCap of STRENGTH_CAPABILITY_REQUIREMENTS[strength] || []) {
      if (!caps[reqCap]) {
        strengthCapsSatisfied = false;
        blockers.push({ code: 'strength_capability_missing', message: `strength "${strength}" requires capability "${reqCap}" which ${profile.companion} lacks.` });
      }
    }
  }

  const ready = !!companion.ready && modelValid !== false && adapterCoherent && strengthCapsSatisfied;
  return {
    id: profile.id,
    companion: profile.companion,
    model: profile.model,
    adapter: profile.adapter,
    strengths: profile.strengths.slice(),
    installed: companion.installed,
    authenticated: companion.authenticated,
    modelValid,
    adapterCoherent,
    ready,
    blockers,
    warnings,
  };
}

// Inspect every configured (non-synthesized) profile. Returns an array.
export function inspectProfiles({ run = defaultRun, env = process.env, load = null } = {}) {
  const registry = load || loadProfiles({ env });
  const probe = memoizeProbe(run);
  return registry.profiles
    .filter((p) => !p.synthesized)
    .map((p) => inspectProfile(p.id, { run: probe, env, load: registry }));
}

export function profileReadinessSummary(report) {
  if (!report) return 'unknown profile';
  const name = report.id || 'profile';
  const route = `${name} → ${report.companion || '?'}${report.model ? ` (${report.model})` : ''}`;
  if (report.ready) {
    const warn = report.warnings?.length ? ` (${report.warnings.length} warning${report.warnings.length > 1 ? 's' : ''})` : '';
    return `${route}: ready${warn}`;
  }
  const blocker = report.blockers?.[0]?.message || 'not ready';
  return `${route}: not ready — ${blocker}`;
}

// Pure strength → readiness projection from an already-loaded registry plus the
// already-inspected profiles (so doctor inspects each profile exactly once).
// Each strength claimed by ≥1 profile maps to { profileId|null, ready, ambiguous }.
export function strengthsSummary(registry, inspectedProfiles = []) {
  const readyById = new Map(inspectedProfiles.map((p) => [p.id, p.ready]));
  const out = {};
  for (const strength of registry.byStrength.keys()) {
    const r = resolveStrength(registry, strength);
    if (r.status === 'ambiguous') {
      out[strength] = { profileId: null, ready: false, ambiguous: true };
    } else {
      out[strength] = { profileId: r.profileId, ready: !!readyById.get(r.profileId), ambiguous: false };
    }
  }
  return out;
}
