// Helpers for summarizing Copilot prompt JSONL events into a compact,
// caller-friendly activity timeline.

import { parseToolLineRange } from './prompt-utils.mjs';

function truncate(text, max = 160) {
  if (typeof text !== 'string') return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function quoted(text, max = 160) {
  const cleaned = truncate(clean(text), max);
  return cleaned ? `"${cleaned}"` : '""';
}

function formatClock(ts) {
  if (!ts) return 'unknown';
  try {
    return new Date(ts).toTimeString().slice(0, 8);
  } catch {
    return 'unknown';
  }
}

function formatIso(ts) {
  return ts ? new Date(ts).toISOString() : null;
}

function safeJson(value, max = 120) {
  if (value == null) return '';
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return '[unserializable]';
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function filePath(input = {}) {
  return firstString(input.path, input.file_path, input.absolute_path, input.file);
}

function lineRange(input = {}) {
  const { start, end } = parseToolLineRange(input);
  if (Array.isArray(input.view_range) && input.view_range.length >= 1) {
    return `lines ${start ?? '?'}-${end ?? '?'}`;
  }
  if (start == null) return null;
  const limit = end;
  if (limit == null) return `line ${start}`;
  if (input.end_line != null) return `lines ${start}-${input.end_line}`;
  return `line ${start} (+${limit})`;
}

function summarizePlanEntry(entry) {
  if (typeof entry === 'string') return clean(entry);
  if (!entry || typeof entry !== 'object') return clean(String(entry || ''));
  const status = firstString(entry.status, entry.state);
  const label = firstString(
    entry.title,
    entry.step,
    entry.description,
    entry.summary,
    entry.label,
    entry.text,
    entry.content,
  );
  const rendered = label || safeJson(entry, 80);
  return clean(`${status ? `[${status}] ` : ''}${rendered}`);
}

function summarizePlan(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return truncate(entries.map(summarizePlanEntry).filter(Boolean).slice(0, 4).join('; '), 240);
}

function describeTool(name, kind, input = {}) {
  const loweredName = (name || '').toLowerCase();
  const loweredKind = (kind || '').toLowerCase();
  const path = filePath(input);
  const range = lineRange(input);

  if (path) {
    return `read file ${path}${range ? ` (${range})` : ''}`;
  }

  if (input.pattern != null) {
    const scope = firstString(input.glob, input.path, input.file_path, input.absolute_path);
    return `grep ${quoted(input.pattern, 120)}${scope ? ` in ${scope}` : ''}`;
  }

  if (input.glob != null) {
    return `glob ${quoted(input.glob, 120)}`;
  }

  const query = firstString(input.query, input.q, input.search_query, input.term, input.prompt);
  if (query && (loweredName.includes('web_search') || loweredKind.includes('search'))) {
    return `web_search ${quoted(query, 120)}`;
  }

  const url = firstString(input.url, input.href, input.uri);
  if (url) {
    return `web_fetch ${url}`;
  }

  const cmd = firstString(input.command, input.cmd, input.script);
  if (cmd || loweredName.includes('shell') || loweredKind.includes('shell')) {
    return `shell ${quoted(cmd || safeJson(input, 100), 140)}`;
  }

  const taskPrompt = firstString(input.task, input.description, input.prompt);
  if (loweredName === 'task' || loweredKind === 'task' || taskPrompt) {
    return `delegate task ${quoted(taskPrompt || safeJson(input, 100), 140)}`;
  }

  if (loweredName.includes('web_search')) {
    return `web_search ${quoted(safeJson(input, 100), 120)}`;
  }
  if (loweredName.includes('web_fetch')) {
    return `web_fetch ${quoted(safeJson(input, 100), 120)}`;
  }

  const label = clean(name || kind || 'tool');
  return `${label}${input && Object.keys(input).length > 0 ? ` ${quoted(safeJson(input, 100), 120)}` : ''}`;
}

function toolOutcome(status, outputPreview) {
  const preview = clean(outputPreview);
  if (status === 'failed') {
    return preview ? ` -> failed: ${quoted(preview, 180)}` : ' -> failed';
  }
  if (status === 'completed') {
    return preview ? ` -> ${quoted(preview, 180)}` : '';
  }
  if (status && status !== 'pending') {
    return ` -> ${status}`;
  }
  return '';
}

export function parseJsonlEvents(content) {
  return String(content || '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Merge runs of consecutive { type: 'thought' } and { type: 'message' } events
// into one event each, joining their text. Other event types pass through
// unchanged in original order. Preserves the timestamp of the last chunk in
// the run so polling logic still observes forward motion.
export function coalesceTextChunks(events) {
  const out = [];
  let current = null;
  for (const ev of events) {
    if (ev.type === 'thought' || ev.type === 'message') {
      if (current && current.type === ev.type) {
        current.text += ev.text || '';
        if (ev.ts) current.ts = ev.ts;
        continue;
      }
      if (current) out.push(current);
      current = { type: ev.type, text: ev.text || '', ts: ev.ts };
    } else {
      if (current) {
        out.push(current);
        current = null;
      }
      out.push(ev);
    }
  }
  if (current) out.push(current);
  return out;
}

export function buildPromptInspection(meta, rawEvents, opts = {}) {
  const includeTimeline = opts.includeTimeline !== false;
  const limit = Math.max(1, Math.min(Number(opts.limit) || 40, 200));
  const events = coalesceTextChunks(rawEvents);
  const timeline = [];
  const toolLines = new Map();
  const failedTools = new Set();
  let latestPlan = null;
  let lastAssistantOutput = null;

  const pushLine = (ts, text) => {
    if (!text) return;
    timeline.push({ ts: Number(ts) || 0, text });
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'tool_call': {
        const baseText = describeTool(ev.name, ev.kind, ev.input || {});
        const entry = { ts: ev.ts, baseText, text: baseText };
        timeline.push(entry);
        toolLines.set(ev.toolCallId, entry);
        break;
      }
      case 'tool_call_update': {
        const line = toolLines.get(ev.toolCallId);
        const baseText = line?.baseText || describeTool(ev.name, ev.kind, {});
        const rendered = `${baseText}${toolOutcome(ev.status, ev.outputPreview)}`;
        if (line) {
          line.text = rendered;
        } else {
          pushLine(ev.ts, rendered);
        }
        if (ev.status === 'failed') {
          const failedName = firstString(ev.name, ev.kind);
          if (failedName) failedTools.add(failedName);
        }
        break;
      }
      case 'plan': {
        const summary = summarizePlan(ev.entries);
        if (summary) {
          latestPlan = summary;
          pushLine(ev.ts, `plan update: ${summary}`);
        }
        break;
      }
      case 'message': {
        const text = clean(ev.text);
        if (text) {
          lastAssistantOutput = truncate(text, 240);
          pushLine(ev.ts, `copilot output: ${quoted(text, 220)}`);
        }
        break;
      }
      case 'alert':
        pushLine(ev.ts, `watchdog alert: ${ev.reason}${ev.tier ? ` (tier ${ev.tier})` : ''}`);
        break;
      case 'stuck':
        pushLine(ev.ts, `supervisor marked prompt stuck: ${ev.reason}`);
        break;
      case 'error':
        pushLine(ev.ts, `prompt error: ${truncate(clean(ev.error || 'unknown error'), 180)}`);
        break;
      case 'cancelled':
        pushLine(ev.ts, 'prompt cancelled');
        break;
      case 'done':
        pushLine(ev.ts, `prompt finished (${ev.stopReason || 'end_turn'})`);
        break;
      default:
        break;
    }
  }

  const renderedTimeline = timeline.map((entry) => `[${formatClock(entry.ts)}] ${entry.text}`);
  const activity = includeTimeline ? renderedTimeline.slice(-limit) : undefined;

  return {
    promptId: meta.promptId,
    sessionId: meta.sessionId,
    status: meta.status,
    cwd: meta.cwd || null,
    startedAt: formatIso(meta.startedAt),
    terminalAt: formatIso(meta.terminalAt),
    lastEventAt: formatIso(meta.lastEventAt),
    msSinceLastEvent: meta.msSinceLastEvent ?? null,
    retentionExpiresAt: formatIso(meta.retentionExpiresAt),
    stuckReason: meta.stuckReason || null,
    stuckDetail: meta.stuckDetail || null,
    latestPlan,
    lastAssistantOutput,
    failedTools: [...failedTools],
    activityCount: renderedTimeline.length,
    activityTruncated: includeTimeline ? renderedTimeline.length > limit : false,
    activity,
    inspectAvailable: true,
  };
}
