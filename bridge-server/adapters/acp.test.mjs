import '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import { FAKE_ACP_AGENT, fakeAcpDescriptor } from '../../test/fake-acp-agent.mjs';
import { waitForResult, until } from '../../test/controller/helpers.mjs';
import { Controller } from '../controller/controller.mjs';
import { Records } from '../controller/records.mjs';
import { ProcessSupervisor } from '../controller/process-supervisor.mjs';
import { pidAlive } from '../../bridge-server/controller/process-supervisor.mjs';
import { getTargetById } from '../../lib/target-registry.mjs';
import { writeTargetChecks, isModelAllowedFor } from '../../lib/state.mjs';
import { AcpAdapter, acpProvider } from './acp.mjs';
import { dispatch } from '../server.mjs';
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

for (const target of ['copilot', 'antigravity']) test(`ACP AUTH_REQUIRED controller send relays ${target} sign-in steps without retry`, async t => {
  const descriptor = getTargetById(target);
  const h = setup(t, { descriptor, env: { ACP_FAKE_AUTH_REQUIRED: '1' } });
  h.controller.providers[target] = h.controller.providers.fake;
  const sent = (await dispatch({ action: 'send', target, thread: 'child', cwd: h.dir, task: 'hello' }, { controller: h.controller })).structuredContent;
  const result = h.records.readResult(sent.job_id);
  const terminal = h.records.readExecution(sent.job_id).terminal;
  t.diagnostic('AUTH_REQUIRED_TERMINAL ' + JSON.stringify({ outcome: result.outcome, error: terminal.error, text: result.text }));
  assert.equal(result.outcome, 'failed');
  assert.equal(terminal.error, 'AUTH_REQUIRED');
  assert.equal(result.cause, 'provider_error');
  assert.equal(sent.status, 'failed'); assert.equal(sent.meta.detail, 'AUTH_REQUIRED');
  assert.equal(result.text, ['Authentication required.', ...descriptor.auth.nextSteps].join(' '));
  assert.equal(result.text.split('Authentication required').length - 1, 1);
  const waited = (await dispatch({ action: 'wait', job_id: sent.job_id, thread: 'child' }, { controller: h.controller })).structuredContent;
  const status = (await dispatch({ action: 'status', job_id: sent.job_id }, { controller: h.controller })).structuredContent;
  assert.equal(sent.content, result.text); assert.equal(waited.content, result.text); assert.equal(status.partial_text, result.text);
  assert.equal(h.frames('session/new').length, 1); assert.equal(h.frames('session/prompt').length, 0);
  assert.ok(result.stopEvidence.gone);
});

for (const fault of ['session-new-error', 'session-new-empty-error', 'session-new-object-error']) {
  test(`ACP session/new relays only a string message: ${fault}`, async t => {
    const h = setup(t, { descriptor: getTargetById('copilot'), env: { ACP_FIXTURE_FAULT: fault } });
    h.controller.providers.copilot = h.controller.providers.fake;
    const sent = (await dispatch({ action: 'send', target: 'copilot', thread: 'child', cwd: h.dir, task: 'hello' }, { controller: h.controller })).structuredContent;
    assert.equal(sent.status, 'failed'); assert.equal(sent.meta.detail, 'history_unavailable');
    const message = '403 "unauthorized: not authorized to use this Copilot feature\\n"';
    if (fault === 'session-new-error') assert.equal(sent.content, message);
    else assert.doesNotMatch(sent.content, /data|headers|\[object Object\]/);
    const waited = (await dispatch({ action: 'wait', job_id: sent.job_id, thread: 'child' }, { controller: h.controller })).structuredContent;
    const status = (await dispatch({ action: 'status', job_id: sent.job_id }, { controller: h.controller })).structuredContent;
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
  assert.equal(result.text, fault === 'prompt-error' ? 'prompt refused' : 'ready\n\nprompt refused');
  assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
});

function setup(t, { descriptor = fakeAcpDescriptor(), env = {} } = {}) {
  const dir = mkdtempSync(join(SANDBOX_HOME, 'owned-acp-'));
  const bin = join(dir, 'agent.mjs');
  writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('../../test/adapters/acp-fixture.mjs', import.meta.url).href)};\n${FAKE_ACP_AGENT}`, { mode: 0o700 });
  const trace = join(dir, 'trace.jsonl'), rowsPath = join(dir, 'rows.jsonl');
  const childEnv = { ...process.env, HOME: dir, [descriptor.binaryEnv]: bin, ACP_FAKE_TRACE: trace,
    ACP_FAKE_LOAD_SESSION: '1', ACP_FIXTURE_ROWS: rowsPath, ...env };
  const records = new Records({ dir: join(dir, 'records'), log: () => {} });
  const adapters = [], supervisors = [], progress = [], logs = [];
  const controller = new Controller({ records, env: childEnv,
    providers: { fake: { enabled: true, ready: true, modelAllowed: () => true, create() {
      const adapter = new AcpAdapter(descriptor, { log: (...args) => logs.push(args) });
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
  const send = (args = {}) => controller.send({ owner: 'child', provider: 'fake', cwd: dir, text: 'exact text\n  with spacing', ...args });
  const finish = async (sent) => sent.outcome ? sent : waitForResult(controller, { owner: 'child', executionId: sent.executionId });
  const frames = (method) => lines(trace).filter((frame) => frame.method === method);
  return { dir, bin, childEnv, records, controller, adapters, supervisors, progress, logs, send, finish, frames, trace };
}

test('new session then cold follow-up loads the same history in a new process and reapplies the model', async (t) => {
  const h = setup(t, { descriptor: getTargetById('antigravity') });
  const first = await h.finish(await h.send({ model: 'gemini-3.8-flash' }));
  const second = await h.finish(await h.send({ text: 'CONTINUATION\nexact follow-up', model: 'claude-sonnet-4-6' }));
  assert.equal(first.outcome, 'completed'); assert.equal(second.outcome, 'completed');
  assert.equal(second.nativeRefs.sessionId, first.nativeRefs.sessionId);
  assert.notEqual(h.supervisors[0].serialize().pid, h.supervisors[1].serialize().pid);
  assert.equal(second.text, 'continued'); // Replayed "earlier answer" is excluded.
  assert.equal(first.effectiveModel, 'gemini-3.8-flash'); assert.equal(second.effectiveModel, 'claude-sonnet-4-6');
  const methods = lines(h.trace).filter((f) => f.method).map((f) => f.method);
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/set_config_option', 'session/prompt',
    'initialize', 'session/load', 'session/set_config_option', 'session/prompt']);
  assert.deepEqual(h.frames('session/prompt').map((f) => f.params.prompt), [
    [{ type: 'text', text: 'exact text\n  with spacing' }], [{ type: 'text', text: 'CONTINUATION\nexact follow-up' }],
  ]);
  assert.equal(h.frames('initialize')[0].params.protocolVersion, 1);
  assert.equal(h.frames('initialize')[0].params.clientInfo.name, getTargetById('antigravity').acp.clientName);
  assert.ok(first.stopEvidence.gone && second.stopEvidence.gone);
  assert.deepEqual(second.usage, { source: 'antigravity-acp', input_tokens: 18021, output_tokens: 88,
    cached_input_tokens: 6842, cache_write_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 18109 });
  assert.equal(second.nativeRefs.promptRequestId, h.frames('session/prompt')[1].id);
});

test('Copilot sets the session model before prompting and refuses cold follow-up', async (t) => {
  const h = setup(t, { descriptor: getTargetById('copilot'), env: { ACP_FIXTURE_USAGE: 'copilot', ACP_FAKE_MODELS: '["auto","local-model"]' } });
  const first = await h.finish(await h.send({ model: 'local-model' }));
  assert.equal(first.outcome, 'completed'); assert.equal(first.usage.input_tokens, 1234);
  assert.equal(first.effectiveModel, 'local-model');
  assert.equal(lines(h.trace)[0].argv.includes('--model'), false);
  assert.deepEqual(lines(h.trace).filter(f => f.method).map(f => f.method),
    ['initialize', 'session/new', 'session/set_config_option', 'session/prompt']);
  assert.deepEqual(h.frames('session/set_config_option')[0].params,
    { sessionId: first.nativeRefs.sessionId, configId: 'model', value: 'local-model' });
  await assert.rejects(h.send({ text: 'follow-up' }), { code: 'FOLLOWUP_UNSUPPORTED' });
  assert.equal(h.supervisors.length, 1); assert.equal(h.frames('session/new').length, 1);
  assert.equal(h.frames('session/load').length, 0);
});

for (const model of ['bogus-model', 'local-model']) test(`Copilot refuses an unavailable or unconfirmed model before delivery: ${model}`, async t => {
  const models = ['auto', ...Array.from({ length: 50 }, (_, i) => `session-model-${i}`), 'local-model'];
  const h = setup(t, { descriptor: getTargetById('copilot'), env: {
    ACP_FAKE_MODELS: JSON.stringify(models), ACP_FAKE_IGNORE_MODEL: '1',
  } });
  h.controller.providers.copilot = h.controller.providers.fake;
  const sent = (await dispatch({ action: 'send', target: 'copilot', thread: 'child', cwd: h.dir, task: 'hello', model },
    { controller: h.controller })).structuredContent;
  assert.equal(sent.status, 'failed');
  assert.equal(sent.meta.detail, 'MODEL_NOT_ALLOWED');
  assert.ok(sent.content.includes(`model "${model}"`));
  assert.ok(sent.content.includes(`Use one of: ${models.join(', ')}, or omit it to inherit configuration.`));
  assert.equal(h.frames('session/set_config_option').length, 1);
  assert.equal(h.frames('session/prompt').length, 0);
});

test('Copilot preserves the native model refusal as the cause', async t => {
  const h = setup(t, { descriptor: getTargetById('copilot'), env: { ACP_FAKE_MODELS: '["auto","local-model"]' } });
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
  const h = setup(t, { descriptor: getTargetById('copilot'), env: {
    ACP_FAKE_MODELS: '["auto","local-model"]', ACP_FAKE_THOUGHT_LEVELS: '{"auto":["medium"],"local-model":["medium","high"]}',
  } });
  const result = await h.finish(await h.send({ model: 'local-model', effort: 'high' }));
  assert.equal(result.effectiveModel, 'local-model');
  assert.equal(result.effectiveEffort, 'high');
  assert.deepEqual(h.frames('session/set_config_option').map(f => [f.params.configId, f.params.value]),
    [['model', 'local-model'], ['reasoning_effort', 'high']]);
});

test('Copilot OTEL usage is execution-private and temporary files are removed on close', async (t) => {
  const h = setup(t, { descriptor: getTargetById('copilot'), env: { ACP_FAKE_USAGE: 'none', ACP_FIXTURE_USAGE: 'otel' } });
  const result = await h.finish(await h.send());
  assert.equal(result.usage.source, 'copilot-otel'); assert.equal(result.usage.input_tokens, 1234);
  assert.equal(existsSync(h.adapters[0].paths.otelTraces), false);
});

test('a refused model after load keeps the original history and never delivers another prompt', async (t) => {
  const h = setup(t, { descriptor: getTargetById('antigravity') });
  const first = await h.finish(await h.send());
  const second = await h.send({ text: 'follow-up', model: 'gemini-9-nope' });
  assert.equal(h.records.readExecution(second.executionId).terminal.error, 'MODEL_NOT_ALLOWED');
  assert.equal(h.records.readConversation('child').historyId, first.nativeRefs.historyId);
  assert.equal(h.frames('session/new').length, 1); assert.equal(h.frames('session/load').length, 1);
  assert.equal(h.frames('session/prompt').length, 1); assert.ok(second.stopEvidence.gone);
});

for (const options of [{ env: { ACP_FAKE_LOAD_SESSION: '0' } }, { env: { ACP_FAKE_LOAD_FAIL: '1' } }]) {
  test(`history refusal never creates a replacement: ${Object.keys(options.env)[0]}`, async (t) => {
    const h = setup(t, options);
    const first = await h.finish(await h.send());
    const second = await h.send({ text: 'follow-up' });
    assert.equal(second.outcome, 'failed'); assert.equal(second.detail, 'history_unavailable');
    assert.equal(h.records.readExecution(second.executionId).terminal.error, 'HistoryUnavailable');
    assert.equal(h.frames('session/new').length, 1); assert.equal(h.frames('session/prompt').length, 1);
    assert.equal(h.records.readConversation('child').historyId, first.nativeRefs.historyId);
    assert.ok(second.stopEvidence.gone);
  });
}

for (const fault of ['refused', 'wrong-model', 'missing-model']) {
  test(`model selection surfaces MODEL_NOT_ALLOWED on ${fault}`, async (t) => {
    const h = setup(t, { descriptor: getTargetById('antigravity'), env: { ACP_FIXTURE_FAULT: fault } });
    const result = await h.send({ model: fault === 'refused' ? 'gemini-9-nope' : 'gemini-3.8-flash' });
    assert.equal(result.outcome, 'failed');
    assert.equal(h.records.readExecution(result.executionId).terminal.error, 'MODEL_NOT_ALLOWED');
    if (fault === 'wrong-model') assert.match(result.text, /Use one of: gemini-3.8-flash,/);
    assert.equal(h.frames('session/prompt').length, 0); assert.ok(result.stopEvidence.gone);
  });
}

for (const [policy, kind, optionId] of [['all', 'execute', 'proceed_once'], ['edit', 'edit', 'proceed_once'], ['edit', 'execute', 'cancel'], ['none', 'execute', 'cancel']]) {
  test(`permission ${policy}/${kind} is answered from the execution env and completes`, async (t) => {
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
  assert.equal(h.records.readResult(sent.executionId), null);
  await until(() => h.progress.some((p) => p.activeCommand), 'command progress');
  assert.ok(h.progress.some((p) => p.retry?.attempt === 2));
  assert.ok(h.progress.every((p) => Number.isFinite(p.lastActivityAt)));
  const result = await h.controller.cancel({ owner: 'child', executionId: sent.executionId });
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
    assert.equal(h.records.readExecution(result.executionId).terminal.error, 'DeliveryUnknown');
    assert.equal(h.frames('session/prompt').length, 1); assert.ok(result.stopEvidence.gone);
  });
}

test('no native acknowledgement times out as DeliveryUnknown without resending', async (t) => {
  const h = setup(t, { env: { ACP_FIXTURE_FAULT: 'silent' } });
  const result = await h.send();
  assert.equal(result.outcome, 'delivery_unknown'); assert.equal(h.frames('session/prompt').length, 1);
  assert.equal(h.records.readExecution(result.executionId).terminal.error, 'DeliveryUnknown');
  assert.ok(result.stopEvidence.gone);
});

test('transport death after acceptance rejects ProviderLost and preserves partial progress', async (t) => {
  const h = setup(t, { env: { ACP_FIXTURE_FAULT: 'die-after-ack', ACP_FAKE_TURN_MS: '60000' } });
  const result = await h.finish(await h.send());
  assert.equal(result.outcome, 'failed');
  assert.equal(h.records.readExecution(result.executionId).terminal.error, 'ProviderLost');
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
  assert.equal(h.records.readExecution(result.executionId).terminal.error, 'ACP_PROTOCOL_MISMATCH');
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
  writeTargetChecks({ antigravity: { ready: true }, copilot: { ready: false } });
  for (const [id, loadsHistory] of [['antigravity', true], ['copilot', false]]) {
    const provider = acpProvider(id, { env: { PATH: '', COPILOT_BIN: '/missing', ANTIGRAVITY_BIN: '/missing' } });
    assert.equal(provider.enabled, true); assert.equal(provider.ready, loadsHistory);
    assert.equal(provider.modelAllowed('test-model'), isModelAllowedFor(id, 'test-model'));
    const { capabilities } = provider.create();
    assert.deepEqual(capabilities, { followUp: loadsHistory, modelSelection: true, loadsHistory,
      interventions: getTargetById(id).capabilities.interventions });
    assert.equal(capabilities.interventions, getTargetById(id).capabilities.interventions);
  }
  assert.throws(() => acpProvider('codex'), /ACP/);
});

test('Antigravity inherits thought_level and reapplies the saved override after cold load', async t => {
  const h = setup(t, { descriptor: getTargetById('antigravity') });
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
  const h = setup(t, { descriptor: getTargetById('antigravity'), env: { ACP_FAKE_REFUSE_EFFORT: '1' } });
  const result = await h.send({ effort });
  assert.equal(result.detail, 'EFFORT_NOT_ALLOWED');
  assert.match(result.text, effort === 'ultra' ? /low, medium, high/ : /Thinking level "low" is not offered/);
  assert.equal(h.frames('session/set_config_option').length, effort === 'ultra' ? 0 : 1);
  assert.equal(h.frames('session/prompt').length, 0);
  assert.equal(h.records.readConversation('child').effortOverride, undefined);
});

for (const replay of ['empty', 'other-session']) test(`Antigravity refuses cold load with ${replay} replay before config or prompt`, async t => {
  const h = setup(t, { descriptor: getTargetById('antigravity'), env: { ACP_FAKE_LOAD_REPLAY: replay } });
  const first = await h.finish(await h.send());
  const next = await h.finish(await h.send({ model: 'gemini-3.8-flash', effort: 'low', text: 'follow-up' }));
  assert.equal(h.records.readExecution(next.executionId).terminal.error, 'HistoryUnavailable');
  assert.equal(h.records.readConversation('child').historyId, first.nativeRefs.historyId);
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
    const h = setup(t, { descriptor: getTargetById('antigravity'), env: {
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
  const h = setup(t, { descriptor: getTargetById('antigravity'), env: { ACP_FAKE_USAGE: 'none' } });
  const result = await h.finish(await h.send());
  assert.equal(result.usage, null);
});

for (const effort of [undefined, 'low', 'max']) test(`Copilot session effort ${effort ?? 'inherits'}`, async t => {
  const h = setup(t, { descriptor: getTargetById('copilot'), env: { ACP_FAKE_MODELS: '["auto","local-model"]', ACP_FAKE_THOUGHT_LEVELS: '["low","medium","high","xhigh","max"]' } });
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
  const h = setup(t, { descriptor: getTargetById('copilot'), env: { ACP_FAKE_THOUGHT_LEVELS: '["low","medium","high","xhigh","max"]',
    ACP_FAKE_IGNORE_EFFORT: fault === 'ignored' ? '1' : '', ACP_FAKE_MISSING_EFFORT: fault === 'missing' ? '1' : '' } });
  h.controller.providers.copilot = h.controller.providers.fake;
  const sent = (await dispatch({ action: 'send', target: 'copilot', thread: 'child', cwd: h.dir, task: 'hello',
    effort: fault === 'refused' ? 'none' : 'low' }, { controller: h.controller })).structuredContent;
  if (fault === 'confirmed') {
    assert.equal(sent.status, 'still_running'); assert.equal(sent.effective_effort, 'low');
    const result = await h.finish({ executionId: sent.job_id }); assert.equal(result.effectiveEffort, 'low');
  } else {
    assert.equal(sent.status, 'failed');
    assert.equal(sent.meta.detail, fault === 'refused' ? 'EFFORT_NOT_ALLOWED' : 'CAPABILITY_UNAVAILABLE');
    assert.match(sent.content, fault === 'refused' ? /Use one of: low, medium, high, xhigh, max/ : /did not confirm effort/);
    assert.equal(h.frames('session/prompt').length, 0);
    assert.equal(h.frames('session/set_config_option').length, fault === 'refused' ? 0 : 1);
    assert.equal(h.records.readConversation('child').effortOverride, undefined);
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
  const h = setup(t, { descriptor: getTargetById('antigravity') });
  h.childEnv.ACP_FAKE_MODEL_DISCONNECT = '1';
  const failed = await h.send({ model: 'gemini-3.8-flash', effort });
  assert.equal(failed.detail, 'history_unavailable');
  assert.equal(h.records.readExecution(failed.executionId).terminal.error, 'HistoryUnavailable');
  assert.equal(h.frames('session/set_config_option').length, 1);
  assert.equal(h.frames('session/prompt').length, 0);
  assert.equal(h.records.readConversation('child').effortOverride, undefined);
});

test('ACP acknowledges delivery without inventing a native turn id', async t => {
  const h = setup(t);
  const sent = await h.send();
  assert.equal(sent.acknowledged, true);
  const execution = h.records.readExecution(sent.executionId);
  assert.equal(execution.nativeTurnId, null);
  assert.equal(execution.nativeRefs.promptRequestId, h.frames('session/prompt')[0].id);
  const result = await h.finish(sent);
  assert.equal(result.nativeRefs.promptRequestId, h.frames('session/prompt')[0].id);
  assert.equal(Object.hasOwn(result.nativeRefs, 'promptId'), false);
});

const input = (h, sent, mode, text) => h.controller.intervene({ executionId: sent.executionId, from: 'user', mode, text });
const releasePrompt = (h, index) => writeFileSync(`${h.childEnv.ACP_FIXTURE_GATE}.${h.frames('session/prompt')[index].id}`, '');

test('Antigravity queues on the live process and session, keeping both answers without invented turn ids', async t => {
  const h = setup(t, { descriptor: getTargetById('antigravity') });
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
  assert.deepEqual(result.turns.map(t => t.messages), [[sent.executionId], [queued.id]]);
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
  const h = setup(t, { descriptor: getTargetById('antigravity') });
  h.childEnv.ACP_FIXTURE_GATE = join(h.dir, 'release');
  const sent = await h.send({ text: 'sleep:60000 original task' });
  assert.deepEqual(await input(h, sent, 'steer', 'unsupported'), { ok: false, status: 'intervention_unavailable', reason: 'capability' });
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

test('Copilot refuses every intervention mode without writes, while cancel still works', async t => {
  const h = setup(t, { descriptor: getTargetById('copilot') });
  const sent = await h.send({ text: 'sleep:60000' });
  for (const mode of ['steer', 'queue', 'interrupt']) {
    assert.deepEqual(await input(h, sent, mode, 'not supported'), { ok: false, status: 'intervention_unavailable', reason: 'capability' });
  }
  assert.deepEqual(h.records.readExecution(sent.executionId).interventions, []);
  assert.equal(h.frames('session/cancel').length, 0); assert.equal(h.frames('session/prompt').length, 1);
  const result = await h.controller.cancel({ owner: 'child', executionId: sent.executionId });
  assert.equal(result.outcome, 'interrupted'); assert.equal(h.frames('session/cancel').length, 1);
  await assert.rejects(h.adapters[0].deliver({ text: 'unqualified follow-up' }), { code: 'DeliveryUnknown' });
});

test('ACP resets the usage window and collectors for each descriptor-enabled bridge turn', async t => {
  const descriptor = fakeAcpDescriptor(), usage = descriptor.acp.usage, windows = [];
  descriptor.capabilities.interventions = getTargetById('antigravity').capabilities.interventions;
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
