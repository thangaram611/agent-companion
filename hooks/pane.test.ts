import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const HOME = '/home/tester'
const DIR = `${HOME}/.claude/agent-companion`
const SEND = 'mcp__plugin_agent-companion_agent-bridge__agent_send'
const START = 1_800_000_000_000
const MODES = { default: 'steer', steer: true, queue: 'bridge', interrupt: true }
const SESSION = 'a21965f1-06a4-4c8f-ac00-d38abcaac9b2'

const pane = (view: { agentId?: string } = {}, bodyRows = 18, bodyColumns = 64, isFocused = false) => ({
  plugin: 'agent-companion', surface: 'terminal' as const, component: 'Pane' as const, requestId: 'companions',
  props: { title: 'Companions', isFocused, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows }, view },
})
const agentRow = (id: string, description: string) => ({
  surface: 'terminal' as const, component: 'AgentRow' as const, requestId: id,
  props: { id, description, type: 'agent-companion', status: 'running', kind: 'local_agent', taskStatus: 'running', label: description,
    startTime: START, cwd: '/work', tokenCount: 0, tokenSamples: [], hasRow: true, rowIds: [id], columns: 120, isHidden: false } satisfies RenderPropsOf['AgentRow'],
})
const execution = (id: string, fields: Record<string, unknown> = {}) => ({
  executionId: id, owner: 'a', provider: 'codex', state: 'running', startedAt: START, cwd: '/work',
  interventions: [], interventionModes: MODES, progress: {}, ...fields,
})

// What `launch-ui.sh jobs` prints for a session: each subagent's newest job
// (bridge-server/ui/jobs.mjs's sessionJobs), and the ids of its other jobs.
type Listed = { jobs: { owner: string; title: string; status: string; execution: unknown; result: unknown }[]; older: string[] }
type Run = { exitCode: number; stdout: string; stderr: string }

// The engine beneath the mod: the bridge's records from memory (`reads` counts
// them), agent_send answering each subagent's job, `launch-ui.sh jobs`
// answering each session's list (`sessions`, or `run` in its place), the
// session's id, the pane's open, the view (refused for `unviewable` agents)
// and the debug log.
function engine(on: On, files: Record<string, unknown>, jobs: Record<string, string>, now: number,
  { sessions = {}, unviewable = [], run }: { sessions?: Record<string, Listed>; unviewable?: string[]; run?: Run } = {}) {
  mock.env(on, { HOME })
  const seen = { reads: 0, opens: [] as unknown[], views: [] as unknown[], lists: [] as (readonly string[])[], logs: [] as unknown[] }
  on('fs.read', (_, e) => {
    seen.reads++
    return e.path in files ? { value: JSON.stringify(files[e.path]) } : { deny: `ENOENT: ${e.path}` }
  })
  on('tool.call', (_, e) => ({ result: {}, text: JSON.stringify({ ok: true, status: 'still_running', job_id: jobs[e.agentId!], target: 'codex' }) }))
  on('session.id', () => ({ value: SESSION }))
  on('process.run', (_, e) => {
    seen.lists.push(e.argv)
    const listed = sessions[e.argv[4]!] ?? { jobs: [], older: [] }
    return { value: { exitCode: 0, stdout: JSON.stringify(listed) + '\n', stderr: '', ...run, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', (_, e) => { seen.opens.push(e); return { value: { isPlaced: true } } })
  on('ui.view', (_, e) => {
    seen.views.push(e)
    return { value: e.agentId && unviewable.includes(e.agentId) ? { deny: 'no agent holds that id' } : {} }
  })
  on('ui.log', (_, e) => { seen.logs.push(e); return { value: undefined } })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  return Object.assign(seen, { clock: mock.clock(on, { now }) })
}

// Each `follow` child the mod starts: what `launch-ui.sh follow` would print
// for its job, in two pieces split mid-line as a pipe may deliver them; a
// finished job's child then exits, a running one's waits until the mod stops it.
type Child = { argv: readonly string[]; job: string; stopped: boolean }
function follows(on: On, scripts: Record<string, { lines: unknown[]; exits?: boolean }>) {
  const children: Child[] = []
  on('process.spawn', async function* (_, e, next) {
    const child: Child = { argv: e.argv, job: e.argv.at(-1)!, stopped: false }
    children.push(child)
    const script = scripts[child.job] ?? { lines: [] }
    const text = script.lines.map(line => JSON.stringify(line) + '\n').join('')
    const half = Math.floor(text.length / 2)
    if (text) {
      yield { stream: 'stdout' as const, text: text.slice(0, half) }
      yield { stream: 'stdout' as const, text: text.slice(half) }
    }
    if (!script.exits) await new Promise<void>(resolve => next.signal.aborted ? resolve() : next.signal.addEventListener('abort', () => resolve()))
    child.stopped = !script.exits
    return { value: script.exits ? { code: 0, signal: null } : { code: null, signal: 'SIGTERM' } } as never
  })
  return children
}

// The drawing as plain text, one line per row, trailing spaces cut: a plain
// Button's hotkey leads it as the terminal draws it ("1: "), and a row spread
// to both ends keeps two spaces between its parts.
async function screen(ui: { drawn: () => Promise<unknown> }): Promise<string> {
  const text = (node: any): string => typeof node === 'string' ? node
    : (node?.type === 'Button' && node.props?.plain && node.props.hotkey ? `${node.props.hotkey}: ` : '')
      + (node?.children?.length ? node.children.map(text).join(node.props?.justifyContent === 'space-between' ? '  ' : '') : node?.props?.label ?? '')
  const root: any = await ui.drawn()
  return root.children.map(text).join('\n').split('\n').map((line: string) => line.trimEnd()).join('\n')
}

test("the list: this session's jobs as cards, running first, and a card opens its subagent's view", async ($, on) => {
  const files: Record<string, unknown> = {
    [`${DIR}/executions/j1.json`]: execution('j1', { effectiveModel: 'gpt-6-astra', progress: { activeCommand: ['/bin/zsh', '-lc', 'node --test opencode.test.mjs'] } }),
    [`${DIR}/executions/j2.json`]: execution('j2', { provider: 'opencode', startedAt: START + 100_000 }),
    [`${DIR}/results/j2.json`]: { executionId: 'j2', outcome: 'completed', finishedAt: START + 138_000 },
    [`${DIR}/executions/j3.json`]: execution('j3', { provider: 'claude', startedAt: START + 275_000, interventionModes: { default: 'queue', queue: 'native', interrupt: true },
      interventions: [{ id: 'm1', from: 'user', mode: 'queue', state: 'delivered', text: 'also check the schema', at: START }] }),
  }
  const seen = engine(on, files, { a1: 'j1', a2: 'j2', a3: 'j3' }, START + 400_000)
  const children = follows(on, {})

  for (const [id, title] of [['a2', 'Review auth middleware'], ['a1', 'Step 3b-2: adapters'], ['a3', 'Second opinion on schema']] as const) {
    await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work', agentId: id })
    await $.ui.render(agentRow(id, title))
  }
  // A new job opens the pane, with no background of its own.
  expect(seen.opens).toEqual(Array(3).fill({ id: 'companions', title: 'Companions', backgroundColor: 'transparent' }))
  await seen.clock.advance(1000)

  const reads = seen.reads
  const ui = await $.ui.mount(pane())
  expect(await screen(ui)).toBe([
    ' Companions  2 running · 1 done',
    '',
    '1: ● Second opinion on schema                              2:06',
    '     claude · ◌ your message queued',
    '',
    '2: ● Step 3b-2: adapters                                   6:41',
    '     codex · running $ node --test opencode.test.mjs',
    '',
    '3: ✓ Review auth middleware                                  4m',
    '     opencode · ✓ done in 0:38',
    '',
    ' ctrl+x tab for keys · 1–3 or ⏎ open a job',
  ].join('\n'))
  expect((await ui.find({ key: 'a3' }))?.type).toBe('Button')

  await ui.press({ key: 'a1' })
  expect(seen.views).toEqual([{ agentId: 'a1' }])
  expect(children).toEqual([])
  // Renders read no files: the clock did.
  await ui.redraw()
  expect(seen.reads).toBe(reads)
  await ui.unmount()
})

test("the subagent in view shows its job: labels, folding, pending, the live line last; '← jobs' goes back; one child per viewed job", { timeoutMs: 30_000 }, async ($, on) => {
  const turn = 'turn-2', at = '2026-11-17T12:00:00.000Z'
  const items = [
    { id: 'c:1', turnId: turn, at, kind: 'user', text: 'Implement Step 3b-2 of docs/LIVE_VIEW_PLAN.md\nfor the adapters.' },
    { id: 'c:2', turnId: turn, at, kind: 'command', command: ['/bin/zsh', '-lc', 'node --test opencode.test.mjs'], status: 'completed', exitCode: 1,
      output: ['✖ steer is acknowledged on the running session', ...Array.from({ length: 6 }, (_, i) => `  at frame ${i}`), 'tests 1 failed', '\x1b[31mfail 1\x1b[0m'].join('\n') },
    { id: 'c:3', turnId: turn, at, kind: 'assistant', text: 'The steer test fails because the fake server never\nreports idle.' },
    { id: 'c:4', turnId: turn, at, kind: 'user', text: 'Lead steer.' },
  ]
  const running = execution('j1', { effectiveModel: 'gpt-6-astra', effortOverride: 'max', progress: { activeCommand: 'node --test opencode.test.mjs' },
    interventions: [{ id: 'l0', from: 'caller', mode: 'steer', state: 'joined', text: 'Lead steer.', at: START },
      { id: 'u1', from: 'user', mode: 'queue', state: 'accepted', text: 'also check the schema', at: START + 1 }] })
  const seen = engine(on, {}, { a1: 'j1', a2: 'j2' }, START + 400_000)
  const children = follows(on, {
    j1: { lines: [{ job: { status: 'running', execution: running, result: null, branch: 'feat/claude-pane' } },
      { turn: { ids: items.map(item => item.id), earlier: 3, labels: { 'c:1': 'task', 'c:4': 'lead' }, taken: ['l0'], located: true, format: { version: '0.169.0', detail: 'native transcript' } }, items }] },
  })
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work', agentId: 'a1' })
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work', agentId: 'a2' })
  await $.ui.render(agentRow('a1', 'Step 3b-2: adapters'))

  const reads = seen.reads
  const ui = await $.ui.mount(pane({ agentId: 'a1' }, 20))
  await seen.clock.settle()
  expect(await screen(ui)).toBe([
    'Step 3b-2: adapters  codex · gpt-6-astra max · feat/claude-pane',
    '',
    '3 earlier items · agent-companion ui shows them',
    'task   Implement Step 3b-2 of docs/LIVE_VIEW_PLAN.md          +1',
    '',
    '$ node --test opencode.test.mjs                           exit 1',
    '  ✖ steer is acknowledged on the running session',
    '    at frame 0',
    '  +5 lines',
    '  tests 1 failed',
    '  fail 1',
    '',
    'The steer test fails because the fake server never',
    'reports idle.',
    '',
    'lead   Lead steer.',
    '',
    '◌ you · queued  also check the schema  runs after this turn',
    '● running $ node --test opencode.test.mjs',
    'ctrl+x tab for keys  b: ← jobs',
  ].join('\n'))
  expect(children.map(child => child.argv)).toEqual([['bash', expect.stringMatching(/\/hooks\/launch-ui\.sh$/), 'follow', DIR, 'j1']])

  await ui.press({ key: 'jobs' })
  expect(seen.views).toEqual([{}])
  // The engine re-runs the pane for the new view: the list, and the child stops.
  await ui.redraw(pane({}).props)
  await seen.clock.settle()
  expect(await screen(ui)).toMatch(/^ Companions/)
  expect(children.map(child => [child.job, child.stopped])).toEqual([['j1', true]])

  await ui.redraw(pane({ agentId: 'a1' }).props)
  await ui.redraw(pane({ agentId: 'a2' }).props)
  await seen.clock.settle()
  expect(children.map(child => [child.job, child.stopped])).toEqual([['j1', true], ['j1', true], ['j2', false]])
  // Renders read no files, whatever they show.
  expect(seen.reads).toBe(reads)
  await ui.unmount()
})

test('an ended job opens on its outcome, and its child exits after the final read without being started again', { timeoutMs: 30_000 }, async ($, on) => {
  const done = execution('j2', { provider: 'claude', state: 'closed', startedAt: START, cwd: '/work/web' })
  const result = { executionId: 'j2', outcome: 'completed', finishedAt: START + 38_000, text: 'Added the CSRF guard and its tests.\nOne unrelated date test still fails.',
    effectiveModel: 'opus-5.5', workSummary: { commands: [{ command: 'npm test', exitCode: 1, status: 'failed' }, { command: 'rg csrf', exitCode: 0 }], commandsOmitted: 0,
      edits: [], errors: [], worktree: { available: true, files: [{ path: 'src/auth.ts', added: 18, deleted: 6 }], filesOmitted: 0 } } }
  const items = [{ id: 'c:1', kind: 'user', text: 'Review the auth middleware.' }, { id: 'c:2', kind: 'assistant', text: result.text }]
  const seen = engine(on, {}, { a2: 'j2' }, START + 600_000)
  const children = follows(on, {
    j2: { exits: true, lines: [{ job: { status: 'completed', execution: done, result, branch: 'auth-guard' } },
      { turn: { ids: ['c:1', 'c:2'], earlier: 0, labels: { 'c:1': 'task' }, taken: [], located: true, format: { version: '2.1.325', detail: 'native transcript' } }, items }] },
  })
  await $.tool.call({ tool: SEND, task: 'review', cwd: '/work/web', agentId: 'a2' })
  await $.ui.render(agentRow('a2', 'Review auth middleware'))

  const ui = await $.ui.mount(pane({ agentId: 'a2' }, 14))
  await seen.clock.settle()
  expect(await screen(ui)).toBe([
    'Review auth middleware  claude · opus-5.5 · auth-guard',
    '',
    '✓ done in 0:38  2 commands, 1 failed · 1 file changed',
    'git, any writer: src/auth.ts +18 −6',
    '',
    'Added the CSRF guard and its tests.',
    'One unrelated date test still fails.',
    '',
    'transcript ↓ (2 items)',
    '',
    'task   Review the auth middleware.',
    '',
    'answer, shown above',
    'ctrl+x tab for keys  b: ← jobs',
  ].join('\n'))
  await ui.redraw()
  await seen.clock.settle()
  expect(children.map(child => [child.job, child.stopped])).toEqual([['j2', false]])
  await ui.unmount()
})

test('an agent the mod does not know, or a companion subagent with no job yet, shows the list and starts no child', async ($, on) => {
  const seen = engine(on, {}, {}, START)
  const children = follows(on, {})
  await $.ui.render(agentRow('a4', 'Not started yet'))
  for (const view of [{ agentId: 'e1' }, { agentId: 'a4' }]) {
    const ui = await $.ui.mount(pane(view))
    expect(await screen(ui)).toBe(' Companions  0 running · 0 done\n\n No companion jobs in this session yet')
    await ui.unmount()
  }
  expect(children).toEqual([])
  expect(seen.views).toEqual([])
})

test('/companion opens the pane at any width with the keys, no background of its own, and lists the jobs again', async ($, on) => {
  const seen = engine(on, {}, {}, START)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(await $.command.run({ command: 'companion', args: '' } as never)).toEqual({})
  expect(seen.opens).toEqual([{ id: 'companions', title: 'Companions', backgroundColor: 'transparent', focus: true }])
  await seen.clock.settle()
  // One list at the session's start, one at the open.
  expect(seen.lists).toHaveLength(2)
})

// A session's subagents as `launch-ui.sh jobs` lists them: the first still runs, the
// rest ended a minute apart, newest first.
const listed = (count: number, session = 'r'): Listed['jobs'] => Array.from({ length: count }, (_, i) => ({
  owner: `${session}${i + 1}`, title: `Job ${session}${i + 1}`, status: i ? 'completed' : 'running',
  execution: execution(`${session}j${i + 1}`, { owner: `${session}${i + 1}`, hostSessionId: session, startedAt: START - i * 60_000 }),
  result: i ? { executionId: `${session}j${i + 1}`, outcome: 'completed', finishedAt: START - i * 60_000 + 30_000 } : null,
}))

test("a resumed session's list is rebuilt from the records for its own id, nine cards and an older line, and a job started since joins it", async ($, on) => {
  const older = Array.from({ length: 14 }, (_, i) => `old${i}`)
  const seen = engine(on, { [`${DIR}/executions/jn.json`]: execution('jn', { text: 'New probe', startedAt: START + 50_000 }) }, { n1: 'jn' }, START + 60_000, {
    sessions: { [SESSION]: { jobs: listed(9), older }, other: { jobs: listed(1, 'x'), older: [] } } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  expect(seen.lists).toEqual([['bash', expect.stringMatching(/\/hooks\/launch-ui\.sh$/), 'jobs', DIR, SESSION, '9']])

  const ui = await $.ui.mount(pane({}, 40))
  const lines = (await screen(ui)).split('\n')
  expect(lines.slice(0, 6)).toEqual([
    ' Companions  1 running · 22 done',
    '',
    '1: ● Job r1                                                1:00',
    '     codex · working',
    '',
    '2: ✓ Job r2                                                  1m',
  ])
  expect(lines.slice(-5)).toEqual([
    '     codex · ✓ done in 0:30',
    '',
    ' 14 older · agent-companion ui shows them',
    '',
    ' ctrl+x tab for keys · 1–9 or ⏎ open a job',
  ])
  // Another session's jobs are never listed.
  expect(lines.some(line => line.includes('Job x1'))).toBe(false)
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(button => [button.key, button.props.hotkey, button.props.autoFocus])).toEqual(
    Array.from({ length: 9 }, (_, i) => [`r${i + 1}`, String(i + 1), i ? undefined : true]))

  // A job started since takes the first card; the ninth one moves to the older line.
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work', agentId: 'n1' })
  await seen.clock.advance(1000)
  await ui.redraw()
  const now = (await screen(ui)).split('\n')
  expect(now[0]).toBe(' Companions  2 running · 22 done')
  expect(now[2]).toMatch(/^1: ● New probe +0:11$/)
  expect(now.at(-3)).toBe(' 15 older · agent-companion ui shows them')
  expect(seen.lists).toHaveLength(2)
  await ui.unmount()
})

test("a card whose subagent Claude Code cannot view opens its job in the pane; '← jobs' comes back, and the person's view wins", { timeoutMs: 30_000 }, async ($, on) => {
  const [old] = listed(2).slice(1)
  const seen = engine(on, { [`${DIR}/executions/j1.json`]: execution('j1') }, { a1: 'j1' }, START + 60_000, {
    sessions: { [SESSION]: { jobs: [old!], older: [] } }, unviewable: ['r2'] })
  const children = follows(on, { rj2: { exits: true, lines: [{ job: { status: 'completed', execution: old!.execution, result: old!.result, branch: 'main' } },
    { turn: { ids: ['c:1'], earlier: 0, labels: { 'c:1': 'task' }, taken: [], located: true, format: { version: '0.169.0', detail: 'native transcript' } },
      items: [{ id: 'c:1', kind: 'user', text: 'Probe the old bridge.' }] }] } })
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work', agentId: 'a1' })
  await seen.clock.advance(1000)

  const ui = await $.ui.mount(pane({}, 12))
  await seen.clock.settle()
  await ui.press({ key: 'r2' })
  await seen.clock.settle()
  expect(seen.views).toEqual([{ agentId: 'r2' }])
  expect(await screen(ui)).toBe([
    'Job r2  codex · main',
    '',
    '✓ done in 0:30',
    '',
    '(no answer)',
    '',
    'transcript ↓ (1 item)',
    '',
    'task   Probe the old bridge.',
    'ctrl+x tab for keys  b: ← jobs',
  ].join('\n'))
  expect(children.map(child => child.job)).toEqual(['rj2'])
  expect(seen.logs).toEqual([{ text: 'agent-companion: no view of subagent r2 (no agent holds that id); the Companions pane shows its job', to: 'debug' }])

  // Back to the list without moving Claude Code's view.
  await ui.press({ key: 'jobs' })
  expect(seen.views).toEqual([{ agentId: 'r2' }])
  expect(await screen(ui)).toMatch(/^ Companions  1 running · 1 done/)

  // The person viewing a companion subagent replaces the pane's pick, and their main view shows the list.
  await ui.press({ key: 'r2' })
  await ui.redraw(pane({ agentId: 'a1' }, 12).props)
  await seen.clock.settle()
  expect(children.map(child => child.job)).toEqual(['rj2', 'rj2', 'j1'])
  await ui.redraw(pane({}, 12).props)
  expect(await screen(ui)).toMatch(/^ Companions/)
  await ui.unmount()
})

test("keys: the first card and '← jobs' take the ring, digits and b press them, and the hint names ctrl+x tab until the pane holds the keys", async ($, on) => {
  const seen = engine(on, {}, {}, START + 60_000, { sessions: { [SESSION]: { jobs: listed(1), older: [] } } })
  follows(on, {})
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  const ui = await $.ui.mount(pane({}, 12, 64, true))
  expect((await screen(ui)).split('\n').at(-1)).toBe(' 1 or ⏎ open a job · esc returns')
  expect((await ui.find({ key: 'r1' }))?.props).toMatchObject({ hotkey: '1', autoFocus: true, plain: true })

  await ui.press({ key: 'r1' })
  expect(seen.views).toEqual([{ agentId: 'r1' }])
  await ui.redraw(pane({ agentId: 'r1' }, 12, 64, true).props)
  expect((await ui.find({ key: 'jobs' }))?.props).toMatchObject({ hotkey: 'b', autoFocus: true, plain: true })
  expect((await screen(ui)).split('\n').at(-1)).toBe('esc returns  b: ← jobs')
  await ui.press({ key: 'jobs' })
  expect(seen.views).toEqual([{ agentId: 'r1' }, {}])
  await ui.unmount()
})

test('a failed list says why, and the jobs the mod saw start stay', async ($, on) => {
  const seen = engine(on, { [`${DIR}/executions/j1.json`]: execution('j1', { text: 'Probe the bridge' }) }, { a1: 'j1' }, START + 60_000,
    { run: { exitCode: 1, stdout: '', stderr: 'agent-companion: Node.js 26 or newer is required.\n' } })
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work', agentId: 'a1' })
  await seen.clock.advance(1000)
  const ui = await $.ui.mount(pane())
  expect((await screen(ui)).split('\n').slice(0, 4)).toEqual([
    ' Companions  1 running · 0 done',
    ' earlier jobs not read: agent-companion: Node.js 26 or newer is required.',
    '',
    '1: ● Probe the bridge                                      1:01',
  ])
  await ui.unmount()
})
