// Real Antigravity ACP through per-execution runtimes. Requires a signed-in
// agy CLI (1.5+) and a currently available model id as argv[2]. Starts seven jobs.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, record, eventually } from './bridge-client.mjs';

const model = process.argv[2];
assert.ok(model, 'usage: node probes/smoke/acp-antigravity.mjs <available-model-id>');
const session = `agysmoke-${Date.now().toString(36)}`, owner = `${session}-child`;
const work = mkdtempSync(join(tmpdir(), 'agentco-antigravity-smoke-'));
writeFileSync(join(work, 'README.md'), '# smoke\nThe magic word is BANANA.\n');
let bridge = await startBridge(session), replacement;
const send = async (task, lead = owner, extra = {}) => {
  const response = await bridge.tool('companion_send', { companion: 'antigravity', cwd: work, task, ...extra }, lead);
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
  assert.equal(first.meta.usage.source, 'antigravity-acp');
  assert.ok(first.meta.usage.input_tokens > 0 && first.meta.usage.output_tokens > 0);
  assert.equal(first.meta.stop_evidence.gone, true);
  assert.match(await bridge.readResource(first.meta.digest_uri), /BANANA/i);

  const secondId = await send('What magic word did you just report? Reply from memory; do not read any file.', owner, { thread: first.thread });
  const secondExecution = record('executions', secondId);
  assert.notEqual(secondExecution.processes.pid, firstExecution.processes.pid);
  const second = await bridge.wait(secondId, owner);
  assert.equal(second.status, 'completed');
  assert.equal(second.meta.native_refs.historyId, first.meta.native_refs.historyId);
  assert.match(second.content, /BANANA/i);

  const steerOwner = `${session}-steer`;
  const steerId = await send('Run `sleep 15` with run_command. After it finishes, reply with exactly the word ORBIT.', steerOwner);
  const status = await eventually(async () => {
    const status = await bridge.tool('companion_status', { job_id: steerId }, steerOwner);
    assert.equal(status.status, 'running', JSON.stringify(status));
    return status.active_command && status;
  }, 'active command before steer', 120_000);
  assert.deepEqual(status.interventions, { default: 'steer', steer: true, queue: true, interrupt: true });
  const reply = await bridge.tool('companion_send', { thread: status.thread, task: 'Also append the word LUNAR after the original word, separated by a space.' }, steerOwner);
  assert.equal(reply.accepted, true, JSON.stringify(reply));
  const steered = await bridge.wait(steerId, steerOwner);
  assert.equal(steered.status, 'completed', JSON.stringify(steered));
  assert.match(steered.content, /\bORBIT LUNAR\s*$/);

  const cancelOwner = `${session}-cancel`;
  const cancelId = await send('Run `sleep 60`, wait for it to finish, then reply FINISHED.', cancelOwner);
  assert.equal((await bridge.tool('companion_status', { job_id: cancelId }, cancelOwner)).status, 'running');
  const cancel = await bridge.tool('companion_cancel', { job_id: cancelId }, cancelOwner);
  assert.equal(cancel.status, 'cancelled');
  assert.equal(cancel.meta.stop_evidence.gone, true);

  const backgroundOwner = `${session}-background`;
  const backgroundId = await send('Run exactly `sleep 20 && echo SLEPT > slept.txt` with run_command, WaitMsBeforeAsync 500 and IsDaemon false. After the command finishes, reply with only the word RESTED.', backgroundOwner);
  const background = await bridge.wait(backgroundId, backgroundOwner);
  assert.equal(background.status, 'completed', JSON.stringify(background));
  assert.match(background.content, /\bRESTED\s*$/);
  assert.equal(readFileSync(join(work, 'slept.txt'), 'utf8'), 'SLEPT\n');
  // The model either ends the prompt early (the bridge keeps the turn open, usage partial) or polls inside it.
  console.log(`background reply: ${background.meta.usage?.partial ? 'turn kept open after end_turn' : 'model waited inside the prompt'}`);

  const pinnedId = await send('Reply with ONLY the word PINNED.', `${session}-model`, { model });
  const pinned = await bridge.wait(pinnedId, `${session}-model`);
  assert.equal(pinned.status, 'completed', JSON.stringify(pinned));
  assert.equal(pinned.meta.selected_model, model);
  assert.equal(pinned.meta.effective_model, model);
  assert.match(pinned.content, /PINNED/);

  const lossOwner = `${session}-loss`;
  const lossId = await send('Run `sleep 60`, wait for it to finish, then reply DONE.', lossOwner);
  assert.equal((await bridge.tool('companion_status', { job_id: lossId }, lossOwner)).status, 'running');
  await bridge.stop(); bridge = null;
  const result = await eventually(() => record('results', lossId), 'bridge-loss cleanup');
  assert.equal(result.cause, 'bridge_loss');
  assert.equal(result.stopEvidence.gone, true);
  replacement = await startBridge(session);
  const lost = await replacement.wait(lossId, lossOwner);
  assert.equal(lost.status, 'cancelled');
  assert.equal(lost.meta.cause, 'bridge_loss');
  console.log('PASS: Antigravity completion, cold history, native steer, cancel, background reply, model pin and bridge-loss cleanup');
} finally { await bridge?.stop(); await replacement?.stop(); }
