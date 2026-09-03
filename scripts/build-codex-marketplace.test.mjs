import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);
const SCRIPT = path.join(HERE, 'build-codex-marketplace.mjs');

test('builds a Codex marketplace root with a nested plugin package', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'codex-marketplace-build-'));
  const out = path.join(tmp, 'marketplace');
  try {
    const result = spawnSync(process.execPath, [SCRIPT, '--out', out], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const pluginRoot = path.join(out, 'plugins', 'agent-companion');
    const markerPath = path.join(out, '.agent-companion-codex-marketplace');
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const heroPath = path.join(pluginRoot, 'assets', 'readme', 'hero.png');
    const architecturePath = path.join(pluginRoot, 'assets', 'readme', 'architecture.png');
    const targetMatrixPath = path.join(pluginRoot, 'assets', 'readme', 'target-matrix.png');
    const hookPath = path.join(pluginRoot, 'hooks', 'hooks-codex.json');
    const bridgeLauncherPath = path.join(pluginRoot, 'hooks', 'launch-agent-bridge.sh');
    const marketplacePath = path.join(out, '.agents', 'plugins', 'marketplace.json');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'agent-companion');
    assert.ok(existsSync(markerPath));
    assert.equal(manifest.hooks, './hooks/hooks-codex.json');
    assert.deepEqual(manifest.mcpServers?.['agent-bridge'], {
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
    assert.equal(manifest.interface.displayName, 'Agent Companion');
    assert.ok(existsSync(heroPath));
    assert.ok(existsSync(architecturePath));
    assert.ok(existsSync(targetMatrixPath));
    assert.ok(existsSync(hookPath));
    assert.ok(existsSync(bridgeLauncherPath));
    assert.equal(existsSync(path.join(pluginRoot, '.mcp.json')), false,
      'Codex MCP registration must stay in the Codex-only manifest so Claude does not load it twice');

    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    assert.equal(marketplace.name, 'agent-companion');
    assert.equal(marketplace.interface.displayName, 'Agent Companion');
    assert.deepEqual(marketplace.plugins[0].source, {
      source: 'local',
      path: './plugins/agent-companion',
    });
    assert.deepEqual(marketplace.plugins[0].policy, {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    });

    assert.equal(
      existsSync(path.join(pluginRoot, 'scripts', 'build-codex-marketplace.test.mjs')),
      false,
      'release package should not include test files',
    );
    assert.equal(
      existsSync(path.join(pluginRoot, 'scripts', 'validate-codex-release.test.mjs')),
      false,
      'release package should not include validator tests',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('documents the generated marketplace as an explicit local path', () => {
  const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /codex plugin marketplace add \.\/dist\/codex-marketplace/);
  assert.doesNotMatch(readme, /codex plugin marketplace add dist\/codex-marketplace/);
});
