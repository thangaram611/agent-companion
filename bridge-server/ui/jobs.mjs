// Read-only job list for the live view: every execution in both hosts' state
// directories, with the caller's own name for the job where the host records
// it, and one Claude session's jobs for Claude Code's Companions pane (the
// `jobs` entry at the end). Nothing here writes a record, renews a lease or
// signals a process; the view's messages go through inbox.mjs.
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { stateDirs } from '../../lib/host.mjs';
import { locateTranscript } from '../../lib/transcripts.mjs';
import { Records } from '../controller/records.mjs';
import { pidAlive } from '../controller/process-supervisor.mjs';

const ACTIVE = new Set(['starting', 'delivering', 'running', 'stopping', 'cleanup_pending']);
const RETRY_MS = 30_000;

export { stateDirs };

// A result is final. Without one, an active record whose recorded process is
// gone (the bridge was killed before any handoff) is `unknown`, not running.
export function statusOf(execution, result, alive) {
  if (result) return result.outcome;
  return ACTIVE.has(execution.state) && (!execution.processes?.pid || alive(execution.processes.pid)) ? 'running' : 'unknown';
}
// Nothing more will be written: a result, or a record no longer active. A
// stopping job's tree dies before its result is written (`unknown` for that
// gap, measured on a user cancel); its result and last transcript writes follow.
export const hasEnded = job => Boolean(job.result) || !ACTIVE.has(job.execution.state);

// Records by path, parsed again only when the file changed, so an unchanged
// record keeps its identity. Executions change while running; results are
// immutable once written (`final`). An unreadable record reads as null.
export function recordReader() {
  const files = new Map();
  return function read(path, final = false) {
    const cached = files.get(path);
    if (final && cached?.value) return cached.value;
    let stat;
    try { stat = statSync(path); } catch { files.delete(path); return null; }
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
    let value = null;
    try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { /* unreadable record: not listed */ }
    files.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  };
}

export function createJobSource({ env = process.env, dirs = stateDirs(env), alive = pidAlive } = {}) {
  const stores = dirs.map(({ host, dir }) => ({ host, dir, records: new Records({ dir, log() {} }) }));
  const read = recordReader();
  return {
    // Running jobs first, then the rest by when they finished, newest first.
    list() {
      const jobs = [];
      for (const { host, dir, records } of stores) {
        let names = [];
        try { names = readdirSync(join(dir, 'executions')); } catch { /* host never used */ }
        for (const name of names) {
          if (!name.endsWith('.json') || name.startsWith('.')) continue;
          const id = name.slice(0, -5);
          let execution, result;
          try {
            execution = read(records.path('executions', id));
            result = execution && read(records.path('results', id), true);
          } catch { continue; }
          if (!execution?.executionId) continue;
          const status = statusOf(execution, result, alive);
          // `dir` is the owning host's state dir, where the job's inbox lives.
          jobs.push({ key: `${host}:${id}`, host, dir, execution, result, status, provider: execution.provider,
            project: execution.cwd ? basename(execution.cwd) : '', startedAt: execution.startedAt,
            finishedAt: result?.finishedAt ?? null });
        }
      }
      const at = job => job.status === 'running' ? Infinity : job.finishedAt ?? job.startedAt;
      return jobs.sort((a, b) => at(b) - at(a) || b.startedAt - a.startedAt);
    },
    caller: createCallers(env),
  };
}

// One Claude Code session's jobs for its Companions pane (hooks/mod.ts), which
// has no Node and rebuilds its list from them, a resumed session included (its
// recorded id, or a subagent its transcript spawned): the
// newest job of each of the session's subagents in list() order, the first
// `limit` with the lead's title for each, and the ids of the session's other jobs.
export function sessionJobs({ dir, sessionId, limit, env = process.env, alive = pidAlive }) {
  const source = createJobSource({ dirs: [{ host: 'claude', dir }], env, alive });
  const spawned = sessionAgents(sessionId, env);
  const all = source.list().filter(job => job.execution.hostSessionId === sessionId || spawned.has(job.execution.owner));
  const owners = new Set();
  const jobs = all.filter(job => !owners.has(job.execution.owner) && owners.add(job.execution.owner)).slice(0, limit)
    .map(job => ({ owner: job.execution.owner, title: source.caller(job).title, status: job.status, execution: job.execution, result: job.result }));
  const listed = new Set(jobs.map(job => job.execution.executionId));
  return { jobs, older: all.flatMap(job => listed.has(job.execution.executionId) ? [] : [job.execution.executionId]) };
}

// The subagents a Claude session spawned, from the Agent results its
// transcript records. A resume can continue under a new session id (measured
// 2026-11-17 on 2.1.326: two resumes in a row each got one), copying the
// history, these results included, under it; the jobs keep the id they started under.
function sessionAgents(sessionId, env) {
  const path = locateTranscript({ companion: 'claude', historyId: sessionId, env })?.path;
  if (!path) return new Set();
  const lead = { ino: null, offset: 0, agents: new Map(), custom: null, ai: null };
  try { scanLead(path, lead); } catch { return new Set(); }
  return new Set(lead.agents.keys());
}

const firstLine = text => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';

// Caller identity. Claude: the lead session's transcript records the Agent
// call's result with the subagent id (the execution's owner) and its
// description, and the session's titles. Codex: the subagent thread's own
// rollout names its task (`agent_path`) and parent thread; Codex's session
// index names threads the person or Codex titled. The spawn message itself is
// encrypted in the parent's rollout (measured on codex-cli 0.168), so no
// longer description is readable. Otherwise the task's first line is the title.
export function createCallers(env = process.env) {
  const home = env.HOME || homedir();
  const codexHome = String(env.CODEX_HOME || '').trim() || join(home, '.codex');
  const located = new Map(), leads = new Map(), rollouts = new Map();
  const index = { names: new Map(), mtimeMs: null, size: null };
  // Found paths do not move; a miss is retried after a while, not on every frame.
  function locate(companion, id) {
    const key = `${companion}:${id}`, hit = located.get(key);
    if (hit?.path || (hit && Date.now() - hit.at < RETRY_MS)) return hit.path;
    const path = locateTranscript({ companion, historyId: id, env })?.path ?? null;
    located.set(key, { path, at: Date.now() });
    return path;
  }
  function claude(job) {
    const path = job.execution.hostSessionId && locate('claude', job.execution.hostSessionId);
    if (!path) return {};
    let lead = leads.get(path);
    if (!lead) leads.set(path, lead = { ino: null, offset: 0, agents: new Map(), custom: null, ai: null });
    scanLead(path, lead);
    // A title the person set wins over Claude's generated one.
    return { title: lead.agents.get(job.execution.owner), lead: lead.custom ?? lead.ai };
  }
  function codex(job) {
    let meta = rollouts.get(job.execution.owner);
    if (!meta) {
      const path = locate('codex', job.execution.owner);
      const payload = path ? parseLine(readFirstLine(path))?.payload : null;
      if (!payload) return {};
      const spawn = payload.source?.subagent?.thread_spawn ?? {};
      const task = (payload.agent_path ?? spawn.agent_path ?? '').split('/').pop();
      rollouts.set(job.execution.owner, meta = { task: task ? task.replaceAll('_', ' ') : null, parent: payload.parent_thread_id ?? spawn.parent_thread_id ?? null });
    }
    return { title: meta.task, lead: threadName(meta.parent ?? job.execution.hostSessionId) };
  }
  function threadName(id) {
    const path = join(codexHome, 'session_index.jsonl');
    try {
      const stat = statSync(path);
      if (stat.mtimeMs !== index.mtimeMs || stat.size !== index.size) {
        index.names = new Map();
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          const entry = parseLine(line);
          if (entry?.id && entry.thread_name) index.names.set(entry.id, entry.thread_name);
        }
        Object.assign(index, { mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch { return null; }
    return index.names.get(id) ?? null;
  }
  return function caller(job) {
    let found = {};
    try { found = job.host === 'codex' ? codex(job) : claude(job); } catch { /* unreadable host files: fall back */ }
    return { title: found.title || firstLine(job.execution.text), fromCaller: Boolean(found.title), lead: found.lead ?? null };
  };
}

function parseLine(line) {
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}

// session_meta carries the base instructions, so the first line can be large.
function readFirstLine(path, limit = 8 * 1024 * 1024) {
  const fd = openSync(path, 'r');
  try {
    let bytes = Buffer.alloc(0);
    for (let size = 64 * 1024; bytes.length < limit; size *= 2) {
      const chunk = Buffer.alloc(size);
      const n = readSync(fd, chunk, 0, size, bytes.length);
      bytes = Buffer.concat([bytes, chunk.subarray(0, n)]);
      const end = bytes.indexOf(10);
      if (end >= 0) return bytes.subarray(0, end).toString('utf8');
      if (n < size) return bytes.toString('utf8');
    }
    return null;
  } finally { closeSync(fd); }
}

// Lead transcripts reach 140 MB (measured). Read each appended byte once, in
// chunks, and parse only the lines that carry an agent id or a session title.
const MARKERS = ['"agentId":"', '"type":"custom-title"', '"type":"ai-title"'].map(text => Buffer.from(text));
function scanLead(path, lead, chunkSize = 4 * 1024 * 1024) {
  const fd = openSync(path, 'r');
  try {
    const { size, ino } = fstatSync(fd);
    if (lead.ino !== ino || size < lead.offset) Object.assign(lead, { ino, offset: 0, agents: new Map(), custom: null, ai: null });
    while (lead.offset < size) {
      const chunk = Buffer.alloc(Math.min(chunkSize, size - lead.offset));
      const n = readSync(fd, chunk, 0, chunk.length, lead.offset);
      const end = chunk.lastIndexOf(10, n - 1) + 1;
      if (!end) {
        // A line longer than the chunk (pasted images): read it whole next time round.
        if (lead.offset + n >= size) break;
        chunkSize *= 2; continue;
      }
      const lines = new Set();
      for (const marker of MARKERS) {
        for (let at = chunk.indexOf(marker); at >= 0 && at < end; at = chunk.indexOf(marker, at + 1)) {
          lines.add(chunk.lastIndexOf(10, at) + 1);
        }
      }
      for (const start of [...lines].sort((a, b) => a - b)) {
        const record = parseLine(chunk.subarray(start, chunk.indexOf(10, start)).toString('utf8'));
        const result = record?.toolUseResult;
        if (result?.agentId && typeof result.description === 'string') lead.agents.set(result.agentId, result.description);
        else if (record?.type === 'custom-title' && record.customTitle) lead.custom = record.customTitle;
        else if (record?.type === 'ai-title' && record.aiTitle) lead.ai = record.aiTitle;
      }
      lead.offset += end;
    }
  } finally { closeSync(fd); }
}

// The branch checked out in the job's worktree now (read from .git, no git process).
export function branchOf(cwd) {
  for (let dir = cwd; dir; dir = dirname(dir) === dir ? null : dirname(dir)) {
    const git = join(dir, '.git');
    let gitdir;
    try { gitdir = statSync(git).isFile() ? resolve(dir, /^gitdir: (.+)$/m.exec(readFileSync(git, 'utf8'))[1].trim()) : git; }
    catch { continue; }
    try {
      const head = readFileSync(join(gitdir, 'HEAD'), 'utf8').trim();
      return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
    } catch { return null; }
  }
  return null;
}

const USAGE = `usage: agent-companion jobs <state dir> <session id> <limit>

Prints one Claude Code session's companion jobs as one JSON line: the newest
job of each of its subagents, running first, at most <limit>, and the ids of
its older jobs. Claude Code's Companions pane runs it; it reads only.
`;
if (import.meta.main) {
  const [dir, sessionId, limit, ...rest] = process.argv.slice(2);
  if (!dir || !isAbsolute(dir) || !sessionId || !/^[1-9][0-9]*$/.test(limit ?? '') || rest.length) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(sessionJobs({ dir, sessionId, limit: Number(limit) })) + '\n');
}
