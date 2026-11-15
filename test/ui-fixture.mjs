// Shared by the live view's headless and performance tests: both hosts' state
// directories with running, finished, failed and older jobs, the companions'
// transcripts and the callers' own records, all under one temp dir. The model
// reads only these paths: its env points HOME, CLAUDE_CONFIG_DIR and CODEX_HOME here.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createJobSource } from '../bridge-server/ui/jobs.mjs';
import { Model } from '../bridge-server/ui/model.mjs';

export const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const S = 1000, M = 60 * S;
const json = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
const jsonl = records => records.map(r => JSON.stringify(r) + '\n').join('');
export const codexItem = (turn, item, at = '2026-11-15T11:56:00.000Z') =>
  ({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', turn_id: turn, item } });

export function uiFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ui-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, CLAUDE_CONFIG_DIR: join(root, '.claude'), CODEX_HOME: join(root, '.codex') };
  const claude = join(root, 'state/claude'), codex = join(root, 'state/codex');
  const repo = join(root, 'work/agent-companion'), web = join(root, 'work/oikos-web');
  json(join(repo, '.git/HEAD'), 'ref: refs/heads/main\n');
  json(join(web, '.git/HEAD'), 'ref: refs/heads/auth-guard\n');

  // Callers: Claude lead sessions name their subagents; Codex names the task.
  json(join(env.CLAUDE_CONFIG_DIR, 'projects/-work/lead-1.jsonl'), jsonl([
    { type: 'ai-title', aiTitle: 'Generated' }, { type: 'custom-title', customTitle: 'Live view plan' },
    { toolUseResult: { status: 'async_launched', agentId: 'agent-run', description: 'Step 1b-2: digest on demand' } },
    { toolUseResult: { status: 'async_launched', agentId: 'agent-op', description: 'Restore spec triage' } },
    { toolUseResult: { status: 'async_launched', agentId: 'agent-old', description: 'Antigravity scenario' } }]));
  json(join(env.CLAUDE_CONFIG_DIR, 'projects/-web/lead-2.jsonl'), jsonl([
    { type: 'ai-title', aiTitle: 'Auth hardening' },
    { toolUseResult: { status: 'async_launched', agentId: 'agent-done', description: 'Review auth middleware' } }]));
  json(join(env.CODEX_HOME, 'sessions/2026/11/15/rollout-2026-11-15T10-58-00-thread-child.jsonl'), jsonl([
    { type: 'session_meta', payload: { id: 'thread-child', parent_thread_id: 'root-1', agent_path: '/root/rate_limit_probe', agent_nickname: 'Popper' } }]));
  json(join(env.CODEX_HOME, 'session_index.jsonl'), jsonl([{ id: 'root-1', thread_name: 'Release checks' }]));

  // Running Codex job, as in the mockup, from a bridge that takes messages;
  // turn-1 is an earlier job's turn. The running OpenCode job's record comes
  // from an older bridge: no interventionModes.
  const running = join(root, 'transcripts/rollout-run.jsonl');
  const output = n => Array.from({ length: n }, (_, i) => `lib/file-${i}.mjs:${i + 1}  const DIGEST_${i} = …`).join('\n');
  json(running, jsonl([
    { timestamp: '2026-11-15T11:55:00.000Z', type: 'session_meta', payload: { id: 'thread-run', cli_version: '0.169.0', base_instructions: { text: 'You are Codex.\nFollow the repository instructions.' } } },
    codexItem('turn-1', { type: 'UserMessage', id: 'old', content: [{ type: 'text', text: 'An earlier job' }] }),
    codexItem('turn-2', { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: ['Step 1b-2 of the live-view plan: render agent-digest on demand from the native transcript.', ...Array.from({ length: 44 }, (_, i) => `Requirement ${i + 1}.`)].join('\n') }] }),
    codexItem('turn-2', { type: 'Reasoning', id: 'r', summary_text: ['Inspecting where the digest is written today and who reads it.'] }),
    codexItem('turn-2', { type: 'CommandExecution', id: 'c1', command: ['/bin/zsh', '-lc', 'rg -n "digest" bridge-server lib'], cwd: repo, status: 'completed', exit_code: 0, aggregated_output: output(23) }),
    codexItem('turn-2', { type: 'FileChange', id: 'f', status: 'completed', changes: { [join(repo, 'lib/digest.mjs')]: { type: 'add' }, [join(repo, 'bridge-server/server.mjs')]: { type: 'update' } } }),
    codexItem('turn-2', { type: 'CommandExecution', id: 'c2', command: ['/bin/zsh', '-lc', 'node --test lib/digest.test.mjs'], cwd: repo, status: 'failed', exit_code: 1,
      aggregated_output: ['✖ on-demand digest renders the running native turn', ...Array.from({ length: 9 }, (_, i) => `  at frame ${i}`), '\x1b[31mtests 1 failed\x1b[0m'].join('\n') }),
    codexItem('turn-2', { type: 'AgentMessage', id: 'a', content: [{ type: 'text', text: 'One test fails on the running case; fixing the renderer now.' }] }),
  ]));

  // Finished Claude Code job with a work summary.
  const done = join(root, 'transcripts/claude-done.jsonl');
  const answer = ['The middleware skipped the CSRF check on GET routes that mutate', 'state. I added a guard and tests; one unrelated date-helper test', 'still fails.',
    '', 'Changes:', '- src/auth.ts: reject mutating GET routes without a token', '- src/auth.test.ts: cover the guard', '', 'Checks: npm test fails only in date.test.ts.'].join('\n');
  const c = { sessionId: 'sess-done', version: '2.1.325', cwd: web };
  json(done, jsonl([
    { ...c, type: 'user', uuid: 'u1', message: { role: 'user', content: 'Review the auth middleware for CSRF gaps and fix what you find.' } },
    { ...c, type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'Reading the middleware first.' }, { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'rg -n csrf src' } }] } },
    { ...c, type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: false, content: 'src/auth.ts:12: csrf' }] } },
    { ...c, type: 'assistant', uuid: 'a2', message: { id: 'm2', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: join(web, 'src/auth.ts') } }] } },
    { ...c, type: 'user', uuid: 'r2', toolUseResult: { filePath: join(web, 'src/auth.ts'), type: 'update' }, message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } },
    { ...c, type: 'assistant', uuid: 'a3', message: { id: 'm3', content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'npm test' } }] } },
    { ...c, type: 'user', uuid: 'r3', message: { content: [{ type: 'tool_result', tool_use_id: 'b2', is_error: true, content: 'Exit code 1\nFAIL src/date.test.ts\n  expected 2026-11-15' }] } },
    { ...c, type: 'assistant', uuid: 'a4', message: { id: 'm4', content: [{ type: 'text', text: answer }] } },
  ]));

  // Failed Copilot job: the captured 429 failure.
  const failed = join(root, 'transcripts/copilot-events.jsonl');
  json(failed, readFileSync(new URL('./fixtures/transcripts/copilot/failure.jsonl', import.meta.url), 'utf8'));
  const rateLimit = 'Failed to get response from the AI model; retried 5 times (total retry wait time: 5.00 seconds) Last error: 429 FIXTURE overloaded: HTTP 429';

  const locator = (companion, path, sessionId) => ({ companion, kind: 'jsonl', path, sessionId });
  const execution = fields => ({ generation: 1, state: 'closed', writer: 'controller', ...fields });
  const records = {
    [claude]: [
      [execution({ executionId: 'run-1', owner: 'agent-run', hostSessionId: 'lead-1', provider: 'codex', cwd: repo, text: 'Step 1b-2 of the live-view plan',
        startedAt: NOW - 4 * M - 12 * S, state: 'running', processes: { pid: 4242 }, historyId: 'thread-run', nativeTurnId: 'turn-2',
        effectiveModel: 'gpt-6-astra', effectiveEffort: 'high', transcript: locator('codex', running, 'thread-run'),
        interventionModes: { default: 'steer', steer: true, queue: 'bridge', interrupt: true }, interventions: [], turns: [], nativeTurnIds: ['turn-2'],
        progress: { activeCommand: 'node --test lib/digest.test.mjs', partialText: '', lastActivityAt: NOW - 18 * S } })],
      [execution({ executionId: 'op-1', owner: 'agent-op', hostSessionId: 'lead-1', provider: 'opencode', cwd: join(root, 'work/hermes'), text: 'Triage the restore spec',
        startedAt: NOW - 41 * S, state: 'running', processes: { pid: 4343 }, effectiveModel: { providerID: 'opencode', id: 'flint-40b-free', variant: 'default' },
        transcript: null, progress: { partialText: 'Reading the restore spec', lastActivityAt: NOW - 2 * S } })],
      [execution({ executionId: 'done-1', owner: 'agent-done', hostSessionId: 'lead-2', provider: 'claude', cwd: web, text: 'Review the auth middleware for CSRF gaps and fix what you find.',
        startedAt: NOW - 12 * M - 362 * S, historyId: 'sess-done', nativeTurnId: 'u1', transcript: locator('claude', done, 'sess-done') }),
      { outcome: 'completed', cause: 'native_complete', finishedAt: NOW - 12 * M, text: answer, usage: { source: 'claude-result', total_tokens: 412_000 },
        effectiveModel: 'opus-5.5', effectiveEffort: 'xhigh', workSummary: {
          transcript: { companion: 'claude', path: done, version: '2.1.325', recognized: true, unrecognized: 0 },
          commands: [{ command: 'rg -n csrf src', exitCode: 0, status: 'completed' }, { command: 'npm test', exitCode: 1, status: 'failed' }, { command: 'npm run lint', exitCode: 0, status: 'completed' }],
          commandsOmitted: 0, edits: [{ path: join(web, 'src/auth.ts'), change: 'update' }], editsOmitted: 0, errors: [], errorsOmitted: 0,
          worktree: { available: true, files: [{ path: 'src/auth.ts', added: 18, deleted: 6 }, { path: 'src/auth.test.ts', added: 40, deleted: 0 }], filesOmitted: 0 } } }],
      [execution({ executionId: 'old-1', owner: 'agent-old', hostSessionId: 'lead-1', provider: 'antigravity', cwd: join(root, 'work/notes-app'), text: 'Scenario', startedAt: NOW - 2 * 24 * 60 * M }),
        { outcome: 'completed', finishedAt: NOW - 2 * 24 * 60 * M + M, text: 'ok' }],
    ],
    [codex]: [
      [execution({ executionId: 'fail-1', owner: 'thread-child', hostSessionId: 'root-1', provider: 'copilot', cwd: join(root, 'work/scratch'), text: 'Reply with the word FAILURE.',
        startedAt: NOW - 61 * M - 10 * S, historyId: '2bd1aa29-799a-478e-beb6-0108984d8d63', effectiveModel: 'fixture-mock',
        transcript: locator('copilot', failed, '2bd1aa29-799a-478e-beb6-0108984d8d63') }),
      { outcome: 'failed', cause: 'provider_error', detail: 'rate_limit', finishedAt: NOW - 61 * M, text: rateLimit, workSummary: {
        transcript: { companion: 'copilot', path: failed, version: { version: 1 }, recognized: true, unrecognized: 0 },
        commands: [], commandsOmitted: 0, edits: [], editsOmitted: 0, errors: [{ type: 'rate_limit', message: rateLimit }], errorsOmitted: 0,
        worktree: { available: false, reason: 'not_a_git_repository', files: [], filesOmitted: 0 } } }],
    ],
  };
  for (const [dir, jobs] of Object.entries(records)) for (const [record, result] of jobs) {
    json(join(dir, 'executions', `${record.executionId}.json`), { ...record, owner: record.owner });
    if (result) json(join(dir, 'results', `${record.executionId}.json`), { owner: record.owner, executionId: record.executionId, generation: 1, ...result });
  }
  const dirs = [{ host: 'claude', dir: claude }, { host: 'codex', dir: codex }];
  return {
    root, env, running, NOW, states: { claude, codex },
    model: ({ size = { columns: 150, rows: 26 }, now = () => NOW } = {}) =>
      new Model({ env, source: createJobSource({ dirs, env, alive: () => true }), now, size }),
    append: records => appendFileSync(running, jsonl(records)),
    setExecution: (id, change) => {
      const path = join(claude, 'executions', `${id}.json`);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      json(path, { ...record, ...change(record) });
    },
  };
}
