import { LineReader } from './codex-protocol.mjs';
import { codexAppServerSandbox, resolveSteerConfirmMs } from './codex-protocol.mjs';
import { inspectCodexAppServerInstallation } from '../../lib/codex-install.mjs';
import { connectionScopedNotificationMethods, routeNotification } from '../../lib/codex-app-server-contract.mjs';
import { codexTurnBaseline, usageFromCodexTokenUsage } from '../../lib/usage.mjs';
import { getTargetById } from '../../lib/target-registry.mjs';
import { companionReady } from '../../lib/target-diagnostics.mjs';
import { isModelAllowedFor } from '../../lib/state.mjs';
import { bounded, systemClock } from '../controller/clock.mjs';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_GENERATOR_ARGS, codexAppServerContract, distillAppServerSchema, compareContracts } from '../../lib/codex-app-server-contract.mjs';

let contractStatus = 'unverified';
let contractCheck;
export const getCodexContractStatus = () => contractStatus;

// One advisory schema dump per bridge process, even when executions overlap.
// The probe never blocks a provider start and never refuses a drifting binary.
export function checkCodexContract(installation, env) {
  return contractCheck ??= new Promise((resolve) => {
    let dir;
    try { dir = mkdtempSync(join(tmpdir(), 'codex-adapter-schema-')); }
    catch { resolve(contractStatus); return; }
    let child;
    const cleanup = () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    };
    const finish = (err) => {
      process.removeListener('exit', cleanup);
      try {
        if (!err) {
          const live = distillAppServerSchema(dir, installation.selected.version || 'unknown');
          contractStatus = compareContracts(codexAppServerContract(), live).identical ? 'match' : 'drift';
        }
      } catch { contractStatus = 'unverified'; }
      finally { cleanup(); resolve(contractStatus); }
    };
    process.once('exit', cleanup);
    try {
      child = execFile(installation.selected.path, [...SCHEMA_GENERATOR_ARGS, dir], {
        env, timeout: 30_000, killSignal: 'SIGKILL',
      }, finish);
    } catch (err) { finish(err); }
  });
}

const PROTOCOL_MS = 10_000;
const capabilities = Object.freeze({ followUp: true, steer: true, modelSelection: true, loadsHistory: true });
const failure = (code, cause) => Object.assign(new Error(code, { cause }), { code, name: code });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// One execution, one stdio connection. The controller alone owns process
// lifetime, durable state, resends (there are none) and cleanup verification.
export class CodexAdapter {
  capabilities = capabilities;

  constructor({ env = process.env, clock = systemClock, inspectInstallation = inspectCodexAppServerInstallation } = {}) {
    this.env = env;
    this.clock = clock;
    this.inspectInstallation = inspectInstallation;
    this.pending = new Map();
    this.serial = 0;
    this.reader = new LineReader();
    this.buffered = [];
    this.messages = new Map();
    this.descendants = new Set();
    this.steers = new Set();
    this.progress = { lastActivityAt: null, activeCommand: null, retry: null, partialText: '' };
    this.done = deferred();
    // Delivery/start can fail before the controller ever calls observe().
    this.done.promise.catch(() => {});
  }

  async start({ cwd, env = this.env, supervisor }) {
    this.cwd = cwd; this.env = env; this.supervisor = supervisor;
    this.sandbox = codexAppServerSandbox(env);
    try {
      if (this.closed) throw new Error('adapter closed');
      const installation = this.inspectInstallation({ env });
      if (!installation?.ready || !installation.selected?.path || !installation.selected?.helperPath) {
        throw new Error(installation?.blocker?.message || 'Codex executable/helper pair unavailable');
      }
      void checkCodexContract(installation, env);
      const runtime = this.runtime = await supervisor.spawn([installation.selected.path, 'app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      runtime.stdout.setEncoding('utf8');
      runtime.stdout.on('data', (chunk) => {
        for (const line of this.reader.push(chunk).lines) {
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          this._message(msg);
        }
      });
      runtime.stderr.resume();
      for (const stream of [runtime, runtime.stdin, runtime.stdout]) stream.on('error', (err) => this._lost(err));
      runtime.stdout.on('end', () => this._lost(new Error('app-server stdout ended')));
      runtime.on('close', (code, signal) => this._lost(new Error(`app-server exited: ${code ?? signal}`)));
      if (this.closed) { runtime.stdin.end(); throw new Error('adapter closed during spawn'); }
      if (runtime.exitCode !== null || runtime.signalCode !== null) throw new Error('app-server exited during spawn');
      await this._call('initialize', {
        clientInfo: { name: 'agent-companion', version: '1' },
        capabilities: { optOutNotificationMethods: connectionScopedNotificationMethods() },
      });
      this._write({ method: 'initialized', params: {} });
      return { runtime };
    } catch (err) { throw failure('RuntimeUnavailable', err); }
  }

  async openHistory({ historyId, model }) {
    try {
      const params = { cwd: this.cwd, sandbox: this.sandbox.mode, approvalPolicy: 'never' };
      if (model !== undefined) params.model = model;
      if (historyId != null) params.threadId = historyId;
      const result = await this._call(historyId == null ? 'thread/start' : 'thread/resume', params);
      const id = result?.thread?.id;
      if (typeof id !== 'string' || !id || (historyId != null && id !== historyId)) throw new Error('thread identity not confirmed');
      // A busy resume must not turn into a second turn/start (measured to be
      // accepted by Codex). The controller only cold-resumes closed executions.
      if (result.thread.status?.type === 'active' || result.thread.turns?.some((turn) => turn.status === 'inProgress')) throw new Error('thread already active');
      this.threadId = id; this.model = model;
      this._metadata(result);
      return { historyId: id, effectiveModel: this.effectiveModel, effectiveEffort: this.effectiveEffort };
    } catch (err) { throw failure('HistoryUnavailable', err); }
  }

  async deliver({ text }) {
    if (this.deliveryStarted) throw failure('DeliveryUnknown', new Error('delivery already attempted'));
    this.deliveryStarted = true;
    try {
      const params = { threadId: this.threadId, cwd: this.cwd, input: [{ type: 'text', text }],
        approvalPolicy: 'never', sandboxPolicy: this.sandbox.policy };
      if (this.model !== undefined) params.model = this.model;
      const result = await this._call('turn/start', params);
      const id = result?.turn?.id;
      if (typeof id !== 'string' || !id) throw new Error('turn/start response has no turn id');
      this.nativeTurnId = this.activeTurnId = id;
      this._metadata(result);
      for (const [msg, at] of this.buffered.splice(0)) this._notification(msg, at);
      return { nativeTurnId: id };
    } catch (err) {
      this.buffered.length = 0;
      throw failure('DeliveryUnknown', err);
    }
  }

  observe({ onProgress } = {}) {
    this.onProgress = onProgress;
    if (this.progress.lastActivityAt !== null) onProgress?.({ ...this.progress });
    return this.done.promise;
  }

  async interrupt() {
    if (!this.activeTurnId || this.terminal) return;
    try { await this._call('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId }); }
    catch (err) { if (!/no active turn to interrupt/i.test(err.message)) throw err; }
  }

  async steer({ text }) {
    const turnId = this.activeTurnId;
    if (!turnId || this.terminal) throw new Error('no active turn to steer');
    const seen = { ...deferred(), text, turnId };
    this.steers.add(seen);
    try {
      const result = await this._call('turn/steer', { threadId: this.threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] });
      if (result?.turnId !== turnId) throw failure('DeliveryUnknown', new Error('steer turn identity not confirmed'));
      // Acceptance is distinct from observing injection at a model boundary;
      // docs/RELIABILITY_REMEDIATION.md W3.3 measured 0.14–130 seconds.
      let confirmed;
      try { confirmed = await bounded(this.clock, () => seen.promise, resolveSteerConfirmMs(this.env), 'SteerUnconfirmed'); }
      catch (err) { if (err.code !== 'SteerUnconfirmed') throw err; confirmed = false; }
      return { accepted: true, confirmed, threadId: this.threadId, turnId, nativeTurnId: turnId };
    } finally { this.steers.delete(seen); }
  }

  close() {
    this.closed = true;
    if (!this.runtime) { this._lost(new Error('adapter closed')); return Promise.resolve(); }
    if (this.closing) return this.closing;
    // Drain stdout after EOF: interrupt's acknowledgement can precede its
    // terminal notification. The controller bounds close and owns escalation.
    this.closing = new Promise((resolve) => {
      if (this.runtime.stdout.readableEnded || this.runtime.stdout.destroyed) resolve();
      else { this.runtime.stdout.once('end', resolve); this.runtime.once('close', resolve); }
    });
    const stdin = this.runtime?.stdin;
    if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.end();
    return this.closing;
  }

  _write(msg) {
    if (this.lost || this.closed) throw this.lost || failure('ProviderLost');
    this.runtime.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n', (err) => { if (err) this._lost(err); });
  }

  _call(method, params) {
    if (this.lost || this.closed) return Promise.reject(this.lost || failure('ProviderLost'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id);
        reject(failure('ProtocolTimeout', new Error(method)));
      }, PROTOCOL_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this._write({ id, method, params }); }
      catch (err) { this.clock.clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }

  _lost(cause) {
    if (this.lost) return;
    this.lost = failure('ProviderLost', cause);
    for (const pending of this.pending.values()) { this.clock.clearTimeout(pending.timer); pending.reject(this.lost); }
    this.pending.clear();
    for (const steer of this.steers) steer.resolve(false);
    if (!this.terminal) this.done.reject(this.lost);
  }

  _message(msg) {
    if (!msg) return;
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return; // Late acknowledgements never re-open delivery.
      this.pending.delete(msg.id); this.clock.clearTimeout(pending.timer);
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else pending.resolve(msg.result);
      return;
    }
    // With approvalPolicy never, approvals cannot be accepted here. Explicitly
    // refuse any unexpected server request so it cannot hang waiting on us.
    if (msg.id !== undefined && msg.method) {
      if (!this.closed && !this.lost) this._write({ id: msg.id, error: { code: -32601, message: 'client requests unsupported' } });
      return;
    }
    if (!this.deliveryStarted || this.terminal || this.lost) return;
    const p = msg.params || {};
    // The pinned server calls this notification `error`; accept turn/failed
    // too for the controller contract, without treating other drift as global.
    const threadId = msg.method === 'turn/failed' ? p.threadId : routeNotification(msg.method, p).threadId;
    if (threadId !== this.threadId) return;
    const at = this.clock.now();
    if (!this.nativeTurnId) {
      if (msg.method === 'turn/started') this.activeTurnId = p.turn?.id;
      this.buffered.push([msg, at]);
    } else this._notification(msg, at);
  }

  _metadata(meta) {
    for (const value of [meta?.thread, meta?.turn, meta?.threadSettings, meta]) {
      if (typeof value?.model === 'string') this.effectiveModel = value.model;
      const effort = value?.reasoningEffort ?? value?.effort;
      if (typeof effort === 'string') this.effectiveEffort = effort;
    }
  }

  _recordPid(value) {
    const pid = Number(value);
    if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && !this.descendants.has(pid)) {
      this.descendants.add(pid);
      void Promise.resolve().then(() => this.supervisor.recordDescendant(pid)).catch((err) => this._lost(err));
    }
  }

  _item(item, completed) {
    if (!item) return;
    this._recordPid(item.processId);
    if (item.type === 'agentMessage' && completed) this.messages.set(item.id, { text: item.text, phase: item.phase });
    if (item.type === 'commandExecution') {
      if (completed && this.commandId === item.id) { this.commandId = null; this.progress.activeCommand = null; }
      if (!completed) { this.commandId = item.id; this.progress.activeCommand = item.command; }
    }
  }

  _notification({ method, params: p }, at) {
    if (this.terminal || this.lost) return;
    const turnId = p.turnId ?? p.turn?.id;
    if (turnId && turnId !== this.nativeTurnId) return;
    this._recordPid(p.processId);
    this._metadata(p);
    if (method === 'model/rerouted') this.effectiveModel = p.toModel;
    this.progress.lastActivityAt = at;
    if (method !== 'error' && method !== 'turn/failed') this.progress.retry = null;
    if (method === 'item/agentMessage/delta') {
      const item = this.messages.get(p.itemId) || { text: '' };
      this.messages.set(p.itemId, { ...item, text: item.text + p.delta });
    }
    if (method === 'item/started' || method === 'item/completed') this._item(p.item, method === 'item/completed');
    if (method === 'item/completed' && p.item?.type === 'userMessage') {
      const text = p.item.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
      for (const steer of this.steers) if (text && text === steer.text && turnId === steer.turnId) steer.resolve(true);
    }
    if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.total) {
      this.usageBaseline ??= codexTurnBaseline(p.tokenUsage) ?? {};
      this.usage = usageFromCodexTokenUsage(p.tokenUsage, this.usageBaseline);
    }
    let outcome, error;
    if (method === 'turn/completed') {
      for (const item of p.turn.items || []) this._item(item, true);
      outcome = ['completed', 'interrupted'].includes(p.turn.status) ? p.turn.status : 'failed';
      error = p.turn.error?.message;
    }
    if (method === 'error' || method === 'turn/failed') {
      if (p.willRetry === true) this.progress.retry = { willRetry: true, ...p.error };
      else { outcome = 'failed'; error = p.error?.message; }
    }
    const messages = [...this.messages.values()];
    const finals = messages.filter((m) => m.phase === 'final_answer');
    this.progress.partialText = (finals.length ? finals : messages).at(-1)?.text || '';
    if (outcome) { this.progress.activeCommand = null; this.progress.retry = null; }
    this.onProgress?.({ ...this.progress, effectiveModel: this.effectiveModel, effectiveEffort: this.effectiveEffort });
    if (outcome) {
      this.terminal = { outcome, text: this.progress.partialText, usage: this.usage,
        nativeRefs: { threadId: this.threadId, turnId: this.nativeTurnId },
        effectiveModel: this.effectiveModel, effectiveEffort: this.effectiveEffort, error };
      this.activeTurnId = null;
      for (const steer of this.steers) steer.resolve(false);
      this.done.resolve(this.terminal);
    }
  }
}

export function codexProvider({ env = process.env } = {}) {
  return {
    enabled: getTargetById('codex', env)?.implemented === true,
    // Registry-driven diagnostics already own readiness. Reading their cached
    // evidence is observational; installation selection happens only at start.
    get ready() { return companionReady('codex', env); },
    modelAllowed: (model) => isModelAllowedFor('codex', model),
    create: () => new CodexAdapter({ env }),
  };
}
