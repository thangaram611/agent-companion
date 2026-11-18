import '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import { FAKE_ACP_AGENT, fakeAcpAgentBin } from '../../test/fake-acp-agent.mjs';
import { companionEnv } from '../../probes/free-backends/run.mjs';
import { createScrubber } from '../../probes/acp-record/scrub.mjs';
import { exerciseScenario, recordCopilot, SCENARIOS } from '../../probes/acp-record/record-copilot.mjs';
import { ProcessSupervisor, pidAlive } from '../controller/process-supervisor.mjs';
import { getTargetById } from '../../lib/target-registry.mjs';
import { AcpAdapter } from './acp.mjs';
import { writeDefaultModel, clearDefaultModel } from '../../lib/state.mjs';

const lines = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
const scratch = () => mkdtempSync(join(SANDBOX_HOME, 'replay-'));

// Known test children and real process-group signals, with the same injected
// census boundary as acp.test.mjs. No real ps or live companion is needed.
function supervisorFor(t, extraEnv = {}, stderr = []) {
  const supervisor = new ProcessSupervisor({ processTable: async () => {
    const pid = supervisor.child?.pid;
    return new Map(pid && !supervisor.exited && pidAlive(pid)
      ? [[pid, { pid, ppid: process.pid, pgid: pid, birthTime: 'fixture-birth' }]] : []);
  } });
  const start = supervisor.spawn.bind(supervisor);
  supervisor.spawn = (argv, options) => {
    const pending = start(argv, { ...options, env: { ...options.env, ...extraEnv } });
    supervisor.child.stderr.on('data', chunk => stderr.push(String(chunk)));
    return pending;
  };
  t.after(() => supervisor.terminate({ graceMs: 0 }));
  return supervisor;
}

function recording(t, selected = SCENARIOS, extraEnv = {}, options = {}) {
  const dir = scratch(), outputDir = join(dir, 'fixtures'), binary = join(dir, 'fake.mjs');
  // Reuse the existing Copilot usage injector; never invent a second fake.
  writeFileSync(binary, `#!${process.execPath}\nprocess.env.ACP_FIXTURE_ROWS = ${JSON.stringify(join(dir, 'rows.jsonl'))};\n`
    + `await import(${JSON.stringify(new URL('../../test/adapters/acp-fixture.mjs', import.meta.url).href)});\n${FAKE_ACP_AGENT}`, { mode: 0o700 });
  const stderr = [], environments = [];
  let checked = false;
  const run = () => recordCopilot({ selected, outputDir, source: { PATH: process.env.PATH, COPILOT_BIN: binary,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT, HOME: '/unused-operator-home', GITHUB_TOKEN: 'must-not-inherit' }, report() {}, ...options }, {
    check: async () => { checked = true; },
    createSupervisor: ({ scenario, env }) => {
      assert.ok(checked, 'Ollama prerequisite must run before a scenario');
      environments.push({ scenario, env: { ...env } });
      return supervisorFor(t, { ACP_FIXTURE_USAGE: 'copilot', ACP_FAKE_THOUGHT_LEVELS: '["low","medium"]',
        ...(scenario === 'turn-command' ? { ACP_FAKE_TEXT: 'fixture-ok\nΩ' } : {}),
        ...(scenario === 'cancel' ? { ACP_FAKE_TURN_MS: '30000' } : {}),
        ...(scenario === 'signed-out' ? { ACP_FAKE_AUTH_REQUIRED: '1' } : {}), ...extraEnv }, stderr);
    },
  });
  return { run, outputDir, stderr, environments };
}

function replay(t, fixture, { shiftIds = false, stderr = [] } = {}) {
  const dir = scratch();
  const [header] = lines(fixture);
  const env = companionEnv({ root: dir, target: 'copilot', proxyUrl: 'http://127.0.0.1:11434', source: { PATH: process.env.PATH } });
  env.COPILOT_BIN = fakeAcpAgentBin(dir);
  env.ACP_FAKE_REPLAY = fixture;
  if (header.model === null) delete env.COPILOT_MODEL;
  else env.COPILOT_MODEL = header.model;
  const supervisor = supervisorFor(t, {}, stderr);
  const adapter = new AcpAdapter(getTargetById('copilot'), { env, log() {} });
  if (shiftIds) {
    const start = adapter.start.bind(adapter);
    adapter.start = async options => { const result = await start(options); adapter.connection.requestId += 100; return result; };
  }
  t.after(() => adapter.close());
  return { adapter, run: () => exerciseScenario(adapter, { scenario: header.scenario, cwd: dir, env, supervisor }), env, supervisor, dir };
}

test('Antigravity inherits the native model on new and loaded sessions when routing omits it', async t => {
  writeDefaultModel('saved-for-new-conversations', 'antigravity');
  t.after(() => clearDefaultModel('antigravity'));
  for (const historyId of [null, 'previous']) {
    const dir = scratch(), path = join(dir, 'inherit.jsonl');
    // Synthetic protocol replay. Any extra config write fails the method-order check.
    const frames = [
      { fixture: 'acp-replay', companion: 'antigravity' },
      { dir: 'client', frame: { id: 1, method: 'initialize' } },
      { dir: 'agent', frame: { id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } } },
      { dir: 'client', frame: { id: 2, method: historyId ? 'session/load' : 'session/new' } },
      { dir: 'agent', frame: { id: 2, result: { sessionId: historyId ?? 'new',
        configOptions: [{ id: 'model', currentValue: 'native-model' }] } } },
    ];
    writeFileSync(path, frames.map(frame => JSON.stringify(frame)).join('\n'));
    const env = { ...process.env, ANTIGRAVITY_ACP_BIN: fakeAcpAgentBin(dir), ACP_FAKE_REPLAY: path };
    const adapter = new AcpAdapter(getTargetById('antigravity'), { env, log() {} });
    try {
      await adapter.start({ cwd: dir, supervisor: supervisorFor(t) });
      const history = await adapter.openHistory({ historyId });
      assert.equal(history.effectiveModel, 'native-model');
    } finally { await adapter.close(); }
  }
});

test('capture scrubs paths and opaque ids while preserving semantic ids and text', () => {
  const scrub = createScrubber({ paths: [
    ['/private/scratch/run', '/fixture/root'], ['/private/scratch/run/home', '/fixture/home'],
    ['/private/scratch/run/work', '/fixture/cwd'], ['/private/scratch/run/tmp', '/fixture/tmp'],
    ['/Users/operator/bin/copilot', '/fixture/bin/copilot'],
  ], forbidden: ['operator', '/Users/operator'] });
  const first = scrub({ dir: 'agent', frame: { jsonrpc: '2.0', id: 42, result: {
    sessionId: 'random-session', configOptions: [{ id: 'model', currentValue: 'gpt-oss:20b' }],
    paths: ['/private/scratch/run/home/.copilot', '/private/scratch/run/work/a', '/private/scratch/run/tmp/b',
      '/private/scratch/run/other', '/Users/operator/bin/copilot'],
  } } });
  assert.equal(first.frame.id, 1);
  assert.equal(first.frame.result.sessionId, 'session-1');
  assert.deepEqual(first.frame.result.configOptions, [{ id: 'model', currentValue: 'gpt-oss:20b' }]);
  assert.deepEqual(first.frame.result.paths, ['/fixture/home/.copilot', '/fixture/cwd/a', '/fixture/tmp/b',
    '/fixture/root/other', '/fixture/bin/copilot']);
  const event = id => scrub({ dir: 'agent', frame: { method: 'session/update', params: {
    sessionId: 'random-session', update: { toolCallId: id, text: 'Model text stays verbatim. Ω' },
  } } });
  assert.equal(event('opaque-call').frame.params.update.toolCallId, 'toolcall-1');
  assert.equal(event('opaque-call').frame.params.update.toolCallId, 'toolcall-1');
  assert.equal(event('another-call').frame.params.update.toolCallId, 'toolcall-2');
  assert.equal(event('opaque-call').frame.params.sessionId, 'session-1');
  assert.equal(event('opaque-call').frame.params.update.text, 'Model text stays verbatim. Ω');
  assert.deepEqual(scrub({ '/private/scratch/run/work/file': 'unchanged' }), { '/fixture/cwd/file': 'unchanged' });
  const rpc = (dir, id, method) => scrub({ dir, frame: { id, ...(method ? { method } : { result: {} }) } }).frame.id;
  assert.equal(rpc('client', 42, 'session/new'), 1);
  assert.equal(rpc('client', 99, 'session/prompt'), 2);
  assert.equal(rpc('agent', 99), 2);
  assert.equal(rpc('agent', 99, 'session/request_permission'), 1, 'agent request ids have a separate namespace');
  assert.equal(rpc('client', 99), 1);
  assert.equal(rpc('client', '99', 'session/prompt'), 'rpc-client-3', 'string and numeric ids stay distinct');
  assert.equal(rpc('agent', '99'), 'rpc-client-3');
});

for (const secret of ['ghp_example', 'gho_example', 'ghu_example', 'ghs_example', 'ghr_example',
  'github_pat_example', 'sk-example', 'sk-proj-example', 'Bearer example', 'bearer example',
  'ghp_', 'github_pat_', 'sk-', 'operator', '/Users/operator/unmapped']) {
  test(`capture refuses private text pattern ${secret.split('_')[0].split(' ')[0]}`, () => {
    const scrub = createScrubber({ forbidden: ['operator', '/Users/operator'] });
    assert.throws(() => scrub({ result: { text: secret } }), /Refusing ACP capture/);
    assert.throws(() => scrub({ fixture: 'acp-replay', version: secret }), /Refusing ACP capture/);
  });
}

test('normalizing an opaque id cannot hide a credential', () => {
  assert.throws(() => createScrubber()({ dir: 'agent', frame: { result: { sessionId: 'ghp_example' } } }), /Refusing ACP capture/);
});

test('recorder and replay round-trip all four scenarios through the real Copilot adapter', { timeout: 30_000 }, async t => {
  const h = recording(t);
  const recorded = await h.run();
  assert.equal(recorded.length, 4);
  for (const [index, entry] of recorded.entries()) {
    const [header, ...rows] = lines(entry.path);
    assert.equal(header.fixture, 'acp-replay'); assert.equal(header.companion, 'copilot');
    assert.equal(header.version, 'fake-acp-agent 1.0.0');
    assert.ok(Number.isFinite(Date.parse(header.recordedAt)));
    assert.equal(header.scenario, SCENARIOS[index]);
    assert.equal(header.model, header.scenario === 'signed-out' ? null : 'gpt-oss:20b');
    assert.ok(rows.every(row => ['client', 'agent'].includes(row.dir) && row.frame.jsonrpc === '2.0'));
    const session = rows.find(row => row.dir === 'client' && row.frame.method === 'session/new');
    assert.equal(session.frame.params.cwd, '/fixture/cwd');
    const played = await replay(t, entry.path, { shiftIds: true }).run();
    if (entry.error) assert.equal(played.error, 'AUTH_REQUIRED');
    else {
      assert.equal(played.result.outcome, entry.result.outcome);
      assert.equal(played.result.text, entry.result.text);
      assert.deepEqual(played.result.usage, entry.result.usage);
      assert.equal(played.history.historyId, 'replay-session-1');
      assert.ok(played.result.nativeRefs.promptRequestId > 100, 'delayed responses use live request ids');
      if (header.scenario !== 'cancel') {
        assert.equal(played.result.usage.input_tokens, 1234);
        assert.equal(played.result.usage.output_tokens, 56);
      }
      if (header.scenario === 'effort') assert.equal(played.history.effectiveEffort, 'low');
    }
  }
  for (const { scenario, env } of h.environments) {
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.notEqual(env.HOME, '/unused-operator-home');
    if (scenario === 'signed-out') {
      for (const key of ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TYPE', 'COPILOT_OFFLINE', 'COPILOT_MODEL']) assert.equal(env[key], undefined);
    } else assert.equal(env.COPILOT_PROVIDER_BASE_URL, 'http://127.0.0.1:11434/v1');
    assert.equal(existsSync(env.HOME), false, 'disposable home cleaned up');
  }
  assert.deepEqual(readdirSync(h.outputDir).sort(), SCENARIOS.map(s => `${s}.jsonl`).sort());
  const again = await h.run();
  assert.equal(again.length, 4, 're-recording overwrites each fixture');
});

test('replay handles permission and unsupported agent requests with their own id space', { timeout: 15_000 }, async t => {
  const [entry] = await recording(t, ['effort'], { ACP_FAKE_ASK_PERMISSION: '1', ACP_FAKE_ASK_FS: '1' }).run();
  const rows = lines(entry.path).slice(1);
  const permission = rows.find(row => row.dir === 'agent' && row.frame.method === 'session/request_permission').frame;
  const response = rows.find(row => row.dir === 'client' && !row.frame.method && row.frame.id === permission.id).frame;
  assert.equal(response.result.outcome.optionId, 'proceed_once');
  const played = await replay(t, entry.path, { shiftIds: true }).run();
  assert.equal(played.result.text, entry.result.text);
  assert.deepEqual(played.result.usage, entry.result.usage);
});

test('unexpected client method fails with -32603 and the mismatch message, without waiting', { timeout: 10_000 }, async t => {
  const dir = scratch(), path = join(dir, 'mismatch.jsonl');
  writeFileSync(path, [{ fixture: 'acp-replay', companion: 'copilot', scenario: 'effort', model: null },
    { dir: 'client', frame: { jsonrpc: '2.0', id: 77, method: 'session/load', params: {} } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const stderr = [], h = replay(t, path, { stderr });
  await assert.rejects(h.run(), err => {
    assert.equal(err.cause.code, -32603);
    assert.equal(err.cause.message, 'ACP replay mismatch: expected session/load; received initialize');
    return true;
  });
  if (!h.supervisor.child.stderr.readableEnded) await once(h.supervisor.child.stderr, 'end');
  assert.match(stderr.join(''), /expected session\/load; received initialize/);
});

test('notification mismatch rejects the pending prompt instead of hanging after cancel', { timeout: 15_000 }, async t => {
  const [entry] = await recording(t, ['cancel']).run();
  const h = replay(t, entry.path);
  h.adapter.interrupt = async () => {
    h.adapter.connection._sendNotification('session/wrong-cancel', { sessionId: h.adapter.sessionId });
    await h.adapter.turn.terminal;
  };
  await assert.rejects(h.run(), /unexpected adapter outcome failed/);
  const result = await h.adapter.turn.terminal;
  assert.match(result.detail, /expected session\/cancel; received session\/wrong-cancel/);
});

for (const [label, env, scenario] of [
  ['secret', { ACP_FAKE_TEXT: 'github_pat_example' }, 'effort'],
  ['wrong command output', { ACP_FAKE_TEXT: 'did something else' }, 'turn-command'],
  ['unconfirmed effort', { ACP_FAKE_IGNORE_EFFORT: '1' }, 'effort'],
  ['signed-in home', { ACP_FAKE_AUTH_REQUIRED: '0' }, 'signed-out'],
]) test(`failed recording saves nothing and preserves previous fixtures: ${label}`, { timeout: 15_000 }, async t => {
  const h = recording(t, [scenario], env);
  mkdirSync(h.outputDir);
  const path = join(h.outputDir, `${scenario}.jsonl`);
  writeFileSync(path, 'previous fixture\n');
  await assert.rejects(h.run());
  assert.equal(readFileSync(path, 'utf8'), 'previous fixture\n');
  assert.deepEqual(readdirSync(h.outputDir), [`${scenario}.jsonl`]);
});

test('a stalled scenario times out and publishes no fixture', { timeout: 10_000 }, async t => {
  const h = recording(t, ['effort'], { ACP_FAKE_TURN_MS: '30000' }, { timeoutMs: 500 });
  await assert.rejects(h.run(), /ACP recording timed out/);
  assert.equal(existsSync(h.outputDir), false);
});

test('tee forwards original bytes and stderr while scrubbing split UTF-8 JSON lines', { timeout: 10_000 }, async t => {
  const dir = scratch(), capture = join(dir, 'wire.jsonl');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../probes/acp-record/tee.mjs', import.meta.url)),
    '-e', 'process.stdin.pipe(process.stdout); process.stderr.write("tee-diagnostic\\n");'], {
    env: { PATH: process.env.PATH, _ACP_RECORD: JSON.stringify({ binary: process.execPath, capture,
      header: { fixture: 'acp-replay' }, paths: [[dir, '/fixture/cwd']], forbidden: [] }) },
  });
  t.after(() => child.kill());
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  const closed = once(child, 'close');
  const input = Buffer.from(`  {"jsonrpc":"2.0", "id":19, "method":"example", "params":{"text":"Ω", "path":${JSON.stringify(dir)}}}  \r\n`);
  const split = input.indexOf(Buffer.from('Ω')) + 1;
  child.stdin.write(input.subarray(0, split)); child.stdin.end(input.subarray(split));
  assert.deepEqual(await closed, [0, null]);
  assert.deepEqual(Buffer.concat(stdout), input);
  assert.equal(Buffer.concat(stderr).toString(), 'tee-diagnostic\n');
  const rows = lines(capture);
  assert.deepEqual(rows.slice(1).map(row => row.dir), ['client', 'agent']);
  for (const row of rows.slice(1)) {
    assert.equal(row.frame.params.text, 'Ω'); assert.equal(row.frame.params.path, '/fixture/cwd');
  }
});

for (const text of ['not JSON', JSON.stringify({ result: { text: 'sk-test' } })]) {
  test(`tee refuses ${text === 'not JSON' ? 'invalid JSON' : 'private text'} and deletes its partial capture`, { timeout: 10_000 }, async t => {
    const dir = scratch(), capture = join(dir, 'wire.jsonl');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../probes/acp-record/tee.mjs', import.meta.url)),
      '-e', 'process.stdin.pipe(process.stdout);'], {
      env: { _ACP_RECORD: JSON.stringify({ binary: process.execPath, capture,
        header: { fixture: 'acp-replay' }, paths: [], forbidden: [] }) },
    });
    t.after(() => child.kill());
    child.stdout.resume(); child.stderr.resume();
    const closed = once(child, 'close');
    child.stdin.end('{"method":"safe"}\n' + text + '\n');
    assert.equal((await closed)[0], 1);
    assert.equal(existsSync(capture), false);
  });
}

// A human creates these with the recorder after upgrading Copilot. No invented
// Copilot recording is committed to fill the gap; absence is an explicit skip.
for (const scenario of SCENARIOS) {
  const path = fileURLToPath(new URL(`../../test/fixtures/acp/copilot/${scenario}.jsonl`, import.meta.url));
  test(`recorded Copilot wire: ${scenario}`, { timeout: 15_000, skip: existsSync(path) ? false : 'Human Copilot recording not present' }, async t => {
    const [header, ...rows] = lines(path);
    assert.equal(header.companion, 'copilot'); assert.equal(header.scenario, scenario);
    const observed = await replay(t, path, { shiftIds: true }).run();
    if (scenario === 'signed-out') assert.equal(observed.error, 'AUTH_REQUIRED');
    else {
      assert.equal(observed.result.outcome, scenario === 'cancel' ? 'interrupted' : 'completed');
      if (scenario === 'turn-command') assert.match(observed.result.text, /fixture-ok/);
      if (scenario === 'effort') assert.equal(observed.history.effectiveEffort, 'low');
      const prompt = rows.find(row => row.dir === 'client' && row.frame.method === 'session/prompt').frame;
      const nativeResult = rows.find(row => row.dir === 'agent' && !row.frame.method && row.frame.id === prompt.id)?.frame.result;
      const nativeUsage = nativeResult?.usage;
      // Copilot 1.0.113 answers a cancelled prompt with its stop reason alone,
      // even mid-turn after a usage_update (1.0.112 still counted it): no usage
      // is reported, none invented. A renamed field would show as an extra key.
      if (scenario === 'cancel') {
        assert.deepEqual(Object.keys(nativeResult), ['stopReason']);
        assert.equal(observed.result.usage, null);
        return;
      }
      // Every completed prompt response carries turn counters. Require real counts:
      // deriving the expectation from the fixture alone would let a renamed field
      // read as null on both sides.
      for (const field of ['input_tokens', 'output_tokens']) {
        assert.ok(Number.isInteger(observed.result.usage?.[field]) && observed.result.usage[field] > 0,
          `recorded ACP usage must yield ${field}: ${JSON.stringify(observed.result.usage)}`);
      }
      assert.equal(observed.result.usage.input_tokens, nativeUsage.inputTokens);
      assert.equal(observed.result.usage.output_tokens, nativeUsage.outputTokens);
    }
  });
}
