// Hand-run, token-spending probe. Importing it runs nothing; tests inject a bridge.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const companions = ['claude', 'codex', 'opencode', 'antigravity', 'copilot'];
const reportedEffort = new Set(['codex', 'opencode', 'antigravity', 'copilot']);
const invalidEffort = '__unsupported_effort_probe__';

export async function runEffortProbe({ bridge, companion, model, cwd, owner, record, report = console.log, readWire, backendEffort }) {
  let step = backendEffort ? 'a: backend rejects unsupported effort' : 'a: unsupported effort refuses before delivery';
  try {
    assert.ok(companions.includes(companion), `Unknown companion: ${companion}`);
    assert.ok(!backendEffort || companion === 'codex', 'backend-validated effort mode is only for unlisted Codex models');
    const wire = { codex: ['/v1/responses', row => row.reasoning?.effort], claude: ['/v1/messages', row => row.output_config?.effort],
      copilot: ['/v1/chat/completions', row => row.reasoning_effort] }[companion];
    const checkpoint = () => readWire?.().length ?? 0;
    const checkWire = (offset, effort) => {
      if (!readWire) return;
      assert.ok(wire, 'wire verification is available for Codex, Claude and Copilot');
      const requests = readWire().slice(offset).filter(row => row.path === wire[0]);
      if (effort === undefined) { assert.equal(requests.length, 0, 'refusal must send no model request'); return; }
      assert.ok(requests.length, 'turn must have a fresh proxy request');
      for (const row of requests) assert.equal(wire[1](row), effort, 'wire effort must match this turn');
    };
    const catalog = await bridge.tool('companion_catalog', {});
    const entry = catalog.companions?.find(t => t.id === companion);
    assert.equal(entry?.effort.selection, true, 'catalog must advertise effort selection');
    const selection = { companion, cwd, ...(model ? { model } : {}) };
    const offset = checkpoint();
    let refusal = await bridge.tool('companion_send', { ...selection, effort: invalidEffort, task: 'Reply with exactly: OK' }, `${owner}-refusal`);
    if (backendEffort) {
      if (refusal.status === 'still_running') refusal = await bridge.wait(refusal.job_id, `${owner}-refusal`);
      assert.equal(refusal.status, 'failed');
      assert.equal(refusal.meta?.cause, 'companion_error');
      assert.match(refusal.content, /invalid reasoning value/i);
      assert.equal(refusal.meta.stop_evidence?.gone, true);
      checkWire(offset, invalidEffort);
    } else {
      if (refusal.status === 'still_running') await bridge.tool('companion_cancel', { job_id: refusal.job_id }, `${owner}-refusal`);
      assert.equal(refusal.code ?? refusal.meta?.detail, 'EFFORT_NOT_ALLOWED', JSON.stringify(refusal));
      assert.notEqual(refusal.status, 'still_running');
      assert.ok(!refusal.meta?.native_refs?.nativeTurnId, 'refusal must have no native turn');
      if (refusal.job_id) {
        const job = record('jobs', refusal.job_id);
        assert.ok(job, 'refused job must be recorded');
        assert.ok(!job.nativeTurnId, 'refusal must precede delivery');
      }
      checkWire(offset);
    }
    const listed = (refusal.hint ?? refusal.content ?? '').match(/Use one of: (.*?), or omit/i)?.[1];
    const levels = backendEffort ? [backendEffort] : entry.effort.levels ?? listed?.split(',').map(v => v.trim());
    assert.ok(levels?.length && !levels.includes(invalidEffort), 'refusal must name the offered levels');
    assert.ok(levels.every(level => order.includes(level)), 'unknown level ordering; update the probe before spending tokens');
    const effort = order.find(level => levels.includes(level));
    report(`PASS ${step}; ${backendEffort ? 'levels unverified for models outside Codex\'s catalog; probe effort' : 'offered'}: ${levels.join(', ')}`);

    const send = async (args) => {
      const offset = checkpoint();
      const sent = await bridge.tool('companion_send', args, owner);
      assert.equal(sent.ok, true, JSON.stringify(sent));
      const result = sent.status === 'still_running' ? await bridge.wait(sent.job_id, owner) : sent;
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.content.trim(), 'OK');
      assert.equal((sent.meta ?? sent).selected_effort, effort);
      assert.equal(result.meta.selected_effort, effort);
      if (reportedEffort.has(companion) || result.meta.effective_effort != null) assert.equal(result.meta.effective_effort, effort);
      const effective = result.meta.effective_model;
      if (companion !== 'copilot') assert.ok(effective, 'provider must report the effective model');
      if (model) {
        assert.equal(result.meta.selected_model, model);
        if (companion === 'opencode') {
          assert.equal(`${effective.providerID}/${effective.id}`, model.split('#')[0]);
          assert.equal(typeof effective.variant, 'string');
        } else if (companion === 'claude' && ['haiku', 'sonnet', 'opus'].includes(model)) {
          assert.ok(effective.includes(model), 'reported model must match the selected alias');
        } else if (effective != null) assert.equal(effective, model);
      }
      const job = record('jobs', sent.job_id);
      assert.ok(job?.historyId && job.processes?.pid > 0, 'native history and process identity required');
      assert.equal(result.meta.stop_evidence?.gone, true, 'runtime must exit before cold follow-up');
      checkWire(offset, effort);
      return { result, job, thread: sent.thread };
    };
    step = `b: ${backendEffort ? 'selected' : 'lowest offered'} effort (${effort}) reaches the provider`;
    const first = await send({ ...selection, effort, task: 'Reply with exactly: OK' });
    report(`PASS ${step}; effective effort: ${first.result.meta.effective_effort ?? 'not reported'}`);
    step = 'c: cold follow-up omits effort and retains the selection';
    if (companion === 'copilot') {
      report(`SKIP ${step}; Copilot cold follow-up is unsupported and out of scope`);
      return;
    }
    const second = await send({ thread: first.thread, task: 'Reply with exactly: OK' });
    assert.equal(second.job.historyId, first.job.historyId);
    assert.notEqual(second.job.processes.pid, first.job.processes.pid);
    assert.deepEqual(second.result.meta.effective_model, first.result.meta.effective_model);
    assert.equal(second.result.meta.effective_effort, first.result.meta.effective_effort);
    report(`PASS ${step}`);
  } catch (err) {
    report(`FAIL ${step}: ${err.message}`);
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [companion, model] = process.argv.slice(2);
  assert.ok(companions.includes(companion), 'Usage: node probes/smoke/effort.mjs <claude|codex|opencode|antigravity|copilot> [model]');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startBridge, record } = await import('./bridge-client.mjs');
  const { inspectCompanion, lastCompanionChecks } = await import('../../lib/companion-diagnostics.mjs');
  const { writeCompanionChecks } = await import('../../lib/state.mjs');
  const readiness = inspectCompanion(companion);
  writeCompanionChecks(lastCompanionChecks());
  assert.ok(readiness.ready, `${companion} is not ready; no model work sent`);
  const session = `effort-${companion}-${Date.now().toString(36)}`;
  const bridge = await startBridge(session);
  try {
    await runEffortProbe({ bridge, companion, model, cwd: mkdtempSync(join(tmpdir(), 'agentco-effort-')), owner: `${session}-child`, record });
  } finally { await bridge.stop(); }
}
