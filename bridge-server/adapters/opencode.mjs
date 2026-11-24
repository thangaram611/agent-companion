import { Agent, request } from 'node:http';
import { createTurnAccumulator, parseOpenCodeModel } from './opencode-protocol.mjs';
import { openCodeCliMajor } from '../../lib/opencode-cli.mjs';
import { getCompanionById } from '../../lib/companion-registry.mjs';
import { companionReady } from '../../lib/companion-diagnostics.mjs';
import { isModelAllowedFor } from '../../lib/state.mjs';
import { usageFromOpenCodeInfo, sumUsage } from '../../lib/usage.mjs';

const capabilities = Object.freeze({ followUp: true, modelSelection: true, loadsHistory: true,
  interventions: getCompanionById('opencode').capabilities.interventions });
const failure = (code, cause) => Object.assign(new Error(code, { cause }), { name: code, code });
const outcomes = { succeeded: 'completed', interrupted: 'interrupted', failed: 'failed' };

// The catalog accepts both a variant id and its reasoningEffort name.
export function openCodeEffortVariant(entry, name, effort, preferred) {
  const variants = entry?.variants || [];
  const matches = v => v.settings?.reasoningEffort === effort || v.id === effort;
  const variant = variants.find(v => v.id === preferred && matches(v)) || variants.find(matches);
  if (variant) return variant.id;
  const levels = [...new Set(variants.map(v => v.settings?.reasoningEffort ?? v.id))];
  throw Object.assign(new Error(levels.length
    ? `effort "${effort}" is not valid for OpenCode model "${name}". Use one of: ${levels.join(', ')}, or omit it to inherit configuration.`
    : `OpenCode advertises no effort levels for model "${name}". Omit effort to inherit configuration.`), { code: 'EFFORT_NOT_ALLOWED' });
}

// Registry diagnostics own readiness. Reading their last evidence never runs
// an auth/version probe or starts a provider. start checks the private runtime.
export function opencodeProvider({ env = process.env } = {}) {
  const companion = getCompanionById('opencode', env);
  return {
    enabled: companion.implemented,
    get ready() { return companionReady('opencode', env); },
    modelAllowed: model => isModelAllowedFor('opencode', model),
    create: () => new OpenCodeAdapter(env, companion),
  };
}

class OpenCodeAdapter {
  capabilities = capabilities;
  #authorization;
  constructor(env, companion) {
    this.env = env;
    this.companion = companion;
    this.channel = new AbortController();
    this.http = new Agent({ keepAlive: true });
  }

  async start({ cwd, env = this.env, model, supervisor }) {
    this.cwd = cwd;
    this.env = { ...this.env, ...env };
    this.model = model;
    this.supervisor = supervisor;
    this.clock = supervisor.clock;
    try {
      if (this.channel.signal.aborted) throw failure('ProviderLost');
      const bin = String(this.env[this.companion.binaryEnv] || this.companion.binaryNames[0]).trim();
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

  async defaultModel(query = '?directory=' + encodeURIComponent(this.cwd)) {
    return (await this._request('/model/default' + query)).data?.data;
  }

  async listModels() {
    return (await this._request('/model?directory=' + encodeURIComponent(this.cwd))).data?.data;
  }

  async openHistory({ historyId, model = this.model, effort }) {
    try {
      const response = historyId == null
        ? await this._request('/session', { method: 'POST', body: { location: { directory: this.cwd } } })
        : await this._request('/session/' + encodeURIComponent(historyId));
      let session = response.data?.data;
      if (!session?.id || (historyId != null && session.id !== historyId)) throw failure('InvalidSession');
      this.sessionId = session.id;
      this.effectiveModel = { source: model === undefined ? 'inherited' : 'selected' };
      let resolved;
      if (model !== undefined) {
        const parsed = parseOpenCodeModel(model);
        if (!parsed) throw failure('ModelNotAllowed');
        const [id, variant] = parsed.modelID.split('#');
        resolved = { providerID: parsed.providerID, id, ...(variant ? { variant } : {}) };
      } else resolved = session.model || await this.defaultModel(this.locationQuery);
      if (effort !== undefined) {
        this.models = await this.listModels();
        const name = `${resolved?.providerID}/${resolved?.id}`;
        const entry = this.models.find(m => m.providerID === resolved?.providerID && m.id === resolved?.id);
        resolved = { ...resolved, variant: openCodeEffortVariant(entry, name, effort, resolved?.variant) };
      }
      // Treat session model writes as persistent even without a prompt.
      // Validate first so a refused level cannot alter existing history.
      if (model !== undefined || effort !== undefined) {
        this.selection = resolved;
        const ack = await this._request(this.sessionPath + '/model', { method: 'POST', body: { model: this.selection } });
        if (ack.status !== 204) throw failure('ModelSelectionUnacknowledged');
        session = (await this._request(this.sessionPath)).data?.data;
        resolved = session?.model;
      }
      this._model(resolved);
      return { historyId: this.sessionId, effectiveModel: this.effectiveModel, effectiveEffort: this.effectiveEffort };
    } catch (cause) {
      if (cause.code === 'EFFORT_NOT_ALLOWED') throw cause;
      if (effort !== undefined && ['ModelSelectionUnacknowledged', 'ModelSelectionMismatch'].includes(cause.code)) {
        throw Object.assign(new Error(`OpenCode did not confirm effort "${effort}" (${cause.code ?? cause.message}). Omit effort to inherit configuration.`), { code: 'CAPABILITY_UNAVAILABLE' });
      }
      throw failure('HistoryUnavailable', cause);
    }
  }

  _model(model) {
    if (!model?.providerID || !model?.id) throw failure('ModelSelectionUnverified');
    // The controller retains this object from openHistory. Update it with the
    // actual assistant metadata before its next progress/terminal snapshot.
    Object.assign(this.effectiveModel, { providerID: model.providerID, id: model.id, variant: model.variant ?? null });
    this.effectiveEffort = this.models?.find(m => m.providerID === model.providerID && m.id === model.id)
      ?.variants?.find(v => v.id === model.variant)?.settings?.reasoningEffort ?? null;
    if (this.selection && (model.providerID !== this.selection.providerID || model.id !== this.selection.id ||
        (this.selection.variant !== undefined && model.variant !== this.selection.variant))) throw failure('ModelSelectionMismatch');
  }

  async deliver({ text }) {
    try {
      if (this.delivered && !this.terminal) throw failure('AlreadyDelivered');
      this.delivered = true;
      // An interrupted turn is published on its acknowledgement; let its own
      // events finish before the next turn replaces the accumulator and stream.
      await this.native?.catch(() => {});
      this.terminal = null; this.observation = null; this.native = null; this.steering = null;
      this.interrupted = new Promise(resolve => { this.resolveInterrupt = resolve; });
      this.nativeTurnId = null; this.messageId = null; this.steerIds = new Set();
      this.backgroundShells = new Map(); // shellID -> command, until its continuation starts
      this.shellResults = new Map(); // shellID -> inboxID, possibly enqueued before tool success
      this.drainBackground = false;
      this.progress = { lastActivityAt: null, activeCommand: null, retry: null, partialText: '' };
      this.acc = createTurnAccumulator(this.sessionId);
      // Subscribe first; fast terminal events can precede the admission reply.
      this.stream = await this._request('/event', { stream: true });
      const ack = (await this._request(this.sessionPath + '/prompt', { method: 'POST', body: { text } })).data?.data;
      if (!ack?.id || (ack.sessionID && ack.sessionID !== this.sessionId)) throw failure('MissingAdmission');
      this.nativeTurnId = ack.id;
      return { nativeTurnId: ack.id };
    } catch (cause) { throw failure('DeliveryUnknown', cause); }
  }

  observe({ onProgress, onInput } = {}) {
    if (onProgress) this.onProgress = onProgress;
    if (onInput) this.onInput = onInput;
    this.native ??= this._observe();
    this.observation ??= Promise.race([this.native, this.interrupted]).then(terminal => (this.terminal = terminal));
    return this.observation;
  }

  async steer({ text, id }) {
    if (!this.nativeTurnId || this.acc.terminal || this.terminal) throw failure('DeliveryUnknown');
    this.steering = this._request(this.sessionPath + '/prompt', { method: 'POST', body: { text } }).then(response => {
      const ack = response.data?.data;
      if (!ack?.id || ack.sessionID !== this.sessionId || ack.delivery !== 'steer') throw failure('DeliveryUnknown');
      this.steerIds.add(ack.id);
      // 2.3.0 stores the admission id as a separate user row when consumed.
      // The transcript reader uses that row's id for all following items.
      this.onInput?.({ id, state: 'joined', nativeTurnId: ack.id });
      return { accepted: true, confirmed: true, nativeTurnId: ack.id };
    });
    return this.steering;
  }

  async _observe() {
    let pending = '', execution = 0;
    let shellsAtStart = new Set(), interruptSent = false;
    const progress = this.progress;
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
          if (event.type === 'session.inbox.enqueued' && data.item?.type === 'synthetic') {
            const meta = data.item.payload?.metadata;
            if (meta?.source === 'shell' && meta.shellID) this.shellResults.set(meta.shellID, data.inboxID);
          }
          let resumedShell;
          if (event.type === 'session.execution.started') {
            shellsAtStart = new Set(this.backgroundShells.keys());
            const ready = [...shellsAtStart].filter(id => this.shellResults.has(id));
            // With several enqueued results only inbox.delivered identifies
            // which ones this execution consumed before a native interrupt.
            if (ready.length === 1) resumedShell = ready[0];
            interruptSent = false;
            this.acc = createTurnAccumulator(this.sessionId);
            this.messageId = null;
            progress.retry = null;
            progress.activeCommand = null;
          } else if (event.type === 'session.inbox.delivered' && !this.acc.terminal) {
            resumedShell = [...shellsAtStart].find(id => this.shellResults.get(id) === data.inboxID);
          }
          if (resumedShell) {
            if (progress.activeCommand === this.backgroundShells.get(resumedShell)) progress.activeCommand = null;
            this.backgroundShells.delete(resumedShell);
            this.shellResults.delete(resumedShell);
            shellsAtStart.delete(resumedShell);
            if (this.drainBackground && !interruptSent) {
              interruptSent = true;
              await this._interruptExecution({ resume: this.backgroundShells.size > 0 });
            }
          }
          const priorTerminal = this.acc.terminal;
          this.acc.push(`data: ${JSON.stringify(event)}\n\n`);
          if (event.type === 'session.step.started') { this._model(data.model); this.messageId = data.assistantMessageID; progress.retry = null; }
          if (event.type === 'session.retry.scheduled') progress.retry = { attempt: data.attempt, at: data.at, error: data.error };
          if (event.type.startsWith('session.tool.') || event.type === 'session.shell.started' || event.type === 'session.shell.ended') {
            await this._shellActivity(event.type, data);
          }
          progress.activeCommand ||= this.backgroundShells.values().next().value ?? null;
          Object.assign(progress, { lastActivityAt: this.clock.now(), partialText: this.acc.snapshot().message, effectiveEffort: this.effectiveEffort });
          this.onProgress?.({ ...progress });
          if (event.type === 'session.idle' || this.acc.terminal !== priorTerminal) {
            const status = this.acc.terminal?.status;
            if (this.backgroundShells.size && (status === 'completed' || (this.drainBackground && status === 'cancelled'))) execution++;
            else return await this._terminal(execution);
          }
        }
      }
      throw failure('ProviderLost');
    } catch (cause) {
      if (cause.code?.startsWith('ModelSelection')) throw cause;
      throw failure('ProviderLost', cause);
    }
  }

  async _shellActivity(type, data) {
    const meta = data.metadata;
    const shellID = data.shellID || meta?.shellID;
    const call = this.acc.toolCall(data.assistantMessageID, data.id);
    let shell = data;
    if (type === 'session.tool.success' && call?.name === 'shell' && meta?.status === 'running' && meta.shellID) {
      if (call.input.background === false) this.backgroundShells.set(meta.shellID, call.input.command);
      shell = meta;
    }
    if (shellID && !Number.isInteger(shell.pid) && type !== 'session.shell.ended') {
      shell = (await this._request('/shell/' + encodeURIComponent(shellID) + this.locationQuery)).data?.data;
    }
    if (Number.isInteger(shell?.pid) && shell.pid > 1) await this.supervisor.recordDescendant(shell.pid);
    this.progress.activeCommand = ['session.tool.success', 'session.tool.failed', 'session.shell.ended'].includes(type)
      ? null : shell?.command || data.input?.command || data.command || this.progress.activeCommand;
  }

  async _terminal(execution = 0) {
    // A fast final event can beat a steer's HTTP receipt. Learn all admitted
    // user ids before walking back through the store to this turn's first one.
    await this.steering?.catch(() => {});
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
          if (message.id === this.nativeTurnId) { found = true; break; }
          if (!this.steerIds.has(message.id)) throw failure('ProviderLost');
          continue;
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
    // A fast explicit background result can advance the store ahead of SSE.
    // Count idle rows from admission and use only this execution's assistant steps.
    const ends = messages.filter(m => m.type === 'idle').reverse();
    const idle = ends[execution];
    const outcome = outcomes[idle?.outcome];
    if (!outcome) throw failure('ProviderLost');
    // The answer is the last execution's; usage covers every execution since admission.
    const olderEnd = execution ? messages.indexOf(ends[execution - 1]) : messages.length;
    const spent = messages.slice(messages.indexOf(idle) + 1).filter(m => m.type === 'assistant');
    const assistants = messages.slice(messages.indexOf(idle) + 1, olderEnd).filter(m => m.type === 'assistant');
    if (outcome === 'completed' && !assistants.length) throw failure('ModelSelectionUnverified');
    for (const assistant of assistants.toReversed()) this._model(assistant.model);
    const texts = assistants.map(m => (m.content || []).filter(p => p.type === 'text').map(p => p.text).join(''));
    return {
      outcome, nativeTurnId: this.nativeTurnId, effectiveEffort: this.effectiveEffort, text: (outcome === 'failed' ? texts.find(Boolean) : texts[0]) || '',
      error: outcome === 'failed' ? [idle, ...assistants].map(m => m?.error?.message).find(m => typeof m === 'string' && m.trim()) : undefined,
      usage: sumUsage(spent.map(m => usageFromOpenCodeInfo({ ...m, modelID: m.model?.id }, 'opencode-server'))),
      nativeRefs: { sessionId: this.sessionId, messageId: assistants[0]?.id || this.messageId || this.nativeTurnId },
      cause: outcome === 'completed' ? 'native_complete' : 'companion_error',
    };
  }

  async _interruptExecution({ resume = false } = {}) {
    // With more cancelled results coming, OpenCode must resume pending steering
    // after interrupt. Its default parks the next synthetic result in the inbox.
    const path = this.sessionPath + '/interrupt' + (resume ? '?resume=true' : '');
    const ack = (await this._request(path, { method: 'POST' })).data;
    if (typeof ack?.interrupted !== 'boolean') throw failure('InterruptUnacknowledged');
    return ack.interrupted;
  }

  // `drain`: interrupt & send waits for the turn's own terminal (its stored usage,
  // no stale events); stop publishes the acknowledgement at once.
  async interrupt({ drain = false } = {}) {
    if (!this.sessionId || this.terminal) return;
    if (this.channel.signal.aborted) throw failure('ProviderLost');
    // The server can already be idle while its execution end is still in flight.
    const betweenTurns = drain && this.backgroundShells?.size && this.acc.terminal;
    const interrupted = betweenTurns ? false : await this._interruptExecution();
    if (drain && !interrupted && this.backgroundShells?.size) {
      // Idle execution interrupts are no-ops. Cancelling a job enqueues its
      // result and wakes a turn. Observe interrupts that turn and drains its end.
      this.drainBackground = true;
      try {
        await Promise.all([...this.backgroundShells.keys()].filter(id => !this.shellResults.has(id))
          .map(id => this._request('/experimental/job/' + encodeURIComponent(id) + '/cancel', { method: 'POST' })));
      } catch (error) { this.drainBackground = false; throw error; }
      return;
    }
    if (interrupted && !drain) {
      // Native acknowledgement is also an abort outcome. Publish it before
      // close can tear down a pending SSE/transcript read during owner stop.
      const snapshot = this.acc?.snapshot();
      this.resolveInterrupt?.({ outcome: 'interrupted', nativeTurnId: this.nativeTurnId, text: snapshot?.message || '', usage: snapshot?.usage,
        nativeRefs: { sessionId: this.sessionId, messageId: this.messageId || this.nativeTurnId }, cause: 'companion_error' });
    }
  }

  async close() {
    this.channel.abort();
    this.http.destroy();
    this.#authorization = undefined;
  }
}
