import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cancelCodexRun,
  codexPromptId,
  codexRuntimeInfo,
  createCodexCollector,
  resolveCodexBin,
  resolveCodexSandbox,
  resolveCodexTimeoutMs,
  startCodexRun,
} from './codex-runtime.mjs';

function fakeBin(source) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-runtime-test-'));
  const bin = join(dir, 'codex-fake.mjs');
  writeFileSync(bin, ['#!/usr/bin/env node', source, ''].join('\n'), { mode: 0o700 });
  chmodSync(bin, 0o700);
  return { dir, bin };
}

// A fake bin that ignores its stdin prompt and emits a fixed JSONL stream
// after stdin closes — the shape every startCodexRun-driving test below reuses
// unless it needs to assert something about the events themselves.
function completingBin(extraLines = []) {
  return fakeBin(`
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => {
      ${extraLines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n      ')}
    });
  `);
}

test('resolveCodexBin / resolveCodexTimeoutMs / codexPromptId / codexRuntimeInfo', () => {
  assert.equal(resolveCodexBin({}), 'codex');
  assert.equal(resolveCodexBin({ CODEX_BIN: '/opt/codex' }), '/opt/codex');
  assert.equal(resolveCodexTimeoutMs({}), 40 * 60 * 1000);
  assert.equal(resolveCodexTimeoutMs({ AGENT_COMPANION_CODEX_TIMEOUT_MS: '1234' }), 1234);
  assert.equal(codexPromptId('job-1'), 'codex-job-1');
  assert.deepEqual(codexRuntimeInfo({ CODEX_BIN: '/opt/codex', AGENT_COMPANION_CODEX_NETWORK: 'off' }), {
    bin: '/opt/codex',
    sandbox: { mode: 'workspace-write', network: false, source: 'default' },
    timeout_ms: 40 * 60 * 1000,
  });
});

// D4: one resolver for sandbox + network, full flag matrix. Unrecognized
// values must never reach `--sandbox` verbatim and must never escalate.
test('resolveCodexSandbox produces the exact D4 flag matrix for every mode', () => {
  assert.deepEqual(resolveCodexSandbox({}), {
    mode: 'workspace-write', network: true, source: 'default',
    args: ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'],
  });
  assert.deepEqual(resolveCodexSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'workspace-write' }), {
    mode: 'workspace-write', network: true, source: 'env',
    args: ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'],
  });
  assert.deepEqual(resolveCodexSandbox({ AGENT_COMPANION_CODEX_NETWORK: 'off' }), {
    mode: 'workspace-write', network: false, source: 'default',
    args: ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false'],
  });
  assert.deepEqual(resolveCodexSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only' }), {
    mode: 'read-only', network: null, source: 'env', args: ['--sandbox', 'read-only'],
  });
  assert.deepEqual(resolveCodexSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'danger-full-access' }), {
    mode: 'danger-full-access', network: null, source: 'env', args: ['--sandbox', 'danger-full-access'],
  });
  assert.deepEqual(resolveCodexSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'bypass' }), {
    mode: 'bypass', network: null, source: 'env', args: ['--dangerously-bypass-approvals-and-sandbox'],
  });
  // Typo/unrecognized: same safe workspace-write behavior as unset, never
  // escalates — but reported as source:'fallback' (vs 'default' when unset)
  // so diagnostics can tell an ignored typo from a clean unconfigured env.
  assert.deepEqual(resolveCodexSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'yolo' }), {
    mode: 'workspace-write', network: true, source: 'fallback',
    args: ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'],
  });
});

test('startCodexRun builds the full default exec argv, pins -m for a model, and writes the prompt to stdin', async () => {
  const { dir, bin } = fakeBin(`
    let input = '';
    process.stdin.on('data', (c) => { input += c; });
    process.stdin.on('end', () => {
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'th-argv' }));
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stdin_len=' + input.length } }));
      console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
    });
  `);
  let started;
  try {
    const result = await startCodexRun({
      jobId: 'j-argv',
      cwd: dir,
      prompt: 'hello codex',
      model: 'gpt-5.6-sol',
      env: { ...process.env, CODEX_BIN: bin },
      onStarted: (info) => { started = info; },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(started.args, [
      'exec', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true',
      '--skip-git-repo-check', '-C', dir, '--json', '-m', 'gpt-5.6-sol', '-',
    ]);
    // Prompt arrived via stdin, not argv — the fake bin reports its length back.
    assert.equal(result.summary.message, 'stdin_len=11'); // 'hello codex'.length === 11
    assert.equal(result.sessionId, 'th-argv');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AGENT_COMPANION_CODEX_NETWORK=off emits an explicit network_access=false override, not a dropped flag', async () => {
  const { dir, bin } = completingBin([{ type: 'turn.completed', usage: {} }]);
  let started;
  try {
    const result = await startCodexRun({
      jobId: 'j-net-off', cwd: dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: bin, AGENT_COMPANION_CODEX_NETWORK: 'off' },
      onStarted: (info) => { started = info; },
    });
    assert.equal(result.status, 'completed');
    assert.ok(started.args.includes('sandbox_workspace_write.network_access=false'));
    assert.ok(!started.args.includes('sandbox_workspace_write.network_access=true'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-only and danger-full-access modes omit the network -c key entirely', async () => {
  const { dir, bin } = completingBin([{ type: 'turn.completed', usage: {} }]);
  try {
    for (const mode of ['read-only', 'danger-full-access']) {
      let started;
      const result = await startCodexRun({
        jobId: `j-${mode}`, cwd: dir, prompt: 'x',
        env: { ...process.env, CODEX_BIN: bin, AGENT_COMPANION_CODEX_SANDBOX_MODE: mode },
        onStarted: (info) => { started = info; },
      });
      assert.equal(result.status, 'completed');
      assert.deepEqual(started.args.slice(0, 3), ['exec', '--sandbox', mode]);
      assert.ok(!started.args.some((a) => a.includes('network_access')));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bypass mode emits --dangerously-bypass-approvals-and-sandbox instead of -s', async () => {
  const { dir, bin } = completingBin([{ type: 'turn.completed', usage: {} }]);
  let started;
  try {
    const result = await startCodexRun({
      jobId: 'j-bypass', cwd: dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: bin, AGENT_COMPANION_CODEX_SANDBOX_MODE: 'bypass' },
      onStarted: (info) => { started = info; },
    });
    assert.equal(result.status, 'completed');
    assert.ok(started.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!started.args.includes('--sandbox'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// D10 JSONL collector — direct unit test against the exported parser rather
// than a full spawn round-trip, since createCodexCollector is exported
// precisely for this.
test('createCodexCollector: last completed agent_message wins, reasoning/toolCalls/sessionId extracted, non-fatal errors and unknown event types tolerated', () => {
  const collector = createCodexCollector();
  const lines = [
    { type: 'thread.started', thread_id: 'th-collect' },
    { type: 'turn.started' },
    // In-progress (not completed) items must NOT win over a later completed one.
    { type: 'item.started', item: { type: 'agent_message', text: 'IN PROGRESS, MUST NOT WIN' } },
    { type: 'item.completed', item: { type: 'reasoning', text: 'thinking about it' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'first answer' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'ls -la' } },
    { type: 'item.completed', item: { type: 'file_change', path: 'src/foo.ts', kind: 'update' } },
    // Non-fatal item-level error: tolerated, must not fail the turn.
    { type: 'item.completed', item: { type: 'error', message: 'non-fatal tool hiccup' } },
    { type: 'item.completed', item: { type: 'todo_list', items: [] } },
    // Unrecognized top-level and item types: ignored, not thrown.
    { type: 'some.future.event.type', payload: 'ignored' },
    { type: 'turn.completed', usage: { input_tokens: 5 } },
  ];
  for (const line of lines) collector.push(JSON.stringify(line) + '\n');
  const result = collector.finish();
  assert.equal(result.sessionId, 'th-collect');
  assert.equal(result.message, 'final answer');
  assert.equal(result.thoughts, 'thinking about it');
  assert.deepEqual(result.toolCalls, [
    { name: 'shell', input: { command: 'ls -la' } },
    { name: 'file_change', input: { path: 'src/foo.ts', kind: 'update' } },
  ]);
  assert.equal(result.fatalError, null);
  assert.equal(result.turnFailedReason, null);
});

test('a `turn.failed` event produces status:failed with the failure reason as the error', async () => {
  const { dir, bin } = completingBin([
    { type: 'thread.started', thread_id: 'th-tf' },
    { type: 'turn.failed', error: { message: 'model overloaded' } },
  ]);
  try {
    const result = await startCodexRun({
      jobId: 'j-turnfail', cwd: dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: bin },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /model overloaded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a top-level `error` event produces status:failed with the error message', async () => {
  const { dir, bin } = completingBin([
    { type: 'thread.started', thread_id: 'th-err' },
    { type: 'error', message: 'fatal codex error' },
  ]);
  try {
    const result = await startCodexRun({
      jobId: 'j-fatalerr', cwd: dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: bin },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /fatal codex error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startCodexRun terminates a stuck CLI at the configured timeout', async () => {
  const { dir, bin } = fakeBin(`
    setInterval(() => {}, 1000);
  `);
  try {
    const result = await startCodexRun({
      jobId: 'j-timeout',
      cwd: dir,
      prompt: 'hello',
      env: {
        ...process.env,
        CODEX_BIN: bin,
        AGENT_COMPANION_CODEX_TIMEOUT_MS: '50',
      },
    });
    assert.equal(result.status, 'timeout');
    assert.equal(result.timedOut, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelCodexRun signals the running child and the run resolves as cancelled', async () => {
  const { dir, bin } = fakeBin(`
    setInterval(() => {}, 1000);
  `);
  try {
    const runPromise = startCodexRun({
      jobId: 'j-cancel', cwd: dir, prompt: 'hello',
      env: { ...process.env, CODEX_BIN: bin },
    });
    // Give the child a moment to actually spawn before cancelling it.
    await new Promise((r) => setTimeout(r, 50));
    const cancelResp = cancelCodexRun('j-cancel');
    assert.equal(cancelResp.ok, true);
    const result = await runPromise;
    assert.equal(result.status, 'cancelled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression for the review blocker: a child that exits before draining stdin
// makes Node emit EPIPE *asynchronously* on the stdin stream once the prompt
// exceeds the OS pipe buffer (~64 KB on macOS). Without codex-runtime's no-op
// stdin error listener that stream error is an uncaughtException that kills
// the whole bridge process — so this test would not merely fail, it would
// crash the test runner.
test('a child that exits without reading a large stdin prompt resolves failed instead of crashing the process', async () => {
  const { dir, bin } = fakeBin(`
    process.exit(1);
  `);
  try {
    const result = await startCodexRun({
      jobId: 'j-epipe', cwd: dir, prompt: 'x'.repeat(200 * 1024),
      env: { ...process.env, CODEX_BIN: bin },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The line-buffered parser's two core streaming behaviors: reassembling a
// JSON line split across push() chunks, and flushing an unterminated final
// line at finish(). A buffer-less mutation of the collector fails both.
test('createCodexCollector reassembles chunk-split lines and flushes an unterminated final line', () => {
  const collector = createCodexCollector();
  collector.push('{"type":"thread.started","thread_id":"th-split"}\n{"type":"item.compl');
  collector.push('eted","item":{"type":"agent_message","text":"split across chunks"}}\n');
  // Final line arrives with no trailing newline — only finish() may surface it.
  collector.push('{"type":"item.completed","item":{"type":"agent_message","text":"unterminated final"}}');
  const result = collector.finish();
  assert.equal(result.sessionId, 'th-split');
  assert.equal(result.message, 'unterminated final');
});
