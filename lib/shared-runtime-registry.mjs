// Shared-runtime registry — on-disk ownership of a long-lived process that
// every bridge on the machine shares.
//
// The bridge is spawned per subagent, but the runtimes it drives (`opencode
// serve` today, the codex app-server broker next) are machine-wide singletons
// that deliberately outlive any one bridge. So "does anyone still need this?"
// cannot be answered from process memory — it needs a file next to the runtime
// holding leases, plus a disposal protocol two bridges can run concurrently
// without killing each other's turns.
//
// All of that was written for `opencode serve` and measured there. This module
// is that machinery with the opencode-shaped parts injected, so a second
// adapter reuses it instead of growing a parallel copy that drifts:
//   - `registryPath`  which file (a function: the path comes from an env var
//                     that tests and operators set after import),
//   - `key`           which entry inside it,
//   - `identity`      what makes two entries the same runtime across a re-read,
//   - `dispose`       how a runtime is stopped — an HTTP POST for opencode, a
//                     socket message or SIGTERM for a broker. Not our concern,
//                     except for one thing it is handed: `(entry,
//                     {confirmDisposal})`. A dispose that does anything before
//                     the destructive act MUST call `confirmDisposal()` as late
//                     as it can and do nothing when it returns false — that is
//                     the only check that sees a bridge which adopted the
//                     runtime mid-dispose.

import { readFileSync, existsSync } from 'node:fs';

import { writePrivateFileAtomic } from './runtime-paths.mjs';

// A lease is one bridge process's claim that it has a job actively using the
// shared runtime. Leases live in the on-disk registry rather than in memory
// because the thing they protect is machine-wide: the runtime is shared by
// every bridge, and the bridge is spawned per subagent, so "this process has no
// live jobs" says nothing about whether the runtime is in use.
//
// Each lease is renewed on its owner's GC tick. A lease whose owning pid is
// gone, or that has not been renewed in LEASE_STALE_MS, is abandoned and gets
// pruned — otherwise a hard-killed bridge would pin the runtime forever.
export const LEASE_STALE_MS = 5 * 60 * 1000;

// How long a published disposal claim is honored. Long enough to cover the
// dispose round-trip, short enough that a reaper killed mid-dispose cannot make
// the runtime permanently unadoptable.
export const DISPOSAL_CLAIM_TTL_MS = 30 * 1000;

// The single definition of "is this pid alive" in the repo. The lease pruner
// below and the hydrate ownership guard (server.mjs) need exactly this rule and
// must not grow a second copy of it: a naive `process.kill(pid, 0)` wrapper
// reports a pid owned by another user as dead, which would make hydrate declare
// a live companion child orphaned on any multi-user box.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return err.code === 'EPERM';
  }
}

// Test seam: the pid probe is the one primitive here that depends on the state
// of the machine rather than on the registry file, so tests swap it wholesale
// instead of hunting for a pid that is reliably alive (or reliably dead) at
// probe time.
let _impl = { pidAlive };

export function _setForTest(overrides = {}) {
  _impl = { ..._impl, ...overrides };
}

export function _resetForTest() {
  _impl = { pidAlive };
}

// Idle TTL derivation, shared so every adapter uses the same shape. The values
// stay with each adapter (they come from that adapter's job timeout); what must
// not be re-decided per adapter is that the TTL is derived from the job budget
// at all. opencode's bug was a bare 30min TTL chosen independently of a 40min
// job budget: a job that simply ran long looked indistinguishable from an idle
// server, and two independently chosen numbers drift apart again.
export function deriveIdleTtlMs({ jobTimeoutMs, floorMs, graceMs }) {
  return Math.max(floorMs, jobTimeoutMs + graceMs);
}

// Drop leases whose owner died or stopped renewing. Returns a fresh object plus
// whether anything was removed (so callers can skip a pointless registry write).
export function pruneLeases(leases, now) {
  const kept = {};
  let changed = false;
  for (const [leaseId, lease] of Object.entries(leases || {})) {
    const renewedAt = Number(lease?.renewedAt) || 0;
    if (_impl.pidAlive(Number(lease?.pid)) && now - renewedAt < LEASE_STALE_MS) kept[leaseId] = lease;
    else changed = true;
  }
  return { leases: kept, changed };
}

// Is a disposal claim in force? Claims expire so a reaper that died mid-dispose
// cannot make the runtime permanently unadoptable.
export function disposalClaimedBy(entry, now = Date.now()) {
  const claim = entry?.disposing;
  if (!claim) return null;
  if (now - (Number(claim.at) || 0) > DISPOSAL_CLAIM_TTL_MS) return null;
  return claim;
}

export function createSharedRuntimeRegistry({ registryPath, key, identity, dispose } = {}) {
  // Misconfiguration is a programming error, not a degraded mode — a registry
  // that silently defaulted its path or its dispose action would quietly own
  // the wrong process.
  if (typeof registryPath !== 'function') throw new Error('shared runtime registry: registryPath must be a function returning the registry file path');
  if (!key) throw new Error('shared runtime registry: key is required');
  if (typeof identity !== 'function') throw new Error('shared runtime registry: identity must be a function');
  if (typeof dispose !== 'function') throw new Error('shared runtime registry: dispose must be a function');

  // The entry this process last resolved. Purely a memo — the file is the
  // source of truth — but it must be dropped whenever the entry is forgotten,
  // including by the reaper below, so it lives with the registry rather than
  // with the adapter.
  let cached = null;

  function readRegistry() {
    try {
      const path = registryPath();
      if (!existsSync(path)) return {};
      const data = JSON.parse(readFileSync(path, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch { return {}; }
  }

  // Atomic, because every bridge on the machine reads this file and lease
  // renewal rewrites it on a heartbeat. A truncate-then-write would let a reader
  // catch the file mid-write; readRegistry treats unparseable as empty, and an
  // empty registry makes the adopter spawn a SECOND runtime rather than
  // reattach to the live one.
  function writeRegistry(reg) {
    try {
      writePrivateFileAtomic(registryPath(), JSON.stringify(reg, null, 2));
    } catch { /* registry is best-effort */ }
  }

  // The entry as it stands on disk right now, or null.
  function read() {
    return readRegistry()[key] || null;
  }

  // Copy for status/observability, so a caller cannot mutate our view.
  function snapshot() {
    const entry = read();
    return entry ? { ...entry } : null;
  }

  function record(entry, { now = Date.now() } = {}) {
    const reg = readRegistry();
    reg[key] = { ...entry, lastUsedAt: now };
    writeRegistry(reg);
  }

  function forget() {
    const reg = readRegistry();
    if (key in reg) { delete reg[key]; writeRegistry(reg); }
    cached = null;
  }

  // Publish `disposing` and confirm we still own the decision. Returns false if
  // anyone raced us — a lease appeared, the runtime was used again, the entry
  // was replaced, or another reaper claimed it first. Exposed (not just used by
  // reapIdle) because an adapter that disposes on demand rather than on idleness
  // needs the same two-phase protocol.
  function claimDisposal(entry, { now = Date.now(), pid = process.pid } = {}) {
    const reg = readRegistry();
    const current = reg[key];
    if (!current || identity(current) !== identity(entry)) return false;
    if (disposalClaimedBy(current, now)) return false;

    reg[key] = { ...current, disposing: { pid, at: now } };
    writeRegistry(reg);

    return confirmDisposal(entry, { now, pid });
  }

  // Re-read the file and answer the only question that authorises a destructive
  // act: is disposing this runtime STILL the right thing to do? Same runtime,
  // the claim is still ours, nobody holds a lease, nobody used it since we
  // decided.
  //
  // This runs TWICE per disposal, and the second run is the one that matters.
  // `claimDisposal` runs it the instant it publishes, which catches an adopter
  // who got in BEFORE the claim landed. It cannot catch one who gets in after,
  // because disposing is not instantaneous — the codex broker asks two RPCs,
  // each with its own timeout, before it SIGTERMs — and a bridge that adopts
  // inside that window has no way to warn us: a lease needs a job, and adoption
  // comes first, so the adopter holds nothing yet. What it DOES leave behind is
  // a bumped `lastUsedAt`. So the disposer looks again immediately before it
  // acts, and stands down if anything moved. That is why `dispose` is handed
  // this as `confirmDisposal`: any dispose with a gap between being called and
  // its destructive act must call it there, as close to the act as it can.
  //
  // Standing down withdraws the claim, for the same reason claiming does: a
  // leftover claim blocks adoption until the TTL expires and costs the adopter a
  // redundant spawn for nothing.
  function confirmDisposal(entry, { now = Date.now(), pid = process.pid } = {}) {
    const current = read();
    if (!current || identity(current) !== identity(entry)) return false;
    if (disposalClaimedBy(current, now)?.pid !== pid) return false;
    if (Object.keys(pruneLeases(current.leases, now).leases).length > 0 || current.lastUsedAt !== entry.lastUsedAt) {
      releaseDisposalClaim(entry, { pid });
      return false;
    }
    return true;
  }

  function releaseDisposalClaim(entry, { pid = process.pid } = {}) {
    const reg = readRegistry();
    const current = reg[key];
    if (!current || identity(current) !== identity(entry) || current.disposing?.pid !== pid) return;
    const { disposing, ...rest } = current;
    reg[key] = rest;
    writeRegistry(reg);
  }

  // Publish this process's in-flight jobs as leases, and prune every abandoned
  // lease (ours or another bridge's) while we hold the file. Call this on a
  // heartbeat — it is a full reconcile, not an increment, so a lease lost to a
  // concurrent read-modify-write is simply re-added on the next tick.
  //
  // Holding a lease also refreshes `lastUsedAt`. That is what makes a job longer
  // than the idle TTL safe: the runtime counts as "in use" for as long as
  // someone is actually using it, instead of only at the moment the job started.
  function syncLeases(jobIds = [], { now = Date.now(), pid = process.pid } = {}) {
    const reg = readRegistry();
    const entry = reg[key];
    if (!entry) return { leases: {}, mine: 0 };

    const { leases, changed } = pruneLeases(entry.leases, now);
    // Reconcile our own leases: drop the ones whose jobs went terminal, then
    // (re)stamp the live ones. Other processes' surviving leases are untouched.
    let heldBefore = 0;
    for (const [leaseId, lease] of Object.entries(leases)) {
      if (Number(lease?.pid) === pid) { heldBefore += 1; delete leases[leaseId]; }
    }
    for (const jobId of jobIds) leases[`${pid}:${jobId}`] = { pid, jobId, renewedAt: now };

    // An idle bridge with nothing to say must not touch the file. This runs on
    // every GC tick in every bridge on the machine; writing unconditionally would
    // be pure contention on a file they all read, for no change in content.
    if (jobIds.length === 0 && heldBefore === 0 && !changed) return { leases, mine: 0 };

    const next = { ...entry, leases };
    if (jobIds.length > 0) next.lastUsedAt = now;
    reg[key] = next;
    writeRegistry(reg);
    return { leases, mine: jobIds.length };
  }

  // Best-effort idle reaper: dispose the shared runtime only when it has gone
  // `idleMs` without use AND no bridge on this machine holds a live lease on it.
  //
  // `hasLiveJobs` is the calling process's own view and stays as a cheap
  // short-circuit, but it is not sufficient on its own: the runtime is shared
  // machine-wide while the bridge is spawned per subagent, so a second bridge
  // with an empty job map used to be able to dispose a runtime out from under
  // someone else's running turn. Leases close that hole.
  //
  // Dispose failures are swallowed (the runtime is detached and self-contained).
  async function reapIdle({ idleMs, hasLiveJobs = false, now = Date.now(), pid = process.pid } = {}) {
    if (hasLiveJobs) return false;
    const reg = readRegistry();
    const entry = reg[key];
    if (!entry || !identity(entry) || !entry.lastUsedAt) return false;

    const { leases, changed } = pruneLeases(entry.leases, now);
    if (changed) {
      reg[key] = { ...entry, leases };
      writeRegistry(reg);
    }
    // Another bridge is mid-turn on this runtime. Its own reaper will dispose it
    // once its jobs finish and the runtime actually goes idle.
    if (Object.keys(leases).length > 0) return false;

    if (now - entry.lastUsedAt < idleMs) return false;

    // Claim the disposal BEFORE the dispose action. Deciding and then disposing
    // is not enough on its own: a lease can only exist once a job exists, so a
    // bridge that adopts this runtime in the window between our check and our
    // dispose landing has no way to warn us, and we would kill its turn.
    // Publishing the intent lets the adopter see it (an adopter refuses a
    // runtime that is being disposed and spawns its own), and re-reading after
    // we publish lets us see an adopter who got in first. Both sides fail safe:
    // the worst case is one redundant spawn, never a disposed runtime with a
    // live job on it.
    if (!claimDisposal(entry, { now, pid })) return false;

    // `dispose` gets the claim's final confirmation to run immediately before
    // its destructive act. Read `confirmDisposal` for why the claim alone is not
    // enough; a dispose that acts the moment it is called (one HTTP POST, no
    // preamble) has no window to guard and need not call it.
    const ctx = { confirmDisposal: (opts = {}) => confirmDisposal(entry, { now, pid, ...opts }) };
    try { await dispose(entry, ctx); } catch { /* the runtime may already be gone */ }
    // Re-read rather than blind-delete: forget() drops the whole entry, so if
    // another bridge replaced this runtime while we disposed the old one, an
    // unconditional delete would erase the replacement and its leases too. The
    // same confirmation gates it, because forgetting is destructive in its own
    // right: without it a disposer that stood down would still erase the entry —
    // and the leases — belonging to the adopter that just beat it, leaving a
    // live runtime nobody is recorded as owning.
    if (!read() || confirmDisposal(entry, { now, pid })) forget();
    return true;
  }

  return {
    read,
    snapshot,
    record,
    forget,
    getCached: () => cached,
    setCached: (value) => { cached = value; },
    clearCache: () => { cached = null; },
    claimDisposal,
    // The second half of the protocol `claimDisposal` is exposed for. An
    // on-demand disposer runs its own preamble between claiming and acting, so
    // it needs the same final look `reapIdle` hands its `dispose` — shipping the
    // claim without it would document a check the API does not hand out.
    confirmDisposal,
    releaseDisposalClaim,
    syncLeases,
    reapIdle,
  };
}
