#!/usr/bin/env node
// agent-bridge MCP server (subagent-oriented, target-generic architecture)
//
// MCP tools: agent_catalog | agent_send | agent_wait | agent_status | agent_reply | agent_cancel.
// agent_send takes an optional `target` (opencode | copilot | codex | antigravity);
// omitting it uses the configured default target, and there is no silent
// fallback.
// Both hosts register this server at plugin/session scope. Owner-bound calls
// require the native subagent identity; catalog and status remain ownerless.
// Task text is passed through verbatim.
//
// `send` enqueues the task and returns `status=still_running` with the job_id
// after delivery acknowledgement. An identical in-flight send reattaches to
// the same execution. Bounded waits hold the owner's lease until they return.
//
// The host budget that actually bounds a wait is the MCP *tool idle* timeout,
// not a stream watchdog. Measured from the Claude Code 2.1.226 binary: the
// stdio-transport default is 1,800,000 ms (30 min), polled on a 30 s tick, and
// it is satisfied by each `agent_wait` **returning** — an emission mid-call does
// not reset it (only a `notifications/progress` would, and that is not what the
// per-iteration line is). So the budget is: clampWaitSec's 1200 s ceiling
// against an 1,800,000 ms stdio idle default = 600 s of headroom, which is why
// clampWaitSec needs no change. Never raise it past 1500 s without also setting
// a per-server `timeout` on the MCP server entry — the `env: MCP_TOOL_TIMEOUT`
// form is a host no-op (it reaches only this child). Codex's own per-tool-call
// budget is 120 s (`codex-rs/codex-mcp/src/rmcp_client.rs:79`); Codex callers
// raise tool_timeout_sec in the Codex plugin manifest.
//
// Completion surfacing: each terminal/alert event is appended to a JSONL queue
// file with `consumed:false`; the drain script (invoked from host lifecycle
// hooks) filters out `consumed:true` and injects unconsumed orphans
// into the subagent's context. Wait-terminal responses mark the job's entries
// consumed so the subagent never sees the same event twice.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { detectHost } from '../lib/host.mjs';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  readFileSync,
  renameSync, existsSync, realpathSync, unlinkSync,
  readdirSync, statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Controller } from './controller/controller.mjs';
import { Records } from './controller/records.mjs';
import { systemClock } from './controller/clock.mjs';
import { codexProvider } from './adapters/codex.mjs';
import { opencodeProvider } from './adapters/opencode.mjs';
import { acpProvider } from './adapters/acp.mjs';

import { watchPrompt, selectedRuntimeAdapter, runtimeSupportsDetachedPromptResume } from './acp-runtime.mjs';

import {
  log,
  validateAgentArgs,
} from './validation.mjs';
import { BASE_DIR, readDefaultModel, migrateLegacyState, isModelAllowedFor, readDefaultTarget, ALLOWED_MODELS, readThreadSid, writeThreadSid, clearThread, writeJob, listJobsForSession, deleteJob } from '../lib/state.mjs';
import { lastTargetChecks } from '../lib/target-diagnostics.mjs';
import { queuePath, promptEventsPath, runtimeDir, bridgeLogFile, daemonLogFile, digestDir, appendPrivateFile, writePrivateFileAtomic } from '../lib/runtime-paths.mjs';
import { createReqId, withReq, logEvent } from '../lib/log.mjs';
import { writeDigest, digestPath, renderDigest } from '../lib/prompt-digest.mjs';
import { writeOpenCodeDigest } from './opencode-runtime.mjs';

import { openCodeServerPromptId, ensureOpenCodeServer, openOpenCodeTurnWatcher, loadOpenCodeTranscript, probeOpenCodeServerHealth } from './opencode-server-runtime.mjs';
import { codexAppServerPromptId, ensureCodexBroker, connectCodexBroker, probeCodexBrokerHealth, resumeCodexThread, readCodexThread, openCodexTurnWatcher } from './codex-app-server-runtime.mjs';
import { pidAlive } from '../lib/shared-runtime-registry.mjs';
import {
  defaultTargetInfo,
  defaultTargetId,
  getTarget,
  listTargets,
  listTargetIds,
} from '../lib/target-registry.mjs';

// The ACP companions — everything the daemon path serves (Copilot, Antigravity).
// Keyed on the descriptor's `capabilities.acp`, never on an id: a new ACP
// companion is a descriptor plus a daemon socket, not a branch here.
// `getTarget('')` would resolve the DEFAULT target, so an empty id is refused
// here rather than silently reading as whatever the default happens to be.
function isAcpTarget(target) {
  return Boolean(target) && getTarget(target)?.capabilities?.acp === true;
}

// --- Queue (replaces dev-channel notifications) -----------------------------

// Resolved per-call so tests can flip AGENT_QUEUE_PATH before each
// scenario. The const-at-module-load form locked the path for the lifetime
// of the process and made queue-write tests unrunnable from node:test
// without subprocesses.
function getQueuePath() {
  return queuePath();
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

// The bridge's resolved host session id, supplied by the host and never by the
// model. Two sources, in precedence:
//   1. MCP _meta["x-codex-turn-metadata"].session_id — Codex injects this
//      on every CallToolRequest (PR openai/codex#15190); adopted by callArgs
//      before dispatch.
//   2. CLAUDE_CODE_SESSION_ID — Claude Code's bridge inherits it from the
//      session that spawned it (every bridge start logged since 2026-08-12
//      carries it).
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

// Only legacy recovery jobs use this in-memory retention cache.
const jobsGcTimer = setInterval(gcExpiredJobs, JOB_GC_INTERVAL_MS);
jobsGcTimer.unref();

function gcExpiredJobs(now = Date.now()) {
  for (const [jobId, job] of jobs) {
    if (!job.terminalAt || !job.retentionExpiresAt) continue;
    if (job.retentionExpiresAt > now) continue;
    jobs.delete(jobId);
    deleteJob(jobId);
    digestCarry.delete(jobId);
    log('INFO', 'gc job:', jobId, `status=${job.status}`);
  }
}

// In-memory jobs use `sessionId` for the companion runtime session (a Copilot
// ACP session or an OpenCode `ses_` id). The persisted form renames it to the
// target-neutral `companionSessionId` so it cannot be confused with the Claude
// Code session id (`claudeSessionId`) that the drain hook keys on, and so an
// OpenCode session id is not stored under a Copilot-specific key.
// Best-effort: failures don't abort the action — the in-memory map is still
// authoritative for the current bridge process.
function persistJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.claudeSessionId) return;
  try {
    const { sessionId, ...rest } = job;
    const data = { ...rest };
    if (sessionId !== undefined) data.companionSessionId = sessionId;
    writeJob(jobId, data);
  } catch (err) {
    log('WARN', 'persistJob failed:', jobId, err.message);
  }
}

// Wait-budget clamp. All waits share a single 1200s (20 min) cap.
// There is no 600s stream-idle watchdog — that figure was measured wrong and
// removed from this file's header; see docs/ARCHITECTURE.md "Negative Results".
// The budget that actually bounds a wait is the MCP *tool idle* timeout
// (stdio default 1,800,000 ms), satisfied by each agent_wait RETURNING, not by
// any mid-call emission. That leaves this cap 600s of headroom. Codex's per-tool MCP timeout defaults to 120s
// (`codex-rs/codex-mcp/src/rmcp_client.rs:79`) but is user-configurable
// via `tool_timeout_sec` in the Codex plugin manifest — see README's Codex
// install section. A NON-NUMERIC value never reaches here — validateSend
// and validateWait reject it with `agent: max_wait_sec must be a number` before
// dispatch. What reaches here is CLAMPED, not defaulted: 3000 -> 1200, -100 -> 1.
// Only a missing value, 0, or NaN falls back to 480. Floor 1s avoids no-wait races.
export function clampWaitSec(input) {
  const cap = 1200;
  return Math.max(1, Math.min(Number(input) || 480, cap));
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
    inspectAvailable: isAcpTarget(patch.target || job.target) && Boolean(job.promptId || patch.promptId),
  });
  // Legacy in-flight jobs retain their old fields until they settle here.
  for (const key of ['mode', 'template', 'template_args', 'profileId', 'strength',
    'parallel', 'parallelStrategy', 'fleet', 'verdict', 'verdictReason']) delete job[key];
  // Usage travels on the summary every adapter builds (lib/usage.mjs, one
  // shape for all of them) and lives on the job from here — one home for the
  // ledger, wait meta, status, the queue event and both digests, not a copy
  // under `summary` as well. Nothing reads `summary.usage` after this point;
  // the live digest read it off the streamed snapshot while the turn ran.
  if (job.summary?.usage) {
    job.usage = job.summary.usage;
    delete job.summary.usage;
  }
  persistJob(jobId);
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

// Codex can finish the conversational turn normally after its subordinate
// command runner failed before executing anything. That is a protocol-level
// completion, but it is not a task verdict. Keep this deliberately narrower
// than a generic error-message detector: zero tool calls alone is valid for a
// conversational turn and thread/read recovery has no tool history, while an
// assistant may legitimately quote a missing-command error in a useful answer.
export function isCodexCommandRunnerBlocker({ target, status, summary } = {}) {
  if (target !== 'codex' || status !== 'completed') return false;
  const stopReason = summary?.stopReason;
  const liveZeroToolTurn = stopReason === 'turn/completed' &&
    Array.isArray(summary?.toolCalls) && summary.toolCalls.length === 0;
  // thread/read is a complete answer salvage but explicitly carries no tool
  // history. It therefore cannot support the generic zero-tool inference below;
  // only the assistant naming the unavailable runner itself is strong enough on
  // that recovery path. This closes restart recovery without relabelling an
  // ordinary salvaged answer whose original tool history is simply absent.
  const recoveredTranscript = stopReason === 'thread/read';
  if (!liveZeroToolTurn && !recoveredTranscript) return false;
  const message = typeof summary?.message === 'string' ? summary.message.trim() : '';
  if (!message) return false;

  // Runtime evidence must be the assistant's assertion, not a quoted example
  // embedded in an otherwise self-reported documentation or wording task.
  const evidenceMessage = message
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^”\n]*”/g, ' ');
  const selfReportedBlocker = /^(?:unable to (?:complete|run|execute)\b|i\s+(?:cannot|can't|am unable to)\s+(?:complete|run|execute)\b|cannot\s+(?:complete|run|execute)\b|(?:every|all)\b[^\n.]{0,120}\bcommands?\b[^\n.]{0,120}\bfailed before execution\b)/i;
  const runnerEvidence = /\b(?:codex-code-mode-host|code[- ]mode host|command runner|tool access)\b/i;
  const unavailableEvidence = /\b(?:missing|unavailable|not found|does not exist|failed before execution|failed to spawn)\b/i;
  // A bare runtime diagnostic is also an explicit self-report. Require the
  // runner/access subject at the start and an unavailable predicate ending its
  // clause; this admits literal errors without matching explanatory prose such
  // as "tool access is unavailable in the hypothetical environment".
  const directRunnerUnavailable = /^(?:the\s+(?:configured\s+)?)?(?:(?:\S*\/)?codex-code-mode-host|code[- ]mode host|command runner|tool access)\b[^\n.!?]{0,120}\b(?:is unavailable|is missing|was not found|does not exist|failed before execution|failed to spawn)\b(?=\s*(?:[.!?]|$))/i;
  if (directRunnerUnavailable.test(evidenceMessage)) return true;
  if (!selfReportedBlocker.test(evidenceMessage)) return false;
  if (runnerEvidence.test(evidenceMessage) && unavailableEvidence.test(evidenceMessage)) return true;

  // On the live edge, the accumulator's empty tool list is real evidence. A
  // universal pre-execution failure statement is then specific enough even if
  // the assistant omitted the runner's binary name. Keep its clauses bounded
  // and ignore quoted examples so unrelated prose does not become runtime
  // failure evidence.
  const universalPreExecutionFailure = /\b(?:every|all)\b[^\n.!?]{0,160}\bcommands?\b[^\n.!?]{0,120}\bfailed before execution\b/i;
  return liveZeroToolTurn && universalPreExecutionFailure.test(evidenceMessage);
}

function iso(ts) { return ts ? new Date(ts).toISOString() : null; }
// --- Target routing and capability gate ------------------------------------

const UNCONFIGURED_SEND_ERROR =
  'no companion target configured and none passed. Pass target on agent_send, ' +
  'or set a default with `node scripts/onboard.mjs --target <id> --set-default`.';

export function resolveRouting({ target = null, model = null } = {}, env = process.env) {
  const companion = target ? String(target).trim().toLowerCase() : readDefaultTarget(env).target;
  if (!companion) return { ok: false, code: 'TARGET_UNCONFIGURED', error: UNCONFIGURED_SEND_ERROR };
  const descriptor = getTarget(companion, env);
  if (!descriptor?.implemented || !descriptor.capabilities?.send) {
    return { ok: false, code: 'TARGET_UNSUPPORTED', companion,
      error: `target "${companion}" is not a supported companion target (supported: ${listTargetIds().join(', ')})` };
  }
  const selectedModel = model || readDefaultModel(companion, env).model;
  if (selectedModel && !descriptor.capabilities.modelSelection) {
    return { ok: false, code: 'CAPABILITY_UNAVAILABLE', companion,
      error: `companion "${companion}" cannot select a model` };
  }
  if (selectedModel && !isModelAllowedFor(companion, selectedModel)) {
    return { ok: false, code: 'MODEL_NOT_ALLOWED', companion, model: selectedModel,
      error: `model "${selectedModel}" is not valid for ${companion}`,
      hint: companion === 'copilot'
        ? `set the Copilot model to one of: ${[...ALLOWED_MODELS].join(', ')}, or omit it to inherit configuration`
        : companion === 'opencode' ? 'Use a provider/model id.' : 'Model ids must contain no whitespace.' };
  }
  return { ok: true, resolved: { companion, model: selectedModel, capabilities: descriptor.capabilities } };
}

function targetLabel(id) {
  return getTarget(id)?.displayName || id || 'unknown target';
}

const digestCarry = new Map(); // jobId -> {body, prior} read from a previous bridge's digest

function priorDigestBody(jobId) {
  const path = digestPath(jobId);
  if (!path || !existsSync(path)) return { body: '', prior: '' };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { body: '', prior: '' }; }
  const idx = text.indexOf('\n## ');
  if (idx < 0) return { body: '', prior: '' };
  // The Task section is re-rendered verbatim from the job record, so carrying
  // it would just duplicate it.
  const body = text.slice(idx + 1).replace(/^## Task\n[\s\S]*?(?=\n## |$)/, '').trim();
  if (!body) return { body: '', prior: '' };
  // The salvaged answer, kept beside the body so every render can ask whether it
  // is about to duplicate it: tier-1 resume replays the whole item list on
  // `turn/completed`, so a completed render often already contains everything
  // the dead bridge wrote — while the delta renders on either side of it do not.
  const prior = /^#{2,3} Final \/ partial assistant message\n+([\s\S]*?)(?=\n#{2,3} |$)/m.exec(body)?.[1]?.trim() || '';
  return { body, prior };
}

function writeJobDigest(job, result = null) {
  const jobId = job?.jobId;
  if (!jobId) return null;
  let salvaged = digestCarry.get(jobId);
  if (salvaged === undefined) {
    // One file read per job per process — the same as when this memoized the
    // verdict. Only the containment test moved.
    salvaged = priorDigestBody(jobId);
    digestCarry.set(jobId, salvaged);
  }
  const incoming = result?.summary?.message || result?.stdout || '';
  const duplicate = salvaged.prior && incoming.includes(salvaged.prior);
  return writeOpenCodeDigest(job, result, { carriedForward: duplicate ? null : (salvaged.body || null) });
}

// Refresh the on-disk digest from the prompt jsonl. Called from
// handleStatus, runWatchLoop interim alerts, and emitNotification. Returns
// the path on success, null when there is nothing to write yet (no promptId
// or no events). Best-effort: any failure is swallowed so the bridge never
// blocks a response on a digest write.
export function refreshDigestForJob(job, statusOverride = null) {
  if (!job || !job.promptId || !job.jobId) return null;
  if (job.target && !isAcpTarget(job.target)) {
    return writeJobDigest({ ...job, status: statusOverride || job.status || 'running' }, job.adapterResult || null);
  }
  try {
    return writeDigest(job.promptId, {
      jobId:      job.jobId,
      target:     job.target || 'copilot',
      targetLabel: targetLabel(job.target || 'copilot'),
      status:     statusOverride || job.status || 'running',
      thread:     job.thread || null,
      task:       job.task || null,
      sessionId:  job.sessionId || null,
      startedAt:  job.startedAt || null,
      terminalAt: job.terminalAt || null,
      usage:      job.usage ?? null,
    });
  } catch (err) {
    log('WARN', 'refreshDigestForJob failed:', job.jobId, err.message);
    return null;
  }
}

const DIGEST_RESOURCE_SCHEME = 'agent-digest';
const DIGEST_RESOURCE_MIME_TYPE = 'text/markdown';
const DIGEST_RESOURCE_FILE_RE = /^agent-digest-([a-zA-Z0-9._-]+)\.md$/;
const DIGEST_RESOURCE_URI_RE = /^agent-digest:\/\/([a-zA-Z0-9._-]+)$/;

export function digestResourceUri(jobId) {
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(jobId)) return null;
  return `${DIGEST_RESOURCE_SCHEME}://${jobId}`;
}

export function digestJobIdFromResourceUri(uri) {
  const match = DIGEST_RESOURCE_URI_RE.exec(String(uri || ''));
  return match ? match[1] : null;
}

function digestJobIdsFromDisk() {
  const ids = new Set();
  try {
    for (const name of readdirSync(digestDir())) {
      const match = DIGEST_RESOURCE_FILE_RE.exec(name);
      if (match) ids.add(match[1]);
    }
  } catch {}
  for (const jobId of jobs.keys()) ids.add(jobId);
  return [...ids].sort();
}

export function digestResourceForJobId(jobId) {
  const path = digestPath(jobId);
  const uri = digestResourceUri(jobId);
  if (!path || !uri || !existsSync(path)) return null;
  let stat;
  try { stat = statSync(path); }
  catch { return null; }
  if (!stat.isFile()) return null;
  const job = jobs.get(jobId);
  const status = job?.status ? ` (${job.status})` : '';
  // Keep the descriptor minimal. Codex 0.139 accepts this shape for
  // list_mcp_resources; richer MCP metadata is still not portable across hosts.
  return {
    uri,
    name: `agent-digest-${jobId}`,
    description: `Smart transcript digest for agent job ${jobId}${status}.`,
    mimeType: DIGEST_RESOURCE_MIME_TYPE,
  };
}

export function listDigestResources() {
  return digestJobIdsFromDisk()
    .map((jobId) => digestResourceForJobId(jobId))
    .filter(Boolean);
}

export function listDigestResourceTemplates() {
  return [{
    uriTemplate: `${DIGEST_RESOURCE_SCHEME}://{job_id}`,
    name: 'agent-digest',
    title: 'Agent job digest',
    description: 'Read a smart transcript digest for an agent companion job by job_id.',
    mimeType: DIGEST_RESOURCE_MIME_TYPE,
  }];
}

export function readDigestResource(uri) {
  const jobId = digestJobIdFromResourceUri(uri);
  if (!jobId) throw new Error(`unknown digest resource uri: ${uri}`);
  const resource = digestResourceForJobId(jobId);
  if (!resource) throw new Error(`digest not found for job_id: ${jobId}`);
  const path = digestPath(jobId);
  return {
    contents: [{
      uri: resource.uri,
      mimeType: DIGEST_RESOURCE_MIME_TYPE,
      text: readFileSync(path, 'utf8'),
    }],
  };
}

function digestUriForJobPrompt(jobId, promptId) {
  return jobId && promptId ? digestResourceUri(jobId) : null;
}

function addDigestReference(obj, { jobId, promptId }) {
  const digestUri = digestUriForJobPrompt(jobId, promptId);
  if (!digestUri) return null;
  obj.digest_uri = digestUri;
  obj.debug = {
    ...(obj.debug && typeof obj.debug === 'object' ? obj.debug : {}),
    digest_path: digestPath(jobId),
  };
  return digestUri;
}

function addDigestMeta(meta, { jobId, promptId }) {
  const digestUri = digestUriForJobPrompt(jobId, promptId);
  if (!digestUri) return null;
  meta.digest_uri = digestUri;
  meta.debug_digest_path = digestPath(jobId);
  return digestUri;
}

function digestResourceLinkForResult(obj) {
  const jobId = obj?.job_id || obj?.meta?.job_id;
  const advertisedUri = obj?.digest_uri || obj?.meta?.digest_uri;
  if (!jobId || !advertisedUri) return null;
  if (advertisedUri !== digestResourceUri(jobId)) return null;
  return { type: 'resource_link', uri: advertisedUri, name: `agent-digest-${jobId}`, mimeType: DIGEST_RESOURCE_MIME_TYPE };
}

// Per-job re-steer availability. Copilot can reply on any live (non-terminal)
// prompt; OpenCode can reply only in server mode with a live session; codex can
// reply only on the app-server transport, where `turn/steer` injects into the
// RUNNING turn (the `codex exec` pipe has no control channel at all).
//
// Every branch keys on the adapter the JOB recorded, never on the live env, so
// flipping CODEX_RUNTIME_ADAPTER/OPENCODE_RUNTIME_ADAPTER mid-flight cannot
// make a running job advertise a capability its own transport does not have.
function jobReplyAvailable(job) {
  if (!job || job.terminalAt) return false;
  const target = job.target;
  if (isAcpTarget(target)) return Boolean(job.promptId);
  if (target === 'opencode') return Boolean(job.opencodeAdapter === 'server' && job.baseUrl && job.sessionId);
  if (target === 'codex') return Boolean(job.codexAdapter === 'appserver' && job.sessionId);
  return false;
}

// Per-job restart-resume availability — whether a respawned bridge could
// reattach to this job. Copilot resumes via the detached daemon; OpenCode server
// jobs resume via the surviving server + persisted session id; codex app-server
// jobs resume via `thread/resume`, which rejoins a RUNNING thread on the shared
// broker and still reads the transcript back from the rollout when the broker
// itself died.
function jobResumeAvailable(job) {
  if (!job) return false;
  const target = job.target;
  if (isAcpTarget(target)) return Boolean(job.promptId && runtimeSupportsDetachedPromptResume(target));
  if (target === 'opencode') return Boolean(job.opencodeAdapter === 'server' && job.baseUrl && job.sessionId);
  if (target === 'codex') return Boolean(job.codexAdapter === 'appserver' && job.sessionId);
  return false;
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
  const response = {
    ok: true,
    job_id: job.jobId,
    target: job.target,
    status,
    prompt_id: data.promptId || job.promptId || null,
    session_id: data.sessionId || job.sessionId || null,
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
    // Per-job capability: whether THIS job can be re-steered / resumed right now,
    // computed from the real predicate rather than the target descriptor. A
    // cli-mode OpenCode job or one without a live session reports false even
    // when the target advertises the capability.
    reply_available: jobReplyAvailable(job),
    resume_available: jobResumeAvailable(job),
    retention_expires_at: data.retentionExpiresAt || iso(job.retentionExpiresAt),
    activity:           includeTimeline ? (Array.isArray(data.activity) ? data.activity : []) : undefined,
    activity_count:     includeTimeline ? (data.activityCount ?? 0) : undefined,
    activity_truncated: includeTimeline ? Boolean(data.activityTruncated) : undefined,
    session_reborn:     Boolean(job.sessionReborn),
    session_retired:    Boolean(job.sessionRetired),
  };
  const failureClass = terminalFailureClass({ ...job, status });
  if (failureClass) response.failure_class = failureClass;
  // Present only when the transport reported it; see lib/usage.mjs.
  if (job.usage) response.usage = job.usage;
  addDigestReference(response, { jobId: job.jobId, promptId: job.promptId });
  return response;
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
const BRIDGE_LIFECYCLE_DETAILS = new Set([
  'target_adapter_non_resumable_after_restart',
  'sdk_adapter_non_resumable_after_restart',
  'rehydrate_no_promptid',
  'target_child_orphaned_by_bridge_restart',
  // Emitted by the hydrate ownership guard when both the owning bridge pid and
  // the companion child pid are gone (the transport-close path, which leaves no
  // hydrate trace of its own).
  'bridge_transport_closed',
]);

// Target-prefix-stripped details that mean "the socket/stream carrying this job
// closed", e.g. `opencode_server_gone` → `server_gone`.
const TRANSPORT_DETAILS = new Set(['server_gone', 'server_unreachable', 'server_watch_error']);

// The app-server itself answered, but a required subordinate runtime could not
// be started. This is definitive bridge-owned evidence, unlike assistant prose.
const RUNTIME_UNAVAILABLE_DETAILS = new Set([
  'bridge_daemon_unreachable',
  'codex_code_mode_host_unavailable',
  'codex_runtime_unavailable',
  // The ACP agent answered `initialize` with a protocol version this daemon
  // does not speak; definitive, bridge-owned, and about the runtime.
  'acp_protocol_mismatch',
]);

// The runtime is not there to be run: spawn could not find/exec it, or the
// shell reported the 127 "command not found" exit.
const RUNTIME_MISSING_RE = /\b(?:ENOENT|EACCES|ENOTDIR)\b|\bexited with code 127\b|\bcommand not found\b/i;
// Socket/stream flap. The runtime may be perfectly healthy; the pipe is not.
const TRANSPORT_RE = /\b(?:EPIPE|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT)\b|socket hang up|stream (?:closed|ended)/i;
// The thread itself is gone. Two codex transports, one class:
//   `codex exec`       — measured on 0.147.0: JSON-RPC code -32600 with the human
//                        reason `no rollout found for thread id`, delivered on
//                        stderr with a completely empty stdout.
//   `codex app-server` — the same `no rollout found for thread id` reason from
//                        `thread/resume`, and `thread not loaded: <id>` from
//                        `thread/read`. Both mean this app-server has no readable
//                        rollout for that id.
//
// The bare `-32600` code is deliberately NOT a signature. On `codex exec` it was a
// safe synonym for the resume rejection because that was the only -32600 the
// transport could emit; on `codex app-server` EVERY error is -32600 and only the
// message distinguishes them (docs/RELIABILITY_REMEDIATION.md, "Error taxonomy"),
// so keying on the code would tell an operator whose steer failed that their
// perfectly alive thread is unrecoverable — the exact misdiagnosis this function
// exists to kill. Nothing is lost by dropping it: the exec rejection carries the
// message text as well as the code.
//
// `thread not found` is deliberately NOT in this class, and that is the opposite of
// what the plan's first taxonomy said. Settled by measurement
// (probes/codex-app-server/unloaded.mjs): a thread with a COMPLETED turn, whose
// app-server was then SIGKILLed, answers a fresh app-server like this —
//
//   thread/loaded/list  -> []                                (not loaded here)
//   thread/read         -> OK, full transcript                (reads from disk!)
//   turn/interrupt      -> -32600 `thread not found: <id>`
//   turn/steer          -> -32600 `thread not found: <id>`
//   thread/resume       -> OK, status {type:"idle"}           (fully recoverable)
//
// So `thread not found` means "not loaded into THIS process", not "gone" — the very
// case the plan measures as fully recoverable. It is also what a genuinely
// nonexistent id returns, so the message cannot tell the two apart and must not be
// used to declare a death. The earlier reading came from
// probes/codex-app-server/errs.mjs, which only ever asked about an all-zero id that
// exists nowhere; with n=1 and that one case degenerate, the generalization did not
// hold. The adapter's answer is structural, not textual: always `thread/resume`
// before `turn/interrupt` / `turn/steer` on a thread this connection did not start.
const THREAD_NOT_RESUMABLE_RE = /no rollout found for thread id|thread not loaded/i;

// Left to the `unknown` fallback, because the thread is alive and only the bridge's
// aim was off:
//   `thread not found: <id>`      — see above: not loaded here, resume fixes it.
//   `no active turn to steer`     — steering an idle thread, or a stale expectedTurnId.
//   `no active turn to interrupt` — cancelling a turn that already ended.
// In all three the thread is alive, so `thread_not_resumable` would be a lie. Neither is
// a lifecycle event (nothing lost ownership of the job), nor a transport flap (the
// RPC round-tripped fine and came back with an answer), and `runtime_unavailable`
// is the only class allowed to name `binaryEnv` — the binary is plainly running.
// `unknown` is what is left, and it is the honest landing: its rendering asserts
// no cause beyond "could not reach", says outright that the bridge will not guess
// one, and hands the operator the captured channels as the evidence.
// One caveat for whoever lands the adapter, to be fixed there and not here: the
// unreachable branches render stdout/stderr only, so a JSON-RPC reason that
// arrives on the job's `error` alone — what codex-runtime.mjs does when the reason
// comes off an event rather than stderr — is classified but never shown.

// Classify an `unreachable` job into one of five failure classes. `evidence` is
// the raw failure text (`error` + stderr) — required because the two
// signature-keyed classes cannot be told apart from `detail` alone.
//
// ORDERING IS LOAD-BEARING. Every detail-keyed test runs BEFORE any text regex.
// A `detail` is set deliberately by the bridge at the point of failure and is
// definitive; the regexes are heuristics over free text that the companion also
// writes to. Testing text first re-creates the exact misdiagnosis this function
// exists to kill: `opencode_server_unreachable` (a transport flap) reclassified
// as `runtime_unavailable` because the assistant's own output happened to quote
// `bash: pnpm: command not found`.
//
// Correspondingly, the caller must NOT feed stdout into `evidence`: on the
// opencode server adapter stdout *is* the assistant's prose. Both signatures the
// text classes exist for (codex's resume rejection, spawn ENOENT / exit 127)
// arrive on stderr, so stdout contributes only false positives here. It is still
// rendered in the operator-facing excerpt — classification and display are
// deliberately different corpora.
//
// `target` is used ONLY to strip the target prefix that the generic worker
// paths bake into their detail strings, so the classifier keys on the condition
// and never on which companion produced it.
export function classifyUnreachable(detail, target, evidence = '') {
  const raw = detail ? String(detail) : '';
  const prefix = target ? `${target}_` : '';
  const key = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const text = typeof evidence === 'string' ? evidence : String(evidence ?? '');

  // --- definitive: keyed on a detail the bridge set itself ---
  if (BRIDGE_LIFECYCLE_DETAILS.has(raw)) return 'bridge_lifecycle';
  if (raw === 'thread_not_resumable') return 'thread_not_resumable';
  // The only class permitted to name `descriptor.binaryEnv`.
  if (RUNTIME_UNAVAILABLE_DETAILS.has(raw)) return 'runtime_unavailable';
  if (raw === 'bridge_timeout' || TRANSPORT_DETAILS.has(key)) return 'runtime_transport';

  // --- heuristic: signature over the failure text, only when no detail spoke ---
  if (THREAD_NOT_RESUMABLE_RE.test(text)) return 'thread_not_resumable';
  if (RUNTIME_MISSING_RE.test(text)) return 'runtime_unavailable';
  if (TRANSPORT_RE.test(text)) return 'runtime_transport';
  // Honest fallback: no signature matched, so do not guess a cause.
  return 'unknown';
}

// One derivation for every machine-readable surface and the human formatter.
// stdout is intentionally excluded: for server adapters it is assistant prose,
// and a quoted missing-command example must not become infrastructure evidence.
export function terminalFailureClass({
  status, detail, target, error, stderr = null, adapterResult = null,
} = {}) {
  if (status !== 'unreachable') return null;
  const errText = typeof stderr === 'string' ? stderr
    : (typeof adapterResult?.stderr === 'string' ? adapterResult.stderr : '');
  const evidence = [error, errText]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n');
  return classifyUnreachable(detail, target, evidence);
}

// Unwrap exactly one level of JSON from an error message. codex delivers
// `error.message` and `turn.failed.error.message` as a JSON-ENCODED STRING
// carrying an API error envelope, e.g.
//   {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"…"}}
// so the operator sees a wall of punctuation with the one useful sentence
// buried inside it. Parse defensively — anything that is not JSON, or is JSON
// without an inner message, is returned verbatim. Never throws: a mangled error
// must still render as *something*.
export function unwrapErrorMessage(raw) {
  if (raw == null) return '';
  if (typeof raw !== 'string') return String(raw);
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('"')) return raw;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return raw; }
  if (typeof parsed === 'string') return parsed;
  if (!parsed || typeof parsed !== 'object') return raw;
  const inner = (parsed.error && typeof parsed.error === 'object') ? parsed.error : parsed;
  if (typeof inner.message === 'string' && inner.message) return inner.message;
  if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  return raw;
}

const MAX_CHANNEL_CHARS = 700;

function tailChars(s, n) { return s.length > n ? `…${s.slice(s.length - (n - 1))}` : s; }

// Inline a truncated tail of one captured channel. Measured on codex 0.147.0:
// a bad `-m <model>` exits 1 with a COMPLETELY EMPTY stderr and the whole error
// on stdout, while a bogus `resume <id>` gives a COMPLETELY EMPTY stdout with
// the whole reason on stderr. Rendering stderr alone therefore loses half the
// failure population outright — and these are precisely the failures where
// nobody opens the digest file. So: both channels, always; empty ones cost
// nothing because they render as nothing.
function channelExcerpt(name, text) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return '';
  return `\n\n**${name} (tail):**\n\`\`\`\n${tailChars(body, MAX_CHANNEL_CHARS)}\n\`\`\``;
}

// Pure formatter: takes the fields a terminal job carries and returns the
// human-readable body. Extracted from emitNotification so buildWaitResponse
// can reuse the exact same formatting when the subagent blocks to completion.
export function formatTerminalContent({
  jobId, status, task, durationMs,
  summary, error, stuckReason, detail, failedTools, promptId,
  sessionReborn = false, sessionRetired = false, digestUri = null,
  target = 'copilot',
  // Captured channels. buildWaitResponse spreads the whole job, so
  // `adapterResult` arrives for free on that path; explicit stdout/stderr let a
  // caller (or a test) supply them directly.
  adapterResult = null, stdout = null, stderr = null,
}) {
  const label = targetLabel(target);
  const rebirthBanner = sessionReborn
    ? `> ⚠ ${label} session was respawned mid-thread; prior in-process conversation context was lost. ` +
      'If your next prompt depends on earlier turns of this thread, restate the relevant context.\n\n'
    : '';
  const taskHeader = rebirthBanner + `Task: ${truncate(task, 200)}\n\n`;
  const duration = durationMs || 0;
  const outText = typeof stdout === 'string' ? stdout
    : (typeof adapterResult?.stdout === 'string' ? adapterResult.stdout : '');
  const errText = typeof stderr === 'string' ? stderr
    : (typeof adapterResult?.stderr === 'string' ? adapterResult.stderr : '');
  const channels = channelExcerpt('stdout', outText) + channelExcerpt('stderr', errText);

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
    return taskHeader + summary.message +
      `\n\n**Tool calls:** ${(summary.toolCalls || []).length}  •  **Duration:** ${Math.round(duration / 1000)}s` +
      filesLine + failedLine;
  }
  if (status === 'completed') {
    return taskHeader +
      `${label} reported completion but returned no assistant message. ` +
      'Treat this as a failed turn and re-dispatch with explicit context.';
  }
  if (status === 'stuck') {
    return taskHeader +
      `${label} got stuck on: \`${stuckReason || 'unknown'}\`.\n\n` +
      (promptId
        ? `Inspect with \`agent_status({ job_id:"${jobId}", verbose:true })\` before deciding whether to recover directly.`
        : 'Prompt inspection is unavailable for this job; decide whether to re-fire or recover directly.');
  }
  if (status === 'failed') {
    // `error` is frequently a JSON-encoded API envelope (a bad `-m` produces
    // exactly that, on stdout, with an empty stderr) — unwrap one level so the
    // operator reads a sentence rather than an escaped blob, and inline both
    // channels so the sentence has its context attached.
    return taskHeader + `${label} job failed: ${unwrapErrorMessage(error) || 'unknown error'}` + channels;
  }
  if (status === 'cancelled') {
    return taskHeader + `${label} job was cancelled.` +
      (summary?.message ? `\n\nPartial output:\n${summary.message}` : '');
  }
  if (status === 'running') {
    return taskHeader + `${label} job exceeded the bridge's wait budget. Runtime was asked to cancel.`;
  }
  if (status === 'timeout') {
    const failedLine = (Array.isArray(failedTools) && failedTools.length)
      ? `\n\n**Failed tools:** ${failedTools.slice(0, 10).join(', ')}` : '';
    const digestHint = (detail) => digestUri
      ? `\n\n**Partial transcript digest:** \`${digestUri}\` — read this MCP resource BEFORE re-dispatching. ${detail}`
      : '';
    const targetDigestLine = digestHint('It contains any captured assistant output, raw stdout/stderr, and job metadata.');
    const digestLine = digestHint(
      'It contains the partial assistant message, files touched, and todos. ' +
      'You may be able to finalise from the digest alone, or use it to scope a much smaller follow-up send.');
    if (!isAcpTarget(target)) {
      return taskHeader +
        `${label} did not finish within the target timeout (${Math.round(duration / 1000)}s).\n\n` +
        'This legacy timeout record does not verify process termination. Recommended next steps for the parent:\n' +
        '- Read the digest resource URI below for any partial output and stderr.\n' +
        '- Decompose the task into a smaller, explicitly-scoped send.' +
        failedLine + targetDigestLine;
    }
    const retiredLine = sessionRetired
      ? `\n\n**Session:** the timed-out ${label} session was retired; the next send on this thread starts a fresh session. Restate any needed context from the digest.`
      : '';
    return taskHeader +
      `${label}'s model turn did not finish within the wait budget (${Math.round(duration / 1000)}s).\n\n` +
      'The daemon is alive; the task was too large for one turn. Recommended next steps for the parent:\n' +
      '- Read the partial-transcript digest resource URI below — sub-agent reports may already cover the work.\n' +
      '- Decompose the task into smaller, explicitly-scoped sub-sends (target ≤ ~100 LOC of source per send).\n' +
      '- Raise `max_wait_sec` (cap 1200s / 20 min per call) if the task is genuinely long.' +
      failedLine + digestLine + retiredLine;
  }
  if (status === 'unreachable') {
    const detailLine = detail ? ` (detail: ${detail})` : '';
    // Classification corpus is `error` + stderr ONLY. stdout is deliberately
    // excluded: on the opencode server adapter it carries the assistant's own
    // prose, so a model quoting `command not found` would otherwise be read as
    // a missing binary. stdout is still rendered below in `channels`.
    const failureClass = terminalFailureClass({ status, detail, target, error, stderr: errText });
    const classLine = `\n\n**Failure class:** \`${failureClass}\``;
    const digestPointer = digestUri
      ? `the digest resource \`${digestUri}\``
      : `the digest/logs under \`${runtimeDir()}\``;

    if (failureClass === 'bridge_lifecycle') {
      // Causally neutral by construction: the bridge genuinely cannot tell
      // which of several outcomes applied, and saying so is more useful than
      // an authoritative-sounding guess. Never names `binaryEnv` — no binary
      // is implicated by a bridge losing ownership of its own job.
      const cause = detail === 'sdk_adapter_non_resumable_after_restart'
        ? 'The experimental Copilot SDK adapter cannot reattach an in-flight prompt after the bridge process restarts. ACP remains the default adapter for restart-resumable jobs.'
        : detail === 'rehydrate_no_promptid'
          ? 'A restarted bridge found this job in flight with no prompt id recorded, so there is nothing left to reattach to.'
          : 'The bridge process that owned this job went away while the job was in flight, and the bridge that replaced it cannot reattach to the work.';
      return taskHeader +
        `The bridge lost ownership of this ${label} job${detailLine}.\n\n` +
        `${cause}\n\n` +
        `This is a bridge-lifecycle event, not a ${label} problem — nothing here implicates the ` +
        'target binary, its configuration, or your PATH. The bridge also cannot tell which of ' +
        'several outcomes actually applied: the companion turn may have completed, may have died ' +
        'when its pipe closed, or may still be running detached. Treat the outcome as unknown ' +
        'rather than failed.\n\n' +
        `**Next:** read ${digestPointer} for whatever was captured before the handover, then ` +
        're-send with the needed context restated.' + classLine + channels;
    }

    if (failureClass === 'thread_not_resumable') {
      return taskHeader +
        `The recorded ${label} thread could not be resumed${detailLine}.\n\n` +
        'The runtime rejected the thread id itself — its rollout is missing, pruned, or was ' +
        'written under a different home directory. This is not a missing-binary condition and ' +
        'retrying the same resume will fail identically.\n\n' +
        '**Next:** start a fresh send and restate the context you need from ' +
        `${digestPointer}.\n\n` +
        'Note: codex reports this on stderr with a completely empty stdout, so the excerpt below ' +
        'may carry only one channel.' + classLine + channels;
    }

    if (failureClass === 'runtime_unavailable') {
      if (detail === 'codex_code_mode_host_unavailable') {
        const partialEvidence = channels || channelExcerpt('assistant output', summary?.message);
        return taskHeader +
          `The Codex app-server was reachable, but its command runner was unavailable${detailLine}.\n\n` +
          'The assistant output below is partial runtime evidence only, not a task verdict. ' +
          'Do not accept it as a review, build, or test conclusion; repair the command runner ' +
          `and re-send after restarting the Codex runtime. Read ${digestPointer} for the captured turn.` +
          classLine + partialEvidence;
      }
      if (detail === 'acp_protocol_mismatch') {
        // The reason lives on `error`, not on a captured channel: say it.
        return taskHeader +
          `The ${label} ACP agent answered a protocol version this bridge does not speak${detailLine}.\n\n` +
          `${unwrapErrorMessage(error) || 'The daemon refused the handshake.'}\n\n` +
          'The daemon pins ACP v1 and does not adapt — the v2 draft renames methods, so guessing would send calls the ' +
          `agent does not have. Install a ${label} release that speaks v1 (or wait for this bridge to adopt the new ` +
          'version), run `node scripts/doctor.mjs`, and re-send.' + classLine + channels;
      }
      if (detail === 'codex_runtime_unavailable') {
        return taskHeader +
          `The Codex app-server runtime was unavailable before a task turn could start${detailLine}.\n\n` +
          'The bridge made at most one guarded broker restart attempt. Run `node scripts/doctor.mjs` ' +
          'to inspect the selected Codex/helper pair, quarantine state, and running-versus-installed broker identity; ' +
          'then re-send after the runtime is healthy.' + classLine + channels;
      }
      // The one class where the binary really is the suspect, and therefore
      // the only one allowed to name `descriptor.binaryEnv`. Wording unchanged.
      let runtimeHint;
      if (isAcpTarget(target)) {
        runtimeHint = `check \`ps -ef | grep acp-daemon\` and tail \`${bridgeLogFile()}\` / \`${daemonLogFile(target)}\` to confirm the ${label} daemon is alive.`;
      } else {
        // Descriptor-driven, not a hardcoded "for OpenCode" lead-in — reachable
        // for any non-copilot target whose binary is missing or not executable.
        const descriptor = getTarget(target);
        const binHint = descriptor
          ? `verify \`${descriptor.binaryEnv}\` or the \`${descriptor.binaryNames[0]}\` CLI is available`
          : 'verify the target binary is installed and on PATH';
        runtimeHint = `check the target binary/configuration and read the digest/logs under \`${runtimeDir()}\`; ${binHint}.`;
      }
      return taskHeader +
        `Bridge could not reach the ${label} runtime${detailLine}.\n\n` +
        `This is infrastructure-level — ${runtimeHint}` + classLine + channels;
    }

    if (failureClass === 'runtime_transport') {
      return taskHeader +
        `The bridge's transport to the ${label} runtime failed mid-job${detailLine}.\n\n` +
        'The runtime may well be installed and healthy: the socket or stream carrying this job ' +
        'closed under it, so the turn can no longer be observed. Whatever the turn completed is ' +
        'simply not visible to the bridge.\n\n' +
        `**Next:** read ${digestPointer}, confirm the runtime process is still alive, and re-send. ` +
        'A repeat means the transport, not the task.' + classLine + channels;
    }

    return taskHeader +
      `Bridge could not reach the ${label} runtime${detailLine}.\n\n` +
      'The bridge has no signature for this failure, so it will not guess a cause. The captured ' +
      `output below and ${digestPointer} are the evidence; do not assume the target binary is at fault ` +
      'without checking it.' + classLine + channels;
  }
  return taskHeader + `Unexpected terminal status: ${status}`;
}

export function emitNotification({
  jobId, status, summary, error, stuckReason, detail = null, duration,
  task, cwd, thread = null, promptId = null, sessionId = null,
  reconciled = false, bridgeReason = null, failedTools = [], reqId = null,
  sessionReborn = false, sessionRetired = false, target = 'copilot', extraMeta = null,
}) {
  if (
    target === 'copilot' &&
    status === 'completed' &&
    typeof summary?.message === 'string' &&
    /(?:^|\n)\s*(?:Info:\s*)?Operation cancelled by user\.?\s*$/i.test(summary.message.trim())
  ) {
    status = 'stuck';
    if (!stuckReason) stuckReason = 'cancelled_before_summary';
  }

  const label = targetLabel(target);

  // Copilot CLI surfaces backend-model failures as stopReason="end_turn" with
  // the error text as the assistant message, so without this remap they'd be
  // classified as "completed" with the error masquerading as content. Cancel
  // takes precedence above (a cancellation during a retry storm is "stuck").
  if (
    target === 'copilot' &&
    status === 'completed' &&
    typeof summary?.message === 'string' &&
    /Error:\s*Execution failed:\s*Error:\s*Failed to get response from the AI model/i.test(summary.message)
  ) {
    status = 'failed';
    if (!detail) detail = 'copilot_capi_failure';
  }
  // The worker normally persists this remap before notifying. Keep the same
  // guard here as a defensive boundary for reconciled/direct notifications so
  // no terminal queue row can promote a command-runner blocker to a verdict.
  if (isCodexCommandRunnerBlocker({ target, status, summary })) {
    status = 'unreachable';
    error = error ||
      'Codex app-server completed the turn only after reporting that its command runner was unavailable; no task verdict was produced.';
    detail = 'codex_code_mode_host_unavailable';
  }
  if (status === 'completed' && isEmptyCompletedSummary(summary)) {
    status = 'failed';
    error = `${label} returned completed without any assistant message, tool calls, or plan updates.`;
    detail = detail || 'empty_completed';
    sessionRetired = true;
  }

  const meta = {
    job_id: jobId, status,
    target,
    duration_ms: String(duration),
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
  const failureClass = terminalFailureClass({
    status, detail, target, error,
    adapterResult: jobs.get(jobId)?.adapterResult ?? null,
  });
  if (failureClass) meta.failure_class = failureClass;
  if (Array.isArray(failedTools) && failedTools.length) meta.failed_tools = failedTools.join(',').slice(0, 80);
  if (reconciled)   meta.reconciled = 'true';
  if (bridgeReason) meta.bridge_reason = String(bridgeReason).slice(0, 40);
  if (reqId)        meta.req_id = String(reqId);
  if (sessionReborn) meta.session_reborn = 'true';
  if (sessionRetired) meta.session_retired = 'true';
  if (extraMeta && typeof extraMeta === 'object') {
    for (const [k, v] of Object.entries(extraMeta)) {
      if (v !== undefined && v !== null) meta[k] = String(v).slice(0, 80);
    }
  }

  // From the job once retained (its one home), or straight off the summary for
  // a notification that never went through retainTerminalJob. Assigned whole,
  // not through extraMeta, whose values are strings sliced to 80 chars.
  const usage = jobs.get(jobId)?.usage ?? summary?.usage ?? null;
  if (usage) meta.usage = usage;

  // Final digest refresh on terminal. We pass the current `status` because
  // the job's stored status may not yet reflect a late remap (e.g. cancelled
  // → stuck) we did above. The resource URI is stable per jobId; surface it
  // whether or not the write succeeded so the parent always knows where to look.
  if (promptId && jobId) {
    if (target && !isAcpTarget(target)) {
      try { refreshDigestForJob(jobs.get(jobId), status); }
      catch (err) { log('WARN', 'emit generic digest write failed:', jobId, err.message); }
    } else {
      try {
        writeDigest(promptId, {
          jobId, status, thread,
          target, targetLabel: label,
          task, sessionId, startedAt: duration ? Date.now() - duration : null,
          terminalAt: Date.now(),
          usage,
        });
      } catch (err) { log('WARN', 'emit digest write failed:', jobId, err.message); }
    }
  }
  const digestUri = addDigestMeta(meta, { jobId, promptId });

  const content = formatTerminalContent({
    jobId, status, task, durationMs: duration,
    summary, error, stuckReason, detail, failedTools, promptId,
    sessionReborn, sessionRetired, digestUri, target,
    // buildWaitResponse spreads the whole job, so it gets this for free. This
    // surface enumerates its fields, so without the explicit hand-off the same
    // job renders with a different failure class and zero channel excerpts when
    // it is delivered through the queue drain — which is the path the parent
    // actually reads when it did not block on agent_wait.
    adapterResult: jobs.get(jobId)?.adapterResult ?? null,
  });

  enqueueEvent({ kind: 'terminal', jobId, content, meta });
  log('INFO', 'emit:', jobId, `status=${status} duration_ms=${duration}${stuckReason ? ` stuck=${stuckReason}` : ''}${detail ? ` detail=${detail}` : ''}${bridgeReason ? ` bridge=${bridgeReason}` : ''}`);
}

function truncate(s, n) { if (!s) return ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// --- Worker -----------------------------------------------------------------

// Legacy recovery observer, retained until the runtime retirement job.
async function runOpenCodeServerWatch({ jobId, reqId, baseUrl, sessionId, promptId, directory = null, task, cwd, thread, startedAt }) {
  const rlog = withReq(reqId, { job_id: jobId });
  let watcher;
  try {
    watcher = await openOpenCodeTurnWatcher({
      baseUrl, sessionId, directory,
      initialLevelCheck: true,
      onEvent: (snapshot) => {
        const job = jobs.get(jobId);
        if (!job || job.promptId !== promptId) return;
        job.adapterResult = { stdout: snapshot.message || '', stderr: '', summary: snapshot };
        refreshDigestForJob(job);
      },
    });
    const result = await watcher.done;

    const currentJob = jobs.get(jobId);

    // Cancel verdict: if the bridge requested an abort for this job, the turn is
    // cancelled regardless of how the stream reported it (OpenCode does not
    // reliably emit MessageAbortedError when aborted mid-reasoning).
    if (currentJob?.cancelRequested && result.status !== 'unreachable') {
      result.status = 'cancelled';
      result.error = null;
      result.detail = 'cancelled';
    }

    // Empty-completed remap: a 'completed' turn with no assistant message, tools,
    // or plan is a failure, matching emitNotification's own remap — keep the
    // retained/persisted status in sync with the notification + digest.
    if (result.status === 'completed' && isEmptyCompletedSummary(result.summary)) {
      result.status = 'failed';
      result.error = 'OpenCode returned completed without any assistant message or tool calls.';
      result.detail = 'empty_completed';
    }

    const duration = Date.now() - startedAt;
    const detail = result.detail
      || (result.status === 'completed' ? null
      : result.status === 'cancelled' ? 'cancelled'
      : result.status === 'timeout' ? 'opencode_server_timeout'
      : result.status === 'unreachable' ? 'opencode_server_unreachable'
      : 'opencode_server_failed');
    retainTerminalJob(jobId, {
      status: result.status, summary: result.summary, error: result.error,
      stuckReason: null, detail, failedTools: [],
      durationMs: duration, terminalAt: Date.now(), adapterResult: result,
    });
    writeJobDigest(jobs.get(jobId), result);
    emitNotification({
      jobId, status: result.status, summary: result.summary, error: result.error,
      stuckReason: null, detail, duration, task, cwd, thread,
      promptId, sessionId, failedTools: [], reqId, target: 'opencode',
    });
    rlog.info('worker.terminal', { status: result.status, duration_ms: duration });
    log('INFO', 'opencode-server worker terminal:', jobId, `status=${result.status} duration_ms=${duration}`);
  } catch (err) {
    try { watcher?.close(); } catch {}
    const currentJob = jobs.get(jobId);
    if (currentJob && currentJob.promptId !== promptId) return;
    const duration = Date.now() - startedAt;
    // Same rule as the codex twin below: keep what streamed before the watch
    // broke, and store the failure on `adapterResult` so it is what the next
    // render reads. Writing a digest from a value the job does not hold left
    // `job.adapterResult` on the last pre-error snapshot, and emitNotification's
    // re-render then rebuilt the body from it — with the error text gone.
    const partial = jobs.get(jobId)?.adapterResult || null;
    const failure = { stdout: partial?.stdout || '', stderr: err.message, summary: partial?.summary || null };
    retainTerminalJob(jobId, {
      status: 'failed', summary: null, error: err.message,
      stuckReason: null, detail: 'opencode_server_watch_error',
      failedTools: [], durationMs: duration, terminalAt: Date.now(),
      adapterResult: failure,
    });
    writeJobDigest(jobs.get(jobId), failure);
    emitNotification({
      jobId, status: 'failed', summary: null, error: err.message,
      stuckReason: null, detail: 'opencode_server_watch_error',
      duration, task, cwd, thread, promptId, sessionId,
      failedTools: [], reqId, target: 'opencode',
    });
    rlog.warn('worker.watch_catch', { error: err.message });
    log('WARN', 'opencode-server watch catch:', jobId, `err="${err.message}"`);
  }
}

async function resumeOpenCodeServerJob(job) {
  const jobId = job.jobId;
  const reqId = job.reqId || createReqId();
  const startedAt = job.startedAt || Date.now();
  const promptId = job.promptId || openCodeServerPromptId(jobId);
  log('INFO', 'opencode-server resume:', jobId, `session=${job.sessionId} base=${job.baseUrl}`);

  if (await probeOpenCodeServerHealth(job.baseUrl)) {
    // Surviving server: the watcher's initial level-check harvests a turn that
    // finished while the bridge was down, or reattaches a still-running one.
    await runOpenCodeServerWatch({
      jobId, reqId, baseUrl: job.baseUrl, sessionId: job.sessionId, promptId, directory: job.cwd || null,
      task: job.task || '', cwd: job.cwd || null,
      thread: job.thread || null, startedAt,
    });
    return;
  }

  // Original server gone. Sessions persist on disk, so a fresh server can still
  // serve the transcript; but an unfinished turn cannot be observed anymore.
  let baseUrl = null;
  try { ({ baseUrl } = await ensureOpenCodeServer()); }
  catch (err) {
    retainTerminalJob(jobId, {
      status: 'unreachable',
      error: `opencode server gone and respawn failed: ${err.message}`,
      detail: 'opencode_server_gone', terminalAt: Date.now(),
    });
    writeJobDigest(jobs.get(jobId), jobs.get(jobId)?.adapterResult || null);
    return;
  }
  updateJob(jobId, { baseUrl });
  let transcript = null;
  try { transcript = await loadOpenCodeTranscript({ baseUrl, sessionId: job.sessionId, directory: job.cwd || null }); }
  catch (err) { log('WARN', 'opencode-server resume transcript failed:', jobId, err.message); }
  if (transcript?.completed) {
    finalizeResumedOpenCodeTranscript(job, transcript, reqId, startedAt);
    return;
  }
  retainTerminalJob(jobId, {
    status: 'unreachable',
    error: 'the opencode server that ran this turn is gone; the in-flight turn was lost (session transcript preserved on disk)',
    detail: 'opencode_server_gone', terminalAt: Date.now(),
  });
  writeJobDigest(jobs.get(jobId), jobs.get(jobId)?.adapterResult || null);
}

function finalizeResumedOpenCodeTranscript(job, transcript, reqId, startedAt) {
  const jobId = job.jobId;
  const status = transcript.aborted ? 'cancelled' : (transcript.error ? 'failed' : 'completed');
  const result = {
    status, summary: transcript.summary, error: transcript.error,
    stdout: transcript.summary?.message || '', stderr: '',
  };
  const duration = Date.now() - startedAt;
  const detail = status === 'completed' ? 'resumed_completed'
    : status === 'cancelled' ? 'cancelled' : 'opencode_server_failed';
  retainTerminalJob(jobId, {
    status, summary: transcript.summary, error: transcript.error,
    detail, durationMs: duration, terminalAt: Date.now(), adapterResult: result,
  });
  writeJobDigest(jobs.get(jobId), result);
  emitNotification({
    jobId, status, summary: transcript.summary, error: transcript.error, detail,
    duration, task: job.task, cwd: job.cwd, thread: job.thread,
    promptId: job.promptId, sessionId: job.sessionId, failedTools: [], reqId,
    target: 'opencode',
  });
  log('INFO', 'opencode-server resume terminal:', jobId, `status=${status} (from transcript)`);
}

// Legacy recovery observer, retained until the runtime retirement job.
async function runCodexAppServerWatch({ jobId, reqId, conn, threadId, promptId, model = null, task, cwd, thread, startedAt }) {
  const rlog = withReq(reqId, { job_id: jobId });
  let watcher;
  try {
    // Subscribe BEFORE the turn starts so the first `item/*Delta` cannot be
    // missed. Resume asks for the level check instead — that is what harvests a
    // turn which finished while this bridge was down.
    watcher = await openCodexTurnWatcher({
      conn, threadId, model,
      initialLevelCheck: true,
      onEvent: (snapshot, { turnId } = {}) => {
        const job = jobs.get(jobId);
        if (!job || job.promptId !== promptId) return;
        // `turn/started` is the live source of the id `turn/interrupt` and
        // `turn/steer` require, and it is the one that keeps up when a SECOND
        // turn starts on this thread. Persisted only when it CHANGES: this
        // fires on every streamed delta, and a ledger write per token is a
        // write storm, while a turn id per turn is two.
        if (turnId && turnId !== job.turnId) updateJob(jobId, { turnId });
        // Real sub-turn streaming — this is what closes F7 on this transport:
        // `codex exec --json` emits no deltas at all, so a reasoning-only turn
        // produced no progress signal whatsoever. Same shared digest writer as
        // every other non-copilot job; there is no third one.
        job.adapterResult = { stdout: snapshot.message || '', stderr: '', summary: snapshot };
        refreshDigestForJob(job);
      },
    });
    watcher.markUsagePartial();
    const result = await watcher.done;

    const currentJob = jobs.get(jobId);

    // Cancel verdict: the bridge owns it. An interrupted turn settles
    // `status:"interrupted"` with NO answer, and a turn that raced the
    // interrupt to its own completion reports whatever it reached — so the
    // stream cannot be trusted to report the cancellation, only the intent
    // recorded before the interrupt was sent can.
    if (currentJob?.cancelRequested && result.status !== 'unreachable') {
      result.status = 'cancelled';
      result.error = null;
      result.detail = 'cancelled';
    }

    // A conversational turn can complete even though Codex never acquired its
    // command runner. Normalize that protocol completion before retaining it:
    // the assistant message and turn/completed stop reason remain evidence,
    // while every persisted/status/wait/notification surface gets the honest
    // runtime verdict. Cancellation above deliberately wins this race.
    if (isCodexCommandRunnerBlocker({ target: 'codex', status: result.status, summary: result.summary })) {
      result.status = 'unreachable';
      result.error =
        'Codex app-server completed the turn only after reporting that its command runner was unavailable; no task verdict was produced.';
      result.detail = 'codex_code_mode_host_unavailable';
    }

    // Empty-completed remap, matching emitNotification's own remap so the
    // retained/persisted status stays in sync with the notification + digest.
    if (result.status === 'completed' && isEmptyCompletedSummary(result.summary)) {
      result.status = 'failed';
      result.error = 'Codex returned completed without any assistant message or tool calls.';
      result.detail = 'empty_completed';
    }

    const duration = Date.now() - startedAt;
    // `codex_server_*` reuses the classifier's transport vocabulary on purpose:
    // classifyUnreachable strips the target prefix, so `server_gone` /
    // `server_unreachable` land in `runtime_transport` — which is exactly what
    // a dead broker or a dropped socket is — without a second detail dialect.
    const detail = result.detail
      || (result.status === 'completed' ? null
      : result.status === 'cancelled' ? 'cancelled'
      : result.status === 'timeout' ? 'codex_server_timeout'
      : result.status === 'unreachable'
        ? (result.summary?.stopReason === 'broker-gone' ? 'codex_server_gone' : 'codex_server_unreachable')
        : 'codex_server_failed');
    retainTerminalJob(jobId, {
      status: result.status, summary: result.summary, error: result.error,
      stuckReason: null, detail, failedTools: [],
      durationMs: duration, terminalAt: Date.now(), adapterResult: result,
    });
    writeJobDigest(jobs.get(jobId), result);
    emitNotification({
      jobId, status: result.status, summary: result.summary, error: result.error,
      stuckReason: null, detail, duration, task, cwd, thread,
      promptId, sessionId: threadId, failedTools: [], reqId, target: 'codex',
    });
    rlog.info('worker.terminal', { status: result.status, duration_ms: duration, turn_id: result.turnId || null });
    log('INFO', 'codex-appserver worker terminal:', jobId, `status=${result.status} duration_ms=${duration}`);
  } catch (err) {
    try { watcher?.close(); } catch {}
    const currentJob = jobs.get(jobId);
    if (currentJob && currentJob.promptId !== promptId) return;
    const duration = Date.now() - startedAt;
    // Keep what streamed before the watch broke; the error joins it on stderr
    // rather than replacing it. Stored on `adapterResult` so emitNotification's
    // refresh renders the same thing instead of dropping the reason.
    const partial = jobs.get(jobId)?.adapterResult || null;
    const failure = { stdout: partial?.stdout || '', stderr: err.message, summary: partial?.summary || null };
    retainTerminalJob(jobId, {
      status: 'failed', summary: null, error: err.message,
      stuckReason: null, detail: 'codex_server_watch_error',
      failedTools: [], durationMs: duration, terminalAt: Date.now(),
      adapterResult: failure,
    });
    writeJobDigest(jobs.get(jobId), failure);
    emitNotification({
      jobId, status: 'failed', summary: null, error: err.message,
      stuckReason: null, detail: 'codex_server_watch_error',
      duration, task, cwd, thread, promptId, sessionId: threadId,
      failedTools: [], reqId, target: 'codex',
    });
    rlog.warn('worker.watch_catch', { error: err.message });
    log('WARN', 'codex-appserver watch catch:', jobId, `err="${err.message}"`);
  }
}

// Restart resume for a codex app-server job — THE incident fix. On this
// transport a bridge that dies mid-run is not lost work: the broker owns the
// turn, so there are two tiers and both were measured
// (docs/RELIABILITY_REMEDIATION.md §2, "Two-tier durability").
async function resumeCodexAppServerJob(job) {
  const jobId = job.jobId;
  const reqId = job.reqId || createReqId();
  const startedAt = job.startedAt || Date.now();
  const promptId = job.promptId || codexAppServerPromptId(jobId);
  const threadId = job.sessionId;
  const socketPath = job.brokerSocket || null;
  log('INFO', 'codex-appserver resume:', jobId, `thread=${threadId} socket=${socketPath || '(default)'}`);

  let conn = null;
  try {
    // Socket presence is not liveness, so this is a real connect + broker/status
    // probe, never a stat of the path.
    const health = await probeCodexBrokerHealth(socketPath);
    if (health.alive) {
      // Tier 1 — the broker outlived the bridge, so the turn is either still
      // running or already finished. The watcher's level check harvests it
      // either way: `active` rides the live stream to its terminal, anything
      // else reads the transcript back over RPC.
      conn = await connectCodexBroker({ socketPath });
      await runCodexAppServerWatch({
        jobId, reqId, conn, threadId, promptId, model: job.model ?? null,
        task: job.task || '', cwd: job.cwd || null,
        thread: job.thread || null, startedAt,
      });
      return;
    }
    // Tier 2 — the broker is gone and took the in-flight turn with it. The
    // rollout survives on disk, so a FRESH broker still resumes the thread and
    // `thread/read` still returns the transcript. Only the turn is lost, and
    // that is emphatically NOT `thread_not_resumable`: the thread resumes here
    // to prove it.
    const spawned = await ensureCodexBroker();
    conn = await connectCodexBroker({ socketPath: spawned.socketPath });
    const resumed = await resumeCodexThread({ conn, threadId, model: job.model ?? null });
    const transcript = await readCodexThread({ conn, threadId });
    finalizeResumedCodexThread(job, { transcript, threadStatus: resumed.status, reqId, startedAt, promptId });
  } catch (err) {
    // Leaving the job non-terminal would hang every agent_wait to its clamp —
    // nothing else settles a resumed job.
    log('WARN', 'codex-appserver resume failed:', jobId, err.message);
    const error = `codex app-server resume failed for thread ${threadId}: ${err.message}`;
    // Same reason as the worker catches: the reason has to be on
    // `adapterResult` or emitNotification's refresh renders it away. Nothing the
    // dead bridge wrote is lost — writeJobDigest carries that body forward.
    const failure = { stdout: '', stderr: error, summary: null };
    retainTerminalJob(jobId, {
      status: 'unreachable', error, detail: 'codex_server_unreachable',
      durationMs: Date.now() - startedAt, terminalAt: Date.now(),
      adapterResult: failure,
    });
    writeJobDigest(jobs.get(jobId), failure);
    emitNotification({
      jobId, status: 'unreachable', summary: null, error, stuckReason: null,
      detail: 'codex_server_unreachable', duration: Date.now() - startedAt,
      task: job.task, cwd: job.cwd, thread: job.thread,
      promptId, sessionId: threadId, failedTools: [], reqId, target: 'codex',
    });
  } finally {
    try { conn?.close(); } catch {}
  }
}

// The honest verdict for tier 2. The transcript is real salvage — `thread/read`
// is a DISK reader, measured returning a full transcript from a fresh
// app-server with no prior resume — but the turn that was in flight when the
// broker died did not finish, and nothing in the protocol distinguishes "idle
// because it finished" from "idle because it was killed". Calling that
// `completed` is the silent-destruction failure this plan exists to kill, so
// the job settles `unreachable` with the salvaged content attached and the
// thread named as the live continuation point.
function finalizeResumedCodexThread(job, { transcript, threadStatus, reqId, startedAt, promptId }) {
  const jobId = job.jobId;
  const summary = transcript.found ? transcript.summary : null;
  const salvage = transcript.found
    ? 'its transcript was read back from the rollout and is in the digest'
    : 'its rollout held no assistant message yet';
  const error = `the codex broker that ran this turn is gone; the in-flight turn was lost. `
    + `Thread \`${job.sessionId}\` resumed cleanly on a fresh broker (status ${threadStatus}) and ${salvage}. `
    + 'The thread itself is intact — this is a lost turn, not a lost thread.';
  const result = { status: 'unreachable', summary, error, stdout: summary?.message || '', stderr: '' };
  const duration = Date.now() - startedAt;

  // Whatever the dead bridge streamed into this digest is the only record of
  // that turn, so nothing here replaces it — writeJobDigest carries the prior
  // body forward into every render this process makes for a job it did not
  // start. When there is nothing to salvage the outcome also goes in the
  // sibling note, exactly as the retire path does.
  const retiredNote = transcript.found
    ? null
    : writeRetirementNote(job, { detail: 'codex_server_gone', error, childPid: null, childAlive: false });
  retainTerminalJob(jobId, {
    status: 'unreachable', summary, error, detail: 'codex_server_gone',
    retiredNote, durationMs: duration, terminalAt: Date.now(), adapterResult: result,
  });
  writeJobDigest(jobs.get(jobId), result);
  // Both branches notify. `retainTerminalJob` only resolves a waiter that is
  // already parked; a parent that relies on the queue drain instead would never
  // hear about a restart that happened to salvage nothing.
  emitNotification({
    jobId, status: 'unreachable', summary, error, stuckReason: null,
    detail: 'codex_server_gone', duration,
    task: job.task, cwd: job.cwd, thread: job.thread,
    promptId, sessionId: job.sessionId, failedTools: [], reqId, target: 'codex',
    // The note path is deliberately NOT in extraMeta: every meta value is
    // sliced to 80 chars there, and a truncated absolute path is worse than
    // none. It lives on the job record (`retiredNote`), which is where the
    // retire path already publishes it.
  });
  log('INFO', 'codex-appserver resume terminal:', jobId, `status=unreachable salvaged=${transcript.found} thread_status=${threadStatus}`);
}

// Watch-loop and terminal handling, factored out so a rehydrated bridge can
// re-attach to a daemon-owned promptId without re-running prompt-bg. Called
// from runWorker (fresh prompt) and from rehydrate (recovery after restart).
async function runWatchLoop({ jobId, promptId, sessionId, thread, task, cwd, startedAt, reqId, sessionReborn = false, target = 'copilot' }) {
  const rlog = withReq(reqId, { job_id: jobId });
  try {
    let result;
    while (true) {
      result = await awaitTerminal(promptId, 480, target);
      if (result?.interim) {
        emitAlertNotification({ jobId, task, promptId, alert: result.alert, startedAt, reqId });
        // Real-time digest refresh: every supervisor alert (~60s during
        // silence) regenerates the on-disk digest so a parent that reads
        // the file mid-flight sees an up-to-date snapshot.
        refreshDigestForJob(jobs.get(jobId));
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
      result.error = `${targetLabel(target)} returned completed without any assistant message, tool calls, or plan updates.`;
      result.detail = 'empty_completed';
      retireThreadSid(thread, sessionId, 'empty_completed');
      result.sessionRetired = true;
      rlog.warn('worker.empty_completed', { prompt_id: promptId, session_retired: !!result.sessionRetired });
      log('WARN', 'empty completed remapped:', jobId, `promptId=${promptId} retired=${!!result.sessionRetired}`);
    }

    if (result.status === 'failed' && result.error === 'empty completed response') {
      result.error = `${targetLabel(target)} returned completed without any assistant message, tool calls, or plan updates.`;
      result.detail = 'empty_completed';
      retireThreadSid(thread, sessionId, 'empty_completed');
      result.sessionRetired = true;
    } else if (result.sessionRetired) {
      retireThreadSid(thread, sessionId, result.detail || result.error || 'session_retired');
      result.sessionRetired = true;
    }

    const duration = Date.now() - startedAt;
    const failedTools = failedToolsFromJsonl(promptId, target);
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
      duration, task, cwd, thread,
      promptId, sessionId, failedTools, reqId, sessionReborn,
      sessionRetired: !!result.sessionRetired,
      target,
    });
  } catch (err) {
    await emitWorkerFailure({ jobId, err, startedAt, reqId, task, cwd, thread, rlog, sessionId, target });
  }
}

async function emitWorkerFailure({ jobId, err, startedAt, reqId, task, cwd, thread, rlog, sessionId, target = 'copilot' }) {
  const duration = Date.now() - startedAt;
  const job = jobs.get(jobId);
  const promptId = job?.promptId;
  const currentSessionId = job?.sessionId || sessionId;
  const isReconcilableErr = !!promptId && (
    (err && typeof err.code === 'string' && ['ECONNREFUSED', 'ENOENT', 'EPIPE', 'ETIMEDOUT'].includes(err.code)) ||
    /timeout/i.test(err?.message || '')
  );
  const reconciled = isReconcilableErr ? await reconcileAfterTimeout(promptId, target) : null;
  let status = reconciled?.status ?? 'failed';
  let summary = reconciled?.summary ?? null;
  let error = reconciled?.error ?? err.message;
  let detail = reconciled?.detail ?? null;
  let sessionRetired = false;
  if (status === 'completed' && isEmptyCompletedSummary(summary)) {
    status = 'failed';
    error = `${targetLabel(target)} returned completed without any assistant message, tool calls, or plan updates.`;
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
    failedTools: promptId ? failedToolsFromJsonl(promptId, target) : [],
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
    duration, task, cwd, thread,
    promptId: promptId || null,
    sessionId: currentSessionId || null,
    failedTools: promptId ? failedToolsFromJsonl(promptId, target) : [],
    bridgeReason: reconciled?.bridgeReason || null,
    reconciled: !!reconciled,
    sessionRetired,
    reqId,
    target,
  });
}

async function awaitTerminal(promptId, maxWaitSec, target = 'copilot') {
  // Cap aligned with the daemon's PROMPT_TIMEOUT_MS (25 min). The +120s
  // padding gives the daemon room to return a terminal payload before we
  // give up on the socket roundtrip.
  const timeoutMs = Math.min((maxWaitSec + 120) * 1000, 25 * 60 * 1000);
  const resp = await watchPrompt(
    { promptId, since: 0, raw: false, wait: maxWaitSec, summaryOnly: true, companion: target },
    timeoutMs,
  );
  if (!resp.ok) throw new Error(`await failed: ${resp.error}`);
  return resp.data;
}

async function reconcileAfterTimeout(promptId, target = 'copilot') {
  try {
    const resp = await watchPrompt(
      { promptId, since: 0, raw: false, wait: 0, summaryOnly: true, companion: target },
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

function failedToolsFromJsonl(promptId, target = 'copilot') {
  try {
    const content = readFileSync(promptEventsPath(promptId, target), 'utf8');
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
  const content = [{ type: 'text', text: JSON.stringify(obj) }];
  const digestResourceLink = digestResourceLinkForResult(obj);
  if (digestResourceLink) content.push(digestResourceLink);
  const result = {
    content,
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

// Controller-owned executions never enter the legacy worker/job cache. These
// envelopes are projections of durable records, including on repeated waits.
function executionStatus(result) {
  return ({ completed: 'completed', failed: 'failed', interrupted: 'cancelled', stopped: 'cancelled', delivery_unknown: 'failed' })[result.outcome];
}

function terminalEnvelope(execution, result, action = 'wait') {
  const status = executionStatus(result);
  const evidence = result.stopEvidence;
  const meta = {
    status, job_id: result.executionId, thread: result.owner, target: execution.provider,
    cause: result.cause, detail: result.outcome === 'delivery_unknown' ? 'delivery_unknown' : result.detail ?? null,
    usage: result.usage, selected_model: result.selectedModel ?? null, effective_model: result.effectiveModel ?? null,
    effective_effort: result.effectiveEffort ?? null, native_refs: result.nativeRefs ?? {},
    stop_evidence: evidence ? { gone: evidence.gone, signals: evidence.signals?.length ?? 0,
      survivors: evidence.survivors?.length ?? 0, cleanup_ms: evidence.cleanupMs ?? null,
      detection_delay_ms: evidence.detectionDelayMs ?? null, protocol: evidence.protocol ?? [] } : null,
    digest_uri: digestResourceUri(result.executionId),
  };
  return { ok: true, action, status, job_id: result.executionId, target: execution.provider,
    content: result.text ?? '', meta };
}

function writeExecutionDigest(execution, result) {
  const text = result?.text ?? execution.progress?.partialText ?? '';
  writePrivateFileAtomic(digestPath(execution.executionId), renderDigest([{ type: 'message', text }], execution.nativeTurnId, {
    jobId: execution.executionId, targetLabel: targetLabel(execution.provider), thread: execution.owner,
    task: execution.text, sessionId: execution.historyId, startedAt: execution.startedAt,
    terminalAt: result?.finishedAt, status: result ? executionStatus(result) : execution.state, usage: result?.usage,
  }));
}

function publishResult(records, execution, result) {
  // The immutable per-execution receipt survives queue draining and bridge
  // restarts. Publication is serialized with the same conversation lock as
  // controller writes; status never invokes this writer.
  records._locked(execution.owner, () => {
    if (records.read('completions', execution.executionId)) return;
    writeExecutionDigest(execution, result);
    const envelope = terminalEnvelope(execution, result);
    appendPrivateFile(getQueuePath(), JSON.stringify({ ts: result.finishedAt, consumed: false,
      claudeSessionId: execution.hostSessionId ?? null, kind: 'terminal', jobId: execution.executionId,
      content: envelope.content, meta: envelope.meta }) + '\n');
    records._write('completions', execution.executionId, { executionId: execution.executionId });
  });
}

export function createBridgeController({ env = process.env, records = new Records({ dir: BASE_DIR }), ...options } = {}) {
  const safely = (fn) => (...args) => { try { fn(...args); } catch (err) { log('WARN', 'execution publication failed:', err.message); } };
  return new Controller({ env, records, clock: systemClock,
    providers: { codex: codexProvider({ env }), opencode: opencodeProvider({ env }),
      copilot: acpProvider('copilot', { env }), antigravity: acpProvider('antigravity', { env }) },
    ...options, onProgress: safely(writeExecutionDigest), onResult: safely((execution, result) => publishResult(records, execution, result)),
  });
}
export const controller = createBridgeController();

export async function recoverController(active = controller) {
  for (const execution of active.records.listExecutions()) {
    const conversation = active.records.readConversation(execution.owner);
    if (conversation?.executionId === execution.executionId && execution.state !== 'closed') {
      await active.recover({ owner: execution.owner });
    }
    const result = active.records.readResult(execution.executionId);
    if (result) publishResult(active.records, execution, result);
  }
}

async function handleSend(args, active, request) {
  const provider = args.target || readDefaultTarget(active.env).target;
  if (!provider) return asJson({ ok: false, action: 'send', code: 'TARGET_UNCONFIGURED', error: UNCONFIGURED_SEND_ERROR });
  const sent = await active.send({ owner: args.thread, provider, cwd: args.cwd, text: args.task,
    model: args.model ?? undefined, hostSessionId: getHostSessionId(), ...request });
  return asJson({ ok: true, status: 'still_running', job_id: sent.executionId, thread: args.thread });
}

function runningEnvelope(view, action) {
  const execution = view.execution;
  return { ok: true, action, status: 'still_running', job_id: execution.executionId, target: execution.provider,
    thread: execution.owner, current_status: view.state, started_at: iso(execution.startedAt),
    age_s: Math.round((Date.now() - execution.startedAt) / 1000), session_reborn: false,
    digest_uri: digestResourceUri(execution.executionId),
    hint: 'call agent_wait({ job_id, max_wait_sec }) again to continue blocking.' };
}

async function handleWait(args, active, request) {
  await active.wait({ owner: args.thread, executionId: args.job_id, timeoutMs: clampWaitSec(args.max_wait_sec) * 1000, ...request });
  const view = active.status({ executionId: args.job_id });
  if (!view.result) return asJson(runningEnvelope(view, 'wait'));
  publishResult(active.records, view.execution, view.result);
  markQueueConsumed(args.job_id);
  return asJson(terminalEnvelope(view.execution, view.result));
}

async function handleCancel(args, active, request) {
  await active.cancel({ owner: args.thread, executionId: args.job_id, ...request });
  const view = active.status({ executionId: args.job_id });
  if (!view.result) return asJson(runningEnvelope(view, 'cancel'));
  publishResult(active.records, view.execution, view.result);
  markQueueConsumed(args.job_id);
  return asJson(terminalEnvelope(view.execution, view.result, 'cancel'));
}

async function handleReply({ job_id, message, thread }, active, request) {
  const response = await active.steer({ owner: thread, executionId: job_id, text: message, ...request });
  return asJson({ action: 'reply', job_id, ...response });
}

function handleCatalog() {
  const checks = lastTargetChecks();
  return asJson({
    ok: true, action: 'catalog',
    default_target: defaultTargetInfo(),
    targets: listTargets().filter((t) => t.implemented).map((target) => {
      const model = readDefaultModel(target.id);
      const checked = checks[target.id];
      return {
        id: target.id,
        display_name: target.displayName,
        default: target.default,
        model: {
          ...model,
          description: model.model ? 'configured default' : "inherits the companion's own configuration",
          enumeration: target.id === 'copilot' ? 'documented ids; account availability not checked'
            : target.capabilities.acp || target.id === 'codex' ? 'not enumerable without a session' : 'not cached',
          ...(target.id === 'copilot' ? { allowed: [...ALLOWED_MODELS] } : {}),
        },
        capabilities: Object.fromEntries(['reply', 'resume', 'cancel', 'modelSelection']
          .map((key) => [key, target.capabilities[key]])),
        readiness: {
          ready: checked?.ready ?? null,
          summary: checked ? (checked.ready ? 'ready at last check' : checked.blockers?.[0]?.message || 'not ready') : 'not checked; run agent_status with diagnostics',
          checked_at: checked?.checkedAt || null,
        },
        installed_version: checked?.version || null,
      };
    }),
  });
}

function handleStatus({ job_id, diagnostics }, active) {
  const project = (view) => {
    const { execution: e, result: r, lease, state } = view;
    return { ok: true, action: 'status', job_id: e.executionId, thread: e.owner, target: e.provider, cwd: e.cwd,
      status: r ? executionStatus(r) : state, native_turn_state: e.terminal?.outcome ?? e.state,
      started_at: iso(e.startedAt), terminal_at: iso(r?.finishedAt), lease,
      last_native_activity: e.progress?.lastActivityAt ?? null, active_command: e.progress?.activeCommand ?? null,
      retry: e.progress?.retry ?? null, partial_text: r?.text ?? e.progress?.partialText ?? '',
      stop_evidence: r?.stopEvidence ?? e.cleanup ?? null, usage: r?.usage,
      selected_model: r?.selectedModel ?? e.modelOverride ?? null,
      effective_model: r?.effectiveModel ?? e.progress?.effectiveModel ?? e.effectiveModel ?? null,
      effective_effort: r?.effectiveEffort ?? e.progress?.effectiveEffort ?? e.effectiveEffort ?? null,
      cause: r?.cause ?? null, detail: r?.detail ?? null, native_refs: r?.nativeRefs ?? { historyId: e.historyId, nativeTurnId: e.nativeTurnId },
      digest_uri: digestResourceUri(e.executionId), reply_available: view.replyAvailable };
  };
  let response;
  if (job_id) {
    const view = active.status({ executionId: job_id });
    response = view ? project(view) : { ok: false, action: 'status', status: 'unknown_job', error: 'unknown job_id' };
  } else {
    const executions = active.records.listExecutions().map((e) => project(active.status({ executionId: e.executionId })));
    response = { ok: true, action: 'status', default_target: defaultTargetInfo(), targets: listTargets(),
      running_jobs: executions.filter((e) => !e.terminal_at), executions };
  }
  if (diagnostics) response.diagnostics = { targets: lastTargetChecks() };
  return asJson(response);
}

// --- MCP server setup -------------------------------------------------------

const mcp = new Server(
  { name: 'agent-bridge', version: '0.0.1' },
  {
    capabilities: { tools: {}, resources: {} },
    instructions:
      'Internal transport for the agent-companion subagent; parent harnesses ' +
      'must spawn that subagent rather than call these tools directly. Claude ' +
      'scopes it to the agent; Codex registers it at plugin/session scope so ' +
      'the role can inherit it. Tools: agent_send (returns ' +
      'still_running synchronously), agent_wait (blocks until terminal), ' +
      'agent_catalog, agent_status, agent_reply, and agent_cancel. The companion uses ' +
      'agent_send for kickoff then loops on agent_wait until terminal. ' +
      `Default target is ${defaultTargetId() || 'unset (pass target or run onboarding)'}; ` +
      `supported targets: ${listTargets().map((t) => t.id).join(', ')}; Copilot runtime adapter is ${selectedRuntimeAdapter()}. ` +
      'Read agent_catalog for companions and models. Runtime IPC, logs, prompt streams, digests, and completion ' +
      `queue live under the private directory ${runtimeDir()}.`,
  },
);

mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: listDigestResources(),
}));

mcp.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: listDigestResourceTemplates(),
}));

mcp.setRequestHandler(ReadResourceRequestSchema, async (req) => (
  readDigestResource(req.params.uri)
));

const JOB_ID_FIELD = {
  type: 'string',
  description: 'Target agent companion job id.',
};

const MAX_WAIT_FIELD = {
  type: 'number',
  description:
    'Upper bound on how long the bridge blocks before returning. Default 480, max 1200 seconds.',
};

const TARGET_FIELD = {
  type: 'string',
  enum: listTargetIds(),
  description:
    `Target agent runtime. Supported now: ${listTargetIds().join(', ')}. Omit only when relying on the configured bridge target.`,
};

const AGENT_OUTPUT_SCHEMA = {
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
    target: { type: 'string' },
    thread: { type: 'string' },
    prompt_id: { type: ['string', 'null'] },
    session_id: { type: ['string', 'null'] },
    digest_uri: { type: ['string', 'null'] },
    debug: { type: 'object', additionalProperties: true },
    meta: { type: 'object', additionalProperties: true },
    content: { type: 'string' },
  },
};

const TOOL_ACTIONS = {
  agent_catalog: 'catalog',
  agent_send: 'send',
  agent_wait: 'wait',
  agent_status: 'status',
  agent_reply: 'reply',
  agent_cancel: 'cancel',
};

const INTERNAL_TOOL_NOTE =
  'Internal transport for the agent-companion subagent; parent harnesses should spawn that subagent. ';

const AGENT_TOOLS = [
  {
    name: 'agent_catalog',
    description: INTERNAL_TOOL_NOTE + 'Read configured companions, models and last-checked readiness without starting a runtime or changing state.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: AGENT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'agent_send',
    description:
      INTERNAL_TOOL_NOTE +
      'Enqueue a task on the selected/default companion target and return still_running ' +
      'immediately with job_id. The companion should then loop on agent_wait until terminal.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: TARGET_FIELD,
        task: { type: 'string', description: 'Exact text delivered to the companion, without framing or appended instructions.' },
        model: { type: 'string', description: 'Explicit model override. Omit to inherit the companion configuration.' },
        cwd: {
          type: 'string',
          description: 'Required absolute target repo/worktree path. The bridge refuses to default cwd.',
        },
        max_wait_sec: MAX_WAIT_FIELD,
      },
      required: ['task', 'cwd'],
    },
    outputSchema: AGENT_OUTPUT_SCHEMA,
  },
  {
    name: 'agent_wait',
    description: INTERNAL_TOOL_NOTE +
      'Block on an existing agent job until terminal or until max_wait_sec elapses.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: JOB_ID_FIELD,
        max_wait_sec: MAX_WAIT_FIELD,
      },
      required: ['job_id'],
    },
    outputSchema: AGENT_OUTPUT_SCHEMA,
  },
  {
    name: 'agent_status',
    description: INTERNAL_TOOL_NOTE +
      'Return bridge/target state, or diagnostics for a specific agent job when job_id is provided.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: JOB_ID_FIELD,
        verbose: { type: 'boolean', description: 'Include full activity timeline for a specific job.' },
        diagnostics: { type: 'boolean', description: 'Include environment/runtime doctor output in the status response.' },
      },
    },
    outputSchema: AGENT_OUTPUT_SCHEMA,
  },
  {
    name: 'agent_reply',
    description: INTERNAL_TOOL_NOTE +
      'Re-steer an in-flight agent job with a follow-up message when the companion adapter supports replies.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: JOB_ID_FIELD,
        message: {
          type: 'string',
          description: 'Follow-up text for a running execution whose adapter supports steer. Returns accepted and '
            + 'confirmed separately; unsupported capability or execution state returns reply_unavailable.',
        },
      },
      required: ['job_id', 'message'],
    },
    outputSchema: AGENT_OUTPUT_SCHEMA,
  },
  {
    name: 'agent_cancel',
    description: INTERNAL_TOOL_NOTE + 'Cancel a specific running agent job.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: JOB_ID_FIELD,
      },
      required: ['job_id'],
    },
    outputSchema: AGENT_OUTPUT_SCHEMA,
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: AGENT_TOOLS,
}));

// Turn one MCP tool call into validated dispatch args.
//
// Codex (PR openai/codex#15190) injects per-turn metadata on every MCP tool
// call as `_meta["x-codex-turn-metadata"]`: `session_id` is the ROOT session
// for every agent in it, `thread_id` the calling agent's own thread (measured
// on codex-cli 0.164.0). Session adoption follows validation so an ownerless
// control call cannot hydrate jobs. This is Codex's only host→bridge session-id
// channel. Claude's _meta carries
// claudecode/toolUseId and progressToken, but no session id; its bridge
// inherits CLAUDE_CODE_SESSION_ID (getHostSessionId).
//
// One agent-companion instance is one companion conversation, so every owner's
// thread is named after the calling agent and never after the host session:
// Codex's thread_id here, and on Claude the subagent's agent_id, which only
// hooks can see — hooks/name-thread.sh writes it into `thread` before the call
// leaves the host (including clearing a root caller's fabricated thread).
// Codex requires thread_source=subagent and never trusts an argument as owner.
// Catalog and all status calls are observers, exempt from this owner gate.
const OWNER_ACTIONS = new Set(['send', 'wait', 'reply', 'cancel']);
export function callArgs(action, params) {
  const turn = params?._meta?.['x-codex-turn-metadata'];
  const toolArgs = params?.arguments || {};
  if (Object.prototype.hasOwnProperty.call(toolArgs, 'action')) {
    throw new Error('agent: split MCP tools do not accept an action field; choose the agent_* tool that matches the operation');
  }
  const args = { action, ...toolArgs };
  if (OWNER_ACTIONS.has(action)) {
    if (turn !== undefined || detectHost() === 'codex') {
      args.thread = turn?.thread_source === 'subagent' ? turn.thread_id : null;
    }
    if (typeof args.thread !== 'string' || !args.thread.trim()) {
      throw Object.assign(new Error(
        'agent: native subagent owner required (Claude: hooks/name-thread.sh; Codex: subagent turn metadata)',
      ), { code: 'NATIVE_OWNER_REQUIRED' });
    }
  }
  // Control-tool schemas carry no model-facing thread field. Validate their
  // public arguments, then retain the attributed owner for the controller.
  const { thread, ...publicArgs } = args;
  const normalized = validateAgentArgs(OWNER_ACTIONS.has(action) && action !== 'send' ? publicArgs : args);
  if (OWNER_ACTIONS.has(action)) normalized.thread = thread;
  // An owner refusal must not adopt a session or trigger legacy hydration.
  if (OWNER_ACTIONS.has(action) && turn?.session_id && typeof turn.session_id === 'string') adoptHostSessionId(turn.session_id);
  return normalized;
}

mcp.setRequestHandler(CallToolRequestSchema, async (req, extra = {}) => {
  const action = TOOL_ACTIONS[req.params.name];
  if (!action) throw new Error(`unknown tool: ${req.params.name}`);
  try {
    return await dispatch(callArgs(action, req.params), { requestId: extra.requestId, signal: extra.signal });
  } catch (err) {
    if (['NATIVE_OWNER_REQUIRED', 'INVALID_CWD'].includes(err?.code)) {
      return asJson({ ok: false, action, status: err.code, code: err.code, error: err.message });
    }
    if (err && err.code === 'BRIDGE_SID_CONFLICT') {
      log('ERROR', 'sid conflict on MCP call:', err.message);
      return asJson({ ok: false, error: err.message, code: 'BRIDGE_SID_CONFLICT' });
    }
    if (/^agent: /.test(err?.message || '')) {
      log('WARN', 'invalid MCP arguments:', err.message);
      return invalidArgsResult(err);
    }
    throw err;
  }
});

// Exported dispatcher lets tests drive the action handlers directly without
// going through MCP transport plumbing. Tests that want to exercise the
// MCP `_meta` path go through callArgs, as the MCP handler does.
export async function dispatch(normalized, { controller: active = controller, requestId, signal } = {}) {
  const request = { requestId, signal };
  try {
    switch (normalized.action) {
      case 'catalog': return handleCatalog();
      case 'send':   return await handleSend(normalized, active, request);
      case 'wait':   return await handleWait(normalized, active, request);
      case 'status': return handleStatus(normalized, active);
      case 'reply':  return await handleReply(normalized, active, request);
      case 'cancel': return await handleCancel(normalized, active, request);
      default: throw new Error(`agent: unhandled action "${normalized.action}"`);
    }
  } catch (err) {
    if (!err.code) throw err;
    const existing = ['thread_busy', 'provider_mismatch', 'cwd_mismatch'].includes(err.code)
      ? active.status({ owner: normalized.thread }) : null;
    return asJson({ ok: false, action: normalized.action, code: err.code,
      status: ({ execution_unknown: 'unknown_job', AMBIGUOUS_HISTORY: 'thread_ambiguous' })[err.code] || err.code,
      thread: normalized.thread, job_id: normalized.job_id ?? existing?.execution.executionId,
      ...(existing ? { target: existing.execution.provider, current_status: existing.state } : {}), error: err.message });
  }
}

// Retained for legacy recovery tests; production startup uses recoverController.
let _hydrated = false;
let _swept = false;

// Record a hydrate retirement NEXT TO the digest, never inside it.
//
// Hard constraint (W1.4′): hydrate must never call writeOpenCodeDigest for a
// job it did not start. A fresh bridge has `adapterResult === null` by
// construction, so the "refresh" it used to do rendered a header-only stub over
// whatever the previous bridge had already written — measured shrinking a live
// 11,754-byte digest to 228 bytes. Appending to a sibling file keeps the
// retirement on disk without ever touching the digest body.
function writeRetirementNote(job, { detail, error, childPid, childAlive }) {
  const digest = digestPath(job.jobId);
  if (!digest) return null;
  // `agent-retired-<jobId>.md`, NOT `<digest>-retired.md`: the latter still
  // matches DIGEST_RESOURCE_FILE_RE, so digestJobIdsFromDisk() would read the
  // note back as a job id `<jobId>-retired` and listDigestResources() would
  // publish a phantom `agent-digest://<jobId>-retired` resource for a job that
  // never existed — one per retirement, and nothing GCs them. The `agent-`
  // prefix change keeps the note beside the digest but out of that namespace.
  const path = digest.replace(/agent-digest-([^/]+)\.md$/, 'agent-retired-$1.md');
  // Defensive: if the digest filename ever stops matching, writing anyway would
  // append the note INTO the digest, which is the exact thing this must not do.
  if (path === digest) return null;
  const lines = [
    `# ${job.target || 'unknown target'} job ${job.jobId} - retired by bridge hydrate`,
    '',
    `**Retired:** ${new Date().toISOString()} by bridge pid ${process.pid}`,
    `**Detail:** \`${detail}\``,
    `**Reason:** ${error}`,
    `**Child pid:** ${childPid || '(never recorded)'} (${childAlive ? 'still alive at retirement' : 'gone'})`,
    `**Digest (not modified):** ${digest}`,
  ];
  if (job.sessionId) lines.push(`**Companion session/thread id:** \`${job.sessionId}\``);
  lines.push('');
  try {
    appendPrivateFile(path, lines.join('\n') + '\n');
    return path;
  } catch (err) {
    log('WARN', 'hydrate retirement note failed:', job.jobId, err.message);
    return null;
  }
}

// Retire a non-terminal single-shot job left behind by a previous bridge.
//
// The pid probe is TELEMETRY, NOT A RESUMABILITY TEST. A piped, non-detached
// companion child is doomed at its next stdout write once the bridge that owned
// the pipe dies (measured: pipe + no-detach → `turn_aborted` in 2.2s, no signal
// ever reaching the child), so "alive" describes a window of seconds, not a job
// anything can rejoin. We still retire — leaving the job non-terminal would
// hang every agent_wait to its clamp, because runWatchLoop is copilot-only and
// wait blocks rather than polls. What the probe buys is an honest message: the
// old code declared two jobs dead 56.1s and 4.1s BEFORE their children actually
// died, and blamed the adapter for what a bridge restart did.
//
// Caveat worth knowing when reading the message: a zombie (exited but unreaped)
// child still reports alive, because the pid remains in the table until waited on.
function retireOrphanedCliJob(job, isPidAlive) {
  const label = targetLabel(job.target);
  // The recorded pid is the CHILD this job spawned (worker `onStarted`), and a
  // fresh bridge never started it — so a pid equal to our own can only be a
  // stale ledger row that pid reuse landed on this process. Never claim that.
  const childPid = Number(job.pid);
  const childAlive = childPid !== process.pid && isPidAlive(childPid);
  const detail = childAlive
    ? 'target_child_orphaned_by_bridge_restart'
    : 'bridge_transport_closed';
  const head = childAlive
    ? `${label} child (pid ${childPid}) is still running but was orphaned when the bridge that owned its stdout pipe restarted; nothing can read its output, so it will die at its next write`
    : childPid > 0
      ? `${label} child (pid ${childPid}) died with the bridge process that owned it`
      : `${label} job never recorded a child pid — the bridge died before the runtime started`;
  // Pointers, because the answer to "where did the work go" is on disk, not in
  // this envelope: codex emits its substance atomically at turn end, so the
  // digest of an aborted job holds ~0.2% of the work product and the rollout
  // (keyed by the companion session/thread id) holds the rest.
  const pointers = [];
  const digest = digestPath(job.jobId);
  if (digest) pointers.push(`digest \`${digest}\``);
  if (job.sessionId) pointers.push(`${job.target} session/thread \`${job.sessionId}\` (its rollout holds the full turn)`);
  const error = pointers.length
    ? `${head}. Salvage: ${pointers.join('; ')}.`
    : `${head}.`;
  const retiredNote = writeRetirementNote(job, { detail, error, childPid, childAlive });
  retainTerminalJob(job.jobId, {
    status: 'unreachable',
    error,
    detail,
    childPidAlive: childAlive,
    retiredNote,
    terminalAt: Date.now(),
  });
}

// On bridge startup (or on first sid-bearing action in fallback mode), claim
// any persisted jobs belonging to this Claude Code session. The previous
// bridge for this session (killed by stdio reconnect, crash, etc.) may have
// left in-flight jobs whose Copilot prompts are still running on the still-
// detached daemon. Re-attach the watch loop so wait/status/reply/cancel
// resolve correctly. Idempotent: subsequent calls within the same process
// are no-ops.
// `pidAlive` is a parameter so the ownership guard is testable without a real
// pid: CI must never depend on a pid it does not own still being alive (or
// still being dead) at probe time.
export function hydrateJobsFromLedger({ pidAlive: isPidAlive = pidAlive } = {}) {
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
    const { companionSessionId, ...rest } = persisted;
    const job = { ...rest };
    if (companionSessionId !== undefined) job.sessionId = companionSessionId;
    // Every persisted job carries the target it was created with; a ledger
    // entry without one is corrupt or hand-edited. Skip it loudly rather than
    // silently assuming a companion (no-silent-fallback).
    if (!job.target) {
      log('WARN', 'hydrate skipped: ledger entry has no target:', job.jobId);
      continue;
    }
    jobs.set(job.jobId, job);
    claimed++;

    const isTerminal = !!job.terminalAt;
    const target = job.target;
    // Per target, not per bridge: every ACP daemon is detached except
    // Copilot's experimental SDK adapter, which has no daemon to rejoin.
    const canResumeDetachedPrompts = isAcpTarget(target) && runtimeSupportsDetachedPromptResume(target);

    // If thread + sessionId are both known but the thread file may not
    // exist (original bridge died before writeThreadSid ran), restore it.
    // Do not restore timeout/empty-completed retirements: those sessions are
    // intentionally poisoned and the next send must mint a clean ACP session.
    // A codex app-server job's thread id is restored the same way — it is
    // what the next send on that thread resumes; an exec job's is not, there
    // being nothing to resume on that transport.
    const sidRestorable = isAcpTarget(target)
      ? (isTerminal || canResumeDetachedPrompts)
      : (target === 'codex' && job.codexAdapter === 'appserver');
    if (sidRestorable && job.thread && job.sessionId && !(isTerminal && job.sessionRetired)) {
      try { writeThreadSid(job.thread, job.sessionId); }
      catch (err) { log('WARN', 'hydrate writeThreadSid failed:', err.message); }
    }

    if (!isAcpTarget(target)) {
      // Restart-resumability is a per-JOB property, not a per-target one, and
      // `jobResumeAvailable` is already the predicate that answers it on the
      // wire (`resume_available`) — so hydrate asks it rather than keeping a
      // second copy of the same rule. Two non-copilot transports satisfy it
      // today: an OpenCode server-mode job (the detached `opencode serve` is
      // still listening and the session is persisted on disk), and a codex
      // app-server job (the broker owns the turn, and the rollout survives even
      // the broker). Both are dispatched here; a future restart-resumable
      // target must add its branch to both the predicate and this call site.
      if (!isTerminal && jobResumeAvailable(job)) {
        if (target === 'codex') {
          resumeCodexAppServerJob(job).catch((err) => log('ERROR', 'codex-appserver resume error:', job.jobId, err.message));
        } else {
          resumeOpenCodeServerJob(job).catch((err) => log('ERROR', 'opencode-server resume error:', job.jobId, err.message));
        }
        resumed++;
        continue;
      }
      if (!isTerminal) retireOrphanedCliJob(job, isPidAlive);
      continue;
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
    if (!canResumeDetachedPrompts) {
      retireThreadSid(job.thread, job.sessionId, 'sdk_adapter_non_resumable_after_restart');
      retainTerminalJob(job.jobId, {
        status: 'unreachable',
        error: 'experimental SDK adapter cannot reattach in-flight prompts after bridge restart',
        detail: 'sdk_adapter_non_resumable_after_restart',
        sessionRetired: true,
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
      cwd: job.cwd || null,
      startedAt: job.startedAt || Date.now(),
      reqId: job.reqId || createReqId(),
      target,
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
  // The salvaged digest text is per bridge PROCESS, and a test that resets the
  // module is simulating a new one — keeping the map would let a test read a
  // digest its simulated predecessor wrote as already salvaged, and silently
  // skip the carry-forward.
  digestCarry.clear();
}

export { mcp, jobs, gcExpiredJobs, persistJob, adoptHostSessionId, retainTerminalJob };

// Controller integration seam. Host loss never implements cleanup itself.
let bridgeLossHandler = async () => { log('WARN', 'bridge loss: no controller cleanup handler registered'); };
export function registerBridgeLossHandler(handler) {
  bridgeLossHandler = handler;
}
export async function onBridgeLoss() {
  await bridgeLossHandler();
}

registerBridgeLossHandler(() => controller.bridgeLost());

let bridgeLossPending = false;
async function exitOnBridgeLoss(code) {
  if (bridgeLossPending) return;
  bridgeLossPending = true;
  // EOF may remove the final active handle. Keep the process alive until the
  // async controller handoff finishes; subsequent signals share this exit.
  const keepAlive = setInterval(() => {}, 1000);
  try { await onBridgeLoss(); }
  catch (err) { log('ERROR', 'bridge loss handler failed:', err.message); }
  finally {
    clearInterval(keepAlive);
    process.exit(code);
  }
}

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
  process.on('SIGINT', () => { void exitOnBridgeLoss(130); });
  process.on('SIGTERM', () => { void exitOnBridgeLoss(143); });
  process.stdin.on('end', () => { void exitOnBridgeLoss(0); });
  migrateLegacyState({ log });
  await recoverController();
  // One-line startup log so a user troubleshooting host routing can grep
  // the private runtime bridge log for "host detected" and see what the
  // bridge resolved on this run. The README's Diagnostics section points
  // readers here.
  logEvent('info', 'bridge.startup', { host_detected: detectHost() });

  await mcp.connect(new StdioServerTransport());
}
