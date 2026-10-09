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
    for (const script of scripts) {
      writeFileSync(join(root, 'hooks', script),
        `printf '%s\\n' '${script}' "\${AGENT_COMPANION_HOST:-claude}"\n`);
    }
    const hooks = JSON.parse(readFileSync(join(HERE, manifest), 'utf8')).hooks;
    const expected = {
      PostToolUse: ['drain-completions.sh'],
      SessionStart: scripts,
      UserPromptSubmit: ['drain-completions.sh'],
    };
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
