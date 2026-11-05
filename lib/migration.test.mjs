import '../test/sandbox-home.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as state from './state.mjs';
import { dispatch, createBridgeController, jobs, hydrateJobsFromLedger, _resetForTest } from '../bridge-server/server.mjs';
import { until } from '../test/controller/helpers.mjs';
import { queuePath } from './runtime-paths.mjs';
import { _setForTest as setDaemon, _resetForTest as resetDaemon } from '../bridge-server/daemon-client.mjs';

function clean() {
  state.clearAllThreads();
  rmSync(state.BASE_DIR, { recursive: true, force: true });
  mkdirSync(state.BASE_DIR, { recursive: true });
}
beforeEach(() => { clean(); jobs.clear(); _resetForTest(); });
const profilesFile = join(state.BASE_DIR, 'profiles.json');
function profiles(doc) { writeFileSync(profilesFile, JSON.stringify(doc)); }
function history(name, sid) {
  mkdirSync(state.THREADS_DIR, { recursive: true });
  writeFileSync(join(state.THREADS_DIR, `${name}.sid`), sid + '\n');
}

test('migration carries the default model once for each companion, logs it, and preserves profiles.json', () => {
  for (const companion of ['copilot', 'codex', 'opencode', 'antigravity']) {
    clean();
    const model = companion === 'opencode' ? 'provider/model' : 'gpt-5.4';
    profiles({ defaultProfile: 'selected', profiles: [{ id: 'selected', companion, model }] });
    const source = readFileSync(profilesFile, 'utf8');
    const events = [];
    state.migrateLegacyState({ env: {}, log: (...args) => events.push(args) });
    assert.equal(state.readDefaultModel(companion, {}).model, model);
    assert.ok(events.some((e) => e.join(' ').includes(`carried default model to ${companion}`)));
    assert.equal(readFileSync(profilesFile, 'utf8'), source);
    state.clearDefaultModel(companion);
    profiles({ defaultProfile: 'later', profiles: [{ id: 'later', companion, model: 'different' }] });
    state.migrateLegacyState({ env: {}, log: () => assert.fail('must not re-read profiles or repeat migration') });
    assert.equal(state.readDefaultModel(companion, {}).model, null, 'file is never read again');
  }
});

test('migration preserves configured model defaults, including environment overrides', () => {
  for (const companion of ['copilot', 'codex', 'opencode', 'antigravity']) {
    clean();
    state.writeDefaultModel('existing', companion);
    profiles({ defaultProfile: 'old', profiles: [{ id: 'old', companion, model: 'legacy' }] });
    state.migrateLegacyState({ env: {} });
    assert.equal(state.readDefaultModel(companion, {}).model, 'existing');
  }
  for (const companion of ['codex', 'opencode']) {
    clean();
    profiles({ defaultProfile: 'old', profiles: [{ id: 'old', companion, model: 'legacy' }] });
    state.migrateLegacyState({ env: { [`AGENT_COMPANION_${companion.toUpperCase()}_MODEL`]: 'configured' } });
    assert.equal(state.readDefaultModel(companion, {}).model, null, 'env setting prevents carry-over');
  }
});

test('missing, invalid and model-free legacy defaults are one-shot no-ops', () => {
  for (const doc of [null, '{bad json', '{}', JSON.stringify({ defaultProfile: 'missing', profiles: [null] }),
    JSON.stringify({ defaultProfile: 'old', profiles: [{ id: 'old', companion: 'codex' }] })]) {
    clean();
    if (doc !== null) writeFileSync(profilesFile, doc);
    state.migrateLegacyState({ env: {} });
    assert.equal(state.readDefaultModel('codex', {}).model, null);
    assert.ok(existsSync(join(state.BASE_DIR, 'phase1-migrated')));
    if (doc !== null) assert.equal(readFileSync(profilesFile, 'utf8'), doc);
  }
});

test('a single legacy session is retained, including ledger-only history, without rewriting jobs', () => {
  history('single__review', 'session-one');
  history('plain', 'plain-session');
  const old = { jobId: 'older', thread: 'ledger-only', profileId: 'one', target: 'codex', companionSessionId: 'old', startedAt: 1 };
  state.writeJob('older', old);
  const newest = { ...old, jobId: 'newer', companionSessionId: 'current', startedAt: 2, status: 'running' };
  state.writeJob('newer', newest);
  state.migrateLegacyState({ env: {} });
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
  state.migrateLegacyState({ env: {} });
  assert.equal(state.readThreadSid('named'), 'session-one');
  assert.throws(() => state.readThreadSid('conflict'), /review__custom/);
  const records = JSON.parse(readFileSync(join(state.THREADS_DIR, 'conflict.ambiguous'), 'utf8'));
  assert.deepEqual(records.map((r) => r.sid).sort(), ['session-three', 'session-two']);
});

test('conflicting legacy histories refuse follow-up explicitly and never start a new conversation', async () => {
  history('conflict__review', 'session-review');
  history('conflict__fast', 'session-fast');
  state.migrateLegacyState({ env: {} });
  const prior = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'migration-conflict';
  const controller = createBridgeController({ providers: Object.fromEntries(['copilot', 'codex', 'opencode', 'antigravity'].map((id) => [id, { enabled: true, ready: true, create: () => assert.fail('ambiguous thread must not start a runtime') }])) });
  try {
    for (const target of ['copilot', 'codex', 'opencode', 'antigravity']) {
      const response = (await dispatch({ action: 'send', target, task: 'continue', cwd: tmpdir(), thread: 'conflict' }, { controller })).structuredContent;
      assert.equal(response.ok, false);
      assert.equal(response.status, 'thread_ambiguous');
      assert.match(response.error, /conflict__review\.sid/);
      assert.match(response.error, /conflict__fast\.sid/);
    }
    assert.equal(jobs.size, 0);
    assert.throws(() => state.writeThreadSid('conflict', 'silent-replacement'), /ambiguous/);
  } finally {
    resetDaemon();
    if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prior;
  }
});

test('a hydrated legacy running job keeps its fields until terminal, then drops conversational policy fields', async () => {
  const legacy = { jobId: 'legacy-running', claudeSessionId: 'legacy-host', target: 'copilot', status: 'running',
    thread: 'legacy-thread', companionSessionId: 'legacy-session', promptId: 'legacy-prompt', startedAt: Date.now(),
    task: 'old task', cwd: tmpdir(), model: 'gpt-5.4', mode: 'ANALYZE', template: 'review', template_args: {},
    profileId: 'old-profile', strength: 'reviewer', parallelStrategy: 'always', fleet: true, verdict: null, verdictReason: 'missing' };
  state.writeJob(legacy.jobId, legacy);
  state.migrateLegacyState({ env: {} });
  const priorSid = process.env.CLAUDE_CODE_SESSION_ID;
  const priorAdapter = process.env.COPILOT_RUNTIME_ADAPTER;
  process.env.CLAUDE_CODE_SESSION_ID = 'legacy-host';
  process.env.COPILOT_RUNTIME_ADAPTER = 'acp';
  let finish;
  setDaemon({ sendToSocket: async (msg) => {
    assert.equal(msg.command, 'watch');
    return new Promise((resolve) => { finish = resolve; });
  } });
  try {
    hydrateJobsFromLedger();
    assert.deepEqual(state.readJob(legacy.jobId), legacy);
    assert.equal(jobs.get(legacy.jobId).profileId, 'old-profile');
    assert.equal(typeof finish, 'function');
    const answer = 'VERDICT: agree\nRUBBER-DUCK: clean.';
    finish({ ok: true, data: { status: 'completed', summary: { message: answer, toolCalls: [] } } });
    await until(() => jobs.get(legacy.jobId)?.terminalAt, 'legacy watcher completion');
    const terminal = readFileSync(queuePath(), 'utf8').trim().split('\n').map(JSON.parse).findLast((e) => e.jobId === legacy.jobId);
    assert.equal(terminal.meta.status, 'completed');
    assert.ok(terminal.content.includes(answer));
    for (const field of ['mode', 'template', 'template_args', 'profileId', 'strength', 'parallelStrategy', 'fleet', 'verdict', 'verdictReason']) {
      assert.equal(Object.hasOwn(state.readJob(legacy.jobId), field), false, field);
      assert.equal(Object.hasOwn(terminal.meta, field), false, field);
    }
    assert.doesNotMatch(terminal.content, /_Verdict:|_Rubber-duck:/);
  } finally {
    resetDaemon();
    if (priorSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = priorSid;
    if (priorAdapter === undefined) delete process.env.COPILOT_RUNTIME_ADAPTER; else process.env.COPILOT_RUNTIME_ADAPTER = priorAdapter;
    _resetForTest();
  }
});
