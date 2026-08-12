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
// A single `aggregated_output` can be a whole build log; the toolCalls entry
// is a digest-facing artifact, not a transcript, so it keeps only a head.
const MAX_COMMAND_OUTPUT_CHARS = 4_000;

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

// ---------------------------------------------------------------------------
// Injectable clock seam
// ---------------------------------------------------------------------------
//
// Same shape as opencode-server-runtime.mjs's `_impl` record and
// daemon-client.mjs's impl pointers: one module-local object, swapped
// wholesale by tests, restored by _resetForTest.
//
// Why the adapter reads the clock through an indirection rather than calling
// Date.now() inline: libuv's timer clock is `mach_continuous_time()` on darwin
// (which counts machine sleep) and `CLOCK_MONOTONIC` on linux (which does
// not), so the two platforms have OPPOSITE suspend semantics. Any duration
// this adapter reports — and any idle threshold later built on one — is
// therefore not exercisable on linux CI in a way that reflects production
// behaviour on macOS. Injection is the only way to test it; this is a
// portability seam, not a flakiness workaround.
const realNow = () => Date.now();

let _impl = { now: realNow };

export function _setForTest(overrides = {}) {
  _impl = { ..._impl, ...overrides };
}

export function _resetForTest() {
  _impl = { now: realNow };
}

export function startCodexRun({
  jobId,
  cwd,
  prompt,
  model = null,
  env = process.env,
  onStarted = () => {},
  // Fires the moment `thread.started` arrives (line 1 of the stream, +0.20 s
  // in 12/12 measured 0.147.0 runs) — long before this promise resolves, so a
  // caller can persist a resumable thread id that survives the run dying.
  onSession = () => {},
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
  const startedAt = _impl.now();
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
  const collector = createCodexCollector({ onSession });
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
      // The adapter's own view of the child's lifetime, read through the
      // injectable clock above (server.mjs separately measures the whole
      // worker, prompt formatting included).
      resolve({ ...result, durationMs: _impl.now() - startedAt });
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
      // Every NON-completed terminal states its reason. This used to be gated
      // on `status === 'failed'`, so a `timeout` or `cancelled` job rendered
      // with a blank error even when the stream or stderr had said exactly
      // what went wrong. `completed` still reports null — stderr banners are
      // noise on a good run, and summary.error carries them for the digest.
      const failureReason = summary.error
        || (timedOut
          ? `codex exec exceeded its ${timeoutMs} ms timeout`
          : cancelled
            ? `codex exec was cancelled (${signal || 'no signal'})`
            : `codex exited with code ${code}`);
      finish({
        status,
        error: status === 'completed' ? null : failureReason,
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
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      return { ok: false, reason: err.message, pid };
    }
    // Mark AFTER the kill lands. Marking first leaked the jobId permanently
    // whenever process.kill threw (ESRCH on a reaped pid, EPERM on a foreign
    // one): unlike the child branch above, nothing here owns a process whose
    // close handler would clear the set — so a later run reusing that jobId
    // would resolve `cancelled` for no reason.
    cancelRequested.add(jobId);
    return { ok: true, reason: 'signalled-pid', pid };
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
// thread/turn/item schema — distinct from the older
// session_configured/agent_message EventMsg schema that only appears in
// on-disk rollout files). Exported for tests. Tolerates unknown event/item
// types by ignoring them.
//
// MEASURED CONTRACT — codex 0.147.0, census over ~24 real runs on this
// machine. What the stream actually emits:
//
//   thread.started{thread_id}   → line 1 of every run, at +0.20 s in 12/12
//                                 measured runs, and the id is stable across
//                                 resumes. Fires `onSession` on arrival so the
//                                 caller can persist a resumable id long
//                                 before the run resolves.
//   turn.started                → turn boundary. `item.id` is TURN-scoped and
//                                 restarts at `item_0` on every turn including
//                                 resumes, so nothing may be keyed on it
//                                 across turns (hence the turn counter below).
//   item.started{command_execution}
//                               → carries the FULL command and is the ONLY
//                                 event that exists while a command runs
//                                 (12 s gaps observed). Recorded as an
//                                 in-flight toolCalls entry so a long build
//                                 does not look frozen, and so a run that dies
//                                 mid-command still names the command.
//   item.completed{command_execution}
//                               → adds status ('completed'|'failed'),
//                                 exit_code and aggregated_output; folded into
//                                 the entry item.started opened, so a failed
//                                 command no longer renders identically to a
//                                 successful one.
//   item.completed{agent_message}
//                               → the answer, emitted ATOMICALLY at turn end;
//                                 last completed one wins.
//   item.completed{error}       → NON-fatal (tolerated; does not fail the
//                                 turn) — only the top-level `error` type and
//                                 `turn.failed` do that.
//   turn.completed              → recognized and ignored (usage stats have no
//                                 consumer here). Note its
//                                 usage.reasoning_output_tokens is non-zero on
//                                 reasoning turns, which PROVES reasoning
//                                 happens even though no reasoning item ever
//                                 streams on this transport.
//   turn.failed                 → fatal; reason becomes the failure message.
//   error (top-level)           → fatal; .message becomes the failure message.
//
// DEFINED BUT NEVER OBSERVED on 0.147.0 across that census: the `reasoning`,
// `file_change`, `mcp_tool_call`, `web_search` and `todo_list` item types —
// and `item.updated`, which does not occur at all. Their branches below are
// deliberate forward-compatible dead code, NOT validated behaviour; the
// `file_change` shape in particular is still a guess (see
// fileChangeToolCalls). Re-run the census before building anything on them.
export function createCodexCollector({ onSession = () => {} } = {}) {
  let pending = '';
  let eventCount = 0;
  let sessionId = null;
  let lastAgentMessage = '';
  const thoughts = [];
  const toolCalls = [];
  let fatalError = null;
  let turnFailedReason = null;
  // Turn counter + in-flight command index. `item.id` alone is not a key: it
  // restarts at `item_0` every turn, so `${turnSeq}:${item.id}` is the
  // narrowest scope in which an item.started can be matched to its
  // item.completed.
  let turnSeq = 0;
  const inFlightCommands = new Map();

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
      const threadId = event.thread_id || null;
      if (threadId && threadId !== sessionId) {
        sessionId = threadId;
        // Swallow a throwing consumer: this runs inside the child's stdout
        // 'data' handler, where an exception is an uncaughtException that
        // takes the whole bridge down (same reasoning as the no-op stdin
        // error listener in startCodexRun).
        try { onSession(threadId); } catch { /* consumer's problem, not the stream's */ }
      }
      return;
    }
    if (type === 'turn.started') {
      turnSeq++;
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
    if (type === 'item.started') {
      consumeStartedItem(event.item);
      return;
    }
    // item.updated (never emitted on 0.147.0) and any unrecognized type —
    // ignored.
  }

  // The only in-flight signal worth keeping: a command_execution that has
  // started but not completed. Every other item type reaches its terminal
  // form in one hop, so recording its `started` twin would only double-count
  // toolCalls.
  function consumeStartedItem(item) {
    if (!item || typeof item !== 'object') return;
    if (String(item.type || '') !== 'command_execution') return;
    const key = commandKey(item);
    // An item with no id cannot be correlated to its completion; leave those
    // to item.completed alone rather than emitting a duplicate entry.
    if (!key || inFlightCommands.has(key)) return;
    const entry = commandEntry(item.command);
    inFlightCommands.set(key, entry);
    toolCalls.push(entry);
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
      const key = commandKey(item);
      const started = key ? inFlightCommands.get(key) : null;
      const entry = started || commandEntry(item.command);
      if (item.command != null) entry.input.command = item.command;
      // A missing `status` names the EVENT ('the item completed'), never the
      // exit outcome — `exit_code` stays the authoritative signal there.
      entry.status = typeof item.status === 'string' && item.status ? item.status : 'completed';
      entry.exit_code = item.exit_code ?? null;
      entry.aggregated_output = typeof item.aggregated_output === 'string' && item.aggregated_output
        ? truncateChars(item.aggregated_output, MAX_COMMAND_OUTPUT_CHARS)
        : null;
      if (started) inFlightCommands.delete(key);
      else toolCalls.push(entry);
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

  // Outcome fields live on the ENTRY, not inside `input`: `input` stays the
  // invocation, which is what formatTerminalContent's "Files touched"
  // `tc.input.path` extraction reads for file_change entries, so nothing a
  // command reports back can ever collide with it. `in_progress` is a
  // bridge-side state — codex has no such status — and is what a run that
  // died mid-command leaves behind.
  function commandEntry(command) {
    return {
      name: 'shell',
      input: { command: command ?? null },
      status: 'in_progress',
      exit_code: null,
      aggregated_output: null,
    };
  }

  function commandKey(item) {
    const id = item.id == null ? '' : String(item.id);
    return id ? `${turnSeq}:${id}` : null;
  }
}

// One file-change item, on either transport, to the one entry shape the digest
// reads: `{name:'file_change', input:{path, kind}}`. That output contract is
// what is worth a single home — `server.mjs`'s "Files touched" extraction reads
// `tc.input.path` and does not branch on which transport produced it — so this
// knows BOTH inbound shapes rather than being copied per adapter.
//
// The app-server shape is MEASURED, from `codex app-server generate-json-schema`
// (0.147.0, the pinned version): the `fileChange` ThreadItem is
// `{changes: FileUpdateChange[], id, status, type}` with `changes` required, and
// `FileUpdateChange` is `{diff, kind, path}` — all three required. `kind` is an
// OBJECT there (`PatchChangeKind`: `{type:'add'|'delete'|'update', move_path?}`),
// so it is unwrapped to its tag: `input.kind` holds a string on the exec side and
// `[object Object]` in a digest would be the whole of what a reader saw.
//
// The exec shape is still a guess: no `file_change` item appeared in the ~24-run
// 0.147.0 census (every probe ran without workspace-write, which is what produces
// one), so `{files:[…]}` vs `{path,kind}` is unvalidated. It is kept exactly as it
// was — an exec item has no `changes` array, so it cannot reach the branch above.
export function fileChangeToolCalls(item) {
  if (Array.isArray(item.changes)) {
    return item.changes
      .filter((change) => change && change.path)
      .map((change) => ({ name: 'file_change', input: { path: change.path, kind: patchChangeKind(change.kind) } }));
  }
  const files = Array.isArray(item.files) && item.files.length ? item.files : [item];
  return files
    .filter((f) => f && (f.path || f.file))
    .map((f) => ({ name: 'file_change', input: { path: f.path || f.file, kind: f.kind || f.status || null } }));
}

// `add` / `delete` / `update` out of the tagged object the app-server sends, or
// the string itself if a transport ever sends a bare one.
function patchChangeKind(kind) {
  if (typeof kind === 'string') return kind || null;
  return typeof kind?.type === 'string' ? kind.type : null;
}
