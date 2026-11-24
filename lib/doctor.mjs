// Environment diagnostics shared by the CLI doctor and MCP status surface.
//
// Health is companion-aware: the bridge lets you attach your companion, so a
// doctor run is OK when the common prerequisites pass AND the configured companion
// (or, if none is configured, at least one selectable companion) is ready. Copilot is
// never required for an OpenCode-only install, and vice versa.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeRoot } from './hosts/runtime.mjs';
import {
  inspectCompanions,
  companionReadinessSummary,
  probeCommand,
  memoizeProbe,
} from './companion-diagnostics.mjs';
import { HOSTS } from './hosts/index.mjs';
import { previewDefaults, readDefaultCompanion } from './state.mjs';
// Doctor used to carry its own copy of this helper. They drifted: the copy in
// companion-diagnostics.mjs was the only one anyone thought to look at, so neither
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
    ok: major >= 26,
    required: '>=26',
  };
}

// Codex-as-HOST-prerequisite probe (report.codex — "can it host/install the
// plugin?"), distinct from the codex-as-COMPANION readiness probe
// (report.companions.codex — "is it ready to receive delegated jobs?", see
// lib/companion-diagnostics.mjs). Both ask about the same `codex` binary but
// stay disambiguated by report namespace + disjoint arg-tuples (`--version` +
// `plugin add --help` here vs `login status` there), so honoring CODEX_BIN
// here keeps the two arms coherent instead of one following an override the
// other ignores.
function codexInfo(run = runCommand, env = process.env) {
  const bin = String(env.CODEX_BIN || HOSTS.codex.id).trim() || HOSTS.codex.id;
  const version = commandVersion(bin, ['--version'], run);
  if (!version.found) return { ...version, pluginAdd: false };
  return {
    ...version,
    pluginAdd: run(bin, ['plugin', 'add', '--help']).ok,
  };
}

// Claude source loading is session-scoped. OpenCode source installs have a
// discoverable package; Codex and Copilot expose native installed-plugin lists.
function installedPlugin(host, env, probe) {
  if (host === HOSTS.claude) return null;
  if (host === HOSTS.opencode) {
    const file = join(host.configDir(env), 'plugins', 'agent-companion', 'package.json');
    try { return JSON.parse(readFileSync(file, 'utf8')).name === 'agent-companion'; }
    catch (err) { return err.code === 'ENOENT' ? false : null; }
  }
  const codex = host === HOSTS.codex;
  const bin = codex ? String(env.CODEX_BIN || '').trim() || host.id : host.id;
  const result = probe(bin, ['plugin', 'list', '--json']);
  if (!result.ok) return null;
  try {
    const list = JSON.parse(result.output);
    return codex
      ? list.installed.some(p => p.pluginId === 'agent-companion@agent-companion' && p.installed)
      : list.some(p => p.name === 'agent-companion' && p.marketplace === 'agent-companion');
  } catch { return null; }
}

export function buildDoctorReport({
  run = runCommand,
  env = process.env,
  nodeVersion = process.versions.node,
} = {}) {
  // Share repeated prerequisite probes within this report.
  const probe = memoizeProbe(run);
  const defaultCompanion = readDefaultCompanion(env, undefined, previewDefaults({ env }));
  const companions = inspectCompanions({ run: probe, env, configuredCompanion: defaultCompanion.companion });
  const report = {
    node: nodeInfo(nodeVersion),
    npm: commandVersion('npm', ['--version'], probe),
    jq: commandVersion('jq', ['--version'], probe),
    ...Object.fromEntries(Object.values(HOSTS).map(host => {
      const version = host.id === HOSTS.codex.id ? codexInfo(probe, env) : commandVersion(host.id, ['--version'], probe);
      let installMarkerPresent = false;
      try { installMarkerPresent = readFileSync(join(host.stateDir(env), '.host'), 'utf8').trim() === host.id; }
      catch { /* no install marker */ }
      return [host.id, { ...version, installMarkerPresent, installed: version.found ? installedPlugin(host, env, probe) : null }];
    })),
    defaultCompanion,
    companions,
    runtime: Object.fromEntries(Object.values(HOSTS).map(host => {
      const dir = runtimeRoot(host, env);
      return [host.id, { dir, bridgeLog: env.AGENT_BRIDGE_LOG_FILE || join(dir, 'agent-bridge.log') }];
    })),
  };

  const commonOk = Boolean(
    report.node.ok &&
    report.npm.found &&
    report.jq.found &&
    Object.keys(HOSTS).some(id => report[id].found)
  );

  // Companion health: a configured companion must have no hard blockers. With no
  // companion configured, at least one supported companion must be selectable
  // (ready), and we flag that selection is not persisted.
  let companionOk;
  const warnings = [];
  if (defaultCompanion.companion) {
    const t = companions[defaultCompanion.companion];
    companionOk = Boolean(t && t.ready);
    if (!t) {
      warnings.push(`Configured default companion "${defaultCompanion.companion}" is not a supported companion.`);
    }
  } else {
    const readyIds = Object.values(companions).filter((t) => t.ready).map((t) => t.id);
    companionOk = readyIds.length > 0;
    if (companionOk) {
      warnings.push('No default companion configured; companion selection is not persisted. Run `node scripts/onboard.mjs --companion <id> --set-default`.');
    } else {
      warnings.push('No companion is ready. Run `node scripts/onboard.mjs --list-companions` to see install/auth next steps.');
    }
  }

  report.warnings = warnings;
  report.ok = Boolean(commonOk && companionOk);

  return report;
}

// The common prerequisite report is synchronous. The CLI also checks the
// live host endpoints without blocking a bridge or sending a user message.
export async function inspectDoctor(options = {}) {
  const report = buildDoctorReport(options);
  for (const host of Object.values(HOSTS)) {
    if (host.diagnostics && (report[host.id].installed || report[host.id].installMarkerPresent)) {
      Object.assign(report[host.id], await host.diagnostics(options.env ?? process.env));
    }
  }
  return report;
}

export function renderDoctorReport(report) {
  const lines = [
    `agent-companion doctor: ${report.ok ? 'ok' : 'needs attention'}`,
    `node:    ${report.node.version} (${report.node.ok ? 'ok' : `requires ${report.node.required}`})`,
    `npm:     ${report.npm.version || 'missing'}`,
    `jq:      ${report.jq.version || 'missing'}`,
    ...Object.keys(HOSTS).map(id => {
      const { version, found, pluginAdd } = report[id];
      const detail = found && pluginAdd !== undefined ? ` (plugin add: ${pluginAdd ? 'ok' : 'missing'})` : '';
      return (id + ':').padEnd(9) + (version || 'missing') + detail + (report[id].installMarkerPresent ? ' (install marker present)' : '')
        + (report[id].installed == null ? '' : report[id].installed ? ' (plugin installed)' : ' (plugin absent)')
        + (report[id].detail ? ' — ' + report[id].detail : '');
    }),
    `default companion: ${report.defaultCompanion.companion || 'unset'} (${report.defaultCompanion.source})`,
  ];
  if (!report.node.ok) {
    lines.push(`agent-companion: Node.js 26 or newer is required (found ${report.node.version}). Upgrade with \`brew upgrade node\`, or install the current LTS from https://nodejs.org.`);
  }
  for (const t of Object.values(report.companions)) {
    lines.push(`  - ${companionReadinessSummary(t)}`);
    if (t.configuredDefault && t.nextSteps[0]) lines.push(`    Next: ${t.nextSteps[0]}`);
  }
  for (const w of report.warnings || []) lines.push(`! ${w}`);
  return lines.join('\n');
}
