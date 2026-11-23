// State-layer round-trip tests. Runs in an isolated directory via
// AGENT_COMPANION_HOME so the user's real state is untouched.

import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Set the home override BEFORE importing the state module so constants bind to it.
const SANDBOX = mkdtempSync(join(tmpdir(), 'copilot-state-'));
process.env.AGENT_COMPANION_HOME = SANDBOX;

const state = await import('./state.mjs');

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

test('companion and models share one private, atomically replaced file and resolve per call', () => {
  const env = { HOME: SANDBOX, XDG_CONFIG_HOME: join(SANDBOX, 'xdg') };
  const file = join(env.XDG_CONFIG_HOME, 'agent-companion', 'settings.json');
  assert.deepEqual(state.readDefaultCompanion(env), { companion: null, source: 'unset' });
  assert.equal(existsSync(file), false);
  state.writeDefaultModel('copilot-model', 'copilot', env);
  const before = statSync(file);
  state.writeDefaultCompanion('Codex', env);
  assert.notEqual(statSync(file).ino, before.ino);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  state.writeDefaultModel('code-model', 'codex', env);
  assert.deepEqual(JSON.parse(readFileSync(file)), {
    companion: 'codex', companions: { copilot: { model: 'copilot-model' }, codex: { model: 'code-model' } },
  });
  assert.deepEqual(state.readDefaultCompanion(env), { companion: 'codex', source: 'config' });
  assert.deepEqual(state.readDefaultModel('codex', env), { model: 'code-model', source: 'config' });
  assert.deepEqual(state.readDefaultCompanion({ ...env, AGENT_COMPANION_DEFAULT_COMPANION: ' Claude ' }), { companion: 'claude', source: 'env' });
  assert.deepEqual(state.readDefaultModel('codex', { ...env, AGENT_COMPANION_CODEX_MODEL: ' env-model ' }), { model: 'env-model', source: 'env' });
  assert.deepEqual(state.readDefaultCompanion({ ...env, AGENT_COMPANION_HOME: SANDBOX }), { companion: null, source: 'unset' });
  const settings = JSON.parse(readFileSync(file));
  settings.companions.codex.effort = 'high';
  writeFileSync(file, JSON.stringify(settings));
  state.clearDefaultModel('codex', env);
  state.clearDefaultCompanion(env);
  state.clearDefaultModel('copilot', env);
  assert.deepEqual(JSON.parse(readFileSync(file)), { companions: { codex: { effort: 'high' } } });
  assert.deepEqual(readdirSync(dirname(file)), ['settings.json']);
  assert.throws(() => state.writeDefaultCompanion(' ', env), /empty id/);
  assert.throws(() => state.writeDefaultModel('', 'codex', env), /empty id/);
});

test('a write that changes nothing leaves the file alone', () => {
  const dir = join(SANDBOX, 'unchanged');
  const env = { ...process.env, AGENT_COMPANION_HOME: dir };
  state.writeDefaultModel('19', 'codex', env);
  const file = join(dir, 'settings.json');
  const before = statSync(file);
  state.writeDefaultModel('19', 'codex', env);
  assert.equal(statSync(file).ino, before.ino);
  assert.equal(statSync(file).mtimeMs, before.mtimeMs);
});

test('per-companion effort round-trips without validating levels or disturbing other settings', () => {
  const env = { AGENT_COMPANION_HOME: join(SANDBOX, 'effort') };
  const file = join(env.AGENT_COMPANION_HOME, 'settings.json');
  const unset = { effort: null, source: 'unset' };
  assert.deepEqual(state.readDefaultEffort('claude', env), unset);
  state.clearDefaultEffort('claude', env);
  assert.equal(existsSync(file), false);
  state.writeDefaultModel('haiku', 'claude', env);
  state.writeDefaultEffort(' custom-level ', 'claude', env);
  assert.deepEqual(state.readDefaultEffort('claude', env), { effort: 'custom-level', source: 'config' });
  assert.deepEqual(state.readDefaultEffort('codex', env), unset);
  assert.deepEqual(state.readDefaultEffort('claude', env, console.warn, {}), unset);
  const before = statSync(file);
  state.writeDefaultEffort('custom-level', 'claude', env);
  assert.equal(statSync(file).ino, before.ino);
  assert.equal(statSync(file).mtimeMs, before.mtimeMs);
  state.writeDefaultEffort('low', 'codex', env);
  state.clearDefaultEffort('claude', env);
  assert.deepEqual(JSON.parse(readFileSync(file)), { companions: { claude: { model: 'haiku' }, codex: { effort: 'low' } } });
  state.clearDefaultModel('claude', env);
  state.clearDefaultEffort('codex', env);
  assert.deepEqual(JSON.parse(readFileSync(file)), {});
  assert.throws(() => state.writeDefaultEffort(' ', 'codex', env), /empty/);
});

test('invalid or unreadable settings warn readers and refuse mutations without replacing the file', () => {
  const env = { AGENT_COMPANION_HOME: join(SANDBOX, 'damaged') };
  mkdirSync(env.AGENT_COMPANION_HOME);
  const file = join(env.AGENT_COMPANION_HOME, 'settings.json');
  for (const raw of ['{bad', 'null', '[]', '{"companion":7}', '{"companions":[]}', '{"companions":{"codex":{"model":42}}}', null]) {
    if (raw === null) mkdirSync(file);
    else writeFileSync(file, raw);
    const events = [];
    const log = (...args) => events.push(args);
    assert.deepEqual(state.readDefaultCompanion(env, log), { companion: null, source: 'unset' });
    assert.deepEqual(state.readDefaultModel('codex', env, log), { model: null, source: 'unset' });
    assert.ok(events.some(([level, message]) => level === 'WARN' && message.includes(file)));
    assert.throws(() => state.writeDefaultCompanion('claude', env), /settings.json/);
    assert.throws(() => state.clearDefaultModel('codex', env), /settings.json/);
    if (raw === null) assert.ok(statSync(file).isDirectory());
    else assert.equal(readFileSync(file, 'utf8'), raw);
    rmSync(file, { recursive: true });
  }
});

test('isModelAllowedFor is companion-specific and lenient on empty', () => {
  assert.equal(state.isModelAllowedFor('copilot', 'byok-model:latest'), true);
  assert.equal(state.isModelAllowedFor('copilot', 'bad model'), false);
  // Antigravity ids are bare and validated by the server itself (-32602).
  assert.equal(state.isModelAllowedFor('antigravity', 'gemini-pro-agent'), true);
  assert.equal(state.isModelAllowedFor('antigravity', 'gemini pro'), false);
  assert.equal(state.isModelAllowedFor('antigravity', ''), true);
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

test('Claude model aliases and ids round-trip with env over file over inherited configuration', () => {
  for (const model of ['haiku', 'sonnet', 'claude-haiku-5-5', '', null]) {
    assert.equal(state.isModelAllowedFor('claude', model), true);
  }
  for (const model of ['bad model', 'bad\nmodel', 'bad\tmodel']) {
    assert.equal(state.isModelAllowedFor('claude', model), false);
  }
  state.clearDefaultModel('claude');
  try {
    assert.deepEqual(state.readDefaultModel('claude'), { model: null, source: 'unset' });
    state.writeDefaultModel('sonnet', 'claude');
    assert.deepEqual(state.readDefaultModel('claude'), { model: 'sonnet', source: 'config' });
    assert.ok(existsSync(join(SANDBOX, 'settings.json')));
    assert.deepEqual(state.readDefaultModel('claude', { AGENT_COMPANION_HOME: SANDBOX, AGENT_COMPANION_CLAUDE_MODEL: ' haiku ' }), { model: 'haiku', source: 'env' });
    assert.deepEqual(state.readDefaultModel('claude', { AGENT_COMPANION_HOME: SANDBOX, AGENT_COMPANION_CLAUDE_MODEL: ' ' }), { model: 'sonnet', source: 'config' });
  } finally { state.clearDefaultModel('claude'); }
});
