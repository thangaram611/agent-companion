// Real Claude stream-json through the bridge. Budget four Haiku turns.
// Simulated owner metadata qualifies the controller/adapter, not host attribution.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCompanion, lastCompanionChecks } from '../../lib/companion-diagnostics.mjs';
import { writeCompanionChecks } from '../../lib/state.mjs';
import { startBridge, record, eventually } from './bridge-client.mjs';

const session = `claudesmoke-${Date.now().toString(36)}`, owner = `${session}-child`;
const work = mkdtempSync(join(tmpdir(), 'agentco-claude-smoke-'));
writeFileSync(join(work, 'README.md'), '# smoke\nThe magic word is BANANA.\n');
// Catalog is observational. Refresh only Claude's readiness using the shared
// parsed auth-status probe, then publish that evidence for the bridge to read.
const readiness = inspectCompanion('claude');
writeCompanionChecks(lastCompanionChecks());
const bridge = await startBridge(session);
try {
  const catalog = await bridge.tool('companion_catalog', {});
  assert.equal(catalog.ok, true);
  const claude = catalog.companions.find((companion) => companion.id === 'claude');
  assert.ok(claude, 'catalog must list claude');
  assert.deepEqual(claude.capabilities, {
    interventions: { default: 'queue', steer: false, queue: 'native', interrupt: true },
    resume: true, cancel: true, modelSelection: true, effortSelection: true,
  });
  assert.equal(claude.readiness.ready, readiness.ready);
  assert.ok(claude.readiness.checked_at);
  console.log('PASS: Claude catalog capabilities and parsed auth-status readiness');
  if (!readiness.ready || readiness.authenticated !== true) {
    console.log('SKIP: Claude is not ready or login is unverified; install claude and sign in, then rerun. No model work sent.');
  } else {
    // The invalid-model assertion is the sole exception to the Haiku pin.
    const refusal = await bridge.tool('companion_send', { companion: 'claude', model: 'invalid model',
      cwd: work, task: 'noop' }, `${owner}-refusal`);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.code, 'MODEL_NOT_ALLOWED');
    console.log('PASS: Claude invalid model refused');

    const sent = await bridge.tool('companion_send', { companion: 'claude', model: 'haiku', cwd: work,
      task: 'Read README.md and reply with ONLY the magic word it names.' }, owner);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.status, 'still_running');
    const firstJob = record('jobs', sent.job_id);
    assert.match(firstJob.historyId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.ok(firstJob.nativeTurnId);
    assert.ok(firstJob.processes.pid > 0);
    const first = await bridge.wait(sent.job_id, owner);
    assert.equal(first.status, 'completed', JSON.stringify(first));
    assert.match(first.content, /BANANA/i);
    assert.equal(first.meta.stop_evidence.gone, true);
    assert.equal(first.meta.usage.source, 'claude-stream-json');
    assert.ok(first.meta.usage.input_tokens > 0 && first.meta.usage.output_tokens > 0);
    assert.ok(Object.hasOwn(first.meta.usage, 'cost'));
    assert.match(first.meta.effective_model, /^claude-/);
    console.log('PASS: Claude fresh send, native identity, usage, cost and verified exit');

    const followup = await bridge.tool('companion_send', { thread: sent.thread,
      task: 'What magic word did you just report? Reply from memory; do not read any file.' }, owner);
    assert.equal(followup.ok, true, JSON.stringify(followup));
    const secondJob = record('jobs', followup.job_id);
    assert.equal(secondJob.historyId, firstJob.historyId);
    assert.ok(secondJob.processes.pid > 0);
    assert.notEqual(secondJob.processes.pid, firstJob.processes.pid);
    const second = await bridge.wait(followup.job_id, owner);
    assert.equal(second.status, 'completed', JSON.stringify(second));
    assert.match(second.content, /BANANA/i);
    assert.equal(second.meta.usage.source, 'claude-stream-json');
    assert.equal(Object.hasOwn(second.meta.usage, 'cost'), false);
    console.log('PASS: Claude cold follow-up recalls history in a new process with usage and no cost');

    const cancelOwner = `${session}-cancel`;
    const long = await bridge.tool('companion_send', { companion: 'claude', model: 'haiku', cwd: work,
      task: 'Write a 1500-word essay about the history of mathematics. Do not use any tools.' }, cancelOwner);
    assert.equal(long.ok, true, JSON.stringify(long));
    assert.equal(long.status, 'still_running');
    assert.equal((await bridge.tool('companion_status', { job_id: long.job_id }, cancelOwner)).status, 'running');
    const reply = await bridge.tool('companion_send', { thread: long.thread, task: 'Reply PIVOT instead.' }, cancelOwner);
    assert.equal(reply.ok, false);
    assert.equal(reply.status, 'reply_unavailable');
    assert.equal(reply.reason, 'capability');
    const cancel = await bridge.tool('companion_cancel', { job_id: long.job_id }, cancelOwner);
    assert.equal(cancel.status, 'cancelled', JSON.stringify(cancel));
    assert.equal(cancel.meta.stop_evidence.gone, true);
    console.log('PASS: Claude running reply refused and cancellation verified gone');

    // The adapter strips CLAUDE_CONFIG_DIR; inspect native storage read-only.
    // Neither transcripts nor the temporary workspace are removed by this probe.
    const projects = join(process.env.HOME || homedir(), '.claude', 'projects');
    await eventually(() => readdirSync(projects, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() && existsSync(join(projects, entry.name, `${firstJob.historyId}.jsonl`))),
    'Claude native transcript');
    console.log('PASS: Claude native transcript present (read-only check)');
  }
} finally { await bridge.stop(); }
