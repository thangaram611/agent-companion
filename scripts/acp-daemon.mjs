#!/usr/bin/env node
// acp-daemon.mjs
// Long-lived daemon that owns ONE native ACP agent (`copilot --acp`, Google's
// `agy_acp_server.par`; any agent with an `acp` block on its descriptor) over
// stdio and exposes it over a Unix domain socket. Speaks JSON-RPC 2.0 (Agent
// Client Protocol v1) to the agent, simple JSON over the socket to clients. One daemon per companion per
// host home: each has its own socket, log and prompt streams
// (lib/runtime-paths.mjs keys them by companion).
//
// Everything companion-shaped is read from the descriptor's `acp` block in
// lib/target-registry.mjs — the spawn argv, extra child env, files to rotate,
// `clientInfo.name`, the default model, whether `session/load` is honoured,
// the answer to `session/request_permission`, the usage reader, the
// `session/update` kinds the agent was measured to emit and, for an agent that
// takes its model per session rather than per spawn, the request that sets it
// (`acp.setModel`). There is no companion-id branch in this file;
// `scripts/copilot-acp-daemon.mjs` is the Copilot binding of these same classes.
//
// Yolo posture is the companion's, declared on its descriptor (Copilot's
// `--allow-all-*` flags; an agent that asks anyway gets the descriptor's
// answer to `session/request_permission`). Behavioural safety is enforced per
// prompt by the templates, not by flags.
//
// Protocol v1 is PINNED: `initialize` sends `protocolVersion: 1`, and an agent
// answering any other version is refused — the child is killed and the session
// fails `ACP_PROTOCOL_MISMATCH` — never adapted. The v2 draft renames
// `session/load` to `session/resume`; adapting silently would send a method
// the pinned contract does not have.

import { spawn, execSync } from 'node:child_process';
import { createServer, connect as connectSocket } from 'node:net';
import { appendFileSync, statSync, lstatSync, unlinkSync, renameSync, writeFileSync, existsSync, readFileSync, chmodSync, realpathSync } from 'node:fs';
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
import { HEARTBEAT_STALE_AFTER_MS, HOST_LIVENESS_TTL_MS, scanLiveHeartbeat } from '../lib/heartbeat.mjs';
import { getTargetById } from '../lib/target-registry.mjs';

// --- Constants ---------------------------------------------------------------

// The one protocol version this daemon speaks. Copilot CLI 1.0.83 and Google's
// agy_acp_server 1.1.1 answer it, and so did Gemini CLI 0.59.0 when it was
// evaluated (all measured 2026-09-11). Copilot and Gemini answer 1 even to a
// request for 2, as the spec says an agent should; Antigravity answers whatever
// it is asked (1 or 2), which is why the pin is enforced at the handshake.
export const ACP_PROTOCOL_VERSION = 1;

const LOG_MAX_BYTES = 1024 * 1024; // 1 MB
const PRIVATE_FILE_MODE = 0o600;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

// Heartbeat-driven liveness extension. Claude/Codex hooks touch a per-host-sid
// file in HEARTBEAT_DIR on every tool turn (PostToolUse / UserPromptSubmit /
// SessionStart). When the inactivity timer fires, the daemon checks for any
// heartbeat newer than HOST_LIVENESS_TTL_MS and reschedules instead of exiting
// — keeping the agent subprocess alive (and its in-process conversation
// context with it) for the full lifetime of an active host session. The 15-min
// idle timer alone would terminate the child mid-session, forcing a rebirth
// on the next prompt-bg and losing context.
//
// Both TTLs are imported from lib/heartbeat.mjs, which also owns the walk: the
// codex broker sweeps the same directory under the same predicate, and a local
// copy tuned in one daemon would unlink heartbeats the other still reads as
// live. See the note beside their definitions.
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

// The daemon's own prompt budget, exported so the bridge derives the shared
// registry's idle TTL from it rather than choosing a second number.
export { PROMPT_TIMEOUT_MS as ACP_PROMPT_TIMEOUT_MS };

// JSON-RPC "Method not found", the answer to any agent request for a client
// capability this daemon did not declare.
const JSONRPC_METHOD_NOT_FOUND = -32601;

// --- Descriptor --------------------------------------------------------------

// The companion this process serves. A descriptor without an `acp` block is
// not an ACP companion; refusing here is what keeps `--companion opencode`
// from starting a daemon that can serve nothing.
export function resolveDescriptor(companionId) {
  const descriptor = getTargetById(companionId);
  if (!descriptor) throw new Error(`unknown companion "${companionId}"`);
  if (!descriptor.acp) throw new Error(`companion "${descriptor.id}" is not an ACP companion (no acp block on its descriptor)`);
  return descriptor;
}

// Resolve the companion binary only when spawning the real daemon. Module
// imports must stay side-effect-light so unit tests can exercise SessionManager
// with a fake AcpConnection on machines without the CLI installed.
//
// Portability matters here — hardcoding a Homebrew Apple Silicon path breaks
// the daemon on Intel Macs, Linux, or any install that lives elsewhere.
// Precedence:
//   1. the descriptor's `binaryEnv` override (for pinning a specific build)
//   2. `command -v <name>` for each of its `binaryNames` — honours the user's PATH
// Fails loudly with an actionable error if neither resolves.
function resolveCompanionBin(descriptor) {
  if (process.env[descriptor.binaryEnv]) return process.env[descriptor.binaryEnv];
  for (const name of descriptor.binaryNames) {
    if (isAbsolute(name)) {
      if (existsSync(name)) return name;
      continue;
    }
    try {
      // Bounded like every other synchronous shell-out in this plugin. `command -v`
      // is a shell builtin and effectively instant, but an unbounded sync exec is
      // the shape of bug we are eliminating, not a judgement call to re-make per
      // call site. SIGKILL because a catchable signal does not actually bound it.
      const found = execSync(`command -v ${name}`, {
        encoding: 'utf8',
        shell: '/bin/sh',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      }).trim();
      if (found) return found;
    } catch {
      // try the next candidate, then the loud error
    }
  }
  throw new Error(
    `${descriptor.binaryNames[0]} binary not found on PATH. Install ${descriptor.displayName} or set $${descriptor.binaryEnv}.`
  );
}

// The runtime files a descriptor may name in `acp.env`, `acp.rotate` and
// `acp.usage`. Computed once per spawn so the descriptor never touches
// runtime-paths itself (it is imported by side-effect-free CLI scripts).
function runtimePaths() {
  return { otelTraces: otelTracesPath() };
}

function readFileOrEmpty(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// --- Logger ------------------------------------------------------------------
//
// `<COMPANION>_DAEMON_LOG_LEVEL` gates DEBUG output (default INFO). In normal
// operation DEBUG-level lines — every socket dispatch, every supervisor
// heartbeat — are dropped so the log stays readable during incidents. Flip
// to DEBUG when live-debugging. Higher-severity levels (WARN, ERROR, FATAL,
// <COMPANION>_STDERR) are always written regardless of the level setting.
//
// One logger per companion, bound at construction: a daemon process serves
// one companion, but a test process may drive several, and each must land in
// its own log.

const LOG_LEVEL_RANK = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, FATAL: 50 };

function envPrefix(companion) {
  return String(companion).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

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

function createLogger(companion) {
  const threshold = () => {
    const level = (process.env[`${envPrefix(companion)}_DAEMON_LOG_LEVEL`] || 'INFO').toUpperCase();
    return LOG_LEVEL_RANK[level] ?? LOG_LEVEL_RANK.INFO;
  };
  return function log(level, ...args) {
    // Always write WARN/ERROR/FATAL and any non-standard level (e.g. COPILOT_STDERR).
    const rank = LOG_LEVEL_RANK[level];
    if (rank !== undefined && rank < threshold()) return;
    try {
      const logFile = daemonLogFile(companion);
      if (existsSync(logFile) && statSync(logFile).size > LOG_MAX_BYTES) {
        writePrivateFile(logFile, '');
      }
      const ts = new Date().toISOString();
      const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      appendPrivateFile(logFile, `${ts} [${level}] ${msg}\n`);
    } catch {
      // best-effort logging
    }
  };
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

// Log the full agent argv exactly once per daemon boot. Subsequent spawns
// log a compact summary so the daemon log doesn't drown in a dozen identical
// 300-char flag strings during a session with many prompts.
let _fullSpawnLogged = false;
function logSpawn(log, companion, bin, flags) {
  if (!_fullSpawnLogged) {
    log('INFO', `spawning ${companion} (full argv):`, bin, flags.join(' '));
    _fullSpawnLogged = true;
    return;
  }
  const pick = (key) => {
    const i = flags.indexOf(key);
    return i >= 0 && i + 1 < flags.length ? flags[i + 1] : null;
  };
  const model = pick('--model') || '?';
  const effort = pick('--reasoning-effort') || '?';
  log('INFO', `spawning ${companion}:`, bin, `[model=${model} reasoning=${effort} flags=${flags.length}]`);
}

// Extract a preview string from an ACP tool_call_update's rawOutput/content.
// Copilot emits distinct shapes for success vs. failure (inspected in
// ~/Library/Caches/copilot/.../app.js): on success, rawOutput is a string or
// { content: string }; on failure, rawOutput is an Error-like object with
// { message, ... } and content is either undefined or an ACP content array
// of the form [{ type:'content', content:{ type:'text', text } }, ...]. The
// old extractor only knew the success shapes, so every failure previewed as
// null — the daemon, supervisor, and inspect summary all lost the error text.
// Gemini CLI 0.59.0's shapes were covered by the same walk when it was
// evaluated: a string rawOutput, an Error-like `{message}` for a cancelled
// tool, and the content array.
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

// The option the daemon picks when the agent asks for permission. The
// one-shot options, never the persistent ones: the daemon answers for THIS
// call and does not write policy into the agent's own store.
function choosePermissionOption(options, allow) {
  const list = Array.isArray(options) ? options : [];
  const wanted = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of wanted) {
    const option = list.find((o) => o?.kind === kind && o?.optionId != null);
    if (option) return option;
  }
  return null;
}

// --- AcpConnection -----------------------------------------------------------

class AcpConnection {
  constructor(descriptor) {
    if (!descriptor?.acp) throw new Error('AcpConnection needs an ACP companion descriptor');
    this.descriptor = descriptor;
    this.companion = descriptor.id;
    this.log = createLogger(this.companion);
    this.child = null;
    this.requestId = 0;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this.sessionCollectors = new Map(); // sessionId -> { events, resolve, reject, timer }
    this.buffer = '';
    this.initialized = false;
    this.dead = false;
    // What the handshake established: the version the agent answered, and
    // whether it is the one this daemon pins.
    this.protocol = { pinned: ACP_PROTOCOL_VERSION, answered: null, status: 'pending' };
    this.agentInfo = null;
    this.agentCapabilities = null;
    // `session/update` kinds seen that the descriptor does not declare —
    // logged once each as drift, then parsed generically like the rest.
    this._undeclaredKinds = new Set();
    this._declaredKinds = new Set(descriptor.acp.updates || []);
  }

  isAlive() {
    return this.child !== null && !this.dead && this.child.exitCode === null;
  }

  async spawn(cwd, model = null) {
    this.cwd = requireAbsoluteDirectoryCwd(cwd, 'spawn cwd');
    this.cwdReal = canonicalCwd(this.cwd);
    this.model = model;
    const flags = this.descriptor.acp.args({ model: this.model, env: process.env });
    const bin = resolveCompanionBin(this.descriptor);
    logSpawn(this.log, this.companion, bin, flags);
    this.log('INFO', `${this.companion} process cwd=${this.cwd} model=${this.model}`);
    const paths = runtimePaths();
    // Rotate the runtime files the descriptor names once they pass the same
    // 1 MB threshold as the daemon log (Copilot's OTEL traces).
    for (const key of this.descriptor.acp.rotate || []) {
      const path = paths[key];
      if (!path) continue;
      try {
        if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) {
          const backup = path + '.bak';
          try { unlinkSync(backup); } catch {}
          renameSync(path, backup);
        }
      } catch { /* best-effort rotation */ }
    }

    this.child = spawn(bin, flags, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.descriptor.acp.env({ env: process.env, paths }),
      },
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    this.child.stdout.on('data', (chunk) => this._onStdoutData(chunk));
    const stderrLevel = `${envPrefix(this.companion)}_STDERR`;
    this.child.stderr.on('data', (chunk) => this.log(stderrLevel, chunk.trim()));

    this.child.on('error', (err) => {
      this.log('ERROR', `${this.companion} process error:`, err.message);
      this._failAll(`${this.companion} process error: ${err.message}`);
    });

    this.child.on('close', (code, signal) => {
      this.log('INFO', `${this.companion} process closed:`, { code, signal });
      this.dead = true;
      this._failAll(`${this.companion} process exited (code=${code}, signal=${signal})`);
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
      this.log('WARN', `non-json line from ${this.companion}:`, line.slice(0, 200));
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

    // A request FROM the agent (has id and method): a client method it wants
    // this daemon to serve. Every one gets an answer — an unanswered request
    // is an agent that waits forever.
    if (msg.id !== undefined && msg.method) {
      this._onAgentRequest(msg);
      return;
    }

    // Notification (has method, no id)
    if (msg.method) {
      this._onNotification(msg);
    }
  }

  // The client methods the agent may call. `session/request_permission` is
  // the only one this daemon serves — it declared no fs and no terminal
  // capability, so a request for those is answered "Method not found" rather
  // than left hanging (an agent that asks anyway falls back to its own file
  // system, as Gemini CLI 0.59.0 was measured to do).
  _onAgentRequest(msg) {
    if (msg.method === 'session/request_permission') {
      this._answerPermission(msg);
      return;
    }
    this.log('WARN', `agent requested undeclared client method ${msg.method}; answering -32601`);
    this._sendResponse(msg.id, null, {
      code: JSONRPC_METHOD_NOT_FOUND,
      message: `Method not found: ${msg.method} (this client declared no such capability)`,
    });
  }

  // The daemon is the user. Answer from the descriptor's policy — `all`
  // allows every kind, `edit` allows tool calls of kind `edit`, `none` allows
  // nothing that asks — and leave a `permission` event on the prompt stream
  // so the digest and the operator can see what was decided and why.
  _answerPermission(msg) {
    const params = msg.params || {};
    const toolCall = params.toolCall || {};
    const policy = this.descriptor.acp.permission(process.env);
    const kind = toolCall.kind ?? null;
    const allow = policy === 'all' || (policy === 'edit' && kind === 'edit');
    const option = choosePermissionOption(params.options, allow);
    const decision = allow ? 'allow' : 'reject';
    const event = {
      type: 'permission',
      toolCallId: toolCall.toolCallId ?? null,
      title: toolCall.title ?? null,
      kind,
      policy,
      decision,
      optionId: option?.optionId ?? null,
    };
    this.log('INFO', 'permission request:', `session=${params.sessionId} tool=${toolCall.title || toolCall.toolCallId || '?'} kind=${kind} policy=${policy} -> ${decision}${option ? ` (${option.optionId})` : ' (no matching option; cancelled)'}`);
    const collector = this.sessionCollectors.get(params.sessionId);
    if (collector?.onEvent) {
      try { collector.onEvent(event); } catch (err) { this.log('WARN', 'onEvent callback failed:', err.message); }
    }
    const outcome = option
      ? { outcome: 'selected', optionId: option.optionId }
      : { outcome: 'cancelled' };
    this._sendResponse(msg.id, { outcome });
  }

  _sendResponse(id, result, error = null) {
    if (!this.isAlive()) return;
    const payload = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
    try { this.child.stdin.write(JSON.stringify(payload) + '\n'); }
    catch (err) { this.log('WARN', 'failed to answer agent request:', err.message); }
  }

  _onNotification(msg) {
    if (msg.method === 'session/update') {
      const params = msg.params || {};
      const sessionId = params.sessionId;
      const update = params.update || {};
      const kind = update.sessionUpdate;
      if (kind && !this._declaredKinds.has(kind) && !this._undeclaredKinds.has(kind)) {
        this._undeclaredKinds.add(kind);
        this.log('WARN', `session/update kind '${kind}' not declared by the ${this.companion} descriptor (acp.updates) — parsed generically; if the agent changed, update lib/target-registry.mjs`);
      }
      const collector = this.sessionCollectors.get(sessionId);
      if (!collector) return;

      let streamEvent = null;

      switch (kind) {
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
          // ACP plan update — the agent's strategy for the turn. Useful for
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
            this.log('DEBUG', 'tool_call failed:', tc?.name || update.toolCallId, outputPreview ? `— ${outputPreview.slice(0, 120)}` : '(no error detail)');
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
          this.log('WARN', 'onEvent callback failed:', err.message);
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
    if (!this.isAlive()) return Promise.reject(new Error(`${this.companion} connection is not alive`));
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
    if (!this.isAlive()) throw new Error(`${this.companion} connection is not alive`);
    const payload = { jsonrpc: '2.0', method, params };
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  // The v1 handshake. `clientCapabilities` is the spec's key (`capabilities`
  // was an MCP-ism); no fs and no terminal, so the agent uses its own file
  // system and shell. ACP has no `initialized` notification — the one the
  // Copilot daemon used to send was MCP's, and Gemini CLI 0.59.0 answered it
  // with a -32601 on stderr (measured 2026-09-11).
  async initialize() {
    const result = await this._sendRequest(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: this.descriptor.acp.clientName, version: '1.0.0' },
      },
      SPAWN_INIT_TIMEOUT_MS,
    );
    const answered = result?.protocolVersion ?? null;
    this.agentInfo = result?.agentInfo || null;
    this.agentCapabilities = result?.agentCapabilities || result?.capabilities || null;
    if (answered !== ACP_PROTOCOL_VERSION) {
      this.protocol = { pinned: ACP_PROTOCOL_VERSION, answered, status: 'mismatch' };
      const err = new Error(
        `${this.descriptor.displayName} answered protocolVersion ${answered === null ? '(none)' : answered}; `
        + `this daemon pins ${ACP_PROTOCOL_VERSION} and does not adapt (agent: ${this.agentInfo?.name || '?'} ${this.agentInfo?.version || ''})`.trim(),
      );
      err.code = 'ACP_PROTOCOL_MISMATCH';
      err.answered = answered;
      this.log('FATAL', 'protocol mismatch:', err.message);
      this.kill();
      throw err;
    }
    this.protocol = { pinned: ACP_PROTOCOL_VERSION, answered, status: 'match' };
    this.log('INFO', 'initialize ok:', {
      agentInfo: this.agentInfo,
      agentCapabilities: this.agentCapabilities,
    });
    this.initialized = true;
    return result;
  }

  async createSession(cwd) {
    const result = await this._sendRequest('session/new', { cwd, mcpServers: [] }, SPAWN_INIT_TIMEOUT_MS);
    this.log('INFO', 'session/new ok:', { sessionId: result?.sessionId });
    await this._applySessionModel(result.sessionId);
    return result.sessionId;
  }

  // The model, where the agent takes it per session rather than as a spawn
  // flag — the descriptor's `acp.setModel` names the request (Antigravity's
  // `session/set_config_option`, measured 2026-09-11 on agy_acp_server 1.1.1).
  // Sent after `session/new` AND after `session/load`, because a loaded
  // session comes back on the agent's default model (measured). No pin, or
  // no hook, sends nothing. An agent that refuses the id (-32602, naming the
  // ids it has) fails the session and the prompt with it: never a silent
  // fallback to the default.
  async _applySessionModel(sessionId) {
    const setModel = this.descriptor.acp.setModel;
    if (typeof setModel !== 'function' || !this.model) return;
    const [method, params] = setModel({ sessionId, model: this.model });
    await this._sendRequest(method, params, SPAWN_INIT_TIMEOUT_MS);
    this.log('INFO', `${method} ok:`, { sessionId, model: this.model });
  }

  // `session/load`: the agent replays the session's history as
  // `session/update` notifications and answers only when it is done. Nothing
  // collects for this session yet, so the replay is dropped on the floor —
  // which is exactly right: it is history, not this prompt's output.
  async loadSession(sessionId, cwd) {
    const result = await this._sendRequest('session/load', { sessionId, cwd, mcpServers: [] }, SPAWN_INIT_TIMEOUT_MS);
    this.log('INFO', 'session/load ok:', { sessionId });
    await this._applySessionModel(sessionId);
    return result;
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
          //   raw: the agent's own prompt response, for the usage reader
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
            raw: result && typeof result === 'object' ? result : null,
          });
        })
        .catch((err) => {
          clearTimeout(collector.timer);
          this.sessionCollectors.delete(sessionId);
          reject(err);
        });
    });
  }

  // Send ACP session/cancel notification. The agent should abort the in-flight
  // turn and the prompt request will resolve with stopReason "cancelled".
  cancelSession(sessionId) {
    try {
      this._sendNotification('session/cancel', { sessionId });
      return true;
    } catch (err) {
      this.log('WARN', 'session/cancel failed:', err.message);
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

// Set of all terminal status values for an in-flight prompt. The long-poll
// `watchPrompt` waiter resolves the moment the status moves into this set.
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stuck']);

class SessionManager {
  constructor(descriptor) {
    if (!descriptor?.acp) throw new Error('SessionManager needs an ACP companion descriptor (lib/target-registry.mjs, `acp` block)');
    this.descriptor = descriptor;
    this.companion = descriptor.id;
    this.log = createLogger(this.companion);
    this.connection = null;
    // Latched by shutdown(): a prompt that settles after it (the killed
    // child rejects every collector) must not re-arm the inactivity timer
    // and keep a stopped daemon's process alive for another 15 minutes.
    this._stopped = false;
    // The last handshake outcome, kept even when the connection was refused
    // — status must be able to name the version a mismatching agent answered.
    this.lastProtocol = null;
    this.sessions = new Map(); // sessionId -> { cwd, promptCount, createdAt, loaded }
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
    // <COMPANION>_DAEMON_LIVENESS_WATCHDOG=0.
    this._lastHeartbeatAt = Date.now();
    if (process.env[`${envPrefix(this.companion)}_DAEMON_LIVENESS_WATCHDOG`] !== '0') {
      this._livenessTimer = setInterval(() => {
        this._lastHeartbeatAt = Date.now();
      }, 1000);
      if (this._livenessTimer.unref) this._livenessTimer.unref();
    }
  }

  // The model a request resolves to: the caller's, else the descriptor's
  // default (Copilot's host-routed default-model state; nothing for an agent
  // whose own default is the one to use).
  normalizeModel(model) {
    const clean = String(model || '').trim();
    return clean || this.descriptor.acp.defaultModel(process.env);
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

  // The prompt's usage, from the descriptor's reader. Copilot's reads the
  // prompt's `invoke_agent` span off the OTEL file exporter (measured
  // 2026-09-10 against Copilot CLI 1.0.77: on disk before the daemon sees the
  // `session/prompt` answer, so this is ONE synchronous read in the prompt's
  // own window — no wait, no retry); Gemini's reads the prompt response
  // itself. `null` (no key on the summary) when the transport reported
  // nothing: a prompt that spent nothing measurable reports nothing.
  _readPromptUsage({ result, sessionId, sinceMs }) {
    try {
      return this.descriptor.acp.usage({
        result: result?.raw ?? null,
        sessionId,
        sinceMs,
        paths: runtimePaths(),
        readFile: readFileOrEmpty,
      }) || null;
    } catch (err) {
      this.log('WARN', 'usage reader threw:', err.message);
      return null;
    }
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
    this.log('WARN', 'session retired:', `sessionId=${sessionId} reason=${reason} existed=${existed}`);
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
      this.log('INFO', 'gc prompt:', promptId, `status=${state.status}`);
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
      try { resolve(state); } catch (err) { this.log('WARN', 'waiter resolver threw:', err.message); }
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
      try { resolve({ interim: true, alert }); } catch (err) { this.log('WARN', 'interim resolver threw:', err.message); }
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
      this.log('WARN', 'failed to write alert event:', err.message);
    }
    this.log('INFO', 'prompt alert:', state.promptId || '?', reason, `tier=${tier}`);
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
  //   - If the liveness watchdog is on and _lastHeartbeatAt is stale
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
      this.log('FATAL', 'event loop starvation detected:', `${stale}ms since last heartbeat — tripping all in-flight prompts`);
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
          this.log('INFO', 'supervisor idle stamp:', pid, `idle=${t}s age=${Math.round(age / 1000)}s`);
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
        this.log('DEBUG', 'supervise heartbeat:', `tick=${this._superviseTickCount} prompts=[${summary}]`);
      }
    }
  }

  // Common transition: status -> "stuck", set reason, append synthetic event,
  // optionally cancel the upstream session, drain waiters.
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
    this.log('WARN', 'prompt stuck:', state.promptId || '?', reason + detail, autoCancelOk ? '(cancelling)' : '(no-cancel)');
    try {
      const line = JSON.stringify({ type: 'stuck', reason, ts: Date.now() }) + '\n';
      appendPrivateFile(state.eventsFile, line);
    } catch (err) {
      this.log('WARN', 'failed to write stuck event:', err.message);
    }
    if (autoCancelOk && this.connection && this.connection.isAlive()) {
      try { this.connection.cancelSession(state.sessionId); } catch {}
    }
    this._drainTerminalWaiters(state);
  }

  async ensureConnection(cwd, model = null) {
    const requestedCwd = requireAbsoluteDirectoryCwd(cwd, 'session cwd');
    const requestedReal = canonicalCwd(requestedCwd);
    const requestedModel = this.normalizeModel(model);
    if (this.connection && this.connection.isAlive() && this.connection.initialized) {
      const currentReal = this.connection.cwdReal || canonicalCwd(this.connection.cwd);
      const currentModel = this.connection.model || this.descriptor.acp.defaultModel(process.env);
      if ((!currentReal || currentReal === requestedReal) && currentModel === requestedModel) return this.connection;

      const active = this._activePromptForCwdSwitch();
      if (active) {
        const modelMismatch = currentModel !== requestedModel;
        const err = new Error(
          modelMismatch
            ? `cannot switch ${this.descriptor.displayName} model from ${currentModel || '(unknown)'} to ${requestedModel}: ` +
              `prompt ${active.promptId} is still ${active.status}`
            : `cannot switch ${this.descriptor.displayName} cwd from ${this.connection.cwd || '(unknown)'} to ${requestedCwd}: ` +
          `prompt ${active.promptId} is still ${active.status}`,
        );
        err.code = modelMismatch ? 'MODEL_BUSY' : 'CWD_BUSY';
        err.existingPromptId = active.promptId;
        err.sessionId = active.sessionId;
        throw err;
      }

      this.log('INFO', `connection config changed: respawning ${this.companion} (` +
        `cwd ${this.connection.cwd || '(unknown)'} -> ${requestedCwd}, ` +
        `model ${currentModel || '(unknown)'} -> ${requestedModel})`);
      this.connection.kill();
      this.connection = null;
      if (this.sessions.size > 0) {
        this.log('INFO', `connection config change: invalidating ${this.sessions.size} stale session(s)`);
        this.sessions.clear();
      }
    }
    // Memoize the in-flight spawn so parallel callers don't race to spawn
    // multiple subprocesses (which would cause "Session not found"
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
          // Every sid in this.sessions was registered with the dead child.
          // After respawning, none of those sids are valid in the new one —
          // wipe the map so a later prompt-bg with a stale sid takes the
          // load-or-rebirth branch (sidKnown=false) instead of falsely passing
          // startPromptBg's local has() check and reaching the new child with
          // a sid it never created. Without this clear, a stale sid combined
          // with a healthy new connection produces 'Session not found' from
          // the agent instead of a clean sessionReborn / sessionLoaded signal.
          if (this.sessions.size > 0) {
            this.log('INFO', `connection respawn: invalidating ${this.sessions.size} stale session(s)`);
            this.sessions.clear();
          }
        }
        const conn = new AcpConnection(this.descriptor);
        await conn.spawn(requestedCwd, requestedModel);
        try {
          await conn.initialize();
        } finally {
          this.lastProtocol = conn.protocol;
        }
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
    const requestedModel = this.normalizeModel(model);
    const conn = await this.ensureConnection(requestedCwd, requestedModel);
    const sessionId = await conn.createSession(requestedCwd);
    this.sessions.set(sessionId, {
      cwd: requestedCwd,
      cwdReal: canonicalCwd(requestedCwd),
      model: requestedModel,
      promptCount: 0,
      createdAt: Date.now(),
      loaded: false,
    });
    // Echo the resolved cwd into the daemon log so post-mortems can
    // confirm the agent rooted where the bridge intended. ACP's session/new
    // accepts cwd silently and gives no read-back, so a daemon-side log
    // line is the only observable signal that the value was honored.
    this.log('INFO', `session/new cwd=${requestedCwd || '(none)'} model=${requestedModel} sessionId=${sessionId}`);
    this._resetInactivityTimer();
    return sessionId;
  }

  async startSession(cwd, model = null) {
    return this._withSessionMutation(() => this._startSessionUnlocked(cwd, model));
  }

  // `session/load` a session id this daemon no longer holds — the daemon was
  // restarted, or the agent child was respawned for a cwd/model change — so
  // the conversation continues instead of restarting cold. Honoured only
  // when BOTH the descriptor and the agent's own `initialize` say so: Copilot
  // advertises `loadSession` but its sessions are process-local, so its
  // descriptor declares false and this never fires for it. Returns false
  // (and logs why) when the load is not available or the agent refuses the
  // id; the caller then mints fresh and reports the rebirth.
  async _tryLoadSessionUnlocked(sessionId, cwd, model = null) {
    if (!this.descriptor.acp.loadSession) return false;
    const requestedCwd = requireAbsoluteDirectoryCwd(cwd, 'session cwd');
    const requestedModel = this.normalizeModel(model);
    const conn = await this.ensureConnection(requestedCwd, requestedModel);
    if (!conn.agentCapabilities?.loadSession) {
      this.log('WARN', `session/load skipped: ${this.companion} did not advertise loadSession`);
      return false;
    }
    try {
      await conn.loadSession(sessionId, requestedCwd);
    } catch (err) {
      this.log('WARN', `session/load failed for ${sessionId}:`, err.message, '— minting a fresh session');
      return false;
    }
    this.sessions.set(sessionId, {
      cwd: requestedCwd,
      cwdReal: canonicalCwd(requestedCwd),
      model: requestedModel,
      promptCount: 0,
      createdAt: Date.now(),
      loaded: true,
    });
    this.log('INFO', `session/load cwd=${requestedCwd} model=${requestedModel} sessionId=${sessionId}`);
    this._resetInactivityTimer();
    return true;
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
    const eventsFile = promptEventsPath(promptId, this.companion);
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
        this.log('WARN', 'failed to write event:', err.message);
      }
      // Supervisor event-level detection: only while still running. Skip
      // synthetic lifecycle events — they're not agent output.
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
        this.log('WARN', 'supervisor observe threw:', err.message);
      }
    };

    // Initial start event
    writeEvent({ type: 'start', sessionId, promptId });

    // Fire and don't await — the IPC handler returns immediately
    this.connection
      .sendPrompt(sessionId, text, writeEvent)
      .then((result) => {
        // The prompt's usage, from the descriptor's reader (see
        // `_readPromptUsage`). On the summary, so it rides the same `done`
        // event and `watch` answer the bridge already reads; absent when
        // nothing was reported, never zeroed. `raw` is the reader's input and
        // does not travel further.
        if (result && typeof result === 'object') {
          const usage = state.status === 'running'
            ? this._readPromptUsage({ result, sessionId, sinceMs: state.startedAt })
            : null;
          delete result.raw;
          if (usage) result.usage = usage;
        }
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
        this.log('WARN', 'failed to read events file:', err.message);
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
      // per delegation regardless of how many raw events the agent emitted.
      return baseResponse;
    }

    const rawEvents = lines.slice(since).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { type: 'parse_error', raw: l.slice(0, 200) };
      }
    });

    // Coalesce consecutive thought/message chunks into single events. Agents
    // stream text in tiny ~5-13 char chunks, which produces 100+ events for a
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
      this.log('WARN', 'failed to read inspect events file:', err.message);
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
  // the same session. The follow-up text is wrapped so the agent knows
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
        this.log('WARN', 'reply timeout: prior turn did not drain:', promptId, `status=${state.status}`);
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
      companion: this.companion,
      daemonPid: process.pid,
      connected: this.connection?.isAlive() ?? false,
      initialized: this.connection?.initialized ?? false,
      pid: this.connection?.child?.pid ?? null,
      connectionCwd: this.connection?.cwd ?? null,
      activeModel: this.connection?.model ?? null,
      protocol: this.connection?.protocol ?? this.lastProtocol ?? { pinned: ACP_PROTOCOL_VERSION, answered: null, status: 'pending' },
      agentInfo: this.connection?.agentInfo ?? null,
      agentCapabilities: this.connection?.agentCapabilities ?? null,
      configuredModel: this.descriptor.acp.defaultModel(process.env),
      sessions: Array.from(this.sessions.entries()).map(([sid, meta]) => ({
        sessionId: sid,
        cwd: meta.cwd,
        model: meta.model || null,
        promptCount: meta.promptCount,
        createdAt: meta.createdAt,
        loaded: !!meta.loaded,
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
    this._stopped = true;
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
    if (this._stopped) return;
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
      this.log('DEBUG', 'inactivity tick: prompts still active, reschedule');
      this.inactivityTimer = setTimeout(() => this._onInactivityTick(), 60_000);
      return;
    }
    // Host-liveness extension: if any host session has touched its heartbeat
    // within HOST_LIVENESS_TTL_MS, the parent (Claude/Codex) is still active
    // and we keep the agent child alive for it. Without this gate, the 15-min
    // idle timer would kill the subprocess mid-session and force a rebirth (and
    // context loss) on the next prompt-bg.
    const liveSid = this._findLiveHeartbeat(now);
    if (liveSid) {
      this.log('INFO', `inactivity tick: host ${liveSid} still active (heartbeat fresh) — extending`);
      this.inactivityTimer = setTimeout(() => this._onInactivityTick(), 60_000);
      return;
    }
    this.log('INFO', 'inactivity timeout — shutting down');
    this.shutdown();
    process.exit(0);
  }

  // Scan HEARTBEAT_DIR for the freshest per-host-sid heartbeat. Returns the
  // sid (basename minus extension) if any heartbeat is within HOST_LIVENESS_TTL_MS,
  // else null. The walk itself (and the stale sweep) lives in lib/heartbeat.mjs
  // because the codex broker asks the same question of the same directory.
  _findLiveHeartbeat(now = Date.now()) {
    return scanLiveHeartbeat(heartbeatDir(), {
      nowMs: now,
      liveTtlMs: HOST_LIVENESS_TTL_MS,
      staleAfterMs: HEARTBEAT_STALE_AFTER_MS,
    });
  }
}

// --- IpcServer ---------------------------------------------------------------

class IpcServer {
  constructor(manager) {
    this.manager = manager;
    this.companion = manager.companion;
    this.log = manager.log;
    this.server = null;
  }

  async start() {
    const socketPath = daemonSocketPath(this.companion);
    // Stale socket detection: try to connect; if refused, unlink
    if (existsSync(socketPath)) {
      try {
        if (lstatSync(socketPath).isSymbolicLink()) {
          this.log('ERROR', 'socket path is a symlink; refusing to use it:', socketPath);
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
        this.log('ERROR', 'socket already in use, daemon already running');
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
        catch (err) { this.log('WARN', 'chmod socket failed:', err.message); }
        this.log('INFO', 'listening on', socketPath);
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
    sock.on('error', (err) => this.log('WARN', 'socket error:', err.message));
  }

  async _dispatch(msg) {
    // v6.1 E1: stamp the inbound req_id on every dispatch line so server,
    // daemon, and client logs can be joined.
    this.log('DEBUG', 'dispatch:', msg.command, msg.reqId ? `req=${msg.reqId}` : '');
    switch (msg.command) {
      case 'prompt-bg': {
        return this.manager._withSessionMutation(async () => {
          // Start a session if no sessionId given (auto mode), then register
          // the prompt before releasing the session/connection lock. This
          // closes the cold-start race where a different-cwd caller could kill
          // the process between session/new and startPromptBg.
          let sessionId = msg.sessionId;
          let sessionReborn = false;
          let sessionLoaded = false;
          let requestedCwd;
          try {
            requestedCwd = requireAbsoluteDirectoryCwd(msg.cwd, 'prompt-bg cwd');
          } catch (err) {
            return { ok: false, code: 'CWD_REQUIRED', error: err.message };
          }
          const requestedModel = this.manager.normalizeModel(msg.model);
          // A session id this daemon does not hold right now: the daemon was
          // restarted, or the agent child respawned. Loaded when the
          // descriptor and the agent both allow it, minted fresh (and
          // reported reborn) otherwise — see _tryLoadSessionUnlocked.
          let loadCandidate = null;
          if (sessionId) {
            const conn = this.manager.connection;
            const connAlive = !!(conn && conn.isAlive() && conn.initialized);
            const sidKnown = this.manager.sessions.has(sessionId);
            if (!connAlive || !sidKnown) {
              this.log('WARN', `prompt-bg: stale sessionId ${sessionId} (connAlive=${connAlive} sidKnown=${sidKnown}) — loading it, else minting fresh`);
              this.manager.sessions.delete(sessionId);
              loadCandidate = sessionId;
              sessionId = null;
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
                this.log('WARN', `prompt-bg: session config changed for ${sessionId} ` +
                  `(cwd ${meta?.cwd || '(unknown)'} -> ${requestedCwd}, model ${meta?.model || '(unknown)'} -> ${requestedModel}) — minting fresh session`);
                this.manager.sessions.delete(sessionId);
                sessionId = null;
                sessionReborn = true;
              }
            }
          }
          try {
            if (loadCandidate) {
              if (await this.manager._tryLoadSessionUnlocked(loadCandidate, requestedCwd, requestedModel)) {
                sessionId = loadCandidate;
                sessionLoaded = true;
              } else {
                sessionReborn = true;
              }
            }
            if (!sessionId) {
              sessionId = await this.manager._startSessionUnlocked(requestedCwd, requestedModel);
            }
            const data = await this.manager.startPromptBg(sessionId, msg.text);
            return { ok: true, data: { ...data, activeModel: this.manager.connection?.model || requestedModel, sessionReborn, sessionLoaded } };
          } catch (err) {
            if (err && ['SESSION_BUSY', 'CWD_BUSY', 'MODEL_BUSY'].includes(err.code)) {
              this.log('WARN', 'prompt-bg refused:', `code=${err.code} sid=${err.sessionId} existing=${err.existingPromptId}`);
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
            // The agent speaks another protocol: named, so the bridge can
            // settle the job on it rather than on a generic spawn failure.
            if (err && err.code === 'ACP_PROTOCOL_MISMATCH') {
              return { ok: false, code: err.code, error: err.message, data: { protocol: this.manager.lastProtocol } };
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
        // new one on the same session with the user's follow-up
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
    const socketPath = daemonSocketPath(this.companion);
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {}
    }
  }
}

// --- Exports + Main ---------------------------------------------------------

// Importable for unit tests. scripts/acp-daemon.test.mjs drives these against
// test/fake-acp-agent.mjs over real stdio; scripts/copilot-acp-daemon.test.mjs
// instantiates the Copilot binding with a stub AcpConnection to exercise the
// per-session mutex and reply drain without a subprocess. Production callers
// always go through `runDaemon` below.
export {
  SessionManager,
  AcpConnection,
  IpcServer,
  TERMINAL_STATUSES,
};

// Run this process as the daemon for one companion. Shared by the generic
// entry point (`node scripts/acp-daemon.mjs --companion <id>`, which the bridge
// spawns) and the Copilot binding's own main.
export function runDaemon(descriptor) {
  const manager = new SessionManager(descriptor);
  const server = new IpcServer(manager);

  const cleanupAndExit = (code) => {
    manager.log('INFO', 'shutting down', { code });
    manager.shutdown();
    server.cleanup();
    process.exit(code);
  };

  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));
  process.on('uncaughtException', (err) => {
    manager.log('FATAL', 'uncaughtException:', err.stack || err.message);
    cleanupAndExit(1);
  });
  process.on('unhandledRejection', (err) => {
    manager.log('FATAL', 'unhandledRejection:', err?.stack || String(err));
  });
  // Catch-all: if anything calls process.exit() directly (e.g. the stop
  // command, inactivity timer), still unlink the socket. exit handlers
  // must be synchronous.
  process.on('exit', () => {
    const socketPath = daemonSocketPath(descriptor.id);
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {}
    }
  });

  server.start().catch((err) => {
    manager.log('FATAL', 'failed to start server:', err.message);
    console.error('failed to start daemon:', err.message);
    process.exit(1);
  });
  return { manager, server };
}

// Match server.mjs's isMain detection — realpathSync on both sides so a
// symlinked argv[1] still matches import.meta.url.
export function isMainModule(metaUrl) {
  try {
    const argvReal = realpathSync(process.argv[1]);
    const metaReal = realpathSync(fileURLToPath(metaUrl));
    return argvReal === metaReal;
  } catch { return false; }
}

if (isMainModule(import.meta.url)) {
  const at = process.argv.indexOf('--companion');
  const companion = at >= 0 ? String(process.argv[at + 1] || '').trim() : '';
  if (!companion) {
    console.error('usage: acp-daemon.mjs --companion <id>   (an ACP companion from lib/target-registry.mjs)');
    process.exit(2);
  }
  let descriptor;
  try { descriptor = resolveDescriptor(companion); }
  catch (err) { console.error(`acp-daemon: ${err.message}`); process.exit(2); }
  runDaemon(descriptor);
}
