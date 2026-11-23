import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AcpConnection } from './acp-protocol.mjs';
import { systemClock } from '../controller/clock.mjs';
import { sumUsage } from '../../lib/usage.mjs';
import { getCompanionById } from '../../lib/companion-registry.mjs';
import { companionReady } from '../../lib/companion-diagnostics.mjs';
import { isModelAllowedFor } from '../../lib/state.mjs';

const failure = (code, cause) => Object.assign(new Error(code, { cause }), { code });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const modelOption = (options) => options?.find(option => option.id === 'model');
const optionValues = (option) => (option?.options ?? []).flatMap(entry => entry.options ?? [entry]).map(entry => entry.value);
const reportedModel = (result) => modelOption(result?.configOptions)?.currentValue
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

// The prompt has ended with open work. Poll native-only state even on a silent
// wire. Silence alone never ends the turn: the agent may be retrying upstream
// before its reply. The turn ends on evidence that the reply is over.
function waitForFollowOn(clock, hasOpenWork) {
  const done = deferred();
  let emptySince, lastUpdate, lastKind, receivedUsage = false;
  let timer = clock.setTimeout(check, 2000);
  function check(params) {
    const now = clock.monotonic();
    let wait = 2000;
    const kind = params?.update?.sessionUpdate;
    if (params) { lastUpdate = now; lastKind = kind; }
    if (hasOpenWork()) {
      emptySince = null;
      receivedUsage = false;
    } else {
      emptySince ??= now;
      // A model call that starts any tool is called again with its result,
      // so only usage with no tool after it ends the reply.
      if (kind === 'usage_update') receivedUsage = true;
      else if (kind === 'tool_call') receivedUsage = false;
      // A reply that failed upstream ends as text with no usage update.
      const quiet = receivedUsage ? 3000 : lastKind === 'agent_message_chunk' && lastUpdate >= emptySince ? 120_000 : null;
      if (quiet !== null) wait = Math.min(wait, lastUpdate + quiet - now);
      if (wait <= 0) { done.resolve('completed'); return; }
    }
    clock.clearTimeout(timer);
    timer = clock.setTimeout(check, wait);
  }
  return { ...done, check, promise: done.promise.finally(() => clock.clearTimeout(timer)) };
}

// The adapter handles ACP messages. The controller owns deadlines and process lifetime.
class ProtocolConnection extends AcpConnection {
  constructor(descriptor, env, log, activity) {
    super({ ...descriptor, acp: { ...descriptor.acp, permission: () => descriptor.acp.permission(env) } });
    this.log = log;
    this.activity = activity;
  }
  _sendRequest(method, params) {
    if (!this.isAlive()) return Promise.reject(failure('ProviderLost'));
    const id = ++this.requestId;
    if (method === 'session/load' && this.descriptor.acp.loadRequiresReplay) this.awaitingReplayFor = params.sessionId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { receiptOnly: method === this.descriptor.acp.receiptMethod, reject, resolve: (result) => {
        // Check at the response frame. A later update in the same stdout chunk is not replay.
        if (method === 'session/load' && this.awaitingReplayFor === params.sessionId) {
          return reject(new Error('The companion replayed no history for the requested session.'));
        }
        if (['session/new', 'session/load'].includes(method)) {
          this.configOptions = result?.configOptions;
          this.effectiveModel = reportedModel(result);
          this.effectiveEffort = thoughtLevel(this.configOptions)?.currentValue;
        }
        // Later frames from this same read can already finish or start a tool.
        if (method === 'session/prompt') this.sessionCollectors.get(params.sessionId)?.onPromptResponse(id, result);
        resolve(result);
      } });
      const fail = (err) => { if (err) { this.pendingRequests.delete(id); reject(err); } };
      try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', fail); }
      catch (err) { fail(err); }
    });
  }
  _onNotification(msg) {
    super._onNotification(msg);
    if (msg.method === 'session/update') {
      if (msg.params?.sessionId === this.awaitingReplayFor) this.awaitingReplayFor = null;
      this.activity(msg.params);
    }
  }
  _onAgentRequest(msg) {
    super._onAgentRequest(msg);
    if (msg.method === 'session/request_permission') this.activity(msg.params);
  }
  async _applySessionModel(sessionId) {
    const model = this.model;
    let returnedOption;
    if (model && this.descriptor.acp.setModel) try {
      const [method, params] = this.descriptor.acp.setModel({ sessionId, model });
      const result = await this._sendRequest(method, params);
      returnedOption = modelOption(result?.configOptions);
      if (returnedOption?.currentValue !== model) throw failure('ModelSelectionMismatch');
      this.effectiveModel = model;
      this.configOptions = result.configOptions;
      this.effectiveEffort = thoughtLevel(this.configOptions)?.currentValue;
    } catch (err) {
      if (err.code === -32000) throw err; // Authentication is classified by openHistory.
      if (err.code === 'ModelSelectionMismatch' || typeof err.code === 'number') {
        const values = optionValues(returnedOption?.options?.length ? returnedOption : modelOption(this.configOptions));
        if (!values.length) throw failure('MODEL_NOT_ALLOWED', err);
        const reason = values.includes(model) ? 'was not applied by the session' : "is not one of this session's models";
        throw Object.assign(new Error(`model "${model}" ${reason}. Use one of: ${values.join(', ')}, or omit it to inherit configuration.`, { cause: err }), { code: 'MODEL_NOT_ALLOWED' });
      }
      throw err; // Transport errors become HistoryUnavailable in openHistory.
    }
    const option = this._validateThoughtLevel();
    if (option && this.effort !== undefined) {
      let result;
      try {
        result = await this._sendRequest('session/set_config_option', { sessionId, configId: option.id, value: this.effort });
      } catch (err) {
        if (err.code === -32602) throw failure('EFFORT_NOT_ALLOWED', err);
        throw err;
      }
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
        const levels = optionValues(option);
        if (!levels.includes(this.effort)) throw Object.assign(new Error(`effort "${this.effort}" is not valid for this session's model. Use one of: ${levels.join(', ')}, or omit it to inherit configuration.`), { code: 'EFFORT_NOT_ALLOWED' });
      } else {
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
  constructor(descriptor, { env = process.env, log = logWarning, clock = systemClock } = {}) {
    if (!descriptor?.acp) throw new Error('AcpAdapter needs an ACP descriptor');
    this.descriptor = descriptor;
    this.env = env;
    this.log = log;
    this.clock = clock;
    const loadsHistory = descriptor.acp.loadSession === true;
    this.capabilities = { followUp: loadsHistory, modelSelection: descriptor.capabilities.modelSelection === true, loadsHistory,
      interventions: descriptor.capabilities.interventions };
  }
  async start({ cwd, env = this.env, model, effort, supervisor }) {
    this.cwd = cwd;
    this.env = env;
    const acp = this.descriptor.acp;
    this.connection = new ProtocolConnection(this.descriptor, env, this.log, (params) => this._activity(params));
    const conn = this.connection;
    conn.model = model;
    conn.effort = effort;
    this.paths = {};
    try {
      // Copilot's legacy usage fallback gets a job-private exporter;
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
      if (err.code === -32000) {
        // The native message plus the descriptor's sign-in steps is the whole explanation.
        const native = (err.message || 'Authentication required').replace(/\.?\s*$/, '.');
        throw Object.assign(new Error([native, ...this.descriptor.auth.nextSteps].join(' ')), { code: 'AUTH_REQUIRED' });
      }
      throw ['MODEL_NOT_ALLOWED', 'EFFORT_NOT_ALLOWED', 'CAPABILITY_UNAVAILABLE'].includes(err.code) ? err : failure('HistoryUnavailable', err);
    }
  }
  deliver({ text }) {
    // Descriptors opt into another prompt after the previous response, on this
    // same live connection. The controller decides whether to continue.
    if (this.turn && (!this.turn.finished || !this.capabilities.interventions.queue)) return Promise.reject(failure('DeliveryUnknown'));
    const conn = this.connection;
    this.progress = null;
    const events = { messageChunks: [], thoughtChunks: [], toolCalls: [], plans: [] };
    const turn = this.turn = { done: deferred(), events, sinceMs: Date.now(), finished: false, pending: 0 };
    const acp = this.descriptor.acp;
    conn.sessionCollectors.set(this.sessionId, {
      events,
      reject: err => turn.followOn?.reject(failure('ProviderLost', err)),
      onPromptResponse: (id, result) => {
        if (id !== turn.promptId || result?.stopReason !== 'end_turn' || !acp.hasOpenWork) return;
        const hasOpenWork = () => acp.hasOpenWork({ toolCalls: events.toolCalls, sessionId: this.sessionId, env: this.env });
        if (hasOpenWork()) {
          turn.extended = true;
          turn.followOn = waitForFollowOn(this.clock, hasOpenWork);
          if (turn.cancelRequested) turn.followOn.resolve('interrupted');
        }
      },
    });
    turn.terminal = turn.done.promise.then(({ outcome, ...detail }) => {
      const { usage } = turn;
      if (usage && turn.extended) usage.partial = true;
      return { outcome, text: events.messageChunks.join(''), usage, ...detail,
        nativeRefs: { sessionId: this.sessionId, promptRequestId: turn.promptId },
        cause: outcome === 'completed' ? 'native_complete' : 'companion_error' };
    }).finally(() => { turn.finished = true; conn.sessionCollectors.delete(this.sessionId); });
    // Observation attaches after acceptance; transport loss can race that gap.
    turn.terminal.catch(() => {});
    return this._prompt(turn, text);
  }
  async steer({ text }) {
    const turn = this.turn;
    if (!this.capabilities.interventions.steer || !turn || turn.finished || turn.outcome) throw failure('DeliveryUnknown');
    turn.followOn?.resolve();
    turn.followOn = null;
    await this._prompt(turn, text);
    return { accepted: true, confirmed: true, nativeTurnId: null };
  }
  _prompt(turn, text) {
    const conn = this.connection, acp = this.descriptor.acp, sessionId = this.sessionId;
    const accepted = deferred();
    turn.pending++;
    const response = conn._sendRequest('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    const promptId = turn.promptId = conn.requestId;
    const acknowledge = turn.acknowledge = () => accepted.resolve({
      acknowledged: true, nativeTurnId: null, nativeRefs: { promptRequestId: promptId },
    });
    if (acp.receiptMethod) {
      conn._sendRequest(acp.receiptMethod, { sessionId })
        .then(acknowledge, err => accepted.reject(failure('DeliveryUnknown', err)));
    }
    response.then(async result => {
      acknowledge();
      const usage = acp.usage({ result, sessionId, sinceMs: turn.sinceMs, paths: this.paths, readFile });
      turn.usage = turn.usage ? sumUsage([turn.usage, usage]) : usage;
      if (turn.promptId !== promptId) return;
      const outcome = turn.followOn ? await turn.followOn.promise
        : result?.stopReason === 'end_turn' ? 'completed' : result?.stopReason === 'cancelled' ? 'interrupted' : 'failed';
      if (turn.promptId === promptId) turn.outcome = outcome;
    }, err => {
      accepted.reject(failure('DeliveryUnknown', err));
      if (conn.dead || !conn.isAlive()) throw failure('ProviderLost', err);
      if (turn.promptId === promptId) turn.done.resolve({ outcome: 'failed', detail: err.message, error: err.message });
    }).then(() => {
      // A superseded prompt can answer last. Drain its usage before publishing the newest outcome.
      if (--turn.pending === 0 && turn.outcome) turn.done.resolve({ outcome: turn.outcome });
    }, turn.done.reject);
    return accepted.promise;
  }
  _activity(params) {
    const turn = this.turn;
    if (!turn || turn.finished || params?.sessionId !== this.sessionId) return;
    turn.acknowledge();
    turn.followOn?.check(params);
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
    // A follow-on has no outstanding prompt to answer the cancel.
    this.turn.cancelRequested = true;
    this.turn.followOn?.resolve('interrupted');
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
  const descriptor = getCompanionById(companion, env);
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
