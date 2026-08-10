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
  _resetForTest,
  _setForTest,
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
  // A command_execution entry now carries its outcome alongside the
  // invocation (see the enrichment test at the end of this file). With no
  // `status` on the wire the fallback names the EVENT, not the exit outcome.
  assert.deepEqual(result.toolCalls, [
    { name: 'shell', input: { command: 'ls -la' }, status: 'completed', exit_code: null, aggregated_output: null },
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

// W1.1 — the thread id must be knowable while the run is still in flight, not
// only in the resolved result. `thread.started` is line 1 of the stream at
// +0.20 s in 12/12 measured 0.147.0 runs, so a caller that only learns the id
// at resolve time loses it on exactly the runs it most needs it for.
test('onSession fires with the thread id while the run is still in flight, once per id', async () => {
  const { dir, bin } = fakeBin(`
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => {
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'th-early' }));
      // A duplicate line must not re-fire the callback.
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'th-early' }));
      setTimeout(() => {
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
      }, 150);
    });
  `);
  try {
    const seen = [];
    let settled = false;
    let settledWhenSeen = null;
    let announce;
    const firstSession = new Promise((r) => { announce = r; });
    const runPromise = startCodexRun({
      jobId: 'j-onsession', cwd: dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: bin },
      onSession: (threadId) => {
        if (settledWhenSeen === null) settledWhenSeen = settled;
        seen.push(threadId);
        announce();
      },
    });
    runPromise.then(() => { settled = true; });
    await firstSession;
    assert.equal(settledWhenSeen, false, 'onSession fired before the run resolved');
    const result = await runPromise;
    assert.deepEqual(seen, ['th-early'], 'a repeated thread.started does not re-fire onSession');
    assert.equal(result.sessionId, 'th-early');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A throwing consumer runs inside the child's stdout 'data' handler, where an
// exception is an uncaughtException — this test would crash the runner, not
// merely fail, if the callback were not isolated.
test('a throwing onSession consumer neither crashes the process nor derails the run', async () => {
  const { dir, bin } = completingBin([
    { type: 'thread.started', thread_id: 'th-throwing' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'survived' } },
    { type: 'turn.completed', usage: {} },
  ]);
  try {
    const result = await startCodexRun({
      jobId: 'j-onsession-throw', cwd: dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: bin },
      onSession: () => { throw new Error('consumer blew up'); },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.sessionId, 'th-throwing');
    assert.equal(result.summary.message, 'survived');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// W0.1 — the clock seam. macOS counts machine sleep in libuv's timer clock and
// linux does not, so a real clock cannot express a suspend-crossing duration
// on CI in either direction; injection is the only way to assert on one.
test('the injectable clock seam supplies the adapter-measured duration', async () => {
  const { dir, bin } = completingBin([{ type: 'turn.completed', usage: {} }]);
  // Exactly two reads per run: the pre-spawn stamp and the one in finish().
  const ticks = [1_000, 61_000];
  _setForTest({ now: () => (ticks.length ? ticks.shift() : 61_000) });
  try {
    const result = await startCodexRun({
      jobId: 'j-clock', cwd: dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: bin },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.durationMs, 60_000);
  } finally {
    _resetForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

// W0.2 — the cancelRequested leak. The pid branch has no child whose close
// handler would clear the set, so marking before the kill left the id in it
// forever when process.kill threw; the next run under that jobId then resolved
// `cancelled` with nothing having been cancelled.
test('a cancelCodexRun pid kill that throws leaves no cancellation marked behind', async () => {
  const { dir, bin } = completingBin([
    { type: 'thread.started', thread_id: 'th-leak' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'ran normally' } },
    { type: 'turn.completed', usage: {} },
  ]);
  try {
    // ESRCH — nothing is running under this jobId and the pid does not exist.
    const cancelResp = cancelCodexRun('j-leak', 2147483647);
    assert.equal(cancelResp.ok, false);
    const result = await startCodexRun({
      jobId: 'j-leak', cwd: dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: bin },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.error, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// W1.3′ — `error` used to be gated on status === 'failed', so a timeout or a
// cancellation rendered with a blank error even when the reason was captured.
test('timeout and cancelled terminals report their reason; completed still reports none', async () => {
  const silent = fakeBin(`
    setInterval(() => {}, 1000);
  `);
  // Writes stderr first, then announces itself on stdout a tick later, so the
  // parent can wait for a signal the child controls instead of racing a wall
  // clock against node's own startup (which is what made a timeout-based
  // version of this assertion flaky under a loaded suite).
  const noisy = fakeBin(`
    process.stderr.write('codex: stalled talking to the model\\n');
    setTimeout(() => {
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'th-noisy' }));
    }, 20);
    setInterval(() => {}, 1000);
  `);
  const clean = completingBin([
    { type: 'item.completed', item: { type: 'agent_message', text: 'all good' } },
    { type: 'turn.completed', usage: {} },
  ]);
  try {
    // Nothing was captured, so the adapter synthesizes an honest reason for
    // each non-completed terminal rather than handing the renderer a null.
    const timedOut = await startCodexRun({
      jobId: 'j-timeout-err', cwd: silent.dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: silent.bin, AGENT_COMPANION_CODEX_TIMEOUT_MS: '50' },
    });
    assert.equal(timedOut.status, 'timeout');
    assert.match(timedOut.error, /timeout/);

    const bareCancel = startCodexRun({
      jobId: 'j-cancel-err', cwd: silent.dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: silent.bin },
    });
    await new Promise((r) => setTimeout(r, 50));
    cancelCodexRun('j-cancel-err');
    const cancelled = await bareCancel;
    assert.equal(cancelled.status, 'cancelled');
    assert.match(cancelled.error, /cancelled/);

    // And when something WAS captured, that is what a non-failed terminal
    // reports — this is the case that used to render blank.
    let announce;
    const started = new Promise((r) => { announce = r; });
    const noisyCancel = startCodexRun({
      jobId: 'j-cancel-stderr', cwd: noisy.dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: noisy.bin },
      onSession: () => announce(),
    });
    await started;
    cancelCodexRun('j-cancel-stderr');
    const cancelledNoisy = await noisyCancel;
    assert.equal(cancelledNoisy.status, 'cancelled');
    assert.match(cancelledNoisy.error, /stalled talking to the model/);

    // A clean run is unchanged: stderr noise stays in summary.error for the
    // digest and never becomes a top-level failure.
    const completed = await startCodexRun({
      jobId: 'j-completed-err', cwd: clean.dir, prompt: 'x',
      env: { ...process.env, CODEX_BIN: clean.bin },
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.error, null);
  } finally {
    for (const t of [noisy, silent, clean]) rmSync(t.dir, { recursive: true, force: true });
  }
});

// W1.2′ collector amendment. `item.started` is the ONLY event that exists
// while a command runs (12 s gaps measured on 0.147.0), and `item.completed`
// is what distinguishes a failed command from a successful one — before this,
// both rendered as a bare `{command}`.
test('command_execution carries in-flight state, status, exit_code and truncated output, keyed per turn', () => {
  const collector = createCodexCollector();
  const bigOutput = 'y'.repeat(6_000);
  const lines = [
    { type: 'thread.started', thread_id: 'th-cmd' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'npm run build' } },
    { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'npm run build', status: 'failed', exit_code: 1, aggregated_output: bigOutput } },
    // Started and never completed — the shape a run that dies mid-command
    // leaves behind. It must survive as the record of what was running.
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'sleep 30' } },
    // Second turn: `item.id` restarts at item_0, so this must NOT fold into
    // the first turn's entry.
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'echo hi' } },
    { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'echo hi', status: 'completed', exit_code: 0, aggregated_output: 'hi\n' } },
  ];
  for (const line of lines) collector.push(JSON.stringify(line) + '\n');
  const result = collector.finish();

  assert.equal(result.toolCalls.length, 3, 'one entry per command — item.started never double-counts');
  const [failed, inFlight, ok] = result.toolCalls;

  assert.equal(failed.input.command, 'npm run build');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exit_code, 1);
  assert.ok(failed.aggregated_output.length < bigOutput.length, 'aggregated_output is truncated');
  assert.match(failed.aggregated_output, /\[truncated \d+ chars\]$/);

  assert.deepEqual(inFlight, {
    name: 'shell', input: { command: 'sleep 30' }, status: 'in_progress', exit_code: null, aggregated_output: null,
  });

  assert.deepEqual(ok, {
    name: 'shell', input: { command: 'echo hi' }, status: 'completed', exit_code: 0, aggregated_output: 'hi\n',
  });

  // The outcome fields sit on the entry, never inside `input` — that keeps
  // formatTerminalContent's `tc.input.path` extraction (file_change entries)
  // collision-free.
  assert.deepEqual(Object.keys(ok.input), ['command']);
});
