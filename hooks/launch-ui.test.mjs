// The UI launch script finds Node through the shared resolver and the UI's
// packages where the plugin root keeps them; it never installs anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'launch-ui-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'plugin root');
  mkdirSync(path.join(root, 'hooks'), { recursive: true });
  mkdirSync(path.join(root, 'bridge-server/ui'), { recursive: true });
  for (const file of ['launch-ui.sh', 'launch-agent-bridge.mjs', 'resolve-codex-deps.mjs']) copyFileSync(path.join(HERE, file), path.join(root, 'hooks', file));
  writeFileSync(path.join(root, 'hooks/node-tools.sh'), `resolve_node() { [ -n "$FAKE_NODE" ] && printf '%s\\n' "$FAKE_NODE"; }
node_requirement_error() { echo 'agent-companion: Node.js 26 or newer is required.' >&2; }
`);
  writeFileSync(path.join(root, 'bridge-server/ui/app.mjs'), `import ink from 'ink';\nconsole.log(ink, process.argv.slice(2).join(' '));\n`);
  const pkg = (dir, name) => {
    mkdirSync(path.join(dir, 'ink'), { recursive: true });
    writeFileSync(path.join(dir, 'ink/package.json'), JSON.stringify({ name: 'ink', type: 'module', exports: './index.mjs' }));
    writeFileSync(path.join(dir, 'ink/index.mjs'), `export default ${JSON.stringify(name)};`);
  };
  const run = (env = {}, args = ['ui']) => spawnSync('/bin/bash', [path.join(root, 'hooks/launch-ui.sh'), ...args], {
    env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: path.join(dir, 'codex home'), FAKE_NODE: process.execPath, ...env }, encoding: 'utf8' });
  return { dir, root, pkg, run };
}

test('a source checkout runs the UI with its own bridge-server/node_modules', t => {
  const f = fixture(t);
  f.pkg(path.join(f.root, 'bridge-server/node_modules'), 'LOCAL-INK');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'LOCAL-INK ui\n');
});

test('a Codex plugin bundle without node_modules resolves the UI packages from plugin data', t => {
  const f = fixture(t);
  f.pkg(path.join(f.dir, 'codex home/plugins/data/agent-companion-agent-companion/bridge-server/node_modules'), 'DATA-INK');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'DATA-INK ui\n');
});

test('missing dependencies or Node fail with what to do, without starting the UI', t => {
  const f = fixture(t);
  let result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /dependencies \(ink, react\) are not installed .*Start a Claude Code or Codex session .*or rerun setup\.sh/);
  f.pkg(path.join(f.root, 'bridge-server/node_modules'), 'LOCAL-INK');
  result = f.run({ FAKE_NODE: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node\.js 26 or newer is required/);
});

test('follow, for the Claude pane, runs without the UI packages', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'bridge-server/ui/follow.mjs'), `console.log('follow', process.argv.slice(2).join(' '));\n`);
  const result = f.run({}, ['follow', '/state', 'job-1']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'follow /state job-1\n');
});

test('jobs, for the Claude pane, runs without the UI packages', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'bridge-server/ui/jobs.mjs'), `console.log('jobs', process.argv.slice(2).join(' '));\n`);
  const result = f.run({}, ['jobs', '/state', 'session-1', '9']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'jobs /state session-1 9\n');
});

test('defaults forwards the companion, edits and --json without UI packages on either host', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'bridge-server/ui/defaults.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  for (const host of ['claude', 'codex']) {
    const args = ['codex', 'model=inherit', '--json'];
    const result = f.run({ AGENT_COMPANION_HOST: host }, ['defaults', ...args]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  }
});
