#!/usr/bin/env node
// End-to-end release validation for the Codex marketplace package.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);
const PLUGIN_NAME = 'agent-companion';
const BUILD_SCRIPT = path.join(HERE, 'build-codex-marketplace.mjs');

const args = process.argv.slice(2);

let keep = false;
let codexBin = 'codex';
let outArg = null;
let retainedReason = null;
let tmpRoot = null;

function hasFlag(name) {
  return args.includes(name);
}

function readOption(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function run(command, commandArgs, { env = process.env, cwd = REPO_ROOT } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error || result.status !== 0) {
    const reason = result.error?.message || result.stderr || result.stdout || `exit ${result.status}`;
    throw new Error(`${command} ${commandArgs.join(' ')} failed: ${String(reason).trim()}`);
  }

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function parseJson(step, stdout) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`${step} did not return JSON: ${stdout || err.message}`);
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertInside(parent, child, label) {
  const rel = path.relative(parent, child);
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `${label} is outside ${parent}: ${child}`);
}

function assertExists(file, label = file) {
  assert(existsSync(file), `missing ${label}: ${file}`);
}

function assertMissing(file, label = file) {
  assert(!existsSync(file), `unexpected ${label}: ${file}`);
}

function validateMarketplaceTree(marketplaceRoot) {
  const pluginRoot = path.join(marketplaceRoot, 'plugins', PLUGIN_NAME);
  const marketplace = readJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'));
  const manifest = readJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));

  assert(marketplace.name === PLUGIN_NAME, 'marketplace name mismatch');
  assert(marketplace.plugins?.[0]?.name === PLUGIN_NAME, 'marketplace plugin entry mismatch');
  assert(marketplace.plugins?.[0]?.source?.path === `./plugins/${PLUGIN_NAME}`, 'marketplace source path mismatch');
  assert(manifest.name === PLUGIN_NAME, 'plugin manifest name mismatch');
  assert(manifest.hooks === './hooks/hooks-codex.json', 'plugin manifest hooks path mismatch');
  assertExists(path.join(pluginRoot, 'hooks', 'hooks-codex.json'), 'Codex hook manifest');
  assertExists(path.join(pluginRoot, 'templates', 'agent-companion.toml'), 'Codex agent template');
  assertExists(path.join(pluginRoot, 'bridge-server', 'server.mjs'), 'bridge server');
  assertMissing(path.join(pluginRoot, 'scripts', 'build-codex-marketplace.test.mjs'), 'test file in release package');
  assertMissing(path.join(pluginRoot, 'scripts', 'validate-codex-release.test.mjs'), 'validator test file in release package');
  assertMissing(path.join(pluginRoot, '.plugin-data'), 'plugin data directory in release package');
  assertMissing(path.join(pluginRoot, 'dist'), 'nested dist directory in release package');
}

function validateInstalledTree(codexHome, installedPath) {
  assertExists(installedPath, 'installed plugin root');
  const resolvedCodexHome = realpathSync(codexHome);
  const resolvedInstalledPath = realpathSync(installedPath);
  assertInside(resolvedCodexHome, resolvedInstalledPath, 'installed plugin path');

  const manifest = readJson(path.join(resolvedInstalledPath, '.codex-plugin', 'plugin.json'));
  assert(manifest.name === PLUGIN_NAME, 'installed plugin manifest name mismatch');
  assert(manifest.hooks === './hooks/hooks-codex.json', 'installed plugin manifest hooks path mismatch');
  assertExists(path.join(resolvedInstalledPath, 'hooks', 'hooks-codex.json'), 'installed Codex hook manifest');
  assertExists(path.join(resolvedInstalledPath, 'templates', 'agent-companion.toml'), 'installed Codex agent template');
  assertExists(path.join(resolvedInstalledPath, 'bridge-server', 'server.mjs'), 'installed bridge server');
  assertMissing(path.join(resolvedInstalledPath, 'scripts', 'validate-codex-release.test.mjs'), 'test file in installed package');
}

function main() {
  keep = hasFlag('--keep');
  codexBin = readOption('--codex-bin') || process.env.CODEX_BIN || 'codex';
  outArg = readOption('--out');

  tmpRoot = mkdtempSync(path.join(tmpdir(), 'agent-companion-release-'));
  const marketplaceRoot = outArg ? path.resolve(REPO_ROOT, outArg) : path.join(tmpRoot, 'codex-marketplace');
  const codexHome = path.join(tmpRoot, 'codex-home');
  const isolatedHome = path.join(tmpRoot, 'home');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  const codexEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    HOME: isolatedHome,
  };

  run(codexBin, ['plugin', 'marketplace', 'add', '--help'], { env: codexEnv });
  run(codexBin, ['plugin', 'add', '--help'], { env: codexEnv });

  run(process.execPath, [BUILD_SCRIPT, '--out', marketplaceRoot]);
  validateMarketplaceTree(marketplaceRoot);

  const addMarketplace = parseJson(
    'codex plugin marketplace add',
    run(codexBin, ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], { env: codexEnv }).stdout,
  );
  assert(addMarketplace.marketplaceName === PLUGIN_NAME, 'unexpected marketplace name from codex marketplace add');

  const addPlugin = parseJson(
    'codex plugin add',
    run(codexBin, ['plugin', 'add', `${PLUGIN_NAME}@${PLUGIN_NAME}`, '--json'], { env: codexEnv }).stdout,
  );
  assert(addPlugin.pluginId === `${PLUGIN_NAME}@${PLUGIN_NAME}`, 'unexpected installed plugin id');
  assert(addPlugin.name === PLUGIN_NAME, 'unexpected installed plugin name');
  assert(addPlugin.marketplaceName === PLUGIN_NAME, 'unexpected installed marketplace name');
  assert(addPlugin.installedPath, 'codex plugin add did not report installedPath');
  validateInstalledTree(codexHome, addPlugin.installedPath);

  console.log('[OK] Codex marketplace release validated');
  console.log(`Marketplace: ${marketplaceRoot}`);
  console.log(`CODEX_HOME: ${codexHome}`);
  console.log(`Installed: ${addPlugin.installedPath}`);
}

try {
  main();
} catch (err) {
  retainedReason = 'failure';
  console.error(`[FAIL] ${err.message}`);
  process.exitCode = 1;
} finally {
  if (tmpRoot && !keep && !retainedReason) {
    rmSync(tmpRoot, { recursive: true, force: true });
    console.log('[OK] Temporary install workspace removed; pass --keep to inspect it');
  } else if (tmpRoot && (keep || retainedReason)) {
    console.error(`[INFO] retained temp dir: ${tmpRoot}`);
  }
}
