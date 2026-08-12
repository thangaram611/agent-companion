// server.mjs must be importable from tests without attaching to stdio and
// must expose enough seams to validate bridge behavior without a real daemon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_SANDBOX = mkdtempSync(join(tmpdir(), 'copilot-state-server-'));
process.env.AGENT_COMPANION_HOME = STATE_SANDBOX;
// Pinned into the sandbox rather than left to resolve through runtimeDir():
// AGENT_COMPANION_HOME does not reach it (lib/host.mjs derives the companion
// home from the HOST, not from that var), so every `log()` this suite provokes
// appended to the operator's live ~/.claude/agent-companion/runtime log —
// measured 31,396 bytes for one run of this file. Never unset it in teardown:
// clearing it is exactly what re-points a straggler at the real path.
process.env.AGENT_BRIDGE_LOG_FILE = join(STATE_SANDBOX, 'agent-bridge.log');
process.env.AGENT_COMPANION_DEFAULT_TARGET = 'copilot';
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
  const oldQ = process.env.AGENT_QUEUE_PATH;
  process.env.AGENT_QUEUE_PATH = queueFile;
  try { return await fn(queueFile); }
  finally {
    if (oldQ === undefined) delete process.env.AGENT_QUEUE_PATH;
    else process.env.AGENT_QUEUE_PATH = oldQ;
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
    target: 'copilot',
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
    [
      'agent_send', 'agent_wait', 'agent_status', 'agent_reply', 'agent_cancel',
    ],
  );
  assert.equal(tools.tools.some((tool) => tool.name === 'copilot_send'), false);
  assert.ok(tools.tools.find((tool) => tool.name === 'agent_send').inputSchema.properties.target);
  assert.equal(tools.tools.find((tool) => tool.name === 'agent_send').inputSchema.properties.action, undefined);
  await assert.rejects(() => mod.mcp._requestHandlers.get('tools/call')({
    method: 'tools/call',
    params: { name: 'copilot_status', arguments: { action: 'status' } },
  }), /unknown tool: copilot_status/);
  const splitWithAction = parse(await mod.mcp._requestHandlers.get('tools/call')({
    method: 'tools/call',
    params: { name: 'agent_status', arguments: { action: 'status' } },
  }));
  assert.equal(splitWithAction.ok, false);
  assert.equal(splitWithAction.code, 'INVALID_ARGUMENTS');
  const statusViaTool = parse(await mod.mcp._requestHandlers.get('tools/call')({
    method: 'tools/call',
    params: { name: 'agent_status', arguments: {} },
  }));
  assert.equal(statusViaTool.ok, true);
  assert.equal(statusViaTool.action, 'status');
  assert.equal(statusViaTool.diagnostics, undefined);
  const statusWithDiagnostics = parse(await mod.mcp._requestHandlers.get('tools/call')({
    method: 'tools/call',
    params: { name: 'agent_status', arguments: { diagnostics: true } },
  }));
  assert.equal(statusWithDiagnostics.ok, true);
  assert.equal(statusWithDiagnostics.action, 'status');
  assert.equal(statusWithDiagnostics.diagnostics.runtime.adapter, process.env.COPILOT_RUNTIME_ADAPTER || 'acp');
  assert.match(statusWithDiagnostics.diagnostics.runtime.dir, /copilot-state-server-|agent-companion/);
  assert.equal(typeof statusWithDiagnostics.diagnostics.node.ok, 'boolean');
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
    mod.jobs.set('job-no-prompt', { jobId: 'job-no-prompt', target: 'copilot', status: 'starting', startedAt: Date.now() });
    assert.match(parse(await mod.dispatch({ action: 'reply', job_id: 'job-no-prompt', message: 'hi' })).error, /no prompt yet/);
    mod.jobs.set('job-done', terminalJob('job-done', 'completed', { promptId: 'p1' }));
    assert.match(parse(await mod.dispatch({ action: 'reply', job_id: 'job-done', message: 'hi' })).error, /already completed/);
    mod.jobs.delete('job-no-prompt');
    mod.jobs.delete('job-done');

    const status = parse(await mod.dispatch({ action: 'status', job_id: null, verbose: false }));
    assert.equal(status.ok, true);
    assert.equal(status.action, 'status');
    assert.equal(status.default_target.target, 'copilot');
    assert.equal(status.targets.some((target) => target.id === 'opencode' && target.implemented), true);
    assert.equal(status.opencode_runtime.permission.mode, 'default');
    assert.equal(typeof status.opencode_runtime.timeout_ms, 'number');
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
  assert.match(body.content, /GitHub Copilot CLI's model turn did not finish/);
  assert.match(body.content, /Decompose the task/);
  assert.match(body.content, /scope_hint/);
  assert.match(body.content, /parallel: "never"/);
  assert.match(body.content, /\*\*Failed tools:\*\* view, grep/);
  assert.match(body.content, /Partial transcript digest/);
  assert.equal(body.meta.digest_uri, 'agent-digest://job-timeout');
  assert.equal(body.meta.digest_path, undefined);
  assert.match(body.meta.debug_digest_path, /agent-digest-job-timeout\.md$/);
  jobs.delete('job-timeout');

  jobs.set('job-timeout-nopid', terminalJob('job-timeout-nopid', 'timeout', { promptId: null }));
  body = parse(await mod.dispatch({ action: 'wait', job_id: 'job-timeout-nopid', max_wait_sec: 1 }));
  assert.equal(body.status, 'timeout');
  assert.doesNotMatch(body.content, /Partial transcript digest/);
  assert.equal(body.meta.digest_uri, undefined);
  assert.equal(body.meta.debug_digest_path, undefined);
  jobs.delete('job-timeout-nopid');

  jobs.set('job-unreachable', terminalJob('job-unreachable', 'unreachable', {
    detail: 'bridge_daemon_unreachable',
  }));
  body = parse(await mod.dispatch({ action: 'wait', job_id: 'job-unreachable', max_wait_sec: 1 }));
  assert.equal(body.status, 'unreachable');
  assert.match(body.content, /Bridge could not reach the GitHub Copilot CLI runtime/);
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

  assert.equal(digestResourceUri(jobId), `agent-digest://${jobId}`);
  assert.equal(digestJobIdFromResourceUri(`agent-digest://${jobId}`), jobId);
  assert.equal(digestJobIdFromResourceUri('file:///tmp/nope'), null);

  const resource = digestResourceForJobId(jobId);
  assert.equal(resource.uri, `agent-digest://${jobId}`);
  assert.equal(resource.mimeType, 'text/markdown');
  assert.equal(resource.description.includes(jobId), true);
  assert.equal(resource._meta, undefined);
  assert.equal(resource.annotations, undefined);
  assert.equal(listDigestResources().some((r) => r.uri === resource.uri), true);

  const templates = listDigestResourceTemplates();
  assert.equal(templates[0].uriTemplate, 'agent-digest://{job_id}');

  const read = readDigestResource(resource.uri);
  assert.equal(read.contents[0].uri, resource.uri);
  assert.match(read.contents[0].text, /Resource body/);
  assert.throws(() => readDigestResource('agent-digest://missing-resource'), /digest not found/);
  assert.throws(() => readDigestResource('agent-digest://bad/path'), /unknown digest resource uri/);

  const listedViaMcp = await mod.mcp._requestHandlers.get('resources/list')({
    method: 'resources/list',
    params: {},
  });
  assert.equal(listedViaMcp.resources.some((r) => r.uri === resource.uri), true);
  const templatesViaMcp = await mod.mcp._requestHandlers.get('resources/templates/list')({
    method: 'resources/templates/list',
    params: {},
  });
  assert.equal(templatesViaMcp.resourceTemplates[0].uriTemplate, 'agent-digest://{job_id}');
  const readViaMcp = await mod.mcp._requestHandlers.get('resources/read')({
    method: 'resources/read',
    params: { uri: resource.uri },
  });
  assert.match(readViaMcp.contents[0].text, /Resource body/);

  jobs.set(jobId, terminalJob(jobId, 'completed', {
    promptId: 'p-resource',
    summary: { message: 'done.\n\nRUBBER-DUCK: clean.', toolCalls: [] },
  }));
  const result = await mod.dispatch({ action: 'status', job_id: jobId, verbose: false });
  const body = parse(result);
  assert.equal(body.digest_uri, resource.uri);
  assert.equal(body.digest_path, undefined);
  assert.equal(body.debug.digest_path, path);
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
  assert.match(content, /GitHub Copilot CLI session was respawned mid-thread/);
  assert.ok(content.indexOf('respawned mid-thread') < content.indexOf('Task:'));
});

test('still-running and terminal wait responses surface session_reborn and reattached metadata', async () => {
  const mod = await bridge();
  const { jobs } = mod;

  jobs.set('jr-still', {
    jobId: 'jr-still', target: 'copilot', status: 'running', task: 't', mode: 'EXECUTE',
    promptId: 'p', sessionId: 's-new', thread: 'companion-x',
    startedAt: Date.now() - 5000,
    sessionReborn: true,
  });
  let body = parse(await mod.dispatch({ action: 'wait', job_id: 'jr-still', max_wait_sec: 1 }));
  assert.equal(body.status, 'still_running');
  assert.equal(body.session_reborn, true);
  assert.equal(body.digest_uri, 'agent-digest://jr-still');
  assert.equal(body.digest_path, undefined);
  assert.match(body.debug.digest_path, /agent-digest-jr-still\.md$/);
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
    target: 'copilot',
    claudeSessionId: 'sid-X',
    sessionId: 'cop-sid-1',
    status: 'completed',
    terminalAt: Date.now() - 10_000,
    retentionExpiresAt: Date.now() - 5_000,
  });
  persistJob('j-gc');
  const filePath = join(state.JOBS_DIR, 'j-gc.json');
  assert.equal(existsSync(filePath), true);
  // The in-memory `sessionId` persists under the target-neutral key.
  assert.equal(state.readJob('j-gc').companionSessionId, 'cop-sid-1');
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
        target: 'copilot', companionSessionId: 'cop-rh', thread: null,
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
  const { validateAgentArgs } = await import('./validation.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;

  _resetForTest();
  process.env.CLAUDE_CODE_SESSION_ID = '${CLAUDE_CODE_SESSION_ID}';
  assert.equal(getHostSessionId(), null);

  delete process.env.CLAUDE_CODE_SESSION_ID;
  await dispatch({ action: 'wait', job_id: 'no-such', max_wait_sec: 1, host_session_id: 'arg-adopted-sid' });
  assert.equal(getHostSessionId(), 'arg-adopted-sid');

  _resetForTest();
  const normalized = validateAgentArgs({ action: 'status', job_id: null, host_session_id: 'forwarded-host-sid' });
  await dispatch(normalized);
  assert.equal(getHostSessionId(), 'forwarded-host-sid');

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
      target: 'copilot', companionSessionId: 'cop-1', thread: 'thread-restored',
      status: 'completed', startedAt: 1000, terminalAt: 2000,
      retentionExpiresAt: Date.now() + 60_000,
    });
    state.writeJob('j-other-session', {
      jobId: 'j-other-session', claudeSessionId: 'sid-other-B',
      status: 'running', startedAt: 1000,
    });
    state.writeJob('j-orphan', {
      jobId: 'j-orphan', claudeSessionId: 'sid-hydrate-A',
      target: 'copilot', status: 'starting', startedAt: 1000,
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

test('hydrateJobsFromLedger marks SDK in-flight prompts as non-resumable after restart', async () => {
  const mod = await bridge();
  const { jobs, hydrateJobsFromLedger, dispatch, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const oldAdapter = process.env.COPILOT_RUNTIME_ADAPTER;

  process.env.CLAUDE_CODE_SESSION_ID = 'sid-sdk-hydrate';
  process.env.COPILOT_RUNTIME_ADAPTER = 'sdk';
  try {
    _resetForTest();
    jobs.clear();
    state.writeThreadSid('thread-sdk-hydrate', null, 'sdk-session-1');
    state.writeJob('j-sdk-hydrate', {
      jobId: 'j-sdk-hydrate', claudeSessionId: 'sid-sdk-hydrate',
      target: 'copilot', companionSessionId: 'sdk-session-1', thread: 'thread-sdk-hydrate',
      task: 'sdk in-flight before restart', mode: 'EXECUTE',
      status: 'running', promptId: 'prompt-sdk-hydrate',
      startedAt: Date.now() - 5000,
    });

    hydrateJobsFromLedger();
    const job = jobs.get('j-sdk-hydrate');
    assert.equal(job.status, 'unreachable');
    assert.equal(job.detail, 'sdk_adapter_non_resumable_after_restart');
    assert.equal(job.sessionRetired, true);
    assert.equal(state.readThreadSid('thread-sdk-hydrate'), null);

    const body = parse(await dispatch({
      action: 'wait',
      job_id: 'j-sdk-hydrate',
      max_wait_sec: 1,
      host_session_id: 'sid-sdk-hydrate',
    }));
    assert.equal(body.status, 'unreachable');
    assert.match(body.content, /SDK adapter cannot reattach/);
  } finally {
    state.deleteJob('j-sdk-hydrate');
    state.clearThread('thread-sdk-hydrate');
    jobs.clear();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    if (oldAdapter === undefined) delete process.env.COPILOT_RUNTIME_ADAPTER;
    else process.env.COPILOT_RUNTIME_ADAPTER = oldAdapter;
    _resetForTest();
  }
});

test('hydrateJobsFromLedger skips a ledger entry with no target (no silent fallback)', async () => {
  const mod = await bridge();
  const { jobs, hydrateJobsFromLedger, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-no-target';
  try {
    _resetForTest();
    jobs.clear();
    state.writeJob('j-no-target', {
      jobId: 'j-no-target', claudeSessionId: 'sid-no-target',
      status: 'running', startedAt: 1000,
    });
    hydrateJobsFromLedger();
    assert.equal(jobs.has('j-no-target'), false);
  } finally {
    state.deleteJob('j-no-target');
    jobs.clear();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
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
    assert.match(instant.body.hint, /agent_wait/);

    jobs.set('copilot-existing-1', {
      jobId: 'copilot-existing-1',
      target: 'copilot',
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
      target: 'copilot',
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
      target: 'copilot',
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

test('OpenCode companion adapter runs a fake CLI and surfaces terminal job state', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();

  const tmp = mkdtempSync(join(tmpdir(), 'opencode-fake-'));
  const fakeBin = join(tmp, 'opencode-fake.mjs');
  writeFileSync(fakeBin, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'if (args[0] !== "run" || !args.includes("--format")) {',
    '  console.error("unexpected args: " + args.join(" "));',
    '  process.exit(2);',
    '}',
    'console.log(JSON.stringify({ type: "message", message: "OpenCode fake completed" }));',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(fakeBin, 0o700);

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const oldBin = process.env.OPENCODE_BIN;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-opencode';
  process.env.OPENCODE_BIN = fakeBin;

  try {
    const send = parse(await dispatch({
      action: 'send',
      target: 'opencode',
      task: 'exercise the OpenCode adapter',
      mode: 'EXECUTE',
      template: 'general',
      cwd: TEST_CWD,
      host_session_id: 'sid-opencode',
      max_wait_sec: 5,
      parallel: 'never',
    }));
    assert.equal(send.ok, true);
    assert.equal(send.target, 'opencode');
    assert.match(send.job_id, /^opencode-/);
    assert.equal(send.status, 'still_running');
    assert.match(send.hint, /agent_wait/);

    const terminal = parse(await dispatch({
      action: 'wait',
      job_id: send.job_id,
      host_session_id: 'sid-opencode',
      max_wait_sec: 5,
    }));
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.target, 'opencode');
    assert.equal(terminal.meta.target, 'opencode');
    assert.match(terminal.content, /OpenCode fake completed/);
    assert.match(terminal.meta.digest_uri, new RegExp(`agent-digest://${send.job_id}`));

    const status = parse(await dispatch({
      action: 'status',
      job_id: send.job_id,
      host_session_id: 'sid-opencode',
      verbose: true,
    }));
    assert.equal(status.ok, true);
    assert.equal(status.target, 'opencode');
    assert.equal(status.inspect_available, false);

    jobs.set('opencode-running-reply', {
      jobId: 'opencode-running-reply',
      target: 'opencode',
      claudeSessionId: 'sid-opencode',
      status: 'running',
      promptId: 'opencode-reply',
      task: 'running opencode job',
      mode: 'EXECUTE',
      cwd: TEST_CWD,
      startedAt: Date.now(),
    });
    const reply = parse(await dispatch({
      action: 'reply',
      job_id: 'opencode-running-reply',
      message: 'revise this',
      host_session_id: 'sid-opencode',
    }));
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'TARGET_UNSUPPORTED');
    assert.equal(reply.target, 'opencode');
  } finally {
    jobs.delete('opencode-running-reply');
    for (const id of [...jobs.keys()]) {
      if (jobs.get(id)?.claudeSessionId === 'sid-opencode') jobs.delete(id);
    }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    if (oldBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = oldBin;
    rmSync(tmp, { recursive: true, force: true });
    _resetForTest();
  }
});

test('OpenCode cancel returns a standard terminal envelope', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();

  const tmp = mkdtempSync(join(tmpdir(), 'opencode-cancel-fake-'));
  const fakeBin = join(tmp, 'opencode-fake.mjs');
  writeFileSync(fakeBin, [
    '#!/usr/bin/env node',
    'process.on("SIGTERM", () => {',
    '  console.log(JSON.stringify({ type: "message", message: "cancelled partial output" }));',
    '  process.exit(0);',
    '});',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(fakeBin, 0o700);

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const oldBin = process.env.OPENCODE_BIN;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-opencode-cancel';
  process.env.OPENCODE_BIN = fakeBin;

  try {
    const send = parse(await dispatch({
      action: 'send',
      target: 'opencode',
      task: 'cancel the OpenCode adapter',
      mode: 'EXECUTE',
      template: 'general',
      cwd: TEST_CWD,
      host_session_id: 'sid-opencode-cancel',
      parallel: 'never',
    }));
    assert.equal(send.status, 'still_running');

    const cancelled = parse(await dispatch({
      action: 'cancel',
      job_id: send.job_id,
      host_session_id: 'sid-opencode-cancel',
    }));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.target, 'opencode');
    assert.equal(cancelled.meta.target, 'opencode');
    assert.match(cancelled.content, /OpenCode job was cancelled/);
  } finally {
    for (const id of [...jobs.keys()]) {
      if (jobs.get(id)?.claudeSessionId === 'sid-opencode-cancel') jobs.delete(id);
    }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    if (oldBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = oldBin;
    rmSync(tmp, { recursive: true, force: true });
    _resetForTest();
  }
});

test('OpenCode timeout is terminal and target-specific', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();

  const tmp = mkdtempSync(join(tmpdir(), 'opencode-timeout-fake-'));
  const fakeBin = join(tmp, 'opencode-fake.mjs');
  writeFileSync(fakeBin, [
    '#!/usr/bin/env node',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(fakeBin, 0o700);

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const oldBin = process.env.OPENCODE_BIN;
  const oldTimeout = process.env.AGENT_COMPANION_OPENCODE_TIMEOUT_MS;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-opencode-timeout';
  process.env.OPENCODE_BIN = fakeBin;
  process.env.AGENT_COMPANION_OPENCODE_TIMEOUT_MS = '50';

  try {
    const send = parse(await dispatch({
      action: 'send',
      target: 'opencode',
      task: 'timeout the OpenCode adapter',
      mode: 'EXECUTE',
      template: 'general',
      cwd: TEST_CWD,
      host_session_id: 'sid-opencode-timeout',
      parallel: 'never',
    }));
    const terminal = parse(await dispatch({
      action: 'wait',
      job_id: send.job_id,
      host_session_id: 'sid-opencode-timeout',
      max_wait_sec: 5,
    }));
    assert.equal(terminal.status, 'timeout');
    assert.equal(terminal.target, 'opencode');
    assert.equal(terminal.meta.detail, 'opencode_timeout');
    assert.match(terminal.content, /OpenCode did not finish within the target timeout/);
    assert.doesNotMatch(terminal.content, /\/fleet/);
  } finally {
    for (const id of [...jobs.keys()]) {
      if (jobs.get(id)?.claudeSessionId === 'sid-opencode-timeout') jobs.delete(id);
    }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    if (oldBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = oldBin;
    if (oldTimeout === undefined) delete process.env.AGENT_COMPANION_OPENCODE_TIMEOUT_MS;
    else process.env.AGENT_COMPANION_OPENCODE_TIMEOUT_MS = oldTimeout;
    rmSync(tmp, { recursive: true, force: true });
    _resetForTest();
  }
});

// --- Codex CLI adapter (bridge-server/codex-runtime.mjs) --------------------
//
// Same fakeBin-subprocess style as the OpenCode CLI tests above, adapted to
// codex's `exec --json` ThreadEvent stream (D10) instead of opencode's
// `run --format json` NDJSON. Per the safety contract, this NEVER invokes a
// real `codex` binary — CODEX_BIN always points at a fake script.

test('Codex companion adapter runs a fake CLI and surfaces terminal job state', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();

  const tmp = mkdtempSync(join(tmpdir(), 'codex-fake-'));
  const fakeBin = join(tmp, 'codex-fake.mjs');
  writeFileSync(fakeBin, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'if (args[0] !== "exec" || !args.includes("--json")) {',
    '  console.error("unexpected args: " + args.join(" "));',
    '  process.exit(2);',
    '}',
    'process.stdin.on("data", () => {});',
    'process.stdin.on("end", () => {',
    '  console.log(JSON.stringify({ type: "thread.started", thread_id: "th-fake-codex" }));',
    '  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex fake completed" } }));',
    '  console.log(JSON.stringify({ type: "turn.completed", usage: {} }));',
    '});',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(fakeBin, 0o700);

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const oldBin = process.env.CODEX_BIN;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-codex';
  process.env.CODEX_BIN = fakeBin;

  try {
    const send = parse(await dispatch({
      action: 'send',
      target: 'codex',
      task: 'exercise the codex adapter',
      mode: 'EXECUTE',
      template: 'general',
      cwd: TEST_CWD,
      host_session_id: 'sid-codex',
      max_wait_sec: 5,
      parallel: 'never',
    }));
    assert.equal(send.ok, true);
    assert.equal(send.target, 'codex');
    assert.match(send.job_id, /^codex-/);
    assert.equal(send.status, 'still_running');
    assert.match(send.hint, /agent_wait/);

    const terminal = parse(await dispatch({
      action: 'wait',
      job_id: send.job_id,
      host_session_id: 'sid-codex',
      max_wait_sec: 5,
    }));
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.target, 'codex');
    assert.equal(terminal.meta.target, 'codex');
    assert.match(terminal.content, /Codex fake completed/);
    assert.match(terminal.meta.digest_uri, new RegExp(`agent-digest://${send.job_id}`));

    // Digest renders through the SHARED writer (writeOpenCodeDigest) — the
    // header names the job's own target, not a codex-only renderer (D7).
    const { digestPath } = await import('../lib/prompt-digest.mjs');
    const digestText = readFileSync(digestPath(send.job_id), 'utf8');
    assert.match(digestText, /^# codex job /);

    const status = parse(await dispatch({
      action: 'status',
      job_id: send.job_id,
      host_session_id: 'sid-codex',
      verbose: true,
    }));
    assert.equal(status.ok, true);
    assert.equal(status.target, 'codex');
    assert.equal(status.inspect_available, false);
    // Send-only is a property of the EXEC transport, which is what this job ran
    // on (CODEX_RUNTIME_ADAPTER unset). Both flags are per-job, not per-target:
    // the same assertions are made the other way round for an appserver job,
    // where turn/steer and thread/resume make them true.
    assert.equal(status.reply_available, false);
    assert.equal(status.resume_available, false);

    // The codex thread_id lands in the existing target-neutral
    // companionSessionId slot. On exec it is still write-only groundwork;
    // the appserver adapter is the consumer that reads it back to resume.
    const state = await import('../lib/state.mjs');
    const persisted = state.readJob(send.job_id);
    assert.equal(persisted.companionSessionId, 'th-fake-codex');

    jobs.set('codex-running-reply', {
      jobId: 'codex-running-reply',
      target: 'codex',
      claudeSessionId: 'sid-codex',
      status: 'running',
      promptId: 'codex-reply',
      task: 'running codex job',
      mode: 'EXECUTE',
      cwd: TEST_CWD,
      startedAt: Date.now(),
    });
    const reply = parse(await dispatch({
      action: 'reply',
      job_id: 'codex-running-reply',
      message: 'revise this',
      host_session_id: 'sid-codex',
    }));
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'TARGET_UNSUPPORTED');
    assert.equal(reply.target, 'codex');
  } finally {
    jobs.delete('codex-running-reply');
    for (const id of [...jobs.keys()]) {
      if (jobs.get(id)?.claudeSessionId === 'sid-codex') jobs.delete(id);
    }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    if (oldBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = oldBin;
    rmSync(tmp, { recursive: true, force: true });
    _resetForTest();
  }
});

test("Codex cancel kills the codex child via codex-runtime (not OpenCode's maps) and returns a standard terminal envelope", async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();

  const tmp = mkdtempSync(join(tmpdir(), 'codex-cancel-fake-'));
  const fakeBin = join(tmp, 'codex-fake.mjs');
  writeFileSync(fakeBin, [
    '#!/usr/bin/env node',
    'process.on("SIGTERM", () => {',
    '  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "cancelled partial output" } }));',
    '  process.exit(0);',
    '});',
    'process.stdin.on("data", () => {});',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(fakeBin, 0o700);

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const oldBin = process.env.CODEX_BIN;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-codex-cancel';
  process.env.CODEX_BIN = fakeBin;

  try {
    const send = parse(await dispatch({
      action: 'send',
      target: 'codex',
      task: 'cancel the codex adapter',
      mode: 'EXECUTE',
      template: 'general',
      cwd: TEST_CWD,
      host_session_id: 'sid-codex-cancel',
      parallel: 'never',
    }));
    assert.equal(send.status, 'still_running');

    const cancelled = parse(await dispatch({
      action: 'cancel',
      job_id: send.job_id,
      host_session_id: 'sid-codex-cancel',
    }));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.target, 'codex');
    assert.equal(cancelled.meta.target, 'codex');
    assert.match(cancelled.content, /Codex CLI job was cancelled/);
  } finally {
    for (const id of [...jobs.keys()]) {
      if (jobs.get(id)?.claudeSessionId === 'sid-codex-cancel') jobs.delete(id);
    }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    if (oldBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = oldBin;
    rmSync(tmp, { recursive: true, force: true });
    _resetForTest();
  }
});

test('Codex timeout is terminal, tagged codex_timeout, and names the codex timeout env var', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();

  const tmp = mkdtempSync(join(tmpdir(), 'codex-timeout-fake-'));
  const fakeBin = join(tmp, 'codex-fake.mjs');
  writeFileSync(fakeBin, [
    '#!/usr/bin/env node',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(fakeBin, 0o700);

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const oldBin = process.env.CODEX_BIN;
  const oldTimeout = process.env.AGENT_COMPANION_CODEX_TIMEOUT_MS;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-codex-timeout';
  process.env.CODEX_BIN = fakeBin;
  process.env.AGENT_COMPANION_CODEX_TIMEOUT_MS = '50';

  try {
    const send = parse(await dispatch({
      action: 'send',
      target: 'codex',
      task: 'timeout the codex adapter',
      mode: 'EXECUTE',
      template: 'general',
      cwd: TEST_CWD,
      host_session_id: 'sid-codex-timeout',
      parallel: 'never',
    }));
    const terminal = parse(await dispatch({
      action: 'wait',
      job_id: send.job_id,
      host_session_id: 'sid-codex-timeout',
      max_wait_sec: 5,
    }));
    assert.equal(terminal.status, 'timeout');
    assert.equal(terminal.target, 'codex');
    assert.equal(terminal.meta.detail, 'codex_timeout');
    assert.match(terminal.content, /Codex CLI did not finish within the target timeout/);
    assert.match(terminal.content, /AGENT_COMPANION_CODEX_TIMEOUT_MS/);
    assert.doesNotMatch(terminal.content, /\/fleet/);
  } finally {
    for (const id of [...jobs.keys()]) {
      if (jobs.get(id)?.claudeSessionId === 'sid-codex-timeout') jobs.delete(id);
    }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    if (oldBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = oldBin;
    if (oldTimeout === undefined) delete process.env.AGENT_COMPANION_CODEX_TIMEOUT_MS;
    else process.env.AGENT_COMPANION_CODEX_TIMEOUT_MS = oldTimeout;
    rmSync(tmp, { recursive: true, force: true });
    _resetForTest();
  }
});

// --- OpenCode server-mode adapter (OPENCODE_RUNTIME_ADAPTER=server) ---------
//
// These drive the bridge through the server-runtime module's `_impl` seam: the
// bridge calls the module wrappers, the wrappers call `_impl.fetchJson` /
// `_impl.openEventStream` / `_impl.spawnServer`, so stubbing the module from the
// test rewires the whole server-mode path with no socket and no real opencode.

import { EventEmitter as _OcEmitter } from 'node:events';

function _ocFrame(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }
function _ocSse(frames) {
  return async () => (async function* () { for (const f of frames) yield f; })();
}
function _ocBootChild() {
  const child = new _OcEmitter();
  child.stdout = new _OcEmitter();
  child.stderr = new _OcEmitter();
  child.pid = 7777;
  child.unref = () => {};
  setImmediate(() => child.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:4096\n')));
  return child;
}

async function withOpenCodeServer(stubs, body) {
  const ocServer = await import('./opencode-server-runtime.mjs');
  const regDir = mkdtempSync(join(tmpdir(), 'oc-srv-reg-'));
  const oldReg = process.env.AGENT_OPENCODE_SERVER_REGISTRY;
  const oldAdapter = process.env.OPENCODE_RUNTIME_ADAPTER;
  process.env.AGENT_OPENCODE_SERVER_REGISTRY = join(regDir, 'servers.json');
  process.env.OPENCODE_RUNTIME_ADAPTER = 'server';
  ocServer._resetForTest();
  ocServer._setForTest({ spawnServer: _ocBootChild, ...stubs });
  try { return await body(ocServer); }
  finally {
    ocServer._resetForTest();
    if (oldReg === undefined) delete process.env.AGENT_OPENCODE_SERVER_REGISTRY; else process.env.AGENT_OPENCODE_SERVER_REGISTRY = oldReg;
    if (oldAdapter === undefined) delete process.env.OPENCODE_RUNTIME_ADAPTER; else process.env.OPENCODE_RUNTIME_ADAPTER = oldAdapter;
    rmSync(regDir, { recursive: true, force: true });
  }
}

test('OpenCode server mode: send routes through the HTTP server and completes', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-oc-srv';
  try {
    await withOpenCodeServer({
      fetchJson: async (url, opts = {}) => {
        if (url.includes('/global/health')) return { ok: true, data: { healthy: true } };
        if (url.endsWith('/session?directory=' + encodeURIComponent(TEST_CWD)) || (url.includes('/session?directory=') && opts.method === 'POST')) return { ok: true, data: { id: 'ses_send' } };
        if (url.includes('/prompt_async')) return { ok: true, data: {} };
        return { ok: true, data: {} };
      },
      openEventStream: _ocSse([
        _ocFrame({ type: 'message.part.updated', properties: { sessionID: 'ses_send', part: { id: 'p1', messageID: 'm1', type: 'text', text: 'server adapter done' } } }),
        _ocFrame({ type: 'session.idle', properties: { sessionID: 'ses_send' } }),
      ]),
    }, async () => {
      const send = parse(await dispatch({
        action: 'send', target: 'opencode', task: 'server-mode task', mode: 'EXECUTE',
        template: 'general', cwd: TEST_CWD, host_session_id: 'sid-oc-srv', parallel: 'never', max_wait_sec: 5,
      }));
      assert.equal(send.ok, true);
      assert.match(send.job_id, /^opencode-/);
      const terminal = parse(await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-oc-srv', max_wait_sec: 5 }));
      assert.equal(terminal.status, 'completed');
      assert.equal(terminal.target, 'opencode');
      assert.match(terminal.content, /server adapter done/);
      const job = jobs.get(send.job_id);
      assert.equal(job.opencodeAdapter, 'server');
      assert.equal(job.sessionId, 'ses_send');
      assert.equal(job.baseUrl, 'http://127.0.0.1:4096');
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-oc-srv') jobs.delete(id);
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('OpenCode server mode: a watch that breaks after the session opened records WHY in the digest', async () => {
  // The twin of the codex app-server test below. Both watch catches must store
  // the failure on `adapterResult`, not only write it: once the session is open
  // the job HAS a promptId, so emitNotification re-renders the digest body from
  // `adapterResult` a moment later — and this branch used to leave the previous
  // snapshot there, which rebuilt the file with the error text gone.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-oc-watchfail';
  try {
    await withOpenCodeServer({
      fetchJson: async (url) => {
        if (url.includes('/global/health')) return { ok: true, data: { healthy: true } };
        if (url.includes('/session?directory=')) return { ok: true, data: { id: 'ses_watchfail' } };
        return { ok: true, data: {} };
      },
      // The session exists; the event stream the watcher needs does not.
      openEventStream: async () => { throw new Error('event stream refused the connection'); },
    }, async () => {
      const send = parse(await dispatch({
        action: 'send', target: 'opencode', task: 'watch breaks', mode: 'EXECUTE',
        template: 'general', cwd: TEST_CWD, host_session_id: 'sid-oc-watchfail', parallel: 'never', max_wait_sec: 5,
      }));
      const terminal = parse(await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-oc-watchfail', max_wait_sec: 5 }));
      assert.equal(terminal.status, 'failed');
      const job = jobs.get(send.job_id);
      assert.equal(job.detail, 'opencode_server_watch_error');
      assert.ok(job.promptId, 'the session opened, so the digest refresh on notify is live');
      assert.match(readFileSync(digestPath(send.job_id), 'utf8'), /event stream refused the connection/,
        'the digest names the failure, not just the header');
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-oc-watchfail') jobs.delete(id);
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('REGRESSION OpenCode server model: a profile model reaches startOpenCodeServerPrompt body', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-oc-model';
  let promptBody = null;
  state.writeProfiles({ profiles: [
    { id: 'oc-pin', companion: 'opencode', adapter: 'server', model: 'anthropic/claude-sonnet-4.6', strengths: ['web_researcher'] },
  ] });
  try {
    await withOpenCodeServer({
      fetchJson: async (url, opts = {}) => {
        if (url.includes('/global/health')) return { ok: true, data: { healthy: true } };
        if (url.endsWith('/session?directory=' + encodeURIComponent(TEST_CWD)) || (url.includes('/session?directory=') && opts.method === 'POST')) return { ok: true, data: { id: 'ses_model' } };
        if (url.includes('/prompt_async')) { promptBody = opts.body; return { ok: true, data: {} }; }
        return { ok: true, data: {} };
      },
      openEventStream: _ocSse([
        _ocFrame({ type: 'message.part.updated', properties: { sessionID: 'ses_model', part: { id: 'p1', messageID: 'm1', type: 'text', text: 'done' } } }),
        _ocFrame({ type: 'session.idle', properties: { sessionID: 'ses_model' } }),
      ]),
    }, async () => {
      const send = parse(await dispatch({
        action: 'send', profile: 'oc-pin', task: 'server-mode model', mode: 'EXECUTE',
        template: 'general', cwd: TEST_CWD, host_session_id: 'sid-oc-model', parallel: 'never', max_wait_sec: 5,
      }));
      assert.equal(send.ok, true);
      assert.equal(send.target, 'opencode');
      parse(await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-oc-model', max_wait_sec: 5 }));
      // The per-profile model (not the env default) reaches the prompt body in
      // the server prompt API's { providerID, modelID } shape.
      assert.deepEqual(promptBody.model, { providerID: 'anthropic', modelID: 'claude-sonnet-4.6' });
    });
  } finally {
    state.clearProfiles();
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-oc-model') jobs.delete(id);
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('OpenCode server mode: reply re-steers and bumps the watch generation before aborting', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  let promptIdAtAbort = null;
  try {
    await withOpenCodeServer({
      fetchJson: async (url) => {
        if (url.includes('/abort')) { promptIdAtAbort = jobs.get('opencode-srv-reply')?.promptId; return { ok: true, data: true }; }
        if (url.includes('/session/status')) return { ok: true, data: {} }; // idle after abort
        if (url.includes('/prompt_async')) return { ok: true, data: {} };
        return { ok: true, data: {} };
      },
      openEventStream: _ocSse([_ocFrame({ type: 'session.idle', properties: { sessionID: 'ses_reply' } })]),
    }, async () => {
      jobs.set('opencode-srv-reply', {
        jobId: 'opencode-srv-reply', target: 'opencode', opencodeAdapter: 'server',
        claudeSessionId: 'sid-oc-reply', status: 'running', promptId: 'opencode-srv-reply',
        sessionId: 'ses_reply', baseUrl: 'http://127.0.0.1:4096', task: 't', mode: 'EXECUTE',
        cwd: TEST_CWD, startedAt: Date.now(),
      });
      const reply = parse(await dispatch({ action: 'reply', job_id: 'opencode-srv-reply', message: 'revise', host_session_id: 'sid-oc-reply' }));
      assert.equal(reply.ok, true);
      assert.equal(reply.target, 'opencode');
      assert.match(reply.new_prompt_id, /-r1$/);
      assert.equal(reply.session_id, 'ses_reply');
      // The generation must be bumped BEFORE the abort fires, so the old watcher
      // discards its (cancelled) terminal instead of resolving waiters.
      for (let i = 0; i < 50 && promptIdAtAbort == null; i++) await new Promise((r) => setImmediate(r));
      assert.match(promptIdAtAbort || '', /-r1$/);
    });
  } finally {
    jobs.delete('opencode-srv-reply');
    _resetForTest();
  }
});

test('OpenCode server mode: cancel aborts the turn and reports cancelled even when the stream goes idle without an abort error', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-oc-cancel2';
  let resolveAbort;
  const abortGate = new Promise((r) => { resolveAbort = r; });
  try {
    await withOpenCodeServer({
      fetchJson: async (url, opts = {}) => {
        if (url.includes('/global/health')) return { ok: true, data: { healthy: true } };
        if (url.includes('/session?directory=') && opts.method === 'POST') return { ok: true, data: { id: 'ses_cancel2' } };
        if (url.includes('/abort')) { resolveAbort(); return { ok: true, data: true }; }
        return { ok: true, data: {} };
      },
      // The turn streams nothing until the abort lands, then goes idle with NO
      // MessageAbortedError — exactly the case where the bridge's cancel intent
      // is the only signal that this was a cancellation.
      openEventStream: async () => (async function* () {
        await abortGate;
        yield _ocFrame({ type: 'session.idle', properties: { sessionID: 'ses_cancel2' } });
      })(),
    }, async () => {
      const send = parse(await dispatch({
        action: 'send', target: 'opencode', task: 'long task', mode: 'EXECUTE',
        template: 'general', cwd: TEST_CWD, host_session_id: 'sid-oc-cancel2', parallel: 'never', max_wait_sec: 1,
      }));
      // wait until the worker has a live session/running status
      for (let i = 0; i < 80 && jobs.get(send.job_id)?.status !== 'running'; i++) await new Promise((r) => setImmediate(r));
      const cancel = parse(await dispatch({ action: 'cancel', job_id: send.job_id, host_session_id: 'sid-oc-cancel2' }));
      // buildCancelFollowup waits up to 5s; the abort unblocks the stream → idle → terminal
      let term = cancel;
      for (let i = 0; i < 10 && (term.status === 'cancelling' || term.status === 'still_running'); i++) {
        term = parse(await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-oc-cancel2', max_wait_sec: 5 }));
      }
      assert.equal(term.status, 'cancelled');
      assert.equal(jobs.get(send.job_id).detail, 'cancelled');
    });
  } finally {
    resolveAbort?.();
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-oc-cancel2') jobs.delete(id);
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('OpenCode server mode: an empty completed turn is remapped to failed', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-oc-empty';
  try {
    await withOpenCodeServer({
      fetchJson: async (url, opts = {}) => {
        if (url.includes('/global/health')) return { ok: true, data: { healthy: true } };
        if (url.includes('/session?directory=') && opts.method === 'POST') return { ok: true, data: { id: 'ses_empty' } };
        return { ok: true, data: {} };
      },
      // session.idle with no message parts at all → empty completed
      openEventStream: _ocSse([_ocFrame({ type: 'session.idle', properties: { sessionID: 'ses_empty' } })]),
    }, async () => {
      const send = parse(await dispatch({
        action: 'send', target: 'opencode', task: 'produce nothing', mode: 'EXECUTE',
        template: 'general', cwd: TEST_CWD, host_session_id: 'sid-oc-empty', parallel: 'never', max_wait_sec: 5,
      }));
      const terminal = parse(await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-oc-empty', max_wait_sec: 5 }));
      assert.equal(terminal.status, 'failed');
      assert.equal(jobs.get(send.job_id).detail, 'empty_completed');
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-oc-empty') jobs.delete(id);
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('OpenCode server mode: per-job status flags reflect reply/resume availability', async () => {
  const mod = await bridge();
  const { jobs, buildJobResponse, _resetForTest } = mod;
  _resetForTest();
  await withOpenCodeServer({}, async () => {
    const live = buildJobResponse({
      jobId: 'oc-live', target: 'opencode', opencodeAdapter: 'server',
      status: 'running', sessionId: 'ses_x', baseUrl: 'http://h', promptId: 'opencode-oc-live', startedAt: Date.now(),
    });
    assert.equal(live.reply_available, true);
    assert.equal(live.resume_available, true);
    // A cli-mode opencode job advertises neither.
    const cli = buildJobResponse({ jobId: 'oc-cli', target: 'opencode', status: 'running', promptId: 'opencode-oc-cli', startedAt: Date.now() });
    assert.equal(cli.reply_available, false);
    assert.equal(cli.resume_available, false);
  });
  _resetForTest();
});

test('OpenCode server mode: hydrate resumes a persisted job from its transcript', async () => {
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  _resetForTest();
  const state = await import('../lib/state.mjs');
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-oc-hydrate';
  try {
    await withOpenCodeServer({
      fetchJson: async (url) => {
        if (url.includes('/global/health')) return { ok: true, data: { healthy: true } };
        if (url.includes('/session/status')) return { ok: true, data: {} }; // idle
        if (url.includes('/message')) return { ok: true, data: [
          { info: { role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{ type: 'text', text: 'finished while bridge was down' }] },
        ] };
        return { ok: true, data: {} };
      },
      openEventStream: _ocSse([]),
    }, async () => {
      // Persist a non-terminal server-mode job, then drop it from memory.
      jobs.set('opencode-hydrate', {
        jobId: 'opencode-hydrate', target: 'opencode', opencodeAdapter: 'server',
        claudeSessionId: 'sid-oc-hydrate', status: 'running', promptId: 'opencode-hydrate',
        sessionId: 'ses_hyd', baseUrl: 'http://127.0.0.1:4096', task: 't', mode: 'EXECUTE',
        cwd: TEST_CWD, startedAt: Date.now(),
      });
      mod.persistJob('opencode-hydrate');
      jobs.delete('opencode-hydrate');
      mod._resetForTest(); // clears the _hydrated guard; CLAUDE_CODE_SESSION_ID drives the claim

      mod.hydrateJobsFromLedger();
      // resume runs async; poll until terminal
      for (let i = 0; i < 50 && !jobs.get('opencode-hydrate')?.terminalAt; i++) {
        await new Promise((r) => setImmediate(r));
      }
      const job = jobs.get('opencode-hydrate');
      assert.ok(job, 'job claimed from ledger');
      assert.equal(job.status, 'completed');
      assert.match(job.adapterResult?.summary?.message || '', /finished while bridge was down/);
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-oc-hydrate') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

// --- Codex app-server adapter (CODEX_RUNTIME_ADAPTER=appserver) -------------
//
// Same technique as withOpenCodeServer above, one layer lower: the bridge calls
// the adapter's module wrappers, the wrappers call `_impl.connect`, so handing
// them the shared fake broker socket rewires the whole app-server path with no
// broker process, no unix socket and no codex binary. The socket fake is the
// one test/fake-codex-broker-socket.mjs hands the adapter's own suite, so these
// tests cannot pass against a broker that suite never saw.

import { fakeBrokerSocket as _cxSocket } from '../test/fake-codex-broker-socket.mjs';

async function _cxUntil(predicate, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return false;
}

// Wall-clock variant, for the one test that waits on a real process booting
// rather than on this process's own microtasks.
async function _cxUntilMs(predicate, budgetMs = 8000, stepMs = 20) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

async function withCodexAppServer({ handlers = {}, statuses = {}, turns = {}, connect = null, spawnBroker = null } = {}, body) {
  const cx = await import('./codex-app-server-runtime.mjs');
  const regDir = mkdtempSync(join(tmpdir(), 'cx-srv-reg-'));
  const prior = {
    reg: process.env.AGENT_CODEX_BROKER_REGISTRY,
    sock: process.env.CODEX_BROKER_SOCKET_PATH,
    adapter: process.env.CODEX_RUNTIME_ADAPTER,
  };
  process.env.AGENT_CODEX_BROKER_REGISTRY = join(regDir, 'broker.json');
  process.env.CODEX_BROKER_SOCKET_PATH = join(regDir, 'b.sock');
  process.env.CODEX_RUNTIME_ADAPTER = 'appserver';
  cx._resetForTest();
  const sockets = [];
  const newSocket = () => { const s = _cxSocket({ handlers, statuses, turns }); sockets.push(s); return s; };
  cx._setForTest({
    connect: connect ? async (path, ms) => connect({ path, ms, newSocket, sockets }) : async () => newSocket(),
    // A live broker answers the health probe, so nothing here may spawn one;
    // a test that wants the spawn path asks for it explicitly.
    spawnBroker: spawnBroker || (() => { throw new Error('the bridge spawned a broker instead of reusing the live one'); }),
  });
  try { return await body({ cx, sockets, live: () => sockets[sockets.length - 1] }); }
  finally {
    cx._resetForTest();
    if (prior.reg === undefined) delete process.env.AGENT_CODEX_BROKER_REGISTRY; else process.env.AGENT_CODEX_BROKER_REGISTRY = prior.reg;
    if (prior.sock === undefined) delete process.env.CODEX_BROKER_SOCKET_PATH; else process.env.CODEX_BROKER_SOCKET_PATH = prior.sock;
    if (prior.adapter === undefined) delete process.env.CODEX_RUNTIME_ADAPTER; else process.env.CODEX_RUNTIME_ADAPTER = prior.adapter;
    rmSync(regDir, { recursive: true, force: true });
  }
}

// A realistic digest left behind by a bridge that died mid-turn: multi-KB of
// streamed work carrying a marker string. The size is the point — the W1.4′
// regression is a multi-KB body collapsing to a few hundred bytes, and a
// length-ratio assertion on a 97-byte seed cannot see it.
function _cxDeadBridgeDigest(jobId, marker) {
  const body = Array.from({ length: 60 }, (_, i) => `${marker} streamed line ${i} — work the dead bridge already paid for.`).join('\n');
  return [
    `# codex job ${jobId} - digest`, '',
    '**Updated:** 2026-08-11T00:00:00.000Z', '**Status:** `running`', '',
    '## Task', '', 't', '',
    '## Final / partial assistant message', '', body, '',
  ].join('\n');
}

// Seed a live app-server job the way runCodexAppServerWorker would have.
function _cxLiveJob(jobs, jobId, sid, extra = {}) {
  jobs.set(jobId, {
    jobId, target: 'codex', codexAdapter: 'appserver',
    claudeSessionId: sid, status: 'running', promptId: `codex-${jobId}`,
    // A running app-server job HAS a turn id: the worker records it from
    // `turn/start`'s answer and refreshes it from every `turn/started`. It is
    // what `turn/interrupt` and `turn/steer` require, so a fixture without one
    // models a bridge that restarted mid-turn, not a normal live job — and that
    // case has its own test (`extra: { turnId: null }`).
    turnId: 'TURN1',
    sessionId: 'T1', brokerSocket: process.env.CODEX_BROKER_SOCKET_PATH,
    task: 't', mode: 'EXECUTE', cwd: TEST_CWD, startedAt: Date.now(),
    ...extra,
  });
  return jobs.get(jobId);
}

test('Codex dispatch stays on the exec adapter when CODEX_RUNTIME_ADAPTER is unset', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  const cx = await import('./codex-app-server-runtime.mjs');
  _resetForTest();

  const tmp = mkdtempSync(join(tmpdir(), 'codex-exec-default-'));
  const fakeBin = join(tmp, 'codex-fake.mjs');
  writeFileSync(fakeBin, [
    '#!/usr/bin/env node',
    'if (process.argv[2] !== "exec") { console.error("not exec"); process.exit(2); }',
    'process.stdin.on("data", () => {});',
    'process.stdin.on("end", () => {',
    '  console.log(JSON.stringify({ type: "thread.started", thread_id: "th-exec-default" }));',
    '  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "exec path ran" } }));',
    '  console.log(JSON.stringify({ type: "turn.completed", usage: {} }));',
    '});',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(fakeBin, 0o700);

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const oldBin = process.env.CODEX_BIN;
  const oldAdapter = process.env.CODEX_RUNTIME_ADAPTER;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-exec';
  process.env.CODEX_BIN = fakeBin;
  delete process.env.CODEX_RUNTIME_ADAPTER;

  // Positively: the app-server transport is not merely unused, it is never even
  // asked for a connection.
  let brokerTouches = 0;
  cx._resetForTest();
  cx._setForTest({
    connect: async () => { brokerTouches++; throw new Error('exec dispatch must not open a broker connection'); },
    spawnBroker: () => { brokerTouches++; throw new Error('exec dispatch must not spawn a broker'); },
  });
  try {
    const send = parse(await dispatch({
      action: 'send', target: 'codex', task: 'default adapter', mode: 'EXECUTE',
      template: 'general', cwd: TEST_CWD, host_session_id: 'sid-cx-exec', parallel: 'never', max_wait_sec: 5,
    }));
    const terminal = parse(await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-cx-exec', max_wait_sec: 5 }));
    assert.equal(terminal.status, 'completed');
    assert.match(terminal.content, /exec path ran/);
    assert.equal(brokerTouches, 0, 'the codex broker must never be contacted on the exec path');

    const job = jobs.get(send.job_id);
    // The exec worker records a child pid and no adapter marker; the app-server
    // worker records the opposite. That asymmetry is the positive evidence.
    assert.equal(job.codexAdapter, undefined);
    assert.ok(job.pid > 0, 'the exec path spawns a child and records its pid');
    assert.equal(job.sessionId, 'th-exec-default');

    const status = parse(await dispatch({ action: 'status', job_id: send.job_id, host_session_id: 'sid-cx-exec' }));
    assert.equal(status.reply_available, false);
    assert.equal(status.resume_available, false);

    // The global status payload keeps its exec shape: no broker block leaks in.
    const global = parse(await dispatch({ action: 'status', host_session_id: 'sid-cx-exec' }));
    assert.deepEqual(Object.keys(global.codex_runtime).sort(), ['bin', 'sandbox', 'timeout_ms']);
    assert.equal(global.targets.find((t) => t.id === 'codex').capabilities.reply, false);
  } finally {
    cx._resetForTest();
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-exec') jobs.delete(id);
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    if (oldBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = oldBin;
    if (oldAdapter === undefined) delete process.env.CODEX_RUNTIME_ADAPTER; else process.env.CODEX_RUNTIME_ADAPTER = oldAdapter;
    rmSync(tmp, { recursive: true, force: true });
    _resetForTest();
  }
});

test('Codex app-server mode: the thread id is persisted while the job is still running, and deltas stream into the digest', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-send';
  try {
    await withCodexAppServer({}, async ({ live }) => {
      const send = parse(await dispatch({
        action: 'send', target: 'codex', task: 'stream me', mode: 'EXECUTE',
        template: 'general', cwd: TEST_CWD, host_session_id: 'sid-cx-send', parallel: 'never', max_wait_sec: 5,
      }));
      assert.equal(send.ok, true);
      assert.match(send.job_id, /^codex-/);

      // W1.1's guarantee on this transport: `thread/start` answers before the
      // model does anything, so the resumable id is in the ledger while the job
      // is still running — not after it ends.
      assert.ok(await _cxUntil(() => jobs.get(send.job_id)?.sessionId === 'T1'), 'thread id captured');
      const running = jobs.get(send.job_id);
      assert.equal(running.status, 'running');
      assert.equal(running.terminalAt, undefined);
      assert.equal(running.codexAdapter, 'appserver');
      assert.equal(running.promptId, `codex-${send.job_id}`);
      const persisted = state.readJob(send.job_id);
      assert.equal(persisted.companionSessionId, 'T1');
      assert.equal(persisted.terminalAt, undefined, 'persisted while still in flight');

      const st = parse(await dispatch({ action: 'status', job_id: send.job_id, host_session_id: 'sid-cx-send' }));
      assert.equal(st.session_id, 'T1');
      assert.equal(st.reply_available, true);
      assert.equal(st.resume_available, true);

      const sock = live();
      assert.ok(await _cxUntil(() => sock.wire().includes('turn/start')), 'turn started');
      // The turn is guarded: the status check runs before turn/start, and a
      // thread this connection created is known-idle so it costs no resume.
      assert.deepEqual(sock.wire(), ['thread/start', 'broker/subscribe', 'turn/start']);
      const startParams = sock.paramsFor('thread/start')[0];
      assert.equal(startParams.approvalPolicy, 'never');
      assert.equal(startParams.ephemeral, false);
      assert.equal('model' in startParams, false, 'no pin, so config.toml stays authoritative');

      // Sub-turn streaming (F7): a delta mid-turn is visible in the digest
      // before anything terminal has happened.
      sock.notify('item/agentMessage/delta', { itemId: 'm1', delta: 'partway through the work' });
      assert.ok(await _cxUntil(() => /partway through the work/.test(readFileSync(digestPath(send.job_id), 'utf8'))),
        'the live digest carries the streamed delta');
      assert.equal(jobs.get(send.job_id).terminalAt, undefined, 'still running while streaming');

      sock.notify('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'ALL DONE', phase: 'final_answer' } });
      sock.notify('turn/completed', { turn: { id: 'TURN1', status: 'completed', items: [] } });

      const terminal = parse(await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-cx-send', max_wait_sec: 5 }));
      assert.equal(terminal.status, 'completed');
      assert.equal(terminal.target, 'codex');
      assert.match(terminal.content, /ALL DONE/);
      // Shared digest writer, target-neutral header — no third writer.
      assert.match(readFileSync(digestPath(send.job_id), 'utf8'), /^# codex job /);
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-send') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('Codex app-server mode: end to end through the REAL broker and the shared fake app-server', async (t) => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  const cx = await import('./codex-app-server-runtime.mjs');
  const { fakeCodexBin } = await import('../test/fake-codex-app-server.mjs');
  const { note, threadItem } = await import('../test/codex-wire-frames.mjs');
  _resetForTest();

  // Unix socket paths are truncated at SUN_LEN (~104 bytes), so the root stays
  // short. Everything the bridge writes is redirected into it.
  const dir = mkdtempSync(join(tmpdir(), 'cxb-'));
  const prior = {
    sock: process.env.CODEX_BROKER_SOCKET_PATH,
    reg: process.env.AGENT_CODEX_BROKER_REGISTRY,
    runtime: process.env.AGENT_RUNTIME_DIR,
    hb: process.env.AGENT_HEARTBEAT_DIR,
    adapter: process.env.CODEX_RUNTIME_ADAPTER,
    bin: process.env.CODEX_BIN,
    sid: process.env.CLAUDE_CODE_SESSION_ID,
    logLevel: process.env.CODEX_BROKER_LOG_LEVEL,
  };
  process.env.CODEX_BROKER_SOCKET_PATH = join(dir, 'b.sock');
  process.env.AGENT_CODEX_BROKER_REGISTRY = join(dir, 'broker.json');
  process.env.AGENT_RUNTIME_DIR = dir;
  process.env.AGENT_HEARTBEAT_DIR = join(dir, 'hb');
  process.env.CODEX_RUNTIME_ADAPTER = 'appserver';
  process.env.CODEX_BIN = fakeCodexBin(dir);
  process.env.CODEX_BROKER_LOG_LEVEL = 'ERROR';
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-e2e';
  cx._resetForTest();
  t.after(() => {
    const pid = cx.codexBrokerSnapshot()?.pid;
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    cx._resetForTest();
    for (const [k, v] of Object.entries({
      CODEX_BROKER_SOCKET_PATH: prior.sock, AGENT_CODEX_BROKER_REGISTRY: prior.reg,
      AGENT_RUNTIME_DIR: prior.runtime, AGENT_HEARTBEAT_DIR: prior.hb,
      CODEX_RUNTIME_ADAPTER: prior.adapter, CODEX_BIN: prior.bin,
      CLAUDE_CODE_SESSION_ID: prior.sid, CODEX_BROKER_LOG_LEVEL: prior.logLevel,
    })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-e2e') jobs.delete(id);
    rmSync(dir, { recursive: true, force: true });
    _resetForTest();
  });

  const send = parse(await dispatch({
    action: 'send', target: 'codex', task: 'real broker', mode: 'EXECUTE',
    template: 'general', cwd: dir, host_session_id: 'sid-cx-e2e', parallel: 'never', max_wait_sec: 5,
  }));
  assert.equal(send.ok, true);
  // The bridge spawned a real detached broker, which spawned the fake
  // app-server over stdio and handshook with it.
  assert.ok(
    await _cxUntilMs(() => jobs.get(send.job_id)?.sessionId === 'T1'),
    `thread opened through the real broker (job=${JSON.stringify(jobs.get(send.job_id)?.error || jobs.get(send.job_id)?.status)})`,
  );
  assert.equal(jobs.get(send.job_id).codexAdapter, 'appserver');
  assert.ok(cx.codexBrokerSnapshot()?.pid > 0, 'the broker is recorded in the shared registry');

  // Drive the turn from a SECOND client, so every frame below travels
  // app-server stdout -> broker -> threadId routing -> the bridge's own
  // connection. Nothing is injected into the bridge locally.
  const driver = await cx.connectCodexBroker({ socketPath: process.env.CODEX_BROKER_SOCKET_PATH });
  // Built from the pinned contract (test/codex-wire-frames.mjs), not written by
  // hand: these three frames are the bridge's only end-to-end proof that the
  // digest it publishes came off a real wire, so their shape is the assertion.
  await driver.call('fake/emit', { frames: [
    note('item/agentMessage/delta', { threadId: 'T1', itemId: 'm1', delta: 'through the real broker' }),
    note('item/completed', { threadId: 'T1', item: threadItem('agentMessage', {
      id: 'm1', text: 'through the real broker', phase: 'final_answer',
    }) }),
    note('turn/completed', { threadId: 'T1', turn: { id: 'TURN1', status: 'completed', items: [] } }),
  ] });
  driver.close();

  const terminal = parse(await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-cx-e2e', max_wait_sec: 10 }));
  assert.equal(terminal.status, 'completed');
  assert.match(terminal.content, /through the real broker/);
});

test('Codex app-server mode: cancel maps to turn/interrupt and settles cancelled although the stream says interrupted', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-cancel';
  let workerSock = null;
  try {
    await withCodexAppServer({
      handlers: {
        // The interrupt is what ends the turn, so the stream answers it — with
        // `interrupted`, which carries NO assistant answer.
        'turn/interrupt': () => {
          workerSock?.notify('turn/completed', { turn: { id: 'TURN1', status: 'interrupted', items: [] } });
          return {};
        },
      },
    }, async ({ live, sockets }) => {
      const send = parse(await dispatch({
        action: 'send', target: 'codex', task: 'long codex turn', mode: 'EXECUTE',
        template: 'general', cwd: TEST_CWD, host_session_id: 'sid-cx-cancel', parallel: 'never', max_wait_sec: 5,
      }));
      assert.ok(await _cxUntil(() => jobs.get(send.job_id)?.status === 'running'), 'job running');
      workerSock = live();
      assert.ok(await _cxUntil(() => workerSock.wire().includes('turn/start')), 'turn started');
      workerSock.notify('item/agentMessage/delta', { itemId: 'm1', delta: 'half an answer' });

      const cancel = parse(await dispatch({ action: 'cancel', job_id: send.job_id, host_session_id: 'sid-cx-cancel' }));
      const cancelSock = sockets[sockets.length - 1];
      assert.notEqual(cancelSock, workerSock, 'cancel opens its own connection');
      // Resume-before-act: a connection that did not start the thread would
      // otherwise meet `thread not found`, which means "not loaded here".
      assert.deepEqual(cancelSock.wire(), ['thread/resume', 'turn/interrupt']);

      let term = cancel;
      for (let i = 0; i < 10 && (term.status === 'cancelling' || term.status === 'still_running'); i++) {
        term = parse(await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-cx-cancel', max_wait_sec: 5 }));
      }
      assert.equal(term.status, 'cancelled');
      const job = jobs.get(send.job_id);
      assert.equal(job.detail, 'cancelled');
      assert.equal(job.error, null);
      // The thread outlives the interrupt — that is the whole difference from
      // the exec adapter's SIGTERM — and the response says so.
      assert.equal(job.sessionId, 'T1');
      assert.match(String(cancel.note || term.content || ''), /stays live|resumable|cancelled/i);
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-cancel') jobs.delete(id);
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('Codex app-server mode: cancel sends the turn id the protocol REQUIRES, taken from the live turn', async () => {
  // The shipped defect: `interruptCodexTurn` omitted `turnId` when null and the
  // bridge never passed one, so every app-server cancel was
  // `-32600 missing field \`turnId\`` on the real server. The fakes validate the
  // contract now, so this cannot pass by omission — and the id asserted here is
  // the one the worker banked from `turn/start`.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-turnid';
  try {
    await withCodexAppServer({}, async ({ sockets }) => {
      const send = parse(await dispatch({
        action: 'send', target: 'codex', task: 'long codex turn', mode: 'EXECUTE',
        template: 'general', cwd: TEST_CWD, host_session_id: 'sid-cx-turnid', parallel: 'never', max_wait_sec: 5,
      }));
      assert.ok(await _cxUntil(() => jobs.get(send.job_id)?.turnId), 'the worker banks the turn id');
      assert.equal(jobs.get(send.job_id).turnId, 'TURN1');

      const cancel = parse(await dispatch({ action: 'cancel', job_id: send.job_id, host_session_id: 'sid-cx-turnid' }));
      const cancelSock = sockets[sockets.length - 1];
      assert.deepEqual(cancelSock.paramsFor('turn/interrupt')[0], { threadId: 'T1', turnId: 'TURN1' });
      assert.equal(cancel.turn_id, 'TURN1');
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-turnid') jobs.delete(id);
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('Codex app-server mode: a RESTARTED bridge cancels by reading the running turn off thread/read', async () => {
  // The turn began before this bridge existed, so `turn/started` is gone for
  // good and the ledger row carries no turn id. `thread/read{includeTurns:true}`
  // reports the last turn as `{id, status}`, and the running one reads
  // `inProgress` — the only other place this id exists.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    await withCodexAppServer({
      statuses: { T1: 'active' },
      turns: { T1: [{ id: 'TURN_OLD', status: 'completed' }, { id: 'TURN_LIVE', status: 'inProgress' }] },
    }, async ({ sockets }) => {
      _cxLiveJob(jobs, 'codex-restarted', 'sid-cx-restart', { turnId: null });
      const cancel = parse(await dispatch({ action: 'cancel', job_id: 'codex-restarted', host_session_id: 'sid-cx-restart' }));
      const sock = sockets[sockets.length - 1];
      assert.equal(cancel.ok, true);
      assert.equal(cancel.turn_id, 'TURN_LIVE');
      assert.deepEqual(sock.wire(), ['thread/read', 'thread/resume', 'turn/interrupt']);
      assert.deepEqual(sock.paramsFor('turn/interrupt')[0], { threadId: 'T1', turnId: 'TURN_LIVE' });
    });
  } finally {
    jobs.delete('codex-restarted');
    _resetForTest();
  }
});

test('Codex app-server mode: a cancel with no resolvable turn id fails LOUDLY and leaves the job running', async () => {
  // The alternative is what shipped: omit the field, get a -32600 the operator
  // never sees, and tell them the cancel was accepted. A cancel that cannot be
  // sent must also not leave `cancelRequested` behind — a stale flag relabels
  // whatever the turn actually produced as `cancelled`.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    await withCodexAppServer({ statuses: { T1: 'active' }, turns: { T1: [] } }, async ({ sockets }) => {
      _cxLiveJob(jobs, 'codex-noturn', 'sid-cx-noturn', { turnId: null });
      const cancel = parse(await dispatch({ action: 'cancel', job_id: 'codex-noturn', host_session_id: 'sid-cx-noturn' }));
      assert.equal(cancel.ok, false);
      assert.equal(cancel.status, 'cancel_failed');
      assert.match(cancel.error, /needs the running turn's id on thread T1/);
      assert.match(cancel.error, /no turns at all/);
      assert.equal(jobs.get('codex-noturn').cancelRequested, false);
      assert.equal(jobs.get('codex-noturn').terminalAt, undefined);
      assert.equal(sockets[sockets.length - 1].wire().includes('turn/interrupt'), false);
    });
  } finally {
    jobs.delete('codex-noturn');
    _resetForTest();
  }
});

test('Codex app-server mode: the bridge owns the cancel verdict when the turn races the interrupt to completed', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-race';
  let workerSock = null;
  try {
    await withCodexAppServer({
      handlers: {
        // The turn had already finished when the interrupt landed, so the
        // stream reports `completed`. Only the intent recorded before the
        // interrupt tells the operator their cancel was honoured.
        'turn/interrupt': () => {
          workerSock?.notify('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'raced to the end', phase: 'final_answer' } });
          workerSock?.notify('turn/completed', { turn: { id: 'TURN1', status: 'completed', items: [] } });
          return {};
        },
      },
    }, async ({ live }) => {
      const send = parse(await dispatch({
        action: 'send', target: 'codex', task: 'racing turn', mode: 'EXECUTE',
        template: 'general', cwd: TEST_CWD, host_session_id: 'sid-cx-race', parallel: 'never', max_wait_sec: 5,
      }));
      assert.ok(await _cxUntil(() => jobs.get(send.job_id)?.status === 'running'), 'job running');
      workerSock = live();
      assert.ok(await _cxUntil(() => workerSock.wire().includes('turn/start')), 'turn started');
      let term = parse(await dispatch({ action: 'cancel', job_id: send.job_id, host_session_id: 'sid-cx-race' }));
      for (let i = 0; i < 10 && (term.status === 'cancelling' || term.status === 'still_running'); i++) {
        term = parse(await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-cx-race', max_wait_sec: 5 }));
      }
      assert.equal(term.status, 'cancelled');
      assert.equal(jobs.get(send.job_id).detail, 'cancelled');
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-race') jobs.delete(id);
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('Codex app-server mode: a cancel whose interrupt never lands does not later relabel a finished turn as cancelled', async () => {
  // The intent is recorded BEFORE the interrupt so the watch can own the
  // verdict. If the interrupt then fails, that intent has to go with it —
  // otherwise the turn runs to a normal completion and the watch stamps it
  // `cancelled` with `error: null`, so the parent throws away a finished answer
  // it was already told the cancel had failed to stop.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-cancelfail';
  let workerSock = null;
  try {
    await withCodexAppServer({
      handlers: {
        'turn/interrupt': () => { throw new Error('broker busy: interrupt not acknowledged'); },
      },
    }, async ({ live }) => {
      const send = parse(await dispatch({
        action: 'send', target: 'codex', task: 'uncancellable turn', mode: 'EXECUTE',
        template: 'general', cwd: TEST_CWD, host_session_id: 'sid-cx-cancelfail', parallel: 'never', max_wait_sec: 5,
      }));
      assert.ok(await _cxUntil(() => jobs.get(send.job_id)?.status === 'running'), 'job running');
      workerSock = live();
      assert.ok(await _cxUntil(() => workerSock.wire().includes('turn/start')), 'turn started');

      const cancel = parse(await dispatch({ action: 'cancel', job_id: send.job_id, host_session_id: 'sid-cx-cancelfail' }));
      assert.equal(cancel.ok, false);
      assert.equal(cancel.status, 'cancel_failed');
      assert.equal(cancel.cancelled, false);
      assert.equal(jobs.get(send.job_id).cancelRequested, false, 'the unfulfilled intent was withdrawn');

      // The turn the operator was told could not be cancelled now finishes.
      workerSock.notify('turn/completed', { turn: { id: 'TURN1', status: 'completed', items: [
        { id: 'm1', type: 'agentMessage', text: 'finished anyway', phase: 'final_answer' },
      ] } });
      const term = parse(await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-cx-cancelfail', max_wait_sec: 5 }));
      assert.equal(term.status, 'completed', 'a turn that finished is reported as finished');
      assert.match(term.content, /finished anyway/);
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-cancelfail') jobs.delete(id);
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('Codex app-server mode: a watch that breaks after the thread opened records WHY in the digest', async () => {
  // The digest is where the operator is sent for salvage, so a failed
  // app-server job that leaves a header-only file tells them nothing. Once the
  // thread is open the job HAS a promptId, which is what makes
  // emitNotification re-render the body from `adapterResult` — so the failure
  // text has to live there, not only in the write just above it.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-watchfail';
  try {
    await withCodexAppServer({
      // The thread opens, then the subscription the watcher needs is refused.
      handlers: { 'broker/subscribe': () => { throw new Error('broker refused the subscription'); } },
    }, async () => {
      const send = parse(await dispatch({
        action: 'send', target: 'codex', task: 'watch breaks', mode: 'EXECUTE',
        template: 'general', cwd: TEST_CWD, host_session_id: 'sid-cx-watchfail', parallel: 'never', max_wait_sec: 5,
      }));
      assert.ok(await _cxUntil(() => jobs.get(send.job_id)?.terminalAt), 'the job settles');
      const job = jobs.get(send.job_id);
      assert.equal(job.status, 'failed');
      assert.equal(job.detail, 'codex_server_watch_error');
      assert.ok(job.promptId, 'the thread opened, so the digest refresh on notify is live');
      assert.match(readFileSync(digestPath(send.job_id), 'utf8'), /broker refused the subscription/,
        'the digest names the failure, not just the header');
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-watchfail') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('Codex app-server mode: reply on a running turn steers it — no cancel, no restart, no generation bump', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    // `active` is what `thread/resume` reports for a thread with a turn in
    // flight — and resume IS the status read on this protocol.
    await withCodexAppServer({ statuses: { T1: 'active' } }, async ({ sockets }) => {
      const job = _cxLiveJob(jobs, 'codex-steer', 'sid-cx-steer');
      const reply = parse(await dispatch({ action: 'reply', job_id: 'codex-steer', message: 'actually, use ripgrep', host_session_id: 'sid-cx-steer' }));
      assert.equal(reply.ok, true);
      assert.equal(reply.target, 'codex');
      assert.equal(reply.steered, true);
      assert.equal(reply.thread_id, 'T1');
      // The watcher already driving the turn is the one that answers, so the
      // generation must NOT move — bumping it would make that watcher discard
      // its own terminal and the job would never settle.
      assert.equal(reply.new_prompt_id, job.promptId);
      assert.equal(jobs.get('codex-steer').promptId, 'codex-codex-steer');
      assert.equal(jobs.get('codex-steer').replyTurn, 1);
      assert.equal(jobs.get('codex-steer').terminalAt, undefined);

      // The lock is held across the RPCs and released on the way out, so the
      // next steer is not locked out by the previous one.
      assert.equal(jobs.get('codex-steer').replyInFlight, false);

      const sock = sockets[sockets.length - 1];
      assert.deepEqual(sock.wire(), ['thread/resume', 'turn/steer'], 'steer only: no interrupt, no second turn/start');
      // `expectedTurnId` is REQUIRED — omitting it was an unconditional -32600
      // on the real server, i.e. every app-server reply failed. The fake
      // enforces the contract, so the field being on the wire is what makes
      // this test pass at all.
      assert.deepEqual(sock.paramsFor('turn/steer')[0], {
        threadId: 'T1', expectedTurnId: 'TURN1', input: [{ type: 'text', text: 'actually, use ripgrep' }],
      });
      assert.equal(reply.turn_id, 'TURN1');
      // Two facts, kept apart: the server accepted it, and the injected message
      // was seen landing in the turn.
      assert.equal(reply.steer_confirmed, true);
      assert.match(reply.steer_confirmation, /item\/completed userMessage/);
    });
  } finally {
    jobs.delete('codex-steer');
    _resetForTest();
  }
});

test('Codex app-server mode: a steer the model has not reached yet is reported unconfirmed, not delivered', async () => {
  // Codex injects a steer at the NEXT MODEL BOUNDARY — measured 0.14 s against
  // an in-flight apply_patch and 130 s against a model mid-reasoning. Claiming
  // delivery because the RPC returned is the thing being fixed; the honest
  // answer is `steered: true, steer_confirmed: false` with the reason.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldWindow = process.env.AGENT_COMPANION_CODEX_STEER_CONFIRM_MS;
  // The default window is 5 s of real waiting; this test only needs the timeout
  // to expire, so it buys the same assertion for 20 ms.
  process.env.AGENT_COMPANION_CODEX_STEER_CONFIRM_MS = '20';
  try {
    await withCodexAppServer({
      statuses: { T1: 'active' },
      // Accepted, never announced — the model is still mid-reasoning.
      handlers: { 'turn/steer': (p) => ({ turn: { id: p.expectedTurnId } }) },
    }, async () => {
      _cxLiveJob(jobs, 'codex-steer-slow', 'sid-cx-steer-slow');
      const reply = parse(await dispatch({
        action: 'reply', job_id: 'codex-steer-slow', message: 'actually, use ripgrep', host_session_id: 'sid-cx-steer-slow',
      }));
      assert.equal(reply.ok, true);
      assert.equal(reply.steered, true);
      assert.equal(reply.steer_confirmed, false);
      assert.match(reply.steer_confirmation, /next model boundary/);
      // Not a failure: the job is still running and still the same turn.
      assert.equal(jobs.get('codex-steer-slow').terminalAt, undefined);
      assert.equal(jobs.get('codex-steer-slow').turnId, 'TURN1');
    });
  } finally {
    jobs.delete('codex-steer-slow');
    if (oldWindow === undefined) delete process.env.AGENT_COMPANION_CODEX_STEER_CONFIRM_MS;
    else process.env.AGENT_COMPANION_CODEX_STEER_CONFIRM_MS = oldWindow;
    _resetForTest();
  }
});

test('Codex app-server mode: a reply never steers with a turn resume reports as FINISHED', async () => {
  // One rule for every read of `lastTurn`. `resolveCodexTurnId` and
  // `startCodexTurn` both take it only when it says `inProgress`; the reply path
  // used to pass `resumed.lastTurn?.id` ungated, so an `active` thread whose
  // last RECORDED turn had completed (the window between one turn finishing and
  // the next being recorded) would have steered a dead id — measured on the real
  // server as `-32600 expected active turn id … but found …`. Gated, the adapter
  // goes and reads the live turn instead.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    await withCodexAppServer({
      turns: { T1: [{ id: 'TURN_LIVE', status: 'inProgress' }] },
      handlers: {
        'thread/resume': (p) => ({
          thread: { id: p.threadId, status: { type: 'active' }, turns: [{ id: 'TURN_DEAD', status: 'completed' }] },
        }),
      },
    }, async ({ sockets }) => {
      // No live id: this bridge restarted and never saw `turn/started`.
      _cxLiveJob(jobs, 'codex-stale-steer', 'sid-cx-stale', { turnId: null });
      const reply = parse(await dispatch({
        action: 'reply', job_id: 'codex-stale-steer', message: 'actually, use ripgrep', host_session_id: 'sid-cx-stale',
      }));
      const sock = sockets[sockets.length - 1];
      assert.equal(reply.ok, true);
      assert.equal(reply.steered, true);
      assert.equal(sock.paramsFor('turn/steer')[0].expectedTurnId, 'TURN_LIVE');
      assert.ok(sock.wire().includes('thread/read'), 'the resolver asked the transport rather than trusting a finished turn');
      assert.equal(jobs.get('codex-stale-steer').turnId, 'TURN_LIVE');
    });
  } finally {
    jobs.delete('codex-stale-steer');
    _resetForTest();
  }
});

test('Codex app-server mode: a job that goes terminal DURING the reply RPCs is rejected, not resurrected', async () => {
  // The reply's two round trips (`thread/resume`, then steer or turn/start) are
  // a window the live watcher can settle the job inside. Clearing `terminalAt`
  // afterwards un-settles a result the parent has already been handed and bills
  // a fresh turn for it.
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    await withCodexAppServer({
      handlers: {
        'thread/resume': (p) => {
          // Settle the job mid-call, exactly as the watcher's terminal would.
          mod.retainTerminalJob('codex-race-reply', { status: 'completed', summary: { message: 'done' }, terminalAt: Date.now() });
          return { thread: { id: p.threadId, status: { type: 'idle' } } };
        },
      },
    }, async ({ sockets }) => {
      _cxLiveJob(jobs, 'codex-race-reply', 'sid-cx-race');
      const reply = parse(await dispatch({ action: 'reply', job_id: 'codex-race-reply', message: 'follow up', host_session_id: 'sid-cx-race' }));
      assert.equal(reply.ok, false);
      assert.match(reply.error, /already completed/);
      const job = jobs.get('codex-race-reply');
      assert.ok(job.terminalAt, 'the terminal survived the reply');
      assert.equal(job.status, 'completed');
      assert.equal(job.replyInFlight, false, 'the reply lock was released');
      // No second billed turn was dispatched on the way out.
      assert.equal(sockets.at(-1).wire().includes('turn/start'), false);
      assert.equal(sockets.at(-1).wire().includes('turn/steer'), false);
    });
  } finally {
    jobs.delete('codex-race-reply');
    _resetForTest();
  }
});

test('Codex app-server mode: two replies in the same tick cannot both dispatch a turn', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    await withCodexAppServer({ statuses: { T1: 'idle' } }, async ({ sockets }) => {
      _cxLiveJob(jobs, 'codex-double-reply', 'sid-cx-double');
      // Fired without awaiting the first: the lock has to be taken before the
      // first await or both calls compute replyTurn 1 and the same `-r1`
      // promptId, and neither watcher can supersede the other.
      const [a, b] = (await Promise.all([
        dispatch({ action: 'reply', job_id: 'codex-double-reply', message: 'first', host_session_id: 'sid-cx-double' }),
        dispatch({ action: 'reply', job_id: 'codex-double-reply', message: 'second', host_session_id: 'sid-cx-double' }),
      ])).map(parse);
      const accepted = [a, b].filter((r) => r.ok);
      const refused = [a, b].filter((r) => !r.ok);
      assert.equal(accepted.length, 1, `exactly one reply may win: ${JSON.stringify([a, b])}`);
      assert.match(refused[0].error, /reply already in flight/);
      assert.equal(jobs.get('codex-double-reply').replyTurn, 1);
      const starts = () => sockets.flatMap((s) => s.wire()).filter((m) => m === 'turn/start');
      assert.ok(await _cxUntil(() => starts().length > 0), 'the accepted reply dispatched its turn');
      assert.equal(starts().length, 1, 'one billed turn, not two');
    });
  } finally {
    jobs.delete('codex-double-reply');
    _resetForTest();
  }
});

test('Codex app-server mode: reply on an idle thread starts a fresh guarded turn under a bumped generation', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  try {
    await withCodexAppServer({
      statuses: { T1: 'idle' },
      // A DIFFERENT id for the replacement turn, so "the job's turn id moved on"
      // is observable rather than coincidental.
      handlers: { 'turn/start': () => ({ turn: { id: 'TURN2' } }) },
    }, async ({ sockets }) => {
      _cxLiveJob(jobs, 'codex-idle-reply', 'sid-cx-idle');
      const reply = parse(await dispatch({ action: 'reply', job_id: 'codex-idle-reply', message: 'follow up', host_session_id: 'sid-cx-idle' }));
      assert.equal(reply.ok, true);
      assert.equal(reply.steered, false);
      assert.match(reply.new_prompt_id, /-r1$/);
      assert.equal(jobs.get('codex-idle-reply').promptId, reply.new_prompt_id);
      // THE STALE-ID WINDOW. This branch was taken because TURN1 is over, and
      // the replacement's id arrives a few round trips later — the watch below
      // is deliberately not awaited. So the job must not still be advertising
      // TURN1: an `agent_cancel` in here would send it, and the real server
      // answers `-32600 expected active turn id … but found …` while the new
      // turn keeps running. Null instead makes the resolver read the live turn
      // off `thread/read`.
      assert.notEqual(jobs.get('codex-idle-reply').turnId, 'TURN1', 'the finished turn\'s id is not carried forward');
      const sock = sockets[sockets.length - 1];
      assert.ok(await _cxUntil(() => sock.wire().includes('turn/start')), 'a new turn was started');
      assert.ok(await _cxUntil(() => jobs.get('codex-idle-reply')?.turnId === 'TURN2'), 'the replacement turn\'s id lands on the job');
      // An idle thread has no turn to steer, so this path re-prompts — but it
      // still never interrupts, because there is nothing running to interrupt.
      assert.equal(sock.wire().includes('turn/interrupt'), false);
      sock.notify('turn/completed', { turn: { id: 'TURN2', status: 'completed', items: [{ id: 'm9', type: 'agentMessage', text: 'second turn done', phase: 'final_answer' }] } });
      assert.ok(await _cxUntil(() => jobs.get('codex-idle-reply')?.terminalAt), 'the replacement watch settles the job');
      assert.equal(jobs.get('codex-idle-reply').status, 'completed');
    });
  } finally {
    jobs.delete('codex-idle-reply');
    _resetForTest();
  }
});

test('Codex reply/resume availability is per job, not per target', async () => {
  const mod = await bridge();
  const { buildJobResponse, _resetForTest } = mod;
  _resetForTest();
  await withCodexAppServer({}, async () => {
    const live = buildJobResponse({
      jobId: 'cx-live', target: 'codex', codexAdapter: 'appserver',
      status: 'running', sessionId: 'T1', promptId: 'codex-cx-live', startedAt: Date.now(),
    });
    assert.equal(live.reply_available, true);
    assert.equal(live.resume_available, true);
    // An exec-adapter codex job advertises neither, even while the env says
    // appserver — it started on a transport that has no control channel.
    const exec = buildJobResponse({
      jobId: 'cx-exec', target: 'codex', status: 'running',
      sessionId: 'th-exec', promptId: 'codex-cx-exec', pid: 999, startedAt: Date.now(),
    });
    assert.equal(exec.reply_available, false);
    assert.equal(exec.resume_available, false);
    // …and neither does an app-server job that has not opened its thread yet.
    const starting = buildJobResponse({ jobId: 'cx-pre', target: 'codex', codexAdapter: 'appserver', status: 'starting', startedAt: Date.now() });
    assert.equal(starting.reply_available, false);
    assert.equal(starting.resume_available, false);
  });
  _resetForTest();
});

test('Codex app-server mode: hydrate resumes the job instead of retiring it, and does not clobber its digest', async () => {
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-hydrate';
  try {
    await withCodexAppServer({
      handlers: {
        // The turn finished while this bridge was down; `thread/read` serves it
        // back from the rollout.
        'thread/read': (p) => ({ thread: { id: p.threadId }, turns: [{ items: [
          { id: 'm1', type: 'agentMessage', text: 'finished while the bridge was down', phase: 'final_answer' },
        ] }] }),
      },
    }, async () => {
      _cxLiveJob(jobs, 'codex-hydrate', 'sid-cx-hydrate');
      mod.persistJob('codex-hydrate');
      // A REALISTIC dead-bridge digest: multi-KB, with a marker no render on
      // the resume path can reproduce. A short seed proves nothing here — a
      // full replacement by the salvaged answer would still be "longer than
      // half of it", which is how the clobber survived its first test.
      const digest = digestPath('codex-hydrate');
      writeFileSync(digest, _cxDeadBridgeDigest('codex-hydrate', 'MARKER-HYDRATE-TIER1'));
      jobs.delete('codex-hydrate');
      mod._resetForTest();

      mod.hydrateJobsFromLedger();
      assert.ok(await _cxUntil(() => jobs.get('codex-hydrate')?.terminalAt), 'the resumed job settles');
      const job = jobs.get('codex-hydrate');
      // NOT retired: this is the case that destroyed ~4 minutes of paid work
      // twice in the field report.
      assert.equal(job.status, 'completed');
      assert.notEqual(job.detail, 'target_child_orphaned_by_bridge_restart');
      assert.notEqual(job.detail, 'bridge_transport_closed');
      assert.equal(existsSync(digest.replace('agent-digest-', 'agent-retired-')), false, 'no retirement note was written');
      // The digest gained the salvaged answer AND still holds every byte the
      // dead bridge streamed (the W1.4′ invariant orphan.mjs guards).
      const after = readFileSync(digest, 'utf8');
      assert.match(after, /finished while the bridge was down/);
      assert.match(after, /MARKER-HYDRATE-TIER1/, 'the dead bridge\'s streamed work survived the resume');
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-hydrate') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('a hydrated adapterResult does not latch the carry-forward off for the renders after it', async () => {
  // The other side of W1.4'. Hydrate restores `job.adapterResult` from the
  // ledger, so the FIRST render a new bridge makes can be the previous bridge's
  // own completed answer — which the digest on disk already contains. When the
  // carry memoized that verdict, it latched "nothing to carry" for the whole
  // process, and the next render (the resumed watcher's first delta, whose
  // accumulator is empty) rebuilt the digest from nothing: measured 7,507 bytes
  // to 351, the dead bridge's work gone. The salvaged text is memoized now and
  // the containment test runs per render, so the section comes back the moment
  // the incoming render stops containing it.
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  try {
    const jobId = 'codex-carry-latch';
    // The hydrated result IS the dead bridge's answer, byte for byte — that is
    // what makes containment hold on the first render.
    const answer = Array.from({ length: 60 }, (_, i) => `MARKER-CARRY streamed line ${i} — work the dead bridge already paid for.`).join('\n');
    const digest = digestPath(jobId);
    writeFileSync(digest, _cxDeadBridgeDigest(jobId, 'MARKER-CARRY'));
    const priorBytes = readFileSync(digest, 'utf8').length;

    // A new process that hydrated this job: same digest on disk, and the dead
    // bridge's own result restored onto the record.
    _cxLiveJob(jobs, jobId, 'sid-cx-carry');
    const job = jobs.get(jobId);
    job.adapterResult = { stdout: answer, stderr: '', summary: { message: answer } };

    mod.refreshDigestForJob(job);
    // Nothing carried on this render: the render already says it.
    assert.doesNotMatch(readFileSync(digest, 'utf8'), /Carried forward from the previous bridge/);

    // The resumed watcher's first progress render, accumulator still empty.
    job.adapterResult = { stdout: '', stderr: '', summary: { message: '' } };
    mod.refreshDigestForJob(job);
    const after = readFileSync(digest, 'utf8');
    assert.match(after, /MARKER-CARRY/, "the dead bridge's streamed work survived a render that no longer contains it");
    assert.ok(after.length > priorBytes / 2, `digest collapsed to ${after.length} bytes from ${priorBytes}`);
  } finally {
    jobs.delete('codex-carry-latch');
    _resetForTest();
  }
});

test('Codex app-server mode: resuming a STILL-RUNNING turn streams into the digest without destroying what the dead bridge wrote', async () => {
  // The main incident path: broker alive, turn still active, bridge restarted.
  // The resumed watcher's accumulator starts EMPTY, so every progress refresh
  // renders a body far smaller than the one already on disk. That render is a
  // full replacement, which is exactly how a multi-KB digest became a stub.
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-active';
  try {
    await withCodexAppServer({ statuses: { T1: 'active' } }, async ({ sockets }) => {
      _cxLiveJob(jobs, 'codex-active', 'sid-cx-active');
      mod.persistJob('codex-active');
      const digest = digestPath('codex-active');
      writeFileSync(digest, _cxDeadBridgeDigest('codex-active', 'MARKER-ACTIVE-TURN'));
      const before = readFileSync(digest, 'utf8').length;
      jobs.delete('codex-active');
      mod._resetForTest();

      mod.hydrateJobsFromLedger();
      assert.ok(await _cxUntil(() => sockets.length > 0 && sockets.at(-1).wire().includes('broker/subscribe')), 'the resumed watcher subscribed');
      const sock = sockets.at(-1);

      // A mid-turn delta — the first progress refresh this bridge makes.
      sock.notify('item/agentMessage/delta', { itemId: 'm2', delta: 'tail of the answer' });
      assert.ok(await _cxUntil(() => readFileSync(digest, 'utf8').includes('tail of the answer')), 'streaming reached the digest');
      const mid = readFileSync(digest, 'utf8');
      assert.match(mid, /MARKER-ACTIVE-TURN/, 'the dead bridge\'s body survived the streaming refresh');
      assert.ok(mid.length >= before, `digest shrank mid-flight: ${before} -> ${mid.length}`);

      // …and it is still there once the resumed turn settles.
      sock.notify('turn/completed', { turn: { id: 'TURN1', status: 'completed', items: [
        { id: 'm2', type: 'agentMessage', text: 'tail of the answer', phase: 'final_answer' },
      ] } });
      assert.ok(await _cxUntil(() => jobs.get('codex-active')?.terminalAt), 'the resumed turn settles');
      assert.equal(jobs.get('codex-active').status, 'completed');
      const after = readFileSync(digest, 'utf8');
      assert.match(after, /MARKER-ACTIVE-TURN/, 'the dead bridge\'s body survived the terminal render');
      assert.match(after, /tail of the answer/);
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-active') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('Codex app-server mode: hydrate with a DEAD broker resumes from the rollout and reports a lost turn, not a lost thread', async () => {
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-dead';
  // The first two connects are the resume probe and ensureCodexBroker's own
  // probe — both find nothing listening. The spawn then brings a broker up and
  // every later connect succeeds, which is the measured tier-2 shape: the
  // rollout survives the broker.
  let refusals = 2;
  try {
    await withCodexAppServer({
      connect: async ({ newSocket }) => {
        if (refusals-- > 0) { const err = new Error('connect ECONNREFUSED'); err.code = 'ECONNREFUSED'; throw err; }
        return newSocket();
      },
      spawnBroker: () => ({ on: () => {}, unref: () => {} }),
      handlers: {
        'thread/read': (p) => ({ thread: { id: p.threadId }, turns: [{ items: [
          { id: 'm1', type: 'agentMessage', text: 'partial work before the broker died', phase: 'commentary' },
        ] }] }),
      },
    }, async () => {
      _cxLiveJob(jobs, 'codex-dead-broker', 'sid-cx-dead');
      mod.persistJob('codex-dead-broker');
      // Salvage is a `thread/read` summary — messages only, no reasoning and no
      // tool calls — so it is routinely SHORTER than what the dead bridge had
      // already streamed. Writing it over the body is still destruction.
      const digest = digestPath('codex-dead-broker');
      writeFileSync(digest, _cxDeadBridgeDigest('codex-dead-broker', 'MARKER-TIER2-SALVAGE'));
      jobs.delete('codex-dead-broker');
      mod._resetForTest();

      mod.hydrateJobsFromLedger();
      assert.ok(await _cxUntil(() => jobs.get('codex-dead-broker')?.terminalAt), 'the resumed job settles');
      const job = jobs.get('codex-dead-broker');
      assert.equal(job.status, 'unreachable');
      assert.equal(job.detail, 'codex_server_gone');
      // The salvage is real and the message must not claim the thread is gone —
      // `thread_not_resumable` here would report the very case this transport
      // was chosen for as lost work.
      assert.match(job.summary.message, /partial work before the broker died/);
      assert.match(job.error, /in-flight turn was lost/);
      assert.match(job.error, /lost turn, not a lost thread/);
      assert.equal(/thread_not_resumable/.test(job.error), false);
      const after = readFileSync(digest, 'utf8');
      assert.match(after, /partial work before the broker died/, 'the salvage reached the digest');
      assert.match(after, /MARKER-TIER2-SALVAGE/, 'the salvage did not overwrite the dead bridge\'s body');
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-dead') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('Codex app-server mode: a resume that salvages nothing leaves the dead bridge\'s digest alone', async () => {
  const mod = await bridge();
  const { jobs, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cx-nosalvage';
  let refusals = 2;
  try {
    await withCodexAppServer({
      connect: async ({ newSocket }) => {
        if (refusals-- > 0) { const err = new Error('connect ECONNREFUSED'); err.code = 'ECONNREFUSED'; throw err; }
        return newSocket();
      },
      spawnBroker: () => ({ on: () => {}, unref: () => {} }),
      // The rollout has no assistant message yet — the turn died in reasoning.
    }, async () => {
      await withQueue(async (queueFile) => {
        _cxLiveJob(jobs, 'codex-nosalvage', 'sid-cx-nosalvage');
        mod.persistJob('codex-nosalvage');
        const digest = digestPath('codex-nosalvage');
        writeFileSync(digest, _cxDeadBridgeDigest('codex-nosalvage', 'MARKER-NO-SALVAGE'));
        jobs.delete('codex-nosalvage');
        mod._resetForTest();

        mod.hydrateJobsFromLedger();
        assert.ok(await _cxUntil(() => jobs.get('codex-nosalvage')?.terminalAt), 'the resumed job settles');
        assert.equal(jobs.get('codex-nosalvage').status, 'unreachable');
        // W1.4\u2032's hard constraint: an empty result must never render a
        // header-only stub over content that is the only record of the work.
        assert.match(readFileSync(digest, 'utf8'), /MARKER-NO-SALVAGE/);
        // The outcome is still recorded on disk \u2014 in the sibling note, never in
        // the body.
        const note = digest.replace('agent-digest-', 'agent-retired-');
        assert.equal(existsSync(note), true);
        assert.match(readFileSync(note, 'utf8'), /codex_server_gone/);
        assert.match(readFileSync(note, 'utf8'), /lost turn, not a lost thread/);
        // \u2026and the terminal reaches the completion queue on THIS branch too. A
        // parent that drains instead of blocking would otherwise never hear
        // that the job settled, purely because the rollout happened to be empty.
        assert.ok(await _cxUntil(() => existsSync(queueFile) && readQueue(queueFile).some((r) => r.jobId === 'codex-nosalvage' && r.kind === 'terminal')),
          'the no-salvage resume enqueued its terminal');
      });
    });
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cx-nosalvage') { try { state.deleteJob(id); } catch {} jobs.delete(id); }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('applyAdapterCapabilities flips codex only under the app-server adapter', async () => {
  const registry = await import('../lib/target-registry.mjs');
  const cx = await import('./codex-app-server-runtime.mjs');
  const exec = registry.getTargetById('codex', { CODEX_RUNTIME_ADAPTER: 'exec' });
  assert.equal(exec.capabilities.reply, false);
  assert.equal(exec.capabilities.resume, false);
  assert.equal(exec.capabilities.serverMode, false);
  assert.equal(exec.adapter, undefined);
  const appserver = registry.getTargetById('codex', { CODEX_RUNTIME_ADAPTER: 'appserver' });
  assert.equal(appserver.capabilities.reply, true);
  assert.equal(appserver.capabilities.resume, true);
  assert.equal(appserver.capabilities.serverMode, true);
  assert.equal(appserver.adapter, 'appserver');
  // Unset and unrecognised both stay on the shipped default.
  assert.equal(registry.getTargetById('codex', {}).capabilities.reply, false);
  assert.equal(registry.getTargetById('codex', { CODEX_RUNTIME_ADAPTER: 'server' }).capabilities.reply, false);
  // Selecting codex must not touch opencode, and vice versa.
  assert.equal(registry.getTargetById('opencode', { CODEX_RUNTIME_ADAPTER: 'appserver' }).capabilities.reply, false);
  assert.equal(registry.getTargetById('codex', { OPENCODE_RUNTIME_ADAPTER: 'server' }).capabilities.reply, false);
  // The descriptor's local predicate and the adapter's own resolver must agree
  // about the spelling — two parsers that disagree would advertise a capability
  // the transport does not have.
  for (const env of [{}, { CODEX_RUNTIME_ADAPTER: 'appserver' }, { CODEX_RUNTIME_ADAPTER: 'APPSERVER' }, { CODEX_RUNTIME_ADAPTER: 'exec' }, { CODEX_RUNTIME_ADAPTER: 'nonsense' }]) {
    assert.equal(registry.codexAppServerAdapterSelected(env), cx.codexAppServerActive(env), JSON.stringify(env));
  }
});

test('agent_status merges the codex app-server block, with pinned-vs-installed version skew', async () => {
  const mod = await bridge();
  const { dispatch, _resetForTest } = mod;
  _resetForTest();
  await withCodexAppServer({}, async () => {
    const status = parse(await dispatch({ action: 'status', host_session_id: 'sid-cx-status' }));
    const rt = status.codex_runtime;
    assert.equal(rt.adapter, 'appserver');
    assert.equal(rt.approvalPolicy, 'never');
    assert.ok(rt.socket.endsWith('.sock'));
    assert.ok(rt.pinned_version);
    assert.ok(rt.broker_registry !== undefined, 'the shared-broker registry entry is reported');
    // No broker has spoken to this process yet, so skew is unknown — which is
    // not the same as "no skew". There is no protocol version field on this
    // transport, so this is the only drift warning there is.
    assert.equal(rt.version_skew, null);
    // The exec knobs are still there: the app-server block merges onto them.
    assert.ok(rt.timeout_ms > 0);
    assert.ok(rt.bin);
    const codex = status.targets.find((t) => t.id === 'codex');
    assert.equal(codex.capabilities.reply, true);
    assert.equal(codex.capabilities.resume, true);
  });
  _resetForTest();
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
    assert.match(body.content, /timed-out GitHub Copilot CLI session was retired/);
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
    target: 'copilot',
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

test('handleReply preserves fleet on the reply terminal notification (regression)', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-reply-fleet';
  await withQueue(async (queueFile) => {
    jobs.set('copilot-reply-fleet', {
      jobId: 'copilot-reply-fleet',
      target: 'copilot',
      reqId: 'req-reply-fleet',
      claudeSessionId: 'sid-reply-fleet',
      thread: 'thread-reply-fleet',
      task: 'original task',
      mode: 'EXECUTE',
      template: 'general',
      parallel: 'always',
      fleet: true,
      status: 'running',
      promptId: 'prompt-old',
      sessionId: 'session-reply-fleet',
      startedAt: Date.now() - 1000,
      inspectAvailable: true,
    });
    try {
      await withDaemonStubs(
        {
          sendToSocket: async (msg) => {
            if (msg.command === 'reply') {
              return { ok: true, data: { ok: true, original_prompt_id: 'prompt-old', new_prompt_id: 'prompt-new', session_id: 'session-reply-fleet' } };
            }
            if (msg.command === 'watch') {
              return { ok: true, data: { promptId: 'prompt-new', sessionId: 'session-reply-fleet', status: 'completed', summary: { message: 'done\n\nRUBBER-DUCK: clean.' } } };
            }
            return { ok: true, data: {} };
          },
        },
        async () => parse(await dispatch({ action: 'reply', job_id: 'copilot-reply-fleet', message: 'go', host_session_id: 'sid-reply-fleet' })),
      );
      // The watch loop emits the terminal event asynchronously; poll the queue.
      let terminal = null;
      for (let i = 0; i < 50 && !terminal; i++) {
        await new Promise((r) => setImmediate(r));
        const rows = existsSync(queueFile) ? readQueue(queueFile) : [];
        terminal = rows.find((row) => row.jobId === 'copilot-reply-fleet' && row.kind === 'terminal');
      }
      assert.ok(terminal, 'terminal event was enqueued for the fleet reply job');
      assert.equal(terminal.meta.fleet, 'true', 'fleet is preserved on the reply terminal notification');
    } finally {
      jobs.delete('copilot-reply-fleet');
      _resetForTest();
      if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    }
  });
});

// ---- TRACK: codex-adapter ----
//
// W1.1 at the worker seam: runSingleShotCliWorker must bank the codex thread
// id the moment `thread.started` arrives, not when the run resolves. Same
// fakeBin discipline as the codex adapter tests above — CODEX_BIN never points
// at a real binary.
test('a codex job persists its thread id while still running, not only at terminal', async () => {
  const mod = await bridge();
  const { dispatch, jobs, _resetForTest } = mod;
  _resetForTest();

  const tmp = mkdtempSync(join(tmpdir(), 'codex-early-sid-'));
  const fakeBin = join(tmp, 'codex-fake.mjs');
  writeFileSync(fakeBin, [
    '#!/usr/bin/env node',
    'process.stdin.on("data", () => {});',
    'process.stdin.on("end", () => {',
    // Line 1 of the stream, exactly as measured on 0.147.0 — then the child
    // holds the turn open, which is the whole point: the id has to be usable
    // long before any terminal result exists.
    '  console.log(JSON.stringify({ type: "thread.started", thread_id: "th-early-capture" }));',
    '});',
    'process.on("SIGTERM", () => process.exit(0));',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(fakeBin, 0o700);

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const oldBin = process.env.CODEX_BIN;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-codex-early';
  process.env.CODEX_BIN = fakeBin;

  try {
    const send = parse(await dispatch({
      action: 'send',
      target: 'codex',
      task: 'capture the thread id early',
      mode: 'EXECUTE',
      template: 'general',
      cwd: TEST_CWD,
      host_session_id: 'sid-codex-early',
      max_wait_sec: 1,
      parallel: 'never',
    }));
    assert.equal(send.status, 'still_running');

    let captured = null;
    for (let i = 0; i < 300 && !captured; i++) {
      await new Promise((r) => setTimeout(r, 10));
      captured = jobs.get(send.job_id)?.sessionId || null;
    }
    assert.equal(captured, 'th-early-capture');
    assert.equal(jobs.get(send.job_id)?.status, 'running', 'the id landed while the job was still running');

    // On disk too — that is what makes it survive the bridge dying mid-run.
    const state = await import('../lib/state.mjs');
    assert.equal(state.readJob(send.job_id).companionSessionId, 'th-early-capture');

    const cancelled = parse(await dispatch({
      action: 'cancel',
      job_id: send.job_id,
      host_session_id: 'sid-codex-early',
    }));
    assert.equal(cancelled.ok, true);
    // The terminal patch must not walk the id back: it reads
    // `result.sessionId ?? jobs.get(jobId)?.sessionId ?? null`, so a run that
    // resolves without one (the child.on('error') path resolves
    // `sessionId: null` by construction) keeps what onSession already banked.
    assert.equal(jobs.get(send.job_id)?.sessionId, 'th-early-capture');
    assert.equal(state.readJob(send.job_id).companionSessionId, 'th-early-capture');
  } finally {
    for (const id of [...jobs.keys()]) {
      if (jobs.get(id)?.claudeSessionId === 'sid-codex-early') jobs.delete(id);
    }
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    if (oldBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = oldBin;
    rmSync(tmp, { recursive: true, force: true });
    _resetForTest();
  }
});

// ---- TRACK: hydrate-guard ----
// W1.4′: hydrate must neither mislabel nor overwrite a job it did not start.
// A fresh bridge used to retire every non-terminal, non-copilot ledger row on
// sight and then rewrite its digest from `adapterResult || null` — which is
// null by construction in a fresh process. In the field incident that declared
// two jobs dead 56.1s and 4.1s before their children actually died and shrank a
// live 11,754-byte digest to 228 bytes.

// A long-lived fake companion binary, built the way codex-runtime.test.mjs
// builds its fakes (a node script, never a real `sleep`), spawned so the test
// owns a pid that is unambiguously alive — no PID-reuse exposure, because the
// pid belongs to a child this process holds open for the duration.
async function withLiveFakeChild(body) {
  const { spawn } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'hydrate-guard-bin-'));
  const bin = join(dir, 'codex-fake.mjs');
  writeFileSync(bin, ['#!/usr/bin/env node', 'setInterval(() => {}, 1 << 30);', ''].join('\n'), { mode: 0o700 });
  chmodSync(bin, 0o700);
  const child = spawn(process.execPath, [bin], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  try { return await body(child); }
  finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('hydrate retires an orphaned CLI job honestly and never rewrites a digest it did not write', async () => {
  const mod = await bridge();
  const { jobs, hydrateJobsFromLedger, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');
  const { pidAlive } = await import('../lib/shared-runtime-registry.mjs');

  await withLiveFakeChild(async (child) => {
    const oldS = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sid-hydrate-guard';
    const digest = digestPath('j-orphan-live');
    // Stand in for the live digest the previous bridge had already written.
    const digestBody = ['# codex job j-orphan-live - digest', '', 'x'.repeat(11_754), ''].join('\n');
    writeFileSync(digest, digestBody);
    const retiredNote = digest.replace(/agent-digest-([^/]+)\.md$/, 'agent-retired-$1.md');
    try {
      _resetForTest();
      jobs.clear();
      state.writeJob('j-orphan-live', {
        jobId: 'j-orphan-live', claudeSessionId: 'sid-hydrate-guard',
        target: 'codex', status: 'running', task: 'long codex turn', mode: 'EXECUTE',
        pid: child.pid, companionSessionId: 'thread-uuid-1',
        startedAt: Date.now() - 60_000,
      });

      // Probe injected (delegating to the real rule) so the assertion is about
      // the guard, not about the scheduler: CI never depends on an unowned pid.
      const probed = [];
      hydrateJobsFromLedger({ pidAlive: (pid) => { probed.push(pid); return pidAlive(pid); } });

      const job = jobs.get('j-orphan-live');
      // (i) not silently mislabelled: the recorded child pid was actually
      // probed, and the verdict names the bridge restart rather than the adapter.
      assert.deepEqual(probed, [child.pid]);
      assert.equal(job.status, 'unreachable');
      assert.equal(job.childPidAlive, true);
      assert.match(job.error, /still running/);
      assert.match(job.error, /orphaned/);
      // (ii) the honest detail, and specifically NOT the blanket adapter verdict.
      assert.equal(job.detail, 'target_child_orphaned_by_bridge_restart');
      assert.notEqual(job.detail, 'target_adapter_non_resumable_after_restart');
      // Salvage pointers, since the digest holds ~0.2% of an aborted turn.
      assert.match(job.error, /thread-uuid-1/);
      assert.ok(job.error.includes(digest), 'the digest path is named as a salvage pointer');
      // (iii) hard constraint: byte-identical digest. The retirement is
      // recorded in a sibling file, never inside the body.
      assert.equal(readFileSync(digest, 'utf8'), digestBody);
      assert.equal(job.retiredNote, retiredNote);
      assert.equal(existsSync(retiredNote), true);
      const note = readFileSync(retiredNote, 'utf8');
      assert.match(note, /target_child_orphaned_by_bridge_restart/);
      assert.match(note, new RegExp(`Child pid:\\*\\* ${child.pid} \\(still alive`));
      // The note must stay OUT of the digest-resource namespace: named
      // `<digest>-retired.md` it would match DIGEST_RESOURCE_FILE_RE and
      // publish a phantom `agent-digest://j-orphan-live-retired` resource
      // describing a job that never existed.
      const uris = mod.listDigestResources().map((r) => r.uri);
      assert.deepEqual(uris.filter((u) => u.includes('j-orphan-live')), ['agent-digest://j-orphan-live']);
    } finally {
      state.deleteJob('j-orphan-live');
      rmSync(digest, { force: true });
      rmSync(retiredNote, { force: true });
      jobs.clear();
      if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = oldS;
      _resetForTest();
    }
  });
});

test('hydrate reports a dead child as a closed bridge transport, still without touching the digest', async () => {
  const mod = await bridge();
  const { jobs, hydrateJobsFromLedger, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-hydrate-guard-dead';
  const digest = digestPath('j-orphan-dead');
  const digestBody = '# codex job j-orphan-dead - digest\n\npartial work\n';
  writeFileSync(digest, digestBody);
  try {
    _resetForTest();
    jobs.clear();
    state.writeJob('j-orphan-dead', {
      jobId: 'j-orphan-dead', claudeSessionId: 'sid-hydrate-guard-dead',
      target: 'codex', status: 'running', task: 't', mode: 'EXECUTE',
      pid: 424242, startedAt: Date.now() - 60_000,
    });
    // Injected false rather than a real reaped pid: asserting "this pid is
    // dead" against the OS is exactly the PID-reuse race CI must not run.
    hydrateJobsFromLedger({ pidAlive: () => false });

    const job = jobs.get('j-orphan-dead');
    assert.equal(job.status, 'unreachable');
    assert.equal(job.detail, 'bridge_transport_closed');
    assert.equal(job.childPidAlive, false);
    assert.match(job.error, /died with the bridge process/);
    assert.equal(readFileSync(digest, 'utf8'), digestBody);
  } finally {
    state.deleteJob('j-orphan-dead');
    rmSync(digest, { force: true });
    rmSync(digest.replace(/agent-digest-([^/]+)\.md$/, 'agent-retired-$1.md'), { force: true });
    jobs.clear();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

test('hydrate never believes a ledger pid that has been reused by this bridge process', async () => {
  const mod = await bridge();
  const { jobs, hydrateJobsFromLedger, _resetForTest } = mod;
  const state = await import('../lib/state.mjs');
  const { digestPath } = await import('../lib/prompt-digest.mjs');

  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-hydrate-guard-self';
  try {
    _resetForTest();
    jobs.clear();
    state.writeJob('j-orphan-self', {
      jobId: 'j-orphan-self', claudeSessionId: 'sid-hydrate-guard-self',
      target: 'codex', status: 'running', task: 't', mode: 'EXECUTE',
      pid: process.pid, startedAt: Date.now() - 60_000,
    });
    // The probe would say "alive" (it is us), but a fresh bridge cannot have
    // started this job's child, so the pid must not be believed — and the
    // probe must not even be consulted.
    let probes = 0;
    hydrateJobsFromLedger({ pidAlive: () => { probes++; return true; } });

    const job = jobs.get('j-orphan-self');
    assert.equal(probes, 0);
    assert.equal(job.childPidAlive, false);
    assert.equal(job.detail, 'bridge_transport_closed');
  } finally {
    state.deleteJob('j-orphan-self');
    rmSync(digestPath('j-orphan-self').replace(/agent-digest-([^/]+)\.md$/, 'agent-retired-$1.md'), { force: true });
    jobs.clear();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    _resetForTest();
  }
});

// ---- TRACK: failure-classifier ----------------------------------------------
// W1.3′: `unreachable` is rendered by FAILURE CLASS, not by target. The bug the
// class split exists to kill is that a bridge-lifecycle event (this process
// restarted under a live job) inherited `verify CODEX_BIN…` from the target
// descriptor and told the operator to go check a binary that was never involved.

test('classifyUnreachable keys on failure class, not on which target produced the failure', async () => {
  const { classifyUnreachable } = await bridge();

  // bridge_lifecycle — the bridge lost ownership of its own job. Target-agnostic.
  for (const detail of [
    'target_adapter_non_resumable_after_restart',
    'sdk_adapter_non_resumable_after_restart',
    'rehydrate_no_promptid',
    'target_child_orphaned_by_bridge_restart',
    'bridge_transport_closed',
  ]) {
    for (const target of ['codex', 'copilot', 'opencode']) {
      assert.equal(classifyUnreachable(detail, target), 'bridge_lifecycle', `${detail} @ ${target}`);
    }
  }

  // runtime_unavailable — the binary is genuinely the suspect.
  assert.equal(classifyUnreachable('bridge_daemon_unreachable', 'copilot'), 'runtime_unavailable');
  assert.equal(classifyUnreachable(null, 'codex', 'spawn codex ENOENT'), 'runtime_unavailable');
  assert.equal(classifyUnreachable(null, 'codex', 'codex exited with code 127'), 'runtime_unavailable');
  assert.equal(classifyUnreachable(null, 'opencode', '/bin/sh: opencode: command not found'), 'runtime_unavailable');

  // runtime_transport — socket/stream flap; the runtime itself may be healthy.
  assert.equal(classifyUnreachable('bridge_timeout', 'copilot'), 'runtime_transport');
  assert.equal(classifyUnreachable('opencode_server_gone', 'opencode'), 'runtime_transport');
  assert.equal(classifyUnreachable('opencode_server_unreachable', 'opencode'), 'runtime_transport');
  assert.equal(classifyUnreachable(null, 'copilot', 'write EPIPE'), 'runtime_transport');
  assert.equal(classifyUnreachable(null, 'copilot', 'socket hang up'), 'runtime_transport');

  // The target prefix is stripped, so the same condition classifies identically
  // whichever companion emitted it — and a target that does NOT own the prefix
  // leaves the detail alone rather than mis-stripping it.
  assert.equal(classifyUnreachable('codex_server_gone', 'codex'), 'runtime_transport');
  assert.equal(classifyUnreachable('opencode_server_gone', 'codex'), 'unknown');

  // thread_not_resumable — codex's resume rejection, keyed on the signature.
  assert.equal(
    classifyUnreachable(null, 'codex', 'ERROR: JSON-RPC error -32600: no rollout found for thread id 0199a1'),
    'thread_not_resumable',
  );
  assert.equal(classifyUnreachable(null, 'codex', 'no rollout found for thread id 0199a1'), 'thread_not_resumable');
  assert.equal(classifyUnreachable('thread_not_resumable', 'codex'), 'thread_not_resumable');
  // A larger number that merely contains 32600 must not trip the signature.
  assert.equal(classifyUnreachable(null, 'codex', 'processed 132600 tokens'), 'unknown');

  // unknown — honest fallback, never a guessed cause.
  assert.equal(classifyUnreachable('codex_worker_error', 'codex', 'boom'), 'unknown');
  assert.equal(classifyUnreachable(null, 'codex', ''), 'unknown');
  assert.equal(classifyUnreachable(undefined, undefined, undefined), 'unknown');
});

// On the `codex app-server` transport EVERY error is JSON-RPC -32600 and only the
// message distinguishes them, so the code itself carries no information. A
// classifier keying on the code would tell an operator whose *steer* failed that
// their live thread is unrecoverable — the misdiagnosis in a new costume.
test('the app-server -32600 family classifies on message text, never on the code', async () => {
  const { classifyUnreachable } = await bridge();

  // Genuinely gone → thread_not_resumable.
  assert.equal(
    classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: no rollout found for thread id 0199a1'),
    'thread_not_resumable',
  );
  // `thread not loaded` is thread/read's wording for the same condition: this
  // app-server has no readable rollout for that id.
  assert.equal(
    classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: thread not loaded: 0199a1'),
    'thread_not_resumable',
  );

  // Alive, and must NOT be called unrecoverable.
  //
  // `thread not found` is the regression this arm exists for: measured in
  // probes/codex-app-server/unloaded.mjs, a thread with a completed turn whose
  // app-server was SIGKILLed answers a FRESH app-server `thread not found` to
  // turn/interrupt and turn/steer — while thread/resume on that same id succeeds
  // with status idle. Calling it unrecoverable would report a broker restart, the
  // case the whole app-server transport was chosen for, as lost work.
  assert.equal(
    classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: thread not found: 0199a1'),
    'unknown',
  );
  assert.equal(
    classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: no active turn to steer'),
    'unknown',
  );
  assert.equal(
    classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: no active turn to interrupt'),
    'unknown',
  );

  // The exec transport's resume rejection is unaffected by dropping the code arm:
  // it carries the human reason alongside -32600, on stderr with an empty stdout.
  assert.equal(
    classifyUnreachable(null, 'codex', 'ERROR: -32600 no rollout found for thread id 0199a1'),
    'thread_not_resumable',
  );

  // And a -32600 with no recognised reason at all stays honest rather than
  // inheriting the resume class from its neighbours.
  assert.equal(classifyUnreachable(null, 'codex', 'JSON-RPC error -32600: Invalid Request'), 'unknown');

  // A set detail still outranks all of it: a steer that failed while the bridge
  // was losing ownership is a lifecycle event, whatever the RPC said.
  assert.equal(
    classifyUnreachable('bridge_transport_closed', 'codex', 'JSON-RPC error -32600: no active turn to steer'),
    'bridge_lifecycle',
  );
});

test('bridge_lifecycle rendering never names the target binary env and points at the digest', async () => {
  const { formatTerminalContent } = await bridge();

  for (const detail of [
    'target_adapter_non_resumable_after_restart',
    'rehydrate_no_promptid',
    'target_child_orphaned_by_bridge_restart',
    'bridge_transport_closed',
  ]) {
    const content = formatTerminalContent({
      jobId: 'jf-life', status: 'unreachable', task: 'delegate something',
      detail, target: 'codex', digestUri: 'agent-digest://jf-life',
    });
    // The regression this whole item exists to kill.
    assert.doesNotMatch(content, /CODEX_BIN/, `${detail} must not name binaryEnv`);
    assert.doesNotMatch(content, /is available/, `${detail} must not tell the operator to verify a CLI`);
    assert.match(content, /\*\*Failure class:\*\* `bridge_lifecycle`/);
    assert.match(content, /lost ownership/);
    // Causally neutral: the bridge says it cannot tell, rather than picking one.
    assert.match(content, /cannot tell which of several outcomes/);
    assert.match(content, /agent-digest:\/\/jf-life/);
  }

  // The SDK detail keeps its specific cause line inside the shared class body.
  const sdk = formatTerminalContent({
    jobId: 'jf-sdk', status: 'unreachable', task: 't',
    detail: 'sdk_adapter_non_resumable_after_restart', target: 'copilot',
  });
  assert.match(sdk, /SDK adapter cannot reattach/);
  assert.match(sdk, /\*\*Failure class:\*\* `bridge_lifecycle`/);

  // With no digestUri the pointer degrades to the runtime dir rather than vanishing.
  const noDigest = formatTerminalContent({
    jobId: 'jf-nod', status: 'unreachable', task: 't',
    detail: 'rehydrate_no_promptid', target: 'codex',
  });
  assert.match(noDigest, /digest\/logs under/);
});

test('runtime_unavailable is the only unreachable class that names descriptor.binaryEnv', async () => {
  const { formatTerminalContent } = await bridge();

  const unavailable = formatTerminalContent({
    jobId: 'jf-una', status: 'unreachable', task: 't', target: 'codex',
    error: 'spawn codex ENOENT',
  });
  assert.match(unavailable, /\*\*Failure class:\*\* `runtime_unavailable`/);
  assert.match(unavailable, /verify `CODEX_BIN` or the `codex` CLI is available/);
  // Today's lead sentence is deliberately preserved for this class.
  assert.match(unavailable, /Bridge could not reach the Codex CLI runtime/);

  // Every other class must stay clear of the binary hint.
  const others = [
    formatTerminalContent({ jobId: 'a', status: 'unreachable', task: 't', target: 'codex', detail: 'bridge_timeout' }),
    formatTerminalContent({ jobId: 'b', status: 'unreachable', task: 't', target: 'codex', detail: 'thread_not_resumable' }),
    formatTerminalContent({ jobId: 'c', status: 'unreachable', task: 't', target: 'codex', detail: 'codex_worker_error' }),
  ];
  for (const content of others) assert.doesNotMatch(content, /CODEX_BIN/);

  assert.match(others[0], /\*\*Failure class:\*\* `runtime_transport`/);
  assert.match(others[0], /transport to the Codex CLI runtime failed mid-job/);
  assert.match(others[1], /\*\*Failure class:\*\* `thread_not_resumable`/);
  assert.match(others[1], /could not be resumed/);
  assert.match(others[2], /\*\*Failure class:\*\* `unknown`/);
  assert.match(others[2], /will not guess a cause/);
});

test('failure content inlines BOTH captured channels, since either one can be empty', async () => {
  const mod = await bridge();
  const { formatTerminalContent } = mod;

  // Measured on codex 0.147.0: a bad `-m` exits 1 with an EMPTY stderr and the
  // whole error on stdout. stderr-only rendering would show the operator nothing.
  const badModel = formatTerminalContent({
    jobId: 'jf-model', status: 'failed', task: 't', target: 'codex',
    error: 'codex exited with code 1',
    adapterResult: { stdout: '{"type":"error","status":400}', stderr: '' },
  });
  assert.match(badModel, /\*\*stdout \(tail\):\*\*/);
  assert.doesNotMatch(badModel, /\*\*stderr \(tail\):\*\*/, 'an empty channel renders as nothing');

  // The mirror image: a bogus resume gives an EMPTY stdout with everything on stderr.
  const badResume = formatTerminalContent({
    jobId: 'jf-resume', status: 'unreachable', task: 't', target: 'codex',
    adapterResult: { stdout: '', stderr: 'ERROR: -32600 no rollout found for thread id 0199a1' },
  });
  assert.match(badResume, /\*\*Failure class:\*\* `thread_not_resumable`/);
  assert.match(badResume, /\*\*stderr \(tail\):\*\*/);
  assert.match(badResume, /no rollout found for thread id/);
  assert.doesNotMatch(badResume, /\*\*stdout \(tail\):\*\*/);

  // Both present, both rendered.
  const both = formatTerminalContent({
    jobId: 'jf-both', status: 'failed', task: 't', target: 'codex',
    error: 'boom', stdout: 'OUT-MARKER', stderr: 'ERR-MARKER',
  });
  assert.match(both, /OUT-MARKER/);
  assert.match(both, /ERR-MARKER/);

  // Long channels are tail-truncated (the tail carries the failure), not dropped.
  const long = formatTerminalContent({
    jobId: 'jf-long', status: 'failed', task: 't', target: 'codex',
    error: 'boom', stdout: `${'x'.repeat(5000)}LAST-LINE`, stderr: '',
  });
  assert.match(long, /LAST-LINE/);
  assert.match(long, /…/);
  assert.ok(long.length < 2500, `channel excerpt stays bounded (was ${long.length})`);

  // The wait path spreads the whole job, so adapterResult arrives for free.
  mod.jobs.set('jf-wait', terminalJob('jf-wait', 'unreachable', {
    target: 'codex', detail: 'codex_worker_error',
    adapterResult: { stdout: 'STDOUT-VIA-JOB', stderr: 'STDERR-VIA-JOB' },
  }));
  const body = parse(await mod.dispatch({ action: 'wait', job_id: 'jf-wait', max_wait_sec: 1 }));
  assert.equal(body.status, 'unreachable');
  assert.match(body.content, /STDOUT-VIA-JOB/);
  assert.match(body.content, /STDERR-VIA-JOB/);
  mod.jobs.delete('jf-wait');
});

test('unwrapErrorMessage peels exactly one JSON level and never throws on anything else', async () => {
  const { unwrapErrorMessage, formatTerminalContent } = await bridge();

  // The measured shape: a JSON-encoded string carrying an API error envelope.
  assert.equal(
    unwrapErrorMessage('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"unknown model: gpt-9"}}'),
    'unknown model: gpt-9',
  );
  // A top-level message with no nested `error` object.
  assert.equal(unwrapErrorMessage('{"message":"flat message"}'), 'flat message');
  // Non-JSON, malformed JSON, and JSON without a message all pass through verbatim.
  assert.equal(unwrapErrorMessage('codex exited with code 1'), 'codex exited with code 1');
  assert.equal(unwrapErrorMessage('{not json at all'), '{not json at all');
  assert.equal(unwrapErrorMessage('{"status":500}'), '{"status":500}');
  assert.equal(unwrapErrorMessage('{"error":{"code":"x"}}'), '{"error":{"code":"x"}}');
  // Exactly ONE level: a doubly-encoded payload keeps its inner encoding.
  assert.equal(unwrapErrorMessage('{"error":{"message":"{\\"message\\":\\"inner\\"}"}}'), '{"message":"inner"}');
  // Degenerate inputs.
  assert.equal(unwrapErrorMessage(null), '');
  assert.equal(unwrapErrorMessage(undefined), '');
  assert.equal(unwrapErrorMessage(42), '42');

  // And it is actually wired into the operator-facing failed body.
  const content = formatTerminalContent({
    jobId: 'jf-unwrap', status: 'failed', task: 't', target: 'codex',
    error: '{"type":"error","status":400,"error":{"message":"unsupported model"}}',
  });
  assert.match(content, /job failed: unsupported model/);
  assert.doesNotMatch(content, /invalid_request_error|"type"/);
});

test('send error envelopes omit an empty candidates list instead of shipping `[]`', async () => {
  const { dispatch } = await bridge();
  await withEnv('CLAUDE_CODE_SESSION_ID', 'sid-candidates', async () => {
    // No profiles are configured in the sandbox, so publicIds() is `[]` — which
    // is truthy, and used to ship as `candidates: []`, indistinguishable from a
    // deliberately withheld list.
    const body = parse(await dispatch({
      action: 'send', task: 'x', mode: 'ANALYZE', profile: 'no-such-profile',
      host_session_id: 'sid-candidates',
    }));
    assert.equal(body.ok, false);
    assert.equal(body.code, 'PROFILE_UNKNOWN');
    assert.equal(body.candidates, undefined);
    assert.equal('candidates' in body, false);
  });
});

test('a definitive detail outranks free text from the companion\'s own stdout', async () => {
  const { classifyUnreachable, formatTerminalContent } = await bridge();

  // On the opencode server adapter, `adapterResult.stdout` IS the assistant's
  // prose (opencode-server-runtime.mjs `stdout: message`). A model quoting a
  // shell transcript must never reclassify a bridge transport flap as a missing
  // binary — that is the original misdiagnosis, re-entered through the back door.
  const assistantProse = 'I tried to run the build but got: bash: line 1: pnpm: command not found';
  const content = formatTerminalContent({
    jobId: 'jf-prose', status: 'unreachable', task: 't', target: 'opencode',
    detail: 'opencode_server_unreachable',
    error: 'opencode /event stream closed before session.idle',
    adapterResult: { stdout: assistantProse, stderr: '' },
  });
  assert.match(content, /\*\*Failure class:\*\* `runtime_transport`/);
  assert.doesNotMatch(content, /OPENCODE_BIN/);
  assert.doesNotMatch(content, /is available/);
  // The prose is still SHOWN — classification and display are different corpora.
  assert.match(content, /pnpm: command not found/);

  // Same for the other text signatures: a set detail always wins.
  assert.equal(
    classifyUnreachable('opencode_server_gone', 'opencode', 'spawn opencode ENOENT'),
    'runtime_transport',
  );
  assert.equal(
    classifyUnreachable('rehydrate_no_promptid', 'codex', 'no rollout found for thread id 0199a1'),
    'bridge_lifecycle',
  );
  assert.equal(
    classifyUnreachable('bridge_daemon_unreachable', 'copilot', 'socket hang up'),
    'runtime_unavailable',
  );

  // Only stderr + `error` feed the classifier; stdout alone never classifies.
  const stdoutOnly = formatTerminalContent({
    jobId: 'jf-out-only', status: 'unreachable', task: 't', target: 'codex',
    stdout: 'the agent said: spawn foo ENOENT while running your tests', stderr: '',
  });
  assert.match(stdoutOnly, /\*\*Failure class:\*\* `unknown`/);
  assert.doesNotMatch(stdoutOnly, /CODEX_BIN/);
  // ...but the same text on stderr, with no detail set, does.
  const stderrOnly = formatTerminalContent({
    jobId: 'jf-err-only', status: 'unreachable', task: 't', target: 'codex',
    stdout: '', stderr: 'spawn codex ENOENT',
  });
  assert.match(stderrOnly, /\*\*Failure class:\*\* `runtime_unavailable`/);
  assert.match(stderrOnly, /verify `CODEX_BIN`/);
});

test('the queue-drain surface renders the same class and channel excerpts as the wait surface', async () => {
  const mod = await bridge();
  const { emitNotification, jobs } = mod;

  // A codex resume rejection: EMPTY stdout, the reason only on stderr, no detail.
  // Delivered through the drain (the path the parent reads when it did not block
  // on agent_wait) this used to render `unknown` with zero evidence, because
  // emitNotification enumerates its formatTerminalContent fields and dropped
  // adapterResult on the floor.
  jobs.set('jf-drain', terminalJob('jf-drain', 'unreachable', {
    target: 'codex',
    adapterResult: { stdout: '', stderr: 'ERROR: JSON-RPC error -32600: no rollout found for thread id 0199a1' },
  }));
  try {
    await withQueue(async (queueFile) => {
      emitNotification({
        jobId: 'jf-drain', status: 'unreachable', summary: null, error: null,
        stuckReason: null, detail: null, duration: 1000,
        task: 'X', mode: 'EXECUTE', cwd: TEST_CWD, target: 'codex',
      });
      const event = readQueue(queueFile).at(-1);
      assert.equal(event.kind, 'terminal');
      assert.match(event.content, /\*\*Failure class:\*\* `thread_not_resumable`/);
      assert.match(event.content, /\*\*stderr \(tail\):\*\*/);
      assert.match(event.content, /no rollout found for thread id/);

      // And the bad-`-m` mirror image, whose ONLY channel is stdout.
      jobs.set('jf-drain2', terminalJob('jf-drain2', 'failed', {
        target: 'codex',
        adapterResult: { stdout: '{"type":"error","status":400,"error":{"message":"unknown model"}}', stderr: '' },
      }));
      emitNotification({
        jobId: 'jf-drain2', status: 'failed', summary: null,
        error: 'codex exited with code 1', stuckReason: null, detail: null, duration: 1000,
        task: 'X', mode: 'EXECUTE', cwd: TEST_CWD, target: 'codex',
      });
      const failedEvent = readQueue(queueFile).at(-1);
      assert.match(failedEvent.content, /\*\*stdout \(tail\):\*\*/);
      assert.match(failedEvent.content, /unknown model/);
    });
  } finally {
    jobs.delete('jf-drain');
    jobs.delete('jf-drain2');
  }
});
