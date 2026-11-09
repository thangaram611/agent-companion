import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { validateAgentArgs } from './validation.mjs';
import { callArgs, mcp, resolveRouting, dispatch, getHostSessionId, _resetForTest } from './server.mjs';
import { BASE_DIR, writeTargetChecks, writeDefaultTarget, writeDefaultModel } from '../lib/state.mjs';

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
  assert.deepEqual(Object.keys(send.properties).sort(), ['cwd', 'effort', 'max_wait_sec', 'model', 'target', 'task']);
  assert.deepEqual(send.required.sort(), ['cwd', 'task']);
  const catalog = tools.find((t) => t.name === 'agent_catalog');
  assert.ok(catalog);
  assert.deepEqual(catalog.inputSchema, { type: 'object', additionalProperties: false, properties: {} });
  assert.deepEqual(callArgs('catalog', { arguments: {} }), { action: 'catalog' });
});

test('explicit invalid models are refused for each companion', () => {
  for (const [target, model] of [['copilot', 'unknown-model'], ['opencode', 'missing-provider'], ['codex', 'bad model'], ['antigravity', 'bad model'], ['claude', 'bad model']]) {
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
  const call = (sid) => mcp._requestHandlers.get('tools/call')({ method: 'tools/call', params: {
    name: 'agent_catalog', arguments: {}, _meta: { 'x-codex-turn-metadata': { session_id: sid, thread_id: 'catalog-caller' } },
  } });
  try {
    rmSync(BASE_DIR, { recursive: true, force: true });
    rmSync(process.env.AGENT_RUNTIME_DIR, { recursive: true, force: true });
    const cold = [snapshot(BASE_DIR), snapshot(process.env.AGENT_RUNTIME_DIR)];
    const first = (await call('catalog-owner-a')).structuredContent;
    assert.deepEqual([snapshot(BASE_DIR), snapshot(process.env.AGENT_RUNTIME_DIR)], cold);
    assert.equal(first.targets.length, 5);
    assert.equal(first.targets.find((t) => t.id === 'codex').model.description, "inherits the companion's own configuration");
    assert.equal(first.targets.find((t) => t.id === 'antigravity').model.enumeration, 'not enumerable without a session');
    const claude = first.targets.find((t) => t.id === 'claude');
    assert.equal(claude.model.model, null);
    assert.equal(claude.model.description, 'inherits the Claude Code default; any model id or alias accepted, validated by Claude Code');
    assert.equal(claude.model.enumeration, 'not enumerable without a session');
    assert.deepEqual(claude.capabilities, { reply: false, resume: true, cancel: true, modelSelection: true, effortSelection: true });
    assert.equal(Object.hasOwn(claude, 'contractStatus'), false);
    assert.equal(first.targets[0].readiness.ready, null);

    writeDefaultTarget('codex');
    writeDefaultModel('gpt-5.4', 'codex');
    writeTargetChecks({ claude: { ready: true, version: 'claude cached', checkedAt: '2026-11-09T00:00:00Z' }, codex: { ready: true, version: 'codex-cli cached', checkedAt: '2026-11-05T00:00:00Z' } });
    mkdirSync(join(BASE_DIR, 'jobs'), { recursive: true });
    writeFileSync(join(BASE_DIR, 'jobs', 'legacy-active.json'), JSON.stringify({ jobId: 'legacy-active', claudeSessionId: 'catalog-owner-b', target: 'copilot',
      thread: 'old-thread', companionSessionId: 'old-session', promptId: 'old-prompt', status: 'running', startedAt: Date.now() }));
    mkdirSync(join(BASE_DIR, 'threads'), { recursive: true });
    writeFileSync(join(BASE_DIR, 'threads', 'old-thread.sid'), 'old-session\n');
    mkdirSync(process.env.AGENT_RUNTIME_DIR, { recursive: true });
    for (const name of ['completions.jsonl', 'agent-digest-legacy-active.md', 'acp-daemons.json', 'codex-broker.json']) {
      writeFileSync(join(process.env.AGENT_RUNTIME_DIR, name), `unchanged ${name}\n`);
    }
    const before = [snapshot(BASE_DIR), snapshot(process.env.AGENT_RUNTIME_DIR)];
    const result = (await call('catalog-owner-b')).structuredContent;
    assert.equal(result.targets.find((t) => t.id === 'claude').installed_version, 'claude cached');
    assert.equal(result.targets.find((t) => t.id === 'claude').readiness.ready, true);
    assert.equal(result.default_target.target, 'codex');
    const codex = result.targets.find((t) => t.id === 'codex');
    assert.equal(codex.model.model, 'gpt-5.4');
    assert.equal(codex.installed_version, 'codex-cli cached');
    assert.equal(codex.readiness.checked_at, '2026-11-05T00:00:00Z');
    assert.equal(getHostSessionId(), null, 'no host adoption or ownership conflict from either caller');
    assert.deepEqual([snapshot(BASE_DIR), snapshot(process.env.AGENT_RUNTIME_DIR)], before);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prior;
    _resetForTest();
  }
});

test('catalog reports effort levels and permissions from the execution environment without probing', async () => {
  const { probePermission } = await import('../lib/target-diagnostics.mjs');
  const { getTarget } = await import('../lib/target-registry.mjs');
  const env = { AGENT_COMPANION_CLAUDE_PERMISSION: 'plan', AGENT_COMPANION_DEFAULT_TARGET: 'claude' };
  const catalog = (await dispatch({ action: 'catalog' }, { controller: { env } })).structuredContent;
  assert.equal(catalog.default_target.target, 'claude');
  for (const target of catalog.targets) {
    assert.equal(target.effort.selection, target.id === 'claude');
    assert.deepEqual(target.effort.levels, target.id === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : null);
    assert.equal(typeof target.effort.description, 'string');
    const { mode, source, risk } = probePermission(getTarget(target.id), env);
    assert.deepEqual(target.permission, { mode, source, risk });
  }
});
