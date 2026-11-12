// Hand-run, token-spending probe. Importing it runs nothing; tests inject a bridge.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const targets = ['claude', 'codex', 'opencode', 'antigravity', 'copilot'];
const reportedEffort = new Set(['codex', 'opencode', 'antigravity']);
const invalidEffort = '__unsupported_effort_probe__';

export async function runEffortProbe({ bridge, target, model, cwd, owner, record, report = console.log }) {
  let step = 'a: unsupported effort refuses before delivery';
  try {
    assert.ok(targets.includes(target), `Unknown target: ${target}`);
    const catalog = await bridge.tool('agent_catalog', {});
    const entry = catalog.targets?.find(t => t.id === target);
    assert.equal(entry?.effort.selection, true, 'catalog must advertise effort selection');
    const selection = { target, cwd, ...(model ? { model } : {}) };
    const refusal = await bridge.tool('agent_send', { ...selection, effort: invalidEffort, task: 'Reply with exactly: OK' }, `${owner}-refusal`);
    if (refusal.status === 'still_running') await bridge.tool('agent_cancel', { job_id: refusal.job_id }, `${owner}-refusal`);
    assert.equal(refusal.code ?? refusal.meta?.detail, 'EFFORT_NOT_ALLOWED', JSON.stringify(refusal));
    assert.notEqual(refusal.status, 'still_running');
    assert.ok(!refusal.meta?.native_refs?.nativeTurnId, 'refusal must have no native turn');
    if (refusal.job_id) {
      const execution = record('executions', refusal.job_id);
      assert.ok(execution, 'refused execution must be recorded');
      assert.ok(!execution.nativeTurnId, 'refusal must precede delivery');
    }
    const listed = (refusal.hint ?? refusal.content ?? '').match(/Use one of: (.*?), or omit/i)?.[1];
    const levels = entry.effort.levels ?? listed?.split(',').map(v => v.trim());
    assert.ok(levels?.length && !levels.includes(invalidEffort), 'refusal must name the offered levels');
    assert.ok(levels.every(level => order.includes(level)), 'unknown level ordering; update the probe before spending tokens');
    const effort = order.find(level => levels.includes(level));
    report(`PASS ${step}; offered: ${levels.join(', ')}`);

    const send = async (args) => {
      const sent = await bridge.tool('agent_send', args, owner);
      assert.equal(sent.ok, true, JSON.stringify(sent));
      const result = sent.status === 'still_running' ? await bridge.wait(sent.job_id, owner) : sent;
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.content.trim(), 'OK');
      assert.equal((sent.meta ?? sent).selected_effort, effort);
      assert.equal(result.meta.selected_effort, effort);
      if (reportedEffort.has(target) || result.meta.effective_effort != null) assert.equal(result.meta.effective_effort, effort);
      const effective = result.meta.effective_model;
      if (target !== 'copilot') assert.ok(effective, 'provider must report the effective model');
      if (model) {
        assert.equal(result.meta.selected_model, model);
        if (target === 'opencode') {
          assert.equal(`${effective.providerID}/${effective.id}`, model.split('#')[0]);
          assert.equal(typeof effective.variant, 'string');
        } else if (target === 'antigravity') {
          const family = model.replace(new RegExp(`-(${order.join('|')})$`), '');
          assert.equal(effective, `${family}-${effort}`);
        } else if (target === 'claude' && ['haiku', 'sonnet', 'opus'].includes(model)) {
          assert.ok(effective.includes(model), 'reported model must match the selected alias');
        } else if (effective != null) assert.equal(effective, model);
      }
      const execution = record('executions', sent.job_id);
      assert.ok(execution?.historyId && execution.processes?.pid > 0, 'native history and process identity required');
      assert.equal(result.meta.stop_evidence?.gone, true, 'runtime must exit before cold follow-up');
      return { result, execution };
    };
    step = `b: lowest offered effort (${effort}) reaches the provider`;
    const first = await send({ ...selection, effort, task: 'Reply with exactly: OK' });
    report(`PASS ${step}; effective effort: ${first.result.meta.effective_effort ?? 'not reported'}`);
    step = 'c: cold follow-up omits effort and retains the selection';
    if (target === 'copilot') {
      report(`SKIP ${step}; Copilot cold follow-up is unsupported and out of scope`);
      return;
    }
    const second = await send({ target, cwd, task: 'Reply with exactly: OK' });
    assert.equal(second.execution.historyId, first.execution.historyId);
    assert.notEqual(second.execution.processes.pid, first.execution.processes.pid);
    assert.deepEqual(second.result.meta.effective_model, first.result.meta.effective_model);
    assert.equal(second.result.meta.effective_effort, first.result.meta.effective_effort);
    report(`PASS ${step}`);
  } catch (err) {
    report(`FAIL ${step}: ${err.message}`);
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, model] = process.argv.slice(2);
  assert.ok(targets.includes(target), 'Usage: node probes/smoke/effort.mjs <claude|codex|opencode|antigravity|copilot> [model]');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startBridge, record } = await import('./bridge-client.mjs');
  const { inspectTarget, lastTargetChecks } = await import('../../lib/target-diagnostics.mjs');
  const { writeTargetChecks } = await import('../../lib/state.mjs');
  const readiness = inspectTarget(target);
  writeTargetChecks(lastTargetChecks());
  assert.ok(readiness.ready, `${target} is not ready; no model work sent`);
  const session = `effort-${target}-${Date.now().toString(36)}`;
  const bridge = await startBridge(session);
  try {
    await runEffortProbe({ bridge, target, model, cwd: mkdtempSync(join(tmpdir(), 'agentco-effort-')), owner: `${session}-child`, record });
  } finally { await bridge.stop(); }
}
