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
export const LOG_DIR  = process.env.AGENT_COMPANION_HOME
  || companionHomeDir(detectHost());
export const LOG_FILE = join(LOG_DIR, 'daemon.log');
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

function rotateIfNeeded() {
  let st;
  try { st = statSync(LOG_FILE); } catch { return; }
  if (st.size < ROTATE_BYTES) return;
  const r1 = LOG_FILE + '.1';
  const r2 = LOG_FILE + '.2';
  try { unlinkSync(r2); } catch {}
  try { renameSync(r1, r2); } catch {}
  try { renameSync(LOG_FILE, r1); } catch {}
}

export function logEvent(level, event, fields = {}) {
  const lvl = LEVELS[level] ?? LEVELS.info;
  if (lvl < CONFIGURED_LEVEL) return;
  ensureDir(dirname(LOG_FILE));
  rotateIfNeeded();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
    ...fields,
  }) + '\n';
  try { appendFileSync(LOG_FILE, line, { mode: 0o600 }); } catch {}
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
