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

    const pluginRoot = path.join(out, 'plugins', 'copilot-companion');
    const markerPath = path.join(out, '.copilot-companion-codex-marketplace');
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const hookPath = path.join(pluginRoot, 'hooks', 'hooks-codex.json');
    const marketplacePath = path.join(out, '.agents', 'plugins', 'marketplace.json');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'copilot-companion');
    assert.ok(existsSync(markerPath));
    assert.equal(manifest.hooks, './hooks/hooks-codex.json');
    assert.equal(manifest.interface.displayName, 'Copilot Companion');
    assert.ok(existsSync(hookPath));

    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    assert.equal(marketplace.name, 'copilot-companion');
    assert.deepEqual(marketplace.plugins[0].source, {
      source: 'local',
      path: './plugins/copilot-companion',
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
