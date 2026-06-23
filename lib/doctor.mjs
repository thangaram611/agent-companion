// Environment diagnostics shared by the CLI doctor and MCP status surface.
//
// Health is companion-aware: the bridge lets you attach your companion, so a
// doctor run is OK when the common prerequisites pass AND the configured target
// (or, if none is configured, at least one selectable target) is ready. Copilot is
// never required for an OpenCode-only install, and vice versa.

import { execFileSync } from 'node:child_process';

import {
  bridgeLogFile,
  daemonLogFile,
  daemonSocketPath,
  digestDir,
  promptJsonlDir,
  queuePath,
  runtimeDir,
} from './runtime-paths.mjs';
import {
  inspectTargets,
  targetReadinessSummary,
  inspectProfile,
  profileReadinessSummary,
  strengthsSummary,
} from './target-diagnostics.mjs';
import { readDefaultTarget } from './state.mjs';
import { loadProfiles, getProfile } from './profile-registry.mjs';

function runCommand(cmd, args = []) {
  try {
    return {
      ok: true,
      output: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    };
  } catch (err) {
    return {
      ok: false,
      output: String(err.stderr || err.message || '').trim(),
    };
  }
}

function commandVersion(cmd, args = ['--version'], run = runCommand) {
  const result = run(cmd, args);
  return { found: result.ok, version: result.ok ? result.output.split('\n')[0] : null };
}

function nodeInfo(nodeVersion = process.versions.node) {
  const cleanVersion = String(nodeVersion || '').replace(/^v/, '');
  const major = Number(cleanVersion.split('.')[0]);
  return {
    found: true,
    version: `v${cleanVersion}`,
    ok: major >= 22,
    required: '>=22',
  };
}

function codexInfo(run = runCommand) {
  const version = commandVersion('codex', ['--version'], run);
  if (!version.found) return { ...version, pluginAdd: false };
  return {
    ...version,
    pluginAdd: run('codex', ['plugin', 'add', '--help']).ok,
    marketplaceAdd: run('codex', ['plugin', 'marketplace', 'add', '--help']).ok,
  };
}

export function buildDoctorReport({ run = runCommand, env = process.env, nodeVersion = process.versions.node } = {}) {
  const targets = inspectTargets({ run, env });
  const defaultTarget = readDefaultTarget(env);

  const report = {
    node: nodeInfo(nodeVersion),
    npm: commandVersion('npm', ['--version'], run),
    jq: commandVersion('jq', ['--version'], run),
    claude: commandVersion('claude', ['--version'], run),
    codex: codexInfo(run),
    defaultTarget,
    targets,
    runtime: {
      adapter: env.COPILOT_RUNTIME_ADAPTER || 'acp',
      dir: runtimeDir(),
      socket: daemonSocketPath(),
      queue: queuePath(),
      bridgeLog: bridgeLogFile(),
      daemonLog: daemonLogFile(),
      promptJsonlDir: promptJsonlDir(),
      digestDir: digestDir(),
    },
  };

  const commonOk = Boolean(
    report.node.ok &&
    report.npm.found &&
    report.jq.found &&
    (report.claude.found || report.codex.found)
  );

  // Target health: a configured target must have no hard blockers. With no
  // target configured, at least one supported target must be selectable
  // (ready), and we flag that selection is not persisted.
  let targetOk;
  const warnings = [];
  if (defaultTarget.target) {
    const t = targets[defaultTarget.target];
    targetOk = Boolean(t && t.ready);
    if (!t) {
      warnings.push(`Configured default target "${defaultTarget.target}" is not a supported target.`);
    }
  } else {
    const readyIds = Object.values(targets).filter((t) => t.ready).map((t) => t.id);
    targetOk = readyIds.length > 0;
    if (targetOk) {
      warnings.push('No default target configured; target selection is not persisted. Run `node scripts/onboard.mjs --target <id> --set-default`.');
    } else {
      warnings.push('No target is ready. Run `node scripts/onboard.mjs --list-targets` to see install/auth next steps.');
    }
  }

  // Strength-routed profile readiness. Additive: legacy installs (no
  // profiles.json → synthesized) and all-invalid installs (no valid profiles)
  // never gate `report.ok`. Only a profiles.json that physically exists with ≥1
  // valid profile can make a strength a blocker.
  const registry = loadProfiles({ env });
  const profiles = registry.profiles
    .filter((p) => !p.synthesized)
    .map((p) => inspectProfile(p.id, { run, env, load: registry }));
  report.profiles = profiles;
  report.strengths = strengthsSummary(registry, profiles);

  const hasProfiles = !registry.synthesized && profiles.length > 0;
  let strengthsOk = true;
  if (hasProfiles) {
    for (const profile of profiles) {
      if (!profile.ready) warnings.push(`Profile "${profile.id}" is not ready — ${profile.blockers?.[0]?.message || 'not ready'}`);
    }
    for (const [strength, info] of Object.entries(report.strengths)) {
      if (info.ambiguous) {
        // Both the no-tiebreak and inert-tiebreak (defaultProfile set but not a
        // claimant) cases gate report.ok: resolveStrength returns STRENGTH_
        // AMBIGUOUS for either, so the strength is genuinely unroutable at send
        // time. Reporting ok here would be a false-green that disagrees with
        // agent_send. The inert case additionally gets an explanatory advisory.
        strengthsOk = false;
        const dp = registry.defaultProfile?.value || null;
        if (dp && getProfile(registry, dp)) {
          warnings.push(`Strength "${strength}" is declared by multiple profiles and defaultProfile "${dp}" does not claim it (inert tiebreak); the send would return STRENGTH_AMBIGUOUS.`);
        } else {
          warnings.push(`Strength "${strength}" is declared by multiple profiles with no defaultProfile tiebreak.`);
        }
      } else if (!info.ready) {
        strengthsOk = false;
        warnings.push(`Strength "${strength}" has no ready profile.`);
      }
    }
    if (!registry.defaultProfile?.value && defaultTarget.target) {
      warnings.push('No defaultProfile configured; no-arg sends fall back to the default target. Set one with `node scripts/onboard.mjs --set-default-profile <id>`.');
    }
    for (const e of registry.loadErrors) {
      warnings.push(`profiles.json: ${e.message}`);
    }
  }

  report.warnings = warnings;
  report.ok = Boolean(commonOk && targetOk && strengthsOk);

  return report;
}

export function renderDoctorReport(report) {
  const lines = [
    `agent-companion doctor: ${report.ok ? 'ok' : 'needs attention'}`,
    `node:    ${report.node.version} (${report.node.ok ? 'ok' : `requires ${report.node.required}`})`,
    `npm:     ${report.npm.version || 'missing'}`,
    `jq:      ${report.jq.version || 'missing'}`,
    `claude:  ${report.claude.version || 'missing'}`,
    `codex:   ${report.codex.version || 'missing'}${report.codex.found ? ` (plugin add: ${report.codex.pluginAdd ? 'ok' : 'missing'})` : ''}`,
    `default target: ${report.defaultTarget.target || 'unset'} (${report.defaultTarget.source})`,
  ];
  for (const t of Object.values(report.targets)) {
    lines.push(`  - ${targetReadinessSummary(t)}`);
  }
  if (report.profiles?.length) {
    lines.push('profiles:');
    for (const p of report.profiles) lines.push(`  - ${profileReadinessSummary(p)}`);
  }
  if (report.strengths && Object.keys(report.strengths).length) {
    lines.push('strengths:');
    for (const [name, info] of Object.entries(report.strengths)) {
      const state = info.ambiguous ? 'ambiguous (no tiebreak)' : info.ready ? `ready → ${info.profileId}` : 'no ready profile';
      lines.push(`  - ${name}: ${state}`);
    }
  }
  lines.push(`runtime: ${report.runtime.dir} (adapter: ${report.runtime.adapter})`);
  for (const w of report.warnings || []) lines.push(`! ${w}`);
  return lines.join('\n');
}
