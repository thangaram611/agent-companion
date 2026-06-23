// Smart-transcript digest for a Copilot ACP prompt.
//
// Reads the private prompt JSONL stream and emits a markdown summary the
// parent agent can read INSTEAD of relying on `status` alone. The goal is
// "good details to finalise", not a raw event dump:
//
//   - Final / partial assistant message (concatenation of streamed chunks)
//   - /fleet sub-agent reports (paired tool_call + tool_call_update preview)
//   - Failed tool calls (name + verbatim error preview, surfaced explicitly)
//   - Source files touched (filtered + sorted source paths)
//   - Other paths explored (deps + bare directories, capped tight)
//   - Tool-call summary (counts grouped by kind, with failed counts)
//   - Todos snapshot (latest `plan` event)
//
// The bridge regenerates this file on every status request, every interim
// supervisor alert (~60s cadence during silence), and on terminal.

import {
  readFileSync,
  existsSync,
} from 'node:fs';

import { digestPathForJob, promptEventsPath, writePrivateFile } from './runtime-paths.mjs';

// Per-section size caps. Picked to keep the digest readable when the parent
// reads the file inline; truncation is marked explicitly so it's never
// silent.
const TASK_MAX_CHARS         = 1500;
const ASSISTANT_MAX_CHARS    = 8000;
// Sub-agent reports are the primary deliverable when /fleet times out — the
// parent reads them to decide whether to re-dispatch. Today Copilot CLI
// hard-caps `outputPreview` at ~300 chars upstream, so this cap is mostly
// future-proofing; even so it sets a sane ceiling if that ever changes.
const SUB_AGENT_MAX_CHARS    = 10000;
const SOURCE_FILE_MAX_ENTRIES = 40;
const OTHER_PATH_MAX_ENTRIES  = 12;
const FAILED_CALL_MAX_ENTRIES = 10;
const FAILED_CALL_PREVIEW_MAX = 600;

export function digestPath(jobId) {
  if (!jobId) return null;
  try { return digestPathForJob(jobId); }
  catch { return null; }
}

// Public entry point. Returns the markdown string, or null if the prompt
// jsonl is missing (no events yet, or job had no promptId).
export function buildDigest(promptId, jobMeta = {}) {
  const events = readPromptEvents(promptId);
  if (!events) return null;
  return renderDigest(events, promptId, jobMeta);
}

// Build + write to disk. Returns the path on success, null if there's
// nothing to write (no events) or the write fails.
export function writeDigest(promptId, jobMeta = {}) {
  const content = buildDigest(promptId, jobMeta);
  if (!content) return null;
  const path = digestPath(jobMeta.jobId);
  if (!path) return null;
  try {
    writePrivateFile(path, content);
    return path;
  } catch {
    return null;
  }
}

// Pure renderer — exported for tests so they can feed synthetic events
// without touching the filesystem.
export function renderDigest(events, promptId, jobMeta = {}) {
  const {
    jobId, status, startedAt, terminalAt, mode, template, thread,
    parallel, task, sessionId,
  } = jobMeta;

  const lines = [];
  lines.push(`# Copilot job ${jobId || '(unknown)'} — digest`);
  lines.push('');
  lines.push(`**Updated:** ${new Date().toISOString()}`);
  if (status)    lines.push(`**Status:** \`${status}\``);
  if (mode)      lines.push(`**Mode:** ${mode}${parallel ? ' (parallel via /fleet)' : ''}`);
  if (template)  lines.push(`**Template:** ${template}`);
  if (thread)    lines.push(`**Thread:** \`${thread}\``);
  if (promptId)  lines.push(`**Prompt:** \`${promptId}\``);
  if (sessionId) lines.push(`**Session:** \`${sessionId}\``);
  if (startedAt) lines.push(`**Started:** ${isoSafe(startedAt)}`);
  if (terminalAt) lines.push(`**Terminal:** ${isoSafe(terminalAt)}`);
  const ageMs = terminalAt
    ? Math.max(0, terminalAt - (startedAt || terminalAt))
    : Math.max(0, Date.now() - (startedAt || Date.now()));
  lines.push(`**Age:** ${formatDuration(ageMs)}`);
  lines.push('');

  if (task) {
    lines.push('## Task');
    lines.push('');
    lines.push(truncateBlock(task, TASK_MAX_CHARS));
    lines.push('');
  }

  const finalMessage = extractAssistantMessage(events);
  if (finalMessage) {
    lines.push('## Final / partial assistant message');
    lines.push('');
    lines.push(truncateBlock(finalMessage, ASSISTANT_MAX_CHARS));
    lines.push('');
  }

  const subAgents = extractSubAgents(events);
  if (subAgents.length > 0) {
    lines.push('## Sub-agent reports (/fleet)');
    lines.push('');
    for (const sub of subAgents) {
      lines.push(`### \`${sub.name}\` — ${sub.status}`);
      if (sub.description) {
        lines.push('');
        lines.push(`*${sub.description}*`);
      }
      lines.push('');
      if (sub.outputPreview) {
        lines.push(truncateBlock(sub.outputPreview, SUB_AGENT_MAX_CHARS));
      } else {
        lines.push('_(no report yet — still running)_');
      }
      lines.push('');
    }
  }

  const failed = extractFailedCalls(events);
  if (failed.length > 0) {
    lines.push('## Failed tool calls');
    lines.push('');
    for (const f of failed.slice(0, FAILED_CALL_MAX_ENTRIES)) {
      lines.push(`- \`${f.kind}\` — **${f.name}**`);
      if (f.preview) {
        lines.push(`  > ${truncateBlock(f.preview, FAILED_CALL_PREVIEW_MAX).replace(/\n/g, '\n  > ')}`);
      }
    }
    if (failed.length > FAILED_CALL_MAX_ENTRIES) {
      lines.push(`- _…and ${failed.length - FAILED_CALL_MAX_ENTRIES} more failed call(s)_`);
    }
    lines.push('');
  }

  const { source, other } = extractFiles(events);
  if (source.length > 0) {
    lines.push('## Source files touched');
    lines.push('');
    for (const f of source.slice(0, SOURCE_FILE_MAX_ENTRIES)) {
      lines.push(`- \`${f.path}\`${f.count > 1 ? ` (${f.count}x)` : ''}`);
    }
    if (source.length > SOURCE_FILE_MAX_ENTRIES) {
      lines.push(`- _…and ${source.length - SOURCE_FILE_MAX_ENTRIES} more_`);
    }
    lines.push('');
  }
  if (other.length > 0) {
    lines.push('## Other paths explored');
    lines.push('');
    for (const f of other.slice(0, OTHER_PATH_MAX_ENTRIES)) {
      lines.push(`- \`${f.path}\`${f.count > 1 ? ` (${f.count}x)` : ''}`);
    }
    if (other.length > OTHER_PATH_MAX_ENTRIES) {
      lines.push(`- _…and ${other.length - OTHER_PATH_MAX_ENTRIES} more directories/deps_`);
    }
    lines.push('');
  }

  const toolStats = extractToolStats(events);
  if (toolStats.totalCalls > 0) {
    lines.push('## Tool-call summary');
    lines.push('');
    for (const row of toolStats.byKind) {
      const failed = row.failed > 0 ? ` (${row.failed} failed)` : '';
      lines.push(`- \`${row.kind}\`: ${row.count}${failed}`);
    }
    if (toolStats.subAgentInvocations > 0) {
      lines.push(`- sub-agent invocations: ${toolStats.subAgentInvocations}`);
    }
    lines.push('');
  }

  const todos = extractTodos(events);
  if (todos.length > 0) {
    lines.push('## Todos (latest snapshot)');
    lines.push('');
    for (const t of todos) {
      const marker = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' ';
      const content = typeof t.content === 'string' ? t.content : '(no description)';
      lines.push(`- [${marker}] ${content} *(${t.status || 'pending'})*`);
    }
    lines.push('');
  }

  // Ensure trailing newline.
  if (lines[lines.length - 1] !== '') lines.push('');
  return lines.join('\n');
}

// --- Internals -------------------------------------------------------------

function readPromptEvents(promptId) {
  if (!promptId) return null;
  let path;
  try { path = promptEventsPath(promptId); }
  catch { return null; }
  if (!existsSync(path)) return null;
  let content;
  try { content = readFileSync(path, 'utf8'); }
  catch { return null; }
  const events = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

function extractAssistantMessage(events) {
  // Concatenate `message` chunks in stream order. `thought` events are
  // internal reasoning — skip.
  //
  // /fleet hazard: Copilot CLI multiplexes every sub-agent's streamed
  // tokens into the SAME jsonl as the parent's, without an agent tag.
  // Concatenating naively across the parallel window yields a character-
  // mixed blob where one sub-agent's "BLOCKING" lines interleave with
  // another's source citations and the parent's narration. So when we
  // detect any sub-agent tool_call window, we splice out the messages
  // emitted during it; the sub-agent reports section already surfaces
  // each sub-agent's report cleanly via paired tool_call_update.
  const sub = subAgentWindow(events);
  const parts = [];
  let elidedDuringFleet = false;
  for (const ev of events) {
    if (ev.type !== 'message' || typeof ev.text !== 'string') continue;
    if (sub && ev.ts > sub.startTs && ev.ts <= sub.endTs) {
      elidedDuringFleet = true;
      continue;
    }
    parts.push(ev.text);
  }
  const joined = parts.join('').trim();
  if (elidedDuringFleet) {
    const marker = '\n\n_[interleaved /fleet sub-agent streams omitted — see Sub-agent reports section below]_';
    return joined ? joined + marker : marker.trimStart();
  }
  return joined;
}

function subAgentWindow(events) {
  // Returns { startTs, endTs } bracketing the /fleet activity window, or
  // null if there were no sub-agent invocations. startTs = first sub-agent
  // tool_call.ts (exclusive lower bound). endTs = last sub-agent
  // tool_call_update.ts, or Infinity if any sub-agent is still running
  // when the digest is built (terminal-via-timeout case).
  let startTs = null;
  let lastUpdateTs = null;
  const liveIds = new Set();
  for (const ev of events) {
    if (ev.type === 'tool_call' && ev.input && typeof ev.input.agent_type === 'string') {
      if (startTs === null || (typeof ev.ts === 'number' && ev.ts < startTs)) startTs = ev.ts;
      liveIds.add(ev.toolCallId);
    } else if (ev.type === 'tool_call_update' && liveIds.has(ev.toolCallId)) {
      if (typeof ev.ts === 'number') {
        if (lastUpdateTs === null || ev.ts > lastUpdateTs) lastUpdateTs = ev.ts;
      }
      if (ev.status && ev.status !== 'in_progress') liveIds.delete(ev.toolCallId);
    }
  }
  if (startTs === null) return null;
  // Any sub-agent never terminated → window extends to end of stream.
  const endTs = liveIds.size > 0 ? Number.POSITIVE_INFINITY : (lastUpdateTs ?? Number.POSITIVE_INFINITY);
  return { startTs, endTs };
}

function extractSubAgents(events) {
  // /fleet sub-agent calls are tool_calls whose `input.agent_type` is set.
  // Pair each with its completion update so we can surface outputPreview
  // (the sub-agent's final report).
  const subs = new Map(); // toolCallId -> sub
  for (const ev of events) {
    if (ev.type === 'tool_call' && ev.input && typeof ev.input.agent_type === 'string') {
      const name = ev.input.name || ev.name || ev.toolCallId;
      subs.set(ev.toolCallId, {
        name,
        description: ev.input.description || null,
        status: 'running',
        outputPreview: null,
      });
    } else if (ev.type === 'tool_call_update' && subs.has(ev.toolCallId)) {
      const sub = subs.get(ev.toolCallId);
      if (ev.status) sub.status = ev.status;
      if (typeof ev.outputPreview === 'string' && ev.outputPreview.length > 0) {
        sub.outputPreview = ev.outputPreview;
      }
    }
  }
  return [...subs.values()];
}

function extractFiles(events) {
  // Aggregate distinct paths from tool_call.locations. Count = number of
  // tool_calls that touched the path (so 4 reads of the same file → 4).
  //
  // Split into:
  //   - source: paths that look like actual source files (have a file
  //     extension and are not inside node_modules / .git / dist / build /
  //     .pnpm). These are what the parent agent cares about.
  //   - other: bare directories or dependency paths. Kept but tightly
  //     capped so node_modules walks don't drown the digest.
  const counts = new Map();
  for (const ev of events) {
    if (ev.type !== 'tool_call' || !Array.isArray(ev.locations)) continue;
    for (const loc of ev.locations) {
      if (loc && typeof loc.path === 'string' && loc.path) {
        counts.set(loc.path, (counts.get(loc.path) || 0) + 1);
      }
    }
  }
  const all = [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => (b.count - a.count) || a.path.localeCompare(b.path));
  const source = [];
  const other = [];
  for (const entry of all) {
    if (isSourcePath(entry.path)) source.push(entry); else other.push(entry);
  }
  return { source, other };
}

function isSourcePath(p) {
  if (/\/(node_modules|\.git|dist|build|\.next|\.pnpm|target|out)(\/|$)/.test(p)) return false;
  // Has a file extension on the last segment (".ts", ".tsx", ".mjs", ".py", etc.)
  const last = p.split('/').pop() || '';
  return /\.[A-Za-z0-9]+$/.test(last);
}

function extractFailedCalls(events) {
  // Pair tool_call_update{status:failed} back to its originating tool_call
  // to get kind + human-readable name. outputPreview on the failed update
  // carries the actual error message (e.g. "rg: ... No such file"). The
  // literature explicitly says preserve error messages verbatim — a count
  // alone doesn't help the parent decide whether to retry.
  const started = new Map(); // toolCallId -> { name, kind }
  for (const ev of events) {
    if (ev.type === 'tool_call') {
      started.set(ev.toolCallId, {
        name: ev.name || '(unnamed)',
        kind: ev.kind || 'unknown',
      });
    }
  }
  const out = [];
  for (const ev of events) {
    if (ev.type !== 'tool_call_update' || ev.status !== 'failed') continue;
    const meta = started.get(ev.toolCallId) || { name: ev.name || '(unnamed)', kind: ev.kind || 'unknown' };
    out.push({
      kind: meta.kind,
      name: meta.name,
      preview: typeof ev.outputPreview === 'string' ? ev.outputPreview.trim() : '',
    });
  }
  return out;
}

function extractToolStats(events) {
  // Aggregate tool_calls by `kind` (the canonical type: read/execute/other),
  // not by `name` (which is the per-call human label and varies wildly).
  // Also count sub-agent invocations separately.
  const kindCount = new Map();
  const kindFailed = new Map();
  const startedKindById = new Map();
  let subAgentInvocations = 0;
  let total = 0;
  for (const ev of events) {
    if (ev.type === 'tool_call') {
      const kind = ev.kind || 'unknown';
      kindCount.set(kind, (kindCount.get(kind) || 0) + 1);
      startedKindById.set(ev.toolCallId, kind);
      total++;
      if (ev.input && typeof ev.input.agent_type === 'string') subAgentInvocations++;
    } else if (ev.type === 'tool_call_update' && ev.status === 'failed') {
      const kind = startedKindById.get(ev.toolCallId) || 'unknown';
      kindFailed.set(kind, (kindFailed.get(kind) || 0) + 1);
    }
  }
  const byKind = [...kindCount.entries()]
    .map(([kind, count]) => ({ kind, count, failed: kindFailed.get(kind) || 0 }))
    .sort((a, b) => (b.count - a.count) || a.kind.localeCompare(b.kind));
  return { byKind, subAgentInvocations, totalCalls: total };
}

function extractTodos(events) {
  // The latest `plan` event is the current todo snapshot. Each entry has
  // `content` + `status` (pending|in_progress|completed|cancelled).
  let latest = null;
  for (const ev of events) {
    if (ev.type === 'plan' && Array.isArray(ev.entries)) {
      latest = ev.entries;
    }
  }
  return latest || [];
}

function truncateBlock(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 16)) + '\n…[truncated]';
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return `${h}h ${mr}m`;
}

function isoSafe(ts) {
  try { return new Date(ts).toISOString(); }
  catch { return String(ts); }
}
