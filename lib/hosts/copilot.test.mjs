import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { copilot } from './copilot.mjs';
import { serveNotices } from './copilot-notice.mjs';
import { dispatch, createBridgeController } from '../../bridge-server/tools.mjs';
import { setupController, until } from '../../test/controller/helpers.mjs';
import { COMPANION_IDS } from '../companion-registry.mjs';
import { decodeTool } from '../../test/tool-call.mjs';

const scope = () => ({ ...process.env, COPILOT_HOME: SANDBOX_HOME, AGENT_COMPANION_HOST: 'copilot',
  AGENT_RUNTIME_DIR: mkdtempSync(join(SANDBOX_HOME, 'runtime-')), COPILOT_AGENT_SESSION_ID: 'root' });
const root = { host: copilot.id, session: 'root', agent: null };
const meta = { 'com.github.copilot/toolCallId': 'call' };
const hook = (event, data, env) => execFileSync(process.execPath, [join(import.meta.dirname, '../../hooks/copilot.mjs'), event],
  { input: JSON.stringify(data), env, encoding: 'utf8' });
function stamp(identity, env, tool = 'status') {
  const response = hook('preToolUse', { toolName: 'agent-bridge-companion_' + tool, toolCallId: 'call',
    toolArgs: JSON.stringify({ lead: { session: 'forged', agent: 'forged' } }), ...identity }, env);
  return JSON.parse(response).modifiedArgs;
}

test('hook overwrites model identity and binds the call to its bridge root, sibling or nested agent', () => {
  const env = scope();
  for (const [sessionId, parent] of [['root'], ['one', 'root'], ['two', 'root'], ['nested', 'two']]) {
    const identity = { sessionId, ...(parent && { agentId: sessionId, parentAgentId: parent }) };
    const args = stamp(identity, env);
    assert.deepEqual(copilot.leadFromCall({ args, meta, env }), { ...root, agent: parent ? sessionId : null });
    assert.equal(copilot.leadFromCall({ args, meta: {}, env }), null);
    assert.equal(copilot.leadFromCall({ args, meta: { 'com.github.copilot/toolCallId': 'other' }, env }), null);
    assert.equal(copilot.leadFromCall({ args, meta, env: {} }), null);
    assert.equal(copilot.leadFromCall({ args: { lead: { ...args.lead, session: 'other', agent: 'other' } }, meta, env }), null);
  }
  for (const identity of [{}, { sessionId: 'other-root' }, { sessionId: 'root', agentId: 'child' },
    { sessionId: 'root', parentAgentId: 'root' }, { sessionId: '${session}' }]) {
    assert.equal(copilot.leadFromCall({ args: stamp(identity, env), meta, env }), null);
  }
  assert.equal(hook('preToolUse', { toolName: 'other-companion_send' }, env), '');
  assert.equal(hook('preToolUse', {}, { ...env, AGENT_COMPANION_JOB: 'job' }), '');
});

test('thread operations require provenance and enforce ownership across siblings and two bridges', async () => {
  const env = scope();
  const h = setupController({ createController: createBridgeController, companion: 'claude', env });
  const call = async (active, name, args) => decodeTool(await dispatch({ name: 'companion_' + name,
    arguments: args, _meta: meta }, { controller: active, host: 'copilot' }));
  const agent = stamp({ sessionId: 'child', agentId: 'child', parentAgentId: 'root' }, env);
  const sent = await call(h.controller, 'send', { ...agent, companion: 'claude', task: 'task', cwd: h.dir });
  assert.deepEqual(sent.delivery, { wake: null, reason: 'subagent', fallback: 'companion_wait' });
  assert.equal((await call(h.controller, 'status', {})).code, 'LEAD_REQUIRED');
  for (const [active, identity] of [[h.controller, { sessionId: 'root' }],
    [h.controller, { sessionId: 'two', agentId: 'two', parentAgentId: 'root' }],
    [createBridgeController({ env: { ...env, COPILOT_AGENT_SESSION_ID: 'other' }, records: h.records }), { sessionId: 'other' }]]) {
    const args = stamp(identity, env);
    assert.equal((await call(active, 'read', { ...args, thread: sent.thread })).code, 'THREAD_NOT_YOURS');
    assert.deepEqual((await call(active, 'status', args)).threads, []);
  }
  await h.finish(sent.job_id);
  const payload = { sessionId: 'child', agentId: 'child', parentAgentId: 'root' };
  // In production publish and hook share the owning profile.
  const hookEnv = { ...env, AGENT_COMPANION_HOME: h.dir, AGENT_RUNTIME_DIR: process.env.AGENT_RUNTIME_DIR };
  assert.equal(hook('postToolUse', { sessionId: 'root' }, hookEnv), '');
  assert.match(JSON.parse(hook('postToolUse', payload, hookEnv)).additionalContext, new RegExp(sent.job_id));
  assert.equal(hook('postToolUse', payload, hookEnv), '');
});

test('a joined extension accepts one notice, routes by root and survives predecessor cleanup', async t => {
  const env = scope();
  const received = [];
  const status = () => copilot.wakeStatus(root, env);
  assert.equal((await status()).wake, null);
  const listen = () => serveNotices(env.AGENT_RUNTIME_DIR, { sessionId: 'root', send: async text => received.push(text) });
  const old = await listen();
  t.after(old);
  const close = await listen();
  t.after(close);
  old();
  assert.equal((await status()).wake, 'copilot_session_send');
  assert.equal((await copilot.wakeStatus({ ...root, agent: 'child' }, env)).reason, 'subagent');
  await copilot.wake({ ...root, session: 'other' }, 'wrong root', env);
  await copilot.wake({ ...root, agent: 'child' }, 'wrong agent', env);
  await copilot.wake(root, 'notice\nwith quotes "…"', env);
  assert.deepEqual(received, ['notice\nwith quotes "…"']);
  const dir = join(env.AGENT_RUNTIME_DIR, 'notices');
  const [file] = readdirSync(dir).map(name => join(dir, name));
  const registration = readFileSync(file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((await copilot.diagnostics(env)).registrations, 1);
  close();
  writeFileSync(file, registration);
  assert.equal((await copilot.diagnostics(env)).registrations, 0);
  assert.equal((await status()).wake, null);
});

// The shared launcher ignores the marker on purpose: Codex marks the bridge required, so a launcher that
// exited in a marked Codex companion would stop the job. Copilot ACP gets --disable-mcp-server instead.
test('a marked extension skips the SDK join', () => {
  const env = { ...scope(), PATH: '', AGENT_COMPANION_JOB: 'nested' };
  assert.equal(execFileSync(process.execPath, [join(import.meta.dirname, '../../extensions/notice/extension.mjs')], { env }).length, 0);
});

test('doctor reports the experimental setting, extension disables and live registrations independently', async () => {
  const env = { ...scope(), COPILOT_HOME: mkdtempSync(join(SANDBOX_HOME, 'profile-')) };
  writeFileSync(join(env.COPILOT_HOME, 'settings.json'), JSON.stringify({
    experimental: true, extensions: { mode: 'disabled', disabledExtensions: ['notice'] },
  }));
  const { experimental, extensionMode, disabledExtensions, registrations } = await copilot.diagnostics(env);
  assert.deepEqual([experimental, extensionMode, disabledExtensions, registrations], [true, 'disabled', ['notice'], 0]);
});

test('every companion adapter gets the marker for the job it starts', async () => {
  for (const companion of COMPANION_IDS) {
    const h = setupController({ companion });
    const job = await h.send();
    assert.equal(h.adapters[0].calls[0][1].env.AGENT_COMPANION_JOB, job.jobId, companion);
    await h.finish(job.jobId);
  }
});

test('a failed notice acknowledgement leaves the result readable and wait can win without a wake', async t => {
  const env = scope();
  const h = setupController({ env, companion: 'claude', createController: createBridgeController });
  const args = stamp({ sessionId: 'root' }, env);
  const call = (name, input) => dispatch({ name: 'companion_' + name, arguments: { ...args, ...input }, _meta: meta },
    { controller: h.controller, host: copilot.id });
  const start = async () => decodeTool(await call('send', { companion: 'claude', task: 'task', cwd: h.dir }));
  const first = await start();
  assert.equal(first.delivery.reason, 'extension_unavailable');
  const received = [];
  const close = await serveNotices(env.AGENT_RUNTIME_DIR, { sessionId: 'root', send: async text => {
    received.push(text);
    throw Error('acknowledgement lost');
  } });
  t.after(close);
  await h.finish(first.job_id);
  await until(() => received.length === 1);
  assert.match((await call('read', { thread: first.thread })).content[0].text, /answer/);
  const next = await start();
  assert.equal(next.delivery.wake, 'copilot_session_send');
  const wait = call('wait', { thread: next.thread });
  await h.finish(next.job_id, undefined, h.adapters.at(-1));
  assert.equal(decodeTool(await wait).content, 'answer');
  assert.equal(received.length, 1);
});
