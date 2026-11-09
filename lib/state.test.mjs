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

test('legacy ledger reading never creates state and rejects unsafe paths', () => {
  rmSync(state.JOBS_DIR, { recursive: true, force: true });
  assert.deepEqual(state.listJobsForSession('host'), []);
  assert.equal(existsSync(state.JOBS_DIR), false);
  assert.equal(state.readJob('missing'), null);
  assert.throws(() => state.readJob('../escape'), /invalid job id/);
});


test('Claude model aliases and ids round-trip with env over file over inherited configuration', () => {
  for (const model of ['haiku', 'sonnet', 'claude-haiku-5-5', '', null]) {
    assert.equal(state.isModelAllowedFor('claude', model), true);
  }
  for (const model of ['bad model', 'bad\nmodel', 'bad\tmodel']) {
    assert.equal(state.isModelAllowedFor('claude', model), false);
  }
  state.clearDefaultModel('claude');
  try {
    assert.deepEqual(state.readDefaultModel('claude', {}), { model: null, source: 'unset' });
    state.writeDefaultModel('sonnet', 'claude');
    assert.deepEqual(state.readDefaultModel('claude', {}), { model: 'sonnet', source: 'config' });
    assert.ok(existsSync(join(SANDBOX, 'default-model-claude')));
    assert.deepEqual(state.readDefaultModel('claude', { AGENT_COMPANION_CLAUDE_MODEL: ' haiku ' }), { model: 'haiku', source: 'env' });
    assert.deepEqual(state.readDefaultModel('claude', { AGENT_COMPANION_CLAUDE_MODEL: ' ' }), { model: 'sonnet', source: 'config' });
  } finally { state.clearDefaultModel('claude'); }
});
