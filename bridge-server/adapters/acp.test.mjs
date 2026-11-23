import '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import { FAKE_ACP_AGENT, fakeAcpDescriptor } from '../../test/fake-acp-agent.mjs';
import { ManualClock, waitForResult, until } from '../../test/controller/helpers.mjs';
import { Controller } from '../controller/controller.mjs';
import { Records } from '../controller/records.mjs';
import { ProcessSupervisor } from '../controller/process-supervisor.mjs';
import { pidAlive } from '../../bridge-server/controller/process-supervisor.mjs';
import { getCompanionById } from '../../lib/companion-registry.mjs';
import { writeCompanionChecks, isModelAllowedFor } from '../../lib/state.mjs';
import { AcpAdapter, acpProvider } from './acp.mjs';
import { callTool, testLead } from '../../test/tool-call.mjs';
import { appendProviderError } from '../provider-error.mjs';

const lines = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

for (const historyId of [null, 'saved-history']) for (const selection of ['session', 'model', 'effort']) {
  test(`ACP AUTH_REQUIRED during ${historyId ? 'loaded' : 'new'} ${selection} carries the native message and descriptor steps`, async t => {
    const descriptor = fakeAcpDescriptor();
    descriptor.auth = { nextSteps: ['Run `fixture-acp login`.', 'Then confirm the fixture account.'] };
    descriptor.acp.setModel = ({ sessionId, model }) => ['session/set_config_option', { sessionId, configId: 'model', value: model }];
    const h = setup(t, { descriptor, env: { ACP_FAKE_AUTH_REQUIRED: selection === 'session' ? '1' : '0',
      ACP_FAKE_THOUGHT_LEVELS: '["low","medium"]' } });
    const adapter = h.controller.providers.fake.create();
    await adapter.start({ cwd: h.dir, env: h.childEnv, supervisor: h.controller.createSupervisor({}) });
    let cause;
    if (selection !== 'session') {
      // New/load succeeds on the wire; the selection request then loses auth.
      cause = Object.assign(new Error('Authentication required'), { code: -32000 });
      const request = adapter.connection._sendRequest.bind(adapter.connection);
      t.mock.method(adapter.connection, '_sendRequest', async (method, params) => {
        if (method === 'session/set_config_option') throw cause;
        return request(method, params);
      });
    }
    await assert.rejects(adapter.openHistory({ historyId,
      ...(selection === 'model' ? { model: 'fake-model-a' } : selection === 'effort' ? { effort: 'low' } : {}) }), err => {
      assert.equal(err.code, 'AUTH_REQUIRED');
      const text = appendProviderError('', err);
      assert.equal(text.split('Authentication required').length - 1, 1);
      for (const step of descriptor.auth.nextSteps) assert.ok(text.includes(step), text);
      return true;
    });
    assert.equal(h.frames(historyId ? 'session/load' : 'session/new').length, 1);
    assert.equal(h.frames('session/prompt').length, 0);
  });
}

for (const companion of ['copilot', 'antigravity']) test(`ACP AUTH_REQUIRED controller send relays ${companion} sign-in steps without retry`, async t => {
  const descriptor = getCompanionById(companion);
  const h = setup(t, { descriptor, env: { ACP_FAKE_AUTH_REQUIRED: '1' } });
  h.controller.providers[companion] = h.controller.providers.fake;
  const sent = await callTool({ action: 'send', companion, cwd: h.dir, task: 'hello' }, { controller: h.controller });
  const result = h.records.readResult(sent.job_id);
  const terminal = h.records.readJob(sent.job_id).terminal;
  t.diagnostic('AUTH_REQUIRED_TERMINAL ' + JSON.stringify({ outcome: result.outcome, error: terminal.error, text: result.text }));
  assert.equal(result.outcome, 'failed');
  assert.equal(terminal.error, 'AUTH_REQUIRED');
  assert.equal(result.cause, 'companion_error');
  assert.equal(sent.status, 'failed'); assert.equal(sent.meta.detail, 'AUTH_REQUIRED');
  assert.equal(result.text, ['Authentication required.', ...descriptor.auth.nextSteps].join(' '));
  assert.equal(result.text.split('Authentication required').length - 1, 1);
  const waited = await callTool({ action: 'wait', job_id: sent.job_id }, { controller: h.controller });
  const status = await callTool({ action: 'status', job_id: sent.job_id }, { controller: h.controller });
  assert.equal(sent.content, result.text); assert.equal(waited.content, result.text); assert.equal(status.partial_text, result.text);
  assert.equal(h.frames('session/new').length, 1); assert.equal(h.frames('session/prompt').length, 0);
  assert.ok(result.stopEvidence.gone);
});

for (const fault of ['session-new-error', 'session-new-empty-error', 'session-new-object-error']) {
  test(`ACP session/new relays only a string message: ${fault}`, async t => {
    const h = setup(t, { descriptor: getCompanionById('copilot'), env: { ACP_FIXTURE_FAULT: fault } });
    h.controller.providers.copilot = h.controller.providers.fake;
    const sent = await callTool({ action: 'send', companion: 'copilot', cwd: h.dir, task: 'hello' }, { controller: h.controller });
    assert.equal(sent.status, 'failed'); assert.equal(sent.meta.detail, 'history_create_failed');
    const message = '403 "unauthorized: not authorized to use this Copilot feature\\n"';
    if (fault === 'session-new-error') assert.equal(sent.content, message);
    else assert.doesNotMatch(sent.content, /data|headers|\[object Object\]/);
    const waited = await callTool({ action: 'wait', job_id: sent.job_id }, { controller: h.controller });
    const status = await callTool({ action: 'status', job_id: sent.job_id }, { controller: h.controller });
    assert.equal(waited.content, sent.content); assert.equal(status.partial_text, sent.content);
    assert.doesNotMatch(JSON.stringify([sent, waited, status]), /SECRET_|headers|response|permission_denied/);
    assert.equal(h.frames('session/prompt').length, 0);
    if (fault === 'session-new-error') t.diagnostic('PROVIDER_ERROR_ENVELOPE copilot ' + JSON.stringify({ status: sent.status,
      cause: sent.meta.cause, detail: sent.meta.detail, content: sent.content }));
  });
}

for (const fault of ['prompt-error', 'prompt-error-after-ack']) test(`ACP prompt error keeps the explanation and partial answer: ${fault}`, async t => {
  const h = setup(t, { env: { ACP_FIXTURE_FAULT: fault } });
  const result = await h.finish(await h.send());
  assert.equal(result.outcome, fault === 'prompt-error' ? 'delivery_unknown' : 'failed');
  assert.equal(result.detail, fault === 'prompt-error' ? 'delivery_unknown' : 'prompt refused');
  assert.equal(Object.hasOwn(result, 'usage'), false, 'a refused request has no prompt counters');
  assert.equal(result.text, fault === 'prompt-error' ? 'prompt refused' : 'ready\n\nprompt refused');
  assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
});

function setup(t, { descriptor = fakeAcpDescriptor(), env = {}, clock } = {}) {
  const dir = mkdtempSync(join(SANDBOX_HOME, 'owned-acp-'));
  const bin = join(dir, 'agent.mjs');
  writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('../../test/adapters/acp-fixture.mjs', import.meta.url).href)};\n${FAKE_ACP_AGENT}`, { mode: 0o700 });
  const trace = join(dir, 'trace.jsonl'), rowsPath = join(dir, 'rows.jsonl');
  const childEnv = { ...process.env, HOME: dir, GEMINI_HOME: join(dir, 'gemini'), [descriptor.binaryEnv]: bin, ACP_FAKE_TRACE: trace,
    ACP_FAKE_LOAD_SESSION: '1', ACP_FIXTURE_ROWS: rowsPath, ...env };
  const records = new Records({ dir: join(dir, 'records'), log: () => {} });
  const adapters = [], supervisors = [], progress = [], logs = [];
  const controller = new Controller({ records, env: childEnv,
    providers: { fake: { enabled: true, ready: true, modelAllowed: () => true, create() {
      const adapter = new AcpAdapter(descriptor, { clock, log: (...args) => logs.push(args) });
      const observe = adapter.observe.bind(adapter);
      adapter.observe = ({ onProgress }) => observe({ onProgress: (value) => { progress.push(value); onProgress(value); } });
      adapters.push(adapter); return adapter;
    } } },
    createSupervisor(options) {
      // Same fixture-only census seam as test/controller/fixture-table.mjs:
      // real spawned processes and signals, birth/ancestry from the fixture.
      // Production ps qualification belongs to process-supervisor.test.mjs.
      const supervisor = new ProcessSupervisor({ ...options, processTable: async () => {
        if (supervisor.child?.pid && !supervisor.exited) await until(() => lines(rowsPath).flat().some((r) => r.pid === supervisor.child.pid), 'fixture census');
        return new Map(lines(rowsPath).flat().filter((r) => pidAlive(r.pid)).map((r) => [r.pid, r]));
      } });
      supervisors.push(supervisor); return supervisor;
    },
  });
  t.after(async () => {
    for (const adapter of adapters) await adapter.close();
    for (const supervisor of supervisors) await supervisor.terminate({ graceMs: 0 });
    for (const active of controller.live.values()) clearTimeout(active.timer);
  });
  const send = (args = {}) => controller.send({ thread: 'child', lead: testLead, companion: 'fake', cwd: dir, text: 'exact text\n  with spacing', ...args });
  const finish = async (sent) => sent.outcome ? sent : waitForResult(controller, { thread: records.readJob(sent.jobId).thread, jobId: sent.jobId });
  const frames = (method) => lines(trace).filter((frame) => frame.method === method);
  return { dir, bin, childEnv, records, controller, adapters, supervisors, progress, logs, send, finish, frames, trace };
}

test('new session then cold follow-up loads the same history in a new process and reapplies the model', async (t) => {
  const h = setup(t, { descriptor: getCompanionById('antigravity') });
  const first = await h.finish(await h.send({ model: 'gemini-3.8-flash' }));
  const second = await h.finish(await h.send({ text: 'CONTINUATION\nexact follow-up', model: 'claude-sonnet-4-6' }));
  assert.equal(first.outcome, 'completed'); assert.equal(second.outcome, 'completed');
  assert.equal(second.nativeRefs.sessionId, first.nativeRefs.sessionId);
  assert.notEqual(h.supervisors[0].serialize().pid, h.supervisors[1].serialize().pid);
  assert.equal(second.text, 'continued'); // Replayed "earlier answer" is excluded.
  assert.equal(first.effectiveModel, 'gemini-3.8-flash'); assert.equal(second.effectiveModel, 'claude-sonnet-4-6');
  const methods = lines(h.trace).filter((f) => f.method).map((f) => f.method);
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/set_config_option', 'session/prompt', '_agent_companion/received',
    'initialize', 'session/load', 'session/set_config_option', 'session/prompt', '_agent_companion/received']);
  assert.deepEqual(h.frames('session/prompt').map((f) => f.params.prompt), [
    [{ type: 'text', text: 'exact text\n  with spacing' }], [{ type: 'text', text: 'CONTINUATION\nexact follow-up' }],
  ]);
  assert.equal(h.frames('initialize')[0].params.protocolVersion, 1);
  assert.equal(h.frames('initialize')[0].params.clientInfo.name, getCompanionById('antigravity').acp.clientName);
  assert.ok(first.stopEvidence.gone && second.stopEvidence.gone);
  assert.deepEqual(second.usage, { source: 'antigravity-acp', input_tokens: 18021, output_tokens: 88,
    cached_input_tokens: 6842, cache_write_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 18109 });
  assert.equal(second.nativeRefs.promptRequestId, h.frames('session/prompt')[1].id);
});

test('Copilot sets the session model before prompting and reapplies it after a cold load', async (t) => {
  const h = setup(t, { descriptor: getCompanionById('copilot'), env: { ACP_FIXTURE_USAGE: 'copilot', ACP_FAKE_MODELS: '["auto","local-model"]' } });
  const first = await h.finish(await h.send({ model: 'local-model' }));
  assert.equal(first.outcome, 'completed'); assert.equal(first.usage.input_tokens, 1234);
  assert.equal(first.effectiveModel, 'local-model');
  assert.equal(lines(h.trace)[0].argv.includes('--model'), false);
  assert.deepEqual(lines(h.trace).filter(f => f.method).map(f => f.method),
    ['initialize', 'session/new', 'session/set_config_option', 'session/prompt']);
  assert.deepEqual(h.frames('session/set_config_option')[0].params,
    { sessionId: first.nativeRefs.sessionId, configId: 'model', value: 'local-model' });
  const next = await h.finish(await h.send({ text: 'follow-up' }));
  assert.equal(next.outcome, 'completed'); assert.equal(next.effectiveModel, 'local-model');
  assert.equal(h.supervisors.length, 2); assert.equal(h.frames('session/new').length, 1);
  assert.deepEqual(h.frames('session/load').map(f => f.params.sessionId), [first.nativeRefs.sessionId]);
  assert.deepEqual(h.frames('session/set_config_option').map(f => f.params.value), ['local-model', 'local-model']);
});

for (const model of ['bogus-model', 'local-model']) test(`Copilot refuses an unavailable or unconfirmed model before delivery: ${model}`, async t => {
  const models = ['auto', ...Array.from({ length: 50 }, (_, i) => `session-model-${i}`), 'local-model'];
  const h = setup(t, { descriptor: getCompanionById('copilot'), env: {
    ACP_FAKE_MODELS: JSON.stringify(models), ACP_FAKE_IGNORE_MODEL: '1',
  } });
  h.controller.providers.copilot = h.controller.providers.fake;
  const sent = await callTool({ action: 'send', companion: 'copilot', cwd: h.dir, task: 'hello', model },
    { controller: h.controller });
  assert.equal(sent.status, 'failed');
  assert.equal(sent.meta.detail, 'MODEL_NOT_ALLOWED');
  assert.ok(sent.content.includes(`model "${model}"`));
  assert.ok(sent.content.includes(`Use one of: ${models.join(', ')}, or omit it to inherit configuration.`));
  assert.equal(h.frames('session/set_config_option').length, 1);
  assert.equal(h.frames('session/prompt').length, 0);
});

test('Copilot preserves the native model refusal as the cause', async t => {
  const h = setup(t, { descriptor: getCompanionById('copilot'), env: { ACP_FAKE_MODELS: '["auto","local-model"]' } });
  const adapter = h.controller.providers.fake.create();
  await adapter.start({ cwd: h.dir, env: h.childEnv, supervisor: h.controller.createSupervisor({}) });
  await assert.rejects(adapter.openHistory({ model: 'bogus-model' }), err => {
    assert.equal(err.code, 'MODEL_NOT_ALLOWED');
    assert.equal(err.cause.code, -32602);
    assert.equal(err.cause.message, "Invalid modelId 'bogus-model': not one of this session's models.");
    return true;
  });
});

test("Copilot validates effort against the selected model's options", async t => {
  const h = setup(t, { descriptor: getCompanionById('copilot'), env: {
    ACP_FAKE_MODELS: '["auto","local-model"]', ACP_FAKE_THOUGHT_LEVELS: '{"auto":["medium"],"local-model":["medium","high"]}',
  } });
  const result = await h.finish(await h.send({ model: 'local-model', effort: 'high' }));
  assert.equal(result.effectiveModel, 'local-model');
  assert.equal(result.effectiveEffort, 'high');
  assert.deepEqual(h.frames('session/set_config_option').map(f => [f.params.configId, f.params.value]),
    [['model', 'local-model'], ['reasoning_effort', 'high']]);
});

test('Copilot OTEL usage is job-private and temporary files are removed on close', async (t) => {
  const h = setup(t, { descriptor: getCompanionById('copilot'), env: { ACP_FAKE_USAGE: 'none', ACP_FIXTURE_USAGE: 'otel' } });
  const result = await h.finish(await h.send());
  assert.equal(result.usage.source, 'copilot-otel'); assert.equal(result.usage.input_tokens, 1234);
  assert.equal(existsSync(h.adapters[0].paths.otelTraces), false);
});

test('a refused model after load keeps the original history and never delivers another prompt', async (t) => {
  const h = setup(t, { descriptor: getCompanionById('antigravity') });
  const first = await h.finish(await h.send());
  const second = await h.send({ text: 'follow-up', model: 'gemini-9-nope' });
  assert.equal(h.records.readJob(second.jobId).terminal.error, 'MODEL_NOT_ALLOWED');
  assert.equal(h.records.readThread('child').historyId, first.nativeRefs.historyId);
  assert.equal(h.frames('session/new').length, 1); assert.equal(h.frames('session/load').length, 1);
  assert.equal(h.frames('session/prompt').length, 1); assert.ok(second.stopEvidence.gone);
});

for (const options of [{ env: { ACP_FAKE_LOAD_SESSION: '0' } }, { env: { ACP_FAKE_LOAD_FAIL: '1' } }]) {
  test(`history refusal never creates a replacement: ${Object.keys(options.env)[0]}`, async (t) => {
    const h = setup(t, options);
    const first = await h.finish(await h.send());
    const second = await h.send({ text: 'follow-up' });
    assert.equal(second.outcome, 'failed'); assert.equal(second.detail, 'history_unavailable');
    assert.equal(h.records.readJob(second.jobId).terminal.error, 'HistoryUnavailable');
    assert.equal(h.frames('session/new').length, 1); assert.equal(h.frames('session/prompt').length, 1);
    assert.equal(h.records.readThread('child').historyId, first.nativeRefs.historyId);
    assert.ok(second.stopEvidence.gone);
  });
}

for (const fault of ['refused', 'wrong-model', 'missing-model']) {
  test(`model selection surfaces MODEL_NOT_ALLOWED on ${fault}`, async (t) => {
    const h = setup(t, { descriptor: getCompanionById('antigravity'), env: { ACP_FIXTURE_FAULT: fault } });
    const result = await h.send({ model: fault === 'refused' ? 'gemini-9-nope' : 'gemini-3.8-flash' });
    assert.equal(result.outcome, 'failed');
    assert.equal(h.records.readJob(result.jobId).terminal.error, 'MODEL_NOT_ALLOWED');
    if (fault === 'wrong-model') assert.match(result.text, /Use one of: gemini-3.8-flash,/);
    assert.equal(h.frames('session/prompt').length, 0); assert.ok(result.stopEvidence.gone);
  });
}

for (const [policy, kind, optionId] of [['all', 'execute', 'proceed_once'], ['edit', 'edit', 'proceed_once'], ['edit', 'execute', 'cancel'], ['none', 'execute', 'cancel']]) {
  test(`permission ${policy}/${kind} is answered from the job env and completes`, async (t) => {
    const h = setup(t, { env: { ACP_FAKE_ASK_PERMISSION: '1', FAKE_ACP_POLICY: policy, ACP_FAKE_PERMISSION_KIND: kind } });
    const result = await h.finish(await h.send());
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(lines(h.trace).find((f) => f.permissionAnswer).permissionAnswer, { outcome: { outcome: 'selected', optionId } });
  });
}

test('delivery is acknowledged by native activity while the prompt is still running; cancel removes the tree', async (t) => {
  const h = setup(t, { env: { ACP_FAKE_TURN_MS: '60000', ACP_FIXTURE_TREE: '1', ACP_FIXTURE_RETRY: '1' } });
  const sent = await h.send();
  assert.equal(sent.acknowledged, true); assert.equal(sent.state, 'running');
  assert.equal(h.records.readResult(sent.jobId), null);
  await until(() => h.progress.some((p) => p.activeCommand), 'command progress');
  assert.ok(h.progress.some((p) => p.retry?.attempt === 2));
  assert.ok(h.progress.every((p) => Number.isFinite(p.lastActivityAt)));
  const result = await h.controller.cancel({ thread: 'child', jobId: sent.jobId });
  assert.equal(result.outcome, 'interrupted'); assert.equal(result.cause, 'owner_stop');
  assert.ok(result.stopEvidence.protocol.find((p) => p.method === 'interrupt').acknowledged);
  const processes = h.supervisors[0].serialize().processes;
  assert.equal(processes.length, 3);
  assert.ok(result.stopEvidence.gone); assert.ok(processes.every((p) => !pidAlive(p.pid)));
  assert.equal(h.frames('session/cancel').length, 1);
});

test('a terminal-only prompt response also acknowledges delivery', async (t) => {
  const h = setup(t, { env: { ACP_FIXTURE_FAULT: 'terminal-only' } });
  const sent = await h.send(); assert.equal(sent.acknowledged, true);
  assert.equal((await h.finish(sent)).outcome, 'completed');
});

for (const fault of ['die-before-ack', 'prompt-error']) {
  test(`delivery failure ${fault} is DeliveryUnknown with one prompt and no resend`, async (t) => {
    const h = setup(t, { env: { ACP_FIXTURE_FAULT: fault } });
    const result = await h.send();
    assert.equal(result.outcome, 'delivery_unknown');
    assert.equal(h.records.readJob(result.jobId).terminal.error, 'DeliveryUnknown');
    assert.equal(h.frames('session/prompt').length, 1); assert.ok(result.stopEvidence.gone);
  });
}

test('no native acknowledgement times out as DeliveryUnknown without resending', async (t) => {
  const h = setup(t, { env: { ACP_FIXTURE_FAULT: 'silent' } });
  const result = await h.send();
  assert.equal(result.outcome, 'delivery_unknown'); assert.equal(h.frames('session/prompt').length, 1);
  assert.equal(h.records.readJob(result.jobId).terminal.error, 'DeliveryUnknown');
  assert.ok(result.stopEvidence.gone);
});

test('transport death after acceptance rejects ProviderLost and preserves partial progress', async (t) => {
  const h = setup(t, { env: { ACP_FIXTURE_FAULT: 'die-after-ack', ACP_FAKE_TURN_MS: '60000' } });
  const result = await h.finish(await h.send());
  assert.equal(result.outcome, 'failed');
  assert.equal(h.records.readJob(result.jobId).terminal.error, 'ProviderLost');
  assert.equal(result.text, 'partial answer\n\nACP transport closed');
  assert.equal(h.frames('session/prompt').length, 1); assert.ok(result.stopEvidence.gone);
});

test('non-end_turn stop reasons fail and unknown update kinds are logged once', async (t) => {
  const h = setup(t, { env: { ACP_FAKE_UNKNOWN_UPDATE: '1', ACP_FIXTURE_STOP: 'max_tokens' } });
  const result = await h.finish(await h.send());
  assert.equal(result.outcome, 'failed'); assert.equal(result.text, 'ready');
  assert.equal(h.logs.filter((args) => String(args[1]).includes('not declared')).length, 2);
});

test('protocol v2 is refused with ACP_PROTOCOL_MISMATCH before session creation', async (t) => {
  const h = setup(t, { env: { ACP_FAKE_PROTOCOL_VERSION: '2' } });
  const result = await h.send();
  assert.equal(result.outcome, 'failed'); assert.equal(result.detail, 'ACP_PROTOCOL_MISMATCH');
  assert.equal(h.records.readJob(result.jobId).terminal.error, 'ACP_PROTOCOL_MISMATCH');
  assert.equal(h.frames('session/new').length, 0); assert.ok(result.stopEvidence.gone);
});

test('spawn failure becomes failed runtime_unavailable and cleans up', async (t) => {
  const h = setup(t, { env: { FAKE_ACP_BIN: join(SANDBOX_HOME, 'missing-binary') } });
  const result = await h.send();
  assert.equal(result.outcome, 'failed'); assert.equal(result.detail, 'runtime_unavailable');
  assert.equal(h.frames('session/new').length, 0); assert.ok(result.stopEvidence.gone);
});

test('inherited model is reported only when the native session reports one', async (t) => {
  const h = setup(t, { env: { ACP_FIXTURE_MODEL: 'native-default' } });
  const result = await h.finish(await h.send());
  assert.equal(result.effectiveModel, 'native-default');
  assert.equal(result.usage.input_tokens, 1234);
  assert.equal(h.frames('session/set_config_option').length, 0);
  assert.equal(lines(h.trace)[0].argv.includes('--model'), false);
});

test('provider factories use cached readiness without spawning and expose qualified capabilities', () => {
  writeCompanionChecks({ antigravity: { ready: true }, copilot: { ready: false } });
  for (const [id, ready] of [['antigravity', true], ['copilot', false]]) {
    const provider = acpProvider(id, { env: { PATH: '', COPILOT_BIN: '/missing', ANTIGRAVITY_BIN: '/missing' } });
    assert.equal(provider.enabled, true); assert.equal(provider.ready, ready);
    assert.equal(provider.modelAllowed('test-model'), isModelAllowedFor(id, 'test-model'));
    const { capabilities } = provider.create();
    assert.deepEqual(capabilities, { followUp: true, modelSelection: true, loadsHistory: true,
      interventions: getCompanionById(id).capabilities.interventions });
    assert.equal(capabilities.interventions, getCompanionById(id).capabilities.interventions);
  }
  assert.throws(() => acpProvider('codex'), /ACP/);
});

test('Antigravity inherits thought_level and reapplies the saved override after cold load', async t => {
  const h = setup(t, { descriptor: getCompanionById('antigravity') });
  const inherited = await h.finish(await h.send());
  assert.equal(inherited.effectiveModel, 'gemini-3.8-flash');
  assert.equal(inherited.effectiveEffort, 'high');
  assert.equal(h.frames('session/set_config_option').length, 0);
  const first = await h.finish(await h.send({ model: 'gemini-3.8-flash', effort: 'low' }));
  const next = await h.finish(await h.send({ text: 'again' }));
  for (const result of [first, next]) {
    assert.equal(result.effectiveModel, 'gemini-3.8-flash');
    assert.equal(result.effectiveEffort, 'low');
  }
  assert.equal(h.frames('session/load').length, 2);
  assert.deepEqual(h.frames('session/set_config_option').map(f => [f.params.configId, f.params.value]),
    [['model', 'gemini-3.8-flash'], ['thought_level', 'low'], ['model', 'gemini-3.8-flash'], ['thought_level', 'low']]);
});

for (const effort of ['ultra', 'low']) test(`Antigravity effort refusal for ${effort} stops before delivery`, async t => {
  // ultra is absent from the advertised levels. Also exercise a native -32602 after validation.
  const h = setup(t, { descriptor: getCompanionById('antigravity'), env: { ACP_FAKE_REFUSE_EFFORT: '1' } });
  const result = await h.send({ effort });
  assert.equal(result.detail, 'EFFORT_NOT_ALLOWED');
  assert.match(result.text, effort === 'ultra' ? /low, medium, high/ : /Thinking level "low" is not offered/);
  assert.equal(h.frames('session/set_config_option').length, effort === 'ultra' ? 0 : 1);
  assert.equal(h.frames('session/prompt').length, 0);
  assert.equal(h.records.readThread('child').effortOverride, undefined);
});

for (const [companion, selection] of [['antigravity', { model: 'gemini-3.8-flash', effort: 'low' }], ['copilot', { model: 'local-model' }]]) for (const replay of ['empty', 'other-session']) test(`${companion} refuses cold load with ${replay} replay before config or prompt`, async t => {
  const h = setup(t, { descriptor: getCompanionById(companion), env: { ACP_FAKE_LOAD_REPLAY: replay, ACP_FAKE_MODELS: '["auto","local-model"]' } });
  const first = await h.finish(await h.send());
  const next = await h.finish(await h.send({ ...selection, text: 'follow-up' }));
  assert.equal(h.records.readJob(next.jobId).terminal.error, 'HistoryUnavailable');
  assert.equal(h.records.readThread('child').historyId, first.nativeRefs.historyId);
  assert.equal(h.frames('session/new').length, 1);
  assert.equal(h.frames('session/load').length, 1);
  assert.equal(h.frames('session/set_config_option').length, 0);
  assert.equal(h.frames('session/prompt').length, 1);
});

test('ACP accepts empty replay for a load-capable descriptor that does not require it', async t => {
  const h = setup(t, { env: { ACP_FAKE_LOAD_REPLAY: 'empty' } });
  await h.finish(await h.send());
  assert.equal((await h.finish(await h.send({ text: 'follow-up' }))).outcome, 'completed');
});

for (const [policy, kind, decision] of [['all', 'execute', undefined], ['edit', 'edit', 'allow'],
  ['edit', 'execute', 'deny'], ['none', 'edit', 'deny']]) {
  test(`Antigravity ${policy} policy handles a parent ${kind}`, async t => {
    const h = setup(t, { descriptor: getCompanionById('antigravity'), env: {
      AGENT_COMPANION_ANTIGRAVITY_PERMISSION: policy, ACP_FAKE_ASK_PERMISSION: '1', ACP_FAKE_PERMISSION_KIND: kind } });
    const result = await h.finish(await h.send());
    const frames = lines(h.trace);
    assert.deepEqual(frames[0].argv, policy === 'all' ? ['acp', '--dangerously-skip-permissions'] : ['acp']);
    assert.equal(frames.find(f => f.permissionAnswer)?.permissionAnswer.outcome.optionId, decision);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.text, decision === 'deny' ? '' : 'ready');
  });
}

test('Antigravity omits turn usage when only context occupancy is reported', async t => {
  const h = setup(t, { descriptor: getCompanionById('antigravity'), env: { ACP_FAKE_USAGE: 'none' } });
  const result = await h.finish(await h.send());
  assert.equal(result.usage, null);
});

for (const effort of [undefined, 'low', 'max']) test(`Copilot session effort ${effort ?? 'inherits'}`, async t => {
  const h = setup(t, { descriptor: getCompanionById('copilot'), env: { ACP_FAKE_MODELS: '["auto","local-model"]', ACP_FAKE_THOUGHT_LEVELS: '["low","medium","high","xhigh","max"]' } });
  const result = await h.finish(await h.send({ effort }));
  const argv = lines(h.trace)[0].argv;
  assert.equal(argv.includes('--reasoning-effort'), false);
  assert.equal(argv.includes('--model'), false);
  assert.equal(result.effectiveModel, 'auto');
  assert.equal(result.effectiveEffort, effort ?? 'medium');
  assert.deepEqual(h.frames('session/set_config_option').map(f => f.params), effort === undefined ? [] :
    [{ sessionId: 'fake-sess-1', configId: 'reasoning_effort', value: effort }]);
});

for (const fault of ['refused', 'ignored', 'missing', 'confirmed']) test(`Copilot thought_level envelope: ${fault}`, async t => {
  const h = setup(t, { descriptor: getCompanionById('copilot'), env: { ACP_FAKE_THOUGHT_LEVELS: '["low","medium","high","xhigh","max"]',
    ACP_FAKE_IGNORE_EFFORT: fault === 'ignored' ? '1' : '', ACP_FAKE_MISSING_EFFORT: fault === 'missing' ? '1' : '' } });
  h.controller.providers.copilot = h.controller.providers.fake;
  const sent = await callTool({ action: 'send', companion: 'copilot', cwd: h.dir, task: 'hello',
    effort: fault === 'refused' ? 'none' : 'low' }, { controller: h.controller });
  if (fault === 'confirmed') {
    assert.equal(sent.status, 'still_running'); assert.equal(sent.effective_effort, 'low');
    const result = await h.finish({ jobId: sent.job_id }); assert.equal(result.effectiveEffort, 'low');
  } else {
    assert.equal(sent.status, 'failed');
    assert.equal(sent.meta.detail, fault === 'refused' ? 'EFFORT_NOT_ALLOWED' : 'CAPABILITY_UNAVAILABLE');
    assert.match(sent.content, fault === 'refused' ? /Use one of: low, medium, high, xhigh, max/ : /did not confirm effort/);
    assert.equal(h.frames('session/prompt').length, 0);
    assert.equal(h.frames('session/set_config_option').length, fault === 'refused' ? 0 : 1);
    assert.equal(h.records.readThread(sent.thread).effortOverride, undefined);
  }
  t.diagnostic('COPILOT_EFFORT_ENVELOPE ' + fault + ' ' + JSON.stringify(sent));
});

test('generic ACP thought_level uses the advertised id on new and load', async t => {
  const h = setup(t, { env: { ACP_FAKE_THOUGHT_LEVELS: '["low","medium"]', ACP_FAKE_THOUGHT_ID: 'thinking' } });
  await h.finish(await h.send({ effort: 'low' }));
  const second = await h.finish(await h.send({ text: 'follow-up' }));
  assert.equal(second.effectiveEffort, 'low');
  assert.equal(h.frames('session/load').length, 1);
  assert.deepEqual(h.frames('session/set_config_option').map(f => f.params.configId), ['thinking', 'thinking']);
});


for (const effort of [undefined, 'low']) test(`Antigravity config connection loss with ${effort ?? 'no'} effort remains HistoryUnavailable`, async t => {
  const h = setup(t, { descriptor: getCompanionById('antigravity') });
  h.childEnv.ACP_FAKE_MODEL_DISCONNECT = '1';
  const failed = await h.send({ model: 'gemini-3.8-flash', effort });
  assert.equal(failed.detail, 'history_create_failed');
  assert.equal(h.records.readJob(failed.jobId).terminal.error, 'HistoryUnavailable');
  assert.equal(h.frames('session/set_config_option').length, 1);
  assert.equal(h.frames('session/prompt').length, 0);
  assert.equal(h.records.readThread('child').effortOverride, undefined);
});

test('ACP acknowledges delivery without inventing a native turn id', async t => {
  const h = setup(t);
  const sent = await h.send();
  assert.equal(sent.acknowledged, true);
  const job = h.records.readJob(sent.jobId);
  assert.equal(job.nativeTurnId, null);
  assert.equal(job.nativeRefs.promptRequestId, h.frames('session/prompt')[0].id);
  const result = await h.finish(sent);
  assert.equal(result.nativeRefs.promptRequestId, h.frames('session/prompt')[0].id);
  assert.equal(Object.hasOwn(result.nativeRefs, 'promptId'), false);
});

const input = (h, sent, mode, text) => h.controller.intervene({ jobId: sent.jobId, from: 'user', mode, text });
const releasePrompt = (h, index) => writeFileSync(`${h.childEnv.ACP_FIXTURE_GATE}.${h.frames('session/prompt')[index].id}`, '');

test('Antigravity queues on the live process and session, keeping both answers without invented turn ids', async t => {
  const h = setup(t, { descriptor: getCompanionById('antigravity') });
  h.childEnv.ACP_FIXTURE_GATE = join(h.dir, 'release');
  const sent = await h.send({ model: 'gemini-3.8-flash' });
  await until(() => h.progress.some(p => p.partialText === 'ready'));
  const queued = await input(h, sent, 'queue', 'CONTINUATION\nonly this text');
  assert.equal(queued.ok, true);
  assert.equal(h.frames('session/prompt').length, 1);
  const progressOffset = h.progress.length;
  releasePrompt(h, 0);
  await until(() => h.frames('session/prompt').length === 2);
  await until(() => h.progress.some(p => p.partialText === 'continued'));
  assert.equal(h.progress[progressOffset].partialText, '');
  assert.equal(h.progress[progressOffset].activeCommand, null);
  assert.equal(h.progress[progressOffset].retry, null);
  releasePrompt(h, 1);
  const result = await h.finish(sent);
  assert.deepEqual(result.turns.map(t => [t.nativeTurnId, t.text]), [[null, 'ready'], [null, 'continued']]);
  assert.deepEqual(result.turns.map(t => t.messages), [[sent.jobId], [queued.id]]);
  assert.deepEqual(result.nativeTurnIds, []); assert.equal(result.usage.total_tokens, 2 * 18109);
  assert.equal(result.interventions[0].state, 'answered');
  assert.deepEqual(h.frames('session/prompt').map(f => f.params), [
    { sessionId: 'fake-sess-1', prompt: [{ type: 'text', text: 'exact text\n  with spacing' }] },
    { sessionId: 'fake-sess-1', prompt: [{ type: 'text', text: 'CONTINUATION\nonly this text' }] },
  ]);
  assert.equal(h.supervisors.length, 1); assert.equal(h.frames('initialize').length, 1);
  assert.equal(h.frames('session/new').length, 1); assert.equal(h.frames('session/load').length, 0);
  assert.equal(h.frames('session/set_config_option').length, 1);
});

test('Antigravity waits for the cancelled prompt response, then sends only new text on the live session', async t => {
  const h = setup(t, { descriptor: getCompanionById('antigravity') });
  h.childEnv.ACP_FIXTURE_GATE = join(h.dir, 'release');
  const sent = await h.send({ text: 'sleep:60000 original task' });
  const replacing = input(h, sent, 'interrupt', 'CONTINUATION\nnew text alone');
  await until(() => h.frames('session/cancel').length === 1);
  assert.equal(h.frames('session/prompt').length, 1);
  releasePrompt(h, 0); await replacing;
  await until(() => h.frames('session/prompt').length === 2);
  releasePrompt(h, 1);
  const result = await h.finish(sent);
  assert.deepEqual(result.turns.map(t => [t.outcome, t.text]), [['interrupted', 'interrupted before answering'], ['completed', 'continued']]);
  assert.deepEqual(result.nativeTurnIds, []); assert.deepEqual(result.turns.map(t => t.usage.total_tokens), [8931, 18109]);
  assert.equal(result.usage.total_tokens, 8931 + 18109);
  assert.equal(result.interventions[0].state, 'answered');
  assert.deepEqual(h.frames('session/prompt')[1].params, { sessionId: 'fake-sess-1', prompt: [{ type: 'text', text: 'CONTINUATION\nnew text alone' }] });
  assert.equal(h.frames('session/load').length, 0); assert.equal(h.frames('session/new').length, 1);
  assert.equal(h.frames('initialize').length, 1); assert.equal(h.supervisors.length, 1);
});

// Copilot 1.0.114 cancels a running prompt when a second one arrives, so steer stays unavailable.
test('Copilot refuses steer without writes; interrupt cancels, then it and the queued message run as later prompts', async t => {
  const h = setup(t, { descriptor: getCompanionById('copilot') });
  const sent = await h.send({ text: 'sleep:60000' });
  assert.deepEqual(await input(h, sent, 'steer', 'not supported'), { ok: false, status: 'intervention_unavailable', reason: 'capability' });
  await assert.rejects(h.adapters[0].steer({ text: 'unsupported' }), { code: 'DeliveryUnknown' });
  assert.deepEqual(h.records.readJob(sent.jobId).interventions, []);
  assert.equal((await input(h, sent, 'queue', 'QUEUED')).ok, true);
  assert.equal(h.frames('session/cancel').length, 0); assert.equal(h.frames('session/prompt').length, 1);
  assert.equal((await input(h, sent, 'interrupt', 'NOW')).ok, true);
  const result = await waitForResult(h.controller, { thread: 'child', jobId: sent.jobId });
  assert.equal(h.frames('session/cancel').length, 1);
  assert.deepEqual(h.frames('session/prompt').map(f => f.params.prompt[0].text), ['sleep:60000', 'NOW', 'QUEUED']);
  assert.deepEqual(result.turns.map(turn => turn.outcome), ['interrupted', 'completed', 'completed']);
  assert.deepEqual(result.interventions.map(i => [i.mode, i.state]), [['queue', 'answered'], ['interrupt', 'answered']]);
});

test('ACP resets the usage window and collectors for each descriptor-enabled bridge turn', async t => {
  const descriptor = fakeAcpDescriptor(), usage = descriptor.acp.usage, windows = [];
  descriptor.capabilities.interventions = getCompanionById('antigravity').capabilities.interventions;
  descriptor.acp.usage = args => { windows.push(args.sinceMs); return usage(args); };
  const h = setup(t, { descriptor });
  h.childEnv.ACP_FIXTURE_GATE = join(h.dir, 'release');
  const sent = await h.send();
  await input(h, sent, 'queue', 'CONTINUATION');
  const firstSince = h.adapters[0].turn.sinceMs;
  releasePrompt(h, 0);
  await until(() => h.frames('session/prompt').length === 2);
  const nextSince = h.adapters[0].turn.sinceMs;
  releasePrompt(h, 1);
  const result = await h.finish(sent);
  assert.deepEqual(windows, [firstSince, nextSince]); assert.ok(nextSince > firstSince);
  assert.deepEqual(result.turns.map(t => [t.text, t.usage.input_tokens]), [['ready', 1234], ['continued', 1234]]);
  assert.equal(result.usage.input_tokens, 2468); assert.equal(h.supervisors.length, 1);
});

const endTurn = { stopReason: 'end_turn' };
const usageUpdate = { sessionUpdate: 'usage_update', used: 123, size: 1000 };
const message = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const command = (id, rawInput = {}) => ({ sessionUpdate: 'tool_call', kind: 'execute', title: 'run_command',
  toolCallId: id, status: 'in_progress', rawInput });
const completed = id => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });
const background = [command('one'), message('Waiting.'), usageUpdate, endTurn];

async function scriptedAgy(t, batches, env = {}) {
  const clock = new ManualClock();
  const h = setup(t, { descriptor: getCompanionById('antigravity'), clock,
    env: { ACP_FAKE_BATCHES: JSON.stringify([[], ...batches]), ...env } });
  const adapter = h.controller.providers.fake.create();
  await adapter.start({ cwd: h.dir, env: h.childEnv, supervisor: h.controller.createSupervisor({}) });
  const { historyId } = await adapter.openHistory({});
  const next = async () => {
    await adapter.connection._sendRequest('_fixture/next', {});
    await clock.flush();
  };
  const begin = async () => {
    const accepted = adapter.deliver({ text: 'fixture prompt' });
    await next();
    await accepted;
  };
  return { ...h, adapter, clock, historyId, next, begin };
}

test('Antigravity holds a running command through its follow-on reply and quiet period', async t => {
  const h = await scriptedAgy(t, [[message('Starting.'), command('one'), message('\n\nWaiting.'), usageUpdate, endTurn],
    [completed('one'), message('\n\nDO'), message('NE'), usageUpdate],
    [message('!')]]);
  await h.begin();
  const terminal = h.adapter.observe({ onProgress() {} });
  assert.equal(h.adapter.turn.finished, false);
  await h.clock.advance(180_000);
  assert.equal(h.adapter.turn.finished, false, 'no deadline while the command runs');
  await h.next();
  await h.clock.advance(2999);
  assert.equal(h.adapter.turn.finished, false);
  await h.next();
  assert.equal(h.progress.at(-1).partialText, 'Starting.\n\nWaiting.\n\nDONE!');
  await h.clock.advance(2999);
  assert.equal(h.adapter.turn.finished, false, 'later activity resets the quiet period');
  await h.clock.advance(1);
  const result = await terminal;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.text, 'Starting.\n\nWaiting.\n\nDONE!');
  assert.deepEqual(result.usage, { source: 'antigravity-acp', input_tokens: 18021, output_tokens: 88,
    cached_input_tokens: 6842, cache_write_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 18109, partial: true });
  assert.equal(h.clock.timers.size, 0);
});

test('Antigravity sees end_turn in wire order when the same read already contains completion and another tool', async t => {
  const h = await scriptedAgy(t, [[...background, completed('one'), usageUpdate, command('two')],
    [completed('two'), message('\n\nFinal')], [usageUpdate]]);
  await h.begin();
  await h.clock.advance(120_000);
  assert.equal(h.adapter.turn.finished, false);
  await h.next();
  await h.clock.advance(3000);
  assert.equal(h.adapter.turn.finished, false, 'usage before the new tool cannot finish its reply');
  await h.next();
  await h.clock.advance(3000);
  assert.equal((await h.adapter.turn.terminal).text, 'Waiting.\n\nFinal');
});

test('Antigravity keeps a follow-on reply open across an edit and a slow next model call', async t => {
  const edit = { sessionUpdate: 'tool_call', kind: 'edit', title: 'File note.md', toolCallId: 'edit', status: 'in_progress' };
  const h = await scriptedAgy(t, [background, [completed('one'), usageUpdate, edit, completed('edit')],
    [message('\n\nFinal'), usageUpdate]]);
  await h.begin();
  await h.next();
  await h.clock.advance(60_000);
  assert.equal(h.adapter.turn.finished, false, 'a tool call after usage means the model answers again');
  await h.next();
  await h.clock.advance(3000);
  assert.equal((await h.adapter.turn.terminal).text, 'Waiting.\n\nFinal');
});

test('Antigravity ends a follow-on reply that went quiet after text with no usage update', async t => {
  const h = await scriptedAgy(t, [background, [completed('one')], [message('\n\nStill writing')]]);
  await h.begin();
  await h.next();
  await h.clock.advance(100_000);
  await h.next();
  await h.clock.advance(119_999);
  assert.equal(h.adapter.turn.finished, false);
  await h.clock.advance(1);
  assert.equal((await h.adapter.turn.terminal).text, 'Waiting.\n\nStill writing');
});

test('Antigravity silence after the work ended never ends the turn; an interrupt does', async t => {
  const h = await scriptedAgy(t, [[...background, completed('one')]]);
  await h.begin();
  await h.clock.advance(3_600_000);
  assert.equal(h.adapter.turn.finished, false, 'the agent may be retrying upstream before its reply');
  await h.adapter.interrupt();
  const result = await h.adapter.turn.terminal;
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.text, 'Waiting.');
  assert.equal(result.usage.partial, true);
  assert.equal(h.clock.timers.size, 0);
});

for (const [name, tool] of [
  ['pending ask_question', { sessionUpdate: 'tool_call', kind: 'other', title: 'ask_question', toolCallId: 'q', status: 'pending' }],
  ['daemon command', command('server', { IsDaemon: true })],
]) test(`Antigravity ends immediately with a ${name}`, async t => {
  const h = await scriptedAgy(t, [[tool, endTurn]]);
  await h.begin();
  assert.equal(h.adapter.turn.finished, true);
  const result = await h.adapter.turn.terminal;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.usage.partial, undefined);
  assert.equal(h.clock.timers.size, 0);
});

function childFiles(h, state) {
  const dir = join(h.childEnv.GEMINI_HOME || join(h.dir, '.gemini'), 'antigravity-cli', 'brain', h.historyId, '.system_generated');
  mkdirSync(join(dir, 'subagents'), { recursive: true });
  mkdirSync(join(dir, 'messages', 'undelivered'), { recursive: true });
  writeFileSync(join(dir, 'subagents', 'child.json'), JSON.stringify({ conversationId: 'child', state }));
  return join(dir, 'messages');
}
const launched = [{ sessionUpdate: 'tool_call', kind: 'other', title: 'invoke_subagent', toolCallId: 'launch', status: 'in_progress' },
  completed('launch'), message('Waiting.'), usageUpdate, endTurn];

test('Antigravity waits for the ALIVE child to report to its parent and for the parent reply', async t => {
  const h = await scriptedAgy(t, [launched, [message('\n\nReported'), usageUpdate]]);
  const dir = childFiles(h, 'SUBAGENT_STATE_ALIVE');
  writeFileSync(join(dir, 'task.json'), JSON.stringify({ sender: h.historyId + '/task-1' }));
  for (const path of ['read.json', 'undelivered/child.json']) writeFileSync(join(dir, path), '{"sender":"child"}');
  await h.begin();
  await h.clock.advance(180_000);
  assert.equal(h.adapter.turn.finished, false);
  writeFileSync(join(dir, 'report.json'), '{"sender":"child"}');
  await h.next();
  await h.clock.advance(3000);
  assert.equal(h.adapter.turn.finished, true);
  assert.equal((await h.adapter.turn.terminal).text, 'Waiting.\n\nReported');
});

test('Antigravity polls native reports without a wire update and waits for the parent reply', async t => {
  const h = await scriptedAgy(t, [launched, [message('\n\nReported'), usageUpdate]], { GEMINI_HOME: '' });
  const dir = childFiles(h, 'SUBAGENT_STATE_ALIVE');
  // The directory already lists this child while its state file is being written.
  writeFileSync(join(dir, '..', 'subagents', 'child.json'), '{');
  await h.begin();
  await h.clock.advance(30_000);
  writeFileSync(join(dir, 'report.json'), '{"sender":"child"}');
  await h.clock.advance(600_000);
  assert.equal(h.adapter.turn.finished, false, 'a report with no reply yet is not the end');
  await h.next();
  await h.clock.advance(3000);
  assert.equal(h.adapter.turn.finished, true);
  assert.equal((await h.adapter.turn.terminal).text, 'Waiting.\n\nReported');
  assert.equal(h.clock.timers.size, 0);
});

test('Antigravity ends immediately with a KILLED child', async t => {
  const h = await scriptedAgy(t, [launched]);
  childFiles(h, 'SUBAGENT_STATE_KILLED');
  await h.begin();
  assert.equal(h.adapter.turn.finished, true);
  assert.equal((await h.adapter.turn.terminal).usage.partial, undefined);
});

test('Antigravity refuses delivery while open, then interrupts without another prompt response', async t => {
  const h = await scriptedAgy(t, [background]);
  await h.begin();
  assert.equal(h.adapter.turn.finished, false);
  await assert.rejects(h.adapter.deliver({ text: 'another prompt' }), { code: 'DeliveryUnknown' });
  await h.adapter.interrupt();
  await h.next(); // The fake has read the cancel and has sent no prompt response.
  assert.equal(h.frames('session/prompt').length, 1);
  assert.deepEqual(h.frames('session/cancel').map(f => f.params), [{ sessionId: h.historyId }]);
  const result = await h.adapter.turn.terminal;
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.text, 'Waiting.');
  assert.equal(h.clock.timers.size, 0);
});

for (const exit of ['close', 'disconnect']) test(`Antigravity ${exit} releases an open turn and its timer`, async t => {
  const h = await scriptedAgy(t, [background]);
  await h.begin();
  const lost = assert.rejects(h.adapter.turn.terminal, { code: 'ProviderLost' });
  if (exit === 'close') await h.adapter.close();
  else h.adapter.connection.child.stdin.end();
  await lost;
  assert.equal(h.clock.timers.size, 0);
});

for (const stopReason of ['cancelled', 'max_tokens']) test(`Antigravity honors ${stopReason} with unfinished work`, async t => {
  const h = await scriptedAgy(t, [[command('one'), { stopReason }]]);
  await h.begin();
  assert.equal(h.adapter.turn.finished, true);
  assert.equal((await h.adapter.turn.terminal).outcome, stopReason === 'cancelled' ? 'interrupted' : 'failed');
  assert.equal(h.clock.timers.size, 0);
});

for (const receipt of ['error', 'result', 'disconnect']) test(`Antigravity silent prompt receipt: ${receipt}`, async t => {
  const h = await scriptedAgy(t, [], { ACP_FAKE_RECEIPT: receipt });
  let ack, failure;
  h.adapter.deliver({ text: 'silent prompt' }).then(value => { ack = value; }, err => { failure = err; });
  await h.next().catch(err => { if (receipt !== 'disconnect') throw err; });
  assert.deepEqual(lines(h.trace).filter(f => f.method).map(f => f.method).slice(2, 4),
    ['session/prompt', '_agent_companion/received']);
  assert.deepEqual(h.frames('_agent_companion/received')[0].params, { sessionId: h.historyId });
  if (receipt === 'disconnect') assert.equal(failure?.code, 'DeliveryUnknown');
  else {
    assert.deepEqual(ack, { acknowledged: true, nativeTurnId: null, nativeRefs: { promptRequestId: h.frames('session/prompt')[0].id } });
    assert.equal(h.adapter.progress, null);
    assert.equal(h.adapter.turn.finished, false);
  }
});

test('Antigravity receipt write failure leaves delivery unknown', async t => {
  const h = await scriptedAgy(t, []);
  const stdin = h.adapter.connection.child.stdin, write = stdin.write.bind(stdin);
  t.mock.method(stdin, 'write', (frame, callback) => {
    if (JSON.parse(frame).method === '_agent_companion/received') {
      callback(Object.assign(new Error('fixture write failed'), { code: -32 }));
      return false;
    }
    return write(frame, callback);
  });
  let failure;
  h.adapter.deliver({ text: 'silent prompt' }).catch(err => { failure = err; });
  await h.next();
  assert.equal(failure?.code, 'DeliveryUnknown');
  assert.equal(h.frames('_agent_companion/received').length, 0);
});

const firstAnswer = { ...endTurn, promptIndex: 0, usage: { inputTokens: 10, outputTokens: 2 } };

test('Antigravity default steer joins the controller turn and sums both prompt answers', async t => {
  const h = setup(t, { descriptor: getCompanionById('antigravity'), clock: new ManualClock(),
    env: { ACP_FAKE_BATCHES: JSON.stringify([[message('First.')], [command('one'), firstAnswer],
      [completed('one'), message('\nSecond.'), endTurn]]) } });
  h.controller.providers.antigravity = h.controller.providers.fake;
  const sent = await h.send({ companion: 'antigravity' });
  const supervisor = h.supervisors[0];
  t.mock.method(supervisor, 'terminate', supervisor.terminate.bind(supervisor, { graceMs: 0 }));
  const call = args => callTool(args, { controller: h.controller });
  const catalog = await call({ action: 'catalog' });
  assert.deepEqual(catalog.companions.find(t => t.id === 'antigravity').capabilities.interventions,
    { default: 'steer', steer: true, queue: 'bridge', interrupt: true });
  const status = await call({ action: 'status', job_id: sent.jobId });
  assert.deepEqual(status.interventions, { default: 'steer', steer: true, queue: true, interrupt: true });
  const text = 'also do this\n  exactly';
  const ack = await call({ action: 'send', thread: 'child', task: text });
  assert.equal(ack.accepted, true); assert.equal(ack.confirmed, true);
  assert.equal(h.records.readJob(sent.jobId).interventions[0].state, 'joined');
  assert.deepEqual(h.frames('session/prompt')[1].params, { sessionId: 'fake-sess-1', prompt: [{ type: 'text', text }] });
  assert.equal(h.frames('_agent_companion/received').length, 2);
  const adapter = h.adapters[0];
  assert.equal(adapter.turn.finished, false);
  assert.equal(adapter.clock.timers.size, 0, 'the superseded end_turn cannot start a follow-on wait');
  adapter.connection._sendNotification('_fixture/next', {});
  const result = await h.finish(sent);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.text, 'First.\nSecond.');
  assert.deepEqual(result.turns.map(t => [t.nativeTurnId, t.messages]), [[null, [sent.jobId, ack.intervention_id]]]);
  assert.equal(result.interventions[0].state, 'answered');
  assert.deepEqual(result.usage, { source: 'antigravity-acp', input_tokens: 18031, output_tokens: 90,
    cached_input_tokens: 6842, cache_write_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 18121 });
});

test('Antigravity steer replaces an active follow-on wait and preserves partial usage', async t => {
  const h = await scriptedAgy(t, [background, [completed('one'), usageUpdate], [message('\nSteered.'), endTurn]]);
  await h.begin();
  assert.equal(h.clock.timers.size, 1);
  await h.adapter.steer({ text: 'continue' });
  await h.clock.advance(120_000);
  assert.equal(h.adapter.turn.finished, false);
  assert.equal(h.clock.timers.size, 0);
  await h.next();
  const result = await h.adapter.turn.terminal;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.text, 'Waiting.\nSteered.');
  assert.equal(result.usage.partial, true);
  assert.equal(result.usage.total_tokens, 2 * 18109);
});

test('Antigravity counts a late first answer without changing the newest outcome', async t => {
  const h = await scriptedAgy(t, [[message('A')], [message('B'), endTurn], [{ ...firstAnswer, stopReason: 'cancelled' }]]);
  await h.begin();
  await h.adapter.steer({ text: 'more' });
  await h.next();
  const result = await h.adapter.turn.terminal;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.text, 'AB');
  assert.equal(result.usage.total_tokens, 18121);
});

test('Antigravity follows only the last of two steers through background completion', async t => {
  const h = await scriptedAgy(t, [[message('A'), command('one')], [], [message('B'), endTurn],
    [firstAnswer, { ...endTurn, promptIndex: 1 }], [completed('one'), message('C'), usageUpdate]]);
  await h.begin();
  await h.adapter.steer({ text: 'second' });
  await h.adapter.steer({ text: 'third' });
  assert.equal(h.clock.timers.size, 1);
  await h.next();
  assert.equal(h.clock.timers.size, 1, 'late responses cannot replace the follow-on timer');
  await h.clock.advance(120_000);
  assert.equal(h.adapter.turn.finished, false);
  await h.next();
  await h.clock.advance(2999);
  assert.equal(h.adapter.turn.finished, false);
  await h.clock.advance(1);
  const result = await h.adapter.turn.terminal;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.text, 'ABC');
  assert.equal(result.usage.total_tokens, 2 * 18109 + 12);
  assert.equal(result.usage.partial, true);
  assert.equal(h.clock.timers.size, 0);
});

for (const ackBy of ['update', 'response']) test(`Antigravity steer can be acknowledged by its ${ackBy}`, async t => {
  const h = await scriptedAgy(t, [[message('A')], [firstAnswer], [], ackBy === 'update' ? [message('B')] : [endTurn], [endTurn]],
    { ACP_FAKE_RECEIPT: 'silent' });
  await h.begin();
  let ack;
  const steering = h.adapter.steer({ text: 'more' }).then(value => { ack = value; });
  await h.next(); // The fake read the steer and answered only the first prompt.
  assert.equal(ack, undefined, 'the old prompt response cannot acknowledge the steer');
  await h.next();
  assert.equal(ack?.accepted, true);
  await steering;
  if (ackBy === 'update') await h.next();
  assert.equal((await h.adapter.turn.terminal).outcome, 'completed');
});

test('Antigravity interrupt after steer waits for the newest cancelled response', async t => {
  const h = await scriptedAgy(t, [[command('one')], [], [firstAnswer], [{ stopReason: 'cancelled' }]]);
  await h.begin();
  await h.adapter.steer({ text: 'more' });
  const interrupted = h.adapter.interrupt();
  await h.next();
  assert.equal(h.frames('session/cancel').length, 1);
  assert.equal(h.adapter.turn.finished, false);
  await h.next();
  await interrupted;
  const result = await h.adapter.turn.terminal;
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.usage.total_tokens, 18121);
  assert.equal(h.clock.timers.size, 0);
});

test('Antigravity refuses steer before and after a turn', async t => {
  const h = await scriptedAgy(t, [[endTurn]]);
  await assert.rejects(h.adapter.steer({ text: 'early' }), { code: 'DeliveryUnknown' });
  await h.begin();
  await assert.rejects(h.adapter.steer({ text: 'late' }), { code: 'DeliveryUnknown' });
  assert.equal(h.frames('session/prompt').length, 1);
});

test('Antigravity fails the turn when the newest prompt is refused', async t => {
  const h = await scriptedAgy(t, [[message('A')], [{ error: { code: -32603, message: 'steer refused' } }]]);
  await h.begin();
  await assert.rejects(h.adapter.steer({ text: 'more' }), { code: 'DeliveryUnknown' });
  const result = await h.adapter.turn.terminal;
  assert.equal(result.outcome, 'failed');
  assert.equal(result.detail, 'steer refused');
  assert.equal(result.text, 'A');
});

test('Antigravity loses the steered turn when the connection dies', async t => {
  const h = await scriptedAgy(t, [background, []]);
  await h.begin();
  await h.adapter.steer({ text: 'more' });
  const lost = assert.rejects(h.adapter.turn.terminal, { code: 'ProviderLost' });
  h.adapter.connection.child.stdin.end();
  await lost;
  assert.equal(h.clock.timers.size, 0);
});
