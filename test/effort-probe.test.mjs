import test from 'node:test';
import assert from 'node:assert/strict';
import { runEffortProbe } from '../probes/smoke/effort.mjs';

function fixture(target, { acceptInvalid = false, effectiveEffort, effectiveModel } = {}) {
  const calls = [], reports = [], executions = new Map();
  let turns = 0;
  const models = { claude: 'claude-haiku-4-5', codex: 'gpt-fixture', opencode: { providerID: 'fixture', id: 'model', variant: 'soft' }, antigravity: 'gemini-flash-low', copilot: null };
  const bridge = {
    async tool(name, args, owner) {
      calls.push({ name, args, owner });
      if (name === 'agent_catalog') return { targets: [{ id: target, effort: { selection: true, levels: null } }] };
      if (name === 'agent_cancel') return { ok: true };
      if (args.effort?.startsWith('__')) return acceptInvalid ? { status: 'still_running', job_id: 'bad' } :
        { status: 'failed', content: 'Use one of: high, low, medium, or omit effort.', meta: { detail: 'EFFORT_NOT_ALLOWED' } };
      const job_id = `job-${++turns}`;
      executions.set(job_id, { historyId: 'history', processes: { pid: turns } });
      return { ok: true, status: 'still_running', job_id, selected_effort: 'low' };
    },
    async wait(job_id) {
      return { ok: true, status: 'completed', job_id, content: 'OK', meta: { selected_effort: 'low',
        effective_effort: effectiveEffort ?? (target === 'claude' ? null : 'low'),
        effective_model: effectiveModel ?? models[target], stop_evidence: { gone: true } } };
    },
  };
  return { bridge, target, cwd: '/fixture', owner: 'owner', record: (_, id) => executions.get(id), report: line => reports.push(line), calls, reports };
}

for (const target of ['claude', 'codex', 'opencode', 'antigravity', 'copilot']) test(`effort probe ${target}: refusal, lowest level, truthful reports and cold follow-up scope`, async () => {
  const h = fixture(target);
  await runEffortProbe(h);
  const sends = h.calls.filter(c => c.name === 'agent_send');
  assert.equal(sends[1].args.effort, 'low');
  assert.equal(sends[1].args.task, 'Reply with exactly: OK');
  if (target === 'copilot') {
    assert.equal(sends.length, 2); assert.match(h.reports[2], /^SKIP.*unsupported/);
  } else {
    assert.equal(sends.length, 3); assert.equal(Object.hasOwn(sends[2].args, 'effort'), false);
    assert.equal(Object.hasOwn(sends[2].args, 'model'), false);
    assert.equal(sends[1].owner, sends[2].owner); assert.match(h.reports[2], /^PASS/);
  }
  assert.ok(h.reports.slice(0, 2).every(line => line.startsWith('PASS')));
});

test('effort probe cancels unexpected acceptance and spends no subsequent turns', async () => {
  const h = fixture('codex', { acceptInvalid: true });
  await assert.rejects(runEffortProbe(h));
  assert.equal(h.calls.at(-1).name, 'agent_cancel');
  assert.equal(h.calls.filter(c => c.name === 'agent_send').length, 1);
  assert.match(h.reports.at(-1), /^FAIL a:/);
});

test('effort probe fails on a provider-reported mismatch before follow-up', async () => {
  const h = fixture('antigravity', { effectiveEffort: 'high' });
  await assert.rejects(runEffortProbe(h), /high.*low/s);
  assert.equal(h.calls.filter(c => c.name === 'agent_send').length, 2);
  assert.match(h.reports.at(-1), /^FAIL b:/);
});

for (const target of ['codex', 'claude', 'copilot']) test(`wire assertion checks each ${target} turn independently`, async () => {
  const h = fixture(target), rows = [];
  const path = { codex: '/v1/responses', claude: '/v1/messages', copilot: '/v1/chat/completions' }[target];
  const entry = effort => ({ path, ...(target === 'codex' ? { reasoning: { effort } } : target === 'claude' ? { output_config: { effort } } : { reasoning_effort: effort }) });
  const wait = h.bridge.wait;
  h.bridge.wait = async id => { rows.push(entry('low')); return wait(id); };
  await runEffortProbe({ ...h, readWire: () => rows });
  const broken = fixture(target);
  // A previous turn's matching request cannot prove this turn's effort.
  await assert.rejects(runEffortProbe({ ...broken, readWire: () => rows }), /fresh proxy request/);
});

test('wire assertion rejects a mismatch before cold follow-up', async () => {
  const h = fixture('claude'), rows = [], wait = h.bridge.wait;
  h.bridge.wait = async id => { rows.push({ path: '/v1/messages', output_config: { effort: 'high' } }); return wait(id); };
  await assert.rejects(runEffortProbe({ ...h, readWire: () => rows }), /wire effort/);
  assert.equal(h.calls.filter(c => c.name === 'agent_send').length, 2);
});

test('unlisted Codex probe waits for backend vocabulary failure and verifies all three wire turns', async () => {
  const h = fixture('codex', { acceptInvalid: true }), rows = [], wait = h.bridge.wait;
  h.bridge.wait = async id => {
    rows.push({ path: '/v1/responses', reasoning: { effort: id === 'bad' ? '__unsupported_effort_probe__' : 'low' } });
    return id === 'bad' ? { status: 'failed', content: 'invalid reasoning value', meta: { cause: 'provider_error', stop_evidence: { gone: true } } } : wait(id);
  };
  await runEffortProbe({ ...h, backendEffort: 'low', readWire: () => rows });
  assert.equal(rows.length, 3);
  assert.equal(h.calls.some(c => c.name === 'agent_cancel'), false);
});
