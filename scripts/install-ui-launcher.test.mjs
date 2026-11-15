import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts/install-ui-launcher.mjs');
function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ui-launcher-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const env = { HOME: dir, AGENT_COMPANION_HOME: path.join(dir, 'state'), AGENT_RUNTIME_DIR: path.join(dir, 'runtime') };
  const install = (extra = [], PATH = '/usr/bin:/bin') => spawnSync(process.execPath, [SCRIPT, '--bin-dir', bin, ...extra], { env: { ...env, PATH }, encoding: 'utf8' });
  return { dir, bin, env, launcher: path.join(bin, 'agent-companion'), install };
}

test('installs once, then reports unchanged; says how to reach it when its directory is not on PATH', t => {
  const s = setup(t);
  let result = s.install(['--dry-run']);
  assert.match(result.stdout, /would be installed/);
  assert.equal(existsSync(s.launcher), false);
  result = s.install();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[OK\] {3}UI launcher installed: .*agent-companion \(runs .*hooks\/launch-ui\.sh\)/);
  assert.match(result.stdout, /is not on PATH\. Add it in your shell profile \(for zsh, ~\/\.zprofile\): export PATH=".*bin:\$PATH"/);
  assert.equal(statSync(s.launcher).mode & 0o777, 0o755);
  const body = readFileSync(s.launcher, 'utf8');
  assert.match(body, /^#!\/bin\/bash\n# AUTO-INSTALLED by agent-companion/);
  assert.ok(body.includes(`exec /bin/bash '${path.join(ROOT, 'hooks/launch-ui.sh')}' "$@"`));
  result = s.install([], `/usr/bin:${s.bin}`);
  assert.match(result.stdout, /UI launcher unchanged/);
  assert.doesNotMatch(result.stdout, /not on PATH/);
});

test('rewrites its own launcher when the checkout moved, and preserves a file it did not write', t => {
  const s = setup(t);
  mkdirSync(s.bin, { recursive: true });
  writeFileSync(s.launcher, "#!/bin/bash\n# AUTO-INSTALLED by agent-companion (scripts/install-ui-launcher.mjs); setup.sh rewrites it\nexec /bin/bash '/old/checkout/hooks/launch-ui.sh' \"$@\"\n");
  assert.match(s.install().stdout, /UI launcher updated/);
  writeFileSync(s.launcher, '#!/bin/sh\necho mine\n');
  const result = s.install();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[WARN\] .*agent-companion exists and was not written by agent-companion; left unchanged/);
  assert.equal(readFileSync(s.launcher, 'utf8'), '#!/bin/sh\necho mine\n');
});

test('the installed launcher runs the UI entry point', t => {
  const s = setup(t);
  s.install();
  const result = spawnSync(s.launcher, ['--help'], { env: { ...process.env, ...s.env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^usage: agent-companion ui/);
  const bad = spawnSync(s.launcher, ['nope'], { env: { ...process.env, ...s.env }, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
