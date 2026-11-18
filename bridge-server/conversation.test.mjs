import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { validateAgentArgs } from './validation.mjs';
import { Records } from './controller/records.mjs';
import { callArgs, mcp, resolveRouting, dispatch, getHostSessionId, _resetForTest } from './server.mjs';
import { BASE_DIR, writeTargetChecks, writeDefaultTarget, writeDefaultModel, writeCompanionDefaults } from '../lib/state.mjs';
import { companionHomeDir } from '../lib/host.mjs';
import { getTargetById } from '../lib/target-registry.mjs';

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
  for (const [target, model] of [['copilot', 'bad model'], ['opencode', 'missing-provider'], ['codex', 'bad model'], ['antigravity', 'bad model'], ['claude', 'bad model']]) {
    const result = resolveRouting({ target, model }, {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MODEL_NOT_ALLOWED');
    if (target === 'copilot') assert.equal(result.hint, 'Model ids must contain no whitespace.');
  }
});


function snapshot(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return { mode: stat.mode, mtime: stat.mtimeMs,
    contents: stat.isDirectory() ? Object.fromEntries(readdirSync(path).sort().map((f) => [f, snapshot(join(path, f))]))
      : readFileSync(path).toString('base64') };
}

test('catalog is ownerless, spawns no process and leaves cold and populated state/runtime directories unchanged', async t => {
  _resetForTest();
  const spawns = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(name =>
    t.mock.method(childProcess, name, () => { throw new Error('catalog invoked ' + name); }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
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
    assert.equal(first.targets.find((t) => t.id === 'antigravity').model.enumeration, 'not enumerable without a session');
    const copilot = first.targets.find(t => t.id === 'copilot');
    assert.equal(copilot.model.enumeration, 'not enumerable without a session');
    assert.equal(Object.hasOwn(copilot.model, 'allowed'), false);
    const claude = first.targets.find((t) => t.id === 'claude');
    assert.equal(claude.model.model, null);
    assert.match(claude.model.description, /model id or alias/i);
    assert.equal(claude.model.enumeration, 'not enumerable without a session');
    for (const target of first.targets) {
      for (const field of [target.model, target.effort]) {
        assert.equal(field.saved, null);
        assert.equal(field.last_run, null);
      }
      const capabilities = getTargetById(target.id).capabilities;
      assert.deepEqual(target.capabilities, {
        interventions: capabilities.interventions, resume: capabilities.resume, cancel: capabilities.cancel,
        modelSelection: capabilities.modelSelection, effortSelection: capabilities.effortSelection,
      });
      assert.deepEqual(Object.keys(target.capabilities.interventions).sort(), ['default', 'interrupt', 'queue', 'steer']);
    }
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
    assert.equal(codex.model.saved, 'gpt-5.4');
    assert.equal(codex.model.source, 'config');
    assert.equal(codex.installed_version, 'codex-cli cached');
    assert.equal(codex.readiness.checked_at, '2026-11-05T00:00:00Z');
    assert.equal(getHostSessionId(), null, 'no host adoption or ownership conflict from either caller');
    assert.deepEqual([snapshot(BASE_DIR), snapshot(process.env.AGENT_RUNTIME_DIR)], before);
    assert.ok(spawns.every(spawn => spawn.mock.callCount() === 0));
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
    assert.equal(target.effort.selection, true);
    if (['codex', 'opencode', 'antigravity', 'copilot'].includes(target.id)) assert.match(target.effort.description, /[Ll]evels depend on the model and are checked at send/);
    const native = {
      codex: /~\/\.codex\/config\.toml.*trusted project.*\.codex\/config\.toml/i,
      opencode: /configured default model/i,
      claude: /Claude Code account default/i,
      copilot: /account's default/i,
      antigravity: /account's default/i,
    }[target.id];
    for (const field of [target.model, target.effort]) {
      assert.match(field.description, /omitted.*saved default/i);
      assert.match(field.description, native);
    }
    assert.match(target.effort.description, /follow-up keeps.*effort/i);
    assert.deepEqual(target.effort.levels, target.id === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : null);
    assert.equal(typeof target.effort.description, 'string');
    const { mode, source, risk } = probePermission(getTarget(target.id), env);
    assert.deepEqual(target.permission, { mode, source, risk });
  }
});

test('catalog reads saved defaults and each last reported field across hosts, skipping unreadable records', async t => {
  const env = { HOME: join(BASE_DIR, 'catalog-home'), CODEX_HOME: join(BASE_DIR, 'custom-codex'),
    AGENT_COMPANION_CODEX_MODEL: 'env-model' };
  writeCompanionDefaults('codex', { model: 'saved-model', effort: 'medium' }, env);
  const now = Date.UTC(2026, 10, 18);
  t.mock.method(Date, 'now', () => now);
  function record(host, provider, age, values) {
    const dir = join(companionHomeDir(host, env), 'executions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, provider + '-' + age + '.json'), JSON.stringify({ provider, startedAt: now - age, ...values }));
  }
  for (const id of ['codex', 'opencode', 'copilot', 'antigravity', 'claude']) {
    record('codex', id, 3000, { effectiveModel: 'old', progress: { effectiveEffort: id === 'claude' ? null : 'high' } });
    // OpenCode reports its model as an object, named as every view names it.
    record('claude', id, 2000, { effectiveModel: 'initial', progress: { effectiveModel: 'working' },
      terminal: { effectiveModel: id === 'opencode' ? { source: 'selected', providerID: 'opencode', id: 'opencode-reported', variant: 'default' } : id + '-reported' } });
    record('codex', id, 1000, { modelOverride: 'selected-only', effortOverride: 'selected-only' });
  }
  const dir = join(companionHomeDir('codex', env), 'executions');
  writeFileSync(join(dir, 'broken.json'), '{');
  record('codex', 'codex', 0, { effectiveModel: 'inaccessible' });
  const readExecution = Records.prototype.readExecution;
  t.mock.method(Records.prototype, 'readExecution', function(id) {
    if (id === 'codex-0') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return readExecution.call(this, id);
  });
  const before = snapshot(BASE_DIR);
  const catalog = (await dispatch({ action: 'catalog' }, { controller: { env } })).structuredContent;
  assert.equal(catalog.targets.length, 5);
  for (const { id, model, effort } of catalog.targets) {
    assert.deepEqual(model.last_run, { value: (id === 'opencode' ? 'opencode/' : '') + id + '-reported', at: new Date(now - 2000).toISOString(), age_ms: 2000, host: 'claude' });
    assert.deepEqual(effort.last_run, id === 'claude' ? null
      : { value: 'high', at: new Date(now - 3000).toISOString(), age_ms: 3000, host: 'codex' });
  }
  const codex = catalog.targets.find(t => t.id === 'codex');
  assert.equal(codex.model.saved, 'saved-model');
  assert.equal(codex.model.model, 'env-model');
  assert.equal(codex.model.source, 'env');
  assert.equal(codex.effort.saved, 'medium');
  assert.deepEqual(snapshot(BASE_DIR), before);
});
