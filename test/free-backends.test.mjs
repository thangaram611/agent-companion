import './sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { SANDBOX_HOME } from './sandbox-home.mjs';
import { wireFields } from '../probes/free-backends/proxy.mjs';
import { companionEnv, runFreeBackends, checkOllama, repo, targets } from '../probes/free-backends/run.mjs';
import { startBridge } from '../probes/smoke/bridge-client.mjs';
import { claudeEnv } from '../bridge-server/adapters/claude-protocol.mjs';

test('proxy logs only model/effort leaves and canonical endpoint paths', () => {
  const body = { model: 'gpt-oss:20b', reasoning_effort: 'low', reasoning: { effort: 'low', summary: 'SECRET' },
    output_config: { effort: 'low', schema: 'SECRET' }, thinking: { type: 'adaptive', budget_tokens: 1024, content: 'SECRET' },
    headers: { authorization: 'SECRET' }, messages: ['SECRET'], instructions: 'SECRET', input: 'SECRET', tools: ['SECRET'] };
  assert.deepEqual(wireFields('/v1/messages?beta=true&key=SECRET', body), { path: '/v1/messages', model: 'gpt-oss:20b',
    reasoning_effort: 'low', reasoning: { effort: 'low' }, output_config: { effort: 'low' }, thinking: { type: 'adaptive', budget_tokens: 1024 } });
  assert.doesNotMatch(JSON.stringify(wireFields('/v1/messages?key=SECRET', body)), /SECRET|"(?:headers|messages|instructions|tools)":/);
  assert.deepEqual(wireFields('/SECRET?token=SECRET', null), { path: '/other' });
  assert.deepEqual(wireFields('/v1/responses', { model: { headers: 'SECRET' }, reasoning: { effort: ['SECRET'] } }), { path: '/v1/responses' });
});

for (const target of targets) test(`${target} env uses isolated homes and excludes live setup and credentials`, () => {
  const root = join(SANDBOX_HOME, 'isolated');
  const source = { HOME: '/live', CODEX_HOME: '/live/codex', CLAUDE_CONFIG_DIR: '/live/claude', COPILOT_HOME: '/live/copilot',
    AGENT_COMPANION_HOME: '/live/bridge', AGENT_COMPANION_REPO: '/live/main-checkout',
    ANTHROPIC_AUTH_TOKEN: 'SECRET', OPENAI_API_KEY: 'SECRET', GITHUB_TOKEN: 'SECRET', NODE_OPTIONS: 'SECRET',
    OPENCODE_CONFIG: '/live/instructions', OPENCODE_CONFIG_CONTENT: 'SECRET', COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '/live',
    HTTPS_PROXY: 'SECRET', PATH: '/bin' };
  const before = { ...source }, env = companionEnv({ root, target, proxyUrl: 'http://127.0.0.1:1234', source });
  for (const key of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'COPILOT_HOME', 'AGENT_COMPANION_HOME',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) {
    assert.ok(isAbsolute(env[key]) && env[key].startsWith(join(root, target) + '/'), key);
  }
  assert.doesNotMatch(JSON.stringify(env), /SECRET|\/live/);
  assert.deepEqual(source, before);
  if (target === 'claude') {
    const native = claudeEnv(env, '/empty');
    assert.equal(native.CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR);
    assert.equal(native.ANTHROPIC_AUTH_TOKEN, 'ollama'); assert.equal(native.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234');
  }
  if (target === 'copilot') {
    assert.equal(env.COPILOT_OFFLINE, 'true'); assert.equal(env.COPILOT_MODEL, 'gpt-oss:20b');
    assert.equal(env.COPILOT_PROVIDER_BASE_URL, 'http://127.0.0.1:1234/v1'); assert.equal(env.COPILOT_PROVIDER_TYPE, 'openai');
  }
});

test('Ollama prerequisite reads tags only and reports Homebrew/manual startup or missing model', async () => {
  const requests = [];
  await checkOllama({ fetchImpl: async (...args) => { requests.push(args); return { ok: true, json: async () => ({ models: [{ name: 'gpt-oss:20b' }] }) }; } });
  assert.equal(requests[0][0], 'http://127.0.0.1:11434/api/tags'); assert.ok(requests[0][1].signal);
  await assert.rejects(checkOllama({ fetchImpl: async () => { throw new Error('offline'); } }), /brew install ollama.*OLLAMA_CONTEXT_LENGTH=32768 ollama serve/s);
  await assert.rejects(checkOllama({ fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }) }), /ollama pull gpt-oss:20b/);
});

for (const scenario of ['success', 'probe-fails', 'bridge-start-fails', 'bridge-stop-fails', 'abort']) {
  test(`runner closes every acquired bridge and proxy: ${scenario}`, async t => {
    const calls = [], abort = new AbortController(), roots = new Set();
    t.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
    const source = Object.fromEntries(targets.map(target => [`${target.toUpperCase()}_BIN`, process.execPath]));
    const running = runFreeBackends({ selected: ['codex', 'claude'], source, signal: abort.signal,
      report: line => { if (line.startsWith('Artifacts: ')) roots.add(line.slice(11)); } }, {
      check: async () => calls.push('check'),
      proxyStart: async () => ({ url: 'http://127.0.0.1:1234', stop: async () => calls.push('proxy-stop') }),
      bridgeStart: async (session, options) => {
        calls.push('bridge-start'); assert.equal(options.repo, repo); assert.equal(options.signal, abort.signal);
        const root = [...roots][0]; assert.ok(options.env.AGENT_COMPANION_HOME.startsWith(root + '/'));
        if (session.includes('codex')) assert.match(readFileSync(join(options.env.CODEX_HOME, 'config.toml'), 'utf8'), /model_provider = "ollama-proxy"[\s\S]*wire_api = "responses"/);
        if (scenario === 'bridge-start-fails') throw new Error('start failed');
        return { stop: async () => { calls.push('bridge-stop'); if (scenario === 'bridge-stop-fails') throw new Error('stop failed'); } };
      },
      probe: async args => {
        calls.push('probe'); assert.ok(args.cwd.startsWith([...roots][0] + '/'));
        assert.deepEqual(args.readWire(), []); assert.equal(args.backendEffort, args.target === 'codex' ? 'low' : undefined);
        if (scenario === 'probe-fails') throw new Error('probe failed');
        if (scenario === 'abort') { abort.abort(new Error('signal')); abort.signal.throwIfAborted(); }
      },
    });
    if (scenario === 'success') await running; else await assert.rejects(running);
    assert.equal(calls.at(-1), 'proxy-stop');
    assert.equal(calls.filter(c => c === 'bridge-stop').length, scenario === 'bridge-start-fails' ? 0 : scenario === 'success' ? 2 : 1);
  });
}

function fakeBridge({ rejectInit = false, ignoreEOF = false, duringInit } = {}) {
  const child = new EventEmitter(), kills = [];
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, done) {
    const frame = JSON.parse(String(chunk));
    if (frame.method === 'initialize') {
      if (duringInit) duringInit();
      else child.stdout.write(JSON.stringify({ id: frame.id, ...(rejectInit ? { error: { message: 'init refused' } } : { result: {} }) }) + '\n');
    }
    done();
  }, final(done) { if (!ignoreEOF) queueMicrotask(() => child.emit('close', 0)); done(); } });
  child.kill = signal => { kills.push(signal); queueMicrotask(() => child.emit('close', 0)); return true; };
  return { child, kills };
}

test('bridge client passes only supplied env, launches this worktree and closes idempotently', async () => {
  const { child } = fakeBridge(); let launch;
  const bridge = await startBridge('fixture', { env: { HOME: '/isolated', CODEX_HOME: '/isolated/codex' }, repo,
    spawnProcess: (...args) => { launch = args; return child; } });
  assert.equal(launch[1][0], join(repo, 'bridge-server/server.mjs'));
  assert.deepEqual(launch[2].env, { HOME: '/isolated', CODEX_HOME: '/isolated/codex', CLAUDE_CODE_SESSION_ID: 'fixture' });
  await bridge.stop(); await bridge.stop();
});

for (const scenario of ['init-failure', 'abort-init', 'stuck-eof']) test(`bridge client cleans startup/exit failure: ${scenario}`, async () => {
  const abort = new AbortController();
  const fake = fakeBridge({ rejectInit: scenario === 'init-failure', ignoreEOF: scenario === 'stuck-eof',
    duringInit: scenario === 'abort-init' ? () => abort.abort() : undefined });
  const started = startBridge('fixture', { env: {}, repo, signal: abort.signal, stopGraceMs: 1, spawnProcess: () => fake.child });
  if (scenario === 'stuck-eof') { const bridge = await started; await bridge.stop(); assert.deepEqual(fake.kills, ['SIGTERM']); }
  else { await assert.rejects(started); assert.equal(fake.child.stdin.writableEnded, true); }
});
