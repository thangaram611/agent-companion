import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { validateAgentArgs } from './validation.mjs';
import { callArgs, mcp, resolveRouting, dispatch, jobs, getHostSessionId, _resetForTest } from './server.mjs';
import { BASE_DIR, writeJob, writeTargetChecks, writeDefaultTarget, writeDefaultModel } from '../lib/state.mjs';
import { _setForTest, _resetForTest as resetDaemon } from './daemon-client.mjs';

test('conversational send accepts exact text and an explicit model, with no framing fields', () => {
  const task = '  Compare these lines.\n\nKeep the trailing whitespace.  \n';
  const args = validateAgentArgs({ action: 'send', task, cwd: tmpdir(), model: 'gpt-5.4' });
  assert.equal(args.task, task);
  assert.equal(args.model, 'gpt-5.4');
  for (const key of ['template', 'template_args', 'mode', 'parallel', 'strength', 'profile']) {
    assert.equal(Object.hasOwn(args, key), false);
    assert.throws(() => validateAgentArgs({ action: 'send', task, cwd: tmpdir(), [key]: 'old' }), /unknown field/);
  }
});

test('registered send and catalog expose only conversational inputs', async () => {
  const { tools } = await mcp._requestHandlers.get('tools/list')({ method: 'tools/list', params: {} });
  const send = tools.find((t) => t.name === 'agent_send').inputSchema;
  assert.deepEqual(Object.keys(send.properties).sort(), ['cwd', 'max_wait_sec', 'model', 'target', 'task']);
  assert.deepEqual(send.required.sort(), ['cwd', 'task']);
  const catalog = tools.find((t) => t.name === 'agent_catalog');
  assert.ok(catalog);
  assert.deepEqual(catalog.inputSchema, { type: 'object', additionalProperties: false, properties: {} });
  assert.deepEqual(callArgs('catalog', { arguments: {} }), { action: 'catalog' });
});

test('explicit invalid models are refused for each companion', () => {
  for (const [target, model] of [['copilot', 'unknown-model'], ['opencode', 'missing-provider'], ['codex', 'bad model'], ['antigravity', 'bad model']]) {
    const result = resolveRouting({ target, model }, {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MODEL_NOT_ALLOWED');
  }
});


function snapshot(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return { mode: stat.mode, mtime: stat.mtimeMs,
    contents: stat.isDirectory() ? Object.fromEntries(readdirSync(path).sort().map((f) => [f, snapshot(join(path, f))]))
      : readFileSync(path).toString('base64') };
}

test('catalog is ownerless and leaves cold and populated state/runtime directories unchanged', async () => {
  _resetForTest();
  const prior = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  let runtimeCalls = 0;
  _setForTest({ ensureDaemon: async () => { runtimeCalls++; }, sendToSocket: async () => { runtimeCalls++; throw new Error('catalog contacted runtime'); } });
  const call = (sid) => mcp._requestHandlers.get('tools/call')({ method: 'tools/call', params: {
    name: 'agent_catalog', arguments: {}, _meta: { 'x-codex-turn-metadata': { session_id: sid, thread_id: 'catalog-caller' } },
  } });
  try {
    rmSync(BASE_DIR, { recursive: true, force: true });
    rmSync(process.env.AGENT_RUNTIME_DIR, { recursive: true, force: true });
    const cold = [snapshot(BASE_DIR), snapshot(process.env.AGENT_RUNTIME_DIR)];
    const first = (await call('catalog-owner-a')).structuredContent;
    assert.deepEqual([snapshot(BASE_DIR), snapshot(process.env.AGENT_RUNTIME_DIR)], cold);
    assert.equal(first.targets.length, 4);
    assert.equal(first.targets.find((t) => t.id === 'codex').model.description, "inherits the companion's own configuration");
    assert.equal(first.targets.find((t) => t.id === 'antigravity').model.enumeration, 'not enumerable without a session');
    assert.equal(first.targets[0].readiness.ready, null);

    writeDefaultTarget('codex');
    writeDefaultModel('gpt-5.4', 'codex');
    writeTargetChecks({ codex: { ready: true, version: 'codex-cli cached', checkedAt: '2026-11-05T00:00:00Z' } });
    writeJob('legacy-active', { jobId: 'legacy-active', claudeSessionId: 'catalog-owner-b', target: 'copilot',
      thread: 'old-thread', companionSessionId: 'old-session', promptId: 'old-prompt', status: 'running', startedAt: Date.now() });
    mkdirSync(join(BASE_DIR, 'threads'), { recursive: true });
    writeFileSync(join(BASE_DIR, 'threads', 'old-thread.sid'), 'old-session\n');
    mkdirSync(process.env.AGENT_RUNTIME_DIR, { recursive: true });
    for (const name of ['completions.jsonl', 'agent-digest-legacy-active.md', 'acp-daemons.json', 'codex-broker.json']) {
      writeFileSync(join(process.env.AGENT_RUNTIME_DIR, name), `unchanged ${name}\n`);
    }
    const before = [snapshot(BASE_DIR), snapshot(process.env.AGENT_RUNTIME_DIR)];
    const count = jobs.size;
    const result = (await call('catalog-owner-b')).structuredContent;
    assert.equal(result.default_target.target, 'codex');
    const codex = result.targets.find((t) => t.id === 'codex');
    assert.equal(codex.model.model, 'gpt-5.4');
    assert.equal(codex.installed_version, 'codex-cli cached');
    assert.equal(codex.readiness.checked_at, '2026-11-05T00:00:00Z');
    assert.equal(getHostSessionId(), null, 'no host adoption or ownership conflict from either caller');
    assert.equal(jobs.size, count, 'no ledger hydration');
    assert.equal(runtimeCalls, 0, 'no runtime spawn, socket call or session creation');
    assert.deepEqual([snapshot(BASE_DIR), snapshot(process.env.AGENT_RUNTIME_DIR)], before);
  } finally {
    resetDaemon();
    if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prior;
    _resetForTest();
  }
});
