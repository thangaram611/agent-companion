import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openCodeRuntimeInfo,
  resolveOpenCodePermissionMode,
  startOpenCodeRun,
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
