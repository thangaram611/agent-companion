// The live view's state: which jobs are listed, which is selected, its followed
// transcript, scroll and fold state, each running job's message box, and the
// key map. render() composes the whole screen as rows of styled segments,
// exactly `columns` cells wide, so the Ink layer only prints them. The only
// writes are the box's inbox requests, through inbox.mjs; drafts stay in memory.
import { randomUUID } from 'node:crypto';
import { jobModel } from '../../lib/model-name.mjs';
import { JobTranscript } from './follow.mjs';
import { takeOutcome, writeRequest } from './inbox.mjs';
import { branchOf, createJobSource } from './jobs.mjs';
import { Pane, boxRows, cardHead, clean, cut, fitSegs, jobBlocks, layoutLine, one, pendingInputs, pendingLine, segsWidth, width, COMPANION_NAMES, MODE_HINTS, supportedModes } from './rows.mjs';

const DAY = 86_400_000;
export const WIDE = 110;
const LIST = 41;
const HOSTS = { claude: 'Claude Code', codex: 'Codex' };
const tokens = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const HELP = [['↑↓ j k', 'jobs, or transcript items when the transcript has focus'], ['⏎ ⇥ esc', 'open or focus the job; back to the list'],
  ['PgUp PgDn', 'scroll the transcript a page'], ['g G', 'transcript top; bottom and follow'], ['e E', 'expand the item; expand all'],
  ['p', 'show the preamble'], ['f', 'follow new transcript items'], ['/', 'filter jobs'], ['o', 'show jobs older than 24 hours'], ['q', 'quit'],
  ['', 'In a running job, the message box has the keys:'], ['typing ⏎', 'write; send in the shown mode'], ['shift+⇥ ctrl+j', 'next mode; new line'],
  ['↑↓ PgUp PgDn', 'scroll the transcript'], ['ctrl+o', 'expand or fold all outputs'], ['ctrl+x', 'cancel the job, after one confirmation'],
  ['esc', 'back to the list, keeping the draft'], ['ctrl+c', 'clear the draft; on an empty box, quit']];
const NAMES = COMPANION_NAMES, MODES = MODE_HINTS;
const supported = job => supportedModes(job.execution);
const REFUSED = { state: 'the job takes no more messages', capability: 'not supported by this companion', text_too_long: 'too long', request_too_large: 'too long' };
// Typed or pasted text: a carriage return inside it is a new line; escapes and control characters go, as in native text.
const draftText = text => clean(text.replace(/\r\n?/g, '\n'));

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
    // Per job key: { draft, mode, confirm, sent: [request + dir + outcome] }.
    this.boxes = new Map();
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
    // Outcomes first, so a request the record now holds is not shown twice.
    const before = this.jobs, outcomes = this.takeOutcomes(), detailChanged = this.refresh();
    const second = Math.floor(this.now() / 1000);
    const clockMoved = second !== this.second && this.jobs.some(job => job.status === 'running');
    this.second = second;
    if (outcomes || detailChanged || clockMoved || before.length !== this.jobs.length || before.some((job, i) => job !== this.jobs[i])) this.changed();
  }
  // Each outcome is read once, then deleted; a refused message returns to an empty box.
  takeOutcomes() {
    let moved = false;
    for (const box of this.boxes.values()) for (const sent of box.sent) {
      if (sent.outcome) continue;
      sent.outcome = takeOutcome(sent.dir, sent.executionId, sent.requestId);
      if (!sent.outcome) continue;
      moved = true;
      if (!sent.outcome.ok && sent.text && !box.draft) box.draft = sent.text;
    }
    return moved;
  }
  refresh() {
    const now = this.now();
    const all = this.source.list();
    // A request the record holds shows from the record; an ended job's requests are moot.
    for (const job of all) {
      const box = this.boxes.get(job.key);
      if (!box) continue;
      if (job.status !== 'running') { box.sent = []; box.confirm = false; continue; }
      const recorded = new Set((job.execution.interventions ?? []).map(input => input.id));
      box.sent = box.sent.filter(sent => !(sent.outcome?.ok && recorded.has(sent.outcome.interventionId)));
    }
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
      d = this.detail = { key: job.key, job, transcript: new JobTranscript({ env: this.env, now: this.now }),
        list: [], preamble: [], top: 0, follow: job.status === 'running', cursor: null,
        toggled: new Set(), expandAll: false, showPreamble: false, branch: branchOf(job.execution.cwd), pane: new Pane(),
        labels: new Map(), taken: new Set() };
      this.poll(true);
      return true;
    }
    const turnMoved = d.job.execution.nativeTurnId !== job.execution.nativeTurnId
      || d.job.execution.nativeTurnIds?.length !== job.execution.nativeTurnIds?.length
      || d.job.execution.interventions?.length !== job.execution.interventions?.length;
    const statusMoved = d.job !== job;
    d.job = job;
    const read = this.poll(false);
    if (turnMoved) this.select();
    return read || statusMoved;
  }
  poll(force) {
    const d = this.detail;
    if (!d.transcript.poll(d.job, force)) return false;
    this.select();
    return true;
  }
  select() { const d = this.detail; Object.assign(d, d.transcript.select(d.job)); }

  expanded(id) { const d = this.detail; return d.expandAll !== d.toggled.has(id); }
  blocks() {
    const d = this.detail, { locator, format } = d.transcript;
    return jobBlocks(d.job, { list: d.list, preamble: d.preamble, labels: d.labels, located: Boolean(locator), format, now: this.now(),
      expanded: id => this.expanded(id), showPreamble: d.showPreamble });
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

  // Ink 8 reports ctrl+letter as the letter with key.ctrl (ctrl+c too, with
  // exitOnCtrlC off), shift+tab as key.tab with key.shift, and ctrl+j as input
  // '\n' (or 'j' with key.ctrl under the kitty protocol). Measured 2026-11-15.
  key(input, key = {}) {
    const typing = this.typing;
    if (typing) return this.boxKey(typing, input, key);
    if (key.ctrl && input === 'c') return this.exit();
    if (this.editing) {
      if (key.escape) { this.filter = ''; this.editing = false; }
      else if (key.return) this.editing = false;
      else if (key.backspace || key.delete) this.filter = this.filter.slice(0, -1);
      else if (input && !key.ctrl && !key.meta) this.filter += clean(input).replaceAll('\n', '');
      this.refresh(); this.listTop = 0; return this.changed();
    }
    if (this.help) { if (input === '?' || input === 'q' || key.escape) this.help = false; return this.changed(); }
    // A ctrl+letter is not the letter's key.
    if (key.ctrl) {
      if (input !== 'o' || !this.detail) return;
      this.toggleAll();
      return this.changed();
    }
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
    else if (input === 'E') this.toggleAll();
    else if (input === 'p') d.showPreamble = !d.showPreamble;
    else if (input === 'f') d.follow = !d.follow;
    else return false;
    return true;
  }
  toggleAll() { const d = this.detail; d.expandAll = !d.expandAll; d.toggled.clear(); }

  // The open running job whose box has the keys; a record without
  // interventionModes comes from an older bridge, which reads no inbox.
  get typing() {
    const job = this.inJob && !this.help && !this.editing ? this.detail?.job : null;
    return job?.status === 'running' && job.execution.interventionModes ? job : null;
  }
  box(job) {
    let box = this.boxes.get(job.key);
    if (!box) {
      const modes = supported(job), preferred = job.execution.interventionModes?.default;
      this.boxes.set(job.key, box = { draft: '', mode: modes.includes(preferred) ? preferred : modes[0] ?? null, confirm: false, sent: [] });
    }
    return box;
  }
  boxKey(job, input, key) {
    const box = this.box(job), d = this.detail, modes = supported(job);
    if (box.confirm) {
      if (input === 'y' || input === 'Y') { box.confirm = false; this.send(job, 'cancel'); }
      else if (input === 'n' || input === 'N' || key.escape || (key.ctrl && input === 'c')) box.confirm = false;
      else return;
    } else if (key.ctrl) {
      if (input === 'c') { if (!box.draft) return this.exit(); box.draft = ''; }
      else if (input === 'x') box.confirm = true;
      else if (input === 'o') this.toggleAll();
      else if (input === 'j' && box.mode) box.draft += '\n';
      else return;
    } else if (key.return) {
      // Terminals that tell shift+⏎ or alt+⏎ apart get a new line, never a send.
      if (key.shift || key.meta) { if (box.mode) box.draft += '\n'; } else this.send(job, box.mode);
    } else if (key.tab) {
      if (!key.shift || modes.length < 2) return;
      box.mode = modes[(modes.indexOf(box.mode) + 1) % modes.length];
    } else if (key.escape) this.inJob = false;
    else if (key.upArrow || key.downArrow) this.scrollBox(key.upArrow ? -1 : 1);
    else if (key.pageUp || key.pageDown) this.scrollBox((key.pageUp ? -1 : 1) * (d.height ?? 10));
    else if (key.backspace || key.delete) box.draft = box.draft.slice(0, /[\udc00-\udfff]$/.test(box.draft) ? -2 : -1);
    else if (input && !key.meta && box.mode) box.draft += draftText(input);
    else return;
    this.changed();
  }
  // Bracketed paste arrives whole, newlines included.
  paste(text) {
    const job = this.typing;
    if (!job || !this.box(job).mode || this.box(job).confirm) return;
    this.box(job).draft += draftText(text);
    this.changed();
  }
  send(job, mode) {
    const box = this.box(job), cancel = mode === 'cancel';
    if (!cancel && (!mode || !box.draft.trim())) return;
    const request = { requestId: randomUUID(), executionId: job.execution.executionId, mode, ...(cancel ? {} : { text: box.draft }), at: this.now() };
    // A refusal shows until the next send.
    box.sent = box.sent.filter(sent => sent.outcome?.ok !== false);
    let outcome = null;
    try { writeRequest(job.dir, request); } catch (err) { outcome = { ok: false, status: 'not_written', reason: err.code ?? err.message }; }
    box.sent.push({ ...request, dir: job.dir, outcome });
    if (!cancel && !outcome) box.draft = '';
  }
  // Scrolling back down to the end follows new items again.
  scrollBox(rows) {
    const d = this.detail;
    this.scroll(rows);
    if (rows > 0 && d.top >= d.pane.total - d.height) d.follow = true;
  }

  // The screen: title, blank, body, blank, key hints; a focused message box
  // carries its own key hints as the body's last row. Each row is exactly `columns` wide.
  render() {
    if (this.frame) return this.frame;
    // Below this the layout cannot fit; Ink cuts what a tinier terminal cannot show.
    const W = Math.max(30, this.size.columns), H = Math.max(8, this.size.rows);
    const boxed = Boolean(this.typing);
    const bodyH = Math.max(1, H - (boxed ? 2 : 4));
    const title = [[' ', 'normal'], ['agent-companion', 'title'], [`  ${this.counts.running} running · ${this.counts.done} done in 24h`, 'dim']];
    if (this.filter && !this.editing) title.push([`  /${this.filter}`, 'dim']);
    let body;
    if (this.help) body = HELP.map(([keys, text]) => [[' ' + keys.padEnd(16), 'title'], [text, 'dim']]);
    else if (!this.wide) body = this.inJob && this.detail ? this.paneRows(W, bodyH) : this.listRows(W, bodyH);
    else {
      const list = this.listRows(LIST, bodyH), pane = this.paneRows(W - LIST - 1, bodyH);
      body = Array.from({ length: bodyH }, (_, i) => [...fitSegs(list[i] ?? [], LIST), ['│', 'faint'], ...(pane[i] ?? [])]);
    }
    const rows = [title, [], ...body.slice(0, bodyH), ...(boxed ? [] : [[], this.hints()])];
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
      rows.push(cardHead(job, job.caller.title, now, w, bg));
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
    const used = result?.usage?.total_tokens;
    const parts = [HOSTS[job.host] + (job.caller.lead ? ` › ${one(job.caller.lead)}` : ''),
      jobModel(execution, result).map(one).join(' '), used != null ? `${tokens(used)} tokens` : '', d.branch ? one(d.branch) : ''];
    const pad = ' '.repeat(margin);
    const header = [[pad + parts.filter(Boolean).join(' · '), 'dim']];
    const boxed = Boolean(this.typing);
    const footer = this.footer(job, w - margin, h, boxed);
    const height = Math.max(1, h - 2 - footer.length);
    this.layoutPane(w - margin, height);
    const focused = this.inJob && !boxed;
    const rows = [header, []];
    for (const { block, row } of d.pane.slice(d.top, height)) {
      const mark = focused && block === d.index && row.length ? ['▎', 'edit'] : [' ', 'normal'];
      rows.push([mark, [' ', 'normal'], ...row]);
    }
    // The box is pinned to the bottom, under the live line and pending messages.
    if (footer.length) while (rows.length < 2 + height) rows.push([]);
    for (const row of footer) rows.push([[pad, 'normal'], ...row]);
    return rows;
  }

  // A running job's footer, `w` cells wide within `h` pane rows: messages not
  // yet in the transcript, the box, then the mode with the box's keys when focused.
  footer(job, w, h, focused) {
    if (job.status !== 'running') return [];
    if (!job.execution.interventionModes) return [[['messages need the updated bridge; this job started on an older one', 'dim']]];
    const box = this.box(job), room = Math.max(1, h - 3);
    const pending = this.pending(job).map(entry => layoutLine(pendingLine(entry), w)[0]);
    let content;
    if (box.confirm) {
      content = layoutLine({ segs: [['Cancel this job?', 'bad'], [' The lead is told you cancelled it.', 'normal']],
        right: [['y', 'title'], [' yes  ', 'dim'], ['n', 'title'], [' no', 'dim']], wrap: false }, w - 4);
    } else if (!box.draft) {
      const name = NAMES[job.provider] ?? clean(job.provider);
      content = [[['› ', 'title'], [box.mode ? `Message ${name}…` : `${name} takes no messages while it works`, 'faint']]];
    } else content = layoutLine({ segs: [['› ', 'title'], [clean(box.draft), 'normal'], ...(focused ? [['▌', 'normal']] : [])], hang: 2 }, w - 4);
    const shown = pending.slice(-Math.max(0, Math.min(pending.length, room - 4)));
    // A tall draft shows its last rows, where the cursor is.
    content = content.slice(-Math.max(1, room - 3 - shown.length));
    return [...shown, ...boxRows(content, w), this.modeLine(job, w, focused)];
  }
  // Messages waiting between the live line and the box: recorded ones the
  // transcript does not show yet, and this view's requests the record does not hold yet.
  pending(job) {
    const out = pendingInputs(job.execution, this.detail.taken);
    for (const { at, mode, text, outcome } of this.box(job).sent) {
      const [glyph, state, style] = !outcome ? ['◌', 'waiting for the bridge', 'warn']
        : outcome.status === 'not_written' ? ['✗', `not sent: ${clean(outcome.reason)}`, 'bad']
        : !outcome.ok ? ['✗', `refused: ${REFUSED[outcome.reason] ?? clean(outcome.reason ?? outcome.status)}`, 'bad']
        : mode === 'cancel' ? ['■', 'stopping the job', 'warn'] : ['◌', 'accepted', 'warn'];
      out.push({ at, label: `${glyph} you · ${mode === 'cancel' ? 'cancel · ' : ''}${state}`, style, text, hint: '' });
    }
    return out.sort((a, b) => a.at - b.at);
  }
  // The mode, then the box's keys right-aligned when it has focus; what does not fit goes first.
  modeLine(job, w, focused) {
    const box = this.box(job), many = supported(job).length > 1;
    const short = box.mode ? [[box.mode, 'ok']] : [['cancel only', 'dim']];
    const full = box.mode ? [...short, [` · ${MODES[box.mode]}`, 'dim']] : short;
    const keys = [box.mode && '⏎ send', many && 'shift+⇥ mode', 'ctrl+x cancel job', 'esc jobs'].filter(Boolean);
    const all = keys.join(' · '), fewer = keys.filter(key => !key.startsWith('ctrl+x')).join(' · ');
    const tries = focused ? [[full, all], [short, all], [short, fewer]] : [[full, null]];
    for (const [segs, hint] of tries) {
      if (segsWidth(segs) + (hint ? width(hint) + 2 : 0) <= w) return layoutLine({ segs, right: hint ? [[hint, 'faint']] : null, wrap: false }, w)[0];
    }
    return fitSegs(short, w);
  }
}
