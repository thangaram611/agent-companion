import '../sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_HOME } from '../sandbox-home.mjs';
import { Records } from '../../bridge-server/controller/records.mjs';

const input = (id = 'e1') => ({ owner: 'child', provider: 'fake', cwd: '/workspace', executionId: id, text: 'exact text', now: 1 });
const make = () => new Records({ dir: mkdtempSync(join(SANDBOX_HOME, 'records-')) });

export function snapshot(dir) {
  return readdirSync(dir, { recursive: true }).sort().filter((p) => statSync(join(dir, p)).isFile())
    .map((p) => [p, statSync(join(dir, p)).mtimeMs, readFileSync(join(dir, p), 'utf8')]);
}

test('an unverified previous cleanup refuses a new execution with its own code', () => {
  const records = make();
  const first = records.begin(input(), 0);
  records.writeResult({ ...first, outcome: 'completed', cause: 'native_complete', text: 'answer', stopEvidence: { gone: false, survivors: [{ pid: 1129 }] } });
  records.writeExecution({ ...first, state: 'closed', cleanup: { gone: false, survivors: [{ pid: 1129 }] } });
  assert.throws(() => records.begin(input('e2'), 1), { code: 'previous_execution_unverified' });
  records.writeExecution({ ...first, state: 'closed', cleanup: { gone: true } });
  assert.equal(records.begin(input('e2'), 1).generation, 2);
});

test('stale generation refused and logged; terminal results are immutable', () => {
  const records = make();
  const logs = [];
  const rival = new Records({ dir: records.dir, log: (event) => logs.push(event) });
  const first = records.begin(input(), 0);
  assert.equal(first.generation, 1);
  assert.equal(records.writeResult({ ...first, outcome: 'completed', cause: 'native_complete', text: 'answer' }), true);
  assert.equal(rival.writeResult({ ...first, outcome: 'failed' }), false);
  records.writeExecution({ ...first, state: 'closed', cleanup: { gone: true } });
  const second = records.begin(input('e2'), 1);
  assert.equal(second.generation, 2);
  assert.equal(rival.writeExecution({ ...first, state: 'running' }), false);
  assert.equal(rival.writeLease({ owner: first.owner, executionId: first.executionId, generation: 1, deadline: 12 }), false);
  assert.equal(rival.writeConversation({ ...records.readConversation('child'), generation: 1 }), false);
  assert.equal(rival.writeResult({ ...first, outcome: 'stopped' }), false);
  assert.equal(logs.filter((e) => e.code === 'stale_generation').length, 4);
  assert.equal(records.readResult('e1').outcome, 'completed');
});

test('observer reads create nothing and change no bytes or mtimes', () => {
  const records = make();
  assert.equal(records.readConversation('missing'), null);
  assert.deepEqual(readdirSync(records.dir), []);
  const execution = records.begin(input(), 0);
  const before = snapshot(records.dir);
  for (let i = 0; i < 5; i++) {
    records.readConversation('child'); records.readExecution(execution.executionId);
    records.readLease(execution.executionId); records.readResult(execution.executionId); records.listExecutions();
  }
  assert.deepEqual(snapshot(records.dir), before);
});

test('handoff fences the old controller writer within the same generation', () => {
  const records = make();
  const execution = records.begin(input(), 0);
  assert.equal(records.handoff(execution), true);
  assert.equal(records.writeExecution({ ...execution, state: 'running' }), false);
  assert.equal(records.writeResult({ ...execution, outcome: 'failed' }), false);
  assert.equal(records.writeResult({ ...execution, outcome: 'stopped', cause: 'bridge_loss', stopEvidence: { gone: true } }, 'watcher'), true);
  assert.equal(new Records({ dir: records.dir }).readResult('e1').cause, 'bridge_loss');
});

test('separate writer processes cannot both acquire a generation or replace a terminal result', async () => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const records = make();
  const compete = async (operation, record) => {
    const children = [0, 1].map(() => fork(new URL('./record-writer.mjs', import.meta.url), [records.dir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
    const exits = children.map((child) => once(child, 'exit'));
    await Promise.all(children.map((child) => once(child, 'message')));
    const replies = children.map((child) => once(child, 'message'));
    children.forEach((child) => child.send({ operation, record }));
    const results = (await Promise.all(replies)).map(([message]) => message);
    await Promise.all(exits);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.ok(results.every((result) => result.ok === true || result.ok === false || ['RECORD_BUSY', 'stale_generation'].includes(result.error)));
  };
  await compete('begin', input());
  await compete('result', { ...records.readExecution('e1'), outcome: 'completed', cause: 'native_complete', text: 'one answer' });
  assert.equal(records.readResult('e1').text, 'one answer');
});

test('effort is recorded on execution and deferred on conversation until accepted', () => {
  const records = make();
  const record = records.begin({ ...input(), effortOverride: 'low' }, 0);
  assert.equal(record.effortOverride, 'low');
  const fresh = new Records({ dir: records.dir });
  assert.equal(fresh.readExecution('e1').effortOverride, 'low');
  assert.equal(fresh.readConversation('child').effortOverride, undefined);
  records.writeConversation({ ...fresh.readConversation('child'), effortOverride: 'low' });
  assert.equal(fresh.readConversation('child').effortOverride, 'low');
  records.writeExecution({ ...record, state: 'closed', cleanup: { gone: true } });
  records.begin({ ...input('e2'), effortOverride: 'invalid' }, 1);
  assert.equal(fresh.readConversation('child').effortOverride, 'low');
  assert.equal(fresh.readExecution('e2').effortOverride, 'invalid');
  assert.deepEqual(readdirSync(records.dir).sort(), ['conversations', 'executions', 'locks']);
});
