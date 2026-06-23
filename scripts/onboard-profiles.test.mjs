// Strength-routed profile authoring tests. Sandboxed via AGENT_COMPANION_HOME
// (set BEFORE import) so writeProfiles never touches the real config. Pure
// planners are exercised directly; runProfileCommand is driven with a captured
// io and validated against the single-producer loadProfiles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOX = mkdtempSync(join(tmpdir(), 'onboard-profiles-'));
process.env.AGENT_COMPANION_HOME = SANDBOX;

const { planProfile, planStrengthAssignment, runProfileCommand } = await import('./onboard.mjs');
const state = await import('../lib/state.mjs');
const { loadProfiles } = await import('../lib/profile-registry.mjs');

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

function reset() { state.clearProfiles(); }
function opts(over = {}) {
  return {
    listProfiles: false, defineProfile: undefined, companion: undefined, model: undefined,
    adapter: undefined, strength: undefined, assignStrength: undefined, setDefaultProfile: undefined,
    yes: false, json: false, ...over,
  };
}
function cap() {
  const out = [], err = [];
  return { io: { log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) }, out, err };
}

// ---- planProfile (pure) ------------------------------------------------------

test('planProfile validates id, companion, model, adapter, strengths, and duplicates', () => {
  assert.equal(planProfile({ id: 'cop-review', companion: 'copilot', model: 'claude-sonnet-4.6', strengths: ['reviewer', 'Reviewer'] }).kind, 'ok');
  assert.deepEqual(planProfile({ id: 'cop-review', companion: 'copilot', strengths: ['reviewer', 'Reviewer'] }).profile.strengths, ['reviewer']);
  assert.equal(planProfile({ id: 'BadId', companion: 'copilot' }).code, 'bad_id');
  assert.equal(planProfile({ id: 'ok', companion: 'gemini' }).code, 'bad_companion');
  assert.equal(planProfile({ id: 'ok', companion: 'copilot', model: 'gpt-5.5' }).code, 'bad_model');
  assert.equal(planProfile({ id: 'ok', companion: 'opencode', model: 'no-slash' }).code, 'bad_model');
  assert.equal(planProfile({ id: 'ok', companion: 'opencode', model: 'anthropic/claude-sonnet-4.6' }).kind, 'ok');
  assert.equal(planProfile({ id: 'ok', companion: 'copilot', adapter: 'server' }).code, 'bad_adapter');
  assert.equal(planProfile({ id: 'ok', companion: 'opencode', adapter: 'server' }).kind, 'ok');
  assert.equal(planProfile({ id: 'ok', companion: 'copilot', strengths: ['archivist'] }).code, 'bad_strength');
  assert.equal(planProfile({ id: 'dup', companion: 'copilot', existing: [{ id: 'dup', companion: 'opencode', strengths: [] }] }).code, 'duplicate_id');
});

// ---- planStrengthAssignment (pure) ------------------------------------------

test('planStrengthAssignment mirrors the resolveStrength ambiguity rule', () => {
  const existing = [
    { id: 'a', companion: 'copilot', strengths: ['reviewer'] },
    { id: 'b', companion: 'copilot', strengths: [] },
  ];
  assert.equal(planStrengthAssignment({ profileId: 'b', strength: 'planner', existing }).kind, 'ok'); // unclaimed
  const conflict = planStrengthAssignment({ profileId: 'b', strength: 'reviewer', existing });
  assert.equal(conflict.kind, 'conflict');
  assert.deepEqual(conflict.candidates.sort(), ['a', 'b']);
  // A defaultProfile that is one of the claimants resolves the tiebreak.
  assert.equal(planStrengthAssignment({ profileId: 'b', strength: 'reviewer', existing, defaultProfile: 'a' }).kind, 'ok');
  assert.equal(planStrengthAssignment({ profileId: 'x', strength: 'reviewer', existing }).code, 'unknown_profile');
});

// ---- runProfileCommand round-trip -------------------------------------------

test('--define-profile persists a profile that validates against loadProfiles', () => {
  reset();
  const { io, out, err } = cap();
  const code = runProfileCommand(opts({ defineProfile: 'cop-review', companion: 'copilot', model: 'claude-sonnet-4.6', strength: ['reviewer', 'planner'] }), {}, io);
  assert.equal(code, 0);
  assert.match(out.join('\n'), /defined profile "cop-review"/);
  assert.deepEqual(err, []);

  const reg = loadProfiles({ env: {} });
  assert.equal(reg.synthesized, false);
  assert.deepEqual(reg.loadErrors, []); // generated file is clean
  assert.deepEqual(reg.byId.get('cop-review').strengths, ['reviewer', 'planner']);

  // No secrets persisted — only ids / model names / strength labels.
  const raw = JSON.parse(readFileSync(state.PROFILES_FILE, 'utf8'));
  assert.deepEqual(Object.keys(raw.profiles[0]).sort(), ['companion', 'id', 'model', 'strengths']);
  assert.doesNotMatch(readFileSync(state.PROFILES_FILE, 'utf8'), /token|secret|password|api[_-]?key/i);
  reset();
});

test('--define-profile + --set-default-profile + --assign-strength compose deterministically', () => {
  reset();
  runProfileCommand(opts({ defineProfile: 'cop-a', companion: 'copilot', strength: ['planner'] }), {}, cap().io);
  runProfileCommand(opts({ defineProfile: 'cop-b', companion: 'copilot' }), {}, cap().io);

  // set default to a non-existent profile → error, exit 2.
  assert.equal(runProfileCommand(opts({ setDefaultProfile: 'ghost' }), {}, cap().io), 2);

  // Assign 'planner' to cop-b with NO defaultProfile → ambiguous; --yes → fail, no write.
  assert.equal(runProfileCommand(opts({ assignStrength: 'cop-b', strength: ['planner'], yes: true }), {}, cap().io), 2);
  assert.deepEqual(loadProfiles({ env: {} }).byId.get('cop-b').strengths, []);

  // Set a defaultProfile that claims planner, then the same assignment resolves.
  assert.equal(runProfileCommand(opts({ setDefaultProfile: 'cop-a' }), {}, cap().io), 0);
  assert.equal(loadProfiles({ env: {} }).defaultProfile.value, 'cop-a');
  assert.equal(runProfileCommand(opts({ assignStrength: 'cop-b', strength: ['planner'], yes: true }), {}, cap().io), 0);
  assert.deepEqual(loadProfiles({ env: {} }).byId.get('cop-b').strengths, ['planner']);
  reset();
});

test('--define-profile with an ambiguous strength under --yes fails without writing', () => {
  reset();
  runProfileCommand(opts({ defineProfile: 'cop-a', companion: 'copilot', strength: ['reviewer'] }), {}, cap().io);
  const code = runProfileCommand(opts({ defineProfile: 'cop-b', companion: 'copilot', strength: ['reviewer'], yes: true }), {}, cap().io);
  assert.equal(code, 2);
  // cop-b must NOT have been written.
  assert.equal(loadProfiles({ env: {} }).byId.has('cop-b'), false);
  reset();
});

test('--list-profiles returns 0 and lists configured profiles', () => {
  reset();
  runProfileCommand(opts({ defineProfile: 'cop-a', companion: 'copilot', strength: ['reviewer'] }), {}, cap().io);
  const { io, out } = cap();
  assert.equal(runProfileCommand(opts({ listProfiles: true }), {}, io), 0);
  assert.match(out.join('\n'), /cop-a/);
  reset();
});
