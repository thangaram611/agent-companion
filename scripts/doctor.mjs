#!/usr/bin/env node
// Environment diagnostics for copilot-companion.

import { execFileSync } from 'node:child_process';

import {
  bridgeLogFile,
  daemonLogFile,
  daemonSocketPath,
  digestDir,
  promptJsonlDir,
  queuePath,
  runtimeDir,
} from '../lib/runtime-paths.mjs';

const asJson = process.argv.includes('--json');

function run(cmd, args = []) {
  try {
    return {
      ok: true,
      output: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    };
  } catch (err) {
    return {
      ok: false,
      output: String(err.stderr || err.message || '').trim(),
    };
  }
}

function commandVersion(cmd, args = ['--version']) {
  const result = run(cmd, args);
  return { found: result.ok, version: result.ok ? result.output.split('\n')[0] : null };
}

function nodeInfo() {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    found: true,
    version: process.version,
    ok: major >= 22,
    required: '>=22',
  };
}

function codexInfo() {
  const version = commandVersion('codex');
  if (!version.found) return { ...version, pluginAdd: false };
  return {
    ...version,
    pluginAdd: run('codex', ['plugin', 'add', '--help']).ok,
    marketplaceAdd: run('codex', ['plugin', 'marketplace', 'add', '--help']).ok,
  };
}

const report = {
  node: nodeInfo(),
  npm: commandVersion('npm', ['--version']),
  jq: commandVersion('jq', ['--version']),
  claude: commandVersion('claude'),
  codex: codexInfo(),
  copilot: commandVersion('copilot'),
  runtime: {
    adapter: process.env.COPILOT_RUNTIME_ADAPTER || 'acp',
    dir: runtimeDir(),
    socket: daemonSocketPath(),
    queue: queuePath(),
    bridgeLog: bridgeLogFile(),
    daemonLog: daemonLogFile(),
    promptJsonlDir: promptJsonlDir(),
    digestDir: digestDir(),
  },
};

report.ok = Boolean(
  report.node.ok &&
  report.npm.found &&
  report.jq.found &&
  report.copilot.found &&
  (report.claude.found || report.codex.found)
);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`copilot-companion doctor: ${report.ok ? 'ok' : 'needs attention'}`);
  console.log(`node:    ${report.node.version} (${report.node.ok ? 'ok' : `requires ${report.node.required}`})`);
  console.log(`npm:     ${report.npm.version || 'missing'}`);
  console.log(`jq:      ${report.jq.version || 'missing'}`);
  console.log(`claude:  ${report.claude.version || 'missing'}`);
  console.log(`codex:   ${report.codex.version || 'missing'}${report.codex.found ? ` (plugin add: ${report.codex.pluginAdd ? 'ok' : 'missing'})` : ''}`);
  console.log(`copilot: ${report.copilot.version || 'missing'}`);
  console.log(`runtime: ${report.runtime.dir} (adapter: ${report.runtime.adapter})`);
}

process.exit(report.ok ? 0 : 1);
