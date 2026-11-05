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
import { codexProvider, getCodexContractStatus } from './adapters/codex.mjs';
import { opencodeProvider } from './adapters/opencode.mjs';
import { acpProvider } from './adapters/acp.mjs';

import { log, validateAgentArgs } from './validation.mjs';
import { BASE_DIR, readDefaultModel, migrateLegacyState, isModelAllowedFor, readDefaultTarget, ALLOWED_MODELS } from '../lib/state.mjs';
import { lastTargetChecks } from '../lib/target-diagnostics.mjs';
import { queuePath, runtimeDir, digestDir, appendPrivateFile, writePrivateFileAtomic } from '../lib/runtime-paths.mjs';
import { logEvent } from '../lib/log.mjs';
import { digestPath, renderDigest } from '../lib/prompt-digest.mjs';
import { defaultTargetInfo, defaultTargetId, getTarget, listTargets, listTargetIds } from '../lib/target-registry.mjs';

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

export function clampWaitSec(input) {
  const cap = 1200;
  return Math.max(1, Math.min(Number(input) || 480, cap));
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
  // Keep the descriptor minimal. Codex 0.139 accepts this shape for
  // list_mcp_resources; richer MCP metadata is still not portable across hosts.
  return {
    uri,
    name: `agent-digest-${jobId}`,
    description: `Smart transcript digest for agent job ${jobId}.`,
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

function digestResourceLinkForResult(obj) {
  const jobId = obj?.job_id || obj?.meta?.job_id;
  const advertisedUri = obj?.digest_uri || obj?.meta?.digest_uri;
  if (!jobId || !advertisedUri) return null;
  if (advertisedUri !== digestResourceUri(jobId)) return null;
  return { type: 'resource_link', uri: advertisedUri, name: `agent-digest-${jobId}`, mimeType: DIGEST_RESOURCE_MIME_TYPE };
}

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
  // A configured per-companion default model (the env knob or the default-model
  // file) is an explicit selection for a NEW conversation. An existing conversation
  // keeps its stored override, and an omitted model with nothing configured inherits
  // the companion's own configuration (Codex then receives no model key at all).
  const known = Object.hasOwn(active.providers ?? {}, provider);
  const configured = known && args.model === undefined && args.thread && !active.records.readConversation(args.thread)
    ? (readDefaultModel(provider, active.env).model ?? undefined) : undefined;
  const sent = await active.send({ owner: args.thread, provider, cwd: args.cwd, text: args.task,
    model: args.model ?? configured, hostSessionId: getHostSessionId(), ...request });
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
        ...(target.id === 'codex' ? { contractStatus: getCodexContractStatus() } : {}),
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
  response.contractStatus = getCodexContractStatus();
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
      `supported targets: ${listTargets().map((t) => t.id).join(', ')}. ` +
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

export function _resetForTest() { _bridgeHostSid = null; }
export { mcp, adoptHostSessionId };

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
