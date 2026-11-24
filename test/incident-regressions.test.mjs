import './sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../bridge-server/controller/controller.mjs';
import { Records } from '../bridge-server/controller/records.mjs';
import { codexDispatchFixture } from './controller/codex-dispatch-fixture.mjs';
import { diskSnapshot, until } from './controller/helpers.mjs';
import { note } from './codex-wire-frames.mjs';

// Phase 3 mapping: a wait budget is not a job timeout. Silence never
// closes work: a cancel does, and a stopped result requires verified process absence.
test('CONTRACT: timeout must stop work or avoid claiming process termination', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  const waiting = h.call({ action: 'wait', job_id, max_wait_sec: 1 });
  await h.clock.advance(1000);
  const response = await waiting;
  assert.equal(response.status, 'still_running');
  assert.equal(response.stop_evidence, undefined);
  assert.doesNotMatch(JSON.stringify(response), /terminated|stopped/);
  assert.equal(h.records.readResult(job_id), null);
  assert.equal((await h.active.live.get(job_id).supervisor.verifyGone()).gone, false);
  await h.clock.advance(3_600_000);
  assert.equal(h.records.readResult(job_id), null, 'an hour of owner silence closes nothing');
  await h.call({ action: 'cancel', job_id });
  await until(() => h.records.readResult(job_id), 'cancel cleanup');
  const result = h.records.readResult(job_id);
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.cause, 'owner_stop');
  assert.equal(result.stopEvidence.gone, true);
  assert.deepEqual(result.stopEvidence.survivors, []);
  const terminal = await h.call({ action: 'wait', job_id });
  assert.equal(terminal.meta.stop_evidence.gone, true);
});

// Phase 3 mapping: refusal allocates no job; the old answer remains
// attributable only to the original job id, including its metadata.
test('CONTRACT: old native answer must not be labeled the successful result of an undelivered new task', async (t) => {
  const h = codexDispatchFixture(t);
  const first = await h.send();
  assert.equal((await h.call({ action: 'send', thread: first.thread, task: 'undelivered', model: 'other' })).status, 'thread_busy');
  await h.complete(first.job_id, 'OLD_ANSWER');
  const result = await h.call({ action: 'wait', job_id: first.job_id });
  assert.equal(result.status, 'completed');
  assert.equal(result.job_id, first.job_id);
  assert.equal(result.job_id, first.job_id);
  assert.equal(result.content, 'OLD_ANSWER');
  assert.deepEqual(h.records.listJobs().map((e) => [e.jobId, e.text]), [[first.job_id, 'original']]);
});

async function retryFixture(t) {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  await h.emit(job_id, [note('error', { threadId: 'T1', turnId: 'TURN1', willRetry: true,
    error: { message: 'Reconnecting... 2/5', codexErrorInfo: 'internalServerError', additionalDetails: null } })]);
  return { ...h, job_id };
}
// Phase 3 mapping: the later native completion, rather than the retry error,
// becomes the durable result and remains observable on repeated waits.
test('CONTRACT: a recovered native answer must remain observable after a retryable error', async (t) => {
  const h = await retryFixture(t);
  await h.complete(h.job_id, 'RECOVERED_AND_FINISHED');
  for (let i = 0; i < 2; i++) {
    const result = await h.call({ action: 'wait', job_id: h.job_id });
    assert.equal(result.status, 'completed');
    assert.equal(result.content, 'RECOVERED_AND_FINISHED');
  }
});

// Phase 3 mapping: results are immutable even within the same generation;
// after a follow-up, every stale-generation write is fenced by shared records.
test('CONTRACT: an older observer must not overwrite an already persisted terminal result', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  const logs = [];
  const second = new Controller({ records: new Records({ dir: h.records.dir, log: (row) => logs.push(row) }) });
  const stale = second.records.readJob(job_id);
  await h.complete(job_id);
  const result = h.records.readResult(job_id);
  assert.equal(second.records.writeResult({ ...result, outcome: 'failed' }), false);
  const next = await h.send('follow-up', stale.thread);
  assert.notEqual(next.job_id, job_id);
  assert.equal(second.records.writeJob(stale), false);
  assert.equal(second.records.writeResult({ ...result, outcome: 'failed' }), false);
  assert.equal(logs.filter((r) => r.code === 'stale_generation').length, 2);
  assert.deepEqual(h.records.readResult(job_id), result);
});

// Phase 3 mapping: expose the native event timestamp, not total job age.
test('CONTRACT: status inactivity must reflect the just-received provider event', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id } = await h.send();
  await h.clock.advance(1000);
  await h.emit(job_id, [note('item/agentMessage/delta', { threadId: 'T1', turnId: 'TURN1', itemId: 'part', delta: 'FRESH_EVENT' })]);
  const status = await h.call({ action: 'status', job_id });
  assert.equal(status.last_native_activity, h.clock.now());
  assert.notEqual(status.last_native_activity, h.records.readJob(job_id).startedAt);
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
  const result = await h.call({ action: 'cancel', job_id });
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
  assert.deepEqual(second.records.readJob(job_id), h.records.readJob(job_id));
});
