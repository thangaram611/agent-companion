import './sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { SANDBOX_HOME } from './sandbox-home.mjs';
import { fakeCodexBin } from './fake-codex-app-server.mjs';
import { fakeClaudeBin } from './fake-claude-stream.mjs';
import { note, threadItem } from './codex-wire-frames.mjs';
import { codexDispatchFixture } from './controller/codex-dispatch-fixture.mjs';
import { fixtureSupervisor } from './controller/fixture-table.mjs';
import { until } from './controller/helpers.mjs';
import { callTool } from './tool-call.mjs';
import { createBridgeController, recoverController } from '../bridge-server/tools.mjs';
import { Records } from '../bridge-server/controller/records.mjs';
import { claudeProvider, ClaudeAdapter } from '../bridge-server/adapters/claude.mjs';
import { writeCompanionChecks, writeDefaultEffort } from '../lib/state.mjs';

const EXACT_TASK = '  First line.\nA second line.  ';

test('dispatch uses codexProvider with a real fake app-server through complete, cancel and bridge-loss handoff', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(SANDBOX_HOME, 'codex-wire-'));
  const bin = fakeCodexBin(dir);
  writeFileSync(join(dir, 'codex-code-mode-host'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const frame = (status) => note('turn/completed', { threadId: 'T1', turn: { id: 'TURN1', status,
    items: [threadItem('agentMessage', { id: 'answer', text: 'native answer', phase: 'final_answer' })] } });
  appendFileSync(bin, `
if (process.argv[2] === 'app-server') {
  process.send({ rows: [{ pid: process.pid, ppid: process.ppid, pgid: process.pid, birthTime: process.pid + ':' + performance.timeOrigin }] });
  process.stdin.on('end', () => { if (process.connected) process.disconnect(); });
}
const original = handle;
handle = (msg) => {
  original(msg);
  if (msg.method === 'turn/start') {
    out(${JSON.stringify(note('item/agentMessage/delta', { threadId: 'T1', turnId: 'TURN1', itemId: 'part', delta: 'native partial' }))});
    if (msg.params.input[0].text === 'complete') out(${JSON.stringify(frame('completed'))});
  }
  if (msg.method === 'turn/interrupt') out(${JSON.stringify(frame('interrupted'))});
};
`);
  const env = { ...process.env, CODEX_BIN: bin, CODEX_FAKE_TRACE: join(dir, 'trace.jsonl') };
  writeCompanionChecks({ codex: { ready: true } });
  const records = new Records({ dir: join(dir, 'records') });
  // Keep production adapters and real child processes. The existing identity
  // fixture replaces ps, which the execution sandbox denies.
  const supervisors = [];
  const createSupervisor = (options) => {
    const supervisor = fixtureSupervisor(options);
    const spawnRuntime = supervisor.spawn.bind(supervisor);
    supervisor.spawn = (argv, opts) => spawnRuntime(argv, { ...opts, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    supervisors.push(supervisor);
    return supervisor;
  };
  const watcherPath = join(dir, 'watcher.mjs');
  writeFileSync(watcherPath, `
import { Records } from ${JSON.stringify(new URL('../bridge-server/controller/records.mjs', import.meta.url).href)};
import { cleanupJob } from ${JSON.stringify(new URL('../scripts/cleanup-watcher.mjs', import.meta.url).href)};
import { fixtureSupervisor } from ${JSON.stringify(new URL('../test/controller/fixture-table.mjs', import.meta.url).href)};
const records = new Records({ dir: process.argv[2] });
await cleanupJob({ records, job: records.readJob(process.argv[3]), createSupervisor: fixtureSupervisor });
`);
  let watcher;
  const active = createBridgeController({ env, records, createSupervisor,
    launchWatcher: async ({ stateDir, jobId }) => {
      watcher = spawn(process.execPath, [watcherPath, stateDir, jobId], { detached: true, stdio: 'ignore' });
      await once(watcher, 'spawn');
      return { pid: watcher.pid };
    } });
  const call = (args) => callTool(args, { controller: active });
  const send = task => call({ action: 'send', companion: 'codex', cwd: dir, task });
  t.after(async () => {
    for (const supervisor of supervisors) await supervisor.terminate({ graceMs: 0 });
    if (watcher && watcher.exitCode === null) await once(watcher, 'exit');
  });
  const completed = await send('complete');
  const answer = await call({ action: 'wait', job_id: completed.job_id, max_wait_sec: 5 });
  assert.equal(answer.status, 'completed', JSON.stringify(answer)); assert.equal(answer.content, 'native answer');
  const running = await send('wait for cancel');
  const status = await call({ action: 'status', job_id: running.job_id });
  assert.equal(status.status, 'running');
  const cancelled = await call({ action: 'cancel', job_id: running.job_id });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.meta.stop_evidence.gone, true);
  const lost = await send('wait for bridge loss');
  await active.bridgeLost();
  assert.equal(records.readJob(lost.job_id).writer, 'watcher');
  await until(() => records.readResult(lost.job_id), 'cleanup watcher result');
  const fresh = createBridgeController({ env, records, createSupervisor });
  await recoverController(fresh);
  const recovered = await callTool({ action: 'wait', job_id: lost.job_id }, { controller: fresh });
  assert.equal(recovered.meta.cause, 'bridge_loss'); assert.equal(recovered.meta.stop_evidence.gone, true);
  assert.equal(recovered.status, 'cancelled');
  const trace = readFileSync(env.CODEX_FAKE_TRACE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(trace.filter((x) => x.method === 'turn/start').length, 3);
  assert.equal(trace.some((x) => x.method === 'turn/interrupt'), true);
  assert.equal(Object.hasOwn(trace.find((x) => x.method === 'turn/start').params, 'model'), false);
});

test('running send steers the acknowledged native turn and confirms injection', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id, thread } = await h.send();
  assert.equal((await h.call({ action: 'status', job_id })).interventions.steer, true);
  const reply = h.call({ action: 'send', thread, task: 'use ripgrep' });
  await until(() => h.frames().some((f) => f.method === 'turn/steer'), 'native steer');
  await h.clock.advance(4000);
  assert.equal(h.records.readResult(job_id), null);
  await h.emit(job_id, [note('item/completed', { threadId: 'T1', turnId: 'TURN1',
    item: threadItem('userMessage', { id: 'steer', content: [{ type: 'text', text: 'use ripgrep' }] }) })]);
  const response = await reply;
  assert.equal(response.ok, true);
  assert.equal(response.accepted, true);
  assert.equal(response.confirmed, true);
  assert.equal(response.nativeTurnId, 'TURN1');
  assert.equal(response.job_id, job_id);
  assert.deepEqual(h.frames().filter((f) => f.method === 'turn/steer').map((f) => f.params), [
    { threadId: 'T1', expectedTurnId: 'TURN1', input: [{ type: 'text', text: 'use ripgrep' }] },
  ]);
  assert.equal(h.frames().filter((f) => f.method === 'turn/start').length, 1);
  assert.equal(h.frames().some((f) => f.method === 'turn/interrupt'), false);
  await h.complete(job_id, 'steered answer');
  assert.equal((await h.call({ action: 'wait', job_id })).content, 'steered answer');
});

test('running send reports acknowledgement without claiming unobserved injection', async (t) => {
  const h = codexDispatchFixture(t);
  h.env.AGENT_COMPANION_CODEX_STEER_CONFIRM_MS = '1';
  const { job_id, thread } = await h.send();
  const response = await h.call({ action: 'send', thread, task: 'later boundary' });
  assert.equal(response.ok, true);
  assert.equal(response.accepted, true);
  assert.equal(response.confirmed, false);
  assert.equal((await h.call({ action: 'status', job_id })).interventions.steer, true);
});

test('aborting a pending steer leaves the native turn running', async (t) => {
  const h = codexDispatchFixture(t);
  const { job_id, thread } = await h.send();
  const abort = new AbortController();
  const reply = h.call({ action: 'send', thread, task: 'pending' }, { signal: abort.signal });
  await until(() => h.frames().some((f) => f.method === 'turn/steer'), 'pending steer');
  abort.abort();
  await h.complete(job_id, 'continued answer');
  const response = await reply;
  assert.equal(response.accepted, true);
  assert.equal(response.confirmed, false);
  assert.equal((await h.call({ action: 'wait', job_id })).content, 'continued answer');
});

test('Claude provider uses cached readiness, accepts aliases and creates independent adapters', () => {
  writeCompanionChecks({ claude: { ready: false } });
  const provider = claudeProvider({ env: { CLAUDE_BIN: '/missing-claude', PATH: '' } });
  assert.equal(provider.enabled, true);
  assert.equal(provider.ready, false);
  writeCompanionChecks({ claude: { ready: true } });
  assert.equal(provider.ready, true, 'readiness getter observes updated cached evidence without probing');
  assert.equal(provider.modelAllowed('haiku'), true);
  assert.equal(provider.modelAllowed('bad model'), false);
  assert.ok(provider.create() instanceof ClaudeAdapter);
  assert.notEqual(provider.create(), provider.create());
  writeCompanionChecks({});
  assert.equal(provider.ready, false);
});

test('dispatch wires the Claude provider through fake native send and cold resume', async (t) => {
  const dir = mkdtempSync(join(SANDBOX_HOME, 'claude-wire-'));
  const env = { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'), CLAUDE_BIN: fakeClaudeBin(dir),
    FAKE_CLAUDE_TRACE: join(dir, 'trace.jsonl'), AGENT_COMPANION_CLAUDE_PERMISSION: 'plan' };
  writeCompanionChecks({ claude: { ready: true } });
  const supervisors = [];
  const active = createBridgeController({ env, records: new Records({ dir: join(dir, 'records') }), createSupervisor: (options) => {
    const supervisor = fixtureSupervisor(options), spawn = supervisor.spawn.bind(supervisor);
    supervisor.spawn = (argv, opts) => spawn(argv, { ...opts, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    supervisors.push(supervisor);
    return supervisor;
  } });
  t.after(async () => {
    for (const live of [...active.live.values()]) await active.cancel({ thread: live.record.thread, jobId: live.record.jobId });
    for (const supervisor of supervisors) await supervisor.terminate({ graceMs: 0 });
    writeCompanionChecks({});
  });
  const call = (args) => callTool(args, { controller: active });
  const answers = [];
  let thread;
  for (const task of [EXACT_TASK, 'follow-up']) {
    const sent = await call({ action: 'send', companion: 'claude', ...(thread && { thread }), cwd: dir, task, effort: task === EXACT_TASK ? 'low' : null });
    assert.equal(sent.ok, true);
    thread = sent.thread;
    assert.equal(sent.effective_model, 'claude-haiku-5-5');
    assert.equal(sent.selected_effort, 'low');
    assert.equal(sent.effective_effort, null);
    assert.equal(sent.permission_mode, 'plan');
    const catalog = await call({ action: 'catalog' });
    assert.equal(catalog.companions.find((companion) => companion.id === 'claude').permission.mode, sent.permission_mode);
    const answer = await call({ action: 'wait', job_id: sent.job_id, max_wait_sec: 5 });
    assert.equal(answer.status, 'completed');
    assert.equal(answer.content, 'alpha');
    answers.push(answer);
  }
  assert.notEqual(supervisors[0].child.pid, supervisors[1].child.pid);
  const statuses = await Promise.all(answers.map(({ job_id }) => call({ action: 'status', job_id, diagnostics: true })));
  assert.ok(statuses[0].native_refs.historyId);
  assert.equal(statuses[0].native_refs.historyId, statuses[1].native_refs.historyId);
  const frames = readFileSync(env.FAKE_CLAUDE_TRACE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(frames.filter((f) => f.type === 'user').map((f) => f.message.content), [EXACT_TASK, 'follow-up']);
  const argv = frames.filter((f) => f.type === 'argv').map((f) => f.args);
  assert.ok(argv[0].includes('--session-id'));
  assert.ok(argv[1].includes('--resume'));
  assert.equal(argv.some((args) => args.includes('--model')), false);
  assert.ok(argv.every((args) => args[args.indexOf('--effort') + 1] === 'low'));
  assert.ok(answers.every((answer) => answer.meta.selected_effort === 'low' && answer.meta.effective_effort === undefined));
});

test('Codex accepts effort and exposes adapter refusals through send, status and saved results', async (t) => {
  const h = codexDispatchFixture(t);
  h.env.AGENT_COMPANION_HOME = h.dir;
  const send = effort => h.call({ action: 'send', companion: 'codex', cwd: h.dir, task: 'original', effort });
  const accepted = await send('low');
  assert.equal(accepted.status, 'still_running');
  assert.equal(accepted.selected_effort, 'low');
  assert.equal(accepted.effective_effort, 'low');
  await h.complete(accepted.job_id);
  for (const [effort, ignored, code, message] of [
    ['ultra', false, 'EFFORT_NOT_ALLOWED', /configured-model.*Use one of: low, medium, high, xhigh, max/],
    ['low', true, 'CAPABILITY_UNAVAILABLE', /did not apply effort "low"/],
  ]) {
    if (ignored) h.env.CODEX_FAKE_IGNORE_EFFORT = '1';
    writeDefaultEffort(effort, 'codex', h.env);
    const refused = await send(effort);
    assert.equal(refused.status, 'failed');
    assert.equal(refused.action, 'send');
    assert.equal(readFileSync(h.records.path('results', refused.job_id) + '.delivery', 'utf8'), 'tool\n', 'terminal send claimed before any wait');
    assert.equal(refused.meta.detail, code);
    assert.match(refused.content, message);
    assert.doesNotMatch(refused.content, /saved default/i);
    assert.equal(refused.meta.selected_effort, effort);
    assert.equal(refused.meta.native_refs, undefined);
    const status = await h.call({ action: 'status', job_id: refused.job_id });
    assert.equal(status.detail, code);
    assert.equal(status.partial_text, undefined);
    const waited = await h.call({ action: 'wait', job_id: refused.job_id });
    const { error, ...failedSend } = refused;
    assert.equal(refused.ok, false);
    assert.match(error, message);
    assert.deepEqual(waited, { ...failedSend, action: 'wait', ok: true });
    assert.equal(new Records({ dir: h.records.dir }).readResult(refused.job_id).text, refused.content);
    if (code === 'EFFORT_NOT_ALLOWED') t.diagnostic('EFFORT_ENVELOPE codex ' + JSON.stringify(refused));
    const saved = await send();
    assert.equal(saved.meta?.detail, code);
    assert.match(saved.content, message);
    assert.ok(saved.content.includes(join(h.dir, 'settings.json')));
    const { error: savedError, ...savedSend } = saved;
    assert.match(savedError, /saved default/);
    assert.deepEqual(await h.call({ action: 'wait', job_id: saved.job_id }), { ...savedSend, action: 'wait', ok: true });
  }
  assert.equal(h.frames().filter((frame) => frame.method === 'turn/start').length, 1);
});
