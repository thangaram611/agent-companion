// Structured JSONL logger + correlation-id helper for the companion.
// One line per event. Rotates at 10 MB → .1 → .2.
//
// v6.1 E1/E2.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { companionHomeDir, detectHost } from './host.mjs';

// AGENT_COMPANION_HOME override wins; otherwise route through lib/host.mjs
// so Codex daemon logs land in ~/.codex/agent-companion/ instead of
// Claude's directory.
//
// Resolved PER CALL, like every path in lib/runtime-paths.mjs — one rule for
// both. As module-load constants these froze the operator's real home before a
// test could redirect them: ESM evaluates a suite's static imports before its
// first statement runs, so `process.env.AGENT_COMPANION_HOME = sandbox` at the
// top of a test file arrived too late and the suite appended fabricated events
// to the live daemon.log (measured 861 bytes per run of
// bridge-server/codex-app-server-runtime.test.mjs). Per-call resolution is why
// the same redirect works for `bridgeLogFile()`.
export function companionLogDir() {
  return process.env.AGENT_COMPANION_HOME || companionHomeDir(detectHost());
}

export function companionLogFile() {
  return join(companionLogDir(), 'daemon.log');
}

export const ROTATE_BYTES = 10 * 1024 * 1024;

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const CONFIGURED_LEVEL =
  LEVELS[(process.env.AGENT_COMPANION_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function ensureDir(p) { try { mkdirSync(p, { recursive: true, mode: 0o700 }); } catch {} }

// crypto.randomBytes-backed id; not a true ULID but cheap and unique.
// Sortable lexicographically by the leading time component.
export function createReqId() {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomBytes(6).toString('hex');
  return `req_${ts}_${rand}`;
}

function rotateIfNeeded(logFile) {
  let st;
  try { st = statSync(logFile); } catch { return; }
  if (st.size < ROTATE_BYTES) return;
  const r1 = logFile + '.1';
  const r2 = logFile + '.2';
  try { unlinkSync(r2); } catch {}
  try { renameSync(r1, r2); } catch {}
  try { renameSync(logFile, r1); } catch {}
}

export function logEvent(level, event, fields = {}) {
  const lvl = LEVELS[level] ?? LEVELS.info;
  if (lvl < CONFIGURED_LEVEL) return;
  const logFile = companionLogFile();
  ensureDir(dirname(logFile));
  rotateIfNeeded(logFile);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
    ...fields,
  }) + '\n';
  try { appendFileSync(logFile, line, { mode: 0o600 }); } catch {}
}

// Convenience namespaced logger keyed by a req_id and optional context.
export function withReq(req_id, base = {}) {
  return {
    req_id,
    trace: (event, f) => logEvent('trace', event, { req_id, ...base, ...f }),
    debug: (event, f) => logEvent('debug', event, { req_id, ...base, ...f }),
    info:  (event, f) => logEvent('info',  event, { req_id, ...base, ...f }),
    warn:  (event, f) => logEvent('warn',  event, { req_id, ...base, ...f }),
    error: (event, f) => logEvent('error', event, { req_id, ...base, ...f }),
  };
}
