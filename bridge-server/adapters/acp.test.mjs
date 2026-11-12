import '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import { FAKE_ACP_AGENT, fakeAcpDescriptor } from '../../test/fake-acp-agent.mjs';
import { until } from '../../test/controller/helpers.mjs';
import { Controller } from '../controller/controller.mjs';
import { Records } from '../controller/records.mjs';
import { ProcessSupervisor } from '../controller/process-supervisor.mjs';
import { pidAlive } from '../../bridge-server/controller/process-supervisor.mjs';
import { getTargetById } from '../../lib/target-registry.mjs';
import { writeTargetChecks, isModelAllowedFor } from '../../lib/state.mjs';
import { AcpAdapter, acpProvider } from './acp.mjs';
import { dispatch } from '../server.mjs';

const lines = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

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
  const finish = async (sent) => sent.outcome ? sent : controller.wait({ owner: 'child', executionId: sent.executionId });
  const frames = (method) => lines(trace).filter((frame) => frame.method === method);
  return { dir, bin, childEnv, records, controller, adapters, supervisors, progress, logs, send, finish, frames, trace };
}

const modeled = () => {
  const descriptor = getTargetById('antigravity');
  return { ...descriptor, acp: { ...descriptor.acp, defaultModel: () => 'fake-model-a' } };
};

test('new session then cold follow-up loads the same history in a new process and reapplies the model', async (t) => {
  const h = setup(t, { descriptor: modeled() });
  const first = await h.finish(await h.send());
  const second = await h.finish(await h.send({ text: 'CONTINUATION\nexact follow-up', model: 'fake-model-b' }));
  assert.equal(first.outcome, 'completed'); assert.equal(second.outcome, 'completed');
  assert.equal(second.nativeRefs.sessionId, first.nativeRefs.sessionId);
  assert.notEqual(h.supervisors[0].serialize().pid, h.supervisors[1].serialize().pid);
  assert.equal(second.text, 'continued'); // Replayed "earlier answer" is excluded.
  assert.equal(first.effectiveModel, 'fake-model-a'); assert.equal(second.effectiveModel, 'fake-model-b');
  const methods = lines(h.trace).filter((f) => f.method).map((f) => f.method);
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/set_config_option', 'session/prompt',
    'initialize', 'session/load', 'session/set_config_option', 'session/prompt']);
  assert.deepEqual(h.frames('session/prompt').map((f) => f.params.prompt), [
    [{ type: 'text', text: 'exact text\n  with spacing' }], [{ type: 'text', text: 'CONTINUATION\nexact follow-up' }],
  ]);
  assert.equal(h.frames('initialize')[0].params.protocolVersion, 1);
  assert.equal(h.frames('initialize')[0].params.clientInfo.name, modeled().acp.clientName);
  assert.ok(first.stopEvidence.gone && second.stopEvidence.gone);
  assert.equal(second.usage, null); // Antigravity has no measured native usage.
  assert.equal(second.nativeRefs.promptId, h.frames('session/prompt')[1].id);
});

test('Copilot-style follow-up is refused with FOLLOWUP_UNSUPPORTED before any process starts', async (t) => {
  const h = setup(t, { descriptor: getTargetById('copilot'), env: { ACP_FIXTURE_USAGE: 'copilot' } });
  const first = await h.finish(await h.send({ model: 'gpt-5' }));
  assert.equal(first.outcome, 'completed'); assert.equal(first.usage.input_tokens, 1234);
  await assert.rejects(h.send({ text: 'follow-up' }), { code: 'FOLLOWUP_UNSUPPORTED' });
  assert.equal(h.supervisors.length, 1); assert.equal(h.frames('session/new').length, 1);
  assert.equal(h.frames('session/load').length, 0);
  assert.ok(lines(h.trace)[0].argv.includes('--model'));
});

test('Copilot OTEL usage is execution-private and temporary files are removed on close', async (t) => {
  const h = setup(t, { descriptor: getTargetById('copilot'), env: { ACP_FAKE_USAGE: 'none', ACP_FIXTURE_USAGE: 'otel' } });
  const result = await h.finish(await h.send());
  assert.equal(result.usage.source, 'copilot-otel'); assert.equal(result.usage.input_tokens, 1234);
  assert.equal(existsSync(h.adapters[0].paths.otelTraces), false);
});

test('a refused model after load keeps the original history and never delivers another prompt', async (t) => {
  const h = setup(t, { descriptor: modeled() });
  const first = await h.finish(await h.send());
  const second = await h.send({ text: 'follow-up', model: 'not-a-model' });
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
    const h = setup(t, { descriptor: modeled(), env: { ACP_FIXTURE_FAULT: fault } });
    const result = await h.send({ model: fault === 'refused' ? 'not-a-model' : 'fake-model-a' });
    assert.equal(result.outcome, 'failed');
    assert.equal(h.records.readExecution(result.executionId).terminal.error, 'MODEL_NOT_ALLOWED');
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
    const provider = acpProvider(id, { env: { PATH: '', COPILOT_BIN: '/missing', ANTIGRAVITY_ACP_BIN: '/missing' } });
    assert.equal(provider.enabled, true); assert.equal(provider.ready, loadsHistory);
    assert.equal(provider.modelAllowed('test-model'), isModelAllowedFor(id, 'test-model'));
    assert.deepEqual(provider.create().capabilities, { followUp: loadsHistory, steer: false, modelSelection: true, loadsHistory });
  }
  assert.throws(() => acpProvider('codex'), /ACP/);
});

const agyModels = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-pro-agent'];
const agySetup = t => {
  const h = setup(t, { descriptor: getTargetById('antigravity'), env: { ACP_FAKE_MODELS: JSON.stringify(agyModels) } });
  h.childEnv.ACP_FAKE_MODEL_STATE = join(h.dir, 'model-state');
  h.controller.providers.antigravity = h.controller.providers.fake;
  h.send = (args = {}) => h.controller.send({ owner: 'child', provider: 'antigravity', cwd: h.dir, text: 'test', ...args });
  return h;
};

test('Antigravity inherits reported effort and reapplies selected effort as a model on cold load', async t => {
  const h = agySetup(t);
  assert.equal((await h.finish(await h.send())).effectiveEffort, 'high');
  assert.equal(h.frames('session/set_config_option').length, 0);
  const first = await h.send({ model: 'gemini-3.8-flash-high', effort: 'low' });
  assert.equal(first.effectiveModel, 'gemini-3.8-flash-low'); assert.equal(first.effectiveEffort, 'low');
  await h.finish(first);
  const next = await h.finish(await h.send({ text: 'again' }));
  assert.equal(next.selectedEffort, 'low'); assert.equal(next.effectiveEffort, 'low');
  assert.ok(h.frames('session/set_config_option').every(f => f.params.value === 'gemini-3.8-flash-low'));
});

for (const model of [undefined, 'gemini-3.8-flash-medium', 'gemini-pro-agent']) {
  test(`Antigravity refuses effort before session config writes: ${model ?? 'current model'}`, async t => {
    const h = agySetup(t);
    await h.finish(await h.send({ model: 'gemini-3.8-flash-high' }));
    const before = readFileSync(h.childEnv.ACP_FAKE_MODEL_STATE, 'utf8');
    const writes = h.frames('session/set_config_option').length;
    const refused = (await dispatch({ action: 'send', target: 'antigravity', thread: 'child', cwd: h.dir, task: 'refuse',
      effort: 'ultra', ...(model ? { model } : {}) }, { controller: h.controller })).structuredContent;
    assert.equal(refused.status, 'failed'); assert.equal(refused.meta.detail, 'EFFORT_NOT_ALLOWED');
    assert.match(refused.content, model === 'gemini-pro-agent' ? /[Oo]mit effort/ : /high, medium, low/);
    assert.equal(h.frames('session/set_config_option').length, writes);
    assert.equal(h.frames('session/prompt').length, 1);
    assert.equal(readFileSync(h.childEnv.ACP_FAKE_MODEL_STATE, 'utf8'), before);
    if (!model) t.diagnostic('EFFORT_ENVELOPE antigravity ' + JSON.stringify(refused));
  });
}

test('Antigravity rejects ignored effort, does not infer effort from an unrelated model suffix', async t => {
  const h = agySetup(t);
  assert.equal((await h.finish(await h.send({ model: 'gemini-pro-agent' }))).effectiveEffort ?? null, null);
  h.childEnv.ACP_FAKE_IGNORE_MODEL = '1';
  const refused = await h.send({ model: 'gemini-3.8-flash', effort: 'low' });
  assert.equal(refused.detail, 'CAPABILITY_UNAVAILABLE');
  assert.match(refused.text, /did not apply/);
  assert.equal(h.frames('session/prompt').length, 1);
});

for (const effort of [undefined, 'none', 'low', 'max']) test(`Copilot launch effort ${effort ?? 'inherits'}`, async t => {
  const h = setup(t, { descriptor: getTargetById('copilot') });
  const result = await h.finish(await h.send({ effort }));
  const argv = lines(h.trace)[0].argv;
  if (effort === undefined) assert.equal(argv.includes('--reasoning-effort'), false);
  else assert.equal(argv[argv.indexOf('--reasoning-effort') + 1], effort);
  assert.equal(result.effectiveEffort ?? null, null);
});


for (const effort of [undefined, 'low']) test(`Antigravity config connection loss with ${effort ?? 'no'} effort remains HistoryUnavailable`, async t => {
  const h = agySetup(t);
  h.childEnv.ACP_FAKE_MODEL_DISCONNECT = '1';
  const failed = await h.send({ model: 'gemini-3.8-flash-high', effort });
  assert.equal(failed.detail, 'history_unavailable');
  assert.equal(h.records.readExecution(failed.executionId).terminal.error, 'HistoryUnavailable');
  assert.equal(h.frames('session/set_config_option').length, 1);
  assert.equal(h.frames('session/prompt').length, 0);
  assert.equal(h.records.readConversation('child').effortOverride, undefined);
});
