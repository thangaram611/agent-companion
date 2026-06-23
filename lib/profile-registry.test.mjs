// Strength-routed profile registry tests. Sandboxed via AGENT_COMPANION_HOME so
// the user's real state is untouched. Set the home override BEFORE importing so
// state constants bind to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOX = mkdtempSync(join(tmpdir(), 'profile-registry-'));
process.env.AGENT_COMPANION_HOME = SANDBOX;

const state = await import('./state.mjs');
const reg = await import('./profile-registry.mjs');

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

function reset() {
  state.clearProfiles();
  state.clearDefaultTarget();
  state.clearDefaultModel();
}

const ENV = {}; // no env overrides unless a case sets them

test('absent profiles.json synthesizes a degenerate default profile (copilot model from default-model)', () => {
  reset();
  state.writeDefaultTarget('copilot');
  state.writeDefaultModel('claude-haiku-4.5');
  const load = reg.loadProfiles({ env: ENV });
  assert.equal(load.synthesized, true);
  assert.equal(load.profiles.length, 1);
  const p = load.profiles[0];
  assert.equal(p.id, '__default__');
  assert.equal(p.companion, 'copilot');
  assert.equal(p.model, 'claude-haiku-4.5');
  assert.deepEqual(p.strengths, []);
  assert.equal(p.synthesized, true);
  assert.equal(load.defaultProfile.value, '__default__');
  assert.equal(load.defaultProfile.source, 'synthesized');
  // Synthesized profile is suppressed from the public view.
  assert.deepEqual(reg.listProfilesPublic(load), []);
});

test('absent profiles.json with opencode default takes model from env, null otherwise', () => {
  reset();
  state.writeDefaultTarget('opencode');
  const withEnv = reg.loadProfiles({ env: { AGENT_COMPANION_OPENCODE_MODEL: 'anthropic/claude-sonnet-4.6' } });
  assert.equal(withEnv.profiles[0].companion, 'opencode');
  assert.equal(withEnv.profiles[0].model, 'anthropic/claude-sonnet-4.6');
  const noEnv = reg.loadProfiles({ env: ENV });
  assert.equal(noEnv.profiles[0].model, null);
});

test('corrupt profiles.json degrades to synthesis (never throws)', () => {
  reset();
  state.writeDefaultTarget('copilot');
  writeFileSync(state.PROFILES_FILE, '{ not valid json');
  const load = reg.loadProfiles({ env: ENV });
  assert.equal(load.synthesized, true);
  assert.equal(load.profiles[0].id, '__default__');
});

test('valid profiles load, dedupe strengths, lowercase, and build byStrength', () => {
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'cop-review', companion: 'copilot', model: 'claude-sonnet-4.6', strengths: ['reviewer', 'Reviewer', 'planner'] },
      { id: 'cop-fast', companion: 'copilot', model: 'claude-haiku-4.5', strengths: ['fast_executor'] },
    ],
    defaultProfile: 'cop-review',
  });
  const load = reg.loadProfiles({ env: ENV });
  assert.equal(load.synthesized, false);
  assert.equal(load.profiles.length, 2);
  assert.deepEqual(load.byId.get('cop-review').strengths, ['reviewer', 'planner']);
  assert.deepEqual(load.byStrength.get('reviewer'), ['cop-review']);
  assert.deepEqual(load.byStrength.get('planner'), ['cop-review']);
  assert.deepEqual(load.byStrength.get('fast_executor'), ['cop-fast']);
  assert.equal(load.defaultProfile.value, 'cop-review');
  assert.equal(load.defaultProfile.source, 'file');
});

test('env default-profile overrides file default-profile (env-above-file)', () => {
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'cop-review', companion: 'copilot', strengths: ['reviewer'] },
      { id: 'cop-fast', companion: 'copilot', strengths: ['fast_executor'] },
    ],
    defaultProfile: 'cop-review',
  });
  const load = reg.loadProfiles({ env: { AGENT_COMPANION_DEFAULT_PROFILE: 'cop-fast' } });
  assert.equal(load.defaultProfile.value, 'cop-fast');
  assert.equal(load.defaultProfile.source, 'env');
});

test('profile inherits — never overrides — its companion capabilities', () => {
  reset();
  state.writeProfiles({ profiles: [{ id: 'cop-x', companion: 'copilot', strengths: [] }] });
  const load = reg.loadProfiles({ env: ENV });
  const caps = load.byId.get('cop-x').capabilities;
  assert.equal(caps.reply, true);
  assert.equal(caps.parallel, 'fleet');
  assert.equal(caps.modelSelection, true);
});

test('opencode adapter:server overlays the env and flips reply/resume on capabilities', () => {
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'oc-cli', companion: 'opencode', strengths: [] },
      { id: 'oc-srv', companion: 'opencode', adapter: 'server', strengths: ['web_researcher'] },
    ],
  });
  const load = reg.loadProfiles({ env: ENV }); // env has no OPENCODE_RUNTIME_ADAPTER
  assert.equal(load.byId.get('oc-cli').capabilities.reply, false);
  assert.equal(load.byId.get('oc-srv').capabilities.reply, true);
  assert.equal(load.byId.get('oc-srv').capabilities.resume, true);
  assert.equal(load.byId.get('oc-srv').capabilities.serverMode, true);
  // Overlay must not leak to the other profile or to process.env.
  assert.equal(process.env.OPENCODE_RUNTIME_ADAPTER, undefined);
});

test('per-profile field violations drop the profile with a loadError', () => {
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'GOOD', companion: 'copilot' },                  // uppercase id → invalid
      { id: 'no-companion' },                                // missing companion
      { id: 'bad-companion', companion: 'gemini' },          // unknown companion
      { id: 'cop-adapter', companion: 'copilot', adapter: 'server' }, // adapter on copilot
      { id: 'ok-one', companion: 'opencode', strengths: ['reviewer', 'nope'] }, // unknown label dropped
    ],
  });
  const load = reg.loadProfiles({ env: ENV });
  assert.deepEqual(load.profiles.map((p) => p.id), ['ok-one']);
  assert.deepEqual(load.byId.get('ok-one').strengths, ['reviewer']);
  const messages = load.loadErrors.map((e) => e.message).join('\n');
  assert.match(messages, /invalid profile id/);
  assert.match(messages, /missing required "companion"/);
  assert.match(messages, /unknown companion/);
  assert.match(messages, /adapter is opencode-only/);
  assert.match(messages, /drops unknown strength/);
});

test('all-invalid file degrades to an EMPTY registry (no synthesis)', () => {
  reset();
  state.writeDefaultTarget('copilot');
  state.writeProfiles({ profiles: [{ id: 'BAD' }, { companion: 'copilot' }] });
  const load = reg.loadProfiles({ env: ENV });
  assert.equal(load.synthesized, false);
  assert.deepEqual(load.profiles, []);
  assert.ok(load.loadErrors.length >= 2);
});

test('duplicate id keeps the first and records a loadError', () => {
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'dup', companion: 'copilot', model: 'claude-sonnet-4.6' },
      { id: 'dup', companion: 'opencode' },
    ],
  });
  const load = reg.loadProfiles({ env: ENV });
  assert.equal(load.profiles.length, 1);
  assert.equal(load.byId.get('dup').companion, 'copilot');
  assert.match(load.loadErrors.map((e) => e.message).join('\n'), /duplicate profile id/);
});

test('defaultProfile naming a non-existent id records a loud loadError', () => {
  reset();
  state.writeProfiles({
    profiles: [{ id: 'cop-x', companion: 'copilot' }],
    defaultProfile: 'ghost',
  });
  const load = reg.loadProfiles({ env: ENV });
  assert.equal(load.defaultProfile.value, 'ghost');
  assert.match(load.loadErrors.map((e) => e.message).join('\n'), /names no configured profile/);
});

test('valid profiles with no defaultProfile leave defaultProfile unset', () => {
  reset();
  state.writeProfiles({ profiles: [{ id: 'cop-x', companion: 'copilot' }] });
  const load = reg.loadProfiles({ env: ENV });
  assert.equal(load.defaultProfile.value, null);
  assert.equal(load.defaultProfile.source, 'unset');
});

test('resolveStrength cardinality 0/1/N with non-claimant defaultProfile → ambiguous', () => {
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'a', companion: 'copilot', strengths: ['reviewer'] },
      { id: 'b', companion: 'copilot', strengths: ['reviewer'] },
      { id: 'c', companion: 'copilot', strengths: ['planner'] },
    ],
    defaultProfile: 'c', // does NOT claim reviewer → inert tiebreak
  });
  const load = reg.loadProfiles({ env: ENV });
  assert.deepEqual(reg.resolveStrength(load, 'web_researcher'), { status: 'unconfigured' });
  assert.deepEqual(reg.resolveStrength(load, 'planner'), { status: 'ok', profileId: 'c' });
  assert.deepEqual(reg.resolveStrength(load, 'reviewer'), { status: 'ambiguous', candidates: ['a', 'b'] });
});

test('defaultProfile that claims the ambiguous strength wins the tiebreak', () => {
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'a', companion: 'copilot', strengths: ['reviewer'] },
      { id: 'b', companion: 'copilot', strengths: ['reviewer'] },
    ],
    defaultProfile: 'b',
  });
  const load = reg.loadProfiles({ env: ENV });
  assert.deepEqual(reg.resolveStrength(load, 'reviewer'), { status: 'ok', profileId: 'b' });
});

test('flatStrengths is id-free and reflects readiness', () => {
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'rev-prof', companion: 'copilot', strengths: ['reviewer'] },
      { id: 'plan-one', companion: 'copilot', strengths: ['planner'] },
      { id: 'plan-two', companion: 'copilot', strengths: ['planner'] },
    ],
  });
  const load = reg.loadProfiles({ env: ENV });
  const flat = reg.flatStrengths(load, (id) => id === 'rev-prof'); // only rev-prof ready
  const byName = Object.fromEntries(flat.map((s) => [s.name, s]));
  assert.equal(byName.reviewer.ready, true);
  assert.equal(byName.reviewer.reason, null);
  assert.equal(byName.web_researcher.ready, false);
  assert.equal(byName.web_researcher.reason, 'no profile declares this strength');
  assert.equal(byName.planner.ready, false); // ambiguous (plan-one, plan-two) no tiebreak
  // No id leakage: scan every reason string for profile/companion ids.
  for (const entry of flat) {
    if (entry.reason == null) continue;
    for (const id of ['rev-prof', 'plan-one', 'plan-two', 'copilot', 'opencode']) {
      assert.ok(!entry.reason.includes(id), `reason leaks "${id}": ${entry.reason}`);
    }
  }
});

test('STRENGTH_CAPABILITY_REQUIREMENTS is the empty v1 map', () => {
  for (const s of reg.VALID_STRENGTHS) {
    assert.deepEqual(reg.STRENGTH_CAPABILITY_REQUIREMENTS[s], []);
  }
});
