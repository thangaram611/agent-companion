import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Records } from './records.mjs';
import { ProcessSupervisor } from './process-supervisor.mjs';
import { systemClock, bounded } from './clock.mjs';
import { cleanupExecution, spawnCleanupWatcher } from '../../scripts/cleanup-watcher.mjs';

const TICK_MS = 1000;
const PROTOCOL_MS = 10_000;
const error = (code) => Object.assign(new Error(code), { code });
const replyUnavailable = (a) => !a || a.record.state !== 'running' || a.record.terminal || a.stopping || a.closed || a.handedOff
  ? 'state' : a.adapter.capabilities.steer ? null : 'capability';
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
  constructor({ providers, records = new Records(), clock = systemClock, env = process.env, createSupervisor = (opts) => new ProcessSupervisor(opts), launchWatcher = spawnCleanupWatcher, onProgress = () => {}, onResult = () => {} } = {}) {
    this.providers = providers;
    this.records = records;
    this.clock = clock;
    this.env = env;
    this.createSupervisor = createSupervisor;
    this.launchWatcher = launchWatcher;
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
  async send({ owner, provider, cwd, text, model, requestId, signal, hostSessionId }) {
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
    if (existing && !existing.closed) {
      if (existing.record.text !== text || existing.record.modelOverride !== modelOverride) throw error('thread_busy');
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
    const record = this.records.begin({ owner, provider, cwd, modelOverride, historyId, executionId, text, hostSessionId, now: this.clock.now() }, conversation?.generation ?? 0);
    const a = { record, adapter, requests: new Set(), ready: deferred(), done: deferred(), remainingMs: this.graceMs, lastTick: this.clock.monotonic() };
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
    const model = a.record.modelOverride === undefined ? {} : { model: a.record.modelOverride };
    let phase = 'runtime_unavailable';
    try {
      if (a.stopping) return;
      a.started = true;
      await bounded(this.clock, () => a.adapter.start({ cwd: a.record.cwd, env: this.env, ...model, supervisor: a.supervisor, historyId: this.records.readConversation(a.record.owner).historyId }), PROTOCOL_MS, 'runtime_unavailable');
      if (a.stopping) return;
      phase = 'history_unavailable';
      const conversation = this.records.readConversation(a.record.owner);
      const history = await bounded(this.clock, () => a.adapter.openHistory({ historyId: conversation.historyId, ...model }), PROTOCOL_MS, 'history_unavailable');
      if (a.stopping) return;
      if (!history?.historyId || (conversation.historyId && history.historyId !== conversation.historyId)) throw error('history_unavailable');
      a.record.historyId = history.historyId;
      a.record.effectiveModel = history.effectiveModel;
      a.record.effectiveEffort = history.effectiveEffort;
      this.records.writeConversation({ ...conversation, historyId: history.historyId });
      a.record.state = 'delivering'; this._persist(a); this.onProgress(a.record);
      phase = 'delivery_unknown'; a.nativeActive = true;
      const ack = await bounded(this.clock, () => a.adapter.deliver({ text: a.record.text }), PROTOCOL_MS, 'DeliveryUnknown');
      if (a.stopping) return;
      if (!ack?.nativeTurnId) throw error('DeliveryUnknown');
      a.record.nativeTurnId = ack.nativeTurnId;
      a.record.state = 'running'; a.record.deliveredAt = this.clock.now(); this._persist(a);
      a.ready.resolve({ executionId: a.record.executionId, generation: a.record.generation, state: 'running', acknowledged: true });
      phase = 'provider_error';
      const terminal = await a.adapter.observe({ onProgress: (progress) => {
        if (!a.closed && !a.handedOff && !a.record.terminal) { a.record.progress = { ...a.record.progress, ...progress }; if (this._eventWrite(a)) this.onProgress(a.record); }
      } });
      if (a.closed || a.handedOff) return;
      if (!['completed', 'failed', 'interrupted'].includes(terminal?.outcome)) throw error('invalid_native_outcome');
      a.nativeActive = false;
      this._terminal(a, { ...terminal, cause: terminal.outcome === 'completed' ? 'native_complete' : (a.stopCause || terminal.cause || 'provider_error') });
      await this._close(a, a.record.terminal.cause);
    } catch (err) {
      if (a.stopping || a.handedOff || a.closed) return;
      this._terminal(a, { outcome: phase === 'delivery_unknown' ? 'delivery_unknown' : 'failed', cause: 'provider_error', detail: typeof err.code === 'string' && !['RuntimeUnavailable', 'HistoryUnavailable', 'DeliveryUnknown', 'ProviderLost'].includes(err.code) ? err.code : phase, error: err.code || err.name });
      await this._close(a, 'provider_error');
    }
  }
  _terminal(a, terminal) {
    // Persist the native outcome before any close operation. Final result
    // publication waits for cleanup evidence; once published it is immutable.
    if (!a.record.terminal) { a.record.terminal = { ...terminal, at: this.clock.now() }; this._persist(a); }
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
    if (a.requests.size) return;
    // A long scheduling gap can be suspend or event-loop starvation. Neither
    // proves owner loss. Pause the grace across it; wall-clock jumps never
    // expire a lease. Ordinary scheduled awake ticks consume the grace.
    if (elapsed >= 0 && elapsed <= 2 * TICK_MS) a.remainingMs -= elapsed;
    else this._lease(a);
    if (a.remainingMs <= 0) void this._close(a, 'owner_lease_expired');
  }
  _close(a, cause) {
    if (a.closing) return a.closing;
    a.stopping = true; a.stopCause = cause;
    this.clock.clearTimeout(a.timer);
    a.record.state = 'stopping'; a.record.stopCause = cause; a.record.stopDecidedAt = this.clock.now();
    a.stopDecidedMono = this.clock.monotonic();
    a.closing = Promise.resolve().then(() => { this._persist(a); return this._finish(a, cause); }).catch((err) => this._abandon(a, err));
    return a.closing;
  }
  async _abandon(a, err) {
    // Storage/authority failure cannot strand the provider or leave a caller
    // awaiting an unhandled rejection. Do not write through a failed fence.
    a.stopping = true; a.handedOff = true;
    this.clock.clearTimeout(a.timer);
    const cleanup = await a.supervisor.terminate();
    a.closed = true;
    for (const id of [...a.requests]) this.endRequest(id);
    this.live.delete(a.record.executionId);
    const response = { executionId: a.record.executionId, state: 'unknown', error: err.code || err.message, stopEvidence: cleanup };
    a.ready.resolve(response); a.done.resolve(response);
    return response;
  }
  async _finish(a, cause) {
    const protocol = [];
    for (const method of [a.started && a.nativeActive !== false ? 'interrupt' : null, 'close'].filter(Boolean)) {
      try { await bounded(this.clock, () => a.adapter[method](), 500, `${method}_timeout`); protocol.push({ method, acknowledged: true }); }
      catch (err) { protocol.push({ method, acknowledged: false, error: err.code || err.name }); }
    }
    const cleanup = await a.supervisor.terminate();
    if (a.handedOff) return a.done.promise;
    a.record.cleanup = { ...cleanup, protocol, detectionDelayMs: cause === 'owner_lease_expired' ? a.stopDecidedMono - a.detachedAt : 0,
      cleanupMs: this.clock.monotonic() - a.stopDecidedMono };
    const terminal = a.record.terminal;
    const result = {
      owner: a.record.owner, executionId: a.record.executionId, generation: a.record.generation,
      outcome: terminal?.outcome || (cleanup.gone ? 'stopped' : 'failed'), cause: terminal?.cause || cause,
      detail: cleanup.gone ? terminal?.detail : 'cleanup_unverified', text: terminal?.text ?? a.record.progress?.partialText ?? '',
      usage: terminal?.usage, nativeRefs: { historyId: a.record.historyId, nativeTurnId: a.record.nativeTurnId, ...terminal?.nativeRefs },
      selectedModel: a.record.modelOverride, effectiveModel: terminal?.effectiveModel ?? a.record.effectiveModel,
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
    if (result) return result;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 1_200_000) throw error('invalid_wait');
    const a = this.live.get(executionId);
    if (!a || a.handedOff) return this.status({ executionId });
    const id = this.beginRequest({ owner, executionId, requestId, signal, kind: 'wait' });
    try { return await bounded(this.clock, () => a.done.promise, timeoutMs, 'wait_timeout'); }
    catch (err) { if (err.code === 'wait_timeout') return this.status({ executionId }); throw err; }
    finally { this.endRequest(id); }
  }
  async steer({ owner, executionId, text, requestId, signal }) {
    this._owner(owner);
    const execution = this.records.readExecution(executionId);
    if (!execution || execution.owner !== owner) throw error('execution_unknown');
    if (typeof text !== 'string' || !text.length) throw error('INVALID_TEXT');
    const a = this.live.get(executionId);
    const reason = replyUnavailable(a);
    if (reason) return { ok: false, status: 'reply_unavailable', reason };
    const id = this.beginRequest({ owner, executionId, requestId, signal, kind: 'reply' });
    try {
      // An already-aborted owner request starts cleanup synchronously.
      if (a.stopping) return { ok: false, status: 'reply_unavailable', reason: 'state' };
      return { ok: true, ...await a.adapter.steer({ text }) };
    } finally { this.endRequest(id); }
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
    return { execution, result, lease, replyAvailable: !result && replyUnavailable(live) === null,
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
    if (!saved) this.records.writeResult({ owner, executionId: execution.executionId, generation: execution.generation,
      outcome: terminal?.outcome || 'stopped', cause: 'bridge_loss', detail: terminal?.detail,
      selectedModel: execution.modelOverride, effectiveModel: terminal?.effectiveModel ?? execution.effectiveModel,
      effectiveEffort: terminal?.effectiveEffort ?? execution.effectiveEffort, text: terminal?.text ?? execution.progress?.partialText ?? '',
      usage: terminal?.usage, nativeRefs: { historyId: execution.historyId, nativeTurnId: execution.nativeTurnId, ...terminal?.nativeRefs },
      stopEvidence, finishedAt: this.clock.now() }, execution.writer);
    this.records.writeExecution({ ...execution, state: 'closed', cleanup: stopEvidence }, execution.writer);
    return this.status({ owner });
  }
  async bridgeLost() {
    this.lost = true;
    const handoffs = [];
    const active = [...this.live.values()].filter((a) => !a.closed && !a.handedOff);
    for (const a of active) {
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
