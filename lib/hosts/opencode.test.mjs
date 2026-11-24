import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOSTS } from './index.mjs';
import { setupController } from '../../test/controller/helpers.mjs';
import { createBridgeController, recoverController } from '../../bridge-server/tools.mjs';
import { toolAnswer } from '../../bridge-server/delivery.mjs';
import plugin from '../../opencode-plugin/server.js';

const host = HOSTS.opencode;
const lead = { host: 'opencode', session: 'ses_root', agent: null };

function cli() {
  const dir = mkdtempSync(join(SANDBOX_HOME, 'oc-'));
  const env = { PATH: dir, HOME: dir, XDG_STATE_HOME: join(dir, 'state'), TRACE: join(dir, 'argv') };
  const state = join(env.XDG_STATE_HOME, 'opencode');
  mkdirSync(state, { recursive: true });
  const service = pid => writeFileSync(join(state, 'service.json'), JSON.stringify({ pid }));
  service(process.ppid);
  writeFileSync(join(dir, 'opencode'), `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(process.env.TRACE, JSON.stringify(args) + '\\n');
if (args[1] === 'GET') console.log(JSON.stringify({
  data:{id:args[2].split('/').pop(), parentID:process.env.PARENT, location:{directory:process.cwd()}}
}));
`, { mode: 0o700 });
  return { env, service, calls: () => existsSync(env.TRACE)
    ? readFileSync(env.TRACE, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
}

test('root and child lead with their own MCP session id', () => {
  for (const session of ['ses_root', 'ses_child']) {
    assert.deepEqual(host.leadFromCall({ meta: { 'ai.opencode/sessionID': session } }), { ...lead, session });
  }
  for (const session of [undefined, null, 4, '', ' ', '${SESSION}', '{{session}}']) {
    assert.equal(host.leadFromCall({ meta: { 'ai.opencode/sessionID': session }, args: { lead } }), null);
  }
});

test('only a managed-service parent can prompt a root session', async () => {
  const { env, service, calls } = cli();
  service(process.pid);
  assert.deepEqual(await host.wakeStatus(lead, env), { wake: null, reason: 'private_server' });
  await host.wake(lead, 'private', env);
  assert.deepEqual(calls(), []);
  service(process.ppid);
  env.PARENT = 'ses_parent';
  assert.deepEqual(await host.wakeStatus(lead, env), { wake: null, reason: 'subagent' });
  await host.wake(lead, 'child', env);
  delete env.PARENT;
  assert.deepEqual(await host.wakeStatus(lead, env), { wake: 'opencode_prompt', reason: null });
  assert.deepEqual(await host.wakeStatus(lead, { ...env, PATH: '' }), { wake: null, reason: 'session_lookup_failed' });
  const notice = 'quote " and newline\n';
  assert.deepEqual(await host.wake(lead, notice, env), { wake: 'opencode_prompt', reason: 'prompt_api_returned' });
  assert.deepEqual(calls().filter(a => a[1] === 'POST'),
    [['api', 'POST', '/api/session/ses_root/prompt', '--data', JSON.stringify({ text: notice })]]);
});

test('plugin registers the Node launcher for a directory and skips companion jobs', async t => {
  const registered = [];
  const ctx = { location: { directory: '/work/repo' }, mcp: { transform: fn => fn({ set: (...args) => registered.push(args) }) } };
  const prior = process.env.AGENT_COMPANION_JOB;
  t.after(() => {
    if (prior === undefined) delete process.env.AGENT_COMPANION_JOB;
    else process.env.AGENT_COMPANION_JOB = prior;
  });
  delete process.env.AGENT_COMPANION_JOB;
  await plugin.setup(ctx);
  const [[name, config]] = registered;
  assert.equal(name, 'agent-bridge');
  assert.deepEqual(config.command, ['/bin/bash', join(import.meta.dirname, '../../hooks/launch-agent-bridge.sh')]);
  assert.equal(config.cwd, ctx.location.directory);
  assert.deepEqual(config.environment, { AGENT_COMPANION_HOST: 'opencode' });
  assert.equal(config.codemode, false);
  process.env.AGENT_COMPANION_JOB = 'a-job';
  await plugin.setup({ mcp: { transform: () => assert.fail('recursive registration') } });
});

test('each companion process receives its own job marker', async t => {
  const h = setupController({ createController: createBridgeController });
  t.mock.method(host, 'wake', async () => {});
  const a = await h.send({ thread: 'one', lead });
  const b = await h.send({ thread: 'two', lead });
  assert.deepEqual(h.adapters.map(ad => ad.calls[0][1].env.AGENT_COMPANION_JOB), [a.jobId, b.jobId]);
  assert.equal(h.controller.env.AGENT_COMPANION_JOB, undefined);
  await h.finish(a.jobId);
  await h.finish(b.jobId, undefined, h.adapters[1]);
});

test('one startup prompt per lead includes unread jobs and skips receipts and completed reads', async t => {
  const h = setupController({ createController: createBridgeController });
  t.mock.method(host, 'wakeStatus', async () => ({ wake: 'opencode_prompt', reason: null }));
  const wake = t.mock.method(host, 'wake', async () => {});
  const jobs = [];
  for (const thread of ['one', 'two', 'delivered', 'read']) {
    const { jobId } = await h.send({ thread, lead });
    await h.finish(jobId, undefined, h.adapters.at(-1));
    jobs.push(h.records.readResult(jobId));
  }
  toolAnswer(h.records, jobs[2]);
  h.records._write('reads', 'read', { job_id: jobs[3].jobId, generation: jobs[3].generation });
  wake.mock.resetCalls();
  await recoverController(h.controller);
  assert.equal(wake.mock.callCount(), 1);
  const [who, notice, , startup] = wake.mock.calls[0].arguments;
  assert.deepEqual(who, lead);
  assert.equal(startup, true);
  for (const [i, job] of jobs.entries()) assert.equal(notice.includes(job.jobId), i < 2);
  assert.ok(jobs.slice(0, 2).every(r => !existsSync(h.records.path('results', r.jobId) + '.delivery')));
  for (const r of jobs.slice(0, 2)) toolAnswer(h.records, r);
  await recoverController(h.controller);
  assert.equal(wake.mock.callCount(), 1);
});
