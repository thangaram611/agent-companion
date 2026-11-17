// One job's transcript as both views follow it: the live view's job pane
// (model.mjs) reads it in process, and Claude Code's Companions pane
// (hooks/mod.ts), which has no Node, reads it as JSON lines from the `follow`
// entry below. Read-only: nothing here writes a record or signals a process.
import { isAbsolute } from 'node:path';
import { followTranscript, locateTranscript } from '../../lib/transcripts.mjs';
import { selectTurnItems } from '../../lib/work-summary.mjs';
import { Records } from '../controller/records.mjs';
import { pidAlive } from '../controller/process-supervisor.mjs';
import { branchOf, recordReader, statusOf } from './jobs.mjs';
import { clean } from './rows.mjs';

const HIDDEN = new Set(['usage', 'turn_end', 'preamble']);
const SQLITE_POLL_MS = 1000, LOCATE_MS = 2000;
// Claude records a message that joined the running turn as a queued_command
// attachment (measured on 2.1.325): a message, not preamble.
const joinedMessages = new WeakMap();
function joined(item) {
  if (item.kind !== 'preamble' || item.attachment?.type !== 'queued_command') return item;
  let message = joinedMessages.get(item);
  if (!message) joinedMessages.set(item, message = { ...item, kind: 'user', text: item.attachment.prompt });
  return message;
}

// job: { provider, execution, result, status }, as jobs.mjs lists it.
export class JobTranscript {
  locator = null; follower = null; format = null; final = false; located = 0; polled = 0;
  items = new Map();
  constructor({ env = process.env, now = Date.now } = {}) { Object.assign(this, { env, now }); }
  // Reads what the companion's native store gained; true when the items
  // changed. A missing store is looked for again every 2 s, SQLite is read at
  // most once a second, and a finished job's turn no longer changes: one read after it ends.
  poll(job, force = false) {
    if (this.final) return false;
    const now = this.now();
    if (!this.follower && (force || now - this.located >= LOCATE_MS)) {
      this.located = now;
      try {
        this.locator = job.execution.transcript ?? locateTranscript({ companion: job.provider, historyId: job.execution.historyId,
          nativeRefs: { ...job.execution.nativeRefs, ...job.result?.nativeRefs }, env: this.env });
      } catch { this.locator = null; }
      if (this.locator) this.follower = followTranscript(this.locator);
    }
    if (!this.follower || (!force && this.locator.kind === 'sqlite' && now - this.polled < SQLITE_POLL_MS)) return false;
    this.polled = now;
    if (job.status !== 'running') this.final = true;
    const read = this.follower.read();
    this.format = read.format;
    if (read.reset) this.items.clear();
    if (!read.items.length && !read.reset) return false;
    for (const item of read.items) this.items.set(item.id, item);
    return true;
  }
  // The job's turn as the views list it, the preamble apart, and who wrote
  // each user message: the first is the task; a later one takes the first
  // unclaimed recorded message with exactly its text, whose sender names it
  // (lead or you; `taken` holds those ids); anything else stays `user`.
  select(job) {
    const { execution } = job;
    const all = [...this.items.values()];
    const turn = selectTurnItems(all, { companion: job.provider, nativeTurnId: execution.nativeTurnId,
      nativeTurnIds: execution.nativeTurnIds, interventions: execution.interventions, startedAt: execution.startedAt });
    const inTurn = new Set(turn);
    // Session-wide instructions carry no turn id; another turn's preamble is not this job's.
    const preamble = all.filter(item => item.kind === 'preamble' && joined(item) === item && (item.turnId == null || inTurn.has(item)));
    const list = turn.map(joined).filter(item => !HIDDEN.has(item.kind));
    const labels = new Map(), taken = new Set(), inputs = execution.interventions ?? [];
    let first = true;
    for (const item of list) {
      if (item.kind !== 'user') continue;
      if (first) { labels.set(item.id, 'task'); first = false; continue; }
      const text = clean(item.text ?? '').trim();
      const input = inputs.find(input => !taken.has(input.id) && clean(input.text ?? '').trim() === text);
      if (!input) continue;
      taken.add(input.id);
      labels.set(item.id, input.from === 'user' ? 'you' : 'lead');
    }
    return { list, preamble, labels, taken };
  }
}

// The pane draws only what fits; the rest is in `agent-companion ui`.
const TAIL = 100, POLL_MS = 250;
const turnOf = ({ nativeTurnId, nativeTurnIds, interventions }) => `${nativeTurnId}|${nativeTurnIds?.length}|${interventions?.length}`;

// One job's lines for the pane: { job } whenever its records or status
// change, then { turn, items } whenever its selected turn does: the last
// TAIL items' ids, how many come before them, their labels, the recorded
// messages the transcript shows (taken), whether the transcript was found and
// its format, with only the items not sent before. tick() answers the lines
// since the last tick and whether the job has ended, its final read done.
export function createFollow({ dir, executionId, env = process.env, now = Date.now, alive = pidAlive }) {
  const records = new Records({ dir, log() {} }), read = recordReader();
  const paths = { execution: records.path('executions', executionId), result: records.path('results', executionId) };
  const transcript = new JobTranscript({ env, now });
  let job = null, branch, seen = null, turn = null, sent = new Map(), sentTurn = null;
  return {
    tick() {
      const execution = read(paths.execution);
      if (!execution?.executionId) throw new Error(`no execution record ${executionId} in ${dir}`);
      const result = read(paths.result, true);
      const status = statusOf(execution, result, alive);
      const lines = [];
      if (execution !== job?.execution || result !== job?.result || status !== job?.status) {
        branch ??= branchOf(execution.cwd);
        job = { provider: execution.provider, execution, result, status };
        lines.push({ job: { status, execution, result, branch } });
      }
      const ended = status !== 'running';
      let items = [];
      if (transcript.poll(job, seen === null || ended) || turnOf(execution) !== seen) {
        seen = turnOf(execution);
        const { list, labels, taken } = transcript.select(job);
        const tail = list.slice(-TAIL);
        turn = { ids: tail.map(item => item.id), earlier: list.length - tail.length,
          labels: Object.fromEntries(tail.flatMap(item => labels.has(item.id) ? [[item.id, labels.get(item.id)]] : [])), taken: [...taken] };
        items = tail.filter(item => sent.get(item.id) !== item);
        sent = new Map(tail.map(item => [item.id, item]));
      }
      const message = { ...turn, located: Boolean(transcript.locator),
        format: transcript.format && { version: transcript.format.version, detail: transcript.format.detail } };
      const key = JSON.stringify(message);
      if (items.length || key !== sentTurn) { lines.push({ turn: message, items }); sentTurn = key; }
      return { lines: lines.map(line => JSON.stringify(line)), ended };
    },
  };
}

const USAGE = `usage: agent-companion follow <state dir> <execution id>

Prints one companion job's records and selected transcript items as JSON
lines while it runs, then exits after the final read once it has ended.
Claude Code's Companions pane runs it; it reads only.
`;
if (import.meta.main) {
  const [dir, executionId, ...rest] = process.argv.slice(2);
  let follow;
  try {
    if (!dir || !isAbsolute(dir) || rest.length) throw new Error('needs an absolute state dir and an execution id');
    follow = createFollow({ dir, executionId });
  } catch {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  // The pane ends it by killing it; a pane whose session died leaves it orphaned.
  const parent = process.ppid;
  process.stdout.on('error', () => process.exit(0));
  let timer = null;
  const step = () => {
    let out;
    try { out = follow.tick(); } catch (error) {
      process.stderr.write(`agent-companion follow: ${error.message}\n`);
      process.exit(1);
    }
    for (const line of out.lines) process.stdout.write(line + '\n');
    if (out.ended || process.ppid !== parent) { clearInterval(timer); timer = false; }
  };
  step();
  if (timer === null) timer = setInterval(step, POLL_MS);
}
