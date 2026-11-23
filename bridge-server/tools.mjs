import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { detectHost, HOSTS } from '../lib/hosts/index.mjs';
import { readDefaultModel, readDefaultEffort, readSettings, settingsPath, isModelAllowedFor, readDefaultCompanion } from '../lib/state.mjs';
import { lastCompanionChecks, probePermission } from '../lib/companion-diagnostics.mjs';
import { defaultCompanionInfo, getCompanion, COMPANIONS, modelHint, listCompanions, listCompanionIds } from '../lib/companion-registry.mjs';
import { lastRuns } from './last-runs.mjs';
import { getCodexContractStatus } from './adapters/codex.mjs';
import { jobStatus, publish, toolAnswer, wakeNotice } from './delivery.mjs';
import { Controller } from './controller/controller.mjs';
import { Records, firstLine, isCompanionSession } from './controller/records.mjs';
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
// --- Companion routing and capability gate ------------------------------------

const UNCONFIGURED_SEND_ERROR =
  'no default companion configured and none passed. Pass companion on companion_send, ' +
  'or set a default with `node scripts/onboard.mjs --companion <id> --set-default`.';
function effortDescription(native = "the companion's configuration") {
  return `Reasoning effort override. When omitted, a new thread uses the saved default, then ${native}. A follow-up keeps its current effort.`;
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

function resolveEffort(descriptor, requested, env, newThread) {
  const configured = newThread && requested == null ? readDefaultEffort(descriptor.id, env) : null;
  const saved = configured?.source === 'config' ? configured.effort : null;
  const effort = requested ?? configured?.effort ?? null;
  const savedEffortHint = saved && `Effort "${saved}" came from the saved default for ${descriptor.id} in ${settingsPath(env)}. Remove the saved default to omit effort, or pass an explicit effort.`;
  const refusal = effortRefusal(descriptor, effort);
  if (refusal && savedEffortHint) refusal.hint = [refusal.hint, savedEffortHint].filter(Boolean).join(' ');
  return { effort, refusal, savedEffortHint };
}

export function resolveRouting({ companion: requested = null, model = null, effort = null } = {}, env = process.env, newThread = true) {
  const companion = requested ? String(requested).trim().toLowerCase() : readDefaultCompanion(env).companion;
  if (!companion) return { ok: false, code: 'COMPANION_UNCONFIGURED', error: UNCONFIGURED_SEND_ERROR };
  const descriptor = getCompanion(companion, env);
  if (!descriptor?.implemented || !descriptor.capabilities?.send) {
    return { ok: false, code: 'COMPANION_UNSUPPORTED', companion,
      error: `unsupported companion "${companion}" (supported: ${listCompanionIds().join(', ')})` };
  }
  const selectedModel = model ?? (newThread ? readDefaultModel(companion, env).model : null);
  if (selectedModel && !descriptor.capabilities.modelSelection) {
    return { ok: false, code: 'CAPABILITY_UNAVAILABLE', companion,
      error: `companion "${companion}" cannot select a model` };
  }
  if (selectedModel && !isModelAllowedFor(companion, selectedModel)) {
    return { ok: false, code: 'MODEL_NOT_ALLOWED', companion, model: selectedModel,
      error: `model "${selectedModel}" is not valid for ${companion}`,
      hint: modelHint(companion) };
  }
  const selection = resolveEffort(descriptor, effort, env, newThread);
  return selection.refusal || { ok: true, resolved: { companion, model: selectedModel, effort: selection.effort, capabilities: descriptor.capabilities, savedEffortHint: selection.savedEffortHint } };
}

function runningEnvelope(view, action, now) {
  const job = view.job;
  return { ok: true, action, status: 'still_running', job_id: job.jobId, companion: job.companion,
    thread: job.thread, current_status: view.state, started_at: iso(job.startedAt),
    age_s: Math.round((now - job.startedAt) / 1000),
    digest_uri: digestResourceUri(job.jobId),
    hint: 'call companion_wait({ job_id, max_wait_sec }) again to continue blocking.' };
}

// Observe only MCP waits on this bridge. Controller requests also include
// sends, cancels and interventions, and are detached before onResult fires.
const pendingWaits = new WeakMap();
async function handleWait(args, active, request) {
  const waits = pendingWaits.get(active) ?? new Set();
  pendingWaits.set(active, waits);
  const waiter = { id: args.job_id, signal: request.signal };
  waits.add(waiter);
  let response;
  try {
    response = await active.wait({ thread: args.thread, jobId: args.job_id,
      timeoutMs: clampWaitSec(args.max_wait_sec) * 1000, ...request });
  } finally { waits.delete(waiter); }
  if (response?.status === 'user_intervened') return asJson({ ok: true, action: 'wait', status: response.status,
    thread: args.thread, job_id: args.job_id, intervention: response.intervention });
  const view = active.status({ jobId: args.job_id });
  if (!view.result) return asJson(runningEnvelope(view, 'wait', active.clock.now()));
  return terminalResponse(active.records, view.job, view.result, 'wait', request);
}

async function handleCancel(args, active, request) {
  await active.cancel({ thread: args.thread, jobId: args.job_id, ...request });
  const view = active.status({ jobId: args.job_id });
  if (!view.result) return asJson(runningEnvelope(view, 'cancel', active.clock.now()));
  return terminalResponse(active.records, view.job, view.result, 'cancel', request);
}

function catalogLastRun(run, field) {
  return run ? { value: run[field], at: new Date(run.startedAt).toISOString(), age_ms: run.ageMs, host: run.host } : null;
}

function handleCatalog(args, { env }) {
  const checks = lastCompanionChecks();
  const settings = readSettings(settingsPath(env)) ?? {};
  const defaultCompanion = readDefaultCompanion(env, undefined, settings);
  const last = lastRuns(env);
  return asJson({
    ok: true, action: 'catalog',
    default_companion: defaultCompanion,
    companions: Object.values(COMPANIONS).filter((t) => t.implemented).map((companion) => {
      const model = readDefaultModel(companion.id, env, undefined, settings);
      const saved = settings.companions?.[companion.id];
      const reports = last.get(companion.id);
      const { nativeDefault: native, adapterKind, modelNote, modelEnumeration, effortDefaultPrefix } = companion.runtime;
      const modelDefault = model.source === 'env' ? 'the environment override ahead of the saved default' : 'the saved default';
      const permission = probePermission(companion, env);
      const checked = checks[companion.id];
      return {
        id: companion.id,
        display_name: companion.displayName,
        default: companion.id === defaultCompanion.companion,
        model: {
          ...model,
          saved: saved?.model ?? null,
          last_run: catalogLastRun(reports?.model, 'model'),
          description: `When the model is omitted, a new thread uses ${modelDefault}, then ${native}.` +
            (modelNote ?? ''),
          enumeration: modelEnumeration ?? 'not enumerable without a session',
        },
        effort: { selection: companion.capabilities.effortSelection, levels: companion.capabilities.effortLevels ?? null,
          saved: saved?.effort ?? null,
          last_run: catalogLastRun(reports?.effort, 'effort'),
          description: !companion.capabilities.effortSelection ? 'Effort selection is unsupported.'
            : (companion.capabilities.effortLevels ? '' : 'Levels depend on the model and are checked at send. ') +
              effortDescription((effortDefaultPrefix ?? '') + native) },
        permission: permission ? { mode: permission.mode, source: permission.source, risk: permission.risk } : null,
        capabilities: Object.fromEntries(['interventions', 'resume', 'cancel', 'modelSelection', 'effortSelection']
          .map((key) => [key, companion.capabilities[key]])),
        readiness: {
          ready: checked?.ready ?? null,
          summary: checked ? (checked.ready ? 'ready at last check' : checked.blockers?.[0]?.message || 'not ready') : 'not checked; run companion_status with diagnostics',
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
    const { job: e, result: r, state } = view;
    return { ok: true, action: 'status', job_id: e.jobId, thread: e.thread, companion: e.companion, cwd: e.cwd,
      status: r ? jobStatus(r) : state, native_turn_state: e.terminal?.outcome ?? e.state,
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
      digest_uri: digestResourceUri(e.jobId), interventions: view.interventions };
  };
  let response;
  if (job_id) {
    const view = active.status({ jobId: job_id });
    response = view ? project(view) : { ok: false, action: 'status', status: 'unknown_job', error: 'unknown job_id' };
  } else {
    const jobs = active.records.listJobs();
    const threads = active.records.listThreads().filter(c => sameLead(c.lead, lead)).map(c => {
      const view = active.status({ jobId: c.jobId });
      const generation = active.records.read('reads', c.thread)?.generation ?? 0;
      const unread = jobs.filter(e => e.thread === c.thread && e.generation > generation
        && existsSync(active.records.path('results', e.jobId))).length;
      return { thread: c.thread, unread, title: c.title, companion: c.companion, cwd: c.cwd,
        state: view.result ? jobStatus(view.result) : view.state,
        job_id: c.jobId, started_at: iso(view.job.startedAt) };
    });
    const running = row => ['starting', 'delivering', 'running', 'stopping'].includes(row.state);
    threads.sort((a, b) => running(b) - running(a) || b.started_at.localeCompare(a.started_at));
    response = { ok: true, action: 'status', default_companion: defaultCompanionInfo(active.env), companions: listCompanions(active.env), threads };
  }
  response.contractStatus = getCodexContractStatus();
  if (diagnostics) response.diagnostics = { companions: lastCompanionChecks() };
  return asJson(response);
}

function readThread({ thread, after, offset = 0, limit = 8000 }, { records }) {
  const posts = records.listJobs().filter(e => e.thread === thread).sort((a, b) => a.generation - b.generation);
  const cursor = records.read('reads', thread)?.job_id;
  const index = id => posts.findIndex(e => e.jobId === id);
  const original = index(cursor);
  let lastRead = original;
  // An empty anchor means before the first post. Continuation links keep the
  // same anchor even if an earlier page advanced the durable read cursor.
  const start = after === undefined ? Math.min(lastRead + 1, posts.length - 1) : after ? index(after) + 1 : 0;
  if (after && start === 0) invalid('after must name a job in this thread');
  let length = 0, first, last;
  const page = [];
  for (const [i, e] of posts.slice(start).entries()) {
    const result = records.readResult(e.jobId);
    const status = result ? jobStatus(result) : 'running';
    const time = result ? new Date(result.finishedAt ?? e.startedAt).toISOString() : 'running';
    const header = `## ${e.jobId} · ${status} · ${e.companion} · ${time}\nTask: ${e.text.split(/\r?\n/, 1)[0]}`;
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
      const { jobId: job_id, generation } = posts[lastRead];
      const saved = records.read('reads', thread);
      if (!saved || generation > saved.generation) records._write('reads', thread, { job_id, generation });
      else lastRead = posts.findLastIndex(e => e.generation <= saved.generation);
    });
  }
  const unread = posts.slice(lastRead + 1).filter(e => existsSync(records.path('results', e.jobId))).length;
  const anchor = posts[start - 1]?.jobId ?? '';
  const next = `companion_read({ thread: ${JSON.stringify(thread)}, after: ${JSON.stringify(anchor)}, offset: ${end} })`;
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

function sendDelivery(lead, env) {
  return { ...HOSTS[lead.host].wakeStatus(lead, env), fallback: 'companion_wait' };
}

async function handleSend(args, active, request, threadRecord) {
  const { task, mode, lead } = args;
  const cwd = args.cwd ?? threadRecord?.cwd;
  let thread = args.thread;
  const live = threadRecord && active.live.has(threadRecord.jobId);
  if (threadRecord) {
    const mismatch = args.companion && args.companion !== threadRecord.companion ? 'companion_mismatch'
      : args.cwd && realpathSync(args.cwd) !== threadRecord.cwd ? 'cwd_mismatch' : null;
    if (mismatch) return refuse('send', mismatch, { thread, job_id: threadRecord.jobId, companion: threadRecord.companion,
      hint: `This thread is bound to ${threadRecord.companion} in ${threadRecord.cwd}. Omit thread to start a new thread.` });
    if (live) {
      const e = active.records.readJob(threadRecord.jobId);
      if ((args.model && args.model !== e.modelOverride) || (args.effort && args.effort !== e.effortOverride)) {
        return refuse('send', 'thread_busy', { thread, job_id: e.jobId, companion: e.companion, current_status: e.state });
      }
      if (task !== e.text) {
        if (task.length > 8000) invalid('intervention text exceeds 8000 characters');
        const selected = mode ?? e.interventionModes.default;
        const { id, ...ack } = await active.intervene({ from: 'caller', thread, jobId: e.jobId,
          mode: selected, text: task, ...request });
        if (!ack.ok) return asJson({ action: 'send', ...ack });
        return asJson({ ...ack, action: 'send', status: 'intervened', thread, job_id: e.jobId, mode: selected, intervention_id: id,
          delivery: sendDelivery(lead, active.env) });
      }
    }
  }
  if (mode !== undefined) invalid('mode requires new text on a running thread');
  // Work a send would start is refused to a companion session a bridge started.
  if (!live && isCompanionSession(lead.session, active.env)) return refuse('send', 'RECURSION_REFUSED');
  const route = resolveRouting({ ...args, companion: threadRecord?.companion ?? args.companion }, active.env, !threadRecord);
  if (!route.ok) return asJson({ ...route, action: 'send', status: route.code });
  const { companion, model, effort, savedEffortHint } = route.resolved;
  if (!thread) {
    do { thread = 'th-' + randomBytes(5).toString('hex'); } while (active.records.readThread(thread));
  }
  const sent = await active.send({ thread, lead, title: args.title, text: task, companion, cwd,
    model: model ?? undefined, effort: effort ?? undefined, savedEffortHint, hostSessionId: lead.session, ...request });
  if (!sent.outcome && !sent.acknowledged) {
    return refuse('send', sent.error ?? 'bridge_loss', { thread, job_id: sent.jobId, status: sent.state });
  }
  if (sent.outcome) return terminalResponse(active.records, active.records.readJob(sent.jobId), sent, 'send', request);
  return asJson({ ok: true, status: 'still_running', thread, job_id: sent.jobId, companion, delivery: sendDelivery(lead, active.env),
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
  return { name: 'companion_' + action, action, description, fields, handler, annotations,
    inputSchema: { type: 'object', additionalProperties: false, properties, ...conditions } };
}

export const tools = [
  tool('catalog', 'List companions, model defaults and last-checked readiness.', {}, {}, handleCatalog,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true }),
  tool('send', 'Send the task verbatim. Pass the returned thread for a follow-up. New text on a running thread intervenes in its default or requested mode.', {
    task: field('string', string), cwd: field('string', assertCwd, { description: 'Absolute working directory. Required for a new thread.' }),
    thread, companion: field('string', (v, k) => optionalString(v, k)?.toLowerCase(), { enum: listCompanionIds() }),
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
  tool('status', 'List your threads or inspect one job. Diagnostics includes cached companion checks.', {
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
  if (tool.action !== 'catalog' && HOSTS[host].bridgePerSession) adoptHostSessionId(active, lead.session);
  return { ...args, lead };
}

export async function dispatch(params, { controller: active, host = detectHost(), requestId, signal } = {}) {
  const tool = tools.find(t => t.name === params.name);
  if (!tool) throw new Error('unknown tool: ' + params.name);
  const { action } = tool;
  let args;
  try {
    args = attributedInput(tool, params, host, active);
    let threadRecord;
    if (args.job_id) {
      const job = active.records.readJob(args.job_id);
      if (!job) return refuse(action, 'execution_unknown', { status: 'unknown_job', job_id: args.job_id });
      args.thread = job.thread;
    }
    if (args.thread) {
      threadRecord = active.records.readThread(args.thread);
      if (!threadRecord) return refuse(action, 'thread_unknown', { status: 'unknown_thread', thread: args.thread });
      if (!sameLead(threadRecord.lead, args.lead)) return refuse(action, 'THREAD_NOT_YOURS');
      args.job_id ??= threadRecord.jobId;
    }
    return await tool.handler(args, active, { requestId, signal }, threadRecord);
  } catch (err) {
    if (!err.code) throw err;
    return refuse(action, err.code, { error: err.message,
      ...(args?.thread && { thread: args.thread }), ...(args?.job_id && { job_id: args.job_id }),
      ...(err.code === 'execution_unknown' && { status: 'unknown_job' }) });
  }
}

// Digest resources and terminal delivery

const DIGEST_RESOURCE_SCHEME = 'job-digest';
const DIGEST_RESOURCE_MIME_TYPE = 'text/markdown';
const DIGEST_RESOURCE_URI_RE = /^job-digest:\/\/([a-zA-Z0-9._-]+)$/;

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
  if (!uri || !active.records.readJob(jobId)) return null;
  // Keep the descriptor minimal. Codex 0.139 accepts this shape for
  // list_mcp_resources; richer MCP metadata is still not portable across hosts.
  return {
    uri,
    name: `job-digest-${jobId}`,
    description: `Native transcript digest for job ${jobId}.`,
    mimeType: DIGEST_RESOURCE_MIME_TYPE,
  };
}

export function listDigestResources(active) {
  return active.records.listJobs()
    .map((job) => digestResourceForJobId(job.jobId, active))
    .filter(Boolean);
}

export function listDigestResourceTemplates() {
  return [{
    uriTemplate: `${DIGEST_RESOURCE_SCHEME}://{job_id}`,
    name: 'job-digest',
    title: 'Job digest',
    description: 'Read a native transcript digest for a companion job by job_id.',
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
      text: renderDigest(active.records.readJob(jobId), active.records.readResult(jobId), active.env),
    }],
  };
}

function asJson(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], ...(obj.ok === false && { isError: true }) };
}

function terminalResponse(records, job, result, action, { signal }) {
  const status = jobStatus(result);
  const evidence = result.stopEvidence;
  const meta = {
    status, job_id: result.jobId, thread: result.thread, companion: job.companion,
    cause: result.cause, detail: result.outcome === 'delivery_unknown' ? 'delivery_unknown' : result.detail ?? null,
    work_summary: result.workSummary ?? null, usage: result.usage, selected_model: result.selectedModel ?? null, effective_model: result.effectiveModel ?? null,
    selected_effort: result.selectedEffort ?? null, effective_effort: result.effectiveEffort ?? null, native_refs: result.nativeRefs ?? {},
    stop_evidence: evidence ? { gone: evidence.gone, signals: evidence.signals?.length ?? 0,
      survivors: evidence.survivors?.length ?? 0, cleanup_ms: evidence.cleanupMs ?? null,
      protocol: evidence.protocol ?? [] } : null,
    digest_uri: digestResourceUri(result.jobId),
    ...(result.interventions?.length ? { interventions: result.interventions.map(({ from, mode, state, text }) =>
      ({ from, mode, state, first_line: firstLine(text) })) } : {}),
  };
  const { text, delivered_by } = toolAnswer(records, result, signal);
  if (delivered_by) meta.delivered_by = delivered_by;
  const metadata = { ok: true, action, status, thread: result.thread, job_id: result.jobId, companion: job.companion, meta };
  return { content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(metadata) }] };
}

export function createBridgeController({ env = process.env, records = new Records(), ...options } = {}) {
  const controller = new Controller({ env, records, clock: systemClock, providers: createProviders(env), ...options,
    onResult(job, result) {
      try {
        const lead = publish(records, job, result);
        const waits = pendingWaits.get(controller) ?? [];
        const waiting = [...waits].some(w => w.id === job.jobId && !w.signal?.aborted);
        if (lead && !waiting) HOSTS[lead.host].wake(lead, wakeNotice(job, result), env)
          .catch(err => log('WARN', 'completion wake failed:', err.message));
      } catch (err) { log('WARN', 'job publication failed:', err.message); }
    },
  });
  return controller;
}
export async function recoverController(active) {
  for (const job of active.records.listJobs()) {
    const threadRecord = active.records.readThread(job.thread);
    if (threadRecord?.jobId === job.jobId && job.state !== 'closed') {
      await active.recover({ thread: job.thread });
    }
    // A startup scan can observe another bridge's live completion. Restore
    // news here; only the bridge finishing the job attempts its wake.
    const result = active.records.readResult(job.jobId);
    if (result) publish(active.records, job, result);
  }
}
