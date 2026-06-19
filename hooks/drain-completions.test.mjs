// drain-completions.sh integration tests via shell-out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SCRIPT = join(__dirname, 'drain-completions.sh');

function makeQueueFile(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-test-'));
  const path = join(dir, 'completions.jsonl');
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, path };
}

function runDrain({ queuePath, payload }) {
  const stdout = execFileSync('bash', [SCRIPT], {
    input: JSON.stringify(payload),
    env: { ...process.env, AGENT_QUEUE_PATH: queuePath },
    encoding: 'utf8',
  });
  return stdout.trim();
}

function readQueueRows(queuePath) {
  if (!existsSync(queuePath)) return [];
  const raw = readFileSync(queuePath, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const NOW = Date.now();
const FRESH_TS = NOW - 30_000;
const FRESH_ALERT_TS = NOW - 60_000;
const STALE_ALERT_TS = NOW - 6 * 60_000;
const STALE_TERMINAL_TS = NOW - 31 * 60_000;

test('drain filters by session, TTL, consumed state, and tagging without mutating on missing session_id', () => {
  const { dir, path } = makeQueueFile([
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-own', claudeSessionId: 'sid-A',
      consumed: false, content: 'A done', meta: { status: 'completed' } },
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-other', claudeSessionId: 'sid-B',
      consumed: false, content: 'B done', meta: { status: 'completed' } },
    { ts: STALE_ALERT_TS, kind: 'alert', jobId: 'j-stale-alert', claudeSessionId: 'sid-A',
      consumed: false, content: 'stale watchdog' },
    { ts: FRESH_ALERT_TS, kind: 'alert', jobId: 'j-fresh-alert', claudeSessionId: 'sid-A',
      consumed: false, content: 'fresh watchdog' },
    { ts: STALE_TERMINAL_TS, kind: 'terminal', jobId: 'j-old-terminal', claudeSessionId: 'sid-A',
      consumed: false, content: 'old', meta: { status: 'completed' } },
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-untagged', claudeSessionId: null,
      consumed: false, content: 'orphan', meta: { status: 'completed' } },
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-consumed', claudeSessionId: 'sid-A',
      consumed: true, content: 'already delivered', meta: { status: 'completed' } },
  ]);
  try {
    const out = runDrain({ queuePath: path, payload: { hook_event_name: 'PostToolUse', session_id: 'sid-A' } });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /j-own/);
    assert.match(ctx, /j-fresh-alert/);
    for (const absent of ['j-other', 'j-stale-alert', 'j-old-terminal', 'j-untagged', 'j-consumed']) {
      assert.doesNotMatch(ctx, new RegExp(absent));
    }
    assert.deepEqual(readQueueRows(path).map((r) => r.jobId), ['j-other']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const rows = [
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-A', claudeSessionId: 'sid-A',
      consumed: false, content: 'A', meta: { status: 'completed' } },
  ];
  const missing = makeQueueFile(rows);
  try {
    assert.equal(runDrain({ queuePath: missing.path, payload: { hook_event_name: 'PostToolUse' } }), '');
    assert.deepEqual(readQueueRows(missing.path), rows, 'queue unchanged when drain refuses to act');
  } finally {
    rmSync(missing.dir, { recursive: true, force: true });
  }
});

test('concurrent drains for different sessions do not double-deliver or lose unrelated rows', async () => {
  const { dir, path } = makeQueueFile([
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-A1', claudeSessionId: 'sid-A',
      consumed: false, content: 'A1', meta: { status: 'completed' } },
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-A2', claudeSessionId: 'sid-A',
      consumed: false, content: 'A2', meta: { status: 'completed' } },
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-B1', claudeSessionId: 'sid-B',
      consumed: false, content: 'B1', meta: { status: 'completed' } },
  ]);
  try {
    const { spawn } = await import('node:child_process');
    const runOne = (sid) => new Promise((res) => {
      const child = spawn('bash', [SCRIPT], {
        env: { ...process.env, AGENT_QUEUE_PATH: path },
      });
      let stdout = '';
      child.stdout.on('data', (b) => (stdout += b.toString()));
      child.on('close', () => res(stdout));
      child.stdin.write(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: sid }));
      child.stdin.end();
    });

    const [outA, outB] = await Promise.all([runOne('sid-A'), runOne('sid-B')]);
    if (outA.trim()) {
      const ctxA = JSON.parse(outA).hookSpecificOutput.additionalContext;
      assert.match(ctxA, /j-A1/);
      assert.match(ctxA, /j-A2/);
      assert.doesNotMatch(ctxA, /j-B1/);
    }
    if (outB.trim()) {
      const ctxB = JSON.parse(outB).hookSpecificOutput.additionalContext;
      assert.match(ctxB, /j-B1/);
      assert.doesNotMatch(ctxB, /j-A/);
    }

    const remainingIds = readQueueRows(path).map((r) => r.jobId).sort();
    const acceptable = [[], ['j-A1', 'j-A2'], ['j-B1']];
    assert.ok(acceptable.some((a) => a.length === remainingIds.length && a.every((id, i) => id === remainingIds[i])),
      `unexpected post-drain queue state: ${JSON.stringify(remainingIds)}`);

    const allDelivered = (outA + outB).match(/j-[AB]\d/g) || [];
    assert.equal(new Set(allDelivered).size, allDelivered.length, 'no double-delivery');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('move-aside drain preserves rows appended after the drain snapshot is renamed', async () => {
  const { dir, path } = makeQueueFile([
    { ts: FRESH_TS, kind: 'terminal', jobId: 'j-pre', claudeSessionId: 'sid-A',
      consumed: false, content: 'pre-drain row', meta: { status: 'completed' } },
  ]);
  const lateRow = {
    ts: Date.now(), kind: 'terminal', jobId: 'j-late', claudeSessionId: 'sid-A',
    consumed: false, content: 'appended mid-drain', meta: { status: 'completed' },
  };
  try {
    const { spawn } = await import('node:child_process');
    const { appendFileSync } = await import('node:fs');

    const child = spawn('bash', [SCRIPT], {
      env: {
        ...process.env,
        AGENT_QUEUE_PATH: path,
        DEBUG_DRAIN_DELAY: '1.5',
      },
    });
    let stdout = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    const closed = new Promise((res) => child.on('close', res));
    child.stdin.write(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'sid-A' }));
    child.stdin.end();

    const renameDeadline = Date.now() + 3_000;
    while (existsSync(path) && Date.now() < renameDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(!existsSync(path), 'drain should have renamed $QUEUE before the test appends');

    appendFileSync(path, JSON.stringify(lateRow) + '\n');
    await closed;

    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /j-pre/);
    assert.doesNotMatch(ctx, /j-late/);
    assert.ok(readQueueRows(path).map((r) => r.jobId).includes('j-late'),
      'late-appended row must not be overwritten by the drain');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
