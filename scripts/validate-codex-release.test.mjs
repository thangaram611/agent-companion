import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);
const SCRIPT = path.join(HERE, 'validate-codex-release.mjs');

function writeFakeCodex(dir, logPath) {
  const fakeCodex = path.join(dir, 'codex');
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const logPath = ${JSON.stringify(logPath)};
const codexHome = process.env.CODEX_HOME || '';
appendFileSync(logPath, JSON.stringify({ args, codexHome, home: process.env.HOME || '' }) + '\\n');

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\\n');
}

function fail(message) {
  process.stderr.write(message + '\\n');
  process.exit(2);
}

if (args.join(' ') === 'plugin marketplace add --help' || args.join(' ') === 'plugin add --help') {
  process.stdout.write('fake help\\n');
  process.exit(0);
}

if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  const source = args[3];
  if (!source || !existsSync(path.join(source, '.agents', 'plugins', 'marketplace.json'))) {
    fail('missing marketplace root');
  }
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(path.join(codexHome, 'fake-marketplace-source'), source);
  writeFileSync(path.join(codexHome, 'config.toml'), '# fake codex config\\n');
  printJson({ marketplaceName: 'agent-companion', installedRoot: source, alreadyAdded: false });
  process.exit(0);
}

if (args[0] === 'plugin' && args[1] === 'add') {
  if (args[2] !== 'agent-companion@agent-companion') fail('unexpected plugin selector');
  const source = readFileSync(path.join(codexHome, 'fake-marketplace-source'), 'utf8');
  const manifest = JSON.parse(readFileSync(path.join(source, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  const relPluginPath = manifest.plugins[0].source.path.replace(/^\\.\\//, '');
  const pluginRoot = path.join(source, relPluginPath);
  const installedPath = path.join(codexHome, 'plugins', 'cache', 'agent-companion', 'agent-companion', '0.0.1');
  mkdirSync(path.dirname(installedPath), { recursive: true });
  cpSync(pluginRoot, installedPath, { recursive: true });
  printJson({
    pluginId: 'agent-companion@agent-companion',
    name: 'agent-companion',
    marketplaceName: 'agent-companion',
    version: '0.0.1',
    installedPath,
    authPolicy: 'ON_INSTALL'
  });
  process.exit(0);
}

fail('unexpected fake codex invocation: ' + args.join(' '));
`);
  chmodSync(fakeCodex, 0o755);
  return fakeCodex;
}

test('validates Codex release package through an isolated marketplace install', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'codex-release-validator-test-'));
  const logPath = path.join(tmp, 'fake-codex.log');
  const out = path.join(tmp, 'marketplace');
  try {
    const fakeCodex = writeFakeCodex(tmp, logPath);
    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--codex-bin', fakeCodex,
      '--out', out,
      '--keep',
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Codex marketplace release validated/);
    assert.ok(existsSync(path.join(out, '.agents', 'plugins', 'marketplace.json')));

    const calls = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((call) => call.args), [
      ['plugin', 'marketplace', 'add', '--help'],
      ['plugin', 'add', '--help'],
      ['plugin', 'marketplace', 'add', out, '--json'],
      ['plugin', 'add', 'agent-companion@agent-companion', '--json'],
    ]);

    const codexHomes = new Set(calls.map((call) => call.codexHome));
    assert.equal(codexHomes.size, 1, 'all codex calls must share one isolated CODEX_HOME');
    assert.ok(calls[0].codexHome, 'validator must set CODEX_HOME');
    for (const call of calls) assert.notEqual(call.home, process.env.HOME);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
