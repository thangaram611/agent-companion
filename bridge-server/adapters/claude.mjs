import { claudeTranscriptExists } from '../../lib/transcripts.mjs';
export { claudeTranscriptExists } from '../../lib/transcripts.mjs';
import { getTargetById } from '../../lib/target-registry.mjs';
import { companionReady } from '../../lib/target-diagnostics.mjs';
import { isModelAllowedFor } from '../../lib/state.mjs';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { LineReader } from './codex-protocol.mjs';
import { claudeArgs, claudeEnv, parseClaudeFrame, claudeTerminal } from './claude-protocol.mjs';
import { systemClock } from '../controller/clock.mjs';

const failure = (code, cause) => Object.assign(new Error(code, { cause }), { code });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {}); // Startup/delivery can fail before observe attaches.
  return { promise, resolve, reject };
};

function binaryFor(env, cwd) {
  const name = String(env.CLAUDE_BIN || 'claude').trim();
  const candidates = name.includes('/') ? [resolve(cwd, name)] : (env.PATH || '').split(delimiter).map((dir) => resolve(cwd, dir, name));
  for (const file of candidates) {
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch {}
  }
  throw failure('RuntimeUnavailable');
}

// One cold process per execution, potentially several native turns. Input UUID
// lifecycles, not elapsed time, determine whether another turn is pending.
export class ClaudeAdapter {
  capabilities = Object.freeze({ followUp: true, steer: false, modelSelection: true, loadsHistory: true,
    interventions: Object.freeze({ default: 'queue', steer: false, queue: 'native', interrupt: true }) });

  constructor({ env = process.env, clock = systemClock, transcriptExists = claudeTranscriptExists } = {}) {
    this.env = env; this.clock = clock; this.transcriptExists = transcriptExists;
    this.reader = new LineReader(); this.init = deferred();
    this.turns = [deferred()]; this.observedTurn = 0; this.resultCount = 0;
    this.inputs = new Map(); this.inputChanged = deferred();
    this.commands = new Map(); this.pending = new Map();
    this.progress = { lastActivityAt: null, activeCommand: null, retry: null, partialText: '', activity: null, effectiveModel: undefined };
  }

  async start({ cwd, env = this.env, model, effort, supervisor, historyId }) {
    try {
      if (this.closed) throw new Error('adapter closed');
      this.env = claudeEnv(env, cwd); this.resume = historyId != null;
      this.historyId = historyId ?? randomUUID();
      const argv = [binaryFor(env, cwd), ...claudeArgs({ historyId: this.historyId, resume: this.resume, model, effort, env })];
      const runtime = this.runtime = await supervisor.spawn(argv, { cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
      runtime.stdout.setEncoding('utf8');
      runtime.stdout.on('data', (chunk) => {
        for (const line of this.reader.push(chunk).lines) {
          const frame = parseClaudeFrame(line);
          if (frame) this._message(frame);
        }
      });
      runtime.stderr.resume();
      for (const stream of [runtime, runtime.stdin, runtime.stdout]) stream.on('error', (err) => this._lost(err));
      runtime.stdout.on('end', () => this._lost(new Error('Claude stdout ended')));
      runtime.on('close', () => this._lost(new Error('Claude exited')));
      if (this.closed) { runtime.stdin.end(); throw new Error('adapter closed during spawn'); }
      if (runtime.exitCode !== null || runtime.signalCode !== null) throw new Error('Claude exited during spawn');
      return { runtime };
    } catch (err) { throw failure('RuntimeUnavailable', err); }
  }

  async openHistory({ historyId }) {
    try {
      if (this.closed || this.lost || this.earlyError) throw new Error('history unavailable');
      if (this.resume && (historyId !== this.historyId || !await this.transcriptExists(historyId, this.env))) throw new Error('history not found');
      if (this.lost || this.earlyError || this.runtime.exitCode !== null || this.runtime.signalCode !== null) throw new Error('history unavailable');
      return { historyId: this.historyId };
    } catch (err) { throw failure('HistoryUnavailable', this.earlyError ? new Error(claudeTerminal(this.earlyError).text) : this.lost || err); }
  }

  async deliver({ text, messageId = randomUUID() }) {
    if (this.deliveryStarted) throw failure('DeliveryUnknown');
    this.deliveryStarted = true;
    this.nativeTurnId = messageId;
    try {
      if (this.lost || this.earlyError) throw this.lost || failure('DeliveryUnknown');
      await this._write({ type: 'user', uuid: this.nativeTurnId, session_id: this.historyId,
        message: { role: 'user', content: text }, parent_tool_use_id: null });
      await this.init.promise;
      if (this.closed) throw failure('DeliveryUnknown');
      return { nativeTurnId: this.nativeTurnId, effectiveModel: this.progress.effectiveModel };
    } catch (err) {
      const cause = this.earlyError ? new Error(claudeTerminal(this.earlyError).text) : err;
      if (this.earlyError?.errors?.some((text) => typeof text === 'string' && text.includes('No conversation found'))) throw failure('history_not_found', cause);
      throw failure(this.identityError ? 'history_mismatch' : 'DeliveryUnknown', cause);
    }
  }

  observe({ onProgress, onInput, next = false } = {}) {
    if (next) this.observedTurn++;
    this.onProgress = onProgress;
    this.onInput = onInput;
    if (this.progress.lastActivityAt !== null) onProgress?.({ ...this.progress });
    return this.turns[this.observedTurn].promise;
  }

  async intervene({ id, text, mode }) {
    this.inputs.set(id, { state: 'accepted', answered: false });
    try {
      await this._write({ type: 'user', uuid: id, session_id: this.historyId,
        message: { role: 'user', content: text }, parent_tool_use_id: null });
      if (mode === 'interrupt') await this.interrupt({ messageId: id });
      return { accepted: true };
    } catch (err) {
      this.inputs.delete(id); this._inputChanged(); throw err;
    }
  }

  async hasPendingInput() {
    // A result precedes its completed lifecycle. Wait for that lifecycle before
    // declaring the queue drained; another result can already be buffered.
    while ([...this.inputs.values()].some(input => input.answered && !['completed', 'cancelled'].includes(input.state))) {
      if (this.lost) throw this.lost;
      await this.inputChanged.promise;
    }
    return this.resultCount > this.observedTurn + 1 || [...this.inputs.values()].some(input => !['completed', 'cancelled'].includes(input.state));
  }

  _inputChanged() { this.inputChanged.resolve(); this.inputChanged = deferred(); }

  async interrupt({ messageId } = {}) {
    if ((!messageId && this.terminal) || !this.runtime) return;
    this.interruptRequested = true;
    const request_id = randomUUID(), receipt = deferred();
    this.pending.set(request_id, receipt);
    try {
      await this._write({ type: 'control_request', request_id, request: { subtype: 'interrupt',
        ...(messageId ? { send_now: true, message_uuid: messageId } : {}) } });
      await receipt.promise;
    } finally { this.pending.delete(request_id); }
  }

  close() {
    this.closed = true;
    if (!this.runtime) { this._lost(new Error('adapter closed')); return Promise.resolve(); }
    if (this.closing) return this.closing;
    // Claude's close is stdin EOF, and it exits ~1 s later (measured 2026-11-09),
    // longer than the controller's 500 ms close bound. The terminal result always
    // precedes close in every measured path, so the flushed EOF is the
    // acknowledgement; the supervisor still verifies the exit itself.
    const stdin = this.runtime.stdin;
    this.closing = new Promise((resolve) => {
      if (this.runtime.stdout.readableEnded || this.runtime.stdout.destroyed || stdin.writableEnded || stdin.destroyed) resolve();
      else { this.runtime.stdout.once('end', resolve); this.runtime.once('close', resolve); stdin.once('finish', resolve); stdin.once('error', resolve); }
    });
    if (!stdin.destroyed && !stdin.writableEnded) stdin.end();
    return this.closing;
  }

  _write(message) {
    if (this.closed || this.lost || !this.runtime || this.runtime.exitCode !== null || this.runtime.signalCode !== null) return Promise.reject(this.lost || failure('ProviderLost'));
    return new Promise((resolve, reject) => {
      this.runtime.stdin.write(JSON.stringify(message) + '\n', (err) => {
        if (err) { this._lost(err); reject(err); } else resolve();
      });
    });
  }

  _lost(cause) {
    if (this.lost) return;
    this.lost = failure('ProviderLost', cause);
    this.init.reject(this.lost);
    for (const receipt of this.pending.values()) receipt.reject(this.lost);
    this.pending.clear();
    for (const turn of this.turns) turn.reject(this.lost);
    this._inputChanged();
  }

  _message(frame) {
    if (frame.type === 'control_response') {
      const response = frame.response, receipt = this.pending.get(response?.request_id);
      if (receipt) response.subtype === 'success' ? receipt.resolve() : receipt.reject(failure('interrupt_failed'));
      return;
    }
    if (this.lost) return;
    if (frame.type === 'command_lifecycle') {
      if (frame.session_id !== this.historyId) return;
      const input = this.inputs.get(frame.command_uuid);
      if (!input) return;
      input.state = frame.state;
      if (frame.state === 'started') {
        if (this.terminal) {
          this.terminal = undefined; this.nativeTurnId = frame.command_uuid; this.interruptRequested = false;
          this.commands.clear();
          this.progress = { ...this.progress, partialText: '', activeCommand: null, retry: null, activity: null };
        }
        this.onInput?.({ id: frame.command_uuid, state: 'joined', nativeTurnId: this.nativeTurnId });
      }
      if (frame.state === 'cancelled') this.onInput?.({ id: frame.command_uuid, state: 'not_delivered' });
      this._inputChanged();
      return;
    }
    if (this.terminal) return;
    if (frame.type === 'result' && !this.initialized && (frame.is_error === true || frame.subtype !== 'success')) {
      // P3 has no session_id: preserve its early error for the history refusal.
      if (frame.session_id && frame.session_id !== this.historyId) return;
      this.earlyError = frame;
      this.init.reject(failure('DeliveryUnknown'));
      if (!frame.session_id) { this._lost(new Error('Claude failed before init')); return; }
    }
    if (frame.type === 'system' && frame.subtype === 'init') {
      if (frame.session_id !== this.historyId) {
        this.identityError = true; this._lost(new Error('history mismatch')); return;
      }
      this.initialized = true; this.progress.effectiveModel = frame.model; this.init.resolve();
    } else {
      if (frame.session_id !== this.historyId) return;
      if (frame.type === 'result') {
        this.terminal = claudeTerminal(frame, { ...this.progress, interruptRequested: this.interruptRequested, includeCost: !this.resume });
        this.terminal.nativeTurnId = this.nativeTurnId;
        // Usage is per turn, but total_cost_usd is cumulative (measured on 2.1.325).
        if (this.terminal.usage?.cost != null) {
          const total = this.terminal.usage.cost;
          this.terminal.usage = { ...this.terminal.usage, cost: total - (this.costSoFar ?? 0) };
          this.costSoFar = total;
        }
        this.terminal.messages = frame.user_message_uuids ?? [this.nativeTurnId];
        for (const id of this.terminal.messages) {
          const input = this.inputs.get(id);
          if (input) input.answered = true;
        }
        this.commands.clear(); this.progress.activeCommand = null; this.progress.retry = null;
        this.progress.partialText = this.terminal.text ?? this.progress.partialText;
      } else if (frame.type === 'system' && frame.subtype === 'api_retry') {
        const { attempt, max_retries, retry_delay_ms, error } = frame;
        this.progress.retry = { attempt, max_retries, retry_delay_ms, error };
      } else if (frame.type === 'system' && frame.subtype === 'thinking_tokens' && frame.parent_tool_use_id == null) {
        this.progress.retry = null; this.progress.activity = 'thinking';
      } else if (['assistant', 'user', 'stream_event'].includes(frame.type) && frame.parent_tool_use_id === null) {
        if (this.progress.retry) this.progress.activity = null;
        this.progress.retry = null;
        if (frame.type === 'stream_event') {
          const event = frame.event;
          if (event?.type === 'message_start') this.progress.partialText = '';
          if (event?.type === 'content_block_delta') {
            if (event.delta?.type === 'thinking_delta') this.progress.activity = 'thinking';
            if (event.delta?.type === 'text_delta') { this.progress.partialText += event.delta.text; this.progress.activity = 'responding'; }
          }
        } else if (frame.type === 'assistant') {
          const content = frame.message?.content;
          if (frame.message?.model) this.progress.effectiveModel = frame.message.model;
          if (Array.isArray(content)) {
            const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('');
            if (content.some((block) => block.type === 'text')) { this.progress.partialText = text; this.progress.activity = 'responding'; }
            for (const block of content) if (block.type === 'tool_use' && block.name === 'Bash') this.commands.set(block.id, block.input?.command);
          }
        } else if (Array.isArray(frame.message?.content)) {
          for (const block of frame.message.content) if (block.type === 'tool_result') this.commands.delete(block.tool_use_id);
        }
        this.progress.activeCommand = [...this.commands.values()].at(-1) ?? null;
      } else return;
    }
    if (this.terminal) this.progress.activity = null;
    else if (this.progress.retry) this.progress.activity = 'retrying';
    else if (this.progress.activeCommand) this.progress.activity = `running ${this.progress.activeCommand}`;
    else if (this.progress.activity?.startsWith('running ')) this.progress.activity = null;
    this.progress.lastActivityAt = this.clock.now();
    this.onProgress?.({ ...this.progress });
    if (this.terminal) {
      this.turns[this.resultCount++].resolve(this.terminal);
      this.turns.push(deferred());
    }
  }
}

export function claudeProvider({ env = process.env } = {}) {
  return {
    enabled: getTargetById('claude', env)?.implemented === true,
    get ready() { return companionReady('claude', env); },
    modelAllowed: (model) => isModelAllowedFor('claude', model),
    create: () => new ClaudeAdapter({ env }),
  };
}
