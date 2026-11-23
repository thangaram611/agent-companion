import { readFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { COMPANIONS } from './companion-registry.mjs';
import { isFile } from './transcripts/common.mjs';
import { locate as locateClaude } from './transcripts/claude.mjs';

const readerFor = id => COMPANIONS[id]?.runtime?.reader;

export function locateTranscript({ companion, historyId, nativeRefs = {}, env = process.env }) {
  const reader = readerFor(companion);
  const path = reader?.locate({ historyId, nativeRefs, env });
  return path && isFile(path) ? { companion, kind: reader.rows ? 'sqlite' : 'jsonl', path, sessionId: historyId ?? null } : null;
}

// The adapter needs a synchronous existence check before resuming.
export function claudeTranscriptExists(historyId, env = process.env) {
  return !!locateClaude({ historyId, env });
}

// Natives record epoch milliseconds (OpenCode) or ISO strings; items carry ISO or null.
function isoTime(value) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// One parse state per transcript. readTranscript replays it from the start on
// every read; followTranscript keeps it, so a JSONL read costs only new bytes.
function parser(locator) {
  const companion = locator?.companion ?? null;
  const reader = readerFor(companion);
  const format = { recognized: false, version: null, detail: null };
  const issues = [];
  let items = new Map(), selected = true;
  const context = {
    state: {}, format, turnId: null, id: null, at: null, nativeType: null,
    emit(kind, fields = {}, suffix = '') {
      const item = { id: `${companion}:${locator.sessionId ?? ''}:${this.id}${suffix}`, turnId: this.turnId, at: isoTime(this.at), kind, status: null, nativeType: this.nativeType, ...fields };
      if (selected) items.set(item.id, item);
      return item;
    },
    unknown(record, nativeType = this.nativeType, suffix = '') {
      return this.emit('unrecognized', { nativeType, record }, suffix);
    },
  };
  const p = {
    companion, reader, context, issues,
    select(value) { selected = value; },
    parse(record, id, at, nativeType) {
      Object.assign(context, { id, at, nativeType });
      try { reader.parse(record, context); }
      catch (error) { issues.push(`${nativeType}: ${error.message}`); context.unknown(record); }
    },
    // `bytes` starts at absolute offset `base`; lines ending after `offset` are selected.
    jsonl(bytes, base, offset) {
      const end = bytes.lastIndexOf(10) + 1;
      let start = 0;
      while (start < end) {
        const next = bytes.indexOf(10, start) + 1;
        selected = base + next > offset;
        const line = bytes.subarray(start, next - 1).toString('utf8');
        if (line.trim()) {
          let record;
          try { record = JSON.parse(line); }
          catch { record = { type: 'invalid_json', line }; issues.push(`invalid JSON at byte ${base + start}`); }
          p.parse(record, String(base + start), record?.timestamp ?? null, record?.type ?? 'unknown');
        }
        start = next;
      }
      return base + end;
    },
    result(cursor) {
      const values = [...items.values()];
      items = new Map();
      const unrecognized = values.filter(item => item.kind === 'unrecognized').length;
      format.recognized = format.version !== null && !issues.length && !unrecognized;
      format.detail = issues.length ? issues.join('; ') : unrecognized ? `${unrecognized} unrecognized native record(s)` : format.version === null ? 'native fingerprint not found' : 'native transcript';
      return { companion, format: { ...format }, items: values, cursor, counts: { unrecognized } };
    },
  };
  return p;
}

// JSONL cursors are byte offsets. SQLite cursors are opaque row-id -> digest maps.
// Replaying context on each read keeps cursors free of transcript text and lets
// results arriving later update the original tool id. No on-disk cache is made.
export function readTranscript(locator, { after } = {}) {
  const p = parser(locator);
  let cursor = after ?? (locator?.kind === 'sqlite' ? { rows: {} } : 0);
  let db;
  try {
    if (!p.reader) throw new Error('unsupported companion');
    if (locator.kind === 'jsonl') {
      const bytes = readFileSync(locator.path);
      const end = bytes.lastIndexOf(10) + 1;
      cursor = p.jsonl(bytes, 0, typeof after === 'number' && after <= end ? after : 0);
    } else if (locator.kind === 'sqlite') {
      db = new DatabaseSync(locator.path, { readOnly: true });
      db.exec('BEGIN');
      const rows = p.reader.rows(db, locator.sessionId, p.context);
      cursor = { rows: {} };
      for (const row of rows) {
        const id = String(row.id ?? row.idx);
        const digest = createHash('sha256').update(JSON.stringify(row)).digest('hex');
        cursor.rows[id] = digest;
        p.select(after?.rows?.[id] !== digest);
        p.parse(row, id, row.time_created ?? null, row.type ?? String(row.step_type));
      }
    } else throw new Error('unsupported transcript kind');
  } catch (error) { p.issues.push(error.message); }
  finally { db?.close(); }
  return p.result(cursor);
}

// Live follow for one locator. Each read() returns what readTranscript(locator,
// { after: previous cursor }) would, but a JSONL read keeps the parse state and
// reads only the appended bytes (a 140 MB transcript replayed in about 170 ms).
// A shrunk or replaced file restarts the parse and returns `reset: true`, so the
// caller drops what it holds. SQLite stores update rows in place: each read
// replays the session's rows and compares them with the row cursor.
export function followTranscript(locator) {
  let p = null, offset = 0, ino = null, cursor;
  return {
    read() {
      if (locator?.kind !== 'jsonl' || !readerFor(locator.companion)) {
        const result = readTranscript(locator, { after: cursor });
        cursor = result.cursor;
        return result;
      }
      let bytes, reset = false;
      try {
        const fd = openSync(locator.path, 'r');
        try {
          const stat = fstatSync(fd);
          if (p && (stat.ino !== ino || stat.size < offset)) { p = null; offset = 0; reset = true; }
          ino = stat.ino;
          bytes = Buffer.alloc(stat.size - offset);
          for (let read = 0, n; read < bytes.length; read += n) {
            n = readSync(fd, bytes, read, bytes.length - read, offset + read);
            if (!n) { bytes = bytes.subarray(0, read); break; }
          }
        } finally { closeSync(fd); }
      } catch (error) {
        p ??= parser(locator);
        p.issues.push(error.message);
        return p.result(offset);
      }
      p ??= parser(locator);
      offset = p.jsonl(bytes, offset, offset);
      return { ...p.result(offset), reset };
    },
  };
}
