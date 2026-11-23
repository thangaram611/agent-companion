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
    if (id === records.readThread('child').jobId) return;
    assert.equal(records.readJob(records.readThread('child').jobId).interventions.find(i => i.id === id)?.state, 'accepted');
  };
  const adapter = fakeAdapter({ capabilities: { interventions }, beforeSend, history: { historyId: 'same-session' },
    interruptResult: { outcome: 'interrupted', text: 'partial must disappear' } });
  const { controller, records, clock, send } = setupController({ adapter });
  t.after(() => { for (const a of controller.live.values()) clock.clearTimeout(a.timer); });
  const input = (jobId, mode, extra = {}) => controller.intervene({ jobId, from: 'user', mode, text: 'new text\nsecond line', ...extra });
  const finish = async (outcome = 'completed', text = 'answer', messages, next = false) => {
    adapter.finishTurn({ outcome, text, ...(messages ? { messages } : {}) }, next);
    await clock.flush();
  };
  const result = jobId => waitForResult(controller, { thread: 'child', jobId });
  return { controller, records, clock, adapter, send: () => send({ text: 'original task' }), input, finish, result,
    get calls() { return adapter.calls.map(([name, args]) => [name, args?.text]); } };
}

for (const steer of [false, true]) for (const queue of [false, 'native', 'bridge']) for (const interrupt of [false, true]) {
  for (const mode of ['steer', 'queue', 'interrupt']) test(`mode ${mode}, capabilities ${JSON.stringify({ steer, queue, interrupt })}`, async t => {
    const h = setup(t, { steer, queue, interrupt }), { jobId } = await h.send();
    const answer = await h.input(jobId, mode);
    if (!{ steer, queue, interrupt }[mode]) {
      assert.deepEqual(answer, { ok: false, status: 'intervention_unavailable', reason: 'capability' });
      assert.deepEqual(h.records.readJob(jobId).interventions, []);
    } else {
      assert.equal(answer.ok, true);
      const [saved] = h.records.readJob(jobId).interventions;
      assert.equal(saved.from, 'user'); assert.equal(saved.mode, mode); assert.equal(saved.text, 'new text\nsecond line');
      assert.equal(typeof saved.id, 'string'); assert.equal(typeof saved.at, 'number');
    }
    await h.controller.cancel({ thread: 'child', jobId });
  });
}

for (const mode of ['steer', 'queue', 'interrupt']) test(`${mode} refuses unavailable states without recording input`, async t => {
  const h = setup(t), { jobId } = await h.send(), a = h.controller.live.get(jobId);
  for (const fields of [{ record: { state: 'starting' } }, { record: { state: 'delivering' } }, { record: { terminal: {} } },
    { stopping: true }, { closed: true }, { handedOff: true }]) {
    const old = { ...a, record: { ...a.record } };
    Object.assign(a, { ...fields, record: { ...a.record, ...fields.record } });
    assert.deepEqual(await h.input(jobId, mode), { ok: false, status: 'intervention_unavailable', reason: 'state' });
    assert.deepEqual(h.records.readJob(jobId).interventions, []);
    Object.assign(a, old);
  }
  await h.finish(); await h.result(jobId);
  assert.deepEqual(await h.input(jobId, mode), { ok: false, status: 'intervention_unavailable', reason: 'state' });
  assert.deepEqual(await h.input('missing', mode), { ok: false, status: 'intervention_unavailable', reason: 'state' });
});

function inbox(h, jobId, requestId, fields = {}) {
  const dir = join(h.records.dir, 'inbox', jobId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${requestId}.json`);
  writeFileSync(path, JSON.stringify({ requestId, jobId, mode: 'queue', text: 'user text\nnext line', at: h.clock.now(), ...fields }), { mode: 0o600 });
  const outcomePath = join(dir, `${requestId}.outcome.json`);
  return { dir, path, outcomePath, outcome: () => JSON.parse(readFileSync(outcomePath, 'utf8')) };
}

for (const mode of ['steer', 'queue', 'interrupt']) test(`inbox ${mode}: tick accepts, records, acknowledges privately and removes request`, async t => {
  const h = setup(t), { jobId } = await h.send();
  const request = inbox(h, jobId, 'request', { mode });
  await h.clock.advance(1000);
  const [input] = h.records.readJob(jobId).interventions;
  assert.deepEqual(h.records.readJob(jobId).interventionModes, h.adapter.capabilities.interventions);
  assert.equal(input.from, 'user'); assert.equal(input.mode, mode);
  assert.equal(input.text, 'user text\nnext line');
  assert.deepEqual(request.outcome(), { requestId: 'request', ok: true, status: 'accepted', interventionId: input.id });
  assert.equal(statSync(request.outcomePath).mode & 0o777, 0o600);
  assert.equal(existsSync(request.path), false);
  assert.deepEqual(readdirSync(request.dir), ['request.outcome.json']);
  await h.clock.advance(1000);
  assert.equal(h.records.readJob(jobId).interventions.length, 1, 'outcomes are never replayed');
  await h.controller.cancel({ thread: 'child', jobId });
  assert.equal(existsSync(request.dir), false);
});

for (const kind of ['ended', 'unsupported', 'json', 'symlink', 'large file', 'long text', 'identity', 'timestamp']) {
  test(`inbox refuses ${kind} with a visible reason`, async t => {
    const h = setup(t, { default: 'queue', steer: false, queue: 'bridge', interrupt: true });
    let ended;
    if (kind === 'ended') { ended = (await h.send()).jobId; await h.controller.cancel({ thread: 'child', jobId: ended }); }
    const { jobId } = await h.send();
    const request = inbox(h, jobId, 'bad', kind === 'ended' ? { jobId: ended }
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
    assert.deepEqual(h.records.readJob(jobId).interventions, []);
    await h.controller.cancel({ thread: 'child', jobId });
  });
}

test('native completion removes outstanding inbox requests and outcomes', async t => {
  const h = setup(t), { jobId } = await h.send();
  const request = inbox(h, jobId, 'pending');
  writeFileSync(join(request.dir, 'old.outcome.json'), '{}');
  await h.finish();
  assert.equal((await h.result(jobId)).interventions.length, 0);
  assert.equal(existsSync(request.dir), false);
});

test('inbox cancel is a normal terminal result with user_cancel, even on a cancel-only companion', async t => {
  const h = setup(t, { default: null, steer: false, queue: false, interrupt: false }), { jobId } = await h.send();
  const close = deferred(); h.adapter.close = () => close.promise;
  const request = inbox(h, jobId, 'cancel', { mode: 'cancel', text: undefined });
  const waiting = h.controller.wait({ thread: 'child', jobId });
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
  const h = setup(t), { jobId } = await h.send();
  h.adapter.interrupt = async () => { void h.finish('completed', 'racing answer'); };
  inbox(h, jobId, 'cancel', { mode: 'cancel', text: undefined });
  const waiting = h.controller.wait({ thread: 'child', jobId });
  await h.clock.advance(1000);
  const result = await waiting;
  assert.equal(result.outcome, 'completed'); assert.equal(result.text, 'racing answer');
  assert.equal(result.cause, 'user_cancel');
});

test('user notice wakes a pending wait before native acknowledgement and reports exactly once', async t => {
  const h = setup(t), { jobId } = await h.send(), gate = deferred();
  h.adapter.steer = () => gate.promise;
  const waiting = h.controller.wait({ thread: 'child', jobId });
  const pending = h.input(jobId, 'steer');
  await h.clock.flush();
  const notice = await waiting;
  assert.deepEqual(notice, { status: 'user_intervened', jobId,
    intervention: { from: 'user', mode: 'steer', text: 'new text\nsecond line', at: h.clock.now() } });
  gate.resolve({ accepted: true }); await pending;
  const again = h.controller.wait({ thread: 'child', jobId, timeoutMs: 1000 });
  await h.clock.advance(1000);
  assert.equal((await again).state, 'running');
  await h.controller.cancel({ thread: 'child', jobId });
});

test('user notices accepted before a wait are ordered, persisted, owner-bound and precede a terminal answer', async t => {
  const h = setup(t), { jobId } = await h.send();
  await h.input(jobId, 'queue', { text: 'first' });
  await h.input(jobId, 'queue', { text: 'second' });
  await h.controller.cancel({ thread: 'child', jobId });
  const next = await h.send();
  const fresh = new Controller({ records: new Records({ dir: h.records.dir, log() {} }), clock: h.clock });
  await assert.rejects(fresh.wait({ thread: 'other', jobId }), { code: 'execution_unknown' });
  assert.equal((await fresh.wait({ thread: 'child', jobId })).intervention.text, 'first');
  assert.equal((await h.controller.wait({ thread: 'child', jobId })).intervention.text, 'second');
  assert.equal((await fresh.wait({ thread: 'child', jobId })).outcome, 'interrupted');
  assert.equal((await h.controller.wait({ thread: 'child', jobId })).outcome, 'interrupted');
  await h.controller.cancel({ thread: 'child', jobId: next.jobId });
});

test('a pre-aborted wait leaves a pending user notice for the next wait', async t => {
  const h = setup(t), { jobId } = await h.send();
  await h.input(jobId, 'queue');
  assert.equal((await h.controller.wait({ thread: 'child', jobId, signal: AbortSignal.abort() })).state, 'running');
  assert.equal((await h.controller.wait({ thread: 'child', jobId })).status, 'user_intervened');
});

test('concurrent waits and a timeout boundary never duplicate or lose a user notice', async t => {
  const h = setup(t), { jobId } = await h.send();
  const first = h.controller.wait({ thread: 'child', jobId, timeoutMs: 1000 });
  const second = h.controller.wait({ thread: 'child', jobId, timeoutMs: 2000 });
  h.clock.setTimeout(() => { void h.input(jobId, 'queue'); }, 1000);
  await h.clock.advance(1000);
  assert.equal((await first).state, 'running');
  assert.equal((await second).status, 'user_intervened');
  await h.controller.cancel({ thread: 'child', jobId });
  assert.equal((await h.controller.wait({ thread: 'child', jobId })).outcome, 'interrupted');
});

test('slow inbox acknowledgement is not replayed on later ticks and cannot recreate an inbox after cancel', async t => {
  const h = setup(t), { jobId } = await h.send(), gate = deferred();
  let writes = 0;
  h.adapter.steer = () => { writes++; return gate.promise; };
  const request = inbox(h, jobId, 'slow', { mode: 'steer' });
  const waiting = h.controller.wait({ thread: 'child', jobId });
  await h.clock.advance(1000);
  assert.equal((await waiting).status, 'user_intervened');
  await h.clock.advance(1000);
  assert.equal(writes, 1); assert.equal(existsSync(request.path), true);
  const terminal = h.controller.wait({ thread: 'child', jobId });
  inbox(h, jobId, 'cancel', { mode: 'cancel', text: undefined });
  await h.clock.advance(1000);
  assert.equal((await terminal).cause, 'user_cancel');
  gate.resolve({ accepted: true }); await h.clock.flush();
  assert.equal(existsSync(request.dir), false);
  assert.equal(h.records.readResult(jobId).interventions.length, 1);
});

test('bridge queue stays held until a successful boundary; answers and ids are ordered once', async t => {
  const h = setup(t), { jobId } = await h.send();
  await h.input(jobId, 'queue');
  const [input] = h.records.readJob(jobId).interventions;
  assert.equal(input.state, 'accepted'); assert.equal(h.calls.filter(c => c[0] === 'deliver').length, 1);
  await h.finish('completed', 'first answer');
  assert.deepEqual(h.calls.filter(c => c[0] === 'deliver'), [['deliver', 'original task'], ['deliver', 'new text\nsecond line']]);
  assert.equal(h.records.readResult(jobId), null);
  await h.finish('completed', 'second answer');
  const result = await h.result(jobId);
  assert.deepEqual(result.nativeTurnIds, ['turn-1', 'turn-2']);
  assert.deepEqual(result.turns.map(t => t.messages), [[jobId], [input.id]]);
  assert.equal(result.interventions[0].state, 'answered');
  assert.equal(result.text, "Task\n\nfirst answer\n\nUser's message (queued): new text\n\nsecond answer");
});

test('bridge turns without native ids retain separate answers', async t => {
  const h = setup(t), deliver = h.adapter.deliver.bind(h.adapter);
  h.adapter.deliver = async args => { await deliver(args); return { acknowledged: true, nativeTurnId: null }; };
  const { jobId } = await h.send();
  await h.input(jobId, 'queue');
  await h.finish('completed', 'first');
  await h.finish('completed', 'second');
  const result = await h.result(jobId);
  assert.deepEqual(result.turns.map(t => [t.nativeTurnId, t.text]), [[null, 'first'], [null, 'second']]);
  assert.deepEqual(result.nativeTurnIds, []);
  assert.match(result.text, /Task\n\nfirst/); assert.match(result.text, /queued.*\n\nsecond/);
});

test('explicit cancellation discards held user input', async t => {
  const h = setup(t), { jobId } = await h.send();
  await h.input(jobId, 'queue');
  const result = await h.controller.cancel({ thread: 'child', jobId });
  assert.equal(result.cause, 'owner_stop'); assert.equal(result.interventions[0].state, 'not_delivered');
});

for (const queue of ['bridge', 'native']) test(`${queue} pending input behind a failed turn is not delivered`, async t => {
  const h = setup(t, { queue }), { jobId } = await h.send();
  await h.input(jobId, 'queue'); await h.finish('failed', 'failed answer');
  const result = await h.result(jobId);
  assert.equal(result.outcome, 'failed'); assert.equal(result.interventions[0].state, 'not_delivered');
  assert.equal(h.calls.filter(c => c[0] === 'deliver').length, 1);
});

test('interrupt ends the old turn and sends only the new message on the live session', async t => {
  const h = setup(t), { jobId } = await h.send();
  await h.input(jobId, 'interrupt'); await h.clock.flush();
  await h.finish('completed', 'new answer'); const result = await h.result(jobId);
  assert.deepEqual(result.turns.map(t => t.outcome), ['interrupted', 'completed']);
  assert.equal(result.turns[0].text, 'interrupted before answering');
  assert.doesNotMatch(result.text, /partial must disappear/);
  assert.deepEqual(h.calls.filter(c => c[0] === 'deliver'), [['deliver', 'original task'], ['deliver', 'new text\nsecond line']]);
});

test('native queued message keeps the job observing without a second delivery', async t => {
  const h = setup(t, { queue: 'native' }), { jobId } = await h.send();
  await h.input(jobId, 'queue'); const [input] = h.records.readJob(jobId).interventions;
  await h.finish('completed', 'first', [jobId], true);
  assert.equal(h.records.readResult(jobId), null);
  await h.finish('completed', 'second', [input.id]);
  const result = await h.result(jobId);
  assert.equal(result.turns.length, 2); assert.equal(result.interventions[0].state, 'answered');
  assert.equal(h.calls.filter(c => c[0] === 'deliver').length, 1);
});

for (const stop of ['cancel', 'bridgeLost']) test(`${stop} marks held messages not_delivered`, async t => {
  const h = setup(t), { jobId } = await h.send(); await h.input(jobId, 'queue');
  await h.controller[stop]({ thread: 'child', jobId });
  assert.equal(h.records.readJob(jobId).interventions[0].state, 'not_delivered');
  assert.equal(h.calls.filter(c => c[0] === 'deliver').length, 1);
});

test('failed steered turn appears once and its unanswered steer is not_delivered', async t => {
  const h = setup(t), { jobId } = await h.send();
  await h.input(jobId, 'steer'); await h.finish('failed', 'provider failed');
  const result = await h.result(jobId);
  assert.equal(result.turns.length, 1); assert.equal(result.turns[0].outcome, 'failed');
  assert.equal(result.interventions[0].state, 'not_delivered');
});

test('interrupt takes priority over held queues without dropping or reversing them', async t => {
  const h = setup(t), { jobId } = await h.send();
  await h.input(jobId, 'queue', { text: 'first queued' });
  await h.input(jobId, 'queue', { text: 'second queued' });
  await h.input(jobId, 'interrupt', { text: 'urgent' }); await h.clock.flush();
  await h.finish(); await h.finish(); await h.finish();
  const result = await h.result(jobId);
  assert.equal(result.turns.length, 4);
  assert.deepEqual(h.calls.filter(c => c[0] === 'deliver').map(c => c[1]), ['original task', 'urgent', 'first queued', 'second queued']);
  assert.ok(result.interventions.every(i => i.state === 'answered'));
});

test('a rejected steer never joins the answer and accepted input is persisted as not_delivered', async t => {
  const h = setup(t), { jobId } = await h.send();
  h.adapter.steer = async () => { throw new Error('native steer refused'); };
  await assert.rejects(h.input(jobId, 'steer'), /native steer refused/);
  await h.finish(); const result = await h.result(jobId);
  assert.deepEqual(result.turns[0].messages, [jobId]);
  assert.equal(result.interventions[0].state, 'not_delivered');
});

test('caller ownership and aborted requests are checked before accepting input', async t => {
  const h = setup(t), { jobId } = await h.send();
  await assert.rejects(h.input(jobId, 'queue', { from: 'caller' }), { code: 'NATIVE_OWNER_REQUIRED' });
  await assert.rejects(h.input(jobId, 'queue', { from: 'caller', thread: 'other' }), { code: 'execution_unknown' });
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await h.input(jobId, 'queue', { from: 'caller', thread: 'child', signal: abort.signal }),
    { ok: false, status: 'intervention_unavailable', reason: 'state' });
  const view = h.controller.status({ jobId });
  assert.equal(view.state, 'running');
  assert.deepEqual(view.job.interventions, []);
});

test('a failed native turn closes without waiting for an outstanding input acknowledgement', async t => {
  const h = setup(t, { queue: 'native' }), { jobId } = await h.send(), receipt = deferred();
  h.adapter.intervene = () => receipt.promise;
  const input = h.input(jobId, 'queue'); await h.clock.flush();
  await h.finish('failed', 'failed before queued input');
  const result = h.records.readResult(jobId);
  receipt.resolve({ accepted: true }); await input;
  assert.equal(result?.outcome, 'failed');
  assert.equal(result.interventions[0].state, 'not_delivered');
  assert.deepEqual(h.records.readResult(jobId), result, 'a late receipt cannot rewrite the terminal result');
});

test('stop preserves a native joined message in the interrupted turn without partial text', async t => {
  const h = setup(t, { queue: 'native' }), { jobId } = await h.send();
  await h.input(jobId, 'queue'); const [input] = h.records.readJob(jobId).interventions;
  h.adapter.onInput({ id: input.id, state: 'joined', nativeTurnId: 'turn-1' });
  const result = await h.controller.cancel({ thread: 'child', jobId });
  assert.equal(result.turns.length, 1);
  assert.deepEqual(result.turns[0].messages, [jobId, input.id]);
  assert.equal(result.turns[0].text, 'interrupted before answering');
  assert.equal(result.interventions[0].state, 'not_delivered');
});

test('result projections: one turn stays unlabelled; several are labelled for the caller with a short first line, and usage sums the turns', () => {
  const long = 'x'.repeat(120);
  const job = { jobId: 'job', terminal: { text: 'last', usage: { input_tokens: 5 } },
    interventions: [{ id: 'u', from: 'user', mode: 'queue', text: `${long}\nmore` }, { id: 'c', from: 'caller', mode: 'interrupt', text: 'stop and do y' }],
    turns: [{ messages: ['job'], outcome: 'completed', text: 'first', usage: { source: 'fake', input_tokens: 1, output_tokens: 2 } },
      { messages: ['u'], outcome: 'interrupted', text: 'partial' },
      { messages: ['c'], outcome: 'completed', text: 'last', usage: { source: 'fake', input_tokens: 3, output_tokens: 4 } }] };
  assert.equal(resultText(job), `Task\n\nfirst\n\nUser's message (queued): ${'x'.repeat(79)}…\n\ninterrupted before answering\n\nCaller's message (interrupt): stop and do y\n\nlast`);
  const usage = resultUsage(job);
  assert.equal(usage.input_tokens, 4); assert.equal(usage.output_tokens, 6);
  const single = { ...job, turns: job.turns.slice(0, 1) };
  assert.equal(resultText(single), 'last');
  assert.deepEqual(resultUsage(single), { input_tokens: 5 });
});
