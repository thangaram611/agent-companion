import '../test/sandbox-home.mjs';
import { tools } from '../bridge-server/tools.mjs';
import { HOSTS } from '../lib/hosts/index.mjs';
// Tests for scripts/install-permissions.mjs.
//
// The script resolves ~/.claude/settings.json from HOME at module load and
// exits on validation/confirmation paths, so each case runs it in a subprocess
// with a temporary HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'install-permissions.mjs');
const REQUIRED_PERMISSIONS = tools.map(tool => HOSTS.claude.toolPrefix + tool.name);

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'claude-perms-test-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runScript(home, extraArgs = [], env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, '--yes', ...extraArgs], {
    env: { ...process.env, HOME: home, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function settingsPath(home) {
  return join(home, '.claude', 'settings.json');
}

function readSettings(home) {
  return JSON.parse(readFileSync(settingsPath(home), 'utf8'));
}

test('fresh install writes required agent-companion permissions', () => {
  withHome((home) => {
    const r = runScript(home);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readSettings(home).permissions.allow, REQUIRED_PERMISSIONS);
  });
});

test('install adds missing permissions, preserves unrelated entries, and backs up', () => {
  withHome((home) => {
    const f = settingsPath(home);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      permissions: {
        allow: [
          'Bash(git status:*)',
          'Read(//tmp/**)',
        ],
      },
    }, null, 2));

    const r = runScript(home);
    assert.equal(r.code, 0, r.stderr);
    const allow = readSettings(home).permissions.allow;

    assert.ok(allow.includes('Bash(git status:*)'));
    assert.ok(allow.includes('Read(//tmp/**)'));
    for (const permission of REQUIRED_PERMISSIONS) assert.ok(allow.includes(permission), `${permission} installed`);
    assert.ok(readdirSync(join(home, '.claude')).some((name) => /settings\.json\.bak\./.test(name)),
      'existing settings file was backed up');
  });
});

test('old bridge permissions in both namespaces are replaced', () => {
  withHome((home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const stale = ['mcp__agent-bridge__', HOSTS.claude.toolPrefix].flatMap(prefix =>
      ['send', 'wait', 'read', 'status', 'cancel', 'catalog', 'reply'].map(action => prefix + 'agent_' + action));
    writeFileSync(settingsPath(home), JSON.stringify({
      permissions: { allow: ['Bash(git status:*)', ...stale, 'Agent(agent-companion)'] },
    }));
    const r = runScript(home);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status:*)', ...REQUIRED_PERMISSIONS]);
  });
});

test('codex host is an explicit no-op and malformed claude settings are not overwritten', () => {
  withHome((home) => {
    const codex = runScript(home, ['--host', 'codex']);
    assert.equal(codex.code, 0, codex.stderr);
    assert.equal(existsSync(settingsPath(home)), false);

    const opencode = runScript(home, ['--host', 'opencode']);
    assert.equal(opencode.code, 0, opencode.stderr);
    assert.equal(existsSync(join(home, '.config', 'opencode')), false);

    const f = settingsPath(home);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '{ invalid json');
    const malformed = runScript(home);
    assert.equal(malformed.code, 2);
    assert.match(malformed.stderr, /not valid JSON/);
    assert.equal(readFileSync(f, 'utf8'), '{ invalid json');
  });
});

test('Claude permissions use the selected CLAUDE_CONFIG_DIR profile', () => withHome(home => {
  const profile = join(home, 'second profile');
  const r = runScript(home, [], { CLAUDE_CONFIG_DIR: profile });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(profile, 'settings.json'))).permissions.allow, REQUIRED_PERMISSIONS);
  assert.equal(existsSync(settingsPath(home)), false);
}));
