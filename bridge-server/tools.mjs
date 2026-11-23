import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { detectHost, HOSTS } from '../lib/hosts/index.mjs';
import { readDefaultModel, readDefaultEffort, readSettings, settingsPath, isModelAllowedFor, readDefaultTarget } from '../lib/state.mjs';
import { lastTargetChecks, probePermission } from '../lib/target-diagnostics.mjs';
import { defaultTargetInfo, getTarget, TARGETS, modelHint, listTargets, listTargetIds } from '../lib/target-registry.mjs';
import { lastRuns } from './last-runs.mjs';
import { getCodexContractStatus } from './adapters/codex.mjs';
import { executionStatus, publish, toolAnswer } from './delivery.mjs';
import { Controller } from './controller/controller.mjs';
import { Records, firstLine } from './controller/records.mjs';
import { systemClock } from './controller/clock.mjs';
import { createProviders } from './providers.mjs';
import { log } from './validation.mjs';
import { renderDigest } from '../lib/digest.mjs';
import { invalid, validateFields, assertCwd, recordId, string, optionalString, number, boolean } from './validation.mjs';

export function clampWaitSec(input) {
  const cap = 1200;
  return Math.max(1, Math.min(Number(input) || 480, cap));
}

function iso(ts) { return ts ? new Date(ts).toISOString() : null; }
// --- Target routing and capability gate ------------------------------------

const UNCONFIGURED_SEND_ERROR =
  'no companion target configured and none passed. Pass target on agent_send, ' +
  'or set a default with `node scripts/onboard.mjs --target <id> --set-default`.';
function effortDescription(native = "the companion's configuration") {
  return `Reasoning effort override. When omitted, a new conversation uses the saved default, then ${native}. A follow-up keeps its current effort.`;
}

function effortRefusal(descriptor, effort) {
  if (!descriptor || effort == null) return null;
  const companion = descriptor.id, { effortSelection, effortLevels } = descriptor.capabilities;
  if (!effortSelection) return { ok: false, code: 'CAPABILITY_UNAVAILABLE', companion,
    error: `companion "${companion}" cannot select effort` };
  if (effortLevels && !effortLevels.includes(effort)) return { ok: false, code: 'EFFORT_NOT_ALLOWED', companion, effort,
    error: `effort "${effort}" is not valid for ${companion}`,
    hint: `Use one of: ${effortLevels.join(', ')}, or omit it to inherit configuration.` };
  return null;
}

function resolveEffort(descriptor, requested, env, newConversation) {
  const configured = newConversation && requested == null ? readDefaultEffort(descriptor.id, env) : null;
  const saved = configured?.source === 'config' ? configured.effort : null;
  const effort = requested ?? configured?.effort ?? null;
  const savedEffortHint = saved && `Effort "${saved}" came from the saved default for ${descriptor.id} in ${settingsPath(env)}. Remove the saved default to omit effort, or pass an explicit effort.`;
  const refusal = effortRefusal(descriptor, effort);
  if (refusal && savedEffortHint) refusal.hint = [refusal.hint, savedEffortHint].filter(Boolean).join(' ');
  return { effort, refusal, savedEffortHint };
}

export function resolveRouting({ target = null, model = null, effort = null } = {}, env = process.env, newConversation = true) {
  const companion = target ? String(target).trim().toLowerCase() : readDefaultTarget(env).target;
  if (!companion) return { ok: false, code: 'TARGET_UNCONFIGURED', error: UNCONFIGURED_SEND_ERROR };
  const descriptor = getTarget(companion, env);
  if (!descriptor?.implemented || !descriptor.capabilities?.send) {
    return { ok: false, code: 'TARGET_UNSUPPORTED', companion,
      error: `target "${companion}" is not a supported companion target (supported: ${listTargetIds().join(', ')})` };
  }
  const selectedModel = model ?? (newConversation ? readDefaultModel(companion, env).model : null);
  if (selectedModel && !descriptor.capabilities.modelSelection) {
    return { ok: false, code: 'CAPABILITY_UNAVAILABLE', companion,
      error: `companion "${companion}" cannot select a model` };
  }
  if (selectedModel && !isModelAllowedFor(companion, selectedModel)) {
    return { ok: false, code: 'MODEL_NOT_ALLOWED', companion, model: selectedModel,
      error: `model "${selectedModel}" is not valid for ${companion}`,
      hint: modelHint(companion) };
  }
  const selection = resolveEffort(descriptor, effort, env, newConversation);
  return selection.refusal || { ok: true, resolved: { companion, model: selectedModel, effort: selection.effort, capabilities: descriptor.capabilities, savedEffortHint: selection.savedEffortHint } };
}

function runningEnvelope(view, action, now) {
  const execution = view.execution;
  return { ok: true, action, status: 'still_running', job_id: execution.executionId, target: execution.provider,
    thread: execution.owner, current_status: view.state, started_at: iso(execution.startedAt),
    age_s: Math.round((now - execution.startedAt) / 1000),
    digest_uri: digestResourceUri(execution.executionId),
    hint: 'call agent_wait({ job_id, max_wait_sec }) again to continue blocking.' };
}

async function handleWait(args, active, request) {
  const response = await active.wait({ owner: args.thread, executionId: args.job_id, timeoutMs: clampWaitSec(args.max_wait_sec) * 1000, ...request });
  if (response?.status === 'user_intervened') return asJson({ ok: true, action: 'wait', status: response.status,
    thread: args.thread, job_id: args.job_id, intervention: response.intervention });
  const view = active.status({ executionId: args.job_id });
  if (!view.result) return asJson(runningEnvelope(view, 'wait', active.clock.now()));
  return ownerTerminalResponse(active.records, view.execution, view.result, 'wait', request);
}

async function handleCancel(args, active, request) {
  await active.cancel({ owner: args.thread, executionId: args.job_id, ...request });
  const view = active.status({ executionId: args.job_id });
  if (!view.result) return asJson(runningEnvelope(view, 'cancel', active.clock.now()));
  return ownerTerminalResponse(active.records, view.execution, view.result, 'cancel', request);
}

function catalogLastRun(run, field) {
  return run ? { value: run[field], at: new Date(run.startedAt).toISOString(), age_ms: run.ageMs, host: run.host } : null;
}

function handleCatalog(args, { env }) {
  const checks = lastTargetChecks();
  const settings = readSettings(settingsPath(env)) ?? {};
  const defaultTarget = readDefaultTarget(env, undefined, settings);
  const last = lastRuns(env);
  return asJson({
    ok: true, action: 'catalog',
    default_target: defaultTarget,
    targets: Object.values(TARGETS).filter((t) => t.implemented).map((target) => {
      const model = readDefaultModel(target.id, env, undefined, settings);
      const saved = settings.companions?.[target.id];
      const reports = last.get(target.id);
      const { nativeDefault: native, adapterKind, modelNote, modelEnumeration, effortDefaultPrefix } = target.runtime;
      const modelDefault = model.source === 'env' ? 'the environment override ahead of the saved default' : 'the saved default';
      const permission = probePermission(target, env);
      const checked = checks[target.id];
      return {
        id: target.id,
        display_name: target.displayName,
        default: target.id === defaultTarget.target,
        model: {
          ...model,
          saved: saved?.model ?? null,
          last_run: catalogLastRun(reports?.model, 'model'),
          description: `When the model is omitted, a new conversation uses ${modelDefault}, then ${native}.` +
            (modelNote ?? ''),
          enumeration: modelEnumeration ?? 'not enumerable without a session',
        },
        effort: { selection: target.capabilities.effortSelection, levels: target.capabilities.effortLevels ?? null,
          saved: saved?.effort ?? null,
          last_run: catalogLastRun(reports?.effort, 'effort'),
          description: !target.capabilities.effortSelection ? 'Effort selection is unsupported.'
            : (target.capabilities.effortLevels ? '' : 'Levels depend on the model and are checked at send. ') +
              effortDescription((effortDefaultPrefix ?? '') + native) },
        permission: permission ? { mode: permission.mode, source: permission.source, risk: permission.risk } : null,
        capabilities: Object.fromEntries(['interventions', 'resume', 'cancel', 'modelSelection', 'effortSelection']
          .map((key) => [key, target.capabilities[key]])),
        readiness: {
          ready: checked?.ready ?? null,
          summary: checked ? (checked.ready ? 'ready at last check' : checked.blockers?.[0]?.message || 'not ready') : 'not checked; run agent_status with diagnostics',
          checked_at: checked?.checkedAt || null,
        },
        installed_version: checked?.version || null,
        ...(adapterKind === 'app-server' ? { contractStatus: getCodexContractStatus() } : {}),
      };
    }),
  });
}

function handleStatus({ job_id, diagnostics, lead }, active) {
  const project = (view) => {
    const { execution: e, result: r, state } = view;
    return { ok: true, action: 'status', job_id: e.executionId, thread: e.owner, target: e.provider, cwd: e.cwd,
      status: r ? executionStatus(r) : state, native_turn_state: e.terminal?.outcome ?? e.state,
      started_at: iso(e.startedAt), terminal_at: iso(r?.finishedAt),
      last_native_activity: e.progress?.lastActivityAt ?? null, active_command: e.progress?.activeCommand ?? null,
      activity: r || e.terminal ? null : e.progress?.activity !== undefined ? e.progress.activity
        : e.progress?.activeCommand ? `running ${e.progress.activeCommand}` : e.progress?.partialText ? 'responding' : null,
      retry: e.progress?.retry ?? null, partial_text: r?.text ?? e.progress?.partialText ?? '',
      stop_evidence: r?.stopEvidence ?? e.cleanup ?? null, usage: r?.usage,
      selected_model: r?.selectedModel ?? e.modelOverride ?? null,
      selected_effort: r?.selectedEffort ?? e.effortOverride ?? null, permission_mode: e.permissionMode ?? null,
      effective_model: r?.effectiveModel ?? e.progress?.effectiveModel ?? e.effectiveModel ?? null,
      effective_effort: r?.effectiveEffort ?? e.progress?.effectiveEffort ?? e.effectiveEffort ?? null,
      cause: r?.cause ?? null, detail: r?.detail ?? null, native_refs: r?.nativeRefs ?? { historyId: e.historyId, nativeTurnId: e.nativeTurnId },
      digest_uri: digestResourceUri(e.executionId), interventions: view.interventions };
  };
  let response;
  if (job_id) {
    const view = active.status({ executionId: job_id });
    response = view ? project(view) : { ok: false, action: 'status', status: 'unknown_job', error: 'unknown job_id' };
  } else {
    const executions = active.records.listExecutions();
    const threads = active.records.listConversations().filter(c => sameLead(c.lead, lead)).map(c => {
      const view = active.status({ executionId: c.executionId });
      const generation = active.records.read('reads', c.owner)?.generation ?? 0;
      const unread = executions.filter(e => e.owner === c.owner && e.generation > generation
        && existsSync(active.records.path('results', e.executionId))).length;
      return { thread: c.owner, unread, title: c.title, target: c.provider, cwd: c.cwd,
        state: view.result ? executionStatus(view.result) : view.state,
        job_id: c.executionId, started_at: iso(view.execution.startedAt) };
    });
    const running = row => ['starting', 'delivering', 'running', 'stopping'].includes(row.state);
    threads.sort((a, b) => running(b) - running(a) || b.started_at.localeCompare(a.started_at));
    response = { ok: true, action: 'status', default_target: defaultTargetInfo(active.env), targets: listTargets(active.env), threads };
  }
  response.contractStatus = getCodexContractStatus();
  if (diagnostics) response.diagnostics = { targets: lastTargetChecks() };
  return asJson(response);
}

function readThread({ thread, after, offset = 0, limit = 8000 }, { records }) {
  const posts = records.listExecutions().filter(e => e.owner === thread).sort((a, b) => a.generation - b.generation);
  const cursor = records.read('reads', thread)?.job_id;
  const index = id => posts.findIndex(e => e.executionId === id);
  const original = index(cursor);
  let lastRead = original;
  // An empty anchor means before the first post. Continuation links keep the
  // same anchor even if an earlier page advanced the durable read cursor.
  const start = after === undefined ? Math.min(lastRead + 1, posts.length - 1) : after ? index(after) + 1 : 0;
  if (after && start === 0) invalid('after must name a job in this thread');
  let length = 0, first, last;
  const page = [];
  for (const [i, e] of posts.slice(start).entries()) {
    const result = records.readResult(e.executionId);
    const status = result ? executionStatus(result) : 'running';
    const time = result ? new Date(result.finishedAt ?? e.startedAt).toISOString() : 'running';
    const header = `## ${e.executionId} · ${status} · ${e.provider} · ${time}\nTask: ${e.text.split(/\r?\n/, 1)[0]}`;
    const chars = Array.from((i ? '\n\n' : '') + header + (result ? '\n' + (result.text ?? '') : ''));
    const finish = length + chars.length;
    if (finish > offset && length < offset + limit) {
      first ??= start + i + 1;
      last = start + i + 1;
      page.push(chars.slice(Math.max(0, offset - length), offset + limit - length).join(''));
      if (result && offset + limit >= finish) lastRead = Math.max(lastRead, start + i);
    }
    length = finish;
  }
  const end = Math.min(offset + limit, length);
  if (lastRead > original) {
    records._locked(thread, () => {
      const { executionId: job_id, generation } = posts[lastRead];
      const saved = records.read('reads', thread);
      if (!saved || generation > saved.generation) records._write('reads', thread, { job_id, generation });
      else lastRead = posts.findLastIndex(e => e.generation <= saved.generation);
    });
  }
  const unread = posts.slice(lastRead + 1).filter(e => existsSync(records.path('results', e.executionId))).length;
  const anchor = posts[start - 1]?.executionId ?? '';
  const next = `agent_read({ thread: ${JSON.stringify(thread)}, after: ${JSON.stringify(anchor)}, offset: ${end} })`;
  const footer = end === length ? `[end · ${unread} unread]`
    : `[posts ${first ?? start + 1}–${last ?? start + 1} of ${posts.length} · characters ${offset}–${end} of ${length} · next: ${next}]`;
  return { content: [{ type: 'text', text: page.join('') + '\n' + footer }] };
}

function sameLead(saved, caller) {
  return saved?.host === caller.host && saved.session === caller.session && saved.agent === caller.agent;
}

function refuse(action, code, fields = {}) {
  return asJson({ ok: false, action, status: code, code, ...fields });
}

async function handleSend(args, active, request, conversation) {
  const { task, mode, lead } = args;
  const cwd = args.cwd ?? conversation?.cwd;
  let thread = args.thread;
  if (conversation) {
    const mismatch = args.target && args.target !== conversation.provider ? 'provider_mismatch'
      : args.cwd && realpathSync(args.cwd) !== conversation.cwd ? 'cwd_mismatch' : null;
    if (mismatch) return refuse('send', mismatch, { thread, job_id: conversation.executionId, target: conversation.provider,
      hint: `This thread is bound to ${conversation.provider} in ${conversation.cwd}. Omit thread to start a new thread.` });
    if (active.live.has(conversation.executionId)) {
      const e = active.records.readExecution(conversation.executionId);
      if ((args.model && args.model !== e.modelOverride) || (args.effort && args.effort !== e.effortOverride)) {
        return refuse('send', 'thread_busy', { thread, job_id: e.executionId, target: e.provider, current_status: e.state });
      }
      if (task !== e.text) {
        if (task.length > 8000) invalid('intervention text exceeds 8000 characters');
        const selected = mode ?? e.interventionModes.default;
        const { id, ...ack } = await active.intervene({ from: 'caller', owner: thread, executionId: e.executionId,
          mode: selected, text: task, ...request });
        if (!ack.ok) return asJson({ action: 'send', ...ack });
        return asJson({ ...ack, action: 'send', status: 'intervened', thread, job_id: e.executionId, mode: selected, intervention_id: id });
      }
    }
  }
  if (mode !== undefined) invalid('mode requires new text on a running thread');
  const route = resolveRouting({ ...args, target: conversation?.provider ?? args.target }, active.env, !conversation);
  if (!route.ok) return asJson({ ...route, action: 'send', status: route.code });
  const { companion, model, effort, savedEffortHint } = route.resolved;
  if (!thread) {
    do { thread = 'th-' + randomBytes(5).toString('hex'); } while (active.records.readConversation(thread));
  }
  const sent = await active.send({ owner: thread, lead, title: args.title, text: task, provider: companion, cwd,
    model: model ?? undefined, effort: effort ?? undefined, savedEffortHint, hostSessionId: lead.session, ...request });
  if (!sent.outcome && !sent.acknowledged) {
    return refuse('send', sent.error ?? 'bridge_loss', { thread, job_id: sent.executionId, status: sent.state });
  }
  if (sent.outcome) return ownerTerminalResponse(active.records, active.records.readExecution(sent.executionId), sent, 'send', request);
  return asJson({ ok: true, status: 'still_running', thread, job_id: sent.executionId, target: companion,
    selected_model: sent.selectedModel ?? null, selected_effort: sent.selectedEffort ?? null,
    effective_model: sent.effectiveModel ?? null, effective_effort: sent.effectiveEffort ?? null, permission_mode: sent.permissionMode ?? null });
}

const field = (type, check, schema = {}) => ({ schema: { type, ...schema }, check });
const thread = field('string', recordId);
const job_id = field('string', recordId);
const modes = ['steer', 'queue', 'interrupt'];
const reference = [{ required: ['thread'] }, { required: ['job_id'] }];

function pageInteger(minimum, maximum) {
  return field('integer', (v, k) => {
    if (!Number.isSafeInteger(v) || v < minimum || (maximum && v > maximum)) invalid('invalid ' + k);
    return v;
  }, { minimum, ...(maximum && { maximum }) });
}

function tool(action, description, fields, conditions, handler, annotations) {
  const properties = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.schema]));
  return { name: 'agent_' + action, action, description, fields, handler, annotations,
    inputSchema: { type: 'object', additionalProperties: false, properties, ...conditions } };
}

export const tools = [
  tool('catalog', 'List companions, model defaults and last-checked readiness.', {}, {}, handleCatalog,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true }),
  tool('send', 'Send the task verbatim. Pass the returned thread for a follow-up. New text on a running thread intervenes in its default or requested mode.', {
    task: field('string', string), cwd: field('string', assertCwd, { description: 'Absolute working directory. Required for a new thread.' }),
    thread, target: field('string', (v, k) => optionalString(v, k)?.toLowerCase(), { enum: listTargetIds() }),
    model: field('string', optionalString), effort: field('string', optionalString),
    mode: field('string', v => modes.includes(v) ? v : invalid('unknown intervention mode'), { enum: modes }),
    title: field('string', string),
  }, { required: ['task'], anyOf: [{ required: ['cwd'] }, { required: ['thread'] }] }, handleSend),
  tool('read', 'Read thread posts in order. Continue a page with the exact after and offset in its footer.', {
    thread, after: field('string', (v, k) => v === '' ? v : recordId(v, k)),
    offset: pageInteger(0), limit: pageInteger(1, 40000),
  }, { required: ['thread'] }, readThread),
  tool('wait', 'Wait for a result, a user intervention, or the wait budget to expire.', {
    thread, job_id, max_wait_sec: field('number', number, { description: 'Default 480 seconds, maximum 1200.' }),
  }, { oneOf: reference }, handleWait),
  tool('status', 'List your threads or inspect one job. Diagnostics includes cached target checks.', {
    thread, job_id, diagnostics: field('boolean', boolean),
  }, { not: { required: ['thread', 'job_id'] } }, handleStatus),
  tool('cancel', 'Stop a job. A later send can resume its thread.', { thread, job_id }, { oneOf: reference }, handleCancel),
];

// Each controller represents one bridge. A Codex session may have several native leads.
const hostSessions = new WeakMap();
function adoptHostSessionId(active, session) {
  const bound = hostSessions.get(active);
  if (bound && bound !== session) throw Object.assign(new Error('This bridge belongs to another Codex session.'), { code: 'BRIDGE_SID_CONFLICT' });
  hostSessions.set(active, session);
}

function attributedInput(tool, params, host, active) {
  const raw = params.arguments ?? {};
  const lead = HOSTS[host].leadFromCall({ args: raw, meta: params._meta });
  if (tool.action !== 'catalog' && !lead) throw Object.assign(new Error('Host lead identity is required.'), { code: 'LEAD_REQUIRED' });
  const { lead: injected, ...publicArgs } = raw;
  const args = validateFields(publicArgs, tool);
  if (tool.action === 'send' && !args.thread && args.cwd === undefined) assertCwd(args.cwd);
  if (args.thread && args.job_id) invalid('pass either thread or job_id');
  if (tool.inputSchema.oneOf && !args.thread && !args.job_id) invalid('thread or job_id is required');
  if (tool.action !== 'catalog' && host === HOSTS.codex.id) adoptHostSessionId(active, lead.session);
  return { ...args, lead };
}

export async function dispatch(params, { controller: active, host = detectHost(), requestId, signal } = {}) {
  const tool = tools.find(t => t.name === params.name);
  if (!tool) throw new Error('unknown tool: ' + params.name);
  const { action } = tool;
  let args;
  try {
    args = attributedInput(tool, params, host, active);
    let conversation;
    if (args.job_id) {
      const execution = active.records.readExecution(args.job_id);
      if (!execution) return refuse(action, 'execution_unknown', { status: 'unknown_job', job_id: args.job_id });
      args.thread = execution.owner;
    }
    if (args.thread) {
      conversation = active.records.readConversation(args.thread);
      if (!conversation) return refuse(action, 'thread_unknown', { status: 'unknown_thread', thread: args.thread });
      if (!sameLead(conversation.lead, args.lead)) return refuse(action, 'THREAD_NOT_YOURS');
      args.job_id ??= conversation.executionId;
    }
    return await tool.handler(args, active, { requestId, signal }, conversation);
  } catch (err) {
    if (!err.code) throw err;
    return refuse(action, err.code, { error: err.message,
      ...(args?.thread && { thread: args.thread }), ...(args?.job_id && { job_id: args.job_id }),
      ...(err.code === 'execution_unknown' && { status: 'unknown_job' }) });
  }
}

// Digest resources and terminal delivery

const DIGEST_RESOURCE_SCHEME = 'agent-digest';
const DIGEST_RESOURCE_MIME_TYPE = 'text/markdown';
const DIGEST_RESOURCE_URI_RE = /^agent-digest:\/\/([a-zA-Z0-9._-]+)$/;

export function digestResourceUri(jobId) {
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(jobId)) return null;
  return `${DIGEST_RESOURCE_SCHEME}://${jobId}`;
}

export function digestJobIdFromResourceUri(uri) {
  const match = DIGEST_RESOURCE_URI_RE.exec(String(uri || ''));
  return match ? match[1] : null;
}

export function digestResourceForJobId(jobId, active) {
  const uri = digestResourceUri(jobId);
  if (!uri || !active.records.readExecution(jobId)) return null;
  // Keep the descriptor minimal. Codex 0.139 accepts this shape for
  // list_mcp_resources; richer MCP metadata is still not portable across hosts.
  return {
    uri,
    name: `agent-digest-${jobId}`,
    description: `Native transcript digest for agent job ${jobId}.`,
    mimeType: DIGEST_RESOURCE_MIME_TYPE,
  };
}

export function listDigestResources(active) {
  return active.records.listExecutions()
    .map((execution) => digestResourceForJobId(execution.executionId, active))
    .filter(Boolean);
}

export function listDigestResourceTemplates() {
  return [{
    uriTemplate: `${DIGEST_RESOURCE_SCHEME}://{job_id}`,
    name: 'agent-digest',
    title: 'Agent job digest',
    description: 'Read a native transcript digest for an agent companion job by job_id.',
    mimeType: DIGEST_RESOURCE_MIME_TYPE,
  }];
}

export function readDigestResource(uri, active) {
  const jobId = digestJobIdFromResourceUri(uri);
  if (!jobId) throw new Error(`unknown digest resource uri: ${uri}`);
  const resource = digestResourceForJobId(jobId, active);
  if (!resource) throw new Error(`digest not found for job_id: ${jobId}`);
  return {
    contents: [{
      uri: resource.uri,
      mimeType: DIGEST_RESOURCE_MIME_TYPE,
      text: renderDigest(active.records.readExecution(jobId), active.records.readResult(jobId), active.env),
    }],
  };
}

function asJson(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], ...(obj.ok === false && { isError: true }) };
}

function ownerTerminalResponse(records, execution, result, action, { signal }) {
  const status = executionStatus(result);
  const evidence = result.stopEvidence;
  const meta = {
    status, job_id: result.executionId, thread: result.owner, target: execution.provider,
    cause: result.cause, detail: result.outcome === 'delivery_unknown' ? 'delivery_unknown' : result.detail ?? null,
    work_summary: result.workSummary ?? null, usage: result.usage, selected_model: result.selectedModel ?? null, effective_model: result.effectiveModel ?? null,
    selected_effort: result.selectedEffort ?? null, effective_effort: result.effectiveEffort ?? null, native_refs: result.nativeRefs ?? {},
    stop_evidence: evidence ? { gone: evidence.gone, signals: evidence.signals?.length ?? 0,
      survivors: evidence.survivors?.length ?? 0, cleanup_ms: evidence.cleanupMs ?? null,
      protocol: evidence.protocol ?? [] } : null,
    digest_uri: digestResourceUri(result.executionId),
    ...(result.interventions?.length ? { interventions: result.interventions.map(({ from, mode, state, text }) =>
      ({ from, mode, state, first_line: firstLine(text) })) } : {}),
  };
  const { text, delivered_by } = toolAnswer(records, result, signal);
  if (delivered_by) meta.delivered_by = delivered_by;
  const metadata = { ok: true, action, status, thread: result.owner, job_id: result.executionId, target: execution.provider, meta };
  return { content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(metadata) }] };
}

export function createBridgeController({ env = process.env, records = new Records(), ...options } = {}) {
  const safely = (fn) => (...args) => { try { fn(...args); } catch (err) { log('WARN', 'execution publication failed:', err.message); } };
  return new Controller({ env, records, clock: systemClock,
    providers: createProviders(env),
    ...options, onResult: safely((execution, result) => publish(records, execution, result)),
  });
}
export async function recoverController(active) {
  for (const execution of active.records.listExecutions()) {
    const conversation = active.records.readConversation(execution.owner);
    if (conversation?.executionId === execution.executionId && execution.state !== 'closed') {
      await active.recover({ owner: execution.owner });
    }
    const result = active.records.readResult(execution.executionId);
    if (result) publish(active.records, execution, result);
  }
}
