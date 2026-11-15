// Bridge EOF hands live work to the cleanup watcher. A replacement bridge
// reads the stopped result; it never adopts and continues the old native turn.
// Spends one Codex turn. This does not qualify uncatchable bridge SIGKILL.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, record, eventually } from './bridge-client.mjs';

const session = `orphan-${Date.now().toString(36)}`, owner = `${session}-child`;
const work = mkdtempSync(join(tmpdir(), 'agentco-orphan-'));
let first = await startBridge(session), second;
try {
  const sent = await first.tool('agent_send', { target: 'codex', cwd: work,
    task: 'Run `sleep 60` in the shell, wait for it to finish, then reply DONE.' }, owner);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  await eventually(async () => (await first.tool('agent_status', { job_id: sent.job_id })).active_command, 'active native command');
  const execution = record('executions', sent.job_id);
  assert.equal(execution.state, 'running');
  await first.stop(); first = null;
  const result = await eventually(() => record('results', sent.job_id), 'watcher cleanup result');
  assert.equal(result.cause, 'bridge_loss');
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.stopEvidence.gone, true);
  assert.deepEqual(result.stopEvidence.survivors, []);
  second = await startBridge(session);
  const final = await second.wait(sent.job_id, owner);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.meta.cause, 'bridge_loss');
  assert.equal(final.meta.native_refs.historyId, execution.historyId);
  assert.equal(final.content, result.text);
  const before = await second.readResource(final.meta.digest_uri);
  const status = await second.tool('agent_status', { job_id: sent.job_id });
  assert.deepEqual(status.interventions, { default: 'steer', steer: false, queue: false, interrupt: false });
  assert.equal(await second.readResource(final.meta.digest_uri), before);
  assert.deepEqual(record('results', sent.job_id), result);
  console.log('PASS: bridge-loss cleanup, verified exit, durable result and read-only replacement status');
} finally { await first?.stop(); await second?.stop(); }
