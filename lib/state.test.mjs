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

test('default-model config inherits when unset, round-trips, validates ids, and writes atomically', () => {
  state.clearDefaultModel();
  assert.deepEqual(state.readDefaultModel(), { model: null, source: 'unset' });

  state.writeDefaultModel('gpt-5.4');
  const r = state.readDefaultModel();
  assert.equal(r.model, 'gpt-5.4');
  assert.equal(r.source, 'config');
  assert.equal(state.isModelAllowedFor('copilot', 'gpt-5.4'), true);
  assert.equal(state.isModelAllowedFor('copilot', 'gpt-5.5'), false);
  assert.equal(state.isModelAllowedFor('copilot', 'fake-model'), false);

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
  state.writeThreadSid('t1', 'sid-abc-1');
  assert.equal(state.readThreadSid('t1'), 'sid-abc-1');
  state.writeThreadSid('t1', 'sid-abc-2');
  assert.equal(state.readThreadSid('t1'), 'sid-abc-2');
  state.clearThread('t1');
  assert.equal(state.readThreadSid('t1'), null);

  assert.throws(() => state.readThreadSid('../x'), /invalid thread name/);
  assert.throws(() => state.writeThreadSid('a/b', 's'), /invalid thread name/);

  state.writeThreadSid('th-a', 'sid-a');
  state.writeThreadSid('th-b', 'sid-b');
  assert.ok(state.listThreads().length >= 2);
  state.clearAllThreads();
  assert.equal(state.listThreads().length, 0);
});




test('isModelAllowedFor is companion-specific and lenient on empty', () => {
  assert.equal(state.isModelAllowedFor('copilot', 'claude-sonnet-4.6'), true);
  // Antigravity ids are bare and validated by the server itself (-32602).
  assert.equal(state.isModelAllowedFor('antigravity', 'gemini-pro-agent'), true);
  assert.equal(state.isModelAllowedFor('antigravity', 'gemini pro'), false);
  assert.equal(state.isModelAllowedFor('antigravity', ''), true);
  assert.equal(state.isModelAllowedFor('copilot', 'gpt-5.5'), false); // codex model, not copilot
  assert.equal(state.isModelAllowedFor('opencode', 'anthropic/claude-sonnet-4.6'), true);
  assert.equal(state.isModelAllowedFor('opencode', 'no-slash'), false);
  assert.equal(state.isModelAllowedFor('copilot', ''), true);   // no pin → allowed
  assert.equal(state.isModelAllowedFor('opencode', null), true);
  assert.equal(state.isModelAllowedFor('unknown', 'x'), false);
  // Codex gate is permissive (bare, no mandatory slash) — accepts any
  // non-blank id, including opencode-shaped provider/model ids under --oss;
  // only structurally-impossible embedded whitespace is rejected.
  assert.equal(state.isModelAllowedFor('codex', 'gpt-5.6-sol'), true);
  assert.equal(state.isModelAllowedFor('codex', 'ollama/gpt-oss:120b'), true);
  assert.equal(state.isModelAllowedFor('codex', 'a b'), false);
  assert.equal(state.isModelAllowedFor('codex', ''), true); // no pin → allowed
});

test('job ledger round-trips, filters by host session, deletes idempotently, and rejects unsafe writes', () => {
  const data = {
    jobId: 'copilot-abc123',
    promptId: 'p-1',
    companionSessionId: 'cop-sid-1',
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
