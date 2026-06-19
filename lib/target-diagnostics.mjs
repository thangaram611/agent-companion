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
import { readDefaultTarget } from './state.mjs';

function defaultRun(cmd, args = []) {
  try {
    return {
      ok: true,
      output: execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    };
  } catch (err) {
    return { ok: false, output: String(err.stderr || err.message || '').trim() };
  }
}

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

// The configured default target plus its source, with no silent fallback.
export function selectConfiguredTarget({ env = process.env } = {}) {
  return readDefaultTarget(env);
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
