import '../sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_HOME } from '../sandbox-home.mjs';
import { pidAlive } from '../../lib/shared-runtime-registry.mjs';
import { Controller } from '../../bridge-server/controller/controller.mjs';
import { Records } from '../../bridge-server/controller/records.mjs';
import { cleanupExecution, spawnCleanupWatcher } from '../../scripts/cleanup-watcher.mjs';
import { fixtureSupervisor } from './fixture-table.mjs';
import { ManualClock, until } from './helpers.mjs';

const treePath = fileURLToPath(new URL('./process-tree.mjs', import.meta.url));
const watcherPath = fileURLToPath(new URL('./watcher-child.mjs', import.meta.url));
const input = (executionId, owner = 'child') => ({ owner, executionId, provider: 'fake', cwd: SANDBOX_HOME, text: 'work', now: 1 });
const makeRecords = () => new Records({ dir: mkdtempSync(join(SANDBOX_HOME, 'watcher-')), log: () => {} });

test('bridge loss: detached watcher kills grouped grandchild and SIGTERM-ignoring child; fresh records read verified result', async (t) => {
  const records = makeRecords(); const clock = new ManualClock(); const supervisors = [];
  let watcher, watcherMessage;
  const provider = { enabled: true, ready: true, create: () => ({
    capabilities: { followUp: true, loadsHistory: true, modelSelection: false, steer: false },
    async start({ supervisor }) { return { runtime: await supervisor.spawn([process.execPath, treePath, 'root', 'ignore'], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] }) }; },
    async openHistory() { return { historyId: 'saved-history' }; },
    async deliver() { return { nativeTurnId: 'native-turn' }; },
    observe() { return new Promise(() => {}); }, async interrupt() { throw new Error('watcher must not use protocol'); }, async close() {},
  }) };
  const controller = new Controller({ records, clock, providers: { fake: provider }, env: {},
    createSupervisor: (options) => { const supervisor = fixtureSupervisor(options); supervisors.push(supervisor); return supervisor; },
    launchWatcher: async ({ stateDir, executionId }) => {
      watcher = fork(watcherPath, [stateDir, executionId], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
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
  const sent = await controller.send({ owner: 'child', provider: 'fake', cwd: records.dir, text: 'original text' });
  const record = supervisors[0].serialize();
  const grandchild = supervisors[0].fixture.grandchild;
  const handoffs = await controller.bridgeLost();
  assert.equal(handoffs.length, 1);
  const bytes = readFileSync(records.path('executions', sent.executionId), 'utf8');
  const exited = once(watcher, 'exit');
  const [message] = await watcherMessage;
  assert.equal(message.gone, true);
  assert.equal((await exited)[0], 0);
  const fresh = new Records({ dir: records.dir });
  const result = fresh.readResult(sent.executionId);
  assert.equal(result.outcome, 'stopped'); assert.equal(result.cause, 'bridge_loss');
  assert.equal(result.stopEvidence.gone, true);
  assert.ok(result.stopEvidence.signals.some((signal) => signal.pid === -record.pgid && signal.signal === 'SIGTERM'));
  assert.ok(result.stopEvidence.signals.some((signal) => signal.pid === grandchild && signal.signal === 'SIGKILL'));
  assert.ok(record.processes.every((row) => !pidAlive(row.pid)));
  assert.equal(readFileSync(records.path('executions', sent.executionId), 'utf8'), bytes, 'watcher only writes its terminal result');
  assert.equal(fresh.readConversation('child').historyId, 'saved-history');
});

test('watcher stale generation is refused before any destructive action', async () => {
  const records = makeRecords(); const first = records.begin(input('first'), 0);
  records.handoff(first);
  records.writeResult({ ...first, outcome: 'stopped', cause: 'bridge_loss', stopEvidence: { gone: true } }, 'watcher');
  records.begin(input('second'), 1);
  let created = false;
  const result = await cleanupExecution({ records, execution: first, createSupervisor: () => { created = true; } });
  assert.equal(result, null); assert.equal(created, false);
  assert.equal(records.readResult('second'), null);
});

test('watcher records failed cleanup honestly without claiming stopped', async () => {
  const records = makeRecords(); const execution = records.begin(input('unverified'), 0); records.handoff(execution);
  const result = await cleanupExecution({ records, execution, clock: new ManualClock(), createSupervisor: () => ({ terminate: async () => ({ gone: false, survivors: [{ pid: 123, birthTime: 'birth' }] }) }) });
  assert.equal(result.outcome, 'failed'); assert.equal(result.detail, 'cleanup_unverified'); assert.equal(result.cause, 'bridge_loss');
});

test('production watcher CLI writes a durable result and exits without provider protocol', async () => {
  const records = makeRecords(); const execution = records.begin(input('empty-tree'), 0); records.handoff(execution);
  const watcher = await spawnCleanupWatcher({ stateDir: records.dir, executionId: execution.executionId });
  await until(() => records.readResult(execution.executionId), 'standalone watcher result');
  await until(() => !pidAlive(watcher.pid), 'standalone watcher exit');
  assert.equal(records.readResult(execution.executionId).stopEvidence.gone, true);
});
