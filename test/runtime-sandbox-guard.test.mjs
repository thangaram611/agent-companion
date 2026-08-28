// Runtime-sandbox guard: proves the precondition that stops a test from
// touching the operator's real ~/.{claude,codex}/agent-companion.
//
// The precondition lives in production code, at the choke points every path
// goes through — lib/host.mjs's refuseRealHomeUnderTest, called by
// runtime-paths' runtimeDir() and by state.mjs's BASE_DIR at import, and its
// bash twin in hooks/drain-completions.sh. It keys on NODE_TEST_CONTEXT, which
// `node --test` sets in every test child and which everything a test spawns
// inherits. So there is no list of suites or hooks to keep current: a suite
// that forgets to sandbox fails the moment it touches the path, with a message
// naming the env var to set.
//
// Measured 2026-08-28: hooks/drain-completions.test.mjs had written five
// fixture-session heartbeats (`sid-A`, `café-1`, …) into the real heartbeats
// dir on every run, and HOST_LIVENESS_TTL_MS (30 min) then kept the shared
// codex broker's idle reaper extended per run. A textual guard over the test
// sources was tried first; it had a directory allowlist, missed hooks that
// reach state through node, and could be satisfied by `= ''`. This one cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { refuseRealHomeUnderTest } from '../lib/host.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(REPO_ROOT, 'hooks', 'drain-completions.sh');
const REAL_HOME = userInfo().homedir;

// This suite runs under NODE_TEST_CONTEXT itself, so the pure helper can be
// exercised in-process; the choke points are exercised in children, which
// inherit the variable exactly the way a forgetful suite's children would.
assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test sets NODE_TEST_CONTEXT in test children; this suite depends on it');

const baseEnv = () => {
  const env = { ...process.env };
  for (const key of ['AGENT_RUNTIME_DIR', 'AGENT_HEARTBEAT_DIR', 'AGENT_COMPANION_HOME', 'AGENT_QUEUE_PATH']) delete env[key];
  env.HOME = REAL_HOME;
  return env;
};

function runNode(source, env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
  });
}

test('the helper refuses the real home only under node --test, and never a tmpdir sandbox', () => {
  const real = join(REAL_HOME, '.claude', 'agent-companion', 'runtime');
  assert.throws(() => refuseRealHomeUnderTest(real, 'runtime dir'), /refusing to use the operator's real runtime dir .*from inside `node --test`/);
  assert.throws(() => refuseRealHomeUnderTest(REAL_HOME, 'state dir'), /real state dir/);
  // A sandbox is a sandbox wherever tmpdir lives — including under $HOME.
  const sandbox = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    assert.equal(refuseRealHomeUnderTest(sandbox, 'runtime dir'), sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  assert.equal(refuseRealHomeUnderTest('/var/folders/xx/T/agent-rt', 'runtime dir'), '/var/folders/xx/T/agent-rt');
  // A sibling that merely shares a prefix is not "inside".
  assert.equal(refuseRealHomeUnderTest(`${REAL_HOME}-other/x`, 'runtime dir'), `${REAL_HOME}-other/x`);
  // Outside the suite the helper is inert: production never sets the variable.
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.equal(refuseRealHomeUnderTest(real, 'runtime dir'), real);
  } finally {
    process.env.NODE_TEST_CONTEXT = saved;
  }
});

test('runtimeDir() throws for the real runtime dir under test, and accepts AGENT_RUNTIME_DIR or a sandboxed HOME', () => {
  const src = "import('./lib/runtime-paths.mjs').then((m) => { console.log('DIR=' + m.runtimeDir()); })";
  const bare = runNode(src, baseEnv());
  assert.notEqual(bare.status, 0, `expected a refusal, got stdout=${bare.stdout}`);
  assert.match(bare.stderr, /refusing to use the operator's real runtime dir/);

  const sandbox = mkdtempSync(join(tmpdir(), 'guard-rt-'));
  const home = mkdtempSync(join(tmpdir(), 'guard-home-'));
  try {
    const viaEnv = runNode(src, { ...baseEnv(), AGENT_RUNTIME_DIR: sandbox });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.equal(viaEnv.stdout.trim(), `DIR=${sandbox}`);
    const viaHome = runNode(src, { ...baseEnv(), HOME: home });
    assert.equal(viaHome.status, 0, viaHome.stderr);
    assert.ok(viaHome.stdout.trim().startsWith(`DIR=${home}`), viaHome.stdout);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('importing lib/state.mjs unsandboxed throws at import under test; AGENT_COMPANION_HOME sandboxes it', () => {
  const src = "import('./lib/state.mjs').then((m) => { console.log('BASE=' + m.BASE_DIR); })";
  const bare = runNode(src, baseEnv());
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /refusing to use the operator's real state dir/);
  const sandbox = mkdtempSync(join(tmpdir(), 'guard-state-'));
  try {
    const ok = runNode(src, { ...baseEnv(), AGENT_COMPANION_HOME: sandbox });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), `BASE=${sandbox}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('the drain-completions hook refuses the real runtime dir under test with exit 78, and writes into a sandbox', () => {
  const run = (env) => spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: 'guard-sid', tool_response: {} }),
    env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
  });
  const bare = run(baseEnv());
  assert.equal(bare.status, 78, `stdout=${bare.stdout} stderr=${bare.stderr}`);
  assert.match(bare.stderr, /refusing to use the operator's real runtime dir .* from inside node --test/);
  assert.equal(existsSync(join(REAL_HOME, '.claude', 'agent-companion', 'runtime', 'heartbeats', 'guard-sid.heartbeat')), false,
    'the refusal must come before the heartbeat write');

  const sandbox = mkdtempSync(join(tmpdir(), 'guard-hook-'));
  try {
    const ok = run({ ...baseEnv(), AGENT_RUNTIME_DIR: sandbox });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(existsSync(join(sandbox, 'heartbeats', 'guard-sid.heartbeat')), 'heartbeat lands in the sandbox');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
