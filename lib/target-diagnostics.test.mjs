// Target readiness diagnostics tests. A fake `run` simulates each machine
// state; AGENT_COMPANION_HOME is pinned to a temp dir so no real config file
// leaks into configuredDefault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
