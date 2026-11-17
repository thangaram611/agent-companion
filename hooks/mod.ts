import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { Pane, cardHead, clean, clock, fitSegs, jobBlocks, layoutLine, liveLines, outcomeLabel, pendingInputs, pendingLine, segsWidth, cut, width,
  type Block, type Seg } from '../bridge-server/ui/rows.mjs'
import { jobModel } from '../lib/model-name.mjs'

// Claude Code's mod for agent-companion (Codex ignores hooks modules). Each
// agent-companion subagent's row in the agent list carries its job's
// progress, read from the bridge's records; other subagents' rows are left to
// the engine. One Companions pane follows the view: this session's jobs as
// cards, rebuilt from the records by a Node child (`launch-ui.sh jobs`) at
// the session's start and each open, or the job of the companion subagent in
// view, or of a card Claude Code could not view, its transcript streamed by a
// Node child (`launch-ui.sh follow`) while it is shown. Native text reaches
// the screen only through rows.mjs's clean.

type Agent = {
  title: string
  endedAt?: number
  jobId?: string
  execution?: any
  result?: any
  texts?: string
  looked?: boolean
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
  job?: { status: string; execution: any; result: any; branch: string | null }
  turn?: Turn
  items: Map<string, any>
  list: any[]
  labels: Map<string, string>
  taken: Set<string>
  pane: Pane
}

const SEND = /^mcp__(plugin_agent-companion_)?agent-bridge__agent_send$/
// Record ids as records.mjs accepts them; anything else names no record.
const isId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(id)
const ENDED = new Set(['completed', 'failed', 'killed'])
const TICK_MS = 1000
// Once a subagent has ended, its job closes within the owner grace
// (AGENT_COMPANION_OWNER_GRACE_MS, 120 s); a record still open after that has
// lost its bridge, and its row goes back to the engine's.
const GRACE_MS = 120_000
// The terminal's own palette, so its theme carries the colour; 39 ends the
// colour alone, leaving the engine's dim or bold for the row.
const SGR: Record<string, string> = { ok: '32', warn: '33', bad: '31' }
const PANE = 'companions'
// The list's cards, each pressed by its digit; the session's other jobs are counted.
const CARDS = 9
// rows.mjs's styles as theme colour keys, so the pane follows the person's theme.
const STYLE: Record<string, { color?: string; weight?: 'bold' }> = {
  title: { weight: 'bold' }, dim: { color: 'inactive' }, faint: { color: 'subtle' },
  ok: { color: 'success' }, bad: { color: 'error' }, warn: { color: 'warning' }, edit: { color: 'suggestion' },
}

const agents = new Map<string, Agent>()
let timer: { cancel: () => void } | undefined
let dir: string | undefined
let follow: Follow | undefined
// The agent whose job the pane shows itself, Claude Code having refused its view.
let picked: string | undefined
// The last rebuild: how many of the session's jobs it left off the list, and why it failed.
let older = 0, rebuilds = 0, failure: string | undefined

// lib/host.mjs's claude state dir: AGENT_COMPANION_HOME, else ~/.claude/agent-companion.
async function stateDir($: EngineInterface) {
  return dir ??= (await $.env.get('AGENT_COMPANION_HOME')) || `${await $.env.get('HOME')}/.claude/agent-companion`
}

async function readText($: EngineInterface, path: string) {
  try { return await $.fs.read(path) } catch { return '' }
}
function parse(text: string | undefined) {
  try { return text ? JSON.parse(text) : null } catch { return null }
}

// What the clock still reads for an agent: the conversation naming its job
// (while it runs, or once after it ended), then the job's records until the
// result, or until the grace after the subagent ended.
function due(a: Agent, now: number) {
  if (a.result) return null
  if (!a.jobId) return a.endedAt == null || !a.looked ? 'conversation' : null
  return a.endedAt == null || now - a.endedAt < GRACE_MS ? 'job' : null
}
// A card's status: the result's outcome, else running until its grace ran out.
const statusOf = (a: Agent, now: number) => a.result?.outcome ?? (due(a, now) ? 'running' : 'unknown')

function startClock($: EngineInterface) {
  timer ??= $.clock.every(TICK_MS, () => void tick($))
}

// Reads only what is due; redraws the rows while a job runs (its elapsed time
// moves every second) or when a record changed; stops when nothing is due.
async function tick($: EngineInterface) {
  const now = await $.clock.now(), base = await stateDir($)
  let pending = false, redraw = false
  for (const [id, a] of agents) {
    const need = due(a, now)
    if (!need) continue
    pending = true
    if (need === 'conversation') {
      a.looked = true
      const jobId = parse(await readText($, `${base}/conversations/${id}.json`))?.executionId
      if (!isId(jobId)) continue
      Object.assign(a, { jobId, listed: true })
    }
    const execution = await readText($, `${base}/executions/${a.jobId}.json`)
    const result = await readText($, `${base}/results/${a.jobId}.json`)
    if (execution + result !== a.texts) {
      Object.assign(a, { texts: execution + result, execution: parse(execution) ?? a.execution, result: parse(result) })
      redraw = true
    }
    if (a.execution && !a.result) redraw = true
  }
  if (redraw) $.ui.invalidate('ui.render')
  if (!pending) { timer?.cancel(); timer = undefined }
}

// The person's queued messages: held by the bridge until their turn, or in
// the companion's own queue (delivered there) until it starts them.
function queued(execution: any) {
  return (execution.interventions ?? []).filter((m: any) => m.from === 'user' && m.mode === 'queue'
    && (m.state === 'accepted' || (m.state === 'delivered' && execution.interventionModes?.queue === 'native'))).length
}
// What a running job is doing, as the agent row and the card say it: the
// person's queued messages, or the live view's in-flight line less its bullet.
function doing(execution: any, now: number): Seg[] {
  const waiting = queued(execution)
  if (waiting) return [[`◌ your ${waiting === 1 ? 'message' : `${waiting} messages`} queued`, 'warn']]
  const [[head, style], ...rest] = liveLines({ execution }, { now }).at(-1)!.segs as [Seg, ...Seg[]]
  return [[head.slice(2), style], ...rest]
}
// The model, less its provider prefix when that repeats the companion (opencode/flint-40b-free).
function modelText(execution: any, result?: any) {
  const provider = clean(execution.provider)
  return jobModel(execution, result).map(clean).map(m => m.startsWith(`${provider}/`) ? m.slice(provider.length + 1) : m).join(' ')
}

// The row's body: title, companion · model, the live line and elapsed time,
// or the outcome and duration once the job ended; cut to `columns`.
function body(a: Agent, now: number, columns: number | undefined, titleWidth: number) {
  const { execution, result } = a
  const title = cut(a.title, titleWidth)
  const segs: Seg[] = [[title + ' '.repeat(titleWidth - width(title) + 2)], [clean(execution.provider)]]
  if (result) {
    const [text, style] = outcomeLabel({ execution, result })
    segs.push([' · '], [text, result.outcome === 'completed' ? undefined : style])
  } else {
    const model = modelText(execution)
    if (model) segs.push([` · ${model}`])
    segs.push([' · '], ...doing(execution, now), [` · ${clock(now - execution.startedAt)}`])
  }
  return fitSegs(segs, columns ?? segsWidth(segs))
    .map(([text, style]) => style && SGR[style] ? `\x1b[${SGR[style]}m${text}\x1b[39m` : text).join('').trimEnd()
}

// Each open lists the session's jobs again; the person's own takes the keys.
function openPane($: EngineInterface, focus?: true) {
  void rebuild($)
  return $.ui.open({ id: PANE, title: 'Companions', backgroundColor: 'transparent', ...(focus && { focus }) })
}

// This session's jobs from the records, the ones whose start the mod did not
// see included: a resumed session has no rows for its earlier subagents. The
// newest rebuild wins; a job the mod saw start since stays on the list.
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
    const owners = new Set<string>(), old = new Set(out.older)
    for (const job of out.jobs) {
      const jobId = job.execution?.executionId
      if (!isId(jobId) || typeof job.owner !== 'string') continue
      owners.add(job.owner)
      const a = agents.get(job.owner) ?? { title: '' }
      agents.set(job.owner, a)
      a.title ||= clean(job.title)
      // A newer job the mod saw start stands.
      if (a.jobId && a.jobId !== jobId && !(a.execution?.startedAt < job.execution.startedAt)) continue
      Object.assign(a, { jobId, execution: job.execution, result: job.result, texts: undefined })
      // No result and no process: its subagent ended unseen, so its record is not read again.
      if (job.status !== 'running' && !job.result) a.endedAt ??= 0
    }
    for (const [id, a] of agents) a.listed = owners.has(id) || (a.listed && !old.has(a.jobId))
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
function cards(now: number) {
  const at = (c: { status: string; a: Agent }) => c.status === 'running' ? Infinity : c.a.result?.finishedAt ?? c.a.execution.startedAt
  return [...agents].flatMap(([id, a]) => a.listed && a.jobId && a.execution ? [{ id, a, status: statusOf(a, now) }] : [])
    .sort((x, y) => at(y) - at(x) || y.a.execution.startedAt - x.a.execution.startedAt)
}
const titleOf = (a: Agent) => a.title || (clean(a.execution?.text ?? '').split('\n')[0] ?? '')
// A card's second row, under its title: the companion, then what it is doing or how it ended.
function cardLine({ a, status }: { a: Agent; status: string }, now: number): Seg[] {
  const line: Seg[] = [['     ', 'normal'], [`${clean(a.execution.provider)} · `, 'dim']]
  if (status === 'running') return [...line, ...doing(a.execution, now).map(([text, style]): Seg => [text, style === 'ok' ? 'dim' : style])]
  if (status === 'unknown') return [...line, ['no result', 'warn']]
  const [text, style] = outcomeLabel({ execution: a.execution, result: a.result })
  return [...line, [text, status === 'completed' ? 'dim' : style]]
}

// The viewed job's rows, exactly what fits in `rows`: a running job follows
// its live line, an ended one opens on its outcome.
function jobRows(a: Agent, f: Follow, now: number, w: number, rows: number): Seg[][] {
  const job = f.job ?? (a.execution && { status: statusOf(a, now), execution: a.execution, result: a.result ?? null, branch: null })
  const about = job ? [clean(job.execution.provider), modelText(job.execution, job.result), clean(job.branch ?? '')].filter(Boolean).join(' · ') : ''
  const head = layoutLine({ segs: [[titleOf(a), 'title'], ...(about ? [[`  ${about}`, 'dim'] as Seg] : [])], wrap: false }, w)
  if (!job) return [...head, [], [['waiting for the job\'s record', 'dim']]]
  const running = job.status === 'running'
  const pending = running ? pendingInputs(job.execution, f.taken).sort((x, y) => x.at - y.at).map(pendingLine) : []
  const blocks: Block[] = jobBlocks(job, { list: f.list, labels: f.labels, located: f.turn?.located ?? false, format: f.turn?.format ?? null, now, pending })
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
    await $.command.register({ name: 'companion', description: "Show this session's companion jobs, or the job of the companion subagent in view" })
    void rebuild($)
    return next(e)
  })
  // The person's own open: placed at any width, with the keys.
  on('command.run', { command: 'companion' }, async $ => {
    await openPane($, true)
    return {}
  })

  // The bridge answers agent_send with the job it started for this subagent;
  // a new job opens the pane, which places itself on a wide terminal.
  on('tool.call', { tool: SEND }, async ($, e, next) => {
    const ran = await next(e)
    const jobId = parse(ran.text)?.job_id
    if (e.agentId && isId(jobId)) {
      const a = agents.get(e.agentId) ?? { title: '' }
      agents.set(e.agentId, a)
      // Its subagent sent it, so that subagent runs.
      if (a.jobId !== jobId) {
        Object.assign(a, { jobId, execution: undefined, result: undefined, texts: undefined, endedAt: undefined, listed: true })
        void openPane($).catch(() => {})
      }
      startClock($)
    }
    return ran
  })

  on('ui.render', { component: 'AgentRow', props: { type: 'agent-companion' } }, async ($, e, next) => {
    const { id, description, status, rowIds, columns } = e.props
    const now = await $.clock.now()
    const a = agents.get(id) ?? { title: '' }
    agents.set(id, a)
    a.title = clean(description)
    // A resumed subagent runs again under the same id.
    a.endedAt = ENDED.has(status) ? a.endedAt ?? now : undefined
    if (due(a, now)) startClock($)
    if (!a.execution || (!a.result && !due(a, now))) return next(e)
    // Titles line up across this list's companion rows, within a third of the row.
    const titles = rowIds.flatMap(row => agents.get(row)?.execution ? [width(agents.get(row)!.title)] : [])
    const titleWidth = Math.min(Math.max(width(a.title), ...titles), columns ? Math.floor(columns / 3) : Infinity)
    return next({ ...e, props: { ...e.props, body: body(a, now, columns, titleWidth) } })
  })

  // Draws only from what the clock and the children already brought in.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // A module loaded under an open pane (a reload) has not listed the session's jobs yet.
    if (!rebuilds) void rebuild($)
    const now = await $.clock.now(), w = Math.max(16, e.props.bodyColumns), focused = e.props.isFocused
    const spans = (segs: Seg[]) => segs.map(([text, style]) => h(Text, STYLE[style ?? ''] ?? null, text))
    const row = (segs: Seg[]) => h(Text, { wrap: 'truncate-end' }, ...(segs.length ? spans(segs) : [' ']))
    // h() answers any node; a column Box is the element a pane takes.
    const column = (...children: unknown[]) => h(Box, { flexDirection: 'column' }, ...children) as RenderElement
    const viewed = e.props.view?.agentId, inView = viewed ? agents.get(viewed) : undefined
    // The person's view of a companion subagent wins over the pane's own pick.
    if (inView?.jobId) picked = undefined
    const id = inView?.jobId ? viewed : picked, a = id ? agents.get(id) : undefined
    if (id && a?.jobId) {
      followJob($, a.jobId)
      const back = () => inView?.jobId ? $.ui.view({}) : (picked = undefined, $.ui.invalidate('ui.render'))
      return column(...jobRows(a, follow!, now, w, e.props.scroll.bodyRows).map(row),
        h(Box, { flexDirection: 'row', justifyContent: 'space-between' }, row([[focused ? 'esc returns' : 'ctrl+x tab for keys', 'faint']]),
          h(Button, { key: 'jobs', plain: true, dimColor: true, hotkey: 'b', autoFocus: true, onPress: back }, '← jobs')))
    }
    stopFollow()
    // A card switches Claude Code to its subagent's view; one Claude Code
    // cannot show (a resumed session lists no earlier subagent) opens here.
    const open = async (agentId: string) => {
      const shown = await $.ui.view({ agentId }).catch((error: unknown) => ({ deny: String(error) }))
      if (shown.deny) {
        $.ui.log(`agent-companion: no view of subagent ${agentId} (${shown.deny}); the Companions pane shows its job`, { to: 'debug' })
        picked = agentId
        $.ui.invalidate('ui.render')
      }
    }
    const list = cards(now), shown = list.slice(0, CARDS), more = older + list.length - shown.length
    const running = list.filter(c => c.status === 'running').length
    const title = row([[' '], ['Companions', 'title'], [`  ${running} running · ${list.length - running + older} done`, 'dim']])
    const failed = failure ? [row([[` earlier jobs not read: ${failure}`, 'warn']])] : []
    if (!list.length) return column(title, ...failed, row([]), row([[' No companion jobs in this session yet', 'dim']]))
    const keys = shown.length === 1 ? '1' : `1–${shown.length}`
    // A card's digit leads its title ("1: ● …"), drawn by the engine.
    return column(title, ...failed, row([]),
      ...shown.flatMap((c, i) => [h(Button, { key: c.id, plain: true, hotkey: String(i + 1), ...(i === 0 ? { autoFocus: true as const } : {}), onPress: () => open(c.id) },
        ...spans(cardHead({ status: c.status, startedAt: c.a.execution.startedAt, finishedAt: c.a.result?.finishedAt }, titleOf(c.a), now, w - 2).slice(1)),
        '\n', ...spans(fitSegs(cardLine(c, now), w))), row([])]),
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
