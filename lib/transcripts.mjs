import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as codex from './transcripts/codex.mjs';
import * as claude from './transcripts/claude.mjs';
import * as copilot from './transcripts/copilot.mjs';
import * as opencode from './transcripts/opencode.mjs';
import * as antigravity from './transcripts/antigravity.mjs';

const readers = { codex, claude, copilot, opencode, antigravity };
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
function findFile(dir, matches, recursive = false) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isFile() && matches(entry.name)) return path;
      if (entry.isDirectory() && recursive) {
        const found = findFile(path, matches, true);
        if (found) return found;
      }
    }
  } catch { /* A missing or inaccessible home has no located transcript. */ }
  return null;
}

export function locateTranscript({ companion, historyId, nativeRefs = {}, env = process.env }) {
  const home = env.HOME || homedir();
  const envHome = (key, fallback) => String(env[key] || '').trim() || join(home, fallback);
  let path;
  switch (companion) {
    case 'codex':
      path = nativeRefs.transcriptPath && isFile(nativeRefs.transcriptPath) ? nativeRefs.transcriptPath
        : historyId && findFile(join(envHome('CODEX_HOME', '.codex'), 'sessions'), name => name.startsWith('rollout-') && name.endsWith(`-${historyId}.jsonl`), true);
      break;
    case 'claude': {
      if (!historyId) return null;
      const projects = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
      try {
        for (const entry of readdirSync(projects, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidate = join(projects, entry.name, `${historyId}.jsonl`);
          if (isFile(candidate)) { path = candidate; break; }
        }
      } catch { return null; }
      break;
    }
    case 'copilot': if (historyId) path = join(envHome('COPILOT_HOME', '.copilot'), 'session-state', historyId, 'events.jsonl'); break;
    case 'opencode': path = env.OPENCODE_DB || join(envHome('XDG_DATA_HOME', '.local/share'), 'opencode', 'opencode.db'); break;
    case 'antigravity': if (historyId) path = join(envHome('GEMINI_HOME', '.gemini'), 'antigravity-acp', 'conversations', `${historyId}.db`); break;
    default: return null;
  }
  return path && isFile(path) ? { companion, kind: ['opencode', 'antigravity'].includes(companion) ? 'sqlite' : 'jsonl', path, sessionId: historyId ?? null } : null;
}

// Retain the adapter's synchronous boolean contract; the projects scan lives here.
export function claudeTranscriptExists(historyId, env = process.env) {
  return locateTranscript({ companion: 'claude', historyId, env }) !== null;
}

// Natives record epoch milliseconds (OpenCode) or ISO strings; items carry ISO or null.
function isoTime(value) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// JSONL cursors are byte offsets. SQLite cursors are opaque row-id -> digest maps.
// Replaying context on each read keeps cursors free of transcript text and lets
// results arriving later update the original tool id. No on-disk cache is made.
export function readTranscript(locator, { after } = {}) {
  const companion = locator?.companion ?? null;
  const items = new Map();
  const format = { recognized: false, version: null, detail: null };
  let cursor = after ?? (locator?.kind === 'sqlite' ? { rows: {} } : 0);
  let selected = true;
  const issues = [];
  const context = {
    state: {}, format, turnId: null, id: null, at: null, nativeType: null,
    emit(kind, fields = {}) {
      const item = { id: `${companion}:${locator.sessionId ?? ''}:${this.id}`, turnId: this.turnId, at: isoTime(this.at), kind, status: null, nativeType: this.nativeType, ...fields };
      if (selected) items.set(item.id, item);
      return item;
    },
    unknown(record, nativeType = this.nativeType, suffix = '') {
      return this.emit('unrecognized', { id: `${companion}:${locator.sessionId ?? ''}:${this.id}${suffix}`, nativeType, record });
    },
  };
  function parse(record, id, at, nativeType) {
    Object.assign(context, { id, at, nativeType });
    try { readers[companion].parse(record, context); }
    catch (error) { issues.push(`${nativeType}: ${error.message}`); context.unknown(record); }
  }
  let db;
  try {
    if (!readers[companion]) throw new Error('unsupported companion');
    if (locator.kind === 'jsonl') {
      const bytes = readFileSync(locator.path);
      const end = bytes.lastIndexOf(10) + 1;
      const offset = typeof after === 'number' && after <= end ? after : 0;
      let start = 0;
      while (start < end) {
        const next = bytes.indexOf(10, start) + 1;
        selected = next > offset;
        const line = bytes.subarray(start, next - 1).toString('utf8');
        if (line.trim()) {
          let record;
          try { record = JSON.parse(line); }
          catch { record = { type: 'invalid_json', line }; issues.push(`invalid JSON at byte ${start}`); }
          parse(record, String(start), record?.timestamp ?? null, record?.type ?? 'unknown');
        }
        start = next;
      }
      cursor = end;
    } else if (locator.kind === 'sqlite') {
      db = new DatabaseSync(locator.path, { readOnly: true });
      db.exec('BEGIN');
      const rows = readers[companion].rows(db, locator.sessionId, context);
      cursor = { rows: {} };
      for (const row of rows) {
        const id = String(row.id ?? row.idx);
        const digest = createHash('sha256').update(JSON.stringify(row)).digest('hex');
        cursor.rows[id] = digest;
        selected = after?.rows?.[id] !== digest;
        parse(row, id, row.time_created ?? null, row.type ?? String(row.step_type));
      }
    } else throw new Error('unsupported transcript kind');
  } catch (error) { issues.push(error.message); }
  finally { db?.close(); }
  const values = [...items.values()];
  const unrecognized = values.filter(item => item.kind === 'unrecognized').length;
  format.recognized = format.version !== null && !issues.length && !unrecognized;
  format.detail = issues.length ? issues.join('; ') : unrecognized ? `${unrecognized} unrecognized native record(s)` : format.version === null ? 'native fingerprint not found' : 'native transcript';
  return { companion, format, items: values, cursor, counts: { unrecognized } };
}
