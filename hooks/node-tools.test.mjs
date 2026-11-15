import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'node-floor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Run the resolver's actual -e program against a synthetic process version.
function fakeNode(dir, name, version) {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/bash
if [ "$1" = --version ]; then printf '%s\\n' v${version}; exit 0; fi
exec ${quote(process.execPath)} -e 'Object.defineProperty(process.versions, "node", {value: process.argv[1]}); Object.defineProperty(process, "execPath", {value: process.argv[2]}); eval(process.argv[3]);' ${quote(version)} "$0" "$2"
`, { mode: 0o755 });
  return bin;
}

for (const version of ['24.22.3', '26.13.0']) {
  test(`resolver validates and selects Node ${version}`, (t) => {
    const dir = fixture(t);
    const override = fakeNode(dir, 'override', version);
    const fallback = fakeNode(dir, 'node', '26.13.0');
    const options = { env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, AGENT_COMPANION_NODE: override }, encoding: 'utf8', timeout: 10_000 };
    const validate = spawnSync('/bin/bash', ['-c', `. "$1"; _cc_validate_node "$AGENT_COMPANION_NODE"`, 'test', join(HERE, 'node-tools.sh')], options);
    assert.equal(validate.status, version.startsWith('24.') ? 1 : 0, validate.stderr);
    const resolved = spawnSync('/bin/bash', ['-c', '. "$1"; resolve_node', 'test', join(HERE, 'node-tools.sh')], options);
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout.trim(), version.startsWith('24.') ? fallback : override);
  });
}

for (const script of ['install-deps.sh', 'launch-agent-bridge.sh']) {
  for (const knownVersion of [true, false]) {
    test(`${script} refuses exhausted resolution (${knownVersion ? 'known' : 'unknown'} version) before npm`, (t) => {
      const dir = fixture(t);
      const root = join(dir, 'plugin root');
      const hooks = join(root, 'hooks');
      mkdirSync(hooks, { recursive: true });
      mkdirSync(join(root, 'bridge-server/node_modules/@modelcontextprotocol/sdk'), { recursive: true });
      writeFileSync(join(root, 'bridge-server/package.json'), '{"name":"fixture","version":"1.0.0"}');
      writeFileSync(join(root, 'bridge-server/node_modules/@modelcontextprotocol/sdk/package.json'), '{}');
      copyFileSync(join(HERE, script), join(hooks, script));
      // Existing launcher fixture seam: preserve real helpers, substitute only
      // exhausted resolution, so machine-wide Homebrew cannot satisfy it.
      writeFileSync(join(hooks, 'node-tools.sh'), readFileSync(join(HERE, 'node-tools.sh'), 'utf8') + '\nresolve_node() { return 1; }\n');
      if (script === 'launch-agent-bridge.sh') {
        writeFileSync(join(hooks, 'install-deps.sh'), '#!/bin/bash\nexit 0\n');
      }
      const node = fakeNode(dir, 'node', '24.22.3');
      if (!knownVersion) writeFileSync(node, '#!/bin/bash\nexit 1\n');
      const marker = join(dir, 'npm-called');
      const npm = join(dir, 'npm');
      writeFileSync(npm, `#!/bin/bash\ntouch ${quote(marker)}\nexit 1\n`, { mode: 0o755 });
      const result = spawnSync('/bin/bash', [join(hooks, script)], {
        env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, CLAUDE_PLUGIN_ROOT: root,
          AGENT_COMPANION_HOST: 'claude', AGENT_COMPANION_NODE: node, AGENT_COMPANION_NPM: npm },
        encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(existsSync(marker), false, 'npm must never run without a qualifying Node');
      assert.equal(result.stdout, '');
      const found = knownVersion ? ' (found v24.22.3)' : '';
      assert.equal(result.stderr.trim(), `agent-companion: Node.js 26 or newer is required${found}. Upgrade with \`brew upgrade node\`, or install the current LTS from https://nodejs.org.`);
    });
  }
}
