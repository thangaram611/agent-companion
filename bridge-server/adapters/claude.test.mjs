import '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import { fakeClaudeBin } from '../../test/fake-claude-stream.mjs';
import { fixtureSupervisor } from '../../test/controller/fixture-table.mjs';
import { ManualClock, until } from '../../test/controller/helpers.mjs';
import { Controller } from '../controller/controller.mjs';
import { Records } from '../controller/records.mjs';
import { bounded } from '../controller/clock.mjs';
import { ClaudeAdapter, claudeTranscriptExists } from './claude.mjs';

function setup(t, { scenario = 'success', env: extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(SANDBOX_HOME, 'claude-adapter-'));
  const env = { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'), CLAUDE_BIN: fakeClaudeBin(dir),
    FAKE_CLAUDE_TRACE: join(dir, 'trace.jsonl'), FAKE_CLAUDE_SCENARIO: scenario, ...extraEnv };
  const adapters = [], supervisors = [];
  const createSupervisor = (options = {}) => {
    const supervisor = fixtureSupervisor(options), spawn = supervisor.spawn.bind(supervisor);
    supervisor.spawn = (argv, opts) => spawn(argv, { ...opts, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    supervisors.push(supervisor);
    return supervisor;
  };
  const create = (options = {}) => {
    const adapter = new ClaudeAdapter({ env, ...options }); adapters.push(adapter); return adapter;
  };
  const launch = async ({ historyId = null, model, ...options } = {}) => {
    const adapter = create(options), supervisor = createSupervisor();
    const started = await adapter.start({ cwd: dir, env, model, historyId, supervisor });
    assert.equal(started.runtime, supervisor.child);
    return { adapter, supervisor };
  };
  t.after(async () => {
    const closing = adapters.map((adapter) => adapter.close());
    await Promise.all(supervisors.map((supervisor) => supervisor.terminate({ graceMs: 0 })));
    await Promise.all(closing);
  });
  const transcript = (id, root = env.CLAUDE_CONFIG_DIR) => {
    const project = join(root, 'projects', 'another-project'); mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${id}.jsonl`), '{}\n');
  };
  const trace = () => { try { return readFileSync(env.FAKE_CLAUDE_TRACE, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  return { dir, env, launch, create, createSupervisor, adapters, supervisors, transcript, trace };
}

test('fresh send and cold follow-up use new processes, saved history, exact text and per-turn usage', async (t) => {
  const h = setup(t), records = new Records({ dir: join(h.dir, 'records'), log: () => {} });
  const controller = new Controller({ env: h.env, records, createSupervisor: h.createSupervisor,
    providers: { claude: { enabled: true, ready: true, modelAllowed: () => true, create: () => h.create() } } });
  t.after(() => { for (const a of controller.live.values()) controller.clock.clearTimeout(a.timer); });
  const send = (text, model) => controller.send({ owner: 'child', provider: 'claude', cwd: h.dir, text, model });
  const first = await send('exact\n  whitespace ');
  assert.equal(first.acknowledged, true);
  const one = await controller.wait({ owner: 'child', executionId: first.executionId });
  const second = await send('follow-up', 'haiku');
  const two = await controller.wait({ owner: 'child', executionId: second.executionId });
  assert.notEqual(h.supervisors[0].child.pid, h.supervisors[1].child.pid);
  assert.equal(one.nativeRefs.historyId, two.nativeRefs.historyId);
  assert.equal(two.outcome, 'completed'); assert.equal(two.text, 'alpha');
  assert.equal(two.effectiveModel, 'claude-haiku-5-5');
  assert.equal(one.stopEvidence.gone, true); assert.equal(two.stopEvidence.gone, true);
  assert.equal(one.usage.cost, 0.00121); assert.equal(Object.hasOwn(two.usage, 'cost'), false);
  assert.equal(one.usage.input_tokens, two.usage.input_tokens);
  const writes = h.trace().filter((frame) => frame.type === 'user');
  assert.deepEqual(writes.map((frame) => frame.message.content), ['exact\n  whitespace ', 'follow-up']);
  assert.equal(writes[0].uuid, one.nativeRefs.nativeTurnId);
  assert.equal(writes[1].uuid, two.nativeRefs.nativeTurnId);
  const argv = h.trace().filter((frame) => frame.type === 'argv').map((frame) => frame.args);
  assert.equal(argv[0].includes('--model'), false);
  assert.deepEqual(argv[1].slice(-4), ['--resume', one.nativeRefs.historyId, '--model', 'haiku']);
});

test('start is silent; init acknowledges delivery without waiting for the three-second replay', async (t) => {
  const h = setup(t, { scenario: 'slow-replay' }), { adapter } = await h.launch();
  assert.equal(adapter.initialized, undefined);
  assert.equal(h.trace().filter((frame) => frame.type === 'user').length, 0);
  const history = await adapter.openHistory({ historyId: null });
  assert.equal(history.historyId, adapter.historyId); assert.equal(history.effectiveModel, undefined);
  const ack = await adapter.deliver({ text: 'slow' });
  assert.ok(ack.nativeTurnId); assert.equal(adapter.initialized, true); assert.equal(adapter.terminal, undefined);
  assert.equal((await adapter.observe()).text, 'alpha');
  await assert.rejects(adapter.deliver({ text: 'never resend' }), { code: 'DeliveryUnknown' });
  assert.equal(h.trace().filter((frame) => frame.type === 'user').length, 1);
});

test('delivery requires both matching init and the write callback', async (t) => {
  const h = setup(t), { adapter } = await h.launch();
  await adapter.openHistory({ historyId: null });
  const write = adapter.runtime.stdin.write.bind(adapter.runtime.stdin);
  let flush, acknowledged = false;
  adapter.runtime.stdin.write = (line, callback) => write(line, (err) => { flush = () => callback(err); });
  const delivering = adapter.deliver({ text: 'flush' }).then((ack) => { acknowledged = true; return ack; });
  await until(() => adapter.initialized && flush, 'init before withheld flush');
  assert.equal(acknowledged, false); flush();
  assert.ok((await delivering).nativeTurnId);
  assert.equal((await adapter.observe()).outcome, 'completed');
});

test('a terminal before observe is retained; close is idempotent and steer is absent', async (t) => {
  const h = setup(t), { adapter } = await h.launch();
  await adapter.openHistory({ historyId: null }); await adapter.deliver({ text: 'early' });
  await until(() => adapter.terminal, 'early result');
  const snapshots = [], terminal = await adapter.observe({ onProgress: (progress) => snapshots.push(progress) });
  assert.equal(terminal.text, 'alpha'); assert.equal(snapshots.at(-1).partialText, 'alpha');
  assert.equal(adapter.steer, undefined);
  assert.deepEqual(adapter.capabilities, { followUp: true, steer: false, modelSelection: true, loadsHistory: true });
  const closing = adapter.close(); assert.equal(adapter.close(), closing); await closing;
  await adapter.close(); await adapter.interrupt();
});

for (const scenario of ['success', 'bash', 'retry', 'malformed', 'stderr-flood', 'auth-error']) {
  test(`native frames: ${scenario}`, async (t) => {
    const h = setup(t, { scenario }), { adapter } = await h.launch();
    await adapter.openHistory({ historyId: null });
    const snapshots = [], observed = adapter.observe({ onProgress: (progress) => snapshots.push(progress) });
    await adapter.deliver({ text: 'one task' });
    const terminal = await observed;
    assert.equal(terminal.outcome, scenario === 'auth-error' ? 'failed' : 'completed');
    assert.equal(terminal.text, scenario === 'auth-error' ? 'Not logged in · Please run /login' : 'alpha');
    assert.equal(terminal.effectiveModel, 'claude-haiku-5-5');
    assert.ok(snapshots.some((progress) => progress.partialText === 'al'));
    assert.ok(snapshots.every((progress) => !/private|nested|wrong/.test(progress.partialText)));
    assert.equal(snapshots.at(-1).activeCommand, null); assert.equal(snapshots.at(-1).retry, null);
    if (scenario === 'bash') {
      const commands = snapshots.map((progress) => progress.activeCommand).filter(Boolean);
      assert.deepEqual(commands.slice(0, 3), ['sleep 8 && echo slept', 'echo second', 'echo second']);
    }
    if (scenario === 'retry') assert.deepEqual(snapshots.find((progress) => progress.retry)?.retry,
      { attempt: 1, max_retries: 3, retry_delay_ms: 25, error: 'busy' });
    if (scenario === 'auth-error') {
      assert.equal(terminal.detail, 'api_error'); assert.equal(terminal.usage.input_tokens, 0); assert.equal(terminal.usage.cost, 0);
    }
  });
}

for (const scenario of ['interrupt', 'interrupt-tools']) {
  test(`control interrupt maps ${scenario} to interrupted and survives exit 1`, async (t) => {
    const h = setup(t, { scenario }), { adapter } = await h.launch();
    await adapter.openHistory({ historyId: null });
    const observed = adapter.observe(); await adapter.deliver({ text: 'long work' });
    await until(() => scenario === 'interrupt' ? adapter.progress.partialText === 'alpha' : adapter.progress.activeCommand, 'active work');
    await adapter.interrupt();
    const terminal = await observed;
    assert.equal(terminal.outcome, 'interrupted'); assert.equal(terminal.text, scenario === 'interrupt' ? 'alpha' : '');
    const controls = h.trace().filter((frame) => frame.type === 'control_request');
    assert.equal(controls.length, 1); assert.deepEqual(controls[0].request, { subtype: 'interrupt' });
    await adapter.close(); await until(() => adapter.runtime.exitCode !== null, 'exit after interrupt');
    assert.equal(adapter.runtime.exitCode, 1); assert.equal(await adapter.observe(), terminal);
  });
}

test('wrong init fails delivery with history_mismatch, without a second write', async (t) => {
  const h = setup(t, { scenario: 'mismatch' }), { adapter } = await h.launch();
  await adapter.openHistory({ historyId: null });
  await assert.rejects(adapter.deliver({ text: 'one' }), { code: 'history_mismatch' });
  assert.equal(h.trace().filter((frame) => frame.type === 'user').length, 1);
});

test('a matching interrupted result before init is retained during startup cleanup', async (t) => {
  const h = setup(t, { scenario: 'interrupt' }), { adapter } = await h.launch();
  await adapter.interrupt();
  const terminal = await adapter.observe();
  assert.equal(terminal.outcome, 'interrupted'); assert.equal(terminal.text, '');
  assert.equal(h.trace().some((frame) => frame.type === 'user'), false);
});

test('missing init times out as DeliveryUnknown, with no resend or late reopening', async (t) => {
  const h = setup(t, { scenario: 'no-init' }), { adapter } = await h.launch();
  const clock = new ManualClock(); await adapter.openHistory({ historyId: null });
  const delivery = bounded(clock, () => adapter.deliver({ text: 'one' }), 10_000, 'DeliveryUnknown');
  const rejected = assert.rejects(delivery, { code: 'DeliveryUnknown' });
  await until(() => h.trace().some((frame) => frame.type === 'user'), 'one user write');
  await clock.advance(10_000); await rejected; await adapter.close();
  assert.equal(h.trace().filter((frame) => frame.type === 'user').length, 1);
});

test('stdout loss without result rejects ProviderLost and retains partial progress', async (t) => {
  const h = setup(t, { scenario: 'stdout-loss' }), { adapter } = await h.launch();
  await adapter.openHistory({ historyId: null });
  const rejected = assert.rejects(adapter.observe(), { code: 'ProviderLost' });
  await adapter.deliver({ text: 'one' }); await rejected;
  assert.equal(adapter.progress.partialText, 'alpha'); await adapter.close();
});

test('an unacknowledged interrupt remains bounded by the controller cleanup budget', async (t) => {
  const h = setup(t, { scenario: 'no-interrupt-ack' }), { adapter } = await h.launch();
  await adapter.openHistory({ historyId: null }); await adapter.deliver({ text: 'one' });
  const clock = new ManualClock(), interrupt = bounded(clock, () => adapter.interrupt(), 500, 'interrupt_timeout');
  const rejected = assert.rejects(interrupt, { code: 'interrupt_timeout' });
  await until(() => h.trace().some((frame) => frame.type === 'control_request'), 'interrupt request');
  await clock.advance(500); await rejected; await adapter.close();
});

test('resume checks transcript presence across projects, including the sandbox HOME fallback', async (t) => {
  const h = setup(t), id = randomUUID();
  assert.equal(claudeTranscriptExists(id, h.env), false); h.transcript(id);
  assert.equal(claudeTranscriptExists(id, h.env), true);
  h.transcript(id, join(h.dir, '.claude'));
  assert.equal(claudeTranscriptExists(id, { HOME: h.dir }), true);
  const { adapter } = await h.launch({ historyId: id });
  assert.deepEqual(await adapter.openHistory({ historyId: id }), { historyId: id });
});

test('missing resume transcript is refused before delivery and check is injectable', async (t) => {
  const h = setup(t), id = randomUUID(), seen = [];
  const { adapter } = await h.launch({ historyId: id, transcriptExists: (historyId, env) => { seen.push([historyId, env.CLAUDE_CONFIG_DIR]); return false; } });
  await assert.rejects(adapter.openHistory({ historyId: id }), { code: 'HistoryUnavailable' });
  assert.deepEqual(seen, [[id, h.env.CLAUDE_CONFIG_DIR]]);
  assert.equal(h.trace().some((frame) => frame.type === 'user'), false);
});

test('early bogus-resume result refuses history and reports history_not_found on attempted delivery', async (t) => {
  const h = setup(t, { scenario: 'bogus-resume' }), id = randomUUID(); h.transcript(id);
  const { adapter } = await h.launch({ historyId: id });
  await until(() => adapter.earlyError, 'early error result');
  await assert.rejects(adapter.openHistory({ historyId: id }), { code: 'HistoryUnavailable' });
  await assert.rejects(adapter.deliver({ text: 'must not send' }), { code: 'history_not_found' });
  assert.equal(h.trace().some((frame) => frame.type === 'user'), false);
});

test('terminal result does not wait for background descendants; supervisor removes the whole tree', async (t) => {
  const h = setup(t, { scenario: 'lingering' }), { adapter, supervisor } = await h.launch();
  await adapter.openHistory({ historyId: null }); await adapter.deliver({ text: 'one' });
  assert.equal((await adapter.observe()).outcome, 'completed');
  assert.ok(supervisor.serialize().processes.length >= 4);
  // Close is acknowledged by the flushed stdin EOF, not by the lingering tree's exit.
  const clock = new ManualClock();
  await bounded(clock, () => adapter.close(), 500, 'close_timeout');
  assert.equal(adapter.runtime.exitCode, null);
  const closing = adapter.close();
  const cleanup = await supervisor.terminate({ graceMs: 0 }); await closing;
  assert.equal(cleanup.gone, true); assert.equal(cleanup.survivors.length, 0);
});

test('missing binary, closed-before-start and failed spawn never launch real Claude', async (t) => {
  const h = setup(t, { env: { CLAUDE_BIN: '/missing-claude-step1', PATH: '' } });
  await assert.rejects(h.launch(), { code: 'RuntimeUnavailable' });
  const adapter = h.create(); await adapter.interrupt(); await adapter.close(); await adapter.close();
  await assert.rejects(adapter.start({ cwd: h.dir, supervisor: h.createSupervisor() }), { code: 'RuntimeUnavailable' });
  const valid = setup(t), failed = valid.create();
  await assert.rejects(failed.start({ cwd: valid.dir, supervisor: { spawn: async () => { throw new Error('spawn failed'); } } }), { code: 'RuntimeUnavailable' });
});

test('PATH lookup uses only the fake binary; fake rejects invalid argv', async (t) => {
  const h = setup(t); fakeClaudeBin(h.dir, 'claude'); h.env.CLAUDE_BIN = ''; h.env.PATH = h.dir;
  const { adapter } = await h.launch(); await adapter.close();
  const bad = spawnSync(join(h.dir, 'claude'), ['--bare'], { env: h.env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /invalid Claude argv/);
});
