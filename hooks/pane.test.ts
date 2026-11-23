import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/tester'
const DIR = `${HOME}/.claude/agent-companion`
const SEND = 'mcp__plugin_agent-companion_agent-bridge__companion_send'
const START = 1_800_000_000_000
const MODES = { default: 'steer', steer: true, queue: 'bridge', interrupt: true }
const SESSION = 'a21965f1-06a4-4c8f-ac00-d38abcaac9b2'

const pane = (bodyRows = 18, bodyColumns = 64, isFocused = false) => ({
  plugin: 'agent-companion', surface: 'terminal' as const, component: 'Pane' as const, requestId: 'companions',
  props: { title: 'Companions', isFocused, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows }, view: {} },
})
const record = (id: string, fields: Record<string, unknown> = {}) => ({
  jobId: id, thread: 'a', companion: 'codex', state: 'running', startedAt: START, cwd: '/work',
  interventions: [], interventionModes: MODES, progress: {}, ...fields,
})
// Thread records naming each thread's title, as the bridge writes them.
const titled = (titles: Record<string, string>) => Object.fromEntries(Object.entries(titles).map(([thread, title]) =>
  [`${DIR}/threads/${thread}.json`, { thread, title }]))

// What `launch-ui.sh jobs` prints for a session: each thread's newest job
// (bridge-server/ui/jobs.mjs's sessionJobs), and the ids of its other jobs.
type Listed = { jobs: { thread: string; title: string; status: string; record: unknown; result: unknown }[]; older: string[] }
type Run = { exitCode: number; stdout: string; stderr: string }

// The engine beneath the mod: the bridge's records from memory (`reads` counts
// them), companion_send answering each send with the next of `jobs` (thread → job),
// `launch-ui.sh jobs` answering each session's list (`sessions`, or `run` in
// its place), the session's id, the pane's opens and closes (`up` while open),
// the debug log, and the session's commands (`commands`; `registers` counts
// the calls). The kit hands no hook of a test a plugin's $.ui.focus (2.1.326):
// each rejects, so `rings` reads the keys the mod tried from its debug log.
function engine(on: On, files: Record<string, unknown>, jobs: Record<string, string>, now: number,
  { sessions = {}, run, outcome = { ok: true, status: 'accepted' } }:
    { sessions?: Record<string, Listed>; run?: Run; outcome?: Record<string, unknown> | null } = {}) {
  mock.env(on, { HOME })
  const sends = Object.entries(jobs)
  const seen = { reads: 0, opens: [] as unknown[], closes: [] as unknown[], up: false, lists: [] as (readonly string[])[], logs: [] as { text: string }[],
    sends: [] as (readonly string[])[],
    commands: new Set<string>(), registers: 0, rings: () => seen.logs.flatMap(({ text }) => /ring stays off (\S+) \(/.exec(text)?.[1] ?? []) }
  on('fs.read', (_, e) => {
    seen.reads++
    return e.path in files ? { value: JSON.stringify(files[e.path]) } : { deny: `ENOENT: ${e.path}` }
  })
  on('tool.call', () => {
    const [thread, job_id] = sends.shift()!
    return { result: {}, text: JSON.stringify({ ok: true, status: 'still_running', thread, job_id, companion: 'codex' }) }
  })
  on('session.id', () => ({ value: SESSION }))
  on('process.run', (_, e) => {
    // `launch-ui.sh send <dir> <job> <mode> [text]`: the bridge's outcome, or none within the wait.
    if (e.argv[2] === 'send') {
      seen.sends.push(e.argv.slice(3))
      const stdout = JSON.stringify({ requestId: 'q1', outcome: outcome && { requestId: 'q1', ...outcome } }) + '\n'
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    seen.lists.push(e.argv)
    const listed = sessions[e.argv[4]!] ?? { jobs: [], older: [] }
    return { value: { exitCode: 0, stdout: JSON.stringify(listed) + '\n', stderr: '', ...run, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', (_, e) => { seen.opens.push(e); seen.up = true; return { value: { isPlaced: true } } })
  on('ui.close', (_, e) => { seen.closes.push(e); seen.up = false; return { value: undefined } })
  on('ui.panes', () => ({ value: seen.up ? [{ id: 'companions', title: 'Companions', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.log', (_, e) => { seen.logs.push(e); return { value: undefined } })
  on('command.register', (_, e) => { seen.registers++; seen.commands.add(e.name); return { value: { command: e.name } } })
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
// Button's hotkey leads it as the terminal draws it ("1: "), a row spread to
// both ends or with a gap keeps two spaces between its parts, and an Input is
// exactly its rows: the text's last lines, as the field scrolls, or empty ones.
const field = (text: string, rows: number) => {
  const lines = text.split('\n').slice(-rows)
  return [...lines, ...Array(rows - lines.length).fill('')].join('\n')
}
async function screen(ui: { drawn: () => Promise<unknown> }): Promise<string> {
  const text = (node: any): string => typeof node === 'string' ? node
    : node?.type === 'Input' ? field(node.props.value || node.props.placeholder, node.props.rows ?? 1)
    : (node?.type === 'Button' && node.props?.plain && node.props.hotkey ? `${node.props.hotkey}: ` : '')
      + (node?.children?.length ? node.children.map(text).join(node.props?.justifyContent === 'space-between' || node.props?.gap ? '  ' : '') : node?.props?.label ?? '')
  const root: any = await ui.drawn()
  return root.children.map(text).join('\n').split('\n').map((line: string) => line.trimEnd()).join('\n')
}

test("the list: this session's threads as cards, the main conversation's included, running first, and a card opens its job", async ($, on) => {
  const files: Record<string, unknown> = {
    ...titled({ a1: 'Step 3b-2: adapters', a2: 'Review auth middleware', a3: 'Second opinion on schema' }),
    [`${DIR}/jobs/j1.json`]: record('j1', { effectiveModel: 'gpt-6-astra', progress: { activeCommand: ['/bin/zsh', '-lc', 'node --test opencode.test.mjs'] } }),
    [`${DIR}/jobs/j2.json`]: record('j2', { companion: 'opencode', startedAt: START + 100_000 }),
    [`${DIR}/results/j2.json`]: { jobId: 'j2', outcome: 'completed', finishedAt: START + 138_000 },
    [`${DIR}/jobs/j3.json`]: record('j3', { companion: 'claude', startedAt: START + 275_000, interventionModes: { default: 'queue', queue: 'native', interrupt: true },
      interventions: [{ id: 'm1', from: 'user', mode: 'queue', state: 'delivered', text: 'also check the schema', at: START }] }),
  }
  const seen = engine(on, files, { a2: 'j2', a1: 'j1', a3: 'j3' }, START + 400_000)
  const children = follows(on, {})

  // The main conversation's sends, and a subagent's.
  for (const agentId of [undefined, undefined, 'x1']) await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work', ...(agentId && { agentId }) })
  // A job's start opens nothing.
  expect(seen.opens).toEqual([])
  await seen.clock.advance(1000)

  const reads = seen.reads
  const ui = await $.ui.mount(pane())
  expect(await screen(ui)).toBe([
    ' Companions  2 running · 1 done',
    '',
    '1: Second opinion on schema                                 2:06',
    '   ● claude · ◌ your message queued',
    '',
    '2: Step 3b-2: adapters                                      6:41',
    '   ● codex · running $ node --test opencode.test.mjs',
    '',
    '3: Review auth middleware                                     4m',
    '   ✓ opencode · done in 0:38',
    '',
    ' ctrl+x tab for keys · 1–3 or ⏎ open a job',
  ].join('\n'))
  // A card's Button is one plain line: an unstyled label to the pane's edge
  // after the engine's "1: ", which the ring inverts whole; its second row,
  // glyph and colours, is a Text outside it.
  const card = await ui.find({ key: 'a3' })
  expect(card).toMatchObject({ type: 'Button', props: { plain: true, hotkey: '1' }, children: [] })
  expect(card?.props.label).toBe('Second opinion on schema' + ' '.repeat(33) + '2:06')
  expect((await ui.find({ type: 'Text', text: '● claude · ◌ your message queued' }))?.props).toMatchObject({ wrap: 'truncate-end' })

  await ui.press({ key: 'a1' })
  await seen.clock.settle()
  expect(await screen(ui)).toMatch(/^Step 3b-2: adapters  codex · gpt-6-astra/)
  expect(children.map(child => child.job)).toEqual(['j1'])
  // Renders read no files: the clock did.
  await ui.redraw()
  expect(seen.reads).toBe(reads)
  await ui.unmount()
})

test("a card shows its job: labels, folding, pending, the live line last; '← jobs' goes back; one child per shown job", { timeoutMs: 30_000 }, async ($, on) => {
  const turn = 'turn-2', at = '2026-11-17T12:00:00.000Z'
  const items = [
    { id: 'c:1', turnId: turn, at, kind: 'user', text: 'Implement Step 3b-2 of docs/LIVE_VIEW_PLAN.md\nfor the adapters.' },
    { id: 'c:2', turnId: turn, at, kind: 'command', command: ['/bin/zsh', '-lc', 'node --test opencode.test.mjs'], status: 'completed', exitCode: 1,
      output: ['✖ steer is acknowledged on the running session', ...Array.from({ length: 6 }, (_, i) => `  at frame ${i}`), 'tests 1 failed', '\x1b[31mfail 1\x1b[0m'].join('\n') },
    { id: 'c:3', turnId: turn, at, kind: 'assistant', text: 'The steer test fails because the fake server never\nreports idle.' },
    { id: 'c:4', turnId: turn, at, kind: 'user', text: 'Lead steer.' },
  ]
  const running = record('j1', { effectiveModel: 'gpt-6-astra', effortOverride: 'max', progress: { activeCommand: 'node --test opencode.test.mjs' },
    interventions: [{ id: 'l0', from: 'caller', mode: 'steer', state: 'joined', text: 'Lead steer.', at: START },
      { id: 'u1', from: 'user', mode: 'queue', state: 'accepted', text: 'also check the schema', at: START + 1 }] })
  const seen = engine(on, { ...titled({ a1: 'Step 3b-2: adapters', a2: 'Other' }), [`${DIR}/jobs/j1.json`]: running,
    [`${DIR}/jobs/j2.json`]: record('j2') }, { a1: 'j1', a2: 'j2' }, START + 400_000)
  const children = follows(on, {
    j1: { lines: [{ job: { status: 'running', record: running, result: null, branch: 'feat/claude-pane' } },
      { turn: { ids: items.map(item => item.id), earlier: 3, labels: { 'c:1': 'task', 'c:4': 'lead' }, taken: ['l0'], located: true, format: { version: '0.169.0', detail: 'native transcript' } }, items }] },
  })
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work' })
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work' })
  await seen.clock.advance(1000)

  const reads = seen.reads
  // Tall enough for the whole turn above the message box's rows.
  const ui = await $.ui.mount(pane(26))
  await ui.press({ key: 'a1' })
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
    '',
    '─'.repeat(64),
    'Message Codex…',
    '',
    '─'.repeat(64),
    'mode: steer ▸  joins the running turn now  cancel job  b: ← jobs',
    'ctrl+x tab for keys',
  ].join('\n'))
  expect(children.map(child => child.argv)).toEqual([['bash', expect.stringMatching(/\/hooks\/launch-ui\.sh$/), 'follow', DIR, 'j1']])
  // A short transcript leaves the box at the pane's bottom, as the live view does.
  await ui.redraw(pane(40).props)
  const tall = (await screen(ui)).split('\n')
  expect(tall.length).toBe(40)
  expect(tall.slice(-6)).toEqual(['─'.repeat(64), 'Message Codex…', '', '─'.repeat(64), 'mode: steer ▸  joins the running turn now  cancel job  b: ← jobs', 'ctrl+x tab for keys'])
  expect(tall.slice(19, 34).every(line => line === '')).toBe(true)

  await ui.press({ key: 'jobs' })
  // The list again, and the child stops.
  await seen.clock.settle()
  expect(await screen(ui)).toMatch(/^ Companions/)
  expect(children.map(child => [child.job, child.stopped])).toEqual([['j1', true]])

  await ui.press({ key: 'a2' })
  await seen.clock.settle()
  expect(children.map(child => [child.job, child.stopped])).toEqual([['j1', true], ['j2', false]])
  // Renders read no files, whatever they show.
  expect(seen.reads).toBe(reads)
  await ui.unmount()
})

test('an ended job opens on its outcome, and its child exits after the final read without being started again', { timeoutMs: 30_000 }, async ($, on) => {
  const done = record('j2', { companion: 'claude', state: 'closed', startedAt: START, cwd: '/work/web' })
  const result = { jobId: 'j2', outcome: 'completed', finishedAt: START + 38_000, text: 'Added the CSRF guard and its tests.\nOne unrelated date test still fails.',
    effectiveModel: 'opus-5.5', workSummary: { commands: [{ command: 'npm test', exitCode: 1, status: 'failed' }, { command: 'rg csrf', exitCode: 0 }], commandsOmitted: 0,
      edits: [], errors: [], worktree: { available: true, files: [{ path: 'src/auth.ts', added: 18, deleted: 6 }], filesOmitted: 0 } } }
  const items = [{ id: 'c:1', kind: 'user', text: 'Review the auth middleware.' }, { id: 'c:2', kind: 'assistant', text: result.text }]
  const seen = engine(on, { ...titled({ a2: 'Review auth middleware' }), [`${DIR}/jobs/j2.json`]: done, [`${DIR}/results/j2.json`]: result },
    { a2: 'j2' }, START + 600_000)
  const children = follows(on, {
    j2: { exits: true, lines: [{ job: { status: 'completed', record: done, result, branch: 'auth-guard' } },
      { turn: { ids: ['c:1', 'c:2'], earlier: 0, labels: { 'c:1': 'task' }, taken: [], located: true, format: { version: '2.1.325', detail: 'native transcript' } }, items }] },
  })
  await $.tool.call({ tool: SEND, task: 'review', cwd: '/work/web' })
  await seen.clock.advance(1000)

  const ui = await $.ui.mount(pane(14))
  await ui.press({ key: 'a2' })
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

test('/companion opens the pane at any width with the keys, no background of its own, and lists the jobs and registers itself again', async ($, on) => {
  const seen = engine(on, {}, {}, START)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(await $.command.run({ command: 'companion', args: '' } as never)).toEqual({})
  expect(seen.opens).toEqual([{ id: 'companions', title: 'Companions', backgroundColor: 'transparent', focus: true }])
  await seen.clock.settle()
  // One list and one registration at the session's start, one each at the open.
  expect(seen.lists).toHaveLength(2)
  expect(seen.registers).toBe(2)
})

// A session's threads as `launch-ui.sh jobs` lists them: the first still runs, the
// rest ended a minute apart, newest first.
const listed = (count: number, session = 'r'): Listed['jobs'] => Array.from({ length: count }, (_, i) => ({
  thread: `${session}${i + 1}`, title: `Job ${session}${i + 1}`, status: i ? 'completed' : 'running',
  record: record(`${session}j${i + 1}`, { thread: `${session}${i + 1}`, hostSessionId: session, startedAt: START - i * 60_000 }),
  result: i ? { jobId: `${session}j${i + 1}`, outcome: 'completed', finishedAt: START - i * 60_000 + 30_000 } : null,
}))

test("the session's list is rebuilt from the records for its own id, nine cards and an older line, and a job started since joins it", async ($, on) => {
  const older = Array.from({ length: 14 }, (_, i) => `old${i}`)
  const seen = engine(on, { [`${DIR}/jobs/jn.json`]: record('jn', { text: 'New probe', startedAt: START + 50_000 }) }, { n1: 'jn' }, START + 60_000, {
    sessions: { [SESSION]: { jobs: listed(9), older }, other: { jobs: listed(1, 'x'), older: [] } } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  expect(seen.lists).toEqual([['bash', expect.stringMatching(/\/hooks\/launch-ui\.sh$/), 'jobs', DIR, SESSION, '9']])

  const ui = await $.ui.mount(pane(40))
  const lines = (await screen(ui)).split('\n')
  expect(lines.slice(0, 6)).toEqual([
    ' Companions  1 running · 22 done',
    '',
    '1: Job r1                                                   1:00',
    '   ● codex · working',
    '',
    '2: Job r2                                                     1m',
  ])
  expect(lines.slice(-5)).toEqual([
    '   ✓ codex · done in 0:30',
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
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work' })
  await seen.clock.advance(1000)
  await ui.redraw()
  const now = (await screen(ui)).split('\n')
  expect(now[0]).toBe(' Companions  2 running · 22 done')
  expect(now[2]).toMatch(/^1: New probe +0:11$/)
  expect(now.at(-3)).toBe(' 15 older · agent-companion ui shows them')
  // Without listing the session's jobs again.
  expect(seen.lists).toHaveLength(1)
  await ui.unmount()
})

test("keys: the first card, then a running job's box, take the ring, each switch puts it there again, digits and b press them, and the hint names ctrl+x tab until the pane holds the keys", async ($, on) => {
  const seen = engine(on, {}, {}, START + 60_000, { sessions: { [SESSION]: { jobs: listed(1), older: [] } } })
  follows(on, {})
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  const ui = await $.ui.mount(pane(12, 64, true))
  expect((await screen(ui)).split('\n').at(-1)).toBe(' 1 or ⏎ open a job · esc returns')
  expect((await ui.find({ key: 'r1' }))?.props).toMatchObject({ hotkey: '1', autoFocus: true, plain: true })

  await ui.press({ key: 'r1' })
  // A running job that takes messages: the ring is asked into its box; the
  // kit's refusal leaves the rest as it was.
  expect(seen.rings()).toEqual(['message'])
  expect(await ui.find({ key: 'message' })).toMatchObject({ type: 'Input', props: { autoFocus: true, rows: 2, submitLabel: 'send' } })
  expect(await ui.find({ key: 'jobs' })).toMatchObject({ props: { label: '← jobs', hotkey: 'b', plain: true, dimColor: true }, children: [] })
  expect((await ui.find({ key: 'jobs' }))?.props.autoFocus).toBeUndefined()
  expect((await screen(ui)).split('\n').at(-1)).toBe('esc returns to the chat')
  await ui.press({ key: 'jobs' })
  expect(seen.rings()).toEqual(['message', 'r1'])
  expect(await screen(ui)).toMatch(/^ Companions/)
  await ui.unmount()
})

test('a failed list says why, and the jobs the mod saw start stay', async ($, on) => {
  const seen = engine(on, { [`${DIR}/jobs/j1.json`]: record('j1', { text: 'Probe the bridge' }) }, { a1: 'j1' }, START + 60_000,
    { run: { exitCode: 1, stdout: '', stderr: 'agent-companion: Node.js 26 or newer is required.\n' } })
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work' })
  await seen.clock.advance(1000)
  const ui = await $.ui.mount(pane())
  expect((await screen(ui)).split('\n').slice(0, 4)).toEqual([
    ' Companions  1 running · 0 done',
    ' earlier jobs not read: agent-companion: Node.js 26 or newer is required.',
    '',
    '1: Probe the bridge                                         1:01',
  ])
  await ui.unmount()
})

// A running job opened from its card, as its follow child reports it, for the box's tests.
async function boxed($: any, on: On, fields: Record<string, unknown> = {}, options: { outcome?: Record<string, unknown> | null } = {}) {
  const running = record('j1', fields)
  const seen = engine(on, { [`${DIR}/jobs/j1.json`]: running }, { a1: 'j1' }, START + 60_000, options)
  follows(on, { j1: { lines: [{ job: { status: 'running', record: running, result: null, branch: 'main' } },
    { turn: { ids: [], earlier: 0, labels: {}, taken: [], located: true, format: { version: '0.169.0', detail: 'native transcript' } }, items: [] }] } })
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work' })
  await seen.clock.advance(1000)
  const ui = await $.ui.mount(pane(14, 72, true))
  await ui.press({ key: 'a1' })
  await seen.clock.settle()
  return { seen, ui, last: async (n: number) => (await screen(ui)).split('\n').slice(-n) }
}

test('the box grows with its draft as the prompt does, from two rows to a third of the pane, and shrinks again', async ($, on) => {
  const { ui } = await boxed($, on)
  const rows = async () => (await ui.find({ key: 'message' }))?.props.rows
  expect(await rows()).toBe(2)
  // shift+⏎ lines: each its row.
  await ui.input({ key: 'message', text: 'one\ntwo\nthree', kind: 'change' })
  expect(await rows()).toBe(3)
  // A long line wraps at the field's width: the pane's 72 columns less the 27 of its hint.
  await ui.input({ key: 'message', text: 'x'.repeat(100), kind: 'change' })
  expect(await rows()).toBe(3)
  // A 14-row pane gives it 4 at most; the field scrolls past that.
  await ui.input({ key: 'message', text: 'a\nb\nc\nd\ne\nf', kind: 'change' })
  expect(await rows()).toBe(4)
  expect((await screen(ui)).split('\n')).toHaveLength(14)
  await ui.input({ key: 'message', text: 'short', kind: 'change' })
  expect(await rows()).toBe(2)
  await ui.unmount()
})

test("a message from you or the lead shows whole in the job's transcript; the task stays folded", async ($, on) => {
  const items = [{ id: 'u1', kind: 'user', text: 'Do the task.\nStep one.\nStep two.' }, { id: 'u2', kind: 'user', text: 'first line\n\nlast line' }]
  const seen = engine(on, { [`${DIR}/jobs/j1.json`]: record('j1') }, { a1: 'j1' }, START + 60_000)
  follows(on, { j1: { lines: [{ job: { status: 'running', record: record('j1'), result: null, branch: null } },
    { turn: { ids: ['u1', 'u2'], earlier: 0, labels: { u1: 'task', u2: 'you' }, taken: [], located: true, format: { version: '0.169.0', detail: 'native transcript' } }, items }] } })
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work' })
  await seen.clock.advance(1000)
  const ui = await $.ui.mount(pane(20))
  await ui.press({ key: 'a1' })
  await seen.clock.settle()
  const lines = (await screen(ui)).split('\n')
  expect(lines.slice(2, 7)).toEqual(['task   Do the task.' + ' '.repeat(43) + '+2', '', 'you    first line', '', '       last line'])
  await ui.unmount()
})

test("the message box sends through launch-ui.sh send in the shown mode; accepted clears it, refused keeps it and says why", async ($, on) => {
  const { seen, ui, last } = await boxed($, on)
  expect(await last(6)).toEqual(['─'.repeat(72), 'Message Codex…', '', '─'.repeat(72), 'mode: steer ▸  joins the running turn now  cancel job  b: ← jobs', 'esc returns to the chat'])
  await ui.input({ key: 'message', text: 'use ripgrep' })
  await seen.clock.settle()
  expect(seen.sends).toEqual([[DIR, 'j1', 'steer', 'use ripgrep']])
  expect((await ui.find({ key: 'message' }))?.props.value).toBe('')
  // Only text is sent: a blank box sends nothing.
  await ui.input({ key: 'message', text: '   ' })
  expect(seen.sends).toHaveLength(1)
  await ui.unmount()
})

test('a refused message keeps its draft and says why once', async ($, on) => {
  const { seen, ui, last } = await boxed($, on, {}, { outcome: { ok: false, status: 'intervention_unavailable', reason: 'state' } })
  await ui.input({ key: 'message', text: 'too late' })
  await seen.clock.settle()
  expect((await ui.find({ key: 'message' }))?.props.value).toBe('too late')
  expect(await last(3)).toEqual(['✗ not sent: the job no longer takes messages', 'mode: steer ▸  joins the running turn now  cancel job  b: ← jobs', 'esc returns to the chat'])
  await ui.unmount()
})

test("the mode cycles through the companion's own modes from its default; a bridge that does not answer is said", async ($, on) => {
  const { seen, ui, last } = await boxed($, on, { companion: 'claude', interventionModes: { default: 'queue', steer: false, queue: 'native', interrupt: true } }, { outcome: null })
  // The mode shows on the row under the box, the box's own hint leaving the field its room.
  expect((await ui.find({ key: 'message' }))?.props).toMatchObject({ placeholder: 'Message Claude Code…', submitLabel: 'send' })
  expect((await last(2))[0]).toBe('mode: queue ▸  runs after the current turn  cancel job  b: ← jobs')
  await ui.press({ key: 'mode' })
  expect((await last(2))[0]).toBe('mode: interrupt ▸  stops this turn, then sends  cancel job  b: ← jobs')
  await ui.input({ key: 'message', text: 'stop and do this' })
  await seen.clock.settle()
  expect(seen.sends).toEqual([[DIR, 'j1', 'interrupt', 'stop and do this']])
  expect((await last(3))[0]).toBe('✗ not sent: no answer from the bridge yet; it reads requests while its session is open')
  await ui.press({ key: 'mode' })
  expect((await ui.find({ key: 'mode' }))?.props.label).toBe('mode: queue ▸')
  await ui.unmount()
})

test('cancel asks once, sends no text, and no takes it back', async ($, on) => {
  const { seen, ui, last } = await boxed($, on)
  await ui.press({ key: 'cancel' })
  expect(await last(2)).toEqual(['Cancel this job? The lead is told you cancelled it.  yes, cancel  no', 'esc returns to the chat'])
  expect((await ui.find({ key: 'cancel-no' }))?.props.autoFocus).toBe(true)
  await ui.press({ key: 'cancel-no' })
  expect(seen.sends).toEqual([])
  expect((await last(2))[0]).toBe('mode: steer ▸  joins the running turn now  cancel job  b: ← jobs')
  await ui.press({ key: 'cancel' })
  await ui.press({ key: 'cancel-yes' })
  await seen.clock.settle()
  expect(seen.sends).toEqual([[DIR, 'j1', 'cancel']])
  await ui.unmount()
})

test('Copilot takes cancel only: no box and no mode, cancel kept', async ($, on) => {
  const copilot = await boxed($, on, { companion: 'copilot', interventionModes: { default: null, steer: false, queue: false, interrupt: false } })
  expect(await copilot.ui.find({ key: 'message' })).toBeUndefined()
  expect(await copilot.ui.find({ key: 'mode' })).toBeUndefined()
  expect(await copilot.last(3)).toEqual(['Copilot takes no messages while it works · cancel only', 'cancel job  b: ← jobs', 'esc returns to the chat'])
  await copilot.ui.unmount()
})

test('a job whose record has no interventionModes, from a bridge older than the inbox, gets no box', async ($, on) => {
  const { ui, last } = await boxed($, on, { interventionModes: undefined })
  expect(await ui.find({ key: 'message' })).toBeUndefined()
  expect(await last(1)).toEqual(['esc returns  b: ← jobs'])
  await ui.unmount()
})
