import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSharedRuntimeRegistry,
  pruneLeases,
  disposalClaimedBy,
  deriveIdleTtlMs,
  pidAlive,
  LEASE_STALE_MS,
  DISPOSAL_CLAIM_TTL_MS,
  _setForTest,
  _resetForTest,
} from './shared-runtime-registry.mjs';

// These are the behaviours that used to be reachable only through
// `opencode serve`: every one of them is about several bridges sharing one
// machine-wide process, so the tests drive two pids over one registry file.
// Time and pid liveness are injected — a test that waited on a real clock, or
// that needed a foreign pid to be alive (or dead) at probe time, would be
// asserting about the machine rather than about this module.

const KEY = 'shared';

let dir;
let path;
let disposed;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shared-runtime-reg-'));
  path = join(dir, 'registry.json');
  disposed = [];
  _resetForTest();
});

afterEach(() => {
  _resetForTest();
  rmSync(dir, { recursive: true, force: true });
});

// The module must know nothing about what it owns. Here a "runtime" is
// identified by an opaque endpoint string and disposed by pushing onto an
// array — no HTTP, no signals, no child process.
function makeRegistry({ dispose = async (entry) => { disposed.push(entry.endpoint); } } = {}) {
  return createSharedRuntimeRegistry({
    registryPath: () => path,
    key: KEY,
    identity: (entry) => entry?.endpoint,
    dispose,
  });
}

function seed(entry) { writeFileSync(path, JSON.stringify({ [KEY]: entry })); }
function onDisk() { return JSON.parse(readFileSync(path, 'utf8'))[KEY]; }
function lease(pid, jobId, renewedAt) { return { [`${pid}:${jobId}`]: { pid, jobId, renewedAt } }; }

// --- configuration ---------------------------------------------------------

test('a misconfigured registry fails loudly instead of owning the wrong thing', () => {
  assert.throws(() => createSharedRuntimeRegistry(), /registryPath/);
  assert.throws(() => createSharedRuntimeRegistry({ registryPath: () => path }), /key/);
  assert.throws(() => createSharedRuntimeRegistry({ registryPath: () => path, key: KEY }), /identity/);
  assert.throws(() => createSharedRuntimeRegistry({ registryPath: () => path, key: KEY, identity: (e) => e }), /dispose/);
});

test('the registry path is resolved per operation, not captured at construction', () => {
  // The opencode path comes from an env var that tests and operators set after
  // import; a captured string would write to whatever was configured first.
  let target = path;
  const reg = createSharedRuntimeRegistry({
    registryPath: () => target,
    key: KEY,
    identity: (entry) => entry?.endpoint,
    dispose: async () => {},
  });
  reg.record({ endpoint: 'a' });
  target = join(dir, 'moved.json');
  reg.record({ endpoint: 'b' });
  assert.equal(onDisk().endpoint, 'a');
  assert.equal(JSON.parse(readFileSync(target, 'utf8'))[KEY].endpoint, 'b');
});

// --- pid liveness ----------------------------------------------------------

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

// --- lease pruning ---------------------------------------------------------

test('a lease whose owning bridge died is pruned', () => {
  _setForTest({ pidAlive: (pid) => pid !== 777 });
  const now = 1_000_000;
  const { leases, changed } = pruneLeases({
    ...lease(777, 'gone', now),
    ...lease(888, 'live', now),
  }, now);
  assert.deepEqual(Object.keys(leases), ['888:live']);
  assert.equal(changed, true, 'the caller needs to know so it writes the prune back');
});

test('a lease that stopped being renewed is pruned even though its owner lives', () => {
  _setForTest({ pidAlive: () => true });
  const now = 10 * LEASE_STALE_MS;
  const { leases, changed } = pruneLeases({
    ...lease(5, 'fresh', now - (LEASE_STALE_MS - 1)),
    ...lease(5, 'wedged', now - (LEASE_STALE_MS + 1)),
    'malformed': { pid: 5 }, // never renewed at all
  }, now);
  assert.deepEqual(Object.keys(leases), ['5:fresh']);
  assert.equal(changed, true);
});

test('a prune that removes nothing reports no change', () => {
  _setForTest({ pidAlive: () => true });
  const now = 1_000;
  const { leases, changed } = pruneLeases(lease(5, 'j', now), now);
  assert.deepEqual(Object.keys(leases), ['5:j']);
  assert.equal(changed, false, 'so the caller can skip a pointless registry write');
});

// --- lease sync ------------------------------------------------------------

test('an idle bridge with nothing to say does not touch the file', () => {
  // Every bridge on the machine runs this on every GC tick and reads the same
  // file. An unconditional write would be pure contention for no content change.
  _setForTest({ pidAlive: () => true });
  const now = 100_000;
  seed({ endpoint: 'unix:/a', lastUsedAt: 42, leases: lease(7, 'theirs', now - 1_000) });
  const reg = makeRegistry();

  const before = readFileSync(path, 'utf8');
  assert.deepEqual(reg.syncLeases([], { now, pid: 9 }), { leases: lease(7, 'theirs', now - 1_000), mine: 0 });
  assert.equal(readFileSync(path, 'utf8'), before, 'idle heartbeat must not touch the file');

  // ...but a bridge that HAS jobs must write, so its lease and the refreshed
  // lastUsedAt become visible to the other bridges.
  reg.syncLeases(['j1'], { now, pid: 9 });
  assert.ok(onDisk().leases['9:j1']);
  assert.equal(onDisk().lastUsedAt, now, 'holding a lease is also "in use"');
});

test('an idle bridge still writes when it has an abandoned lease to prune', () => {
  _setForTest({ pidAlive: () => false });
  const now = 100_000;
  seed({ endpoint: 'unix:/a', lastUsedAt: 42, leases: lease(7, 'theirs', now) });
  const reg = makeRegistry();
  reg.syncLeases([], { now, pid: 9 });
  assert.deepEqual(onDisk().leases, {}, 'a hard-killed bridge must not pin the runtime forever');
  assert.equal(onDisk().lastUsedAt, 42, 'a pure prune is not a use');
});

test('lease sync retires our finished jobs but never another bridge\'s', () => {
  _setForTest({ pidAlive: () => true });
  const now = 100_000;
  seed({ endpoint: 'unix:/a', lastUsedAt: now, leases: lease(7, 'theirs', now) });
  const reg = makeRegistry();

  reg.syncLeases(['mine-1', 'mine-2'], { now, pid: 9 });
  assert.deepEqual(Object.keys(onDisk().leases).sort(), ['7:theirs', '9:mine-1', '9:mine-2']);

  // Job 1 went terminal; a full reconcile must retire exactly that lease.
  reg.syncLeases(['mine-2'], { now, pid: 9 });
  assert.deepEqual(Object.keys(onDisk().leases).sort(), ['7:theirs', '9:mine-2']);

  reg.syncLeases([], { now, pid: 9 });
  assert.deepEqual(Object.keys(onDisk().leases), ['7:theirs']);
});

test('lease sync is a no-op when no runtime is registered', () => {
  writeFileSync(path, JSON.stringify({}));
  assert.deepEqual(makeRegistry().syncLeases(['x']), { leases: {}, mine: 0 });
});

test('registry writes are atomic so a concurrent reader never sees a partial file', () => {
  // read() treats unparseable JSON as "nothing registered", and that makes the
  // adopter spawn a SECOND runtime instead of reattaching. A truncate-then-write
  // would expose exactly that window.
  _setForTest({ pidAlive: () => true });
  seed({ endpoint: 'unix:/a', lastUsedAt: 1 });
  const before = new Set(readdirSync(dir));
  makeRegistry().syncLeases(['j'], { now: 2, pid: 9 });
  assert.deepEqual(new Set(readdirSync(dir)), before, 'no temp file may be left behind');
  assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')));
});

test('an unparseable registry reads as empty rather than throwing', () => {
  writeFileSync(path, '{ half-writ');
  assert.equal(makeRegistry().read(), null);
});

// --- entry bookkeeping -----------------------------------------------------

test('record stamps lastUsedAt and forget drops the entry and the memo together', () => {
  const reg = makeRegistry();
  reg.record({ endpoint: 'unix:/a', pid: 1234 }, { now: 500 });
  reg.setCached({ endpoint: 'unix:/a' });
  assert.deepEqual(reg.snapshot(), { endpoint: 'unix:/a', pid: 1234, lastUsedAt: 500 });

  reg.forget();
  assert.equal(reg.read(), null);
  assert.equal(reg.getCached(), null, 'a stale memo would outlive the entry the reaper just disposed');
});

// --- idle reaping ----------------------------------------------------------

test('the reaper disposes an unused runtime with no leases', async () => {
  const reg = makeRegistry();
  seed({ endpoint: 'unix:/a', lastUsedAt: 1 });
  assert.equal(await reg.reapIdle({ idleMs: 1_000, now: 60_000 }), true);
  assert.deepEqual(disposed, ['unix:/a']);
  assert.equal(reg.read(), null);
});

test('the reaper stands down for a live lease another bridge holds', async () => {
  _setForTest({ pidAlive: () => true });
  const now = 60_000;
  seed({ endpoint: 'unix:/a', lastUsedAt: 1, leases: lease(7, 'theirs', now) });
  assert.equal(await makeRegistry().reapIdle({ idleMs: 1_000, now, hasLiveJobs: false }), false);
  assert.deepEqual(disposed, []);
  assert.ok(onDisk().leases['7:theirs'], 'a live lease must survive the prune');
});

test('the reaper stands down on its own live jobs and on a runtime still in use', async () => {
  const reg = makeRegistry();
  seed({ endpoint: 'unix:/a', lastUsedAt: 1 });
  assert.equal(await reg.reapIdle({ idleMs: 1_000, now: 60_000, hasLiveJobs: true }), false);
  assert.equal(await reg.reapIdle({ idleMs: 1_000, now: 500 }), false, 'still inside the idle TTL');
  assert.deepEqual(disposed, []);
});

test('a runtime that has never recorded a use is left alone', async () => {
  // No lastUsedAt means "we have no idea how long this has been idle", and the
  // reaper must not guess — the entry is written before the runtime is used.
  const reg = makeRegistry();
  seed({ endpoint: 'unix:/a' });
  assert.equal(await reg.reapIdle({ idleMs: 1_000, now: 60_000 }), false);
  assert.deepEqual(disposed, []);
  assert.ok(reg.read(), 'and the entry stays for the adopter to find');
});

test('a dispose that fails still retires the entry', async () => {
  // The runtime is detached and self-contained; "already gone" and "gone now"
  // are the same outcome for the registry.
  const reg = makeRegistry({ dispose: async () => { throw new Error('connection refused'); } });
  seed({ endpoint: 'unix:/a', lastUsedAt: 1 });
  assert.equal(await reg.reapIdle({ idleMs: 1_000, now: 60_000 }), true);
  assert.equal(reg.read(), null);
});

test('disposing an old runtime never erases a replacement registered meanwhile', async () => {
  // Another bridge saw the old runtime go away, spawned its own, and registered
  // it with a live lease — all while our dispose was in flight. Blind-deleting
  // the entry here would erase that bridge's runtime AND its lease.
  _setForTest({ pidAlive: () => true });
  const reg = makeRegistry({
    dispose: async () => seed({ endpoint: 'unix:/new', lastUsedAt: 60_000, leases: lease(7, 'new', 60_000) }),
  });
  seed({ endpoint: 'unix:/old', lastUsedAt: 1 });

  assert.equal(await reg.reapIdle({ idleMs: 1_000, now: 60_000 }), true);
  assert.equal(onDisk().endpoint, 'unix:/new', 'the replacement entry must survive');
  assert.ok(onDisk().leases['7:new'], 'the replacement\'s lease must survive');
});

// --- disposal claim --------------------------------------------------------

test('the claim is published before the dispose action runs', async () => {
  let claimAtDisposeTime = null;
  const reg = makeRegistry({ dispose: async () => { claimAtDisposeTime = onDisk()?.disposing || null; } });
  seed({ endpoint: 'unix:/a', lastUsedAt: 1 });

  assert.equal(await reg.reapIdle({ idleMs: 1_000, now: 60_000, pid: 111 }), true);
  assert.deepEqual(claimAtDisposeTime, { pid: 111, at: 60_000 }, 'the claim must be visible to other bridges BEFORE dispose');
});

test('two reapers cannot both claim the same disposal', () => {
  const entry = { endpoint: 'unix:/a', lastUsedAt: 1 };
  seed(entry);
  const reg = makeRegistry();

  assert.equal(reg.claimDisposal(entry, { now: 5_000, pid: 111 }), true);
  assert.equal(onDisk().disposing.pid, 111);
  assert.equal(reg.claimDisposal(entry, { now: 5_001, pid: 222 }), false, 'the second reaper must see the live claim');
  assert.equal(onDisk().disposing.pid, 111, 'and must not overwrite it');
});

test('the reaper stands down when another pid already owns the disposal', async () => {
  seed({ endpoint: 'unix:/a', lastUsedAt: 1, disposing: { pid: 111, at: 5_000 } });
  assert.equal(await makeRegistry().reapIdle({ idleMs: 1_000, now: 6_000, pid: 222 }), false);
  assert.deepEqual(disposed, []);
});

test('a disposal claim expires so a reaper killed mid-dispose cannot wedge the runtime', async () => {
  const at = 1_000;
  const entry = { endpoint: 'unix:/a', lastUsedAt: 1, disposing: { pid: 111, at } };
  seed(entry);
  assert.ok(disposalClaimedBy(entry, at + DISPOSAL_CLAIM_TTL_MS), 'still in force at the boundary');
  assert.equal(disposalClaimedBy(entry, at + DISPOSAL_CLAIM_TTL_MS + 1), null);

  // ...and a second reaper may take the disposal over once the claim lapses.
  const reg = makeRegistry();
  assert.equal(await reg.reapIdle({ idleMs: 1_000, now: at + DISPOSAL_CLAIM_TTL_MS + 1, pid: 222 }), true);
  assert.deepEqual(disposed, ['unix:/a']);
});

test('the claim is withdrawn when an adopter got in first', () => {
  // A lease can only exist once a job exists, so leases alone cannot protect the
  // window between "the reaper decided this is idle" and "the claim lands".
  // `decided` is the reaper's stale view; the file already has the adopter.
  _setForTest({ pidAlive: () => true });
  const now = 60_000;
  const decided = { endpoint: 'unix:/a', lastUsedAt: 1 };
  seed({ ...decided, leases: lease(7, 'adopted', now) });
  const reg = makeRegistry();

  assert.equal(reg.claimDisposal(decided, { now, pid: 111 }), false);
  assert.equal(onDisk().disposing, undefined, 'a leftover claim would block the adopter until the TTL expired');
  assert.ok(onDisk().leases['7:adopted']);
});

test('the claim is withdrawn when the runtime was used again mid-claim', () => {
  const now = 60_000;
  const decided = { endpoint: 'unix:/a', lastUsedAt: 1 };
  seed({ ...decided, lastUsedAt: now - 1 });
  const reg = makeRegistry();

  assert.equal(reg.claimDisposal(decided, { now, pid: 111 }), false);
  assert.equal(onDisk().disposing, undefined);
});

test('a claim over an entry that was replaced is refused outright', () => {
  seed({ endpoint: 'unix:/new', lastUsedAt: 1 });
  const reg = makeRegistry();
  assert.equal(reg.claimDisposal({ endpoint: 'unix:/old', lastUsedAt: 1 }, { now: 1, pid: 111 }), false);
  assert.equal(onDisk().disposing, undefined);
});

test('releasing a claim only touches our own', () => {
  const entry = { endpoint: 'unix:/a', lastUsedAt: 1 };
  seed({ ...entry, disposing: { pid: 111, at: 5_000 } });
  const reg = makeRegistry();

  reg.releaseDisposalClaim(entry, { pid: 222 });
  assert.deepEqual(onDisk().disposing, { pid: 111, at: 5_000 }, 'never withdraw another reaper\'s claim');
  reg.releaseDisposalClaim(entry, { pid: 111 });
  assert.equal(onDisk().disposing, undefined);
});

// --- idle TTL derivation ---------------------------------------------------

test('the idle TTL always clears the job budget but never collapses below the floor', () => {
  const floorMs = 30 * 60_000;
  const graceMs = 5 * 60_000;
  // The original bug: a 30min TTL under a 40min job budget.
  assert.ok(deriveIdleTtlMs({ jobTimeoutMs: 40 * 60_000, floorMs, graceMs }) > 40 * 60_000);
  assert.equal(deriveIdleTtlMs({ jobTimeoutMs: 3 * 60 * 60_000, floorMs, graceMs }), 3 * 60 * 60_000 + graceMs);
  assert.equal(deriveIdleTtlMs({ jobTimeoutMs: 1_000, floorMs, graceMs }), floorMs);
});
