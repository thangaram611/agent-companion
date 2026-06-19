// Tests for scripts/install-codex-hooks.mjs.
//
// We invoke the script as a subprocess (vs. importing) for two reasons:
//   1. It calls process.exit() on confirmation paths, which would tear
//      down the test runner.
//   2. HOME-rooted path resolution at module load is what we want to
//      exercise — running as a child gives a clean env.
//
// All tests run against a tmp HOME so the user's real ~/.codex/hooks.json
// is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'install-codex-hooks.mjs');
const PLUGIN_ROOT = dirname(HERE); // repo root

function runScript(home, extraArgs = [], extraEnv = {}) {
  const args = [SCRIPT, '--plugin-root', PLUGIN_ROOT, '--yes', ...extraArgs];
  const r = spawnSync(process.execPath, args, {
    env: { ...process.env, ...extraEnv, HOME: home },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readHooks(home) {
  return JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'codex-hooks-test-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function managedEntries(cfg, event) {
  return (cfg.hooks[event] || []).filter((e) => e._managed_by === 'agent-companion');
}

test('CLI validation rejects missing/relative plugin roots and malformed existing config without overwrite', () => {
  withHome((home) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--yes'], {
      env: { ...process.env, HOME: home }, encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--plugin-root/);

    const rel = spawnSync(process.execPath, [SCRIPT, '--plugin-root', 'rel/path', '--yes'], {
      env: { ...process.env, HOME: home }, encoding: 'utf8',
    });
    assert.equal(rel.status, 2);
    assert.match(rel.stderr, /must be absolute/);

    const f = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '{ this is not json');
    const malformed = runScript(home);
    assert.equal(malformed.code, 2);
    assert.match(malformed.stderr, /not valid JSON/);
    assert.equal(readFileSync(f, 'utf8'), '{ this is not json');
  });
});

test('fresh install writes the expected managed hook bundle with baked absolute paths', () => {
  withHome((home) => {
    const transientPath = join(home, '.codex', 'tmp', 'arg0', 'codex-abc123');
    const arbitraryPath = join(home, 'bin');
    mkdirSync(arbitraryPath, { recursive: true });
    writeFileSync(join(arbitraryPath, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(arbitraryPath, 'jq'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = runScript(home, [], {
      PATH: [
        transientPath,
        arbitraryPath,
        dirname(process.execPath),
        arbitraryPath,
        process.env.PATH || '',
      ].join(delimiter),
    });
    assert.equal(r.code, 0, r.stderr);
    const cfg = readHooks(home);

    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
      assert.equal(managedEntries(cfg, ev).length, 1, `${ev} has exactly one managed entry`);
    }

    const sessionStart = managedEntries(cfg, 'SessionStart')[0];
    const cmds = sessionStart.hooks.map((h) => h.command);
    assert.match(cmds[0], /^CLAUDE_PLUGIN_ROOT='/);
    assert.match(cmds[0], /AGENT_COMPANION_NODE='/);
    assert.match(cmds[0], /\/bin\/bash '/);
    assert.ok(cmds[0].includes(PLUGIN_ROOT), 'plugin-root absolute path baked in');
    assert.ok(cmds[0].includes(process.execPath), 'node path baked in for hook scripts');
    const pathMatch = cmds[0].match(/PATH='([^']+)'/);
    assert.ok(pathMatch, 'PATH is baked into hook command');
    const pathEntries = pathMatch[1].split(delimiter);
    assert.ok(pathEntries.includes(dirname(process.execPath)), 'node directory included in short PATH');
    assert.ok(pathEntries.includes('/usr/bin'), 'system binary directory included in short PATH');
    assert.ok(pathEntries.includes('/bin'), 'shell utility directory included in short PATH');
    assert.equal(pathEntries.includes(transientPath), false,
      'transient Codex temp PATH entries are not persisted');
    assert.equal(pathEntries.includes(arbitraryPath), false,
      'arbitrary caller PATH entries are not persisted');
    assert.equal(cmds[0].includes(join(arbitraryPath, 'npm')), false,
      'npm is not baked from arbitrary caller PATH entries');
    assert.equal(cmds[0].includes(join(arbitraryPath, 'jq')), false,
      'jq is not baked from arbitrary caller PATH entries');
    assert.equal(new Set(pathEntries).size, pathEntries.length, 'PATH entries are deduplicated');
    assert.doesNotMatch(cmds.join('\n'), /\$\{CLAUDE_PLUGIN_ROOT\}/,
      'no ${VAR} placeholder because Codex does not expand user-scope hook env');
    assert.match(cmds[0], /install-agent-codex\.sh/);
    assert.match(cmds[1], /prewarm-target\.sh/);
    assert.match(cmds[2], /install-deps\.sh/);
    assert.match(cmds[3], /drain-completions\.sh/);
    assert.equal(sessionStart.hooks[2].timeout, 55);
    for (const i of [0, 1, 3]) assert.equal(sessionStart.hooks[i].timeout, 5);

    const postToolUse = managedEntries(cfg, 'PostToolUse')[0];
    assert.equal(postToolUse.matcher, '.*');
  });
});

test('reinstall is idempotent, preserves user hooks, and writes backups only for existing config', () => {
  withHome((home) => {
    const f = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '/usr/local/bin/user-script.sh', timeout: 5 }],
        }],
        UserPromptSubmit: [{
          hooks: [{ type: 'command', command: 'echo user-hook' }],
        }],
      },
    }, null, 2));

    runScript(home);
    runScript(home);
    runScript(home);
    const cfg = readHooks(home);

    // User's SessionStart entry must still be there.
    const userSS = cfg.hooks.SessionStart.find((e) =>
      e.hooks?.[0]?.command === '/usr/local/bin/user-script.sh');
    assert.ok(userSS, 'user SessionStart entry preserved');
    assert.notEqual(userSS._managed_by, 'agent-companion',
      'user entry was not tagged with our sentinel');

    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
      assert.equal(managedEntries(cfg, ev).length, 1, `${ev} still has 1 managed entry after repeated installs`);
    }
    assert.equal(cfg.hooks.SessionStart.length, 2,
      'one user entry + one managed entry = 2');
    assert.ok(readdirSync(join(home, '.codex')).filter((name) => /hooks\.json\.bak\./.test(name)).length >= 1,
      'modifying an existing hooks.json writes a backup');
  });
});

test('install migrates legacy untagged agent-companion hook entries', () => {
  withHome((home) => {
    const f = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(f), { recursive: true });
    const legacy = (script) => ({
      type: 'command',
      command: `CLAUDE_PLUGIN_ROOT='${PLUGIN_ROOT}' bash '${join(PLUGIN_ROOT, script)}'`,
    });
    writeFileSync(f, JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [
            legacy('hooks/install-agent-codex.sh'),
            legacy('hooks/prewarm-target.sh'),
            legacy('hooks/install-deps.sh'),
            legacy('hooks/drain-completions.sh'),
          ],
        }],
        UserPromptSubmit: [{
          hooks: [legacy('hooks/drain-completions.sh')],
        }],
        PostToolUse: [{
          matcher: '.*',
          hooks: [legacy('hooks/drain-completions.sh')],
        }],
      },
    }, null, 2));

    const r = runScript(home);
    assert.equal(r.code, 0, r.stderr);
    const cfg = readHooks(home);

    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
      assert.equal(cfg.hooks[ev].length, 1, `${ev} legacy entry replaced`);
      assert.equal(managedEntries(cfg, ev).length, 1, `${ev} has one managed entry`);
    }

    const commands = cfg.hooks.SessionStart[0].hooks.map((hook) => hook.command);
    assert.ok(commands.every((command) => command.includes('AGENT_COMPANION_HOST=codex')),
      'replacement commands are codex-host routed');
    assert.ok(commands.every((command) => command.includes('AGENT_COMPANION_NODE=')),
      'replacement commands bake the node executable');
  });
});

test('uninstall removes only managed entries, preserves user entries', () => {
  withHome((home) => {
    // Seed user hooks
    const f = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '/usr/local/bin/user-script.sh' }],
        }],
      },
    }, null, 2));

    runScript(home);
    runScript(home, ['--uninstall']);

    const cfg = readHooks(home);
    assert.equal(cfg.hooks.SessionStart.length, 1, 'user entry survives');
    assert.equal(cfg.hooks.SessionStart[0].hooks[0].command,
      '/usr/local/bin/user-script.sh');
    assert.equal(cfg.hooks.UserPromptSubmit, undefined,
      'event keys with no remaining entries are removed');
    assert.equal(cfg.hooks.PostToolUse, undefined);
  });
});
