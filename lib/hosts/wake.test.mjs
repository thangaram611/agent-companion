import '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { setupController, until } from '../../test/controller/helpers.mjs';
import { dispatch, createBridgeController, recoverController } from '../../bridge-server/tools.mjs';
import { decodeTool } from '../../test/tool-call.mjs';
import { wakeNotice } from '../../bridge-server/delivery.mjs';

function bridge(host) {
  const env = { HOME: process.env.HOME, AGENT_RUNTIME_DIR: process.env.AGENT_RUNTIME_DIR, PATH: '' };
  const h = setupController({ createController: createBridgeController, companion: 'claude', env });
  const call = async (action, args, agent = null) => decodeTool(await dispatch({
    name: 'companion_' + action, arguments: { ...args, lead: { session: 'main', agent } },
    _meta: { 'x-codex-turn-metadata': { session_id: 'main', thread_source: agent ? 'subagent' : 'user', thread_id: agent ?? 'main' } },
  }, { controller: h.controller, host }));
  const send = (agent, thread) => call('send', { companion: 'claude', task: 'task', cwd: h.dir, ...(thread && { thread }) }, agent);
  const finish = job => h.finish(job.job_id, { outcome: 'completed', text: 'answer' }, h.adapters.at(-1));
  return { ...h, env, call, send, finish };
}
const delivery = (wake, reason = null) => ({ wake, reason, fallback: 'companion_wait' });

test('Claude wakes only the idle current main conversation, once per result', async t => {
  const h = bridge('claude');
  const socket = join(process.env.HOME, 'inbox.sock'), lines = [];
  const server = createServer(peer => { let text = ''; peer.setEncoding('utf8').on('data', c => { text += c; }).on('end', () => lines.push(text)); });
  server.listen(socket);
  await once(server, 'listening');
  t.after(() => server.close());
  Object.assign(h.env, { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: 'fixture-token', CLAUDE_CODE_SESSION_ID: 'inherited-and-wrong' });
  const start = session => execFileSync(process.execPath, [join(import.meta.dirname, '../../hooks/hook.mjs'), 'session-start'], {
    env: { ...process.env, ...h.env, AGENT_COMPANION_HOME: h.dir, AGENT_COMPANION_HOST: 'claude' }, input: JSON.stringify({ session_id: session }) });
  start('main');
  const path = join(h.env.AGENT_RUNTIME_DIR, 'sessions', createHash('sha256').update(socket).digest('hex') + '.json');
  assert.deepEqual(JSON.parse(readFileSync(path)), { socket, session: 'main', at: JSON.parse(readFileSync(path)).at });
  assert.deepEqual([statSync(path).mode & 0o777, statSync(dirname(path)).mode & 0o777], [0o600, 0o700]);
  const job = async (agent, expected, thread) => {
    const sent = await h.send(agent, thread);
    assert.deepEqual(sent.delivery, expected);
    return sent;
  };
  const enabled = delivery('inbox_socket'), stale = await job(null, enabled);
  start('after-clear');
  await h.finish(stale);
  await h.finish(await job(null, delivery(null, 'session_changed')));
  start('main');
  await h.finish(await job('child', delivery(null, 'subagent')));
  delete h.env.CLAUDE_CODE_MESSAGING_TOKEN;
  await h.finish(await job(null, delivery(null, 'missing_token')));
  h.env.CLAUDE_CODE_MESSAGING_TOKEN = 'fixture-token';
  // A pending wait returns the result itself: no wake.
  const waiting = await job(null, enabled), wait = h.call('wait', { thread: waiting.thread });
  await h.finish(waiting);
  assert.equal((await wait).content, 'answer');
  const received = [];
  for (let i = 0; i < 2; i++) { received.push(await job(null, enabled, received[0]?.thread)); await h.finish(received[i]); }
  await recoverController(h.controller);
  await until(() => lines.length >= 2);
  // Exactly two frames, auth then user, each naming its job and how to read it; a wake claims nothing.
  assert.deepEqual(lines.map(frame => frame.split('\n').map(line => line && JSON.parse(line))), received.map(sent => [
    { type: 'auth', token: 'fixture-token' }, { type: 'user', message: { role: 'user', content: wakeNotice(h.records.readJob(sent.job_id), h.records.readResult(sent.job_id)) } }, '']));
  assert.deepEqual(readdirSync(join(h.env.AGENT_RUNTIME_DIR, 'news')), ['main']);
  assert.ok(received.every(sent => !existsSync(h.records.path('results', sent.job_id) + '.delivery')));
});

test('Codex queues the root thread through its own PATH and environment', async () => {
  const h = bridge('codex');
  const trace = join(h.dir, 'queue.jsonl');
  Object.assign(h.env, { PATH: h.dir, CODEX_HOME: join(h.dir, 'custom home'), WAKE_TRACE: trace });
  writeFileSync(join(h.dir, 'codex'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.WAKE_TRACE, JSON.stringify([process.env.CODEX_HOME, ...process.argv.slice(2)]) + '\\n')\n`, { mode: 0o700 });
  const child = await h.send('child');
  assert.deepEqual(child.delivery, delivery(null, 'subagent'));
  await h.finish(child);
  const root = await h.send();
  assert.deepEqual(root.delivery, delivery('codex_queue'));
  await h.finish(root);
  await until(() => existsSync(trace) && readFileSync(trace, 'utf8').endsWith('\n'));
  const [home, ...args] = JSON.parse(readFileSync(trace, 'utf8'));
  assert.equal(home, h.env.CODEX_HOME);
  assert.deepEqual(args.slice(0, -1), ['queue', '--thread', 'main', '--message']);
  assert.ok(args.at(-1).includes(root.thread) && args.at(-1).includes(root.job_id));
  assert.equal((await h.call('status')).threads[0].unread, 1);
  assert.equal((await h.call('wait', { thread: root.thread })).content, 'answer');
});
