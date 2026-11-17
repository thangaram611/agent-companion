// One job's transcript as the views follow it: located in its companion's
// native store, read as it grows and narrowed to the job's turn. Read-only.
import { followTranscript, locateTranscript } from '../../lib/transcripts.mjs';
import { selectTurnItems } from '../../lib/work-summary.mjs';
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
