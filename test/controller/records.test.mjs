import '../sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_HOME } from '../sandbox-home.mjs';
import { Records } from '../../bridge-server/controller/records.mjs';

const input = (id = 'e1') => ({ thread: 'child', companion: 'fake', cwd: '/workspace', jobId: id, text: 'exact text', now: 1 });
const make = () => new Records({ dir: mkdtempSync(join(SANDBOX_HOME, 'records-')) });

export function snapshot(dir) {
  return readdirSync(dir, { recursive: true }).sort().filter((p) => statSync(join(dir, p)).isFile())
    .map((p) => [p, statSync(join(dir, p)).mtimeMs, readFileSync(join(dir, p), 'utf8')]);
}

test('an unverified previous cleanup refuses a new job with its own code', () => {
  const records = make();
  const first = records.begin(input(), 0);
  records.writeResult({ ...first, outcome: 'completed', cause: 'native_complete', text: 'answer', stopEvidence: { gone: false, survivors: [{ pid: 1129 }] } });
  records.writeJob({ ...first, state: 'closed', cleanup: { gone: false, survivors: [{ pid: 1129 }] } });
  assert.throws(() => records.begin(input('e2'), 1), { code: 'previous_execution_unverified' });
  records.writeJob({ ...first, state: 'closed', cleanup: { gone: true } });
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
  records.writeJob({ ...first, state: 'closed', cleanup: { gone: true } });
  const second = records.begin(input('e2'), 1);
  assert.equal(second.generation, 2);
  assert.equal(rival.writeJob({ ...first, state: 'running' }), false);
  assert.equal(rival.writeThread({ ...records.readThread('child'), generation: 1 }), false);
  assert.equal(rival.writeResult({ ...first, outcome: 'stopped' }), false);
  assert.equal(logs.filter((e) => e.code === 'stale_generation').length, 3);
  assert.equal(records.readResult('e1').outcome, 'completed');
});

test('observer reads create nothing and change no bytes or mtimes', () => {
  const records = make();
  assert.equal(records.readThread('missing'), null);
  assert.deepEqual(readdirSync(records.dir), []);
  const job = records.begin(input(), 0);
  const before = snapshot(records.dir);
  for (let i = 0; i < 5; i++) {
    records.readThread('child'); records.readJob(job.jobId);
    records.readResult(job.jobId); records.listJobs();
  }
  assert.deepEqual(snapshot(records.dir), before);
});

test('handoff fences the old controller writer within the same generation', () => {
  const records = make();
  const job = records.begin(input(), 0);
  assert.equal(records.handoff(job), true);
  assert.equal(records.writeJob({ ...job, state: 'running' }), false);
  assert.equal(records.writeResult({ ...job, outcome: 'failed' }), false);
  assert.equal(records.writeResult({ ...job, outcome: 'stopped', cause: 'bridge_loss', stopEvidence: { gone: true } }, 'watcher'), true);
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
  await compete('result', { ...records.readJob('e1'), outcome: 'completed', cause: 'native_complete', text: 'one answer' });
  assert.equal(records.readResult('e1').text, 'one answer');
});

test('effort is recorded on job and deferred on thread until accepted', () => {
  const records = make();
  const record = records.begin({ ...input(), effortOverride: 'low' }, 0);
  assert.equal(record.effortOverride, 'low');
  const fresh = new Records({ dir: records.dir });
  assert.equal(fresh.readJob('e1').effortOverride, 'low');
  assert.equal(fresh.readThread('child').effortOverride, undefined);
  records.writeThread({ ...fresh.readThread('child'), effortOverride: 'low' });
  assert.equal(fresh.readThread('child').effortOverride, 'low');
  records.writeJob({ ...record, state: 'closed', cleanup: { gone: true } });
  records.begin({ ...input('e2'), effortOverride: 'invalid' }, 1);
  assert.equal(fresh.readThread('child').effortOverride, 'low');
  assert.equal(fresh.readJob('e2').effortOverride, 'invalid');
  assert.deepEqual(readdirSync(records.dir).sort(), ['jobs', 'locks', 'threads']);
});

test('migrates a 1.0.0 store, finishes a dead archiver\'s 0.x archive and takes a late write', () => {
  const dir = mkdtempSync(join(SANDBOX_HOME, 'migration-'));
  const put = (folder, file, text) => {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, file), text);
  };
  const old = { owner: 'th-1', executionId: 'j1', provider: 'codex' };
  const renamed = { thread: 'th-1', jobId: 'j1', companion: 'codex' };
  for (const folder of ['threads', 'jobs', 'stops']) put(folder, 'old', folder);
  put('.', 'daemon.log', 'daemon.log');
  mkdirSync(join(dir, 'legacy.pending')); // claimed by a process that died
  put('conversations', 'th-1.json', JSON.stringify(old));
  put('executions', 'j1.json', JSON.stringify(old));
  put('results', 'j1.json', JSON.stringify({ ...old, cause: 'provider_error' }));
  put('results', 'j1.json.delivery', 'owner\n');
  const records = new Records({ dir });
  assert.deepEqual(readdirSync(dir).sort(), ['jobs', 'legacy', 'results', 'threads']);
  for (const file of ['threads/old', 'jobs/old', 'stops/old', 'daemon.log'])
    assert.equal(readFileSync(join(dir, 'legacy', file), 'utf8'), file.split('/')[0]);
  assert.deepEqual(records.readThread('th-1'), renamed);
  assert.deepEqual(records.readJob('j1'), renamed);
  assert.deepEqual(records.readResult('j1'), { ...renamed, cause: 'companion_error' });
  assert.equal(readFileSync(join(dir, 'results/j1.json.delivery'), 'utf8'), 'owner\n');
  const reopen = () => execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { Records } from './bridge-server/controller/records.mjs'; new Records({ dir: process.argv[1] })", dir]);
  const before = snapshot(dir);
  reopen();
  assert.deepEqual(snapshot(dir), before);
  put('conversations', 'th-1.json', JSON.stringify({ ...old, provider: 'late' }));
  put('conversations', 'th-2.json', JSON.stringify({ ...old, owner: 'th-2' }));
  reopen();
  assert.deepEqual(records.readThread('th-1'), { ...renamed, companion: 'late' });
  assert.deepEqual(records.readThread('th-2'), { ...renamed, thread: 'th-2' });
  assert.equal(existsSync(join(dir, 'conversations')), false);
});
