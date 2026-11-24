import '../sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_HOME } from '../sandbox-home.mjs';
import { snapshotWorktree } from '../../lib/worktree-snapshot.mjs';
import { pidAlive } from '../../bridge-server/controller/process-supervisor.mjs';
import { Records } from '../../bridge-server/controller/records.mjs';
import { runCleanup, spawnCleanupWatcher } from '../../bridge-server/controller/watcher.mjs';
import { cleanupJob } from '../../scripts/cleanup-watcher.mjs';
import { fixtureSupervisor } from './fixture-table.mjs';
import { ManualClock, setupController, until } from './helpers.mjs';

const treePath = fileURLToPath(new URL('./process-tree.mjs', import.meta.url));
const watcherPath = fileURLToPath(new URL('./watcher-child.mjs', import.meta.url));
const input = (jobId, thread = 'child') => ({ thread, jobId, companion: 'fake', cwd: SANDBOX_HOME, text: 'work', now: 1 });
const makeRecords = () => new Records({ dir: mkdtempSync(join(SANDBOX_HOME, 'watcher-')), log: () => {} });

test('bridge loss: detached watcher kills grouped grandchild and SIGTERM-ignoring child; fresh records read verified result', async (t) => {
  let watcher, watcherMessage;
  const { controller, records, supervisors, send } = setupController({
    capabilities: { modelSelection: false }, history: { historyId: 'saved-history' }, ack: { nativeTurnId: 'native-turn' },
    start: async ({ supervisor }) => ({ runtime: await supervisor.spawn([process.execPath, treePath, 'root', 'ignore'], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] }) }),
    interrupt() { throw new Error('watcher must not use protocol'); },
    createSupervisor: fixtureSupervisor, snapshot: snapshotWorktree,
    launchWatcher: async ({ stateDir, jobId }) => {
      watcher = fork(watcherPath, [stateDir, jobId], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      watcherMessage = once(watcher, 'message');
      await once(watcher, 'spawn');
      return { pid: watcher.pid };
    } });
  t.after(async () => {
    for (const supervisor of supervisors) for (const row of supervisor.serialize().processes) {
      if (pidAlive(row.pid)) { try { process.kill(row.pid, 'SIGKILL'); } catch {} }
    }
    watcher?.kill();
  });
  const sent = await send({ text: 'original text' });
  const record = supervisors[0].serialize();
  const grandchild = supervisors[0].fixture.grandchild;
  const handoffs = await controller.bridgeLost();
  assert.equal(handoffs.length, 1);
  const bytes = readFileSync(records.path('jobs', sent.jobId), 'utf8');
  const exited = once(watcher, 'exit');
  const [message] = await watcherMessage;
  assert.equal(message.gone, true);
  assert.equal((await exited)[0], 0);
  const fresh = new Records({ dir: records.dir });
  const result = fresh.readResult(sent.jobId);
  assert.equal(result.outcome, 'stopped'); assert.equal(result.cause, 'bridge_loss');
  assert.equal(result.stopEvidence.gone, true);
  assert.ok(result.stopEvidence.signals.some((signal) => signal.pid === -record.pgid && signal.signal === 'SIGTERM'));
  assert.ok(result.stopEvidence.signals.some((signal) => signal.pid === grandchild && signal.signal === 'SIGKILL'));
  assert.ok(record.processes.every((row) => !pidAlive(row.pid)));
  assert.equal(readFileSync(records.path('jobs', sent.jobId), 'utf8'), bytes, 'watcher only writes its terminal result');
  assert.equal(fresh.readThread('child').historyId, 'saved-history');
});

test('watcher stale generation is refused before any destructive action', async () => {
  const records = makeRecords(); const first = records.begin(input('first'), 0);
  records.handoff(first);
  records.writeResult({ ...first, outcome: 'stopped', cause: 'bridge_loss', stopEvidence: { gone: true } }, 'watcher');
  records.begin(input('second'), 1);
  let created = false;
  const result = await cleanupJob({ records, job: first, createSupervisor: () => { created = true; } });
  assert.equal(result, null); assert.equal(created, false);
  assert.equal(records.readResult('second'), null);
});

test('watcher records failed cleanup honestly without claiming stopped', async () => {
  const records = makeRecords(); const job = records.begin({ ...input('unverified'), effortOverride: 'low' }, 0); records.handoff(job);
  const result = await cleanupJob({ records, job, clock: new ManualClock(), createSupervisor: () => ({ terminate: async () => ({ gone: false, survivors: [{ pid: 123, birthTime: 'birth' }] }) }) });
  assert.equal(result.selectedEffort, 'low');
  assert.equal(result.outcome, 'failed'); assert.equal(result.detail, 'cleanup_unverified'); assert.equal(result.cause, 'bridge_loss');
});

test('watcher preserves turn attribution and intervention delivery states after bridge loss', async () => {
  const records = makeRecords(), job = records.begin(input('intervened'), 0);
  const inbox = join(records.dir, 'inbox', job.jobId);
  mkdirSync(inbox, { recursive: true }); writeFileSync(join(inbox, 'pending.json'), '{}');
  job.nativeTurnIds = ['one'];
  job.interventions = [{ id: 'queued', from: 'user', mode: 'queue', text: 'later', at: 2, state: 'accepted' }];
  job.turns = [{ nativeTurnId: 'one', messages: ['intervened'], outcome: 'completed', text: 'first answer' }];
  records.handoff(job);
  const result = await cleanupJob({ records, job, createSupervisor: () => ({ terminate: async () => ({ gone: true }) }) });
  assert.equal(result.text, 'first answer');
  assert.equal(result.interventions[0].state, 'not_delivered');
  assert.deepEqual(result.nativeTurnIds, ['one']); assert.deepEqual(result.turns, job.turns);
  assert.equal(existsSync(inbox), false, 'watcher terminal result removes the abandoned inbox');
});

test('production watcher CLI writes a durable result and exits without provider protocol', async () => {
  const records = makeRecords(); const job = records.begin(input('empty-tree'), 0); records.handoff(job);
  const watcher = await spawnCleanupWatcher({ stateDir: records.dir, jobId: job.jobId });
  await until(() => records.readResult(job.jobId), 'standalone watcher result');
  await until(() => !pidAlive(watcher.pid), 'standalone watcher exit');
  assert.equal(records.readResult(job.jobId).stopEvidence.gone, true);
});

test('watcher failure persists only a bounded reason', async () => {
  const records = makeRecords(), job = records.begin(input('failing-watcher'), 0);
  records.handoff(job);
  const createSupervisor = () => ({ terminate: async () => { throw new Error('sensitive native detail'); } });
  await assert.rejects(runCleanup({ records, job, createSupervisor }), /sensitive native detail/);
  assert.equal(records.readJob(job.jobId).watcherFailure, 'watcher_cleanup_failed');
  assert.equal(JSON.stringify(records.readJob(job.jobId)).includes('sensitive native detail'), false);
});

test('a detached watcher records a bounded failure even when its job record cannot be read', () => {
  const records = makeRecords(), log = join(records.dir, 'bridge.log');
  mkdirSync(join(records.dir, 'jobs'));
  writeFileSync(records.path('jobs', 'broken-job'), 'private malformed input');
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../../bridge-server/controller/watcher.mjs', import.meta.url)), records.dir, 'broken-job'],
    { env: { ...process.env, AGENT_BRIDGE_LOG_FILE: log }, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1);
  const saved = readFileSync(log, 'utf8');
  assert.match(saved, /watcher_input_unavailable/);
  assert.doesNotMatch(saved, /private malformed input/);
});
