// Tests for scripts/onboard.mjs. Pure helpers (parseArgs/planOnboard) are
// exercised directly; the CLI exit-code paths run in a subprocess with a
// temp HOME so no real default-target is written.

import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, planOnboard } from './onboard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'onboard.mjs');

function target(id, ready, extra = {}) {
  return { id, displayName: id, ready, installed: ready, blockers: [], warnings: [], nextSteps: [], ...extra };
}

test('parseArgs reads flags, inline values, and toggles', () => {
  const o = parseArgs(['--host', 'codex', '--target=opencode', '--set-default', '--yes', '--json']);
  assert.equal(o.host, 'codex');
  assert.equal(o.target, 'opencode');
  assert.equal(o.setDefault, true);
  assert.equal(o.yes, true);
  assert.equal(o.json, true);
  assert.equal(parseArgs(['--list-targets']).listTargets, true);
  assert.equal(parseArgs(['--bogus']).unknown, '--bogus');
});

test('planOnboard: explicit target none → host-only', () => {
  const plan = planOnboard({ options: parseArgs(['--target', 'none']), targets: {} });
  assert.equal(plan.kind, 'host-only');
});

test('planOnboard: explicit ready target is chosen', () => {
  const targets = { opencode: target('opencode', true), copilot: target('copilot', false) };
  const plan = planOnboard({ options: parseArgs(['--target', 'opencode', '--set-default']), targets });
  assert.equal(plan.kind, 'chosen');
  assert.equal(plan.id, 'opencode');
  assert.equal(plan.ready, true);
  assert.equal(plan.writeDefault, true);
});

test('planOnboard: explicit not-ready target is still chosen (write intent), ready=false', () => {
  const targets = { opencode: target('opencode', false), copilot: target('copilot', false) };
  const plan = planOnboard({ options: parseArgs(['--target', 'opencode']), targets });
  assert.equal(plan.kind, 'chosen');
  assert.equal(plan.ready, false);
  assert.equal(plan.writeDefault, false);
});

test('planOnboard: explicit ready codex target is chosen', () => {
  const targets = { opencode: target('opencode', false), copilot: target('copilot', false), codex: target('codex', true) };
  const plan = planOnboard({ options: parseArgs(['--target', 'codex', '--set-default']), targets });
  assert.equal(plan.kind, 'chosen');
  assert.equal(plan.id, 'codex');
  assert.equal(plan.ready, true);
  assert.equal(plan.writeDefault, true);
});

test('planOnboard: unknown target errors', () => {
  const plan = planOnboard({ options: parseArgs(['--target', 'goose']), targets: {} });
  assert.equal(plan.kind, 'error');
  assert.equal(plan.code, 'unknown_target');
});

test('planOnboard: auto picks the single ready target', () => {
  const targets = { opencode: target('opencode', true), copilot: target('copilot', false) };
  const plan = planOnboard({ options: parseArgs(['--target', 'auto', '--set-default']), targets });
  assert.equal(plan.kind, 'chosen');
  assert.equal(plan.id, 'opencode');
  assert.equal(plan.autoSelected, true);
});

test('planOnboard: auto with both ready under --yes is ambiguous', () => {
  const targets = { opencode: target('opencode', true), copilot: target('copilot', true) };
  const plan = planOnboard({ options: parseArgs(['--target', 'auto', '--yes']), targets });
  assert.equal(plan.kind, 'error');
  assert.equal(plan.code, 'ambiguous_target');
});

test('planOnboard: auto with none ready under --yes errors', () => {
  const targets = { opencode: target('opencode', false), copilot: target('copilot', false) };
  const plan = planOnboard({ options: parseArgs(['--target', 'auto', '--yes']), targets });
  assert.equal(plan.kind, 'error');
  assert.equal(plan.code, 'no_ready_target');
});

test('planOnboard: no target, interactive → ask', () => {
  const targets = { opencode: target('opencode', true), copilot: target('copilot', true) };
  const plan = planOnboard({ options: parseArgs([]), targets });
  assert.equal(plan.kind, 'ask');
  assert.deepEqual(plan.candidates.sort(), ['copilot', 'opencode']);
});

// --- CLI exit-code paths (subprocess) ---

function run(args, env = {}, files = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-onboard-home-'));
  try {
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(home, name), bytes);
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        HOME: home, CODEX_HOME: join(home, '.codex'), AGENT_COMPANION_HOME: home,
        AGENT_RUNTIME_DIR: join(home, 'runtime'), PATH: '/usr/bin:/bin',
        NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
        OPENCODE_BIN: '/missing-opencode', COPILOT_BIN: '/missing-copilot',
        CODEX_BIN: '/missing-codex', ANTIGRAVITY_ACP_BIN: '/missing-antigravity', ...env,
      },
    });
    const stored = Object.fromEntries(['default-target', 'profiles.json', 'default-model'].map((name) => [
      name, existsSync(join(home, name)) ? readFileSync(join(home, name), 'utf8') : null,
    ]));
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, stored };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('CLI --list-targets --json exits 0 with target readiness', () => {
  const r = run(['--list-targets', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.targets.opencode);
  assert.ok(out.targets.copilot);
  assert.ok(out.targets.codex);
  assert.equal(out.defaultTarget.target, null);
});

test('CLI --target none --yes is host-only and exits 0', () => {
  const r = run(['--target', 'none', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).target, null);
});


test('CLI unknown target exits 2', () => {
  const r = run(['--target', 'goose', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown target/);
});

test('CLI unavailable target fails without replacing an existing default', () => {
  const r = run(['--target', 'opencode', '--set-default', '--yes', '--json'], {}, { 'default-target': 'copilot\n' });
  assert.equal(r.code, 3, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.target, 'opencode');
  assert.equal(out.wroteDefault, false);
  assert.equal(out.report.ready, false);
  assert.equal(r.stored['default-target'], 'copilot\n');
});

test('CLI explicit --no-target-check allows deferred configuration and labels it unready', () => {
  const r = run(['--target', 'opencode', '--set-default', '--no-target-check', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, false);
  assert.equal(r.stored['default-target'], 'opencode\n');
});

test('CLI plan and ordinary reruns preserve existing defaults, models and profiles', () => {
  const files = {
    'default-target': 'copilot\n', 'default-model': 'custom-model\n',
    'profiles.json': '{ "profiles": [{"id":"review","companion":"copilot","strengths":["reviewer"]}], "defaultProfile":"review" }\n',
  };
  for (const args of [['--plan'], [], ['--target', 'none']]) {
    const r = run([...args, '--set-default', '--yes', '--json'], {}, files);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.stored, files);
    assert.match(JSON.parse(r.stdout).configuration.summary, /copilot/);
  }
});

test('failed smoke and read-only plans never commit a default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-commit-'));
  const bin = join(dir, 'codex');
  writeFileSync(bin, `#!${process.execPath}
    if (process.argv[2] === '--version') console.log('codex-cli fake');
    process.exit(0);
  `, { mode: 0o700 });
  try {
    for (const flags of [['--smoke'], ['--smoke', '--no-target-check'], ['--plan']]) {
      const r = run(['--target', 'codex', '--set-default', '--yes', '--json', ...flags], { CODEX_BIN: bin }, { 'default-target': 'copilot\n' });
      assert.equal(r.code, flags.includes('--plan') ? 0 : 3, r.stderr);
      assert.equal(r.stored['default-target'], 'copilot\n');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('plans explain an overriding environment default and never read legacy profiles', () => {
  const files = { 'default-target': 'copilot\n', 'profiles.json': '{bad json\n' };
  const r = run(['--plan', '--target', 'codex', '--set-default', '--yes', '--json'], { AGENT_COMPANION_DEFAULT_TARGET: 'opencode' }, files);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(JSON.parse(r.stdout).plan.code, 'env_override');
  for (const [name, bytes] of Object.entries(files)) assert.equal(r.stored[name], bytes);
  const preserved = run(['--plan', '--yes', '--json'], {}, files);
  assert.equal(preserved.code, 0, preserved.stderr);
  assert.equal(preserved.stored['profiles.json'], files['profiles.json']);
  assert.equal(Object.hasOwn(JSON.parse(preserved.stdout).configuration, 'profiles'), false);
});
