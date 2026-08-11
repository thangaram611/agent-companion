// heartbeat.mjs
// Host-liveness heartbeat scan for the long-lived daemons. `selectLiveHeartbeat`
// is the pure classifier — the TTL boundary, freshest-of-many selection and the
// stale-cleanup predicate — so those can be unit-tested without touching the
// filesystem. `scanLiveHeartbeat` is the readdir/stat/unlink wrapper around it.
//
// The I/O half lives here rather than in each daemon because there are now two
// daemons asking the same question (copilot-acp-daemon and the codex app-server
// broker), and a copy-pasted directory walk is how the two would drift on which
// filenames count and when a stale file is swept.
//
// See scripts/copilot-acp-daemon.mjs and scripts/codex-app-server-broker.mjs for
// the wiring, and hooks/drain-completions.sh for the writer side.

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Classify a snapshot of heartbeat files into:
//   - liveSid:        the freshest sid still inside liveTtlMs, or null
//   - staleToUnlink:  filenames older than staleAfterMs, safe to remove
//
// `entries` is an array of { name, mtimeMs } objects. `name` should be the
// basename like "<sid>.heartbeat" (sids without that suffix are ignored, so
// stray files in the heartbeat dir don't confuse the scan). `nowMs`,
// `liveTtlMs`, and `staleAfterMs` are explicit so tests can pin time.
//
// Invariant: liveTtlMs < staleAfterMs. The caller's defaults (30 min / 24h)
// satisfy this; a misconfigured call where they cross would mean "stale"
// entries could still be considered live. We don't enforce — keep the helper
// pure and let the daemon's constants be the source of truth.
export function selectLiveHeartbeat({ entries, nowMs, liveTtlMs, staleAfterMs }) {
  let liveSid = null;
  let liveMtime = -Infinity;
  const staleToUnlink = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (!entry.name.endsWith('.heartbeat')) continue;
    const mtimeMs = entry.mtimeMs;
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) continue;
    const age = nowMs - mtimeMs;
    if (age > staleAfterMs) {
      staleToUnlink.push(entry.name);
      continue;
    }
    if (age <= liveTtlMs && mtimeMs > liveMtime) {
      liveMtime = mtimeMs;
      liveSid = entry.name.replace(/\.heartbeat$/, '');
    }
  }
  return { liveSid, staleToUnlink };
}

// Scan `dir` and return the freshest live host sid, or null. Sweeps heartbeats
// older than `staleAfterMs` as a side effect — keeps the dir from growing
// unbounded across orphaned sessions (parent crash, OS reboot).
//
// A missing directory means no host has ever checked in, which is "no live
// host", not an error: the daemons call this from an idle timer where throwing
// would leave the timer unarmed.
export function scanLiveHeartbeat(dir, { nowMs = Date.now(), liveTtlMs, staleAfterMs } = {}) {
  let names;
  try { names = readdirSync(dir); }
  catch { return null; }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.heartbeat')) continue;
    try {
      entries.push({ name, mtimeMs: statSync(join(dir, name)).mtimeMs });
    } catch { /* file vanished between readdir and stat — skip */ }
  }
  const { liveSid, staleToUnlink } = selectLiveHeartbeat({ entries, nowMs, liveTtlMs, staleAfterMs });
  for (const name of staleToUnlink) {
    try { unlinkSync(join(dir, name)); } catch {}
  }
  return liveSid;
}
