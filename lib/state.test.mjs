// State-layer round-trip tests. Runs in an isolated directory via
// AGENT_COMPANION_HOME so the user's real state is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Set the home override BEFORE importing the state module so constants bind to it.
const SANDBOX = mkdtempSync(join(tmpdir(), 'copilot-state-'));
process.env.AGENT_COMPANION_HOME = SANDBOX;

const state = await import('./state.mjs');

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

test('default-model config falls back, round-trips, validates ids, and writes atomically', () => {
  state.clearDefaultModel();
  assert.deepEqual(state.readDefaultModel(), { model: state.DEFAULT_MODEL, source: 'fallback' });

  state.writeDefaultModel('gpt-5.4');
  const r = state.readDefaultModel();
  assert.equal(r.model, 'gpt-5.4');
  assert.equal(r.source, 'config');
  assert.equal(state.isModelAllowed('gpt-5.4'), true);
  assert.equal(state.isModelAllowed('gpt-5.5'), false);
  assert.equal(state.isCodexAgentModelAllowed('gpt-5.5'), true);
  assert.equal(state.isModelAllowed('fake-model'), false);

  assert.throws(() => state.writeDefaultModel(' '), /empty id/);
  assert.throws(() => state.writeDefaultModel(''), /empty id/);

  const dir = dirname(state.MODEL_FILE);
  const leftover = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
  state.clearDefaultModel();
});

test('default-target is unset without config, honors env override, round-trips, and writes atomically', () => {
  state.clearDefaultTarget();
  assert.deepEqual(state.readDefaultTarget({}), { target: null, source: 'unset' });
  assert.deepEqual(
    state.readDefaultTarget({ AGENT_COMPANION_DEFAULT_TARGET: 'Copilot' }),
    { target: 'copilot', source: 'env' },
  );

  state.writeDefaultTarget('copilot');
  const r = state.readDefaultTarget({});
  assert.equal(r.target, 'copilot');
  assert.equal(r.source, 'config');

  assert.throws(() => state.writeDefaultTarget(' '), /empty id/);
  assert.throws(() => state.writeDefaultTarget(''), /empty id/);

  const dir = dirname(state.TARGET_FILE);
  const leftover = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
  state.clearDefaultTarget();
});

test('thread sid files round-trip, overwrite, list, clear, and reject unsafe names', () => {
  assert.equal(state.readThreadSid('t1'), null);
  state.writeThreadSid('t1', null, 'sid-abc-1');
  assert.equal(state.readThreadSid('t1'), 'sid-abc-1');
  state.writeThreadSid('t1', null, 'sid-abc-2');
  assert.equal(state.readThreadSid('t1'), 'sid-abc-2');
  state.clearThread('t1');
  assert.equal(state.readThreadSid('t1'), null);

  assert.throws(() => state.readThreadSid('../x'), /invalid thread name/);
  assert.throws(() => state.writeThreadSid('a/b', null, 's'), /invalid thread name/);

  state.writeThreadSid('th-a', null, 'sid-a');
  state.writeThreadSid('th-b', null, 'sid-b');
  assert.ok(state.listThreads().length >= 2);
  state.clearAllThreads();
  assert.equal(state.listThreads().length, 0);
});

test('thread sid namespaces by profileId; legacy (null) path stays byte-identical', () => {
  // Legacy/null path → <name>.sid
  state.writeThreadSid('shared', null, 'legacy-sid');
  assert.ok(existsSync(join(state.THREADS_DIR, 'shared.sid')));
  // Namespaced path → <name>__<profileId>.sid, isolated from legacy + each other.
  state.writeThreadSid('shared', 'cop-review', 'sid-review');
  state.writeThreadSid('shared', 'cop-fast', 'sid-fast');
  assert.ok(existsSync(join(state.THREADS_DIR, 'shared__cop-review.sid')));
  assert.ok(existsSync(join(state.THREADS_DIR, 'shared__cop-fast.sid')));
  assert.equal(state.readThreadSid('shared'), 'legacy-sid');
  assert.equal(state.readThreadSid('shared', 'cop-review'), 'sid-review');
  assert.equal(state.readThreadSid('shared', 'cop-fast'), 'sid-fast');
  // Cache keyed by profileId: clearing one leaves the others.
  state.clearThread('shared', 'cop-review');
  assert.equal(state.readThreadSid('shared', 'cop-review'), null);
  assert.equal(state.readThreadSid('shared', 'cop-fast'), 'sid-fast');
  assert.equal(state.readThreadSid('shared'), 'legacy-sid');
  assert.throws(() => state.writeThreadSid('shared', 'bad/pid', 's'), /invalid profile id/);
  state.clearThread('shared');
  state.clearThread('shared', 'cop-fast');
});

test('profiles.json round-trips, returns null on missing/corrupt, and writes atomically', () => {
  state.clearProfiles();
  assert.equal(state.readProfilesRaw(), null);

  const doc = { profiles: [{ id: 'cop-x', companion: 'copilot', strengths: ['reviewer'] }], defaultProfile: 'cop-x' };
  state.writeProfiles(doc);
  assert.deepEqual(state.readProfilesRaw(), doc);

  writeFileSync(state.PROFILES_FILE, '{ broken');
  assert.equal(state.readProfilesRaw(), null); // corrupt → null, never throws

  assert.throws(() => state.writeProfiles(null), /must be a plain object/);
  assert.throws(() => state.writeProfiles([]), /must be a plain object/);

  const leftover = readdirSync(dirname(state.PROFILES_FILE)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
  state.clearProfiles();
  assert.equal(state.readProfilesRaw(), null);
});

test('readDefaultProfile is unset without config and honors env-above-file', () => {
  state.clearProfiles();
  assert.deepEqual(state.readDefaultProfile({}), { value: null, source: 'unset' });

  state.writeProfiles({ profiles: [{ id: 'cop-x', companion: 'copilot' }], defaultProfile: 'cop-x' });
  assert.deepEqual(state.readDefaultProfile({}), { value: 'cop-x', source: 'file' });
  assert.deepEqual(
    state.readDefaultProfile({ AGENT_COMPANION_DEFAULT_PROFILE: 'cop-y' }),
    { value: 'cop-y', source: 'env' },
  );
  state.clearProfiles();
});

test('isModelAllowedFor is companion-specific and lenient on empty', () => {
  assert.equal(state.isModelAllowedFor('copilot', 'claude-sonnet-4.6'), true);
  assert.equal(state.isModelAllowedFor('copilot', 'gpt-5.5'), false); // codex model, not copilot
  assert.equal(state.isModelAllowedFor('opencode', 'anthropic/claude-sonnet-4.6'), true);
  assert.equal(state.isModelAllowedFor('opencode', 'no-slash'), false);
  assert.equal(state.isModelAllowedFor('copilot', ''), true);   // no pin → allowed
  assert.equal(state.isModelAllowedFor('opencode', null), true);
  assert.equal(state.isModelAllowedFor('unknown', 'x'), false);
});

test('job ledger round-trips, filters by host session, deletes idempotently, and rejects unsafe writes', () => {
  const data = {
    jobId: 'copilot-abc123',
    promptId: 'p-1',
    copilotSessionId: 'cop-sid-1',
    claudeSessionId: 'cc-sid-A',
    status: 'running',
    startedAt: 1000,
  };
  state.writeJob('copilot-abc123', data);
  const back = state.readJob('copilot-abc123');
  assert.deepEqual(back, data);
  assert.equal(state.readJob('nonexistent-job'), null);

  state.writeJob('j-A1', { jobId: 'j-A1', claudeSessionId: 'sid-A', status: 'running' });
  state.writeJob('j-A2', { jobId: 'j-A2', claudeSessionId: 'sid-A', status: 'completed' });
  state.writeJob('j-B1', { jobId: 'j-B1', claudeSessionId: 'sid-B', status: 'running' });

  const aJobs = state.listJobsForSession('sid-A');
  const bJobs = state.listJobsForSession('sid-B');
  const cJobs = state.listJobsForSession('sid-C');
  assert.equal(aJobs.length, 2);
  assert.equal(bJobs.length, 1);
  assert.equal(cJobs.length, 0);
  assert.deepEqual(aJobs.map((j) => j.jobId).sort(), ['j-A1', 'j-A2']);
  assert.deepEqual(state.listJobsForSession(null), []);
  assert.deepEqual(state.listJobsForSession(''), []);

  state.deleteJob('j-A1');
  state.deleteJob('j-A2');
  state.deleteJob('j-B1');
  state.deleteJob('never-existed');
  state.deleteJob('never-existed');
  assert.equal(state.readJob('never-existed'), null);

  assert.throws(() => state.writeJob('../escape', { jobId: 'x' }), /invalid job id/);
  assert.throws(() => state.writeJob('a/b', { jobId: 'x' }), /invalid job id/);
  assert.throws(() => state.writeJob('valid-id', null), /must be an object/);
  assert.throws(() => state.writeJob('valid-id', 'string'), /must be an object/);
});

test('host-session to thread mapping round-trips and validates both ids', () => {
  const sid = '019e0dc8-94b3-7172-abeb-60578f8a8a8d';
  assert.equal(state.readHostSessionThread(sid), null);
  state.writeHostSessionThread(sid, 'companion-copilot-abc');
  assert.equal(state.readHostSessionThread(sid), 'companion-copilot-abc');
  state.writeHostSessionThread(sid, 'companion-copilot-xyz');
  assert.equal(state.readHostSessionThread(sid), 'companion-copilot-xyz');
  state.clearHostSessionThread(sid);
  assert.equal(state.readHostSessionThread(sid), null);

  assert.throws(() => state.readHostSessionThread('../escape'), /invalid host session id/);
  assert.throws(() => state.writeHostSessionThread('a/b', 't'), /invalid host session id/);
  assert.throws(() => state.writeHostSessionThread('', 't'), /invalid host session id/);
  assert.throws(() => state.writeHostSessionThread('sid-1', ''), /empty thread name/);
  assert.throws(() => state.writeHostSessionThread('sid-1', '   '), /empty thread name/);
  assert.throws(() => state.writeHostSessionThread('sid-1', 'thread/with/slash'), /invalid thread name/);
});
