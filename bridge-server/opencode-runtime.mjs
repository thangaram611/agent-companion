import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { digestPath } from '../lib/prompt-digest.mjs';
import { writePrivateFile } from '../lib/runtime-paths.mjs';

const running = new Map();
const cancelRequested = new Set();
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_SUMMARY_CHARS = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 40 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5_000;

export function resolveOpenCodeBin(env = process.env) {
  return String(env.OPENCODE_BIN || 'opencode').trim() || 'opencode';
}

export function resolveOpenCodePermissionMode(env = process.env) {
  const explicit = String(env.AGENT_COMPANION_OPENCODE_PERMISSION_MODE || '').trim().toLowerCase();
  if (explicit === 'skip' || explicit === 'dangerously-skip') {
    return { mode: 'skip', skipPermissions: true, source: 'env' };
  }
  if (explicit === 'default' || explicit === 'prompt') {
    return { mode: 'default', skipPermissions: false, source: 'env' };
  }
  return { mode: 'default', skipPermissions: false, source: 'fallback' };
}

export function resolveOpenCodeTimeoutMs(env = process.env) {
  const raw = String(env.AGENT_COMPANION_OPENCODE_TIMEOUT_MS || '').trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return n;
}

export function openCodeRuntimeInfo(env = process.env) {
  return {
    bin: resolveOpenCodeBin(env),
    permission: resolveOpenCodePermissionMode(env),
    timeout_ms: resolveOpenCodeTimeoutMs(env),
  };
}

export function openCodePromptId(jobId) {
  return `opencode-${jobId}`;
}

export function startOpenCodeRun({
  jobId,
  cwd,
  prompt,
  model = null,
  agent = null,
  title = null,
  env = process.env,
  onStarted = () => {},
}) {
  const bin = resolveOpenCodeBin(env);
  const permission = resolveOpenCodePermissionMode(env);
  const timeoutMs = resolveOpenCodeTimeoutMs(env);
  const args = ['run', '--dir', cwd, '--format', 'json'];
  if (model) args.push('--model', model);
  if (agent) args.push('--agent', agent);
  if (title) args.push('--title', title);
  if (permission.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  args.push(prompt);

  let timedOut = false;
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(jobId, child);
  onStarted({
    pid: child.pid || null,
    promptId: openCodePromptId(jobId),
    command: bin,
    args,
  });

  let stdout = '';
  let stderr = '';
  const collector = createOpenCodeCollector();
  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stdout = appendCapped(stdout, text, MAX_CAPTURE_BYTES);
    collector.push(text);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendCapped(stderr, chunk.toString('utf8'), MAX_CAPTURE_BYTES);
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      const hardKill = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, DEFAULT_KILL_GRACE_MS);
      if (hardKill.unref) hardKill.unref();
    }, timeoutMs);
    if (timeout.unref) timeout.unref();

    const finish = (result) => {
      clearTimeout(timeout);
      running.delete(jobId);
      cancelRequested.delete(jobId);
      resolve(result);
    };

    child.on('error', (err) => {
      finish({
        status: 'failed',
        error: err.message,
        summary: null,
        stdout,
        stderr,
        exitCode: null,
        signal: null,
      });
    });
    child.on('close', (code, signal) => {
      const summary = summarizeOpenCodeOutput(stdout, stderr, collector.finish());
      const cancelled = cancelRequested.has(jobId) || signal === 'SIGTERM' || signal === 'SIGKILL';
      const status = timedOut ? 'timeout' : cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed';
      finish({
        status,
        error: status === 'failed' ? (summary.error || stderr.trim() || `opencode exited with code ${code}`) : null,
        summary,
        stdout,
        stderr,
        exitCode: code,
        signal,
        timedOut,
        permission,
        timeoutMs,
      });
    });
  });
}

export function cancelOpenCodeRun(jobId, pid = null) {
  const child = running.get(jobId);
  if (child && !child.killed) {
    cancelRequested.add(jobId);
    child.kill('SIGTERM');
    return { ok: true, reason: 'signalled-child', pid: child.pid || pid || null };
  }
  if (pid) {
    try {
      cancelRequested.add(jobId);
      process.kill(pid, 'SIGTERM');
      return { ok: true, reason: 'signalled-pid', pid };
    } catch (err) {
      return { ok: false, reason: err.message, pid };
    }
  }
  return { ok: false, reason: 'no running OpenCode process found', pid: null };
}

export function writeOpenCodeDigest(job, result = null) {
  const path = digestPath(job?.jobId);
  if (!path) return null;
  const stdout = result?.stdout ? truncateBlock(result.stdout.trim(), 12_000) : '';
  const stderr = result?.stderr ? truncateBlock(result.stderr.trim(), 4_000) : '';
  const summary = result?.summary?.message || '';
  const lines = [];
  lines.push(`# ${job?.target || 'opencode'} job ${job?.jobId || '(unknown)'} - digest`);
  lines.push('');
  lines.push(`**Updated:** ${new Date().toISOString()}`);
  if (job?.status) lines.push(`**Status:** \`${job.status}\``);
  if (job?.mode) lines.push(`**Mode:** ${job.mode}`);
  if (job?.template) lines.push(`**Template:** ${job.template}`);
  if (job?.thread) lines.push(`**Thread:** \`${job.thread}\``);
  if (job?.promptId) lines.push(`**Prompt:** \`${job.promptId}\``);
  if (job?.cwd) lines.push(`**CWD:** \`${job.cwd}\``);
  if (job?.startedAt) lines.push(`**Started:** ${new Date(job.startedAt).toISOString()}`);
  if (job?.terminalAt) lines.push(`**Terminal:** ${new Date(job.terminalAt).toISOString()}`);
  lines.push('');
  if (job?.task) {
    lines.push('## Task', '', truncateBlock(job.task, 1500), '');
  }
  if (summary) {
    lines.push('## Final / partial assistant message', '', truncateBlock(summary, 12_000), '');
  }
  if (stdout) {
    lines.push('## Raw stdout', '', '```text', stdout, '```', '');
  }
  if (stderr) {
    lines.push('## Raw stderr', '', '```text', stderr, '```', '');
  }
  try {
    writePrivateFile(path, lines.join('\n'));
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

function summarizeOpenCodeOutput(stdout, stderr, collected = null) {
  const parsed = collected?.events?.length ? collected.events : parseJsonFragments(stdout);
  const message = collected?.message || chooseMessage(parsed, stdout, stderr);
  const toolCalls = collected?.toolCalls?.length
    ? collected.toolCalls
    : parsed
      .filter((entry) => entry && typeof entry === 'object' && /tool/i.test(String(entry.type || entry.event || entry.kind || '')))
      .map((entry) => ({ input: entry.input || entry.args || {}, name: entry.name || entry.tool || entry.type || entry.event }));
  return {
    message: truncateBlock(message, MAX_SUMMARY_CHARS),
    thoughts: '',
    toolCalls,
    stopReason: parsed.length > 0 ? 'json' : 'text',
    error: collected?.error || stderr.trim() || null,
  };
}

function createOpenCodeCollector() {
  let pending = '';
  const events = [];
  const messageParts = [];
  const toolCalls = [];
  let error = null;
  return {
    push(text) {
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    },
    finish() {
      if (pending.trim()) consumeLine(pending);
      return {
        events,
        message: messageParts.map((part) => part.trim()).filter(Boolean).join('\n'),
        toolCalls,
        error,
      };
    },
  };

  function consumeLine(line) {
    const clean = line.trim();
    if (!clean) return;
    let entry;
    try { entry = JSON.parse(clean); }
    catch { return; }
    events.push(entry);
    const type = eventType(entry);
    if (/tool/i.test(type)) {
      toolCalls.push({ input: entry.input || entry.args || {}, name: entry.name || entry.tool || entry.type || entry.event || 'tool' });
      return;
    }
    if (/error|fail/i.test(type) || typeof entry.error === 'string') {
      error = entry.error || entry.message || error;
    }
    const parts = extractAssistantStrings(entry);
    for (const part of parts) messageParts.push(part);
  }
}

function parseJsonFragments(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  const out = [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {}
  for (const line of trimmed.split('\n')) {
    const clean = line.trim();
    if (!clean) continue;
    try { out.push(JSON.parse(clean)); } catch {}
  }
  return out;
}

function chooseMessage(parsed, stdout, stderr) {
  const candidates = parsed.flatMap((entry) => extractAssistantStrings(entry));
  const preferred = candidates.filter((s) => s.trim().length > 0).join('\n');
  if (preferred) return preferred.trim();
  if (parsed.length > 0) return '';
  const raw = String(stdout || '').trim();
  if (raw) return raw;
  return String(stderr || '').trim();
}

function eventType(entry) {
  return String(entry?.type || entry?.event || entry?.kind || '');
}

function extractAssistantStrings(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const type = eventType(entry);
  if (/tool/i.test(type)) return [];
  if (/error|fail/i.test(type) || typeof entry.error === 'string') return [];
  const out = [];
  if (entry.role === 'assistant') collectContent(entry.content, out);
  if (/assistant|message|text|response|result|summary|output/i.test(type)) {
    collectMessageLike(entry, out);
  }
  if (out.length === 0) collectMessageLike(entry, out, { shallow: true });
  return out;
}

function collectContent(value, out) {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectContent(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.text === 'string') out.push(value.text);
  if (typeof value.content === 'string') out.push(value.content);
}

function collectMessageLike(value, out, { shallow = false } = {}) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/tool|input|args|stdout|stderr|error/i.test(key)) continue;
    if (['message', 'content', 'text', 'output', 'result', 'response', 'summary'].includes(key) && typeof child === 'string') {
      out.push(child);
      continue;
    }
    if (!shallow && child && typeof child === 'object') collectMessageLike(child, out);
  }
}

function truncateBlock(s, n) {
  const text = String(s || '');
  return text.length > n ? `${text.slice(0, n)}\n\n[truncated ${text.length - n} chars]` : text;
}

function appendCapped(current, chunk, maxBytes) {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= maxBytes) return next;
  return next.slice(Math.max(0, next.length - maxBytes));
}
