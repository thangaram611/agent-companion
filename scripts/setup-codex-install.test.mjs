import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  '.codex-plugin',
  'assets',
  'bridge-server',
  'hooks',
  'lib',
  'scripts',
  'templates',
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
  mkdirSync(codexHome, { recursive: true });
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
  appendFileSync(
    path.join(installedPath, 'templates', 'agent-companion.toml'),
    '\\n# installed-copy-provenance\\n',
  );
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
        CODEX_RUNTIME_ADAPTER: 'appserver',
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

function runSetup(sourceRoot, home, codexHome, binDir, logPath, extraEnv = {}) {
  return spawnSync('/bin/bash', [
    path.join(sourceRoot, 'setup.sh'),
    '--host', 'codex',
    '--target', 'none',
    '--skip-tests',
  ], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      ...extraEnv,
      HOME: home,
      CODEX_HOME: codexHome,
      FAKE_CODEX_LOG: logPath,
      PATH: [binDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
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
    assert.match(first.stdout, /start a fresh session/);

    const calls = readCalls(logPath);
    const marketplaceRoot = path.join(sourceRoot, 'dist', 'codex-marketplace');
    assert.deepEqual(calls.map((call) => call.args), [
      ['--version'],
      ['plugin', 'marketplace', 'add', '--help'],
      ['plugin', 'add', '--help'],
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
        CODEX_RUNTIME_ADAPTER: 'appserver',
      },
      default_tools_approval_mode: 'approve',
      startup_timeout_sec: 120,
      tool_timeout_sec: 1320,
    });
    assert.ok(existsSync(path.join(pluginRoot, 'hooks', 'launch-agent-bridge.sh')));
    assert.equal(existsSync(path.join(pluginRoot, 'stale-cache-marker')), false);

    const expectedAgent = `${AGENT_SENTINEL}\n${readFileSync(
      path.join(pluginRoot, 'templates', 'agent-companion.toml'),
      'utf8',
    )}`;
    assert.equal(readFileSync(agentPath, 'utf8'), expectedAgent);
    assert.match(expectedAgent, /# installed-copy-provenance/);
    assert.doesNotMatch(
      readFileSync(path.join(sourceRoot, 'templates', 'agent-companion.toml'), 'utf8'),
      /# installed-copy-provenance/,
    );

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
    utimesSync(agentPath, stableTime, stableTime);
    utimesSync(hooksPath, stableTime, stableTime);
    const stableAgentBytes = readFileSync(agentPath);
    const stableHooksBytes = readFileSync(hooksPath);
    writeFileSync(path.join(pluginRoot, 'stale-cache-marker-again'), 'old package again\n');

    const second = runSetup(sourceRoot, home, codexHome, binDir, logPath);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(existsSync(path.join(pluginRoot, 'stale-cache-marker-again')), false);
    assert.deepEqual(readFileSync(agentPath), stableAgentBytes);
    assert.deepEqual(readFileSync(hooksPath), stableHooksBytes);
    assert.equal(statSync(agentPath).mtimeMs, stableTime.getTime());
    assert.equal(statSync(hooksPath).mtimeMs, stableTime.getTime());
    assert.equal(hookBackups(codexHome).length, 1);

    const allCalls = readCalls(logPath);
    assert.equal(allCalls.length, 12);
    assert.deepEqual(
      allCalls.slice(6).map((call) => call.args),
      calls.map((call) => call.args),
      'repeat setup must refresh through the same Codex command sequence',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
      ['plugin', 'marketplace', 'add', path.join(sourceRoot, 'dist', 'codex-marketplace'), '--json'],
      ['plugin', 'add', 'agent-companion@agent-companion', '--json'],
      ['mcp', 'list', '--json'],
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
