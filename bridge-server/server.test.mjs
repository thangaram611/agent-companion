// server.mjs must be importable from tests without attaching to stdio and
// must expose enough seams to validate bridge behavior without a real daemon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_SANDBOX = mkdtempSync(join(tmpdir(), 'copilot-state-server-'));
process.env.COPILOT_COMPANION_HOME = STATE_SANDBOX;
const TEST_CWD = tmpdir();

test.after(() => rmSync(STATE_SANDBOX, { recursive: true, force: true }));

async function bridge() {
  return import('./server.mjs');
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

async function withEnv(key, value, fn) {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return await fn(); }
  finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

async function withQueue(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'copilot-queue-test-'));
  const queueFile = join(tmp, 'completions.jsonl');
  const oldQ = process.env.COPILOT_QUEUE_PATH;
  process.env.COPILOT_QUEUE_PATH = queueFile;
  try { return await fn(queueFile); }
  finally {
    if (oldQ === undefined) delete process.env.COPILOT_QUEUE_PATH;
    else process.env.COPILOT_QUEUE_PATH = oldQ;
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readQueue(queueFile) {
  return readFileSync(queueFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function withDaemonStubs(stubs, body) {
  const daemonClient = await import('./daemon-client.mjs');
  daemonClient._setForTest(stubs);
  try { return await body(); }
  finally { daemonClient._resetForTest(); }
}

function terminalJob(jobId, status, extra = {}) {
  return {
    jobId,
    status,
    task: 'X',
    mode: 'EXECUTE',
    durationMs: 1000,
    failedTools: [],
    startedAt: Date.now() - 1000,
    terminalAt: Date.now(),
    retentionExpiresAt: Date.now() + 60_000,
    ...extra,
  };
}

test('server imports safely and dispatch handles the public boundary errors/status shapes', async () => {
  const mod = await bridge();
  assert.equal(typeof mod.dispatch, 'function');
  assert.ok(mod.jobs && typeof mod.jobs.get === 'function');
  assert.ok(mod.mcp);
  const tools = await mod.mcp._requestHandlers.get('tools/list')({ method: 'tools/list', params: {} });
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ['copilot_send', 'copilot_wait', 'copilot_status', 'copilot_reply', 'copilot_cancel'],
  );
  assert.equal(tools.tools.some((tool) => tool.name === 'copilot'), false);
  assert.equal(tools.tools.find((tool) => tool.name === 'copilot_send').inputSchema.properties.action, undefined);
  await assert.rejects(() => mod.mcp._requestHandlers.get('tools/call')({
    method: 'tools/call',
    params: { name: 'copilot', arguments: { action: 'status' } },
  }), /unknown tool: copilot/);
  const splitWithAction = parse(await mod.mcp._requestHandlers.get('tools/call')({
    method: 'tools/call',
    params: { name: 'copilot_status', arguments: { action: 'status' } },
  }));
  assert.equal(splitWithAction.ok, false);
  assert.equal(splitWithAction.code, 'INVALID_ARGUMENTS');
  const statusViaTool = parse(await mod.mcp._requestHandlers.get('tools/call')({
    method: 'tools/call',
    params: { name: 'copilot_status', arguments: {} },
  }));
  assert.equal(statusViaTool.ok, true);
  assert.equal(statusViaTool.action, 'status');
  await assert.rejects(() => mod.dispatch({ action: 'frobnicate' }), /unhandled action/);

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  mod._resetForTest();
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const send = parse(await mod.dispatch({ action: 'send', task: 'do thing', mode: 'EXECUTE', template: 'general', cwd: TEST_CWD }));
    assert.equal(send.ok, false);
    assert.match(send.error, /CLAUDE_CODE_SESSION_ID/);

    assert.equal(parse(await mod.dispatch({ action: 'wait', job_id: 'no-such', max_wait_sec: 1 })).status, 'unknown_job');
    assert.match(parse(await mod.dispatch({ action: 'cancel', job_id: 'no-such' })).error, /unknown job_id/);

    assert.match(parse(await mod.dispatch({ action: 'reply', job_id: 'nonexistent-job', message: 'hi' })).error, /unknown job_id/);
    mod.jobs.set('job-no-prompt', { jobId: 'job-no-prompt', status: 'starting', startedAt: Date.now() });
    assert.match(parse(await mod.dispatch({ action: 'reply', job_id: 'job-no-prompt', message: 'hi' })).error, /no prompt yet/);
    mod.jobs.set('job-done', terminalJob('job-done', 'completed', { promptId: 'p1' }));
    assert.match(parse(await mod.dispatch({ action: 'reply', job_id: 'job-done', message: 'hi' })).error, /already completed/);
    mod.jobs.delete('job-no-prompt');
    mod.jobs.delete('job-done');

    const status = parse(await mod.dispatch({ action: 'status', job_id: null, verbose: false }));
    assert.equal(status.ok, true);
    assert.equal(status.action, 'status');
    assert.ok(Array.isArray(status.running_jobs));
    assert.ok(status.default_model);
    assert.equal(status.active, undefined);
    assert.equal(status.paused, undefined);
    assert.equal(status.active_sessions_total, undefined);
  } finally {
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    mod._resetForTest();
  }
});

test('rubber-duck classification and wait-budget clamping cover clean/revised/missing and bounds', async () => {
  const { classifyRubberDuck, clampWaitSec } = await bridge();
  const cases = [
    ['Did the thing.\n\nRUBBER-DUCK: clean.', 'clean'],
    ['body\n rubber-duck: CLEAN', 'clean'],
    ['RUBBER-DUCK: revised -- dropped the foo claim.', 'revised'],
    ['just an answer with no verdict', 'missing'],
    ['', 'missing'],
    [null, 'missing'],
    ['RUBBER-DUCK: clear signal', 'missing'],
    ['sub A\nRUBBER-DUCK: clean.\nsub B\nRUBBER-DUCK: clean.', 'clean'],
    ['sub A\nRUBBER-DUCK: clean.\nsub B\nRUBBER-DUCK: revised -- fixed.', 'revised'],
    ['RUBBER-DUCK: revised -- note.\nlater: RUBBER-DUCK: clean.', 'revised'],
  ];
  for (const [input, expected] of cases) assert.equal(classifyRubberDuck(input), expected);

  assert.equal(clampWaitSec(700, 'ANALYZE'), 700);
  assert.equal(clampWaitSec(1200, 'EXECUTE'), 1200);
  assert.equal(clampWaitSec(1500, 'PLAN'), 1200);
  for (const value of [undefined, null, 0, 'not a number']) {
    assert.equal(clampWaitSec(value, 'EXECUTE'), 480);
  }
  assert.equal(clampWaitSec(0.4, 'EXECUTE'), 1);
});

test('wait response formatting covers timeout, digest metadata, unreachable details, and clean terminal meta', async () => {
  const mod = await bridge();
  const { jobs } = mod;

  jobs.set('job-timeout', terminalJob('job-timeout', 'timeout', {
    task: 'analyze a giant file',
    mode: 'ANALYZE',
    durationMs: 540_000,
    failedTools: ['view', 'grep'],
    promptId: 'p-timeout',
    sessionId: 's-timeout',
    thread: 'companion-test',
  }));
  let body = parse(await mod.dispatch({ action: 'wait', job_id: 'job-timeout', max_wait_sec: 1 }));
  assert.equal(body.status, 'timeout');
  assert.match(body.content, /Copilot's model turn did not finish/);
  assert.match(body.content, /Decompose the task/);
  assert.match(body.content, /scope_hint/);
  assert.match(body.content, /parallel: "never"/);
  assert.match(body.content, /\*\*Failed tools:\*\* view, grep/);
  assert.match(body.content, /Partial transcript digest/);
  assert.match(body.meta.digest_path, /copilot-digest-job-timeout\.md$/);
  jobs.delete('job-timeout');

  jobs.set('job-timeout-nopid', terminalJob('job-timeout-nopid', 'timeout', { promptId: null }));
  body = parse(await mod.dispatch({ action: 'wait', job_id: 'job-timeout-nopid', max_wait_sec: 1 }));
  assert.equal(body.status, 'timeout');
  assert.doesNotMatch(body.content, /Partial transcript digest/);
  assert.equal(body.meta.digest_path, undefined);
  jobs.delete('job-timeout-nopid');

  jobs.set('job-unreachable', terminalJob('job-unreachable', 'unreachable', {
    detail: 'bridge_daemon_unreachable',
  }));
  body = parse(await mod.dispatch({ action: 'wait', job_id: 'job-unreachable', max_wait_sec: 1 }));
  assert.equal(body.status, 'unreachable');
  assert.match(body.content, /Bridge could not reach the Copilot daemon/);
  assert.match(body.content, /detail: bridge_daemon_unreachable/);
  assert.equal(body.meta.detail, 'bridge_daemon_unreachable');
  jobs.delete('job-unreachable');

  jobs.set('job-completed', terminalJob('job-completed', 'completed', {
    summary: { message: 'done.\n\nRUBBER-DUCK: clean.' },
  }));
  body = parse(await mod.dispatch({ action: 'wait', job_id: 'job-completed', max_wait_sec: 1 }));
  assert.equal(body.status, 'completed');
  assert.equal(body.meta.detail, undefined);
  jobs.delete('job-completed');

  jobs.set('job-empty-completed', terminalJob('job-empty-completed', 'completed', {
    summary: { message: '', thoughts: '', toolCalls: [], plan: null },
  }));
  body = parse(await mod.dispatch({ action: 'wait', job_id: 'job-empty-completed', max_wait_sec: 1 }));
  assert.equal(body.status, 'completed');
  assert.match(body.content, /reported completion but returned no assistant message/);
  assert.doesNotMatch(body.content, /Unexpected terminal status/);
  jobs.delete('job-empty-completed');
});

test('digest MCP resources list, read, template, and tool resource links', async () => {
  const mod = await bridge();
  const {
    digestJobIdFromResourceUri,
    digestResourceForJobId,
    digestResourceUri,
    listDigestResourceTemplates,
    listDigestResources,
    readDigestResource,
  } = mod;
  const { jobs } = mod;
  const { digestPath } = await import('../lib/prompt-digest.mjs');

  const jobId = 'job-resource-1';
  const path = digestPath(jobId);
  writeFileSync(path, '# Digest\n\nResource body.\n');

  assert.equal(digestResourceUri(jobId), `copilot-digest://${jobId}`);
  assert.equal(digestJobIdFromResourceUri(`copilot-digest://${jobId}`), jobId);
  assert.equal(digestJobIdFromResourceUri('file:///tmp/nope'), null);

  const resource = digestResourceForJobId(jobId);
  assert.equal(resource.uri, `copilot-digest://${jobId}`);
  assert.equal(resource.mimeType, 'text/markdown');
  assert.equal(resource._meta.digest_path, path);
  assert.equal(listDigestResources().some((r) => r.uri === resource.uri), true);

  const templates = listDigestResourceTemplates();
  assert.equal(templates[0].uriTemplate, 'copilot-digest://{job_id}');

  const read = readDigestResource(resource.uri);
  assert.equal(read.contents[0].uri, resource.uri);
  assert.match(read.contents[0].text, /Resource body/);
  assert.throws(() => readDigestResource('copilot-digest://missing-resource'), /digest not found/);
  assert.throws(() => readDigestResource('copilot-digest://bad/path'), /unknown digest resource uri/);

  jobs.set(jobId, terminalJob(jobId, 'completed', {
    promptId: 'p-resource',
    summary: { message: 'done.\n\nRUBBER-DUCK: clean.', toolCalls: [] },
  }));
  const result = await mod.dispatch({ action: 'status', job_id: jobId, verbose: false });
  const body = parse(result);
  assert.equal(body.digest_path, path);
  assert.equal(result.content[0].type, 'text');
  const link = result.content.find((entry) => entry.type === 'resource_link');
  assert.equal(link.uri, resource.uri);
  assert.equal(link.mimeType, 'text/markdown');
  jobs.delete(jobId);
});

test('buildJobResponse and session-reborn content preserve bridge-owned status/detail metadata', async () => {
  const { buildJobResponse, formatTerminalContent } = await bridge();
  assert.equal(buildJobResponse(
    terminalJob('j1', 'timeout'),
    { status: 'failed', stuckReason: null },
  ).status, 'timeout');
  assert.equal(buildJobResponse(
    terminalJob('j2', 'unreachable', { detail: 'bridge_daemon_unreachable' }),
    { status: 'completed', summary: { message: 'oops' } },
  ).status, 'unreachable');
  assert.equal(buildJobResponse({ jobId: 'j3', status: 'starting', startedAt: Date.now() }, { status: 'running' }).status, 'running');
  assert.equal(buildJobResponse(terminalJob('j4', 'unreachable', { detail: 'bridge_timeout' })).detail, 'bridge_timeout');
  assert.equal(buildJobResponse(terminalJob('j5', 'completed')).detail, null);
  assert.equal(buildJobResponse(terminalJob('j6', 'completed', { detail: null }), { status: 'completed', detail: 'spurious' }).detail, null);
  assert.equal(buildJobResponse(terminalJob('j-rb', 'completed', { sessionReborn: true })).session_reborn, true);
  assert.equal(buildJobResponse(terminalJob('j-ret', 'timeout', { sessionRetired: true })).session_retired, true);
  assert.equal(buildJobResponse(terminalJob('j-norm', 'completed')).session_reborn, false);

  const content = formatTerminalContent({
    jobId: 'jr1', status: 'completed', task: 'continue thread',
    mode: 'EXECUTE', durationMs: 1234,
    summary: { message: 'OK\n\nRUBBER-DUCK: clean.', toolCalls: [] },
    error: null, stuckReason: null, detail: null, failedTools: [],
    promptId: 'p1', sessionReborn: true,
  });
  assert.match(content, /Copilot session was respawned mid-thread/);
  assert.ok(content.indexOf('respawned mid-thread') < content.indexOf('Task:'));
});

test('still-running and terminal wait responses surface session_reborn and reattached metadata', async () => {
  const mod = await bridge();
  const { jobs } = mod;

  jobs.set('jr-still', {
    jobId: 'jr-still', status: 'running', task: 't', mode: 'EXECUTE',
    promptId: 'p', sessionId: 's-new', thread: 'companion-x',
    startedAt: Date.now() - 5000,
    sessionReborn: true,
  });
  let body = parse(await mod.dispatch({ action: 'wait', job_id: 'jr-still', max_wait_sec: 1 }));
  assert.equal(body.status, 'still_running');
  assert.equal(body.session_reborn, true);
  assert.match(body.digest_path, /copilot-digest-jr-still\.md$/);
  jobs.delete('jr-still');

  jobs.set('jr-wait', terminalJob('jr-wait', 'completed', {
    promptId: 'p', sessionId: 's-new', thread: 'companion-x',
    summary: { message: 'k\n\nRUBBER-DUCK: clean.', toolCalls: [] },
    sessionReborn: true,
    reattached: true,
  }));
  body = parse(await mod.dispatch({ action: 'wait', job_id: 'jr-wait', max_wait_sec: 1 }));
  assert.equal(body.meta.session_reborn, 'true');
  assert.equal(body.meta.reattached, 'true');
  assert.match(body.content, /respawned mid-thread/);
  jobs.delete('jr-wait');
});

test('emitNotification writes queue rows with status remaps, detail/session metadata, rubber-duck state, and private mode', async () => {
  const { emitNotification } = await bridge();
  await withQueue(async (queueFile) => {
    await withEnv('CLAUDE_CODE_SESSION_ID', 'cc-test-session-abc', async () => {
      emitNotification({
        jobId: 'j-detail', status: 'unreachable', detail: 'bridge_daemon_unreachable',
        summary: null, error: null, stuckReason: null, duration: 1234,
        task: 'X', mode: 'EXECUTE', cwd: '/tmp',
      });
    });
    let event = readQueue(queueFile).at(-1);
    assert.equal(event.kind, 'terminal');
    assert.equal(event.claudeSessionId, 'cc-test-session-abc');
    assert.equal(event.meta.status, 'unreachable');
    assert.equal(event.meta.detail, 'bridge_daemon_unreachable');

    emitNotification({
      jobId: 'j-capi', status: 'completed',
      summary: {
        stopReason: 'end_turn',
        message: 'Info: Request failed due to a transient API error. Retrying...\nError: Execution failed: Error: Failed to get response from the AI model; retried 5 times. Last error: CAPIError: Request timed out.',
      },
      duration: 142383, task: 'X', mode: 'EXECUTE', cwd: '/tmp',
    });
    event = readQueue(queueFile).at(-1);
    assert.equal(event.meta.status, 'failed');
    assert.equal(event.meta.detail, 'copilot_capi_failure');
    assert.equal(event.meta.stop_reason, 'end_turn');

    await withEnv('CLAUDE_CODE_SESSION_ID', undefined, async () => {
      emitNotification({
        jobId: 'j-ok', status: 'completed',
        summary: { stopReason: 'end_turn', message: 'All checks pass.\nRUBBER-DUCK: clean.' },
        duration: 2000, task: 'X', mode: 'EXECUTE', cwd: '/tmp',
      });
    });
    event = readQueue(queueFile).at(-1);
    assert.equal(event.claudeSessionId, null);
    assert.equal(event.meta.status, 'completed');
    assert.equal(event.meta.detail, undefined);
    assert.equal(event.meta.rubber_duck, 'clean');
    assert.equal((await import('node:fs')).statSync(queueFile).mode & 0o777, 0o600);
  });
});

test('job ledger persistence, GC, and queue consumption protect resumed terminal jobs', async () => {
  const mod = await bridge();
  const { jobs, gcExpiredJobs, persistJob, hydrateJobsFromLedger, dispatch } = mod;
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
  assert.equal(existsSync(filePath), true);
  assert.equal(state.readJob('j-gc').copilotSessionId, 'cop-sid-1');
  gcExpiredJobs();
  assert.equal(jobs.has('j-gc'), false);
  assert.equal(existsSync(filePath), false);

  jobs.set('j-untagged', { jobId: 'j-untagged', status: 'starting', startedAt: Date.now() });
  persistJob('j-untagged');
  assert.equal(existsSync(join(state.JOBS_DIR, 'j-untagged.json')), false);
  jobs.delete('j-untagged');

  await withQueue(async (queueFile) => {
    const oldS = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sid-rehydrate-A';
    try {
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
      writeFileSync(queueFile, JSON.stringify({
        ts: Date.now() - 1000, kind: 'terminal', jobId: 'j-rehydrated',
        claudeSessionId: 'sid-rehydrate-A', consumed: false,
        content: 'all done', meta: { status: 'completed' },
      }) + '\n');

      jobs.clear();
      mod._resetForTest();
      hydrateJobsFromLedger();
      assert.equal(jobs.has('j-rehydrated'), true);

      const body = parse(await dispatch({ action: 'wait', job_id: 'j-rehydrated', max_wait_sec: 1 }));
      assert.equal(body.status, 'completed');
      assert.equal(readQueue(queueFile)[0].consumed, true);

      state.deleteJob('j-rehydrated');
      jobs.clear();
    } finally {
      if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = oldS;
      mod._resetForTest();
    }
  });
});

test('host session adoption rejects placeholders/conflicts and accepts arg/meta/legacy aliases', async () => {
  const mod = await bridge();
  const { dispatch, getHostSessionId, adoptHostSessionId, _resetForTest } = mod;
  const { validateCopilotArgs } = await import('./validation.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;

  _resetForTest();
  process.env.CLAUDE_CODE_SESSION_ID = '${CLAUDE_CODE_SESSION_ID}';
  assert.equal(getHostSessionId(), null);

  delete process.env.CLAUDE_CODE_SESSION_ID;
  await dispatch({ action: 'wait', job_id: 'no-such', max_wait_sec: 1, host_session_id: 'arg-adopted-sid' });
  assert.equal(getHostSessionId(), 'arg-adopted-sid');

  _resetForTest();
  const normalized = validateCopilotArgs({ action: 'status', job_id: null, claude_session_id: 'legacy-claude-sid' });
  await dispatch(normalized);
  assert.equal(getHostSessionId(), 'legacy-claude-sid');

  _resetForTest();
  adoptHostSessionId('meta-sid-codex');
  assert.equal(getHostSessionId(), 'meta-sid-codex');
  let conflict = parse(await dispatch({
    action: 'status', job_id: null, verbose: false, host_session_id: 'arg-sid-different',
  }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'BRIDGE_SID_CONFLICT');
  assert.equal(getHostSessionId(), 'meta-sid-codex');

  const ok = parse(await dispatch({
    action: 'status', job_id: null, verbose: false, host_session_id: 'meta-sid-codex',
  }));
  assert.equal(ok.ok, true);
  assert.notEqual(ok.code, 'BRIDGE_SID_CONFLICT');

  if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  _resetForTest();
});

test('resolveSendThread and hydrateJobsFromLedger preserve host/thread continuity and orphan recovery', async () => {
  const mod = await bridge();
  const { jobs, resolveSendThread, hydrateJobsFromLedger } = mod;
  const state = await import('../lib/state.mjs');

  state.writeHostSessionThread('sid-explicit', 'stored-thread');
  assert.equal(resolveSendThread('caller-thread', 'sid-explicit', 'copilot-job1'), 'caller-thread');
  assert.equal(state.readHostSessionThread('sid-explicit'), 'caller-thread');
  assert.equal(resolveSendThread(null, 'sid-explicit', 'copilot-job2'), 'caller-thread');
  state.clearHostSessionThread('sid-explicit');

  assert.equal(resolveSendThread(null, '', 'copilot-jobNOSID'), 'companion-copilot-jobNOSID');
  assert.equal(resolveSendThread(null, 'codex/has spaces!', 'copilot-jobX'), 'companion-copilot-jobX');
  assert.equal(state.readHostSessionThread('codex_has_spaces_'), 'companion-copilot-jobX');
  state.clearHostSessionThread('codex_has_spaces_');

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-hydrate-A';
  try {
    state.writeJob('j-mine-terminal', {
      jobId: 'j-mine-terminal', claudeSessionId: 'sid-hydrate-A',
      copilotSessionId: 'cop-1', thread: 'thread-restored',
      status: 'completed', startedAt: 1000, terminalAt: 2000,
      retentionExpiresAt: Date.now() + 60_000,
    });
    state.writeJob('j-other-session', {
      jobId: 'j-other-session', claudeSessionId: 'sid-other-B',
      status: 'running', startedAt: 1000,
    });
    state.writeJob('j-orphan', {
      jobId: 'j-orphan', claudeSessionId: 'sid-hydrate-A',
      status: 'starting', startedAt: 1000,
    });

    jobs.clear();
    mod._resetForTest();
    hydrateJobsFromLedger();
    assert.equal(jobs.has('j-mine-terminal'), true);
    assert.equal(jobs.has('j-other-session'), false);
    assert.equal(jobs.get('j-mine-terminal').sessionId, 'cop-1');
    assert.equal(state.readThreadSid('thread-restored'), 'cop-1');
    assert.equal(jobs.get('j-orphan').status, 'unreachable');
    assert.equal(jobs.get('j-orphan').detail, 'rehydrate_no_promptid');

    for (const id of ['j-mine-terminal', 'j-other-session', 'j-orphan']) state.deleteJob(id);
    state.clearThread('thread-restored');
    jobs.clear();
  } finally {
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    mod._resetForTest();
  }
});

test('sweepOwnSessionStaleQueueRows drops only stale rows for the current host session', async () => {
  const { sweepOwnSessionStaleQueueRows } = await bridge();
  await withQueue(async (queueFile) => {
    const oldS = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sid-sweep-A';
    try {
      const now = Date.now();
      writeFileSync(queueFile, [
        { ts: now - 90_000, kind: 'alert', jobId: 'j-mine-old', claudeSessionId: 'sid-sweep-A', consumed: false, content: 'mine-old' },
        { ts: now - 30_000, kind: 'alert', jobId: 'j-mine-fresh', claudeSessionId: 'sid-sweep-A', consumed: false, content: 'mine-fresh' },
        { ts: now - 90_000, kind: 'alert', jobId: 'j-other-old', claudeSessionId: 'sid-sweep-B', consumed: false, content: 'other-old' },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n');
      sweepOwnSessionStaleQueueRows(now);
      assert.deepEqual(readQueue(queueFile).map((r) => r.jobId).sort(), ['j-mine-fresh', 'j-other-old']);
    } finally {
      if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    }
  });
});

test('handleSend returns immediately and reattaches to existing jobs without daemon calls', async () => {
  const mod = await bridge();
  const { dispatch, jobs, retainTerminalJob, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-send';

  try {
    const instant = await withDaemonStubs(
      { ensureDaemon: async () => {}, sendToSocket: async () => ({ ok: true, data: {} }) },
      async () => {
        const t0 = performance.now();
        const res = await dispatch({
          action: 'send', task: 'instant-return smoke',
          mode: 'EXECUTE', template: 'general',
          cwd: TEST_CWD,
          host_session_id: 'sid-send',
          max_wait_sec: 9999,
          parallel: 'never',
        });
        return { body: parse(res), elapsed: performance.now() - t0 };
      },
    );
    assert.ok(instant.elapsed < 200, `handleSend must return synchronously (got ${instant.elapsed}ms)`);
    assert.equal(instant.body.status, 'still_running');
    assert.equal(instant.body.current_status, 'starting');
    assert.match(instant.body.hint, /copilot_wait/);

    jobs.set('copilot-existing-1', {
      jobId: 'copilot-existing-1',
      claudeSessionId: 'sid-send',
      thread: 'thread-reattach',
      cwd: TEST_CWD,
      status: 'running',
      promptId: 'prompt-existing-1',
      sessionId: 'cop-sid-1',
      startedAt: Date.now() - 5_000,
    });
    let socketCalls = 0;
    const reattached = await withDaemonStubs(
      {
        ensureDaemon: async () => { socketCalls++; },
        sendToSocket: async () => { socketCalls++; throw new Error('reattach must not touch the daemon'); },
      },
      async () => parse(await dispatch({
        action: 'send', task: 'reattach me',
        mode: 'EXECUTE', template: 'general',
        thread: 'thread-reattach',
        cwd: TEST_CWD,
        host_session_id: 'sid-send',
        max_wait_sec: 1,
        parallel: 'never',
      })),
    );
    assert.equal(reattached.status, 'still_running');
    assert.equal(reattached.job_id, 'copilot-existing-1');
    assert.equal(reattached.reattached, true);
    assert.equal(socketCalls, 0);

    jobs.set('copilot-existing-mismatch', {
      jobId: 'copilot-existing-mismatch',
      claudeSessionId: 'sid-send',
      thread: 'thread-cwd-mismatch',
      cwd: null,
      status: 'running',
      promptId: 'prompt-existing-mismatch',
      sessionId: 'cop-sid-mismatch',
      startedAt: Date.now() - 5_000,
    });
    const mismatch = await withDaemonStubs(
      {
        ensureDaemon: async () => { throw new Error('cwd mismatch must fail before daemon startup'); },
        sendToSocket: async () => { throw new Error('cwd mismatch must not touch the daemon'); },
      },
      async () => parse(await dispatch({
        action: 'send', task: 'corrected cwd must not attach to unknown old cwd',
        mode: 'EXECUTE', template: 'general',
        thread: 'thread-cwd-mismatch',
        cwd: TEST_CWD,
        host_session_id: 'sid-send',
        max_wait_sec: 1,
        parallel: 'never',
      })),
    );
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 'cwd_mismatch');
    assert.equal(mismatch.existing_cwd, null);
    assert.equal(mismatch.requested_cwd, TEST_CWD);

    jobs.set('copilot-existing-2', {
      jobId: 'copilot-existing-2',
      claudeSessionId: 'sid-send',
      thread: 'thread-terminal',
      cwd: TEST_CWD,
      status: 'running',
      promptId: 'prompt-existing-2',
      sessionId: 'cop-sid-2',
      startedAt: Date.now() - 5_000,
    });
    const terminal = await withDaemonStubs(
      {
        ensureDaemon: async () => {},
        sendToSocket: async () => { throw new Error('reattach must not touch the daemon'); },
      },
      async () => {
        setImmediate(() => {
          retainTerminalJob('copilot-existing-2', {
            status: 'completed',
            summary: { message: 'done.\n\nRUBBER-DUCK: clean.' },
            durationMs: 4_000,
            terminalAt: Date.now(),
          });
        });
        return parse(await dispatch({
          action: 'send', task: 'reattach terminal',
          mode: 'EXECUTE', template: 'general',
          thread: 'thread-terminal',
          cwd: TEST_CWD,
          host_session_id: 'sid-send',
          max_wait_sec: 5,
          parallel: 'never',
        }));
      },
    );
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.meta.reattached, 'true');
  } finally {
    for (const id of [...jobs.keys()]) {
      if (jobs.get(id)?.claudeSessionId === 'sid-send') jobs.delete(id);
    }
    _resetForTest();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    await new Promise((r) => setImmediate(r));
  }
});

test('runWorker retires persisted thread sid on prompt timeout and empty completion', async () => {
  const mod = await bridge();
  const state = await import('../lib/state.mjs');
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-retire';

  async function runTerminalScenario({ thread, promptId, daemonResult }) {
    let watchCalls = 0;
    return withDaemonStubs(
      {
        ensureDaemon: async () => {},
        sendToSocket: async (msg) => {
          if (msg.command === 'prompt-bg') {
            return { ok: true, data: { promptId, sessionId: 'cop-sid-retire' } };
          }
          if (msg.command === 'watch') {
            watchCalls++;
            return { ok: true, data: daemonResult };
          }
          return { ok: true, data: {} };
        },
      },
      async () => {
        const sendBody = parse(await dispatch({
          action: 'send',
          task: `retire ${thread}`,
          mode: 'EXECUTE',
          template: 'general',
          cwd: TEST_CWD,
          thread,
          host_session_id: 'sid-retire',
          max_wait_sec: 5,
          parallel: 'never',
        }));
        assert.equal(sendBody.status, 'still_running');
        for (let i = 0; i < 20 && !jobs.get(sendBody.job_id)?.terminalAt; i++) {
          await new Promise((r) => setImmediate(r));
        }
        assert.equal(watchCalls, 1);
        return parse(await dispatch({
          action: 'wait',
          job_id: sendBody.job_id,
          host_session_id: 'sid-retire',
          max_wait_sec: 1,
        }));
      },
    );
  }

  try {
    state.clearThread('thread-timeout-retire');
    let body = await runTerminalScenario({
      thread: 'thread-timeout-retire',
      promptId: 'prompt-timeout-retire',
      daemonResult: { status: 'failed', error: 'prompt timeout', sessionRetired: true },
    });
    assert.equal(body.status, 'timeout');
    assert.equal(body.meta.detail, 'prompt_timeout');
    assert.equal(body.meta.session_retired, 'true');
    assert.match(body.content, /timed-out Copilot ACP session was retired/);
    assert.equal(state.readThreadSid('thread-timeout-retire'), null);

    state.clearThread('thread-empty-retire');
    body = await runTerminalScenario({
      thread: 'thread-empty-retire',
      promptId: 'prompt-empty-retire',
      daemonResult: {
        status: 'completed',
        summary: { message: '', thoughts: '', toolCalls: [], plan: null },
      },
    });
    assert.equal(body.status, 'failed');
    assert.equal(body.meta.detail, 'empty_completed');
    assert.equal(body.meta.session_retired, 'true');
    assert.match(body.content, /without any assistant message/);
    assert.equal(state.readThreadSid('thread-empty-retire'), null);
  } finally {
    for (const id of [...jobs.keys()]) {
      if (jobs.get(id)?.claudeSessionId === 'sid-retire') jobs.delete(id);
    }
    state.clearThread('thread-timeout-retire');
    state.clearThread('thread-empty-retire');
    _resetForTest();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('runWorker maps daemon SESSION_BUSY into a terminal unreachable response', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
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
          return { ok: true, data: {} };
        },
      },
      async () => {
        const sendBody = parse(await dispatch({
          action: 'send',
          task: 'this one races the daemon mutex',
          mode: 'EXECUTE',
          template: 'general',
          cwd: TEST_CWD,
          thread: 'thread-busy-C',
          host_session_id: 'sid-busy-C',
          max_wait_sec: 5,
          parallel: 'never',
        }));
        assert.equal(sendBody.status, 'still_running');
        return parse(await dispatch({
          action: 'wait',
          job_id: sendBody.job_id,
          max_wait_sec: 5,
          host_session_id: 'sid-busy-C',
        }));
      },
    );
    assert.equal(body.status, 'unreachable');
    assert.equal(body.meta.detail, 'session_busy');
    assert.equal(body.meta.existing_prompt_id, 'p1');
  } finally {
    for (const id of [...jobs.keys()]) {
      if (jobs.get(id)?.claudeSessionId === 'sid-busy-C') jobs.delete(id);
    }
    _resetForTest();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('handleReply rebinds a running job to the replacement prompt and watcher result', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-reply-rebind';
  jobs.set('copilot-reply-1', {
    jobId: 'copilot-reply-1',
    reqId: 'req-reply-1',
    claudeSessionId: 'sid-reply-rebind',
    thread: 'thread-reply-1',
    task: 'original task',
    mode: 'EXECUTE',
    template: 'general',
    parallel: 'never',
    status: 'running',
    promptId: 'prompt-old',
    sessionId: 'session-reply-1',
    startedAt: Date.now() - 1000,
    inspectAvailable: true,
  });
  try {
    const body = await withDaemonStubs(
      {
        sendToSocket: async (msg) => {
          if (msg.command === 'reply') {
            assert.equal(msg.promptId, 'prompt-old');
            return {
              ok: true,
              data: {
                ok: true,
                original_prompt_id: 'prompt-old',
                new_prompt_id: 'prompt-new',
                session_id: 'session-reply-1',
              },
            };
          }
          if (msg.command === 'watch') {
            assert.equal(msg.promptId, 'prompt-new');
            return {
              ok: true,
              data: {
                promptId: 'prompt-new',
                sessionId: 'session-reply-1',
                status: 'completed',
                summary: { message: 'replacement done\n\nRUBBER-DUCK: clean.' },
              },
            };
          }
          if (msg.command === 'inspect') return { ok: true, data: {} };
          return { ok: true, data: {} };
        },
      },
      async () => parse(await dispatch({
        action: 'reply',
        job_id: 'copilot-reply-1',
        message: 'use this instead',
        host_session_id: 'sid-reply-rebind',
      })),
    );
    assert.equal(body.ok, true);
    assert.equal(body.new_prompt_id, 'prompt-new');

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const job = jobs.get('copilot-reply-1');
    assert.equal(job.promptId, 'prompt-new');
    assert.equal(job.status, 'completed');
    assert.equal(job.terminalAt > 0, true);
  } finally {
    jobs.delete('copilot-reply-1');
    _resetForTest();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});
