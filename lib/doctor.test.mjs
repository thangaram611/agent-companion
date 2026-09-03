import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin the companion home BEFORE importing doctor so target diagnostics never
// read a real ~/.{claude,codex}/agent-companion/default-target file.
const HOME_SANDBOX = mkdtempSync(join(tmpdir(), 'agent-doctor-home-'));
process.env.AGENT_COMPANION_HOME = HOME_SANDBOX;

const { buildDoctorReport, renderDoctorReport } = await import('./doctor.mjs');
const state = await import('./state.mjs');

test.after(() => { state.clearProfiles(); rmSync(HOME_SANDBOX, { recursive: true, force: true }); });

function withRuntimeHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-doctor-test-'));
  const prior = process.env.AGENT_RUNTIME_DIR;
  process.env.AGENT_RUNTIME_DIR = dir;
  try { return fn(dir); }
  finally {
    if (prior === undefined) delete process.env.AGENT_RUNTIME_DIR;
    else process.env.AGENT_RUNTIME_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

// codex/codexLoggedIn describe the SAME `codex` binary the real memoized probe
// shares between the HOST arm (report.codex — plugin-host prereq, unconditional
// --version + plugin subcommands) and the TARGET arm (report.targets.codex —
// downstream companion readiness, gated by `login status`). Defaults preserve
// every pre-existing assertion here (codex found:true, unconditional) while
// defaulting `codexLoggedIn:false` so a codex TARGET is present-but-unauthenticated
// unless a test opts in — nothing before this change ever asserted on
// report.targets.codex, so that default is a new, safe addition.
function machineRun({ opencode = false, copilot = false, codex = true, codexLoggedIn = false } = {}) {
  return (cmd, args = []) => {
    const a = args.join(' ');
    if (cmd === 'npm') return { ok: true, output: '10.0.0\nextra' };
    if (cmd === 'jq') return { ok: true, output: 'jq-1.7' };
    if (cmd === 'claude') return { ok: false, output: 'not found' };
    if (cmd === 'codex') {
      if (!codex) return { ok: false, output: 'not found' };
      if (a === '--version') return { ok: true, output: 'codex 0.130.0' };
      if (a === 'plugin add --help') return { ok: true, output: 'usage' };
      if (a === 'plugin marketplace add --help') return { ok: false, output: 'missing' };
      // Live-verified (0.145.0): empty stdout in BOTH the logged-in and
      // logged-out case — exit code alone carries the signal.
      if (a === 'login status') return { ok: codexLoggedIn, output: '' };
    }
    if (/opencode/.test(cmd)) {
      if (!opencode) return { ok: false, output: 'not found' };
      if (a === '--version') return { ok: true, output: 'opencode 1.2.3' };
      if (a === 'models') return { ok: true, output: opencode.models || '' };
    }
    if (/copilot/.test(cmd)) {
      if (!copilot) return { ok: false, output: 'not found' };
      if (a === '--version') return { ok: true, output: 'copilot 1.0.61' };
    }
    return { ok: false, output: 'missing' };
  };
}

test('doctor is target-aware: configured opencode target ready → ok', () => {
  withRuntimeHome((home) => {
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true });
    const report = buildDoctorReport({
      run,
      env: { COPILOT_RUNTIME_ADAPTER: 'sdk', AGENT_COMPANION_DEFAULT_TARGET: 'opencode' },
      nodeVersion: '22.1.0',
    });

    assert.equal(report.ok, true);
    assert.equal(report.node.version, 'v22.1.0');
    assert.equal(report.claude.found, false);
    assert.equal(report.codex.found, true);
    assert.equal(report.defaultTarget.target, 'opencode');
    assert.equal(report.targets.opencode.ready, true);
    assert.equal(report.targets.copilot.ready, true);
    assert.equal(report.runtime.adapter, 'sdk');
    assert.match(report.runtime.dir, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const rendered = renderDoctorReport(report);
    assert.match(rendered, /agent-companion doctor: ok/);
    assert.match(rendered, /default target: opencode \(env\)/);
    assert.match(rendered, /runtime: .* \(adapter: sdk\)/);
  });
});

test('opencode-only install is ok without copilot', () => {
  withRuntimeHome(() => {
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: false });
    const report = buildDoctorReport({
      run,
      env: { AGENT_COMPANION_DEFAULT_TARGET: 'opencode' },
      nodeVersion: '22.1.0',
    });
    assert.equal(report.ok, true);
    assert.equal(report.targets.copilot.ready, false);
    assert.equal(report.targets.copilot.blockers[0].code, 'missing_binary');
  });
});

test('configured target with a missing binary fails health', () => {
  withRuntimeHome(() => {
    const run = machineRun({ opencode: false, copilot: false });
    const report = buildDoctorReport({
      run,
      env: { AGENT_COMPANION_DEFAULT_TARGET: 'opencode' },
      nodeVersion: '22.1.0',
    });
    assert.equal(report.ok, false);
    assert.equal(report.targets.opencode.ready, false);
  });
});

test('no configured target warns about non-persisted selection', () => {
  withRuntimeHome(() => {
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true });
    const report = buildDoctorReport({ run, env: {}, nodeVersion: '22.1.0' });
    assert.equal(report.defaultTarget.target, null);
    assert.equal(report.ok, true); // a target is selectable
    assert.ok(report.warnings.some((w) => /not persisted/.test(w)));
  });
});

// --------------------------------------------------------- codex host vs target

test('codex TARGET readiness (report.targets.codex) is independent of the codex HOST-prereq arm (report.codex)', () => {
  withRuntimeHome(() => {
    // Binary present (host arm finds it) but not logged in — target readiness
    // is a SEPARATE axis (auth), never implied by host.found alone.
    const loggedOut = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true, codex: true, codexLoggedIn: false });
    const reportOut = buildDoctorReport({ run: loggedOut, env: { AGENT_COMPANION_DEFAULT_TARGET: 'opencode' }, nodeVersion: '22.1.0' });
    assert.equal(reportOut.codex.found, true);
    assert.equal(reportOut.targets.codex.installed, true);
    assert.equal(reportOut.targets.codex.authenticated, false);
    assert.equal(reportOut.targets.codex.ready, false);

    const loggedIn = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true, codex: true, codexLoggedIn: true });
    const reportIn = buildDoctorReport({ run: loggedIn, env: { AGENT_COMPANION_DEFAULT_TARGET: 'opencode' }, nodeVersion: '22.1.0' });
    assert.equal(reportIn.codex.found, true);
    assert.equal(reportIn.targets.codex.ready, true);
  });
});

test('codex-as-default-target with a missing binary fails health', () => {
  withRuntimeHome(() => {
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true, codex: false });
    const report = buildDoctorReport({ run, env: { AGENT_COMPANION_DEFAULT_TARGET: 'codex' }, nodeVersion: '22.1.0' });
    assert.equal(report.targets.codex.ready, false);
    assert.equal(report.targets.codex.blockers[0].code, 'missing_binary');
    assert.equal(report.ok, false);
  });
});

test('codexInfo (host arm) honors CODEX_BIN, matching the target arm binaryEnv', () => {
  withRuntimeHome(() => {
    const seen = [];
    const run = (cmd, args = []) => {
      seen.push(cmd);
      if (cmd === 'npm') return { ok: true, output: '10.0.0' };
      if (cmd === 'jq') return { ok: true, output: 'jq-1.7' };
      if (cmd === '/custom/codex' && args.join(' ') === '--version') return { ok: true, output: 'codex-cli 0.145.0' };
      if (cmd === '/custom/codex' && args.join(' ') === 'plugin add --help') return { ok: true, output: 'usage' };
      return { ok: false, output: 'not found' };
    };
    const report = buildDoctorReport({ run, env: { CODEX_BIN: '/custom/codex' }, nodeVersion: '22.1.0' });
    assert.equal(report.codex.found, true);
    assert.equal(report.codex.version, 'codex-cli 0.145.0');
    assert.ok(seen.includes('/custom/codex'));
    assert.ok(!seen.includes('codex'), 'codexInfo must not fall back to bare PATH `codex` once CODEX_BIN is set');
  });
});

function appServerInstall({
  ready = true,
  quarantined = false,
  quarantineStatus = quarantined ? 'present' : 'absent',
  quarantineError = null,
  source = 'installed',
} = {}) {
  return {
    ready,
    blocker: ready ? null : { code: 'code_mode_host_missing', message: 'the installed Codex package has no code-mode host and no matching fallback' },
    installed: {
      path: '/opt/homebrew/bin/codex',
      realPath: '/opt/homebrew/Caskroom/codex/0.152.1/bin/codex',
      version: '0.152.1',
      helperPath: '/opt/homebrew/Caskroom/codex/0.152.1/bin/codex-code-mode-host',
      quarantined,
      quarantineStatus,
      quarantineError,
      complete: ready,
    },
    selected: ready ? {
      path: source === 'plugin-appserver' ? '/fake/.codex/plugins/.plugin-appserver/codex' : '/opt/homebrew/bin/codex',
      realPath: source === 'plugin-appserver' ? '/fake/.codex/plugins/.plugin-appserver/codex' : '/opt/homebrew/Caskroom/codex/0.152.1/bin/codex',
      version: '0.152.1',
      helperPath: source === 'plugin-appserver'
        ? '/fake/.codex/plugins/.plugin-appserver/codex-code-mode-host'
        : '/opt/homebrew/Caskroom/codex/0.152.1/bin/codex-code-mode-host',
      source,
      identity: source === 'plugin-appserver' ? 'plugin-1521' : 'cask-1521',
      quarantined: false,
      quarantineStatus: source === 'plugin-appserver' ? 'absent' : quarantineStatus,
    } : null,
  };
}

function appServerBroker(overrides = {}) {
  return {
    alive: true,
    ready: true,
    brokerPid: 101,
    appServerPid: 102,
    codexVersion: '0.152.1',
    codexPath: '/opt/homebrew/bin/codex',
    codexRealPath: '/opt/homebrew/Caskroom/codex/0.152.1/bin/codex',
    codexIdentity: 'cask-1521',
    clients: 1,
    ...overrides,
  };
}

test('doctor reports the selected helper pair and detects quarantine without mutating it', () => {
  withRuntimeHome(() => {
    const report = buildDoctorReport({
      run: machineRun({ codex: true, codexLoggedIn: true }),
      env: { AGENT_COMPANION_DEFAULT_TARGET: 'codex', CODEX_RUNTIME_ADAPTER: 'appserver' },
      nodeVersion: '22.1.0',
      inspectCodexInstall: () => appServerInstall({ quarantined: true, source: 'plugin-appserver' }),
      probeCodexBroker: () => appServerBroker({
        codexPath: '/fake/.codex/plugins/.plugin-appserver/codex',
        // This test exercises quarantine/fallback reporting, not the separate
        // deleted-running-binary check (covered below). Avoid making a made-up
        // fixture path look like evidence that a live executable disappeared.
        codexRealPath: null,
        codexIdentity: 'plugin-1521',
      }),
    });
    assert.equal(report.ok, true);
    assert.equal(report.runtime.codexAppServer.installation.installed.quarantined, true);
    assert.equal(report.runtime.codexAppServer.installation.selected.source, 'plugin-appserver');
    assert.ok(report.warnings.some((warning) => /quarantined/.test(warning)));
    const rendered = renderDoctorReport(report);
    assert.match(rendered, /codex app-server: 0\.152\.1 at \/fake\/\.codex\/plugins/);
    assert.match(rendered, /helper: .*codex-code-mode-host/);
  });
});

test('doctor surfaces an indeterminate quarantine probe without pretending it is absent', () => {
  withRuntimeHome(() => {
    const report = buildDoctorReport({
      run: machineRun({ codex: true, codexLoggedIn: true }),
      env: { AGENT_COMPANION_DEFAULT_TARGET: 'codex', CODEX_RUNTIME_ADAPTER: 'appserver' },
      nodeVersion: '22.1.0',
      inspectCodexInstall: () => appServerInstall({
        quarantineStatus: 'indeterminate',
        quarantineError: 'xattr probe timed out',
      }),
      probeCodexBroker: () => ({ alive: false, ready: false, code: 'ENOENT', error: 'not running' }),
    });
    assert.equal(report.ok, true, 'a complete pair remains advisory when no safer fallback exists');
    assert.ok(report.warnings.some((warning) => /Could not determine.*quarantined.*timed out/.test(warning)));
    assert.match(renderDoctorReport(report), /quarantine unknown/);
  });
});

test('doctor fails loudly when the running broker is older than the selected cask', () => {
  withRuntimeHome(() => {
    const report = buildDoctorReport({
      run: machineRun({ codex: true, codexLoggedIn: true }),
      env: { AGENT_COMPANION_DEFAULT_TARGET: 'codex', CODEX_RUNTIME_ADAPTER: 'appserver' },
      nodeVersion: '22.1.0',
      inspectCodexInstall: () => appServerInstall(),
      probeCodexBroker: () => appServerBroker({
        codexVersion: '0.152.0',
        codexRealPath: '/opt/homebrew/Caskroom/codex/0.152.0/bin/codex',
        codexIdentity: 'cask-1520',
      }),
    });
    assert.equal(report.ok, false);
    assert.equal(report.runtime.codexAppServer.stale, true);
    assert.ok(report.runtime.codexAppServer.staleReasons.some((reason) => /running version 0\.152\.0/.test(reason)));
    assert.match(renderDoctorReport(report), /broker: .*\(stale\)/);
  });
});

test('doctor treats refused, missing, and non-socket broker endpoints as healthy cold state', () => {
  withRuntimeHome(() => {
    for (const code of ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']) {
      const report = buildDoctorReport({
        run: machineRun({ codex: true, codexLoggedIn: true }),
        env: { AGENT_COMPANION_DEFAULT_TARGET: 'codex', CODEX_RUNTIME_ADAPTER: 'appserver' },
        nodeVersion: '22.1.0',
        inspectCodexInstall: () => appServerInstall(),
        probeCodexBroker: () => ({ alive: false, ready: false, code, error: 'not running' }),
      });
      const broker = report.runtime.codexAppServer.broker;
      assert.equal(report.ok, true, `${code} is a healthy cold-start state`);
      assert.equal(broker.probeState, 'not_running');
      assert.equal(broker.probeFailed, false);
      assert.equal(broker.indeterminate, false);
      assert.match(renderDoctorReport(report), /broker: not running/);
      assert.ok(!report.warnings.some((warning) => /Could not inspect the Codex broker/.test(warning)));
    }
  });
});

test('doctor keeps an unusable helper unhealthy even when the broker is cold', () => {
  withRuntimeHome(() => {
    const report = buildDoctorReport({
      run: machineRun({ codex: true, codexLoggedIn: true }),
      env: { AGENT_COMPANION_DEFAULT_TARGET: 'codex', CODEX_RUNTIME_ADAPTER: 'appserver' },
      nodeVersion: '22.1.0',
      inspectCodexInstall: () => appServerInstall({ ready: false }),
      probeCodexBroker: () => ({ alive: false, ready: false, code: 'ENOENT', error: 'not running' }),
    });
    assert.equal(report.ok, false);
    assert.ok(report.warnings.some((warning) => /no code-mode host/.test(warning)));
  });
});

test('doctor reports structured non-connect broker failures as indeterminate', () => {
  withRuntimeHome(() => {
    for (const { code, error } of [
      { code: 'EACCES', error: 'permission denied' },
      { code: 'ETIMEDOUT', error: 'connect timed out' },
      { code: 'EUNEXPECTED', error: 'unexpected socket failure' },
    ]) {
      const report = buildDoctorReport({
        run: machineRun({ codex: true, codexLoggedIn: true }),
        env: { AGENT_COMPANION_DEFAULT_TARGET: 'codex', CODEX_RUNTIME_ADAPTER: 'appserver' },
        nodeVersion: '22.1.0',
        inspectCodexInstall: () => appServerInstall(),
        probeCodexBroker: () => ({ alive: false, ready: false, code, error }),
      });
      const broker = report.runtime.codexAppServer.broker;
      const rendered = renderDoctorReport(report);
      assert.equal(report.ok, false, `${code} must not look like a healthy cold start`);
      assert.equal(broker.probeState, 'indeterminate');
      assert.equal(broker.probeFailed, true);
      assert.equal(broker.indeterminate, true);
      assert.ok(report.warnings.some((warning) => warning.includes(error)));
      assert.match(rendered, new RegExp(`broker: indeterminate \\(probe failed: ${code}\\)`));
      assert.doesNotMatch(rendered, /broker: not running/);
    }
  });
});

// --------------------------------------------------------- strength roll-up

test('synthesized install (no profiles.json) leaves report.ok untouched and lists no profiles', () => {
  withRuntimeHome(() => {
    state.clearProfiles();
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true });
    const report = buildDoctorReport({ run, env: { AGENT_COMPANION_DEFAULT_TARGET: 'opencode' }, nodeVersion: '22.1.0' });
    assert.equal(report.ok, true);
    assert.deepEqual(report.profiles, []);          // synthetic profile suppressed
    assert.deepEqual(report.strengths, {});
  });
});

test('all-invalid profiles.json degrades to empty and does not gate report.ok', () => {
  withRuntimeHome(() => {
    state.writeProfiles({ profiles: [{ id: 'BAD' }, { companion: 'copilot' }] });
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true });
    const report = buildDoctorReport({ run, env: { AGENT_COMPANION_DEFAULT_TARGET: 'opencode' }, nodeVersion: '22.1.0' });
    assert.equal(report.ok, true);
    assert.deepEqual(report.profiles, []);
    state.clearProfiles();
  });
});

test('a strength with no ready profile is a blocker', () => {
  withRuntimeHome(() => {
    // copilot not installed → the copilot reviewer profile is not ready; default
    // target opencode is ready so targetOk passes and strengthsOk is isolated.
    state.writeProfiles({ profiles: [{ id: 'cop-review', companion: 'copilot', strengths: ['reviewer'] }] });
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: false });
    const report = buildDoctorReport({ run, env: { AGENT_COMPANION_DEFAULT_TARGET: 'opencode' }, nodeVersion: '22.1.0' });
    assert.equal(report.strengths.reviewer.ready, false);
    assert.equal(report.ok, false);
    assert.ok(report.warnings.some((w) => /Strength "reviewer" has no ready profile/.test(w)));
    state.clearProfiles();
  });
});

test('a strength claimed by two profiles with no tiebreak is a blocker', () => {
  withRuntimeHome(() => {
    state.writeProfiles({ profiles: [
      { id: 'cop-plan-a', companion: 'copilot', strengths: ['planner'] },
      { id: 'cop-plan-b', companion: 'copilot', strengths: ['planner'] },
    ] });
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true });
    const report = buildDoctorReport({ run, env: { AGENT_COMPANION_DEFAULT_TARGET: 'copilot' }, nodeVersion: '22.1.0' });
    assert.equal(report.strengths.planner.ambiguous, true);
    assert.equal(report.ok, false);
    assert.ok(report.warnings.some((w) => /no defaultProfile tiebreak/.test(w)));
    state.clearProfiles();
  });
});

test('a non-claimant defaultProfile surfaces an inert-tiebreak advisory', () => {
  withRuntimeHome(() => {
    state.writeProfiles({
      profiles: [
        { id: 'cop-plan-a', companion: 'copilot', strengths: ['planner'] },
        { id: 'cop-plan-b', companion: 'copilot', strengths: ['planner'] },
        { id: 'cop-review', companion: 'copilot', strengths: ['reviewer'] },
      ],
      defaultProfile: 'cop-review', // claims reviewer, NOT planner → inert for planner
    });
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true });
    const report = buildDoctorReport({ run, env: { AGENT_COMPANION_DEFAULT_TARGET: 'copilot' }, nodeVersion: '22.1.0' });
    assert.equal(report.ok, false);
    assert.ok(report.warnings.some((w) => /inert tiebreak/.test(w)));
    state.clearProfiles();
  });
});

test('valid strengths but no defaultProfile + default-target → advisory, still ok', () => {
  withRuntimeHome(() => {
    state.writeProfiles({ profiles: [{ id: 'cop-review', companion: 'copilot', strengths: ['reviewer'] }] });
    const run = machineRun({ opencode: { models: 'anthropic/x' }, copilot: true });
    const report = buildDoctorReport({ run, env: { AGENT_COMPANION_DEFAULT_TARGET: 'copilot' }, nodeVersion: '22.1.0' });
    assert.equal(report.strengths.reviewer.ready, true);
    assert.equal(report.ok, true);
    assert.ok(report.warnings.some((w) => /No defaultProfile configured/.test(w)));
    const rendered = renderDoctorReport(report);
    assert.match(rendered, /profiles:/);
    assert.match(rendered, /strengths:/);
    assert.match(rendered, /reviewer: ready → cop-review/);
    state.clearProfiles();
  });
});
