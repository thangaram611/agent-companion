import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { Pane, cardHead, clean, clock, fitSegs, jobBlocks, layoutLine, liveLines, outcomeLabel, pendingInputs, pendingLine, cut, width,
  type Block, type Seg, COMPANION_NAMES, MODE_HINTS, supportedModes } from '../bridge-server/ui/rows.mjs'
import { jobModel } from '../lib/model-name.mjs'

// Claude Code's mod for agent-companion (Codex ignores hooks modules). The
// session's running threads are listed above the prompt with their progress,
// read from the bridge's records. One Companions pane, opened by /companion,
// shows this session's threads as cards, rebuilt from the records by a Node
// child (`launch-ui.sh jobs`) at the session's start and each open; a card
// opens its thread's newest job in the pane, its transcript streamed by a
// Node child (`launch-ui.sh follow`) while it is shown. Native text reaches
// the screen only through rows.mjs's clean.

// One thread, by its id: its newest job and that job's records.
type Card = {
  title: string
  jobId?: string
  record?: any
  result?: any
  texts?: string
  // The thread's record was read for its title.
  looked?: boolean
  // A list rebuild found no result and no process: its record is not read again.
  gone?: boolean
  // On the list: its job started under the mod, or the last rebuild listed it.
  listed?: boolean
}
// The viewed job as its `follow` child prints it (bridge-server/ui/follow.mjs).
type Turn = { ids: string[]; earlier: number; labels: Record<string, string>; taken: string[]; located: boolean; format: { version?: unknown; detail?: string } | null }
type Follow = {
  jobId: string
  stop?: () => void
  // Ended by the mod (the view or the job changed, the pane closed), or by itself.
  stopped?: boolean
  ended?: boolean
  failure?: string
  job?: { status: string; record: any; result: any; branch: string | null }
  turn?: Turn
  items: Map<string, any>
  list: any[]
  labels: Map<string, string>
  taken: Set<string>
  pane: Pane
}

const SEND = /^mcp__(plugin_agent-companion_)?agent-bridge__companion_send$/
// Record ids as records.mjs accepts them; anything else names no record.
const isId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(id)
const TICK_MS = 1000
const PANE = 'companions'
// The list's cards, each pressed by its digit; the session's other jobs are counted.
const CARDS = 9
// The engine's "1: " before a plain Button's label.
const HOTKEY = 3
// The message box's text rows, between its rules: two at least, since the
// engine takes a new line only from two, then as many as the draft wraps to,
// up to a third of the pane, as Claude Code's prompt grows.
const BOX_ROWS = 2
// The field's hint while focused (2.1.326): the engine keeps the long one when
// it leaves the field half the pane.
const HINT = width(' ⏎ send · shift+⏎ new line'), SHORT_HINT = width(' ⏎ send')
function boxRowsFor(draft: string, w: number, bodyRows: number) {
  const field = Math.max(12, w - (w - HINT >= w / 2 ? HINT : SHORT_HINT))
  // Word-wrapped as rows.mjs wraps, the cursor's cell after the last line.
  const wrapped = draft.split('\n').reduce((n, line, i, all) => n + layoutLine({ segs: [[i === all.length - 1 ? `${line} ` : line || ' ']] }, field).length, 0)
  return Math.min(Math.max(BOX_ROWS, wrapped), Math.max(BOX_ROWS, Math.floor(bodyRows / 3)))
}
// Labels whose messages the job's view shows whole.
const WHOLE = new Set(['you', 'lead'])
// rows.mjs's styles as theme colour keys, so the pane follows the person's theme.
const STYLE: Record<string, { color?: string; weight?: 'bold' }> = {
  title: { weight: 'bold' }, dim: { color: 'inactive' }, faint: { color: 'subtle' },
  ok: { color: 'success' }, bad: { color: 'error' }, warn: { color: 'warning' }, edit: { color: 'suggestion' },
}

const threads = new Map<string, Card>()
let timer: { cancel: () => void } | undefined
let dir: string | undefined
let follow: Follow | undefined
// The thread whose job the pane shows.
let picked: string | undefined
// The last rebuild: how many of the session's jobs it left off the list, and why it failed.
let older = 0, rebuilds = 0, failure: string | undefined

// A running job's message box, per job: the draft, the mode it sends in (the
// companion's own default first), the cancel question, and the last send's
// state. The draft outlives the job's end and the pane's close, in memory only.
type MessageBox = { draft: string; mode: string | null; confirm: boolean; sending: boolean; refused?: string }
const boxes = new Map<string, MessageBox>()
function boxOf(jobId: string, record: any): MessageBox {
  let box = boxes.get(jobId)
  if (!box) {
    const modes = supportedModes(record), preferred = record?.interventionModes?.default
    boxes.set(jobId, box = { draft: '', mode: modes.includes(preferred) ? preferred : modes[0] ?? null, confirm: false, sending: false })
  }
  return box
}

// One message or cancel through the inbox: `launch-ui.sh send` writes the
// request as the live view does (inbox.mjs) and waits for the owning bridge's
// outcome. Accepted, the record's own pending line takes over; refused, the
// reason shows once and the draft stays.
async function sendRequest($: EngineInterface, jobId: string, box: MessageBox, mode: string, text?: string) {
  box.sending = true; box.refused = undefined
  $.ui.invalidate('ui.render')
  try {
    const ran = await $.process.run(['bash', `${$.plugin.root}/hooks/launch-ui.sh`, 'send', await stateDir($), jobId, mode, ...(text === undefined ? [] : [text])], { timeoutMs: 20_000 })
    const outcome = parse(ran.stdout)?.outcome
    if (ran.exitCode !== 0) box.refused = clean(ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`)
    else if (!outcome) box.refused = 'no answer from the bridge yet; it reads requests while its session is open'
    else if (!outcome.ok) box.refused = clean(outcome.reason === 'state' ? 'the job no longer takes messages' : outcome.reason === 'capability' ? `this companion does not take ${mode}` : outcome.reason ?? outcome.status ?? 'refused')
    else if (mode !== 'cancel') box.draft = ''
  } catch (error) { box.refused = clean(String(error)) }
  box.sending = false
  $.ui.invalidate('ui.render')
}

// lib/hosts/'s claude state dir: AGENT_COMPANION_HOME, else ~/.claude/agent-companion.
async function stateDir($: EngineInterface) {
  return dir ??= (await $.env.get('AGENT_COMPANION_HOME')) || `${await $.env.get('HOME')}/.claude/agent-companion`
}

async function readText($: EngineInterface, path: string) {
  try { return await $.fs.read(path) } catch { return '' }
}
function parse(text: string | undefined) {
  try { return text ? JSON.parse(text) : null } catch { return null }
}

// The clock reads a thread's job until its result; silence never stops the
// reading, a rebuild that found the job gone does.
const due = (a: Card) => Boolean(a.jobId && !a.result && !a.gone)
// A card's status: the result's outcome, else running until a rebuild found it gone.
const statusOf = (a: Card) => a.result?.outcome ?? (due(a) ? 'running' : 'unknown')

function startClock($: EngineInterface) {
  timer ??= $.clock.every(TICK_MS, () => void tick($))
}

// Reads only what is due; redraws the rows while a job runs (its elapsed time
// moves every second) or when a record changed; stops when nothing is due.
async function tick($: EngineInterface) {
  const now = await $.clock.now(), base = await stateDir($)
  let pending = false, redraw = false
  for (const [id, a] of threads) {
    if (!due(a)) continue
    pending = true
    if (!a.looked) {
      a.looked = true
      a.title ||= clean(parse(await readText($, `${base}/threads/${id}.json`))?.title ?? '')
    }
    const record = await readText($, `${base}/jobs/${a.jobId}.json`)
    const result = await readText($, `${base}/results/${a.jobId}.json`)
    if (record + result !== a.texts) {
      Object.assign(a, { texts: record + result, record: parse(record) ?? a.record, result: parse(result) })
      redraw = true
    }
    if (a.record && !a.result) redraw = true
  }
  if (redraw) $.ui.invalidate('ui.render')
  if (!pending) { timer?.cancel(); timer = undefined }
}

// The person's queued messages: held by the bridge until their turn, or in
// the companion's own queue (delivered there) until it starts them.
function queued(record: any) {
  return (record.interventions ?? []).filter((m: any) => m.from === 'user' && m.mode === 'queue'
    && (m.state === 'accepted' || (m.state === 'delivered' && record.interventionModes?.queue === 'native'))).length
}
// What a running job is doing, as the band and the card say it: the
// person's queued messages, or the live view's in-flight line less its bullet.
function doing(record: any, now: number): Seg[] {
  const waiting = queued(record)
  if (waiting) return [[`◌ your ${waiting === 1 ? 'message' : `${waiting} messages`} queued`, 'warn']]
  const [[head, style], ...rest] = liveLines({ record }, { now }).at(-1)!.segs as [Seg, ...Seg[]]
  return [[head.slice(2), style], ...rest]
}
// The model, less its provider prefix when that repeats the companion (opencode/flint-40b-free).
function modelText(record: any, result?: any) {
  const companion = clean(record.companion)
  return jobModel(record, result).map(clean).map(m => m.startsWith(`${companion}/`) ? m.slice(companion.length + 1) : m).join(' ')
}

// A running thread's row above the prompt: title, companion · model, the
// live line and elapsed time, cut to `columns`.
function bandRow(a: Card, now: number, columns: number, titleWidth: number): Seg[] {
  const { record } = a, title = cut(titleOf(a), titleWidth), model = modelText(record)
  return fitSegs([[title + ' '.repeat(titleWidth - width(title) + 2), 'title'], [clean(record.companion), 'dim'],
    ...(model ? [[` · ${model}`, 'dim'] as Seg] : []), [' · ', 'dim'], ...doing(record, now), [` · ${clock(now - record.startedAt)}`, 'dim']], columns)
}

// Claude Code 2.1.326 dropped /companion from the typeahead after the person
// viewed a subagent and came back (cause unknown). Each open registers it
// again: the engine lists a forgotten one again and ignores an unchanged
// repeat. The name stays a literal here, where claude plugin validate reads it.
function registerCommand($: EngineInterface) {
  return $.command.register({ name: 'companion', description: "Show this session's companion threads and their jobs" })
}

// Each open lists the session's jobs again; the person's own takes the keys.
function openPane($: EngineInterface, focus?: true) {
  void rebuild($)
  void registerCommand($).catch(() => {})
  return $.ui.open({ id: PANE, title: 'Companions', backgroundColor: 'transparent', ...(focus && { focus }) })
}

// After the pane switches between the list and a job, its ring would rest on
// nothing; this puts it on the new screen's first control. A pane not holding
// the keys refuses, and an element never drawn ends the wait: both harmless,
// noted in the debug log.
function ring($: EngineInterface, key: string) {
  void $.ui.focus({ requestId: PANE, key }).then(moved => moved.deny, String)
    .then(why => why && $.ui.log(`agent-companion: the Companions pane's ring stays off ${key} (${why})`, { to: 'debug' }))
    .catch(() => {})
}

// This session's threads from the records, the ones whose start the mod did
// not see included (a reload, an earlier run of the session). The newest
// rebuild wins; a job the mod saw start since stays on the list.
async function rebuild($: EngineInterface) {
  const n = ++rebuilds
  let out: any, why: string | undefined
  try {
    const ran = await $.process.run(['bash', `${$.plugin.root}/hooks/launch-ui.sh`, 'jobs', await stateDir($), await $.session.id(), String(CARDS)])
    out = ran.exitCode === 0 && parse(ran.stdout)
    if (!Array.isArray(out?.jobs) || !Array.isArray(out.older)) why = ran.stderr.trim().split('\n').at(-1) || `exit ${ran.exitCode}`
  } catch (error) { why = String(error) }
  if (n !== rebuilds) return
  failure = why && clean(why)
  if (!why) {
    const listed = new Set<string>(), old = new Set(out.older)
    for (const job of out.jobs) {
      const jobId = job.record?.jobId
      if (!isId(jobId) || !isId(job.thread)) continue
      listed.add(job.thread)
      const a = threads.get(job.thread) ?? { title: '' }
      threads.set(job.thread, a)
      a.title ||= clean(job.title)
      a.looked = true
      // A newer job the mod saw start stands.
      if (a.jobId && a.jobId !== jobId && !(a.record?.startedAt < job.record.startedAt)) continue
      // No result and no process: the job is gone, so its record is not read again.
      Object.assign(a, { jobId, record: job.record, result: job.result, texts: undefined,
        gone: job.status !== 'running' && !job.result })
    }
    for (const [id, a] of threads) a.listed = listed.has(id) || (a.listed && !old.has(a.jobId))
    older = old.size
    startClock($)
  }
  $.ui.invalidate('ui.render')
}

// One child per viewed job, started by the pane's render and never waited on.
function followJob($: EngineInterface, jobId: string) {
  if (follow?.jobId === jobId) return
  stopFollow()
  const f: Follow = { jobId, items: new Map(), list: [], labels: new Map(), taken: new Set(), pane: new Pane() }
  follow = f
  void run($, f)
}
function stopFollow() {
  if (!follow) return
  follow.stopped = true
  follow.stop?.()
  follow = undefined
}
// Streams the child's JSON lines into the follow and redraws on a change;
// the child exits by itself after the final read of an ended job.
async function run($: EngineInterface, f: Follow) {
  const child = $.process.spawn({ argv: ['bash', `${$.plugin.root}/hooks/launch-ui.sh`, 'follow', await stateDir($), f.jobId] })
  f.stop = () => void child.return({ code: null, signal: null }).catch(() => {})
  if (f.stopped) f.stop()
  let buffer = '', errors = '', exit: { code: number | null; signal: string | null } | null = null
  try {
    for await (const { stream, text } of child) {
      if (stream === 'stderr') { errors = (errors + text).slice(-2000); continue }
      const lines = (buffer + text).split('\n')
      buffer = lines.pop() ?? ''
      let changed = false
      for (const line of lines) changed = take(f, parse(line)) || changed
      if (changed && follow === f) $.ui.invalidate('ui.render')
    }
    exit = await child.result
  } catch (error) { errors ||= String(error) }
  f.ended = true
  if (f.stopped) return
  if (exit?.code !== 0) f.failure = clean(errors.trim().split('\n').at(-1) || `exit ${exit?.signal ?? exit?.code ?? 'unknown'}`)
  if (follow === f) $.ui.invalidate('ui.render')
}
// Keeps only what the pane can draw: the child's tail of the turn.
function take(f: Follow, message: any) {
  if (message?.job) { f.job = message.job; return true }
  if (!message?.turn) return false
  const turn: Turn = message.turn
  for (const item of message.items ?? []) f.items.set(item.id, item)
  const ids = new Set(turn.ids)
  for (const id of f.items.keys()) if (!ids.has(id)) f.items.delete(id)
  Object.assign(f, { turn, list: turn.ids.flatMap(id => f.items.get(id) ?? []), labels: new Map(Object.entries(turn.labels)), taken: new Set(turn.taken) })
  return true
}

// This session's jobs, running first, then the rest by when they ended.
function cards() {
  const at = (c: { status: string; a: Card }) => c.status === 'running' ? Infinity : c.a.result?.finishedAt ?? c.a.record.startedAt
  return [...threads].flatMap(([id, a]) => a.listed && a.jobId && a.record ? [{ id, a, status: statusOf(a) }] : [])
    .sort((x, y) => at(y) - at(x) || y.a.record.startedAt - x.a.record.startedAt)
}
const titleOf = (a: Card) => a.title || (clean(a.record?.text ?? '').split('\n')[0] ?? '')
// A card's second row, under its title: the status glyph, the companion,
// then what it is doing or how it ended, the glyph not repeated.
function cardLine({ a, status }: { a: Card; status: string }, glyph: Seg, now: number): Seg[] {
  const line: Seg[] = [[' '.repeat(HOTKEY)], glyph, [` ${clean(a.record.companion)} · `, 'dim']]
  if (status === 'running') return [...line, ...doing(a.record, now).map(([text, style]): Seg => [text, style === 'ok' ? 'dim' : style])]
  if (status === 'unknown') return [...line, ['no result', 'warn']]
  const [text, style] = outcomeLabel({ record: a.record, result: a.result })
  return [...line, [text.slice(2), status === 'completed' ? 'dim' : style]]
}

// The viewed job's rows, exactly what fits in `rows`: a running job follows
// its live line, an ended one opens on its outcome.
function jobRows(a: Card, f: Follow, now: number, w: number, rows: number): Seg[][] {
  const job = f.job ?? (a.record && { status: statusOf(a), record: a.record, result: a.result ?? null, branch: null })
  const about = job ? [clean(job.record.companion), modelText(job.record, job.result), clean(job.branch ?? '')].filter(Boolean).join(' · ') : ''
  const head = layoutLine({ segs: [[titleOf(a), 'title'], ...(about ? [[`  ${about}`, 'dim'] as Seg] : [])], wrap: false }, w)
  if (!job) return [...head, [], [['waiting for the job\'s record', 'dim']]]
  const running = job.status === 'running'
  const pending = running ? pendingInputs(job.record, f.taken).sort((x, y) => x.at - y.at).map(pendingLine) : []
  // The pane opens no item, so a message from you or the lead shows whole:
  // short, and folded it hid the lines the person wrote. The task stays folded.
  const blocks: Block[] = jobBlocks(job, { list: f.list, labels: f.labels, located: f.turn?.located ?? false, format: f.turn?.format ?? null, now, pending,
    expanded: id => WHOLE.has(f.labels.get(id) ?? '') })
  if (f.turn?.earlier) {
    const text = `${f.turn.earlier} earlier item${f.turn.earlier === 1 ? '' : 's'} · agent-companion ui shows them`
    const at = blocks.findIndex(block => block.key === f.list[0]?.id)
    blocks.splice(at < 0 ? blocks.length : at, 0, { key: 'earlier', source: text, flags: '', lines: () => [{ segs: [[text, 'faint']] }] })
  }
  if (f.failure) blocks.unshift({ key: 'failure', source: f.failure, flags: '', lines: () => [{ segs: [[`transcript follow stopped: ${f.failure}`, 'warn']] }, { segs: [] }] })
  const total = f.pane.layout(blocks, w), room = Math.max(1, rows - head.length - 2)
  return [...head, [], ...f.pane.slice(running ? Math.max(0, total - room) : 0, room).map(({ row }) => row)]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommand($)
    void rebuild($)
    return next(e)
  })
  // The person's own open: placed at any width, with the keys.
  on('command.run', { command: 'companion' }, async $ => {
    await openPane($, true)
    return {}
  })

  // The bridge answers companion_send with the thread and the job it started,
  // for the main conversation and its subagents alike; a terminal answer
  // carries them in its metadata block, the last line. A start opens nothing.
  on('tool.call', { tool: SEND }, async ($, e, next) => {
    const ran = await next(e)
    const sent = parse(ran.text) ?? parse(ran.text?.trimEnd().split('\n').at(-1))
    const thread = sent?.thread ?? sent?.meta?.thread, jobId = sent?.job_id ?? sent?.meta?.job_id
    if (isId(thread) && isId(jobId)) {
      const a = threads.get(thread) ?? { title: '' }
      threads.set(thread, a)
      if (a.jobId !== jobId) Object.assign(a, { jobId, record: undefined, result: undefined, texts: undefined, gone: false, listed: true })
      startClock($)
    }
    return ran
  })

  // The band above the prompt: one row per running thread, titles lined up
  // within a third of the row. It yields to a survey and draws nothing with
  // no thread running.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const running = cards().filter(c => c.status === 'running')
    if (e.props.hasSurvey || !running.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now(), w = Math.max(16, e.props.bodyColumns)
    const titleWidth = Math.min(Math.max(...running.map(c => width(titleOf(c.a)))), Math.floor(w / 3))
    return h(Box, { flexDirection: 'column' }, ...running.map(c => h(Text, { key: c.id, wrap: 'truncate-end' },
      ...bandRow(c.a, now, w, titleWidth).map(([text, style]) => h(Text, STYLE[style ?? ''] ?? null, text))))) as RenderElement
  })

  // Draws only from what the clock and the children already brought in.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    // A module loaded under an open pane (a reload) has not listed the session's jobs yet.
    if (!rebuilds) void rebuild($)
    const now = await $.clock.now(), w = Math.max(16, e.props.bodyColumns), focused = e.props.isFocused
    const spans = (segs: Seg[]) => segs.map(([text, style]) => h(Text, STYLE[style ?? ''] ?? null, text))
    const row = (segs: Seg[]) => h(Text, { wrap: 'truncate-end' }, ...(segs.length ? spans(segs) : [' ']))
    // h() answers any node; a column Box is the element a pane takes.
    const column = (...children: unknown[]) => h(Box, { flexDirection: 'column' }, ...children) as RenderElement
    const id = picked, a = id ? threads.get(id) : undefined
    if (id && a?.jobId) {
      followJob($, a.jobId)
      const back = () => {
        picked = undefined
        $.ui.invalidate('ui.render')
        const first = cards()[0]
        if (first) ring($, first.id)
      }
      // The job as jobRows draws it: the child's record, else the clock's.
      const status = follow?.job?.status ?? (a.record ? statusOf(a) : null), record = follow?.job?.record ?? a.record
      const box = status === 'running' && record?.interventionModes ? boxOf(a.jobId, record) : null
      const jobsButton = h(Button, { key: 'jobs', label: '← jobs', plain: true, dimColor: true, hotkey: 'b', ...(box ? {} : { autoFocus: true as const }), onPress: back })
      if (!box) return column(...jobRows(a, follow!, now, w, e.props.scroll.bodyRows).map(row),
        h(Box, { flexDirection: 'row', justifyContent: 'space-between' }, row([[focused ? 'esc returns' : 'ctrl+x tab for keys', 'faint']]), jobsButton))
      const jobId = a.jobId, modes = supportedModes(record), name = COMPANION_NAMES[record.companion] ?? clean(record.companion)
      const redraw = () => $.ui.invalidate('ui.render')
      // The box as Claude Code draws its own prompt: a faint rule above and
      // below, the field the pane's full width between them. The engine sizes
      // the field from the pane's width less its hint (2.1.326), so a frame,
      // padding or a › beside it would overflow it; its own label adds a colon.
      // Two rows, since it takes a new line only from two. The mode is on the
      // row below; Copilot takes cancel alone.
      const rule = () => row([['─'.repeat(w), 'faint']]), bodyRows = e.props.scroll.bodyRows, rows = boxRowsFor(box.draft, w, bodyRows)
      const field = box.mode
        ? [rule(), h(Input, { key: 'message', placeholder: `Message ${name}…`, value: box.draft, rows, submitLabel: 'send', autoFocus: true,
              // Drawn again only when the draft needs another number of rows.
              onInput: (value: string) => { box.draft = value; if (boxRowsFor(value, w, bodyRows) !== rows) redraw() },
              // Kept as sent, so a refusal leaves it in the box.
              onSubmit: (value: string) => { if (!value.trim() || box.sending) return; box.draft = value; void sendRequest($, jobId, box, box.mode!, value) } }), rule()]
        : [row([[`${name} takes no messages while it works · cancel only`, 'dim']])]
      const state = box.sending ? [row([['◌ sending…', 'faint']])] : box.refused ? [row([[`✗ not sent: ${box.refused}`, 'bad']])] : []
      const cycle = () => { box.mode = modes[(modes.indexOf(box.mode!) + 1) % modes.length]!; redraw() }
      const controls = box.confirm
        ? h(Box, { flexDirection: 'row', gap: 2 }, row([['Cancel this job? ', 'bad'], ['The lead is told you cancelled it.', 'dim']]),
            h(Button, { key: 'cancel-yes', label: 'yes, cancel', plain: true, onPress: () => { box.confirm = false; void sendRequest($, jobId, box, 'cancel') } }),
            h(Button, { key: 'cancel-no', label: 'no', plain: true, autoFocus: true, onPress: () => { box.confirm = false; redraw(); ring($, box.mode ? 'message' : 'jobs') } }))
        : h(Box, { flexDirection: 'row', gap: 2 },
            ...(modes.length > 1 ? [h(Button, { key: 'mode', label: `mode: ${box.mode} ▸`, plain: true, onPress: cycle })] : []),
            ...(box.mode ? [row([[MODE_HINTS[box.mode] ?? '', 'dim']])] : []),
            h(Button, { key: 'cancel', label: 'cancel job', plain: true, dimColor: true, onPress: () => { box.confirm = true; redraw(); ring($, 'cancel-no') } }),
            jobsButton)
      // The transcript gets what the box, its state and controls leave; the
      // box stays pinned to the bottom, as in the live view and the
      // companion's own app, however short the transcript is.
      const spare = 2 + (box.mode ? rows + 2 : 1) + state.length, room = Math.max(4, bodyRows - spare)
      const shown = jobRows(a, follow!, now, w, room)
      return column(...shown.map(row), ...Array.from({ length: room - shown.length }, () => row([])), ...field, ...state, controls,
        row([[focused ? 'esc returns to the chat' : 'ctrl+x tab for keys', 'faint']]))
    }
    stopFollow()
    // A card opens its thread's newest job here; a running job that takes
    // messages opens with the keys in its box.
    const open = (thread: string) => {
      picked = thread
      $.ui.invalidate('ui.render')
      const opened = threads.get(thread)
      ring($, opened?.record && statusOf(opened) === 'running' && supportedModes(opened.record).length ? 'message' : 'jobs')
    }
    const list = cards(), shown = list.slice(0, CARDS), more = older + list.length - shown.length
    const running = list.filter(c => c.status === 'running').length
    const title = row([[' '], ['Companions', 'title'], [`  ${running} running · ${list.length - running + older} done`, 'dim']])
    const failed = failure ? [row([[` earlier jobs not read: ${failure}`, 'warn']])] : []
    if (!list.length) return column(title, ...failed, row([]), row([[' No companion jobs in this session yet', 'dim']]))
    const keys = shown.length === 1 ? '1' : `1–${shown.length}`
    // A card is a plain Button whose label is one unstyled string, since the
    // engine inverts each styled part of a label on its own: the title, and
    // the time at the pane's edge less the engine's "1: ". That is cardHead's
    // line less its ' ● ' and trailing ' '; the glyph leads the row below,
    // outside the Button.
    return column(title, ...failed, row([]),
      ...shown.flatMap((c, i) => {
        const head = cardHead({ status: c.status, startedAt: c.a.record.startedAt, finishedAt: c.a.result?.finishedAt }, titleOf(c.a), now, w - HOTKEY + 4)
        return [h(Button, { key: c.id, label: head.slice(3, 6).map(([text]) => text).join(''), plain: true, hotkey: String(i + 1),
          ...(i === 0 ? { autoFocus: true as const } : {}), onPress: () => open(c.id) }), row(fitSegs(cardLine(c, head[1]!, now), w)), row([])]
      }),
      ...(more ? [row([[` ${more} older · agent-companion ui shows them`, 'faint']]), row([])] : []),
      row([[focused ? ` ${keys} or ⏎ open a job · esc returns` : ` ctrl+x tab for keys · ${keys} or ⏎ open a job`, 'faint']]))
  })

  // The next open starts on the list.
  on('ui.close', { id: PANE }, ($, e, next) => {
    stopFollow()
    picked = undefined
    return next(e)
  })
}
