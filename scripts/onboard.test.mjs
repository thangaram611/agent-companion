// Tests for scripts/onboard.mjs. Pure helpers (parseArgs/planOnboard) are
// exercised directly; the CLI exit-code paths run in a subprocess with a
// temp HOME so all settings stay in the fixture.

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

function companion(id, ready, extra = {}) {
  return { id, displayName: id, ready, installed: ready, blockers: [], warnings: [], nextSteps: [], ...extra };
}

test('parseArgs reads flags, inline values, and toggles', () => {
  const o = parseArgs(['--host', 'codex', '--companion=opencode', '--set-default', '--yes', '--json']);
  assert.equal(o.host, 'codex');
  assert.equal(o.companion, 'opencode');
  assert.equal(o.setDefault, true);
  assert.equal(o.yes, true);
  assert.equal(o.json, true);
  assert.equal(parseArgs(['--list-companions']).listCompanions, true);
  assert.equal(parseArgs(['--bogus']).unknown, '--bogus');
});

test('planOnboard: explicit companion none → host-only', () => {
  const plan = planOnboard({ options: parseArgs(['--companion', 'none']), companions: {} });
  assert.equal(plan.kind, 'host-only');
});

test('planOnboard: explicit ready companion is chosen', () => {
  const companions = { opencode: companion('opencode', true), copilot: companion('copilot', false) };
  const plan = planOnboard({ options: parseArgs(['--companion', 'opencode', '--set-default']), companions });
  assert.equal(plan.kind, 'chosen');
  assert.equal(plan.id, 'opencode');
  assert.equal(plan.ready, true);
  assert.equal(plan.writeDefault, true);
});

test('planOnboard: explicit not-ready companion is still chosen (write intent), ready=false', () => {
  const companions = { opencode: companion('opencode', false), copilot: companion('copilot', false) };
  const plan = planOnboard({ options: parseArgs(['--companion', 'opencode']), companions });
  assert.equal(plan.kind, 'chosen');
  assert.equal(plan.ready, false);
  assert.equal(plan.writeDefault, false);
});

test('planOnboard: explicit ready codex companion is chosen', () => {
  const companions = { opencode: companion('opencode', false), copilot: companion('copilot', false), codex: companion('codex', true) };
  const plan = planOnboard({ options: parseArgs(['--companion', 'codex', '--set-default']), companions });
  assert.equal(plan.kind, 'chosen');
  assert.equal(plan.id, 'codex');
  assert.equal(plan.ready, true);
  assert.equal(plan.writeDefault, true);
});

test('planOnboard: unknown companion errors', () => {
  const plan = planOnboard({ options: parseArgs(['--companion', 'goose']), companions: {} });
  assert.equal(plan.kind, 'error');
  assert.equal(plan.code, 'unknown_companion');
});

test('planOnboard: auto picks the single ready companion', () => {
  const companions = { opencode: companion('opencode', true), copilot: companion('copilot', false) };
  const plan = planOnboard({ options: parseArgs(['--companion', 'auto', '--set-default']), companions });
  assert.equal(plan.kind, 'chosen');
  assert.equal(plan.id, 'opencode');
  assert.equal(plan.autoSelected, true);
});

test('planOnboard: auto with both ready under --yes is ambiguous', () => {
  const companions = { opencode: companion('opencode', true), copilot: companion('copilot', true) };
  const plan = planOnboard({ options: parseArgs(['--companion', 'auto', '--yes']), companions });
  assert.equal(plan.kind, 'error');
  assert.equal(plan.code, 'ambiguous_companion');
});

test('planOnboard: auto with none ready under --yes errors', () => {
  const companions = { opencode: companion('opencode', false), copilot: companion('copilot', false) };
  const plan = planOnboard({ options: parseArgs(['--companion', 'auto', '--yes']), companions });
  assert.equal(plan.kind, 'error');
  assert.equal(plan.code, 'no_ready_companion');
});

test('planOnboard: no companion, interactive → ask', () => {
  const companions = { opencode: companion('opencode', true), copilot: companion('copilot', true) };
  const plan = planOnboard({ options: parseArgs([]), companions });
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
        CODEX_BIN: '/missing-codex', ANTIGRAVITY_BIN: '/missing-antigravity', CLAUDE_BIN: '/missing-claude', ...env,
      },
    });
    const stored = Object.fromEntries(Object.keys(files).map(name => [
      name, existsSync(join(home, name)) ? readFileSync(join(home, name), 'utf8') : null,
    ]));
    const file = join(home, 'settings.json');
    const settings = existsSync(file) ? JSON.parse(readFileSync(file)) : {};
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, stored, settings, hasSettings: existsSync(file) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function saved(companion, models = {}) {
  const companions = Object.fromEntries(Object.entries(models).map(([id, model]) => [id, { model }]));
  return { 'settings.json': JSON.stringify({ companion, companions }) };
}

test('CLI previews a legacy default without consuming it, then migrates it on startup', () => {
  const files = { 'default-target': 'copilot\n' };
  const args = ['--companion', 'none', '--yes', '--json'];
  const preview = run(['--plan', ...args], {}, files);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).configuration.defaultCompanion.companion, 'copilot');
  assert.deepEqual(preview.stored, files);
  assert.equal(preview.hasSettings, false);
  const actual = run(args, {}, files);
  assert.equal(actual.code, 0, actual.stderr);
  assert.deepEqual(actual.settings, { companion: 'copilot' });
  assert.equal(actual.stored['default-target'], null);
});

test('CLI --list-companions --json exits 0 with companion readiness', () => {
  const r = run(['--list-companions', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.companions.opencode);
  assert.ok(out.companions.copilot);
  assert.ok(out.companions.codex);
  assert.ok(out.companions.claude);
  assert.deepEqual(out.companions.antigravity.nextSteps, ['brew install --cask antigravity-cli']);
  assert.equal(Object.keys(out.companions).length, 5);
  assert.equal(out.defaultCompanion.companion, null);
});

test('CLI --companion none --yes is host-only and exits 0', () => {
  const r = run(['--companion', 'none', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).companion, null);
});


test('CLI unknown companion exits 2', () => {
  const r = run(['--companion', 'goose', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown companion/);
});

test('CLI unavailable companion fails without replacing an existing default', () => {
  const r = run(['--companion', 'opencode', '--set-default', '--yes', '--json'], {}, saved('copilot'));
  assert.equal(r.code, 3, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.companion, 'opencode');
  assert.equal(out.wroteDefault, false);
  assert.equal(out.report.ready, false);
  assert.equal(r.settings.companion, 'copilot');
});

test('CLI explicit --no-companion-check allows deferred configuration and labels it unready', () => {
  const r = run(['--companion', 'opencode', '--set-default', '--no-companion-check', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, false);
  assert.equal(r.settings.companion, 'opencode');
});

test('CLI plan and ordinary reruns preserve existing defaults, models and profiles', () => {
  const files = {
    ...saved('copilot', { copilot: 'custom-model' }),
    'profiles.json': '{ "profiles": [{"id":"review","companion":"copilot","strengths":["reviewer"]}], "defaultProfile":"review" }\n',
  };
  for (const args of [['--plan'], [], ['--companion', 'none']]) {
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
    for (const flags of [['--smoke'], ['--smoke', '--no-companion-check'], ['--plan']]) {
      const r = run(['--companion', 'codex', '--model', 'gpt-5.4', '--set-default', '--yes', '--json', ...flags],
        { CODEX_BIN: bin }, saved('copilot', { codex: 'previous-model' }));
      assert.equal(r.code, flags.includes('--plan') ? 0 : 3, r.stderr);
      assert.equal(r.settings.companion, 'copilot');
      assert.equal(r.settings.companions.codex.model, 'previous-model');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('plans explain an overriding environment default and never read legacy profiles', () => {
  const files = { ...saved('copilot'), 'profiles.json': '{bad json\n' };
  const r = run(['--plan', '--companion', 'codex', '--set-default', '--yes', '--json'], { AGENT_COMPANION_DEFAULT_COMPANION: 'opencode' }, files);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(JSON.parse(r.stdout).plan.code, 'env_override');
  for (const [name, bytes] of Object.entries(files)) assert.equal(r.stored[name], bytes);
  const preserved = run(['--plan', '--yes', '--json'], {}, files);
  assert.equal(preserved.code, 0, preserved.stderr);
  assert.equal(preserved.stored['profiles.json'], files['profiles.json']);
  assert.equal(Object.hasOwn(JSON.parse(preserved.stdout).configuration, 'profiles'), false);
});


test('Claude onboarding persists a ready companion without a smoke turn and rejects logged-out auth', () => {
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
      const r = run(['--host', 'claude', '--companion', 'claude', '--set-default', '--yes', '--json'],
        { CLAUDE_BIN: bin, FAKE_LOGGED_IN: loggedIn }, saved('copilot'));
      assert.equal(r.code, loggedIn === '1' ? 0 : 3, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.report.authenticated, loggedIn === '1');
      assert.equal(out.report.smoke.run, false);
      assert.equal(r.settings.companion, loggedIn === '1' ? 'claude' : 'copilot');
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
    const options = parseArgs(['--companion', 'claude', '--set-default', ...(requested ? ['--model', requested] : [])]);
    const companions = { claude: companion('claude', true, {
      capabilities: { modelSelection: true }, defaultModel: { model: 'sonnet', source: 'config' },
    }) };
    const model = { requested: requested ?? null, action, current: 'sonnet', source: 'config' };
    assert.deepEqual(planOnboard({ options, companions }).model, model);
    const r = run(['--plan', '--json', '--no-companion-check', ...['--companion', 'claude', '--set-default'],
      ...(requested ? ['--model', requested] : [])], {}, saved(undefined, { claude: 'sonnet' }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).model, model);
    assert.equal(r.settings.companions?.claude?.model, 'sonnet');
    assert.equal(r.settings.companion, undefined);
  }
});

test('model requires an explicit supported companion and a nonempty value', () => {
  for (const args of [[], ['--companion', 'auto'], ['--companion', 'none'], ['--companion', 'goose']]) {
    const r = run([...args, '--model', 'haiku']);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /\[FAIL\].*--model requires.*--companion/);
  }
  for (const args of [['--model'], ['--model='], ['--model', '   '], ['--model', '--yes']]) {
    const r = run(['--companion', 'claude', ...args]);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /\[FAIL\].*--model requires a value/);
  }
});

test('model capability refusal uses the bridge wording', () => {
  for (const model of ['haiku', 'inherit']) {
    const plan = planOnboard({ options: parseArgs(['--companion', 'claude', '--model', model]),
      companions: { claude: companion('claude', true, { capabilities: { modelSelection: false } }) } });
    assert.equal(plan.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(plan.message, 'companion "claude" cannot select a model');
  }
});

test('invalid model ids fail with companion-specific bridge hints', () => {
  for (const [id, model, hint] of [
    ['claude', 'two words', /Model ids must contain no whitespace\./],
    ['codex', 'two words', /Model ids must contain no whitespace\./],
    ['opencode', 'haiku', /Use a provider\/model id\./],
    ['copilot', 'two words', /Model ids must contain no whitespace\./],
  ]) {
    const r = run(['--companion', id, '--model', model, '--set-default', '--no-companion-check']);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /\[FAIL\].*MODEL_NOT_ALLOWED/);
    assert.match(r.stderr, hint);
    assert.equal(r.settings.companion, undefined);
  }
});

test('model writes and clears share the companion readiness gate, including an unchanged companion', () => {
  const files = saved('claude', { claude: 'sonnet' });
  for (const model of ['haiku', 'inherit']) {
    const args = ['--companion', 'claude', '--model', model, '--set-default', '--json'];
    const blocked = run(args, {}, files);
    assert.equal(blocked.code, 3, blocked.stderr);
    assert.equal(blocked.settings.companions.claude.model, 'sonnet');
    const r = run([...args, '--no-companion-check'], {}, files);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.settings.companions?.claude?.model, model === 'inherit' ? undefined : 'haiku');
    assert.equal(JSON.parse(r.stdout).wroteDefault, false);
    assert.deepEqual(JSON.parse(r.stdout).model, {
      requested: model, action: model === 'inherit' ? 'clear' : 'set',
      current: model === 'inherit' ? null : 'haiku', source: model === 'inherit' ? 'unset' : 'config',
    });
    const preview = run(args.filter((a) => a !== '--set-default'), {}, files);
    assert.equal(preview.settings.companions.claude.model, 'sonnet');
  }
  const fresh = run(['--companion', 'claude', '--model', 'haiku', '--set-default', '--no-companion-check']);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(fresh.settings.companion, 'claude');
  assert.equal(fresh.settings.companions.claude.model, 'haiku');
  assert.match(fresh.stdout, /wrote default model for claude: haiku/);
});

test('list-companions reports per-companion model and source in JSON and text', () => {
  const files = saved(undefined, { claude: 'haiku' });
  const r = run(['--list-companions', '--json'], {}, files);
  assert.equal(r.code, 0, r.stderr);
  const companions = JSON.parse(r.stdout).companions;
  assert.deepEqual(companions.claude.defaultModel, { model: 'haiku', source: 'config' });
  assert.deepEqual(companions.codex.defaultModel, { model: null, source: 'unset' });
  assert.equal(companions.claude.capabilities.modelSelection, true);
  assert.match(run(['--list-companions'], {}, files).stdout, /default model: haiku \(config\)/);
  const overridden = run(['--plan', '--companion', 'claude', '--model', 'inherit', '--no-companion-check', '--json'],
    { AGENT_COMPANION_CLAUDE_MODEL: 'opus' }, files);
  assert.equal(JSON.parse(overridden.stdout).model.source, 'env');
});

test('human model plans explain set and clear, even without --set-default', () => {
  for (const [model, text] of [['haiku', /; model haiku/], ['inherit', /; model inherit \(clear saved default\)/]]) {
    const r = run(['--companion', 'claude', '--model', model, '--no-companion-check']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, text);
    assert.equal(r.settings.companions?.claude?.model, undefined);
  }
});

test('each companion saves its model in shared settings and keeps environment precedence', () => {
  for (const [id, model] of [['copilot', 'byok-model:latest'], ['codex', 'gpt-5.4'],
    ['opencode', 'anthropic/claude-haiku-4-5'], ['antigravity', 'gemini-3.8-flash']]) {
    const r = run(['--companion', id, '--model', model, '--set-default', '--no-companion-check', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.settings.companions[id].model, model);
  }
  const r = run(['--companion', 'claude', '--model', 'inherit', '--set-default', '--no-companion-check', '--json'],
    { AGENT_COMPANION_CLAUDE_MODEL: 'opus' }, saved(undefined, { claude: 'haiku' }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.settings.companions?.claude?.model, undefined);
  assert.deepEqual(JSON.parse(r.stdout).model, { requested: 'inherit', action: 'clear', current: 'opus', source: 'env' });
});
