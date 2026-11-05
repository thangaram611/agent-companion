import '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import { ManualClock, until } from '../../test/controller/helpers.mjs';
import { ProcessSupervisor } from '../controller/process-supervisor.mjs';
import { Controller } from '../controller/controller.mjs';
import { Records } from '../controller/records.mjs';
import { pidAlive } from '../../lib/shared-runtime-registry.mjs';
import { writeTargetChecks } from '../../lib/state.mjs';
import { opencodeProvider } from './opencode.mjs';

const fake = fileURLToPath(new URL('../../test/adapters/fake-opencode.mjs', import.meta.url));

function setup(t, extra = {}) {
  const dir = realpathSync(mkdtempSync(join(SANDBOX_HOME, 'opencode-adapter-')));
  const bin = join(dir, 'opencode');
  writeFileSync(bin, `#!${process.execPath}\nawait import(${JSON.stringify(fake)});\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir,
    OPENCODE_BIN: bin, FAKE_OPENCODE_DIR: dir, AGENT_COMPANION_OPENCODE_MODEL: '', ...extra };
  writeTargetChecks({ opencode: { ready: true, binary: bin, version: '2.2.5' } });
  const clock = new ManualClock();
  const records = new Records({ dir: join(dir, 'records') });
  const adapters = [], supervisors = [], advancedCleanup = new Set();
  const provider = opencodeProvider({ env });
  const create = provider.create;
  provider.create = () => { const adapter = create(); adapters.push(adapter); return adapter; };
  const controller = new Controller({ providers: { opencode: provider }, env, records, clock, createSupervisor(opts) {
    // Like test/controller/fixture-table.mjs: real processes/signals, fixture
    // identities instead of ps (denied by the macOS sandbox). No OS-census claim.
    const supervisor = new ProcessSupervisor({ ...opts, processTable: async () => {
      const pid = supervisor.record.pid;
      if (!pid) return new Map();
      const path = join(dir, `${pid}.json`);
      await until(() => existsSync(path) || !pidAlive(pid), 'fixture process identity');
      if (!existsSync(path)) return new Map();
      return new Map(JSON.parse(readFileSync(path, 'utf8')).filter(r => pidAlive(r.pid)).map(r => [r.pid, r]));
    } });
    supervisors.push(supervisor); return supervisor;
  } });
  t.after(async () => {
    for (const a of controller.live.values()) await settle(controller.cancel({ owner: a.record.owner, executionId: a.record.executionId }));
    await Promise.all(adapters.map(a => a.close()));
    for (const s of supervisors) {
      const stopping = s.terminate({ graceMs: 0 });
      await until(async () => (await s.verifyGone()).gone, 'fixture reaped');
      await clock.advance(500);
      await stopping;
    }
  });
  const send = (args = {}) => settle(controller.send({ owner: 'child', provider: 'opencode', cwd: dir, text: 'hello', ...args }));
  const requests = () => existsSync(join(dir, 'requests.jsonl')) ? readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const settle = async (promise) => {
    let result, error, done = false;
    promise.then(r => { result = r; done = true; }, e => { error = e; done = true; });
    await until(async () => {
      if (done) return true;
      // Give actual child exit/reaping I/O time before advancing virtual cleanup
      // deadlines. Advancing on every yield can exhaust 500 ms before one exit.
      for (const s of supervisors) {
        if (s.terminating && !advancedCleanup.has(s) && [...clock.timers.values()].some(timer => timer.at === clock.time + 2000)) {
          advancedCleanup.add(s);
          await until(async () => (await s.verifyGone()).gone, 'fixture reaped after SIGTERM');
          await clock.advance(2000);
        }
      }
      return done;
    }, 'controller result');
    if (error) throw error;
    return result;
  };
  const finish = (sent) => settle(controller.wait({ owner: records.readExecution(sent.executionId).owner, executionId: sent.executionId, timeoutMs: 100_000 }));
  return { dir, env, clock, provider, controller, records, adapters, supervisors, send, settle, finish, requests };
}

test('provider readiness is cached and never spawns; model gate and capabilities match the contract', t => {
  const h = setup(t);
  assert.equal(h.provider.enabled, true);
  assert.equal(h.provider.ready, true);
  assert.equal(h.provider.modelAllowed('fixture/model#fast'), true);
  assert.equal(h.provider.modelAllowed('malformed'), false);
  assert.deepEqual(h.provider.create().capabilities, { followUp: true, steer: false, modelSelection: true, loadsHistory: true });
  assert.deepEqual(h.requests(), []);
  writeTargetChecks({ opencode: { ready: false } });
  assert.equal(opencodeProvider({ env: h.env }).ready, false);
});

test('new session and cold follow-up keep history, change PID, and record changing inherited defaults', async t => {
  const h = setup(t);
  const text = 'exact text\nwith quotes " and unicode π';
  const first = await h.send({ text });
  assert.equal(first.acknowledged, true);
  const one = await h.finish(first);
  assert.equal(one.outcome, 'completed');
  assert.equal(one.text, 'answer: ' + text);
  assert.deepEqual(one.effectiveModel, { providerID: 'fixture', id: 'first', variant: 'default', source: 'inherited' });
  h.env.FAKE_OPENCODE_DEFAULT = 'second';
  const second = await h.send({ text: 'recall' });
  const two = await h.finish(second);
  assert.equal(two.text, text);
  assert.equal(two.nativeRefs.sessionId, one.nativeRefs.sessionId);
  assert.notEqual(h.records.readExecution(first.executionId).processes.pid, h.records.readExecution(second.executionId).processes.pid);
  assert.equal(two.effectiveModel.id, 'second');
  assert.equal(two.effectiveModel.source, 'inherited');
  assert.equal(two.usage.input_tokens, 11);
  assert.equal(two.usage.output_tokens, 3);
  assert.equal(two.usage.cost, 0.01);
  assert.ok(one.nativeRefs.messageId);
  assert.ok(one.nativeRefs.nativeTurnId);
  assert.equal(h.requests().filter(r => r.path === '/api/session' && r.method === 'POST').length, 1);
  assert.deepEqual(h.requests().filter(r => r.path?.endsWith('/prompt')).map(r => r.body), [{ text }, { text: 'recall' }]);
  assert.equal(h.requests().filter(r => r.path?.endsWith('/model')).length, 0);
  for (const launch of h.requests().filter(r => r.argv)) {
    assert.deepEqual(launch.argv, ['serve', '--hostname', '127.0.0.1', '--port', '0']);
    assert.equal(launch.cwd, h.dir); assert.equal(launch.pwd, h.dir);
  }
  assert.equal(one.stopEvidence.gone, true); assert.equal(two.stopEvidence.gone, true);
  assert.equal(existsSync(join(h.dir, 'servers.json')), false);
  assert.doesNotMatch(JSON.stringify(h.records.listExecutions()), /password|authorization/i);
});

for (const [label, extra, args] of [
  ['explicit selection', {}, { model: 'fixture/chosen#fast' }],
  ['environment default selection', { AGENT_COMPANION_OPENCODE_MODEL: 'fixture/chosen#fast' }, {}],
  ['explicit override of environment default', { AGENT_COMPANION_OPENCODE_MODEL: 'fixture/other' }, { model: 'fixture/chosen#fast' }],
]) test(`${label} is acknowledged before prompting and verified against execution metadata`, async t => {
  const h = setup(t, extra);
  const result = await h.finish(await h.send(args));
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.effectiveModel, { providerID: 'fixture', id: 'chosen', variant: 'fast', source: 'selected' });
  const calls = h.requests();
  assert.ok(calls.findIndex(r => r.path?.endsWith('/model')) < calls.findIndex(r => r.path?.endsWith('/prompt')));
  assert.deepEqual(calls.find(r => r.path?.endsWith('/model')).body, { model: { providerID: 'fixture', id: 'chosen', variant: 'fast' } });
});

for (const mode of ['model-rejected', 'model-ignored', 'bad-model-ack']) test(`${mode} refuses delivery`, async t => {
  const h = setup(t, { FAKE_OPENCODE_MODE: mode });
  const result = await h.settle(h.send({ model: 'fixture/chosen' }));
  assert.equal(result.outcome, 'failed');
  assert.equal(result.detail, 'history_unavailable');
  assert.equal(h.requests().filter(r => r.path?.endsWith('/prompt')).length, 0);
  assert.equal(result.stopEvidence.gone, true);
});

test('execution model mismatch fails instead of claiming the selected model ran', async t => {
  const h = setup(t, { FAKE_OPENCODE_MODE: 'execution-mismatch' });
  const result = await h.finish(await h.send({ model: 'fixture/chosen' }));
  assert.equal(result.outcome, 'failed');
  assert.equal(result.cause, 'provider_error');
  assert.equal(h.records.readExecution(result.executionId).terminal.error, 'ModelSelectionMismatch');
  assert.equal(result.effectiveModel.id, 'different');
});

for (const mode of ['no-ack', 'bad-ack', 'hang-ack']) test(`${mode} yields DeliveryUnknown without a resend`, async t => {
  const h = setup(t, { FAKE_OPENCODE_MODE: mode });
  const sending = h.send();
  if (mode === 'hang-ack') {
    await until(() => h.requests().some(r => r.path?.endsWith('/prompt')));
    await h.clock.advance(10_000);
  }
  const result = await h.settle(sending);
  assert.equal(result.outcome, 'delivery_unknown');
  assert.equal(h.records.readExecution(result.executionId).terminal.error, 'DeliveryUnknown');
  assert.equal(h.requests().filter(r => r.path?.endsWith('/prompt')).length, 1);
  assert.equal(result.stopEvidence.gone, true);
});

test('native interrupt records the tool PID and yields interrupted with the owned tree gone', async t => {
  const h = setup(t, { FAKE_OPENCODE_MODE: 'tool' });
  const sent = await h.send();
  await until(() => h.supervisors[0].serialize().processes.length === 2, 'reported shell PID');
  assert.equal(h.records.readExecution(sent.executionId).progress.activeCommand, 'fixture tool');
  const result = await h.settle(h.controller.cancel({ owner: 'child', executionId: sent.executionId }));
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.cause, 'owner_stop');
  assert.equal(result.stopEvidence.gone, true);
  for (const p of h.supervisors[0].serialize().processes) assert.equal(pidAlive(p.pid), false);
  assert.ok(result.stopEvidence.protocol.every(p => p.acknowledged));
});

test('retry is progress and interrupting one private runtime leaves its sibling running', async t => {
  const h = setup(t, { FAKE_OPENCODE_MODE: 'retry' });
  const one = await h.send();
  const two = await h.send({ owner: 'sibling', text: 'sibling work' });
  await until(() => h.records.readExecution(one.executionId).progress?.retry?.attempt === 2);
  assert.equal(h.records.readResult(one.executionId), null);
  const siblingPid = h.records.readExecution(two.executionId).processes.pid;
  assert.equal((await h.settle(h.controller.cancel({ owner: 'child', executionId: one.executionId }))).outcome, 'interrupted');
  assert.equal(pidAlive(siblingPid), true);
  assert.equal(h.records.readResult(two.executionId), null);
  assert.equal((await h.settle(h.controller.cancel({ owner: 'sibling', executionId: two.executionId }))).outcome, 'interrupted');
});

for (const mode of ['crash', 'no-boot']) test(`startup ${mode} becomes failed runtime_unavailable`, async t => {
  const h = setup(t, { FAKE_OPENCODE_MODE: mode });
  const sending = h.send();
  if (mode === 'no-boot') {
    await until(() => h.supervisors[0]?.record.birthTime);
    await h.clock.advance(10_000);
  }
  const result = await h.settle(sending);
  assert.equal(result.outcome, 'failed'); assert.equal(result.detail, 'runtime_unavailable');
  assert.equal(result.stopEvidence.gone, true);
});

test('unknown history throws HistoryUnavailable and never creates a replacement', async t => {
  const h = setup(t);
  const one = await h.finish(await h.send());
  writeFileSync(join(h.dir, 'history.json'), '{}');
  const result = await h.settle(h.send({ text: 'follow up' }));
  assert.equal(result.outcome, 'failed'); assert.equal(result.detail, 'history_unavailable');
  assert.equal(h.records.readExecution(result.executionId).terminal.error, 'HistoryUnavailable');
  assert.equal(h.records.readConversation('child').historyId, one.nativeRefs.sessionId);
  assert.equal(h.requests().filter(r => r.path === '/api/session').length, 1);
  assert.equal(h.requests().filter(r => r.path?.endsWith('/prompt')).length, 1);
});

for (const mode of ['drop-stream', 'die']) test(`${mode} before terminal rejects ProviderLost, never reuses an old idle outcome`, async t => {
  const h = setup(t);
  await h.finish(await h.send());
  h.env.FAKE_OPENCODE_MODE = mode;
  const result = await h.finish(await h.send({ text: 'unfinished' }));
  assert.equal(result.outcome, 'failed');
  assert.equal(h.records.readExecution(result.executionId).terminal.error, 'ProviderLost');
  assert.equal(result.stopEvidence.gone, true);
  if (mode === 'die') assert.equal(result.stopEvidence.protocol.find(p => p.method === 'interrupt').acknowledged, false);
});

test('provider failure yields failed and close only closes HTTP channels', async t => {
  const h = setup(t, { FAKE_OPENCODE_MODE: 'provider-error' });
  const result = await h.finish(await h.send());
  assert.equal(result.outcome, 'failed');
  assert.equal(result.cause, 'provider_error');
  h.env.FAKE_OPENCODE_MODE = 'tool';
  const sent = await h.send({ text: 'still running' });
  await h.adapters[1].close();
  // close has no process-signalling authority; cleanup belongs to controller.
  assert.equal(pidAlive(h.supervisors[1].record.pid), true);
  await h.finish(sent);
});
