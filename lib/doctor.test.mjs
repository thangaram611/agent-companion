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

test.after(() => { rmSync(HOME_SANDBOX, { recursive: true, force: true }); });

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
      env: { AGENT_COMPANION_DEFAULT_TARGET: 'opencode' },
      nodeVersion: '22.1.0',
    });

    assert.equal(report.ok, true);
    assert.equal(report.node.version, 'v22.1.0');
    assert.equal(report.claude.found, false);
    assert.equal(report.codex.found, true);
    assert.equal(report.defaultTarget.target, 'opencode');
    assert.equal(report.targets.opencode.ready, true);
    assert.equal(report.targets.copilot.ready, true);
    assert.match(report.runtime.dir, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const rendered = renderDoctorReport(report);
    assert.match(rendered, /agent-companion doctor: ok/);
    assert.match(rendered, /default target: opencode \(env\)/);
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

test('doctor reports no execution cutoff when retired timeout knobs are set', () => {
  withRuntimeHome(() => {
    const report = buildDoctorReport({ run: machineRun({ opencode: true }), env: {
      AGENT_COMPANION_DEFAULT_TARGET: 'opencode',
      AGENT_COMPANION_CODEX_TIMEOUT_MS: '1', AGENT_COMPANION_OPENCODE_TIMEOUT_MS: '1',
    } });
    assert.doesNotMatch(JSON.stringify(report) + renderDoctorReport(report), /timeout_ms|timeoutEnv|40 minutes|AGENT_COMPANION_(CODEX|OPENCODE)_TIMEOUT_MS/);
  });
});
