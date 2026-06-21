#!/usr/bin/env node
// copilot-acp-daemon.mjs
// Long-lived daemon that manages a `copilot --acp` child process and exposes
// it over a Unix domain socket. Speaks JSON-RPC 2.0 to Copilot, simple JSON
// over the socket to clients.
//
// One daemon, one Copilot process, multiple ACP sessions. Yolo mode —
// Copilot has full tool access (shell, write, edit, web). Behavioral
// safety is enforced per-prompt by skills, not by flags.

import { spawn, execSync } from 'node:child_process';
import { createServer, connect as connectSocket } from 'node:net';
import { appendFileSync, statSync, lstatSync, unlinkSync, renameSync, writeFileSync, existsSync, readFileSync, chmodSync, readdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import {
  daemonSocketPath,
  daemonLogFile,
  heartbeatDir,
  promptEventsPath,
  otelTracesPath,
} from '../lib/runtime-paths.mjs';
import { Supervisor, pollSupervisor } from '../lib/prompt-supervisor.mjs';
import {
  parseJsonlEvents,
  coalesceTextChunks,
  buildPromptInspection,
} from '../lib/prompt-inspect.mjs';
import { selectLiveHeartbeat } from '../lib/heartbeat.mjs';
import { readDefaultModel } from '../lib/state.mjs';

// --- Constants ---------------------------------------------------------------

// Resolve the copilot CLI binary only when spawning the real daemon. Module
// imports must stay side-effect-light so unit tests can exercise SessionManager
// with a fake AcpConnection on machines without Copilot CLI installed.
//
// Portability matters here — hardcoding a Homebrew Apple Silicon path breaks
// the daemon on Intel Macs, Linux, or any install that lives elsewhere.
// Precedence:
//   1. $COPILOT_BIN override (for pinning a specific build)
//   2. `command -v copilot` — honours the user's PATH
//   3. /opt/homebrew/bin/copilot as a last-resort legacy fallback
// Fails loudly with an actionable error if none resolve.
function resolveCopilotBin() {
  if (process.env.COPILOT_BIN) return process.env.COPILOT_BIN;
  try {
    const found = execSync('command -v copilot', { encoding: 'utf8', shell: '/bin/sh' }).trim();
    if (found) return found;
  } catch {
    // fall through to fallback
  }
  const legacyFallback = '/opt/homebrew/bin/copilot';
  if (existsSync(legacyFallback)) return legacyFallback;
  throw new Error(
    'copilot binary not found on PATH. Install GitHub Copilot CLI or set $COPILOT_BIN.'
  );
}
const LOG_MAX_BYTES = 1024 * 1024; // 1 MB
const PRIVATE_FILE_MODE = 0o600;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

// Heartbeat-driven liveness extension. Claude/Codex hooks touch a per-host-sid
// file in HEARTBEAT_DIR on every tool turn (PostToolUse / UserPromptSubmit /
// SessionStart). When the inactivity timer fires, the daemon checks for any
// heartbeat newer than HOST_LIVENESS_TTL_MS and reschedules instead of exiting
// — keeping the Copilot subprocess alive (and its in-process conversation
// context with it) for the full lifetime of an active host session. The 15-min
// idle timer alone would terminate the Copilot child mid-session, forcing a
// rebirth on the next prompt-bg and losing context.
const HOST_LIVENESS_TTL_MS = 30 * 60 * 1000; // 30 min — see hooks/drain-completions.sh
const HEARTBEAT_STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h: unlink unused heartbeats
const PROMPT_TIMEOUT_MS = 25 * 60 * 1000; // 25 min per prompt — must be >= MAX_LONG_POLL_WAIT_MS or legitimate long prompts are killed and surface as "prompt timeout" failures instead of real answers. Raised from 10 min to accommodate /fleet jobs that legitimately decompose into multiple long-running sub-agents (e.g. multi-file code reviews).
const PROMPT_RETENTION_MS = 60 * 60 * 1000; // retain terminal prompts for inspection
const SPAWN_INIT_TIMEOUT_MS = 30 * 1000; // 30s for handshake
const SILENCE_CHECK_INTERVAL_MS = 10 * 1000; // 10s — silence heuristic
const MAX_LONG_POLL_WAIT_MS = 22 * 60 * 1000; // 22 min — caller-requested wait cap (must be <= PROMPT_TIMEOUT_MS)
const PROMPT_TIMEOUT_ERROR = 'prompt timeout';
const EMPTY_COMPLETED_ERROR = 'empty completed response';
// replyPrompt must wait for the cancelled prompt to reach a TERMINAL_STATUSES
// state before re-entering startPromptBg, otherwise the prior collector still
// owns `sessionCollectors[sessionId]` and would be overwritten by the
// replacement — recreating the duplicate-prompt collision the per-session
// mutex is meant to prevent. If the drain does not complete inside this
// window the reply is failed cleanly rather than racing.
export const REPLY_DRAIN_TIMEOUT_MS = 10 * 1000;

// YOLO MODE: Copilot has unrestricted tool access. Constituent flags
// (--allow-all-tools / --allow-all-paths / --allow-all-urls) are preferred
// over the --allow-all alias because the alias has github/copilot-cli#1652
// (still pauses for confirmation in some recent CLI versions).
//
// --experimental opts in to Copilot CLI experimental features like Rubber Duck
// (https://github.blog/ai-and-ml/github-copilot/github-copilot-cli-combines-model-families-for-a-second-opinion/)
// — a cross-model-family reviewer that activates automatically at checkpoints
// (after planning, after complex implementations, after writing tests). When
// the primary is a Claude model, Rubber Duck uses GPT-5.4 as the second
// opinion. It requires GPT-5.4 access on the user's Copilot subscription; if
// access is missing the flag is silently inert, no error.
const COPILOT_DEFAULT_MODEL = 'gpt-5.5';

// Read the host-routed effective model. lib/state.mjs chooses
// ~/.claude/agent-companion or ~/.codex/agent-companion from
// AGENT_COMPANION_HOST, so Codex and Claude config stay separate.
function readConfiguredModel() {
  try {
    const { model } = readDefaultModel();
    if (model) return model;
  } catch {}
  return COPILOT_DEFAULT_MODEL;
}

function normalizeModel(model) {
  const clean = String(model || '').trim();
  return clean || readConfiguredModel();
}

function isBlankText(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}

function isEmptyCompletedResult(result) {
  if (!result || typeof result !== 'object') return true;
  return isBlankText(result.message) &&
    isBlankText(result.thoughts) &&
    (!Array.isArray(result.toolCalls) || result.toolCalls.length === 0) &&
    !result.plan;
}

function buildCopilotFlags(model) {
  return [
    '--acp',
    '--model', normalizeModel(model),
    '--reasoning-effort', 'xhigh',
    '--no-ask-user',
    '--allow-all-tools',
    '--allow-all-paths',
    '--allow-all-urls',
    '--experimental',
  ];
}

// --- Logger ------------------------------------------------------------------
//
// COPILOT_DAEMON_LOG_LEVEL gates DEBUG output (default INFO). In normal
// operation DEBUG-level lines — every socket dispatch, every supervisor
// heartbeat — are dropped so the log stays readable during incidents. Flip
// to DEBUG when live-debugging. Higher-severity levels (WARN, ERROR, FATAL,
// COPILOT_STDERR) are always written regardless of the level setting.

const LOG_LEVEL = (process.env.COPILOT_DAEMON_LOG_LEVEL || 'INFO').toUpperCase();
const LOG_LEVEL_RANK = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, FATAL: 50 };
const LOG_THRESHOLD = LOG_LEVEL_RANK[LOG_LEVEL] ?? LOG_LEVEL_RANK.INFO;

function chmodPrivate(path) {
  try { chmodSync(path, PRIVATE_FILE_MODE); } catch {}
}

function writePrivateFile(path, content) {
  writeFileSync(path, content, { mode: PRIVATE_FILE_MODE });
  chmodPrivate(path);
}

function appendPrivateFile(path, content) {
  appendFileSync(path, content, { mode: PRIVATE_FILE_MODE });
  chmodPrivate(path);
}

function log(level, ...args) {
  // Always write WARN/ERROR/FATAL and any non-standard level (e.g. COPILOT_STDERR).
  const rank = LOG_LEVEL_RANK[level];
  if (rank !== undefined && rank < LOG_THRESHOLD) return;
  try {
    const logFile = daemonLogFile();
    if (existsSync(logFile) && statSync(logFile).size > LOG_MAX_BYTES) {
      writePrivateFile(logFile, '');
    }
    const ts = new Date().toISOString();
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    appendPrivateFile(logFile, `${ts} [${level}] ${msg}\n`);
  } catch {
    // best-effort logging
  }
}

function canonicalCwd(cwd) {
  if (!cwd) return null;
  try { return realpathSync(cwd); }
  catch { return String(cwd); }
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

function sameCwd(a, b) {
  const ca = canonicalCwd(a);
  const cb = canonicalCwd(b);
  return !!ca && !!cb && ca === cb;
}

// Log the full Copilot argv exactly once per daemon boot. Subsequent spawns
// log a compact summary so the daemon log doesn't drown in a dozen identical
// 300-char flag strings during a session with many prompts.
let _fullSpawnLogged = false;
function logSpawn(bin, flags) {
  if (!_fullSpawnLogged) {
    log('INFO', 'spawning copilot (full argv):', bin, flags.join(' '));
    _fullSpawnLogged = true;
    return;
  }
  const pick = (key) => {
    const i = flags.indexOf(key);
    return i >= 0 && i + 1 < flags.length ? flags[i + 1] : null;
  };
  const model = pick('--model') || '?';
  const effort = pick('--reasoning-effort') || '?';
  log('INFO', 'spawning copilot:', bin, `[model=${model} reasoning=${effort} flags=${flags.length}]`);
}

// Extract a preview string from an ACP tool_call_update's rawOutput/content.
// Copilot emits distinct shapes for success vs. failure (inspected in
// ~/Library/Caches/copilot/.../app.js): on success, rawOutput is a string or
// { content: string }; on failure, rawOutput is an Error-like object with
// { message, ... } and content is either undefined or an ACP content array
// of the form [{ type:'content', content:{ type:'text', text } }, ...]. The
// old extractor only knew the success shapes, so every failure previewed as
// null — the daemon, supervisor, and inspect summary all lost the error text.
function extractOutputPreview(update) {
  const ro = update.rawOutput;
  if (typeof ro === 'string') return ro.slice(0, 300);
  if (typeof ro?.content === 'string') return ro.content.slice(0, 300);
  if (typeof ro?.message === 'string') return ro.message.slice(0, 300);
  const content = update.content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const entry of content) {
      const text = entry?.content?.text ?? entry?.text;
      if (typeof text === 'string') parts.push(text);
    }
    if (parts.length) return parts.join('\n').slice(0, 300);
  }
  if (ro && typeof ro === 'object') {
    try { return JSON.stringify(ro).slice(0, 300); } catch { return null; }
  }
  return null;
}

// --- AcpConnection -----------------------------------------------------------

class AcpConnection {
  constructor() {
    this.child = null;
    this.requestId = 0;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this.sessionCollectors = new Map(); // sessionId -> { events, resolve, reject, timer }
    this.buffer = '';
    this.initialized = false;
    this.dead = false;
  }

  isAlive() {
    return this.child !== null && !this.dead && this.child.exitCode === null;
  }

  async spawn(cwd, model = null) {
    this.cwd = requireAbsoluteDirectoryCwd(cwd, 'spawn cwd');
    this.cwdReal = canonicalCwd(this.cwd);
    this.model = normalizeModel(model);
    const flags = buildCopilotFlags(this.model);
    const copilotBin = resolveCopilotBin();
    logSpawn(copilotBin, flags);
    log('INFO', `copilot process cwd=${this.cwd} model=${this.model}`);
    const OTEL_TRACES_PATH = otelTracesPath();
    // Rotate OTel traces file if it exceeds 1 MB (same threshold as daemon log).
    try {
      if (existsSync(OTEL_TRACES_PATH) && statSync(OTEL_TRACES_PATH).size > LOG_MAX_BYTES) {
        const backup = OTEL_TRACES_PATH + '.bak';
        try { unlinkSync(backup); } catch {}
        renameSync(OTEL_TRACES_PATH, backup);
      }
    } catch { /* best-effort rotation */ }

    this.child = spawn(copilotBin, flags, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        COPILOT_OTEL_ENABLED: 'true',
        COPILOT_OTEL_FILE_EXPORTER_PATH: OTEL_TRACES_PATH,
      },
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    this.child.stdout.on('data', (chunk) => this._onStdoutData(chunk));
    this.child.stderr.on('data', (chunk) => log('COPILOT_STDERR', chunk.trim()));

    this.child.on('error', (err) => {
      log('ERROR', 'copilot process error:', err.message);
      this._failAll(`copilot process error: ${err.message}`);
    });

    this.child.on('close', (code, signal) => {
      log('INFO', 'copilot process closed:', { code, signal });
      this.dead = true;
      this._failAll(`copilot process exited (code=${code}, signal=${signal})`);
    });
  }

  _onStdoutData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log('WARN', 'non-json line from copilot:', line.slice(0, 200));
      return;
    }

    // Response to a request (has id, has result/error)
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
      return;
    }

    // Notification (has method, no id)
    if (msg.method) {
      this._onNotification(msg);
    }
  }

  _onNotification(msg) {
    if (msg.method === 'session/update') {
      const params = msg.params || {};
      const sessionId = params.sessionId;
      const update = params.update || {};
      const collector = this.sessionCollectors.get(sessionId);
      if (!collector) return;

      let streamEvent = null;

      switch (update.sessionUpdate) {
        case 'agent_thought_chunk': {
          const text = update.content?.text || update.text || '';
          if (text) {
            collector.events.thoughtChunks.push(text);
            streamEvent = { type: 'thought', text };
          }
          break;
        }
        case 'agent_message_chunk': {
          const text = update.content?.text || update.text || '';
          if (text) {
            // When a thought/tool_call/plan interrupts the message stream,
            // Copilot's next message chunk arrives with no leading
            // whitespace, producing run-ons like "critique.The command..."
            // across the interruption. Insert a paragraph break at that
            // boundary — but skip if the prior chunk already ended with one.
            if (collector._messageNeedsBreak) {
              const last = collector.events.messageChunks.at(-1);
              if (typeof last !== 'string' || !/\n\s*$/.test(last)) {
                collector.events.messageChunks.push('\n\n');
              }
              collector._messageNeedsBreak = false;
            }
            collector.events.messageChunks.push(text);
            streamEvent = { type: 'message', text };
          }
          break;
        }
        case 'plan': {
          // ACP plan update — Copilot's strategy for the turn. Useful for
          // surfacing high-level intent to the user during long turns.
          const entries = update.entries || update.plan || [];
          if (Array.isArray(entries) && entries.length > 0) {
            collector.events.plans.push(entries);
            streamEvent = { type: 'plan', entries };
          }
          break;
        }
        case 'tool_call': {
          const tc = {
            toolCallId: update.toolCallId,
            name: update.title || update.kind || 'unknown',
            kind: update.kind || null,
            locations: update.locations || null,
            input: update.rawInput || null,
            status: update.status || 'pending',
            output: null,
          };
          collector.events.toolCalls.push(tc);
          streamEvent = {
            type: 'tool_call',
            toolCallId: tc.toolCallId,
            name: tc.name,
            kind: tc.kind,
            locations: tc.locations,
            input: tc.input,
          };
          break;
        }
        case 'tool_call_update': {
          const tc = collector.events.toolCalls.find((t) => t.toolCallId === update.toolCallId);
          if (tc) {
            tc.status = update.status || tc.status;
            if (update.locations) tc.locations = update.locations;
            if (update.rawOutput !== undefined) tc.output = update.rawOutput;
            else if (update.content) tc.output = update.content;
          }
          const outputPreview = extractOutputPreview(update);
          if (update.status === 'failed') {
            log('DEBUG', 'tool_call failed:', tc?.name || update.toolCallId, outputPreview ? `— ${outputPreview.slice(0, 120)}` : '(no error detail)');
          }
          streamEvent = {
            type: 'tool_call_update',
            toolCallId: update.toolCallId,
            status: update.status,
            outputPreview,
            name: tc?.name ?? null,
            kind: tc?.kind ?? null,
          };
          break;
        }
      }

      // Non-message events arriving after at least one message chunk mark
      // the stream as needing a paragraph break on the next resumption.
      // See the agent_message_chunk case for consumption.
      if (streamEvent && streamEvent.type !== 'message' && collector.events.messageChunks.length > 0) {
        collector._messageNeedsBreak = true;
      }

      if (streamEvent && collector.onEvent) {
        try {
          collector.onEvent(streamEvent);
        } catch (err) {
          log('WARN', 'onEvent callback failed:', err.message);
        }
      }
    }
  }

  _failAll(reason) {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
    for (const [sid, collector] of this.sessionCollectors) {
      clearTimeout(collector.timer);
      collector.reject(new Error(reason));
    }
    this.sessionCollectors.clear();
  }

  _sendRequest(method, params, timeoutMs = 60_000) {
    if (!this.isAlive()) return Promise.reject(new Error('copilot connection is not alive'));
    const id = ++this.requestId;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`request timeout (method=${method})`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  _sendNotification(method, params) {
    if (!this.isAlive()) throw new Error('copilot connection is not alive');
    const payload = { jsonrpc: '2.0', method, params };
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  async initialize() {
    const result = await this._sendRequest(
      'initialize',
      {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: { name: 'copilot-acp-daemon', version: '1.0.0' },
      },
      SPAWN_INIT_TIMEOUT_MS,
    );
    this.agentCapabilities = result?.agentCapabilities || result?.capabilities || null;
    log('INFO', 'initialize ok:', {
      agentInfo: result?.agentInfo,
      agentCapabilities: this.agentCapabilities,
    });
    this._sendNotification('notifications/initialized', {});
    this.initialized = true;
    return result;
  }

  async createSession(cwd) {
    const result = await this._sendRequest('session/new', { cwd, mcpServers: [] }, SPAWN_INIT_TIMEOUT_MS);
    log('INFO', 'session/new ok:', { sessionId: result?.sessionId });
    return result.sessionId;
  }

  async sendPrompt(sessionId, text, onEvent = null) {
    return new Promise((resolve, reject) => {
      const collector = {
        events: {
          sessionId,
          thoughtChunks: [],
          messageChunks: [],
          toolCalls: [],
          plans: [],
          stopReason: null,
        },
        // Set to true by non-message events (thought, tool_call, plan) after
        // at least one message chunk has arrived; consumed by the next
        // agent_message_chunk to insert a paragraph break. See
        // _onNotification:agent_message_chunk for the rationale.
        _messageNeedsBreak: false,
        onEvent,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.sessionCollectors.delete(sessionId);
          reject(new Error(PROMPT_TIMEOUT_ERROR));
        }, PROMPT_TIMEOUT_MS),
      };
      this.sessionCollectors.set(sessionId, collector);

      this._sendRequest(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text }] },
        PROMPT_TIMEOUT_MS,
      )
        .then((result) => {
          clearTimeout(collector.timer);
          this.sessionCollectors.delete(sessionId);
          // Build the clean response shape:
          //   thoughts: joined reasoning
          //   message: joined final response text
          //   toolCalls: condensed [{name, summary, status}]
          //   stopReason: end_turn / etc.
          const condensedToolCalls = collector.events.toolCalls.map((tc) => ({
            name: tc.name,
            kind: tc.kind,
            locations: tc.locations,
            input: tc.input,
            status: tc.status,
            // Only keep a short text preview of the output to avoid blowing up the response
            outputPreview:
              typeof tc.output === 'string'
                ? tc.output.slice(0, 500)
                : tc.output?.content?.slice?.(0, 500) ?? null,
          }));
          resolve({
            sessionId,
            thoughts: collector.events.thoughtChunks.join(''),
            message: collector.events.messageChunks.join(''),
            toolCalls: condensedToolCalls,
            // Latest plan (most recent plan update wins)
            plan: collector.events.plans.length > 0
              ? collector.events.plans[collector.events.plans.length - 1]
              : null,
            stopReason: result?.stopReason || 'unknown',
          });
        })
        .catch((err) => {
          clearTimeout(collector.timer);
          this.sessionCollectors.delete(sessionId);
          reject(err);
        });
    });
  }

  // Send ACP session/cancel notification. Copilot should abort the in-flight
  // turn and the prompt request will resolve with stopReason "cancelled".
  cancelSession(sessionId) {
    try {
      this._sendNotification('session/cancel', { sessionId });
      return true;
    } catch (err) {
      log('WARN', 'session/cancel failed:', err.message);
      return false;
    }
  }

  kill() {
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.kill('SIGTERM');
      } catch {}
    }
    this.dead = true;
    this._failAll('connection killed');
  }
}

// --- SessionManager ----------------------------------------------------------

function eventsFilePath(promptId) {
  return promptEventsPath(promptId);
}

// Set of all terminal status values for an in-flight prompt. The long-poll
// `watchPrompt` waiter resolves the moment the status moves into this set.
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stuck']);

class SessionManager {
  constructor() {
    this.connection = null;
    this.sessions = new Map(); // sessionId -> { cwd, promptCount, createdAt }
    this._sessionMutation = Promise.resolve();
    // promptId -> {
    //   sessionId, cwd, eventsFile, status, summary, error, stuckReason,
    //   stuckDetail, startedAt, terminalAt, retentionExpiresAt,
    //   startedAt, lastEventAt,
    //   _terminalWaiters: Array<(state) => void>,
    //   _interimWaiters: Array<(alert) => void>,  // resolved on alert; not a terminal
    //   _lastAlertTs: number | null,               // cooldown anchor for pollSupervisor
    //   _idleStamps: Set<60|120|240>,              // per-prompt one-shot log anchors
    //   _supervisor: <counters from Supervisor>
    // }
    this.inFlightPrompts = new Map(); // includes retained terminal prompts until TTL expiry
    this.inactivityTimer = null;
    this.supervisor = new Supervisor();
    this.superviseTimer = setInterval(() => this._superviseAll(), SILENCE_CHECK_INTERVAL_MS);
    // Allow Node to exit if this is the only remaining handle (defensive).
    if (this.superviseTimer.unref) this.superviseTimer.unref();

    // Supervisor heartbeat: counts _superviseAll() ticks so we can emit one
    // DEBUG line per minute per in-flight prompt. Absence of this line across
    // multiple minutes is a smoking gun for event-loop starvation (the fault
    // pattern that produced the mnzlczmu-43iw failure).
    this._superviseTickCount = 0;

    // Liveness watchdog (v6.1 A2). One lightweight setInterval at 1s cadence
    // timestamps _lastHeartbeatAt so _superviseAll can detect if the event
    // loop was starved between ticks. ON by default; opt out with
    // COPILOT_DAEMON_LIVENESS_WATCHDOG=0.
    this._lastHeartbeatAt = Date.now();
    if (process.env.COPILOT_DAEMON_LIVENESS_WATCHDOG !== '0') {
      this._livenessTimer = setInterval(() => {
        this._lastHeartbeatAt = Date.now();
      }, 1000);
      if (this._livenessTimer.unref) this._livenessTimer.unref();
    }
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

  _activePromptForCwdSwitch() {
    for (const state of this.inFlightPrompts.values()) {
      if (!TERMINAL_STATUSES.has(state.status)) return state;
    }
    return null;
  }

  _markTerminalState(state, patch = {}) {
    const terminalAt = patch.terminalAt || Date.now();
    Object.assign(state, patch, {
      terminalAt,
      retentionExpiresAt: terminalAt + PROMPT_RETENTION_MS,
    });
  }

  retireSession(sessionId, reason) {
    if (!sessionId) return false;
    const existed = this.sessions.delete(sessionId);
    if (this.connection && this.connection.isAlive()) {
      try { this.connection.cancelSession(sessionId); } catch {}
    }
    log('WARN', 'session retired:', `sessionId=${sessionId} reason=${reason} existed=${existed}`);
    return existed;
  }

  _gcExpiredPrompts(now = Date.now()) {
    for (const [promptId, state] of this.inFlightPrompts) {
      if (!TERMINAL_STATUSES.has(state.status)) continue;
      if (!state.retentionExpiresAt || state.retentionExpiresAt > now) continue;
      if (existsSync(state.eventsFile)) {
        try {
          unlinkSync(state.eventsFile);
        } catch {}
      }
      this.inFlightPrompts.delete(promptId);
      log('INFO', 'gc prompt:', promptId, `status=${state.status}`);
    }
  }

  // Drain every terminal waiter. Each receives a state snapshot. Also splices
  // any shared resolvers out of _interimWaiters so a resolver registered on
  // both arrays (see watchPrompt) doesn't fire twice.
  _drainTerminalWaiters(state) {
    if (!state._terminalWaiters || state._terminalWaiters.length === 0) return;
    const waiters = state._terminalWaiters;
    state._terminalWaiters = [];
    if (state._interimWaiters) {
      state._interimWaiters = state._interimWaiters.filter((w) => !waiters.includes(w));
    }
    for (const resolve of waiters) {
      try { resolve(state); } catch (err) { log('WARN', 'waiter resolver threw:', err.message); }
    }
  }

  // Drain interim waiters with an alert payload. Prompt stays running.
  // Splices shared resolvers out of _terminalWaiters so the same resolver
  // doesn't fire again on terminal drain.
  _drainInterimWaiters(state, alert) {
    if (!state._interimWaiters || state._interimWaiters.length === 0) return;
    const waiters = state._interimWaiters;
    state._interimWaiters = [];
    if (state._terminalWaiters) {
      state._terminalWaiters = state._terminalWaiters.filter((w) => !waiters.includes(w));
    }
    for (const resolve of waiters) {
      try { resolve({ interim: true, alert }); } catch (err) { log('WARN', 'interim resolver threw:', err.message); }
    }
  }

  // Emit a non-terminal alert: write a synthetic 'alert' event to the JSONL,
  // set the cooldown anchor, wake any long-polling watchers.
  _emitAlert(state, reason, tier) {
    const ts = Date.now();
    const alert = { reason, tier, ts };
    state._lastAlertTs = ts;
    try {
      appendPrivateFile(state.eventsFile, JSON.stringify({ type: 'alert', ...alert }) + '\n');
    } catch (err) {
      log('WARN', 'failed to write alert event:', err.message);
    }
    log('INFO', 'prompt alert:', state.promptId || '?', reason, `tier=${tier}`);
    this._drainInterimWaiters(state, alert);
  }

  // Called every SILENCE_CHECK_INTERVAL_MS by the superviseTimer setInterval.
  // Dispatches on pollSupervisor's action — 'alert' emits a non-terminal
  // notification; 'trip' cancels the prompt.
  //
  // Observability (Change 4):
  //   - Every 6 ticks (~60s) while there are in-flight prompts, emit a DEBUG
  //     heartbeat listing idle/age per prompt. Absence of this line across a
  //     multi-minute window is a smoking gun for event-loop starvation.
  //   - On the first tick where a prompt's idle crosses 60s / 120s / 240s,
  //     emit an INFO stamp EVEN IF pollSupervisor suppresses the real alert
  //     (e.g. during cooldown). Gives a clean timeline of what the supervisor
  //     saw, independent of what it did.
  //
  // Liveness (Change 9, flag-gated):
  //   - If COPILOT_DAEMON_LIVENESS_WATCHDOG=1 and _lastHeartbeatAt is stale
  //     by >30s, force-trip every in-flight prompt with reason
  //     `event_loop_starvation`. The 1s heartbeat interval means a healthy
  //     loop refreshes this well under 30s; staleness means the loop was
  //     blocked (the fault pattern behind the mnzlczmu-43iw failure).
  _superviseAll() {
    const now = Date.now();
    this._gcExpiredPrompts(now);
    if (this.inFlightPrompts.size === 0) return;

    // Liveness (flag-gated)
    if (this._livenessTimer && now - this._lastHeartbeatAt > 30_000) {
      const stale = now - this._lastHeartbeatAt;
      log('FATAL', 'event loop starvation detected:', `${stale}ms since last heartbeat — tripping all in-flight prompts`);
      for (const [, state] of this.inFlightPrompts) {
        if (state.status === 'running') {
          this._tripStuck(state, `event_loop_starvation:${Math.round(stale / 1000)}s`);
        }
      }
      return;
    }

    this._superviseTickCount++;
    const shouldHeartbeat = this._superviseTickCount % 6 === 0;

    for (const [pid, state] of this.inFlightPrompts) {
      if (state.status !== 'running') continue;
      const idle = now - state.lastEventAt;
      const age = now - state.startedAt;

      // One-shot idle stamps at 60/120/240s thresholds so the log shows what
      // the supervisor saw even when pollSupervisor suppresses action.
      if (!state._idleStamps) state._idleStamps = new Set();
      for (const t of [60, 120, 240]) {
        if (idle > t * 1000 && !state._idleStamps.has(t)) {
          state._idleStamps.add(t);
          log('INFO', 'supervisor idle stamp:', pid, `idle=${t}s age=${Math.round(age / 1000)}s`);
        }
      }

      const r = pollSupervisor(state, now);
      if (r.action === 'trip') {
        this._tripStuck(state, r.reason);
      } else if (r.action === 'alert') {
        this._emitAlert(state, r.reason, r.tier);
      }
    }

    if (shouldHeartbeat) {
      const summary = Array.from(this.inFlightPrompts.entries())
        .filter(([, s]) => s.status === 'running')
        .map(([pid, s]) => `${pid.slice(0, 8)}(idle=${Math.round((now - s.lastEventAt) / 1000)}s age=${Math.round((now - s.startedAt) / 1000)}s)`)
        .join(' ');
      if (summary) {
        log('DEBUG', 'supervise heartbeat:', `tick=${this._superviseTickCount} prompts=[${summary}]`);
      }
    }
  }

  // Common transition: status -> "stuck", set reason, append synthetic event,
  // optionally cancel the upstream Copilot session, drain waiters.
  //
  // opts.autoCancelOk (default true) controls whether we send session/cancel.
  // Loops set autoCancelOk:false because the caller may want to inspect the
  // exact failing context without racing an upstream cancellation cleanup.
  _tripStuck(state, reason, opts = {}) {
    if (state.status !== 'running') return; // already terminal
    const autoCancelOk = opts.autoCancelOk !== false;
    this._markTerminalState(state, {
      status: 'stuck',
      stuckReason: reason,
      stuckDetail: opts.detail || null,
      autoCancelledBySupervisor: autoCancelOk,
    });
    const detail = opts.detail ? ` ${opts.detail}` : '';
    log('WARN', 'prompt stuck:', state.promptId || '?', reason + detail, autoCancelOk ? '(cancelling)' : '(no-cancel)');
    try {
      const line = JSON.stringify({ type: 'stuck', reason, ts: Date.now() }) + '\n';
      appendPrivateFile(state.eventsFile, line);
    } catch (err) {
      log('WARN', 'failed to write stuck event:', err.message);
    }
    if (autoCancelOk && this.connection && this.connection.isAlive()) {
      try { this.connection.cancelSession(state.sessionId); } catch {}
    }
    this._drainTerminalWaiters(state);
  }

  async ensureConnection(cwd, model = null) {
    const requestedCwd = requireAbsoluteDirectoryCwd(cwd, 'session cwd');
    const requestedReal = canonicalCwd(requestedCwd);
    const requestedModel = normalizeModel(model);
    if (this.connection && this.connection.isAlive() && this.connection.initialized) {
      const currentReal = this.connection.cwdReal || canonicalCwd(this.connection.cwd);
      const currentModel = this.connection.model || readConfiguredModel();
      if ((!currentReal || currentReal === requestedReal) && currentModel === requestedModel) return this.connection;

      const active = this._activePromptForCwdSwitch();
      if (active) {
        const modelMismatch = currentModel !== requestedModel;
        const err = new Error(
          modelMismatch
            ? `cannot switch Copilot model from ${currentModel || '(unknown)'} to ${requestedModel}: ` +
              `prompt ${active.promptId} is still ${active.status}`
            : `cannot switch Copilot cwd from ${this.connection.cwd || '(unknown)'} to ${requestedCwd}: ` +
          `prompt ${active.promptId} is still ${active.status}`,
        );
        err.code = modelMismatch ? 'MODEL_BUSY' : 'CWD_BUSY';
        err.existingPromptId = active.promptId;
        err.sessionId = active.sessionId;
        throw err;
      }

      log('INFO', `connection config changed: respawning Copilot (` +
        `cwd ${this.connection.cwd || '(unknown)'} -> ${requestedCwd}, ` +
        `model ${currentModel || '(unknown)'} -> ${requestedModel})`);
      this.connection.kill();
      this.connection = null;
      if (this.sessions.size > 0) {
        log('INFO', `connection config change: invalidating ${this.sessions.size} stale session(s)`);
        this.sessions.clear();
      }
    }
    // Memoize the in-flight spawn so parallel callers don't race to spawn
    // multiple Copilot subprocesses (which would cause "Session not found"
    // errors when sessions registered on orphaned subprocesses are later used
    // via the surviving `this.connection` reference).
    if (this._pendingConnection) {
      await this._pendingConnection;
      return this.ensureConnection(requestedCwd, requestedModel);
    }
    this._pendingConnection = (async () => {
      try {
        if (this.connection) {
          this.connection.kill();
          this.connection = null;
          // Every sid in this.sessions was registered with the dead child
          // (Copilot's --acp sessions are process-local — github/copilot-cli#1767).
          // After respawning, none of those sids are valid. Wipe the map so
          // a later prompt-bg with a stale sid hits the rebirth branch
          // (sidKnown=false) instead of falsely passing startPromptBg's local
          // has() check and reaching the new Copilot child with a sid it
          // never created. Without this clear, a stale sid combined with a
          // healthy new connection produces 'Session not found' from Copilot
          // instead of a clean sessionReborn signal.
          if (this.sessions.size > 0) {
            log('INFO', `connection respawn: invalidating ${this.sessions.size} stale session(s)`);
            this.sessions.clear();
          }
        }
        const conn = new AcpConnection();
        await conn.spawn(requestedCwd, requestedModel);
        await conn.initialize();
        this.connection = conn;
        this._resetInactivityTimer();
        return conn;
      } finally {
        this._pendingConnection = null;
      }
    })();
    return this._pendingConnection;
  }

  async _startSessionUnlocked(cwd, model = null) {
    const requestedCwd = requireAbsoluteDirectoryCwd(cwd, 'session cwd');
    const requestedModel = normalizeModel(model);
    const conn = await this.ensureConnection(requestedCwd, requestedModel);
    const sessionId = await conn.createSession(requestedCwd);
    this.sessions.set(sessionId, {
      cwd: requestedCwd,
      cwdReal: canonicalCwd(requestedCwd),
      model: requestedModel,
      promptCount: 0,
      createdAt: Date.now(),
    });
    // Echo the resolved cwd into the daemon log so post-mortems can
    // confirm Copilot rooted where the bridge intended. ACP's session/new
    // accepts cwd silently and gives no read-back, so a daemon-side log
    // line is the only observable signal that the value was honored.
    log('INFO', `session/new cwd=${requestedCwd || '(none)'} model=${requestedModel} sessionId=${sessionId}`);
    this._resetInactivityTimer();
    return sessionId;
  }

  async startSession(cwd, model = null) {
    return this._withSessionMutation(() => this._startSessionUnlocked(cwd, model));
  }

  // v6.1 C1: SessionManager.sendPrompt (blocking) and the matching IPC
  // commands `start`, `prompt`, `prompt-auto` were never reached from the
  // bridge (it always uses prompt-bg). Removed to shrink the surface.

  // Start a prompt in the background. Writes streaming events to a JSONL file
  // and returns immediately with a promptId. Use watchPrompt to poll progress
  // and cancelPrompt to interrupt.
  async startPromptBg(sessionId, text) {
    if (!this.connection || !this.connection.isAlive()) {
      throw new Error('no active connection — call start first');
    }
    if (!this.sessions.has(sessionId)) {
      throw new Error(`unknown sessionId: ${sessionId}`);
    }

    // Per-session prompt mutex. AcpConnection.sendPrompt keys its event
    // collector by sessionId and unconditionally overwrites; if we start a
    // second prompt while the prior one is still non-terminal (running OR
    // cancelling), the prior collector is silently amputated and JSON-RPC
    // resolutions cross-contaminate. Refuse the second start and surface
    // SESSION_BUSY so the bridge can reattach instead of colliding.
    //
    // No exemption for the reply path: replyPrompt must wait for the prior
    // state to reach TERMINAL_STATUSES (drain cap = REPLY_DRAIN_TIMEOUT_MS)
    // before re-entering this method. That's the only legitimate way to
    // start a new prompt on the same session.
    for (const prior of this.inFlightPrompts.values()) {
      if (prior.sessionId !== sessionId) continue;
      if (TERMINAL_STATUSES.has(prior.status)) continue;
      const err = new Error(`session busy: prompt ${prior.promptId} is in flight (status=${prior.status})`);
      err.code = 'SESSION_BUSY';
      err.existingPromptId = prior.promptId;
      err.sessionId = sessionId;
      throw err;
    }

    const promptId = randomUUID();
    const eventsFile = eventsFilePath(promptId);
    const sessionMeta = this.sessions.get(sessionId);
    // Reset / create the file
    writePrivateFile(eventsFile, '');

    const state = {
      promptId,
      sessionId,
      cwd: sessionMeta?.cwd || null,
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
      _terminalWaiters: [],
      _interimWaiters: [],
      _lastAlertTs: null,
    };
    this.inFlightPrompts.set(promptId, state);

    const writeEvent = (event) => {
      try {
        const line = JSON.stringify({ ...event, ts: Date.now() }) + '\n';
        appendPrivateFile(eventsFile, line);
        state.lastEventAt = Date.now();
      } catch (err) {
        log('WARN', 'failed to write event:', err.message);
      }
      // Supervisor event-level detection: only while still running. Skip
      // synthetic lifecycle events — they're not Copilot output.
      if (state.status !== 'running') return;
      if (event.type === 'start' || event.type === 'done' || event.type === 'error'
          || event.type === 'cancelled' || event.type === 'stuck' || event.type === 'alert') return;
      // Mark first real event so pollSupervisor switches from the
      // first-event-silence thresholds to the post-first-event ones.
      state._hasFirstRealEvent = true;
      try {
        const r = this.supervisor.observe(event, state);
        if (r.action === 'trip') {
          this._tripStuck(state, r.reason, { autoCancelOk: r.autoCancelOk !== false, detail: r.detail });
        }
      } catch (err) {
        log('WARN', 'supervisor observe threw:', err.message);
      }
    };

    // Initial start event
    writeEvent({ type: 'start', sessionId, promptId });

    // Fire and don't await — the IPC handler returns immediately
    this.connection
      .sendPrompt(sessionId, text, writeEvent)
      .then((result) => {
        // The daemon may have already moved this prompt to a terminal state
        // (e.g., the supervisor trip transitioned to "stuck" and called
        // cancelSession). If so, don't overwrite the status — but DO drain
        // any waiters that registered after the stuck transition.
        if (state.status === 'running') {
          if (isEmptyCompletedResult(result)) {
            this.retireSession(sessionId, 'empty_completed');
            this._markTerminalState(state, {
              status: 'failed',
              error: EMPTY_COMPLETED_ERROR,
              stuckDetail: 'empty_completed',
              sessionRetired: true,
            });
            writeEvent({ type: 'error', error: EMPTY_COMPLETED_ERROR, detail: 'empty_completed' });
          } else {
            this._markTerminalState(state, {
              status: 'completed',
              summary: result,
            });
            writeEvent({ type: 'done', stopReason: result?.stopReason || 'end_turn', summary: result });
          }
        } else if (state.status === 'cancelling') {
          this._markTerminalState(state, { status: 'cancelled' });
          writeEvent({ type: 'cancelled', stopReason: result?.stopReason || 'cancelled' });
        }
        // For any other already-terminal state (stuck), keep the existing reason.
        const meta = this.sessions.get(sessionId);
        if (meta) meta.promptCount += 1;
        this._resetInactivityTimer();
        this._drainTerminalWaiters(state);
      })
      .catch((err) => {
        if (state.status === 'running') {
          const promptTimedOut = err?.message === PROMPT_TIMEOUT_ERROR;
          if (promptTimedOut) this.retireSession(sessionId, 'prompt_timeout');
          this._markTerminalState(state, {
            status: 'failed',
            error: err.message,
            sessionRetired: promptTimedOut,
          });
          writeEvent({ type: 'error', error: err.message, detail: promptTimedOut ? 'prompt_timeout' : undefined });
        } else if (state.status === 'cancelling') {
          this._markTerminalState(state, {
            status: 'cancelled',
            error: null,
            stuckDetail: err.message,
          });
          writeEvent({ type: 'cancelled', stopReason: 'cancelled', detail: err.message });
        }
        this._resetInactivityTimer();
        this._drainTerminalWaiters(state);
      });

    this._resetInactivityTimer();
    return { promptId, sessionId, eventsFile };
  }

  // Watch / long-poll a prompt.
  //
  // Returns synchronously by default (back-compat with old `watch --since`).
  // When opts.wait > 0, this method becomes async and may block until the
  // prompt reaches a terminal status, the wait budget expires, or both.
  // When opts.summaryOnly is true, the response strips the events array
  // entirely — useful for the agent-bridge worker which only cares about
  // terminal state and summary.
  async watchPrompt(promptId, since = 0, opts = {}) {
    const state = this.inFlightPrompts.get(promptId);
    if (!state) throw new Error(`unknown promptId: ${promptId}`);

    const wait = Math.max(0, Math.min(Number(opts.wait) || 0, MAX_LONG_POLL_WAIT_MS / 1000));

    let interimAlert = null;
    if (wait > 0 && !TERMINAL_STATUSES.has(state.status)) {
      // Long-poll path: register a one-shot resolver on BOTH terminal and
      // interim waiter arrays so the watch can return on either event type.
      // The drain helpers cross-splice to prevent double-firing.
      interimAlert = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          const tIdx = state._terminalWaiters.indexOf(resolver);
          if (tIdx >= 0) state._terminalWaiters.splice(tIdx, 1);
          const iIdx = state._interimWaiters.indexOf(resolver);
          if (iIdx >= 0) state._interimWaiters.splice(iIdx, 1);
          resolve(null);
        }, wait * 1000);
        const resolver = (payload) => {
          clearTimeout(timer);
          // payload is either the state (terminal drain) or { interim, alert }
          if (payload && payload.interim) {
            resolve(payload.alert);
          } else {
            resolve(null);
          }
        };
        state._terminalWaiters.push(resolver);
        state._interimWaiters.push(resolver);
      });
    }

    // Build the response. Re-read the events file lazily — even on the long-poll
    // path, the caller may want to see new events that arrived during the wait.
    let lines = [];
    if (!opts.summaryOnly) {
      try {
        const content = readFileSync(state.eventsFile, 'utf8');
        lines = content.split('\n').filter((l) => l.trim().length > 0);
      } catch (err) {
        log('WARN', 'failed to read events file:', err.message);
      }
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
      // interim alert, if the long-poll was woken by _emitAlert rather than
      // a terminal transition. Status stays 'running' in this case; caller
      // should re-call watch to continue waiting for terminal.
      interim: interimAlert ? true : false,
      alert: interimAlert,
      sessionRetired: !!state.sessionRetired,
    };

    if (opts.summaryOnly) {
      // Summary-only mode: caller does NOT want the events array. This is
      // the path the agent-bridge MCP server uses — one tiny payload
      // per delegation regardless of how many raw events Copilot emitted.
      return baseResponse;
    }

    const rawEvents = lines.slice(since).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { type: 'parse_error', raw: l.slice(0, 200) };
      }
    });

    // Coalesce consecutive thought/message chunks into single events. Copilot
    // streams text in tiny ~5-13 char chunks, which produces 100+ events for a
    // small response. Merging them gives a ~10-15x reduction in response size
    // (and thus the tokens Claude consumes per `watch` poll). Pass --raw to
    // skip coalescing for debugging.
    const events = opts.raw ? rawEvents : coalesceTextChunks(rawEvents);

    return { ...baseResponse, events };
  }

  inspectPrompt(promptId, opts = {}) {
    const state = this.inFlightPrompts.get(promptId);
    if (!state) throw new Error(`unknown promptId: ${promptId}`);

    let events = [];
    try {
      events = parseJsonlEvents(readFileSync(state.eventsFile, 'utf8'));
    } catch (err) {
      log('WARN', 'failed to read inspect events file:', err.message);
    }

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
        sessionRetired: !!state.sessionRetired,
      },
      events,
      {
        includeTimeline: opts.includeTimeline !== false,
        limit: opts.limit,
      },
    );
  }

  // v6.1 D2: Reply mechanism. ACP has no native "inject mid-turn" primitive,
  // so the safe primitive is cancel-the-current-turn + start-a-fresh-turn on
  // the same Copilot session. The follow-up text is wrapped so Copilot knows
  // the previous turn was interrupted intentionally, not because of an error.
  //
  // Concurrency: a per-prompt `replyInFlight` lock prevents two overlapping
  // replies racing the cancel/start sequence on the same session.
  async replyPrompt(promptId, message) {
    const state = this.inFlightPrompts.get(promptId);
    if (!state) throw new Error(`unknown promptId: ${promptId}`);
    if (state.status !== 'running') {
      return { ok: false, reason: `prompt is ${state.status}` };
    }
    if (state.replyInFlight) {
      return { ok: false, reason: 'reply already in flight for this prompt' };
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return { ok: false, reason: 'message must be a non-empty string' };
    }
    if (!this.connection || !this.connection.isAlive()) {
      return { ok: false, reason: 'no active connection' };
    }
    state.replyInFlight = true;
    const sessionId = state.sessionId;
    try {
      // Cancel the in-flight turn and wait for it to actually reach a
      // terminal state. Failing to wait would let us re-enter
      // startPromptBg while AcpConnection.sendPrompt's collector for this
      // session is still mapped to the cancelled prompt — replacement
      // would overwrite it and trigger the duplicate-prompt collision.
      // REPLY_DRAIN_TIMEOUT_MS caps the wait; on expiry we return a
      // structured failure rather than racing.
      this.cancelPrompt(promptId);
      const drained = await new Promise((resolve) => {
        if (TERMINAL_STATUSES.has(state.status)) return resolve(true);
        const timer = setTimeout(() => {
          const idx = state._terminalWaiters.indexOf(resolver);
          if (idx >= 0) state._terminalWaiters.splice(idx, 1);
          resolve(false);
        }, REPLY_DRAIN_TIMEOUT_MS);
        const resolver = () => {
          clearTimeout(timer);
          // Belt-and-suspenders: the drain helper resolves us before the
          // status flip becomes observable in some orderings; double-check
          // before declaring success.
          resolve(TERMINAL_STATUSES.has(state.status));
        };
        state._terminalWaiters.push(resolver);
      });

      if (!drained) {
        log('WARN', 'reply timeout: prior turn did not drain:', promptId, `status=${state.status}`);
        return { ok: false, reason: 'reply timeout: prior turn did not drain' };
      }

      const merged = [
        'CONTINUATION (user follow-up while you were working):',
        '',
        'Your previous turn was cancelled intentionally so the user could',
        'add the following context. Incorporate it and continue the same',
        'underlying task — do not start over from scratch.',
        '',
        '--- USER FOLLOW-UP ---',
        message.trim(),
      ].join('\n');

      const startResult = await this.startPromptBg(sessionId, merged);
      return {
        ok: true,
        original_prompt_id: promptId,
        new_prompt_id: startResult.promptId,
        session_id: sessionId,
      };
    } finally {
      state.replyInFlight = false;
    }
  }

  cancelPrompt(promptId) {
    const state = this.inFlightPrompts.get(promptId);
    if (!state) throw new Error(`unknown promptId: ${promptId}`);
    if (state.status !== 'running') {
      return { cancelled: false, reason: `prompt is ${state.status}` };
    }
    if (!this.connection || !this.connection.isAlive()) {
      return { cancelled: false, reason: 'no active connection' };
    }
    state.status = 'cancelling';
    const sent = this.connection.cancelSession(state.sessionId);
    return { cancelled: true, ackSent: sent };
  }

  forgetPrompt(promptId) {
    const state = this.inFlightPrompts.get(promptId);
    if (!state) return { forgotten: false };
    if (existsSync(state.eventsFile)) {
      try {
        unlinkSync(state.eventsFile);
      } catch {}
    }
    this.inFlightPrompts.delete(promptId);
    return { forgotten: true };
  }

  getStatus() {
    return {
      connected: this.connection?.isAlive() ?? false,
      initialized: this.connection?.initialized ?? false,
      pid: this.connection?.child?.pid ?? null,
      connectionCwd: this.connection?.cwd ?? null,
      activeModel: this.connection?.model ?? null,
      agentCapabilities: this.connection?.agentCapabilities ?? null,
      configuredModel: readConfiguredModel(),
      sessions: Array.from(this.sessions.entries()).map(([sid, meta]) => ({
        sessionId: sid,
        cwd: meta.cwd,
        model: meta.model || null,
        promptCount: meta.promptCount,
        createdAt: meta.createdAt,
      })),
      inFlightPrompts: Array.from(this.inFlightPrompts.entries()).map(([pid, state]) => ({
        promptId: pid,
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

  shutdown() {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
    if (this.superviseTimer) clearInterval(this.superviseTimer);
    this.superviseTimer = null;
    if (this._livenessTimer) clearInterval(this._livenessTimer);
    this._livenessTimer = null;
    if (this.connection) {
      this.connection.kill();
      this.connection = null;
    }
    this.sessions.clear();
    // Drain any pending long-poll waiters with the current state so callers
    // don't hang on a daemon that's about to exit.
    for (const [, state] of this.inFlightPrompts) {
      if (state.status === 'running') {
        state.status = 'failed';
        state.error = 'daemon shutdown';
      }
      this._drainTerminalWaiters(state);
    }
    // Clean up any leftover event files
    for (const [, state] of this.inFlightPrompts) {
      if (existsSync(state.eventsFile)) {
        try {
          unlinkSync(state.eventsFile);
        } catch {}
      }
    }
    this.inFlightPrompts.clear();
  }

  // Count prompts that are NOT in a terminal state. inFlightPrompts retains
  // terminal entries until TTL expiry, so its raw size is not a safe signal
  // for "anything still running". v6.1 A3.
  activePrompts() {
    let n = 0;
    for (const [, state] of this.inFlightPrompts) {
      if (!TERMINAL_STATUSES.has(state.status)) n++;
    }
    return n;
  }

  // Trip any "running" prompt that has had no event movement for
  // INACTIVITY_TIMEOUT_MS * 2. Failsafe so a stuck-counter bug can't keep
  // the daemon alive forever (v6.1 A3 follow-up).
  _tripDormantPrompts(now = Date.now()) {
    const limit = INACTIVITY_TIMEOUT_MS * 2;
    for (const [, state] of this.inFlightPrompts) {
      if (TERMINAL_STATUSES.has(state.status)) continue;
      const idle = now - (state.lastEventAt || state.startedAt || now);
      if (idle > limit) {
        this._tripStuck(state, `dormant_failsafe:${Math.round(idle / 1000)}s`, { autoCancelOk: true });
      }
    }
  }

  _resetInactivityTimer() {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => this._onInactivityTick(), INACTIVITY_TIMEOUT_MS);
  }

  _onInactivityTick() {
    const now = Date.now();
    // Failsafe before deciding: trip any prompt whose status says "running"
    // but has had no event movement for INACTIVITY_TIMEOUT_MS * 2 — protects
    // against a leaked active counter holding the daemon alive forever.
    this._tripDormantPrompts(now);
    if (this.activePrompts() > 0) {
      // Real work in flight; reschedule a short check, do not exit.
      log('DEBUG', 'inactivity tick: prompts still active, reschedule');
      this.inactivityTimer = setTimeout(() => this._onInactivityTick(), 60_000);
      return;
    }
    // Host-liveness extension: if any host session has touched its heartbeat
    // within HOST_LIVENESS_TTL_MS, the parent (Claude/Codex) is still active
    // and we keep the Copilot child alive for it. Without this gate, the 15-min
    // idle timer would kill the subprocess mid-session and force a rebirth (and
    // context loss) on the next prompt-bg.
    const liveSid = this._findLiveHeartbeat(now);
    if (liveSid) {
      log('INFO', `inactivity tick: host ${liveSid} still active (heartbeat fresh) — extending`);
      this.inactivityTimer = setTimeout(() => this._onInactivityTick(), 60_000);
      return;
    }
    log('INFO', 'inactivity timeout — shutting down');
    this.shutdown();
    process.exit(0);
  }

  // Scan HEARTBEAT_DIR for the freshest per-host-sid heartbeat. Returns the
  // sid (basename minus extension) if any heartbeat is within HOST_LIVENESS_TTL_MS,
  // else null. Sweeps heartbeats older than HEARTBEAT_STALE_AFTER_MS as a side
  // effect — keeps the dir from growing unbounded across orphaned sessions
  // (parent process crash, OS reboot, etc).
  //
  // I/O lives here; classification (TTL boundary, freshest-of-many,
  // stale-unlink predicate) is in lib/heartbeat.mjs so it can be unit-tested.
  _findLiveHeartbeat(now = Date.now()) {
    let names;
    const dir = heartbeatDir();
    try { names = readdirSync(dir); }
    catch { return null; } // dir doesn't exist → no hosts yet
    const entries = [];
    for (const name of names) {
      if (!name.endsWith('.heartbeat')) continue;
      try {
        const stat = statSync(`${dir}/${name}`);
        entries.push({ name, mtimeMs: stat.mtimeMs });
      } catch { /* file vanished between readdir and stat — skip */ }
    }
    const { liveSid, staleToUnlink } = selectLiveHeartbeat({
      entries, nowMs: now,
      liveTtlMs: HOST_LIVENESS_TTL_MS,
      staleAfterMs: HEARTBEAT_STALE_AFTER_MS,
    });
    for (const name of staleToUnlink) {
      try { unlinkSync(`${dir}/${name}`); } catch {}
    }
    return liveSid;
  }
}

// --- IpcServer ---------------------------------------------------------------

class IpcServer {
  constructor(manager) {
    this.manager = manager;
    this.server = null;
  }

  async start() {
    const socketPath = daemonSocketPath();
    // Stale socket detection: try to connect; if refused, unlink
    if (existsSync(socketPath)) {
      try {
        if (lstatSync(socketPath).isSymbolicLink()) {
          log('ERROR', 'socket path is a symlink; refusing to use it:', socketPath);
          console.error('refusing symlink socket path', socketPath);
          process.exit(1);
        }
      } catch {}
      const inUse = await new Promise((resolve) => {
        const probe = connectSocket(socketPath);
        probe.on('connect', () => {
          probe.end();
          resolve(true);
        });
        probe.on('error', () => resolve(false));
      });
      if (inUse) {
        log('ERROR', 'socket already in use, daemon already running');
        console.error('daemon already running at', socketPath);
        process.exit(1);
      }
      try {
        unlinkSync(socketPath);
      } catch {}
    }

    // allowHalfOpen: true so the server can still write the response after
    // the client has half-closed the write side (sent its message + EOF).
    this.server = createServer({ allowHalfOpen: true }, (sock) => this._onConnection(sock));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(socketPath, () => {
        // v6.1 A6: lock the socket to the owning user so other accounts on
        // the host cannot speak to the daemon. Default umask leaves it 0666.
        try { chmodSync(socketPath, 0o600); }
        catch (err) { log('WARN', 'chmod socket failed:', err.message); }
        log('INFO', 'listening on', socketPath);
        resolve();
      });
    });
  }

  _onConnection(sock) {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
    });
    sock.on('end', async () => {
      let response;
      try {
        const msg = JSON.parse(buf);
        response = await this._dispatch(msg);
      } catch (err) {
        response = { ok: false, error: err.message };
      }
      try {
        sock.end(JSON.stringify(response) + '\n');
      } catch {}
    });
    sock.on('error', (err) => log('WARN', 'socket error:', err.message));
  }

  async _dispatch(msg) {
    // v6.1 E1: stamp the inbound req_id on every dispatch line so server,
    // daemon, and client logs can be joined.
    log('DEBUG', 'dispatch:', msg.command, msg.reqId ? `req=${msg.reqId}` : '');
    switch (msg.command) {
      case 'prompt-bg': {
        return this.manager._withSessionMutation(async () => {
          // Start a session if no sessionId given (auto mode), then register
          // the prompt before releasing the session/connection lock. This
          // closes the cold-start race where a different-cwd caller could kill
          // the process between session/new and startPromptBg.
          let sessionId = msg.sessionId;
          let sessionReborn = false;
          let requestedCwd;
          try {
            requestedCwd = requireAbsoluteDirectoryCwd(msg.cwd, 'prompt-bg cwd');
          } catch (err) {
            return { ok: false, code: 'CWD_REQUIRED', error: err.message };
          }
          const requestedModel = normalizeModel(msg.model);
          if (sessionId) {
            const conn = this.manager.connection;
            const connAlive = !!(conn && conn.isAlive() && conn.initialized);
            const sidKnown = this.manager.sessions.has(sessionId);
            if (!connAlive || !sidKnown) {
              log('WARN', `prompt-bg: stale sessionId ${sessionId} (connAlive=${connAlive} sidKnown=${sidKnown}) — minting fresh session`);
              this.manager.sessions.delete(sessionId);
              sessionId = null;
              sessionReborn = true;
            } else {
              const meta = this.manager.sessions.get(sessionId);
              const cwdMismatch = meta?.cwd && !sameCwd(meta.cwd, requestedCwd);
              const modelMismatch = meta?.model && meta.model !== requestedModel;
              if (cwdMismatch || modelMismatch) {
                const activeForSession = [...this.manager.inFlightPrompts.values()]
                  .find((state) => state.sessionId === sessionId && !TERMINAL_STATUSES.has(state.status));
                if (activeForSession) {
                  const code = modelMismatch ? 'MODEL_BUSY' : 'SESSION_BUSY';
                  return {
                    ok: false,
                    code,
                    error: `session ${modelMismatch ? 'model' : 'cwd'} switch blocked: prompt ${activeForSession.promptId} is still ${activeForSession.status}`,
                    data: {
                      existingPromptId: activeForSession.promptId,
                      sessionId,
                    },
                  };
                }
                log('WARN', `prompt-bg: session config changed for ${sessionId} ` +
                  `(cwd ${meta?.cwd || '(unknown)'} -> ${requestedCwd}, model ${meta?.model || '(unknown)'} -> ${requestedModel}) — minting fresh session`);
                this.manager.sessions.delete(sessionId);
                sessionId = null;
                sessionReborn = true;
              }
            }
          }
          try {
            if (!sessionId) {
              sessionId = await this.manager._startSessionUnlocked(requestedCwd, requestedModel);
            }
            const data = await this.manager.startPromptBg(sessionId, msg.text);
            return { ok: true, data: { ...data, activeModel: this.manager.connection?.model || requestedModel, sessionReborn } };
          } catch (err) {
            if (err && ['SESSION_BUSY', 'CWD_BUSY', 'MODEL_BUSY'].includes(err.code)) {
              log('WARN', 'prompt-bg refused:', `code=${err.code} sid=${err.sessionId} existing=${err.existingPromptId}`);
              return {
                ok: false,
                code: err.code,
                error: err.message,
                data: {
                  existingPromptId: err.existingPromptId,
                  sessionId: err.sessionId,
                },
              };
            }
            throw err;
          }
        });
      }
      case 'watch': {
        const data = await this.manager.watchPrompt(msg.promptId, msg.since || 0, {
          raw: !!msg.raw,
          wait: msg.wait || 0,
          summaryOnly: !!msg.summaryOnly,
        });
        return { ok: true, data };
      }
      case 'inspect': {
        const data = this.manager.inspectPrompt(msg.promptId, {
          includeTimeline: msg.includeTimeline !== false,
          limit: msg.limit,
        });
        return { ok: true, data };
      }
      case 'cancel': {
        const data = this.manager.cancelPrompt(msg.promptId);
        return { ok: true, data };
      }
      case 'reply': {
        // v6.1 D2: peer-steering. Cancels the in-flight prompt and starts a
        // new one on the same Copilot session with the user's follow-up
        // text. Returns the new promptId so the bridge can re-link the
        // job_id without emitting a notification mid-stream.
        const data = await this.manager.replyPrompt(msg.promptId, msg.message);
        return { ok: data.ok !== false, data };
      }
      case 'forget': {
        const data = this.manager.forgetPrompt(msg.promptId);
        return { ok: true, data };
      }
      case 'status': {
        return { ok: true, data: this.manager.getStatus() };
      }
      case 'stop': {
        this.manager.shutdown();
        setTimeout(() => process.exit(0), 50);
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown command: ${msg.command}` };
    }
  }

  cleanup() {
    if (this.server) {
      try {
        this.server.close();
      } catch {}
    }
    const socketPath = daemonSocketPath();
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {}
    }
  }
}

// --- Exports + Main ---------------------------------------------------------

// Importable for unit tests. Tests instantiate SessionManager with a stub
// AcpConnection (see scripts/copilot-acp-daemon.test.mjs) to exercise the
// per-session mutex and reply drain without spawning a Copilot subprocess
// or opening the IPC socket. Production callers always go through the
// `isMain` startup path below.
export {
  SessionManager,
  AcpConnection,
  IpcServer,
  TERMINAL_STATUSES,
};

// Match server.mjs's isMain detection — realpathSync on both sides so a
// symlinked argv[1] still matches import.meta.url.
const isMain = (() => {
  try {
    const argvReal = realpathSync(process.argv[1]);
    const metaReal = realpathSync(fileURLToPath(import.meta.url));
    return argvReal === metaReal;
  } catch { return false; }
})();

if (isMain) {
  const manager = new SessionManager();
  const server = new IpcServer(manager);

  const cleanupAndExit = (code) => {
    log('INFO', 'shutting down', { code });
    manager.shutdown();
    server.cleanup();
    process.exit(code);
  };

  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));
  process.on('uncaughtException', (err) => {
    log('FATAL', 'uncaughtException:', err.stack || err.message);
    cleanupAndExit(1);
  });
  process.on('unhandledRejection', (err) => {
    log('FATAL', 'unhandledRejection:', err?.stack || String(err));
  });
  // Catch-all: if anything calls process.exit() directly (e.g. the stop
  // command, inactivity timer), still unlink the socket. exit handlers
  // must be synchronous.
  process.on('exit', () => {
    const socketPath = daemonSocketPath();
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {}
    }
  });

  server.start().catch((err) => {
    log('FATAL', 'failed to start server:', err.message);
    console.error('failed to start daemon:', err.message);
    process.exit(1);
  });
}
