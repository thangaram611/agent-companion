import '../sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_HOME } from '../sandbox-home.mjs';
import { Controller } from '../../bridge-server/controller/controller.mjs';
import { Records } from '../../bridge-server/controller/records.mjs';
import { ManualClock, deferred } from './helpers.mjs';

function setup(options = {}) {
  const clock = new ManualClock();
  const dir = mkdtempSync(join(SANDBOX_HOME, 'controller-'));
  const records = new Records({ dir, log: () => {} });
  const adapters = [], supervisors = [];
  const createSupervisor = () => {
    const supervisor = { spawn: async () => ({}), serialize: () => ({ processes: [] }), census: async () => {}, quiesce: async () => {}, stopCensus() {}, detach() {},
      terminate: async () => { supervisor.terminated++; return { gone: options.gone ?? true, signals: [], checkedAt: clock.now() }; }, terminated: 0 };
    supervisors.push(supervisor); return supervisor;
  };
  const create = () => {
    const terminal = deferred(), ack = deferred();
    const adapter = {
      capabilities: { followUp: true, steer: false, modelSelection: true, loadsHistory: true, ...options.capabilities },
      calls: [], terminal, ack,
      async start(args) { this.calls.push(['start', args]); if (options.startCrash) throw new Error('startup crash'); return { runtime: await args.supervisor.spawn(['fake'], { cwd: args.cwd }) }; },
      async openHistory(args) { this.calls.push(['openHistory', args]); if (options.historyError) throw Object.assign(new Error(options.historyError), { code: options.historyError }); if (options.historyCrash) throw new Error('HistoryUnavailable'); return { historyId: args.historyId || 'native-history', effectiveModel: 'effective-model' }; },
      async deliver(args) { this.calls.push(['deliver', args]); if (options.lostAck) return ack.promise; return { nativeTurnId: 'turn-1' }; },
      observe(args) { this.calls.push(['observe', args]); this.progress = args.onProgress; return terminal.promise; },
      async interrupt() { this.calls.push(['interrupt']); if (options.racingComplete) terminal.resolve({ outcome: 'completed', text: 'native answer', usage: { tokens: 7 } }); if (options.hungInterrupt) return new Promise(() => {}); },
      async close() { this.calls.push(['close']); if (options.hungClose) return new Promise(() => {}); },
    };
    adapters.push(adapter); return adapter;
  };
  const controller = new Controller({ providers: { fake: { enabled: true, ready: true, modelAllowed: (model) => ['a', 'b'].includes(model), create } }, records, clock,
    env: options.env || {}, createSupervisor, launchWatcher: options.launchWatcher || (async () => ({ pid: 123 })) });
  const send = (overrides = {}) => controller.send({ owner: 'child', provider: 'fake', cwd: dir, text: 'verbatim text\nwith context', ...overrides });
  const done = async (executionId) => {
    await clock.flush();
    return controller.wait({ owner: records.readExecution(executionId).owner, executionId });
  };
  const finish = async (executionId, outcome = { outcome: 'completed', text: 'answer' }, adapter = adapters[0]) => {
    adapter.terminal.resolve(outcome); return done(executionId);
  };
  return { controller, clock, records, dir, adapters, supervisors, send, done, finish };
}
const calls = (adapter, method) => adapter.calls.filter(([name]) => name === method);
const disk = (dir) => readdirSync(dir, { recursive: true }).sort().filter((file) => statSync(join(dir, file)).isFile()).map((file) => [file, statSync(join(dir, file)).mtimeMs, readFileSync(join(dir, file), 'utf8')]);

for (const [method, detail] of [['start', 'runtime_unavailable'], ['openHistory', 'history_unavailable'], ['deliver', 'delivery_unknown']]) {
  test(`wrapped ${method} failure relays the innermost message only, on one bounded line`, async () => {
    const h = setup(), create = h.controller.providers.fake.create;
    const message = '  provider refused\n\t' + 'x'.repeat(600);
    const inner = Object.assign(new Error(message), { data: { headers: 'SECRET_HEADER' }, response: 'SECRET_BODY' });
    const wrapped = Object.assign(new Error('wrapper', { cause: new Error('middle', { cause: inner }) }), { code: 'HistoryUnavailable' });
    h.controller.providers.fake.create = () => {
      const adapter = create(); adapter[method] = async () => { throw wrapped; }; return adapter;
    };
    const result = await h.send();
    assert.equal(result.detail, detail);
    assert.match(result.text, /^provider refused x+…$/);
    assert.equal(result.text.length, 500);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_|wrapper|middle/);
  });
}

test('duplicate send reattaches once; different text or model on a busy conversation is refused', async () => {
  const h = setup();
  const [one, two] = await Promise.all([h.send({ model: 'a' }), h.send({ model: 'a' })]);
  assert.equal(one.executionId, two.executionId);
  assert.equal(h.adapters.length, 1);
  assert.deepEqual(calls(h.adapters[0], 'deliver').map(([, args]) => args.text), ['verbatim text\nwith context']);
  await assert.rejects(h.send({ text: 'different' }), { code: 'thread_busy' });
  await assert.rejects(h.send({ model: 'b' }), { code: 'thread_busy' });
  assert.equal((await h.finish(one.executionId)).outcome, 'completed');
});

test('lost acknowledgement becomes delivery_unknown with no resend', async () => {
  const h = setup({ lostAck: true });
  const first = h.send(), duplicate = h.send();
  await h.clock.flush();
  await h.clock.advance(10_000);
  const [result, again] = await Promise.all([first, duplicate]);
  assert.equal(result.outcome, 'delivery_unknown');
  assert.equal(result.executionId, again.executionId);
  assert.equal(calls(h.adapters[0], 'deliver').length, 1);
  assert.equal(calls(h.adapters[0], 'observe').length, 0);
  assert.equal(h.supervisors[0].terminated, 1);
  assert.equal((await h.done(result.executionId)).outcome, 'delivery_unknown');
});

test('missed terminal event expires the owner lease honestly and preserves partial text', async () => {
  const h = setup();
  const sent = await h.send();
  h.adapters[0].progress({ lastActivityAt: h.clock.now(), partialText: 'partial answer', retry: { attempt: 2 } });
  await h.clock.advance(119_000);
  assert.equal(h.records.readResult(sent.executionId), null);
  await h.clock.advance(1000);
  const result = await h.done(sent.executionId);
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.cause, 'owner_lease_expired');
  assert.equal(result.text, 'partial answer');
  assert.equal(result.stopEvidence.gone, true);
  assert.equal(result.stopEvidence.detectionDelayMs, 120_000);
});

test('status-only second bridge writes nothing, renews nothing and refuses overlapping execution', async () => {
  const h = setup(); const sent = await h.send();
  const observer = new Controller({ records: new Records({ dir: h.dir }), providers: h.controller.providers, clock: h.clock });
  const before = disk(h.dir);
  for (let i = 0; i < 5; i++) {
    assert.equal(observer.status({ executionId: sent.executionId }).state, 'unknown');
    h.controller.status({ owner: 'child' });
  }
  assert.deepEqual(disk(h.dir), before);
  await assert.rejects(observer.send({ owner: 'child', provider: 'fake', cwd: h.dir, text: 'new' }), { code: 'previous_execution_unverified' });
  assert.deepEqual(disk(h.dir), before);
  await h.clock.advance(120_000);
  assert.equal((await h.done(sent.executionId)).cause, 'owner_lease_expired');
});

test('cancelled pending owner request closes only its execution', async () => {
  const h = setup(); const sent = await h.send();
  const waiting = h.controller.wait({ owner: 'child', executionId: sent.executionId, requestId: 'owner-wait' });
  const result = await h.controller.cancelRequest('owner-wait');
  assert.equal(result.cause, 'owner_stop');
  assert.deepEqual(await waiting, result);
  assert.equal(h.supervisors[0].terminated, 1);
  assert.equal(await h.controller.cancelRequest('unrelated'), null);
});

test('AbortSignal during pending send closes startup and never delivers', async () => {
  const h = setup(); const abort = new AbortController();
  const sent = h.send({ signal: abort.signal }); abort.abort();
  const result = await sent;
  assert.equal(result.cause, 'owner_stop');
  assert.equal(calls(h.adapters[0], 'deliver').length, 0);
  assert.equal(result.stopEvidence.gone, true);
});

test('SubagentStop or TaskStop marker closes on next tick; old marker does not stop cold follow-up', async () => {
  const h = setup(); const sent = await h.send();
  mkdirSync(join(h.dir, 'stops'));
  writeFileSync(join(h.dir, 'stops', 'child.json'), JSON.stringify({ owner: 'child', at: h.clock.now(), source: 'SubagentStop' }));
  await h.clock.advance(1000);
  assert.equal((await h.done(sent.executionId)).cause, 'owner_stop');
  const next = await h.send({ text: 'follow-up' });
  await h.clock.advance(1000);
  assert.equal(h.records.readResult(next.executionId), null);
  await h.finish(next.executionId, undefined, h.adapters[1]);
});

test('startup crash becomes failed runtime_unavailable and cleans up', async () => {
  const h = setup({ startCrash: true });
  const result = await h.send();
  assert.equal(result.outcome, 'failed'); assert.equal(result.detail, 'runtime_unavailable');
  assert.equal(h.supervisors[0].terminated, 1);
  assert.equal(calls(h.adapters[0], 'deliver').length, 0);
});

test('native completion racing stop keeps completed and publishes one immutable result', async () => {
  const h = setup({ racingComplete: true }); const sent = await h.send();
  const result = await h.controller.cancel({ owner: 'child', executionId: sent.executionId });
  assert.equal(result.outcome, 'completed'); assert.equal(result.cause, 'native_complete');
  assert.equal(result.text, 'native answer'); assert.deepEqual(result.usage, { tokens: 7 });
  const bytes = readFileSync(h.records.path('results', sent.executionId), 'utf8');
  assert.deepEqual(await h.controller.cancel({ owner: 'child', executionId: sent.executionId }), result);
  assert.equal(readFileSync(h.records.path('results', sent.executionId), 'utf8'), bytes);
  assert.equal(readdirSync(join(h.dir, 'results')).length, 1);
});

test('two same-provider executions: closing one leaves the other untouched', async () => {
  const h = setup(); const one = await h.send(); const two = await h.send({ owner: 'sibling' });
  const siblingBefore = h.records.readExecution(two.executionId);
  await h.controller.cancel({ owner: 'child', executionId: one.executionId });
  assert.equal(h.supervisors[1].terminated, 0);
  assert.deepEqual(h.records.readExecution(two.executionId), siblingBefore);
  await h.finish(two.executionId, undefined, h.adapters[1]);
});

test('pending owner attachment renews grace; observers and other children cannot attach', async () => {
  const h = setup({ env: { AGENT_COMPANION_OWNER_GRACE_MS: '3000' } }); const sent = await h.send();
  await h.clock.advance(2000);
  assert.throws(() => h.controller.beginRequest({ owner: 'other', executionId: sent.executionId, kind: 'wait' }), { code: 'execution_unknown' });
  assert.throws(() => h.controller.beginRequest({ owner: 'child', executionId: sent.executionId, kind: 'status' }), { code: 'invalid_owner_request' });
  const wait = h.controller.wait({ owner: 'child', executionId: sent.executionId, timeoutMs: 10_000 });
  await h.clock.advance(10_000); await wait;
  assert.equal(h.records.readResult(sent.executionId), null);
  await h.clock.advance(2999); assert.equal(h.records.readResult(sent.executionId), null);
  await h.clock.advance(1001);
  assert.equal((await h.done(sent.executionId)).cause, 'owner_lease_expired');
});

test('wall clock jumps and suspend gaps do not consume unobserved owner grace', async () => {
  const h = setup({ env: { AGENT_COMPANION_OWNER_GRACE_MS: '3000' } }); const sent = await h.send();
  h.clock.wall += 86_400_000;
  await h.clock.suspend(3_600_000);
  assert.equal(h.records.readResult(sent.executionId), null);
  await h.clock.advance(2000); assert.equal(h.records.readResult(sent.executionId), null);
  h.clock.wall -= 172_800_000;
  await h.clock.advance(1000);
  assert.equal((await h.done(sent.executionId)).cause, 'owner_lease_expired');
});

test('retry progress stays nonterminal and fresh activity is persisted as provider activity', async () => {
  const h = setup(); const sent = await h.send(); await h.clock.advance(5000);
  h.adapters[0].progress({ lastActivityAt: h.clock.now(), retry: { attempt: 2, cause: 'reconnect' }, activeCommand: 'fake-command', partialText: 'recovering' });
  const status = h.controller.status({ executionId: sent.executionId });
  assert.equal(status.result, null);
  assert.equal(status.execution.progress.lastActivityAt, h.clock.now());
  assert.equal((await h.finish(sent.executionId, { outcome: 'completed', text: 'recovered' })).text, 'recovered');
});

test('cold follow-up loads saved history, retains explicit model and omits inherited model keys', async () => {
  const h = setup(); const first = await h.send();
  assert.equal(Object.hasOwn(calls(h.adapters[0], 'start')[0][1], 'model'), false);
  assert.equal(Object.hasOwn(calls(h.adapters[0], 'openHistory')[0][1], 'model'), false);
  await h.finish(first.executionId);
  const second = await h.send({ text: 'second', model: 'a' });
  assert.deepEqual(calls(h.adapters[1], 'openHistory')[0][1], { historyId: 'native-history', model: 'a' });
  await h.finish(second.executionId, undefined, h.adapters[1]);
  const third = await h.send({ text: 'third' });
  assert.equal(calls(h.adapters[2], 'start')[0][1].model, 'a');
  assert.equal(third.generation, 3);
  await h.finish(third.executionId, undefined, h.adapters[2]);
});

test('start receives null for fresh history and the saved id before cold resume', async () => {
  const h = setup();
  const first = await h.send();
  const fresh = calls(h.adapters[0], 'start')[0][1].historyId;
  await h.finish(first.executionId);
  const second = await h.send({ text: 'follow-up' });
  const resumed = calls(h.adapters[1], 'start')[0][1].historyId;
  await h.finish(second.executionId, undefined, h.adapters[1]);
  assert.equal(fresh, null);
  assert.equal(resumed, 'native-history');
});

test('unqualified follow-up and history failure never create replacement conversations', async () => {
  const h = setup({ capabilities: { loadsHistory: false } }); const first = await h.send(); await h.finish(first.executionId);
  await assert.rejects(h.send({ text: 'follow-up' }), { code: 'FOLLOWUP_UNSUPPORTED' });
  assert.equal(h.supervisors.length, 1);
  const broken = setup({ historyCrash: true });
  const result = await broken.send();
  assert.equal(result.detail, 'history_unavailable');
  assert.equal(calls(broken.adapters[0], 'deliver').length, 0);
});

test('validate owner, canonical cwd, provider, model and ambiguous legacy history before start', async () => {
  const h = setup();
  await assert.rejects(h.send({ owner: '' }), { code: 'NATIVE_OWNER_REQUIRED' });
  await assert.rejects(h.send({ cwd: 'relative' }), { code: 'INVALID_CWD' });
  await assert.rejects(h.send({ provider: 'absent' }), { code: 'TARGET_UNSUPPORTED' });
  await assert.rejects(h.send({ model: 'not-allowed' }), { code: 'MODEL_NOT_ALLOWED' });
  mkdirSync(join(h.dir, 'threads')); writeFileSync(join(h.dir, 'threads', 'ambiguous.ambiguous'), 'two histories');
  await assert.rejects(h.send({ owner: 'ambiguous' }), { code: 'AMBIGUOUS_HISTORY' });
  const link = join(h.dir, 'alias'); symlinkSync(h.dir, link);
  const sent = await h.send({ cwd: link });
  assert.equal(h.records.readConversation('child').cwd, realpathSync(h.dir));
  await h.finish(sent.executionId);
});

test('hung interrupt and protocol close are bounded before process termination', async () => {
  const h = setup({ hungInterrupt: true, hungClose: true }); const sent = await h.send();
  const stopping = h.controller.cancel({ owner: 'child', executionId: sent.executionId });
  await h.clock.advance(1000);
  const result = await stopping;
  assert.equal(result.stopEvidence.cleanupMs, 1000);
  assert.equal(result.stopEvidence.gone, true);
  assert.deepEqual(result.stopEvidence.protocol.map((p) => p.acknowledged), [false, false]);
});

test('unverified cleanup never claims stopped or permits overlapping execution', async () => {
  const h = setup({ gone: false }); const sent = await h.send();
  const result = await h.controller.cancel({ owner: 'child', executionId: sent.executionId });
  assert.equal(result.outcome, 'failed'); assert.equal(result.detail, 'cleanup_unverified');
  await assert.rejects(h.send({ text: 'new' }), { code: 'previous_execution_unverified' });
});

test('bridge loss serializes all live executions and fences late provider writes', async () => {
  const launches = [];
  const h = setup({ launchWatcher: async (args) => { launches.push(args); return { pid: 123 }; } });
  const one = await h.send(); const two = await h.send({ owner: 'sibling' });
  const handoffs = await h.controller.bridgeLost();
  assert.equal(handoffs.length, 2); assert.equal(launches.length, 2);
  for (const sent of [one, two]) assert.equal(h.records.readExecution(sent.executionId).writer, 'watcher');
  const before = disk(h.dir);
  h.adapters[0].progress({ partialText: 'late' });
  h.adapters[0].terminal.resolve({ outcome: 'completed', text: 'late answer' });
  await h.clock.flush();
  assert.deepEqual(disk(h.dir), before);
  await assert.rejects(h.send({ owner: 'new' }), { code: 'bridge_loss' });
});

test('startup recovery verifies absence without adopting live work or mutating status reads', async () => {
  const h = setup();
  const execution = h.records.begin({ owner: 'old', provider: 'fake', cwd: h.dir, text: 'old text', effortOverride: 'low', executionId: 'old-execution', now: h.clock.now() }, 0);
  h.records.writeExecution({ ...execution, state: 'running', processes: { pid: 91001, pgid: 91001, birthTime: 'old', processes: [{ pid: 91001, birthTime: 'old' }] }, progress: { partialText: 'saved partial' } });
  let gone = false;
  const fresh = new Controller({ records: h.records, clock: h.clock, providers: h.controller.providers, createSupervisor: () => ({ verifyGone: async () => ({ gone, survivors: gone ? [] : [{ pid: 91001 }] }) }) });
  const before = disk(h.dir);
  assert.equal((await fresh.recover({ owner: 'old' })).state, 'unknown');
  assert.deepEqual(disk(h.dir), before);
  gone = true;
  const recovered = await fresh.recover({ owner: 'old' });
  assert.equal(recovered.result.cause, 'bridge_loss');
  assert.equal(recovered.result.text, 'saved partial');
  assert.equal(recovered.result.selectedEffort, 'low');
  assert.equal(recovered.state, 'closed');
});

test('a native outcome is durable before close; final publication waits for exit evidence', async () => {
  const h = setup(); const sent = await h.send();
  const closing = deferred();
  h.adapters[0].close = () => closing.promise;
  h.adapters[0].terminal.resolve({ outcome: 'completed', text: 'durable before cleanup' });
  await h.clock.flush();
  assert.equal(h.records.readExecution(sent.executionId).terminal.text, 'durable before cleanup');
  assert.equal(h.records.readResult(sent.executionId), null);
  closing.resolve();
  assert.equal((await h.done(sent.executionId)).stopEvidence.gone, true);
});

test('losing the generation fence stops owned work and resolves pending requests honestly', async () => {
  const h = setup({ lostAck: true }); const sending = h.send(); await h.clock.flush();
  h.records.writeExecution = () => false;
  h.adapters[0].ack.resolve({ nativeTurnId: 'ack-after-fence-loss' });
  const response = await sending;
  assert.equal(response.error, 'writer_fenced'); assert.equal(response.state, 'unknown');
  assert.equal(h.supervisors[0].terminated, 1);
  assert.equal(calls(h.adapters[0], 'observe').length, 0);
});

test('one failed bridge-loss handoff does not strand another execution', async () => {
  const launches = [];
  const h = setup({ launchWatcher: async (args) => { launches.push(args); return { pid: 123 }; } });
  await h.send(); const sibling = await h.send({ owner: 'sibling' });
  const handoff = h.records.handoff.bind(h.records);
  h.records.handoff = (record) => record.owner === 'child' ? false : handoff(record);
  const results = await h.controller.bridgeLost();
  assert.equal(results[0].error, 'writer_fenced'); assert.equal(h.supervisors[0].terminated, 1);
  assert.equal(launches[0].executionId, sibling.executionId);
  assert.equal(h.records.readExecution(sibling.executionId).writer, 'watcher');
});

test('ambiguous delivery still attempts native interrupt before killing the runtime', async () => {
  const h = setup({ lostAck: true }); const sending = h.send(); await h.clock.flush();
  await h.clock.advance(10_000); await sending;
  assert.equal(calls(h.adapters[0], 'interrupt').length, 1);
});

test('recovery can confirm late absence after failed watcher cleanup without rewriting its result', async () => {
  const h = setup();
  const execution = h.records.begin({ owner: 'old', provider: 'fake', cwd: h.dir, text: 'work', executionId: 'old', now: h.clock.now() }, 0);
  execution.processes = { pid: 91234, birthTime: 'old', processes: [{ pid: 91234, birthTime: 'old' }] };
  h.records.handoff(execution);
  h.records.writeResult({ ...execution, outcome: 'failed', cause: 'bridge_loss', stopEvidence: { gone: false } }, 'watcher');
  const resultBytes = readFileSync(h.records.path('results', 'old'), 'utf8');
  const fresh = new Controller({ records: h.records, clock: h.clock, createSupervisor: () => ({ verifyGone: async () => ({ gone: true }) }) });
  assert.equal((await fresh.recover({ owner: 'old' })).state, 'closed');
  assert.equal(readFileSync(h.records.path('results', 'old'), 'utf8'), resultBytes);
  assert.equal(h.records.begin({ owner: 'old', provider: 'fake', cwd: h.dir, text: 'next', executionId: 'next', now: h.clock.now() }, 1).generation, 2);
});


test('terminal model and effort supersede history-opening metadata in immutable results', async () => {
  const h = setup(); const sent = await h.send({ model: 'a' });
  const result = await h.finish(sent.executionId, { outcome: 'completed', text: 'answer', effectiveModel: 'rerouted', effectiveEffort: 'high' });
  assert.equal(result.selectedModel, 'a');
  assert.equal(result.effectiveModel, 'rerouted');
  assert.equal(result.effectiveEffort, 'high');
  assert.deepEqual(await h.done(sent.executionId), result);
});

test('explicit adapter refusal codes survive history and observe failures', async () => {
  for (const code of ['MODEL_NOT_ALLOWED', 'ACP_PROTOCOL_MISMATCH']) {
    const h = setup({ historyError: code });
    assert.equal((await h.send()).detail, code);
    const observing = setup(); const sent = await observing.send();
    observing.adapters[0].terminal.reject(Object.assign(new Error(code), { code }));
    assert.equal((await observing.done(sent.executionId)).detail, code);
  }
});

test('watcher terminal result releases the observed attachment without rewriting the lease', async () => {
  const h = setup(); const sent = await h.send();
  h.controller.beginRequest({ owner: 'child', executionId: sent.executionId, requestId: 'pending', kind: 'wait' });
  await h.controller.bridgeLost();
  const execution = h.records.readExecution(sent.executionId);
  h.records.writeResult({ owner: 'child', executionId: sent.executionId, generation: execution.generation,
    outcome: 'stopped', cause: 'bridge_loss', stopEvidence: { gone: true } }, 'watcher');
  const before = disk(h.dir);
  const view = h.controller.status({ executionId: sent.executionId });
  assert.equal(view.lease.attached, false);
  assert.equal(view.lease.remainingMs, null);
  assert.deepEqual(disk(h.dir), before);
});

test('effort inherits on follow-up, participates in busy equality and reaches adapters and results', async () => {
  const h = setup();
  const first = await h.send({ effort: 'low' });
  assert.equal(first.selectedEffort, 'low');
  assert.equal(first.effectiveEffort, null);
  assert.equal((await h.send()).executionId, first.executionId);
  await assert.rejects(h.send({ effort: 'high' }), { code: 'thread_busy' });
  for (const method of ['start', 'openHistory']) assert.equal(calls(h.adapters[0], method)[0][1].effort, 'low');
  assert.equal((await h.finish(first.executionId)).selectedEffort, 'low');
  const second = await h.send({ text: 'follow-up' });
  assert.equal(second.selectedEffort, 'low');
  assert.equal(h.records.readConversation('child').effortOverride, 'low');
  assert.equal(calls(h.adapters[1], 'openHistory')[0][1].effort, 'low');
  await h.finish(second.executionId, undefined, h.adapters[1]);
  const third = await h.send({ text: 'change effort', effort: 'high' });
  assert.equal(third.selectedEffort, 'high');
  assert.equal((await h.finish(third.executionId, undefined, h.adapters[2])).selectedEffort, 'high');
  const inherited = await h.send({ owner: 'other' });
  assert.equal(inherited.selectedEffort, null);
  for (const method of ['start', 'openHistory']) assert.equal(Object.hasOwn(calls(h.adapters[3], method)[0][1], 'effort'), false);
  await h.finish(inherited.executionId, undefined, h.adapters[3]);
});

for (const prior of [undefined, 'low']) {
  for (const code of ['EFFORT_NOT_ALLOWED', 'CAPABILITY_UNAVAILABLE']) {
    test(`refused effort ${code} preserves ${prior ?? 'inherit'} for an omitted follow-up`, async () => {
      const options = {};
      const h = setup(options);
      if (prior) await h.finish((await h.send({ effort: prior })).executionId);
      options.historyError = code;
      const refused = await h.send({ effort: 'invalid' });
      assert.equal(refused.detail, code);
      assert.equal(h.records.readConversation('child').effortOverride, prior);
      assert.equal(h.records.readConversation('child').historyId, prior ? 'native-history' : null);
      assert.equal(h.records.readExecution(refused.executionId).effortOverride, 'invalid');
      assert.equal(calls(h.adapters.at(-1), 'deliver').length, 0);
      delete options.historyError;
      const next = await h.send({ text: 'follow-up' });
      assert.equal(next.selectedEffort, prior ?? null);
      assert.equal(calls(h.adapters.at(-1), 'openHistory')[0][1].effort, prior);
      await h.finish(next.executionId, undefined, h.adapters.at(-1));
    });
  }
}

test('an omitted busy send reattaches while effort is still awaiting history validation', async () => {
  const h = setup();
  const first = h.send({ effort: 'low' });
  const again = h.send();
  const [one, two] = await Promise.all([first, again]);
  assert.equal(one.executionId, two.executionId);
  assert.equal(h.adapters.length, 1);
  await h.finish(one.executionId);
});
