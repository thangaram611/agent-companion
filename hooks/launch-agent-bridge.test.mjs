// Codex MCP launcher integration tests. The SessionStart dependency hook is
// allowed to exit 0 after a bounded lock wait, so launcher success must depend
// on observable dependency readiness rather than that exit code alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(HERE, 'launch-agent-bridge.sh');

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-bridge-launcher-'));
  const root = path.join(dir, 'plugin root');
  const hooks = path.join(root, 'hooks');
  const bridge = path.join(root, 'bridge-server');
  const calls = path.join(dir, 'install-calls');
  const fakeNode = path.join(dir, 'node');
  mkdirSync(hooks, { recursive: true });
  mkdirSync(bridge, { recursive: true });
  copyFileSync(LAUNCHER, path.join(hooks, 'launch-agent-bridge.sh'));
  for (const file of ['launch-agent-bridge.mjs', 'resolve-codex-deps.mjs']) {
    copyFileSync(path.join(HERE, file), path.join(hooks, file));
  }
  chmodSync(path.join(hooks, 'launch-agent-bridge.sh'), 0o755);
  writeFileSync(path.join(bridge, 'server.mjs'), '// fake server\n');
  writeFileSync(path.join(hooks, 'node-tools.sh'), `
resolve_node() { printf '%s\\n' "$FAKE_NODE"; }
`);
  writeFileSync(path.join(hooks, 'install-deps.sh'), `#!/bin/bash
count=0
if [ -f "$TEST_CALLS" ]; then IFS= read -r count < "$TEST_CALLS"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$TEST_CALLS"
printf 'dependency attempt %s\\n' "$count"
if [ "\${READY_ON_ATTEMPT:-0}" -gt 0 ]; then
  mkdir -p "$PLUGIN_DATA/bridge-server/node_modules/@modelcontextprotocol/sdk"
  printf '{}\\n' > "$PLUGIN_DATA/bridge-server/node_modules/@modelcontextprotocol/sdk/package.json"
fi
if [ "\${READY_ON_ATTEMPT:-0}" -le 0 ] || [ "$count" -lt "$READY_ON_ATTEMPT" ]; then
  exit 75
fi
exit 0
`);
  chmodSync(path.join(hooks, 'install-deps.sh'), 0o755);
  writeFileSync(fakeNode, `#!/bin/bash
printf 'node exec: %s\\n' "$@"
`);
  chmodSync(fakeNode, 0o755);
  return { dir, root, calls, fakeNode, launcher: path.join(hooks, 'launch-agent-bridge.sh') };
}

function run(fixture, readyOnAttempt) {
  return spawnSync('/bin/bash', [fixture.launcher], {
    env: {
      ...process.env,
      CODEX_HOME: path.join(fixture.dir, 'codex home'),
      FAKE_NODE: fixture.fakeNode,
      TEST_CALLS: fixture.calls,
      READY_ON_ATTEMPT: String(readyOnAttempt),
    },
    encoding: 'utf8',
  });
}

test('ignores an early SDK file until the contended install reports complete', () => {
  const fixture = makeFixture();
  try {
    const result = run(fixture, 2);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fixture.calls, 'utf8').trim(), '2');
    assert.match(result.stdout, /node exec: --import\nnode exec: .*hooks\/launch-agent-bridge\.mjs\nnode exec: .*bridge-server\/server\.mjs/);
    assert.doesNotMatch(result.stdout, /dependency attempt/,
      'dependency chatter must never corrupt MCP stdout');
    assert.match(result.stderr, /dependency attempt 1/);
    assert.match(result.stderr, /dependency attempt 2/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('loads static and dynamic SDK imports from plugin data with ESM conditions and source-relative imports intact', () => {
  const fixture = makeFixture();
  try {
    fixture.fakeNode = process.execPath;
    const data = path.join(fixture.dir, 'codex home', 'plugins/data/agent-companion-agent-companion');
    const sdk = path.join(data, 'bridge-server/node_modules/@test/sdk');
    mkdirSync(sdk, { recursive: true });
    writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({
      name: '@test/sdk', type: 'module', exports: { import: './index.mjs', require: './wrong.cjs' },
    }));
    writeFileSync(path.join(sdk, 'index.mjs'), 'export const value = "SDK";');
    writeFileSync(path.join(fixture.root, 'bridge-server/local.mjs'), 'export const local = "local";');
    writeFileSync(path.join(fixture.root, 'bridge-server/server.mjs'), `
import { value } from '@test/sdk';
import { local } from './local.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
// server.mjs starts MCP only when it is the entry point, not when imported.
assert.equal(process.argv[1], fileURLToPath(import.meta.url));
assert.equal((await import('@test/sdk')).value, value);
console.log(value, local);
`);
    const result = run(fixture, 1);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'SDK local\n');
    assert.equal(existsSync(path.join(fixture.root, 'bridge-server/node_modules')), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('fails honestly without starting Node when dependencies remain unavailable', () => {
  const fixture = makeFixture();
  try {
    const result = run(fixture, 0);
    assert.equal(result.status, 1);
    assert.equal(readFileSync(fixture.calls, 'utf8').trim(), '2');
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /dependencies are not ready after two bounded install attempts/);
    assert.equal(existsSync(path.join(
      fixture.root,
      'bridge-server/node_modules/@modelcontextprotocol/sdk/package.json',
    )), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
