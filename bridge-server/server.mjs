#!/usr/bin/env node
// copilot-bridge MCP server (v6.1 — clean-break subagent-isolated architecture)
//
// Single MCP tool: `copilot` with actions send | wait | status | reply | cancel.
// No start/stop/pause/session-gate — this server is spawned inline per invocation
// from the copilot-companion subagent's frontmatter, so there is no separate
// activation lifecycle. Model selection and rubber-duck critique are internal
// server concerns and never exposed through the public schema.
//
// `send` enqueues the task and returns `status=still_running` with the job_id
// immediately (no blocking — the worker keeps running in the background). The
// subagent then loops on `wait` until terminal, emitting a short line between
// iterations to reset the host's stream-idle watchdog. Both hosts have
// generous per-tool-call budgets (Claude 600s, Codex 120s per
// `codex-rs/codex-mcp/src/rmcp_client.rs:79`); a single wait bounded by
// clampWaitSec (≤1200s) is fine for both hosts — Claude Code's 600s
// stream-idle watchdog is satisfied by the companion's per-iteration
// "still running" emission, and Codex callers raise tool_timeout_sec.
//
// Completion surfacing: each terminal/alert event is appended to a JSONL queue
// file with `consumed:false`; the drain script (invoked from the subagent's
// frontmatter hooks) filters out `consumed:true` and injects unconsumed orphans
// into the subagent's context. Wait-terminal responses mark the job's entries
// consumed so the subagent never sees the same event twice.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  appendFileSync, readFileSync, writeFileSync,
  renameSync, existsSync, realpathSync, chmodSync, unlinkSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ensureRuntime,
  promptBg,
  watchPrompt,
  inspectPrompt,
  cancelPrompt,
  replyPrompt,
  selectedRuntimeAdapter,
} from './copilot-runtime.mjs';
import {
  log,
  formatPrompt,
  appendRubberDuckReview,
  shouldUseFleet,
  validateCopilotArgs,
} from './validation.mjs';
import {
  readDefaultModel,
  isModelAllowed,
  readThreadSid, writeThreadSid, clearThread, listThreads,
  readHostSessionThread, writeHostSessionThread,
  writeJob, readJob, listJobsForSession, deleteJob,
} from '../lib/state.mjs';
import { sanitizeHostSessionId } from '../lib/host.mjs';
import { queuePath, promptEventsPath, runtimeDir, bridgeLogFile, daemonLogFile } from '../lib/runtime-paths.mjs';
import { createReqId, withReq, logEvent } from '../lib/log.mjs';
import { writeDigest, digestPath } from '../lib/prompt-digest.mjs';

// --- Queue (replaces dev-channel notifications) -----------------------------

// Resolved per-call so tests can flip COPILOT_QUEUE_PATH before each
// scenario. The const-at-module-load form locked the path for the lifetime
// of the process and made queue-write tests unrunnable from node:test
// without subprocesses.
function getQueuePath() {
  return queuePath();
}

const PRIVATE_FILE_MODE = 0o600;

function chmodPrivate(path) {
  try { chmodSync(path, PRIVATE_FILE_MODE); } catch {}
}

function appendPrivateFile(path, content) {
  appendFileSync(path, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  chmodPrivate(path);
}

function writePrivateFile(path, content) {
  writeFileSync(path, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  chmodPrivate(path);
}

function appendQueueLines(path, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  appendPrivateFile(path, lines.join('\n') + '\n');
}

function rewriteQueueByMoveAside(suffix, transform) {
  const queuePath = getQueuePath();
  if (!existsSync(queuePath)) return false;
  const drainPath = `${queuePath}.${suffix}.${process.pid}.${Date.now()}`;
  try {
    renameSync(queuePath, drainPath);
  } catch {
    return false;
  }
  try {
    const lines = readFileSync(drainPath, 'utf8').split('\n').filter(Boolean);
    const nextLines = transform(lines) || [];
    appendQueueLines(queuePath, nextLines);
    return true;
  } finally {
    try { unlinkSync(drainPath); } catch {}
  }
}

// The bridge's resolved host session id. Three sources, in precedence:
//   1. MCP _meta["x-codex-turn-metadata"].session_id — Codex injects this
//      on every CallToolRequest (PR openai/codex#15190); adopted in
//      server.mjs's CallToolRequestSchema handler before dispatch.
//   2. The host_session_id (or legacy claude_session_id) MCP arg —
//      forwarded by the agent. Used by the Claude subagent because Claude
//      Code does NOT expand ${VAR} in MCP env: blocks at spawn time, so
//      env-var injection is unavailable. Codex falls back here only if
//      _meta is absent (e.g. older Codex versions).
//   3. CLAUDE_CODE_SESSION_ID env var — backstop for tests and direct
//      Claude invocations that do set it.
let _bridgeHostSid = null;

export function getHostSessionId() {
  return _bridgeHostSid || sanitizeSid(process.env.CLAUDE_CODE_SESSION_ID) || null;
}

// Reject obviously-bad values: empty, or an unexpanded shell template like
// "${CLAUDE_CODE_SESSION_ID}" that survives Claude Code's literal-pass-through
// of MCP env: blocks. A literal placeholder must NOT be treated as a valid
// session id — every event tagged with it would land in a non-existent
// session's drain bucket and never surface.
function sanitizeSid(s) {
  if (!s || typeof s !== 'string') return null;
  if (s.includes('${') || s.includes('}')) return null;
  return s;
}

// Set once per bridge process. Subsequent calls with a different sid throw
// BRIDGE_SID_CONFLICT — multiple host sessions sharing one bridge violates
// the isolation contract that the queue tagging is supposed to enforce.
// Callers (MCP request handler, dispatch) catch and surface this as a
// structured `{ ok: false, code: 'BRIDGE_SID_CONFLICT' }` response so a
// misrouted call gets explicit feedback instead of silently landing on
// the wrong session's ledger.
function adoptHostSessionId(sid) {
  if (!sid) return;
  if (_bridgeHostSid && _bridgeHostSid !== sid) {
    const err = new Error(
      `bridge sid conflict: process bound to ${_bridgeHostSid}, received ${sid}. ` +
      'Multiple host sessions sharing one bridge process violates queue-tag isolation.'
    );
    err.code = 'BRIDGE_SID_CONFLICT';
    throw err;
  }
  if (_bridgeHostSid) return;
  _bridgeHostSid = sid;
  log('INFO', 'sid adopted:', sid);
  // Lazy hydrate-and-sweep, deferred until the bridge actually knows whose
  // session it serves. Idempotent guards inside both functions handle the
  // already-run case.
  try { hydrateJobsFromLedger(); } catch (err) { log('WARN', 'lazy hydrate failed:', err.message); }
  try { sweepOwnSessionStaleQueueRows(); } catch (err) { log('WARN', 'lazy sweep failed:', err.message); }
}

function enqueueEvent(event) {
  // Synchronous append; writes are small (~1-5KB). `consumed:false` lets the
  // drain script filter out events already surfaced by a wait-terminal MCP
  // response — the subagent never sees the same event twice.
  //
  // Sid resolution: prefer the originating job's stored sid (so a recovered
  // bridge holding session-B's job correctly tags session-B's events even
  // when this bridge process serves session-A). Fall back to the bridge's
  // own adopted sid; fall back finally to env. Untagged rows are dropped by
  // the drain hook, so a missing sid means the event never surfaces.
  const fromJob = event.jobId ? jobs.get(event.jobId)?.claudeSessionId : null;
  const sid = fromJob || getHostSessionId();
  try {
    appendPrivateFile(
      getQueuePath(),
      JSON.stringify({
        ts: Date.now(),
        consumed: false,
        claudeSessionId: sid,
        ...event,
      }) + '\n',
    );
  } catch (err) {
    log('WARN', 'enqueue failed:', err.message);
  }
}

function markQueueConsumed(jobId) {
  try {
    rewriteQueueByMoveAside('consume', (lines) => {
      let changed = false;
      const updated = lines.map((line) => {
        try {
          const e = JSON.parse(line);
          if (e.jobId === jobId && !e.consumed) { e.consumed = true; changed = true; }
          return JSON.stringify(e);
        } catch { return line; }
      });
      return changed ? updated : lines;
    });
  } catch (err) {
    log('WARN', 'markQueueConsumed failed:', err.message);
  }
}

log('INFO', 'bridge start:', `pid=${process.pid} ppid=${process.ppid} claude_sid=${process.env.CLAUDE_CODE_SESSION_ID || 'unset'}`);

// --- Job tracking -----------------------------------------------------------

const jobs = new Map();
const JOB_RETENTION_MS = 60 * 60 * 1000;
const JOB_GC_INTERVAL_MS = 60 * 1000;

const jobsGcTimer = setInterval(() => gcExpiredJobs(), JOB_GC_INTERVAL_MS);
if (jobsGcTimer.unref) jobsGcTimer.unref();

function gcExpiredJobs(now = Date.now()) {
  for (const [jobId, job] of jobs) {
    if (!job.terminalAt || !job.retentionExpiresAt) continue;
    if (job.retentionExpiresAt > now) continue;
    jobs.delete(jobId);
    deleteJob(jobId);
    log('INFO', 'gc job:', jobId, `status=${job.status}`);
  }
}

// In-memory jobs use `sessionId` for the Copilot ACP session; persisted form
// renames it to `copilotSessionId` so it cannot be confused with the Claude
// Code session id (`claudeSessionId`) that the drain hook keys on. Best-effort:
// failures don't abort the action — the in-memory map is still authoritative
// for the current bridge process.
function persistJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.claudeSessionId) return;
  try {
    const { sessionId, ...rest } = job;
    const data = { ...rest };
    if (sessionId !== undefined) data.copilotSessionId = sessionId;
    writeJob(jobId, data);
  } catch (err) {
    log('WARN', 'persistJob failed:', jobId, err.message);
  }
}

// Wait-budget clamp. All modes share a single 1200s (20 min) cap; the
// previous mode-aware split (900 ANALYZE / 540 other) was lifted when the
// daemon prompt timeout grew from 10→25 min to accommodate /fleet jobs.
// Claude Code's 600s stream-idle watchdog is satisfied by the companion's
// per-iteration "still running" emission, so the clamp no longer needs to
// stay under it. Codex's per-tool MCP timeout defaults to 120s
// (`codex-rs/codex-mcp/src/rmcp_client.rs:79`) but is user-configurable
// via `[mcp_servers.X].tool_timeout_sec` in the agent TOML — see README's
// Codex install section. Default 480s when input is missing, non-numeric,
// or zero. Floor 1s to avoid no-wait races. The `mode` arg is retained
// for call-site compatibility but no longer affects the cap.
export function clampWaitSec(input, _mode) {
  const cap = 1200;
  return Math.max(1, Math.min(Number(input) || 480, cap));
}

// Resolve the thread name for a send. Three sources, in precedence:
//   1. Explicit `args.thread` from caller (Claude's MY_THREAD-comment trick).
//   2. Server-side host-session→thread state file (Codex path: subagent has
//      no transcript-replay mechanism, so the bridge resolves continuity
//      keyed by the host session id from MCP _meta). Harmless on Claude
//      because the agent always passes its remembered thread, so this
//      branch only fires when the caller deliberately omits it.
//   3. Auto-generated `companion-<jobId>` for first-ever sends.
// On every send we persist the (host_session_id → thread) mapping so a
// future bridge respawn can rehydrate the same Copilot session.
export function resolveSendThread(explicitThread, hostSidRaw, jobId) {
  let thread = explicitThread || null;
  const hostSidKey = hostSidRaw ? sanitizeHostSessionId(hostSidRaw) : '';
  if (!thread && hostSidKey) {
    try { thread = readHostSessionThread(hostSidKey); }
    catch (err) { log('WARN', 'readHostSessionThread failed:', err.message); }
  }
  if (!thread) thread = `companion-${jobId}`;
  if (hostSidKey) {
    try { writeHostSessionThread(hostSidKey, thread); }
    catch (err) { log('WARN', 'writeHostSessionThread failed:', err.message); }
  }
  return thread;
}

function getJob(jobId) { gcExpiredJobs(); return jobs.get(jobId) || null; }
function updateJob(jobId, patch) {
  const j = jobs.get(jobId);
  if (j) { Object.assign(j, patch); persistJob(jobId); }
  return j || null;
}
function retainTerminalJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const terminalAt = patch.terminalAt || Date.now();
  Object.assign(job, patch, {
    terminalAt,
    retentionExpiresAt: terminalAt + JOB_RETENTION_MS,
    inspectAvailable: Boolean(job.promptId || patch.promptId),
  });
  persistJob(jobId);
  resolveAllWaiters(jobId, { terminal: true, job });
  return job;
}

function retireThreadSid(thread, sessionId, reason) {
  if (!thread || !sessionId) return false;
  try {
    if (readThreadSid(thread) !== sessionId) return false;
    clearThread(thread);
    log('WARN', 'thread sid retired:', `thread=${thread} session=${sessionId} reason=${reason}`);
    return true;
  } catch (err) {
    log('WARN', 'retireThreadSid failed:', err.message);
    return false;
  }
}

function isBlankText(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}

function isEmptyCompletedSummary(summary) {
  if (!summary || typeof summary !== 'object') return true;
  return isBlankText(summary.message) &&
    isBlankText(summary.thoughts) &&
    (!Array.isArray(summary.toolCalls) || summary.toolCalls.length === 0) &&
    !summary.plan;
}

function iso(ts) { return ts ? new Date(ts).toISOString() : null; }
function canonicalPathForCompare(path) {
  if (!path) return null;
  try { return realpathSync(path); }
  catch { return String(path); }
}
function sameRequiredCwd(a, b) {
  const ca = canonicalPathForCompare(a);
  const cb = canonicalPathForCompare(b);
  return !!ca && !!cb && ca === cb;
}
function normalizeInspectLimit(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return 40;
  return Math.max(1, Math.min(n, 200));
}

async function fetchPromptInspect(job, { includeTimeline = false, limit = 40 } = {}) {
  if (!job?.promptId) return null;
  const resp = await inspectPrompt({
    promptId: job.promptId,
    includeTimeline,
    limit: normalizeInspectLimit(limit),
  });
  if (!resp.ok) throw new Error(`inspect failed: ${resp.error}`);
  return resp.data;
}

// Refresh the on-disk digest from the prompt jsonl. Called from
// handleStatus, runWatchLoop interim alerts, and emitNotification. Returns
// the path on success, null when there is nothing to write yet (no promptId
// or no events). Best-effort: any failure is swallowed so the bridge never
// blocks a response on a digest write.
export function refreshDigestForJob(job, statusOverride = null) {
  if (!job || !job.promptId || !job.jobId) return null;
  try {
    return writeDigest(job.promptId, {
      jobId:      job.jobId,
      status:     statusOverride || job.status || 'running',
      mode:       job.mode || null,
      template:   job.template || null,
      thread:     job.thread || null,
      parallel:   !!job.fleet,
      parallelStrategy: job.parallelStrategy || job.parallel || null,
      task:       job.task || null,
      sessionId:  job.sessionId || null,
      startedAt:  job.startedAt || null,
      terminalAt: job.terminalAt || null,
    });
  } catch (err) {
    log('WARN', 'refreshDigestForJob failed:', job.jobId, err.message);
    return null;
  }
}

export function buildJobResponse(job, inspect = null, { includeTimeline = false } = {}) {
  const data = inspect || {};
  // Status precedence: when the worker has emitted a bridge-level remap
  // (timeout or unreachable), prefer the job's status over inspect data.
  // Inspect is sourced from the daemon, which doesn't know about these
  // bridge-only statuses and would otherwise surface the raw underlying
  // value (e.g. failed for prompt timeout). For supervisor-detected and
  // normal terminal states, inspect data wins as before.
  const bridgeStatus = job.status;
  const isBridgeRemap = bridgeStatus === 'timeout' || bridgeStatus === 'unreachable';
  const status = isBridgeRemap ? bridgeStatus : (data.status || bridgeStatus || 'unknown');
  return {
    ok: true,
    job_id: job.jobId,
    status,
    prompt_id: data.promptId || job.promptId || null,
    session_id: data.sessionId || job.sessionId || null,
    mode: job.mode || null,
    parallel: job.parallelStrategy || job.parallel || null,
    fleet: Boolean(job.fleet),
    thread: job.thread || null,
    cwd: data.cwd || job.cwd || null,
    started_at: data.startedAt || iso(job.startedAt),
    terminal_at: data.terminalAt || iso(job.terminalAt),
    ms_since_last_event:
      data.msSinceLastEvent ??
      (job.terminalAt ? 0 : Math.max(0, Date.now() - (job.startedAt || Date.now()))),
    stuck_reason: data.stuckReason || job.stuckReason || null,
    supervisor_detail: data.stuckDetail || job.stuckDetail || null,
    // detail is bridge-owned (set only by the worker on `unreachable` remap
    // or when retainTerminalJob persists the reconciled value). The daemon
    // never emits a `detail` field on inspect responses, so we read only
    // from job. Keeping a `data.detail` fallback here would let a future
    // daemon change silently override the bridge's authoritative value.
    detail: job.detail || null,
    failed_tools: Array.isArray(data.failedTools) && data.failedTools.length > 0
      ? data.failedTools : Array.isArray(job.failedTools) ? job.failedTools : [],
    latest_plan: data.latestPlan || null,
    inspect_available: Boolean(
      data.inspectAvailable ?? job.inspectAvailable ??
      (job.promptId && (!job.retentionExpiresAt || job.retentionExpiresAt > Date.now()))
    ),
    retention_expires_at: data.retentionExpiresAt || iso(job.retentionExpiresAt),
    activity:           includeTimeline ? (Array.isArray(data.activity) ? data.activity : []) : undefined,
    activity_count:     includeTimeline ? (data.activityCount ?? 0) : undefined,
    activity_truncated: includeTimeline ? Boolean(data.activityTruncated) : undefined,
    session_reborn:     Boolean(job.sessionReborn),
    session_retired:    Boolean(job.sessionRetired),
    // Path to the smart-transcript digest file. Always points at a stable
    // location keyed by jobId; the file itself exists only if a digest has
    // been written for this job (skipped when the prompt has no events yet).
    digest_path: job.promptId ? digestPath(job.jobId) : null,
  };
}

// --- Waiters (v6.1) --------------------------------------------------------
//
// `wait` parks a resolver on the target jobId (`send` returns synchronously,
// so it never parks). The worker calls resolveAllWaiters through
// retainTerminalJob when the job reaches a terminal state. A per-call
// timeout returns {timeout:true, job} so the subagent can loop with a fresh
// wait.

const waiters = new Map(); // jobId -> Set<resolver>

function parkWaiter(jobId, resolver) {
  if (!waiters.has(jobId)) waiters.set(jobId, new Set());
  waiters.get(jobId).add(resolver);
}
function unparkWaiter(jobId, resolver) {
  const set = waiters.get(jobId);
  if (!set) return;
  set.delete(resolver);
  if (set.size === 0) waiters.delete(jobId);
}
function resolveAllWaiters(jobId, value) {
  const set = waiters.get(jobId);
  if (!set) return;
  waiters.delete(jobId);
  for (const r of set) { try { r(value); } catch {} }
}

function waitForJob(jobId, maxWaitSec) {
  return new Promise((resolve) => {
    const existing = getJob(jobId);
    if (!existing) { resolve({ unknown: true }); return; }
    if (existing.terminalAt) { resolve({ terminal: true, job: existing }); return; }
    let settled = false;
    const resolver = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unparkWaiter(jobId, resolver);
      resolve(value);
    };
    parkWaiter(jobId, resolver);
    const timer = setTimeout(
      () => resolver({ timeout: true, job: getJob(jobId) }),
      Math.max(1, maxWaitSec) * 1000,
    );
  });
}

function buildWaitResponse(outcome) {
  if (outcome.unknown) {
    return asJson({
      ok: false, action: 'wait', status: 'unknown_job',
      error: "unknown job_id (may have been GC'd after retention expired)",
    });
  }
  const job = outcome.job;
  if (outcome.timeout) {
    const stillRunning = {
      ok: true, action: 'wait', status: 'still_running',
      job_id: job.jobId,
      // Surface thread even on still_running so a crash+resume can still
      // recover it. (v6.1 thread-continuity invariant.)
      thread: job.thread || null,
      current_status: job.status || 'running',
      parallel: job.parallelStrategy || job.parallel || null,
      fleet: Boolean(job.fleet),
      started_at: iso(job.startedAt),
      age_s: Math.round((Date.now() - (job.startedAt || Date.now())) / 1000),
      // Mirror the terminal-path field so a poll that catches the job mid-run
      // still sees the rebirth signal — without this, callers using {wait,
      // max_wait_sec} would only learn about the lost context on the next
      // poll iteration that resolves terminally.
      session_reborn: Boolean(job.sessionReborn),
      // Path to the smart-transcript digest the parent can read for an
      // up-to-date progress summary without making another status round-trip.
      digest_path: job.promptId ? digestPath(job.jobId) : null,
      hint: 'call copilot({action:"wait", job_id, max_wait_sec}) again to continue blocking.',
    };
    if (job.reattached) stillRunning.reattached = true;
    return asJson(stillRunning);
  }
  markQueueConsumed(job.jobId);
  // Final digest refresh for terminal-via-wait. This is the path the
  // companion's wait loop hits when a long job finishes; without this the
  // digest can lag behind by one supervisor-alert window (~60s).
  refreshDigestForJob(job, job.status);
  const digestFilePath = job.promptId ? digestPath(job.jobId) : null;
  const meta = {
    job_id: job.jobId, status: job.status,
    mode: job.mode || 'EXECUTE',
    parallel: job.parallelStrategy || job.parallel || '',
    fleet: Boolean(job.fleet) ? 'true' : 'false',
    thread: job.thread || null,
    prompt_id: job.promptId || null,
    session_id: job.sessionId || null,
    failed_tools: Array.isArray(job.failedTools) ? job.failedTools.join(',') : '',
    stuck_reason: job.stuckReason || null,
  };
  if (job.detail) meta.detail = String(job.detail).slice(0, 80);
  if (job.sessionReborn) meta.session_reborn = 'true';
  if (job.sessionRetired) meta.session_retired = 'true';
  if (job.reattached) meta.reattached = 'true';
  if (job.existingPromptId) meta.existing_prompt_id = String(job.existingPromptId);
  if (digestFilePath) meta.digest_path = digestFilePath;
  return asJson({
    ok: true, action: 'wait', status: job.status,
    job_id: job.jobId,
    duration_ms: job.durationMs || null,
    content: formatTerminalContent({ ...job, digestFilePath }),
    meta,
  });
}

// --- Notification payload ---------------------------------------------------

function emitAlertNotification({ jobId, task, promptId, alert, startedAt, reqId = null }) {
  const ageSec = Math.round((Date.now() - startedAt) / 1000);
  const content = [
    `Task: ${truncate(task, 200)}`,
    '',
    `**promptId:** ${promptId}  |  **age:** ${ageSec}s  |  **tier:** ${alert.tier}  |  **reason:** ${alert.reason}`,
  ].join('\n');
  const meta = {
    job_id: jobId, status: 'watchdog', prompt_id: promptId,
    age_sec: String(ageSec), tier: String(alert.tier), reason: alert.reason,
  };
  if (reqId) meta.req_id = String(reqId);
  enqueueEvent({ kind: 'alert', jobId, content, meta });
}

// One-shot rebirth alert, fired at prompt-bg time when the daemon reports
// that the bridge-supplied sessionId was stale and a fresh Copilot session
// had to be minted. Surfaces *immediately* (next drain tick), independent of
// whether the eventual completion succeeds, so the parent can correct course
// in long-running threads. emitNotification's session_reborn meta + the
// formatTerminalContent banner are belt-and-suspenders for callers that
// don't drain alerts.
function emitRebirthAlert({ jobId, task, promptId, thread, previousSid, newSessionId, startedAt, reqId = null }) {
  const ageSec = Math.round((Date.now() - startedAt) / 1000);
  const content = [
    `Task: ${truncate(task, 200)}`,
    '',
    '**Copilot session respawned** — the prior subprocess died, in-process conversation context was lost.',
    '',
    `**thread:** ${thread || '(none)'}  |  **prev sid:** ${previousSid || '(none)'}  |  **new sid:** ${newSessionId}`,
    '',
    'If subsequent prompts in this thread depend on earlier turns, restate the relevant context.',
  ].join('\n');
  const meta = {
    job_id: jobId, status: 'watchdog', prompt_id: promptId,
    age_sec: String(ageSec), tier: '1', reason: 'session_reborn',
    session_reborn: 'true',
  };
  if (thread)       meta.thread = String(thread);
  if (previousSid)  meta.previous_session_id = String(previousSid);
  if (newSessionId) meta.session_id = String(newSessionId);
  if (reqId)        meta.req_id = String(reqId);
  enqueueEvent({ kind: 'alert', jobId, content, meta });
  log('WARN', 'rebirth:', jobId, `thread=${thread || '-'} prev=${previousSid || '-'} new=${newSessionId}`);
}

// Pure formatter: takes the fields a terminal job carries and returns the
// human-readable body. Extracted from emitNotification so buildWaitResponse
// can reuse the exact same formatting when the subagent blocks to completion.
export function formatTerminalContent({
  jobId, status, task, mode, durationMs,
  summary, error, stuckReason, detail, failedTools, promptId,
  sessionReborn = false, sessionRetired = false, digestFilePath = null,
}) {
  const rebirthBanner = sessionReborn
    ? '> ⚠ Copilot session was respawned mid-thread; prior in-process conversation context was lost. ' +
      'If your next prompt depends on earlier turns of this thread, restate the relevant context.\n\n'
    : '';
  const taskHeader = rebirthBanner + `Task: ${truncate(task, 200)}\n\n`;
  const duration = durationMs || 0;
  const rubberDuck = classifyRubberDuck(summary?.message);

  if (status === 'completed' && summary?.message) {
    const filesTouched = (summary.toolCalls || [])
      .map((tc) => tc?.input?.path || tc?.input?.file_path)
      .filter(Boolean);
    const filesLine = filesTouched.length
      ? `\n\n**Files touched:** ${[...new Set(filesTouched)].slice(0, 10).join(', ')}`
      : '';
    const failedLine = (Array.isArray(failedTools) && failedTools.length)
      ? `\n\n**Failed tools:** ${failedTools.slice(0, 10).join(', ')}`
      : '';
    let rubberDuckFooter = '';
    if (rubberDuck === 'clean') {
      rubberDuckFooter = '\n\n_Rubber-duck: ✓ clean_';
    } else if (rubberDuck === 'revised') {
      rubberDuckFooter = '\n\n_Rubber-duck: ↻ revised — see `RUBBER-DUCK:` in the message above._';
    }
    return taskHeader + summary.message +
      `\n\n**Tool calls:** ${(summary.toolCalls || []).length}  •  **Duration:** ${Math.round(duration / 1000)}s` +
      filesLine + failedLine + rubberDuckFooter;
  }
  if (status === 'completed') {
    return taskHeader +
      'Copilot reported completion but returned no assistant message. ' +
      'Treat this as a failed turn and re-dispatch with explicit context.';
  }
  if (status === 'stuck') {
    return taskHeader +
      `Copilot got stuck on: \`${stuckReason || 'unknown'}\`.\n\n` +
      (promptId
        ? `Inspect with \`copilot({action:"status", job_id:"${jobId}", verbose:true})\` before deciding whether to recover directly.`
        : 'Prompt inspection is unavailable for this job; decide whether to re-fire or recover directly.');
  }
  if (status === 'failed') {
    return taskHeader + `Copilot job failed: ${error || 'unknown error'}`;
  }
  if (status === 'cancelled') {
    return taskHeader + 'Copilot job was cancelled.' +
      (summary?.message ? `\n\nPartial output:\n${summary.message}` : '');
  }
  if (status === 'running') {
    return taskHeader + "Copilot job exceeded the bridge's wait budget. Daemon was asked to cancel.";
  }
  if (status === 'timeout') {
    const failedLine = (Array.isArray(failedTools) && failedTools.length)
      ? `\n\n**Failed tools:** ${failedTools.slice(0, 10).join(', ')}` : '';
    const digestLine = digestFilePath
      ? `\n\n**Partial transcript digest:** \`${digestFilePath}\` — read this BEFORE re-dispatching. ` +
        'It contains the partial assistant message, /fleet sub-agent reports (often near-complete), files touched, and todos. ' +
        'You may be able to finalise from the digest alone, or use it to scope a much smaller follow-up send.'
      : '';
    const retiredLine = sessionRetired
      ? '\n\n**Session:** the timed-out Copilot ACP session was retired; the next send on this thread starts a fresh session. Restate any needed context from the digest.'
      : '';
    return taskHeader +
      `Copilot's model turn did not finish within the wait budget (${Math.round(duration / 1000)}s).\n\n` +
      'The daemon is alive; the task was too large for one turn. Recommended next steps for the parent:\n' +
      '- Read the partial-transcript digest (path below) — sub-agent reports may already cover the work.\n' +
      '- Decompose the task into smaller, explicitly-scoped sub-sends (target ≤ ~100 LOC of source per send).\n' +
      '- For ANALYZE on large files, pass `template_args.scope_hint` (e.g. "imports/types only", "lines 1-120") to bind the analysis to a specific section.\n' +
      '- Raise `max_wait_sec` (cap 1200s / 20 min for all modes) if the task is genuinely long.\n' +
      "- Try `parallel: \"never\"` once if you suspect /fleet's coordination overhead is the bottleneck for a strictly linear task." +
      failedLine + digestLine + retiredLine;
  }
  if (status === 'unreachable') {
    const detailLine = detail ? ` (detail: ${detail})` : '';
    return taskHeader +
      `Bridge could not reach the Copilot daemon (or socket reconciliation failed)${detailLine}.\n\n` +
      `This is infrastructure-level — check \`ps -ef | grep copilot-acp-daemon\` and tail \`${bridgeLogFile()}\` / \`${daemonLogFile()}\` to confirm the daemon is alive.`;
  }
  return taskHeader + `Unexpected terminal status: ${status}`;
}

export function emitNotification({
  jobId, status, summary, error, stuckReason, detail = null, duration,
  task, mode, cwd, thread = null, promptId = null, sessionId = null,
  reconciled = false, bridgeReason = null, failedTools = [], reqId = null,
  sessionReborn = false, sessionRetired = false, fleet = false, extraMeta = null,
}) {
  if (
    status === 'completed' &&
    typeof summary?.message === 'string' &&
    /(?:^|\n)\s*(?:Info:\s*)?Operation cancelled by user\.?\s*$/i.test(summary.message.trim())
  ) {
    status = 'stuck';
    if (!stuckReason) stuckReason = 'cancelled_before_summary';
  }

  // Copilot CLI surfaces backend-model failures as stopReason="end_turn" with
  // the error text as the assistant message, so without this remap they'd be
  // classified as "completed" with the error masquerading as content. Cancel
  // takes precedence above (a cancellation during a retry storm is "stuck").
  if (
    status === 'completed' &&
    typeof summary?.message === 'string' &&
    /Error:\s*Execution failed:\s*Error:\s*Failed to get response from the AI model/i.test(summary.message)
  ) {
    status = 'failed';
    if (!detail) detail = 'copilot_capi_failure';
  }
  if (status === 'completed' && isEmptyCompletedSummary(summary)) {
    status = 'failed';
    error = 'Copilot returned completed without any assistant message, tool calls, or plan updates.';
    detail = detail || 'empty_completed';
    sessionRetired = true;
  }

  const meta = {
    job_id: jobId, status,
    duration_ms: String(duration),
    mode: mode || 'EXECUTE',
  };
  if (cwd)       meta.cwd = String(cwd);
  if (thread)    meta.thread = String(thread);
  if (promptId)  meta.prompt_id = String(promptId);
  if (sessionId) meta.session_id = String(sessionId);
  meta.inspect_available = promptId ? 'true' : 'false';
  if (summary?.toolCalls)  meta.tool_calls  = String(summary.toolCalls.length || 0);
  if (summary?.stopReason) meta.stop_reason = String(summary.stopReason);
  if (stuckReason)         meta.stuck_reason = String(stuckReason).slice(0, 80);
  if (detail)              meta.detail = String(detail).slice(0, 80);
  if (Array.isArray(failedTools) && failedTools.length) meta.failed_tools = failedTools.join(',').slice(0, 80);
  if (reconciled)   meta.reconciled = 'true';
  if (bridgeReason) meta.bridge_reason = String(bridgeReason).slice(0, 40);
  if (reqId)        meta.req_id = String(reqId);
  if (sessionReborn) meta.session_reborn = 'true';
  if (sessionRetired) meta.session_retired = 'true';
  meta.fleet = fleet ? 'true' : 'false';
  if (extraMeta && typeof extraMeta === 'object') {
    for (const [k, v] of Object.entries(extraMeta)) {
      if (v !== undefined && v !== null) meta[k] = String(v).slice(0, 80);
    }
  }

  const rubberDuck = classifyRubberDuck(summary?.message);
  if (status === 'completed') meta.rubber_duck = rubberDuck;

  // Final digest refresh on terminal. We pass the current `status` because
  // the job's stored status may not yet reflect a late remap (e.g. cancelled
  // → stuck) we did above. Path is stable per jobId; surface it whether or
  // not the write succeeded so the parent always knows where to look.
  const digestFilePath = jobId ? digestPath(jobId) : null;
  if (promptId && jobId) {
    try {
      writeDigest(promptId, {
        jobId, status, mode, template: null, thread, parallel: !!fleet,
        task, sessionId, startedAt: duration ? Date.now() - duration : null,
        terminalAt: Date.now(),
      });
    } catch (err) { log('WARN', 'emit digest write failed:', jobId, err.message); }
  }
  if (digestFilePath) meta.digest_path = digestFilePath;

  const content = formatTerminalContent({
    jobId, status, task, mode, durationMs: duration,
    summary, error, stuckReason, detail, failedTools, promptId,
    sessionReborn, sessionRetired, digestFilePath,
  });

  enqueueEvent({ kind: 'terminal', jobId, content, meta });
  if (status === 'completed' && rubberDuck === 'missing') {
    log('WARN', 'emit:', jobId, 'rubber_duck verdict missing from completed message — Copilot output drifted from wrapper contract');
  }
  log('INFO', 'emit:', jobId, `status=${status} duration_ms=${duration}${status === 'completed' ? ` rubber_duck=${rubberDuck}` : ''}${stuckReason ? ` stuck=${stuckReason}` : ''}${detail ? ` detail=${detail}` : ''}${bridgeReason ? ` bridge=${bridgeReason}` : ''}`);
}

function truncate(s, n) { if (!s) return ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Classify the rubber-duck verdict surfaced by Copilot in the final message.
// The rubber-duck wrapper is appended to general/research prompts, so every
// completed job from those templates should yield at least one
// `RUBBER-DUCK: clean.` or `RUBBER-DUCK: revised …` line.
//
// Multi-verdict handling: when /fleet dispatches sub-agents, each sub-agent
// receives the wrapper instructions and may emit its own verdict line; the
// orchestrator concatenates sub-agent outputs into the final message, so the
// message can contain N verdicts. We scan ALL matches and fail-pessimistic:
// if ANY verdict is `revised`, the overall classification is `revised`. This
// avoids silently downgrading a sub-agent's `revised` finding to `clean` just
// because an earlier sub-agent reported `clean`.
//
// A 'missing' verdict means no marker at all — Copilot's output drifted from
// the wrapper's contract. Logged at WARN for visibility.
export function classifyRubberDuck(message) {
  if (!message) return 'missing';
  const matches = [...String(message).matchAll(/(?:^|\n)\s*RUBBER-DUCK:\s*(clean|revised)\b/gi)];
  if (matches.length === 0) return 'missing';
  for (const m of matches) {
    if (m[1].toLowerCase() === 'revised') return 'revised';
  }
  return 'clean';
}

// --- Worker -----------------------------------------------------------------

const MAX_JOB_MS = 40 * 60 * 1000;

async function runWorker({ jobId, reqId, task, mode, template, template_args, cwd, thread, model, previousSid, parallel }) {
  const startedAt = Date.now();
  const fleet = shouldUseFleet({ parallel, template, mode, task });
  const rlog = withReq(reqId, { job_id: jobId });
  rlog.info('worker.start', { mode, template, thread: thread || null, model, cwd: cwd || null, parallel_strategy: parallel, fleet });
  log('INFO', 'worker start:', jobId, `req=${reqId} mode=${mode} template=${template} thread=${thread || '-'} model=${model} cwd=${cwd} parallel=${parallel} fleet=${fleet}`);
  try {
    await ensureRuntime({ reqId });

    let formatted = formatPrompt({ template, task, mode, template_args, parallel });
    // plan_review prompts already embed their own senior-architect critique
    // instructions; layering the generic rubber-duck wrapper on top doubles
    // the prompt size without changing the output. Skip it for that template
    // only — every other template still gets the always-on wrapper.
    if (template !== 'plan_review') {
      formatted = appendRubberDuckReview(formatted);
    }

    const startResp = await promptBg({
      sessionId: previousSid || null,
      text: formatted,
      cwd,
      model,
      reqId,
    });
    if (!startResp.ok) {
      // Daemon-side mutex says another prompt already owns this Copilot
      // sessionId. The bridge reattach guard should normally catch this
      // first, but a race between two send dispatches can still slip
      // through. Map to a clean terminal 'unreachable' envelope (with
      // detail=session_busy + existing_prompt_id) instead of throwing a
      // generic error that the caller would see as "unexpected terminal".
      if (['SESSION_BUSY', 'CWD_BUSY', 'MODEL_BUSY'].includes(startResp.code)) {
        const detail = String(startResp.code || 'SESSION_BUSY').toLowerCase();
        const existingPromptId = startResp.data?.existingPromptId || null;
        const conflictSessionId = startResp.data?.sessionId || null;
        rlog.warn('worker.daemon_busy', { code: startResp.code, existing_prompt_id: existingPromptId, session_id: conflictSessionId });
        log('WARN', 'worker daemon busy:', jobId, `code=${startResp.code} existingPromptId=${existingPromptId} sessionId=${conflictSessionId}`);
        const duration = Date.now() - startedAt;
        retainTerminalJob(jobId, {
          status: 'unreachable',
          detail,
          error: startResp.error || 'daemon busy',
          existingPromptId,
          durationMs: duration,
          terminalAt: Date.now(),
        });
        emitNotification({
          jobId,
          status: 'unreachable',
          summary: null,
          error: startResp.error || 'daemon busy',
          stuckReason: null,
          detail,
          duration, task, mode, cwd, thread,
          promptId: null,
          sessionId: conflictSessionId,
          failedTools: [],
          reqId,
          fleet,
          extraMeta: existingPromptId ? { existing_prompt_id: String(existingPromptId) } : undefined,
        });
        return;
      }
      throw new Error(`prompt-bg failed: ${startResp.error}`);
    }
    const { promptId, sessionId, sessionReborn } = startResp.data;
    rlog.info('worker.prompt_started', { prompt_id: promptId, session_id: sessionId, session_reborn: !!sessionReborn });
    log('INFO', 'worker prompt started:', jobId, `promptId=${promptId} sessionId=${sessionId}${sessionReborn ? ' (REBORN)' : ''}`);

    updateJob(jobId, { promptId, sessionId, status: 'running', inspectAvailable: true, sessionReborn: !!sessionReborn });

    if (thread && sessionId) {
      try { writeThreadSid(thread, sessionId); }
      catch (err) { log('WARN', 'writeThreadSid failed:', err.message); }
    }

    // Surface the rebirth immediately, before the prompt completes. The
    // parent (Claude/Codex) needs to know that Copilot's in-process
    // conversation context was lost so it can restate any thread context
    // that matters — Copilot CLI's ACP session/load is process-local
    // (github/copilot-cli#1767), so cross-process resume isn't possible
    // at the protocol layer. The terminal emit also tags meta.session_reborn
    // as belt-and-suspenders for callers that don't drain alerts.
    if (sessionReborn) {
      emitRebirthAlert({ jobId, task, promptId, thread, previousSid, newSessionId: sessionId, startedAt, reqId });
    }

    await runWatchLoop({ jobId, promptId, sessionId, thread, task, mode, cwd, startedAt, reqId, sessionReborn: !!sessionReborn, fleet });
  } catch (err) {
    // Failure before the prompt was registered (ensureDaemon, prompt-bg, etc).
    // No promptId yet → not reconcilable, just record terminal failure.
    await emitWorkerFailure({ jobId, err, startedAt, reqId, task, mode, cwd, thread, rlog, sessionId: null });
  } finally {
    rlog.info('worker.end', { duration_ms: Date.now() - startedAt });
    log('INFO', 'worker end:', jobId, `duration_ms=${Date.now() - startedAt}`);
  }
}

// Watch-loop and terminal handling, factored out so a rehydrated bridge can
// re-attach to a daemon-owned promptId without re-running prompt-bg. Called
// from runWorker (fresh prompt) and from rehydrate (recovery after restart).
async function runWatchLoop({ jobId, promptId, sessionId, thread, task, mode, cwd, startedAt, reqId, sessionReborn = false, fleet = false }) {
  const rlog = withReq(reqId, { job_id: jobId });
  try {
    let result;
    while (true) {
      result = await awaitTerminal(promptId, 480);
      if (result?.interim) {
        emitAlertNotification({ jobId, task, promptId, alert: result.alert, startedAt, reqId });
        // Real-time digest refresh: every supervisor alert (~60s during
        // silence) regenerates the on-disk digest so a parent that reads
        // the file mid-flight sees an up-to-date snapshot.
        refreshDigestForJob(jobs.get(jobId));
        if (Date.now() - startedAt > MAX_JOB_MS) throw new Error(`watch loop exceeded MAX_JOB_MS (${MAX_JOB_MS}ms)`);
        continue;
      }
      break;
    }

    if (result.status === 'failed' && result.error === 'prompt timeout') {
      // Promote prompt_timeout to a first-class terminal status. The model
      // turn did not finish within the wait budget; the daemon is alive
      // and the task was too large for one turn. Distinct from `stuck`
      // (supervisor trip) and from `unreachable` (daemon/socket dead).
      result.status = 'timeout';
      result.stuckReason = null;
      result.error = null;
      result.detail = 'prompt_timeout';
      retireThreadSid(thread, sessionId, 'prompt_timeout');
      result.sessionRetired = true;
      rlog.warn('worker.remap_prompt_timeout', { prompt_id: promptId });
      log('INFO', 'remap prompt_timeout:', jobId, `promptId=${promptId} → status=timeout retired=${!!result.sessionRetired}`);
    }

    if (result.status === 'completed' && isEmptyCompletedSummary(result.summary)) {
      result.status = 'failed';
      result.error = 'Copilot returned completed without any assistant message, tool calls, or plan updates.';
      result.detail = 'empty_completed';
      retireThreadSid(thread, sessionId, 'empty_completed');
      result.sessionRetired = true;
      rlog.warn('worker.empty_completed', { prompt_id: promptId, session_retired: !!result.sessionRetired });
      log('WARN', 'empty completed remapped:', jobId, `promptId=${promptId} retired=${!!result.sessionRetired}`);
    }

    if (result.status === 'failed' && result.error === 'empty completed response') {
      result.error = 'Copilot returned completed without any assistant message, tool calls, or plan updates.';
      result.detail = 'empty_completed';
      retireThreadSid(thread, sessionId, 'empty_completed');
      result.sessionRetired = true;
    } else if (result.sessionRetired) {
      retireThreadSid(thread, sessionId, result.detail || result.error || 'session_retired');
      result.sessionRetired = true;
    }

    const currentJob = jobs.get(jobId);
    if (currentJob?.supersedingPromptId === promptId && result.status === 'cancelled') {
      currentJob.supersededPromptStatus = 'cancelled';
      persistJob(jobId);
      rlog.info('worker.prompt_superseded', { prompt_id: promptId, replacement_prompt_id: currentJob.promptId || null });
      log('INFO', 'worker prompt superseded:', jobId, `promptId=${promptId}`);
      return;
    }
    if (currentJob?.promptId && currentJob.promptId !== promptId) {
      rlog.info('worker.prompt_obsolete', { prompt_id: promptId, current_prompt_id: currentJob.promptId });
      log('INFO', 'worker obsolete prompt ignored:', jobId, `old=${promptId} current=${currentJob.promptId}`);
      return;
    }

    const duration = Date.now() - startedAt;
    const failedTools = failedToolsFromJsonl(promptId);
    retainTerminalJob(jobId, {
      promptId, sessionId,
      status: result.status, summary: result.summary,
      error: result.error, stuckReason: result.stuckReason,
      detail: result.detail || null,
      failedTools, durationMs: duration,
      terminalAt: Date.now(),
      sessionReborn,
      sessionRetired: !!result.sessionRetired,
    });
    rlog.info('worker.terminal', { status: result.status, duration_ms: duration, failed_tools: failedTools?.length || 0, session_reborn: sessionReborn, session_retired: !!result.sessionRetired });
    emitNotification({
      jobId,
      status: result.status, summary: result.summary,
      error: result.error, stuckReason: result.stuckReason,
      detail: result.detail || null,
      duration, task, mode, cwd, thread,
      promptId, sessionId, failedTools, reqId, sessionReborn,
      sessionRetired: !!result.sessionRetired,
      fleet,
    });
  } catch (err) {
    await emitWorkerFailure({ jobId, err, startedAt, reqId, task, mode, cwd, thread, rlog, sessionId });
  }
}

async function emitWorkerFailure({ jobId, err, startedAt, reqId, task, mode, cwd, thread, rlog, sessionId }) {
  const duration = Date.now() - startedAt;
  const promptId = jobs.get(jobId)?.promptId;
  const currentSessionId = jobs.get(jobId)?.sessionId || sessionId;
  const fleet = !!jobs.get(jobId)?.fleet;
  const isReconcilableErr = !!promptId && (
    (err && typeof err.code === 'string' && ['ECONNREFUSED', 'ENOENT', 'EPIPE', 'ETIMEDOUT'].includes(err.code)) ||
    /timeout/i.test(err?.message || '')
  );
  const reconciled = isReconcilableErr ? await reconcileAfterTimeout(promptId) : null;
  let status = reconciled?.status ?? 'failed';
  let summary = reconciled?.summary ?? null;
  let error = reconciled?.error ?? err.message;
  let detail = reconciled?.detail ?? null;
  let sessionRetired = false;
  if (status === 'completed' && isEmptyCompletedSummary(summary)) {
    status = 'failed';
    error = 'Copilot returned completed without any assistant message, tool calls, or plan updates.';
    detail = 'empty_completed';
    retireThreadSid(thread, currentSessionId, 'empty_completed');
    sessionRetired = true;
  }
  rlog.warn('worker.catch', { error: err.message, reconciled: reconciled?.status || null });
  log('WARN', 'worker catch:', jobId, `err="${err.message}" reconciled=${reconciled?.status || 'n/a'}`);
  retainTerminalJob(jobId, {
    promptId: promptId || null,
    sessionId: currentSessionId || null,
    status,
    summary,
    error,
    stuckReason: reconciled?.stuckReason ?? null,
    detail,
    failedTools: promptId ? failedToolsFromJsonl(promptId) : [],
    durationMs: duration, terminalAt: Date.now(),
    sessionRetired,
  });
  emitNotification({
    jobId,
    status,
    summary,
    error,
    stuckReason: reconciled?.stuckReason ?? null,
    detail,
    duration, task, mode, cwd, thread,
    promptId: promptId || null,
    sessionId: currentSessionId || null,
    failedTools: promptId ? failedToolsFromJsonl(promptId) : [],
    bridgeReason: reconciled?.bridgeReason || null,
    reconciled: !!reconciled,
    sessionRetired,
    fleet,
    reqId,
  });
}

async function awaitTerminal(promptId, maxWaitSec) {
  // Cap aligned with the daemon's PROMPT_TIMEOUT_MS (25 min). The +120s
  // padding gives the daemon room to return a terminal payload before we
  // give up on the socket roundtrip.
  const timeoutMs = Math.min((maxWaitSec + 120) * 1000, 25 * 60 * 1000);
  const resp = await watchPrompt(
    { promptId, since: 0, raw: false, wait: maxWaitSec, summaryOnly: true },
    timeoutMs,
  );
  if (!resp.ok) throw new Error(`await failed: ${resp.error}`);
  return resp.data;
}

async function reconcileAfterTimeout(promptId) {
  try {
    const resp = await watchPrompt(
      { promptId, since: 0, raw: false, wait: 0, summaryOnly: true },
      5_000,
    );
    const data = resp?.ok ? resp.data : null;
    if (data?.status === 'completed') {
      return { status: 'completed', summary: data.summary, error: null, stuckReason: null, detail: null, bridgeReason: 'reconciled_completed' };
    }
    if (data?.status === 'stuck' || data?.status === 'cancelled') {
      return { status: 'stuck', summary: null, error: null, stuckReason: data.stuckReason || data.status, detail: null, bridgeReason: 'reconciled_stuck' };
    }
    // Socket reconciliation succeeded but the daemon reported no terminal
    // state — treat as bridge-level unreachable (socket flapped). detail
    // distinguishes this from a hard daemon-dead failure below.
    return { status: 'unreachable', summary: null, error: null, stuckReason: null, detail: 'bridge_timeout', bridgeReason: 'bridge_timeout' };
  } catch {
    // Daemon process dead or socket gone — true infra failure.
    return { status: 'unreachable', summary: null, error: null, stuckReason: null, detail: 'bridge_daemon_unreachable', bridgeReason: 'bridge_daemon_unreachable' };
  }
}

function failedToolsFromJsonl(promptId) {
  try {
    const content = readFileSync(promptEventsPath(promptId), 'utf8');
    const byId = new Map();
    const names = new Set();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'tool_call') byId.set(ev.toolCallId, ev.name);
      else if (ev.type === 'tool_call_update' && ev.status === 'failed') {
        const name = ev.name || byId.get(ev.toolCallId);
        if (name) names.add(name);
      }
    }
    return [...names];
  } catch { return []; }
}

// --- Action handlers --------------------------------------------------------

function asJson(obj) {
  const result = {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
  };
  if (obj?.ok === false) result.isError = true;
  return result;
}

function invalidArgsResult(err) {
  return asJson({
    ok: false,
    action: 'validate',
    code: 'INVALID_ARGUMENTS',
    error: err?.message || String(err),
  });
}

async function handleSend(args) {
  // The drain hook keys event delivery on claudeSessionId. Without it, every
  // queue write the new job produces would land in a row that no session can
  // claim — the model would never see its own watchdog alerts or terminal
  // events. Refuse upfront with a clear error rather than silently dropping
  // notifications later.
  if (!getHostSessionId()) {
    return asJson({
      ok: false,
      action: 'send',
      error: 'CLAUDE_CODE_SESSION_ID not set in bridge environment — bridge cannot tag events for hook delivery. Verify the subagent template forwards it via the env: block.',
    });
  }

  // v6.1: bridge auto-generates a thread name if caller (the companion
  // subagent) did not pass one. This is how the companion gets a stable
  // handle it can remember across resumes — main never sees or carries it.
  // Pre-compute the jobId first so we can derive thread = companion-<jobId>.
  const jobId = `copilot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const thread = resolveSendThread(args.thread || null, getHostSessionId(), jobId);

  // Reattach guard. When the MCP bridge dies mid-send and Claude Code respawns
  // it, the same tool call lands again with the same thread + host session.
  // The previous worker is still running inside the daemon. Starting a new
  // prompt-bg on the same Copilot sessionId would overwrite the live
  // collector entry (sessionCollectors[sessionId]) and silently amputate the
  // first prompt's event stream. Instead, find the live job and just wait
  // on it — its terminal payload is the one the caller wants anyway.
  const hostSid = getHostSessionId();
  for (const existing of jobs.values()) {
    if (existing.thread !== thread) continue;
    if (existing.claudeSessionId !== hostSid) continue;
    if (existing.terminalAt) continue;
    if (!sameRequiredCwd(existing.cwd, args.cwd)) {
      return asJson({
        ok: false,
        action: 'send',
        status: 'cwd_mismatch',
        job_id: existing.jobId,
        current_status: existing.status || 'running',
        thread,
        existing_cwd: existing.cwd || null,
        requested_cwd: args.cwd,
        error:
          `existing in-flight job ${existing.jobId} on thread ${thread} is rooted at ` +
          `${existing.cwd || '(unknown)'}, but this send requested ${args.cwd}. ` +
          'Refusing to reattach or start Copilot in the wrong workspace; wait/cancel the existing job or use a different thread.',
      });
    }
    existing.reattached = true;
    persistJob(existing.jobId);
    const maxWait = clampWaitSec(args.max_wait_sec, args.mode);
    logEvent('info', 'copilot.send.reattached', {
      job_id: existing.jobId, thread, host_session: hostSid, status: existing.status || 'running',
    });
    log('INFO', 'copilot:send reattached:', `job=${existing.jobId} thread=${thread} status=${existing.status}`);
    const outcome = await waitForJob(existing.jobId, maxWait);
    return buildWaitResponse(outcome);
  }

  // Thread → previous Copilot sid. If the caller passed an explicit thread
  // name that doesn't exist yet, readThreadSid returns null (new thread).
  // An auto-generated companion-<jobId> is brand new too, so null.
  let previousSid = null;
  try { previousSid = readThreadSid(thread); }
  catch (err) { return asJson({ ok: false, error: err.message }); }

  const { model } = readDefaultModel();
  if (!isModelAllowed(model)) {
    return asJson({
      ok: false, reason: 'model-not-allowed', model,
      hint: 'configure default_model to an allowed id',
    });
  }

  const reqId = createReqId();
  const fleet = shouldUseFleet({
    parallel: args.parallel,
    template: args.template,
    mode: args.mode,
    task: args.task,
  });
  jobs.set(jobId, {
    jobId, reqId,
    claudeSessionId: getHostSessionId(),
    task: args.task, mode: args.mode,
    template: args.template, cwd: args.cwd,
    thread,
    parallelStrategy: args.parallel,
    fleet,
    startedAt: Date.now(),
    status: 'starting', inspectAvailable: false,
  });
  persistJob(jobId);
  logEvent('info', 'copilot.send', {
    req_id: reqId, job_id: jobId,
    template: args.template, mode: args.mode,
    thread, model,
    parallel_strategy: args.parallel,
    fleet,
  });
  log('INFO', 'copilot:send', `job=${jobId} req=${reqId} template=${args.template} mode=${args.mode} thread=${thread} model=${model} parallel=${args.parallel} fleet=${fleet}`);

  runWorker({
    jobId, reqId,
    task: args.task, mode: args.mode,
    template: args.template, template_args: args.template_args,
    cwd: args.cwd, thread, model, previousSid,
    parallel: args.parallel,
  }).catch((err) => log('ERROR', 'worker error:', err.message));

  // Return immediately with still_running. The worker continues in the
  // background; the caller (subagent) loops on `wait` to block until terminal.
  // Returning synchronously here avoids client-side MCP timeouts on hosts
  // (Codex) with shorter per-tool budgets than the bridge's natural wait
  // window. Shape mirrors buildWaitResponse's still_running envelope so the
  // subagent doesn't need to special-case send vs wait responses.
  const job = jobs.get(jobId);
  return asJson({
    ok: true, action: 'send', status: 'still_running',
    job_id: jobId,
    thread,
    current_status: job?.status || 'starting',
    parallel: args.parallel,
    fleet,
    started_at: iso(job?.startedAt || Date.now()),
    age_s: 0,
    session_reborn: false,
    hint: 'call copilot({action:"wait", job_id, max_wait_sec}) to block until terminal.',
  });
}

async function handleWait({ job_id, max_wait_sec }) {
  if (!job_id) return asJson({ ok: false, action: 'wait', error: 'job_id required' });
  // The clamp is mode-agnostic now (single 1200s cap), but we still pass
  // mode through to keep the call signature stable for legacy callers.
  const job = getJob(job_id);
  const mode = job?.mode || 'EXECUTE';
  const max = clampWaitSec(max_wait_sec, mode);
  const outcome = await waitForJob(job_id, max);
  return buildWaitResponse(outcome);
}

async function handleCancel({ job_id }) {
  if (!job_id) return asJson({ ok: false, action: 'cancel', error: 'job_id required' });
  const job = getJob(job_id);
  if (!job)                                       return asJson({ ok: false, error: 'unknown job_id' });
  if (!job.promptId || job.status === 'starting') return asJson({ ok: false, error: 'job is not yet cancellable' });
  if (job.status !== 'running')                   return asJson({ ok: false, error: `job is ${job.status}` });
  const resp = await cancelPrompt({ promptId: job.promptId });
  // v6.1 gap fix: cancel also surfaces the job via the cancel MCP response,
  // so mark the queue entry consumed to avoid a duplicate drain injection.
  if (resp.data?.cancelled) markQueueConsumed(job_id);
  return asJson({
    ok: true, action: 'cancel', job_id,
    cancelled: !!resp.data?.cancelled, reason: resp.data?.reason,
  });
}

async function handleReply({ job_id, message }) {
  // Re-steer an in-flight job. Triple guard: validation rejects missing
  // message; this handler rejects unknown/terminal jobs locally (cheap fast
  // path); the daemon enforces its own per-prompt lock so two concurrent
  // replies cannot race the cancel-and-restart sequence.
  const job = getJob(job_id);
  if (!job) return asJson({ ok: false, action: 'reply', error: 'unknown job_id' });
  if (!job.promptId) return asJson({ ok: false, action: 'reply', error: 'job has no prompt yet — wait for status: running' });
  if (job.terminalAt) return asJson({ ok: false, action: 'reply', error: `job is already ${job.status} — start a new send` });
  if (job.replyInFlight) return asJson({ ok: false, action: 'reply', error: 'reply already in flight for this job' });

  const originalPromptId = job.promptId;
  job.replyInFlight = true;
  job.supersedingPromptId = originalPromptId;
  job.supersededPromptStatus = null;
  persistJob(job_id);
  try {
    const resp = await replyPrompt({ promptId: originalPromptId, message });
    if (!resp.ok || !resp.data?.ok) {
      const reason = resp.data?.reason || resp.error || 'reply failed';
      delete job.supersedingPromptId;
      if (job.supersededPromptStatus === 'cancelled' && !job.terminalAt) {
        retainTerminalJob(job_id, {
          status: 'cancelled',
          error: reason,
          durationMs: Date.now() - (job.startedAt || Date.now()),
          terminalAt: Date.now(),
        });
      } else {
        persistJob(job_id);
      }
      return asJson({ ok: false, action: 'reply', job_id, error: reason });
    }
    const replacementPromptId = resp.data.new_prompt_id;
    const replacementSessionId = resp.data.session_id || job.sessionId;
    updateJob(job_id, {
      promptId: replacementPromptId,
      sessionId: replacementSessionId,
      status: 'running',
      inspectAvailable: true,
      terminalAt: null,
      retentionExpiresAt: null,
      error: null,
      stuckReason: null,
      detail: null,
      supersedingPromptId: null,
      supersededPromptStatus: null,
    });
    delete job.supersedingPromptId;
    delete job.supersededPromptStatus;

    const reqId = job.reqId || createReqId();
    runWatchLoop({
      jobId: job_id,
      promptId: replacementPromptId,
      sessionId: replacementSessionId,
      thread: job.thread || null,
      task: job.task || message,
      mode: job.mode || 'EXECUTE',
      cwd: job.cwd || null,
      startedAt: job.startedAt || Date.now(),
      reqId,
      sessionReborn: !!job.sessionReborn,
    }).catch((err) => log('ERROR', 'reply watch loop error:', job_id, err.message));

    log('INFO', 'copilot:reply', `job=${job_id} old_prompt=${originalPromptId} new_prompt=${replacementPromptId}`);
    return asJson({
      ok: true, action: 'reply', job_id,
      original_prompt_id: resp.data.original_prompt_id,
      new_prompt_id: replacementPromptId,
      session_id: replacementSessionId,
      hint: 'reply accepted. The original turn was cancelled; the follow-up runs as a new prompt on the same Copilot session.',
    });
  } finally {
    job.replyInFlight = false;
    persistJob(job_id);
  }
}

async function handleStatus({ job_id, verbose }) {
  if (job_id) {
    const job = getJob(job_id);
    if (!job) return asJson({ ok: false, error: 'unknown job_id' });
    let inspect = null;
    if (job.promptId) {
      try { inspect = await fetchPromptInspect(job, { includeTimeline: verbose }); }
      catch (err) { log('WARN', 'status inspect failed:', job_id, err.message); }
    }
    // Refresh the on-disk digest so the caller can read up-to-date detail
    // (sub-agent reports, files touched, todos, partial assistant message)
    // without having to inspect the raw jsonl. This is the primary mechanism
    // the parent agent uses to track progress on long-running /fleet jobs.
    refreshDigestForJob(job);
    return asJson(buildJobResponse(job, inspect, { includeTimeline: verbose }));
  }
  const modelInfo = readDefaultModel();
  return asJson({
    ok: true, action: 'status',
    runtime_adapter: selectedRuntimeAdapter(),
    default_model: modelInfo,
    threads: listThreads(),
    jobs_in_memory: jobs.size,
    running_jobs: [...jobs.values()]
      .filter((j) => !j.terminalAt)
      .map((j) => ({
        job_id: j.jobId,
        status: j.status || 'starting',
        mode: j.mode || null,
        parallel: j.parallelStrategy || j.parallel || null,
        fleet: Boolean(j.fleet),
        thread: j.thread || null,
        cwd: j.cwd || null,
        prompt_id: j.promptId || null,
        started_at: iso(j.startedAt),
        age_s: Math.round((Date.now() - (j.startedAt || Date.now())) / 1000),
        reply_in_flight: !!j.replyInFlight,
      })),
  });
}

// --- MCP server setup -------------------------------------------------------

const mcp = new Server(
  { name: 'copilot-bridge', version: '0.0.1' },
  {
    capabilities: { tools: {} },
    instructions:
      'Internal MCP server for the copilot-companion subagent. Spawned inline ' +
      'per invocation by the companion agent. Actions: send (returns ' +
      'still_running synchronously), wait (blocks until terminal), status, ' +
      'reply, cancel. The companion uses send for kickoff then loops on wait ' +
      `until terminal. Runtime adapter is ${selectedRuntimeAdapter()}. ` +
      'Parallel orchestration is strategy-based: auto, always, ' +
      'or never. Runtime IPC, logs, prompt streams, digests, and completion ' +
      `queue live under the private directory ${runtimeDir()}.`,
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'copilot',
      description:
        'Internal Copilot companion tool. Actions: send | wait | status | reply | cancel. ' +
        'Not exposed to main Claude — only the copilot-companion subagent invokes this. ' +
        'Rubber-duck critique and model selection are handled server-side.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['send', 'wait', 'status', 'reply', 'cancel'],
            description:
              'send: enqueue a task; returns still_running with job_id immediately. Caller then loops on action:wait to block until terminal. ' +
              'wait: block on an existing job_id up to max_wait_sec seconds. ' +
              'status: without job_id returns global state; with job_id returns job diagnostics. ' +
              'reply: re-steer an in-flight job (requires job_id + message). ' +
              'cancel: cancel a specific running job (requires job_id).',
          },
          task: {
            type: 'string',
            description: '[send] Plain-language description of the task.',
          },
          message: {
            type: 'string',
            description:
              '[reply] Follow-up text to inject into a running job. The current ' +
              'in-flight turn is cancelled and a new turn is started on the same ' +
              'Copilot session with this message wrapped as a continuation.',
          },
          mode: {
            type: 'string',
            enum: ['PLAN', 'ANALYZE', 'EXECUTE'],
            description:
              '[send] PLAN: produce a plan, read-only. ANALYZE: investigate, read-only. ' +
              'EXECUTE (default): Copilot may edit/write/shell.',
          },
          template: {
            type: 'string',
            enum: ['general', 'research', 'plan_review'],
            description:
              '[send] Prompt template. Defaults to "general". "research" for evidence-backed web research. ' +
              '"plan_review" for senior-architect plan reviews (requires template_args.plan_path).',
          },
          template_args: {
            type: 'object',
            description: '[send] Template-specific arguments. Keys validated per-template.',
            additionalProperties: false,
            properties: {
              plan_path:       { type: 'string', description: '[plan_review only] Absolute path to the plan .md (or "latest").' },
              focus_directive: { type: 'string', description: '[plan_review only] Optional focus directive for plan_review.' },
              scope_hint:      { type: 'string', description: '[general only] Binds the analysis to a specific scope (e.g. "imports/types only", "lines 1-120"). Useful for large-file ANALYZE.' },
            },
          },
          cwd: {
            type: 'string',
            description:
              '[send required] Absolute target repo/worktree for Copilot. The bridge rejects missing cwd instead of defaulting to the bridge process cwd.',
          },
          thread: {
            type: 'string',
            description:
              '[send] Optional thread name. If omitted the bridge auto-generates `companion-<jobId>`. ' +
              'Supplying a remembered thread name resumes a prior Copilot session for multi-turn continuity.',
            pattern: '^[a-zA-Z0-9._-]+$',
          },
          max_wait_sec: {
            type: 'number',
            description:
              '[send|wait] Upper bound on how long the bridge blocks before returning ' +
              'still_running. Default 480, max 1200 (20 min) for all modes. The companion emits ' +
              'a "still running" line between wait iterations to reset Claude Code\'s 600s ' +
              "stream-idle watchdog, so the clamp is no longer mode-scoped. On a fresh `send` " +
              'this bound is moot — the call returns still_running synchronously — but on a ' +
              'reattach to an in-flight job, send blocks on the existing job up to this bound. ' +
              'Wait always blocks up to this bound.',
          },
          parallel: {
            type: 'string',
            enum: ['auto', 'always', 'never'],
            description:
              '[send] Parallel orchestration strategy. "auto" (default) prepends "/fleet " only ' +
              'when the bridge judges the task broad enough to benefit. "always" forces /fleet. ' +
              '"never" skips /fleet for strictly linear or single-source work.',
          },
          job_id:  { type: 'string',  description: '[wait|status|reply|cancel] Target a specific job.' },
          verbose: { type: 'boolean', description: '[status] Include full activity timeline when a job_id is given.' },
          claude_session_id: {
            type: 'string',
            description:
              "[all] Caller's Claude Code session id, used to scope the bridge's queue writes and " +
              "ledger so events from one session never leak into another. The Claude companion subagent " +
              'extracts this from $CLAUDE_CODE_SESSION_ID via Bash at activation and forwards it on ' +
              'every action. Required on `send` for Claude callers; recommended on every other action ' +
              "(lets the bridge rehydrate its own-session jobs after a restart). Codex callers don't " +
              'need this — the bridge reads the session id from MCP `_meta["x-codex-turn-metadata"]` ' +
              'directly. host_session_id is accepted as a host-neutral alias.',
          },
          host_session_id: {
            type: 'string',
            description:
              '[all] Host-neutral alias of `claude_session_id`. Same semantics — pass either, not both. ' +
              'Provided so non-Claude hosts can forward a session id without using a Claude-named field.',
          },
        },
        required: ['action'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          status: { type: 'string' },
          code: { type: 'string' },
          error: { type: 'string' },
          job_id: { type: 'string' },
          thread: { type: 'string' },
          prompt_id: { type: ['string', 'null'] },
          session_id: { type: ['string', 'null'] },
          digest_path: { type: ['string', 'null'] },
          meta: { type: 'object', additionalProperties: true },
          content: { type: 'string' },
          fleet: { type: 'boolean' },
          parallel: { type: 'string' },
        },
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'copilot') throw new Error(`unknown tool: ${req.params.name}`);
  try {
    // Codex (PR openai/codex#15190) injects per-turn metadata on every MCP
    // tool call as `_meta["x-codex-turn-metadata"]`, including a stable
    // session_id. Adopt that BEFORE validation/dispatch so even callers
    // that don't forward host_session_id get correctly tagged. This is
    // the primary host→bridge session-id channel on Codex; arg-based
    // forwarding is the fallback for hosts that don't expose _meta
    // (Claude does not).
    const metaSid = req?.params?._meta?.['x-codex-turn-metadata']?.session_id;
    if (metaSid && typeof metaSid === 'string') adoptHostSessionId(metaSid);
    const normalized = validateCopilotArgs(req.params.arguments || {});
    return await dispatch(normalized);
  } catch (err) {
    if (err && err.code === 'BRIDGE_SID_CONFLICT') {
      log('ERROR', 'sid conflict on MCP call:', err.message);
      return asJson({ ok: false, error: err.message, code: 'BRIDGE_SID_CONFLICT' });
    }
    if (/^copilot: /.test(err?.message || '')) {
      log('WARN', 'invalid MCP arguments:', err.message);
      return invalidArgsResult(err);
    }
    throw err;
  }
});

// Exported dispatcher lets tests drive the action handlers directly without
// going through MCP transport plumbing. Tests that want to exercise the
// MCP `_meta` path call `adoptHostSessionId(metaSid)` directly before
// invoking dispatch — this matches the MCP handler's own ordering.
export async function dispatch(normalized) {
  // Arg-based session-id adoption (host_session_id is the host-neutral
  // alias; claude_session_id stays accepted as input alias and is
  // normalized into host_session_id by validation.mjs::normalizeHostSid).
  // Skipped if _meta already adopted a sid for this process — adoptHostSessionId
  // is no-op-on-match / throws BRIDGE_SID_CONFLICT on conflict, so the
  // precedence holds. We catch the conflict here so direct callers (tests,
  // and any non-MCP consumer) get the same structured error the MCP handler
  // returns rather than an unhandled rejection.
  try {
    if (normalized.host_session_id) adoptHostSessionId(normalized.host_session_id);
  } catch (err) {
    if (err && err.code === 'BRIDGE_SID_CONFLICT') {
      log('ERROR', 'sid conflict on dispatch:', err.message);
      return asJson({ ok: false, error: err.message, code: 'BRIDGE_SID_CONFLICT' });
    }
    throw err;
  }
  switch (normalized.action) {
    case 'send':   return handleSend(normalized);
    case 'wait':   return handleWait(normalized);
    case 'status': return handleStatus(normalized);
    case 'reply':  return handleReply(normalized);
    case 'cancel': return handleCancel(normalized);
    default: throw new Error(`copilot: unhandled action "${normalized.action}"`);
  }
}

// Module-level idempotency flags. Hydrate and sweep are now triggered
// lazily by adoptHostSessionId on the first sid-bearing MCP call, so we
// must guard against re-running within the same bridge process.
let _hydrated = false;
let _swept = false;

// On bridge startup (or on first sid-bearing action in fallback mode), claim
// any persisted jobs belonging to this Claude Code session. The previous
// bridge for this session (killed by stdio reconnect, crash, etc.) may have
// left in-flight jobs whose Copilot prompts are still running on the still-
// detached daemon. Re-attach the watch loop so wait/status/reply/cancel
// resolve correctly. Idempotent: subsequent calls within the same process
// are no-ops.
export function hydrateJobsFromLedger() {
  if (_hydrated) return;
  const mySid = getHostSessionId();
  if (!mySid) {
    log('WARN', 'hydrate skipped: CLAUDE_CODE_SESSION_ID not set');
    return;
  }
  let entries;
  try { entries = listJobsForSession(mySid); }
  catch (err) { log('WARN', 'hydrate listJobs failed:', err.message); return; }

  let claimed = 0;
  let resumed = 0;
  for (const persisted of entries) {
    const { copilotSessionId, ...rest } = persisted;
    const job = { ...rest };
    if (copilotSessionId !== undefined) job.sessionId = copilotSessionId;
    jobs.set(job.jobId, job);
    claimed++;

    const isTerminal = !!job.terminalAt;

    // If thread + sessionId are both known but the thread file may not
    // exist (original bridge died before writeThreadSid ran), restore it.
    // Do not restore timeout/empty-completed retirements: those sessions are
    // intentionally poisoned and the next send must mint a clean ACP session.
    if (job.thread && job.sessionId && !(isTerminal && job.sessionRetired)) {
      try { writeThreadSid(job.thread, job.sessionId); }
      catch (err) { log('WARN', 'hydrate writeThreadSid failed:', err.message); }
    }

    // Resume the watch loop for non-terminal jobs that have a registered
    // promptId. Jobs in 'starting' (no prompt-bg yet) cannot be resumed —
    // mark them terminal:unreachable so wait/status return cleanly.
    if (isTerminal) continue;
    if (!job.promptId) {
      retainTerminalJob(job.jobId, {
        status: 'unreachable',
        error: 'bridge restart before prompt-bg completed',
        detail: 'rehydrate_no_promptid',
        terminalAt: Date.now(),
      });
      continue;
    }
    runWatchLoop({
      jobId: job.jobId,
      promptId: job.promptId,
      sessionId: job.sessionId || null,
      thread: job.thread || null,
      task: job.task || '',
      mode: job.mode || 'EXECUTE',
      cwd: job.cwd || null,
      startedAt: job.startedAt || Date.now(),
      reqId: job.reqId || createReqId(),
      fleet: !!job.fleet,
    }).catch((err) => log('ERROR', 'rehydrate watch error:', job.jobId, err.message));
    resumed++;
  }
  log('INFO', 'hydrate:', `claimed=${claimed} resumed=${resumed} sid=${mySid}`);
  _hydrated = true;
}

// On startup, drop own-session entries from the queue that are older than
// STARTUP_STALE_MS. Without this, the prior bridge's already-displayed alerts
// would be redelivered on the first PostToolUse hook the new bridge's session
// fires — same model would see them twice. We can be strict here because the
// bridge's only durable user-facing state is the model's prior context, which
// already has those alerts.
const STARTUP_STALE_MS = 60_000;
export function sweepOwnSessionStaleQueueRows(nowMs = Date.now()) {
  if (_swept) return;
  const mySid = getHostSessionId();
  if (!mySid) return;
  _swept = true;
  try {
    let dropped = 0;
    const moved = rewriteQueueByMoveAside('sweep', (lines) => {
      const kept = [];
      for (const line of lines) {
        let e; try { e = JSON.parse(line); } catch { kept.push(line); continue; }
        const isOwn = e.claudeSessionId === mySid;
        const isStale = typeof e.ts === 'number' && (nowMs - e.ts > STARTUP_STALE_MS);
        if (isOwn && isStale) { dropped++; continue; }
        kept.push(line);
      }
      return kept;
    });
    if (moved && dropped > 0) log('INFO', 'startup sweep:', `dropped=${dropped} sid=${mySid}`);
  } catch (err) {
    log('WARN', 'startup sweep failed:', err.message);
  }
}

// Test-only: reset module-level state so each test scenario starts clean.
// Production code never calls this — module state is permanent until the
// bridge process exits. Exists because Node's ESM module cache means the
// in-process test runner sees state mutations carry across test cases.
export function _resetForTest() {
  _bridgeHostSid = null;
  _hydrated = false;
  _swept = false;
}

export { mcp, jobs, gcExpiredJobs, persistJob, adoptHostSessionId, retainTerminalJob };

// Only attach stdio transport when launched as a script. Allows
// `import('./server.mjs')` from tests without spawning a real MCP loop.
// Resolve both sides through realpath so a symlinked argv[1] still matches
// import.meta.url.
const isMain = (() => {
  try {
    const argvReal = realpathSync(process.argv[1]);
    const metaReal = realpathSync(fileURLToPath(import.meta.url));
    return argvReal === metaReal;
  } catch { return false; }
})();
if (isMain) {
  // One-line startup log so a user troubleshooting host routing can grep
  // the private runtime bridge log for "host detected" and see what the
  // bridge resolved on this run. The README's Diagnostics section points
  // readers here.
  const { detectHost } = await import('../lib/host.mjs');
  logEvent('info', 'bridge.startup', { host_detected: detectHost() });

  // Only run eager hydrate/sweep when the env actually carries a real sid.
  // In production, Claude Code passes the literal string `${CLAUDE_CODE_SESSION_ID}`
  // through to the env block (no ${VAR} expansion at MCP-spawn time), so
  // sanitizeSid returns null and we wait for the subagent to forward the
  // sid via the first MCP call's `claude_session_id` arg.
  if (getHostSessionId()) {
    hydrateJobsFromLedger();
    sweepOwnSessionStaleQueueRows();
  }
  await mcp.connect(new StdioServerTransport());
}
