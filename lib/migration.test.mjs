import '../test/sandbox-home.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as state from './state.mjs';
const env = { AGENT_COMPANION_HOME: state.BASE_DIR };

beforeEach(() => {
  rmSync(state.BASE_DIR, { recursive: true, force: true });
  mkdirSync(state.BASE_DIR, { recursive: true });
});

test('shared migration imports each unambiguous setting and retains both sides of each conflict', () => {
  const env = { HOME: state.BASE_DIR, CODEX_HOME: join(state.BASE_DIR, 'custom-codex') };
  const dirs = { claude: join(env.HOME, '.claude', 'agent-companion'), codex: join(env.CODEX_HOME, 'agent-companion') };
  const old = (host, name, value) => {
    mkdirSync(dirs[host], { recursive: true });
    const path = join(dirs[host], name);
    writeFileSync(path, value + '\n');
    return path;
  };
  const moved = [
    old('codex', 'default-model', 'copilot-id'), old('claude', 'default-model', 'copilot-id'),
    old('claude', 'default-model-opencode', 'provider/model'), old('codex', 'default-model-antigravity', 'agy'),
    old('codex', 'default-model-claude', 'sonnet'),
  ];
  const conflicts = [
    ['target', 'default-target', 'claude', 'codex'],
    ['companions.codex.model', 'default-model-codex', 'left-model', 'right-model'],
  ].flatMap(([setting, name, left, right]) => ['claude', 'codex'].map((host, i) => {
    const value = i ? right : left;
    return { setting, host, value, path: old(host, name, value) };
  }));
  const warnings = [];
  state.migrateDefaults({ env, log: (level, message) => { if (level === 'WARN') warnings.push(message); } });
  assert.deepEqual(JSON.parse(readFileSync(join(env.HOME, '.config', 'agent-companion', 'settings.json'))), {
    companions: { copilot: { model: 'copilot-id' }, opencode: { model: 'provider/model' },
      antigravity: { model: 'agy' }, claude: { model: 'sonnet' } },
  });
  assert.ok(moved.every(path => !existsSync(path)));
  assert.deepEqual(state.legacyDefaultConflicts(env), conflicts);
  for (const { path, value, setting } of conflicts) {
    assert.equal(readFileSync(path, 'utf8').trim(), value);
    assert.ok(warnings.some(message => message.includes(setting) && message.includes(value)));
  }
  assert.deepEqual(state.readDefaultModel('codex', env), { model: null, source: 'unset' });
  assert.deepEqual(state.readDefaultTarget(env), { target: null, source: 'unset' });
  const late = old('claude', 'default-model-opencode', 'too/late');
  state.migrateDefaults({ env, log: () => assert.fail('already migrated') });
  assert.ok(existsSync(late));
  assert.equal(state.readDefaultModel('opencode', env).model, 'provider/model');
});

test('even an empty migration creates settings once and the override only imports its own directory', () => {
  const ignoredDir = join(state.BASE_DIR, '.claude', 'agent-companion');
  mkdirSync(ignoredDir, { recursive: true });
  writeFileSync(join(ignoredDir, 'default-target'), 'claude');
  const sandbox = { ...env, HOME: state.BASE_DIR };
  state.migrateDefaults({ env: sandbox });
  const file = join(state.BASE_DIR, 'settings.json');
  assert.deepEqual(JSON.parse(readFileSync(file)), {});
  writeFileSync(join(state.BASE_DIR, 'default-target'), 'codex');
  state.migrateDefaults({ env: sandbox });
  assert.equal(state.readDefaultTarget(sandbox).target, null);
  rmSync(file);
  state.migrateDefaults({ env: sandbox });
  assert.equal(state.readDefaultTarget(sandbox).target, 'codex');
  assert.ok(existsSync(join(ignoredDir, 'default-target')));
  assert.equal(existsSync(join(state.BASE_DIR, 'default-target')), false);
});
