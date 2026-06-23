// Experimental Copilot SDK runtime adapter.
//
// ACP remains the default because it currently provides the strongest
// out-of-process job retention story. This adapter keeps the bridge method
// contract stable while we validate SDK parity behind COPILOT_RUNTIME_ADAPTER=sdk.

import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { promptEventsPath, writePrivateFile, appendPrivateFile } from '../lib/runtime-paths.mjs';
import {
  buildPromptInspection,
  coalesceTextChunks,
  parseJsonlEvents,
} from '../lib/prompt-inspect.mjs';

const PROMPT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_PROMPT_TIMEOUT_MS = 25 * 60 * 1000;
const SDK_STOP_TIMEOUT_MS = 5 * 1000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stuck']);

let sdkModuleOverride = null;
let sdkModulePromise = null;
let manager = null;

function promptTimeoutMs() {
  const configured = Number(process.env.COPILOT_SDK_PROMPT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PROMPT_TIMEOUT_MS;
}

function requireAbsoluteDirectoryCwd(cwd, label = 'cwd') {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error(`${label} is required (absolute target repo/worktree path; refusing to default to process.cwd())`);
  }
  if (!isAbsolute(cwd)) throw new Error(`${label} must be absolute: ${cwd}`);
  let st;
  try { st = statSync(cwd); }
  catch { throw new Error(`${label} must exist as a directory: ${cwd}`); }
  if (!st.isDirectory()) throw new Error(`${label} must be a directory: ${cwd}`);
  return cwd;
}

function canonicalCwd(cwd) {
  if (!cwd) return null;
  try { return realpathSync(cwd); }
  catch { return String(cwd); }
}

function sameCwd(a, b) {
  const ca = canonicalCwd(a);
  const cb = canonicalCwd(b);
  return !!ca && !!cb && ca === cb;
}

async function loadSdkModule() {
  if (sdkModuleOverride) return sdkModuleOverride;
  if (!sdkModulePromise) sdkModulePromise = import('@github/copilot-sdk');
  return sdkModulePromise;
}

function wrapError(err) {
  const response = {
    ok: false,
    error: err?.message || String(err),
  };
  if (err?.code) response.code = err.code;
  if (err?.data) response.data = err.data;
  return response;
}

async function wrap(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return wrapError(err);
  }
}

function timestampMs(event) {
  const parsed = Date.parse(event?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function previewFromValue(value, max = 300) {
  if (typeof value === 'string') return value.slice(0, max);
  if (value == null) return null;
  try { return JSON.stringify(value).slice(0, max); }
  catch { return '[unserializable]'; }
}

function toolKind(toolName, data = {}) {
  const name = String(toolName || '').toLowerCase();
  if (data.mcpServerName || data.mcpToolName) return 'mcp';
  if (name.includes('shell') || name.includes('terminal') || name.includes('bash') || name.includes('command')) return 'execute';
  if (name.includes('read') || name.includes('view') || name.includes('grep') || name.includes('search') || name.includes('glob')) return 'read';
  if (name.includes('edit') || name.includes('write') || name.includes('patch')) return 'write';
  return 'tool';
}

function outputPreview(data = {}) {
  if (data.error?.message) return data.error.message.slice(0, 300);
  if (typeof data.result?.detailedContent === 'string') return data.result.detailedContent.slice(0, 300);
  if (typeof data.result?.content === 'string') return data.result.content.slice(0, 300);
  if (Array.isArray(data.result?.contents)) return previewFromValue(data.result.contents);
  return null;
}

function errorFromEvent(event) {
  const data = event?.data || {};
  return data.errorMessage || data.message || data.error?.message || data.error || data.reason || data.summary || `${event?.type || 'sdk'} error`;
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

const PATH_ARGUMENT_KEYS = new Set([
  'path',
  'file',
  'file_path',
  'filepath',
  'filename',
  'relative_path',
  'relativepath',
  'target_file',
  'target_path',
  'targetpath',
  'source_file',
  'source_path',
  'sourcepath',
]);
const PATH_ARRAY_ARGUMENT_KEYS = new Set(['paths', 'files', 'file_paths', 'filenames']);

function normalizeToolInput(input) {
  if (typeof input !== 'string') return input || {};
  const trimmed = input.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return input;
  try { return JSON.parse(trimmed); }
  catch { return input; }
}

function looksPathLike(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  if (trimmed.includes('\n')) return false;
  return true;
}

function locationsFromToolInput(input) {
  const locations = [];
  const seen = new Set();
  const add = (value) => {
    if (!looksPathLike(value)) return;
    const path = value.trim();
    if (seen.has(path)) return;
    seen.add(path);
    locations.push({ path });
  };
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, raw] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[-\s]/g, '_');
      const compactKey = normalizedKey.replace(/_/g, '');
      if (PATH_ARGUMENT_KEYS.has(normalizedKey) || PATH_ARGUMENT_KEYS.has(compactKey)) {
        if (Array.isArray(raw)) for (const item of raw) add(item);
        else add(raw);
        continue;
      }
      if (PATH_ARRAY_ARGUMENT_KEYS.has(normalizedKey) && Array.isArray(raw)) {
        for (const item of raw) add(item);
        continue;
      }
      visit(raw);
    }
  };
  visit(input);
  return locations;
}

function toolCallEventFields(input) {
  const locations = locationsFromToolInput(input);
  return locations.length > 0 ? { input, locations } : { input };
}

function sessionConfig({ cwd, model, approveAll }) {
  const config = {
    model,
    workingDirectory: cwd,
    streaming: true,
    includeSubAgentStreamingEvents: false,
    onPermissionRequest: approveAll,
    onUserInputRequest: async () => ({
      answer: 'No interactive user is attached to this Copilot companion runtime. Continue with the available context.',
      wasFreeform: true,
    }),
  };
  if (!model) delete config.model;
  if (process.env.COPILOT_SDK_REASONING_EFFORT) {
    config.reasoningEffort = process.env.COPILOT_SDK_REASONING_EFFORT;
  }
  return config;
}

class SdkRuntimeManager {
  constructor() {
    this.client = null;
    this.sessions = new Map();
    this.prompts = new Map();
    this._clientStart = null;
    this._sessionMutation = Promise.resolve();
    this._sdkStatus = null;
    this._gcTimer = setInterval(() => this._gcExpiredPrompts(), 60 * 1000);
    if (this._gcTimer.unref) this._gcTimer.unref();
  }

  async ensureRuntime() {
    await loadSdkModule();
  }

  async _withSessionMutation(fn) {
    const prior = this._sessionMutation.catch(() => {});
    let release;
    this._sessionMutation = new Promise((resolve) => { release = resolve; });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async _ensureClient() {
    if (this.client) return this.client;
    if (this._clientStart) return this._clientStart;
    this._clientStart = (async () => {
      const sdk = await loadSdkModule();
      const options = {};
      if (process.env.COPILOT_SDK_LOG_LEVEL) options.logLevel = process.env.COPILOT_SDK_LOG_LEVEL;
      if (process.env.COPILOT_BIN && sdk.RuntimeConnection?.forStdio) {
        options.connection = sdk.RuntimeConnection.forStdio({ path: process.env.COPILOT_BIN });
      }
      const client = new sdk.CopilotClient(options);
      await client.start();
      this.client = client;
      try { this._sdkStatus = await client.getStatus(); } catch {}
      return client;
    })();
    try {
      return await this._clientStart;
    } finally {
      this._clientStart = null;
    }
  }

  async _sessionConfig(cwd, model) {
    const sdk = await loadSdkModule();
    return sessionConfig({ cwd, model, approveAll: sdk.approveAll });
  }

  _registerSession(session, { cwd, model }) {
    const existing = this.sessions.get(session.sessionId);
    if (existing?.unsubscribe) {
      try { existing.unsubscribe(); } catch {}
    }
    const meta = {
      session,
      sessionId: session.sessionId,
      cwd,
      cwdReal: canonicalCwd(cwd),
      model: model || null,
      promptCount: existing?.promptCount || 0,
      createdAt: existing?.createdAt || Date.now(),
      activePromptId: existing?.activePromptId || null,
      unsubscribe: null,
    };
    meta.unsubscribe = session.on((event) => this._onSessionEvent(session.sessionId, event));
    this.sessions.set(session.sessionId, meta);
    return meta;
  }

  async _getSession({ sessionId, cwd, model }) {
    const client = await this._ensureClient();
    const requestedCwd = requireAbsoluteDirectoryCwd(cwd, 'prompt-bg cwd');
    const requestedModel = String(model || '').trim() || undefined;
    const config = await this._sessionConfig(requestedCwd, requestedModel);
    let sessionReborn = false;

    if (sessionId && this.sessions.has(sessionId)) {
      const meta = this.sessions.get(sessionId);
      const active = meta.activePromptId ? this.prompts.get(meta.activePromptId) : null;
      if (active && !isTerminal(active.status)) {
        if (!sameCwd(meta.cwd, requestedCwd)) {
          const err = new Error(`session cwd switch blocked: prompt ${active.promptId} is still ${active.status}`);
          err.code = 'SESSION_BUSY';
          err.data = { existingPromptId: active.promptId, sessionId };
          throw err;
        }
        if ((meta.model || null) !== (requestedModel || null)) {
          const err = new Error(`session model switch blocked: prompt ${active.promptId} is still ${active.status}`);
          err.code = 'MODEL_BUSY';
          err.data = { existingPromptId: active.promptId, sessionId };
          throw err;
        }
      }
      if (sameCwd(meta.cwd, requestedCwd) && (meta.model || null) === (requestedModel || null)) {
        return { meta, sessionReborn };
      }
      try { await meta.session.disconnect(); } catch {}
      if (meta.unsubscribe) {
        try { meta.unsubscribe(); } catch {}
      }
      this.sessions.delete(sessionId);
      sessionId = null;
      sessionReborn = true;
    }

    if (sessionId) {
      try {
        const session = await client.resumeSession(sessionId, { ...config, suppressResumeEvent: true });
        return { meta: this._registerSession(session, { cwd: requestedCwd, model: requestedModel }), sessionReborn };
      } catch {
        sessionReborn = true;
      }
    }

    const session = await client.createSession(config);
    return { meta: this._registerSession(session, { cwd: requestedCwd, model: requestedModel }), sessionReborn };
  }

  async promptBg({ sessionId = null, text, cwd, model }) {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('prompt text is required');
    return this._withSessionMutation(async () => {
      this._gcExpiredPrompts();
      const { meta, sessionReborn } = await this._getSession({ sessionId, cwd, model });
      const active = meta.activePromptId ? this.prompts.get(meta.activePromptId) : null;
      if (active && !isTerminal(active.status)) {
        const err = new Error(`session busy: prompt ${active.promptId} is in flight (status=${active.status})`);
        err.code = 'SESSION_BUSY';
        err.data = { existingPromptId: active.promptId, sessionId: meta.sessionId };
        throw err;
      }

      const promptId = randomUUID();
      const eventsFile = promptEventsPath(promptId);
      writePrivateFile(eventsFile, '');
      const state = {
        promptId,
        sessionId: meta.sessionId,
        session: meta.session,
        cwd: meta.cwd,
        model: meta.model,
        eventsFile,
        status: 'running',
        summary: null,
        error: null,
        stuckReason: null,
        stuckDetail: null,
        startedAt: Date.now(),
        terminalAt: null,
        retentionExpiresAt: null,
        lastEventAt: Date.now(),
        messageParts: [],
        messageBuffers: new Map(),
        thoughtParts: [],
        deltaMessageIds: new Set(),
        toolNames: new Map(),
        toolStatuses: new Map(),
        lastAssistantMessage: null,
        taskCompleteSummary: null,
        waiters: [],
        timeout: null,
      };
      this.prompts.set(promptId, state);
      meta.activePromptId = promptId;
      this._writeEvent(state, { type: 'start', sessionId: meta.sessionId, promptId });
      state.timeout = setTimeout(() => {
        this._finishPrompt(state, {
          status: 'failed',
          error: 'prompt timeout',
          detail: 'prompt_timeout',
        });
        meta.session.abort().catch(() => {});
      }, promptTimeoutMs());
      if (state.timeout.unref) state.timeout.unref();

      meta.session.send({
        prompt: text,
        mode: 'enqueue',
        agentMode: 'autopilot',
      }).catch((err) => {
        this._finishPrompt(state, { status: 'failed', error: err.message });
      });

      return {
        promptId,
        sessionId: meta.sessionId,
        eventsFile,
        activeModel: meta.model,
        sessionReborn,
      };
    });
  }

  async watchPrompt(promptId, since = 0, opts = {}) {
    const state = this.prompts.get(promptId);
    if (!state) throw new Error(`unknown promptId: ${promptId}`);
    const wait = Math.max(0, Math.min(Number(opts.wait) || 0, promptTimeoutMs() / 1000));
    if (wait > 0 && !isTerminal(state.status)) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          const idx = state.waiters.indexOf(resolver);
          if (idx >= 0) state.waiters.splice(idx, 1);
          resolve();
        }, wait * 1000);
        const resolver = () => {
          clearTimeout(timer);
          resolve();
        };
        state.waiters.push(resolver);
      });
    }

    let lines = [];
    if (!opts.summaryOnly) {
      try { lines = readFileSync(state.eventsFile, 'utf8').split('\n').filter((line) => line.trim()); }
      catch {}
    }

    const baseResponse = {
      promptId,
      sessionId: state.sessionId,
      cwd: state.cwd,
      status: state.status,
      startedAt: state.startedAt,
      terminalAt: state.terminalAt || null,
      nextOffset: lines.length,
      lastEventAt: state.lastEventAt,
      msSinceLastEvent: Date.now() - state.lastEventAt,
      retentionExpiresAt: state.retentionExpiresAt || null,
      summary: state.status === 'completed' ? state.summary : null,
      error: state.status === 'failed' ? state.error : null,
      stuckReason: state.stuckReason || null,
      stuckDetail: state.stuckDetail || null,
      interim: false,
      alert: null,
      sessionRetired: false,
    };
    if (opts.summaryOnly) return baseResponse;

    const rawEvents = lines.slice(since).map((line) => {
      try { return JSON.parse(line); }
      catch { return { type: 'parse_error', raw: line.slice(0, 200) }; }
    });
    const events = opts.raw ? rawEvents : coalesceTextChunks(rawEvents);
    return { ...baseResponse, events };
  }

  inspectPrompt(promptId, opts = {}) {
    const state = this.prompts.get(promptId);
    if (!state) throw new Error(`unknown promptId: ${promptId}`);
    let events = [];
    try { events = parseJsonlEvents(readFileSync(state.eventsFile, 'utf8')); }
    catch {}
    return buildPromptInspection(
      {
        promptId,
        sessionId: state.sessionId,
        cwd: state.cwd,
        status: state.status,
        startedAt: state.startedAt,
        terminalAt: state.terminalAt || null,
        lastEventAt: state.lastEventAt,
        msSinceLastEvent: Date.now() - state.lastEventAt,
        retentionExpiresAt: state.retentionExpiresAt || null,
        stuckReason: state.stuckReason || null,
        stuckDetail: state.stuckDetail || null,
        sessionRetired: false,
      },
      events,
      {
        includeTimeline: opts.includeTimeline !== false,
        limit: opts.limit,
      },
    );
  }

  async cancelPrompt(promptId) {
    const state = this.prompts.get(promptId);
    if (!state) throw new Error(`unknown promptId: ${promptId}`);
    if (state.status !== 'running') return { cancelled: false, reason: `prompt is ${state.status}` };
    state.status = 'cancelling';
    await state.session.abort();
    this._finishPrompt(state, { status: 'cancelled' });
    return { cancelled: true, ackSent: true };
  }

  async replyPrompt(promptId, message) {
    const state = this.prompts.get(promptId);
    if (!state) throw new Error(`unknown promptId: ${promptId}`);
    if (state.status !== 'running') return { ok: false, reason: `prompt is ${state.status}` };
    if (!message || typeof message !== 'string' || !message.trim()) return { ok: false, reason: 'message must be a non-empty string' };
    const meta = this.sessions.get(state.sessionId);
    if (!meta) return { ok: false, reason: 'session is not available' };

    const merged = [
      'CONTINUATION (user follow-up while you were working):',
      '',
      'Your previous turn was cancelled intentionally so the user could',
      'add the following context. Incorporate it and continue the same',
      'underlying task - do not start over from scratch.',
      '',
      '--- USER FOLLOW-UP ---',
      message.trim(),
    ].join('\n');

    await this.cancelPrompt(promptId);
    const replacement = await this.promptBg({
      sessionId: state.sessionId,
      text: merged,
      cwd: state.cwd,
      model: state.model,
    });
    return {
      ok: true,
      original_prompt_id: promptId,
      new_prompt_id: replacement.promptId,
      session_id: replacement.sessionId,
    };
  }

  async runtimeStatus() {
    this._gcExpiredPrompts();
    let sdkStatus = this._sdkStatus;
    if (this.client) {
      try { sdkStatus = await this.client.getStatus(); this._sdkStatus = sdkStatus; } catch {}
    }
    return {
      connected: !!this.client,
      initialized: !!this.client,
      pid: null,
      connectionCwd: null,
      activeModel: null,
      configuredModel: null,
      sdkStatus,
      sessions: Array.from(this.sessions.values()).map((meta) => ({
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        model: meta.model || null,
        promptCount: meta.promptCount,
        createdAt: meta.createdAt,
      })),
      inFlightPrompts: Array.from(this.prompts.values()).map((state) => ({
        promptId: state.promptId,
        sessionId: state.sessionId,
        cwd: state.cwd,
        status: state.status,
        startedAt: state.startedAt,
        terminalAt: state.terminalAt || null,
        msSinceLastEvent: Date.now() - state.lastEventAt,
        retentionExpiresAt: state.retentionExpiresAt || null,
        stuckReason: state.stuckReason || null,
      })),
    };
  }

  _onSessionEvent(sessionId, event) {
    const meta = this.sessions.get(sessionId);
    const state = meta?.activePromptId ? this.prompts.get(meta.activePromptId) : null;
    if (!state || isTerminal(state.status)) return;
    const ts = timestampMs(event);
    const data = event?.data || {};

    switch (event.type) {
      case 'assistant.message_delta':
        if (event.agentId) return;
        if (typeof data.deltaContent === 'string' && data.deltaContent) {
          if (data.messageId) state.deltaMessageIds.add(data.messageId);
          state.messageParts.push(data.deltaContent);
          if (data.messageId) {
            state.messageBuffers.set(data.messageId, (state.messageBuffers.get(data.messageId) || '') + data.deltaContent);
          }
          this._writeEvent(state, { type: 'message', text: data.deltaContent, ts });
        }
        break;
      case 'assistant.reasoning_delta':
      case 'assistant.streaming_delta':
        if (event.agentId) return;
        if (typeof data.deltaContent === 'string' && data.deltaContent) {
          state.thoughtParts.push(data.deltaContent);
          this._writeEvent(state, { type: 'thought', text: data.deltaContent, ts });
        }
        break;
      case 'assistant.message':
        if (event.agentId) return;
        if (typeof data.content === 'string' && data.content) {
          state.lastAssistantMessage = data.content;
          const streamed = data.messageId ? state.messageBuffers.get(data.messageId) : null;
          if (streamed && data.content.startsWith(streamed)) {
            const suffix = data.content.slice(streamed.length);
            if (suffix) this._writeEvent(state, { type: 'message', text: suffix, ts });
          } else if (!state.deltaMessageIds.has(data.messageId)) {
            this._writeEvent(state, { type: 'message', text: data.content, ts });
          }
        }
        if (Array.isArray(data.toolRequests)) {
          for (const tool of data.toolRequests) {
            const id = tool.toolCallId || randomUUID();
            const input = normalizeToolInput(tool.arguments || {});
            state.toolNames.set(id, tool.name || tool.toolTitle || 'tool');
            this._writeEvent(state, {
              type: 'tool_call',
              toolCallId: id,
              name: tool.name || tool.toolTitle || 'tool',
              kind: tool.mcpServerName ? 'mcp' : toolKind(tool.name),
              ...toolCallEventFields(input),
              ts,
            });
          }
        }
        break;
      case 'assistant.reasoning':
        if (event.agentId) return;
        if (typeof data.content === 'string' && data.content) {
          state.thoughtParts.push(data.content);
          this._writeEvent(state, { type: 'thought', text: data.content, ts });
        }
        break;
      case 'tool.execution_start': {
        const id = data.toolCallId || randomUUID();
        const input = normalizeToolInput(data.arguments || {});
        state.toolNames.set(id, data.toolName || 'tool');
        this._writeEvent(state, {
          type: 'tool_call',
          toolCallId: id,
          name: data.toolName || 'tool',
          kind: toolKind(data.toolName, data),
          ...toolCallEventFields(input),
          ts,
        });
        break;
      }
      case 'tool.execution_complete': {
        const id = data.toolCallId || randomUUID();
        const status = data.success ? 'completed' : 'failed';
        state.toolStatuses.set(id, status);
        this._writeEvent(state, {
          type: 'tool_call_update',
          toolCallId: id,
          name: state.toolNames.get(id) || data.toolName || 'tool',
          kind: toolKind(state.toolNames.get(id), data),
          status,
          outputPreview: outputPreview(data),
          ts,
        });
        break;
      }
      case 'session.task_complete':
        if (typeof data.summary === 'string' && data.summary) {
          state.taskCompleteSummary = data.summary;
          if (!state.lastAssistantMessage && state.messageParts.length === 0) {
            this._writeEvent(state, { type: 'message', text: data.summary, ts });
          }
        }
        break;
      case 'session.error':
      case 'assistant.model_call_failure':
      case 'model_call_failure':
      case 'model.call_failure':
        this._finishPrompt(state, { status: 'failed', error: errorFromEvent(event) });
        break;
      case 'assistant.abort':
      case 'abort':
        if (state.status === 'cancelling') this._finishPrompt(state, { status: 'cancelled' });
        break;
      case 'session.idle':
        if (state.status === 'cancelling') this._finishPrompt(state, { status: 'cancelled' });
        else this._finishPrompt(state, { status: 'completed' });
        break;
      default:
        break;
    }
  }

  _writeEvent(state, event) {
    try {
      const line = JSON.stringify({ ...event, ts: event.ts || Date.now() }) + '\n';
      appendPrivateFile(state.eventsFile, line);
      state.lastEventAt = event.ts || Date.now();
    } catch {}
  }

  _summaryForState(state) {
    const message = (state.lastAssistantMessage || state.messageParts.join('') || state.taskCompleteSummary || '').trim();
    const thoughts = state.thoughtParts.join('').trim();
    const toolCalls = Array.from(state.toolNames.entries()).map(([id, name]) => ({
      id,
      name,
      status: state.toolStatuses.get(id) || 'completed',
    }));
    return {
      message,
      thoughts,
      toolCalls,
      stopReason: state.status === 'cancelled' ? 'cancelled' : 'end_turn',
    };
  }

  _finishPrompt(state, { status, error = null, detail = null }) {
    if (!state || isTerminal(state.status)) return;
    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }
    state.status = status;
    state.error = error;
    state.stuckDetail = detail;
    state.summary = status === 'completed' ? this._summaryForState(state) : null;
    const terminalAt = Date.now();
    state.terminalAt = terminalAt;
    state.retentionExpiresAt = terminalAt + PROMPT_RETENTION_MS;

    const meta = this.sessions.get(state.sessionId);
    if (meta?.activePromptId === state.promptId) {
      meta.activePromptId = null;
      meta.promptCount += 1;
    }

    if (status === 'completed') {
      this._writeEvent(state, { type: 'done', stopReason: state.summary?.stopReason || 'end_turn' });
    } else if (status === 'cancelled') {
      this._writeEvent(state, { type: 'cancelled', stopReason: 'cancelled' });
    } else if (status === 'failed') {
      this._writeEvent(state, { type: 'error', error: error || 'sdk runtime failed', detail });
    }
    const waiters = state.waiters.splice(0);
    for (const resolve of waiters) {
      try { resolve(); } catch {}
    }
  }

  _gcExpiredPrompts(now = Date.now()) {
    for (const [promptId, state] of this.prompts) {
      if (!isTerminal(state.status)) continue;
      if (!state.retentionExpiresAt || state.retentionExpiresAt > now) continue;
      if (existsSync(state.eventsFile)) {
        try { unlinkSync(state.eventsFile); } catch {}
      }
      this.prompts.delete(promptId);
    }
  }

  async shutdown() {
    if (this._gcTimer) {
      clearInterval(this._gcTimer);
      this._gcTimer = null;
    }
    for (const meta of this.sessions.values()) {
      if (meta.unsubscribe) {
        try { meta.unsubscribe(); } catch {}
      }
      try { await meta.session.disconnect(); } catch {}
    }
    this.sessions.clear();
    for (const state of this.prompts.values()) {
      if (state.timeout) clearTimeout(state.timeout);
      if (existsSync(state.eventsFile)) {
        try { unlinkSync(state.eventsFile); } catch {}
      }
    }
    this.prompts.clear();
    if (this.client) {
      const client = this.client;
      let timer = null;
      try {
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), SDK_STOP_TIMEOUT_MS);
        });
        const stopped = await Promise.race([
          client.stop().then(() => true).catch(() => true),
          timeout,
        ]);
        if (timer) clearTimeout(timer);
        if (!stopped && typeof client.forceStop === 'function') {
          await client.forceStop().catch(() => {});
        }
        if (stopped && typeof client.forceStop === 'function') {
          await client.forceStop().catch(() => {});
        }
      } catch {
        if (timer) clearTimeout(timer);
      }
      this.client = null;
    }
  }
}

function runtimeManager() {
  if (!manager) manager = new SdkRuntimeManager();
  return manager;
}

export async function ensureRuntime(opts = {}) {
  void opts;
  await runtimeManager().ensureRuntime();
}

export function runtimeStatus(timeoutMs) {
  void timeoutMs;
  return wrap(() => runtimeManager().runtimeStatus());
}

export function promptBg(args) {
  return wrap(() => runtimeManager().promptBg(args));
}

export function watchPrompt({ promptId, since = 0, raw = false, wait = 0, summaryOnly = false }, timeoutMs) {
  void timeoutMs;
  return wrap(() => runtimeManager().watchPrompt(promptId, since, { raw, wait, summaryOnly }));
}

export function inspectPrompt({ promptId, includeTimeline = false, limit = 40 }, timeoutMs) {
  void timeoutMs;
  return wrap(() => runtimeManager().inspectPrompt(promptId, { includeTimeline, limit }));
}

export function cancelPrompt({ promptId }) {
  return wrap(() => runtimeManager().cancelPrompt(promptId));
}

export function replyPrompt({ promptId, message }, timeoutMs) {
  void timeoutMs;
  return wrap(() => runtimeManager().replyPrompt(promptId, message));
}

export function _setSdkModuleForTest(module) {
  sdkModuleOverride = module;
  sdkModulePromise = null;
}

export async function _resetSdkRuntimeForTest() {
  if (manager) await manager.shutdown();
  manager = null;
  sdkModuleOverride = null;
  sdkModulePromise = null;
}
