// v6.1 smoke test: server.mjs must be importable from a test process without
// attaching to stdio (which would deadlock the test runner) and must expose
// the dispatcher + jobs map for unit-level testing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// state.mjs binds BASE_DIR at module-load. Set the sandbox BEFORE importing
// any module that touches state. Tests that exercise the persisted job
// ledger rely on this sandbox.
const STATE_SANDBOX = mkdtempSync(join(tmpdir(), 'copilot-state-server-'));
process.env.COPILOT_COMPANION_HOME = STATE_SANDBOX;

test.after(() => rmSync(STATE_SANDBOX, { recursive: true, force: true }));

test('server.mjs is importable without spawning MCP transport', async () => {
  const mod = await import('./server.mjs');
  assert.equal(typeof mod.dispatch, 'function', 'dispatch is exported');
  assert.ok(mod.jobs && typeof mod.jobs.get === 'function', 'jobs Map is exported');
  assert.ok(mod.mcp, 'mcp server instance is exported');
});

test('dispatch rejects unknown actions', async () => {
  const { dispatch } = await import('./server.mjs');
  await assert.rejects(
    () => dispatch({ action: 'frobnicate' }),
    /unhandled action/,
  );
});

test('dispatch send rejects when CLAUDE_CODE_SESSION_ID is unset', async () => {
  const { dispatch } = await import('./server.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const result = await dispatch({ action: 'send', task: 'do thing', mode: 'EXECUTE', template: 'general' });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ok, false);
    assert.match(body.error, /CLAUDE_CODE_SESSION_ID/);
    // No throw, no exit — bridge stays alive so other actions still work.
  } finally {
    if (oldS !== undefined) process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('dispatch wait/cancel work without env sid (look up job from jobs map)', async () => {
  const { dispatch, jobs } = await import('./server.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    // unknown job_id paths don't depend on env sid
    const w = await dispatch({ action: 'wait', job_id: 'no-such', max_wait_sec: 1 });
    assert.equal(JSON.parse(w.content[0].text).status, 'unknown_job');
    const c = await dispatch({ action: 'cancel', job_id: 'no-such' });
    assert.match(JSON.parse(c.content[0].text).error, /unknown job_id/);
  } finally {
    if (oldS !== undefined) process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('dispatch reply rejects unknown job_id', async () => {
  const { dispatch } = await import('./server.mjs');
  const result = await dispatch({ action: 'reply', job_id: 'nonexistent-job', message: 'hi' });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.match(body.error, /unknown job_id/);
});

test('dispatch reply rejects job without promptId yet', async () => {
  const { dispatch, jobs } = await import('./server.mjs');
  jobs.set('job-no-prompt', { jobId: 'job-no-prompt', status: 'starting', startedAt: Date.now() });
  try {
    const result = await dispatch({ action: 'reply', job_id: 'job-no-prompt', message: 'hi' });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ok, false);
    assert.match(body.error, /no prompt yet/);
  } finally {
    jobs.delete('job-no-prompt');
  }
});

test('dispatch reply rejects already-terminal job', async () => {
  const { dispatch, jobs } = await import('./server.mjs');
  jobs.set('job-done', {
    jobId: 'job-done', status: 'completed', promptId: 'p1',
    startedAt: Date.now() - 1000, terminalAt: Date.now(),
  });
  try {
    const result = await dispatch({ action: 'reply', job_id: 'job-done', message: 'hi' });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ok, false);
    assert.match(body.error, /already completed/);
  } finally {
    jobs.delete('job-done');
  }
});

test('dispatch cancel rejects unknown job_id', async () => {
  const { dispatch } = await import('./server.mjs');
  const result = await dispatch({ action: 'cancel', job_id: 'nonexistent' });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.match(body.error, /unknown job_id/);
});

test('dispatch wait on unknown job returns status=unknown_job', async () => {
  const { dispatch } = await import('./server.mjs');
  const result = await dispatch({ action: 'wait', job_id: 'missing', max_wait_sec: 1 });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.status, 'unknown_job');
});

test('dispatch status without job_id returns global snapshot', async () => {
  const { dispatch } = await import('./server.mjs');
  const result = await dispatch({ action: 'status', job_id: null, verbose: false });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.action, 'status');
  assert.ok(Array.isArray(body.running_jobs), 'running_jobs is an array');
  assert.ok(body.default_model, 'default_model present');
  // v6.1: must NOT carry session-oriented fields.
  assert.equal(body.active, undefined);
  assert.equal(body.paused, undefined);
  assert.equal(body.active_sessions_total, undefined);
});

test('classifyRubberDuck: clean verdict', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  assert.equal(classifyRubberDuck('Did the thing.\n\nRUBBER-DUCK: clean.'), 'clean');
  assert.equal(classifyRubberDuck('RUBBER-DUCK: clean.'), 'clean');
  assert.equal(classifyRubberDuck('body\n rubber-duck: CLEAN'), 'clean');
});

test('classifyRubberDuck: revised verdict', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  assert.equal(classifyRubberDuck('Did it.\n\nRUBBER-DUCK: revised — dropped the foo claim.'), 'revised');
  assert.equal(classifyRubberDuck('RUBBER-DUCK: revised'), 'revised');
});

test('classifyRubberDuck: missing when no marker', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  assert.equal(classifyRubberDuck('just an answer with no verdict'), 'missing');
  assert.equal(classifyRubberDuck(''), 'missing');
  assert.equal(classifyRubberDuck(null), 'missing');
  assert.equal(classifyRubberDuck(undefined), 'missing');
});

test('classifyRubberDuck: ignores unrelated words after prefix', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  // "clear" and "revival" start with c/r but should not match clean|revised
  assert.equal(classifyRubberDuck('RUBBER-DUCK: clear signal'), 'missing');
  assert.equal(classifyRubberDuck('RUBBER-DUCK: revival'), 'missing');
});

// ---------- clampWaitSec: mode-aware caps ----------

test('clampWaitSec: ANALYZE permits up to 900s', async () => {
  const { clampWaitSec } = await import('./server.mjs');
  assert.equal(clampWaitSec(700, 'ANALYZE'), 700);
  assert.equal(clampWaitSec(900, 'ANALYZE'), 900);
  assert.equal(clampWaitSec(1200, 'ANALYZE'), 900);
});

test('clampWaitSec: non-ANALYZE caps at 540', async () => {
  const { clampWaitSec } = await import('./server.mjs');
  assert.equal(clampWaitSec(700, 'EXECUTE'), 540);
  assert.equal(clampWaitSec(700, 'PLAN'), 540);
  assert.equal(clampWaitSec(540, 'EXECUTE'), 540);
  assert.equal(clampWaitSec(300, 'EXECUTE'), 300);
});

test('clampWaitSec: defaults missing/zero/non-numeric to 480', async () => {
  const { clampWaitSec } = await import('./server.mjs');
  assert.equal(clampWaitSec(undefined, 'EXECUTE'), 480);
  assert.equal(clampWaitSec(null, 'EXECUTE'), 480);
  assert.equal(clampWaitSec(0, 'EXECUTE'), 480);
  assert.equal(clampWaitSec('not a number', 'EXECUTE'), 480);
  assert.equal(clampWaitSec(undefined, 'ANALYZE'), 480);
});

test('clampWaitSec: floor of 1 (no zero-wait races)', async () => {
  const { clampWaitSec } = await import('./server.mjs');
  assert.equal(clampWaitSec(1, 'EXECUTE'), 1);
  // Note: 0 hits the `|| 480` default branch above; only positive values
  // smaller than 1 (which Number can produce from string '0.5') flow through
  // the floor.
  assert.equal(clampWaitSec(0.4, 'EXECUTE'), 1);
});

// ---------- formatTerminalContent: timeout + unreachable branches ----------

test('formatTerminalContent: timeout body lists decompose / scope_hint / parallel:false', async () => {
  // formatTerminalContent isn't exported directly, so we exercise it via the
  // emitNotification → enqueueEvent path is too heavy. Instead, drive it
  // through a test-only re-import of the module's internal: easiest is to
  // shape a stuck-style synthetic job and call formatTerminalContent through
  // its public path. Since the function isn't exported, we test the *content*
  // contract via an integration assertion: handle a synthetic timeout job
  // through buildWaitResponse.
  const mod = await import('./server.mjs');
  const { jobs } = mod;
  const jobId = 'job-test-timeout';
  jobs.set(jobId, {
    jobId,
    status: 'timeout',
    task: 'analyze a giant file',
    mode: 'ANALYZE',
    durationMs: 540_000,
    failedTools: ['view', 'grep'],
    promptId: 'p-timeout',
    sessionId: 's-timeout',
    thread: 'companion-test',
    startedAt: Date.now() - 540_000,
    terminalAt: Date.now(),
    retentionExpiresAt: Date.now() + 60_000,
  });
  try {
    const res = await mod.dispatch({ action: 'wait', job_id: jobId, max_wait_sec: 1 });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.status, 'timeout');
    assert.match(body.content, /Copilot's model turn did not finish/);
    assert.match(body.content, /Decompose the task/);
    assert.match(body.content, /scope_hint/);
    assert.match(body.content, /parallel: false/);
    assert.match(body.content, /\*\*Failed tools:\*\* view, grep/);
  } finally {
    jobs.delete(jobId);
  }
});

test('formatTerminalContent: unreachable body cites daemon / log paths', async () => {
  const mod = await import('./server.mjs');
  const { jobs } = mod;
  const jobId = 'job-test-unreachable';
  jobs.set(jobId, {
    jobId,
    status: 'unreachable',
    task: 'something',
    mode: 'EXECUTE',
    detail: 'bridge_daemon_unreachable',
    durationMs: 1000,
    failedTools: [],
    startedAt: Date.now() - 1000,
    terminalAt: Date.now(),
    retentionExpiresAt: Date.now() + 60_000,
  });
  try {
    const res = await mod.dispatch({ action: 'wait', job_id: jobId, max_wait_sec: 1 });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.status, 'unreachable');
    assert.match(body.content, /Bridge could not reach the Copilot daemon/);
    assert.match(body.content, /detail: bridge_daemon_unreachable/);
    assert.match(body.content, /copilot-acp-daemon/);
    assert.equal(body.meta.detail, 'bridge_daemon_unreachable');
  } finally {
    jobs.delete(jobId);
  }
});

// ---------- buildJobResponse: status precedence + detail ----------

test('buildJobResponse: bridge timeout wins over inspect data.status', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  const job = {
    jobId: 'j1', status: 'timeout', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
    detail: null,
  };
  // Daemon inspect comes back saying "failed" (which would be the underlying
  // raw status it knows about) — bridge remap to "timeout" must win.
  const out = buildJobResponse(job, { status: 'failed', stuckReason: null });
  assert.equal(out.status, 'timeout');
});

test('buildJobResponse: bridge unreachable wins over inspect data.status', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  const job = {
    jobId: 'j2', status: 'unreachable', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
    detail: 'bridge_daemon_unreachable',
  };
  const out = buildJobResponse(job, { status: 'completed', summary: { message: 'oops' } });
  assert.equal(out.status, 'unreachable');
});

test('buildJobResponse: inspect status wins for non-bridge-remap statuses', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  // Mid-flight job: inspect is the source of truth for live status.
  const job = { jobId: 'j3', status: 'starting', startedAt: Date.now() };
  const out = buildJobResponse(job, { status: 'running' });
  assert.equal(out.status, 'running');
});

test('buildJobResponse: surfaces detail field when set on job', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  const job = {
    jobId: 'j4', status: 'unreachable', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
    detail: 'bridge_timeout',
  };
  const out = buildJobResponse(job);
  assert.equal(out.detail, 'bridge_timeout');
});

test('buildJobResponse: detail null when not set', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  const job = {
    jobId: 'j5', status: 'completed', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
  };
  const out = buildJobResponse(job);
  assert.equal(out.detail, null);
});

test('buildJobResponse: ignores spurious data.detail (bridge-owned)', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  // If a future daemon change starts emitting a `detail` field, the bridge's
  // authoritative value (or null) must still win — daemon should not be able
  // to override the bridge's status-detail invariant.
  const job = {
    jobId: 'j6', status: 'completed', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
    detail: null,
  };
  const out = buildJobResponse(job, { status: 'completed', detail: 'spurious_from_daemon' });
  assert.equal(out.detail, null);
});

// ---------- session rebirth signaling ----------

test('formatTerminalContent: rebirth banner prepended when sessionReborn=true', async () => {
  const { formatTerminalContent } = await import('./server.mjs');
  const body = formatTerminalContent({
    jobId: 'jr1', status: 'completed', task: 'continue thread',
    mode: 'EXECUTE', durationMs: 1234,
    summary: { message: 'OK\n\nRUBBER-DUCK: clean.', toolCalls: [] },
    error: null, stuckReason: null, detail: null, failedTools: [],
    promptId: 'p1', sessionReborn: true,
  });
  assert.match(body, /Copilot session was respawned mid-thread/);
  assert.match(body, /prior in-process conversation context was lost/);
  // Banner precedes the Task: header so the warning is visible before any
  // model output the user reads.
  const bannerIdx = body.indexOf('respawned mid-thread');
  const taskIdx = body.indexOf('Task:');
  assert.ok(bannerIdx >= 0 && taskIdx > bannerIdx, 'banner must precede Task header');
});

test('formatTerminalContent: no banner when sessionReborn is falsy', async () => {
  const { formatTerminalContent } = await import('./server.mjs');
  const body = formatTerminalContent({
    jobId: 'jr2', status: 'completed', task: 'normal call',
    mode: 'EXECUTE', durationMs: 1000,
    summary: { message: 'done\n\nRUBBER-DUCK: clean.', toolCalls: [] },
    error: null, stuckReason: null, detail: null, failedTools: [],
    promptId: 'p2',
  });
  assert.doesNotMatch(body, /respawned mid-thread/);
});

test('buildWaitResponse: surfaces meta.session_reborn when job has the flag', async () => {
  const mod = await import('./server.mjs');
  const { jobs } = mod;
  const jobId = 'jr-wait';
  jobs.set(jobId, {
    jobId, status: 'completed', task: 't', mode: 'EXECUTE',
    promptId: 'p', sessionId: 's-new', thread: 'companion-x',
    startedAt: Date.now() - 1000, terminalAt: Date.now(),
    retentionExpiresAt: Date.now() + 60_000,
    durationMs: 1000, failedTools: [],
    summary: { message: 'k\n\nRUBBER-DUCK: clean.', toolCalls: [] },
    sessionReborn: true,
  });
  try {
    const res = await mod.dispatch({ action: 'wait', job_id: jobId, max_wait_sec: 1 });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.meta.session_reborn, 'true');
    assert.match(body.content, /respawned mid-thread/);
  } finally {
    jobs.delete(jobId);
  }
});

test('buildWaitResponse: still_running surfaces session_reborn so polls see it before terminal', async () => {
  const mod = await import('./server.mjs');
  const { jobs } = mod;
  const jobId = 'jr-still';
  jobs.set(jobId, {
    jobId, status: 'running', task: 't', mode: 'EXECUTE',
    promptId: 'p', sessionId: 's-new', thread: 'companion-x',
    startedAt: Date.now() - 5000,
    sessionReborn: true,
  });
  try {
    // Use a 1s wait_sec so the wait resolves on timeout (still_running),
    // not by terminal completion.
    const res = await mod.dispatch({ action: 'wait', job_id: jobId, max_wait_sec: 1 });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.status, 'still_running');
    assert.equal(body.session_reborn, true);
  } finally {
    jobs.delete(jobId);
  }
});

test('buildJobResponse: session_reborn boolean reflects job field', async () => {
  const { buildJobResponse } = await import('./server.mjs');
  const reborn = buildJobResponse({
    jobId: 'j-rb', status: 'completed', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
    sessionReborn: true,
  });
  assert.equal(reborn.session_reborn, true);
  const normal = buildJobResponse({
    jobId: 'j-norm', status: 'completed', startedAt: Date.now() - 1000,
    terminalAt: Date.now(), retentionExpiresAt: Date.now() + 60_000,
  });
  assert.equal(normal.session_reborn, false);
});

// ---------- emitNotification: queue write carries meta.detail ----------

test('emitNotification: writes meta.detail to queue file when detail set', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // Redirect queue path BEFORE invoking emitNotification (getQueuePath is
  // resolved per-call, so this works even after server.mjs has been imported).
  const tmp = mkdtempSync(join(tmpdir(), 'copilot-queue-test-'));
  const queueFile = join(tmp, 'completions.jsonl');
  const oldQ = process.env.COPILOT_QUEUE_PATH;
  process.env.COPILOT_QUEUE_PATH = queueFile;
  try {
    const { emitNotification } = await import('./server.mjs');
    emitNotification({
      jobId: 'j-notif',
      status: 'unreachable',
      summary: null,
      error: null,
      stuckReason: null,
      detail: 'bridge_daemon_unreachable',
      duration: 1234,
      task: 'X',
      mode: 'EXECUTE',
      cwd: '/tmp',
    });
    const content = readFileSync(queueFile, 'utf8');
    const event = JSON.parse(content.trim().split('\n').pop());
    assert.equal(event.kind, 'terminal');
    assert.equal(event.meta.status, 'unreachable');
    assert.equal(event.meta.detail, 'bridge_daemon_unreachable');
  } finally {
    if (oldQ === undefined) delete process.env.COPILOT_QUEUE_PATH; else process.env.COPILOT_QUEUE_PATH = oldQ;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('emitNotification: remaps Copilot CAPI failure (completed → failed + detail)', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'copilot-queue-test-'));
  const queueFile = join(tmp, 'completions.jsonl');
  const oldQ = process.env.COPILOT_QUEUE_PATH;
  process.env.COPILOT_QUEUE_PATH = queueFile;
  try {
    const { emitNotification } = await import('./server.mjs');
    emitNotification({
      jobId: 'j-capi',
      status: 'completed',
      summary: {
        stopReason: 'end_turn',
        message: 'Info: Request failed due to a transient API error. Retrying...\nError: Execution failed: Error: Failed to get response from the AI model; retried 5 times (total retry wait time: 5.47 seconds) Last error: CAPIError: Request timed out.',
      },
      error: null,
      stuckReason: null,
      detail: null,
      duration: 142383,
      task: 'X',
      mode: 'EXECUTE',
      cwd: '/tmp',
    });
    const content = readFileSync(queueFile, 'utf8');
    const event = JSON.parse(content.trim().split('\n').pop());
    assert.equal(event.kind, 'terminal');
    assert.equal(event.meta.status, 'failed');
    assert.equal(event.meta.detail, 'copilot_capi_failure');
    assert.equal(event.meta.stop_reason, 'end_turn');
  } finally {
    if (oldQ === undefined) delete process.env.COPILOT_QUEUE_PATH; else process.env.COPILOT_QUEUE_PATH = oldQ;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('emitNotification: normal completed message is not remapped', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'copilot-queue-test-'));
  const queueFile = join(tmp, 'completions.jsonl');
  const oldQ = process.env.COPILOT_QUEUE_PATH;
  process.env.COPILOT_QUEUE_PATH = queueFile;
  try {
    const { emitNotification } = await import('./server.mjs');
    emitNotification({
      jobId: 'j-ok',
      status: 'completed',
      summary: {
        stopReason: 'end_turn',
        message: 'All checks pass.\nRUBBER-DUCK: clean.',
      },
      error: null,
      stuckReason: null,
      detail: null,
      duration: 2000,
      task: 'X',
      mode: 'EXECUTE',
      cwd: '/tmp',
    });
    const content = readFileSync(queueFile, 'utf8');
    const event = JSON.parse(content.trim().split('\n').pop());
    assert.equal(event.meta.status, 'completed');
    assert.equal(event.meta.detail, undefined);
    assert.equal(event.meta.rubber_duck, 'clean');
  } finally {
    if (oldQ === undefined) delete process.env.COPILOT_QUEUE_PATH; else process.env.COPILOT_QUEUE_PATH = oldQ;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('persistJob writes file; gcExpiredJobs evicts in-memory entry and deletes file', async () => {
  const { existsSync } = await import('node:fs');
  const { jobs, gcExpiredJobs, persistJob } = await import('./server.mjs');
  const state = await import('../lib/state.mjs');

  jobs.set('j-gc', {
    jobId: 'j-gc',
    claudeSessionId: 'sid-X',
    sessionId: 'cop-sid-1',
    status: 'completed',
    terminalAt: Date.now() - 10_000,
    retentionExpiresAt: Date.now() - 5_000,
  });
  persistJob('j-gc');

  const filePath = join(state.JOBS_DIR, 'j-gc.json');
  assert.equal(existsSync(filePath), true, 'persisted file written under sandbox');

  // sessionId in-memory → copilotSessionId on disk; claudeSessionId preserved.
  const persisted = state.readJob('j-gc');
  assert.equal(persisted.copilotSessionId, 'cop-sid-1');
  assert.equal(persisted.claudeSessionId, 'sid-X');
  assert.equal(persisted.sessionId, undefined, 'in-memory `sessionId` field is renamed, not duplicated');

  gcExpiredJobs();
  assert.equal(jobs.has('j-gc'), false, 'in-memory entry evicted');
  assert.equal(existsSync(filePath), false, 'persisted file deleted');
});

test('getHostSessionId rejects literal ${VAR} placeholder from unexpanded env block', async () => {
  const { getHostSessionId, _resetForTest } = await import('./server.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  _resetForTest();
  process.env.CLAUDE_CODE_SESSION_ID = '${CLAUDE_CODE_SESSION_ID}';
  try {
    assert.equal(getHostSessionId(), null,
      'literal placeholder must NOT be treated as a valid sid');
  } finally {
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('dispatch adopts host_session_id from arg when env is unset', async () => {
  const { dispatch, getHostSessionId, _resetForTest } = await import('./server.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  _resetForTest();
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    // Unknown job_id is fine — we're just verifying adoption side-effect.
    // host_session_id is the post-validation contract field (dispatch consumes
    // the normalized object). Direct dispatch tests must use this name;
    // claude_session_id alias acceptance is exercised via validateCopilotArgs
    // in validation.test.mjs.
    await dispatch({ action: 'wait', job_id: 'no-such', max_wait_sec: 1, host_session_id: 'arg-adopted-sid' });
    assert.equal(getHostSessionId(), 'arg-adopted-sid', 'bridge adopted sid from MCP arg');
  } finally {
    if (oldS !== undefined) process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('dispatch adopts arg sid even when env carries a literal placeholder', async () => {
  const { dispatch, getHostSessionId, _resetForTest } = await import('./server.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  _resetForTest();
  process.env.CLAUDE_CODE_SESSION_ID = '${CLAUDE_CODE_SESSION_ID}';
  try {
    await dispatch({ action: 'status', job_id: null, verbose: false, host_session_id: 'real-uuid-xyz' });
    assert.equal(getHostSessionId(), 'real-uuid-xyz',
      'arg overrides broken-env literal placeholder');
  } finally {
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('validateCopilotArgs + dispatch round-trip: claude_session_id alias is normalized into host_session_id', async () => {
  // Proves the full flow: legacy Claude callers passing `claude_session_id`
  // still work — validation normalizes the field to host_session_id, dispatch
  // adopts via the normalized object.
  const { dispatch, getHostSessionId, _resetForTest } = await import('./server.mjs');
  const { validateCopilotArgs } = await import('./validation.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  _resetForTest();
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const normalized = validateCopilotArgs({
      action: 'status',
      job_id: null,
      claude_session_id: 'legacy-claude-sid',
    });
    assert.equal(normalized.host_session_id, 'legacy-claude-sid',
      'validation normalized claude_session_id input → host_session_id field');
    await dispatch(normalized);
    assert.equal(getHostSessionId(), 'legacy-claude-sid');
  } finally {
    if (oldS !== undefined) process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('MCP _meta["x-codex-turn-metadata"].session_id is adoptable as the primary Codex path', async () => {
  // Codex flow: server.mjs's CallToolRequestSchema handler extracts
  // request.params._meta["x-codex-turn-metadata"].session_id and calls
  // adoptHostSessionId before dispatch. We can't easily wire the MCP
  // transport in a unit test, so we exercise the same helper directly
  // — that's what the handler calls.
  const { adoptHostSessionId, getHostSessionId, _resetForTest } = await import('./server.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  _resetForTest();
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const codexSid = '019e0dc8-94b3-7172-abeb-60578f8a8a8d';
    adoptHostSessionId(codexSid);
    assert.equal(getHostSessionId(), codexSid,
      'bridge adopted sid from simulated _meta path');
  } finally {
    if (oldS !== undefined) process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('_meta-adopted sid wins over later host_session_id arg with different value (BRIDGE_SID_CONFLICT)', async () => {
  // Ordering invariant: the MCP handler calls adoptHostSessionId(metaSid)
  // BEFORE dispatch — so once _meta wins, a conflicting arg-side adoption
  // is rejected with BRIDGE_SID_CONFLICT and dispatch short-circuits
  // before the action runs. This is the contract the drain hook depends
  // on (the bridge tags queue rows with the same sid Codex sends to hook
  // stdin); silent-ignore would let a misrouted call land on the wrong
  // session's ledger.
  const { adoptHostSessionId, dispatch, getHostSessionId, _resetForTest } = await import('./server.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  _resetForTest();
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    adoptHostSessionId('meta-sid-codex');
    const result = await dispatch({
      action: 'status', job_id: null, verbose: false,
      host_session_id: 'arg-sid-different',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.ok, false, 'mismatched arg-sid yields ok:false');
    assert.equal(parsed.code, 'BRIDGE_SID_CONFLICT', 'error code surfaces conflict');
    assert.match(parsed.error, /sid conflict/i, 'error message describes the conflict');
    assert.equal(getHostSessionId(), 'meta-sid-codex',
      'meta-adopted sid retained even though the arg-side adoption was rejected');
  } finally {
    if (oldS !== undefined) process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('matching second adoption (meta then arg with same sid) is silently accepted', async () => {
  // Guard against accidental over-strictness: only differing sids should
  // throw. A second adoption of the *same* sid (e.g. _meta on turn 1,
  // matching host_session_id arg on turn 2) is a no-op, and dispatch
  // proceeds to the action.
  const { adoptHostSessionId, dispatch, getHostSessionId, _resetForTest } = await import('./server.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  _resetForTest();
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    adoptHostSessionId('shared-sid');
    const result = await dispatch({
      action: 'status', job_id: null, verbose: false,
      host_session_id: 'shared-sid',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.ok, true, 'matching arg-sid is accepted; status action runs');
    assert.notEqual(parsed.code, 'BRIDGE_SID_CONFLICT', 'no conflict reported on match');
    assert.equal(getHostSessionId(), 'shared-sid', 'sid stays bound to the agreed value');
  } finally {
    if (oldS !== undefined) process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

// Note: not asserting send-with-arg-sid via dispatch — handleSend kicks off a
// background runWorker that contacts the real daemon, which would burn live
// Copilot tokens. The gate logic is exercised end-to-end by the integration
// run from a copilot-companion subagent (see /tmp/copilot-bridge.log line
// "sid adopted: <uuid>" after a real subagent dispatch).

test('resolveSendThread: explicit args.thread wins over stored mapping', async () => {
  const { resolveSendThread } = await import('./server.mjs');
  const state = await import('../lib/state.mjs');
  const sid = 'codex-sid-explicit-wins';
  state.writeHostSessionThread(sid, 'stored-thread');
  try {
    const out = resolveSendThread('caller-thread', sid, 'copilot-job1');
    assert.equal(out, 'caller-thread', 'explicit caller thread wins');
    assert.equal(state.readHostSessionThread(sid), 'caller-thread',
      'mapping is updated to caller-supplied thread');
  } finally {
    state.clearHostSessionThread(sid);
  }
});

test('resolveSendThread: falls back to stored mapping when no args.thread', async () => {
  const { resolveSendThread } = await import('./server.mjs');
  const state = await import('../lib/state.mjs');
  const sid = 'codex-sid-stored-fallback';
  state.writeHostSessionThread(sid, 'companion-prior-job');
  try {
    const out = resolveSendThread(null, sid, 'copilot-job2');
    assert.equal(out, 'companion-prior-job',
      'stored host-session thread reused');
  } finally {
    state.clearHostSessionThread(sid);
  }
});

test('resolveSendThread: auto-generates and persists when neither caller-supplied nor stored', async () => {
  const { resolveSendThread } = await import('./server.mjs');
  const state = await import('../lib/state.mjs');
  const sid = 'codex-sid-fresh';
  state.clearHostSessionThread(sid);
  try {
    const out = resolveSendThread(null, sid, 'copilot-jobNEW');
    assert.equal(out, 'companion-copilot-jobNEW', 'auto thread name follows companion-<jobId>');
    assert.equal(state.readHostSessionThread(sid), 'companion-copilot-jobNEW',
      'mapping persisted for next send');
  } finally {
    state.clearHostSessionThread(sid);
  }
});

test('resolveSendThread: no host session id → no state-file work, plain auto-generation', async () => {
  const { resolveSendThread } = await import('./server.mjs');
  const out = resolveSendThread(null, '', 'copilot-jobNOSID');
  assert.equal(out, 'companion-copilot-jobNOSID');
});

test('resolveSendThread: host session id with disallowed chars is sanitized for file path', async () => {
  const { resolveSendThread } = await import('./server.mjs');
  const state = await import('../lib/state.mjs');
  const rawSid = 'codex/has spaces!';
  const sanitized = 'codex_has_spaces_';
  try {
    const out = resolveSendThread(null, rawSid, 'copilot-jobX');
    assert.equal(out, 'companion-copilot-jobX');
    assert.equal(state.readHostSessionThread(sanitized), 'companion-copilot-jobX',
      'mapping is keyed by sanitized id (raw path would be invalid)');
  } finally {
    state.clearHostSessionThread(sanitized);
  }
});

test('hydrateJobsFromLedger claims own-session jobs, ignores other-session jobs', async () => {
  const { jobs, hydrateJobsFromLedger } = await import('./server.mjs');
  const state = await import('../lib/state.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-hydrate-A';
  try {
    state.writeJob('j-mine-terminal', {
      jobId: 'j-mine-terminal', claudeSessionId: 'sid-hydrate-A',
      copilotSessionId: 'cop-1', thread: null,
      status: 'completed', startedAt: 1000, terminalAt: 2000,
      retentionExpiresAt: Date.now() + 60_000,
    });
    state.writeJob('j-other-session', {
      jobId: 'j-other-session', claudeSessionId: 'sid-other-B',
      status: 'running', startedAt: 1000,
    });

    jobs.clear();
    const { _resetForTest } = await import('./server.mjs');
    _resetForTest();
    hydrateJobsFromLedger();

    assert.equal(jobs.has('j-mine-terminal'), true, 'own session terminal job claimed');
    assert.equal(jobs.has('j-other-session'), false, 'other-session job NOT claimed');
    const claimed = jobs.get('j-mine-terminal');
    assert.equal(claimed.sessionId, 'cop-1', 'persisted copilotSessionId restored as in-memory sessionId');

    state.deleteJob('j-mine-terminal');
    state.deleteJob('j-other-session');
    jobs.clear();
  } finally {
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('hydrateJobsFromLedger restores thread→sid mapping for resumed jobs', async () => {
  const { jobs, hydrateJobsFromLedger } = await import('./server.mjs');
  const state = await import('../lib/state.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-hydrate-thread';
  try {
    state.clearThread('thread-restored');
    state.writeJob('j-with-thread', {
      jobId: 'j-with-thread', claudeSessionId: 'sid-hydrate-thread',
      copilotSessionId: 'cop-thread-sid', thread: 'thread-restored',
      status: 'completed', startedAt: 1000, terminalAt: 2000,
      retentionExpiresAt: Date.now() + 60_000,
    });

    jobs.clear();
    const { _resetForTest } = await import('./server.mjs');
    _resetForTest();
    hydrateJobsFromLedger();

    assert.equal(state.readThreadSid('thread-restored'), 'cop-thread-sid',
      'thread sid file restored from ledger');

    state.deleteJob('j-with-thread');
    state.clearThread('thread-restored');
    jobs.clear();
  } finally {
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('rehydrated terminal job: dispatch wait marks the queue row consumed (no double-delivery)', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { jobs, dispatch, hydrateJobsFromLedger } = await import('./server.mjs');
  const state = await import('../lib/state.mjs');

  const tmpQ = mkdtempSync(join(tmpdir(), 'copilot-rehydrate-q-'));
  const queueFile = join(tmpQ, 'q.jsonl');
  const oldQ = process.env.COPILOT_QUEUE_PATH;
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.COPILOT_QUEUE_PATH = queueFile;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-rehydrate-A';

  try {
    // Pre-bridge state: terminal job persisted, plus one unconsumed queue row
    // for that job (as if the previous bridge wrote it before dying).
    state.writeJob('j-rehydrated', {
      jobId: 'j-rehydrated', claudeSessionId: 'sid-rehydrate-A',
      copilotSessionId: 'cop-rh', thread: null,
      task: 'old task', mode: 'EXECUTE',
      status: 'completed',
      summary: { message: 'all done' },
      error: null, stuckReason: null, detail: null,
      startedAt: Date.now() - 5000, terminalAt: Date.now() - 1000,
      retentionExpiresAt: Date.now() + 60_000,
    });
    const queueRow = {
      ts: Date.now() - 1000, kind: 'terminal', jobId: 'j-rehydrated',
      claudeSessionId: 'sid-rehydrate-A', consumed: false,
      content: 'all done', meta: { status: 'completed' },
    };
    writeFileSync(queueFile, JSON.stringify(queueRow) + '\n');

    jobs.clear();
    const { _resetForTest } = await import('./server.mjs');
    _resetForTest();
    hydrateJobsFromLedger();
    assert.equal(jobs.has('j-rehydrated'), true, 'rehydrated into in-memory map');

    // Subagent (re-spawned by Claude Code on a fresh bridge) calls wait.
    const result = await dispatch({ action: 'wait', job_id: 'j-rehydrated', max_wait_sec: 1 });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'completed');

    // The queue row should now be consumed:true so the next drain cycle
    // doesn't re-deliver the same content the wait response just carried.
    const post = readFileSync(queueFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(post.length, 1);
    assert.equal(post[0].consumed, true, 'queue row marked consumed by wait response');

    state.deleteJob('j-rehydrated');
    jobs.clear();
  } finally {
    if (oldQ === undefined) delete process.env.COPILOT_QUEUE_PATH; else process.env.COPILOT_QUEUE_PATH = oldQ;
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    rmSync(tmpQ, { recursive: true, force: true });
  }
});

test('hydrateJobsFromLedger marks starting-without-promptId as unreachable', async () => {
  const { jobs, hydrateJobsFromLedger } = await import('./server.mjs');
  const state = await import('../lib/state.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-hydrate-orphan';
  try {
    state.writeJob('j-orphan', {
      jobId: 'j-orphan', claudeSessionId: 'sid-hydrate-orphan',
      status: 'starting', startedAt: 1000,
      // no promptId, no terminalAt
    });

    jobs.clear();
    const { _resetForTest } = await import('./server.mjs');
    _resetForTest();
    hydrateJobsFromLedger();
    const claimed = jobs.get('j-orphan');
    assert.ok(claimed, 'orphan claimed');
    assert.equal(claimed.status, 'unreachable');
    assert.equal(claimed.detail, 'rehydrate_no_promptid');

    state.deleteJob('j-orphan');
    jobs.clear();
  } finally {
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('sweepOwnSessionStaleQueueRows drops own stale rows, keeps fresh and other-session', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { sweepOwnSessionStaleQueueRows } = await import('./server.mjs');

  const tmp = mkdtempSync(join(tmpdir(), 'copilot-sweep-test-'));
  const queueFile = join(tmp, 'q.jsonl');
  const oldQ = process.env.COPILOT_QUEUE_PATH;
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.COPILOT_QUEUE_PATH = queueFile;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-sweep-A';
  try {
    const NOW = Date.now();
    const rows = [
      { ts: NOW - 90_000, kind: 'alert', jobId: 'j-mine-old', claudeSessionId: 'sid-sweep-A', consumed: false, content: 'mine-old' },
      { ts: NOW - 30_000, kind: 'alert', jobId: 'j-mine-fresh', claudeSessionId: 'sid-sweep-A', consumed: false, content: 'mine-fresh' },
      { ts: NOW - 90_000, kind: 'alert', jobId: 'j-other-old', claudeSessionId: 'sid-sweep-B', consumed: false, content: 'other-old' },
    ];
    writeFileSync(queueFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    sweepOwnSessionStaleQueueRows(NOW);

    const remaining = readFileSync(queueFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const ids = remaining.map((r) => r.jobId).sort();
    assert.deepEqual(ids, ['j-mine-fresh', 'j-other-old'],
      'own-session stale dropped; fresh own and other-session retained');
  } finally {
    if (oldQ === undefined) delete process.env.COPILOT_QUEUE_PATH; else process.env.COPILOT_QUEUE_PATH = oldQ;
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('persistJob skips when claudeSessionId is null (untagged jobs not persisted)', async () => {
  const { existsSync } = await import('node:fs');
  const { jobs, persistJob } = await import('./server.mjs');
  const state = await import('../lib/state.mjs');

  jobs.set('j-untagged', { jobId: 'j-untagged', status: 'starting', startedAt: Date.now() });
  persistJob('j-untagged');

  const filePath = join(state.JOBS_DIR, 'j-untagged.json');
  assert.equal(existsSync(filePath), false, 'untagged job not persisted');
  jobs.delete('j-untagged');
});

test('emitNotification: stamps claudeSessionId from env on the queue event', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'copilot-queue-test-'));
  const queueFile = join(tmp, 'completions.jsonl');
  const oldQ = process.env.COPILOT_QUEUE_PATH;
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.COPILOT_QUEUE_PATH = queueFile;
  process.env.CLAUDE_CODE_SESSION_ID = 'cc-test-session-abc';
  try {
    const { emitNotification } = await import('./server.mjs');
    emitNotification({
      jobId: 'j-sid', status: 'completed', summary: { message: 'ok' },
      duration: 10, task: 'X', mode: 'EXECUTE', cwd: '/tmp',
    });
    const event = JSON.parse(readFileSync(queueFile, 'utf8').trim().split('\n').pop());
    assert.equal(event.claudeSessionId, 'cc-test-session-abc');
  } finally {
    if (oldQ === undefined) delete process.env.COPILOT_QUEUE_PATH; else process.env.COPILOT_QUEUE_PATH = oldQ;
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('emitNotification: writes claudeSessionId=null when env unset', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'copilot-queue-test-'));
  const queueFile = join(tmp, 'completions.jsonl');
  const oldQ = process.env.COPILOT_QUEUE_PATH;
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.COPILOT_QUEUE_PATH = queueFile;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const { emitNotification } = await import('./server.mjs');
    emitNotification({
      jobId: 'j-no-sid', status: 'completed', summary: { message: 'ok' },
      duration: 10, task: 'X', mode: 'EXECUTE', cwd: '/tmp',
    });
    const event = JSON.parse(readFileSync(queueFile, 'utf8').trim().split('\n').pop());
    assert.equal(event.claudeSessionId, null);
  } finally {
    if (oldQ === undefined) delete process.env.COPILOT_QUEUE_PATH; else process.env.COPILOT_QUEUE_PATH = oldQ;
    if (oldS !== undefined) process.env.CLAUDE_CODE_SESSION_ID = oldS;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('emitNotification: omits meta.detail when no detail provided', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'copilot-queue-test-'));
  const queueFile = join(tmp, 'completions.jsonl');
  const oldQ = process.env.COPILOT_QUEUE_PATH;
  process.env.COPILOT_QUEUE_PATH = queueFile;
  try {
    const { emitNotification } = await import('./server.mjs');
    emitNotification({
      jobId: 'j-notif-no-detail',
      status: 'completed',
      summary: { message: 'done.\n\nRUBBER-DUCK: clean.' },
      duration: 100,
      task: 'X',
      mode: 'EXECUTE',
      cwd: '/tmp',
    });
    const content = readFileSync(queueFile, 'utf8');
    const event = JSON.parse(content.trim().split('\n').pop());
    assert.equal(event.meta.status, 'completed');
    assert.equal(event.meta.detail, undefined);
  } finally {
    if (oldQ === undefined) delete process.env.COPILOT_QUEUE_PATH; else process.env.COPILOT_QUEUE_PATH = oldQ;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- classifyRubberDuck: multi-verdict (fleet sub-agents) ----------

test('classifyRubberDuck: multiple clean verdicts → clean', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  const msg = 'sub-agent A:\n\nRUBBER-DUCK: clean.\n\nsub-agent B:\n\nRUBBER-DUCK: clean.';
  assert.equal(classifyRubberDuck(msg), 'clean');
});

test('classifyRubberDuck: one revised among many cleans → revised (fail-pessimistic)', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  const msg = 'sub-agent A:\n\nRUBBER-DUCK: clean.\n\nsub-agent B:\n\nRUBBER-DUCK: revised — fixed a hallucination.\n\nsub-agent C:\n\nRUBBER-DUCK: clean.';
  // Earlier behavior (using .match instead of .matchAll) would silently
  // downgrade this to "clean" because the first match wins.
  assert.equal(classifyRubberDuck(msg), 'revised');
});

test('classifyRubberDuck: revised then clean → revised', async () => {
  const { classifyRubberDuck } = await import('./server.mjs');
  const msg = 'RUBBER-DUCK: revised — note.\n\nlater: RUBBER-DUCK: clean.';
  assert.equal(classifyRubberDuck(msg), 'revised');
});

test('buildWaitResponse: meta.detail omitted when no detail set', async () => {
  const mod = await import('./server.mjs');
  const { jobs } = mod;
  const jobId = 'job-test-completed';
  jobs.set(jobId, {
    jobId,
    status: 'completed',
    task: 'X',
    mode: 'EXECUTE',
    durationMs: 1000,
    failedTools: [],
    summary: { message: 'done.\n\nRUBBER-DUCK: clean.' },
    startedAt: Date.now() - 1000,
    terminalAt: Date.now(),
    retentionExpiresAt: Date.now() + 60_000,
  });
  try {
    const res = await mod.dispatch({ action: 'wait', job_id: jobId, max_wait_sec: 1 });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.status, 'completed');
    assert.equal(body.meta.detail, undefined);
  } finally {
    jobs.delete(jobId);
  }
});

// ---------- handleSend: bridge-side reattach + daemon SESSION_BUSY translation ----

// Set up the daemon-client test seam. Each test below stubs sendToSocket /
// ensureDaemon to a scenario-specific impl and resets at the end. Order
// matters: import server.mjs first so we know daemon-client.mjs is on the
// module-loader path with its public wrappers intact.
async function withDaemonStubs(stubs, body) {
  const daemonClient = await import('./daemon-client.mjs');
  daemonClient._setForTest(stubs);
  try { return await body(); }
  finally { daemonClient._resetForTest(); }
}

test('handleSend reattaches to a non-terminal job for the same thread + host sid', async () => {
  const { dispatch, jobs, _resetForTest } = await import('./server.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-reattach-A';
  let socketCalls = 0;
  jobs.set('copilot-existing-1', {
    jobId: 'copilot-existing-1',
    claudeSessionId: 'sid-reattach-A',
    thread: 'thread-reattach-A',
    status: 'running',
    promptId: 'prompt-existing-1',
    sessionId: 'cop-sid-1',
    startedAt: Date.now() - 5_000,
  });
  try {
    const body = await withDaemonStubs(
      {
        ensureDaemon: async () => { socketCalls++; },
        sendToSocket: async () => { socketCalls++; throw new Error('reattach must not touch the daemon'); },
      },
      async () => {
        const res = await dispatch({
          action: 'send',
          task: 'reattach me',
          mode: 'EXECUTE',
          template: 'general',
          thread: 'thread-reattach-A',
          host_session_id: 'sid-reattach-A',
          max_wait_sec: 1, // force still_running timeout
          parallel: false,
        });
        return JSON.parse(res.content[0].text);
      },
    );
    assert.equal(body.status, 'still_running', 'reattach + waitForJob timeout → still_running');
    assert.equal(body.job_id, 'copilot-existing-1', 'must surface the pre-existing job id, not a fresh one');
    assert.equal(body.reattached, true, 'still_running response must carry reattached:true');
    assert.equal(socketCalls, 0, 'reattach branch must skip both ensureDaemon and sendToSocket');
  } finally {
    jobs.delete('copilot-existing-1');
    _resetForTest();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('handleSend reattach surfaces meta.reattached on terminal flip mid-wait', async () => {
  const { dispatch, jobs, retainTerminalJob, _resetForTest } = await import('./server.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-reattach-B';
  jobs.set('copilot-existing-2', {
    jobId: 'copilot-existing-2',
    claudeSessionId: 'sid-reattach-B',
    thread: 'thread-reattach-B',
    status: 'running',
    promptId: 'prompt-existing-2',
    sessionId: 'cop-sid-2',
    startedAt: Date.now() - 5_000,
  });
  try {
    const body = await withDaemonStubs(
      {
        ensureDaemon: async () => {},
        sendToSocket: async () => { throw new Error('reattach must not touch the daemon'); },
      },
      async () => {
        // Schedule the terminal flip slightly after dispatch parks its waiter.
        // retainTerminalJob fires resolveAllWaiters, so the still-running
        // handleSend's waitForJob resolves with terminal:true and
        // buildWaitResponse takes the terminal branch — which is where the
        // meta.reattached flag is written.
        setImmediate(() => {
          retainTerminalJob('copilot-existing-2', {
            status: 'completed',
            summary: { message: 'done.\n\nRUBBER-DUCK: clean.' },
            durationMs: 4_000,
            terminalAt: Date.now(),
          });
        });
        const res = await dispatch({
          action: 'send',
          task: 'reattach me again',
          mode: 'EXECUTE',
          template: 'general',
          thread: 'thread-reattach-B',
          host_session_id: 'sid-reattach-B',
          max_wait_sec: 5,
          parallel: false,
        });
        return JSON.parse(res.content[0].text);
      },
    );
    assert.equal(body.status, 'completed', 'terminal flip drives status=completed');
    assert.equal(body.job_id, 'copilot-existing-2');
    assert.equal(body.meta.reattached, 'true', 'terminal payload must surface meta.reattached');
  } finally {
    jobs.delete('copilot-existing-2');
    _resetForTest();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('runWorker translates daemon SESSION_BUSY into unreachable + meta.existing_prompt_id', async () => {
  // Belt-and-suspenders: the bridge reattach guard normally catches the
  // duplicate before it reaches the daemon, but a race between two
  // interleaved sends could still slip through. SESSION_BUSY from the daemon
  // must map to a clean terminal envelope instead of a 6 ms "unexpected
  // terminal" bubbling out as a generic error.
  const { dispatch, jobs, _resetForTest } = await import('./server.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-busy-C';
  try {
    const body = await withDaemonStubs(
      {
        ensureDaemon: async () => {},
        sendToSocket: async (msg) => {
          if (msg.command === 'prompt-bg') {
            return {
              ok: false,
              code: 'SESSION_BUSY',
              error: 'session busy: prompt p1 is in flight (status=running)',
              data: { existingPromptId: 'p1', sessionId: 'cop-sid-busy' },
            };
          }
          // status/watch probes get an empty-ok so ensureDaemon-style calls
          // never fall through to the spawn path.
          return { ok: true, data: {} };
        },
      },
      async () => {
        const res = await dispatch({
          action: 'send',
          task: 'this one races the daemon mutex',
          mode: 'EXECUTE',
          template: 'general',
          thread: 'thread-busy-C',
          host_session_id: 'sid-busy-C',
          max_wait_sec: 5,
          parallel: false,
        });
        return JSON.parse(res.content[0].text);
      },
    );
    assert.equal(body.status, 'unreachable', 'SESSION_BUSY maps to terminal:unreachable');
    assert.equal(body.meta.detail, 'session_busy', 'detail tag identifies the busy variant');
    assert.equal(body.meta.existing_prompt_id, 'p1', 'meta surfaces the daemon-reported promptId');
  } finally {
    // Best-effort cleanup of the in-memory job the failing send registered.
    for (const id of [...jobs.keys()]) {
      if (jobs.get(id)?.claudeSessionId === 'sid-busy-C') jobs.delete(id);
    }
    _resetForTest();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});
