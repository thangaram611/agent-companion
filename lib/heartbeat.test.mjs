// heartbeat.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEARTBEAT_STALE_AFTER_MS, HOST_LIVENESS_TTL_MS, selectLiveHeartbeat } from './heartbeat.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// The exported constants themselves, not a restatement of them: both daemons
// sweep the shared heartbeat dir under exactly these.
const TTL = HOST_LIVENESS_TTL_MS;
const STALE = HEARTBEAT_STALE_AFTER_MS;

test('the shared heartbeat predicate keeps the daemons on one TTL pair', () => {
  assert.equal(HOST_LIVENESS_TTL_MS, 30 * MIN);
  assert.equal(HEARTBEAT_STALE_AFTER_MS, 24 * HOUR);
  assert.ok(HOST_LIVENESS_TTL_MS < HEARTBEAT_STALE_AFTER_MS,
    'a live window wider than the sweep window would let a swept heartbeat still read as live');
});

test('selectLiveHeartbeat chooses the freshest live heartbeat and honors TTL edges', () => {
  const empty = selectLiveHeartbeat({ entries: [], nowMs: 1000, liveTtlMs: TTL, staleAfterMs: STALE });
  assert.deepEqual(empty, { liveSid: null, staleToUnlink: [] });

  const now = 10 * HOUR;
  const freshest = selectLiveHeartbeat({
    entries: [
      { name: 'sid-old.heartbeat',   mtimeMs: now - 20 * MIN }, // within TTL but older
      { name: 'sid-fresh.heartbeat', mtimeMs: now - 1 * MIN  }, // freshest
      { name: 'sid-mid.heartbeat',   mtimeMs: now - 10 * MIN }, // mid
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(freshest.liveSid, 'sid-fresh');
  assert.deepEqual(freshest.staleToUnlink, []);

  const boundary = selectLiveHeartbeat({
    entries: [{ name: 'sid-boundary.heartbeat', mtimeMs: now - TTL }],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(boundary.liveSid, 'sid-boundary');

  const expired = selectLiveHeartbeat({
    entries: [{ name: 'sid-expired.heartbeat', mtimeMs: now - TTL - 1 }],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(expired.liveSid, null);
  // Not stale either — between TTL and staleAfter.
  assert.deepEqual(expired.staleToUnlink, []);

  const expiredOnly = selectLiveHeartbeat({
    entries: [
      { name: 'sid-a.heartbeat', mtimeMs: now - (TTL + MIN) },  // expired, not stale
      { name: 'sid-b.heartbeat', mtimeMs: now - 2 * HOUR },     // expired, not stale
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(expiredOnly.liveSid, null);
  assert.deepEqual(expiredOnly.staleToUnlink, []);
});

test('selectLiveHeartbeat filters invalid entries, sweeps stale files, and has stable tie behavior', () => {
  const now = 48 * HOUR;
  const stale = selectLiveHeartbeat({
    entries: [
      { name: 'sid-old.heartbeat',  mtimeMs: now - STALE - HOUR }, // way stale
      { name: 'sid-fresh.heartbeat', mtimeMs: now - 5 * MIN },     // live
      { name: 'sid-mid.heartbeat',   mtimeMs: now - HOUR },        // expired, not stale
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(stale.liveSid, 'sid-fresh');
  assert.deepEqual(stale.staleToUnlink, ['sid-old.heartbeat']);

  const filtered = selectLiveHeartbeat({
    entries: [
      { name: 'sid-real.heartbeat', mtimeMs: now - 1 * MIN },
      { name: 'README.md',          mtimeMs: now - 1 * MIN },
      { name: 'sid-bare',           mtimeMs: now - 1 * MIN },
      { name: '.DS_Store',          mtimeMs: now - 1 * MIN },
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(filtered.liveSid, 'sid-real');

  const invalid = selectLiveHeartbeat({
    entries: [
      { name: 'sid-good.heartbeat', mtimeMs: now - 1 * MIN },
      { name: 'sid-nan.heartbeat',  mtimeMs: NaN },
      { name: 'sid-undef.heartbeat' },
      { name: 'sid-str.heartbeat',  mtimeMs: 'not a number' },
      null,
      undefined,
      { /* no name */ mtimeMs: now },
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  assert.equal(invalid.liveSid, 'sid-good');
  assert.deepEqual(invalid.staleToUnlink, []);

  // Documents the current tie-break: iteration order on equal mtimes. Not a
  // correctness-critical detail, but pinning it avoids flaky tests if someone
  // ever changes the comparator.
  const tieMtime = now - 5 * MIN;
  const tied = selectLiveHeartbeat({
    entries: [
      { name: 'sid-a.heartbeat', mtimeMs: tieMtime },
      { name: 'sid-b.heartbeat', mtimeMs: tieMtime },
    ],
    nowMs: now, liveTtlMs: TTL, staleAfterMs: STALE,
  });
  // Strict `>` comparator means the first-encountered wins.
  assert.equal(tied.liveSid, 'sid-a');
});
