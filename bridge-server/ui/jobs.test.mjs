import '../../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchOf, createCallers, createJobSource } from './jobs.mjs';

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ui-jobs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}
const lines = records => records.map(r => JSON.stringify(r) + '\n').join('');

test('jobs from both hosts: running first, then by finish time; an active record whose process is gone is unknown', t => {
  const dir = temp(t);
  const claude = join(dir, 'claude'), codex = join(dir, 'codex');
  const execution = (id, fields) => ({ executionId: id, owner: `o-${id}`, provider: 'codex', cwd: '/work/app', text: 'task', startedAt: 1000, state: 'closed', ...fields });
  write(join(claude, 'executions/a.json'), execution('a', { startedAt: 100 }));
  write(join(claude, 'results/a.json'), { outcome: 'completed', finishedAt: 500 });
  write(join(claude, 'executions/b.json'), execution('b', { state: 'running', processes: { pid: 11 }, startedAt: 50 }));
  write(join(codex, 'executions/c.json'), execution('c', { startedAt: 200 }));
  write(join(codex, 'results/c.json'), { outcome: 'failed', finishedAt: 900 });
  write(join(codex, 'executions/d.json'), execution('d', { state: 'running', processes: { pid: 22 }, startedAt: 300 }));
  write(join(codex, 'executions/.agent-x.tmp'), '{');
  write(join(codex, 'executions/broken.json'), '{');
  const source = createJobSource({ dirs: [{ host: 'claude', dir: claude }, { host: 'codex', dir: codex }], alive: pid => pid === 11 });
  const jobs = source.list();
  assert.deepEqual(jobs.map(j => [j.key, j.status]), [['claude:b', 'running'], ['codex:c', 'failed'], ['claude:a', 'completed'], ['codex:d', 'unknown']]);
  assert.equal(jobs[0].project, 'app');
  assert.deepEqual(jobs.map(j => j.dir), [claude, codex, claude, codex], 'each job names its host state dir, where its inbox lives');
  // A result appearing later is picked up; the cached execution is reused.
  write(join(claude, 'results/b.json'), { outcome: 'stopped', finishedAt: 1000 });
  assert.equal(source.list().find(j => j.key === 'claude:b').status, 'stopped');
});

test('claude caller: subagent description and session title from the lead transcript, read incrementally', t => {
  const dir = temp(t);
  const lead = join(dir, '.claude/projects/-work-app/lead-1.jsonl');
  write(lead, lines([
    { type: 'ai-title', aiTitle: 'Generated title', sessionId: 'lead-1' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'agentId: child-1' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'child-1', description: 'Review auth middleware', prompt: 'long prompt' } },
  ]));
  const caller = createCallers({ HOME: dir });
  const job = owner => ({ host: 'claude', execution: { owner, hostSessionId: 'lead-1', text: '\n  First task line\nmore' } });
  assert.deepEqual(caller(job('child-1')), { title: 'Review auth middleware', fromCaller: true, lead: 'Generated title' });
  assert.deepEqual(caller(job('child-2')), { title: 'First task line', fromCaller: false, lead: 'Generated title' });
  // A partial line is left for the next read; a title the person set wins.
  appendFileSync(lead, lines([{ type: 'custom-title', customTitle: 'auth-hardening' }, { type: 'ai-title', aiTitle: 'Later generated' }])
    + JSON.stringify({ toolUseResult: { agentId: 'child-2', description: 'Second job' } }).slice(0, 20));
  assert.deepEqual(caller(job('child-2')), { title: 'First task line', fromCaller: false, lead: 'auth-hardening' });
  appendFileSync(lead, JSON.stringify({ toolUseResult: { agentId: 'child-2', description: 'Second job' } }).slice(20) + '\n');
  assert.equal(caller(job('child-2')).title, 'Second job');
  // A line longer than one read chunk (a pasted image) does not hide what follows.
  appendFileSync(lead, lines([{ type: 'user', message: { content: 'x'.repeat(5 * 1024 * 1024) } },
    { toolUseResult: { agentId: 'child-3', description: 'After the image' } }]));
  assert.equal(caller(job('child-3')).title, 'After the image');
  assert.deepEqual(caller({ host: 'claude', execution: { owner: 'x', hostSessionId: 'missing', text: 'Task' } }), { title: 'Task', fromCaller: false, lead: null });
});

test('codex caller: task name from the subagent rollout, lead name from the session index', t => {
  const dir = temp(t);
  const codexHome = join(dir, 'codex-home');
  write(join(codexHome, 'sessions/2026/11/13/rollout-2026-11-13T22-22-55-child-thread.jsonl'), lines([
    { type: 'session_meta', payload: { id: 'child-thread', parent_thread_id: 'parent-thread', agent_path: '/root/password_fix', agent_nickname: 'Aristotle',
      base_instructions: { text: 'x'.repeat(200_000) }, source: { subagent: { thread_spawn: { parent_thread_id: 'parent-thread', agent_path: '/root/password_fix' } } } } },
  ]));
  const index = join(codexHome, 'session_index.jsonl');
  write(index, lines([{ id: 'parent-thread', thread_name: 'Old name' }, { id: 'parent-thread', thread_name: 'Verify signatures' }]));
  const caller = createCallers({ HOME: dir, CODEX_HOME: codexHome });
  const job = { host: 'codex', execution: { owner: 'child-thread', hostSessionId: 'root', text: 'Fix the password handling' } };
  assert.deepEqual(caller(job), { title: 'password fix', fromCaller: true, lead: 'Verify signatures' });
  appendFileSync(index, lines([{ id: 'parent-thread', thread_name: 'Renamed' }]));
  assert.equal(caller(job).lead, 'Renamed');
  assert.deepEqual(caller({ host: 'codex', execution: { owner: 'unknown-thread', text: 'Fallback line' } }), { title: 'Fallback line', fromCaller: false, lead: null });
});

test('branch comes from the worktree .git without running git', t => {
  const dir = temp(t);
  write(join(dir, 'repo/.git/HEAD'), 'ref: refs/heads/feat/live-tui\n');
  mkdirSync(join(dir, 'repo/src'), { recursive: true });
  assert.equal(branchOf(join(dir, 'repo/src')), 'feat/live-tui');
  write(join(dir, 'gitdirs/wt/HEAD'), '0123456789abcdef\n');
  write(join(dir, 'wt/.git'), `gitdir: ${join(dir, 'gitdirs/wt')}\n`);
  assert.equal(branchOf(join(dir, 'wt')), '0123456');
  assert.equal(branchOf(join(dir, 'nowhere')), null);
});
