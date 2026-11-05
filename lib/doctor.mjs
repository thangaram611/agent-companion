// Environment diagnostics shared by the CLI doctor and MCP status surface.
//
// Health is companion-aware: the bridge lets you attach your companion, so a
// doctor run is OK when the common prerequisites pass AND the configured target
// (or, if none is configured, at least one selectable target) is ready. Copilot is
// never required for an OpenCode-only install, and vice versa.

import {
  bridgeLogFile,
  digestDir,
  promptJsonlDir,
  queuePath,
  runtimeDir,
} from './runtime-paths.mjs';
import {
  inspectTargets,
  targetReadinessSummary,
  probeCommand,
  memoizeProbe,
} from './target-diagnostics.mjs';
import { readDefaultTarget } from './state.mjs';
// Doctor used to carry its own copy of this helper. They drifted: the copy in
// target-diagnostics.mjs was the only one anyone thought to look at, so neither
// got a timeout. One shared probe (see probeCommand's comment for why the
// timeout matters) means there is nowhere left for that to happen.
const runCommand = probeCommand;

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

// Codex-as-HOST-prerequisite probe (report.codex — "can it host/install the
// plugin?"), distinct from the codex-as-TARGET readiness probe
// (report.targets.codex — "is it ready to receive delegated jobs?", see
// lib/target-diagnostics.mjs). Both ask about the same `codex` binary but
// stay disambiguated by report namespace + disjoint arg-tuples (`--version` +
// `plugin add --help` here vs `login status` there), so honoring CODEX_BIN
// here keeps the two arms coherent instead of one following an override the
// other ignores.
function codexInfo(run = runCommand, env = process.env) {
  const bin = String(env.CODEX_BIN || 'codex').trim() || 'codex';
  const version = commandVersion(bin, ['--version'], run);
  if (!version.found) return { ...version, pluginAdd: false };
  return {
    ...version,
    pluginAdd: run(bin, ['plugin', 'add', '--help']).ok,
  };
}

export function buildDoctorReport({
  run = runCommand,
  env = process.env,
  nodeVersion = process.versions.node,
} = {}) {
  // Share repeated prerequisite probes within this report.
  const probe = memoizeProbe(run);
  const targets = inspectTargets({ run: probe, env });
  const defaultTarget = readDefaultTarget(env);
  const report = {
    node: nodeInfo(nodeVersion),
    npm: commandVersion('npm', ['--version'], probe),
    jq: commandVersion('jq', ['--version'], probe),
    claude: commandVersion('claude', ['--version'], probe),
    codex: codexInfo(probe, env),
    defaultTarget,
    targets,
    runtime: {
      dir: runtimeDir(),
      queue: queuePath(),
      bridgeLog: bridgeLogFile(),
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

  report.warnings = warnings;
  report.ok = Boolean(commonOk && targetOk);

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
  for (const w of report.warnings || []) lines.push(`! ${w}`);
  return lines.join('\n');
}
