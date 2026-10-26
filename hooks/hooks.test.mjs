import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

for (const [host, manifest, rootVar, installer] of [
  ['claude', 'hooks.json', 'CLAUDE_PLUGIN_ROOT', 'install-agent.sh'],
  ['codex', 'hooks-codex.json', 'PLUGIN_ROOT', 'install-agent-codex.sh'],
]) {
  test(`${host} hook commands run the intended scripts from a plugin path containing spaces`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-companion-hooks-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, 'plugin root');
    mkdirSync(join(root, 'hooks'), { recursive: true });
    const scripts = [installer, 'prewarm-target.sh', 'install-deps.sh', 'drain-completions.sh'];
    for (const script of [...scripts, 'name-thread.sh']) {
      writeFileSync(join(root, 'hooks', script),
        `printf '%s\\n' '${script}' "\${AGENT_COMPANION_HOST:-claude}"\n`);
    }
    const hooks = JSON.parse(readFileSync(join(HERE, manifest), 'utf8')).hooks;
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

// Claude Code shows a subagent's agent_id to hooks only, never to the MCP
// server, so the hook is what carries it to the bridge as the thread name.
test('claude names the companion thread after the calling subagent, and leaves main alone', () => {
  const [group, ...rest] = JSON.parse(readFileSync(join(HERE, 'hooks.json'), 'utf8')).hooks.PreToolUse;
  assert.equal(rest.length, 0);
  assert.equal(group.matcher, 'mcp__agent-bridge__agent_send');
  const run = (payload) => spawnSync('/bin/bash', ['-c', group.hooks[0].command], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: dirname(HERE) },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  const call = { hook_event_name: 'PreToolUse', tool_name: group.matcher, tool_input: { task: 'review', cwd: '/repo', thread: 'invented' } };

  const subagent = run({ ...call, agent_id: 'a7aae695fc8e1726b', agent_type: 'agent-companion' });
  assert.equal(subagent.status, 0, subagent.stderr);
  assert.deepEqual(JSON.parse(subagent.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { task: 'review', cwd: '/repo', thread: 'a7aae695fc8e1726b' },
    },
  });

  const main = run(call);
  assert.equal(main.status, 0, main.stderr);
  assert.equal(main.stdout, '');
});
