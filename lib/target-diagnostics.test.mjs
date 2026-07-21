// Target readiness diagnostics tests. A fake `run` simulates each machine
// state; AGENT_COMPANION_HOME is pinned to a temp dir so no real config file
// leaks into configuredDefault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOX = mkdtempSync(join(tmpdir(), 'agent-diag-'));
process.env.AGENT_COMPANION_HOME = SANDBOX;

const {
  inspectTarget,
  inspectTargets,
  targetReadinessSummary,
  inspectProfile,
  inspectProfiles,
  strengthsSummary,
  probeCommand,
  memoizeProbe,
  PROBE_TIMEOUT_MS,
} = await import('./target-diagnostics.mjs');
const state = await import('./state.mjs');
const { loadProfiles } = await import('./profile-registry.mjs');

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

// Build a fake `run` from a simple machine description.
//   opencode: false | { models?: string }
//   copilot:  false | true
function makeRun({ opencode = false, copilot = false } = {}) {
  return (cmd, args = []) => {
    const a = args.join(' ');
    const isOpenCode = /opencode/.test(cmd);
    const isCopilot = /copilot/.test(cmd);
    if (isOpenCode) {
      if (!opencode) return { ok: false, output: 'command not found' };
      if (a === '--version') return { ok: true, output: 'opencode 1.2.3' };
      if (a === 'models') return { ok: true, output: opencode.models || '' };
      return { ok: false, output: 'unknown opencode subcommand' };
    }
    if (isCopilot) {
      if (!copilot) return { ok: false, output: 'command not found' };
      if (a === '--version') return { ok: true, output: 'copilot 1.0.61' };
      return { ok: false, output: 'unknown copilot subcommand' };
    }
    return { ok: false, output: 'unknown command' };
  };
}

test('opencode installed with a provider is ready', () => {
  const run = makeRun({ opencode: { models: 'anthropic/claude-opus-4.8\nopenai/gpt-5.5' } });
  const r = inspectTarget('opencode', { run, env: {} });
  assert.equal(r.installed, true);
  assert.equal(r.version, 'opencode 1.2.3');
  assert.equal(r.authenticated, true);
  assert.equal(r.ready, true);
  assert.deepEqual(r.blockers, []);
});

test('opencode installed without a provider is blocked on needs_provider', () => {
  const run = makeRun({ opencode: { models: '' } });
  const r = inspectTarget('opencode', { run, env: {} });
  assert.equal(r.installed, true);
  assert.equal(r.authenticated, false);
  assert.equal(r.ready, false);
  assert.equal(r.blockers[0].code, 'needs_provider');
});

test('opencode missing binary blocks on missing_binary', () => {
  const run = makeRun({ opencode: false });
  const r = inspectTarget('opencode', { run, env: {} });
  assert.equal(r.installed, false);
  assert.equal(r.ready, false);
  assert.equal(r.blockers[0].code, 'missing_binary');
  assert.equal(r.authenticated, 'unknown');
});

test('opencode skip permission mode is ready but warns dangerous', () => {
  const run = makeRun({ opencode: { models: 'anthropic/x' } });
  const r = inspectTarget('opencode', { run, env: { AGENT_COMPANION_OPENCODE_PERMISSION_MODE: 'skip' } });
  assert.equal(r.ready, true);
  assert.equal(r.permission.mode, 'skip');
  assert.equal(r.permission.risk, 'dangerous');
  assert.ok(r.warnings.some((w) => w.code === 'dangerous_permissions'));
});

test('opencode default permission warns about interactive prompts', () => {
  const run = makeRun({ opencode: { models: 'anthropic/x' } });
  const r = inspectTarget('opencode', { run, env: {} });
  assert.ok(r.warnings.some((w) => w.code === 'interactive_permissions'));
});

test('copilot installed is ready with auth_unknown warning (no cheap probe)', () => {
  const run = makeRun({ copilot: true });
  const r = inspectTarget('copilot', { run, env: {} });
  assert.equal(r.installed, true);
  assert.equal(r.authenticated, 'unknown');
  assert.equal(r.ready, true);
  assert.ok(r.warnings.some((w) => w.code === 'auth_unknown'));
  assert.equal(r.permission.mode, 'managed');
});

test('copilot missing blocks on missing_binary', () => {
  const run = makeRun({ copilot: false });
  const r = inspectTarget('copilot', { run, env: {} });
  assert.equal(r.ready, false);
  assert.equal(r.blockers[0].code, 'missing_binary');
});

test('binary env override is probed instead of PATH name', () => {
  const seen = [];
  const run = (cmd, args = []) => {
    seen.push(cmd);
    if (cmd === '/custom/oc' && args.join(' ') === '--version') return { ok: true, output: 'opencode 9.9' };
    if (cmd === '/custom/oc' && args.join(' ') === 'models') return { ok: true, output: 'anthropic/x' };
    return { ok: false, output: 'nope' };
  };
  const r = inspectTarget('opencode', { run, env: { OPENCODE_BIN: '/custom/oc' } });
  assert.equal(r.installed, true);
  assert.equal(r.binary, '/custom/oc');
  assert.equal(r.binarySource, 'env');
  assert.ok(seen.includes('/custom/oc'));
  // The auth check must run against the override binary, not the bare PATH name.
  assert.equal(r.authenticated, true);
  assert.equal(r.ready, true);
  assert.ok(!seen.includes('opencode'), 'auth probe must not fall back to PATH `opencode`');
});

test('unknown target id returns a clear blocker', () => {
  const r = inspectTarget('goose', { run: makeRun({}), env: {} });
  assert.equal(r.ready, false);
  assert.equal(r.blockers[0].code, 'unknown_target');
});

test('inspectTargets covers every registered target', () => {
  const run = makeRun({ opencode: { models: 'anthropic/x' }, copilot: true });
  const all = inspectTargets({ run, env: {} });
  assert.deepEqual(Object.keys(all).sort(), ['copilot', 'opencode']);
  assert.equal(all.opencode.ready, true);
  assert.equal(all.copilot.ready, true);
});

test('configuredDefault reflects the env default-target override', () => {
  const run = makeRun({ opencode: { models: 'anthropic/x' }, copilot: true });
  const env = { AGENT_COMPANION_DEFAULT_TARGET: 'copilot' };
  assert.equal(inspectTarget('copilot', { run, env }).configuredDefault, true);
  assert.equal(inspectTarget('opencode', { run, env }).configuredDefault, false);
  assert.deepEqual(state.readDefaultTarget(env), { target: 'copilot', source: 'env' });
});

test('readDefaultTarget reports unset with no config', () => {
  assert.deepEqual(state.readDefaultTarget({}), { target: null, source: 'unset' });
});

test('targetReadinessSummary renders ready and blocked states', () => {
  const run = makeRun({ opencode: false });
  assert.match(targetReadinessSummary(inspectTarget('opencode', { run, env: {} })), /not installed/);
  const ready = inspectTarget('copilot', { run: makeRun({ copilot: true }), env: {} });
  assert.match(targetReadinessSummary(ready), /GitHub Copilot CLI: ready/);
});

// --------------------------------------------------------- profile readiness

function resetProfiles() { state.clearProfiles(); }

test('inspectProfile: ready copilot profile inherits companion readiness', () => {
  resetProfiles();
  state.writeProfiles({ profiles: [{ id: 'cop-review', companion: 'copilot', model: 'claude-sonnet-4.6', strengths: ['reviewer'] }] });
  const run = makeRun({ copilot: true });
  const r = inspectProfile('cop-review', { run, env: {} });
  assert.equal(r.companion, 'copilot');
  assert.equal(r.ready, true);
  assert.equal(r.modelValid, 'unknown'); // documented copilot model, unverifiable
  assert.deepEqual(r.strengths, ['reviewer']);
  resetProfiles();
});

test('inspectProfile: a copilot model not in the allowlist is a blocker', () => {
  resetProfiles();
  state.writeProfiles({ profiles: [{ id: 'cop-bad', companion: 'copilot', model: 'gpt-5.5', strengths: [] }] });
  const r = inspectProfile('cop-bad', { run: makeRun({ copilot: true }), env: {} });
  assert.equal(r.modelValid, false);
  assert.equal(r.ready, false);
  assert.ok(r.blockers.some((b) => b.code === 'model_invalid'));
  resetProfiles();
});

test('inspectProfile: opencode model is verified against `opencode models`', () => {
  resetProfiles();
  state.writeProfiles({ profiles: [
    { id: 'oc-known', companion: 'opencode', model: 'anthropic/claude-sonnet-4.6', strengths: [] },
    { id: 'oc-unknown', companion: 'opencode', model: 'anthropic/ghost-model', strengths: [] },
  ] });
  const run = makeRun({ opencode: { models: 'anthropic/claude-sonnet-4.6\nopenai/gpt-5.5' } });
  const known = inspectProfile('oc-known', { run, env: {} });
  assert.equal(known.modelValid, true);
  assert.equal(known.ready, true);
  const unknown = inspectProfile('oc-unknown', { run, env: {} });
  assert.equal(unknown.modelValid, 'unknown'); // shape ok, not listed → warn, not blocked
  assert.ok(unknown.warnings.some((w) => w.code === 'model_unverified'));
  assert.equal(unknown.ready, true);
  resetProfiles();
});

test('inspectProfiles excludes the synthesized profile; strengthsSummary projects readiness', () => {
  resetProfiles();
  state.writeProfiles({ profiles: [
    { id: 'cop-review', companion: 'copilot', strengths: ['reviewer'] },
    { id: 'cop-plan-a', companion: 'copilot', strengths: ['planner'] },
    { id: 'cop-plan-b', companion: 'copilot', strengths: ['planner'] },
  ] });
  const run = makeRun({ copilot: true });
  const profiles = inspectProfiles({ run, env: {} });
  assert.deepEqual(profiles.map((p) => p.id).sort(), ['cop-plan-a', 'cop-plan-b', 'cop-review']);
  const summary = strengthsSummary(loadProfiles({ env: {} }), profiles);
  assert.equal(summary.reviewer.ready, true);
  assert.equal(summary.reviewer.profileId, 'cop-review');
  assert.equal(summary.planner.ambiguous, true);
  assert.equal(summary.planner.ready, false);
  resetProfiles();
});

test('inspectProfile: unknown profile id reports a blocker', () => {
  resetProfiles();
  const r = inspectProfile('ghost', { run: makeRun({ copilot: true }), env: {} });
  assert.equal(r.ready, false);
  assert.equal(r.blockers[0].code, 'unknown_profile');
});

// --- the shared probe: timeout + memoization -------------------------------
//
// These guard the hang that motivated probeCommand. The bridge runs these
// probes on its only thread, so an unbounded one wedges every in-flight job.

test('probeCommand kills a hung binary instead of blocking forever', () => {
  const started = Date.now();
  const r = probeCommand('sleep', ['30'], { timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.output, /did not respond within 300ms/);
  // Generous bound: the point is that it returned at all, not that it was fast.
  assert.ok(elapsed < 15_000, `probe should return promptly, took ${elapsed}ms`);
});

test('probeCommand bounds a binary that IGNORES the graceful kill signal', () => {
  // The whole point of the timeout. `timeout` does not abandon the child, it
  // signals it and keeps blocking until it exits — so with the default
  // (catchable) SIGTERM, a process that traps it blocks for its full lifetime
  // while probeCommand still reports timedOut. That is the original hang
  // wearing a reassuring label. Only an uncatchable signal is a real bound.
  const ignorer = join(SANDBOX, 'sigterm-ignorer.mjs');
  writeFileSync(ignorer, [
    "process.on('SIGTERM', () => {});",
    "process.on('SIGINT', () => {});",
    'setTimeout(() => process.exit(0), 30000);',
  ].join('\n'));

  const started = Date.now();
  const r = probeCommand(process.execPath, [ignorer], { timeoutMs: 500 });
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(elapsed < 10_000, `probe must not wait out a SIGTERM-ignoring child; took ${elapsed}ms`);
});

test('probeCommand default budget matches the onboard smoke budget', () => {
  assert.equal(PROBE_TIMEOUT_MS, 120_000);
});

test('probeCommand still reports success output and missing binaries', () => {
  const ok = probeCommand('echo', ['hello'], { timeoutMs: 5_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.output, 'hello');

  const missing = probeCommand('agent-companion-no-such-binary', ['--version'], { timeoutMs: 5_000 });
  assert.equal(missing.ok, false);
  // A missing binary must NOT be reported as a timeout — the doctor renders
  // the two differently and "not installed" is the actionable one.
  assert.notEqual(missing.timedOut, true);
  assert.match(missing.output, /ENOENT/);
});

test('a hung binary degrades one target instead of hanging the whole report', () => {
  // Same shape as the real failure: `opencode --version` never returns.
  const run = (cmd, args = []) => {
    if (/opencode/.test(cmd)) return probeCommand('sleep', ['30'], { timeoutMs: 300 });
    return makeRun({ copilot: true })(cmd, args);
  };
  const targets = inspectTargets({ run, env: {} });
  assert.equal(targets.opencode.installed, false);
  assert.equal(targets.opencode.ready, false);
  assert.equal(targets.copilot.ready, true, 'a hung target must not take healthy ones down with it');
});

test('memoizeProbe collapses repeat probes of the same command', () => {
  let calls = 0;
  const memo = memoizeProbe((cmd, args = []) => {
    calls += 1;
    return { ok: true, output: `${cmd} ${args.join(' ')}` };
  });
  assert.equal(memo('opencode', ['--version']).output, 'opencode --version');
  assert.equal(memo('opencode', ['--version']).output, 'opencode --version');
  assert.equal(calls, 1);
  memo('opencode', ['models']);
  assert.equal(calls, 2, 'different args must not share a cache entry');
  memo('copilot', ['--version']);
  assert.equal(calls, 3, 'different commands must not share a cache entry');

  // A space-joined key would fold these two into one entry and hand the second
  // call the first one's result.
  memo('a b', []);
  memo('a', ['b']);
  assert.equal(calls, 5, 'the cache key must not be ambiguous across the cmd/args boundary');
});

test('inspectProfiles probes each companion once regardless of profile count', () => {
  resetProfiles();
  state.writeProfiles({ profiles: [
    { id: 'oc-a', companion: 'opencode', strengths: ['reviewer'] },
    { id: 'oc-b', companion: 'opencode', strengths: ['planner'] },
    { id: 'oc-c', companion: 'opencode', strengths: ['fast_executor'] },
  ] });
  const seen = [];
  const base = makeRun({ opencode: { models: 'anthropic/x' } });
  const run = (cmd, args = []) => { seen.push(`${cmd} ${args.join(' ')}`); return base(cmd, args); };
  const profiles = inspectProfiles({ run, env: {} });
  assert.equal(profiles.length, 3);
  // Without memoization this is 3x the probe count, and with a 120s ceiling on
  // each probe that multiplies the worst-case time-to-return by the profile count.
  assert.deepEqual(seen, [...new Set(seen)], `probes repeated: ${seen.join(', ')}`);
  resetProfiles();
});
