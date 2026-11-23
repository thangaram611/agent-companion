import './sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync, realpathSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCompanionDefaults, writeTargetChecks } from '../lib/state.mjs';
import { queuePath } from '../lib/runtime-paths.mjs';
import { setupController, diskSnapshot, deferred } from './controller/helpers.mjs';
import { tools, dispatch, createBridgeController, recoverController } from '../bridge-server/tools.mjs';

import pkg from '../bridge-server/package.json' with { type: 'json' };
import { mcp } from '../bridge-server/server.mjs';

const main = { session: 'session-a', agent: null };
const task = '  First line.\n\nSecond line: `quoted` — keep whitespace.  \n';

function fixture(options = {}) {
  const h = setupController({ provider: 'claude', capabilities: { interventions: { default: 'steer', steer: true, queue: 'native', interrupt: true } }, ...options });
  h.controller.env.AGENT_COMPANION_HOME = h.dir;
  const call = async (action, args = {}, lead = main, extra = {}) =>
    (await dispatch({ name: 'agent_' + action, arguments: { lead, ...args } },
      { controller: h.controller, host: 'claude', ...extra })).structuredContent;
  const send = (args = {}, lead = main) => call('send', { task, target: 'claude', cwd: h.dir, ...args }, lead);
  return { ...h, call, send };
}

const scenarios = {
  async 'MCP advertises the package version and public tool schemas'() {
    const request = (method, params) => mcp._requestHandlers.get(method)({ method, params });
    const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.serverInfo.version, pkg.version);
    const listed = (await request('tools/list', {})).tools;
    assert.deepEqual(listed.map(t => t.name), tools.map(t => t.name));
    assert.ok(!listed.some(t => t.name === 'agent_reply'));
    for (const tool of listed) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(!Object.hasOwn(tool.inputSchema.properties, 'lead'));
      for (const field of ['prompt_id', 'session_id', 'debug']) assert.ok(!Object.hasOwn(tool.outputSchema.properties, field));
    }
  },

  async 'Claude main lead starts a thread and delivers its exact task once'() {
    const h = fixture();
    const sent = await h.send();
    assert.match(sent.thread, /^th-[a-f0-9]{10}$/);
    assert.deepEqual(sent, { ok: true, status: 'still_running', thread: sent.thread, job_id: sent.job_id,
      target: 'claude', selected_model: null, selected_effort: null, effective_model: 'effective-model',
      effective_effort: null, permission_mode: 'bypassPermissions' });
    assert.deepEqual(h.adapters[0].calls.filter(([name]) => name === 'deliver').map(([, input]) => input.text), [task]);
  },
  async 'host identity gates every protected call before work'() {
    const h = fixture();
    const before = diskSnapshot(h.dir);
    for (const { action } of tools.filter(t => t.action !== 'catalog')) assert.equal((await h.call(action, {}, null)).code, 'LEAD_REQUIRED');
    assert.equal((await h.call('catalog', {}, null)).ok, true);
    assert.deepEqual(diskSnapshot(h.dir), before);
  },

  async 'subagents and sessions have independent thread lists and cannot use foreign references'() {
    const h = fixture();
    const sub = { ...main, agent: 'native-child' };
    const first = await h.send({ title: 'Review' });
    const second = await h.send({}, sub);
    assert.notEqual(second.thread, first.thread);
    const before = diskSnapshot(h.dir);
    for (const [lead, other] of [[main, second], [sub, first]]) {
      for (const { action } of tools.filter(t => t.action !== 'catalog')) {
        for (const ref of action === 'send' ? [{ thread: other.thread, task }] : [{ thread: other.thread }, { job_id: other.job_id }]) {
          assert.equal((await h.call(action, ref, lead)).code, 'THREAD_NOT_YOURS');
        }
      }
    }
    for (const { action } of tools.filter(t => t.action !== 'catalog')) {
      const r = await h.call(action, { thread: 'th-deadbeef00', ...(action === 'send' && { task }) });
      assert.equal(r.code, 'thread_unknown');
      assert.equal(r.status, 'unknown_thread');
    }
    const row = (s, title) => ({ thread: s.thread, title, target: 'claude', cwd: realpathSync(h.dir), state: 'running',
      job_id: s.job_id, started_at: new Date(h.clock.now()).toISOString() });
    assert.deepEqual((await h.call('status')).threads, [row(first, 'Review')]);
    assert.deepEqual((await h.call('status', {}, sub)).threads, [row(second, task.split('\n')[0])]);
    assert.deepEqual((await h.call('status', {}, { session: 'session-b' })).threads, []);
    assert.deepEqual(diskSnapshot(h.dir), before);
  },

  async 'Codex binds the metadata session and ignores a forged lead on every call'() {
    const h = fixture();
    const call = async (action, args, source = 'user', session = 'root') => (await dispatch({
      name: 'agent_' + action, arguments: { ...args, lead: main },
      _meta: { 'x-codex-turn-metadata': { session_id: session, thread_source: source, thread_id: source === 'user' ? session : 'child' } },
    }, { controller: h.controller, host: 'codex' })).structuredContent;
    const before = diskSnapshot(h.dir);
    assert.equal((await h.call('status', {}, main, { host: 'codex' })).code, 'LEAD_REQUIRED');
    for (const thread_id of [null, undefined, '']) {
      const malformed = await dispatch({ name: 'agent_status', arguments: { lead: main }, _meta: {
        'x-codex-turn-metadata': { session_id: 'root', thread_source: 'subagent', thread_id },
      } }, { controller: h.controller, host: 'codex' });
      assert.equal(malformed.structuredContent.code, 'LEAD_REQUIRED');
    }
    assert.equal((await call('catalog', {}, 'user', 'other')).ok, true);
    assert.deepEqual(diskSnapshot(h.dir), before);
    for (const [source, agent] of [['user', null], ['subagent', 'child']]) {
      const sent = await call('send', { target: 'claude', task, cwd: h.dir }, source);
      assert.deepEqual(h.records.readConversation(sent.thread).lead, { session: 'root', host: 'codex', agent });
      assert.equal(h.records.readExecution(sent.job_id).hostSessionId, 'root');
      assert.equal((await call('status', { job_id: sent.job_id }, agent ? 'user' : 'subagent')).code, 'THREAD_NOT_YOURS');
      assert.deepEqual((await call('status', {}, source)).threads.map(row => row.thread), [sent.thread]);
    }
    assert.equal((await call('status', {}, 'user', 'other')).code, 'BRIDGE_SID_CONFLICT');
  },

  async 'cwd is required only for new threads and bindings use the canonical directory'() {
    const h = fixture();
    for (const cwd of [undefined, 'relative', join(h.dir, 'absent'), new URL(import.meta.url).pathname]) {
      assert.equal((await h.call('send', { task, ...(cwd && { cwd }) })).code, 'INVALID_CWD');
    }
    const link = join(h.dir, 'link');
    symlinkSync(h.dir, link);
    const { thread, job_id } = await h.send({ cwd: link });
    const bound = realpathSync(h.dir);
    assert.equal(h.records.readConversation(thread).cwd, bound);
    await h.finish(job_id);
    for (const [change, code] of [[{ target: 'codex' }, 'provider_mismatch'], [{ cwd: '/' }, 'cwd_mismatch']]) {
      const response = await h.call('send', { task, thread, ...change });
      assert.equal(response.code, code);
      for (const fact of ['claude', bound, 'omit thread']) assert.ok(response.hint.toLowerCase().includes(fact.toLowerCase()));
    }
  },

  async 'new sends use live routing refusals and start no adapter on refusal'() {
    const h = fixture();
    const send = args => h.call('send', { task, cwd: h.dir, ...args });
    assert.equal((await send({})).code, 'TARGET_UNCONFIGURED');
    assert.equal((await send({ target: 'absent' })).code, 'TARGET_UNSUPPORTED');
    const model = await send({ target: 'opencode', model: 'no-provider' });
    assert.equal(model.code, 'MODEL_NOT_ALLOWED');
    assert.match(model.hint, /provider\/model/i);
    const effort = await send({ target: 'claude', effort: 'minimal' });
    assert.equal(effort.code, 'EFFORT_NOT_ALLOWED');
    assert.match(effort.hint, /low, medium, high, xhigh, max/);
    writeCompanionDefaults('claude', { effort: 'invalid' }, h.controller.env);
    assert.ok((await h.send()).hint.includes(join(h.dir, 'settings.json')));
    h.controller.providers.claude.ready = false;
    assert.equal((await h.send({ effort: 'low' })).code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(h.adapters.length, 0);
    assert.deepEqual(h.records.listConversations(), []);
  },

  async 'new thread selection respects explicit, environment and saved settings; resume retains accepted choices'() {
    const h = fixture();
    writeCompanionDefaults('claude', { model: 'a', effort: 'low' }, h.controller.env);
    const first = await h.send();
    assert.deepEqual([first.selected_model, first.selected_effort], ['a', 'low']);
    Object.assign(h.controller.env, { AGENT_COMPANION_CLAUDE_MODEL: 'b' });
    const env = await h.send(), explicit = await h.send({ model: 'a', effort: 'max' });
    assert.deepEqual([env.selected_model, env.selected_effort], ['b', 'low']);
    assert.deepEqual([explicit.selected_model, explicit.selected_effort], ['a', 'max']);
    assert.equal(h.controller.live.size, 3);
    await h.finish(first.job_id);
    const next = await h.call('send', { thread: first.thread, task: 'follow-up' });
    assert.deepEqual([next.thread, next.target, next.selected_model, next.selected_effort], [first.thread, 'claude', 'a', 'low']);
    const adapter = h.adapters.at(-1);
    assert.deepEqual(adapter.calls.find(([op]) => op === 'openHistory')[1], { model: 'a', effort: 'low', historyId: 'native-history' });
    await h.finish(next.job_id, undefined, adapter);
    assert.equal((await h.call('send', { thread: first.thread, task, model: 'b' })).selected_model, 'b');
    assert.equal(h.records.readConversation(first.thread).title, task.split('\n')[0]);
    const failure = fixture({ historyError: 'EFFORT_NOT_ALLOWED' });
    const rejected = await failure.send({ effort: 'low' });
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.meta.detail, 'EFFORT_NOT_ALLOWED');
    assert.equal(failure.records.readConversation(rejected.thread).effortOverride, undefined);
  },

  async 'live send reattaches identical work and delivers different text in the requested mode'() {
    const h = fixture();
    const sent = await h.send({ model: 'a', effort: 'low' });
    const follow = args => h.call('send', { thread: sent.thread, task, ...args });
    assert.deepEqual(await follow({}), sent);
    for (const change of [{ model: 'b' }, { effort: 'max', task: 'different' }]) assert.equal((await follow(change)).code, 'thread_busy');
    for (const mode of [undefined, 'steer', 'queue', 'interrupt']) {
      const text = 'exact new text\n' + mode;
      const ack = await follow({ task: text, ...(mode && { mode }) });
      assert.equal(ack.status, 'intervened');
      assert.equal(ack.action, 'send');
      assert.equal(ack.mode, mode ?? 'steer');
      assert.equal(ack.job_id, sent.job_id);
      assert.equal(ack.thread, sent.thread);
      assert.equal(ack.accepted, true);
      const input = h.records.readExecution(ack.job_id).interventions.at(-1);
      assert.equal(input.id, ack.intervention_id);
      assert.equal(input.text, text);
    }
    assert.equal(h.adapters[0].calls.filter(([name]) => name === 'deliver').length, 1);
    assert.equal((await follow({ task: 'x'.repeat(8001) })).code, 'INVALID_ARGUMENTS');
    assert.equal((await follow({ mode: 'queue' })).code, 'INVALID_ARGUMENTS');
    assert.equal((await h.send({ mode: 'queue' })).code, 'INVALID_ARGUMENTS');
    await h.call('cancel', { thread: sent.thread });
    assert.equal((await follow({ task: 'again', mode: 'queue' })).code, 'INVALID_ARGUMENTS');
  },

  async 'unavailable intervention returns its reason without substituting another mode'() {
    const start = deferred();
    const h = fixture({ start: () => start.promise, capabilities: { interventions: { default: 'queue', queue: 'bridge' } } });
    const sending = h.send();
    const [{ owner: thread }] = h.records.listConversations();
    const follow = mode => h.call('send', { thread, task: 'new text', mode });
    const refused = reason => ({ ok: false, action: 'send', status: 'intervention_unavailable', reason });
    assert.deepEqual(await follow('queue'), refused('state'));
    start.resolve();
    await sending;
    assert.deepEqual(await follow('steer'), refused('capability'));
    assert.deepEqual(h.records.listExecutions()[0].interventions, []);
  },

  async 'wait budgets and one-shot user inbox notifications work by either reference'() {
    const h = fixture();
    const { thread, job_id } = await h.send();
    for (const [ref, max, seconds] of [[{ thread }, undefined, 480], [{ job_id }, 5000, 1200]]) {
      let returned = false;
      const wait = h.call('wait', { ...ref, ...(max && { max_wait_sec: max }) }).then(value => { returned = true; return value; });
      await h.clock.advance(seconds * 1000 - 1);
      assert.equal(returned, false);
      await h.clock.advance(1);
      const running = await wait;
      assert.equal(running.current_status, 'running');
      assert.equal(running.thread, thread);
      assert.equal(running.digest_uri, 'agent-digest://' + job_id);
      assert.ok(running.age_s >= seconds && running.hint);
      assert.equal(Object.hasOwn(running, 'session_reborn'), false);
    }
    const wait = h.call('wait', { thread });
    const inbox = h.records.inboxPath(job_id);
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'msg.json'), JSON.stringify({ executionId: job_id, requestId: 'msg', at: 1, text: 'human input', mode: 'queue' }));
    await h.clock.advance(1000);
    const notice = await wait;
    assert.equal(notice.status, 'user_intervened');
    assert.equal(notice.intervention.text, 'human input');
    const again = h.call('wait', { job_id, max_wait_sec: 1 });
    await h.clock.advance(1000);
    assert.equal((await again).status, 'still_running');
  },

  async 'cancel ends one job, preserves its history, and lists running threads ahead of ended ones'() {
    const h = fixture();
    const a = await h.send();
    await h.clock.advance(1);
    const b = await h.send();
    await h.clock.advance(1);
    const c = await h.send();
    for (const ref of [{ thread: c.thread }, { job_id: a.job_id }]) assert.equal((await h.call('cancel', ref)).status, 'cancelled');
    assert.deepEqual((await h.call('status')).threads.map(r => r.thread), [b.thread, c.thread, a.thread]);
    const resumed = await h.call('send', { thread: a.thread, task: 'resume' });
    assert.notEqual(resumed.job_id, a.job_id);
    assert.equal(h.adapters.at(-1).calls.find(([op]) => op === 'openHistory')[1].historyId, 'native-history');
    assert.equal((await h.call('wait', { job_id: a.job_id })).meta.thread, a.thread);
  },

  async 'status projects progress and cached diagnostics, including reads from a second bridge'() {
    const h = fixture({ createController: createBridgeController });
    const { thread, job_id } = await h.send();
    writeTargetChecks({ claude: { ready: true, checkedAt: 'cached' } });
    for (const [progress, expected] of [[{ partialText: 'recovering' }, 'responding'], [{ activeCommand: 'build' }, 'running build'],
      [{ activity: 'thinking' }, 'thinking'], [{ activity: null }, null]]) {
      h.adapters[0].progress({ ...progress, retry: { willRetry: true } });
      const status = await h.call('status', { job_id });
      assert.equal(status.retry.willRetry, true);
      assert.equal(status.activity, expected);
      assert.equal(status.status, 'running');
    }
    assert.equal(h.records.read('completions', job_id), null);
    const before = diskSnapshot(h.dir);
    const status = await h.call('status', { thread, diagnostics: true });
    assert.deepEqual(status.diagnostics.targets.claude, { ready: true, checkedAt: 'cached' });
    const second = createBridgeController({ records: h.records, env: h.controller.env });
    assert.equal((await h.call('status', { job_id }, main, { controller: second })).status, 'unknown');
    assert.deepEqual(diskSnapshot(h.dir), before);
    await h.finish(job_id);
    assert.equal((await h.call('status', { thread })).activity, null);
  },

  async 'racing native completion stays immutable across waits and repeated startup recovery'() {
    const h = fixture({ racingComplete: true, createController: createBridgeController });
    const { job_id } = await h.send();
    const cancel = await h.call('cancel', { job_id });
    assert.equal(cancel.status, 'completed');
    assert.equal(cancel.content, 'native answer');
    const other = createBridgeController({ records: h.records, env: h.controller.env });
    for (let i = 0; i < 2; i++) {
      await recoverController(other);
      assert.equal((await h.call('wait', { job_id }, main, { controller: other })).content, cancel.content);
    }
    const rows = readFileSync(queuePath(), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.jobId === job_id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].consumed, true);
    assert.equal(rows[0].claudeSessionId, main.session);
  },

  async 'invalid arguments are refused before a tool starts work'() {
    const h = fixture();
    for (const [action, args] of [['send', { task, cwd: h.dir, max_wait_sec: 10 }], ['status', { verbose: false }],
      ['send', { cwd: h.dir }], ['cancel', {}], ['wait', {}], ['wait', { thread: '../escape' }],
      ['wait', { job_id: '../escape' }], ['wait', { job_id: 'id', max_wait_sec: '1' }], ['status', { diagnostics: 'yes' }],
      ['send', { task, cwd: h.dir, mode: 'unknown' }], ['send', { task, job_id: 'old' }], ['catalog', { action: 'send' }]]) {
      assert.equal((await h.call(action, args)).code, 'INVALID_ARGUMENTS', action);
    }
    assert.deepEqual(h.records.listExecutions(), []);
  },
  async 'durable outcomes map to the original job and thread after restart'() {
    for (const [outcome, status] of [['completed', 'completed'], ['failed', 'failed'], ['interrupted', 'cancelled'],
      ['stopped', 'cancelled'], ['delivery_unknown', 'failed']]) {
      const h = fixture();
      const e = h.records.begin({ owner: 'th-0123456789', lead: { ...main, host: 'claude' }, provider: 'claude',
        cwd: h.dir, text: task, executionId: 'saved', now: h.clock.now() }, 0);
      h.records.writeResult({ ...e, outcome, text: 'saved output', detail: 'native detail', stopEvidence: { gone: true } });
      const response = await h.call('wait', { job_id: e.executionId });
      assert.deepEqual([response.thread, response.meta.thread, response.status, response.content], [e.owner, e.owner, status, 'saved output']);
      assert.equal(response.meta.detail, outcome === 'delivery_unknown' ? outcome : 'native detail');
    }
  },
};
for (const [name, scenario] of Object.entries(scenarios)) test(name, scenario);
