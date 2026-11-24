import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { detectHost, HOSTS } from '../lib/hosts/index.mjs';
import { readDefaultModel, readDefaultEffort, readSettings, settingsPath, isModelAllowedFor, readDefaultCompanion } from '../lib/state.mjs';
import { lastCompanionChecks, probePermission } from '../lib/companion-diagnostics.mjs';
import { defaultCompanionInfo, getCompanion, COMPANIONS, modelHint, listCompanionIds } from '../lib/companion-registry.mjs';
import { lastRuns } from './last-runs.mjs';
import { getCodexContractStatus } from './adapters/codex.mjs';
import { jobStatus, publish, needsStartupWake, toolAnswer, wakeNotice, readCall, postHeader, threadPosts, toolName } from './delivery.mjs';
import { Controller } from './controller/controller.mjs';
import { Records, firstLine, isCompanionSession } from './controller/records.mjs';
import { createProviders } from './providers.mjs';
import { logJob } from './validation.mjs';
import { renderDigest } from '../lib/digest.mjs';
import { invalid, validateFields, assertCwd, recordId, string, optionalString, number, boolean } from './validation.mjs';

export function clampWaitSec(input) {
  return Math.max(1, Math.min(input ?? 480, 1200));
}

function iso(ts) { return ts ? new Date(ts).toISOString() : null; }
// --- Companion routing and capability gate ------------------------------------

const UNCONFIGURED_SEND_ERROR =
  'No default companion is configured. Pass a companion ID from catalog, or choose a default with node scripts/onboard.mjs.';
const readinessCheck = 'Run node scripts/onboard.mjs --list-companions from the checkout.';

function effortRefusal(descriptor, effort) {
  if (!descriptor || effort == null) return null;
  const companion = descriptor.id, { effortSelection, effortLevels } = descriptor.capabilities;
  if (!effortSelection) return { ok: false, code: 'CAPABILITY_UNAVAILABLE', companion,
    error: `companion "${companion}" cannot select effort. Omit effort or choose another companion.` };
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
      error: `companion "${companion}" cannot select a model. Omit model or choose another companion.` };
  }
  if (selectedModel && !isModelAllowedFor(companion, selectedModel)) {
    return { ok: false, code: 'MODEL_NOT_ALLOWED', companion, model: selectedModel,
      error: `model "${selectedModel}" is not valid for ${companion}`,
      hint: modelHint(companion) };
  }
  const selection = resolveEffort(descriptor, effort, env, newThread);
  return selection.refusal || { ok: true, resolved: { companion, model: selectedModel, effort: selection.effort, capabilities: descriptor.capabilities, savedEffortHint: selection.savedEffortHint } };
}

function runningEnvelope(view, action, now, host) {
  const job = view.job;
  return { ok: true, action, status: 'still_running', job_id: job.jobId, companion: job.companion,
    thread: job.thread, current_status: view.state, started_at: iso(job.startedAt),
    age_s: Math.round((now - job.startedAt) / 1000),
    digest_uri: digestResourceUri(job.jobId),
    hint: `Call ${toolName(host, 'wait')}({ job_id: ${JSON.stringify(job.jobId)} }) to continue waiting.` };
}

function notControlled(action, job, host) {
  return refuse(action, 'job_not_controlled', { thread: job.thread, job_id: job.jobId,
    hint: `Use the owning session, or check ${toolName(host, 'status')}({ job_id: ${JSON.stringify(job.jobId)} }) later.` });
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
  if (view.state === 'job_not_controlled') return notControlled('wait', view.job, args.lead.host);
  if (!view.result) return asJson(runningEnvelope(view, 'wait', active.clock.now(), args.lead.host));
  return terminalResponse(active.records, view.job, view.result, 'wait', request);
}

async function handleCancel(args, active, request) {
  await active.cancel({ thread: args.thread, jobId: args.job_id, ...request });
  const view = active.status({ jobId: args.job_id });
  if (!view.result) return asJson(runningEnvelope(view, 'cancel', active.clock.now(), args.lead.host));
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
    inheritance: 'On a new thread an omitted model uses the environment override, then the saved model, then the native default. Omitted effort uses the saved effort, then native configuration. A follow-up keeps the last accepted selections.',
    ...(listCompanionIds().some(id => !checks[id]) && { readiness_check: readinessCheck }),
    companions: Object.values(COMPANIONS).filter((t) => t.implemented).map((companion) => {
      const model = readDefaultModel(companion.id, env, undefined, settings);
      const saved = settings.companions?.[companion.id];
      const reports = last.get(companion.id);
      const { nativeDefault: native, modelNote, modelEnumeration } = companion.runtime;
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
          native_default: native,
          ...(modelNote && { description: modelNote.trim() }),
          enumeration: modelEnumeration ?? 'not enumerable without a session',
        },
        effort: { selection: companion.capabilities.effortSelection, levels: companion.capabilities.effortLevels ?? null,
          saved: saved?.effort ?? null,
          last_run: catalogLastRun(reports?.effort, 'effort'),
          ...(!companion.capabilities.effortLevels && companion.capabilities.effortSelection && { description: 'Levels depend on the model and are checked at send.' }) },
        permission: permission ? { mode: permission.mode, source: permission.source, risk: permission.risk } : null,
        capabilities: Object.fromEntries(['interventions', 'resume', 'cancel', 'modelSelection', 'effortSelection']
          .map((key) => [key, companion.capabilities[key]])),
        readiness: {
          ready: checked?.ready ?? null,
          summary: checked ? (checked.ready ? 'ready at last check' : checked.blockers?.[0]?.message || 'not ready') : 'not checked',
          checked_at: checked?.checkedAt || null,
        },
        installed_version: checked?.version || null,
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
      retry: e.progress?.retry ?? null,
      ...(state === 'running' && !r && e.progress?.partialText && { partial_text: Array.from(e.progress.partialText.slice(-1024)).slice(-512).join('') }),
      usage: r?.usage,
      selected_model: r?.selectedModel ?? e.modelOverride ?? null,
      selected_effort: r?.selectedEffort ?? e.effortOverride ?? null, permission_mode: e.permissionMode ?? null,
      effective_model: r?.effectiveModel ?? e.progress?.effectiveModel ?? e.effectiveModel ?? null,
      effective_effort: r?.effectiveEffort ?? e.progress?.effectiveEffort ?? e.effectiveEffort ?? null,
      cause: r?.cause ?? null, detail: r?.detail ?? null, ...(diagnostics && {
        native_refs: r?.nativeRefs ?? { historyId: e.historyId, nativeTurnId: e.nativeTurnId },
        stop_evidence: r?.stopEvidence ?? e.cleanup ?? null,
        ...(COMPANIONS[e.companion]?.runtime.adapterKind === 'app-server' && { contractStatus: getCodexContractStatus() }),
      }),
      digest_uri: digestResourceUri(e.jobId), interventions: view.interventions };
  };
  let response;
  if (job_id) {
    const view = active.status({ jobId: job_id });
    if (view?.state === 'job_not_controlled') return notControlled('status', view.job, lead.host);
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
    response = { ok: true, action: 'status', default_companion: defaultCompanionInfo(active.env), threads };
  }
  if (diagnostics) {
    const checks = lastCompanionChecks();
    response.diagnostics = { companions: Object.fromEntries(Object.entries(checks).map(([id, report]) => {
      const { ready, checkedAt, version, blockers, nextSteps } = report;
      return [id, { ready, checkedAt, version, blockers: blockers?.map(({ code, message }) => ({ code, message })), nextSteps }];
    })), readiness_check: readinessCheck };
  }
  return asJson(response);
}

function readThread({ thread, after, offset = 0, limit = 8000, lead }, { records }, _request, threadRecord) {
  const posts = threadPosts(records, thread);
  const cursor = records.read('reads', thread)?.job_id;
  const index = id => posts.findIndex(e => e.jobId === id);
  const original = index(cursor);
  let lastRead = original;
  // An empty anchor means before the first post. Continuation links keep the
  // same anchor even if an earlier page advanced the durable read cursor.
  const start = after === undefined ? Math.min(lastRead + 1, posts.length - 1) : after ? index(after) + 1 : 0;
  if (after && start === 0) invalid('after excludes a job in this thread. First pass only thread, then copy the next call in the footer.');
  let length = 0, first, last;
  const page = [];
  for (const [i, e] of posts.slice(start).entries()) {
    const result = records.readResult(e.jobId);
    const header = postHeader(e, result, threadRecord.title);
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
  const next = readCall(lead.host, thread, anchor, end);
  const recovery = !page.length && unread ? ` · unread posts: ${readCall(lead.host, thread)}` : '';
  const footer = end === length ? `[end · ${unread} unread${recovery}]`
    : `[posts ${first ?? start + 1}–${last ?? start + 1} of ${posts.length} · characters ${offset}–${end} of ${length} · next: ${next}]`;
  return { content: [{ type: 'text', text: page.join('') + '\n' + footer }] };
}

function sameLead(saved, caller) {
  return saved?.host === caller.host && saved.session === caller.session && saved.agent === caller.agent;
}

function refuse(action, code, fields = {}) {
  return asJson({ ok: false, action, status: code, code, ...fields });
}

async function sendDelivery(lead, env, job) {
  const eligibility = await HOSTS[lead.host].wakeStatus(lead, env);
  logJob(eligibility.wake ? 'wake.armed' : 'wake.ineligible', job, lead.host, eligibility.wake, eligibility.reason ?? 'acknowledgement');
  return { ...eligibility, fallback: toolName(lead.host, 'wait') };
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
        return refuse('send', 'thread_busy', { thread, job_id: e.jobId, companion: e.companion, current_status: e.state, hint: `Wait for ${toolName(lead.host, 'wait')}({ job_id: ${JSON.stringify(e.jobId)} }) before changing model or effort.` });
      }
      if (task !== e.text) {
        if (task.length > 8000) invalid('intervention text exceeds 8000 characters');
        const selected = mode ?? e.interventionModes.default;
        const { id, ...ack } = await active.intervene({ from: 'caller', thread, jobId: e.jobId,
          mode: selected, text: task, ...request });
        if (!ack.ok) {
          const view = active.status({ jobId: e.jobId });
          const modes = Object.entries(view.interventions).filter(([, allowed]) => allowed === true).map(([mode]) => mode);
          return asJson({ action: 'send', ...ack, current_status: view.state, supported_modes: modes,
            hint: modes.length ? `Use one of: ${modes.join(', ')}.` : 'Wait for the job to finish, then send a follow-up.' });
        }
        return asJson({ ...ack, action: 'send', status: 'intervened', thread, job_id: e.jobId, mode: selected, intervention_id: id,
          delivery: await sendDelivery(lead, active.env, e) });
      }
    }
  }
  if (mode !== undefined) invalid('mode requires new text on a running thread');
  // Work a send would start is refused to a companion session a bridge started.
  if (!live && isCompanionSession(lead.session, active.env)) return refuse('send', 'RECURSION_REFUSED', { hint: 'Return the task to the parent lead.' });
  const route = resolveRouting({ ...args, companion: threadRecord?.companion ?? args.companion }, active.env, !threadRecord);
  if (!route.ok) return asJson({ ...route, action: 'send', status: route.code });
  const { companion, model, effort, savedEffortHint } = route.resolved;
  if (!thread) {
    do { thread = 'th-' + randomBytes(5).toString('hex'); } while (active.records.readThread(thread));
  }
  const sent = await active.send({ thread, lead, title: args.title, text: task, companion, cwd,
    model: model ?? undefined, effort: effort ?? undefined, savedEffortHint, hostSessionId: lead.session, ...request });
  if (!sent.outcome && !sent.acknowledged) {
    return refuse('send', sent.error ?? 'bridge_loss', { thread, job_id: sent.jobId, status: sent.state,
      hint: `Check ${toolName(lead.host, 'status')}({ job_id: ${JSON.stringify(sent.jobId)} }) before retrying.` });
  }
  if (sent.outcome) return terminalResponse(active.records, active.records.readJob(sent.jobId), sent, 'send', request);
  return asJson({ ok: true, status: 'still_running', thread, job_id: sent.jobId, companion, delivery: await sendDelivery(lead, active.env, { thread, jobId: sent.jobId }),
    selected_model: sent.selectedModel ?? null, selected_effort: sent.selectedEffort ?? null,
    effective_model: sent.effectiveModel ?? null, effective_effort: sent.effectiveEffort ?? null, permission_mode: sent.permissionMode ?? null });
}

const field = (type, check, schema = {}) => ({ schema: { type, ...schema }, check });
const described = (field, description) => ({ ...field, schema: { ...field.schema, description } });
const thread = field('string', recordId);
const threadRef = described(thread, 'Thread ID returned by send or status. Selects its latest job. Omit when passing job_id.');
const job_id = field('string', recordId, { description: 'Job ID returned by send or status. Selects that exact job. Omit when passing thread.' });
const modes = ['steer', 'queue', 'interrupt'];
const reference = [{ required: ['thread'] }, { required: ['job_id'] }];

function pageInteger(minimum, maximum, description) {
  return field('integer', (v, k) => {
    if (!Number.isSafeInteger(v) || v < minimum || (maximum && v > maximum)) {
      invalid(`${k} must be a whole number of characters ${maximum ? `from ${minimum} to ${maximum}` : `at least ${minimum}`}.`);
    }
    return v;
  }, { description, minimum, ...(maximum && { maximum }) });
}

function tool(action, description, fields, conditions, handler, annotations) {
  const properties = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.schema]));
  return { name: 'companion_' + action, action, description, fields, handler, annotations,
    inputSchema: { type: 'object', additionalProperties: false, properties, ...conditions } };
}

export const tools = [
  tool('catalog', 'List companions, model defaults and last-checked readiness.', {}, {}, handleCatalog,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true }),
  tool('send', 'Delegate background work or request an independent review. Pass task and absolute cwd on the first send. An armed delivery.wake lets you continue other work. If wake is null, wait using the returned job_id. Handle a terminal result immediately.', {
    task: field('string', string, { description: 'Required verbatim instructions. The companion sees only this task and cwd, so include context and completion criteria. New text on a running thread intervenes in the current job.' }),
    cwd: field('string', assertCwd, { description: 'Absolute path to an existing directory. Required on a new thread. Omit on follow-up to reuse its directory.' }),
    thread: described(thread, 'Omit to start a thread. For a follow-up, copy the thread ID from send or status.'),
    companion: field('string', (v, k) => optionalString(v, k)?.toLowerCase(), { enum: listCompanionIds(), description: 'Companion ID from catalog. Omit to use the current default on a new thread or the bound companion on a follow-up.' }),
    model: field('string', optionalString, { description: 'Native model ID or alias accepted by this companion. Omit to inherit defaults on a new thread or keep the last accepted model on a follow-up.' }),
    effort: field('string', optionalString, { description: 'Reasoning effort level for this model. Catalog lists known levels. Omit to inherit defaults on a new thread or keep the last accepted effort on a follow-up.' }),
    mode: field('string', v => modes.includes(v) ? v : invalid('mode must be steer, queue or interrupt. Omit it on a new thread.'), { enum: modes,
      description: 'Only for new text on a running thread. Steer joins the current turn, queue waits for the next turn, interrupt stops the current turn before sending. Omit to use the job’s default mode.' }),
    title: field('string', string, { description: 'Short display title for a new thread. Defaults to the first line of the task. Follow-ups keep the original title.' }),
  }, { required: ['task'], anyOf: [{ required: ['cwd'] }, { required: ['thread'] }] }, handleSend),
  tool('read', 'First read: pass only thread. For the next page, copy the call in the footer.', {
    thread: described(thread, 'Required thread ID returned by send or status.'),
    after: { ...field('string', (v, k) => v === '' ? v : recordId(v, k), { description: 'First read: omit to use the read cursor. For continuation copy the footer. Excludes the named job in this thread. An empty string starts at the first post.' }), keepEmpty: true },
    offset: pageInteger(0, null, 'Characters to skip from the page anchor. Defaults to 0. Copy the offset and after together from the footer.'),
    limit: pageInteger(1, 40000, 'Maximum characters per page, 1–40000. Defaults to 8000.'),
  }, { required: ['thread'] }, readThread),
  tool('wait', 'Pass either reference. Wait for a result, a user intervention, or the wait budget to expire.', {
    thread: threadRef, job_id, max_wait_sec: field('number', (v, k) => {
      number(v, k);
      if (v <= 0) invalid('max_wait_sec must be positive. Use status to poll.');
      return v;
    }, { description: 'Wait budget in seconds. Defaults to 480, capped at 1200, with a minimum wait of 1 second. Use status to poll.' }),
  }, { anyOf: reference }, handleWait),
  tool('status', 'Inspect a thread or job. With neither reference, list this lead’s threads. Unread counts completed posts remaining at the read cursor.', {
    thread: described(threadRef, threadRef.schema.description + ' Omit both IDs to list threads.'),
    job_id: described(job_id, job_id.schema.description + ' Omit both IDs to list threads.'),
    diagnostics: field('boolean', boolean, { description: 'Defaults to false. Include cached readiness verdicts, blockers and remedies. For a job, include native IDs, stop evidence and Codex protocol status when applicable.' }),
  }, {}, handleStatus),
  tool('cancel', 'Pass either reference to stop a job. A later send can resume its thread.', { thread: threadRef, job_id }, { anyOf: reference }, handleCancel),
];

// Each controller represents one bridge. A Codex session may have several native leads.
const hostSessions = new WeakMap();
function adoptHostSessionId(active, session) {
  const bound = hostSessions.get(active);
  if (bound && bound !== session) throw Object.assign(new Error('Reconnect from the session that owns this bridge.'), { code: 'BRIDGE_SID_CONFLICT' });
  hostSessions.set(active, session);
}

function attributedInput(tool, params, host, active) {
  const raw = params.arguments ?? {};
  const lead = HOSTS[host].leadFromCall({ args: raw, meta: params._meta, env: active.env });
  if (tool.action !== 'catalog' && !lead) throw Object.assign(new Error('Use the registered bridge for this host and check its identity hook or call metadata.'), { code: 'LEAD_REQUIRED' });
  const { lead: injected, ...publicArgs } = raw;
  const args = validateFields(publicArgs, tool);
  if (tool.action === 'send' && !args.thread && args.cwd === undefined) assertCwd(args.cwd);
  if ((tool.action === 'wait' || tool.action === 'cancel') && !args.thread && !args.job_id) invalid('Pass a thread or job_id returned by send or status.');
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
    const job = args.job_id && active.records.readJob(args.job_id);
    args.thread ??= job?.thread;
    const listHint = `Call ${toolName(host, 'status')}({}) in this lead to list its references.`;
    if (args.thread) {
      threadRecord = active.records.readThread(args.thread);
      if (!threadRecord) return refuse(action, 'thread_unknown', { status: 'unknown_thread', thread: args.thread, hint: listHint });
      if (!sameLead(threadRecord.lead, args.lead)) return refuse(action, 'THREAD_NOT_YOURS', { hint: listHint });
    }
    if (args.job_id) {
      if (!job) return refuse(action, 'job_unknown', { status: 'unknown_job', job_id: args.job_id, hint: listHint });
      if (job.thread !== args.thread) invalid('job_id does not belong to thread. Pass either reference on its own.');
    } else if (threadRecord) {
      args.job_id = threadRecord.jobId;
    }
    return await tool.handler(args, active, { requestId, signal }, threadRecord);
  } catch (err) {
    if (!err.code) throw err;
    if (err.code === 'job_not_controlled') return notControlled(action, { thread: args.thread, jobId: args.job_id }, host);
    const checked = err.code === 'CAPABILITY_UNAVAILABLE' ? lastCompanionChecks()[err.companion] : null;
    const recovery = {
      CAPABILITY_UNAVAILABLE: [checked?.blockers?.[0]?.message ?? `Companion ${err.companion ?? 'provider'} is unavailable.`,
        checked?.nextSteps?.[0] ?? readinessCheck].join(' '),
      previous_job_unverified: 'Inspect the previous job and verify cleanup before starting more work.',
      FOLLOWUP_UNSUPPORTED: 'Start a new thread and include the context it needs.',
      bridge_loss: 'Reconnect to the owning session and check status before retrying.',
      stale_generation: 'Check the latest job on this thread before retrying.',
      RECORD_BUSY: 'Retry when the current record update finishes.',
      writer_fenced: 'Check the job in the owning session.',
      thread_busy: 'Wait for the current job to finish before changing its selection.',
      job_id_busy: 'Start a new thread to obtain another job ID.',
      MODEL_NOT_ALLOWED: 'Choose an accepted model or omit model to keep the current selection.',
      DeliveryUnknown: 'Inspect the job before retrying because the request may have reached the companion.',
    };
    return refuse(action, err.code, { error: err.message === err.code && recovery[err.code] ? recovery[err.code] : err.message,
      ...(args?.thread && { thread: args.thread }), ...(args?.job_id && { job_id: args.job_id }),
      ...(err.code === 'job_unknown' && { status: 'unknown_job' }) });
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

// Keep meaningful zero counts and false verdicts while dropping absent or empty metadata.
function compact(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.length ? value.map(compact).filter(v => v !== undefined) : undefined;
  if (typeof value !== 'object') return value;
  const entries = Object.entries(value).map(([key, val]) => [key, compact(val)]).filter(([, val]) => val !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function terminalResponse(records, job, result, action, { signal }) {
  const status = jobStatus(result);
  const evidence = result.stopEvidence;
  const meta = {
    cause: result.cause, detail: result.outcome === 'delivery_unknown' ? 'delivery_unknown' : result.detail ?? null,
    work_summary: result.workSummary ?? null, usage: result.usage, selected_model: result.selectedModel ?? null, effective_model: result.effectiveModel ?? null,
    selected_effort: result.selectedEffort ?? null, effective_effort: result.effectiveEffort ?? null,
    stop_evidence: evidence ? { gone: evidence.gone, signals: evidence.signals?.length ?? 0,
      survivors: evidence.survivors?.length ?? 0, cleanup_ms: evidence.cleanupMs ?? null } : null,
    digest_uri: digestResourceUri(result.jobId),
    ...(result.interventions?.length ? { interventions: result.interventions.map(({ from, mode, state, text }) =>
      ({ from, mode, state, first_line: firstLine(text) })) } : {}),
  };
  const { text, delivered_by } = toolAnswer(records, result, signal);
  if (delivered_by) meta.delivered_by = delivered_by;
  const refused = action === 'send' && result.outcome === 'failed' && job.deliveredAt == null;
  const metadata = { ok: !refused, action, status, thread: result.thread, job_id: result.jobId, companion: job.companion,
    ...(refused && { error: result.text || result.detail || result.cause }), meta: compact(meta) };
  return { ...(refused && { isError: true }), content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(metadata) }] };
}

// One startup prompt can cover multiple jobs. Log the decision for each.
async function wakeJobs(records, jobs, lead, env, startup = false) {
  let transport;
  const record = (event, reason) => {
    for (const job of jobs) logJob(event, job, lead.host, transport, reason);
  };
  try {
    const host = HOSTS[lead.host];
    const eligibility = await host.wakeStatus(lead, env, startup);
    transport = eligibility.wake;
    if (!transport) return record('wake.ineligible', eligibility.reason);
    const notice = jobs.map(job => wakeNotice(records, job, records.readResult(job.jobId))).join('\n');
    record('wake.attempted', startup ? 'startup' : 'completion');
    const evidence = await host.wake(lead, notice, env, startup, eligibility);
    if (evidence) record(evidence.wake ? 'wake.transport' : 'wake.ineligible', evidence.reason);
  } catch {
    const reason = { inbox_socket: 'socket_write_unconfirmed', codex_queue: 'queue_exit_unconfirmed',
      opencode_prompt: 'prompt_request_failed', copilot_session_send: 'extension_ack_unavailable' };
    record('wake.failed', reason[transport] ?? 'eligibility_check_failed');
  }
}

export function createBridgeController({ env = process.env, records = new Records(), ...options } = {}) {
  const controller = new Controller({ env, records, providers: createProviders(env), ...options,
    onResult(job, result) {
      try {
        const lead = publish(records, job, result);
        const waits = pendingWaits.get(controller) ?? [];
        const waiting = [...waits].some(w => w.id === job.jobId && !w.signal?.aborted);
        if (waiting) logJob('wake.skipped', job, lead?.host, null, 'covered_by_wait');
        else if (!lead) logJob('wake.ineligible', job, null, null, 'missing_lead');
        else void wakeJobs(records, [job], lead, env);
      } catch { logJob('wake.failed', job, null, null, 'publication_failed'); }
    },
  });
  return controller;
}
export async function recoverController(active) {
  const notices = new Map();
  for (const job of active.records.listJobs()) {
    const threadRecord = active.records.readThread(job.thread);
    if (threadRecord?.jobId === job.jobId && job.state !== 'closed') {
      await active.recover({ thread: job.thread });
    }
    const result = active.records.readResult(job.jobId);
    if (!result) continue;
    const lead = publish(active.records, job, result);
    if (!HOSTS[lead?.host]?.startupWake || !needsStartupWake(active.records, job)) {
      logJob('wake.skipped', job, lead?.host, null, HOSTS[lead?.host]?.startupWake ? 'already_read_or_claimed' : 'no_startup_wake');
      continue;
    }
    if (!notices.has(lead.session)) notices.set(lead.session, { lead, jobs: [] });
    notices.get(lead.session).jobs.push(job);
  }
  for (const { lead, jobs } of notices.values()) void wakeJobs(active.records, jobs, lead, active.env, true);
}
