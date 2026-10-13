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
    '  process.stdin.on("end", () => { console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ready" } })); console.log(JSON.stringify({ type: "turn.completed", usage: {} })); process.exit(0); });',
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

test('Codex smoke requires a completed assistant ready reply, not exit zero or tool output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-smoke-replies-'));
  const bin = join(dir, 'codex');
  writeFileSync(bin, `#!${process.execPath}
    if (process.argv[2] === '--version') { console.log('codex-cli fake'); process.exit(0); }
    if (process.argv[2] === 'login') process.exit(0);
    process.stdout.write(process.env.SMOKE_OUTPUT || '');
    process.exit(Number(process.env.SMOKE_EXIT || 0));
  `, { mode: 0o700 });
  const reply = (text) => ({ type: 'item.completed', item: { type: 'agent_message', text } });
  const done = { type: 'turn.completed', usage: {} };
  const cases = [
    ['empty', [], false],
    ['completion only', [done], false],
    ['wrong reply', [reply('not ready'), done], false],
    ['tool only', [{ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'ready' } }, done], false],
    ['unfinished', [reply('ready')], false],
    ['failed turn', [reply('ready'), { type: 'turn.failed', error: { message: 'failed' } }], false],
    ['fatal error', [reply('ready'), { type: 'error', message: 'failed' }, done], false],
    ['nonzero exit', [reply('ready'), done], false, 1],
    ['ready', [reply('ready'), done], true],
    ['case and punctuation', [reply(' READY!\n'), done], true],
  ];
  try {
    for (const [name, events, passed, exit = 0] of cases) {
      const r = run(['--target', 'codex', '--yes', '--smoke', '--json'], {
        CODEX_BIN: bin, SMOKE_OUTPUT: events.map(JSON.stringify).join('\n'), SMOKE_EXIT: String(exit),
      });
      assert.equal(JSON.parse(r.stdout).smoke.passed, passed, name);
      assert.equal(r.code, passed ? 0 : 3, name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI --target none --yes is host-only and exits 0', () => {
  const r = run(['--target', 'none', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).target, null);
});

test('OpenCode 2 onboarding smoke uses the same private CLI and verifies the assistant reply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode2-onboard-'));
  const bin = join(dir, 'opencode-fake.mjs'), capture = join(dir, 'run.json');
  writeFileSync(bin, `#!${process.execPath}
    const args = process.argv.slice(2);
    if (args[0] === '--version') { console.log('opencode v2.0.25'); process.exit(0); }
    if (args[0] === 'models') { console.log('ollama-cloud/gpt-oss:120b'); process.exit(0); }
    if (args[0] === 'auth') { console.log(JSON.stringify([{ id: 'ollama-cloud', connections: [{ type: 'credential', id: 'cred_fixture' }] }])); process.exit(0); }
    if (args.includes('--dir') || !args.includes('--standalone')) { console.error('Unrecognized legacy flag or missing private server'); process.exit(2); }
    (await import('node:fs')).writeFileSync(process.env.OC_CAPTURE, JSON.stringify({ args, cwd: process.cwd() }));
    if (process.env.OC_FAKE_TOOL_ONLY) console.log(JSON.stringify({ type: 'tool_call', name: 'read', output: 'READY' }));
    else console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: 'READY' } }));
  `, { mode: 0o700 });
  try {
    const r = run(['--target', 'opencode', '--set-default', '--yes', '--smoke', '--json'], {
      OPENCODE_BIN: bin, OC_CAPTURE: capture, AGENT_COMPANION_OPENCODE_MODEL: 'ollama-cloud/gpt-oss:120b',
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).smoke.passed, true);
    const actual = JSON.parse(readFileSync(capture));
    assert.ok(actual.args.includes('--standalone'));
    assert.ok(actual.args.includes('ollama-cloud/gpt-oss:120b'));
    assert.doesNotMatch(actual.args.join(' '), /--dir/);
    assert.match(actual.cwd, /agent-onboard-smoke-/);
    const toolOnly = run(['--target', 'opencode', '--yes', '--smoke', '--json'], { OPENCODE_BIN: bin, OC_CAPTURE: capture, OC_FAKE_TOOL_ONLY: '1' });
    assert.equal(toolOnly.code, 3, toolOnly.stderr);
    assert.equal(JSON.parse(toolOnly.stdout).ok, false);
    assert.equal(JSON.parse(toolOnly.stdout).smoke.passed, false, 'tool output is not an assistant smoke reply');
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
    assert.match(JSON.parse(r.stdout).configuration.summary, /review.*copilot/);
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

test('plans explain conflicting defaults and preserve invalid or ambiguous profiles', () => {
  const cases = [
    [{ 'default-target': 'copilot\n' }, { AGENT_COMPANION_DEFAULT_TARGET: 'opencode' }, 'env_override'],
    [{ 'profiles.json': '{bad json\n' }, {}, 'invalid_configuration'],
    [{ 'profiles.json': JSON.stringify({ profiles: [{ id: 'review', companion: 'copilot' }], defaultProfile: 'review' }) }, {}, 'profile_override'],
    [{ 'profiles.json': JSON.stringify({ profiles: [{ id: 'a', companion: 'codex' }, { id: 'b', companion: 'codex' }] }) }, {}, 'profile_selection'],
  ];
  for (const [files, env, code] of cases) {
    const r = run(['--plan', '--target', 'codex', '--set-default', '--yes', '--json'], env, files);
    assert.equal(r.code, 2, r.stderr);
    assert.equal(JSON.parse(r.stdout).plan.code, code);
    for (const [name, bytes] of Object.entries(files)) assert.equal(r.stored[name], bytes);
  }
  const preserved = run(['--plan', '--yes', '--json'], {}, { 'profiles.json': '{bad json\n' });
  assert.equal(preserved.code, 0, preserved.stderr);
  assert.equal(preserved.stored['profiles.json'], '{bad json\n');
  assert.match(JSON.parse(preserved.stdout).configuration.summary, /needs attention/);
});

test('preflight includes readiness of the profile that will actually receive work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-profile-readiness-'));
  const bin = join(dir, 'copilot');
  writeFileSync(bin, '#!/bin/sh\necho copilot-fake\n', { mode: 0o700 });
  try {
    const profiles = JSON.stringify({ profiles: [{ id: 'review', companion: 'copilot', model: 'not-a-real-model' }], defaultProfile: 'review' });
    const r = run(['--plan', '--target', 'copilot', '--set-default', '--yes', '--json'], { COPILOT_BIN: bin }, { 'profiles.json': profiles });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).plan.ready, false);
    assert.match(JSON.stringify(JSON.parse(r.stdout).plan.report.blockers), /model_invalid/);
    assert.equal(r.stored['profiles.json'], profiles);
    assert.equal(r.stored['default-target'], null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
