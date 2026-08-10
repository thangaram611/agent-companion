import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openCodeRuntimeInfo,
  resolveOpenCodePermissionMode,
  startOpenCodeRun,
  writeOpenCodeDigest,
} from './opencode-runtime.mjs';

function fakeBin(source) {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-runtime-test-'));
  const bin = join(dir, 'opencode-fake.mjs');
  writeFileSync(bin, ['#!/usr/bin/env node', source, ''].join('\n'), { mode: 0o700 });
  chmodSync(bin, 0o700);
  return { dir, bin };
}

test('OpenCode runtime info exposes permission mode and timeout config', () => {
  assert.deepEqual(resolveOpenCodePermissionMode({}), {
    mode: 'default',
    skipPermissions: false,
    source: 'fallback',
  });
  assert.deepEqual(resolveOpenCodePermissionMode({ AGENT_COMPANION_OPENCODE_PERMISSION_MODE: 'skip' }), {
    mode: 'skip',
    skipPermissions: true,
    source: 'env',
  });
  // The dangerous flag is only honored through the explicit permission-mode
  // env; there is no legacy boolean shortcut.
  assert.deepEqual(resolveOpenCodePermissionMode({ AGENT_COMPANION_OPENCODE_SKIP_PERMISSIONS: '1' }), {
    mode: 'default',
    skipPermissions: false,
    source: 'fallback',
  });
  assert.equal(openCodeRuntimeInfo({
    OPENCODE_BIN: '/tmp/opencode',
    AGENT_COMPANION_OPENCODE_TIMEOUT_MS: '1234',
  }).timeout_ms, 1234);
});

test('startOpenCodeRun passes dangerous permission flag only when configured', async () => {
  const { dir, bin } = fakeBin(`
    const args = process.argv.slice(2);
    console.log(JSON.stringify({ type: 'message', message: args.join(' ') }));
  `);
  try {
    let result = await startOpenCodeRun({
      jobId: 'j-default',
      cwd: dir,
      prompt: 'hello',
      env: { ...process.env, OPENCODE_BIN: bin },
    });
    assert.equal(result.status, 'completed');
    assert.doesNotMatch(result.stdout, /dangerously-skip-permissions/);

    result = await startOpenCodeRun({
      jobId: 'j-skip',
      cwd: dir,
      prompt: 'hello',
      env: {
        ...process.env,
        OPENCODE_BIN: bin,
        AGENT_COMPANION_OPENCODE_PERMISSION_MODE: 'skip',
      },
    });
    assert.equal(result.status, 'completed');
    assert.match(result.stdout, /--dangerously-skip-permissions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startOpenCodeRun extracts assistant NDJSON without selecting tool output', async () => {
  const { dir, bin } = fakeBin(`
    console.log(JSON.stringify({ type: 'tool_call', name: 'bash', input: { cmd: 'printf noisy' }, output: 'TOOL OUTPUT THAT MUST NOT WIN' }));
    console.log(JSON.stringify({ type: 'message', message: 'first assistant part' }));
    console.log(JSON.stringify({ type: 'message', message: 'second assistant part' }));
  `);
  try {
    const result = await startOpenCodeRun({
      jobId: 'j-json',
      cwd: dir,
      prompt: 'hello',
      env: { ...process.env, OPENCODE_BIN: bin },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.summary.message, 'first assistant part\nsecond assistant part');
    assert.equal(result.summary.toolCalls.length, 1);
    assert.doesNotMatch(result.summary.message, /TOOL OUTPUT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startOpenCodeRun does not promote tool-only NDJSON to assistant text', async () => {
  const { dir, bin } = fakeBin(`
    console.log(JSON.stringify({ type: 'tool_call', name: 'bash', input: { cmd: 'printf noisy' }, output: 'TOOL ONLY OUTPUT' }));
  `);
  try {
    const result = await startOpenCodeRun({
      jobId: 'j-tool-only',
      cwd: dir,
      prompt: 'hello',
      env: { ...process.env, OPENCODE_BIN: bin },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.summary.message, '');
    assert.equal(result.summary.toolCalls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startOpenCodeRun terminates a stuck CLI at the configured timeout', async () => {
  const { dir, bin } = fakeBin(`
    setInterval(() => {}, 1000);
  `);
  try {
    const result = await startOpenCodeRun({
      jobId: 'j-timeout',
      cwd: dir,
      prompt: 'hello',
      env: {
        ...process.env,
        OPENCODE_BIN: bin,
        AGENT_COMPANION_OPENCODE_TIMEOUT_MS: '50',
      },
    });
    assert.equal(result.status, 'timeout');
    assert.equal(result.timedOut, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- TRACK: atomic-digests (W0.2) ----
//
// `writeOpenCodeDigest` is called on every status request and on terminal while
// other processes read the same path. A truncate-then-write hands those readers
// a zero-length or half-written file (measured on this machine: 20,945 of
// 119,401 concurrent cross-process reads returned 0 bytes). This test pins the
// property itself — a concurrent reader in a SEPARATE process never sees
// anything but a whole digest — rather than asserting which writer was called.

// Runs in its own process: spins reading `target` until `stopPath` appears and
// reports every distinct byte-length it observed. Under a truncating write the
// set contains 0 (and other short lengths); under temp+rename it cannot.
const CONCURRENT_READER_SOURCE = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [target, readyPath, stopPath] = process.argv.slice(2);
const lengths = new Set();
let reads = 0;
writeFileSync(readyPath, '');
while (!existsSync(stopPath)) {
  let content;
  // ENOENT is only reachable before the first write ever lands; rename(2)
  // never exposes a gap where the path is missing.
  try { content = readFileSync(target, 'utf8'); } catch { continue; }
  reads += 1;
  lengths.add(content.length);
}
process.stdout.write(JSON.stringify({ reads, lengths: [...lengths] }));
`;

async function withConcurrentReader(target, dir, rewriteLoop) {
  const readerBin = join(dir, 'digest-reader.mjs');
  writeFileSync(readerBin, CONCURRENT_READER_SOURCE, { mode: 0o700 });
  const readyPath = join(dir, 'digest-reader-ready');
  const stopPath = join(dir, 'digest-reader-stop');
  const child = spawn(process.execPath, [readerBin, target, readyPath, stopPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  const exited = new Promise((resolve) => child.on('close', resolve));
  try {
    // Don't start rewriting until the reader is provably spinning, so the
    // observation window can never be empty on a slow machine.
    for (let i = 0; i < 2000 && !existsSync(readyPath); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(existsSync(readyPath), 'concurrent reader started');
    rewriteLoop();
  } finally {
    writeFileSync(stopPath, '');
    await exited;
  }
  return JSON.parse(out || '{}');
}

test('writeOpenCodeDigest replaces the file atomically - a concurrent reader never sees a partial digest', async () => {
  const digestDir = mkdtempSync(join(tmpdir(), 'opencode-digest-atomic-'));
  process.env.AGENT_DIGEST_DIR = digestDir;
  try {
    // Every field is either fixed-width (the ISO `Updated:` stamp, the fixed
    // `Started:` epoch) or constant, so successive rewrites are byte-identical
    // in size — which is what lets the reader treat "any other length" as a
    // torn read. Both raw channels are filled to their caps so the file is as
    // wide as this digest ever gets.
    const job = {
      jobId: 'j-atomic',
      target: 'opencode',
      status: 'running',
      mode: 'EXECUTE',
      startedAt: 1_700_000_000_000,
      task: 'T'.repeat(1500),
    };
    const result = {
      stdout: 'O'.repeat(14_000),
      stderr: 'E'.repeat(5_000),
      summary: { message: 'M'.repeat(14_000) },
    };
    const target = writeOpenCodeDigest(job, result);
    assert.ok(target, 'first write lands');
    const wholeLength = readFileSync(target, 'utf8').length;
    assert.ok(wholeLength > 20_000, `digest is large enough to tear (${wholeLength} B)`);

    const observed = await withConcurrentReader(target, digestDir, () => {
      for (let i = 0; i < 200; i += 1) writeOpenCodeDigest(job, result);
    });

    assert.ok(observed.reads > 0, 'the reader actually observed the digest');
    assert.deepEqual(
      observed.lengths,
      [wholeLength],
      `every concurrent read saw the whole file; observed ${JSON.stringify(observed.lengths)}`,
    );
    // Atomic replace must not regress the 0600 contract the digest carries.
    assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    delete process.env.AGENT_DIGEST_DIR;
    rmSync(digestDir, { recursive: true, force: true });
  }
});
