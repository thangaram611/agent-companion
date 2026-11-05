import './sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../bridge-server/controller/controller.mjs';
import { Records } from '../bridge-server/controller/records.mjs';
import { createBridgeController, recoverController } from '../bridge-server/server.mjs';
import { codexDispatchFixture, diskSnapshot, terminalRows } from './controller/codex-dispatch-fixture.mjs';
import { until } from './controller/helpers.mjs';
import { note } from './codex-wire-frames.mjs';

// Phase 3 mapping: a wait budget is not an execution timeout. Only owner lease
// expiry closes work, and a stopped result requires verified process absence.
test('CONTRACT: timeout must stop work or avoid claiming process termination', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  const waiting = h.call({ action: 'wait', thread: 'child', job_id, max_wait_sec: 1 });
  await until(() => h.active.requests.size === 1, 'attached wait');
  await h.clock.advance(1000);
  const response = await waiting;
  assert.equal(response.status, 'still_running');
  assert.equal(response.stop_evidence, undefined);
  assert.doesNotMatch(JSON.stringify(response), /terminated|stopped/);
  assert.equal(h.records.readResult(job_id), null);
  assert.equal((await h.active.live.get(job_id).supervisor.verifyGone()).gone, false);
  await h.clock.advance(3000);
  await until(() => h.records.readResult(job_id), 'lease cleanup');
  const result = h.records.readResult(job_id);
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.cause, 'owner_lease_expired');
  assert.equal(result.stopEvidence.gone, true);
  assert.deepEqual(result.stopEvidence.survivors, []);
  const terminal = await h.call({ action: 'wait', thread: 'child', job_id });
  assert.equal(terminal.meta.stop_evidence.gone, true);
});

// Phase 3 mapping: new work on a busy conversation is an explicit refusal;
// it does not silently attach to, replace, or steer the original native turn.
test('CONTRACT: new instructions must be delivered or explicitly rejected while native turn is active', async (t) => {
  const h = codexDispatchFixture(t);
  const first = await h.send();
  const refused = await h.send('NEW_DECISION_MUST_REACH_PROVIDER');
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 'thread_busy');
  assert.equal(refused.job_id, first.job_id);
  assert.deepEqual(h.frames().filter((f) => f.method === 'turn/start').map((f) => f.params.input[0].text), ['original']);
  assert.equal(h.frames().some((f) => f.method === 'turn/steer'), false);
});

// Phase 3 mapping: refusal allocates no execution; the old answer remains
// attributable only to the original execution id, including its queue event.
test('CONTRACT: old native answer must not be labeled the successful result of an undelivered new task', async (t) => {
  const h = codexDispatchFixture(t);
  const first = await h.send();
  assert.equal((await h.send('undelivered')).status, 'thread_busy');
  await h.complete(first.job_id, 'OLD_ANSWER');
  const result = await h.call({ action: 'wait', thread: 'child', job_id: first.job_id });
  assert.equal(result.status, 'completed');
  assert.equal(result.job_id, first.job_id);
  assert.equal(result.content, 'OLD_ANSWER');
  assert.deepEqual(h.records.listExecutions().map((e) => [e.executionId, e.text]), [[first.job_id, 'original']]);
  assert.equal(terminalRows(first.job_id).length, 1);
  assert.equal(terminalRows(first.job_id)[0].meta.job_id, first.job_id);
});

async function retryFixture(t) {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  await h.emit(job_id, [note('error', { threadId: 'T1', turnId: 'TURN1', willRetry: true,
    error: { message: 'Reconnecting... 2/5', codexErrorInfo: 'internalServerError', additionalDetails: null } })]);
  return { ...h, job_id };
}
// Phase 3 mapping: schema-validated retry frames remain native progress.
test('CONTRACT: willRetry:true must not settle the bridge job before native terminal', async (t) => {
  const h = await retryFixture(t);
  const status = await h.call({ action: 'status', job_id: h.job_id });
  assert.equal(status.status, 'running');
  assert.equal(status.retry.willRetry, true);
  assert.equal(h.records.readResult(h.job_id), null);
  assert.equal(h.records.readExecution(h.job_id).terminal, undefined);
  assert.equal(terminalRows(h.job_id).length, 0);
});
// Phase 3 mapping: the later native completion, rather than the retry error,
// becomes the durable result and remains observable on repeated waits.
test('CONTRACT: a recovered native answer must remain observable after a retryable error', async (t) => {
  const h = await retryFixture(t);
  await h.complete(h.job_id, 'RECOVERED_AND_FINISHED');
  for (let i = 0; i < 2; i++) {
    const result = await h.call({ action: 'wait', thread: 'child', job_id: h.job_id });
    assert.equal(result.status, 'completed');
    assert.equal(result.content, 'RECOVERED_AND_FINISHED');
  }
});

// Phase 3 mapping: a second controller reads the shared records but neither
// adopts the runtime nor renews the owner's lease nor writes a digest.
test('CONTRACT: a status-only second bridge must not recover a live owner job', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  const second = new Controller({ records: new Records({ dir: h.records.dir }), clock: h.clock });
  const before = diskSnapshot();
  const lease = h.records.readLease(job_id);
  const status = await h.call({ action: 'status', job_id }, {}, second);
  assert.equal(status.status, 'unknown');
  assert.deepEqual(diskSnapshot(), before);
  assert.deepEqual(second.records.readLease(job_id), lease);
  assert.equal(second.live.size, 0);
  assert.equal(second.requests.size, 0);
  assert.equal(h.active.live.size, 1);
  assert.equal(h.frames().filter((f) => f.method === 'turn/start').length, 1);
});

// Phase 3 mapping: results are immutable even within the same generation;
// after a follow-up, every stale-generation write is fenced by shared records.
test('CONTRACT: an older observer must not overwrite an already persisted terminal result', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  const logs = [];
  const second = new Controller({ records: new Records({ dir: h.records.dir, log: (row) => logs.push(row) }) });
  const stale = second.records.readExecution(job_id);
  await h.complete(job_id);
  const result = h.records.readResult(job_id);
  assert.equal(second.records.writeResult({ ...result, outcome: 'failed' }), false);
  const next = await h.send('follow-up');
  assert.notEqual(next.job_id, job_id);
  assert.equal(second.records.writeExecution(stale), false);
  assert.equal(second.records.writeResult({ ...result, outcome: 'failed' }), false);
  assert.equal(logs.filter((r) => r.code === 'stale_generation').length, 2);
  assert.deepEqual(h.records.readResult(job_id), result);
});

// Phase 3 mapping: durable completion receipts deduplicate publications from
// repeated waits and startup reconciliation, including after the queue drains.
test('CONTRACT: one native job must publish at most one terminal event across observers', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  await h.complete(job_id);
  await h.call({ action: 'wait', thread: 'child', job_id });
  const second = createBridgeController({ records: new Records({ dir: h.records.dir }), env: h.env });
  await recoverController(second);
  await h.call({ action: 'wait', thread: 'child', job_id }, {}, second);
  await recoverController(second);
  assert.equal(terminalRows(job_id).length, 1);
  assert.equal(terminalRows(job_id)[0].consumed, true);
  assert.deepEqual(second.records.read('completions', job_id), { executionId: job_id });
});

// Phase 3 mapping: expose the native event timestamp, not total job age.
test('CONTRACT: status inactivity must reflect the just-received provider event', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  await h.clock.advance(1000);
  await h.emit(job_id, [note('item/agentMessage/delta', { threadId: 'T1', turnId: 'TURN1', itemId: 'part', delta: 'FRESH_EVENT' })]);
  const status = await h.call({ action: 'status', job_id });
  assert.equal(status.last_native_activity, h.clock.now());
  assert.notEqual(status.last_native_activity, h.records.readExecution(job_id).startedAt);
  assert.equal(status.partial_text, 'FRESH_EVENT');
});

// Phase 3 mapping: snapshot all sandbox state, including records, lease,
// digest, completion queue and file mtimes, across the job-specific handler.
test('CONTRACT: the job-specific status handler must be read-only', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  const before = diskSnapshot();
  for (let i = 0; i < 3; i++) assert.equal((await h.call({ action: 'status', job_id })).status, 'running');
  assert.deepEqual(diskSnapshot(), before);
});

// The six old controls described the legacy defects themselves. These instead
// establish the new fixture's transport, delivery, ownership and cleanup facts.
test('CONTROL: sandbox-addressed transport starts only the fake Codex binary', async (t) => {
  const h = codexDispatchFixture(t);
  await h.send();
  assert.deepEqual(h.spawns, [[h.bin, 'app-server']]);
  assert.ok(h.records.dir.startsWith(h.dir));
  assert.ok(h.frames().some((f) => f.method === 'initialize'));
});
test('CONTROL: duplicate send reattaches without a second native start', async (t) => {
  const h = codexDispatchFixture(t);
  assert.equal((await h.send()).job_id, (await h.send()).job_id);
  assert.equal(h.frames().filter((f) => f.method === 'turn/start').length, 1);
});
test('CONTROL: fake server rejects frames outside the pinned wire schema', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  await assert.rejects(h.emit(job_id, [{ method: 'error', params: {} }]), /refuses a frame/);
});
test('CONTROL: native completion preserves text and verified exit', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  await h.complete(job_id);
  const result = h.records.readResult(job_id);
  assert.equal(result.text, 'native answer');
  assert.equal(result.stopEvidence.gone, true);
  assert.equal(h.active.live.size, 0);
});
test('CONTROL: dispatch cancel interrupts the fake turn and verifies exit', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  const result = await h.call({ action: 'cancel', thread: 'child', job_id });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.meta.cause, 'owner_stop');
  assert.equal(result.meta.stop_evidence.gone, true);
  assert.equal(h.frames().filter((f) => f.method === 'turn/interrupt').length, 1);
});
test('CONTROL: a second bridge has independent controller and records instances', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  const records = new Records({ dir: h.records.dir });
  const second = new Controller({ records });
  assert.notEqual(second.records, h.records);
  assert.notEqual(second.live, h.active.live);
  assert.deepEqual(second.records.readExecution(job_id), h.records.readExecution(job_id));
});
