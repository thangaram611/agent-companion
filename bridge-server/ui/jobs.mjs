// Read-only job list for the live view: every execution in both hosts' state
// directories with its thread's title and its lead session's name, and one
// Claude session's threads for Claude Code's Companions pane (the `jobs` entry
// at the end). Nothing here writes a record, renews a lease or
// signals a process; the view's messages go through inbox.mjs.
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { stateDirs, HOSTS } from '../../lib/hosts/index.mjs';
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
          let execution, result, conversation;
          try {
            execution = read(records.path('executions', id));
            result = execution && read(records.path('results', id), true);
            conversation = execution && read(records.path('conversations', execution.owner));
          } catch { continue; }
          if (!execution?.executionId) continue;
          const status = statusOf(execution, result, alive);
          // `dir` is the owning host's state dir, where the job's inbox lives.
          jobs.push({ key: `${host}:${id}`, host, dir, execution, result, conversation, status, provider: execution.provider,
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

// The session a job's lead belongs to; a job from before threads has only the
// bridge's host session.
const leadSession = job => job.conversation?.lead?.session ?? job.execution.hostSessionId;

// One Claude Code session's threads for its Companions pane (hooks/mod.ts),
// which has no Node and rebuilds its list from them: the newest job of each
// thread whose lead is this session (main conversation or its subagents), in
// list() order, the first `limit` with their titles, and the ids of the
// session's other jobs. Another session's threads, one before a /clear
// included, are left to the live view.
export function sessionJobs({ dir, sessionId, limit, env = process.env, alive = pidAlive }) {
  const source = createJobSource({ dirs: [{ host: HOSTS.claude.id, dir }], env, alive });
  const all = source.list().filter(job => leadSession(job) === sessionId);
  const threads = new Set();
  const jobs = all.filter(job => !threads.has(job.execution.owner) && threads.add(job.execution.owner)).slice(0, limit)
    .map(job => ({ thread: job.execution.owner, title: source.caller(job).title, status: job.status, execution: job.execution, result: job.result }));
  const listed = new Set(jobs.map(job => job.execution.executionId));
  return { jobs, older: all.flatMap(job => listed.has(job.execution.executionId) ? [] : [job.execution.executionId]) };
}

const firstLine = text => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';

// A job's title is its thread's (the lead's `title` on send, else the task's
// first line). The lead's name is its session's title: Claude's from the lead
// transcript, a title the person set winning over the generated one; Codex's
// from its session index, which names threads the person or Codex titled.
export function createCallers(env = process.env) {
  const codexHome = HOSTS.codex.configDir(env);
  const located = new Map(), leads = new Map();
  const index = { names: new Map(), mtimeMs: null, size: null };
  // Found paths do not move; a miss is retried after a while, not on every frame.
  function locate(id) {
    const hit = located.get(id);
    if (hit?.path || (hit && Date.now() - hit.at < RETRY_MS)) return hit.path;
    const path = locateTranscript({ companion: HOSTS.claude.id, historyId: id, env })?.path ?? null;
    located.set(id, { path, at: Date.now() });
    return path;
  }
  function claudeName(session) {
    const path = locate(session);
    if (!path) return null;
    let lead = leads.get(path);
    if (!lead) leads.set(path, lead = { ino: null, offset: 0, custom: null, ai: null });
    scanLead(path, lead);
    return lead.custom ?? lead.ai;
  }
  function codexName(id) {
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
  const names = { [HOSTS.claude.id]: claudeName, [HOSTS.codex.id]: codexName };
  return function caller(job) {
    const session = leadSession(job);
    let lead = null;
    try { lead = session ? names[job.host]?.(session) ?? null : null; } catch { /* unreadable host files: no name */ }
    return { title: job.conversation?.title || firstLine(job.execution.text), lead };
  };
}

function parseLine(line) {
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}

// Lead transcripts reach 140 MB (measured). Read each appended byte once, in
// chunks, and parse only the lines that carry a session title.
const MARKERS = ['"type":"custom-title"', '"type":"ai-title"'].map(text => Buffer.from(text));
function scanLead(path, lead, chunkSize = 4 * 1024 * 1024) {
  const fd = openSync(path, 'r');
  try {
    const { size, ino } = fstatSync(fd);
    if (lead.ino !== ino || size < lead.offset) Object.assign(lead, { ino, offset: 0, custom: null, ai: null });
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
        if (record?.type === 'custom-title' && record.customTitle) lead.custom = record.customTitle;
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

Prints one Claude Code session's companion threads as one JSON line: the
newest job of each thread its lead started, running first, at most <limit>,
and the ids of its older jobs. Claude Code's Companions pane runs it; it reads only.
`;
if (import.meta.main) {
  const [dir, sessionId, limit, ...rest] = process.argv.slice(2);
  if (!dir || !isAbsolute(dir) || !sessionId || !/^[1-9][0-9]*$/.test(limit ?? '') || rest.length) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(sessionJobs({ dir, sessionId, limit: Number(limit) })) + '\n');
}
