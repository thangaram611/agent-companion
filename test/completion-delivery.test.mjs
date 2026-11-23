import './sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { setupController, until } from './controller/helpers.mjs';
import { createBridgeController } from '../bridge-server/tools.mjs';
import { callTool } from './tool-call.mjs';

async function withQueuedResult(t, checkDelivery) {
  const h = setupController({ createController: createBridgeController, provider: 'codex' });
  const owner = 'native-child';
  const lead = { session: 'delivery-session', agent: owner };
  const session = lead.session;
  const call = async (args, request) => (await callTool({ ...args, lead }, { controller: h.controller, ...request })).structuredContent;
  const queue = join(h.dir, 'completions.jsonl');
  const previous = process.env.AGENT_QUEUE_PATH;
  process.env.AGENT_QUEUE_PATH = queue;
  t.after(() => { if (previous === undefined) delete process.env.AGENT_QUEUE_PATH; else process.env.AGENT_QUEUE_PATH = previous; });
  const { job_id } = await call({ action: 'send', cwd: h.dir, task: 'task', target: 'codex' });
  const wait = request => call({ action: 'wait', job_id }, request);
  const cancel = () => call({ action: 'cancel', job_id });
  const answer = `Terminal answer for delivery test ${job_id}.`;
  h.adapters[0].terminal.resolve({ outcome: 'completed', text: answer, usage: { input_tokens: 13, output_tokens: 7 } });
  await until(() => h.records.readResult(job_id), 'terminal result between waits');
  const row = readFileSync(queue, 'utf8').trim().split('\n').map(JSON.parse).find(row => row.jobId === job_id);
  assert.ok(row, 'expected a queued completion for the finished job');
  assert.equal(row.consumed, false);
  assert.equal(row.claudeSessionId, session);

  const status = await call({ action: 'status', job_id });
  assert.equal(status.partial_text, answer);
  assert.equal(existsSync(row.receiptPath), false, 'status leaves the result available for delivery');

  const drain = async (fields = {}, env = {}) => {
    const script = fileURLToPath(new URL('../hooks/drain-completions.sh', import.meta.url));
    const run = promisify(execFile)('bash', [script], {
      env: { ...process.env, AGENT_COMPANION_HOST: 'claude', AGENT_QUEUE_PATH: queue,
        AGENT_RUNTIME_DIR: process.env.AGENT_RUNTIME_DIR, AGENT_HEARTBEAT_DIR: join(process.env.AGENT_RUNTIME_DIR, 'heartbeats'), ...env },
      // Bound fixture I/O under full-suite contention. The manifests own the host deadline.
      encoding: 'utf8', timeout: 30_000,
    });
    run.child.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, ...fields }));
    const { stdout, stderr } = await run;
    assert.equal(stderr, '');
    return stdout.trim() ? JSON.parse(stdout).hookSpecificOutput.additionalContext : '';
  };
  await checkDelivery({ wait, cancel, drain, answer, owner, queue, row, resultPath: h.records.path('results', job_id) });
}

for (const context of ['session', 'owner subagent']) {
  test(`completion delivery: ${context} drain before agent_wait delivers the terminal text once`, async t => {
    await withQueuedResult(t, async ({ wait, cancel, drain, answer, owner, row, resultPath }) => {
      const injected = await drain(context === 'owner subagent' ? { agent_id: owner } : {});
      const response = await wait();
      const hookCopies = injected.split(answer).length - 1;
      const waitCopies = (response.content ?? '').split(answer).length - 1;
      assert.equal(hookCopies + waitCopies, 1, `terminal text copies: PostToolUse=${hookCopies}, agent_wait=${waitCopies}`);
      assert.equal(hookCopies, 1);
      assert.equal(response.status, 'completed');
      assert.match(response.content, /already delivered to this session by the completion hook/i);
      assert.equal(response.content.split('\n').length, 1);
      assert.ok(response.content.includes(resultPath));
      assert.equal(response.meta.result_path, resultPath);
      assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).text, answer);
      assert.deepEqual(response.meta, { ...row.meta, delivered_by: 'hook', result_path: resultPath });
      assert.equal(response.meta.digest_uri, `agent-digest://${row.jobId}`);
      assert.deepEqual(await cancel(), { ...response, action: 'cancel' });
      assert.equal(statSync(row.receiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(row.receiptPath)).mode & 0o777, 0o700);
    });
  });
}

test('completion delivery: agent_wait before the drain returns the terminal text and the drain is silent', async t => {
  await withQueuedResult(t, async ({ wait, drain, answer }) => {
    const first = await wait();
    assert.equal(first.content, answer);
    assert.equal(await drain(), '');
    assert.deepEqual(await wait(), first);
  });
});

test('completion delivery: an aborted wait leaves the result available to the hook', async t => {
  await withQueuedResult(t, async ({ wait, drain, answer, row }) => {
    await wait({ signal: AbortSignal.abort() });
    assert.equal(existsSync(row.receiptPath), false);
    assert.ok((await drain()).includes(answer));
  });
});

test('completion delivery: terminal cancel claims for the owner', async t => {
  await withQueuedResult(t, async ({ wait, cancel, drain, answer, row }) => {
    const result = await cancel();
    assert.equal(result.content, answer);
    assert.equal(statSync(row.receiptPath).mode & 0o777, 0o600);
    assert.equal(await drain(), '');
    assert.deepEqual(await wait(), { ...result, action: 'wait' });
  });
});

test('completion delivery: owner and drain competing for the same queue snapshot have one winner', async t => {
  await withQueuedResult(t, async ({ wait, drain, answer, queue, row }) => {
    const draining = drain({}, { DEBUG_DRAIN_DELAY: '1' });
    // The hook now owns a snapshot that an owner cannot mark consumed.
    const snapshotTaken = () => readdirSync(dirname(queue)).some(name => name.startsWith('completions.jsonl.drain.'));
    const [injected, result] = await Promise.all([draining, (async () => {
      await until(snapshotTaken, 'drain move-aside');
      return wait();
    })()]);
    assert.equal(Number(injected.includes(answer)) + Number(result.content === answer), 1);
    assert.ok(existsSync(row.receiptPath));
  });
});
