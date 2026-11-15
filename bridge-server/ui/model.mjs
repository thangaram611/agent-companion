// The live view's state: which jobs are listed, which is selected, its followed
// transcript, scroll and fold state, and the key map. render() composes the
// whole screen as rows of styled segments, exactly `columns` cells wide, so the
// Ink layer only prints them. Read-only: nothing here writes outside memory.
import { followTranscript, locateTranscript } from '../../lib/transcripts.mjs';
import { selectTurnItems } from '../../lib/work-summary.mjs';
import { modelName } from '../../lib/digest.mjs';
import { branchOf, createJobSource } from './jobs.mjs';
import { Pane, age, clean, clock, commandText, cut, fitSegs, itemLines, liveLines, outcomeLines, width } from './rows.mjs';

const DAY = 86_400_000;
export const WIDE = 110;
const LIST = 41;
const HOSTS = { claude: 'Claude Code', codex: 'Codex' };
const GLYPHS = { running: ['●', 'ok'], completed: ['✓', 'ok'], failed: ['✗', 'bad'], delivery_unknown: ['✗', 'bad'],
  stopped: ['■', 'warn'], interrupted: ['■', 'warn'], unknown: ['?', 'warn'] };
const HIDDEN = new Set(['usage', 'turn_end', 'preamble']);
// One-row items sit together; anything taller gets a blank line around it.
const COMPACT = new Set(['user', 'reasoning', 'edit', 'preamble']);
const SQLITE_POLL_MS = 1000, LOCATE_MS = 2000;
// Card and header fields are one line each.
const one = text => clean(text).replace(/\s*\n\s*/g, ' ');
const tokens = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const HELP = [['↑↓ j k', 'jobs, or transcript items when the transcript has focus'], ['⏎ ⇥ esc', 'open or focus the job; back to the list'],
  ['PgUp PgDn', 'scroll the transcript a page'], ['g G', 'transcript top; bottom and follow'], ['e E', 'expand the item; expand all'],
  ['p', 'show the preamble'], ['f', 'follow new transcript items'], ['/', 'filter jobs'], ['o', 'show jobs older than 24 hours'], ['q', 'quit']];

export class Model {
  constructor({ env = process.env, source = createJobSource({ env }), now = Date.now, size = { columns: 120, rows: 40 }, exit = () => {} } = {}) {
    Object.assign(this, { env, source, now, size, exit });
    this.listeners = new Set();
    this.version = 0;
    this.jobs = []; this.counts = { running: 0, done: 0, older: 0 };
    this.titles = new Map();
    this.showOlder = false; this.filter = ''; this.editing = false; this.help = false;
    this.selected = null; this.inJob = false; this.listTop = 0;
    this.detail = null; this.second = null;
    this.refresh();
  }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getVersion = () => this.version;
  changed() { this.version++; this.frame = null; for (const listener of this.listeners) listener(); }
  get wide() { return this.size.columns >= WIDE; }
  setSize(size) {
    if (size.columns === this.size.columns && size.rows === this.size.rows) return;
    this.size = size; this.changed();
  }

  // Poll: records, caller titles and the selected transcript. Re-render on a
  // change, and once a second while a job is running for its clock.
  tick() {
    const before = this.jobs, detailChanged = this.refresh();
    const second = Math.floor(this.now() / 1000);
    const clockMoved = second !== this.second && this.jobs.some(job => job.status === 'running');
    this.second = second;
    if (detailChanged || clockMoved || before.length !== this.jobs.length || before.some((job, i) => job !== this.jobs[i])) this.changed();
  }
  refresh() {
    const now = this.now();
    const all = this.source.list();
    const recent = job => job.status === 'running' || (job.finishedAt ?? job.startedAt) >= now - DAY;
    let listed = all.filter(job => this.showOlder || recent(job));
    this.counts = { running: all.filter(job => job.status === 'running').length,
      done: all.filter(job => job.status !== 'running' && recent(job)).length, older: all.filter(job => !recent(job)).length };
    const previous = new Map(this.jobs.map(job => [job.key, job]));
    listed = listed.map(job => {
      const caller = this.source.caller(job);
      const old = previous.get(job.key);
      // Keep identity when nothing shown changed, so a frame is skipped.
      return old && old.execution === job.execution && old.result === job.result && old.status === job.status && old.caller.title === caller.title && old.caller.lead === caller.lead
        ? old : { ...job, caller };
    });
    if (this.filter) {
      const needle = this.filter.toLowerCase();
      listed = listed.filter(job => [job.caller.title, job.caller.lead, job.provider, job.project, job.execution.text]
        .some(value => String(value ?? '').toLowerCase().includes(needle)));
    }
    this.jobs = listed;
    if (!listed.some(job => job.key === this.selected)) this.selected = listed[0]?.key ?? null;
    return this.syncDetail();
  }
  get job() { return this.jobs.find(job => job.key === this.selected) ?? null; }

  // The selected job's transcript, read from its own native store.
  syncDetail() {
    const job = this.job;
    if (!job) { const had = Boolean(this.detail); this.detail = null; return had; }
    let d = this.detail;
    if (d?.key !== job.key) {
      d = this.detail = { key: job.key, job, locator: null, follower: null, located: 0, polled: 0, final: false, items: new Map(),
        list: [], preamble: [], format: null, top: 0, follow: job.status === 'running', cursor: null,
        toggled: new Set(), expandAll: false, showPreamble: false, branch: branchOf(job.execution.cwd), pane: new Pane() };
      this.poll(true);
      return true;
    }
    const turnMoved = d.job.execution.nativeTurnId !== job.execution.nativeTurnId;
    const statusMoved = d.job !== job;
    d.job = job;
    const read = this.poll(false);
    if (turnMoved) this.select();
    return read || statusMoved;
  }
  poll(force) {
    const d = this.detail, { job } = d, now = this.now();
    if (d.final) return false;
    if (!d.follower && (force || now - d.located >= LOCATE_MS)) {
      d.located = now;
      try {
        d.locator = job.execution.transcript ?? locateTranscript({ companion: job.provider, historyId: job.execution.historyId,
          nativeRefs: { ...job.execution.nativeRefs, ...job.result?.nativeRefs }, env: this.env });
      } catch { d.locator = null; }
      if (d.locator) d.follower = followTranscript(d.locator);
    }
    if (!d.follower || (!force && d.locator.kind === 'sqlite' && now - d.polled < SQLITE_POLL_MS)) return false;
    d.polled = now;
    // A finished job's turn no longer changes: one read after it ends.
    if (job.status !== 'running') d.final = true;
    const read = d.follower.read();
    d.format = read.format;
    if (read.reset) d.items.clear();
    if (!read.items.length && !read.reset) return false;
    for (const item of read.items) d.items.set(item.id, item);
    this.select();
    return true;
  }
  select() {
    const d = this.detail, { execution } = d.job;
    const all = [...d.items.values()];
    const turn = selectTurnItems(all, { companion: d.job.provider, nativeTurnId: execution.nativeTurnId, startedAt: execution.startedAt });
    const inTurn = new Set(turn);
    // Session-wide instructions carry no turn id; another turn's preamble is not this job's.
    d.preamble = all.filter(item => item.kind === 'preamble' && (item.turnId == null || inTurn.has(item)));
    d.list = turn.filter(item => !HIDDEN.has(item.kind));
  }

  expanded(id) { const d = this.detail; return d.expandAll !== d.toggled.has(id); }
  blocks() {
    const d = this.detail, { job } = d, ended = job.status !== 'running';
    const cwd = job.execution.cwd, answer = job.result?.text ? clean(job.result.text).trim() : null;
    const blocks = [];
    if (job.result) {
      const expanded = this.expanded('outcome');
      blocks.push({ key: 'outcome', focus: 'outcome', source: job.result, flags: `${expanded}|${d.list.length}`,
        lines: () => outcomeLines(job, { expanded, items: d.list.length }) });
    }
    // Unrecognized records show inline; this is for a missing or unreadable store.
    if (!d.locator || d.format?.version == null) {
      const text = !d.locator ? (ended ? 'transcript not found' : 'waiting for the transcript') : `transcript not recognized: ${d.format?.detail ?? 'not read yet'}`;
      blocks.push({ key: 'notice', source: text, flags: '', lines: () => [{ segs: [[text, d.locator ? 'warn' : 'dim']] }, { segs: [] }] });
    }
    if (d.preamble.length && !d.showPreamble) {
      const text = `preamble · ${d.preamble.length} item${d.preamble.length === 1 ? '' : 's'} · p shows`;
      blocks.push({ key: 'preamble', focus: 'preamble', source: text, flags: '', lines: () => [{ segs: [[text, 'faint']] }, { segs: [] }] });
    }
    let previous = null;
    for (const item of [...(d.showPreamble ? d.preamble : []), ...d.list]) {
      const expanded = this.expanded(item.id);
      const compact = COMPACT.has(item.kind) && !expanded;
      const gap = previous !== null && !(previous && compact);
      blocks.push({ key: item.id, focus: item.id, source: item, flags: `${expanded}|${gap}|${ended}|${answer !== null}`,
        lines: () => [...(gap ? [{ segs: [] }] : []), ...itemLines(item, { expanded, ended, cwd, answer })] });
      previous = compact;
    }
    if (!ended) {
      const now = this.now(), progress = job.execution.progress ?? {};
      const lastText = d.list.findLast(item => item.kind === 'assistant')?.text ?? null;
      const active = progress.activeCommand && d.list.findLast(item => item.kind === 'command' && item.status === 'running'
        && commandText(item.command) === commandText(progress.activeCommand));
      const activeAt = active?.at ? Date.parse(active.at) : null;
      blocks.push({ key: 'live', source: job.execution, flags: `${activeAt == null ? '' : Math.floor((now - activeAt) / 1000)}|${lastText}`,
        lines: () => [{ segs: [] }, ...liveLines(job, { now, lastText, activeAt })] });
    }
    return blocks;
  }

  // Lay out the selected job's pane and settle scroll and cursor for `height` rows.
  layoutPane(w, height) {
    const d = this.detail, pane = d.pane;
    const blocks = this.blocks();
    pane.layout(blocks, w);
    const focusable = blocks.map((block, i) => block.focus ? i : -1).filter(i => i >= 0);
    let index = blocks.findIndex(block => block.focus && block.focus === d.cursor);
    if (d.follow || index < 0) index = (d.follow ? focusable.at(-1) : focusable[0]) ?? -1;
    d.cursor = blocks[index]?.focus ?? null;
    const max = Math.max(0, pane.total - height);
    if (d.follow) d.top = max;
    else if (d.reveal && index >= 0) {
      const start = pane.starts[index], end = pane.starts[index + 1];
      if (start < d.top) d.top = start;
      else if (end > d.top + height) d.top = Math.min(start, end - height);
    }
    d.reveal = false;
    d.top = Math.min(Math.max(0, d.top), max);
    d.height = height; d.index = index; d.focusable = focusable;
  }
  // Keys work on the last laid-out blocks; several can arrive between frames.
  moveCursor(step) {
    const d = this.detail;
    if (!d?.focusable?.length) return;
    const found = d.focusable.findIndex(i => d.pane.blocks[i].focus === d.cursor);
    const at = d.follow || found < 0 ? d.focusable.length - 1 : found;
    const next = d.focusable[Math.min(d.focusable.length - 1, Math.max(0, at + step))];
    d.cursor = d.pane.blocks[next].focus;
    d.follow = false; d.reveal = true;
  }
  scroll(rows) {
    const d = this.detail;
    if (!d) return;
    d.follow = false;
    d.top = Math.max(0, d.top + rows);
    // Keep the cursor on screen: the first item that starts inside the new view.
    const pane = d.pane, top = Math.min(d.top, Math.max(0, pane.total - (d.height ?? 0)));
    const inside = d.focusable?.find(i => pane.starts[i] >= top) ?? d.focusable?.findLast(i => pane.starts[i] < top);
    if (inside != null) d.cursor = pane.blocks[inside].focus;
  }

  key(input, key = {}) {
    if (this.editing) {
      if (key.escape) { this.filter = ''; this.editing = false; }
      else if (key.return) this.editing = false;
      else if (key.backspace || key.delete) this.filter = this.filter.slice(0, -1);
      else if (input && !key.ctrl && !key.meta) this.filter += clean(input).replaceAll('\n', '');
      this.refresh(); this.listTop = 0; return this.changed();
    }
    if (this.help) { if (input === '?' || input === 'q' || key.escape) this.help = false; return this.changed(); }
    if (input === 'q') return this.exit();
    if (input === '?') this.help = true;
    else if (input === '/') this.editing = true;
    else if (input === 'o') { this.showOlder = !this.showOlder; this.refresh(); }
    else if (key.tab && this.wide && this.detail) this.inJob = !this.inJob;
    else if (!this.inJob) {
      const at = this.jobs.findIndex(job => job.key === this.selected);
      const go = i => { this.selected = this.jobs[Math.min(this.jobs.length - 1, Math.max(0, i))]?.key ?? null; this.syncDetail(); };
      if (key.upArrow || input === 'k') go(at - 1);
      else if (key.downArrow || input === 'j') go(at + 1);
      else if (key.home) go(0);
      else if (key.end) go(this.jobs.length - 1);
      else if (key.return && this.detail) this.inJob = true;
      else if (!this.detailKey(input)) return;
    } else if (key.upArrow || input === 'k') this.moveCursor(-1);
    else if (key.downArrow || input === 'j') this.moveCursor(1);
    else if (key.pageUp) this.scroll(-(this.detail?.height ?? 10));
    else if (key.pageDown || input === ' ') this.scroll(this.detail?.height ?? 10);
    else if (key.home || input === 'g') Object.assign(this.detail, { follow: false, top: 0, cursor: null });
    else if (key.end || input === 'G') this.detail.follow = true;
    else if (key.escape) this.inJob = false;
    else if (!this.detailKey(input)) return;
    this.changed();
  }
  detailKey(input) {
    const d = this.detail;
    if (!d) return false;
    if (input === 'e' && d.cursor) { d.toggled.has(d.cursor) ? d.toggled.delete(d.cursor) : d.toggled.add(d.cursor); d.follow = false; d.reveal = true; }
    else if (input === 'E') { d.expandAll = !d.expandAll; d.toggled.clear(); }
    else if (input === 'p') d.showPreamble = !d.showPreamble;
    else if (input === 'f') d.follow = !d.follow;
    else return false;
    return true;
  }

  // The screen: title, blank, body, blank, key hints. Each row is exactly `columns` wide.
  render() {
    if (this.frame) return this.frame;
    // Below this the layout cannot fit; Ink cuts what a tinier terminal cannot show.
    const W = Math.max(30, this.size.columns), H = Math.max(8, this.size.rows);
    const bodyH = Math.max(1, H - 4);
    const title = [[' ', 'normal'], ['agent-companion', 'title'], [`  ${this.counts.running} running · ${this.counts.done} done in 24h`, 'dim']];
    if (this.filter && !this.editing) title.push([`  /${this.filter}`, 'dim']);
    let body;
    if (this.help) body = HELP.map(([keys, text]) => [[' ' + keys.padEnd(12), 'title'], [text, 'dim']]);
    else if (!this.wide) body = this.inJob && this.detail ? this.paneRows(W, bodyH) : this.listRows(W, bodyH);
    else {
      const list = this.listRows(LIST, bodyH), pane = this.paneRows(W - LIST - 1, bodyH);
      body = Array.from({ length: bodyH }, (_, i) => [...fitSegs(list[i] ?? [], LIST), ['│', 'faint'], ...(pane[i] ?? [])]);
    }
    const rows = [title, [], ...body.slice(0, bodyH), [], this.hints()];
    return this.frame = rows.map(row => fitSegs(row, W));
  }
  hints() {
    if (this.editing) return [[' /', 'title'], [this.filter, 'normal'], ['▌', 'faint'], ['   enter keeps   esc clears', 'faint']];
    const job = this.inJob && this.detail;
    const keys = this.wide
      ? job ? '↑↓ items   ⇥ jobs   e expand   E all   p preamble   f follow   ? keys' : '↑↓ jobs   ⇥ focus   e expand   f follow   / filter   ? keys'
      : job ? '↑↓ items   esc back   e expand   f follow   ? keys' : '↑↓ jobs   ⏎ open   / filter   o older   ? keys';
    return [[' ' + keys, 'faint']];
  }
  listRows(w, h) {
    const rows = [];
    if (!this.jobs.length) return [[[' ' + (this.filter ? `No job matches /${this.filter}` : 'No jobs in the last 24 hours'), 'dim']]];
    const olderLine = !this.showOlder && this.counts.older > 0;
    const fits = Math.max(1, Math.floor((h - (olderLine ? 1 : 0)) / 3));
    const at = Math.max(0, this.jobs.findIndex(job => job.key === this.selected));
    if (at < this.listTop) this.listTop = at;
    if (at >= this.listTop + fits) this.listTop = at - fits + 1;
    const now = this.now();
    for (const job of this.jobs.slice(this.listTop, this.listTop + fits)) {
      const bg = job.key === this.selected;
      const [glyph, style] = GLYPHS[job.status] ?? GLYPHS.unknown;
      const when = job.status === 'running' ? clock(now - job.startedAt) : age(now - (job.finishedAt ?? job.startedAt));
      const whenStyle = job.status === 'running' || job.status === 'completed' ? (job.status === 'running' ? 'ok' : 'dim') : style;
      // ' ● ' title, at least two spaces, the time, one space.
      const name = cut(one(job.caller.title), w - 6 - width(when));
      rows.push([[' ', 'normal', bg], [glyph, style, bg], [' ', 'normal', bg], [name, 'title', bg],
        [' '.repeat(w - 4 - width(name) - width(when)), 'normal', bg], [when, whenStyle, bg], [' ', 'normal', bg]]);
      rows.push(fitSegs([['   ', 'normal', bg], [cut(`${job.provider} · ${one(job.project)}`, w - 4), 'dim', bg]], w));
      rows.push([]);
    }
    if (olderLine) { while (rows.length < h - 1) rows.push([]); rows.push([[` ${this.counts.older} older`, 'faint']]); }
    return rows;
  }
  // Two columns before the text: the item cursor's gutter and a space.
  paneRows(w, h) {
    const margin = 2;
    const d = this.detail;
    if (!d) return [];
    const { job } = d, { execution, result } = job;
    const progress = execution.progress ?? {};
    const model = modelName(result?.effectiveModel ?? progress.effectiveModel ?? execution.effectiveModel ?? execution.modelOverride);
    const effort = result?.effectiveEffort ?? progress.effectiveEffort ?? execution.effectiveEffort ?? execution.effortOverride;
    const used = result?.usage?.total_tokens;
    const parts = [HOSTS[job.host] + (job.caller.lead ? ` › ${one(job.caller.lead)}` : ''),
      [model, effort].filter(Boolean).map(String).map(one).join(' '), used != null ? `${tokens(used)} tokens` : '', d.branch ? one(d.branch) : ''];
    const pad = ' '.repeat(margin);
    const header = [[pad + parts.filter(Boolean).join(' · '), 'dim']];
    const height = Math.max(1, h - 2);
    this.layoutPane(w - margin, height);
    const focused = this.inJob;
    const rows = [header, []];
    for (const { block, row } of d.pane.slice(d.top, height)) {
      const mark = focused && block === d.index && row.length ? ['▎', 'edit'] : [' ', 'normal'];
      rows.push([mark, [' ', 'normal'], ...row]);
    }
    return rows;
  }
}
