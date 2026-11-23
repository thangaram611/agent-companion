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
import { waitForResult, ManualClock, until } from '../../test/controller/helpers.mjs';
import { Controller } from '../controller/controller.mjs';
import { Records } from '../controller/records.mjs';
import { bounded } from '../controller/clock.mjs';
import { ClaudeAdapter, claudeTranscriptExists } from './claude.mjs';
import { getCompanionById } from '../../lib/companion-registry.mjs';

for (const scenario of ['errors-only', 'early-error']) test(`Claude failure explanation survives ${scenario}`, async t => {
  const h = setup(t, { scenario });
  const controller = new Controller({ env: h.env, records: new Records({ dir: join(h.dir, 'records') }), createSupervisor: h.createSupervisor,
    providers: { claude: { enabled: true, ready: true, create: () => h.create() } } });
  t.after(() => { for (const a of controller.live.values()) clearTimeout(a.timer); });
  const sent = await controller.send({ thread: 'child', companion: 'claude', cwd: h.dir, text: 'hello' });
  const result = sent.outcome ? sent : await controller.wait({ thread: 'child', jobId: sent.jobId });
  assert.equal(result.outcome, scenario === 'early-error' ? 'delivery_unknown' : 'failed');
  assert.equal(result.text, scenario === 'early-error' ? 'Provider unavailable before init' : 'alpha\n\nProvider overloaded Try again later');
  assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
});

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
  const send = (text, model, effort) => controller.send({ thread: 'child', companion: 'claude', cwd: h.dir, text, model, effort });
  const first = await send('exact\n  whitespace ');
  assert.equal(first.acknowledged, true);
  const one = await controller.wait({ thread: 'child', jobId: first.jobId });
  const second = await send('follow-up', 'haiku', 'low');
  assert.equal(second.selectedEffort, 'low');
  assert.equal(second.effectiveModel, 'claude-haiku-5-5');
  assert.equal(second.effectiveEffort, null);
  const two = await controller.wait({ thread: 'child', jobId: second.jobId });
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
  assert.deepEqual(argv[1].slice(-6), ['--resume', one.nativeRefs.historyId, '--model', 'haiku', '--effort', 'low']);
  assert.equal(argv[0].includes('--effort'), false);
  assert.equal(two.selectedEffort, 'low');
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
  assert.deepEqual(adapter.capabilities, { followUp: true, modelSelection: true, loadsHistory: true,
    interventions: getCompanionById('claude').capabilities.interventions });
  assert.equal(adapter.capabilities.interventions, getCompanionById('claude').capabilities.interventions);
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
    assert.equal(terminal.text, scenario === 'auth-error' ? 'alpha\n\nNot logged in · Please run /login' : 'alpha');
    assert.equal(terminal.effectiveModel, 'claude-haiku-5-5');
    assert.ok(snapshots.some((progress) => progress.partialText === 'al' && progress.activity === 'responding'));
    assert.ok(snapshots.some((progress) => progress.activity === 'thinking'));
    assert.equal(snapshots.at(-1).activity, null);
    assert.doesNotMatch(JSON.stringify(snapshots), /private|nested|wrong/);
    assert.ok(snapshots.every((progress) => !/private|nested|wrong/.test(progress.partialText)));
    assert.equal(snapshots.at(-1).activeCommand, null); assert.equal(snapshots.at(-1).retry, null);
    if (scenario === 'bash') {
      const commands = snapshots.map((progress) => progress.activeCommand).filter(Boolean);
      assert.ok(snapshots.filter((p) => p.activeCommand).every((p) => p.activity === `running ${p.activeCommand}`));
      assert.deepEqual(commands.slice(0, 3), ['sleep 8 && echo slept', 'echo second', 'echo second']);
    }
    if (scenario === 'retry') assert.equal(snapshots.find((p) => p.retry)?.activity, 'retrying');
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
  await assert.rejects(adapter.openHistory({ historyId: id }), { code: 'HistoryUnavailable', cause: new Error(`No conversation found with session ID: ${id}`) });
  await assert.rejects(adapter.deliver({ text: 'must not send' }), { code: 'history_not_found', cause: new Error(`No conversation found with session ID: ${id}`) });
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

test('thinking counters and deltas set activity without retaining thinking content', () => {
  const adapter = new ClaudeAdapter({ env: {} });
  adapter.historyId = 's';
  const send = (frame) => adapter._message({ session_id: 's', parent_tool_use_id: null, ...frame });
  send({ type: 'system', subtype: 'thinking_tokens', thinking_tokens: 7 });
  assert.equal(adapter.progress.activity, 'thinking');
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } } });
  assert.equal(adapter.progress.activity, 'responding');
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private thought' } } });
  assert.equal(adapter.progress.activity, 'thinking');
  assert.doesNotMatch(JSON.stringify(adapter.progress), /private thought/);
});

const measured = JSON.parse(readFileSync(new URL('../../test/fixtures/interventions/claude.json', import.meta.url), 'utf8'));
function measuredAdapter() {
  const adapter = new ClaudeAdapter({ env: {} }), writes = [], states = [];
  adapter.historyId = 'session'; adapter.nativeTurnId = 'task'; adapter.runtime = {};
  adapter._write = async frame => {
    writes.push(frame);
    if (frame.type === 'control_request') adapter._message({ type: 'control_response',
      response: { subtype: 'success', request_id: frame.request_id, response: { still_queued: ['message'], send_now: 'stopped' } } });
  };
  adapter.observe({ onInput: value => states.push(value) });
  return { adapter, writes, states };
}

// The m1 frames were recorded with no priority, which joins at the next tool boundary exactly as `next` does (2.1.330).
test('m1 tool-time steer joins the answer; lifecycle completion before result is retained', async () => {
  const { adapter, writes, states } = measuredAdapter();
  await adapter.intervene({ id: 'message', mode: 'steer', text: 'B verbatim\nnext line' });
  for (const frame of measured.tool) adapter._message(frame);
  const result = await adapter.observe();
  assert.equal(result.outcome, 'completed'); assert.deepEqual(result.messages, ['task', 'message']);
  assert.equal(await adapter.hasPendingInput(), false);
  assert.deepEqual(writes, [{ type: 'user', uuid: 'message', session_id: 'session',
    message: { role: 'user', content: 'B verbatim\nnext line' }, parent_tool_use_id: null, priority: 'next' }]);
  assert.ok(states.some(s => s.id === 'message' && s.state === 'joined'));
});

for (const buffered of [false, true]) test(`m1 final-text queue becomes the next turn, buffered=${buffered}`, async () => {
  const { adapter, writes } = measuredAdapter();
  await adapter.intervene({ id: 'message', mode: 'queue', text: 'B' });
  assert.equal(writes[0].priority, 'later');
  const boundary = measured.stream.findIndex(frame => frame.type === 'result');
  for (const frame of measured.stream.slice(0, boundary + 1)) adapter._message(frame);
  assert.equal(await adapter.hasPendingInput(), true);
  if (buffered) for (const frame of measured.stream.slice(boundary + 1)) adapter._message(frame);
  const first = await adapter.observe(); assert.deepEqual(first.messages, ['task']);
  assert.equal(await adapter.hasPendingInput(), true);
  const second = adapter.observe({ next: true });
  if (!buffered) {
    const tail = measured.stream.slice(boundary + 1);
    for (const frame of tail.slice(0, -1)) adapter._message(frame);
    let settled = false;
    const drained = adapter.hasPendingInput().then(value => { settled = true; return value; });
    await Promise.resolve(); assert.equal(settled, false, 'result alone does not complete the UUID lifecycle');
    adapter._message(tail.at(-1)); assert.equal(await drained, false);
  }
  assert.deepEqual((await second).messages, ['message']);
  assert.equal((await second).nativeTurnId, 'message');
  assert.equal(await adapter.hasPendingInput(), false);
});

for (const scenario of ['now', 'now-tool']) test(`m1 ${scenario}: message precedes send_now and gets its own answer`, async () => {
  const { adapter, writes } = measuredAdapter();
  await adapter.intervene({ id: 'message', mode: 'interrupt', text: 'ONLY-NEW' });
  assert.equal(writes[0].type, 'user'); assert.equal(writes[0].message.content, 'ONLY-NEW'); assert.equal(writes[0].priority, undefined);
  assert.deepEqual(writes[1].request, { subtype: 'interrupt', send_now: true, message_uuid: 'message' });
  for (const frame of measured[scenario]) adapter._message(frame);
  const first = await adapter.observe();
  assert.equal(first.outcome, 'interrupted'); assert.deepEqual(first.messages, ['task']);
  assert.equal(await adapter.hasPendingInput(), true);
  const second = await adapter.observe({ next: true });
  assert.equal(second.outcome, 'completed'); assert.deepEqual(second.messages, ['message']);
  assert.equal(await adapter.hasPendingInput(), false);
});

test('m1 cancellation drains pending input and reports not_delivered', async () => {
  const { adapter, states } = measuredAdapter();
  await adapter.intervene({ id: 'message', mode: 'queue', text: 'B' });
  for (const frame of measured.cancel) adapter._message(frame);
  assert.equal((await adapter.observe()).outcome, 'completed');
  assert.equal(await adapter.hasPendingInput(), false);
  assert.ok(states.some(s => s.id === 'message' && s.state === 'not_delivered'));
});

for (const scenario of ['tool', 'stream', 'now', 'now-tool']) test(`controller with m1 ${scenario} frames publishes one attributed result`, async t => {
  const { adapter } = measuredAdapter();
  const dir = mkdtempSync(join(SANDBOX_HOME, 'claude-turns-')), records = new Records({ dir });
  adapter.start = async () => {};
  adapter.openHistory = async () => ({ historyId: 'session' });
  adapter.deliver = async ({ messageId }) => { adapter.nativeTurnId = messageId; return { nativeTurnId: messageId }; };
  adapter.close = async () => {};
  const controller = new Controller({ records, env: {}, snapshot: async () => ({ available: false, reason: 'test' }),
    providers: { claude: { enabled: true, ready: true, create: () => adapter } },
    createSupervisor: () => ({ terminate: async () => ({ gone: true }) }) });
  t.after(() => { for (const a of controller.live.values()) clearTimeout(a.timer); });
  const { jobId } = await controller.send({ thread: 'child', companion: 'claude', cwd: dir, text: 'task' });
  await controller.intervene({ jobId, from: 'user', mode: scenario.startsWith('now') ? 'interrupt' : scenario === 'tool' ? 'steer' : 'queue', text: 'B' });
  const [input] = records.readJob(jobId).interventions;
  const id = uuid => uuid === 'task' ? jobId : uuid === 'message' ? input.id : uuid;
  // Both results can be in the same stdout chunk, before the loop resumes.
  // Measured on 2.1.325: usage is per turn, total_cost_usd is cumulative.
  const usage = [{ total_cost_usd: 0.00004, usage: { input_tokens: 200, output_tokens: 40 } }, { total_cost_usd: 0.00006, usage: { input_tokens: 100, output_tokens: 20 } }];
  let results = 0;
  for (const frame of measured[scenario]) adapter._message({ ...frame, ...(frame.type === 'result' ? usage[results++] : {}),
    ...(frame.command_uuid ? { command_uuid: id(frame.command_uuid) } : {}),
    ...(frame.user_message_uuids ? { user_message_uuids: frame.user_message_uuids.map(id) } : {}) });
  const result = await waitForResult(controller, { thread: 'child', jobId });
  assert.equal(result.outcome, 'completed'); assert.equal(result.turns.length, scenario === 'tool' ? 1 : 2);
  assert.deepEqual(result.nativeTurnIds, scenario === 'tool' ? [jobId] : [jobId, input.id]);
  assert.equal(result.interventions[0].state, 'answered');
  if (result.turns.length > 1) {
    assert.match(result.text, /^Task\n/); assert.match(result.text, /User's message/);
    assert.ok(Math.abs(result.turns[1].usage.cost - 0.00002) < 1e-12, 'second turn reports only its own cost');
    assert.ok(Math.abs(result.usage.cost - 0.00006) < 1e-12); assert.equal(result.usage.input_tokens, 300);
  } else assert.doesNotMatch(result.text, /Task/);
  assert.deepEqual(result.turns.at(-1).messages, scenario === 'tool' ? [jobId, input.id] : [input.id]);
  if (scenario.startsWith('now')) assert.equal(result.turns[0].text, 'interrupted before answering');
});
