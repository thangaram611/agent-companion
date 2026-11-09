import '../sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ProcessSupervisor, readProcessTable, pidAlive } from '../../bridge-server/controller/process-supervisor.mjs';
import { ManualClock, until } from './helpers.mjs';
import { fixtureSupervisor } from './fixture-table.mjs';

const fixture = fileURLToPath(new URL('./process-tree.mjs', import.meta.url));

test('supervisor censuses an independent process group and kills SIGTERM survivors by identity', async (t) => {
  const clock = new ManualClock();
  const supervisor = fixtureSupervisor({ clock });
  t.after(async () => { await supervisor.terminate({ graceMs: 0 }); });
  const child = await supervisor.spawn([process.execPath, fixture, 'root', 'ignore'], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
  const pids = supervisor.fixture;
  await supervisor.census();
  const record = supervisor.serialize();
  assert.equal(record.pid, child.pid);
  assert.equal(record.pgid, child.pid);
  assert.ok(record.birthTime);
  assert.deepEqual(record.processes.map((p) => p.pid).sort(), [child.pid, pids.leaf, pids.grandchild].sort());
  assert.equal(record.processes.find((p) => p.pid === pids.grandchild).pgid, pids.grandchild);
  let evidence;
  const stop = supervisor.terminate().then((result) => { evidence = result; });
  await until(() => supervisor.lastSignals.some((s) => s.signal === 'SIGTERM'));
  await until(() => [...clock.timers.values()].some((t) => t.at === clock.time + 2000));
  await clock.advance(2000);
  await until(() => supervisor.lastSignals.some((s) => s.signal === 'SIGKILL'));
  await until(async () => (await supervisor.verifyGone()).gone, 'OS reaping killed fixture tree');
  await until(() => evidence || [...clock.timers.values()].some((t) => t.at === clock.time + 25));
  while (!evidence) { await clock.advance(25); await until(() => evidence || [...clock.timers.values()].some((t) => t.at === clock.time + 25)); }
  await stop;
  assert.equal(evidence.gone, true, JSON.stringify(evidence));
  assert.ok(evidence.signals.some((s) => s.pid === pids.grandchild && s.signal === 'SIGKILL'));
  assert.equal((await fixtureSupervisor({ record }).verifyGone()).gone, true);
});

test('real ps census provides current process birth time and ancestry', async (t) => {
  let table;
  try { table = await readProcessTable(new ManualClock()); }
  catch (err) { if (err.code === 'EPERM') return t.skip('sandbox denies ps; OS census unverified'); throw err; }
  const current = table.get(process.pid);
  assert.equal(current.ppid, process.ppid);
  assert.ok(current.birthTime);
  assert.ok(current.pgid > 0);
});

test('PID reuse never signals a replacement or its process group', async () => {
  const original = { pid: 91234, pgid: 91234, birthTime: 'old', processes: [{ pid: 91234, pgid: 91234, birthTime: 'old' }] };
  const signals = [];
  const supervisor = new ProcessSupervisor({ record: original, clock: new ManualClock(), processTable: async () => new Map([[91234, { pid: 91234, pgid: 91234, ppid: 1, birthTime: 'new' }]]), signal: (...args) => signals.push(args) });
  assert.equal((await supervisor.terminate()).gone, true);
  assert.deepEqual(signals, []);
});

test('a failed census cannot be reported as verified absence', async () => {
  const supervisor = new ProcessSupervisor({ record: { pid: 91234, pgid: 91234, birthTime: 'old', processes: [{ pid: 91234, pgid: 91234, birthTime: 'old' }] }, processTable: async () => { throw new Error('ps unavailable'); } });
  const evidence = await supervisor.verifyGone();
  assert.equal(evidence.gone, false);
  assert.equal(evidence.error, 'ps unavailable');
});

test('two-second census and reported escaped descendants retain birth identities after reparenting', async () => {
  const clock = new ManualClock();
  const root = { pid: 91001, pgid: 91001, ppid: 1, birthTime: 'root' };
  const escaped = { pid: 91002, pgid: 91002, ppid: 1, birthTime: 'escaped' };
  const leaf = { pid: 91003, pgid: 91002, ppid: 91002, birthTime: 'leaf' };
  const rows = new Map([[root.pid, root], [escaped.pid, escaped], [leaf.pid, leaf]]);
  const supervisor = new ProcessSupervisor({ clock, record: { ...root, processes: [root] }, processTable: async () => rows });
  await supervisor.recordDescendant(escaped.pid);
  supervisor._schedule();
  await clock.advance(1999);
  assert.equal(supervisor.serialize().processes.length, 2);
  await clock.advance(1);
  assert.equal(supervisor.serialize().processes.length, 3);
  rows.delete(root.pid); escaped.ppid = 1;
  await supervisor.census();
  assert.equal(supervisor.serialize().processes.length, 3);
  supervisor.stopCensus();
  assert.equal(clock.timers.size, 0);
});

test('a reported pid that names a process older than the root is a collision, not a descendant', async () => {
  // Incident 2026-11-09: Codex reported process_id 1129; that pid was a system
  // daemon born on Oct 29 under a root spawned on Nov 9.
  const root = { pid: 54618, pgid: 54618, ppid: 1, birthTime: 'Mon Nov 9 09:36:57 2026' };
  const daemon = { pid: 1129, pgid: 1129, ppid: 1, birthTime: 'Thu Oct 29 04:59:21 2026' };
  const escaped = { pid: 55615, pgid: 55615, ppid: 1, birthTime: 'Mon Nov 9 09:37:46 2026' };
  const sameSecond = { pid: 54650, pgid: 54650, ppid: 1, birthTime: root.birthTime };
  const rows = new Map([root, daemon, escaped, sameSecond].map((row) => [row.pid, row]));
  const signals = [];
  const supervisor = new ProcessSupervisor({ clock: new ManualClock(), record: { ...root, processes: [root] }, processTable: async () => rows,
    signal: (pid, sig) => { signals.push([pid, sig]); if (pid === daemon.pid) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } });
  assert.equal(await supervisor.recordDescendant(daemon.pid), false);
  assert.equal(await supervisor.recordDescendant(escaped.pid), true);
  assert.equal(await supervisor.recordDescendant(sameSecond.pid), true);
  assert.deepEqual(supervisor.serialize().processes.map((p) => p.pid), [root.pid, escaped.pid, sameSecond.pid]);
  rows.delete(root.pid); rows.delete(escaped.pid); rows.delete(sameSecond.pid);
  const evidence = await supervisor.verifyGone();
  assert.equal(evidence.gone, true); assert.deepEqual(evidence.survivors, []);
  await supervisor._signal('SIGTERM');
  assert.equal(signals.some(([pid]) => pid === daemon.pid), false);
});

test('real sibling process tree stays alive when the first owned tree closes', async (t) => {
  const pairs = [0, 1].map(() => {
    const clock = new ManualClock(); return { clock, supervisor: fixtureSupervisor({ clock }) };
  });
  t.after(() => {
    for (const { supervisor } of pairs) for (const row of supervisor.serialize().processes) {
      try { process.kill(row.pid, 'SIGKILL'); } catch {}
    }
  });
  for (const { supervisor } of pairs) await supervisor.spawn([process.execPath, fixture, 'root', 'ignore'], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
  const siblingBefore = pairs[1].supervisor.serialize();
  for (let i = 0; i < pairs.length; i++) {
    const { supervisor, clock } = pairs[i];
    const closing = supervisor.terminate();
    await until(() => [...clock.timers.values()].some((timer) => timer.at === 2000));
    await clock.advance(2000);
    await until(() => supervisor.lastSignals.some((signal) => signal.signal === 'SIGKILL'));
    await until(async () => (await supervisor.verifyGone()).gone, 'sibling fixture exit');
    await clock.advance(500);
    assert.equal((await closing).gone, true);
    if (i === 0) {
      assert.equal((await pairs[1].supervisor.verifyGone()).survivors.length, 3);
      assert.deepEqual(pairs[1].supervisor.serialize(), siblingBefore);
    }
  }
});

test('handoff quiescence includes an already pending adapter descendant lookup', async () => {
  const { deferred } = await import('./helpers.mjs');
  const scan = deferred();
  const supervisor = new ProcessSupervisor({ clock: new ManualClock(), processTable: () => scan.promise });
  const pending = supervisor.recordDescendant(91234);
  let drained = false;
  const quiescent = supervisor.quiesce().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  scan.resolve(new Map([[91234, { pid: 91234, pgid: 91234, birthTime: 'reported' }]]));
  await pending; await quiescent;
  assert.equal(supervisor.serialize().processes[0].pid, 91234);
});

test('pidAlive treats a foreign-owned pid as alive, not as dead', () => {
  assert.equal(pidAlive(process.pid), true);
  // pid 1 exists on every POSIX box and is root-owned, so an unprivileged probe
  // gets EPERM. Reporting that as dead is what would make the hydrate guard
  // declare a live companion child orphaned on a multi-user machine.
  assert.equal(pidAlive(1), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive('4242'), false);
});
