import '../sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_HOME } from '../sandbox-home.mjs';
import { Controller } from '../../bridge-server/controller/controller.mjs';
import { Records, resultText, resultUsage } from '../../bridge-server/controller/records.mjs';
import { ManualClock, deferred } from './helpers.mjs';

function setup(t, interventions = { default: 'steer', steer: true, queue: 'bridge', interrupt: true }) {
  const clock = new ManualClock(), dir = mkdtempSync(join(SANDBOX_HOME, 'interventions-'));
  const records = new Records({ dir, log() {} }), calls = [];
  let turn = deferred(), serial = 0, pending = false;
  const beforeSend = id => {
    if (id === records.readConversation('child').executionId) return;
    assert.equal(records.readExecution(records.readConversation('child').executionId).interventions.find(i => i.id === id)?.state, 'accepted');
  };
  const adapter = {
    capabilities: { followUp: true, loadsHistory: true, interventions },
    async start() {}, async openHistory() { return { historyId: 'same-session' }; },
    async deliver({ text, messageId }) {
      beforeSend(messageId); calls.push(['deliver', text]); turn = deferred();
      return { nativeTurnId: `turn-${++serial}` };
    },
    observe({ onInput }) { this.onInput = onInput; calls.push(['observe']); return turn.promise; },
    hasPendingInput() { return pending; },
    async steer({ text, id }) { beforeSend(id); calls.push(['steer', text]); return { accepted: true, confirmed: true, nativeTurnId: `turn-${serial}` }; },
    async intervene({ text, id, mode }) { beforeSend(id); calls.push([mode, text]); pending = true; return { accepted: true }; },
    async interrupt() { calls.push(['interrupt']); turn.resolve({ outcome: 'interrupted', text: 'partial must disappear' }); },
    async close() { calls.push(['close']); },
  };
  const controller = new Controller({ clock, records, env: { AGENT_COMPANION_OWNER_GRACE_MS: '3000' },
    snapshot: async () => ({ available: false, reason: 'test' }),
    providers: { fake: { enabled: true, ready: true, create: () => adapter } },
    createSupervisor: () => ({ async terminate() { return { gone: true }; }, async quiesce() {}, async census() {},
      serialize() { return {}; }, stopCensus() {}, detach() {} }), launchWatcher: async () => ({ pid: 123 }),
  });
  t.after(() => { for (const a of controller.live.values()) clock.clearTimeout(a.timer); });
  const send = () => controller.send({ owner: 'child', provider: 'fake', cwd: dir, text: 'original task' });
  const input = (executionId, mode, extra = {}) => controller.intervene({ executionId, from: 'user', mode, text: 'new text\nsecond line', ...extra });
  const finish = async (outcome = 'completed', text = 'answer', messages, next = false) => {
    const old = turn; if (next) turn = deferred(); pending = next;
    old.resolve({ outcome, text, ...(messages ? { messages, nativeTurnId: `turn-${++serial}` } : {}) });
    await clock.flush();
  };
  const result = executionId => controller.wait({ owner: 'child', executionId });
  return { controller, records, clock, calls, adapter, send, input, finish, result };
}

for (const steer of [false, true]) for (const queue of [false, 'native', 'bridge']) for (const interrupt of [false, true]) {
  for (const mode of ['steer', 'queue', 'interrupt']) test(`mode ${mode}, capabilities ${JSON.stringify({ steer, queue, interrupt })}`, async t => {
    const h = setup(t, { steer, queue, interrupt }), { executionId } = await h.send();
    const answer = await h.input(executionId, mode);
    if (!{ steer, queue, interrupt }[mode]) {
      assert.deepEqual(answer, { ok: false, status: 'intervention_unavailable', reason: 'capability' });
      assert.deepEqual(h.records.readExecution(executionId).interventions, []);
    } else {
      assert.equal(answer.ok, true);
      const [saved] = h.records.readExecution(executionId).interventions;
      assert.equal(saved.from, 'user'); assert.equal(saved.mode, mode); assert.equal(saved.text, 'new text\nsecond line');
      assert.equal(typeof saved.id, 'string'); assert.equal(typeof saved.at, 'number');
    }
    await h.controller.cancel({ owner: 'child', executionId });
  });
}

for (const mode of ['steer', 'queue', 'interrupt']) test(`${mode} refuses unavailable states without writing or renewing`, async t => {
  const h = setup(t), { executionId } = await h.send(), a = h.controller.live.get(executionId);
  for (const fields of [{ record: { state: 'starting' } }, { record: { state: 'delivering' } }, { record: { terminal: {} } },
    { stopping: true }, { closed: true }, { handedOff: true }]) {
    const old = { ...a, record: { ...a.record } }, lease = h.records.readLease(executionId);
    Object.assign(a, { ...fields, record: { ...a.record, ...fields.record } });
    assert.deepEqual(await h.input(executionId, mode), { ok: false, status: 'intervention_unavailable', reason: 'state' });
    assert.deepEqual(h.records.readLease(executionId), lease);
    Object.assign(a, old);
  }
  await h.finish(); await h.result(executionId);
  assert.deepEqual(await h.input(executionId, mode), { ok: false, status: 'intervention_unavailable', reason: 'state' });
  assert.deepEqual(await h.input('missing', mode), { ok: false, status: 'intervention_unavailable', reason: 'state' });
});

test('bridge queue stays held until a successful boundary; answers and ids are ordered once', async t => {
  const h = setup(t), { executionId } = await h.send();
  await h.input(executionId, 'queue');
  const [input] = h.records.readExecution(executionId).interventions;
  assert.equal(input.state, 'accepted'); assert.equal(h.calls.filter(c => c[0] === 'deliver').length, 1);
  await h.finish('completed', 'first answer');
  assert.deepEqual(h.calls.filter(c => c[0] === 'deliver'), [['deliver', 'original task'], ['deliver', 'new text\nsecond line']]);
  assert.equal(h.records.readResult(executionId), null);
  await h.finish('completed', 'second answer');
  const result = await h.result(executionId);
  assert.deepEqual(result.nativeTurnIds, ['turn-1', 'turn-2']);
  assert.deepEqual(result.turns.map(t => t.messages), [[executionId], [input.id]]);
  assert.equal(result.interventions[0].state, 'answered');
  assert.equal(result.text, "Task\n\nfirst answer\n\nUser's message (queued): new text\n\nsecond answer");
});

test('steer joins its turn, preserves the legacy reply entry and caller lease handling', async t => {
  const h = setup(t), { executionId } = await h.send();
  await h.clock.advance(2000);
  const reply = await h.controller.steer({ owner: 'child', executionId, text: 'change course' });
  assert.equal(reply.ok, true); assert.equal(h.controller.live.get(executionId).remainingMs, 3000);
  await h.finish(); const result = await h.result(executionId);
  assert.deepEqual(result.turns[0].messages, [executionId, result.interventions[0].id]);
  assert.equal(result.text, 'answer');
  assert.deepEqual(await h.controller.steer({ owner: 'child', executionId, text: 'too late' }), { ok: false, status: 'reply_unavailable', reason: 'state' });
});

test('user intervention does not extend the lease; held input is lost on expiry', async t => {
  const h = setup(t), { executionId } = await h.send();
  await h.clock.advance(2000); const lease = h.records.readLease(executionId);
  await h.input(executionId, 'queue'); assert.deepEqual(h.records.readLease(executionId), lease);
  await h.clock.advance(1000); const result = await h.result(executionId);
  assert.equal(result.cause, 'owner_lease_expired'); assert.equal(result.interventions[0].state, 'not_delivered');
});

for (const queue of ['bridge', 'native']) test(`${queue} pending input behind a failed turn is not delivered`, async t => {
  const h = setup(t, { queue }), { executionId } = await h.send();
  await h.input(executionId, 'queue'); await h.finish('failed', 'failed answer');
  const result = await h.result(executionId);
  assert.equal(result.outcome, 'failed'); assert.equal(result.interventions[0].state, 'not_delivered');
  assert.equal(h.calls.filter(c => c[0] === 'deliver').length, 1);
});

test('interrupt ends the old turn and sends only the new message on the live session', async t => {
  const h = setup(t), { executionId } = await h.send();
  await h.input(executionId, 'interrupt'); await h.clock.flush();
  await h.finish('completed', 'new answer'); const result = await h.result(executionId);
  assert.deepEqual(result.turns.map(t => t.outcome), ['interrupted', 'completed']);
  assert.equal(result.turns[0].text, 'interrupted before answering');
  assert.doesNotMatch(result.text, /partial must disappear/);
  assert.deepEqual(h.calls.filter(c => c[0] === 'deliver'), [['deliver', 'original task'], ['deliver', 'new text\nsecond line']]);
});

test('native queued message keeps the job observing without a second delivery', async t => {
  const h = setup(t, { queue: 'native' }), { executionId } = await h.send();
  await h.input(executionId, 'queue'); const [input] = h.records.readExecution(executionId).interventions;
  await h.finish('completed', 'first', [executionId], true);
  assert.equal(h.records.readResult(executionId), null);
  await h.finish('completed', 'second', [input.id]);
  const result = await h.result(executionId);
  assert.equal(result.turns.length, 2); assert.equal(result.interventions[0].state, 'answered');
  assert.equal(h.calls.filter(c => c[0] === 'deliver').length, 1);
});

for (const stop of ['cancel', 'bridgeLost']) test(`${stop} marks held messages not_delivered`, async t => {
  const h = setup(t), { executionId } = await h.send(); await h.input(executionId, 'queue');
  await h.controller[stop]({ owner: 'child', executionId });
  assert.equal(h.records.readExecution(executionId).interventions[0].state, 'not_delivered');
  assert.equal(h.calls.filter(c => c[0] === 'deliver').length, 1);
});

test('failed steered turn appears once and its unanswered steer is not_delivered', async t => {
  const h = setup(t), { executionId } = await h.send();
  await h.input(executionId, 'steer'); await h.finish('failed', 'provider failed');
  const result = await h.result(executionId);
  assert.equal(result.turns.length, 1); assert.equal(result.turns[0].outcome, 'failed');
  assert.equal(result.interventions[0].state, 'not_delivered');
});

test('interrupt takes priority over held queues without dropping or reversing them', async t => {
  const h = setup(t), { executionId } = await h.send();
  await h.input(executionId, 'queue', { text: 'first queued' });
  await h.input(executionId, 'queue', { text: 'second queued' });
  await h.input(executionId, 'interrupt', { text: 'urgent' }); await h.clock.flush();
  await h.finish(); await h.finish(); await h.finish();
  const result = await h.result(executionId);
  assert.equal(result.turns.length, 4);
  assert.deepEqual(h.calls.filter(c => c[0] === 'deliver').map(c => c[1]), ['original task', 'urgent', 'first queued', 'second queued']);
  assert.ok(result.interventions.every(i => i.state === 'answered'));
});

test('a rejected steer never joins the answer and accepted input is persisted as not_delivered', async t => {
  const h = setup(t), { executionId } = await h.send();
  h.adapter.steer = async () => { throw new Error('native steer refused'); };
  await assert.rejects(h.input(executionId, 'steer'), /native steer refused/);
  await h.finish(); const result = await h.result(executionId);
  assert.deepEqual(result.turns[0].messages, [executionId]);
  assert.equal(result.interventions[0].state, 'not_delivered');
});

test('caller ownership and aborted requests are checked before accepting input', async t => {
  const h = setup(t), { executionId } = await h.send();
  await assert.rejects(h.input(executionId, 'queue', { from: 'caller' }), { code: 'NATIVE_OWNER_REQUIRED' });
  await assert.rejects(h.input(executionId, 'queue', { from: 'caller', owner: 'other' }), { code: 'execution_unknown' });
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await h.input(executionId, 'queue', { from: 'caller', owner: 'child', signal: abort.signal }),
    { ok: false, status: 'intervention_unavailable', reason: 'state' });
  const result = await h.result(executionId);
  assert.equal(result.cause, 'owner_stop'); assert.deepEqual(result.interventions, []);
});

test('a failed native turn closes without waiting for an outstanding input acknowledgement', async t => {
  const h = setup(t, { queue: 'native' }), { executionId } = await h.send(), receipt = deferred();
  h.adapter.intervene = () => receipt.promise;
  const input = h.input(executionId, 'queue'); await h.clock.flush();
  await h.finish('failed', 'failed before queued input');
  const result = h.records.readResult(executionId);
  receipt.resolve({ accepted: true }); await input;
  assert.equal(result?.outcome, 'failed');
  assert.equal(result.interventions[0].state, 'not_delivered');
  assert.deepEqual(h.records.readResult(executionId), result, 'a late receipt cannot rewrite the terminal result');
});

test('stop preserves a native joined message in the interrupted turn without partial text', async t => {
  const h = setup(t, { queue: 'native' }), { executionId } = await h.send();
  await h.input(executionId, 'queue'); const [input] = h.records.readExecution(executionId).interventions;
  h.adapter.onInput({ id: input.id, state: 'joined', nativeTurnId: 'turn-1' });
  const result = await h.controller.cancel({ owner: 'child', executionId });
  assert.equal(result.turns.length, 1);
  assert.deepEqual(result.turns[0].messages, [executionId, input.id]);
  assert.equal(result.turns[0].text, 'interrupted before answering');
  assert.equal(result.interventions[0].state, 'not_delivered');
});

test('result projections: one turn stays unlabelled; several are labelled for the caller with a short first line, and usage sums the turns', () => {
  const long = 'x'.repeat(120);
  const execution = { executionId: 'job', terminal: { text: 'last', usage: { input_tokens: 5 } },
    interventions: [{ id: 'u', from: 'user', mode: 'queue', text: `${long}\nmore` }, { id: 'c', from: 'caller', mode: 'interrupt', text: 'stop and do y' }],
    turns: [{ messages: ['job'], outcome: 'completed', text: 'first', usage: { source: 'fake', input_tokens: 1, output_tokens: 2 } },
      { messages: ['u'], outcome: 'interrupted', text: 'partial' },
      { messages: ['c'], outcome: 'completed', text: 'last', usage: { source: 'fake', input_tokens: 3, output_tokens: 4 } }] };
  assert.equal(resultText(execution), `Task\n\nfirst\n\nUser's message (queued): ${'x'.repeat(79)}…\n\ninterrupted before answering\n\nCaller's message (interrupt): stop and do y\n\nlast`);
  const usage = resultUsage(execution);
  assert.equal(usage.input_tokens, 4); assert.equal(usage.output_tokens, 6);
  const single = { ...execution, turns: execution.turns.slice(0, 1) };
  assert.equal(resultText(single), 'last');
  assert.deepEqual(resultUsage(single), { input_tokens: 5 });
});
