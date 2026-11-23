import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/tester'
const DIR = `${HOME}/.claude/agent-companion`
const SEND = 'mcp__plugin_agent-companion_agent-bridge__companion_send'
const START = 1_800_000_000_000

// The bridge's records, served to $.fs.read from memory (`reads` counts the
// reads), and companion_send answering each send with the next thread and job.
function setup(on: On, files: Record<string, unknown>, sends: [string, string][], now = START) {
  mock.env(on, { HOME })
  const state = { reads: 0 }
  on('fs.read', (_, e) => {
    state.reads++
    return e.path in files ? { value: JSON.stringify(files[e.path]) } : { deny: `ENOENT: ${e.path}` }
  })
  on('tool.call', () => {
    const [thread, job_id] = sends.shift()!
    return { result: {}, text: JSON.stringify({ ok: true, status: 'still_running', thread, job_id, companion: 'codex' }) }
  })
  return { clock: mock.clock(on, { now }), fs: state }
}

const band = (props: Record<string, unknown> = {}) => ({
  plugin: 'agent-companion', surface: 'terminal' as const, component: 'AbovePrompt' as const, requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {}, ...props },
})
// The band as plain text, one line per row, trailing spaces cut; nothing when the mod drew nothing.
async function rows(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  const text = (node: any): string => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')
  const root: any = await ui.drawn()
  return root?.type === 'Box' ? root.children.map((row: unknown) => text(row).trimEnd()) : []
}

const execution = (id: string, fields: Record<string, unknown> = {}) => ({
  executionId: id, owner: 't', provider: 'codex', state: 'running', startedAt: START, cwd: '/work',
  interventions: [], interventionModes: { default: 'steer', steer: true, queue: 'bridge', interrupt: true }, progress: {}, ...fields,
})

test("a send from the main conversation lists its thread above the prompt: title, companion · model, what it does, elapsed", async ($, on) => {
  const files: Record<string, unknown> = {
    [`${DIR}/conversations/t1.json`]: { owner: 't1', title: 'Step 3b-2: adapters' },
    [`${DIR}/executions/j1.json`]: execution('j1', { effectiveModel: 'gpt-6-astra', effortOverride: 'max',
      progress: { activeCommand: ['/bin/zsh', '-lc', 'node --test opencode.test.mjs'] } }),
  }
  const { clock, fs } = setup(on, files, [['t1', 'j1']], START + 400_000)
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work' })
  await clock.advance(1000)
  const reads = fs.reads
  const ui = await $.ui.mount(band())
  expect(await rows(ui)).toEqual(['Step 3b-2: adapters  codex · gpt-6-astra max · running $ node --test opencode.test.mjs · 6:41'])
  // The live line in the theme's success colour, the title bold.
  const spans = ((await ui.drawn()) as any).children[0].children
  expect(spans.map((span: any) => [span.children[0], span.props])).toContainEqual(['running $ node --test opencode.test.mjs', { color: 'success' }])
  expect(spans[0].props).toEqual({ weight: 'bold' })
  // Records are read on the clock, never by a render.
  await ui.redraw()
  expect(fs.reads).toBe(reads)
  await ui.unmount()
})

test("the person's queued message replaces the live line, titles line up, and an ended thread leaves the band", async ($, on) => {
  const files: Record<string, unknown> = {
    [`${DIR}/executions/j3.json`]: execution('j3', { provider: 'claude', effectiveModel: 'opus-5.5', text: 'Second opinion on schema\nwith detail',
      interventionModes: { default: 'queue', steer: false, queue: 'native', interrupt: true },
      interventions: [{ id: 'm1', from: 'user', mode: 'queue', state: 'delivered', text: 'also check the schema', at: START }],
      progress: { activity: 'thinking' } }),
    [`${DIR}/executions/j4.json`]: execution('j4', { provider: 'opencode', text: 'Probe', progress: { partialText: 'Reading' } }),
  }
  const { clock } = setup(on, files, [['t3', 'j3'], ['t4', 'j4']], START + 125_000)
  // A subagent's send is listed as the main conversation's are.
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work', agentId: 'a1' })
  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work' })
  await clock.advance(1000)
  const ui = await $.ui.mount(band())
  expect(await rows(ui)).toEqual([
    'Second opinion on schema  claude · opus-5.5 · ◌ your message queued · 2:06',
    'Probe                     opencode · responding · 2:06',
  ])
  files[`${DIR}/results/j3.json`] = { executionId: 'j3', outcome: 'failed', finishedAt: START + 62_000 }
  files[`${DIR}/results/j4.json`] = { executionId: 'j4', outcome: 'completed', finishedAt: START + 62_000 }
  await clock.advance(1000)
  await ui.redraw()
  expect(await rows(ui)).toEqual([])
  await ui.unmount()
})

test('the band draws nothing with no thread running, yields to a survey, and cuts rows to its columns', async ($, on) => {
  const files: Record<string, unknown> = {
    [`${DIR}/conversations/t5.json`]: { owner: 't5', title: 'Step 3b-2: adapters' },
    [`${DIR}/executions/j5.json`]: execution('j5', { progress: { activeCommand: 'npm test -- --reporter spec' }, effectiveModel: 'gpt-6-astra' }),
  }
  const { clock, fs } = setup(on, files, [['t5', 'j5']])
  const empty = await $.ui.mount(band())
  expect(await rows(empty)).toEqual([])
  expect(fs.reads).toBe(0)
  await empty.unmount()

  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work' })
  await clock.advance(1000)
  const survey = await $.ui.mount(band({ hasSurvey: true }))
  expect(await rows(survey)).toEqual([])
  await survey.unmount()
  const narrow = await $.ui.mount(band({ bodyColumns: 40 }))
  const [shown] = await rows(narrow)
  expect(shown).toBe('Step 3b-2: a…  codex · gpt-6-astra · ru…')
  expect([...shown!].length).toBeLessThanOrEqual(40)
  await narrow.unmount()
})
