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

test.after(() => rmSync(HOME_SANDBOX, { recursive: true, force: true }));

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

function machineRun({ opencode = false, copilot = false } = {}) {
  return (cmd, args = []) => {
    const a = args.join(' ');
    if (cmd === 'npm') return { ok: true, output: '10.0.0\nextra' };
    if (cmd === 'jq') return { ok: true, output: 'jq-1.7' };
    if (cmd === 'claude') return { ok: false, output: 'not found' };
    if (cmd === 'codex') {
      if (a === '--version') return { ok: true, output: 'codex 0.130.0' };
      if (a === 'plugin add --help') return { ok: true, output: 'usage' };
      if (a === 'plugin marketplace add --help') return { ok: false, output: 'missing' };
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
