// Installer tests use registry and archive fixtures, local downloads and a
// fake codesign command to check integrity before extraction and activation.

import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { install, selectDistribution, installedVersion, verifySignature, EXPECTED_AUTHORITY } from './install-antigravity-acp.mjs';
import { antigravityAcpPaths, getTargetById } from '../lib/target-registry.mjs';

const REGISTRY = { agents: [JSON.parse(readFileSync(new URL('../test/fixtures/antigravity-acp-agent.json', import.meta.url), 'utf8'))] };
const ARCHIVE = new URL('../test/fixtures/antigravity-acp.zip', import.meta.url);
const ARCHIVE_SHA256 = 'c17b902e93a86acd1d91827a9f055d5bcfbe5920e15391ea2dbe1353d12b8f2a';

test('selectDistribution maps supported platforms to registry keys and refuses unsupported platforms', () => {
  assert.deepEqual(selectDistribution(REGISTRY, 'darwin', 'arm64'), {
    version: '1.4.3', archive: REGISTRY.agents[0].distribution.binary['darwin-aarch64'].archive, cmd: './agy_acp_server.par', args: [],
    sha256: 'c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b',
  });
  assert.deepEqual(selectDistribution(REGISTRY, 'linux', 'x64').args, ['--uid='], 'the registry launches linux with --uid=, and so does the descriptor');
  assert.equal(selectDistribution(REGISTRY, 'linux', 'arm64').archive, REGISTRY.agents[0].distribution.binary['linux-aarch64'].archive);
  assert.throws(() => selectDistribution(REGISTRY, 'win32', 'x64'), /no antigravity-acp binary for win32-x64/, 'the installer supports macOS ARM64 and Linux');
  assert.throws(() => selectDistribution({ agents: [] }), /no "antigravity-acp" entry/);
});

for (const sha256 of [undefined, 'not-a-sha256']) {
  test(`selectDistribution refuses an invalid registry checksum: ${sha256}`, () => {
    const registry = structuredClone(REGISTRY);
    registry.agents[0].distribution.binary['darwin-aarch64'].sha256 = sha256;
    assert.throws(() => selectDistribution(registry, 'darwin', 'arm64'), /valid SHA-256 checksum/);
  });
}

for (const mismatch of [false, true]) {
  test(`install ${mismatch ? 'rejects a SHA-256 mismatch before extraction' : 'verifies SHA-256 before activating the archive'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-integrity-'));
    const paths = { root, current: join(root, 'current'), binary: join(root, 'current', 'agy_acp_server.par') };
    const priorPath = process.env.PATH;
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'codesign'), `#!/bin/sh\necho called >> "$0.calls"\necho 'Authority=${EXPECTED_AUTHORITY}' >&2\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${priorPath}`;
    mkdirSync(join(root, 'installed'));
    symlinkSync('installed', paths.current);
    const registry = structuredClone(REGISTRY);
    for (const entry of Object.values(registry.agents[0].distribution.binary)) {
      entry.archive = ARCHIVE.href;
      entry.sha256 = mismatch ? '0'.repeat(64) : ARCHIVE_SHA256;
    }
    const registryUrl = `data:application/json,${encodeURIComponent(JSON.stringify(registry))}`;
    const logs = [];
    try {
      if (mismatch) {
        await assert.rejects(install({ paths, registryUrl, log: (line) => logs.push(line) }), /SHA-256 mismatch/);
        assert.equal(installedVersion(paths), 'installed');
        assert.equal(existsSync(join(root, '1.4.3')), false, 'a rejected archive is not extracted');
        assert.equal(existsSync(join(bin, 'codesign.calls')), false, 'signature checks cannot bypass a checksum failure');
      } else {
        const result = await install({ paths, registryUrl, log: (line) => logs.push(line) });
        assert.equal(result.changed, true);
        assert.equal(installedVersion(paths), '1.4.3');
        assert.equal(readFileSync(paths.binary, 'utf8'), '#!/bin/sh\nexit 0\n');
        assert.ok(logs.some((line) => line.includes(`SHA-256 verified: ${ARCHIVE_SHA256}`)));
        assert.equal(JSON.parse(readFileSync(join(root, '1.4.3', 'registry-entry.json'), 'utf8')).sha256, ARCHIVE_SHA256);
        if (process.platform === 'darwin') assert.equal(readFileSync(join(bin, 'codesign.calls'), 'utf8'), 'called\ncalled\n');
      }
    } finally {
      if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

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
