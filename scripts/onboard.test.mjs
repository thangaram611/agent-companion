// Tests for scripts/onboard.mjs. Pure helpers (parseArgs/planOnboard) are
// exercised directly; the CLI exit-code paths run in a subprocess with a
// temp HOME so no real default-target is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function run(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-onboard-home-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, AGENT_COMPANION_HOME: home, PATH: '/usr/bin:/bin', ...env },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
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

// The codex smoke branch is config-isolated (D11's one deliberate exception —
// --ignore-user-config avoids the user's MCP servers booting on this turn and
// racing the smoke budget) and non-persisting (--ephemeral). Drives the real
// CLI end to end against a FAKE `codex` binary (CODEX_BIN override) that
// answers --version/login status/exec itself — no real Codex turn ever runs,
// per the safety contract.
test('CLI --target codex --smoke runs `codex exec` with --ignore-user-config --ephemeral --sandbox read-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-onboard-codex-fake-'));
  const argvFile = join(dir, 'argv.json');
  const bin = join(dir, 'codex-fake.mjs');
  writeFileSync(bin, [
    // Absolute shebang (not `#!/usr/bin/env node`) — this test deliberately
    // restricts PATH to /usr/bin:/bin (see `run()`) so `env node` would not
    // resolve; the kernel follows an absolute interpreter path without any
    // PATH lookup at all.
    `#!${process.execPath}`,
    'import { writeFileSync } from "node:fs";',
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") { console.log("codex-cli 0.145.0"); process.exit(0); }',
    'if (args[0] === "login" && args[1] === "status") { process.exit(0); }',
    'if (args[0] === "exec") {',
    `  writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));`,
    '  process.stdin.on("data", () => {});',
    '  process.stdin.on("end", () => { console.log(JSON.stringify({ type: "turn.completed", usage: {} })); process.exit(0); });',
    '} else {',
    '  process.exit(1);',
    '}',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(bin, 0o700);
  try {
    const r = run(['--target', 'codex', '--set-default', '--yes', '--smoke', '--json'], { CODEX_BIN: bin });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.report.ready, true);
    assert.equal(out.smoke.supported, true);
    assert.equal(out.smoke.passed, true);
    const capturedArgs = JSON.parse(readFileSync(argvFile, 'utf8'));
    assert.ok(capturedArgs.includes('--ignore-user-config'), `--ignore-user-config missing: ${capturedArgs.join(' ')}`);
    assert.ok(capturedArgs.includes('--ephemeral'), `--ephemeral missing: ${capturedArgs.join(' ')}`);
    const sIdx = capturedArgs.indexOf('--sandbox');
    assert.ok(sIdx >= 0 && capturedArgs[sIdx + 1] === 'read-only', `--sandbox read-only missing: ${capturedArgs.join(' ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('CLI --target opencode --yes on a clean PATH is not ready → exit 3, writes default', () => {
  const r = run(['--target', 'opencode', '--set-default', '--yes', '--json']);
  assert.equal(r.code, 3, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.target, 'opencode');
  assert.equal(out.wroteDefault, true);
  assert.equal(out.report.ready, false);
});
