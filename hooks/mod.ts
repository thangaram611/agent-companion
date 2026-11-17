import type { EngineInterface, Register } from 'claude-code'

import { clean, clock, cut, fitSegs, liveLines, outcomeLabel, segsWidth, width, type Seg } from '../bridge-server/ui/rows.mjs'
import { jobModel } from '../lib/model-name.mjs'

// Claude Code's mod for agent-companion (Codex ignores hooks modules): each
// agent-companion subagent's row in the agent list carries its job's
// progress, read from the bridge's records. Other subagents' rows are left
// to the engine. Native text reaches the row only through rows.mjs's clean.

type Agent = {
  title: string
  endedAt?: number
  jobId?: string
  execution?: any
  result?: any
  texts?: string
  looked?: boolean
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

const agents = new Map<string, Agent>()
let timer: { cancel: () => void } | undefined
let dir: string | undefined

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
      a.jobId = jobId
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
    // The companion is already named: drop its own provider prefix (opencode/flint-40b-free).
    const provider = clean(execution.provider)
    const model = jobModel(execution).map(clean).map(m => m.startsWith(`${provider}/`) ? m.slice(provider.length + 1) : m).join(' ')
    if (model) segs.push([` · ${model}`])
    const waiting = queued(execution)
    if (waiting) segs.push([' · '], [`◌ your ${waiting === 1 ? 'message' : `${waiting} messages`} queued`, 'warn'])
    else {
      // The live view's in-flight line, less its bullet: the engine draws the row's.
      const [[head, style], ...rest] = liveLines({ execution }, { now }).at(-1)!.segs as [Seg, ...Seg[]]
      segs.push([' · '], [head.slice(2), style], ...rest)
    }
    segs.push([` · ${clock(now - execution.startedAt)}`])
  }
  return fitSegs(segs, columns ?? segsWidth(segs))
    .map(([text, style]) => style && SGR[style] ? `\x1b[${SGR[style]}m${text}\x1b[39m` : text).join('').trimEnd()
}

export const register: Register = on => {
  // The bridge answers agent_send with the job it started for this subagent.
  on('tool.call', { tool: SEND }, async ($, e, next) => {
    const ran = await next(e)
    const jobId = parse(ran.text)?.job_id
    if (e.agentId && isId(jobId)) {
      const a = agents.get(e.agentId) ?? { title: '' }
      if (a.jobId !== jobId) Object.assign(a, { jobId, execution: undefined, result: undefined, texts: undefined })
      agents.set(e.agentId, a)
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
}
