import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AcpConnection } from './acp-protocol.mjs';
import { getTargetById } from '../../lib/target-registry.mjs';
import { companionReady } from '../../lib/target-diagnostics.mjs';
import { isModelAllowedFor } from '../../lib/state.mjs';

const failure = (code, cause) => Object.assign(new Error(code, { cause }), { code });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const reportedModel = (result) => result?.configOptions?.find((option) => option.id === 'model')?.currentValue
  ?? result?.models?.currentModelId;
const thoughtLevel = (options) => options?.find(option => option.category === 'thought_level');
const readFile = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
const logWarning = (level, ...args) => { if (['WARN', 'ERROR', 'FATAL'].includes(level)) console.error('[acp]', ...args); };

function binaryFor(descriptor, env) {
  if (env[descriptor.binaryEnv]) return env[descriptor.binaryEnv];
  for (const name of descriptor.binaryNames) {
    const candidates = isAbsolute(name) ? [name] : (env.PATH || '').split(delimiter).map((dir) => resolve(dir, name));
    for (const candidate of candidates) {
      try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  throw failure('runtime_unavailable');
}

// Reuse ACP framing, v1 initialization, session new/load, update parsing and
// permission answers. The controller owns deadlines and process lifetime:
// the inherited lifecycle methods are historical and unused here.
class ProtocolConnection extends AcpConnection {
  constructor(descriptor, env, log, activity) {
    super({ ...descriptor, acp: { ...descriptor.acp, permission: () => descriptor.acp.permission(env) } });
    this.log = log;
    this.activity = activity;
  }
  _sendRequest(method, params) {
    if (!this.isAlive()) return Promise.reject(failure('ProviderLost'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { reject, resolve: (result) => {
        if (['session/new', 'session/load'].includes(method)) {
          this.configOptions = result?.configOptions;
          this.effectiveModel = reportedModel(result);
          this.effectiveEffort = thoughtLevel(this.configOptions)?.currentValue
            ?? this.descriptor.acp.reportedEffort?.({ model: this.effectiveModel, configOptions: this.configOptions });
        }
        resolve(result);
      } });
      const fail = (err) => { if (err) { this.pendingRequests.delete(id); reject(err); } };
      try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', fail); }
      catch (err) { fail(err); }
    });
  }
  _onNotification(msg) {
    super._onNotification(msg);
    if (msg.method === 'session/update') this.activity(msg.params);
  }
  _onAgentRequest(msg) {
    super._onAgentRequest(msg);
    if (msg.method === 'session/request_permission') this.activity(msg.params);
  }
  async _applySessionModel(sessionId) {
    const thought = this._validateThoughtLevel();
    const model = !thought && this.effort !== undefined && this.descriptor.acp.selectEffort
      ? this.descriptor.acp.selectEffort({ model: this.model ?? this.effectiveModel, effort: this.effort, configOptions: this.configOptions })
      : this.model;
    // Validate against the session's advertised options before any selection write.
    if (model && this.descriptor.acp.setModel) try {
      const [method, params] = this.descriptor.acp.setModel({ sessionId, model });
      const result = await this._sendRequest(method, params);
      if (reportedModel(result) !== model) throw failure('ModelSelectionMismatch');
      this.effectiveModel = reportedModel(result);
      this.configOptions = result.configOptions ?? this.configOptions;
      this.effectiveEffort = thoughtLevel(this.configOptions)?.currentValue
        ?? this.descriptor.acp.reportedEffort?.({ model: this.effectiveModel, configOptions: this.configOptions });
    } catch (err) {
      if (this.effort !== undefined && err.code === 'ModelSelectionMismatch') throw Object.assign(new Error(`Companion did not apply effort "${this.effort}" with model "${model}": ${err.message}`), { code: 'CAPABILITY_UNAVAILABLE' });
      if (err.code === 'ModelSelectionMismatch' || typeof err.code === 'number') throw failure('MODEL_NOT_ALLOWED', err);
      throw err; // Transport errors become HistoryUnavailable in openHistory.
    }
    const option = this._validateThoughtLevel();
    if (option && this.effort !== undefined) {
      const result = await this._sendRequest('session/set_config_option', { sessionId, configId: option.id, value: this.effort });
      const confirmed = result?.configOptions?.find(entry => entry.id === option.id)?.currentValue;
      if (confirmed !== this.effort) throw Object.assign(new Error(`Companion did not confirm effort "${this.effort}" (reported ${JSON.stringify(confirmed) ?? 'nothing'}). Omit effort to inherit configuration.`), { code: 'CAPABILITY_UNAVAILABLE' });
      this.configOptions = result.configOptions;
      this.effectiveEffort = confirmed;
    }
  }
  _validateThoughtLevel() {
    const option = thoughtLevel(this.configOptions);
    if (this.effort !== undefined) {
      if (option) {
        const levels = (option.options || []).flatMap(entry => entry.options || [entry]).map(entry => entry.value);
        if (!levels.includes(this.effort)) throw Object.assign(new Error(`effort "${this.effort}" is not valid for this session's model. Use one of: ${levels.join(', ')}, or omit it to inherit configuration.`), { code: 'EFFORT_NOT_ALLOWED' });
      } else if (!this.descriptor.acp.selectEffort) {
        throw Object.assign(new Error('Companion advertises no thought_level option. Omit effort to inherit configuration.'), { code: 'CAPABILITY_UNAVAILABLE' });
      }
    }
    return option;
  }
  // initialize() calls kill() on version mismatch. Fail protocol requests;
  // only ProcessSupervisor may signal the owned process.
  kill() {
    this.dead = true;
    this._failAll('ACP transport closed');
  }
}

export class AcpAdapter {
  constructor(descriptor, { env = process.env, log = logWarning } = {}) {
    if (!descriptor?.acp) throw new Error('AcpAdapter needs an ACP descriptor');
    this.descriptor = descriptor;
    this.env = env;
    this.log = log;
    const loadsHistory = descriptor.acp.loadSession === true;
    this.capabilities = { followUp: loadsHistory, steer: false, modelSelection: descriptor.capabilities.modelSelection === true, loadsHistory };
  }
  async start({ cwd, env = this.env, model, effort, supervisor }) {
    this.cwd = cwd;
    const acp = this.descriptor.acp;
    this.connection = new ProtocolConnection(this.descriptor, env, this.log, (params) => this._activity(params));
    const conn = this.connection;
    conn.model = model ?? acp.defaultModel(env);
    conn.effort = effort;
    this.paths = {};
    try {
      // Copilot's legacy usage fallback gets an execution-private exporter;
      // no shared provider files, rotation, leases or durable adapter state.
      if (acp.rotate?.includes('otelTraces')) {
        this.telemetryDir = mkdtempSync(join(tmpdir(), 'acp-usage-'));
        this.paths.otelTraces = join(this.telemetryDir, 'traces.jsonl');
      }
      const child = conn.child = await supervisor.spawn([binaryFor(this.descriptor, env), ...acp.args({ model: conn.model, effort, env })], {
        cwd, env: { ...env, ...acp.env({ env, paths: this.paths }) }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lost = () => conn.kill();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => conn._onStdoutData(chunk));
      child.stdout.on('end', lost);
      child.stdout.on('error', lost);
      child.stdin.on('error', lost);
      child.stderr.resume();
      child.on('error', lost);
      child.on('close', lost);
      if (this.closed || child.exitCode !== null || child.signalCode !== null) {
        child.stdin.end();
        throw failure('runtime_unavailable');
      }
      await conn.initialize();
      return { runtime: child };
    } catch (err) {
      throw failure(err.code === 'ACP_PROTOCOL_MISMATCH' ? err.code : 'runtime_unavailable', err);
    }
  }
  async openHistory({ historyId, model, effort }) {
    const conn = this.connection;
    if (model !== undefined) conn.model = model;
    conn.effort = effort;
    try {
      if (historyId != null) {
        if (!this.capabilities.loadsHistory || !conn.agentCapabilities?.loadSession) throw failure('HistoryUnavailable');
        await conn.loadSession(historyId, this.cwd);
        this.sessionId = historyId;
      } else {
        this.sessionId = await conn.createSession(this.cwd);
        if (!this.sessionId) throw failure('HistoryUnavailable');
      }
      return { historyId: this.sessionId, effectiveModel: conn.effectiveModel, effectiveEffort: conn.effectiveEffort };
    } catch (err) {
      throw ['MODEL_NOT_ALLOWED', 'EFFORT_NOT_ALLOWED', 'CAPABILITY_UNAVAILABLE'].includes(err.code) ? err : failure('HistoryUnavailable', err);
    }
  }
  deliver({ text }) {
    // One execution, one prompt. Even a failed/ambiguous send is never retried.
    if (this.turn) return Promise.reject(failure('DeliveryUnknown'));
    const conn = this.connection;
    const accepted = deferred();
    const events = { messageChunks: [], thoughtChunks: [], toolCalls: [], plans: [] };
    const turn = this.turn = { accepted, events, sinceMs: Date.now(), finished: false };
    conn.sessionCollectors.set(this.sessionId, { events, reject: () => {} });
    const response = conn._sendRequest('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] });
    turn.promptId = conn.requestId;
    turn.terminal = response.then((result) => {
      accepted.resolve({ nativeTurnId: turn.promptId });
      const outcome = result?.stopReason === 'end_turn' ? 'completed' : result?.stopReason === 'cancelled' ? 'interrupted' : 'failed';
      return { outcome, text: events.messageChunks.join(''),
        usage: this.descriptor.acp.usage({ result, sessionId: this.sessionId, sinceMs: turn.sinceMs, paths: this.paths, readFile }),
        nativeRefs: { sessionId: this.sessionId, promptId: turn.promptId },
        cause: outcome === 'completed' ? 'native_complete' : 'provider_error' };
    }, (err) => {
      accepted.reject(failure('DeliveryUnknown', err));
      if (conn.dead || !conn.isAlive()) throw failure('ProviderLost', err);
      return { outcome: 'failed', text: events.messageChunks.join(''), cause: 'provider_error', detail: err.message, error: err.message,
        nativeRefs: { sessionId: this.sessionId, promptId: turn.promptId } };
    }).finally(() => { turn.finished = true; conn.sessionCollectors.delete(this.sessionId); });
    // Observation attaches after acceptance; transport loss can race that gap.
    turn.terminal.catch(() => {});
    return accepted.promise;
  }
  _activity(params) {
    const turn = this.turn;
    if (!turn || turn.finished || params?.sessionId !== this.sessionId) return;
    // ACP's prompt response is terminal. A native update/permission request
    // for this live session is its earlier evidence of prompt acceptance.
    turn.accepted.resolve({ nativeTurnId: turn.promptId });
    const active = turn.events.toolCalls.findLast((tool) => !['completed', 'failed', 'cancelled'].includes(tool.status));
    this.progress = { lastActivityAt: Date.now(), activeCommand: active ? active.input?.command || active.name : null,
      retry: params.update?.retry ?? null, partialText: turn.events.messageChunks.join('') };
    this.onProgress?.(this.progress);
  }
  observe({ onProgress }) {
    this.onProgress = onProgress;
    if (this.progress) onProgress(this.progress);
    return this.turn.terminal;
  }
  async interrupt() {
    if (!this.turn || this.turn.finished) return;
    if (!this.connection.cancelSession(this.sessionId)) throw failure('ProviderLost');
    // session/cancel is a notification: the prompt's terminal response is
    // the acknowledgement, including a completion racing the cancellation.
    await this.turn.terminal;
  }
  async close() {
    this.closed = true;
    this.connection?.kill();
    this.connection?.child?.stdin.end();
    if (this.telemetryDir) rmSync(this.telemetryDir, { recursive: true, force: true });
  }
}

export function acpProvider(companion, { env = process.env } = {}) {
  const descriptor = getTargetById(companion, env);
  if (!descriptor?.acp) throw new Error(`Not an ACP companion: ${companion}`);
  return {
    enabled: descriptor.implemented === true,
    // As with the catalog, readiness reads existing diagnostic evidence.
    // Probing/version commands or runtime startup belong to explicit actions.
    get ready() { return companionReady(descriptor.id, env); },
    modelAllowed: (model) => isModelAllowedFor(descriptor.id, model),
    create: () => new AcpAdapter(descriptor, { env }),
  };
}
