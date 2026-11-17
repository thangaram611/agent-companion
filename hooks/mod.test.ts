import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const HOME = '/home/tester'
const DIR = `${HOME}/.claude/agent-companion`
const SEND = 'mcp__plugin_agent-companion_agent-bridge__agent_send'
const START = 1_800_000_000_000
const plain = (text?: string) => text?.replace(/\x1b\[[0-9;]*m/g, '')

// The bridge's records, served to $.fs.read from memory; `reads` counts the reads.
function records(on: On, files: Record<string, unknown>) {
  const state = { reads: 0 }
  on('fs.read', (_, e) => {
    state.reads++
    return e.path in files ? { value: JSON.stringify(files[e.path]) } : { deny: `ENOENT: ${e.path}` }
  })
  return state
}

// Each body the mod hands the engine for an agent row.
function bodies(on: On) {
  const seen: (string | undefined)[] = []
  on('ui.render', { component: 'AgentRow' }, ($, e, next) => {
    seen.push(e.props.body)
    return next(e)
  })
  return seen
}

function setup(on: On, files: Record<string, unknown>, now = START) {
  mock.env(on, { HOME })
  return { clock: mock.clock(on, { now }), fs: records(on, files), seen: bodies(on) }
}

type RowProps = RenderPropsOf['AgentRow']
const row = (id: string, props: Partial<RowProps> = {}) => ({
  surface: 'terminal' as const,
  component: 'AgentRow' as const,
  requestId: id,
  props: {
    id, description: 'Step 3b-2: adapters', type: 'agent-companion', status: 'running', kind: 'local_agent',
    taskStatus: 'running', label: 'Step 3b-2: adapters', startTime: START, cwd: '/work', tokenCount: 0,
    tokenSamples: [], hasRow: true, rowIds: [id], columns: 120, isHidden: false, ...props,
  } satisfies RowProps,
})

const execution = (id: string, fields: Record<string, unknown> = {}) => ({
  executionId: id, owner: 'a', provider: 'codex', state: 'running', startedAt: START, cwd: '/work',
  interventions: [], interventionModes: { default: 'steer', steer: true, queue: 'bridge', interrupt: true }, progress: {}, ...fields,
})

test('agent_send maps the subagent to its job and the row shows the running command', async ($, on) => {
  const files: Record<string, unknown> = {
    [`${DIR}/executions/j1.json`]: execution('j1', { effectiveModel: 'gpt-6-astra', effortOverride: 'max',
      progress: { activeCommand: ['/bin/zsh', '-lc', 'node --test opencode.test.mjs'] } }),
  }
  const { clock, fs, seen } = setup(on, files, START + 400_000)
  on('tool.call', () => ({ result: {}, text: JSON.stringify({ ok: true, status: 'still_running', job_id: 'j1', thread: 'a1', target: 'codex' }) }))

  await $.tool.call({ tool: SEND, task: 'do it', cwd: '/work', agentId: 'a1' })
  await clock.advance(1000)
  const reads = fs.reads
  await $.ui.render(row('a1'))
  await $.ui.render(row('a1'))

  expect(plain(seen.at(-1))).toBe('Step 3b-2: adapters  codex · gpt-6-astra max · running $ node --test opencode.test.mjs · 6:41')
  expect(seen.at(-1)).toContain('\x1b[32mrunning $ node --test opencode.test.mjs\x1b[39m')
  // Records are read on the clock, never by a render.
  expect(fs.reads).toBe(reads)
})

test('a job started before the mod loaded is found through its conversation record, and the row follows it to its end', async ($, on) => {
  const files: Record<string, unknown> = {
    [`${DIR}/conversations/a2.json`]: { owner: 'a2', executionId: 'j2' },
    [`${DIR}/executions/j2.json`]: execution('j2', { provider: 'opencode', effectiveModel: { providerID: 'opencode', id: 'flint-40b-free', variant: 'default' },
      progress: { partialText: 'Reading the adapter' } }),
  }
  const { clock, seen } = setup(on, files, START + 41_000)

  const ui = await $.ui.mount({ plugin: 'agent-companion', ...row('a2', { description: 'Review auth middleware' }) })
  expect(seen.at(-1)).toBeUndefined()

  // The clock finds the job and redraws the row.
  await clock.advance(1000)
  expect(plain(seen.at(-1))).toBe('Review auth middleware  opencode · flint-40b-free · responding · 0:42')

  files[`${DIR}/results/j2.json`] = { executionId: 'j2', outcome: 'completed', finishedAt: START + 38_000 }
  await clock.advance(1000)
  expect(plain(seen.at(-1))).toBe('Review auth middleware  opencode · ✓ done in 0:38')
  await ui.unmount()
})

test("the person's queued message replaces the live line, and a failure shows in red", async ($, on) => {
  const files: Record<string, unknown> = {
    [`${DIR}/conversations/a3.json`]: { owner: 'a3', executionId: 'j3' },
    [`${DIR}/executions/j3.json`]: execution('j3', { provider: 'claude', effectiveModel: 'opus-5.5',
      interventionModes: { default: 'queue', steer: false, queue: 'native', interrupt: true },
      interventions: [{ id: 'm1', from: 'user', mode: 'queue', state: 'delivered', text: 'also check the schema', at: START }],
      progress: { activity: 'thinking' } }),
  }
  const { clock, seen } = setup(on, files, START + 125_000)

  await $.ui.render(row('a3', { description: 'Second opinion on schema' }))
  await clock.advance(1000)
  await $.ui.render(row('a3', { description: 'Second opinion on schema' }))
  expect(plain(seen.at(-1))).toBe('Second opinion on schema  claude · opus-5.5 · ◌ your message queued · 2:06')
  expect(seen.at(-1)).toContain('\x1b[33m◌ your message queued\x1b[39m')

  files[`${DIR}/results/j3.json`] = { executionId: 'j3', outcome: 'failed', finishedAt: START + 62_000 }
  await clock.advance(1000)
  await $.ui.render(row('a3', { description: 'Second opinion on schema' }))
  expect(seen.at(-1)).toBe('Second opinion on schema  claude · \x1b[31m✗ failed after 1:02\x1b[39m')
})

test("another subagent's row is left to the engine and reads nothing", async ($, on) => {
  const { clock, fs, seen } = setup(on, {})

  await $.ui.render(row('e1', { type: 'Explore', description: 'find the retry code' }))
  await clock.advance(5000)

  expect(seen).toEqual([undefined])
  expect(fs.reads).toBe(0)
})

test('a companion subagent with no job yet keeps the engine row and looks only for its conversation', async ($, on) => {
  const { clock, fs, seen } = setup(on, {})

  await $.ui.render(row('a4'))
  await clock.advance(1000)
  await $.ui.render(row('a4'))

  expect(seen).toEqual([undefined, undefined])
  expect(fs.reads).toBe(1)
})

test("the body is cut to the row's columns", async ($, on) => {
  const files: Record<string, unknown> = {
    [`${DIR}/conversations/a5.json`]: { owner: 'a5', executionId: 'j5' },
    [`${DIR}/executions/j5.json`]: execution('j5', { progress: { activeCommand: 'npm test -- --reporter spec' }, effectiveModel: 'gpt-6-astra' }),
  }
  const { clock, seen } = setup(on, files)

  await $.ui.render(row('a5', { columns: 40 }))
  await clock.advance(1000)
  await $.ui.render(row('a5', { columns: 40 }))

  const shown = plain(seen.at(-1))!
  expect(shown).toBe('Step 3b-2: a…  codex · gpt-6-astra · ru…')
  expect([...shown].length).toBeLessThanOrEqual(40)
})
