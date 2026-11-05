// Pure-function helpers for the agent-bridge MCP server (v6.1).
//
// Internal action validator for the split MCP tools:
// agent_catalog | agent_send | agent_wait | agent_status | agent_reply | agent_cancel.
// The server injects the action before validation. Error
// messages are prefixed with `agent:` so MCP clients can surface them as
// synchronous tool-call rejections.
//
// Nothing in here opens sockets, spawns processes, or reads state files —
// it's safe to import from tests without side effects other than appending
// a line to the private runtime bridge log on the `log()` helper.

import {
  statSync,
  appendFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';

import { bridgeLogFile, PRIVATE_FILE_MODE, chmodPrivate } from '../lib/runtime-paths.mjs';

// --- Logger -----------------------------------------------------------------

export const BRIDGE_LOG_MAX_BYTES = 1024 * 1024;

export function getBridgeLogFile() {
  return bridgeLogFile();
}

export function log(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `${ts} [${level}] ${msg}\n`;
  const logFile = getBridgeLogFile();
  try {
    if (existsSync(logFile) && statSync(logFile).size > BRIDGE_LOG_MAX_BYTES) {
      // v6.1 C4: keep the previous log in .bak instead of truncating in
      // place. Truncate-on-rotate dropped the most recent diagnostic data
      // exactly when something went wrong enough to fill the log.
      try {
        renameSync(logFile, logFile + '.bak');
        chmodPrivate(logFile + '.bak');
      }
      catch { writeFileSync(logFile, '', { mode: PRIVATE_FILE_MODE }); chmodPrivate(logFile); }
    }
    appendFileSync(logFile, line, { mode: PRIVATE_FILE_MODE });
    chmodPrivate(logFile);
  } catch { /* best-effort */ }
  if (level === 'WARN' || level === 'ERROR' || level === 'FATAL') {
    try { process.stderr.write(line); } catch {}
  }
}

// --- Constants --------------------------------------------------------------

export const VALID_ACTIONS = new Set(['catalog', 'send', 'wait', 'status', 'reply', 'cancel']);
export const VALID_TARGETS = new Set(['opencode', 'copilot', 'codex', 'antigravity']);

// Thread is an internal field injected by the host, not a model-facing input.
const ALLOWED_FIELDS = {
  catalog: new Set(['action']),
  send:   new Set(['action', 'task', 'cwd', 'thread', 'target', 'model', 'max_wait_sec']),
  wait:   new Set(['action', 'job_id', 'max_wait_sec']),
  status: new Set(['action', 'job_id', 'verbose', 'diagnostics']),
  reply:  new Set(['action', 'job_id', 'message']),
  cancel: new Set(['action', 'job_id']),
};

function assertKnownFields(action, args) {
  const allowed = ALLOWED_FIELDS[action];
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new Error(`agent: unknown field "${key}" for action="${action}" (allowed: ${[...allowed].join(', ')})`);
    }
  }
}

function assertString(name, value, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return;
    throw new Error(`agent: ${name} is required`);
  }
  if (typeof value !== 'string') throw new Error(`agent: ${name} must be a string`);
}

function assertBoolean(name, value) {
  if (value === undefined) return;
  if (typeof value !== 'boolean') throw new Error(`agent: ${name} must be a boolean`);
}

function assertThreadName(value) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') throw new Error('agent: thread must be a string');
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`agent: thread must match [a-zA-Z0-9._-]+ (got "${value}")`);
  }
}

function assertCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === '') {
    throw new Error(
      'agent: cwd is required for action="send" ' +
      '(pass the absolute target repo/worktree path; refusing to default to the bridge process cwd)',
    );
  }
  if (typeof cwd !== 'string') throw new Error('agent: cwd must be a string');
  if (!isAbsolute(cwd)) throw new Error(`agent: cwd must be an absolute path, got "${cwd}"`);
  let st;
  try { st = statSync(cwd); }
  catch { throw new Error(`agent: cwd does not exist: ${cwd}`); }
  if (!st.isDirectory()) throw new Error(`agent: cwd is not a directory: ${cwd}`);
}

export function validateAgentArgs(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? rawArgs : {};
  const action = args.action;
  if (!action) throw new Error('agent: action is required (one of: catalog, send, wait, status, reply, cancel)');
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`agent: action must be one of catalog|send|wait|status|reply|cancel, got "${action}"`);
  }
  assertKnownFields(action, args);
  switch (action) {
    case 'catalog': return { action: 'catalog' };
    case 'send':   return validateSend(args);
    case 'wait':   return validateWait(args);
    case 'status': return validateStatus(args);
    case 'reply':  return validateReply(args);
    case 'cancel': return validateCancel(args);
    default:       throw new Error(`agent: unhandled action "${action}"`);
  }
}

function validateReply(args) {
  // v6.1 D4: peer-steering. Both fields strictly required — there is no
  // sensible default for either.
  assertString('job_id', args.job_id);
  assertString('message', args.message);
  if (args.message.length > 8000) {
    throw new Error(`agent: reply.message too long (${args.message.length} > 8000 chars)`);
  }
  return { action: 'reply', job_id: args.job_id, message: args.message };
}

function validateCancel(args) {
  assertString('job_id', args.job_id);
  return { action: 'cancel', job_id: args.job_id };
}

function validateWait(args) {
  assertString('job_id', args.job_id);
  if (args.max_wait_sec !== undefined && typeof args.max_wait_sec !== 'number') {
    throw new Error('agent: max_wait_sec must be a number');
  }
  return { action: 'wait', job_id: args.job_id, max_wait_sec: args.max_wait_sec };
}

function validateStatus(args) {
  assertString('job_id', args.job_id, { optional: true });
  assertBoolean('verbose', args.verbose);
  assertBoolean('diagnostics', args.diagnostics);
  return {
    action: 'status',
    job_id: args.job_id || null,
    verbose: !!args.verbose,
    diagnostics: !!args.diagnostics,
  };
}

function validateSend(args) {
  assertString('task', args.task);
  assertCwd(args.cwd);
  assertThreadName(args.thread);
  assertString('target', args.target, { optional: true });
  assertString('model', args.model, { optional: true });
  const target = String(args.target || '').trim().toLowerCase();
  if (target && !VALID_TARGETS.has(target)) {
    throw new Error(`agent: target must be one of ${[...VALID_TARGETS].join('|')}, got "${args.target}"`);
  }
  if (args.max_wait_sec !== undefined && typeof args.max_wait_sec !== 'number') {
    throw new Error('agent: max_wait_sec must be a number');
  }
  return {
    action: 'send',
    task: args.task,
    cwd: args.cwd,
    thread: args.thread || null,
    target: target || null,
    model: args.model?.trim() || null,
    max_wait_sec: args.max_wait_sec,
  };
}
