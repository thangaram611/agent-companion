import '../test/sandbox-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);
const AGENT_SENTINEL = '# AUTO-INSTALLED by agent-companion plugin (hooks/install-agent-codex.sh) — edits will be overwritten on next session';
const FIXTURE_PATHS = [
  '.claude-plugin',
  '.codex-plugin',
  'opencode-plugin',
  'assets',
  'bridge-server',
  'hooks',
  'lib',
  'scripts',
  'test',
  'LICENSE',
  'README.md',
  'setup.sh',
];

function copySourceFixture(destination) {
  mkdirSync(destination, { recursive: true });
  for (const relativePath of FIXTURE_PATHS) {
    cpSync(path.join(REPO_ROOT, relativePath), path.join(destination, relativePath), {
      recursive: true,
      filter(source) {
        const base = path.basename(source);
        return base !== 'node_modules' && base !== 'dist' && base !== '.plugin-data';
      },
    });
  }
}

function writeExecutable(file, contents) {
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
}

function writeFakeToolchain(binDir) {
  mkdirSync(binDir, { recursive: true });
  symlinkSync(process.execPath, path.join(binDir, 'node'));
  symlinkSync('/usr/bin/jq', path.join(binDir, 'jq'));
  writeExecutable(path.join(binDir, 'npm'), `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo 10.0.0
else
  [ -z "\${FAKE_NPM_LOG:-}" ] || printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
  # Like npm ci: empty node_modules first, through a link if it is one.
  [ "\${FAKE_NPM_EMPTY:-}" != 1 ] || [ "\${1:-}" != ci ] || rm -rf node_modules/*
  exit "\${FAKE_NPM_EXIT:-0}"
fi
exit 0
`);

  writeExecutable(path.join(binDir, 'codex'), `#!${process.execPath}
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME || '';
const logPath = process.env.FAKE_CODEX_LOG || '';
const marketplaceState = path.join(codexHome, '.fake-marketplace-source');
const installedPath = path.join(
  codexHome,
  'plugins',
  'cache',
  'agent-companion',
  'agent-companion',
  '0.0.1',
);

appendFileSync(logPath, JSON.stringify({ args, codexHome, home: process.env.HOME || '' }) + '\\n');

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\\n');
}

function fail(message) {
  process.stderr.write(message + '\\n');
  process.exit(2);
}

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli 0.152.1\\n');
  process.exit(0);
}

if (args.join(' ') === 'login status') {
  process.exit(Number(process.env.FAKE_CODEX_AUTH_FAIL || 0) ||
    (process.env.FAKE_CODEX_AUTH_EXPIRES === '1' && existsSync(marketplaceState) ? 1 : 0));
}

if (args.join(' ') === 'plugin marketplace add --help' || args.join(' ') === 'plugin add --help') {
  process.stdout.write('fake help\\n');
  process.exit(0);
}

if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  const source = args[3];
  if (args[4] !== '--json') fail('marketplace add must request JSON');
  if (!source || !existsSync(path.join(source, '.agents', 'plugins', 'marketplace.json'))) {
    fail('missing marketplace root');
  }
  const alreadyAdded = existsSync(marketplaceState);
  if (!existsSync(codexHome)) fail('CODEX_HOME must exist before marketplace registration');
  writeFileSync(marketplaceState, source);
  printJson({
    marketplaceName: 'agent-companion',
    installedRoot: source,
    alreadyAdded,
  });
  process.exit(0);
}

if (args[0] === 'plugin' && args[1] === 'add') {
  if (args[2] !== 'agent-companion@agent-companion' || args[3] !== '--json') {
    fail('unexpected plugin add invocation');
  }
  const marketplaceRoot = readFileSync(marketplaceState, 'utf8');
  const marketplace = JSON.parse(readFileSync(
    path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
    'utf8',
  ));
  const relativePluginPath = marketplace.plugins[0].source.path.replace(/^\\.\\//, '');
  const pluginRoot = path.join(marketplaceRoot, relativePluginPath);
  rmSync(installedPath, { recursive: true, force: true });
  mkdirSync(path.dirname(installedPath), { recursive: true });
  cpSync(pluginRoot, installedPath, { recursive: true });
  printJson({
    pluginId: 'agent-companion@agent-companion',
    name: 'agent-companion',
    marketplaceName: 'agent-companion',
    version: '0.0.1',
    installedPath,
    authPolicy: 'ON_INSTALL',
  });
  process.exit(0);
}

if (args.join(' ') === 'mcp list --json') {
  let cwd = installedPath;
  if (process.env.FAKE_CODEX_BAD_MCP === '1') {
    cwd = path.join(codexHome, 'wrong MCP root');
    mkdirSync(cwd, { recursive: true });
  }
  printJson([{
    name: 'agent-bridge',
    enabled: true,
    transport: {
      type: 'stdio',
      command: '/bin/bash',
      args: ['hooks/launch-agent-bridge.sh'],
      env: {
        AGENT_COMPANION_HOST: 'codex',
      },
      env_vars: [],
      cwd,
    },
    startup_timeout_sec: 120,
    tool_timeout_sec: 1320,
    auth_status: 'unsupported',
  }]);
  process.exit(0);
}

fail('unexpected fake codex invocation: ' + args.join(' '));
`);
}

function seedLegacyHooks(codexHome) {
  const hooksPath = path.join(codexHome, 'hooks.json');
  const managed = (command) => ({
    _managed_by: 'agent-companion',
    hooks: [{ type: 'command', command }],
  });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(hooksPath, JSON.stringify({
    customTopLevel: { preserve: true },
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'echo user-session-start' }] },
        managed('echo stale-session-start'),
      ],
      UserPromptSubmit: [managed('echo stale-prompt')],
      PostToolUse: [managed('echo stale-post-tool')],
      PreToolUse: [managed('echo stale-pre-tool')],
      Stop: [managed('echo stale-stop')],
      CustomEvent: [{ hooks: [{ type: 'command', command: 'echo custom' }] }],
    },
  }, null, 2) + '\n');
  return hooksPath;
}

function runSetup(sourceRoot, home, codexHome, binDir, logPath, extraEnv = {}, args = [
  '--host', 'codex', '--companion', 'none', '--skip-tests',
]) {
  return spawnSync('/bin/bash', [
    path.join(sourceRoot, 'setup.sh'),
    ...args,
  ], {
    cwd: sourceRoot,
    env: {
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
      HOME: home,
      CODEX_HOME: codexHome,
      AGENT_RUNTIME_DIR: path.join(home, 'runtime'),
      OPENCODE_BIN: '/missing-opencode', COPILOT_BIN: '/missing-copilot',
      ANTIGRAVITY_BIN: '/missing-antigravity', CLAUDE_BIN: '/missing-claude',
      FAKE_CODEX_LOG: logPath,
      PATH: [binDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function readCalls(logPath) {
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function installedPluginRoot(codexHome) {
  return path.join(
    codexHome,
    'plugins',
    'cache',
    'agent-companion',
    'agent-companion',
    '0.0.1',
  );
}

function hookBackups(codexHome) {
  return readdirSync(codexHome).filter((name) => /^hooks\.json\.bak\./.test(name));
}

test('Codex source setup installs and refreshes the plugin in a custom CODEX_HOME', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'agent-companion setup test-'));
  const sourceRoot = path.join(tmp, 'source checkout');
  const home = path.join(tmp, 'user home');
  const codexHome = path.join(tmp, 'custom Codex home');
  const binDir = path.join(tmp, 'fake bin');
  const logPath = path.join(tmp, 'codex calls.jsonl');
  try {
    copySourceFixture(sourceRoot);
    mkdirSync(home, { recursive: true });
    writeFakeToolchain(binDir);

    const hooksPath = seedLegacyHooks(codexHome);
    const pluginRoot = installedPluginRoot(codexHome);
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(path.join(pluginRoot, 'stale-cache-marker'), 'old package\n');
    const agentPath = path.join(codexHome, 'agents', 'agent-companion.toml');
    mkdirSync(path.dirname(agentPath), { recursive: true });
    writeFileSync(agentPath, `${AGENT_SENTINEL}\nstale role\n`);

    const first = runSetup(sourceRoot, home, codexHome, binDir, logPath);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /Codex agent-bridge MCP registration verified/);
    // The live-view launcher lands in the (sandboxed) home and names the checkout.
    assert.match(first.stdout, /UI launcher installed: .*\.local\/bin\/agent-companion/);
    assert.match(first.stdout, /Live view: run ~\/\.local\/bin\/agent-companion ui \(add ~\/\.local\/bin to PATH/);
    assert.ok(readFileSync(path.join(home, '.local/bin/agent-companion'), 'utf8').includes(path.join(realpathSync(sourceRoot), 'hooks/launch-ui.sh')));
    assert.match(first.stdout, /start a fresh session/);

    const calls = readCalls(logPath);
    const marketplaceRoot = path.join(realpathSync(sourceRoot), 'dist', 'codex-marketplace');
    assert.deepEqual(calls.map((call) => call.args), [
      ['--version'],
      ['plugin', 'marketplace', 'add', '--help'],
      ['plugin', 'add', '--help'],
      ['--version'],
      ['login', 'status'],
      ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'],
      ['plugin', 'add', 'agent-companion@agent-companion', '--json'],
      ['mcp', 'list', '--json'],
    ]);
    assert.ok(calls.every((call) => call.codexHome === codexHome));
    assert.ok(calls.every((call) => call.home === home));

    const manifest = JSON.parse(readFileSync(
      path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
      'utf8',
    ));
    assert.deepEqual(manifest.mcpServers['agent-bridge'], {
      command: '/bin/bash',
      args: ['hooks/launch-agent-bridge.sh'],
      cwd: '.',
      env: {
        AGENT_COMPANION_HOST: 'codex',
      },
      default_tools_approval_mode: 'approve',
      required: true,
      startup_timeout_sec: 120,
      tool_timeout_sec: 1320,
    });
    assert.ok(existsSync(path.join(pluginRoot, 'hooks', 'launch-agent-bridge.sh')));
    assert.equal(existsSync(path.join(pluginRoot, 'stale-cache-marker')), false);

    assert.equal(existsSync(agentPath), false);

    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    assert.deepEqual(hooks.customTopLevel, { preserve: true });
    assert.equal(hooks.hooks.SessionStart.length, 1);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'echo user-session-start');
    assert.equal(hooks.hooks.CustomEvent[0].hooks[0].command, 'echo custom');
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'PreToolUse', 'Stop']) {
      assert.equal(hooks.hooks[event], undefined, `${event} legacy entry removed`);
    }
    assert.equal(hookBackups(codexHome).length, 1);
    assert.equal(readFileSync(path.join(codexHome, 'agent-companion', '.host'), 'utf8'), 'codex\n');
    assert.equal(existsSync(path.join(home, '.codex')), false);

    const stableTime = new Date('2020-01-02T03:04:05.000Z');
    utimesSync(hooksPath, stableTime, stableTime);
    const stableHooksBytes = readFileSync(hooksPath);
    writeFileSync(path.join(pluginRoot, 'stale-cache-marker-again'), 'old package again\n');

    const second = runSetup(sourceRoot, home, codexHome, binDir, logPath);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /UI launcher unchanged/);
    assert.equal(existsSync(path.join(pluginRoot, 'stale-cache-marker-again')), false);
    assert.equal(existsSync(agentPath), false);
    assert.deepEqual(readFileSync(hooksPath), stableHooksBytes);
    assert.equal(statSync(hooksPath).mtimeMs, stableTime.getTime());
    assert.equal(hookBackups(codexHome).length, 1);

    const allCalls = readCalls(logPath);
    assert.equal(allCalls.length, 16);
    assert.deepEqual(
      allCalls.slice(8).map((call) => call.args),
      calls.map((call) => call.args),
      'repeat setup must refresh through the same Codex command sequence',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('setup discovers the same test files as root discovery, including cross-cutting guards', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'setup-discovery-'));
  const source = path.join(tmp, 'source'), home = path.join(tmp, 'home');
  const bin = path.join(tmp, 'bin'), capture = path.join(tmp, 'tests.json');
  try {
    copySourceFixture(source);
    mkdirSync(home);
    writeFakeToolchain(bin);
    rmSync(path.join(bin, 'node'));
    writeExecutable(path.join(bin, 'node'), `#!${process.execPath}
      import { writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      const args = process.argv.slice(2);
      if (args[0] === '--test') {
        writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args.slice(1)));
      } else {
        const r = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit' });
        process.exit(r.status ?? 1);
      }
    `);
    const result = runSetup(source, home, path.join(home, '.codex'), bin, path.join(tmp, 'calls'), {}, [
      '--host', 'codex', '--companion', 'none',
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const found = JSON.parse(readFileSync(capture)).map((f) => path.relative(realpathSync(source), f)).sort();
    const expected = readdirSync(REPO_ROOT, { recursive: true }).filter((f) => f.endsWith('.test.mjs') && !f.startsWith('bridge-server/node_modules/')).sort();
    assert.deepEqual(found, expected);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('Codex source setup preserves legacy hooks when effective MCP registration is wrong', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'agent-companion setup failure test-'));
  const sourceRoot = path.join(tmp, 'source checkout');
  const home = path.join(tmp, 'user home');
  const codexHome = path.join(tmp, 'custom Codex home');
  const binDir = path.join(tmp, 'fake bin');
  const logPath = path.join(tmp, 'codex calls.jsonl');
  try {
    copySourceFixture(sourceRoot);
    mkdirSync(home, { recursive: true });
    writeFakeToolchain(binDir);
    const hooksPath = seedLegacyHooks(codexHome);
    const originalHooks = readFileSync(hooksPath);

    const result = runSetup(sourceRoot, home, codexHome, binDir, logPath, {
      FAKE_CODEX_BAD_MCP: '1',
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(
      result.stdout,
      /installed the plugin but did not register its agent-bridge MCP transport/,
    );
    assert.doesNotMatch(result.stdout, /Setup complete/);
    assert.deepEqual(readFileSync(hooksPath), originalHooks);
    assert.deepEqual(hookBackups(codexHome), []);
    assert.equal(existsSync(path.join(codexHome, 'agents', 'agent-companion.toml')), false);
    assert.equal(existsSync(path.join(codexHome, 'agent-companion', '.host')), false);
    assert.ok(existsSync(path.join(installedPluginRoot(codexHome), '.codex-plugin', 'plugin.json')));
    assert.deepEqual(readCalls(logPath).map((call) => call.args).slice(-3), [
      ['plugin', 'marketplace', 'add', path.join(realpathSync(sourceRoot), 'dist', 'codex-marketplace'), '--json'],
      ['plugin', 'add', 'agent-companion@agent-companion', '--json'],
      ['mcp', 'list', '--json'],
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function setupFixture(t) {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'setup-flow-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source checkout'), home = path.join(tmp, 'home');
  const codexHome = path.join(tmp, 'custom codex'), bin = path.join(tmp, 'bin');
  const log = path.join(tmp, 'codex.jsonl'), npmLog = path.join(tmp, 'npm.log');
  copySourceFixture(source);
  mkdirSync(home);
  writeFakeToolchain(bin);
  return {
    tmp, source, home, codexHome, bin, log, npmLog,
    settingsFile: path.join(home, '.config', 'agent-companion', 'settings.json'),
    settings() { return JSON.parse(readFileSync(this.settingsFile)); },
    seedSettings(settings) {
      mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      writeFileSync(this.settingsFile, JSON.stringify(settings));
    },
    run(args, env = {}) {
      return runSetup(source, home, codexHome, bin, log, { FAKE_NPM_LOG: npmLog, ...env }, args);
    },
    state(host = 'codex') {
      const dir = path.join(host === 'codex' ? codexHome : path.join(home, '.claude'), 'agent-companion');
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    assertNoInstall() {
      assert.equal(existsSync(npmLog), false, 'preflight must precede npm installation');
      assert.equal(existsSync(installedPluginRoot(codexHome)), false);
      if (existsSync(log)) assert.ok(readCalls(log).every(({ args }) => !args.includes('--json')), 'no plugin mutation');
    },
  };
}

test('clean setup detects the only host/companion, previews changes and preserves its default on rerun', (t) => {
  const f = setupFixture(t);
  const first = f.run(['--skip-tests']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /detected host: codex/);
  assert.ok(first.stdout.indexOf('Intended installation changes:') < first.stdout.indexOf('Installing bridge server dependencies'));
  assert.match(first.stdout, /companion: codex \(config\)/);
  assert.match(first.stdout, /Unverified: live delegation/);
  assert.match(first.stdout, /Approve.*plugin hooks/);
  const file = f.settingsFile;
  assert.equal(f.settings().companion, 'codex');
  const time = new Date('2020-01-02T03:04:05Z');
  utimesSync(file, time, time);
  const second = f.run(['--skip-tests']);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /preserve companion configuration/);
  assert.equal(statSync(file).mtimeMs, time.getTime());
  assert.ok(readCalls(f.log).every(({ args }) => !['exec', 'app-server'].includes(args[0])));
});

test('preflight refuses missing hosts, missing authentication and ambiguous companions without installation', async (t) => {
  for (const scenario of ['missing host', 'authentication', 'multiple companions', 'none ready', 'both hosts']) {
    await t.test(scenario, (t) => {
      const f = setupFixture(t);
      let args = ['--host', 'codex', '--companion', 'codex', '--skip-tests'];
      const env = {};
      let message;
      if (scenario === 'missing host') {
        args = ['--host', 'claude', '--companion', 'none']; message = /claude.*not found/;
      } else if (scenario === 'authentication' || scenario === 'none ready') {
        env.FAKE_CODEX_AUTH_FAIL = '1';
        if (scenario === 'none ready') args = ['--host', 'codex', '--skip-tests'];
        message = /authentication|codex login/;
      } else if (scenario === 'multiple companions') {
        writeExecutable(path.join(f.bin, 'copilot'), '#!/bin/sh\necho copilot-fake\n');
        env.COPILOT_BIN = path.join(f.bin, 'copilot');
        args = ['--host', 'codex', '--skip-tests']; message = /multiple companions ready/;
      } else {
        writeExecutable(path.join(f.bin, 'claude'), '#!/bin/sh\nexit 0\n');
        args = ['--companion', 'none', '--yes']; message = /Multiple hosts are installed/;
      }
      const r = f.run(args, env);
      assert.notEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, message);
      f.assertNoInstall();
      assert.equal(existsSync(f.settingsFile), false);
    });
  }
});

test('dry-run previews a clean install and --no-companion-check explicitly defers authentication', (t) => {
  const f = setupFixture(t);
  const preview = f.run(['--host', 'codex', '--companion', 'codex', '--dry-run']);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /Plan \(codex\): set default companion to codex/);
  assert.match(preview.stdout, /Preview only/);
  assert.match(preview.stdout, /Next: brew install --cask antigravity-cli/);
  f.assertNoInstall();
  const deferred = f.run(['--host', 'codex', '--companion', 'codex', '--no-companion-check', '--skip-tests'], { FAKE_CODEX_AUTH_FAIL: '1' });
  assert.equal(deferred.status, 0, deferred.stdout + deferred.stderr);
  assert.match(deferred.stdout, /Readiness deferred/);
  assert.match(deferred.stdout, /companion: codex \(config\); needs attention/);
  assert.equal(f.settings().companion, 'codex');
});

test('both hosts preserve the shared default, legacy profiles and unrelated host settings', (t) => {
  const f = setupFixture(t);
  writeExecutable(path.join(f.bin, 'claude'), '#!/bin/sh\nexit 0\n');
  const profiles = '{ "profiles": [{"id":"review","companion":"copilot","strengths":["reviewer"]}], "defaultProfile":"review" }\n';
  writeFileSync(path.join(f.state(), 'profiles.json'), profiles);
  f.seedSettings({ companion: 'opencode' });
  f.state('claude');
  const settings = path.join(f.home, '.claude/settings.json');
  writeFileSync(settings, JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(custom)'], deny: ['Bash(blocked)'] } }));
  const result = f.run(['--host', 'both', '--skip-tests']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /companion: opencode \(config\); needs attention/);
  assert.match(result.stdout, /Claude: permissions installed; companion: opencode/);
  assert.equal(readFileSync(path.join(f.state(), 'profiles.json'), 'utf8'), profiles);
  assert.deepEqual(f.settings(), { companion: 'opencode' });
  const saved = JSON.parse(readFileSync(settings));
  assert.equal(saved.theme, 'dark');
  assert.ok(saved.permissions.allow.includes('Bash(custom)'));
  assert.deepEqual(saved.permissions.deny, ['Bash(blocked)']);
});

test('setup installs dependencies without emptying the target of a linked node_modules', (t) => {
  const f = setupFixture(t);
  const data = path.join(f.tmp, 'plugin data', 'node_modules');
  mkdirSync(path.join(data, 'installed-package'), { recursive: true });
  const link = path.join(f.source, 'bridge-server', 'node_modules');
  symlinkSync(data, link);
  const run = f.run(['--skip-tests'], { FAKE_NPM_EMPTY: '1' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(readFileSync(f.npmLog, 'utf8'), /^ci /m);
  assert.deepEqual(readdirSync(data), ['installed-package']);
  assert.notEqual(lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink(), true);
});

test('partial installation reports completed stages, preserves defaults and succeeds on rerun', (t) => {
  const f = setupFixture(t);
  writeExecutable(path.join(f.bin, 'claude'), '#!/bin/sh\nexit 0\n');
  f.seedSettings({ companion: 'copilot' });
  const args = ['--host', 'both', '--companion', 'codex', '--skip-tests'];
  const failed = f.run(args, { FAKE_CODEX_BAD_MCP: '1' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /Setup incomplete: Codex plugin installation/);
  assert.match(failed.stdout, /Claude: permissions installed/);
  assert.match(failed.stdout, /Codex: plugin installed; MCP and hooks pending verification/);
  assert.match(failed.stdout, /rerun the same command/);
  assert.equal(f.settings().companion, 'copilot');
  const repaired = f.run(args);
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  assert.equal(f.settings().companion, 'codex');
});

test('setup preserves user-owned roles and applies settings only after installation succeeds', async (t) => {
  for (const owned of [false, true]) await t.test(owned ? 'user-owned agent' : 'npm failure', (t) => {
    const f = setupFixture(t);
    f.seedSettings({ companion: 'copilot' });
    const agent = path.join(f.codexHome, 'agents/agent-companion.toml');
    if (owned) {
      mkdirSync(path.dirname(agent), { recursive: true });
      writeFileSync(agent, '# user-owned\n');
    }
    const r = f.run(['--host', 'codex', '--companion', 'codex', '--skip-tests'], owned ? {} : { FAKE_NPM_EXIT: '1' });
    assert.equal(r.status, owned ? 0 : 1, r.stdout + r.stderr);
    assert.match(r.stdout, owned ? /User-owned agent preserved/ : /Setup incomplete: bridge dependencies/);
    assert.equal(f.settings().companion, owned ? 'codex' : 'copilot');
    if (owned) assert.equal(readFileSync(agent, 'utf8'), '# user-owned\n');
    assert.equal(existsSync(installedPluginRoot(f.codexHome)), owned);
  });
});

test('readiness lost after installation is explained without replacing the previous default', (t) => {
  const f = setupFixture(t);
  f.seedSettings({ companion: 'copilot' });
  const r = f.run(['--host', 'codex', '--companion', 'codex', '--skip-tests'], { FAKE_CODEX_AUTH_EXPIRES: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Setup incomplete: companion configuration/);
  assert.match(r.stdout, /Codex CLI has no configured authentication/);
  assert.match(r.stdout, /codex login/);
  assert.equal(f.settings().companion, 'copilot');
});


test('setup accepts independent Claude host and companion selections without a smoke turn', (t) => {
  const f = setupFixture(t);
  const claude = path.join(f.bin, 'claude');
  // The host fixture succeeds without JSON; it cannot establish companion auth.
  writeExecutable(claude, '#!/bin/sh\nexit 0\n');
  const retired = path.join(f.home, '.claude', 'agents', 'agent-companion.md');
  mkdirSync(path.dirname(retired), { recursive: true });
  writeFileSync(retired, '---\n# AUTO-INSTALLED by agent-companion plugin (hooks/install-agent.sh)\n');
  const args = ['--host', 'claude', '--companion', 'claude'];
  const preview = f.run([...args, '--dry-run'], { CLAUDE_BIN: claude });
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /authentication could not be verified/);
  f.assertNoInstall();
  writeExecutable(claude, `#!${process.execPath}
    const args = process.argv.slice(2).join(' ');
    if (args === '--version') console.log('Claude fake');
    else if (args === 'auth status') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));
    else process.exit(99);
  `);
  const result = f.run([...args, '--skip-tests'], { CLAUDE_BIN: claude });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.settings().companion, 'claude');
  assert.equal(existsSync(retired), false);
  assert.equal(existsSync(path.join(f.codexHome, 'agent-companion/default-target')), false);
  assert.match(result.stdout, /Claude: permissions installed; companion: claude/);
});

test('setup rejects model arguments without an explicit companion before preflight', (t) => {
  const f = setupFixture(t);
  for (const args of [[], ['--companion', 'auto'], ['--companion', 'none']]) {
    const r = f.run(['--host', 'codex', ...args, '--model', 'haiku', '--dry-run']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /\[FAIL\].*--model requires.*--companion/);
  }
  for (const args of [['--model'], ['--model='], ['--model', '--dry-run']]) {
    const r = f.run(['--host', 'codex', '--companion', 'claude', ...args]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /--model requires a value/);
  }
  f.assertNoInstall();
});

test('setup passes model to plan and apply, previews intent, and clears a saved model', (t) => {
  const f = setupFixture(t);
  const capture = path.join(f.tmp, 'onboard.jsonl');
  rmSync(path.join(f.bin, 'node'));
  writeExecutable(path.join(f.bin, 'node'), `#!${process.execPath}
    import { appendFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const args = process.argv.slice(2);
    if (args[0]?.endsWith('/onboard.mjs')) appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + '\\n');
    const r = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  `);
  writeExecutable(path.join(f.bin, 'claude'), '#!/bin/sh\nexit 0\n');
  const args = ['--host', 'both', '--companion', 'codex'];
  const legacy = ['claude', 'codex'].map(host => path.join(f.state(host), 'default-target'));
  for (const file of legacy) writeFileSync(file, 'copilot\n');
  const preview = f.run([...args, '--model=gpt-5.4', '--dry-run']);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout.split('Intended installation changes:')[1], /model gpt-5\.4 for codex/);
  assert.equal(existsSync(path.dirname(f.settingsFile)), false);
  for (const file of legacy) assert.equal(readFileSync(file, 'utf8'), 'copilot\n');
  f.assertNoInstall();
  for (const model of ['gpt-5.4', 'inherit']) {
    const result = f.run([...args, '--model', model, '--skip-tests']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const file of legacy) assert.equal(existsSync(file), false);
    assert.equal(f.settings().companion, 'codex');
    assert.equal(f.settings().companions?.codex?.model, model === 'inherit' ? undefined : model);
  }
  const calls = readCalls(capture);
  assert.equal(calls.length, 10);
  assert.equal(calls.filter((args) => args.includes('--plan')).length, 6);
  assert.deepEqual(calls.map((args) => args[args.indexOf('--model') + 1]),
    [...Array(6).fill('gpt-5.4'), ...Array(4).fill('inherit')]);
});

test('setup shell syntax is valid', () => {
  const r = spawnSync('/bin/bash', ['-n', path.join(REPO_ROOT, 'setup.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('OpenCode and all register the checkout plugin and marker; both skips it', t => {
  const f = setupFixture(t);
  writeExecutable(path.join(f.bin, 'claude'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(f.bin, 'opencode'), `#!/bin/sh
if [ "$1 $2" = "plugin add" ] && [ "$3" != --help ]; then
  echo "$3" >> "$HOME/plugin-add"
  echo 'Plugin target must be an npm registry package or Git package specifier' >&2
  exit 1
fi
exit 0
`);
  const conf = path.join(f.home, 'xdg');
  const config = path.join(conf, 'opencode/opencode.jsonc');
  const env = { XDG_CONFIG_HOME: conf };
  const args = ['--companion', 'none', '--skip-tests'];
  for (const extra of [['--host', 'both', '--opencode-idle-timeout=false'],
    ['--host', 'opencode', '--opencode-idle-timeout', 'wrong']]) {
    assert.equal(f.run([...args, ...extra], env).status, 2);
  }
  const preview = f.run([...args, '--host', 'opencode', '--opencode-idle-timeout', '8 hours', '--dry-run'], env);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /Set experimental.location_idle_timeout to 8 hours/);
  assert.match(preview.stdout, /opencode reload/);
  assert.equal(existsSync(config), false);
  // The fake npm does not install packages.
  const packageDir = 'bridge-server/node_modules/jsonc-parser';
  cpSync(path.join(REPO_ROOT, packageDir), path.join(f.source, packageDir), { recursive: true });
  for (const [host, flag] of [['both', []], ['opencode', ['--opencode-idle-timeout=false']], ['all', ['--opencode-idle-timeout', 'default']]]) {
    const r = f.run(['--host', host, ...args, ...flag, '--yes'], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    if (host === 'both') {
      assert.equal(existsSync(path.join(conf, 'opencode')), false);
    } else {
      assert.equal(JSON.parse(readFileSync(config)).experimental.location_idle_timeout, host === 'opencode' ? false : undefined);
      assert.match(r.stdout, /opencode service restart/);
      assert.equal(readFileSync(path.join(conf, 'opencode/agent-companion/.host'), 'utf8'), 'opencode\n');
      assert.deepEqual(readdirSync(path.join(conf, 'opencode/plugins')), ['agent-companion']);
      assert.equal(realpathSync(path.join(conf, 'opencode/plugins/agent-companion')), path.join(f.source, 'opencode-plugin'));
    }
  }
  assert.deepEqual(readFileSync(path.join(f.home, 'plugin-add'), 'utf8').trim().split('\n'), Array(2).fill(path.join(f.source, 'opencode-plugin')));
});
