// Real Claude stream-json through the bridge. Budget four Haiku turns.
// Simulated owner metadata qualifies the controller/adapter, not host attribution.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTarget, lastTargetChecks } from '../../lib/target-diagnostics.mjs';
import { writeTargetChecks } from '../../lib/state.mjs';
import { startBridge, record, eventually } from './bridge-client.mjs';

const session = `claudesmoke-${Date.now().toString(36)}`, owner = `${session}-child`;
const work = mkdtempSync(join(tmpdir(), 'agentco-claude-smoke-'));
writeFileSync(join(work, 'README.md'), '# smoke\nThe magic word is BANANA.\n');
// Catalog is observational. Refresh only Claude's readiness using the shared
// parsed auth-status probe, then publish that evidence for the bridge to read.
const readiness = inspectTarget('claude');
writeTargetChecks(lastTargetChecks());
const bridge = await startBridge(session);
try {
  const catalog = await bridge.tool('agent_catalog', {});
  assert.equal(catalog.ok, true);
  const claude = catalog.targets.find((target) => target.id === 'claude');
  assert.ok(claude, 'catalog must list claude');
  assert.deepEqual(claude.capabilities, { reply: false, resume: true, cancel: true, modelSelection: true });
  assert.equal(claude.readiness.ready, readiness.ready);
  assert.ok(claude.readiness.checked_at);
  console.log('PASS: Claude catalog capabilities and parsed auth-status readiness');
  if (!readiness.ready || readiness.authenticated !== true) {
    console.log('SKIP: Claude is not ready or login is unverified; install claude and sign in, then rerun. No model work sent.');
  } else {
    // The invalid-model assertion is the sole exception to the Haiku pin.
    const refusal = await bridge.tool('agent_send', { target: 'claude', model: 'invalid model',
      cwd: work, task: 'noop' }, `${owner}-refusal`);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.code, 'MODEL_NOT_ALLOWED');
    console.log('PASS: Claude invalid model refused');

    const sent = await bridge.tool('agent_send', { target: 'claude', model: 'haiku', cwd: work,
      task: 'Read README.md and reply with ONLY the magic word it names.' }, owner);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.status, 'still_running');
    const firstExecution = record('executions', sent.job_id);
    assert.match(firstExecution.historyId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.ok(firstExecution.nativeTurnId);
    assert.ok(firstExecution.processes.pid > 0);
    const first = await bridge.wait(sent.job_id, owner);
    assert.equal(first.status, 'completed', JSON.stringify(first));
    assert.match(first.content, /BANANA/i);
    assert.equal(first.meta.stop_evidence.gone, true);
    assert.equal(first.meta.usage.source, 'claude-stream-json');
    assert.ok(first.meta.usage.input_tokens > 0 && first.meta.usage.output_tokens > 0);
    assert.ok(Object.hasOwn(first.meta.usage, 'cost'));
    assert.match(first.meta.effective_model, /^claude-/);
    console.log('PASS: Claude fresh send, native identity, usage, cost and verified exit');

    const followup = await bridge.tool('agent_send', { target: 'claude', model: 'haiku', cwd: work,
      task: 'What magic word did you just report? Reply from memory; do not read any file.' }, owner);
    assert.equal(followup.ok, true, JSON.stringify(followup));
    const secondExecution = record('executions', followup.job_id);
    assert.equal(secondExecution.historyId, firstExecution.historyId);
    assert.ok(secondExecution.processes.pid > 0);
    assert.notEqual(secondExecution.processes.pid, firstExecution.processes.pid);
    const second = await bridge.wait(followup.job_id, owner);
    assert.equal(second.status, 'completed', JSON.stringify(second));
    assert.match(second.content, /BANANA/i);
    assert.equal(second.meta.usage.source, 'claude-stream-json');
    assert.equal(Object.hasOwn(second.meta.usage, 'cost'), false);
    console.log('PASS: Claude cold follow-up recalls history in a new process with usage and no cost');

    const cancelOwner = `${session}-cancel`;
    const long = await bridge.tool('agent_send', { target: 'claude', model: 'haiku', cwd: work,
      task: 'Write a 1500-word essay about the history of mathematics. Do not use any tools.' }, cancelOwner);
    assert.equal(long.ok, true, JSON.stringify(long));
    assert.equal(long.status, 'still_running');
    assert.equal((await bridge.tool('agent_status', { job_id: long.job_id })).status, 'running');
    const reply = await bridge.tool('agent_reply', { job_id: long.job_id, message: 'Reply PIVOT instead.' }, cancelOwner);
    assert.equal(reply.ok, false);
    assert.equal(reply.status, 'reply_unavailable');
    assert.equal(reply.reason, 'capability');
    const cancel = await bridge.tool('agent_cancel', { job_id: long.job_id }, cancelOwner);
    assert.equal(cancel.status, 'cancelled', JSON.stringify(cancel));
    assert.equal(cancel.meta.stop_evidence.gone, true);
    console.log('PASS: Claude running reply refused and cancellation verified gone');

    // The adapter strips CLAUDE_CONFIG_DIR; inspect native storage read-only.
    // Neither transcripts nor the temporary workspace are removed by this probe.
    const projects = join(process.env.HOME || homedir(), '.claude', 'projects');
    await eventually(() => readdirSync(projects, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() && existsSync(join(projects, entry.name, `${firstExecution.historyId}.jsonl`))),
    'Claude native transcript');
    console.log('PASS: Claude native transcript present (read-only check)');
  }
} finally { await bridge.stop(); }
