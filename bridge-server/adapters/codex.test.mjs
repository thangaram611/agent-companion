import '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import { fakeCodexBin } from '../../test/fake-codex-app-server.mjs';
import { note, driftNote, threadItem } from '../../test/codex-wire-frames.mjs';
import { ManualClock, until } from '../../test/controller/helpers.mjs';
import { fixtureSupervisor } from '../../test/controller/fixture-table.mjs';
import { Controller } from '../controller/controller.mjs';
import { Records } from '../controller/records.mjs';
import { inspectCodexAppServerInstallation } from '../../lib/codex-install.mjs';
import { codexAppServerContract, CODEX_PINNED_VERSION } from '../../lib/codex-app-server-contract.mjs';
import { writeTargetChecks } from '../../lib/state.mjs';
import { CodexAdapter, codexProvider } from './codex.mjs';

const treeFile = fileURLToPath(new URL('../../test/controller/process-tree.mjs', import.meta.url));
const terminal = (status = 'completed', text = 'answer', turnId = 'TURN1') => note('turn/completed', {
  threadId: 'T1', turn: { id: turnId, status, items: [threadItem('agentMessage', { id: 'answer', text, phase: 'final_answer' })] },
});

function setup(t, { fault = '', tree = false, env: extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(SANDBOX_HOME, 'codex-adapter-'));
  const bin = fakeCodexBin(dir);
  writeFileSync(join(dir, 'codex-code-mode-host'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  // Extend the shared, contract-validating fake only with fault injection and
  // durable history. Its normal request handlers and framing remain in use.
  appendFileSync(bin, `
import { existsSync, writeFileSync } from 'node:fs';
import { fork } from 'node:child_process';
let current, held;
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (line) => {
  const frame = JSON.parse(String(line));
  if (current && frame.id === current.id && frame.result) {
    if (current.method.startsWith('thread/')) {
      frame.result.model = current.params.model ?? 'configured-model';
      frame.result.reasoningEffort = 'high';
      if (current.method === 'thread/start') writeFileSync(process.env.CODEX_TEST_HISTORY, frame.result.thread.id);
    }
    if (current.method === 'turn/start') {
      if (process.env.CODEX_TEST_TURN_EFFORT) frame.result.reasoningEffort = process.env.CODEX_TEST_TURN_EFFORT;
      if (process.env.CODEX_TEST_FAULT === 'early') out(${JSON.stringify(terminal())});
      if (['lost', 'late'].includes(process.env.CODEX_TEST_FAULT)) { held = frame; return true; }
      if (process.env.CODEX_TEST_FAULT === 'missing-id') frame.result = { turn: {} };
    }
  }
  return originalWrite(JSON.stringify(frame) + '\\n');
};
const originalHandle = handle;
handle = (msg) => {
  const fail = (message) => { trace(msg); out({ id: msg.id, error: { code: -32600, message } }); };
  if (msg.method === 'initialize' && process.env.CODEX_TEST_FAULT === 'startup') return fail('startup refused');
  if (msg.method === 'thread/resume' && !existsSync(process.env.CODEX_TEST_HISTORY)) return fail('no rollout found for thread id ' + msg.params.threadId);
  if (msg.method === 'turn/interrupt' && process.env.CODEX_TEST_FAULT === 'no-active') return fail('no active turn to interrupt');
  if (msg.method === 'turn/interrupt' && process.env.CODEX_TEST_FAULT === 'wrong-turn') return fail('expected active turn id TURN1 but found TURN2');
  if (msg.method === 'turn/interrupt' && process.env.CODEX_TEST_FAULT === 'late' && held) {
    trace({ method: 'fake/lateAck' }); out(held); held = null;
  }
  current = msg;
  originalHandle(msg);
  current = null;
  if (msg.method === 'turn/interrupt' && process.env.CODEX_TEST_FAULT === 'interrupt') out(${JSON.stringify(terminal('interrupted', 'partial'))});
};
if (process.argv[2] === 'app-server') {
  const row = { pid: process.pid, ppid: process.ppid, pgid: process.pid, birthTime: process.pid + ':' + performance.timeOrigin };
  if (process.env.CODEX_TEST_TREE === 'yes') {
    const worker = fork(${JSON.stringify(treeFile)}, ['root', 'ignore'], { detached: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
    worker.on('message', (message) => process.send({ commandPid: worker.pid, rows: [row, ...message.rows] }));
  } else process.send({ rows: [row] });
  process.stdin.on('end', () => { if (process.connected) process.disconnect(); });
}
`);
  const env = { ...process.env, HOME: dir, CODEX_HOME: join(dir, 'home'), CODEX_BIN: bin,
    AGENT_COMPANION_CODEX_SANDBOX_MODE: 'workspace-write', AGENT_COMPANION_CODEX_NETWORK: 'on',
    AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: '5000', CODEX_FAKE_INIT_DELAY_MS: '0',
    CODEX_FAKE_TRACE: join(dir, 'trace.jsonl'), CODEX_TEST_HISTORY: join(dir, 'history'),
    CODEX_TEST_FAULT: fault, CODEX_TEST_TREE: tree ? 'yes' : 'no', ...extraEnv };
  const records = new Records({ dir: join(dir, 'records'), log: () => {} });
  const clock = new ManualClock();
  const adapters = [], supervisors = [], controls = [];
  const createSupervisor = (opts) => {
    // The real supervisor and real processes; only ps is replaced by the
    // existing IPC identity fixture because the execution sandbox denies ps.
    const supervisor = fixtureSupervisor(opts);
    const spawn = supervisor.spawn.bind(supervisor);
    supervisor.spawn = async (argv, options) => {
      const child = await spawn(argv, { ...options, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      let serial = 0;
      const pending = new Map();
      createInterface({ input: child.stdout }).on('line', (line) => {
        const msg = JSON.parse(line), waiter = pending.get(msg.id);
        if (waiter) { pending.delete(msg.id); msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result); }
      });
      controls.push((method, params = {}) => new Promise((resolve, reject) => {
        const id = 'test-' + (++serial);
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      }));
      return child;
    };
    supervisor.reported = [];
    const recordDescendant = supervisor.recordDescendant.bind(supervisor);
    supervisor.recordDescendant = (pid) => { supervisor.reported.push(pid); return recordDescendant(pid); };
    supervisors.push(supervisor);
    return supervisor;
  };
  const create = () => {
    const adapter = new CodexAdapter({ env, clock, inspectInstallation: ({ env }) => inspectCodexAppServerInstallation({
      env, platform: 'linux', run: () => ({ ok: true, output: 'codex-cli ' + CODEX_PINNED_VERSION }),
    }) });
    adapters.push(adapter);
    return adapter;
  };
  const controller = new Controller({ env, records, createSupervisor,
    providers: { codex: { enabled: true, ready: true, modelAllowed: () => true, create } } });
  t.after(async () => {
    const closing = [];
    for (const a of controller.live.values()) {
      controller.clock.clearTimeout(a.timer);
      closing.push(a.adapter.close());
    }
    await Promise.all(supervisors.map((s) => s.terminate({ graceMs: 0 })));
    await Promise.all(closing);
  });
  const send = (args = {}) => controller.send({ owner: 'child', provider: 'codex', cwd: dir, text: 'exact text\n  with spaces ', ...args });
  const rpc = (method, params, index = controls.length - 1) => controls[index](method, params);
  const emit = (...frames) => rpc('fake/emit', { frames });
  const wait = (id) => controller.wait({ owner: records.readExecution(id).owner, executionId: id, timeoutMs: 10_000 });
  const trace = () => { try { return readFileSync(env.CODEX_FAKE_TRACE, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  return { dir, env, clock, records, controller, adapters, supervisors, send, emit, rpc, wait, trace };
}

test('new conversation and cold follow-up use new processes and exactly the saved thread', async (t) => {
  const h = setup(t, { env: { AGENT_COMPANION_CODEX_MODEL: 'must-not-pin' } });
  const one = await h.send();
  assert.equal(one.acknowledged, true);
  assert.equal(one.effectiveModel, 'configured-model');
  assert.equal(one.effectiveEffort, 'high');
  assert.equal(one.selectedEffort, null);
  assert.equal(one.permissionMode, 'workspace-write');
  await h.emit(terminal());
  const first = await h.wait(one.executionId);
  assert.equal(first.outcome, 'completed');
  assert.equal(first.effectiveModel, 'configured-model');
  assert.equal(first.stopEvidence.gone, true);
  const two = await h.send({ text: 'follow up' });
  assert.notEqual(h.supervisors[0].child.pid, h.supervisors[1].child.pid);
  await h.emit(terminal());
  const second = await h.wait(two.executionId);
  assert.equal(second.nativeRefs.threadId, first.nativeRefs.threadId);
  assert.equal(second.nativeRefs.threadId, 'T1');
  assert.deepEqual(h.trace().filter((m) => ['thread/start', 'thread/resume'].includes(m.method)).map((m) => [m.method, m.params.threadId]),
    [['thread/start', undefined], ['thread/resume', 'T1']]);
  for (const m of h.trace().filter((m) => ['thread/start', 'thread/resume', 'turn/start'].includes(m.method))) {
    assert.equal(Object.hasOwn(m.params, 'model'), false);
    for (const key of ['effort', 'reasoningEffort', 'reasoning_effort']) assert.equal(Object.hasOwn(m.params, key), false);
    assert.equal(m.params.approvalPolicy, 'never');
  }
  const sent = h.trace().filter((m) => m.method === 'turn/start');
  assert.equal(sent[0].params.input[0].text, 'exact text\n  with spaces ');
  assert.deepEqual(sent[0].params.sandboxPolicy, { type: 'workspaceWrite', networkAccess: true });
  assert.equal(h.records.readExecution(one.executionId).terminal.effectiveEffort, 'high');
});

test('handshake opts out of exactly the pinned connection-scoped notifications', async (t) => {
  const h = setup(t); const sent = await h.send();
  const messages = h.trace();
  assert.deepEqual(messages[0].params.capabilities.optOutNotificationMethods,
    codexAppServerContract().serverNotifications.filter((n) => n.routing === 'connection').map((n) => n.method));
  assert.deepEqual(messages.slice(0, 4).map((m) => m.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  await h.emit(terminal()); await h.wait(sent.executionId);
});

test('explicit model persists across cold resume and network-off reaches turn/start', async (t) => {
  const h = setup(t, { env: { AGENT_COMPANION_CODEX_NETWORK: 'off', AGENT_COMPANION_CODEX_APPROVAL_POLICY: 'on-request' } });
  const first = await h.send({ model: 'chosen-model' });
  await h.emit(terminal()); await h.wait(first.executionId);
  const second = await h.send({ text: 'again' });
  await h.emit(terminal());
  assert.equal((await h.wait(second.executionId)).effectiveModel, 'chosen-model');
  for (const m of h.trace().filter((m) => ['thread/start', 'thread/resume', 'turn/start'].includes(m.method))) {
    assert.equal(m.params.model, 'chosen-model');
    assert.equal(m.params.approvalPolicy, 'never');
    if (m.method === 'turn/start') assert.deepEqual(m.params.sandboxPolicy, { type: 'workspaceWrite', networkAccess: false });
  }
});

for (const fault of ['missing-id', 'lost', 'late']) test(`delivery ${fault} rejects DeliveryUnknown and never resends`, async (t) => {
  const h = setup(t, { fault }); const sending = h.send();
  await until(() => h.trace().some((m) => m.method === 'turn/start'));
  if (fault !== 'missing-id') {
    await h.emit(note('turn/started', { threadId: 'T1', turn: { id: 'TURN1' } }), terminal());
    assert.equal(h.records.readResult(h.records.readConversation('child').executionId), null);
    await h.clock.advance(10_000);
  }
  const result = await sending;
  assert.equal(result.outcome, 'delivery_unknown');
  assert.equal(h.records.readExecution(result.executionId).terminal.error, 'DeliveryUnknown');
  assert.equal(h.trace().filter((m) => m.method === 'turn/start').length, 1);
  if (fault === 'late') assert.ok(h.trace().some((m) => m.method === 'fake/lateAck'));
  assert.equal(result.nativeRefs.nativeTurnId, undefined);
  assert.equal(result.stopEvidence.gone, true);
});

test('completion before the turn/start response is retained until observe', async (t) => {
  const h = setup(t, { fault: 'early' }); const sent = await h.send();
  const result = await h.wait(sent.executionId);
  assert.equal(result.outcome, 'completed'); assert.equal(result.text, 'answer');
  assert.equal(result.nativeRefs.turnId, 'TURN1');
});

test('turn progress reports effective model and effort without trusting the requested model', async (t) => {
  const h = setup(t); const sent = await h.send({ model: 'requested-model' });
  await h.emit(note('thread/settings/updated', { threadId: 'T1', threadSettings: { model: 'server-model', effort: 'medium' } }),
    note('model/rerouted', { threadId: 'T1', turnId: 'TURN1', fromModel: 'server-model', toModel: 'effective-model' }), terminal());
  await h.wait(sent.executionId);
  const execution = h.records.readExecution(sent.executionId);
  assert.equal(execution.terminal.effectiveModel, 'effective-model');
  assert.equal(execution.terminal.effectiveEffort, 'medium');
  assert.equal(execution.progress.effectiveModel, 'effective-model');
});

test('willRetry stays progress; deltas, completed items and per-turn usage survive completion', async (t) => {
  const h = setup(t); const sent = await h.send();
  const retry = { threadId: 'T1', turnId: 'TURN1', error: { message: 'reconnecting' }, willRetry: true };
  await h.emit(note('item/agentMessage/delta', { threadId: 'T1', turnId: 'TURN1', itemId: 'answer', delta: 'part' }),
    driftNote('turn/failed', retry), note('error', retry));
  await until(() => h.records.readExecution(sent.executionId).progress?.retry);
  const progress = h.records.readExecution(sent.executionId).progress;
  assert.equal(progress.partialText, 'part');
  assert.equal(progress.retry.willRetry, true);
  assert.equal(progress.lastActivityAt, h.clock.now());
  assert.equal(h.records.readResult(sent.executionId), null);
  const usage = (input, output) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output });
  await h.emit(note('thread/tokenUsage/updated', { threadId: 'T1', turnId: 'TURN1', tokenUsage: { total: usage(110, 25), last: usage(10, 5) } }),
    note('thread/tokenUsage/updated', { threadId: 'T1', turnId: 'TURN1', tokenUsage: { total: usage(130, 32), last: usage(20, 7) } }),
    note('item/completed', { threadId: 'T1', turnId: 'TURN1', item: threadItem('agentMessage', { id: 'answer', text: 'answer', phase: 'final_answer' }) }), terminal());
  const result = await h.wait(sent.executionId);
  assert.equal(result.outcome, 'completed'); assert.equal(result.text, 'answer');
  assert.equal(result.usage.source, 'codex-app-server');
  assert.equal(result.usage.input_tokens, 30); assert.equal(result.usage.output_tokens, 12);
  assert.equal(result.usage.total_tokens, 42);
});

for (const method of ['error', 'turn/failed', 'turn/completed']) test(`${method} without retry is terminal failure`, async (t) => {
  const h = setup(t); const sent = await h.send();
  const params = { threadId: 'T1', turnId: 'TURN1', error: { message: 'fatal' }, willRetry: false };
  await h.emit(method === 'turn/completed' ? terminal('failed', 'partial') : method === 'error' ? note(method, params) : driftNote(method, params));
  assert.equal((await h.wait(sent.executionId)).outcome, 'failed');
});

test('interrupt uses the active turn, reports interrupted and removes the real process tree', async (t) => {
  const h = setup(t, { fault: 'interrupt', tree: true }); const sent = await h.send();
  const supervisor = h.supervisors[0], pid = supervisor.fixture.commandPid;
  await h.emit(note('item/started', { threadId: 'T1', turnId: 'TURN1', item: threadItem('commandExecution', { id: 'cmd', command: 'fixture command', processId: String(pid) }) }));
  await until(() => h.records.readExecution(sent.executionId).progress?.activeCommand);
  assert.equal(h.records.readExecution(sent.executionId).progress.activeCommand, 'fixture command');
  assert.ok(supervisor.reported.includes(pid));
  await h.emit(note('item/commandExecution/terminalInteraction', { threadId: 'T1', turnId: 'TURN1', itemId: 'cmd', processId: String(supervisor.fixture.rows.at(-1).pid), stdin: '' }));
  await until(() => supervisor.reported.length === 2);
  const result = await h.controller.cancel({ owner: 'child', executionId: sent.executionId });
  assert.equal(result.outcome, 'interrupted'); assert.equal(result.cause, 'owner_stop');
  assert.equal(result.stopEvidence.gone, true);
  assert.equal(supervisor.serialize().processes.length, 4);
  assert.ok(result.stopEvidence.signals.some((s) => s.signal === 'SIGKILL'));
  assert.deepEqual(h.trace().find((m) => m.method === 'turn/interrupt').params, { threadId: 'T1', turnId: 'TURN1' });
});

test('interrupt accepts no-active-turn but propagates an active-turn mismatch', async (t) => {
  for (const fault of ['no-active', 'wrong-turn']) {
    const h = setup(t, { fault }); const sent = await h.send();
    if (fault === 'no-active') await h.adapters[0].interrupt();
    else await assert.rejects(h.adapters[0].interrupt(), /expected active turn id/);
    await h.emit(terminal()); await h.wait(sent.executionId);
  }
});

test('start failure becomes failed runtime_unavailable with cleanup', async (t) => {
  const h = setup(t, { fault: 'startup' }); const result = await h.send();
  assert.equal(result.outcome, 'failed'); assert.equal(result.detail, 'runtime_unavailable');
  assert.equal(result.stopEvidence.gone, true);
  assert.equal(h.trace().some((m) => m.method === 'thread/start'), false);
});

test('unknown history fails HistoryUnavailable without starting a replacement', async (t) => {
  const h = setup(t);
  mkdirSync(join(h.records.dir, 'threads'), { recursive: true });
  writeFileSync(join(h.records.dir, 'threads', 'child.sid'), 'missing-thread');
  h.records._write('jobs', 'legacy', { thread: 'child', target: 'codex', startedAt: 1 });
  const result = await h.send();
  assert.equal(result.outcome, 'failed'); assert.equal(result.detail, 'history_unavailable');
  assert.equal(h.records.readExecution(result.executionId).terminal.error, 'HistoryUnavailable');
  assert.deepEqual(h.trace().filter((m) => m.method.startsWith('thread/')).map((m) => [m.method, m.params.threadId]), [['thread/resume', 'missing-thread']]);
});

test('transport death before terminal rejects ProviderLost and preserves partial text', async (t) => {
  const h = setup(t); const sent = await h.send();
  await h.emit(note('item/agentMessage/delta', { threadId: 'T1', turnId: 'TURN1', itemId: 'answer', delta: 'partial' }));
  h.supervisors[0].child.stdin.write(JSON.stringify({ method: 'fake/die' }) + '\n');
  const result = await h.wait(sent.executionId);
  assert.equal(result.outcome, 'failed'); assert.equal(result.text, 'partial');
  assert.equal(h.records.readExecution(sent.executionId).terminal.error, 'ProviderLost');
  assert.equal(result.stopEvidence.gone, true);
});

test('steer distinguishes acknowledgement from a matching userMessage in the confirmation window', async (t) => {
  const h = setup(t); const sent = await h.send();
  const steering = h.adapters[0].steer({ text: 'change direction' });
  await until(() => h.trace().some((m) => m.method === 'turn/steer'));
  await h.emit(note('item/completed', { threadId: 'T1', turnId: 'TURN1', item: threadItem('userMessage', { id: 'steer', content: [{ type: 'text', text: 'change direction' }] }) }));
  assert.equal((await steering).confirmed, true);
  assert.deepEqual(h.trace().find((m) => m.method === 'turn/steer').params, {
    threadId: 'T1', expectedTurnId: 'TURN1', input: [{ type: 'text', text: 'change direction' }],
  });
  const unconfirmed = h.adapters[0].steer({ text: 'another instruction' });
  await until(() => [...h.clock.timers.values()].some((timer) => timer.at === h.clock.time + 5000));
  await h.emit(note('item/completed', { threadId: 'T1', turnId: 'TURN1', item: threadItem('userMessage', { id: 'opening', content: [{ type: 'text', text: 'opening message' }] }) }));
  await h.clock.advance(5000);
  assert.equal((await unconfirmed).confirmed, false);
  await h.emit(terminal()); await h.wait(sent.executionId);
});

test('provider entry uses cached readiness, validates models and creates independent adapters without spawning', () => {
  writeTargetChecks({ codex: { ready: false } });
  const provider = codexProvider({ env: { CODEX_BIN: '/nonexistent/codex' } });
  assert.equal(provider.enabled, true); assert.equal(provider.ready, false);
  writeTargetChecks({ codex: { ready: true } });
  assert.equal(provider.ready, true);
  assert.equal(provider.modelAllowed('chosen-model'), true); assert.equal(provider.modelAllowed('two models'), false);
  assert.notEqual(provider.create(), provider.create());
  assert.deepEqual(provider.create().capabilities, { followUp: true, steer: true, modelSelection: true, loadsHistory: true });
});


test('delivery metadata refreshes reported effort without inventing a selected override', async (t) => {
  const h = setup(t, { env: { CODEX_TEST_TURN_EFFORT: 'medium' } });
  const sent = await h.send();
  assert.equal(sent.effectiveEffort, 'medium');
  assert.equal(sent.selectedEffort, null);
  await h.emit(terminal());
  assert.equal((await h.wait(sent.executionId)).effectiveEffort, 'medium');
});
