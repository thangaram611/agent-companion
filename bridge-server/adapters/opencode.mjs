import { Agent, request } from 'node:http';
import { createTurnAccumulator, parseOpenCodeModel } from '../opencode-server-runtime.mjs';
import { openCodeCliMajor } from '../../lib/opencode-cli.mjs';
import { getTargetById } from '../../lib/target-registry.mjs';
import { lastTargetChecks } from '../../lib/target-diagnostics.mjs';
import { isModelAllowedFor } from '../../lib/state.mjs';
import { usageFromOpenCodeInfo, sumUsage } from '../../lib/usage.mjs';

const capabilities = Object.freeze({ followUp: true, steer: false, modelSelection: true, loadsHistory: true });
const failure = (code, cause) => Object.assign(new Error(code, { cause }), { name: code, code });
const outcomes = { succeeded: 'completed', interrupted: 'interrupted', failed: 'failed' };

// Registry diagnostics own readiness. Reading their last evidence never runs
// an auth/version probe or starts a provider. start checks the private runtime.
export function opencodeProvider({ env = process.env } = {}) {
  const target = getTargetById('opencode', env);
  return {
    enabled: target.implemented,
    get ready() { return lastTargetChecks().opencode?.ready === true; },
    modelAllowed: model => isModelAllowedFor('opencode', model),
    create: () => new OpenCodeAdapter(env, target),
  };
}

class OpenCodeAdapter {
  capabilities = capabilities;
  #authorization;
  constructor(env, target) {
    this.env = env;
    this.target = target;
    this.channel = new AbortController();
    this.http = new Agent({ keepAlive: true });
    this.interrupted = new Promise(resolve => { this.resolveInterrupt = resolve; });
  }

  async start({ cwd, env = this.env, model, supervisor }) {
    this.cwd = cwd;
    this.env = { ...this.env, ...env };
    this.model = model;
    this.supervisor = supervisor;
    this.clock = supervisor.clock;
    try {
      if (this.channel.signal.aborted) throw failure('ProviderLost');
      const bin = String(this.env[this.target.binaryEnv] || this.target.binaryNames[0]).trim();
      this.child = await supervisor.spawn([bin, 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
        cwd, env: { ...this.env, PWD: cwd }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child.once('exit', () => this.channel.abort(failure('ProviderLost')));
      this.child.once('error', () => this.channel.abort(failure('ProviderLost')));
      await this._bootstrap();
      const info = (await this._request('/info')).data;
      if (openCodeCliMajor(info?.version) !== 2 || info.pid !== this.child.pid) throw failure('OpenCode2Required');
      return { runtime: this.child };
    } catch (cause) { throw failure('runtime_unavailable', cause); }
  }

  _bootstrap() {
    return new Promise((resolve, reject) => {
      let output = '';
      const { signal } = this.channel;
      const done = (error) => {
        this.clock.clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        for (const stream of [this.child.stdout, this.child.stderr]) { stream.off('data', read); stream.resume(); }
        output = ''; // bootstrap credentials never enter durable records/logs
        error ? reject(error) : resolve();
      };
      const abort = () => done(failure('ProviderLost'));
      const read = chunk => {
        output += chunk.toString('utf8');
        if (output.length > 64 * 1024) return done(failure('InvalidBootstrap'));
        // Wait for complete lines: a password can span multiple pipe chunks.
        const url = output.match(/(?:^|\n)server listening on (http:\/\/127\.0\.0\.1:\d+)\r?\n/);
        const password = output.match(/(?:^|\n)server password ([^\r\n]+)\r?\n/);
        if (/opencode server listening on/.test(output)) return done(failure('OpenCode2Required'));
        if (url && password) {
          this.baseUrl = url[1];
          this.#authorization = 'Basic ' + Buffer.from('opencode:' + password[1]).toString('base64');
          done();
        }
      };
      const timer = this.clock.setTimeout(() => done(failure('BootstrapTimeout')), 10_000);
      for (const stream of [this.child.stdout, this.child.stderr]) stream.on('data', read);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted || this.child.exitCode !== null || this.child.signalCode !== null) abort();
    });
  }

  async _request(path, { method = 'GET', body, stream = false } = {}) {
    let req, timer;
    try {
      const response = await new Promise((resolve, reject) => {
        req = request(this.baseUrl + '/api' + path, {
          method, agent: this.http, signal: this.channel.signal,
          headers: { authorization: this.#authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(stream ? { accept: 'text/event-stream' } : {}) },
        }, resolve);
        req.on('error', reject);
        timer = this.clock.setTimeout(() => req.destroy(failure('RequestTimeout')), 10_000);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
      // A subscribed response may fail before observe starts consuming it.
      response.on('error', () => {});
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume(); throw failure(`HTTP_${response.statusCode}`);
      }
      if (stream) return response;
      let text = '';
      for await (const chunk of response) text += chunk;
      return { status: response.statusCode, data: text ? JSON.parse(text) : null };
    } finally { this.clock.clearTimeout(timer); }
  }

  get sessionPath() { return '/session/' + encodeURIComponent(this.sessionId); }
  get locationQuery() { return '?location[directory]=' + encodeURIComponent(this.cwd); }

  async openHistory({ historyId, model = this.model }) {
    try {
      const response = historyId == null
        ? await this._request('/session', { method: 'POST', body: { location: { directory: this.cwd } } })
        : await this._request('/session/' + encodeURIComponent(historyId));
      let session = response.data?.data;
      if (!session?.id || (historyId != null && session.id !== historyId)) throw failure('InvalidSession');
      this.sessionId = session.id;
      const choice = model === undefined ? String(this.env.AGENT_COMPANION_OPENCODE_MODEL || '').trim() || undefined : model;
      this.effectiveModel = { source: choice === undefined ? 'inherited' : 'selected' };
      if (choice !== undefined) {
        const parsed = parseOpenCodeModel(choice);
        if (!parsed) throw failure('ModelNotAllowed');
        const [id, variant] = parsed.modelID.split('#');
        this.selection = { providerID: parsed.providerID, id, ...(variant ? { variant } : {}) };
        const ack = await this._request(this.sessionPath + '/model', { method: 'POST', body: { model: this.selection } });
        if (ack.status !== 204) throw failure('ModelSelectionUnacknowledged');
        session = (await this._request(this.sessionPath)).data?.data;
        this._model(session?.model);
      } else {
        const resolved = session.model || (await this._request('/model/default' + this.locationQuery)).data?.data;
        this._model(resolved);
      }
      return { historyId: this.sessionId, effectiveModel: this.effectiveModel };
    } catch (cause) { throw failure('HistoryUnavailable', cause); }
  }

  _model(model) {
    if (!model?.providerID || !model?.id) throw failure('ModelSelectionUnverified');
    // The controller retains this object from openHistory. Update it with the
    // actual assistant metadata before its next progress/terminal snapshot.
    Object.assign(this.effectiveModel, { providerID: model.providerID, id: model.id, variant: model.variant ?? null });
    if (this.selection && (model.providerID !== this.selection.providerID || model.id !== this.selection.id ||
        (this.selection.variant !== undefined && model.variant !== this.selection.variant))) throw failure('ModelSelectionMismatch');
  }

  async deliver({ text }) {
    try {
      if (this.delivered) throw failure('AlreadyDelivered');
      this.delivered = true;
      this.acc = createTurnAccumulator(this.sessionId);
      // Subscribe first; fast terminal events can precede the admission reply.
      this.stream = await this._request('/event', { stream: true });
      const ack = (await this._request(this.sessionPath + '/prompt', { method: 'POST', body: { text } })).data?.data;
      if (!ack?.id || (ack.sessionID && ack.sessionID !== this.sessionId)) throw failure('MissingAdmission');
      this.nativeTurnId = ack.id;
      return { nativeTurnId: ack.id };
    } catch (cause) { throw failure('DeliveryUnknown', cause); }
  }

  observe({ onProgress }) {
    this.observation ??= Promise.race([this._observe(onProgress), this.interrupted]);
    return this.observation;
  }

  async _observe(onProgress) {
    let pending = '';
    const progress = { activeCommand: null, retry: null };
    try {
      this.stream.setEncoding('utf8');
      for await (const chunk of this.stream) {
        pending += chunk;
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(pending))) {
          const frame = pending.slice(0, separator.index);
          pending = pending.slice(separator.index + separator[0].length);
          const json = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
          if (!json) continue;
          const event = JSON.parse(json);
          const data = event.data;
          if (data?.sessionID !== this.sessionId) continue;
          this.acc.push(`data: ${JSON.stringify(event)}\n\n`);
          if (event.type === 'session.step.started') { this._model(data.model); this.messageId = data.assistantMessageID; progress.retry = null; }
          if (event.type === 'session.retry.scheduled') progress.retry = { attempt: data.attempt, at: data.at, error: data.error };
          if (event.type.startsWith('session.tool.') || event.type === 'session.shell.started') {
            progress.activeCommand = data.input?.command || data.command || progress.activeCommand;
            const shellID = data.shellID || data.metadata?.shellID;
            const shell = shellID ? (await this._request('/shell/' + encodeURIComponent(shellID) + this.locationQuery)).data?.data : data;
            if (shell?.command) progress.activeCommand = shell.command;
            if (Number.isInteger(shell?.pid) && shell.pid > 1) await this.supervisor.recordDescendant(shell.pid);
          }
          if (['session.tool.success', 'session.tool.failed', 'session.shell.ended'].includes(event.type)) progress.activeCommand = null;
          onProgress?.({ ...progress, lastActivityAt: this.clock.now(), partialText: this.acc.snapshot().message });
          if (this.acc.terminal || event.type === 'session.idle') return await this._terminal();
        }
      }
      throw failure('ProviderLost');
    } catch (cause) {
      if (cause.code?.startsWith('ModelSelection')) throw cause;
      throw failure('ProviderLost', cause);
    }
  }

  async _terminal() {
    // Same projection/paging as the legacy transcript reader, but anchored to
    // THIS admission id. Neither session.outcome nor an older idle is evidence.
    const messages = [];
    const cursors = new Set();
    let query = '?order=desc&limit=100', found = false;
    while (query) {
      const page = (await this._request(this.sessionPath + '/message' + query)).data;
      if (!Array.isArray(page?.data)) throw failure('ProviderLost');
      for (const message of page.data) {
        if (message.type === 'user') {
          if (message.id !== this.nativeTurnId) throw failure('ProviderLost');
          found = true; break;
        }
        messages.push(message);
      }
      if (found) break;
      const cursor = page.cursor?.next;
      if (cursor && cursors.has(cursor)) throw failure('ProviderLost');
      if (cursor) cursors.add(cursor);
      query = cursor ? '?cursor=' + encodeURIComponent(cursor) : null;
    }
    if (!found) throw failure('ProviderLost');
    const idle = messages.find(m => m.type === 'idle');
    const outcome = outcomes[idle?.outcome];
    if (!outcome) throw failure('ProviderLost');
    const assistants = messages.filter(m => m.type === 'assistant');
    if (outcome === 'completed' && !assistants.length) throw failure('ModelSelectionUnverified');
    for (const assistant of assistants.toReversed()) this._model(assistant.model);
    return {
      outcome, text: (assistants[0]?.content || []).filter(p => p.type === 'text').map(p => p.text).join(''),
      usage: sumUsage(assistants.map(m => usageFromOpenCodeInfo({ ...m, modelID: m.model?.id }, 'opencode-server'))),
      nativeRefs: { sessionId: this.sessionId, messageId: assistants[0]?.id || this.messageId || this.nativeTurnId },
      cause: outcome === 'completed' ? 'native_complete' : 'provider_error',
    };
  }

  async interrupt() {
    if (!this.sessionId) return;
    if (this.channel.signal.aborted) throw failure('ProviderLost');
    const ack = (await this._request(this.sessionPath + '/interrupt', { method: 'POST' })).data;
    if (typeof ack?.interrupted !== 'boolean') throw failure('InterruptUnacknowledged');
    if (ack.interrupted) {
      // Native acknowledgement is also an abort outcome. Publish it before
      // close can tear down a pending SSE/transcript read during owner stop.
      const snapshot = this.acc?.snapshot();
      this.resolveInterrupt({ outcome: 'interrupted', text: snapshot?.message || '', usage: snapshot?.usage,
        nativeRefs: { sessionId: this.sessionId, messageId: this.messageId || this.nativeTurnId }, cause: 'provider_error' });
    }
  }

  async close() {
    this.channel.abort();
    this.http.destroy();
    this.#authorization = undefined;
  }
}
