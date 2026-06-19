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
const REQUIRED_PERMISSIONS = [
  'mcp__copilot-bridge__agent_send',
  'mcp__copilot-bridge__agent_wait',
  'mcp__copilot-bridge__agent_status',
  'mcp__copilot-bridge__agent_reply',
  'mcp__copilot-bridge__agent_cancel',
  'mcp__copilot-bridge__copilot_send',
  'mcp__copilot-bridge__copilot_wait',
  'mcp__copilot-bridge__copilot_status',
  'mcp__copilot-bridge__copilot_reply',
  'mcp__copilot-bridge__copilot_cancel',
  'Bash(echo "$CLAUDE_CODE_SESSION_ID")',
];

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'claude-perms-test-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runScript(home, extraArgs = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--yes', ...extraArgs], {
    env: { ...process.env, HOME: home },
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

test('fresh install writes required copilot-companion permissions', () => {
  withHome((home) => {
    const r = runScript(home);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readSettings(home).permissions.allow, REQUIRED_PERMISSIONS);
  });
});

test('install migrates legacy multiplexed permission and preserves unrelated entries', () => {
  withHome((home) => {
    const f = settingsPath(home);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      permissions: {
        allow: [
          'Bash(git status:*)',
          'mcp__copilot-bridge__copilot',
          'Bash(echo:*)',
          'Read(//tmp/**)',
        ],
      },
    }, null, 2));

    const r = runScript(home);
    assert.equal(r.code, 0, r.stderr);
    const allow = readSettings(home).permissions.allow;

    assert.equal(allow.includes('mcp__copilot-bridge__copilot'), false);
    assert.equal(allow.includes('Bash(echo:*)'), false);
    assert.ok(allow.includes('Bash(git status:*)'));
    assert.ok(allow.includes('Read(//tmp/**)'));
    for (const permission of REQUIRED_PERMISSIONS) assert.ok(allow.includes(permission), `${permission} installed`);
    assert.ok(readdirSync(join(home, '.claude')).some((name) => /settings\.json\.bak\./.test(name)),
      'existing settings file was backed up');
  });
});

test('codex host is an explicit no-op and malformed claude settings are not overwritten', () => {
  withHome((home) => {
    const codex = runScript(home, ['--host', 'codex']);
    assert.equal(codex.code, 0, codex.stderr);
    assert.equal(existsSync(settingsPath(home)), false);

    const f = settingsPath(home);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '{ invalid json');
    const malformed = runScript(home);
    assert.equal(malformed.code, 2);
    assert.match(malformed.stderr, /not valid JSON/);
    assert.equal(readFileSync(f, 'utf8'), '{ invalid json');
  });
});
