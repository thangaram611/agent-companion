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

test('absent profiles.json with codex default takes model from AGENT_COMPANION_CODEX_MODEL, not the opencode env', () => {
  reset();
  state.writeDefaultTarget('codex');
  const withEnv = reg.loadProfiles({ env: { AGENT_COMPANION_CODEX_MODEL: 'gpt-5.6-sol', AGENT_COMPANION_OPENCODE_MODEL: 'anthropic/should-not-leak' } });
  assert.equal(withEnv.profiles[0].companion, 'codex');
  assert.equal(withEnv.profiles[0].model, 'gpt-5.6-sol');
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

test('codex adapter:appserver overlays CODEX_RUNTIME_ADAPTER and flips reply/resume', () => {
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'cx-exec', companion: 'codex', strengths: [] },
      { id: 'cx-app', companion: 'codex', adapter: 'appserver', strengths: ['planner'] },
    ],
  });
  const load = reg.loadProfiles({ env: ENV }); // env has no CODEX_RUNTIME_ADAPTER
  // exec is the default and stays send-only: the pipe has no control channel.
  assert.equal(load.byId.get('cx-exec').capabilities.reply, false);
  assert.equal(load.byId.get('cx-exec').capabilities.resume, false);
  // The app-server profile inherits the daemon capabilities through the SAME
  // applyAdapterCapabilities path opencode's adapter:'server' uses.
  assert.equal(load.byId.get('cx-app').capabilities.reply, true);
  assert.equal(load.byId.get('cx-app').capabilities.resume, true);
  assert.equal(load.byId.get('cx-app').capabilities.serverMode, true);
  // Overlay must not leak to the sibling profile or to process.env.
  assert.equal(process.env.CODEX_RUNTIME_ADAPTER, undefined);
});

test('a single-shot pin does NOT overlay — the host env still says what a job can do', () => {
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'cx-pin-exec', companion: 'codex', adapter: 'exec' },
      { id: 'oc-pin-cli', companion: 'opencode', adapter: 'cli' },
    ],
  });
  // The host has both daemons selected and these profiles named the single-shot
  // transports — which the SEND PATH DOES NOT READ. resolveRouting projects
  // companion/model/profileId/strength and nothing else; the transport comes from
  // the env at spawn. So these jobs will run on the daemons and will be able to
  // reply, and a capability report of `false` here would be a promise the runtime
  // does not keep. The declaration is recorded (below) and validated; it just
  // does not get to under-report a machine it cannot actually change.
  const load = reg.loadProfiles({
    env: { CODEX_RUNTIME_ADAPTER: 'appserver', OPENCODE_RUNTIME_ADAPTER: 'server' },
  });
  assert.equal(load.byId.get('cx-pin-exec').capabilities.reply, true);
  assert.equal(load.byId.get('oc-pin-cli').capabilities.reply, true);
  // Recorded, not silently dropped: doctor and status show what was authored.
  assert.equal(load.byId.get('cx-pin-exec').adapter, 'exec');
  assert.equal(load.byId.get('oc-pin-cli').adapter, 'cli');
  // Same host, no pin at all — identical answer. That equality IS the rule: the
  // single-shot value changes nothing about capability resolution.
  const inherited = reg.buildSynthesizedProfile('codex', { CODEX_RUNTIME_ADAPTER: 'appserver' });
  assert.equal(inherited.capabilities.reply, true);
  // And the daemon pin is the direction that DOES overlay: on a host with the env
  // unset, `appserver` reports the daemon's capabilities while `exec` does not.
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'cx-app', companion: 'codex', adapter: 'appserver' },
      { id: 'cx-exec', companion: 'codex', adapter: 'exec' },
    ],
  });
  const bare = reg.loadProfiles({ env: ENV });
  assert.equal(bare.byId.get('cx-app').capabilities.reply, true);
  assert.equal(bare.byId.get('cx-exec').capabilities.reply, false);
});

test('adapter validation names the valid set for THAT companion', () => {
  reset();
  state.writeProfiles({
    profiles: [
      { id: 'cx-server', companion: 'codex', adapter: 'server' },      // opencode's value
      { id: 'oc-appserver', companion: 'opencode', adapter: 'appserver' }, // codex's value
      { id: 'cop-adapter', companion: 'copilot', adapter: 'server' },  // no adapter at all
      { id: 'cx-ok', companion: 'codex', adapter: 'APPSERVER' },       // case-folded, kept
    ],
  });
  const load = reg.loadProfiles({ env: ENV });
  assert.deepEqual(load.profiles.map((p) => p.id), ['cx-ok']);
  assert.equal(load.byId.get('cx-ok').adapter, 'appserver');

  const messageFor = (id) => load.loadErrors.find((e) => e.id === id)?.message || '';
  // Each rejection recites the companion's OWN pair, never a merged four-value
  // list — a codex profile told "cli or server" would be told to spell a
  // transport codex does not have.
  assert.match(messageFor('cx-server'), /adapter must be "exec" or "appserver" for companion "codex"/);
  assert.doesNotMatch(messageFor('cx-server'), /"cli"/);
  assert.match(messageFor('oc-appserver'), /adapter must be "cli" or "server" for companion "opencode"/);
  assert.doesNotMatch(messageFor('oc-appserver'), /"appserver"/);
  // Copilot has no profile-selectable adapter, so the answer is not a value list.
  assert.match(messageFor('cop-adapter'), /no profile-selectable adapter/);
  assert.match(messageFor('cop-adapter'), /opencode, codex/);
});

test('COMPANION_ADAPTERS agrees with the target registry it overlays into', async () => {
  // Two tables name these transports: this one (which values a PROFILE may carry
  // and which env var to overlay) and the target registry's ADAPTER_UPGRADES
  // (which value turns reply/resume on). They are deliberately separate — the
  // registry stays import-light for the standalone CLIs — so this is the check
  // that keeps them from drifting apart, the same trade the registry's own
  // predicate/adapter agreement test makes.
  //
  // A drift here is silent and specific: an accepted value the registry does not
  // recognise would overlay an env var that upgrades nothing, and the profile
  // would advertise the daemon's capabilities while running the single-shot
  // transport.
  const registry = await import('./target-registry.mjs');
  for (const [companion, spec] of Object.entries(reg.COMPANION_ADAPTERS)) {
    const daemon = registry.daemonAdapterFor(companion);
    assert.ok(daemon, `${companion} accepts an adapter but the registry has no daemon transport for it`);
    assert.ok(spec.values.includes(daemon), `${companion} must accept its own daemon value "${daemon}"`);
    // Every accepted value round-trips through the overlay: the daemon one
    // upgrades, the others do not. Anything else means one table renamed a
    // transport the other still spells the old way.
    for (const value of spec.values) {
      const caps = registry.getTargetById(companion, { [spec.env]: value }).capabilities;
      assert.equal(caps.serverMode, value === daemon, `${companion}/${value} via ${spec.env}`);
    }
  }
  // And the companions with no entry here genuinely have no daemon to select.
  for (const id of registry.listTargetIds()) {
    if (reg.COMPANION_ADAPTERS[id]) continue;
    assert.equal(registry.daemonAdapterFor(id), null, `${id} has a daemon adapter no profile can ask for`);
  }
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
  assert.match(messages, /no profile-selectable adapter/);
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
