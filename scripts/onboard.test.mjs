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
        CODEX_BIN: '/missing-codex', ANTIGRAVITY_ACP_BIN: '/missing-antigravity', CLAUDE_BIN: '/missing-claude', ...env,
      },
    });
    const stored = Object.fromEntries([...new Set(['default-target', 'profiles.json', 'default-model', ...Object.keys(files)])].map((name) => [
      name, existsSync(join(home, name)) ? readFileSync(join(home, name), 'utf8') : null,
    ]));
    const models = Object.fromEntries(['claude', 'codex', 'opencode', 'antigravity'].map((id) => [
      id, existsSync(join(home, `default-model-${id}`)) ? readFileSync(join(home, `default-model-${id}`), 'utf8') : null,
    ]));
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, stored, models };
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
  assert.ok(out.targets.claude);
  assert.equal(Object.keys(out.targets).length, 5);
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
    assert.deepEqual(JSON.parse(r.stdout).model,
      { requested: null, action: 'none', current: 'custom-model', source: 'config' });
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
      const r = run(['--target', 'codex', '--model', 'gpt-5.4', '--set-default', '--yes', '--json', ...flags],
        { CODEX_BIN: bin }, { 'default-target': 'copilot\n', 'default-model-codex': 'previous-model\n' });
      assert.equal(r.code, flags.includes('--plan') ? 0 : 3, r.stderr);
      assert.equal(r.stored['default-target'], 'copilot\n');
      assert.equal(r.models.codex, 'previous-model\n');
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


test('Claude onboarding persists a ready target without a smoke turn and rejects logged-out auth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-claude-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!${process.execPath}
    const args = process.argv.slice(2).join(' ');
    if (args === '--version') console.log('Claude fake');
    else if (args === 'auth status') console.log(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_IN === '1', authMethod: 'claude.ai', apiProvider: 'firstParty' }));
    else process.exit(99);
  `, { mode: 0o700 });
  try {
    for (const loggedIn of ['1', '0']) {
      const r = run(['--host', 'claude', '--target', 'claude', '--set-default', '--yes', '--json'],
        { CLAUDE_BIN: bin, FAKE_LOGGED_IN: loggedIn }, { 'default-target': 'copilot\n' });
      assert.equal(r.code, loggedIn === '1' ? 0 : 3, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.report.authenticated, loggedIn === '1');
      assert.equal(out.report.smoke.run, false);
      assert.equal(r.stored['default-target'], loggedIn === '1' ? 'claude\n' : 'copilot\n');
      assert.equal(out.report.permission.risk, 'dangerous');
    }
    const help = run(['--help']);
    assert.match(help.stdout, /opencode\|copilot\|codex\|claude\|antigravity/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseArgs accepts separate and inline model values', () => {
  assert.equal(parseArgs(['--model', 'haiku']).model, 'haiku');
  assert.equal(parseArgs(['--model=inherit']).model, 'inherit');
});

test('model plans describe set, clear and preserve without writes', () => {
  for (const [requested, action] of [['haiku', 'set'], ['inherit', 'clear'], [undefined, 'none']]) {
    const options = parseArgs(['--target', 'claude', '--set-default', ...(requested ? ['--model', requested] : [])]);
    const targets = { claude: target('claude', true, {
      capabilities: { modelSelection: true }, defaultModel: { model: 'sonnet', source: 'config' },
    }) };
    const model = { requested: requested ?? null, action, current: 'sonnet', source: 'config' };
    assert.deepEqual(planOnboard({ options, targets }).model, model);
    const r = run(['--plan', '--json', '--no-target-check', ...['--target', 'claude', '--set-default'],
      ...(requested ? ['--model', requested] : [])], {}, { 'default-model-claude': 'sonnet\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).model, model);
    assert.equal(r.models.claude, 'sonnet\n');
    assert.equal(r.stored['default-target'], null);
  }
});

test('model requires an explicit supported target and a nonempty value', () => {
  for (const args of [[], ['--target', 'auto'], ['--target', 'none'], ['--target', 'goose']]) {
    const r = run([...args, '--model', 'haiku']);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /\[FAIL\].*--model requires.*--target/);
  }
  for (const args of [['--model'], ['--model='], ['--model', '   '], ['--model', '--yes']]) {
    const r = run(['--target', 'claude', ...args]);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /\[FAIL\].*--model requires a value/);
  }
});

test('model capability refusal uses the bridge wording', () => {
  for (const model of ['haiku', 'inherit']) {
    const plan = planOnboard({ options: parseArgs(['--target', 'claude', '--model', model]),
      targets: { claude: target('claude', true, { capabilities: { modelSelection: false } }) } });
    assert.equal(plan.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(plan.message, 'companion "claude" cannot select a model');
  }
});

test('invalid model ids fail with companion-specific bridge hints', () => {
  for (const [id, model, hint] of [
    ['claude', 'two words', /Model ids must contain no whitespace\./],
    ['codex', 'two words', /Model ids must contain no whitespace\./],
    ['opencode', 'haiku', /Use a provider\/model id\./],
    ['copilot', 'haiku', /set the Copilot model to one of: .*or omit it to inherit configuration/],
  ]) {
    const r = run(['--target', id, '--model', model, '--set-default', '--no-target-check']);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /\[FAIL\].*MODEL_NOT_ALLOWED/);
    assert.match(r.stderr, hint);
    assert.equal(r.stored['default-target'], null);
  }
});

test('model writes and clears share the target readiness gate, including an unchanged target', () => {
  const files = { 'default-target': 'claude\n', 'default-model-claude': 'sonnet\n' };
  for (const model of ['haiku', 'inherit']) {
    const args = ['--target', 'claude', '--model', model, '--set-default', '--json'];
    const blocked = run(args, {}, files);
    assert.equal(blocked.code, 3, blocked.stderr);
    assert.equal(blocked.models.claude, 'sonnet\n');
    const r = run([...args, '--no-target-check'], {}, files);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.models.claude, model === 'inherit' ? null : 'haiku\n');
    assert.equal(JSON.parse(r.stdout).wroteDefault, false);
    assert.deepEqual(JSON.parse(r.stdout).model, {
      requested: model, action: model === 'inherit' ? 'clear' : 'set',
      current: model === 'inherit' ? null : 'haiku', source: model === 'inherit' ? 'unset' : 'config',
    });
    const preview = run(args.filter((a) => a !== '--set-default'), {}, files);
    assert.equal(preview.models.claude, 'sonnet\n');
  }
  const fresh = run(['--target', 'claude', '--model', 'haiku', '--set-default', '--no-target-check']);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(fresh.stored['default-target'], 'claude\n');
  assert.equal(fresh.models.claude, 'haiku\n');
  assert.match(fresh.stdout, /wrote default model for claude: haiku/);
});

test('list-targets reports per-companion model and source in JSON and text', () => {
  const files = { 'default-model-claude': 'haiku\n' };
  const r = run(['--list-targets', '--json'], {}, files);
  assert.equal(r.code, 0, r.stderr);
  const targets = JSON.parse(r.stdout).targets;
  assert.deepEqual(targets.claude.defaultModel, { model: 'haiku', source: 'config' });
  assert.deepEqual(targets.codex.defaultModel, { model: null, source: 'unset' });
  assert.equal(targets.claude.capabilities.modelSelection, true);
  assert.match(run(['--list-targets'], {}, files).stdout, /default model: haiku \(config\)/);
  const overridden = run(['--plan', '--target', 'claude', '--model', 'inherit', '--no-target-check', '--json'],
    { AGENT_COMPANION_CLAUDE_MODEL: 'opus' }, files);
  assert.equal(JSON.parse(overridden.stdout).model.source, 'env');
});

test('human model plans explain set and clear, even without --set-default', () => {
  for (const [model, text] of [['haiku', /; model haiku/], ['inherit', /; model inherit \(clear saved default\)/]]) {
    const r = run(['--target', 'claude', '--model', model, '--no-target-check']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, text);
    assert.equal(r.models.claude, null);
  }
});

test('each companion uses its existing model file and keeps environment precedence', () => {
  for (const [id, model] of [['copilot', 'gpt-5.4'], ['codex', 'gpt-5.4'],
    ['opencode', 'anthropic/claude-haiku-4-5'], ['antigravity', 'gemini-pro-agent']]) {
    const r = run(['--target', id, '--model', model, '--set-default', '--no-target-check', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(id === 'copilot' ? r.stored['default-model'] : r.models[id], `${model}\n`);
  }
  const r = run(['--target', 'claude', '--model', 'inherit', '--set-default', '--no-target-check', '--json'],
    { AGENT_COMPANION_CLAUDE_MODEL: 'opus' }, { 'default-model-claude': 'haiku\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.models.claude, null);
  assert.deepEqual(JSON.parse(r.stdout).model, { requested: 'inherit', action: 'clear', current: 'opus', source: 'env' });
});
