import '../sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../bridge-server/controller/controller.mjs';
import { Records, resultText, resultUsage } from '../../bridge-server/controller/records.mjs';
import { fakeAdapter, setupController, deferred, waitForResult } from './helpers.mjs';

function setup(t, interventions = { default: 'steer', steer: true, queue: 'bridge', interrupt: true }) {
  const beforeSend = id => {
    if (id === records.readConversation('child').executionId) return;
    assert.equal(records.readExecution(records.readConversation('child').executionId).interventions.find(i => i.id === id)?.state, 'accepted');
  };
  const adapter = fakeAdapter({ capabilities: { interventions }, beforeSend, history: { historyId: 'same-session' },
    interruptResult: { outcome: 'interrupted', text: 'partial must disappear' } });
  const { controller, records, clock, send } = setupController({ adapter });
  t.after(() => { for (const a of controller.live.values()) clock.clearTimeout(a.timer); });
  const input = (executionId, mode, extra = {}) => controller.intervene({ executionId, from: 'user', mode, text: 'new text\nsecond line', ...extra });
  const finish = async (outcome = 'completed', text = 'answer', messages, next = false) => {
    adapter.finishTurn({ outcome, text, ...(messages ? { messages } : {}) }, next);
    await clock.flush();
  };
  const result = executionId => waitForResult(controller, { owner: 'child', executionId });
  return { controller, records, clock, adapter, send: () => send({ text: 'original task' }), input, finish, result,
    get calls() { return adapter.calls.map(([name, args]) => [name, args?.text]); } };
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

for (const mode of ['steer', 'queue', 'interrupt']) test(`${mode} refuses unavailable states without writing or attaching`, async t => {
  const h = setup(t), { executionId } = await h.send(), a = h.controller.live.get(executionId);
  for (const fields of [{ record: { state: 'starting' } }, { record: { state: 'delivering' } }, { record: { terminal: {} } },
    { stopping: true }, { closed: true }, { handedOff: true }]) {
    const old = { ...a, record: { ...a.record } }, attachment = h.records.readAttachment(executionId);
    Object.assign(a, { ...fields, record: { ...a.record, ...fields.record } });
    assert.deepEqual(await h.input(executionId, mode), { ok: false, status: 'intervention_unavailable', reason: 'state' });
    assert.deepEqual(h.records.readAttachment(executionId), attachment);
    Object.assign(a, old);
  }
  await h.finish(); await h.result(executionId);
  assert.deepEqual(await h.input(executionId, mode), { ok: false, status: 'intervention_unavailable', reason: 'state' });
  assert.deepEqual(await h.input('missing', mode), { ok: false, status: 'intervention_unavailable', reason: 'state' });
});

function inbox(h, executionId, requestId, fields = {}) {
  const dir = join(h.records.dir, 'inbox', executionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${requestId}.json`);
  writeFileSync(path, JSON.stringify({ requestId, executionId, mode: 'queue', text: 'user text\nnext line', at: h.clock.now(), ...fields }), { mode: 0o600 });
  const outcomePath = join(dir, `${requestId}.outcome.json`);
  return { dir, path, outcomePath, outcome: () => JSON.parse(readFileSync(outcomePath, 'utf8')) };
}

for (const mode of ['steer', 'queue', 'interrupt']) test(`inbox ${mode}: tick accepts, records, acknowledges privately and removes request`, async t => {
  const h = setup(t), { executionId } = await h.send();
  const attachment = h.records.readAttachment(executionId);
  const request = inbox(h, executionId, 'request', { mode });
  await h.clock.advance(1000);
  const [input] = h.records.readExecution(executionId).interventions;
  assert.deepEqual(h.records.readExecution(executionId).interventionModes, h.adapter.capabilities.interventions);
  assert.equal(input.from, 'user'); assert.equal(input.mode, mode);
  assert.equal(input.text, 'user text\nnext line');
  assert.deepEqual(request.outcome(), { requestId: 'request', ok: true, status: 'accepted', interventionId: input.id });
  assert.equal(statSync(request.outcomePath).mode & 0o777, 0o600);
  assert.equal(existsSync(request.path), false);
  assert.deepEqual(readdirSync(request.dir), ['request.outcome.json']);
  assert.deepEqual(h.records.readAttachment(executionId), attachment, 'inbox input does not attach the owner');
  await h.clock.advance(1000);
  assert.equal(h.records.readExecution(executionId).interventions.length, 1, 'outcomes are never replayed');
  await h.controller.cancel({ owner: 'child', executionId });
  assert.equal(existsSync(request.dir), false);
});

for (const kind of ['ended', 'unsupported', 'json', 'symlink', 'large file', 'long text', 'identity', 'timestamp']) {
  test(`inbox refuses ${kind} with a visible reason`, async t => {
    const h = setup(t, { default: 'queue', steer: false, queue: 'bridge', interrupt: true });
    let ended;
    if (kind === 'ended') { ended = (await h.send()).executionId; await h.controller.cancel({ owner: 'child', executionId: ended }); }
    const { executionId } = await h.send();
    const request = inbox(h, executionId, 'bad', kind === 'ended' ? { executionId: ended }
      : kind === 'unsupported' ? { mode: 'steer' } : kind === 'long text' ? { text: 'x'.repeat(8001) }
      : kind === 'identity' ? { requestId: '../wrong' } : kind === 'timestamp' ? { at: 'yesterday' } : {});
    if (kind === 'json') writeFileSync(request.path, '{');
    if (kind === 'large file') writeFileSync(request.path, ' '.repeat(65537));
    if (kind === 'symlink') {
      const target = join(h.records.dir, 'private-text'); writeFileSync(target, 'must not be read');
      const { unlinkSync } = await import('node:fs'); unlinkSync(request.path); symlinkSync(target, request.path);
    }
    await h.clock.advance(1000);
    const outcome = request.outcome();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, ({ ended: 'state', unsupported: 'capability', json: 'invalid_request', symlink: 'invalid_file',
      'large file': 'request_too_large', 'long text': 'text_too_long', identity: 'invalid_request', timestamp: 'invalid_request' })[kind]);
    assert.equal(existsSync(request.path), false);
    assert.deepEqual(h.records.readExecution(executionId).interventions, []);
    await h.controller.cancel({ owner: 'child', executionId });
  });
}

test('stop markers take precedence over inbox delivery; close removes outstanding requests and outcomes', async t => {
  for (const stop of ['marker', 'completed']) {
    const h = setup(t), { executionId } = await h.send();
    const request = inbox(h, executionId, 'pending');
    writeFileSync(join(request.dir, 'old.outcome.json'), '{}');
    if (stop === 'marker') h.records._write('stops', 'child', { t: h.clock.now(), source: 'SubagentStop' });
    if (stop === 'completed') await h.finish();
    else await h.clock.advance(1000);
    const result = await h.result(executionId);
    assert.equal(result.cause, { marker: 'owner_stop', completed: 'native_complete' }[stop]);
    assert.equal(result.interventions.length, 0);
    assert.equal(existsSync(request.dir), false);
  }
});

test('inbox cancel is a normal terminal result with user_cancel, even on a cancel-only companion', async t => {
  const h = setup(t, { default: null, steer: false, queue: false, interrupt: false }), { executionId } = await h.send();
  const close = deferred(); h.adapter.close = () => close.promise;
  const request = inbox(h, executionId, 'cancel', { mode: 'cancel', text: undefined });
  const waiting = h.controller.wait({ owner: 'child', executionId });
  await h.clock.advance(1000);
  assert.deepEqual(request.outcome(), { requestId: 'cancel', ok: true, status: 'cancelling' });
  assert.equal(statSync(request.outcomePath).mode & 0o777, 0o600);
  assert.equal(existsSync(request.path), false);
  close.resolve(); await h.clock.flush();
  const result = await waiting;
  assert.equal(result.cause, 'user_cancel'); assert.equal(result.outcome, 'interrupted');
  assert.deepEqual(result.interventions, []);
  assert.equal(existsSync(request.dir), false);
});

test('a completion during user cancel keeps the native answer and the user_cancel cause', async t => {
  const h = setup(t), { executionId } = await h.send();
  h.adapter.interrupt = async () => { void h.finish('completed', 'racing answer'); };
  inbox(h, executionId, 'cancel', { mode: 'cancel', text: undefined });
  const waiting = h.controller.wait({ owner: 'child', executionId });
  await h.clock.advance(1000);
  const result = await waiting;
  assert.equal(result.outcome, 'completed'); assert.equal(result.text, 'racing answer');
  assert.equal(result.cause, 'user_cancel');
});

test('user notice wakes an attached wait before native acknowledgement and reports exactly once', async t => {
  const h = setup(t), { executionId } = await h.send(), gate = deferred();
  h.adapter.steer = () => gate.promise;
  const waiting = h.controller.wait({ owner: 'child', executionId });
  const pending = h.input(executionId, 'steer');
  await h.clock.flush();
  assert.equal(h.controller.requests.size, 0, 'early notice releases the wait');
  const notice = await waiting;
  assert.deepEqual(notice, { status: 'user_intervened', executionId,
    intervention: { from: 'user', mode: 'steer', text: 'new text\nsecond line', at: h.clock.now() } });
  gate.resolve({ accepted: true }); await pending;
  const again = h.controller.wait({ owner: 'child', executionId, timeoutMs: 1000 });
  await h.clock.advance(1000);
  assert.equal((await again).state, 'running');
  await h.controller.cancel({ owner: 'child', executionId });
});

test('user notices accepted before a wait are ordered, persisted, owner-bound and precede a terminal answer', async t => {
  const h = setup(t), { executionId } = await h.send();
  await h.input(executionId, 'queue', { text: 'first' });
  await h.input(executionId, 'queue', { text: 'second' });
  await h.controller.cancel({ owner: 'child', executionId });
  const next = await h.send();
  const fresh = new Controller({ records: new Records({ dir: h.records.dir, log() {} }), clock: h.clock });
  await assert.rejects(fresh.wait({ owner: 'other', executionId }), { code: 'execution_unknown' });
  assert.equal((await fresh.wait({ owner: 'child', executionId })).intervention.text, 'first');
  assert.equal((await h.controller.wait({ owner: 'child', executionId })).intervention.text, 'second');
  assert.equal((await fresh.wait({ owner: 'child', executionId })).outcome, 'interrupted');
  assert.equal((await h.controller.wait({ owner: 'child', executionId })).outcome, 'interrupted');
  await h.controller.cancel({ owner: 'child', executionId: next.executionId });
});

test('collecting an earlier notice is an owner wait; an aborted wait still cancels the job', async t => {
  const h = setup(t), { executionId } = await h.send();
  const sentAt = h.records.readAttachment(executionId).detachedAt;
  await h.clock.advance(2000);
  await h.input(executionId, 'queue');
  assert.equal(h.records.readAttachment(executionId).detachedAt, sentAt, 'user input does not attach the owner');
  assert.equal((await h.controller.wait({ owner: 'child', executionId })).status, 'user_intervened');
  assert.equal(h.records.readAttachment(executionId).detachedAt, h.clock.now(), 'collecting the notice is an owner request');
  await h.input(executionId, 'queue');
  const abort = new AbortController(); abort.abort();
  const result = await h.controller.wait({ owner: 'child', executionId, signal: abort.signal });
  assert.equal(result.cause, 'owner_stop');
});

test('concurrent waits and a timeout boundary never duplicate or lose a user notice', async t => {
  const h = setup(t), { executionId } = await h.send();
  const first = h.controller.wait({ owner: 'child', executionId, timeoutMs: 1000 });
  const second = h.controller.wait({ owner: 'child', executionId, timeoutMs: 2000 });
  h.clock.setTimeout(() => { void h.input(executionId, 'queue'); }, 1000);
  await h.clock.advance(1000);
  assert.equal((await first).state, 'running');
  assert.equal((await second).status, 'user_intervened');
  await h.controller.cancel({ owner: 'child', executionId });
  assert.equal((await h.controller.wait({ owner: 'child', executionId })).outcome, 'interrupted');
});

test('slow inbox acknowledgement is not replayed on later ticks and cannot recreate an inbox after cancel', async t => {
  const h = setup(t), { executionId } = await h.send(), gate = deferred();
  let writes = 0;
  h.adapter.steer = () => { writes++; return gate.promise; };
  const request = inbox(h, executionId, 'slow', { mode: 'steer' });
  const waiting = h.controller.wait({ owner: 'child', executionId });
  await h.clock.advance(1000);
  assert.equal((await waiting).status, 'user_intervened');
  await h.clock.advance(1000);
  assert.equal(writes, 1); assert.equal(existsSync(request.path), true);
  const terminal = h.controller.wait({ owner: 'child', executionId });
  inbox(h, executionId, 'cancel', { mode: 'cancel', text: undefined });
  await h.clock.advance(1000);
  assert.equal((await terminal).cause, 'user_cancel');
  gate.resolve({ accepted: true }); await h.clock.flush();
  assert.equal(existsSync(request.dir), false);
  assert.equal(h.records.readResult(executionId).interventions.length, 1);
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

test('bridge turns without native ids retain separate answers', async t => {
  const h = setup(t), deliver = h.adapter.deliver.bind(h.adapter);
  h.adapter.deliver = async args => { await deliver(args); return { acknowledged: true, nativeTurnId: null }; };
  const { executionId } = await h.send();
  await h.input(executionId, 'queue');
  await h.finish('completed', 'first');
  await h.finish('completed', 'second');
  const result = await h.result(executionId);
  assert.deepEqual(result.turns.map(t => [t.nativeTurnId, t.text]), [[null, 'first'], [null, 'second']]);
  assert.deepEqual(result.nativeTurnIds, []);
  assert.match(result.text, /Task\n\nfirst/); assert.match(result.text, /queued.*\n\nsecond/);
});

test('user intervention does not attach the owner; held input is not delivered after an owner stop', async t => {
  const h = setup(t), { executionId } = await h.send();
  await h.clock.advance(2000); const attachment = h.records.readAttachment(executionId);
  await h.input(executionId, 'queue'); assert.deepEqual(h.records.readAttachment(executionId), attachment);
  h.records._write('stops', 'child', { t: h.clock.now(), source: 'SubagentStop' });
  await h.clock.advance(1000); const result = await h.result(executionId);
  assert.equal(result.cause, 'owner_stop'); assert.equal(result.interventions[0].state, 'not_delivered');
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
