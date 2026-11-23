// Tests for scripts/install-codex-hooks.mjs.
//
// We invoke the script as a subprocess (vs. importing) for two reasons:
//   1. It calls process.exit() on CLI validation and no-op paths, which would tear
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
  mkdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'install-codex-hooks.mjs');
const PLUGIN_ROOT = dirname(HERE); // repo root

function uninstall(home, extraEnv = {}) {
  const args = [SCRIPT, '--plugin-root', PLUGIN_ROOT, '--yes', '--uninstall'];
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

test('CLI validation rejects missing/relative plugin roots and malformed existing config without overwrite', () => {
  withHome((home) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--uninstall', '--yes'], {
      env: { ...process.env, HOME: home }, encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--plugin-root/);

    const rel = spawnSync(process.execPath, [SCRIPT, '--plugin-root', 'rel/path', '--uninstall', '--yes'], {
      env: { ...process.env, HOME: home }, encoding: 'utf8',
    });
    assert.equal(rel.status, 2);
    assert.match(rel.stderr, /must be absolute/);

    const f = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '{ this is not json');
    const malformed = uninstall(home);
    assert.equal(malformed.code, 2);
    assert.match(malformed.stderr, /not valid JSON/);
    assert.equal(readFileSync(f, 'utf8'), '{ this is not json');
  });
});

test('uninstall removes only managed entries, preserves user entries', () => {
  withHome((home) => {
    const f = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '/usr/local/bin/user-script.sh' }] },
          { _managed_by: 'agent-companion', hooks: [] },
        ],
        UserPromptSubmit: [{ _managed_by: 'agent-companion', hooks: [] }],
        PostToolUse: [{ _managed_by: 'agent-companion', hooks: [] }],
      },
    }, null, 2));

    uninstall(home);

    const cfg = readHooks(home);
    assert.equal(cfg.hooks.SessionStart.length, 1, 'user entry survives');
    assert.equal(cfg.hooks.SessionStart[0].hooks[0].command,
      '/usr/local/bin/user-script.sh');
    assert.equal(cfg.hooks.UserPromptSubmit, undefined,
      'event keys with no remaining entries are removed');
    assert.equal(cfg.hooks.PostToolUse, undefined);
  });
});

test('uninstall is a byte-for-byte no-op when no managed entries exist', () => {
  withHome((home) => {
    const f = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(f), { recursive: true });
    const original = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo user' }] }],
      },
    }) + '\n';
    writeFileSync(f, original);
    const before = statSync(f).mtimeMs;

    const result = uninstall(home);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /no agent-companion hooks present/);
    assert.equal(readFileSync(f, 'utf8'), original);
    assert.equal(statSync(f).mtimeMs, before);
    assert.deepEqual(
      readdirSync(join(home, '.codex')).filter((name) => /hooks\.json\.bak\./.test(name)),
      [],
      'a no-op uninstall must not create a backup',
    );
  });
});

test('CODEX_HOME selects the hooks file for migration cleanup', () => {
  withHome((home) => {
    const codexHome = join(home, 'custom codex home');
    const f = join(codexHome, 'hooks.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      hooks: {
        SessionStart: [
          { _managed_by: 'agent-companion', hooks: [] },
          { hooks: [{ type: 'command', command: 'echo user' }] },
        ],
      },
    }));

    const result = uninstall(home, { CODEX_HOME: codexHome });

    assert.equal(result.code, 0, result.stderr);
    const cleaned = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(cleaned.hooks.SessionStart.length, 1);
    assert.equal(cleaned.hooks.SessionStart[0].hooks[0].command, 'echo user');
    assert.equal(existsSync(join(home, '.codex', 'hooks.json')), false);
  });
});
