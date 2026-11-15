import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Records, resultText, resultUsage, discardInterventions } from './records.mjs';
import { getTargetById } from '../../lib/target-registry.mjs';
import { probePermission } from '../../lib/target-diagnostics.mjs';
import { ProcessSupervisor } from './process-supervisor.mjs';
import { systemClock, bounded } from './clock.mjs';
import { cleanupExecution, spawnCleanupWatcher } from '../../scripts/cleanup-watcher.mjs';
import { appendProviderError } from '../provider-error.mjs';
import { locateTranscript, readTranscript } from '../../lib/transcripts.mjs';
import { snapshotWorktree, diffWorktrees } from '../../lib/worktree-snapshot.mjs';
import { selectTurnItems, summarizeWork } from '../../lib/work-summary.mjs';

const TICK_MS = 1000;
const PROTOCOL_MS = 10_000;
const error = (code) => Object.assign(new Error(code), { code });
const interventionUnavailable = (a, mode) => !a || a.record.state !== 'running' || a.record.terminal || a.stopping || a.closed || a.handedOff
  ? 'state' : a.record.interventionModes?.[mode] ? null : 'capability';
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};

// providers[id] = { enabled, ready, modelAllowed(model), create() }.
// create() returns exactly the protocol-only adapter in PHASE3-SPEC.md.
// The host supplies trusted owner/request identities; this module does no
// metadata attribution. send/wait/reply/cancel hold attachment until they return.
export class Controller {
  constructor({ providers, records = new Records(), clock = systemClock, env = process.env, createSupervisor = (opts) => new ProcessSupervisor(opts), launchWatcher = spawnCleanupWatcher, snapshot = snapshotWorktree, onProgress = () => {}, onResult = () => {} } = {}) {
    this.providers = providers;
    this.records = records;
    this.clock = clock;
    this.env = env;
    this.createSupervisor = createSupervisor;
    this.launchWatcher = launchWatcher;
    this.snapshot = snapshot;
    this.onProgress = onProgress;
    this.onResult = onResult;
    this.live = new Map();
    this.requests = new Map();
    this.graceMs = Number(env.AGENT_COMPANION_OWNER_GRACE_MS ?? 120_000);
    if (!Number.isFinite(this.graceMs) || this.graceMs < 0) throw error('invalid_owner_grace');
  }
  _owner(owner) { if (!owner) throw error('NATIVE_OWNER_REQUIRED'); }
  _persist(a) {
    if (!a.handedOff && !this.records.writeExecution(a.record)) throw error('writer_fenced');
  }
  _eventWrite(a) {
    try { this._persist(a); return true; }
    catch (err) { void Promise.resolve().then(() => this._abandon(a, err)); }
  }
  _lease(a) {
    if (a.handedOff || a.closed) return;
    this.records.writeLease({ owner: a.record.owner, executionId: a.record.executionId, generation: a.record.generation,
      attached: a.requests.size > 0, requestIds: [...a.requests], graceMs: this.graceMs,
      deadline: a.requests.size ? null : this.clock.now() + a.remainingMs, remainingMs: a.remainingMs });
  }
  // Also usable around a host's owner-bound operation. Only these four kinds
  // constitute attachment; catalog/status never call this method.
  beginRequest({ owner, executionId, requestId = randomUUID(), kind, signal }) {
    this._owner(owner);
    const a = this.live.get(executionId);
    if (!a || a.record.owner !== owner || a.closed || a.handedOff) throw error('execution_unknown');
    if (!['send', 'wait', 'reply', 'cancel'].includes(kind)) throw error('invalid_owner_request');
    if (this.requests.has(requestId)) throw error('request_id_busy');
    const abort = () => { void this.cancelRequest(requestId); };
    this.requests.set(requestId, { a, signal, abort });
    a.requests.add(requestId);
    a.remainingMs = this.graceMs;
    a.lastTick = this.clock.monotonic();
    this._lease(a);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    return requestId;
  }
  endRequest(requestId) {
    const request = this.requests.get(requestId);
    if (!request) return;
    const { a, signal, abort } = request;
    signal?.removeEventListener('abort', abort);
    this.requests.delete(requestId); a.requests.delete(requestId);
    if (!a.requests.size) { a.remainingMs = this.graceMs; a.lastTick = this.clock.monotonic(); a.detachedAt = a.lastTick; }
    this._lease(a);
  }
  async cancelRequest(requestId) {
    const request = this.requests.get(requestId);
    if (!request) return null;
    return this._close(request.a, 'owner_stop');
  }
  async send({ owner, provider, cwd, text, model, effort, requestId, signal, hostSessionId }) {
    this._owner(owner);
    if (this.lost) throw error('bridge_loss');
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw error('INVALID_CWD');
    try { cwd = realpathSync(cwd); if (!statSync(cwd).isDirectory()) throw error('INVALID_CWD'); }
    catch { throw error('INVALID_CWD'); }
    if (typeof text !== 'string' || !text.length) throw error('INVALID_TEXT');
    const conversation = this.records.readConversation(owner);
    if (conversation && conversation.provider !== provider) throw error('provider_mismatch');
    if (conversation && conversation.cwd !== cwd) throw error('cwd_mismatch');
    const modelOverride = model === undefined ? conversation?.modelOverride : model;
    const existing = conversation && this.live.get(conversation.executionId);
    const effortOverride = effort === undefined
      ? (existing && !existing.closed ? existing.record.effortOverride : conversation?.effortOverride) : effort;
    if (existing && !existing.closed) {
      if (existing.record.text !== text || existing.record.modelOverride !== modelOverride || existing.record.effortOverride !== effortOverride) throw error('thread_busy');
      return this._sendAttached(existing, { owner, requestId, signal });
    }
    const selected = this.providers?.[provider];
    if (!selected?.enabled) throw error('TARGET_UNSUPPORTED');
    if (!selected.ready) throw error('CAPABILITY_UNAVAILABLE');
    if (modelOverride !== undefined && (typeof modelOverride !== 'string' || !selected.modelAllowed?.(modelOverride))) throw error('MODEL_NOT_ALLOWED');
    const historyId = conversation ? conversation.historyId : this.records.readLegacyHistory(owner, provider);
    const adapter = selected.create();
    if (historyId && (!adapter.capabilities.loadsHistory || !adapter.capabilities.followUp)) throw error('FOLLOWUP_UNSUPPORTED');
    const executionId = randomUUID();
    const permissionMode = probePermission(getTargetById(provider), this.env)?.mode ?? null;
    const record = this.records.begin({ owner, provider, cwd, modelOverride, effortOverride, permissionMode, interventionModes: adapter.capabilities.interventions,
      historyId, executionId, text, hostSessionId, now: this.clock.now() }, conversation?.generation ?? 0);
    const a = { record, adapter, held: [], requests: new Set(), waiters: new Set(), inboxRequests: new Set(), ready: deferred(), done: deferred(), remainingMs: this.graceMs, lastTick: this.clock.monotonic() };
    a.supervisor = this.createSupervisor({ clock: this.clock, onRecord: (processes) => { a.record.processes = processes; this._eventWrite(a); } });
    // Snapshot the marker at dispatch. An old SubagentStop must not cancel a
    // later same-child follow-up; a changed marker is a new stop observation.
    a.stopMarker = JSON.stringify(this.records.readStop(owner));
    this.live.set(executionId, a);
    const response = this._sendAttached(a, { owner, requestId, signal });
    this._schedule(a);
    void this._run(a).catch((err) => this._abandon(a, err));
    return response;
  }
  async _sendAttached(a, args) {
    const id = this.beginRequest({ ...args, executionId: a.record.executionId, kind: 'send' });
    try { return await a.ready.promise; }
    finally { this.endRequest(id); }
  }
  async _run(a) {
    const selection = {
      ...(a.record.modelOverride === undefined ? {} : { model: a.record.modelOverride }),
      ...(a.record.effortOverride === undefined ? {} : { effort: a.record.effortOverride }),
    };
    let phase = 'runtime_unavailable';
    try {
      if (a.stopping) return;
      a.startSnapshot = this._snapshot(a);
      a.started = true;
      await bounded(this.clock, () => a.adapter.start({ cwd: a.record.cwd, env: this.env, ...selection, supervisor: a.supervisor, historyId: this.records.readConversation(a.record.owner).historyId }), PROTOCOL_MS, 'runtime_unavailable');
      if (a.stopping) return;
      phase = 'history_unavailable';
      const conversation = this.records.readConversation(a.record.owner);
      const history = await bounded(this.clock, () => a.adapter.openHistory({ historyId: conversation.historyId, ...selection }), PROTOCOL_MS, 'history_unavailable');
      if (a.stopping) return;
      if (!history?.historyId || (conversation.historyId && history.historyId !== conversation.historyId)) throw error('history_unavailable');
      a.record.historyId = history.historyId;
      a.record.effectiveModel = history.effectiveModel;
      a.record.effectiveEffort = history.effectiveEffort;
      this.records.writeConversation({ ...conversation, historyId: history.historyId, effortOverride: a.record.effortOverride });
      a.record.nativeRefs = history.nativeRefs ?? {};
      a.record.startSnapshot = await a.startSnapshot;
      if (a.stopping) return;
      a.record.state = 'delivering'; this._persist(a); this.onProgress(a.record);
      phase = 'delivery_unknown'; a.nativeActive = true;
      const ack = await this._deliver(a, { id: a.record.executionId, text: a.record.text });
      if (a.stopping) return;
      a.record.nativeTurnId = ack.nativeTurnId ?? null;
      a.record.nativeRefs = { ...a.record.nativeRefs, ...ack.nativeRefs };
      this._locate(a);
      a.record.effectiveModel = ack.effectiveModel ?? a.record.effectiveModel;
      a.record.effectiveEffort = ack.effectiveEffort ?? a.record.effectiveEffort;
      a.record.state = 'running'; a.record.deliveredAt = this.clock.now(); this._persist(a);
      a.ready.resolve({ executionId: a.record.executionId, generation: a.record.generation, state: 'running', acknowledged: true,
        target: a.record.provider, selectedModel: a.record.modelOverride ?? null, selectedEffort: a.record.effortOverride ?? null,
        effectiveModel: a.record.effectiveModel ?? null, effectiveEffort: a.record.effectiveEffort ?? null, permissionMode: a.record.permissionMode });
      phase = 'provider_error';
      let next = false;
      for (;;) {
        const terminal = await a.adapter.observe({ next, onProgress: (progress) => {
          if (!a.closed && !a.handedOff && !a.record.terminal) { a.record.progress = { ...a.record.progress, ...progress }; if (this._eventWrite(a)) this.onProgress(a.record); }
        }, onInput: ({ id, state, nativeTurnId }) => {
          if (a.closed || a.handedOff || a.stopping) return;
          const input = a.record.interventions.find(input => input.id === id);
          if (input && !['answered', 'not_delivered'].includes(input.state)) {
            input.state = state;
            if (state === 'joined') {
              this._turnIds(a, [nativeTurnId]);
              if (a.turn?.nativeTurnId === nativeTurnId && !a.turn.messages.includes(id)) a.turn.messages.push(id);
            }
            this._eventWrite(a);
          }
        } });
        if (a.closed || a.handedOff) return;
        if (!['completed', 'failed', 'interrupted'].includes(terminal?.outcome)) throw error('invalid_native_outcome');
        a.nativeActive = false;
        // An acknowledgement may follow the native result. Account for every
        // accepted write before deciding that this execution has no more work.
        if (!a.stopping && terminal.outcome !== 'failed') await this._settleInputs(a);
        if (a.closed || a.handedOff) return;
        this._recordTurn(a, terminal);
        if (terminal.outcome !== 'failed' && !a.stopping) {
          let pending, tail;
          do {
            tail = a.inputTail;
            pending = await a.adapter.hasPendingInput?.();
            await this._settleInputs(a);
          } while (tail !== a.inputTail && !a.stopping);
          if (a.closed || a.handedOff) return;
          if (!a.stopping && pending) { a.nativeActive = true; next = true; continue; }
          if (!a.stopping && a.held.length) {
            // Interrupt input precedes the ordinary queue, in acceptance order.
            const priority = a.held.findIndex(input => input.mode === 'interrupt');
            const [input] = a.held.splice(priority < 0 ? 0 : priority, 1);
            phase = 'delivery_unknown';
            await this._deliver(a, input);
            if (a.stopping) return;
            phase = 'provider_error'; next = false; continue;
          }
        }
        this._terminal(a, { ...terminal, cause: a.stopCause === 'user_cancel' ? 'user_cancel'
          : terminal.outcome === 'completed' ? 'native_complete' : (a.stopCause || terminal.cause || 'provider_error') });
        await this._close(a, a.record.terminal.cause);
        break;
      }
    } catch (err) {
      if (a.stopping || a.handedOff || a.closed) return;
      this._pendingTurn(a);
      this._terminal(a, { outcome: phase === 'delivery_unknown' ? 'delivery_unknown' : 'failed', cause: 'provider_error', detail: typeof err.code === 'string' && !['RuntimeUnavailable', 'HistoryUnavailable', 'DeliveryUnknown', 'ProviderLost'].includes(err.code) ? err.code : phase, error: err.code || err.name }, err);
      if (a.turn) this._recordTurn(a, { ...a.record.terminal, error: undefined });
      await this._close(a, 'provider_error');
    }
  }
  async _deliver(a, input) {
    a.nativeActive = true;
    a.turn = { nativeTurnId: null, messages: [input.id] };
    a.record.progress = {}; a.record.state = 'delivering'; this._persist(a);
    const ack = await bounded(this.clock, () => a.adapter.deliver({ text: input.text, messageId: input.id }), PROTOCOL_MS, 'DeliveryUnknown');
    if (!ack?.nativeTurnId && ack?.acknowledged !== true) throw error('DeliveryUnknown');
    if (a.stopping) return ack;
    a.turn.nativeTurnId = ack.nativeTurnId ?? null;
    a.record.state = 'running';
    a.record.effectiveModel = ack.effectiveModel ?? a.record.effectiveModel;
    a.record.effectiveEffort = ack.effectiveEffort ?? a.record.effectiveEffort;
    if (ack.nativeTurnId) this._turnIds(a, [ack.nativeTurnId]);
    if (input.state === 'accepted') input.state = 'delivered';
    this._persist(a);
    return ack;
  }
  _turnIds(a, ids) {
    for (const id of ids) if (id && !a.record.nativeTurnIds.includes(id)) a.record.nativeTurnIds.push(id);
  }
  _recordTurn(a, terminal) {
    const nativeTurnId = terminal.nativeTurnId ?? a.turn?.nativeTurnId ?? a.record.nativeTurnId ?? null;
    const answered = terminal.messages ?? a.turn?.messages;
    // ACP has no native turn id. The initiating message distinguishes its
    // turns; a post-close correction without a new turn updates the last one.
    const existing = nativeTurnId == null
      ? answered ? a.record.turns.find(turn => turn.messages[0] === answered[0]) : a.record.turns.at(-1)
      : a.record.turns.find(turn => turn.nativeTurnId === nativeTurnId);
    const messages = answered ?? existing?.messages ?? [];
    this._turnIds(a, [nativeTurnId]);
    const text = terminal.outcome === 'interrupted' ? 'interrupted before answering'
      : terminal.outcome === 'failed' ? appendProviderError(terminal.text ?? a.record.progress?.partialText, terminal.error) : terminal.text ?? '';
    const turn = { nativeTurnId, messages, outcome: terminal.outcome, text, usage: terminal.usage };
    if (existing) Object.assign(existing, turn);
    else a.record.turns.push(turn);
    for (const input of a.record.interventions) if (messages.includes(input.id)) input.state = terminal.outcome === 'completed' ? 'answered' : 'not_delivered';
    a.turn = null;
    this._persist(a);
  }
  async _settleInputs(a) {
    let tail;
    do { tail = a.inputTail; await tail; } while (tail !== a.inputTail && !a.stopping);
  }
  _terminal(a, terminal, explanation = terminal.error) {
    // Persist the native outcome before any close operation. Final result
    // publication waits for cleanup evidence; once published it is immutable.
    if (!a.record.terminal) {
      if (terminal.cause === 'provider_error' && ['failed', 'delivery_unknown'].includes(terminal.outcome)) {
        terminal = { ...terminal, text: appendProviderError(terminal.text ?? a.record.progress?.partialText, explanation) };
      }
      a.record.terminal = { ...terminal, at: this.clock.now() }; this._persist(a);
    }
  }
  _schedule(a) {
    a.timer = this.clock.setTimeout(() => {
      try { this._tick(a); }
      catch (err) { a.record.monitorError = err.code || err.message; void this._close(a, 'provider_error'); }
      if (!a.stopping && !a.closed && !a.handedOff) this._schedule(a);
    }, TICK_MS);
    a.timer?.unref?.();
  }
  _tick(a) {
    if (a.stopping || a.closed || a.handedOff) return;
    const marker = this.records.readStop(a.record.owner);
    if (marker && JSON.stringify(marker) !== a.stopMarker) { void this._close(a, 'owner_stop'); return; }
    const now = this.clock.monotonic();
    const elapsed = now - a.lastTick; a.lastTick = now;
    // A long scheduling gap can be suspend or event-loop starvation. Neither
    // proves owner loss. Pause the grace across it; wall-clock jumps never
    // expire a lease. Ordinary scheduled awake ticks consume the grace.
    if (!a.requests.size) {
      if (elapsed >= 0 && elapsed <= 2 * TICK_MS) a.remainingMs -= elapsed;
      else this._lease(a);
      if (a.remainingMs <= 0) { void this._close(a, 'owner_lease_expired'); return; }
    }
    this._inbox(a);
  }
  _inbox(a) {
    const executionId = a.record.executionId;
    for (const { requestId, request, reason } of this.records.readInbox(executionId)) {
      if (a.inboxRequests.has(requestId)) continue;
      const finish = outcome => this.records.finishInbox(executionId, requestId, outcome);
      if (reason || request.executionId !== executionId || !this.live.has(request.executionId) || a.stopping) {
        finish({ ok: false, status: 'intervention_unavailable', reason: reason ?? 'state' });
        continue;
      }
      if (request.mode === 'cancel') {
        finish({ ok: true, status: 'cancelling' });
        void this._close(a, 'user_cancel');
        continue;
      }
      a.inboxRequests.add(requestId);
      void this.intervene({ executionId, from: 'user', mode: request.mode, text: request.text }).then(response => {
        finish(response.ok ? { ok: true, status: 'accepted', interventionId: response.id } : response);
      }, err => finish({ ok: false, status: 'intervention_unavailable', reason: err.code || 'delivery_failed' }))
        .catch(err => { a.record.monitorError = err.code || err.message; void this._close(a, 'provider_error'); })
        .finally(() => a.inboxRequests.delete(requestId));
    }
  }
  _close(a, cause) {
    if (a.closing) return a.closing;
    a.stopping = true; a.stopCause = cause;
    this._pendingTurn(a);
    discardInterventions(a.record); a.held.length = 0;
    this.clock.clearTimeout(a.timer);
    a.record.state = 'stopping'; a.record.stopCause = cause; a.record.stopDecidedAt = this.clock.now();
    a.stopDecidedMono = this.clock.monotonic();
    a.closing = Promise.resolve().then(() => { this._persist(a); return this._finish(a, cause); }).catch((err) => this._abandon(a, err));
    return a.closing;
  }
  _pendingTurn(a) {
    // Native input may have started before the previous observe continuation
    // ran. Its lifecycle still identifies the unfinished turn during cleanup.
    if (!a.turn) {
      const messages = a.record.interventions.filter(input => input.state === 'joined').map(input => input.id);
      if (messages.length) {
        a.turn = { nativeTurnId: messages[0], messages };
        a.nativeActive = true;
      }
    }
  }
  async _abandon(a, err) {
    // Storage/authority failure cannot strand the provider or leave a caller
    // awaiting an unhandled rejection. Do not write through a failed fence.
    a.stopping = true; a.handedOff = true;
    this.clock.clearTimeout(a.timer);
    const cleanup = await a.supervisor.terminate();
    a.closed = true;
    this.records.removeInbox(a.record.executionId);
    for (const id of [...a.requests]) this.endRequest(id);
    this.live.delete(a.record.executionId);
    const response = { executionId: a.record.executionId, state: 'unknown', error: err.code || err.message, stopEvidence: cleanup };
    a.ready.resolve(response); a.done.resolve(response);
    return response;
  }
  async _snapshot(a) {
    try { return await this.snapshot(a.record.cwd, { env: this.env }); }
    catch { return { available: false, reason: 'snapshot_failed' }; }
  }
  _locate(a) {
    if (!a.record.transcript) {
      try { a.record.transcript = locateTranscript({ companion: a.record.provider, historyId: a.record.historyId,
        nativeRefs: a.record.nativeRefs, env: this.env }); }
      catch { a.record.transcript = null; }
    }
  }
  async _workSummary(a, cleanup) {
    a.record.startSnapshot ??= await a.startSnapshot;
    a.record.endSnapshot = cleanup.gone ? await this._snapshot(a) : { available: false, reason: 'cleanup_unverified' };
    a.record.nativeRefs = { ...a.record.nativeRefs, ...a.record.terminal?.nativeRefs };
    this._locate(a);
    let transcript;
    try { if (a.record.transcript) transcript = readTranscript(a.record.transcript); }
    catch { transcript = { format: { detail: 'transcript_read_failed' }, items: [] }; }
    const items = selectTurnItems(transcript?.items ?? [], { companion: a.record.provider,
      nativeTurnId: a.record.nativeTurnId, nativeTurnIds: a.record.nativeTurnIds, interventions: a.record.interventions, startedAt: a.record.startedAt });
    const worktree = await diffWorktrees(a.record.cwd, a.record.startSnapshot, a.record.endSnapshot, { env: this.env });
    return { summary: summarizeWork({ locator: a.record.transcript, transcript, items, worktree, ended: true }),
      nativeError: items.find(item => item.kind === 'error')?.error };
  }
  async _finish(a, cause) {
    const protocol = [];
    for (const method of [a.started && a.nativeActive !== false ? 'interrupt' : null, 'close'].filter(Boolean)) {
      try { await bounded(this.clock, () => a.adapter[method](), 500, `${method}_timeout`); protocol.push({ method, acknowledged: true }); }
      catch (err) { protocol.push({ method, acknowledged: false, error: err.code || err.name }); }
    }
    const cleanup = await a.supervisor.terminate();
    if (a.handedOff) return a.done.promise;
    if (a.turn && a.record.interventions.length) this._recordTurn(a, { outcome: 'interrupted' });
    discardInterventions(a.record);
    a.record.cleanup = { ...cleanup, protocol, detectionDelayMs: cause === 'owner_lease_expired' ? a.stopDecidedMono - a.detachedAt : 0,
      cleanupMs: this.clock.monotonic() - a.stopDecidedMono };
    const { summary: workSummary, nativeError } = await this._workSummary(a, cleanup);
    if (a.handedOff) return a.done.promise;
    let terminal = a.record.terminal;
    if (a.record.provider === 'copilot' && terminal?.outcome === 'completed' && nativeError) {
      terminal = a.record.terminal = { ...terminal, outcome: 'failed', cause: 'provider_error', detail: nativeError.type,
        text: appendProviderError(terminal.text, nativeError.message) };
      this._recordTurn(a, terminal);
    }
    const result = {
      workSummary,
      owner: a.record.owner, executionId: a.record.executionId, generation: a.record.generation,
      outcome: terminal?.outcome || (cleanup.gone ? 'stopped' : 'failed'), cause: terminal?.cause || cause,
      detail: cleanup.gone ? terminal?.detail : 'cleanup_unverified', text: resultText(a.record),
      turns: a.record.turns, interventions: a.record.interventions, nativeTurnIds: a.record.nativeTurnIds,
      usage: resultUsage(a.record, terminal?.usage), nativeRefs: { historyId: a.record.historyId, nativeTurnId: a.record.nativeTurnId, nativeTurnIds: a.record.nativeTurnIds, ...a.record.nativeRefs, ...terminal?.nativeRefs },
      selectedModel: a.record.modelOverride, selectedEffort: a.record.effortOverride, effectiveModel: terminal?.effectiveModel ?? a.record.effectiveModel,
      effectiveEffort: terminal?.effectiveEffort ?? a.record.effectiveEffort,
      stopEvidence: a.record.cleanup, finishedAt: this.clock.now(),
    };
    if (!this.records.writeResult(result)) throw error('writer_fenced');
    a.record.state = cleanup.gone ? 'closed' : 'unknown'; this._persist(a);
    this.records.writeLease({ owner: a.record.owner, executionId: a.record.executionId, generation: a.record.generation,
      attached: false, requestIds: [], deadline: null, closedAt: this.clock.now() });
    a.closed = true;
    for (const id of [...a.requests]) this.endRequest(id);
    const saved = this.records.readResult(a.record.executionId);
    this.onResult(a.record, saved);
    this.live.delete(a.record.executionId);
    a.ready.resolve(saved); a.done.resolve(saved);
    return saved;
  }
  async wait({ owner, executionId, requestId, signal, timeoutMs = 30_000 }) {
    this._owner(owner);
    const execution = this.records.readExecution(executionId);
    if (!execution || execution.owner !== owner) throw error('execution_unknown');
    const result = this.records.readResult(executionId);
    if (result) return this._userNotice(owner, executionId) ?? result;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 1_200_000) throw error('invalid_wait');
    const a = this.live.get(executionId);
    if (!a || a.handedOff) return this._userNotice(owner, executionId) ?? this.status({ executionId });
    const id = this.beginRequest({ owner, executionId, requestId, signal, kind: 'wait' });
    try {
      const notice = !signal?.aborted && this._userNotice(owner, executionId);
      if (notice) return notice;
      return await new Promise(resolve => {
        const finish = value => {
          if (!a.waiters.delete(finish)) return;
          this.clock.clearTimeout(timer);
          resolve(value);
        };
        const timer = this.clock.setTimeout(() => finish(this.status({ executionId })), timeoutMs);
        a.waiters.add(finish);
        a.done.promise.then(finish);
      });
    }
    finally { this.endRequest(id); }
  }
  _userNotice(owner, executionId) {
    const intervention = this.records.takeUserIntervention(executionId, owner);
    return intervention ? { status: 'user_intervened', executionId, intervention } : null;
  }
  _notifyUser(a) {
    for (const finish of a.waiters) {
      const notice = this._userNotice(a.record.owner, a.record.executionId);
      if (!notice) break;
      finish(notice);
    }
  }
  async intervene({ executionId, from, owner, mode, text, requestId, signal }) {
    if (!['caller', 'user'].includes(from)) throw error('INVALID_SENDER');
    if (from === 'caller') {
      this._owner(owner);
      const execution = this.records.readExecution(executionId);
      if (!execution || execution.owner !== owner) throw error('execution_unknown');
    }
    if (typeof text !== 'string' || !text.length) throw error('INVALID_TEXT');
    const a = this.live.get(executionId);
    if (mode === undefined) mode = a?.record.interventionModes.default;
    const unavailable = reason => ({ ok: false, status: 'intervention_unavailable', reason });
    const reason = interventionUnavailable(a, mode);
    if (reason || !['steer', 'queue', 'interrupt'].includes(mode)) return unavailable(reason || 'capability');
    const request = from === 'caller' ? this.beginRequest({ owner, executionId, requestId, signal, kind: 'reply' }) : null;
    try {
      if (a.stopping || signal?.aborted) return unavailable('state');
      const input = { id: randomUUID(), from, mode, text, at: this.clock.now(), state: 'accepted' };
      a.record.interventions.push(input); this._persist(a);
      if (from === 'user') this._notifyUser(a);
      const operation = (a.inputTail ?? Promise.resolve()).then(async () => {
        if (a.stopping || a.handedOff || a.closed) return unavailable('state');
        const nativeQueue = a.adapter.capabilities.interventions.queue === 'native';
        try {
          let ack;
          if (mode === 'queue' && !nativeQueue) a.held.push(input);
          else if (mode === 'interrupt' && !nativeQueue) {
            a.held.push(input);
            await bounded(this.clock, () => a.adapter.interrupt({ drain: true }), PROTOCOL_MS, 'interrupt_timeout');
          } else {
            ack = mode === 'steer' ? await a.adapter.steer({ text, id: input.id })
              : await bounded(this.clock, () => a.adapter.intervene(input), PROTOCOL_MS, 'DeliveryUnknown');
            if (!a.stopping && !a.handedOff && !a.closed) {
              if (mode === 'steer') { a.turn?.messages.push(input.id); input.state = 'joined'; }
              else if (input.state === 'accepted') input.state = 'delivered';
            }
          }
          if (!a.closed && !a.handedOff) this._persist(a);
          return { ok: true, ...ack, id: input.id };
        } catch (err) {
          input.state = 'not_delivered'; a.held = a.held.filter(held => held !== input);
          if (!a.closed && !a.handedOff) this._persist(a);
          throw err;
        }
      });
      a.inputTail = operation.catch(() => {});
      return await operation;
    } finally { if (request) this.endRequest(request); }
  }
  async steer(args) {
    const result = await this.intervene({ ...args, from: 'caller', mode: 'steer' });
    return result.status === 'intervention_unavailable' ? { ...result, status: 'reply_unavailable' } : result;
  }
  async cancel({ owner, executionId, requestId, signal }) {
    this._owner(owner);
    const execution = this.records.readExecution(executionId);
    if (!execution || execution.owner !== owner) throw error('execution_unknown');
    const result = this.records.readResult(executionId);
    if (result) return result;
    const id = this.beginRequest({ owner, executionId, requestId, signal, kind: 'cancel' });
    try { return await this._close(this.live.get(executionId), 'owner_stop'); }
    finally { this.endRequest(id); }
  }
  status({ executionId, owner } = {}) {
    if (!executionId && owner) executionId = this.records.readConversation(owner)?.executionId;
    if (!executionId) return null;
    const execution = this.records.readExecution(executionId);
    if (!execution) return null;
    const result = this.records.readResult(executionId);
    const live = this.live.get(executionId);
    const savedLease = this.records.readLease(executionId);
    const lease = savedLease && (result
      ? { ...savedLease, attached: false, requestIds: [], deadline: null, remainingMs: null }
      : { ...savedLease, remainingMs: live ? live.remainingMs : savedLease.deadline == null ? null : Math.max(0, savedLease.deadline - this.clock.now()) });
    const interventions = { default: execution.interventionModes?.default ?? null,
      ...Object.fromEntries(['steer', 'queue', 'interrupt'].map(mode => [mode, !result && interventionUnavailable(live, mode) === null])) };
    return { execution, result, lease, interventions,
      state: result?.stopEvidence?.gone || execution.cleanup?.gone ? 'closed' : live ? execution.state : 'unknown' };
  }
  // Explicit startup reconciliation, never invoked by an observer. It never
  // adopts or signals an old runtime: only positive absence permits recovery.
  async recover({ owner }) {
    this._owner(owner);
    const conversation = this.records.readConversation(owner);
    if (!conversation) return null;
    const execution = this.records.readExecution(conversation.executionId);
    if (!execution) return null;
    const saved = this.records.readResult(execution.executionId);
    if (this.live.has(execution.executionId) || saved?.stopEvidence?.gone || execution.cleanup?.gone || !execution.processes?.pid) return this.status({ owner });
    const supervisor = this.createSupervisor({ record: execution.processes, clock: this.clock });
    const stopEvidence = await supervisor.verifyGone();
    if (!stopEvidence.gone) return this.status({ owner });
    const terminal = execution.terminal;
    discardInterventions(execution);
    if (!saved) this.records.writeResult({ owner, executionId: execution.executionId, generation: execution.generation,
      outcome: terminal?.outcome || 'stopped', cause: 'bridge_loss', detail: terminal?.detail,
      selectedModel: execution.modelOverride, selectedEffort: execution.effortOverride, effectiveModel: terminal?.effectiveModel ?? execution.effectiveModel,
      effectiveEffort: terminal?.effectiveEffort ?? execution.effectiveEffort, text: resultText(execution),
      turns: execution.turns, interventions: execution.interventions, nativeTurnIds: execution.nativeTurnIds,
      usage: resultUsage(execution, terminal?.usage), nativeRefs: { historyId: execution.historyId, nativeTurnId: execution.nativeTurnId, nativeTurnIds: execution.nativeTurnIds, ...terminal?.nativeRefs },
      stopEvidence, finishedAt: this.clock.now() }, execution.writer);
    this.records.writeExecution({ ...execution, state: 'closed', cleanup: stopEvidence }, execution.writer);
    return this.status({ owner });
  }
  async bridgeLost() {
    this.lost = true;
    const handoffs = [];
    const active = [...this.live.values()].filter((a) => !a.closed && !a.handedOff);
    for (const a of active) {
      this._pendingTurn(a);
      if (a.turn && a.record.interventions.length) this._recordTurn(a, { outcome: 'interrupted' });
      discardInterventions(a.record); a.held.length = 0;
      a.stopping = true; a.handedOff = true;
      this.clock.clearTimeout(a.timer); a.supervisor.stopCensus();
    }
    for (const a of active) {
      try {
        await a.supervisor.quiesce();
        try { await a.supervisor.census(); } catch {}
        a.record.processes = a.supervisor.serialize();
        if (!this.records.handoff(a.record)) throw error('writer_fenced');
        let watcher;
        try { watcher = await this.launchWatcher({ stateDir: this.records.dir, executionId: a.record.executionId }); }
        catch { watcher = { result: await cleanupExecution({ records: this.records, execution: a.record, clock: this.clock, createSupervisor: this.createSupervisor }) }; }
        a.supervisor.detach();
        const response = { executionId: a.record.executionId, state: 'cleanup_pending', watcher };
        for (const id of [...a.requests]) this.endRequest(id);
        a.ready.resolve(response); a.done.resolve(response); handoffs.push(response);
      } catch (err) { handoffs.push(await this._abandon(a, err)); }
    }
    return handoffs;
  }
}
