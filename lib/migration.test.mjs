import '../test/sandbox-home.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as state from './state.mjs';
import { dispatch, createBridgeController, _resetForTest } from '../bridge-server/server.mjs';
import { until } from '../test/controller/helpers.mjs';
import { queuePath } from './runtime-paths.mjs';

const env = { AGENT_COMPANION_HOME: state.BASE_DIR };

function clean() {
  state.clearAllThreads();
  rmSync(state.BASE_DIR, { recursive: true, force: true });
  mkdirSync(state.BASE_DIR, { recursive: true });
}
beforeEach(() => { clean(); _resetForTest(); });
const profilesFile = join(state.BASE_DIR, 'profiles.json');
function profiles(doc) { writeFileSync(profilesFile, JSON.stringify(doc)); }
function history(name, sid) {
  mkdirSync(state.THREADS_DIR, { recursive: true });
  writeFileSync(join(state.THREADS_DIR, `${name}.sid`), sid + '\n');
}

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

test('profile carry-over preserves newer per-host settings in the bridge startup order', () => {
  profiles({ defaultProfile: 'p', profiles: [{ id: 'p', companion: 'codex', model: 'legacy-profile' }] });
  writeFileSync(join(state.BASE_DIR, 'default-target'), 'claude');
  writeFileSync(join(state.BASE_DIR, 'default-model-codex'), 'saved-model');
  state.migrateLegacyState({ env });
  state.migrateDefaults({ env });
  assert.equal(state.readDefaultTarget(env).target, 'claude');
  assert.equal(state.readDefaultModel('codex', env).model, 'saved-model');
  assert.equal(existsSync(join(state.BASE_DIR, 'default-model-codex')), false);
});

test('migration carries the default model once for each companion, logs it, and preserves profiles.json', () => {
  for (const companion of ['copilot', 'codex', 'opencode', 'antigravity', 'claude']) {
    clean();
    const model = companion === 'opencode' ? 'provider/model' : 'gpt-5.4';
    profiles({ defaultProfile: 'selected', profiles: [{ id: 'selected', companion, model }] });
    const source = readFileSync(profilesFile, 'utf8');
    const events = [];
    state.migrateLegacyState({ env, log: (...args) => events.push(args) });
    assert.equal(state.readDefaultModel(companion, env).model, model);
    assert.ok(events.some((e) => e.join(' ').includes(`carried default model to ${companion}`)));
    assert.equal(readFileSync(profilesFile, 'utf8'), source);
    state.clearDefaultModel(companion);
    profiles({ defaultProfile: 'later', profiles: [{ id: 'later', companion, model: 'different' }] });
    state.migrateLegacyState({ env, log: () => assert.fail('must not re-read profiles or repeat migration') });
    assert.equal(state.readDefaultModel(companion, env).model, null, 'file is never read again');
  }
});

test('migration preserves configured model defaults, including environment overrides', () => {
  for (const companion of ['copilot', 'codex', 'opencode', 'antigravity', 'claude']) {
    clean();
    state.writeDefaultModel('existing', companion);
    profiles({ defaultProfile: 'old', profiles: [{ id: 'old', companion, model: 'legacy' }] });
    state.migrateLegacyState({ env });
    assert.equal(state.readDefaultModel(companion, env).model, 'existing');
  }
  for (const companion of ['codex', 'opencode', 'claude']) {
    clean();
    profiles({ defaultProfile: 'old', profiles: [{ id: 'old', companion, model: 'legacy' }] });
    state.migrateLegacyState({ env: { ...env, [`AGENT_COMPANION_${companion.toUpperCase()}_MODEL`]: 'configured' } });
    assert.equal(state.readDefaultModel(companion, env).model, null, 'env setting prevents carry-over');
  }
});

test('missing, invalid and model-free legacy defaults are one-shot no-ops', () => {
  for (const doc of [null, '{bad json', '{}', JSON.stringify({ defaultProfile: 'missing', profiles: [null] }),
    JSON.stringify({ defaultProfile: 'old', profiles: [{ id: 'old', companion: 'codex' }] })]) {
    clean();
    if (doc !== null) writeFileSync(profilesFile, doc);
    state.migrateLegacyState({ env });
    assert.equal(state.readDefaultModel('codex', env).model, null);
    assert.ok(existsSync(join(state.BASE_DIR, 'phase1-migrated')));
    if (doc !== null) assert.equal(readFileSync(profilesFile, 'utf8'), doc);
  }
});

test('a single legacy session is retained, including ledger-only history, without rewriting jobs', () => {
  history('single__review', 'session-one');
  history('plain', 'plain-session');
  const old = { jobId: 'older', thread: 'ledger-only', profileId: 'one', target: 'codex', companionSessionId: 'old', startedAt: 1 };
  mkdirSync(state.JOBS_DIR, { recursive: true });
  writeFileSync(join(state.JOBS_DIR, 'older.json'), JSON.stringify(old));
  const newest = { ...old, jobId: 'newer', companionSessionId: 'current', startedAt: 2, status: 'running' };
  writeFileSync(join(state.JOBS_DIR, 'newer.json'), JSON.stringify(newest));
  state.migrateLegacyState({ env });
  assert.equal(state.readThreadSid('single'), 'session-one');
  assert.equal(state.readThreadSid('plain'), 'plain-session');
  assert.equal(state.readThreadSid('ledger-only'), 'current', 'superseded sessions do not create false ambiguity');
  assert.equal(existsSync(join(state.THREADS_DIR, 'single__review.sid')), false);
  assert.deepEqual(state.readJob('newer'), newest);
  assert.deepEqual(state.readJob('older'), old);
});

test('migration preserves profile ids with separators and the sessions behind an ambiguous history', () => {
  profiles({ profiles: [{ id: 'review__custom', companion: 'copilot' }, { id: 'fast', companion: 'codex' }] });
  history('named__review__custom', 'session-one');
  history('conflict__review__custom', 'session-two');
  history('conflict__fast', 'session-three');
  state.migrateLegacyState({ env });
  assert.equal(state.readThreadSid('named'), 'session-one');
  assert.throws(() => state.readThreadSid('conflict'), /review__custom/);
  const records = JSON.parse(readFileSync(join(state.THREADS_DIR, 'conflict.ambiguous'), 'utf8'));
  assert.deepEqual(records.map((r) => r.sid).sort(), ['session-three', 'session-two']);
});

test('conflicting legacy histories refuse follow-up explicitly and never start a new conversation', async () => {
  history('conflict__review', 'session-review');
  history('conflict__fast', 'session-fast');
  state.migrateLegacyState({ env });
  const prior = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'migration-conflict';
  const controller = createBridgeController({ providers: Object.fromEntries(['copilot', 'codex', 'opencode', 'antigravity', 'claude'].map((id) => [id, { enabled: true, ready: true, create: () => assert.fail('ambiguous thread must not start a runtime') }])) });
  try {
    for (const target of ['copilot', 'codex', 'opencode', 'antigravity', 'claude']) {
      const response = (await dispatch({ action: 'send', target, task: 'continue', cwd: tmpdir(), thread: 'conflict' }, { controller })).structuredContent;
      assert.equal(response.ok, false);
      assert.equal(response.status, 'thread_ambiguous');
      assert.match(response.error, /conflict__review\.sid/);
      assert.match(response.error, /conflict__fast\.sid/);
    }
    assert.throws(() => state.writeThreadSid('conflict', 'silent-replacement'), /ambiguous/);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prior;
  }
});
