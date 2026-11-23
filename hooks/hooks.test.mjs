import '../test/sandbox-home.mjs';
import { tools } from '../bridge-server/tools.mjs';
import { HOSTS } from '../lib/hosts/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

for (const [host, manifest, rootVar] of [
  ['claude', 'hooks.json', 'CLAUDE_PLUGIN_ROOT'],
  ['codex', 'hooks-codex.json', 'PLUGIN_ROOT'],
]) {
  test(`${host} hook commands run the intended scripts from a plugin path containing spaces`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-companion-hooks-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, 'plugin root');
    mkdirSync(join(root, 'hooks'), { recursive: true });
    const scripts = [ 'install-deps.sh', 'drain-completions.sh'];
    for (const script of [...scripts, 'name-thread.sh']) {
      writeFileSync(join(root, 'hooks', script),
        `printf '%s\\n' '${script}' "\${AGENT_COMPANION_HOST:-claude}"\n`);
    }
    const hooks = JSON.parse(readFileSync(join(HERE, manifest), 'utf8')).hooks;
    if (host === 'claude') assert.deepEqual(hooks.PreToolUse.flatMap(g => g.hooks.map(h => h.onFailure)), ['block']);
    else for (const group of Object.values(hooks).flat()) assert.ok(group.hooks.every(h => !Object.hasOwn(h, 'onFailure')));
    const expected = {
      PostToolUse: ['drain-completions.sh'],
      SessionStart: scripts,
      UserPromptSubmit: ['drain-completions.sh'],
      // Codex names the thread itself, in MCP _meta.
      ...(host === 'claude' ? { PreToolUse: ['name-thread.sh'] } : {}),
    };
    assert.deepEqual(Object.keys(hooks).sort(), Object.keys(expected).sort());
    for (const [event, names] of Object.entries(expected)) {
      const commands = hooks[event].flatMap((group) => group.hooks);
      assert.equal(commands.length, names.length, event);
      for (const [index, hook] of commands.entries()) {
        const result = spawnSync('/bin/bash', ['-c', hook.command], {
          env: { ...process.env, [rootVar]: root, AGENT_COMPANION_HOST: 'claude' },
          encoding: 'utf8',
          timeout: 5_000,
          killSignal: 'SIGKILL',
        });
        assert.equal(result.status, 0, `${event}: ${result.stderr || result.error}`);
        assert.equal(result.stdout, `${names[index]}\n${host}\n`, event);
      }
    }
  });
}

test('Claude stamps the host lead on every protected tool and preserves the requested thread', () => {
  const [group] = JSON.parse(readFileSync(join(HERE, 'hooks.json'), 'utf8')).hooks.PreToolUse;
  const matcher = new RegExp(group.matcher);
  for (const prefix of ['mcp__agent-bridge__', HOSTS.claude.toolPrefix]) {
    for (const { name, action } of tools) assert.equal(matcher.test(prefix + name), action !== 'catalog');
    assert.ok(!matcher.test(prefix + 'agent_send_extra'));
  }
  const run = (payload) => spawnSync('/bin/bash', ['-c', group.hooks[0].command], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: dirname(HERE) },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  for (const agent of [null, 'native-child']) {
    const input = { thread: 'th-123', task: 'review', lead: { session: 'invented' } };
    const result = run({ session_id: 'native-session', agent_id: agent ?? undefined, tool_input: input });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).hookSpecificOutput.updatedInput,
      { ...input, lead: { session: 'native-session', agent } });
  }
});

test('claude blocks owner calls if Node cannot run the identity rewrite', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ac-no-node-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'hooks'));
  writeFileSync(join(root, 'hooks/node-tools.sh'), 'resolve_node() { return 1; }\n');
  const result = spawnSync('/bin/bash', [join(HERE, 'name-thread.sh')], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, input: '{"tool_input":{"thread":"forged"}}', encoding: 'utf8',
  });
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
