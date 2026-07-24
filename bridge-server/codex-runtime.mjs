import { spawn } from 'node:child_process';

import { appendCapped, truncateChars, MAX_SUMMARY_CHARS } from '../lib/text-utils.mjs';

// No digest writer here — codex reuses `writeOpenCodeDigest` from
// opencode-runtime.mjs (its header is already target-neutral: `# ${job.target
// || 'opencode'} job ...`), so this module only imports what a CLI adapter
// needs to spawn/collect/cancel. See docs/ARCHITECTURE.md for the shared
// digest-routing rationale.

const running = new Map();
const cancelRequested = new Set();
const MAX_CAPTURE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 40 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5_000;

export function resolveCodexBin(env = process.env) {
  return String(env.CODEX_BIN || 'codex').trim() || 'codex';
}

// One resolver for sandbox + network — both are expressed as a single argv
// segment for `codex exec`, so splitting them into two functions would just
// invite the two to drift. Reads AGENT_COMPANION_CODEX_SANDBOX_MODE and
// AGENT_COMPANION_CODEX_NETWORK.
//
//   unset / 'workspace-write' / anything unrecognized → workspace-write.
//     Codex's true "safe" floor (read-only) cannot write files, so
//     workspace-write is the minimum viable mode for the delegated edit work
//     this bridge exists to run. An unrecognized string NEVER reaches
//     `--sandbox` verbatim and never escalates — it silently behaves like
//     unset (source:'fallback'). Only the literal string 'workspace-write'
//     counts as an explicit env choice (source:'env').
//   'read-only'          → `--sandbox read-only` (no network key: meaningless
//                           in a mode that can't write or reach the network).
//   'danger-full-access'  → `--sandbox danger-full-access` (same reasoning).
//   'bypass'              → `--dangerously-bypass-approvals-and-sandbox`
//                           INSTEAD OF `-s` — removes the sandbox entirely
//                           (the documented purpose: externally-sandboxed
//                           environments, e.g. the bridge itself already
//                           running under sandbox-exec, which cannot nest a
//                           second Seatbelt profile).
//
// Network in workspace-write defaults ON (codex's own `codex exec` default is
// OFF) so a delegated job can `npm install` without a confusing failure.
// AGENT_COMPANION_CODEX_NETWORK=off emits an EXPLICIT `=false` override —
// merely omitting the flag would defer to the user's config.toml and could
// fail open for a user who enabled network there.
export function resolveCodexSandbox(env = process.env) {
  const raw = String(env.AGENT_COMPANION_CODEX_SANDBOX_MODE || '').trim().toLowerCase();

  if (raw === 'read-only') {
    return { mode: 'read-only', network: null, args: ['--sandbox', 'read-only'], source: 'env' };
  }
  if (raw === 'danger-full-access') {
    return { mode: 'danger-full-access', network: null, args: ['--sandbox', 'danger-full-access'], source: 'env' };
  }
  if (raw === 'bypass') {
    return { mode: 'bypass', network: null, args: ['--dangerously-bypass-approvals-and-sandbox'], source: 'env' };
  }

  const source = raw === 'workspace-write' ? 'env' : raw ? 'fallback' : 'default';
  const networkOff = String(env.AGENT_COMPANION_CODEX_NETWORK || '').trim().toLowerCase() === 'off';
  const network = !networkOff;
  return {
    mode: 'workspace-write',
    network,
    // ONE argv token per `-c key=value` pair — no shell quoting needed
    // (spawn, not shell).
    args: ['--sandbox', 'workspace-write', '-c', `sandbox_workspace_write.network_access=${network}`],
    source,
  };
}

export function resolveCodexTimeoutMs(env = process.env) {
  const raw = String(env.AGENT_COMPANION_CODEX_TIMEOUT_MS || '').trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return n;
}

export function codexRuntimeInfo(env = process.env) {
  const sandbox = resolveCodexSandbox(env);
  return {
    bin: resolveCodexBin(env),
    sandbox: { mode: sandbox.mode, network: sandbox.network, source: sandbox.source },
    timeout_ms: resolveCodexTimeoutMs(env),
  };
}

export function codexPromptId(jobId) {
  return `codex-${jobId}`;
}

export function startCodexRun({
  jobId,
  cwd,
  prompt,
  model = null,
  env = process.env,
  onStarted = () => {},
}) {
  const bin = resolveCodexBin(env);
  const sandbox = resolveCodexSandbox(env);
  const timeoutMs = resolveCodexTimeoutMs(env);
  // Mandatory flags: sandbox segment (write access), --skip-git-repo-check
  // (the bridge dispatches into arbitrary cwds; codex refuses non-git dirs by
  // default), -C <cwd> (the --dir analog; belt-and-suspenders with spawn's
  // own cwd option below), --json (JSONL event stream). Prompt arrives via
  // stdin ('-') rather than argv to avoid argv-size limits on large formatted
  // prompts.
  const args = [
    'exec',
    ...sandbox.args,
    '--skip-git-repo-check',
    '-C', cwd,
    '--json',
    ...(model ? ['-m', model] : []),
    '-',
  ];

  let timedOut = false;
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.set(jobId, child);
  onStarted({
    pid: child.pid || null,
    promptId: codexPromptId(jobId),
    command: bin,
    args,
  });

  // An early-exiting child (bad model id, expired auth) emits EPIPE
  // asynchronously on stdin once the prompt exceeds the OS pipe buffer;
  // without a listener that stream error would crash the whole bridge.
  child.stdin?.on('error', () => {});
  try {
    child.stdin?.write(prompt == null ? '' : String(prompt));
    child.stdin?.end();
  } catch { /* best-effort — write failures degrade to the child's exit result */ }

  let stdout = '';
  let stderr = '';
  const collector = createCodexCollector();
  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stdout = appendCapped(stdout, text, MAX_CAPTURE_BYTES);
    collector.push(text);
  });
  child.stderr?.on('data', (chunk) => {
    // codex logs (and the login-status-style stderr banners) land here, not
    // in the --json stream.
    stderr = appendCapped(stderr, chunk.toString('utf8'), MAX_CAPTURE_BYTES);
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      const hardKill = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, DEFAULT_KILL_GRACE_MS);
      if (hardKill.unref) hardKill.unref();
    }, timeoutMs);
    if (timeout.unref) timeout.unref();

    const finish = (result) => {
      clearTimeout(timeout);
      running.delete(jobId);
      cancelRequested.delete(jobId);
      resolve(result);
    };

    child.on('error', (err) => {
      finish({
        status: 'failed',
        error: err.message,
        summary: null,
        sessionId: null,
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        timedOut,
        timeoutMs,
      });
    });
    child.on('close', (code, signal) => {
      const collected = collector.finish();
      const summary = summarizeCodexOutput(stderr, collected);
      const cancelled = cancelRequested.has(jobId) || signal === 'SIGTERM' || signal === 'SIGKILL';
      const turnFailed = !!(collected.fatalError || collected.turnFailedReason);
      const status = timedOut
        ? 'timeout'
        : cancelled
          ? 'cancelled'
          : (code === 0 && !turnFailed)
            ? 'completed'
            : 'failed';
      finish({
        status,
        error: status === 'failed' ? (summary.error || `codex exited with code ${code}`) : null,
        summary,
        sessionId: collected.sessionId || null,
        stdout,
        stderr,
        exitCode: code,
        signal,
        timedOut,
        timeoutMs,
      });
    });
  });
}

export function cancelCodexRun(jobId, pid = null) {
  const child = running.get(jobId);
  if (child && !child.killed) {
    cancelRequested.add(jobId);
    child.kill('SIGTERM');
    return { ok: true, reason: 'signalled-child', pid: child.pid || pid || null };
  }
  if (pid) {
    try {
      cancelRequested.add(jobId);
      process.kill(pid, 'SIGTERM');
      return { ok: true, reason: 'signalled-pid', pid };
    } catch (err) {
      return { ok: false, reason: err.message, pid };
    }
  }
  return { ok: false, reason: 'no running Codex process found', pid: null };
}

// Build the summary object consumed by server.mjs (formatTerminalContent,
// isEmptyCompletedSummary, writeOpenCodeDigest). `error` is intentionally
// unconditional (not gated on overall status) so any captured stderr noise
// surfaces even on a completed run — mirrors summarizeOpenCodeOutput.
function summarizeCodexOutput(stderr, collected) {
  return {
    message: truncateChars(collected.message, MAX_SUMMARY_CHARS),
    thoughts: collected.thoughts,
    toolCalls: collected.toolCalls,
    stopReason: collected.eventCount > 0 ? 'json' : 'text',
    error: collected.fatalError || collected.turnFailedReason || stderr.trim() || null,
  };
}

// Line-buffered parser for the `codex exec --json` ThreadEvent stream (typed
// thread/turn/item schema on 0.145.0 — distinct from the older
// session_configured/agent_message EventMsg schema that only appears in
// on-disk rollout files). Exported for tests. Tolerates unknown event/item
// types by ignoring them.
//
//   thread.started{thread_id}        → sessionId (persists as
//                                       companionSessionId; v2 exec-resume
//                                       continuity groundwork).
//   item.completed{item:{type,...}}  → only COMPLETED items are terminal
//                                       material (mirrors opencode's "last
//                                       completed wins"); item.started/
//                                       item.updated are progress-only and
//                                       ignored here.
//     agent_message   → .text is the final answer; last completed one wins.
//     reasoning        → .text joined into thoughts ('' fallback — field name
//                        is unverified against a real turn, per D10; the dry
//                        run is the deferred JSONL-shape validation step).
//     command_execution → toolCalls entry {name:'shell', input:{command}}.
//     file_change      → one toolCalls entry per file, {name:'file_change',
//                        input:{path, kind}} so formatTerminalContent's
//                        "Files touched" `tc.input.path` extraction works.
//     mcp_tool_call    → toolCalls entry.
//     web_search       → toolCalls entry.
//     todo_list        → informational only, not surfaced in toolCalls.
//     error            → NON-fatal (tolerated; does not fail the turn) —
//                        only the top-level `error` type and `turn.failed`
//                        do that.
//   turn.completed          → recognized and ignored (usage stats have no
//                             v1 consumer; re-add capture with the digest
//                             enrichment pass if it lands).
//   turn.failed             → fatal; reason becomes the failure message.
//   error (top-level)       → fatal; .message becomes the failure message.
export function createCodexCollector() {
  let pending = '';
  let eventCount = 0;
  let sessionId = null;
  let lastAgentMessage = '';
  const thoughts = [];
  const toolCalls = [];
  let fatalError = null;
  let turnFailedReason = null;

  return {
    push(text) {
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    },
    finish() {
      if (pending.trim()) consumeLine(pending);
      return {
        eventCount,
        sessionId,
        message: lastAgentMessage,
        thoughts: thoughts.join('\n'),
        toolCalls,
        fatalError,
        turnFailedReason,
      };
    },
  };

  function consumeLine(line) {
    const clean = line.trim();
    if (!clean) return;
    let event;
    try { event = JSON.parse(clean); }
    catch { return; }
    eventCount++;
    const type = String(event?.type || '');
    if (type === 'thread.started') {
      sessionId = event.thread_id || sessionId;
      return;
    }
    if (type === 'turn.completed') return;
    if (type === 'turn.failed') {
      turnFailedReason = event.error?.message || event.error || event.reason || event.message || 'codex turn failed';
      return;
    }
    if (type === 'error') {
      fatalError = event.message || event.error || 'codex reported a fatal error';
      return;
    }
    if (type === 'item.completed') {
      consumeItem(event.item);
      return;
    }
    // item.started / item.updated / turn.started / any unrecognized type —
    // ignored (progress-only, not terminal-summary material).
  }

  function consumeItem(item) {
    if (!item || typeof item !== 'object') return;
    const type = String(item.type || '');
    if (type === 'agent_message') {
      if (typeof item.text === 'string') lastAgentMessage = item.text;
      return;
    }
    if (type === 'reasoning') {
      if (typeof item.text === 'string' && item.text) thoughts.push(item.text);
      return;
    }
    if (type === 'command_execution') {
      toolCalls.push({ name: 'shell', input: { command: item.command ?? null } });
      return;
    }
    if (type === 'file_change') {
      for (const change of fileChangeToolCalls(item)) toolCalls.push(change);
      return;
    }
    if (type === 'mcp_tool_call') {
      toolCalls.push({ name: item.tool || item.name || 'mcp_tool_call', input: item.input || item.args || {} });
      return;
    }
    if (type === 'web_search') {
      toolCalls.push({ name: 'web_search', input: { query: item.query ?? null } });
      return;
    }
    // todo_list (informational only) and a non-fatal item-level `error` are
    // both tolerated without contributing to toolCalls or failing the turn.
  }
}

// A file_change item may describe one file or a batch (shape unconfirmed
// against a real turn — see D10's deferred dry-run). Normalize either shape
// to one toolCalls entry per file so downstream "Files touched" extraction
// never has to branch on it.
function fileChangeToolCalls(item) {
  const files = Array.isArray(item.files) && item.files.length ? item.files : [item];
  return files
    .filter((f) => f && (f.path || f.file))
    .map((f) => ({ name: 'file_change', input: { path: f.path || f.file, kind: f.kind || f.status || null } }));
}
