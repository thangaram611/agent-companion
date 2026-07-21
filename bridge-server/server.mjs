#!/usr/bin/env node
// agent-bridge MCP server (subagent-isolated, target-generic architecture)
//
// MCP tools: agent_send | agent_wait | agent_status | agent_reply | agent_cancel.
// agent_send takes an optional `target` (opencode | copilot); omitting it uses
// the configured default target, and there is no silent fallback.
// No start/stop/pause/session-gate — this server is spawned inline per invocation
// from the agent-companion subagent's frontmatter, so there is no separate
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

import {
  ensureRuntime,
  promptBg,
  watchPrompt,
  inspectPrompt,
  cancelPrompt,
  replyPrompt,
  selectedRuntimeAdapter,
  runtimeSupportsDetachedPromptResume,
} from './copilot-runtime.mjs';
import {
  log,
  formatPrompt,
  appendRubberDuckReview,
  shouldUseFleet,
  validateAgentArgs,
} from './validation.mjs';
import {
  readDefaultModel,
  isModelAllowedFor,
  readDefaultTarget,
  ALLOWED_MODELS,
  DEFAULT_MODEL,
  readThreadSid, writeThreadSid, clearThread, listThreads,
  readHostSessionThread, writeHostSessionThread,
  writeJob, readJob, listJobsForSession, deleteJob,
} from '../lib/state.mjs';
import {
  loadProfiles,
  getProfile,
  resolveStrength,
  buildSynthesizedProfile,
  listProfilesPublic,
  flatStrengths,
  STRENGTH_CAPABILITY_REQUIREMENTS,
} from '../lib/profile-registry.mjs';
import { sanitizeHostSessionId } from '../lib/host.mjs';
import { queuePath, promptEventsPath, runtimeDir, bridgeLogFile, daemonLogFile, digestDir, appendPrivateFile } from '../lib/runtime-paths.mjs';
import { createReqId, withReq, logEvent } from '../lib/log.mjs';
import { writeDigest, digestPath } from '../lib/prompt-digest.mjs';
import { buildDoctorReport } from '../lib/doctor.mjs';
import {
  cancelOpenCodeRun,
  openCodeRuntimeInfo,
  startOpenCodeRun,
  writeOpenCodeDigest,
} from './opencode-runtime.mjs';
import {
  resolveOpenCodeAdapter,
  openCodeServerActive,
  openCodeServerRuntimeInfo,
  openCodeServerPromptId,
  resolveOpenCodeServerModel,
  parseOpenCodeModel,
  ensureOpenCodeServer,
  createOpenCodeSession,
  startOpenCodeServerPrompt,
  abortOpenCodeSession,
  getOpenCodeSessionStatus,
  openOpenCodeTurnWatcher,
  loadOpenCodeTranscript,
  probeOpenCodeServerHealth,
  openCodeServerPoolSnapshot,
  reapIdleOpenCodeServer,
  syncOpenCodeServerLeases,
  openCodeServerIdleTtlMs,
} from './opencode-server-runtime.mjs';
import {
  defaultTargetInfo,
  defaultTargetId,
  getTarget,
  listTargets,
} from '../lib/target-registry.mjs';

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

// The bridge's resolved host session id. Three sources, in precedence:
//   1. MCP _meta["x-codex-turn-metadata"].session_id — Codex injects this
//      on every CallToolRequest (PR openai/codex#15190); adopted in
//      server.mjs's CallToolRequestSchema handler before dispatch.
//   2. The host_session_id MCP arg —
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

// Dispose the shared `opencode serve` after it has been idle this long with no
// live opencode-server job anywhere on the machine. The server is detached and
// survives bridge restarts by design (that enables resume), so without a reaper
// it would persist forever. The TTL is derived from the job timeout — see
// openCodeServerIdleTtlMs. Leases are the primary guard; this is the backstop.
const OPENCODE_SERVER_IDLE_TTL_MS = openCodeServerIdleTtlMs();

const jobsGcTimer = setInterval(() => {
  gcExpiredJobs();
  const liveOpenCodeServerJobs = [...jobs.entries()]
    .filter(([, j]) => j.target === 'opencode' && j.opencodeAdapter === 'server' && !j.terminalAt)
    .map(([jobId]) => jobId);
  // Renew our leases before reaping so this tick's view of machine-wide
  // liveness includes our own jobs, and so other bridges see them too.
  try { syncOpenCodeServerLeases(liveOpenCodeServerJobs); }
  catch (err) { log('WARN', 'opencode server lease sync failed:', err.message); }
  // Fire-and-forget; never let a dispose HTTP call disrupt the GC tick.
  Promise.resolve(reapIdleOpenCodeServer({
    idleMs: OPENCODE_SERVER_IDLE_TTL_MS,
    hasLiveJobs: liveOpenCodeServerJobs.length > 0,
  })).catch(() => {});
}, JOB_GC_INTERVAL_MS);
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

// Wait-budget clamp. All modes share a single 1200s (20 min) cap; the
// previous mode-aware split (900 ANALYZE / 540 other) was lifted when the
// daemon prompt timeout grew from 10→25 min to accommodate /fleet jobs.
// Claude Code's 600s stream-idle watchdog is satisfied by the companion's
// per-iteration "still running" emission, so the clamp no longer needs to
// stay under it. Codex's per-tool MCP timeout defaults to 120s
// (`codex-rs/codex-mcp/src/rmcp_client.rs:79`) but is user-configurable
// via `[mcp_servers.X].tool_timeout_sec` in the agent TOML — see README's
// Codex install section. Default 480s when input is missing, non-numeric,
// or zero. Floor 1s to avoid no-wait races.
export function clampWaitSec(input) {
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
    inspectAvailable: (patch.target || job.target) === 'copilot' && Boolean(job.promptId || patch.promptId),
  });
  persistJob(jobId);
  resolveAllWaiters(jobId, { terminal: true, job });
  return job;
}

function retireThreadSid(thread, profileId, sessionId, reason) {
  if (!thread || !sessionId) return false;
  try {
    if (readThreadSid(thread, profileId) !== sessionId) return false;
    clearThread(thread, profileId);
    log('WARN', 'thread sid retired:', `thread=${thread} profile=${profileId || '-'} session=${sessionId} reason=${reason}`);
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

// --- Strength/profile routing — the sole SEND routing brain -----------------
//
// resolveRouting({target, profile, strength}, env) generalizes the old
// one-to-one resolveTargetId. It reads ONLY loadProfiles(env) output, applies
// constraint-consistency precedence, runs the pre-spawn capability gate
// (STEP C), and returns {ok:true, resolved} or {ok:false, code, ...}. No silent
// fallback: identical inputs + identical profiles.json → identical outcome.

// Unchanged wording from the pre-#2 TARGET_UNCONFIGURED path.
const UNCONFIGURED_SEND_ERROR =
  'no companion target configured and none passed. Pass target on agent_send, ' +
  'or set a default with `node scripts/onboard.mjs --target <id> --set-default`.';

// STEP C — pre-spawn, statically-knowable capability gate. Only model + adapter
// actually gate under v1 (STRENGTH_CAPABILITY_REQUIREMENTS is an empty no-op map).
function capabilityGate(prof, env) {
  if (!prof.companion) return { ok: false, code: 'TARGET_UNCONFIGURED', error: UNCONFIGURED_SEND_ERROR };
  const descriptor = getTarget(prof.companion, env);
  const caps = prof.capabilities || descriptor?.capabilities || null;
  if (!descriptor || !descriptor.implemented || !caps?.send) {
    return {
      ok: false, code: 'TARGET_UNSUPPORTED', companion: prof.companion,
      error: `target "${prof.companion}" is not a supported companion target (supported: ${listTargets().map((t) => t.id).join(', ')})`,
    };
  }
  const model = prof.model || null;
  if (model) {
    if (caps.modelSelection === false) {
      return { ok: false, code: 'CAPABILITY_UNAVAILABLE', companion: prof.companion, error: `companion "${prof.companion}" cannot select a model but profile pins "${model}"` };
    }
    if (!isModelAllowedFor(prof.companion, model)) {
      if (prof.companion === 'copilot') {
        return {
          ok: false, code: 'MODEL_NOT_ALLOWED', companion: 'copilot', model,
          error: `model "${model}" is not a documented Copilot model`,
          hint: `set the Copilot model to a documented model id (one of: ${[...ALLOWED_MODELS].join(', ')}), or remove it to use the ${DEFAULT_MODEL} default`,
        };
      }
      return { ok: false, code: 'CAPABILITY_UNAVAILABLE', companion: prof.companion, error: `companion "${prof.companion}" model "${model}" is not a valid provider/model pin (expected provider/model)` };
    }
  }
  if (prof.companion === 'opencode' && prof.adapter === 'server' && !caps.serverMode) {
    return { ok: false, code: 'CAPABILITY_UNAVAILABLE', companion: prof.companion, error: 'opencode adapter:"server" requested but server mode is unavailable in this environment' };
  }
  // STRENGTH_CAPABILITY_REQUIREMENTS — no-op under the v1 empty map; populating
  // it later enforces a requirement pre-spawn here with zero other changes.
  for (const declared of prof.strengths) {
    for (const reqCap of STRENGTH_CAPABILITY_REQUIREMENTS[declared] || []) {
      if (!caps[reqCap]) {
        return { ok: false, code: 'CAPABILITY_UNAVAILABLE', companion: prof.companion, error: `strength "${declared}" requires capability "${reqCap}" which companion "${prof.companion}" lacks` };
      }
    }
  }
  return { ok: true };
}

// Bare target-only path: lone profile whose companion===t; if multiple require a
// defaultProfile tiebreak among them or PROFILE_AMBIGUOUS; if none, synthesize
// for the explicit companion (legacy semantics — an explicit target always
// resolves to that companion with the default model).
function resolveBareTarget(load, t, env) {
  const matches = load.profiles.filter((pr) => !pr.synthesized && pr.companion === t);
  if (matches.length === 1) return { ok: true, prof: matches[0] };
  if (matches.length > 1) {
    const dp = load.defaultProfile?.value || null;
    const winner = dp ? matches.find((m) => m.id === dp) : null;
    if (winner) return { ok: true, prof: winner };
    return { ok: false, code: 'PROFILE_AMBIGUOUS', error: `multiple profiles target companion "${t}" with no defaultProfile tiebreak`, candidates: matches.map((m) => m.id) };
  }
  return { ok: true, prof: buildSynthesizedProfile(t, env) };
}

// Zero explicit inputs: defaultProfile wins if it resolves; else the empty/
// no-default edge falls back to the legacy bare-target against default-target
// (so a hand-authored profiles.json that omits defaultProfile but keeps a
// default-target does not newly fail); else TARGET_UNCONFIGURED.
function resolveZeroInput(load, env) {
  const dp = load.defaultProfile?.value || null;
  if (dp) {
    const prof = getProfile(load, dp);
    if (prof) return { ok: true, prof };
    // A configured defaultProfile that names no profile is a loud error, not a
    // silent fall-through to default-target — the cardinal no-silent-fallback
    // rule (handoff §"never silently ignored"). The synthesized registry's
    // defaultProfile always resolves, so this only fires on a real typo.
    return {
      ok: false, code: 'PROFILE_UNKNOWN',
      error: `defaultProfile "${dp}" names no configured profile`,
      candidates: load.profiles.filter((pr) => !pr.synthesized).map((pr) => pr.id),
    };
  }
  const dt = readDefaultTarget(env).target;
  if (dt) return resolveBareTarget(load, dt, env);
  return { ok: false, code: 'TARGET_UNCONFIGURED', error: UNCONFIGURED_SEND_ERROR };
}

export function resolveRouting({ target = null, profile = null, strength = null } = {}, env = process.env) {
  const t = target ? String(target).trim().toLowerCase() : null;
  const p = profile ? String(profile).trim() : null;
  const s = strength ? String(strength).trim().toLowerCase() : null;
  const load = loadProfiles({ env });
  const publicIds = () => load.profiles.filter((pr) => !pr.synthesized).map((pr) => pr.id);

  const succeed = (prof, requestedStrength) => {
    const gate = capabilityGate(prof, env);
    if (!gate.ok) return { ...gate, load };
    return {
      ok: true,
      load,
      resolved: {
        profileId: prof.synthesized ? null : prof.id,
        companion: prof.companion,
        model: prof.model || null,
        strengths: prof.strengths.slice(),
        capabilities: prof.capabilities,
        adapter: prof.adapter || null,
        synthesized: !!prof.synthesized,
        strength: requestedStrength || null,
      },
    };
  };

  // STEP A — constraint-consistency precedence.
  if (p && s) return { ok: false, code: 'ROUTING_CONFLICT', error: 'pass only one of profile or strength', load };

  let prof = null;
  let requestedStrength = null;

  if (p) {
    prof = getProfile(load, p);
    if (!prof) return { ok: false, code: 'PROFILE_UNKNOWN', error: `no configured profile "${p}"`, candidates: publicIds(), load };
  } else if (s) {
    const r = resolveStrength(load, s);
    if (r.status === 'unconfigured') return { ok: false, code: 'STRENGTH_UNCONFIGURED', error: `no configured profile declares strength "${s}"`, candidates: publicIds(), load };
    if (r.status === 'ambiguous') return { ok: false, code: 'STRENGTH_AMBIGUOUS', error: `strength "${s}" is declared by multiple profiles with no defaultProfile tiebreak`, candidates: r.candidates, load };
    prof = getProfile(load, r.profileId);
    requestedStrength = s;
  } else if (t) {
    const bt = resolveBareTarget(load, t, env);
    if (!bt.ok) return { ...bt, load };
    prof = bt.prof;
  } else {
    const zi = resolveZeroInput(load, env);
    if (!zi.ok) return { ...zi, load };
    prof = zi.prof;
  }

  // target refinement: an explicit target co-existing with profile/strength must
  // agree with the resolved profile's companion.
  if (t && (p || s) && prof.companion !== t) {
    return { ok: false, code: 'ROUTING_CONFLICT', error: `resolved profile targets companion "${prof.companion}" but explicit target is "${t}"`, load };
  }

  return succeed(prof, requestedStrength);
}

function targetLabel(id) {
  return getTarget(id)?.displayName || id || 'unknown target';
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
  if (job.target && job.target !== 'copilot') {
    return writeOpenCodeDigest({ ...job, status: statusOverride || job.status || 'running' }, job.adapterResult || null);
  }
  try {
    return writeDigest(job.promptId, {
      jobId:      job.jobId,
      status:     statusOverride || job.status || 'running',
      mode:       job.mode || null,
      template:   job.template || null,
      thread:     job.thread || null,
      parallel:   !!job.fleet,
      parallelStrategy: job.parallelStrategy || null,
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

const DIGEST_RESOURCE_SCHEME = 'agent-digest';
const DIGEST_RESOURCE_MIME_TYPE = 'text/markdown';
const DIGEST_RESOURCE_FILE_RE = /^agent-digest-([a-zA-Z0-9._-]+)\.md$/;
const DIGEST_RESOURCE_URI_RE = /^agent-digest:\/\/([a-zA-Z0-9._-]+)$/;

export function digestResourceUri(jobId) {
  if (!digestPath(jobId)) return null;
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
  const resource = digestResourceForJobId(jobId);
  return resource ? { type: 'resource_link', ...resource } : null;
}

// Per-job re-steer availability. Copilot can reply on any live (non-terminal)
// prompt; OpenCode can reply only in server mode with a live session.
function jobReplyAvailable(job) {
  if (!job || job.terminalAt) return false;
  const target = job.target;
  if (target === 'copilot') return Boolean(job.promptId);
  if (target === 'opencode') return Boolean(job.opencodeAdapter === 'server' && job.baseUrl && job.sessionId);
  return false;
}

// Per-job restart-resume availability — whether a respawned bridge could
// reattach to this job. Copilot resumes via the detached daemon; OpenCode server
// jobs resume via the surviving server + persisted session id.
function jobResumeAvailable(job) {
  if (!job) return false;
  const target = job.target;
  if (target === 'copilot') return Boolean(job.promptId && runtimeSupportsDetachedPromptResume());
  if (target === 'opencode') return Boolean(job.opencodeAdapter === 'server' && job.baseUrl && job.sessionId);
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
    mode: job.mode || null,
    parallel: job.parallelStrategy || null,
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
  addDigestReference(response, { jobId: job.jobId, promptId: job.promptId });
  return response;
}

// --- Waiters ----------------------------------------------------------------
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
      target: job.target,
      // Surface thread even on still_running so a crash+resume can still
      // recover it. (thread-continuity invariant.)
      thread: job.thread || null,
      current_status: job.status || 'running',
      parallel: job.parallelStrategy || null,
      fleet: Boolean(job.fleet),
      started_at: iso(job.startedAt),
      age_s: Math.round((Date.now() - (job.startedAt || Date.now())) / 1000),
      // Mirror the terminal digest field so a poll that catches the job mid-run
      // still sees the rebirth signal — without this, callers using {wait,
      // max_wait_sec} would only learn about the lost context on the next
      // poll iteration that resolves terminally.
      session_reborn: Boolean(job.sessionReborn),
      // Resource URI for the smart-transcript digest the parent can read for an
      // up-to-date progress summary without making another status round-trip.
      hint: 'call agent_wait({ job_id, max_wait_sec }) again to continue blocking.',
    };
    addDigestReference(stillRunning, { jobId: job.jobId, promptId: job.promptId });
    if (job.reattached) stillRunning.reattached = true;
    return asJson(stillRunning);
  }
  markQueueConsumed(job.jobId);
  // Final digest refresh for terminal-via-wait. This is the path the
  // companion's wait loop hits when a long job finishes; without this the
  // digest can lag behind by one supervisor-alert window (~60s).
  refreshDigestForJob(job, job.status);
  const meta = {
    job_id: job.jobId, status: job.status,
    target: job.target,
    mode: job.mode || 'EXECUTE',
    parallel: job.parallelStrategy || '',
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
  const digestUri = addDigestMeta(meta, { jobId: job.jobId, promptId: job.promptId });
  return asJson({
    ok: true, action: 'wait', status: job.status,
    job_id: job.jobId,
    target: job.target,
    duration_ms: job.durationMs || null,
    content: formatTerminalContent({ ...job, digestUri, target: job.target }),
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
  sessionReborn = false, sessionRetired = false, digestUri = null,
  target = 'copilot',
}) {
  const label = targetLabel(target);
  const rebirthBanner = sessionReborn
    ? `> ⚠ ${label} session was respawned mid-thread; prior in-process conversation context was lost. ` +
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
    return taskHeader + `${label} job failed: ${error || 'unknown error'}`;
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
      'It contains the partial assistant message, /fleet sub-agent reports (often near-complete), files touched, and todos. ' +
      'You may be able to finalise from the digest alone, or use it to scope a much smaller follow-up send.');
    if (target !== 'copilot') {
      return taskHeader +
        `${label} did not finish within the target timeout (${Math.round(duration / 1000)}s).\n\n` +
        'The bridge terminated the target process. Recommended next steps for the parent:\n' +
        '- Read the digest resource URI below for any partial output and stderr.\n' +
        '- Decompose the task into a smaller, explicitly-scoped send.\n' +
        '- If the task is genuinely long, raise `AGENT_COMPANION_OPENCODE_TIMEOUT_MS` and retry.' +
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
      '- For ANALYZE on large files, pass `template_args.scope_hint` (e.g. "imports/types only", "lines 1-120") to bind the analysis to a specific section.\n' +
      '- Raise `max_wait_sec` (cap 1200s / 20 min for all modes) if the task is genuinely long.\n' +
      "- Try `parallel: \"never\"` once if you suspect /fleet's coordination overhead is the bottleneck for a strictly linear task." +
      failedLine + digestLine + retiredLine;
  }
  if (status === 'unreachable') {
    if (detail === 'sdk_adapter_non_resumable_after_restart') {
      return taskHeader +
        'The experimental Copilot SDK adapter cannot reattach an in-flight prompt after the bridge process restarts.\n\n' +
        'Start a fresh send and restate the needed context. ACP remains the default adapter for restart-resumable jobs.';
    }
    const detailLine = detail ? ` (detail: ${detail})` : '';
    const runtimeHint = target === 'copilot'
      ? `check \`ps -ef | grep copilot-acp-daemon\` and tail \`${bridgeLogFile()}\` / \`${daemonLogFile()}\` to confirm the daemon is alive.`
      : `check the target binary/configuration and read the digest/logs under \`${runtimeDir()}\`; for OpenCode verify \`OPENCODE_BIN\` or the \`opencode\` CLI is available.`;
    return taskHeader +
      `Bridge could not reach the ${label} runtime${detailLine}.\n\n` +
      `This is infrastructure-level — ${runtimeHint}`;
  }
  return taskHeader + `Unexpected terminal status: ${status}`;
}

export function emitNotification({
  jobId, status, summary, error, stuckReason, detail = null, duration,
  task, mode, cwd, thread = null, promptId = null, sessionId = null,
  reconciled = false, bridgeReason = null, failedTools = [], reqId = null,
  sessionReborn = false, sessionRetired = false, fleet = false, target = 'copilot', extraMeta = null,
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
  // → stuck) we did above. The resource URI is stable per jobId; surface it
  // whether or not the write succeeded so the parent always knows where to look.
  if (promptId && jobId) {
    if (target && target !== 'copilot') {
      try { refreshDigestForJob(jobs.get(jobId), status); }
      catch (err) { log('WARN', 'emit generic digest write failed:', jobId, err.message); }
    } else {
      try {
        writeDigest(promptId, {
          jobId, status, mode, template: null, thread, parallel: !!fleet,
          task, sessionId, startedAt: duration ? Date.now() - duration : null,
          terminalAt: Date.now(),
        });
      } catch (err) { log('WARN', 'emit digest write failed:', jobId, err.message); }
    }
  }
  const digestUri = addDigestMeta(meta, { jobId, promptId });

  const content = formatTerminalContent({
    jobId, status, task, mode, durationMs: duration,
    summary, error, stuckReason, detail, failedTools, promptId,
    sessionReborn, sessionRetired, digestUri, target,
  });

  enqueueEvent({ kind: 'terminal', jobId, content, meta });
  if (target === 'copilot' && status === 'completed' && rubberDuck === 'missing') {
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

async function runWorker({ jobId, reqId, task, mode, template, template_args, cwd, thread, profileId = null, model, previousSid, parallel }) {
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
      try { writeThreadSid(thread, profileId, sessionId); }
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

    await runWatchLoop({ jobId, promptId, sessionId, thread, profileId, task, mode, cwd, startedAt, reqId, sessionReborn: !!sessionReborn, fleet });
  } catch (err) {
    // Failure before the prompt was registered (ensureDaemon, prompt-bg, etc).
    // No promptId yet → not reconcilable, just record terminal failure.
    await emitWorkerFailure({ jobId, err, startedAt, reqId, task, mode, cwd, thread, rlog, sessionId: null });
  } finally {
    rlog.info('worker.end', { duration_ms: Date.now() - startedAt });
    log('INFO', 'worker end:', jobId, `duration_ms=${Date.now() - startedAt}`);
  }
}

async function runOpenCodeWorker(args) {
  // CLI single-shot vs HTTP server mode. Server mode (OPENCODE_RUNTIME_ADAPTER=
  // server) unlocks reply/resume/streaming; CLI mode stays the default.
  if (openCodeServerActive()) return runOpenCodeServerWorker(args);
  return runOpenCodeCliWorker(args);
}

// Server-mode worker: ensure a pooled `opencode serve`, create a persisted
// session, subscribe to /event BEFORE prompting (so session.idle can't be
// missed), then drive the turn through the reusable watch helper.
async function runOpenCodeServerWorker({ jobId, reqId, task, mode, template, template_args, cwd, thread, model = null, parallel, target }) {
  const startedAt = Date.now();
  const rlog = withReq(reqId, { job_id: jobId, target });
  rlog.info('worker.start', { mode, template, thread: thread || null, cwd: cwd || null, parallel_strategy: parallel, target, adapter: 'server', model: model || null });
  log('INFO', 'opencode-server worker start:', jobId, `req=${reqId} mode=${mode} template=${template} thread=${thread || '-'} cwd=${cwd} model=${model || '-'}`);
  try {
    const { baseUrl } = await ensureOpenCodeServer();
    const sessionId = await createOpenCodeSession({ baseUrl, directory: cwd, title: thread || jobId });
    const promptId = openCodeServerPromptId(jobId);
    // The session is rooted at `cwd` via ?directory=; mark the adapter so reply/
    // cancel/hydrate gate on what THIS job started with, not the live env.
    updateJob(jobId, { promptId, sessionId, baseUrl, opencodeAdapter: 'server', pid: null, status: 'running', inspectAvailable: false });
    writeOpenCodeDigest(jobs.get(jobId), null);
    rlog.info('worker.session_created', { session_id: sessionId, base_url: baseUrl });
    log('INFO', 'opencode-server session:', jobId, `session=${sessionId} base=${baseUrl} dir=${cwd}`);

    const formatted = formatPrompt({ template, task, mode, template_args, parallel: 'never' });
    await runOpenCodeServerWatch({
      jobId, reqId, baseUrl, sessionId, promptId, directory: cwd,
      prompt: formatted, model, task, mode, cwd, thread, startedAt, fresh: true,
    });
  } catch (err) {
    const duration = Date.now() - startedAt;
    retainTerminalJob(jobId, {
      status: 'failed', summary: null, error: err.message,
      stuckReason: null, detail: 'opencode_server_worker_error',
      failedTools: [], durationMs: duration, terminalAt: Date.now(),
    });
    writeOpenCodeDigest(jobs.get(jobId), { stdout: '', stderr: err.message, summary: null });
    emitNotification({
      jobId, status: 'failed', summary: null, error: err.message,
      stuckReason: null, detail: 'opencode_server_worker_error',
      duration, task, mode, cwd, thread,
      promptId: jobs.get(jobId)?.promptId || null, sessionId: jobs.get(jobId)?.sessionId || null,
      failedTools: [], reqId, target, fleet: false,
    });
    rlog.warn('worker.catch', { error: err.message });
    log('WARN', 'opencode-server worker catch:', jobId, `err="${err.message}"`);
  } finally {
    rlog.info('worker.end', { duration_ms: Date.now() - startedAt });
  }
}

// Drive one OpenCode server turn to terminal. Reused by the fresh worker, by
// reply (re-steer), and by restart resume. `fresh`/`reply` fire prompt_async
// after the watcher subscribes; resume omits the prompt and reattaches.
// A per-job watch generation guard (job.promptId === promptId) ensures a
// superseded turn (after a reply aborts it) never writes a terminal/notification
// over the live one — mirrors the Copilot superseding-prompt logic.
async function runOpenCodeServerWatch({ jobId, reqId, baseUrl, sessionId, promptId, directory = null, prompt = null, model = null, task, mode, cwd, thread, startedAt, fresh = false, reply = false, abortFirst = false }) {
  const rlog = withReq(reqId, { job_id: jobId });
  const timeoutMs = resolveOpenCodeServerTimeoutMs();
  let watcher;
  try {
    // Reply path: abort the in-flight turn and wait for the session to settle
    // BEFORE subscribing/prompting, so the follow-up does not race the old turn
    // or hit SessionBusyError. The handler already bumped job.promptId, so the
    // old watcher discards its terminal when this abort's session.idle lands.
    if (abortFirst) {
      const ab = await abortOpenCodeSession({ baseUrl, sessionId, directory });
      if (!ab.aborted) rlog.warn('reply.abort_unconfirmed', { error: ab.error || null });
      const settled = await waitOpenCodeSessionIdle({ baseUrl, sessionId, directory });
      if (!settled) rlog.warn('reply.session_still_busy', {});
    }
    // Subscribe to the directory-scoped event stream BEFORE prompting so the
    // terminal session.idle can't be missed. Resume omits the prompt and asks
    // the watcher to level-check whether the turn already finished.
    watcher = await openOpenCodeTurnWatcher({
      baseUrl, sessionId, directory, timeoutMs,
      initialLevelCheck: !fresh && !reply,
      onEvent: (snapshot) => {
        const job = jobs.get(jobId);
        if (!job || job.promptId !== promptId) return;
        job.adapterResult = { stdout: snapshot.message || '', stderr: '', summary: snapshot };
        refreshDigestForJob(job);
      },
    });
    if (fresh || reply) {
      // Per-job model (from the resolved profile) overrides the env default; an
      // unset/synthesized job falls back to resolveOpenCodeServerModel()'s env
      // default so the legacy/default path is byte-identical.
      const promptModel = parseOpenCodeModel(model) || resolveOpenCodeServerModel();
      await startOpenCodeServerPrompt({ baseUrl, sessionId, directory, prompt, model: promptModel });
    }
    const result = await watcher.done;

    // Supersede guard: if a reply bumped job.promptId while we waited, this turn
    // is obsolete — drop its terminal so the replacement watch owns the job.
    const currentJob = jobs.get(jobId);
    if (currentJob && currentJob.promptId !== promptId) {
      rlog.info('worker.prompt_obsolete', { prompt_id: promptId, current_prompt_id: currentJob.promptId });
      log('INFO', 'opencode-server obsolete turn ignored:', jobId, `old=${promptId} current=${currentJob.promptId}`);
      return;
    }

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
    const job = jobs.get(jobId);
    if (job) job.adapterResult = result;
    retainTerminalJob(jobId, {
      status: result.status, summary: result.summary, error: result.error,
      stuckReason: null, detail, failedTools: [],
      durationMs: duration, terminalAt: Date.now(), adapterResult: result,
    });
    writeOpenCodeDigest(jobs.get(jobId), result);
    emitNotification({
      jobId, status: result.status, summary: result.summary, error: result.error,
      stuckReason: null, detail, duration, task, mode, cwd, thread,
      promptId, sessionId, failedTools: [], reqId, target: 'opencode', fleet: false,
    });
    rlog.info('worker.terminal', { status: result.status, duration_ms: duration });
    log('INFO', 'opencode-server worker terminal:', jobId, `status=${result.status} duration_ms=${duration}`);
  } catch (err) {
    try { watcher?.close(); } catch {}
    const currentJob = jobs.get(jobId);
    if (currentJob && currentJob.promptId !== promptId) return;
    const duration = Date.now() - startedAt;
    retainTerminalJob(jobId, {
      status: 'failed', summary: null, error: err.message,
      stuckReason: null, detail: 'opencode_server_watch_error',
      failedTools: [], durationMs: duration, terminalAt: Date.now(),
    });
    writeOpenCodeDigest(jobs.get(jobId), { stdout: '', stderr: err.message, summary: null });
    emitNotification({
      jobId, status: 'failed', summary: null, error: err.message,
      stuckReason: null, detail: 'opencode_server_watch_error',
      duration, task, mode, cwd, thread, promptId, sessionId,
      failedTools: [], reqId, target: 'opencode', fleet: false,
    });
    rlog.warn('worker.watch_catch', { error: err.message });
    log('WARN', 'opencode-server watch catch:', jobId, `err="${err.message}"`);
  }
}

function resolveOpenCodeServerTimeoutMs() {
  // Reuse the same timeout knob as the CLI adapter for parity.
  return openCodeServerRuntimeInfo().timeout_ms;
}

// Poll /session/status until the session leaves 'busy' (or a short budget
// elapses). Used between a reply's abort and its re-prompt so OpenCode does not
// reject the follow-up with SessionBusyError.
async function waitOpenCodeSessionIdle({ baseUrl, sessionId, directory, attempts = 20, intervalMs = 150 }) {
  for (let i = 0; i < attempts; i++) {
    const status = await getOpenCodeSessionStatus({ baseUrl, sessionId, directory });
    if (status !== 'busy') return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// Restart resume for an OpenCode server job. An in-flight turn only keeps
// running on the exact server process that started it, so probe the recorded
// base URL first. If it survived, reattach (or harvest a turn that finished
// while the bridge was down). If it is gone, replay the persisted transcript
// from a fresh server; an unfinished turn is unrecoverable.
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
      task: job.task || '', mode: job.mode || 'EXECUTE', cwd: job.cwd || null,
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
    writeOpenCodeDigest(jobs.get(jobId), jobs.get(jobId)?.adapterResult || null);
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
  writeOpenCodeDigest(jobs.get(jobId), jobs.get(jobId)?.adapterResult || null);
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
  job.adapterResult = result;
  retainTerminalJob(jobId, {
    status, summary: transcript.summary, error: transcript.error,
    detail, durationMs: duration, terminalAt: Date.now(), adapterResult: result,
  });
  writeOpenCodeDigest(jobs.get(jobId), result);
  emitNotification({
    jobId, status, summary: transcript.summary, error: transcript.error, detail,
    duration, task: job.task, mode: job.mode, cwd: job.cwd, thread: job.thread,
    promptId: job.promptId, sessionId: job.sessionId, failedTools: [], reqId,
    target: 'opencode', fleet: false,
  });
  log('INFO', 'opencode-server resume terminal:', jobId, `status=${status} (from transcript)`);
}

async function runOpenCodeCliWorker({ jobId, reqId, task, mode, template, template_args, cwd, thread, model = null, parallel, target }) {
  const startedAt = Date.now();
  const rlog = withReq(reqId, { job_id: jobId, target });
  rlog.info('worker.start', { mode, template, thread: thread || null, cwd: cwd || null, parallel_strategy: parallel, target, model: model || null });
  log('INFO', 'opencode worker start:', jobId, `req=${reqId} mode=${mode} template=${template} thread=${thread || '-'} cwd=${cwd} parallel=${parallel} model=${model || '-'}`);
  try {
    const formatted = formatPrompt({ template, task, mode, template_args, parallel: 'never' });
    const result = await startOpenCodeRun({
      jobId,
      cwd,
      prompt: formatted,
      model: model || null,
      onStarted: ({ pid, promptId, command }) => {
        updateJob(jobId, {
          promptId,
          sessionId: null,
          pid,
          runtimeCommand: command,
          status: 'running',
          inspectAvailable: false,
        });
        writeOpenCodeDigest(jobs.get(jobId), null);
        rlog.info('worker.prompt_started', { prompt_id: promptId, pid, command });
        log('INFO', 'opencode worker started:', jobId, `promptId=${promptId} pid=${pid || '-'}`);
      },
    });
    const duration = Date.now() - startedAt;
    const detail = result.status === 'failed'
      ? (result.exitCode == null ? result.signal || 'opencode_failed' : `exit_${result.exitCode}`)
      : result.status === 'cancelled'
        ? (result.signal || 'cancelled')
        : result.status === 'timeout'
          ? 'opencode_timeout'
          : null;
    retainTerminalJob(jobId, {
      status: result.status,
      summary: result.summary,
      error: result.error,
      stuckReason: null,
      detail,
      failedTools: [],
      durationMs: duration,
      terminalAt: Date.now(),
      adapterResult: result,
    });
    writeOpenCodeDigest(jobs.get(jobId), result);
    emitNotification({
      jobId,
      status: result.status,
      summary: result.summary,
      error: result.error,
      stuckReason: null,
      detail,
      duration,
      task,
      mode,
      cwd,
      thread,
      promptId: jobs.get(jobId)?.promptId || null,
      sessionId: null,
      failedTools: [],
      reqId,
      target,
      fleet: false,
    });
    rlog.info('worker.terminal', { status: result.status, duration_ms: duration, exit_code: result.exitCode, signal: result.signal || null });
  } catch (err) {
    const duration = Date.now() - startedAt;
    retainTerminalJob(jobId, {
      status: 'failed',
      summary: null,
      error: err.message,
      stuckReason: null,
      detail: 'opencode_worker_error',
      failedTools: [],
      durationMs: duration,
      terminalAt: Date.now(),
    });
    emitNotification({
      jobId,
      status: 'failed',
      summary: null,
      error: err.message,
      stuckReason: null,
      detail: 'opencode_worker_error',
      duration,
      task,
      mode,
      cwd,
      thread,
      promptId: jobs.get(jobId)?.promptId || null,
      sessionId: null,
      failedTools: [],
      reqId,
      target,
    });
    rlog.warn('worker.catch', { error: err.message });
    log('WARN', 'opencode worker catch:', jobId, `err="${err.message}"`);
  } finally {
    rlog.info('worker.end', { duration_ms: Date.now() - startedAt });
    log('INFO', 'opencode worker end:', jobId, `duration_ms=${Date.now() - startedAt}`);
  }
}

// Watch-loop and terminal handling, factored out so a rehydrated bridge can
// re-attach to a daemon-owned promptId without re-running prompt-bg. Called
// from runWorker (fresh prompt) and from rehydrate (recovery after restart).
async function runWatchLoop({ jobId, promptId, sessionId, thread, profileId = null, task, mode, cwd, startedAt, reqId, sessionReborn = false, fleet = false }) {
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
      retireThreadSid(thread, profileId, sessionId, 'prompt_timeout');
      result.sessionRetired = true;
      rlog.warn('worker.remap_prompt_timeout', { prompt_id: promptId });
      log('INFO', 'remap prompt_timeout:', jobId, `promptId=${promptId} → status=timeout retired=${!!result.sessionRetired}`);
    }

    if (result.status === 'completed' && isEmptyCompletedSummary(result.summary)) {
      result.status = 'failed';
      result.error = 'Copilot returned completed without any assistant message, tool calls, or plan updates.';
      result.detail = 'empty_completed';
      retireThreadSid(thread, profileId, sessionId, 'empty_completed');
      result.sessionRetired = true;
      rlog.warn('worker.empty_completed', { prompt_id: promptId, session_retired: !!result.sessionRetired });
      log('WARN', 'empty completed remapped:', jobId, `promptId=${promptId} retired=${!!result.sessionRetired}`);
    }

    if (result.status === 'failed' && result.error === 'empty completed response') {
      result.error = 'Copilot returned completed without any assistant message, tool calls, or plan updates.';
      result.detail = 'empty_completed';
      retireThreadSid(thread, profileId, sessionId, 'empty_completed');
      result.sessionRetired = true;
    } else if (result.sessionRetired) {
      retireThreadSid(thread, profileId, sessionId, result.detail || result.error || 'session_retired');
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
  const job = jobs.get(jobId);
  const promptId = job?.promptId;
  const profileId = job?.profileId ?? null;
  const currentSessionId = job?.sessionId || sessionId;
  const fleet = !!job?.fleet;
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
    retireThreadSid(thread, profileId, currentSessionId, 'empty_completed');
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

  // Route by target/profile/strength through the sole routing brain. Every
  // resolution error returns the TARGET_UNCONFIGURED envelope shape (echoing
  // candidates + the public profile list); MODEL_NOT_ALLOWED keeps its legacy
  // reason/model/hint fields as a superset.
  const routing = resolveRouting(
    { target: args.target || null, profile: args.profile || null, strength: args.strength || null },
    process.env,
  );
  if (!routing.ok) {
    const envelope = {
      ok: false,
      action: 'send',
      code: routing.code,
      target: routing.companion || null,
      error: routing.error,
      targets: listTargets(),
      profiles: listProfilesPublic(routing.load),
    };
    if (routing.candidates) envelope.candidates = routing.candidates;
    if (routing.code === 'MODEL_NOT_ALLOWED') {
      envelope.reason = 'model-not-allowed';
      envelope.model = routing.model;
      envelope.hint = routing.hint;
    }
    return asJson(envelope);
  }

  const target = routing.resolved.companion;
  const model = routing.resolved.model;
  const profileId = routing.resolved.profileId;
  const routedStrength = routing.resolved.strength;

  // The bridge auto-generates a thread name if the caller (the companion
  // subagent) did not pass one. This is how the companion gets a stable
  // handle it can remember across resumes — main never sees or carries it.
  // Pre-compute the jobId first so we can derive thread = companion-<jobId>.
  const jobId = `${target}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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
    const existingTarget = existing.target;
    if (existingTarget !== target) {
      return asJson({
        ok: false,
        action: 'send',
        status: 'target_mismatch',
        job_id: existing.jobId,
        current_status: existing.status || 'running',
        thread,
        target,
        existing_target: existingTarget,
        error:
          `existing in-flight job ${existing.jobId} on thread ${thread} targets ${existingTarget}, ` +
          `but this send requested ${target}. Wait/cancel the existing job or use a different thread.`,
      });
    }
    const existingProfileId = existing.profileId ?? null;
    if (existingProfileId !== profileId) {
      return asJson({
        ok: false,
        action: 'send',
        status: 'profile_mismatch',
        job_id: existing.jobId,
        current_status: existing.status || 'running',
        thread,
        target,
        existing_profile: existingProfileId,
        requested_profile: profileId,
        error:
          `existing in-flight job ${existing.jobId} on thread ${thread} runs profile ` +
          `${existingProfileId || '(default)'}, but this send resolved to ${profileId || '(default)'}. ` +
          'Wait/cancel the existing job or use a different thread.',
      });
    }
    if (!sameRequiredCwd(existing.cwd, args.cwd)) {
      return asJson({
        ok: false,
        action: 'send',
        status: 'cwd_mismatch',
        job_id: existing.jobId,
        target,
        current_status: existing.status || 'running',
        thread,
        existing_cwd: existing.cwd || null,
        requested_cwd: args.cwd,
        error:
          `existing in-flight job ${existing.jobId} on thread ${thread} is rooted at ` +
          `${existing.cwd || '(unknown)'}, but this send requested ${args.cwd}. ` +
          'Refusing to reattach or start the target in the wrong workspace; wait/cancel the existing job or use a different thread.',
      });
    }
    existing.reattached = true;
    persistJob(existing.jobId);
    const maxWait = clampWaitSec(args.max_wait_sec);
    logEvent('info', 'agent.send.reattached', {
      job_id: existing.jobId, target, thread, host_session: hostSid, status: existing.status || 'running',
    });
    log('INFO', 'agent:send reattached:', `job=${existing.jobId} target=${target} thread=${thread} status=${existing.status}`);
    const outcome = await waitForJob(existing.jobId, maxWait);
    return buildWaitResponse(outcome);
  }

  // Thread → previous Copilot sid. If the caller passed an explicit thread
  // name that doesn't exist yet, readThreadSid returns null (new thread).
  // An auto-generated companion-<jobId> is brand new too, so null.
  // Thread → previous Copilot sid, namespaced by profile (synthesized/legacy →
  // profileId=null → byte-identical <thread>.sid). The model was already
  // validated by the capability gate in resolveRouting.
  let previousSid = null;
  if (target === 'copilot') {
    try { previousSid = readThreadSid(thread, profileId); }
    catch (err) { return asJson({ ok: false, error: err.message }); }
  }

  const reqId = createReqId();
  const fleet = target === 'copilot' && shouldUseFleet({
    parallel: args.parallel,
    template: args.template,
    mode: args.mode,
    task: args.task,
  });
  jobs.set(jobId, {
    jobId, reqId,
    target,
    profileId,
    model,
    strength: routedStrength,
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
  logEvent('info', `${target}.send`, {
    req_id: reqId, job_id: jobId, target,
    profile: profileId, strength: routedStrength,
    template: args.template, mode: args.mode,
    thread, model,
    parallel_strategy: args.parallel,
    fleet,
  });
  log('INFO', 'agent:send', `job=${jobId} req=${reqId} target=${target} profile=${profileId || '-'} strength=${routedStrength || '-'} template=${args.template} mode=${args.mode} thread=${thread} model=${model || '-'} parallel=${args.parallel} fleet=${fleet}`);

  if (target === 'copilot') {
    runWorker({
      jobId, reqId,
      task: args.task, mode: args.mode,
      template: args.template, template_args: args.template_args,
      cwd: args.cwd, thread, profileId, model, previousSid,
      parallel: args.parallel,
    }).catch((err) => log('ERROR', 'worker error:', err.message));
  } else if (target === 'opencode') {
    runOpenCodeWorker({
      jobId, reqId,
      task: args.task, mode: args.mode,
      template: args.template, template_args: args.template_args,
      cwd: args.cwd, thread, profileId, model,
      parallel: args.parallel,
      target,
    }).catch((err) => log('ERROR', 'opencode worker error:', err.message));
  }

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
    target,
    profile: profileId,
    strength: routedStrength,
    thread,
    current_status: job?.status || 'starting',
    parallel: args.parallel,
    fleet,
    started_at: iso(job?.startedAt || Date.now()),
    age_s: 0,
    session_reborn: false,
    hint: 'call agent_wait({ job_id, max_wait_sec }) to block until terminal.',
  });
}

async function handleWait({ job_id, max_wait_sec }) {
  if (!job_id) return asJson({ ok: false, action: 'wait', error: 'job_id required' });
  const max = clampWaitSec(max_wait_sec);
  const outcome = await waitForJob(job_id, max);
  return buildWaitResponse(outcome);
}

async function buildCancelFollowup(job_id, target, cancelMeta = {}) {
  const outcome = await waitForJob(job_id, 5);
  if (outcome.terminal) return buildWaitResponse(outcome);
  return asJson({
    ok: true,
    action: 'cancel',
    status: 'cancelling',
    job_id,
    target,
    cancelled: true,
    ...cancelMeta,
    hint: 'cancel signal accepted; call agent_wait({ job_id, max_wait_sec }) until terminal.',
  });
}

async function handleCancel({ job_id }) {
  if (!job_id) return asJson({ ok: false, action: 'cancel', error: 'job_id required' });
  const job = getJob(job_id);
  if (!job)                                       return asJson({ ok: false, error: 'unknown job_id' });
  const target = job.target;
  if (!job.promptId || job.status === 'starting') return asJson({ ok: false, error: 'job is not yet cancellable' });
  if (job.status !== 'running')                   return asJson({ ok: false, error: `job is ${job.status}` });
  if (target !== 'copilot') {
    // OpenCode server mode aborts the HTTP session turn; the watch loop then
    // observes session.idle with MessageAbortedError and maps it to cancelled.
    // CLI mode signals the spawned `opencode run` child.
    if (target === 'opencode' && job.opencodeAdapter === 'server' && job.baseUrl && job.sessionId) {
      // Record the intent BEFORE aborting: OpenCode's abort does not always emit
      // a MessageAbortedError (a turn aborted mid-reasoning just goes idle), so
      // the watch can't infer cancellation from the stream alone. The bridge
      // initiated it, so it owns the verdict.
      updateJob(job_id, { cancelRequested: true });
      const resp = await abortOpenCodeSession({ baseUrl: job.baseUrl, sessionId: job.sessionId, directory: job.cwd || null });
      if (resp.aborted) {
        return buildCancelFollowup(job_id, target, { reason: 'aborted opencode session turn' });
      }
      return asJson({
        ok: false, action: 'cancel', job_id, target,
        status: 'cancel_failed', cancelled: false,
        reason: resp.error || 'opencode session abort not confirmed',
        error: resp.error || 'opencode session abort not confirmed',
      });
    }
    const resp = cancelOpenCodeRun(job_id, job.pid || null);
    if (resp.ok) {
      return buildCancelFollowup(job_id, target, {
        reason: resp.reason,
        pid: resp.pid || null,
      });
    }
    return asJson({
      ok: false,
      action: 'cancel',
      job_id,
      target,
      status: 'cancel_failed',
      cancelled: false,
      reason: resp.reason,
      pid: resp.pid || null,
      error: resp.reason,
    });
  }
  const resp = await cancelPrompt({ promptId: job.promptId });
  // Cancel also surfaces the job via the cancel MCP response, so mark the
  // queue entry consumed to avoid a duplicate drain injection.
  if (resp.data?.cancelled) {
    markQueueConsumed(job_id);
    return buildCancelFollowup(job_id, target, { reason: resp.data?.reason || null });
  }
  return asJson({
    ok: true, action: 'cancel', status: 'cancel_not_confirmed', job_id, target,
    cancelled: !!resp.data?.cancelled, reason: resp.data?.reason,
  });
}

// OpenCode server re-steer: abort the in-flight turn, bump the per-job watch
// generation so the old watcher drops its (cancelled) terminal, then prompt the
// same session again under a fresh watch. Mirrors Copilot's cancel-then-reprompt
// reply without the daemon socket.
async function handleOpenCodeServerReply(job, message) {
  const job_id = job.jobId;
  if (!job.sessionId || !job.baseUrl) return asJson({ ok: false, action: 'reply', error: 'job has no live opencode session yet — wait for status: running' });
  if (job.terminalAt) return asJson({ ok: false, action: 'reply', error: `job is already ${job.status} — start a new send` });
  if (job.replyInFlight) return asJson({ ok: false, action: 'reply', error: 'reply already in flight for this job' });

  const originalPromptId = job.promptId;
  const replyTurn = (job.replyTurn || 0) + 1;
  const replacementPromptId = openCodeServerPromptId(job_id, replyTurn);
  // Bump the watch generation SYNCHRONOUSLY, before any await. The original
  // turn's watcher is parked on `await watcher.done`; when the abort's
  // session.idle lands it reaches its supersede guard, which must already see
  // the new promptId so it discards the (cancelled) terminal instead of
  // resolving waiters / emitting a spurious cancelled notification over the
  // re-steer. Abort + settle then run inside the background watch so a failed
  // abort or a still-busy session surfaces as the new turn's terminal rather
  // than racing here. (Mirror of Copilot's atomic cancel-then-reprompt.)
  job.replyInFlight = true;
  updateJob(job_id, {
    promptId: replacementPromptId,
    replyTurn,
    status: 'running',
    inspectAvailable: false,
    terminalAt: null,
    retentionExpiresAt: null,
    error: null,
    stuckReason: null,
    detail: null,
  });

  const reqId = job.reqId || createReqId();
  runOpenCodeServerWatch({
    jobId: job_id, reqId,
    baseUrl: job.baseUrl, sessionId: job.sessionId, promptId: replacementPromptId, directory: job.cwd || null,
    prompt: message, model: job.model ?? null, task: job.task || message, mode: job.mode || 'EXECUTE',
    cwd: job.cwd || null, thread: job.thread || null,
    startedAt: job.startedAt || Date.now(), reply: true, abortFirst: true,
  })
    .catch((err) => log('ERROR', 'opencode-server reply watch error:', job_id, err.message))
    .finally(() => { const j = jobs.get(job_id); if (j) { j.replyInFlight = false; persistJob(job_id); } });

  log('INFO', 'agent:reply opencode-server', `job=${job_id} old_prompt=${originalPromptId} new_prompt=${replacementPromptId}`);
  return asJson({
    ok: true, action: 'reply', job_id, target: 'opencode',
    original_prompt_id: originalPromptId,
    new_prompt_id: replacementPromptId,
    session_id: job.sessionId,
    hint: 'reply accepted. The original turn was aborted; the follow-up runs as a new prompt on the same OpenCode session.',
  });
}

async function handleReply({ job_id, message }) {
  // Re-steer an in-flight job. Triple guard: validation rejects missing
  // message; this handler rejects unknown/terminal jobs locally (cheap fast
  // path); the daemon enforces its own per-prompt lock so two concurrent
  // replies cannot race the cancel-and-restart sequence.
  const job = getJob(job_id);
  if (!job) return asJson({ ok: false, action: 'reply', error: 'unknown job_id' });
  const target = job.target;
  if (target === 'opencode') {
    if (job.opencodeAdapter === 'server' && job.baseUrl && job.sessionId) {
      return handleOpenCodeServerReply(job, message);
    }
    return asJson({
      ok: false, action: 'reply', job_id, target, code: 'TARGET_UNSUPPORTED',
      error: 'OpenCode reply requires server mode (OPENCODE_RUNTIME_ADAPTER=server) and a live session; the CLI adapter cannot re-steer — cancel or start a new send.',
    });
  }
  if (target !== 'copilot') {
    return asJson({
      ok: false,
      action: 'reply',
      job_id,
      target,
      code: 'TARGET_UNSUPPORTED',
      error: `${targetLabel(target)} does not support in-flight replies; cancel or start a new send with the revised prompt.`,
    });
  }
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
      profileId: job.profileId ?? null,
      task: job.task || message,
      mode: job.mode || 'EXECUTE',
      cwd: job.cwd || null,
      startedAt: job.startedAt || Date.now(),
      reqId,
      sessionReborn: !!job.sessionReborn,
      fleet: !!job.fleet,
    }).catch((err) => log('ERROR', 'reply watch loop error:', job_id, err.message));

    log('INFO', 'agent:reply', `job=${job_id} old_prompt=${originalPromptId} new_prompt=${replacementPromptId}`);
    return asJson({
      ok: true, action: 'reply', job_id, target,
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

async function handleStatus({ job_id, verbose, diagnostics }) {
  if (job_id) {
    const job = getJob(job_id);
    if (!job) return asJson({ ok: false, error: 'unknown job_id' });
    let inspect = null;
    if (job.promptId && job.target === 'copilot') {
      try { inspect = await fetchPromptInspect(job, { includeTimeline: verbose }); }
      catch (err) { log('WARN', 'status inspect failed:', job_id, err.message); }
    }
    // Refresh the on-disk digest so the caller can read up-to-date detail
    // (sub-agent reports, files touched, todos, partial assistant message)
    // without having to inspect the raw jsonl. This is the primary mechanism
    // the parent agent uses to track progress on long-running /fleet jobs.
    refreshDigestForJob(job);
    const response = buildJobResponse(job, inspect, { includeTimeline: verbose });
    if (diagnostics) response.diagnostics = buildDoctorReport();
    return asJson(response);
  }
  const modelInfo = readDefaultModel();
  // Single producer read for the harness-facing strengths view + the
  // operator-facing default_profile. The strengths array is deliberately
  // id-free (the subagent enumerates it BEFORE sending and routes by label,
  // never by companion/model/profile id).
  const registry = loadProfiles({ env: process.env });
  const response = {
    ok: true, action: 'status',
    default_target: defaultTargetInfo(),
    default_profile: registry.synthesized ? { value: null, source: 'synthesized' } : registry.defaultProfile,
    targets: listTargets(),
    strengths: flatStrengths(registry),
    runtime_adapter: selectedRuntimeAdapter(),
    opencode_runtime: { ...openCodeRuntimeInfo(), ...openCodeServerRuntimeInfo(), server_pool: openCodeServerPoolSnapshot() },
    default_model: modelInfo,
    threads: listThreads(),
    jobs_in_memory: jobs.size,
    running_jobs: [...jobs.values()]
      .filter((j) => !j.terminalAt)
      .map((j) => ({
        job_id: j.jobId,
        target: j.target,
        profile: j.profileId ?? null,
        strength: j.strength ?? null,
        status: j.status || 'starting',
        mode: j.mode || null,
        parallel: j.parallelStrategy || null,
        fleet: Boolean(j.fleet),
        thread: j.thread || null,
        cwd: j.cwd || null,
        prompt_id: j.promptId || null,
        started_at: iso(j.startedAt),
        age_s: Math.round((Date.now() - (j.startedAt || Date.now())) / 1000),
        reply_in_flight: !!j.replyInFlight,
      })),
  };
  if (diagnostics) {
    const report = buildDoctorReport();
    response.diagnostics = report;
    // Operator-facing, diagnostics-gated profile detail (ids + blockers).
    response.profiles = (report.profiles || []).map((p) => ({
      id: p.id, companion: p.companion, model: p.model, strengths: p.strengths,
      ready: p.ready, blockers: p.blockers,
    }));
  }
  return asJson(response);
}

// --- MCP server setup -------------------------------------------------------

const mcp = new Server(
  { name: 'agent-bridge', version: '0.0.1' },
  {
    capabilities: { tools: {}, resources: {} },
    instructions:
      'Internal MCP server for the agent-companion subagent. Spawned inline ' +
      'per invocation by the companion agent. Tools: agent_send (returns ' +
      'still_running synchronously), agent_wait (blocks until terminal), ' +
      'agent_status, agent_reply, and agent_cancel. The companion uses ' +
      'agent_send for kickoff then loops on agent_wait until terminal. ' +
      `Default target is ${defaultTargetId() || 'unset (pass target or run onboarding)'}; ` +
      `supported targets: ${listTargets().map((t) => t.id).join(', ')}; Copilot runtime adapter is ${selectedRuntimeAdapter()}. ` +
      'Route a send by strength (preferred) or profile instead of a concrete ' +
      'target; discover the configured strengths via {action:status} and never ' +
      'pass companion or model ids. ' +
      'Parallel orchestration (Copilot) is strategy-based: auto, always, ' +
      'or never. Runtime IPC, logs, prompt streams, digests, and completion ' +
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

const HOST_SESSION_FIELDS = {
  host_session_id: {
    type: 'string',
    description:
      "Caller's host session id, used to scope queue writes and persisted jobs. " +
      'Claude companion agents forward $CLAUDE_CODE_SESSION_ID under this key on every call; Codex normally uses MCP _meta instead.',
  },
};

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
  enum: ['opencode', 'copilot'],
  description:
    'Target agent runtime. Supported now: opencode and copilot. Omit only when relying on the configured bridge target.',
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
    fleet: { type: 'boolean' },
    parallel: { type: 'string' },
  },
};

const TOOL_ACTIONS = {
  agent_send: 'send',
  agent_wait: 'wait',
  agent_status: 'status',
  agent_reply: 'reply',
  agent_cancel: 'cancel',
};

const AGENT_TOOLS = [
  {
    name: 'agent_send',
    description:
      'Enqueue a task on the selected/default companion target and return still_running ' +
      'immediately with job_id. The companion should then loop on agent_wait until terminal.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: TARGET_FIELD,
        strength: {
          type: 'string',
          description:
            'Route to the configured profile that declares this capability label (e.g. reviewer, ' +
            'web_researcher, planner, fast_executor). Validated server-side against the live profile ' +
            'registry. Discover available strengths via {action:status}; do not hardcode. Mutually ' +
            'exclusive with profile.',
        },
        profile: {
          type: 'string',
          description:
            'Route to a specific configured profile id. Discover ids via {action:status, ' +
            'diagnostics:true}. Mutually exclusive with strength.',
        },
        task: { type: 'string', description: 'Plain-language task for the selected companion target.' },
        mode: {
          type: 'string',
          enum: ['PLAN', 'ANALYZE', 'EXECUTE'],
          description: 'PLAN produces a plan, ANALYZE is read-only, EXECUTE may edit/write/shell.',
        },
        template: {
          type: 'string',
          enum: ['general', 'research', 'plan_review'],
          description:
            'Prompt template. Defaults to general. plan_review requires template_args.plan_path.',
        },
        template_args: {
          type: 'object',
          description: 'Template-specific arguments. Keys are validated per template.',
          additionalProperties: false,
          properties: {
            plan_path:       { type: 'string', description: '[plan_review] Absolute path to the plan .md, or "latest".' },
            focus_directive: { type: 'string', description: '[plan_review] Optional review focus.' },
            scope_hint:      { type: 'string', description: '[general] Scope hint for large-file analysis.' },
          },
        },
        cwd: {
          type: 'string',
          description: 'Required absolute target repo/worktree path. The bridge refuses to default cwd.',
        },
        thread: {
          type: 'string',
          description: 'Optional thread name for conversation continuity where the companion supports it.',
          pattern: '^[a-zA-Z0-9._-]+$',
        },
        max_wait_sec: MAX_WAIT_FIELD,
        parallel: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: 'Parallel orchestration strategy. Defaults to auto.',
        },
        ...HOST_SESSION_FIELDS,
      },
      required: ['cwd'],
    },
    outputSchema: AGENT_OUTPUT_SCHEMA,
  },
  {
    name: 'agent_wait',
    description: 'Block on an existing agent job until terminal or until max_wait_sec elapses.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: JOB_ID_FIELD,
        max_wait_sec: MAX_WAIT_FIELD,
        ...HOST_SESSION_FIELDS,
      },
      required: ['job_id'],
    },
    outputSchema: AGENT_OUTPUT_SCHEMA,
  },
  {
    name: 'agent_status',
    description: 'Return bridge/target state, or diagnostics for a specific agent job when job_id is provided.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: JOB_ID_FIELD,
        verbose: { type: 'boolean', description: 'Include full activity timeline for a specific job.' },
        diagnostics: { type: 'boolean', description: 'Include environment/runtime doctor output in the status response.' },
        ...HOST_SESSION_FIELDS,
      },
    },
    outputSchema: AGENT_OUTPUT_SCHEMA,
  },
  {
    name: 'agent_reply',
    description: 'Re-steer an in-flight agent job with a follow-up message when the companion adapter supports replies.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: JOB_ID_FIELD,
        message: {
          type: 'string',
          description: 'Follow-up text. The bridge cancels and restarts the current turn with this continuation.',
        },
        ...HOST_SESSION_FIELDS,
      },
      required: ['job_id', 'message'],
    },
    outputSchema: AGENT_OUTPUT_SCHEMA,
  },
  {
    name: 'agent_cancel',
    description: 'Cancel a specific running agent job.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: JOB_ID_FIELD,
        ...HOST_SESSION_FIELDS,
      },
      required: ['job_id'],
    },
    outputSchema: AGENT_OUTPUT_SCHEMA,
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: AGENT_TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const action = TOOL_ACTIONS[req.params.name];
  if (!action) throw new Error(`unknown tool: ${req.params.name}`);
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
    const toolArgs = req.params.arguments || {};
    if (Object.prototype.hasOwnProperty.call(toolArgs, 'action')) {
      throw new Error('agent: split MCP tools do not accept an action field; choose the agent_* tool that matches the operation');
    }
    const normalized = validateAgentArgs({ action, ...toolArgs });
    return await dispatch(normalized);
  } catch (err) {
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
// MCP `_meta` path call `adoptHostSessionId(metaSid)` directly before
// invoking dispatch — this matches the MCP handler's own ordering.
export async function dispatch(normalized) {
  // Arg-based session-id adoption (host_session_id is the host-neutral
  // session-id field, validated by validation.mjs::normalizeHostSid).
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
    default: throw new Error(`agent: unhandled action "${normalized.action}"`);
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
  const canResumeDetachedPrompts = runtimeSupportsDetachedPromptResume();
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

    // If thread + sessionId are both known but the thread file may not
    // exist (original bridge died before writeThreadSid ran), restore it.
    // Do not restore timeout/empty-completed retirements: those sessions are
    // intentionally poisoned and the next send must mint a clean ACP session.
    if (target === 'copilot' && job.thread && job.sessionId && !(isTerminal && job.sessionRetired) && (isTerminal || canResumeDetachedPrompts)) {
      try { writeThreadSid(job.thread, job.profileId ?? null, job.sessionId); }
      catch (err) { log('WARN', 'hydrate writeThreadSid failed:', err.message); }
    }

    if (target !== 'copilot') {
      // OpenCode server jobs survive a bridge restart: the detached `opencode
      // serve` is still listening and the session is persisted on disk. Resume
      // reattaches by base URL + session id. Everything else (CLI single-shot,
      // or a server job with no session yet) is non-resumable.
      if (!isTerminal && target === 'opencode' && job.opencodeAdapter === 'server' && job.sessionId && job.baseUrl) {
        resumeOpenCodeServerJob(job).catch((err) => log('ERROR', 'opencode-server resume error:', job.jobId, err.message));
        resumed++;
        continue;
      }
      if (!isTerminal) {
        retainTerminalJob(job.jobId, {
          status: 'unreachable',
          error: `${targetLabel(target)} job cannot be resumed after a bridge restart`,
          detail: 'target_adapter_non_resumable_after_restart',
          terminalAt: Date.now(),
        });
        writeOpenCodeDigest(jobs.get(job.jobId), jobs.get(job.jobId)?.adapterResult || null);
      }
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
      retireThreadSid(job.thread, job.profileId ?? null, job.sessionId, 'sdk_adapter_non_resumable_after_restart');
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
      profileId: job.profileId ?? null,
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
  // sid via the first MCP call's `host_session_id` arg.
  if (getHostSessionId()) {
    hydrateJobsFromLedger();
    sweepOwnSessionStaleQueueRows();
  }
  await mcp.connect(new StdioServerTransport());
}
