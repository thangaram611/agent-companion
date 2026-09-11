// scripts/install-antigravity-acp.test.mjs — the pure parts of the installer:
// which registry archive this platform gets, where it lands, and what counts
// as installed. The download, unzip and codesign paths are exercised for real
// by running the script (probes/README.md) — they need the network and a Mac.

import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selectDistribution, installedVersion, verifySignature, AGENT_ID, EXPECTED_AUTHORITY } from './install-antigravity-acp.mjs';
import { antigravityAcpPaths, getTargetById } from '../lib/target-registry.mjs';

// The registry entry as published 2026-09-03 (PR #567), abridged.
const REGISTRY = {
  agents: [{
    id: AGENT_ID, name: 'Google Antigravity', version: '1.1.1',
    distribution: { binary: {
      'darwin-aarch64': { archive: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip', cmd: './agy_acp_server.par' },
      'linux-x86_64': { archive: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip', cmd: './agy_acp_server.par', args: ['--uid='] },
      'linux-aarch64': { archive: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip', cmd: './agy_acp_server.par', args: ['--uid='] },
      'windows-x86_64': { archive: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip', cmd: './agy_acp_server.exe' },
    } },
  }],
};

test('selectDistribution maps node\'s platform/arch onto the registry\'s keys and refuses what the registry lacks', () => {
  assert.deepEqual(selectDistribution(REGISTRY, 'darwin', 'arm64'), {
    version: '1.1.1', archive: REGISTRY.agents[0].distribution.binary['darwin-aarch64'].archive, cmd: './agy_acp_server.par', args: [],
  });
  assert.deepEqual(selectDistribution(REGISTRY, 'linux', 'x64').args, ['--uid='], 'the registry launches linux with --uid=, and so does the descriptor');
  assert.equal(selectDistribution(REGISTRY, 'linux', 'arm64').archive, REGISTRY.agents[0].distribution.binary['linux-aarch64'].archive);
  assert.throws(() => selectDistribution(REGISTRY, 'darwin', 'x64'), /no antigravity-acp binary for darwin-x64; the registry has: darwin-aarch64/, 'no Intel Mac build');
  assert.throws(() => selectDistribution({ agents: [] }), /no "antigravity-acp" entry/);
});

test('the install root is host-neutral under XDG data, and the descriptor spawns the `current` binary there', () => {
  const p = antigravityAcpPaths({}, '/home/u');
  assert.equal(p.root, '/home/u/.local/share/agent-companion/antigravity-acp');
  assert.equal(p.binary, '/home/u/.local/share/agent-companion/antigravity-acp/current/agy_acp_server.par');
  assert.equal(antigravityAcpPaths({ XDG_DATA_HOME: '/data' }, '/home/u').root, '/data/agent-companion/antigravity-acp');
  assert.equal(getTargetById('antigravity').binaryNames[0], antigravityAcpPaths().binary);

  const root = mkdtempSync(join(tmpdir(), 'agy-install-'));
  try {
    const paths = { root, current: join(root, 'current'), binary: join(root, 'current', 'agy_acp_server.par') };
    assert.equal(installedVersion(paths), null);
    mkdirSync(join(root, '1.1.1'));
    symlinkSync('1.1.1', paths.current);
    assert.equal(installedVersion(paths), '1.1.1', 'the version is the directory `current` points at');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifySignature requires Google\'s Developer ID on macOS and says it cannot verify elsewhere', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return cmd === 'sh' ? `Identifier=agy_acp_server\nAuthority=${EXPECTED_AUTHORITY}\n` : ''; };
  assert.deepEqual(verifySignature('/x/agy_acp_server.par', { platform: 'darwin', run }), { verified: true, detail: EXPECTED_AUTHORITY });
  assert.deepEqual(calls[0], ['codesign', '--verify', '--strict', '/x/agy_acp_server.par']);
  const other = (cmd) => (cmd === 'sh' ? 'Authority=Developer ID Application: Someone Else (XXXX)\n' : '');
  assert.equal(verifySignature('/x/agy_acp_server.par', { platform: 'darwin', run: other }).verified, false);
  const failing = () => { throw new Error('code object is not signed at all'); };
  assert.throws(() => verifySignature('/x/agy_acp_server.par', { platform: 'darwin', run: failing }), /not signed/);
  assert.equal(verifySignature('/x/agy_acp_server.par', { platform: 'linux', run }).verified, false);
});
