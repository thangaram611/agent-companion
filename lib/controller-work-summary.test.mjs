import '../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotWorktree } from './worktree-snapshot.mjs';
import { callTool, testLead } from '../test/tool-call.mjs';
import { setupController, deferred, until } from '../test/controller/helpers.mjs';
function setup(t, { companion = 'codex', ack = { nativeTurnId: 'turn-1' }, late = false, unreadable = false, gone = true, snapshot } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'controller-summary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = companion === 'copilot' ? join(dir, 'session-state/history/events.jsonl') : join(dir, 'rollout.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  const write = () => writeFileSync(path, companion === 'copilot'
    ? readFileSync(new URL('../test/fixtures/transcripts/copilot/failure.jsonl', import.meta.url))
    : [ { type: 'session_meta', payload: { cli_version: '0.169.0' } },
      { type: 'turn_context', payload: { turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'CommandExecution', id: 'cmd', command: ['echo ok'], status: 'completed', exit_code: 0 } } },
    ].map(r => JSON.stringify(r) + '\n').join(''));
  if (!late) write();
  const h = setupController({ dir: join(dir, 'records'), companion, ack, gone, snapshot: snapshot ?? snapshotWorktree,
    history: { historyId: 'history', nativeRefs: { transcriptPath: path } },
    env: { ...process.env, HOME: dir, COPILOT_HOME: dir },
    onTerminate() {
      h.adapters[0].calls.push(['terminate']);
      if (late) write();
      if (unreadable) rmSync(path);
    },
  });
  return { ...h, path, send: () => h.send({ cwd: dir, text: 'task', lead: testLead }), finish: sent => h.finish(sent.jobId),
    get events() { return h.adapters[0]?.calls.map(([name]) => name) ?? []; } };
}
for (const late of [false, true]) test(`summary is immutable and exposed by repeated waits; terminal locator retry=${late}`, async t => {
  const h = setup(t, { late }); const sent = await h.send();
  assert.equal(h.records.readJob(sent.jobId).transcript?.path ?? null, late ? null : h.path);
  const result = await h.finish(sent);
  assert.equal(result.workSummary.transcript.path, h.path);
  assert.equal(result.workSummary.commands[0].exitCode, 0);
  assert.deepEqual(h.records.readResult(sent.jobId), result);
  for (let i = 0; i < 2; i++) {
    const envelope = await callTool({ action: 'wait', job_id: sent.jobId }, { controller: h.controller });
    assert.deepEqual(envelope.meta.work_summary.commands, result.workSummary.commands);
    assert.equal(envelope.meta.work_summary.transcript.path, result.workSummary.transcript.path);
    assert.equal(envelope.meta.work_summary.errors, undefined);
    assert.equal(envelope.content, 'answer');
  }
});
test('unreadable transcript gives an unavailable section and still writes the result', async t => {
  const h = setup(t, { unreadable: true }); const result = await h.finish(await h.send());
  assert.equal(result.outcome, 'completed');
  assert.equal(result.workSummary.transcript.available, false);
  assert.ok(result.workSummary.transcript.reason);
  assert.equal(h.records.readResult(result.jobId).text, 'answer');
});
test('Copilot native error corrects completed to failed with native error explanation', async t => {
  const h = setup(t, { companion: 'copilot', ack: { acknowledged: true, nativeTurnId: null, nativeRefs: { promptRequestId: 3 } } });
  const sent = await h.send(); assert.equal(sent.acknowledged, true);
  const result = await h.finish(sent);
  assert.equal(result.outcome, 'failed'); assert.equal(result.cause, 'companion_error');
  assert.equal(result.detail, 'rate_limit'); assert.match(result.text, /^answer\n\n.*429/);
  assert.equal(result.turns[0].outcome, 'failed'); assert.equal(result.turns[0].text, result.text);
  assert.equal(result.nativeRefs.nativeTurnId, null); assert.equal(result.nativeRefs.promptRequestId, 3);
});
for (const ack of [{ nativeTurnId: null }, {}]) test(`missing delivery acknowledgement remains DeliveryUnknown: ${JSON.stringify(ack)}`, async t => {
  const h = setup(t, { ack });
  const result = await h.send();
  assert.equal(result.outcome, 'delivery_unknown'); assert.equal(result.detail, 'delivery_unknown');
});
test('start snapshot runs alongside startup, gates delivery; end snapshot follows termination', async t => {
  const start = deferred(); let calls = 0;
  const h = setup(t, { snapshot: async () => {
    calls++;
    if (calls === 1) return start.promise;
    assert.ok(h.events.includes('terminate'));
    return { available: false, reason: 'test' };
  } });
  const sending = h.send();
  await until(() => h.events.includes('start'));
  assert.equal(calls, 1); assert.ok(!h.events.includes('deliver'));
  start.resolve({ available: false, reason: 'test' });
  const result = await h.finish(await sending);
  assert.equal(calls, 2); assert.equal(result.workSummary.worktree.available, false);
});
test('snapshot failures leave an immutable result with an unavailable worktree', async t => {
  const h = setup(t, { snapshot: async () => { throw new Error('snapshot failure'); } });
  const result = await h.finish(await h.send());
  assert.equal(result.outcome, 'completed');
  assert.equal(result.workSummary.worktree.reason, 'snapshot_failed');
  assert.ok(h.records.readResult(result.jobId));
});
test('unverified provider cleanup never takes an end snapshot', async t => {
  let snapshots = 0;
  const h = setup(t, { gone: false, snapshot: async () => {
    snapshots++; return { available: true, tree: 'unused' };
  } });
  const result = await h.finish(await h.send());
  assert.equal(snapshots, 1);
  assert.equal(result.workSummary.worktree.reason, 'cleanup_unverified');
});
