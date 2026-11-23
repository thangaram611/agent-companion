import '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import { fakeCodexBin } from '../../test/fake-codex-app-server.mjs';
import { ProcessSupervisor, pidAlive } from '../controller/process-supervisor.mjs';
import { companionHomeDir } from '../../lib/hosts/index.mjs';
import { settingsPath } from '../../lib/state.mjs';
import { defaults, formatDefaults } from './defaults.mjs';

const launcher = fileURLToPath(new URL('../../hooks/launch-ui.sh', import.meta.url));
const openCodeFake = new URL('../../test/adapters/fake-opencode.mjs', import.meta.url).href;
function put(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(SANDBOX_HOME, 'defaults-')));
  const env = { HOME: root, PATH: process.env.PATH, CODEX_HOME: join(root, 'custom codex home'),
    XDG_CONFIG_HOME: join(root, 'xdg'), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    AGENT_COMPANION_NODE: process.execPath, CODEX_BIN: fakeCodexBin(root), CODEX_FAKE_TRACE: join(root, 'rpc'),
    OPENCODE_BIN: join(root, 'opencode.mjs'), FAKE_OPENCODE_DIR: root };
  writeFileSync(join(root, 'codex-code-mode-host'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const forbidden = join(root, 'unexpected-runtime.mjs');
  writeFileSync(forbidden, '#!' + process.execPath + "\nimport { writeFileSync } from 'node:fs'; writeFileSync(process.env.HOME + '/unexpected-start', '1'); process.exit(1);\n", { mode: 0o700 });
  Object.assign(env, { CLAUDE_BIN: forbidden, COPILOT_BIN: forbidden, ANTIGRAVITY_BIN: forbidden });
  writeFileSync(env.OPENCODE_BIN, '#!' + process.execPath + '\nawait import(' + JSON.stringify(openCodeFake) + ');\n', { mode: 0o700 });
  appendFileSync(env.CODEX_BIN, `
if (process.argv[2] === 'app-server') historyFs.writeFileSync(process.env.CODEX_FAKE_TRACE + '.home', process.env.CODEX_HOME);
`);
  const supervisors = [];
  // Only the census is simulated. The timeout fixture also reports the pid
  // of its deliberately detached child. All signals go to real fake processes.
  function createSupervisor() {
    const supervisor = new ProcessSupervisor({ processTable: async () => {
      const pid = supervisor.child?.pid;
      const rows = new Map(pidAlive(pid) ? [[pid, { pid, pgid: pid, ppid: process.pid, birthTime: 'fixture-' + pid }]] : []);
      if (env.CODEX_FAKE_CHILD_PID && existsSync(env.CODEX_FAKE_CHILD_PID)) {
        const child = Number(readFileSync(env.CODEX_FAKE_CHILD_PID, 'utf8'));
        if (pidAlive(child)) rows.set(child, { pid: child, pgid: child, ppid: pid, birthTime: 'fixture-' + child });
      }
      return rows;
    } });
    supervisors.push(supervisor);
    return supervisor;
  }
  t.after(() => {
    assert.equal(existsSync(join(root, 'unexpected-start')), false, 'a records-only companion was started');
    for (const supervisor of supervisors) assert.equal(pidAlive(supervisor.child?.pid), false, 'fake server survived');
  });
  const file = settingsPath(env);
  const cli = (...args) => spawnSync('/bin/bash', [launcher, 'defaults', ...args], { cwd: root,
    env, encoding: 'utf8', timeout: 12_000, killSignal: 'SIGKILL' });
  const run = (query, options) => defaults(query, { cwd: root, env, createSupervisor, ...options });
  const log = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const settings = () => JSON.parse(readFileSync(file));
  return { root, env, file, cli, run, settings, rpc: () => log(env.CODEX_FAKE_TRACE),
    http: () => log(join(root, 'requests.jsonl')), supervisors };
}

test('listing migrates shared settings, resolves both native defaults and shows environment overrides', async t => {
  const h = fixture(t);
  const legacy = join(companionHomeDir('claude', h.env), 'default-model-codex');
  put(legacy, 'saved-model\n');
  put(join(companionHomeDir('codex', h.env), 'default-target'), 'copilot\n');
  h.env.AGENT_COMPANION_CODEX_MODEL = 'env-model';
  h.env.AGENT_COMPANION_DEFAULT_COMPANION = 'claude';
  h.env.CODEX_FAKE_CONFIG = JSON.stringify({ model: 'configured-model', model_reasoning_effort: 'xhigh' });
  const result = await h.run({});
  assert.equal(existsSync(legacy), false);
  assert.equal(h.settings().companions.codex.model, 'saved-model');
  assert.deepEqual(result.companion, { saved: 'copilot', value: 'claude', source: 'env', inherit: 'claude' });
  assert.deepEqual(Object.keys(result.companions).sort(), ['antigravity', 'claude', 'codex', 'copilot', 'opencode']);
  assert.deepEqual(result.companions.codex.model, { saved: 'saved-model', value: 'env-model', source: 'env' });
  assert.deepEqual(result.companions.codex.inherit, { model: 'configured-model', effort: 'xhigh', source: 'config/read' });
  assert.deepEqual(result.companions.opencode.inherit, { model: 'fixture/first', effort: 'default', source: '/model/default' });
  assert.deepEqual(h.rpc().map(m => m.method), ['initialize', 'initialized', 'config/read', 'model/list', 'model/list']);
  assert.deepEqual(h.rpc()[2].params, { cwd: h.root });
  assert.equal(readFileSync(h.env.CODEX_FAKE_TRACE + '.home', 'utf8'), h.env.CODEX_HOME);
  assert.deepEqual(h.http().filter(r => r.path).map(r => [r.method, r.path, new URLSearchParams(r.query).get('directory')]),
    [['GET', '/api/info', null], ['GET', '/api/model/default', h.root]]);
  assert.equal(h.supervisors.length, 2);
});

test('Codex uses catalog fallbacks and checks effort against the inherited, saved or newly selected model', async t => {
  const h = fixture(t);
  const run = async changes => (await h.run({ companion: 'codex', ...changes })).companions.codex;
  assert.deepEqual((await run({})).inherit, { model: 'catalog-model', effort: 'high', source: 'model/list' });
  const offset = h.rpc().length;
  h.env.CODEX_FAKE_CONFIG = JSON.stringify({ model: 'configured-model', model_reasoning_effort: 'low' });
  assert.equal((await run({})).inherit.effort, 'low');
  assert.deepEqual(h.rpc().slice(offset).map(m => m.method), ['initialize', 'initialized', 'config/read']);
  h.env.CODEX_FAKE_CONFIG = JSON.stringify({ model: 'configured-model' });
  assert.equal((await run({})).inherit.effort, 'high');
  await assert.rejects(run({ effort: 'ultra' }), /not valid for Codex model "configured-model"/);
  assert.equal((await run({ model: 'catalog-model', effort: 'ultra' })).effort.saved, 'ultra');
  await assert.rejects(run({ model: 'configured-model' }), /not valid for Codex model "configured-model"/);
  assert.equal((await run({ effort: 'ultra' })).effort.source, 'config');
  const unknown = await run({ model: 'custom/provider', effort: 'bespoke' });
  assert.equal(unknown.validation, "unverified: not in Codex's model list");
  assert.equal((await run({})).validation, unknown.validation);
  assert.equal((await run({ effort: 'inherit' })).model.saved, 'custom/provider');
  assert.equal((await run({ model: 'inherit' })).model.saved, null);
  assert.deepEqual(h.settings(), {});
  assert.equal(h.http().length, 0);
});

test('OpenCode checks the chosen model, variant ids and reasoningEffort aliases on the directory-scoped catalog', async t => {
  const h = fixture(t);
  const run = async changes => (await h.run({ companion: 'opencode', ...changes })).companions.opencode;
  await assert.rejects(run({ model: 'fixture/missing' }), /unknown OpenCode model/);
  await assert.rejects(run({ model: 'wrong-shape' }), /invalid model/);
  await assert.rejects(run({ model: 'fixture/chosen#missing' }), /unknown OpenCode variant/);
  await assert.rejects(run({ effort: 'fast' }), /not valid for OpenCode model "fixture\/first"/);
  assert.equal(existsSync(h.file), false);
  assert.equal((await run({ model: 'fixture/chosen#fast', effort: 'low' })).model.saved, 'fixture/chosen#fast');
  assert.equal((await run({ effort: 'fast' })).effort.saved, 'fast');
  const before = statSync(h.file).ino;
  await assert.rejects(run({ model: 'fixture/bare', effort: 'high' }), /no effort levels/);
  assert.equal(statSync(h.file).ino, before);
  assert.equal((await run({ model: 'inherit', effort: 'high' })).model.saved, null);
  assert.equal((await run({ effort: 'inherit' })).effort.saved, null);
  assert.deepEqual(h.settings(), {});
  const requests = h.http().filter(r => r.path && r.path !== '/api/info');
  assert.ok(requests.some(r => r.path === '/api/model'));
  for (const r of requests) {
    assert.equal(r.method, 'GET');
    assert.ok(['/api/model', '/api/model/default'].includes(r.path));
    assert.equal(new URLSearchParams(r.query).get('directory'), h.root);
  }
  assert.deepEqual(h.rpc(), []);
});

for (const id of ['claude', 'copilot', 'antigravity']) test(id + ' sets and clears through the launcher without starting a native process', t => {
  const h = fixture(t);
  const edit = (...args) => {
    const result = h.cli(id, ...args, '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const rows = JSON.parse(result.stdout).companions;
    assert.deepEqual(Object.keys(rows), [id]);
    return rows[id];
  };
  const effort = id === 'claude' ? 'xhigh' : 'session-level';
  const row = edit('model=chosen', 'effort=' + effort);
  assert.equal(row.model.saved, 'chosen');
  assert.equal(row.effort.saved, effort);
  if (id !== 'claude') {
    assert.equal(row.validation, 'unverified until a session runs');
    assert.match(h.cli(id).stdout, /unverified until a session runs/);
  }
  assert.equal(edit('model=inherit').effort.saved, effort);
  assert.equal(edit('effort=inherit').model.saved, null);
  assert.deepEqual(h.settings(), {});
  assert.equal(row.inherit.reason, 'no reported run');
  assert.deepEqual(h.rpc(), []);
  assert.deepEqual(h.http(), []);
});

test('default companion round-trips on both hosts and clearing shows the underlying environment choice', t => {
  const h = fixture(t);
  h.env.AGENT_COMPANION_HOST = 'codex';
  assert.equal(JSON.parse(h.cli('companion=opencode', '--json').stdout).companion.saved, 'opencode');
  h.env.AGENT_COMPANION_HOST = 'claude';
  h.env.AGENT_COMPANION_DEFAULT_COMPANION = 'claude';
  assert.deepEqual(JSON.parse(h.cli('--json', 'companion=inherit').stdout).companion,
    { saved: null, value: 'claude', source: 'env', inherit: 'claude' });
  assert.deepEqual(h.settings(), {});
});

test('the generated launcher lists all defaults as JSON even with unavailable providers and no package imports', t => {
  const h = fixture(t);
  const bin = join(h.root, '.local', 'bin');
  const install = fileURLToPath(new URL('../../scripts/install-ui-launcher.mjs', import.meta.url));
  assert.equal(spawnSync(process.execPath, [install, '--bin-dir', bin], { env: h.env }).status, 0);
  const guard = join(h.root, 'package-guard.mjs');
  put(guard, `import { registerHooks } from 'node:module';
registerHooks({ resolve(id, ctx, next) {
  if (!/^(node:|file:|[./])/.test(id)) throw Error('unexpected package import ' + id);
  return next(id, ctx);
} });`);
  const env = { ...h.env, CODEX_BIN: join(h.root, 'missing-codex'), OPENCODE_BIN: join(h.root, 'missing-opencode'),
    NODE_OPTIONS: '--import="' + guard + '"' };
  for (const host of ['claude', 'codex']) {
    const r = spawnSync(join(bin, 'agent-companion'), ['defaults', '--json'], { env: { ...env, AGENT_COMPANION_HOST: host },
      cwd: h.root, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const result = JSON.parse(r.stdout);
    assert.equal(result.companion.source, 'unset');
    assert.equal(Object.keys(result.companions).length, 5);
    assert.match(result.companions.codex.inherit.reason, /executable/);
    assert.match(result.companions.opencode.inherit.reason, /ENOENT/);
  }
});

test('latest reported execution across both hosts supplies model, effort and age; an override isolates both hosts', async t => {
  const h = fixture(t);
  const now = Date.now();
  const record = (dir, provider, msAgo, values) => put(join(dir, 'executions', provider + '-' + msAgo + '.json'),
    JSON.stringify({ provider, startedAt: now - msAgo, ...values }));
  for (const id of ['claude', 'copilot', 'antigravity']) {
    record(companionHomeDir('claude', h.env), id, 500_000, { effectiveModel: 'old', effectiveEffort: 'old' });
    put(join(companionHomeDir('claude', h.env), 'executions', 'damaged.json'), '{');
    record(companionHomeDir('codex', h.env), id, 120_000, { effectiveModel: 'latest', effectiveEffort: id === 'claude' ? null : 'high',
      modelOverride: 'requested', effortOverride: 'requested' });
    record(companionHomeDir('claude', h.env), id, 0, { modelOverride: 'never-reported' });
    const snapshot = await h.run({ companion: id });
    const { inherit } = snapshot.companions[id];
    assert.equal(inherit.model, 'latest');
    assert.equal(inherit.effort, id === 'claude' ? null : 'high');
    assert.equal(inherit.host, 'codex');
    assert.ok(inherit.ageMs >= 120_000);
    assert.match(formatDefaults(snapshot), /codex last run, 2m ago/);
    if (id === 'claude') assert.match(formatDefaults(snapshot), /effort=not reported/);
  }
  h.env.AGENT_COMPANION_HOME = join(h.root, 'isolated');
  assert.equal((await h.run({ companion: 'claude' })).companions.claude.inherit.reason, 'no reported run');
  record(h.env.AGENT_COMPANION_HOME, 'claude', 1_000, { effectiveModel: 'init', progress: { effectiveModel: 'isolated-latest' } });
  assert.equal((await h.run({ companion: 'claude' })).companions.claude.inherit.model, 'isolated-latest');
  assert.equal(h.supervisors.length, 0);
});

test('CLI refusals have one-line reasons and leave an unmigrated home untouched', t => {
  const h = fixture(t);
  const legacy = join(companionHomeDir('codex', h.env), 'default-target');
  put(legacy, 'claude\n');
  for (const args of [['unknown'], ['companion=unknown'], ['companion=codex', 'effort=low'], ['model=foo'], ['claude', 'model='],
    ['claude', 'bad=field'], ['claude', 'effort=high', 'effort=low'], ['claude', 'model=two models'],
    ['claude', 'model=sonnet', 'effort=unsupported']]) {
    const r = h.cli(...args);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^[^\r\n]+\n$/);
    assert.equal(readFileSync(legacy, 'utf8'), 'claude\n');
    assert.equal(existsSync(h.file), false);
  }
  const r = h.cli('--json', 'companion=missing');
  assert.match(JSON.parse(r.stderr).error, /unknown companion/);
  assert.equal(r.status, 1);
  assert.equal(existsSync(h.file), false);
});

test('local and native refusals preserve the settings file and both legacy conflict files byte for byte', async t => {
  const h = fixture(t);
  const paths = ['claude', 'codex'].map(host => join(companionHomeDir(host, h.env), 'default-model-codex'));
  paths.forEach((path, i) => put(path, 'legacy-' + i));
  await assert.rejects(h.run({ companion: 'codex', model: 'configured-model', effort: 'ultra' }), /not valid/);
  assert.equal(existsSync(h.file), false);
  await h.run({ target: 'opencode' });
  const state = paths.concat(h.file);
  const snapshot = () => state.map(path => [statSync(path).ino, readFileSync(path, 'utf8')]);
  const before = snapshot();
  await assert.rejects(h.run({ companion: 'codex', model: 'configured-model', effort: 'ultra' }), /not valid/);
  await assert.rejects(h.run({ companion: 'claude', model: 'sonnet', effort: 'bogus' }), /invalid claude effort/);
  assert.deepEqual(snapshot(), before);
});

test('lists both hosts and paths for each migration conflict and resolves only the setting edited', async t => {
  const h = fixture(t);
  const paths = ['default-target', 'default-model'].map(name => ['claude', 'codex'].map(host => {
    const path = join(companionHomeDir(host, h.env), name);
    put(path, host);
    return path;
  }));
  const result = await h.run({});
  assert.equal(result.companion.saved, null);
  assert.equal(result.conflicts.length, 4);
  const text = formatDefaults(result);
  for (const [i, pair] of paths.entries()) {
    for (const [j, path] of pair.entries()) {
      const host = ['claude', 'codex'][j];
      assert.deepEqual(result.conflicts.find(c => c.path === path),
        { path, host, setting: ['companion', 'companions.copilot.model'][i], value: host });
      assert.ok(text.includes(path));
    }
  }
  assert.match(text, /Choose with agent-companion defaults companion=<id>/);
  assert.match(text, /Choose with agent-companion defaults copilot model=<id>/);
  await h.run({ companion: 'copilot', effort: 'high' });
  assert.ok(paths.flat().every(existsSync));
  await h.run({ target: 'claude' });
  assert.ok(paths[0].every(path => !existsSync(path)));
  assert.ok(paths[1].every(existsSync));
  assert.deepEqual((await h.run({ companion: 'copilot', model: 'inherit' })).conflicts, []);
  assert.ok(paths[1].every(path => !existsSync(path)));
  assert.deepEqual(h.settings(), { companion: 'claude', companions: { copilot: { effort: 'high' } } });
});

test('failed native reads give a short reason, allow independent settings, and refuse saves requiring the missing evidence', async t => {
  const h = fixture(t);
  h.env.CODEX_FAKE_CONFIG_ERROR = 'profile is no longer supported\nsecond line';
  const result = await h.run({ companion: 'codex' });
  assert.equal(result.companions.codex.inherit.reason, 'profile is no longer supported second line');
  await assert.rejects(h.run({ companion: 'codex', effort: 'high' }), /profile is no longer supported/);
  await h.run({ companion: 'codex', model: 'configured-model', effort: 'high' });
  h.env.FAKE_OPENCODE_MODE = 'models-unavailable';
  await assert.rejects(h.run({ companion: 'opencode', model: 'fixture/first' }), /HTTP_503/);
  h.env.CODEX_BIN = join(h.root, 'missing');
  await assert.rejects(h.run({ companion: 'codex', model: 'configured-model' }), /Codex.*executable/i);
  const cleared = await h.run({ companion: 'codex', model: 'inherit', effort: 'inherit' });
  assert.match(cleared.companions.codex.inherit.reason, /Codex.*executable/i);
  assert.deepEqual(h.settings(), {});
});

test('a stalled initialize or server bootstrap times out and its owned process is gone', async t => {
  const h = fixture(t);
  h.env.CODEX_FAKE_CHILD_PID = join(h.root, 'detached.pid');
  appendFileSync(h.env.CODEX_BIN, `
if (process.argv[2] === 'app-server') {
  const { spawn } = await import('node:child_process');
  spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.env.CODEX_FAKE_CHILD_PID, String(process.pid)); setInterval(() => {}, 10000)"],
    { detached: true, stdio: 'ignore' }).unref();
}`);
  t.after(() => {
    if (existsSync(h.env.CODEX_FAKE_CHILD_PID)) {
      const pid = Number(readFileSync(h.env.CODEX_FAKE_CHILD_PID, 'utf8'));
      if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
  h.env.CODEX_FAKE_INIT_DELAY_MS = '30000';
  h.env.FAKE_OPENCODE_MODE = 'no-boot';
  for (const companion of ['codex', 'opencode']) {
    const result = await h.run({ companion }, { timeoutMs: companion === 'codex' ? 1500 : 350 });
    assert.match(result.companions[companion].inherit.reason, /timed out/);
    const pid = h.supervisors.at(-1).child.pid;
    assert.ok(pid > 1);
    assert.equal(pidAlive(pid), false);
  }
  assert.equal(pidAlive(Number(readFileSync(h.env.CODEX_FAKE_CHILD_PID, 'utf8'))), false);
});
