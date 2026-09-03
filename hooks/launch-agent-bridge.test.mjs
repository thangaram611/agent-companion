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
  mkdir -p "$CLAUDE_PLUGIN_ROOT/bridge-server/node_modules/@modelcontextprotocol/sdk"
  printf '{}\\n' > "$CLAUDE_PLUGIN_ROOT/bridge-server/node_modules/@modelcontextprotocol/sdk/package.json"
fi
if [ "\${READY_ON_ATTEMPT:-0}" -le 0 ] || [ "$count" -lt "$READY_ON_ATTEMPT" ]; then
  exit 75
fi
exit 0
`);
  chmodSync(path.join(hooks, 'install-deps.sh'), 0o755);
  writeFileSync(fakeNode, `#!/bin/bash
printf 'node exec: %s\\n' "$1"
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
    assert.match(result.stdout, /node exec: .*bridge-server\/server\.mjs/);
    assert.doesNotMatch(result.stdout, /dependency attempt/,
      'dependency chatter must never corrupt MCP stdout');
    assert.match(result.stderr, /dependency attempt 1/);
    assert.match(result.stderr, /dependency attempt 2/);
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
