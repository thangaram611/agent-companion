// Text rows for the live view. Everything here is pure: native text becomes
// sanitized, styled segments ([text, style]) wrapped to a width, and a pane
// keeps each block's wrapped rows so a frame touches only changed blocks and
// renders only the visible slice.

// Native text can carry terminal escapes; none reaches the terminal.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
const UNSAFE = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
export function clean(text) {
  const value = String(text ?? '');
  if (!UNSAFE.test(value)) return value;
  return value.replace(ESCAPES, '').replace(/\r\n/g, '\n').split('\n')
    .map(line => line.slice(line.lastIndexOf('\r') + 1).replaceAll('\t', '    ').replace(CONTROLS, '')).join('\n');
}

// Terminal cell width. ASCII is the fast path; East Asian wide and emoji count 2.
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;
const ZERO = /[\p{Mark}\u200b-\u200d\ufe0e\ufe0f]/u;
const ASCII = /^[\x20-\x7e]*$/;
const charWidth = ch => ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1;
export function width(text) {
  if (ASCII.test(text)) return text.length;
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}
// Cut to at most `w` cells, marking a cut with an ellipsis.
export function cut(text, w) {
  if (width(text) <= w) return text;
  if (w <= 0) return '';
  let out = '', used = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (used + cw > w - 1) break;
    out += ch; used += cw;
  }
  return out + '…';
}
export const segsWidth = segs => segs.reduce((sum, [text]) => sum + width(text), 0);
// Exactly `w` cells on one line: cut, then pad in the last segment's background.
export function fitSegs(segs, w, padStyle = 'normal') {
  const out = [];
  let used = 0;
  for (let [text, style, bg] of segs) {
    if (used >= w) break;
    if (text.includes('\n')) text = text.replaceAll('\n', ' ');
    const piece = width(text) <= w - used ? text : cut(text, w - used);
    out.push([piece, style, bg]); used += width(piece);
  }
  if (used < w) out.push([' '.repeat(w - used), padStyle, out.at(-1)?.[2]]);
  return out;
}

// A logical line wraps at spaces to `w` cells. Continuation rows indent by
// `hang`; `right` is right-aligned on the first row; `wrap: false` cuts instead.
export function layoutLine({ segs, right = null, indent = 0, hang = indent, wrap = true }, w) {
  const rows = [];
  let row, col, rowStart, limit = Math.max(1, w - (right ? segsWidth(right) + 2 : 0));
  // Most lines fit one row: skip tokenizing (it dominates a full rewrap).
  const pad = Math.min(indent, w - 1);
  const multiline = segs.some(([text]) => text.includes('\n'));
  if (!multiline && pad + segsWidth(segs) <= limit) {
    row = pad ? [[' '.repeat(pad), 'normal']] : [];
    for (const [text, style] of segs) if (text) { const last = row.at(-1); if (last && last[1] === style) last[0] += text; else row.push([text, style]); }
    if (right) row.push([' '.repeat(Math.max(1, w - pad - segsWidth(segs) - segsWidth(right))), 'normal'], ...right);
    return [row];
  }
  const push = (text, style, tw = width(text)) => {
    if (!text) return;
    const last = row.at(-1);
    if (last && last[1] === style) last[0] += text; else row.push([text, style]);
    col += tw;
  };
  const start = spaces => { row = []; col = 0; push(' '.repeat(Math.min(spaces, w - 1)), 'normal'); rowStart = col; };
  const newRow = () => { rows.push(row); limit = Math.max(1, w); start(hang); };
  start(indent);
  if (!wrap) {
    for (const [raw, style] of segs) {
      const text = raw.replaceAll('\n', ' ');
      const piece = width(text) <= limit - col ? text : cut(text, limit - col);
      push(piece, style);
      if (piece !== text) break;
    }
  } else for (const [text, style] of segs) {
    const ascii = ASCII.test(text);
    // A newline inside a segment (a heredoc command) starts a new row.
    for (const token of text.split(/( +|\n)/)) {
      if (!token) continue;
      if (token === '\n') { newRow(); continue; }
      const tw = ascii ? token.length : width(token);
      if (col + tw <= limit) { push(token, style, tw); continue; }
      if (token[0] === ' ') { newRow(); continue; }
      if (col > rowStart && tw <= w - Math.min(hang, w - 1)) { newRow(); push(token, style, tw); continue; }
      // Longer than a row: split by cells.
      let piece = '', used = 0;
      for (const ch of token) {
        const cw = charWidth(ch);
        if (col + used + cw > limit && col + used > rowStart) { push(piece, style); newRow(); piece = ''; used = 0; }
        piece += ch; used += cw;
      }
      push(piece, style);
    }
  }
  rows.push(row);
  if (right) {
    const first = rows[0];
    first.push([' '.repeat(Math.max(1, w - segsWidth(first) - segsWidth(right))), 'normal'], ...right);
  }
  return rows;
}

const FOLD_HEAD = 2, FOLD_TAIL = 2, ANSWER_LINES = 6;
const lines = text => clean(text).replace(/^\n+|\n+$/g, '').split('\n');
// Card and header fields are one line each.
export const one = text => clean(text).replace(/\s*\n\s*/g, ' ');
// Items are replaced, never mutated, on upsert: their cleaned lines are kept per object.
const memo = new WeakMap();
function linesOf(item, field, value = item[field]) {
  let fields = memo.get(item);
  if (!fields) memo.set(item, fields = {});
  return fields[field] ??= lines(value);
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function commandText(command) {
  if (!Array.isArray(command)) return clean(command);
  const shell = command.findIndex(part => part === '-lc' || part === '-c');
  return clean(shell >= 0 && shell === command.length - 2 ? command.at(-1) : command.join(' '));
}
// A path inside the job's worktree is shown relative to it.
export const relPath = (path, cwd) => cwd && String(path).startsWith(cwd + '/') ? String(path).slice(cwd.length + 1) : clean(path);

// One row (first line, cut, with a count of the rest) or the whole text.
function textLines(label, labelStyle, all, style, expanded) {
  const head = label ? [[label.padEnd(7), labelStyle]] : [];
  const pad = head.length ? 7 : 0;
  if (expanded) return all.map((line, i) => ({ segs: [...(i ? [[' '.repeat(pad), 'normal']] : head), [line, style]], hang: pad }));
  return [{ segs: [...head, [all[0], style]], right: all.length > 1 ? [[`+${all.length - 1}`, 'faint']] : null, wrap: false }];
}
// Command and tool output: first and last lines with a count, each cut to one row.
function outputLines(all, truncated, expanded) {
  if (!all.length || (all.length === 1 && !all[0])) return [];
  const shown = expanded || all.length <= FOLD_HEAD + FOLD_TAIL + 1 ? all : null;
  const out = (shown ?? all.slice(0, FOLD_HEAD)).map(line => ({ segs: [[line, 'dim']], indent: 2, wrap: Boolean(shown && expanded) }));
  if (!shown) {
    out.push({ segs: [[`+${all.length - FOLD_HEAD - FOLD_TAIL} lines`, 'faint']], indent: 2 });
    for (const line of all.slice(-FOLD_TAIL)) out.push({ segs: [[line, 'dim']], indent: 2, wrap: false });
  }
  if (truncated && expanded) out.push({ segs: [['output capped by the transcript reader; the native transcript has the rest', 'faint']], indent: 2 });
  return out;
}
function commandStatus(item, ended) {
  if (item.denied) return [['refused', 'warn']];
  if (item.exitCode === 0) return [['ok', 'ok']];
  if (item.exitCode != null) return [[`exit ${item.exitCode}`, 'bad']];
  if (['running', 'streaming'].includes(item.status)) return ended ? [['unfinished', 'warn']] : [['running', 'ok']];
  if (item.status === 'failed') return [['failed', 'bad']];
  return null;
}
const CHANGE = { add: 'added', update: 'updated', delete: 'deleted' };

// Logical lines for one transcript item. Kinds the view does not list
// (usage, turn_end) are filtered by the caller.
// A user item's label says who wrote it: task, lead, you, or user when unknown.
export function itemLines(item, { expanded = false, ended = false, cwd = null, answer = null, label = 'user' } = {}) {
  switch (item.kind) {
    case 'user': return textLines(label, 'dim', linesOf(item, 'text', item.text ?? (item.image ? '[image]' : '')), 'dim', expanded);
    case 'reasoning': return textLines('think', 'dim', linesOf(item, 'text'), 'dim', expanded);
    case 'preamble': return textLines('pre', 'faint', linesOf(item, 'text'), 'dim', expanded);
    case 'assistant':
      // The final answer already opens a finished job.
      if (answer != null && clean(item.text).trim() === answer) return [{ segs: [['answer, shown above', 'faint']] }];
      return linesOf(item, 'text').map(line => ({ segs: [[line, 'normal']] }));
    case 'command': {
      const head = { segs: [['$ ', 'title'], [commandText(item.command), 'title']], hang: 2, right: commandStatus(item, ended) };
      const extra = item.denied ? [{ segs: [[`refused: ${clean(item.denied)}`, 'warn']], indent: 2 }] : [];
      return [head, ...extra, ...outputLines(item.output ? linesOf(item, 'output') : [], item.truncated, expanded)];
    }
    case 'edit': return (item.paths ?? []).map(entry => ({ segs: [['✎ ', 'edit'], [relPath(entry.path, cwd), 'normal'], ['  ' + (CHANGE[entry.change] ?? clean(entry.change)), 'dim']], hang: 2 }));
    case 'tool': {
      const input = item.input === undefined ? '' : clean(typeof item.input === 'string' ? item.input : JSON.stringify(item.input)).replaceAll('\n', ' ');
      const head = { segs: [['▸ ', 'title'], [clean(item.name ?? 'tool'), 'title'], ...(input ? [['  ' + input, 'dim']] : [])], hang: 2, wrap: expanded, right: commandStatus(item, ended) };
      const output = item.output ?? item.text;
      return [head, ...outputLines(output ? linesOf(item, 'output', output) : [], item.truncated, expanded)];
    }
    case 'error':
      if (answer && item.error?.message && answer.includes(clean(item.error.message))) return [{ segs: [['✗ ', 'bad'], [`${clean(item.error.type ?? 'error')}, shown above`, 'faint']], hang: 2 }];
      return [{ segs: [['✗ ', 'bad'], [clean(`${item.error?.type ?? 'error'}: ${item.error?.message ?? ''}`), 'bad']], hang: 2 }];
    default: return [{ segs: [['? ', 'warn'], [`unrecognized ${clean(item.nativeType ?? item.kind)}`, 'warn']], hang: 2 }];
  }
}

export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
export function age(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

const GLYPHS = { running: ['●', 'ok'], completed: ['✓', 'ok'], failed: ['✗', 'bad'], delivery_unknown: ['✗', 'bad'],
  stopped: ['■', 'warn'], interrupted: ['■', 'warn'], unknown: ['?', 'warn'] };
// A job card's first row, exactly `w` cells: ' ● ' title, at least two
// spaces, the time (elapsed while it runs, else how long ago it ended), one space.
export function cardHead({ status, startedAt, finishedAt }, title, now, w, bg) {
  const [glyph, style] = GLYPHS[status] ?? GLYPHS.unknown;
  const when = status === 'running' ? clock(now - startedAt) : age(now - (finishedAt ?? startedAt));
  const whenStyle = status === 'running' ? 'ok' : status === 'completed' ? 'dim' : style;
  const name = cut(one(title), w - 6 - width(when));
  return [[' ', 'normal', bg], [glyph, style, bg], [' ', 'normal', bg], [name, 'title', bg],
    [' '.repeat(Math.max(0, w - 4 - width(name) - width(when))), 'normal', bg], [when, whenStyle, bg], [' ', 'normal', bg]];
}

const OUTCOME = { completed: ['✓ done in', 'ok'], failed: ['✗ failed after', 'bad'], delivery_unknown: ['✗ delivery unknown after', 'bad'],
  stopped: ['■ stopped after', 'warn'], interrupted: ['■ interrupted after', 'warn'] };
// A finished job's outcome and duration, as one segment: ['✓ done in 0:38', 'ok'].
export function outcomeLabel({ result, execution }) {
  const [label, style] = OUTCOME[result.outcome] ?? [`? ${result.outcome}`, 'warn'];
  return [`${label} ${clock(result.finishedAt - execution.startedAt)}`, style];
}
// A finished job opens on its outcome: result line, git change list, errors, answer.
export function outcomeLines(job, { expanded = false, items = 0 } = {}) {
  const { result, execution } = job;
  const summary = result.workSummary;
  const first = [outcomeLabel(job)];
  if (summary) {
    const commands = summary.commands ?? [];
    const failed = commands.filter(c => !c.denied && (c.exitCode != null && c.exitCode !== 0 || c.status === 'failed')).length;
    const refused = commands.filter(c => c.denied).length;
    const total = commands.length + (summary.commandsOmitted ?? 0);
    if (total) first.push(['  ' + plural(total, 'command'), 'normal']);
    if (failed) first.push([', ', 'normal'], [`${failed} failed`, 'bad']);
    if (refused) first.push([', ', 'normal'], [`${refused} refused`, 'warn']);
    const tree = summary.worktree;
    if (tree?.available) first.push([` · ${plural(tree.files.length + (tree.filesOmitted ?? 0), 'file')} changed`, 'normal']);
    else if (summary.edits?.length) first.push([` · ${plural(summary.edits.length + (summary.editsOmitted ?? 0), 'edit')}`, 'normal']);
  }
  if (result.outcome !== 'completed' && (result.detail || result.cause)) first.push([` · ${clean(result.detail ?? result.cause)}`, 'dim']);
  const out = [{ segs: first, hang: 2 }];
  const tree = summary?.worktree;
  if (tree?.available && tree.files.length) {
    const files = tree.files.map(f => `${relPath(f.path, execution.cwd)} ${f.binary ? 'binary' : `+${f.added}${f.deleted ? ` −${f.deleted}` : ''}`}`);
    if (tree.filesOmitted) files.push(`${tree.filesOmitted} more`);
    out.push({ segs: [['git, any writer: ' + files.join(' · '), 'dim']] });
  } else if (tree && !tree.available) out.push({ segs: [[`git: unavailable (${clean(tree.reason)})`, 'dim']] });
  const answerText = clean(result.text ?? '');
  for (const error of (summary?.errors ?? []).filter(e => !answerText.includes(clean(e.message)))) out.push({ segs: [['✗ ', 'bad'], [clean(`${error.type}: ${error.message}`), 'bad']], hang: 2 });
  if (summary?.transcript?.available === false) out.push({ segs: [[`transcript unavailable: ${clean(summary.transcript.reason)}`, 'warn']] });
  out.push({ segs: [] });
  const answer = lines(result.text || '(no answer)');
  const shown = expanded ? answer : answer.slice(0, ANSWER_LINES);
  shown.forEach((line, i) => out.push({ segs: [[line, result.text ? 'normal' : 'dim']],
    right: !expanded && i === shown.length - 1 && answer.length > shown.length ? [[`+${answer.length - shown.length}`, 'faint']] : null }));
  out.push({ segs: [] }, { segs: [[`transcript ↓ (${plural(items, 'item')})`, 'faint']] }, { segs: [] });
  return out;
}

// The in-flight line, once, as the transcript's last line; a reply still being
// written (OpenCode stores text only when a step completes) comes just before it.
export function liveLines(job, { now, lastText = null, activeAt = null }) {
  const progress = job.execution.progress ?? {};
  const out = [];
  const partial = clean(progress.partialText ?? '').replace(/\n+$/, '');
  if (partial && partial.trim() !== (lastText ?? '').trim()) out.push(...lines(partial).map(line => ({ segs: [[line, 'normal']] })));
  const doing = progress.activeCommand ? `running $ ${commandText(progress.activeCommand)}`
    : progress.activity ? clean(progress.activity) : partial ? 'responding' : job.execution.state === 'running' ? 'working' : clean(job.execution.state);
  const segs = [[`● ${doing}`, 'ok']];
  if (progress.retry) segs.push([` · retrying${progress.retry.attempt ? ` (attempt ${progress.retry.attempt})` : ''}`, 'warn']);
  if (activeAt != null) segs.push([` · ${clock(now - activeAt)}`, 'ok']);
  out.push({ segs, hang: 2 });
  return out;
}

// A recorded message the companion has not shown yet: [state, hint].
function pendingState({ state, mode }) {
  if (state === 'joined') return ['joined', 'in the running turn'];
  if (state === 'not_delivered') return ['not delivered', ''];
  // Held by the bridge (accepted) or by the companion's own queue (delivered).
  if (mode === 'queue') return ['queued', 'runs after this turn'];
  if (state === 'accepted') return mode === 'steer' ? ['sending', ''] : ['interrupting', 'runs once this turn stops'];
  return [clean(state), ''];
}
// Recorded messages the transcript does not show yet (`taken` holds the ids it shows).
export function pendingInputs(execution, taken) {
  return (execution.interventions ?? []).filter(input => !taken.has(input.id) && input.state !== 'answered').map(input => {
    const [state, hint] = pendingState(input);
    return { at: input.at, label: `${input.state === 'not_delivered' ? '✗' : '◌'} ${input.from === 'user' ? 'you' : 'lead'} · ${state}`, style: 'warn', text: input.text, hint };
  });
}
// One pending message as one row: who and its state, the text, a hint.
export const pendingLine = ({ label, style, text, hint }) => ({ segs: [[label, style],
  ...(text ? [['  ' + one(text), 'normal']] : []), ...(hint ? [['  ' + hint, 'faint']] : [])], wrap: false });

// One-row items sit together; anything taller gets a blank line around it.
const COMPACT = new Set(['user', 'reasoning', 'edit', 'preamble']);
// A job's transcript as Pane blocks: the outcome once it ended, a notice while
// its transcript is missing or unrecognized, the folded preamble, each item
// with the label of who wrote it, and while it runs the live line, after any
// `pending` lines. `expanded(id)` says which blocks are open.
export function jobBlocks(job, { list, preamble = [], labels = new Map(), located, format, now, expanded = () => false, showPreamble = false, pending = [] }) {
  const ended = job.status !== 'running';
  const cwd = job.execution.cwd, answer = job.result?.text ? clean(job.result.text).trim() : null;
  const blocks = [];
  if (job.result) {
    const open = expanded('outcome');
    blocks.push({ key: 'outcome', focus: 'outcome', source: job.result, flags: `${open}|${list.length}`,
      lines: () => outcomeLines(job, { expanded: open, items: list.length }) });
  }
  // Unrecognized records show inline; this is for a missing or unreadable store.
  if (!located || format?.version == null) {
    const text = !located ? (ended ? 'transcript not found' : 'waiting for the transcript') : `transcript not recognized: ${clean(format?.detail ?? 'not read yet')}`;
    blocks.push({ key: 'notice', source: text, flags: '', lines: () => [{ segs: [[text, located ? 'warn' : 'dim']] }, { segs: [] }] });
  }
  if (preamble.length && !showPreamble) {
    const text = `preamble · ${preamble.length} item${preamble.length === 1 ? '' : 's'} · p shows`;
    blocks.push({ key: 'preamble', focus: 'preamble', source: text, flags: '', lines: () => [{ segs: [[text, 'faint']] }, { segs: [] }] });
  }
  let previous = null;
  for (const item of [...(showPreamble ? preamble : []), ...list]) {
    const open = expanded(item.id), label = labels.get(item.id);
    const compact = COMPACT.has(item.kind) && !open;
    const gap = previous !== null && !(previous && compact);
    blocks.push({ key: item.id, focus: item.id, source: item, flags: `${open}|${gap}|${ended}|${answer !== null}|${label}`,
      lines: () => [...(gap ? [{ segs: [] }] : []), ...itemLines(item, { expanded: open, ended, cwd, answer, label })] });
    previous = compact;
  }
  if (!ended) {
    const progress = job.execution.progress ?? {};
    const lastText = list.findLast(item => item.kind === 'assistant')?.text ?? null;
    const active = progress.activeCommand && list.findLast(item => item.kind === 'command' && item.status === 'running'
      && commandText(item.command) === commandText(progress.activeCommand));
    const activeAt = active?.at ? Date.parse(active.at) : null;
    const waiting = pending.map(line => line.segs.map(([text]) => text).join('')).join('\n');
    blocks.push({ key: 'live', source: job.execution, flags: `${activeAt == null ? '' : Math.floor((now - activeAt) / 1000)}|${lastText}|${waiting}`,
      lines: () => [{ segs: [] }, ...pending, ...liveLines(job, { now, lastText, activeAt })] });
  }
  return blocks;
}

// A faint border `w` cells wide around rows already laid out to `w - 4`.
export function boxRows(content, w) {
  const line = '─'.repeat(Math.max(0, w - 2));
  return [[[`╭${line}╮`, 'faint']], ...content.map(row => [['│ ', 'faint'], ...fitSegs(row, Math.max(0, w - 4)), [' │', 'faint']]), [[`╰${line}╯`, 'faint']]];
}

// Wrapped rows per block, cached on the block's identity, flags and width; a
// prefix sum over row counts finds the visible slice by binary search.
export class Pane {
  cache = new Map();
  blocks = [];
  starts = [0];
  // blocks: [{ key, source, flags, lines: () => logicalLines }]
  layout(blocks, w) {
    const next = new Map();
    this.starts = new Array(blocks.length + 1);
    this.starts[0] = 0;
    blocks.forEach((block, i) => {
      let hit = this.cache.get(block.key);
      if (!hit || hit.source !== block.source || hit.flags !== block.flags || hit.width !== w) {
        hit = { source: block.source, flags: block.flags, width: w, rows: block.lines().flatMap(line => layoutLine(line, w)) };
      }
      next.set(block.key, hit);
      block.rows = hit.rows;
      this.starts[i + 1] = this.starts[i] + hit.rows.length;
    });
    this.cache = next;
    this.blocks = blocks;
    return this.total;
  }
  get total() { return this.starts.at(-1); }
  blockAt(row) {
    let lo = 0, hi = this.blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= row) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  slice(top, height) {
    const out = [];
    if (!this.blocks.length) return out;
    for (let i = this.blockAt(top), row = top; i < this.blocks.length && out.length < height; i++) {
      const block = this.blocks[i];
      for (let r = row - this.starts[i]; r < block.rows.length && out.length < height; r++, row++) out.push({ block: i, row: block.rows[r], first: r === 0 });
    }
    return out;
  }
}

// Both views' input boxes: each companion's own name, what each message mode
// does, and the modes a job's companion takes (recorded on its execution).
export const COMPANION_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity', copilot: 'Copilot' };
export const MODE_HINTS = { steer: 'joins the running turn now', queue: 'runs after the current turn', interrupt: 'stops this turn, then sends' };
export const supportedModes = execution => ['steer', 'queue', 'interrupt'].filter(mode => execution?.interventionModes?.[mode]);
