// Real Antigravity ACP through per-execution runtimes. Requires a signed-in
// server and a currently available model id as argv[2]. Spends five turns.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestPath } from '../../lib/prompt-digest.mjs';
import { startBridge, record, eventually } from './bridge-client.mjs';

const model = process.argv[2];
assert.ok(model, 'usage: node probes/smoke/acp-antigravity.mjs <available-model-id>');
const session = `agysmoke-${Date.now().toString(36)}`, owner = `${session}-child`;
const work = mkdtempSync(join(tmpdir(), 'agentco-antigravity-smoke-'));
writeFileSync(join(work, 'README.md'), '# smoke\nThe magic word is BANANA.\n');
let bridge = await startBridge(session), replacement;
const send = async (task, thread = owner, extra = {}) => {
  const response = await bridge.tool('agent_send', { target: 'antigravity', cwd: work, task, ...extra }, thread);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.job_id;
};
try {
  const firstId = await send('Read README.md and reply with ONLY the magic word.');
  const firstExecution = record('executions', firstId);
  assert.ok(firstExecution.historyId);
  const first = await bridge.wait(firstId, owner);
  assert.equal(first.status, 'completed', JSON.stringify(first));
  assert.match(first.content, /BANANA/i);
  assert.equal(first.meta.usage ?? null, null); // No fabricated usage counters.
  assert.equal(first.meta.stop_evidence.gone, true);
  assert.match(readFileSync(digestPath(firstId), 'utf8'), /BANANA/i);

  const secondId = await send('What magic word did you just report? Reply from memory; do not read any file.');
  const secondExecution = record('executions', secondId);
  assert.notEqual(secondExecution.processes.pid, firstExecution.processes.pid);
  const second = await bridge.wait(secondId, owner);
  assert.equal(second.status, 'completed');
  assert.equal(second.meta.native_refs.historyId, first.meta.native_refs.historyId);
  assert.match(second.content, /BANANA/i);

  const cancelOwner = `${session}-cancel`;
  const cancelId = await send('Run `sleep 60`, wait for it to finish, then reply FINISHED.', cancelOwner);
  const status = await bridge.tool('agent_status', { job_id: cancelId });
  assert.equal(status.status, 'running');
  assert.equal(status.reply_available, false);
  const reply = await bridge.tool('agent_reply', { job_id: cancelId, message: 'Reply PIVOT instead.' }, cancelOwner);
  assert.equal(reply.ok, false);
  assert.equal(reply.status, 'reply_unavailable');
  assert.equal(reply.reason, 'capability');
  const cancel = await bridge.tool('agent_cancel', { job_id: cancelId }, cancelOwner);
  assert.equal(cancel.status, 'cancelled');
  assert.equal(cancel.meta.stop_evidence.gone, true);

  const pinnedId = await send('Reply with ONLY the word PINNED.', `${session}-model`, { model });
  const pinned = await bridge.wait(pinnedId, `${session}-model`);
  assert.equal(pinned.status, 'completed', JSON.stringify(pinned));
  assert.equal(pinned.meta.selected_model, model);
  assert.equal(pinned.meta.effective_model, model);
  assert.match(pinned.content, /PINNED/);

  const lossOwner = `${session}-loss`;
  const lossId = await send('Run `sleep 60`, wait for it to finish, then reply DONE.', lossOwner);
  assert.equal((await bridge.tool('agent_status', { job_id: lossId })).status, 'running');
  await bridge.stop(); bridge = null;
  const result = await eventually(() => record('results', lossId), 'bridge-loss cleanup');
  assert.equal(result.cause, 'bridge_loss');
  assert.equal(result.stopEvidence.gone, true);
  replacement = await startBridge(session);
  const lost = await replacement.wait(lossId, lossOwner);
  assert.equal(lost.status, 'cancelled');
  assert.equal(lost.meta.cause, 'bridge_loss');
  console.log('PASS: Antigravity completion, cold history, steer refusal, cancel, model pin and bridge-loss cleanup');
} finally { await bridge?.stop(); await replacement?.stop(); }
