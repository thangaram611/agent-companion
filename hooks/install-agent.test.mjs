// install-agent.sh / install-agent-codex.sh integration tests via shell-out.
//
// Both agents inherit the session bridge. Claude materialization translates
// the logical server/tool names into the plugin namespace used by the host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

const VARIANTS = [
  {
    name: 'claude',
    script: join(__dirname, 'install-agent.sh'),
    dest: ['.claude', 'agents', 'agent-companion.md'],
    sentinel: 'hooks/install-agent.sh',
  },
  {
    name: 'codex',
    script: join(__dirname, 'install-agent-codex.sh'),
    dest: ['.codex', 'agents', 'agent-companion.toml'],
    sentinel: 'hooks/install-agent-codex.sh',
  },
];

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'install-agent-'));
}

function run(variant, home, extra = {}) {
  return execFileSync('bash', [variant.script], {
    env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT, ...extra },
    encoding: 'utf8',
  });
}

function destPath(variant, home) {
  return join(home, ...variant.dest);
}

// Run Node in place: Homebrew's executable cannot be relocated without its
// dylibs. Mark each wrapper invocation because the resolver canonicalizes both
// candidates to the same process.execPath; the PATH candidate must stay unused.
function nodeWrapper(dir, name) {
  const wrapper = join(dir, name);
  const executable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  writeFileSync(wrapper, `#!/bin/sh\n: > "$0.used"\nexec ${executable} "$@"\n`, { mode: 0o755 });
  return realpathSync(wrapper);
}

for (const variant of VARIANTS) {
  test(`${variant.name}: a no-op rerun leaves the destination's mtime untouched`, () => {
    const home = makeHome();
    try {
      run(variant, home);
      const dest = destPath(variant, home);
      const before = readFileSync(dest);
      // Force a distinguishable mtime if the file were rewritten.
      execFileSync('bash', ['-c', `touch -t 200101010000 "${dest}"`]);
      const stamped = statSync(dest).mtimeMs;

      run(variant, home);
      assert.equal(statSync(dest).mtimeMs, stamped, 'identical content must not be rewritten');
      assert.ok(readFileSync(dest).equals(before), 'content must be unchanged too');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${variant.name}: changed content IS rewritten`, () => {
    const home = makeHome();
    try {
      run(variant, home);
      const dest = destPath(variant, home);
      const good = readFileSync(dest, 'utf8');
      // Keep the sentinel (so the script still considers the file its own) but
      // corrupt the body, as a stale install from an older plugin version would.
      writeFileSync(dest, good.replace(/\n/, '\nstale-drift-marker\n'));
      run(variant, home);
      assert.equal(readFileSync(dest, 'utf8'), good, 'a drifted install must be repaired');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${variant.name}: a user-authored file without the sentinel is left alone`, () => {
    const home = makeHome();
    try {
      const dest = destPath(variant, home);
      mkdirSync(join(home, ...variant.dest.slice(0, -1)), { recursive: true });
      writeFileSync(dest, 'hand written, do not touch\n');
      run(variant, home);
      assert.equal(readFileSync(dest, 'utf8'), 'hand written, do not touch\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${variant.name}: no leftover temp files after a run`, () => {
    const home = makeHome();
    try {
      const tmp = join(home, 'tmpdir');
      mkdirSync(tmp);
      run(variant, home, { TMPDIR: tmp });
      // Covers the success path only — the old two-temp-file rewrite leaked its
      // second mktemp on failure paths this test cannot reach. Kept because the
      // trap arrangement around $TMP is easy to break while refactoring.
      const leftovers = execFileSync('bash', ['-c', `ls -A "${tmp}" | wc -l`], { encoding: 'utf8' }).trim();
      assert.equal(leftovers, '0', 'the rewrite must not leak temp files');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test('Claude materializes the plugin-scoped reference and tools without a second server', () => {
  const home = makeHome();
  try {
    const variant = VARIANTS.find((entry) => entry.name === 'claude');
    run(variant, home);
    const agent = readFileSync(destPath(variant, home), 'utf8');
    assert.match(agent, /^---\n# AUTO-INSTALLED/);
    assert.match(agent, /^mcpServers: \[plugin:agent-companion:agent-bridge\]$/m);
    for (const action of ['catalog', 'send', 'wait', 'status', 'reply', 'cancel']) {
      assert.ok(agent.includes(`mcp__plugin_agent-companion_agent-bridge__agent_${action}`));
    }
    assert.doesNotMatch(agent, /mcp__agent-bridge__|^\s+(?:command|args|timeout|env):/m);
    const script = readFileSync(variant.script, 'utf8');
    assert.ok(!script.includes('node-tools.sh'), 'Node resolution belongs to the session launcher');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex: CODEX_HOME selects the materialized agent directory', () => {
  const home = makeHome();
  try {
    const codex = VARIANTS.find((entry) => entry.name === 'codex');
    const codexHome = join(home, 'custom codex home');
    run(codex, home, { CODEX_HOME: codexHome });
    const installed = join(codexHome, 'agents', 'agent-companion.toml');
    assert.ok(readFileSync(installed, 'utf8').includes(codex.sentinel));
    assert.equal(existsSync(join(home, '.codex', 'agents', 'agent-companion.toml')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the shared node resolver honors AGENT_COMPANION_NODE', () => {
  const home = makeHome();
  try {
    const override = nodeWrapper(home, 'node-override');
    const pathNode = nodeWrapper(home, 'node');
    const out = execFileSync('bash', ['-c', `. "${join(__dirname, 'node-tools.sh')}" && resolve_node`], {
      env: { ...process.env, HOME: home, AGENT_COMPANION_NODE: override, PATH: `${home}:${process.env.PATH}` },
      encoding: 'utf8',
    }).trim();
    assert.equal(out, realpathSync(process.execPath));
    assert.ok(existsSync(`${override}.used`), 'the explicit override must be invoked');
    assert.equal(existsSync(`${pathNode}.used`), false, 'the usable PATH candidate must not be tried');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
