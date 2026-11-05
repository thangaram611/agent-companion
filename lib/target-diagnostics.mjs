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

import {
  getTargetById,
  listTargetIds,
  TARGET_IDS,
} from './target-registry.mjs';
import { readDefaultTarget, readTargetChecks } from './state.mjs';
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { probeCommand, PROBE_TIMEOUT_MS } from './command-probe.mjs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export { probeCommand, PROBE_TIMEOUT_MS } from './command-probe.mjs';

// The one file reader an auth probe gets: a string, or null when the file is
// not there or not readable. Injectable, like `run`, so a test can describe
// any machine.
function defaultReadFile(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// Every diagnostics probe in the plugin funnels through this one function —
// target readiness and the doctor report all use it — so
// the timeout below cannot be present on one probe path and missing on another.
//
// The timeout is load-bearing, not hygiene. A synchronous child blocks the calling
// thread, and the bridge only has one: a companion binary that hangs (stalled
// on a TTY auth prompt, a wedged network call, an unresponsive provider probe)
// would otherwise wedge `agent_status({diagnostics:true})` forever and take
// every in-flight job on that bridge down with it. Both agent templates tell
// the subagent to call that tool, so it is a routine call, not a rare one.
//
// 120s matches the smoke budget in scripts/onboard.mjs, which shells out to the
// same class of binary.
// Collapse repeat probes of the same command within a diagnostics pass.
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
const checkedTargets = new Map();

// Catalog reads only this evidence (or the last onboarding check on disk).
// It must never run an installation/auth probe itself.
export function lastTargetChecks() {
  return { ...readTargetChecks(), ...Object.fromEntries(checkedTargets) };
}

// Resolve which binary name(s) to probe: an explicit env override wins,
// otherwise every known candidate name is tried in order.
function binaryCandidates(descriptor, env) {
  const override = String(env[descriptor.binaryEnv] || '').trim();
  if (override) return { candidates: [override], source: 'env' };
  return { candidates: descriptor.binaryNames.slice(), source: 'path' };
}

// Whether agent_send may start an execution for a companion. Refusal
// (CAPABILITY_UNAVAILABLE) needs evidence: a cached readiness check decides when
// one exists; without one, a companion whose binary resolves (env override or a
// PATH candidate) is ready. Nothing here spawns a process or writes state.
export function companionReady(id, env = process.env, checks = lastTargetChecks()) {
  const check = checks[id];
  if (check && typeof check.ready === 'boolean') return check.ready;
  const descriptor = getTargetById(id);
  if (!descriptor) return false;
  return binaryCandidates(descriptor, env).candidates.some((candidate) => executableResolves(candidate, env));
}

function executableResolves(candidate, env) {
  const isExecutable = (file) => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } };
  if (candidate.includes('/')) return isExecutable(candidate);
  return String(env.PATH || '').split(':').filter(Boolean).some((dir) => isExecutable(join(dir, candidate)));
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

// OpenCode's descriptor checks the v1 model list or v2 native connections.
// Copilot: no cheap probe, so we stay honest with 'unknown'.
// Codex (`descriptor.auth.checkByExitCode`): `codex login status` prints its
// verdict to STDERR with empty stdout in BOTH the logged-in and logged-out
// case (live-verified on 0.145.0) — the stdout-based rule below would
// false-red a logged-in machine, so exit code alone decides authenticated.
// Antigravity (`descriptor.auth.probe`): no command answers without a turn,
// so the descriptor reads the server's own credential state — its
// `settings.json` through the injected reader, the keychain item through
// the injected runner — and says which it found.
function probeAuth(descriptor, env, run, install, { readFile, home, platform }) {
  if (!install.installed) return { authenticated: 'unknown', detail: null };
  if (typeof descriptor.auth?.probe === 'function') {
    const verdict = descriptor.auth.probe({ env, home, readFile, run, platform, install });
    return { authenticated: verdict?.authenticated ?? 'unknown', detail: verdict?.detail ?? null };
  }
  const checks = descriptor.auth?.checkCommands || [];
  if (checks.length === 0) return { authenticated: 'unknown', detail: null };
  const byExitCode = !!descriptor.auth?.checkByExitCode;
  for (const [cmd, args] of checks) {
    // A checkCommand that invokes the target's own binary must use the
    // resolved binary (which may be an OPENCODE_BIN/CODEX_BIN override), not
    // the bare PATH name baked into the descriptor — otherwise an override
    // that isn't on PATH makes the auth check spuriously fail.
    const bin = cmd === descriptor.binaryNames[0] ? install.binary : cmd;
    const res = run(bin, args);
    if (byExitCode) {
      if (res.ok) return { authenticated: true, detail: null };
      continue;
    }
    if (res.ok && res.output) return { authenticated: true, detail: null };
  }
  return { authenticated: false, detail: 'check command returned no configured result' };
}

// A knob that is a closed set of named modes (Codex's sandbox, Antigravity's
// permission policy — unlike OpenCode's binary prompt/skip). The set lives on
// the descriptor (`permission.modes`), and `permission.dangerousModes` names
// the members to flag: two for Codex (danger-full-access, bypass —
// independently dangerous), none for Antigravity (see its descriptor).
function probeSandboxPermission(perm, env) {
  const raw = String(env[perm.bridgeEnv] || '').trim().toLowerCase();
  const recognized = (perm.modes || []).includes(raw);
  const mode = recognized ? raw : perm.safeDefault;
  const source = !raw ? 'default' : recognized ? 'env' : 'fallback';
  const risk = perm.dangerousModes.includes(mode) ? 'dangerous' : 'normal';
  // exec's approval policy is forced to `never` (no TTY) in every sandbox
  // mode, so unlike OpenCode there is no "may stop on a permission prompt"
  // state to report — the sandbox posture itself (mode + network) is the
  // only thing worth surfacing, and that already lives in `mode`.
  return { mode, source, readyForNonInteractive: true, risk };
}

function probePermission(descriptor, env) {
  const perm = descriptor.permission || {};
  if (Array.isArray(perm.dangerousModes)) return probeSandboxPermission(perm, env);
  return { mode: 'managed', readyForNonInteractive: 'unknown', risk: 'normal' };
}

function dangerousPermissionMessage(descriptor, permission) {
  const modeDesc = permission.mode === 'bypass'
    ? 'sandbox disabled entirely (bypass)'
    : `full disk+network access (${permission.mode})`;
  return `${descriptor.displayName} is set to run with ${modeDesc}.`;
}

export function inspectTarget(id, { run = defaultRun, env = process.env, readFile = defaultReadFile, home = homedir(), platform = process.platform } = {}) {
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
  const auth = probeAuth(descriptor, env, run, install, { readFile, home, platform });
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
      message: `${descriptor.displayName} has no configured ${descriptor.id === 'opencode' ? 'provider/model' : 'authentication'}${auth.detail ? ` (${auth.detail})` : ''}. See ${descriptor.auth.docs}`,
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
      message: dangerousPermissionMessage(descriptor, permission),
    });
  } else if (install.installed && permission.mode === 'default' && descriptor.permission?.bridgeEnv) {
    warnings.push({
      code: 'interactive_permissions',
      message: `Unattended ${descriptor.displayName} runs may stop on a permission prompt unless you configure its permission rules (${descriptor.permission.docs}).`,
    });
  }

  const ready = install.installed && auth.authenticated !== false;

  const report = {
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
  checkedTargets.set(descriptor.id, { ...report, checkedAt: new Date().toISOString() });
  return report;
}

export function inspectTargets({ run = defaultRun, env = process.env, readFile = defaultReadFile, home = homedir(), platform = process.platform } = {}) {
  const out = {};
  for (const id of listTargetIds()) out[id] = inspectTarget(id, { run, env, readFile, home, platform });
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
