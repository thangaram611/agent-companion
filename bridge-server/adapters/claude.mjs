import { getTargetById } from '../../lib/target-registry.mjs';
import { companionReady } from '../../lib/target-diagnostics.mjs';
import { isModelAllowedFor } from '../../lib/state.mjs';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
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

export function claudeTranscriptExists(historyId, env) {
  const projects = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'), 'projects');
  try {
    return readdirSync(projects, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false;
      try { return statSync(join(projects, entry.name, `${historyId}.jsonl`)).isFile(); } catch { return false; }
    });
  } catch { return false; }
}

// One cold process, one user write. Controller deadlines and supervisor cleanup
// own lifetime; init confirms delivery, whereas replay can wait for the model.
export class ClaudeAdapter {
  capabilities = Object.freeze({ followUp: true, steer: false, modelSelection: true, loadsHistory: true });

  constructor({ env = process.env, clock = systemClock, transcriptExists = claudeTranscriptExists } = {}) {
    this.env = env; this.clock = clock; this.transcriptExists = transcriptExists;
    this.reader = new LineReader(); this.init = deferred(); this.done = deferred();
    this.commands = new Map(); this.pending = new Map();
    this.progress = { lastActivityAt: null, activeCommand: null, retry: null, partialText: '', effectiveModel: undefined };
  }

  async start({ cwd, env = this.env, model, supervisor, historyId }) {
    try {
      if (this.closed) throw new Error('adapter closed');
      this.env = claudeEnv(env, cwd); this.resume = historyId != null;
      this.historyId = historyId ?? randomUUID();
      const argv = [binaryFor(env, cwd), ...claudeArgs({ historyId: this.historyId, resume: this.resume, model, env })];
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
    } catch (err) { throw failure('HistoryUnavailable', err); }
  }

  async deliver({ text }) {
    if (this.deliveryStarted) throw failure('DeliveryUnknown');
    this.deliveryStarted = true;
    this.nativeTurnId = randomUUID();
    try {
      if (this.lost || this.earlyError) throw this.lost || failure('DeliveryUnknown');
      await this._write({ type: 'user', uuid: this.nativeTurnId, session_id: this.historyId,
        message: { role: 'user', content: text }, parent_tool_use_id: null });
      await this.init.promise;
      if (this.closed) throw failure('DeliveryUnknown');
      return { nativeTurnId: this.nativeTurnId };
    } catch (err) {
      if (this.earlyError?.errors?.some((text) => typeof text === 'string' && text.includes('No conversation found'))) throw failure('history_not_found', err);
      throw failure(this.identityError ? 'history_mismatch' : 'DeliveryUnknown', err);
    }
  }

  observe({ onProgress } = {}) {
    this.onProgress = onProgress;
    if (this.progress.lastActivityAt !== null) onProgress?.({ ...this.progress });
    return this.done.promise;
  }

  async interrupt() {
    if (this.terminal || !this.runtime) return;
    this.interruptRequested = true;
    const request_id = randomUUID(), receipt = deferred();
    this.pending.set(request_id, receipt);
    try {
      await this._write({ type: 'control_request', request_id, request: { subtype: 'interrupt' } });
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
    if (!this.terminal) this.done.reject(this.lost);
  }

  _message(frame) {
    if (frame.type === 'control_response') {
      const response = frame.response, receipt = this.pending.get(response?.request_id);
      if (receipt) response.subtype === 'success' ? receipt.resolve() : receipt.reject(failure('interrupt_failed'));
      return;
    }
    if (this.terminal || this.lost) return;
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
        this.commands.clear(); this.progress.activeCommand = null; this.progress.retry = null;
        this.progress.partialText = this.terminal.text ?? this.progress.partialText;
      } else if (frame.type === 'system' && frame.subtype === 'api_retry') {
        const { attempt, max_retries, retry_delay_ms, error } = frame;
        this.progress.retry = { attempt, max_retries, retry_delay_ms, error };
      } else if (['assistant', 'user', 'stream_event'].includes(frame.type) && frame.parent_tool_use_id === null) {
        this.progress.retry = null;
        if (frame.type === 'stream_event') {
          const event = frame.event;
          if (event?.type === 'message_start') this.progress.partialText = '';
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') this.progress.partialText += event.delta.text;
        } else if (frame.type === 'assistant') {
          const content = frame.message?.content;
          if (frame.message?.model) this.progress.effectiveModel = frame.message.model;
          if (Array.isArray(content)) {
            const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('');
            if (content.some((block) => block.type === 'text')) this.progress.partialText = text;
            for (const block of content) if (block.type === 'tool_use' && block.name === 'Bash') this.commands.set(block.id, block.input?.command);
          }
        } else if (Array.isArray(frame.message?.content)) {
          for (const block of frame.message.content) if (block.type === 'tool_result') this.commands.delete(block.tool_use_id);
        }
        this.progress.activeCommand = [...this.commands.values()].at(-1) ?? null;
      } else return;
    }
    this.progress.lastActivityAt = this.clock.now();
    this.onProgress?.({ ...this.progress });
    if (this.terminal) this.done.resolve(this.terminal);
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
