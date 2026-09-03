// Environment diagnostics shared by the CLI doctor and MCP status surface.
//
// Health is companion-aware: the bridge lets you attach your companion, so a
// doctor run is OK when the common prerequisites pass AND the configured target
// (or, if none is configured, at least one selectable target) is ready. Copilot is
// never required for an OpenCode-only install, and vice versa.

import {
  bridgeLogFile,
  daemonLogFile,
  daemonSocketPath,
  digestDir,
  promptJsonlDir,
  queuePath,
  runtimeDir,
} from './runtime-paths.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import {
  inspectTargets,
  targetReadinessSummary,
  inspectProfile,
  profileReadinessSummary,
  strengthsSummary,
  probeCommand,
  memoizeProbe,
} from './target-diagnostics.mjs';
import { readDefaultTarget } from './state.mjs';
import { loadProfiles, getProfile } from './profile-registry.mjs';
import { inspectCodexAppServerInstallation } from './codex-install.mjs';
import { codexBrokerStaleReasons } from '../bridge-server/codex-app-server-runtime.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODEX_BROKER_PROBE = pathResolve(__dirname, '..', 'scripts', 'probe-codex-broker.mjs');
const CODEX_BROKER_COLD_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK']);

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

function normalizeCodexBrokerProbe(value) {
  const broker = value && typeof value === 'object'
    ? { ...value }
    : { alive: false, ready: false, code: null, error: 'broker probe returned no object', probeFailed: true };
  const alive = broker.alive === true;
  const cold = !alive && CODEX_BROKER_COLD_CODES.has(broker.code);
  const probeFailed = Boolean(broker.probeFailed || (!alive && !cold));
  const probeState = alive ? 'running' : probeFailed ? 'indeterminate' : 'not_running';
  return {
    ...broker,
    alive,
    ready: alive && broker.ready === true,
    probeFailed,
    indeterminate: probeState === 'indeterminate',
    probeState,
  };
}

function probeCodexBrokerSync(run = runCommand) {
  const result = run(process.execPath, [CODEX_BROKER_PROBE], { timeoutMs: 7_000 });
  if (!result.ok) {
    return normalizeCodexBrokerProbe({
      alive: false,
      ready: false,
      code: null,
      error: result.output || 'broker probe failed',
      probeFailed: true,
    });
  }
  try {
    const parsed = JSON.parse(result.output);
    return normalizeCodexBrokerProbe(parsed);
  } catch (err) {
    return normalizeCodexBrokerProbe({
      alive: false,
      ready: false,
      code: null,
      error: `broker probe returned invalid JSON: ${err.message}`,
      probeFailed: true,
    });
  }
}

function codexAppServerDiagnostics({ env, run, inspectInstall, probeBroker }) {
  const active = String(env.CODEX_RUNTIME_ADAPTER || 'exec').trim().toLowerCase() === 'appserver';
  if (!active) return { active: false };
  const installation = inspectInstall({ env, run });
  const broker = normalizeCodexBrokerProbe(probeBroker(run));
  const staleReasons = broker.alive && installation.ready
    ? codexBrokerStaleReasons(broker, installation)
    : [];
  const definitelyAbsent = broker.probeState === 'not_running';
  const brokerHealthy = !broker.probeFailed
    && (definitelyAbsent || (broker.alive && broker.ready && staleReasons.length === 0));
  return {
    active: true,
    installation,
    broker,
    stale: staleReasons.length > 0,
    staleReasons,
    ok: Boolean(installation.ready && brokerHealthy),
  };
}

export function buildDoctorReport({
  run = runCommand,
  env = process.env,
  nodeVersion = process.versions.node,
  inspectCodexInstall = inspectCodexAppServerInstallation,
  probeCodexBroker = probeCodexBrokerSync,
} = {}) {
  // One cache for the whole report: targets are inspected once here and again
  // for every profile that routes to them, and each of those probes now carries
  // a 120s ceiling. Without the cache an N-profile install multiplies the
  // worst-case time-to-return by N.
  const probe = memoizeProbe(run);
  const targets = inspectTargets({ run: probe, env });
  const defaultTarget = readDefaultTarget(env);
  const codexAppServer = codexAppServerDiagnostics({
    env,
    run: probe,
    inspectInstall: inspectCodexInstall,
    probeBroker: probeCodexBroker,
  });

  const report = {
    node: nodeInfo(nodeVersion),
    npm: commandVersion('npm', ['--version'], probe),
    jq: commandVersion('jq', ['--version'], probe),
    claude: commandVersion('claude', ['--version'], probe),
    codex: codexInfo(probe, env),
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
      codexAppServer,
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
  if (codexAppServer.active) {
    const install = codexAppServer.installation;
    if (!install.ready) warnings.push(`Codex app-server runtime is unavailable: ${install.blocker?.message || 'no complete Codex/code-mode-host pair was found'}`);
    if (install.installed?.quarantined) {
      warnings.push(`The installed Codex binary is quarantined (${install.installed.path}); doctor made no xattr changes.`);
    } else if (install.installed?.quarantineStatus === 'indeterminate') {
      warnings.push(
        `Could not determine whether the installed Codex binary is quarantined (${install.installed.path}): `
        + `${install.installed.quarantineError || 'the read-only xattr probe failed'}. Doctor made no xattr changes.`,
      );
    }
    if (install.selected?.source === 'plugin-appserver') {
      warnings.push(`Codex app-server will use the guarded extracted pair at ${install.selected.realPath || install.selected.path}.`);
    }
    if (codexAppServer.broker?.probeFailed) {
      warnings.push(`Could not inspect the Codex broker: ${codexAppServer.broker.error || codexAppServer.broker.code || 'the probe result was indeterminate'}`);
    }
    if (codexAppServer.broker?.alive && !codexAppServer.broker.ready) warnings.push('The running Codex broker has not completed its app-server handshake.');
    for (const reason of codexAppServer.staleReasons) warnings.push(`Running Codex broker is stale: ${reason}.`);
  }
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
    .map((p) => inspectProfile(p.id, { run: probe, env, load: registry }));
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
  report.ok = Boolean(commonOk && targetOk && strengthsOk && (!codexAppServer.active || codexAppServer.ok));

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
  const cx = report.runtime.codexAppServer;
  if (cx?.active) {
    const selected = cx.installation?.selected;
    const quarantineNote = selected?.quarantined
      ? ', quarantined'
      : selected?.quarantineStatus === 'indeterminate'
        ? ', quarantine unknown'
        : '';
    lines.push(
      selected
        ? `codex app-server: ${selected.version || 'unknown version'} at ${selected.realPath || selected.path} (${selected.source}${quarantineNote})`
        : `codex app-server: unavailable (${cx.installation?.blocker?.code || 'no_complete_pair'})`,
    );
    if (selected?.helperPath) lines.push(`  helper: ${selected.helperPath}`);
    if (cx.broker?.alive) {
      lines.push(
        `  broker: pid ${cx.broker.brokerPid || '?'} / app-server ${cx.broker.appServerPid || '?'}; `
        + `${cx.broker.codexVersion || 'unknown version'} at ${cx.broker.codexRealPath || cx.broker.codexPath || 'unknown path'}`
        + `${cx.stale ? ' (stale)' : ''}`,
      );
    } else if (cx.broker?.indeterminate || cx.broker?.probeFailed) {
      lines.push(`  broker: indeterminate (probe failed${cx.broker?.code ? `: ${cx.broker.code}` : ''})`);
    } else {
      lines.push('  broker: not running');
    }
  }
  lines.push(`runtime: ${report.runtime.dir} (adapter: ${report.runtime.adapter})`);
  for (const w of report.warnings || []) lines.push(`! ${w}`);
  return lines.join('\n');
}
