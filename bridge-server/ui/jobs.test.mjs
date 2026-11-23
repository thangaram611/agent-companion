import '../../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { branchOf, createCallers, createJobSource, sessionJobs } from './jobs.mjs';
import { uiFixture } from '../../test/ui-fixture.mjs';

const LAUNCH = fileURLToPath(new URL('../../hooks/launch-ui.sh', import.meta.url));

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
  const record = (id, fields) => ({ jobId: id, thread: `o-${id}`, companion: 'codex', cwd: '/work/app', text: 'task', startedAt: 1000, state: 'closed', ...fields });
  write(join(claude, 'jobs/a.json'), record('a', { startedAt: 100 }));
  write(join(claude, 'results/a.json'), { outcome: 'completed', finishedAt: 500 });
  write(join(claude, 'jobs/b.json'), record('b', { state: 'running', processes: { pid: 11 }, startedAt: 50 }));
  write(join(codex, 'jobs/c.json'), record('c', { startedAt: 200 }));
  write(join(codex, 'results/c.json'), { outcome: 'failed', finishedAt: 900 });
  write(join(codex, 'jobs/d.json'), record('d', { state: 'running', processes: { pid: 22 }, startedAt: 300 }));
  write(join(codex, 'jobs/.agent-x.tmp'), '{');
  write(join(codex, 'jobs/broken.json'), '{');
  const source = createJobSource({ dirs: [{ host: 'claude', dir: claude }, { host: 'codex', dir: codex }], alive: pid => pid === 11 });
  const jobs = source.list();
  assert.deepEqual(jobs.map(j => [j.key, j.status]), [['claude:b', 'running'], ['codex:c', 'failed'], ['claude:a', 'completed'], ['codex:d', 'unknown']]);
  assert.equal(jobs[0].project, 'app');
  assert.deepEqual(jobs.map(j => j.dir), [claude, codex, claude, codex], 'each job names its host state dir, where its inbox lives');
  // A result appearing later is picked up; the cached record is reused.
  write(join(claude, 'results/b.json'), { outcome: 'stopped', finishedAt: 1000 });
  assert.equal(source.list().find(j => j.key === 'claude:b').status, 'stopped');
});

test("callers: the thread's title, else the task's first line, and the lead session's name from its host", t => {
  const dir = temp(t);
  const lead = join(dir, '.claude/projects/-work-app/lead-1.jsonl');
  write(lead, lines([{ type: 'ai-title', aiTitle: 'Generated title', sessionId: 'lead-1' }]));
  const codexHome = join(dir, 'codex-home'), index = join(codexHome, 'session_index.jsonl');
  write(index, lines([{ id: 'root-1', thread_name: 'Old name' }, { id: 'root-1', thread_name: 'Verify signatures' }]));
  const caller = createCallers({ HOME: dir, CODEX_HOME: codexHome });
  const job = (host, session, title) => ({ host, threadRecord: { title, lead: { host, session, agent: null } }, record: { thread: 'th-1', text: '\n  First task line\nmore' } });
  assert.deepEqual(caller(job('claude', 'lead-1', 'Review auth middleware')), { title: 'Review auth middleware', lead: 'Generated title' });
  assert.deepEqual(caller(job('claude', 'lead-1')), { title: 'First task line', lead: 'Generated title' });
  // Read incrementally: a partial line waits for the next read; a title the person set wins.
  appendFileSync(lead, lines([{ type: 'ai-title', aiTitle: 'Later generated' }]) + JSON.stringify({ type: 'custom-title', customTitle: 'auth-hardening' }).slice(0, 20));
  assert.equal(caller(job('claude', 'lead-1')).lead, 'Later generated');
  appendFileSync(lead, JSON.stringify({ type: 'custom-title', customTitle: 'auth-hardening' }).slice(20) + '\n');
  assert.equal(caller(job('claude', 'lead-1')).lead, 'auth-hardening');
  // A line longer than one read chunk (a pasted image) does not hide what follows.
  appendFileSync(lead, lines([{ type: 'user', message: { content: 'x'.repeat(5 * 1024 * 1024) } }, { type: 'custom-title', customTitle: 'After the image' }]));
  assert.equal(caller(job('claude', 'lead-1')).lead, 'After the image');
  assert.deepEqual(caller(job('codex', 'root-1', 'password fix')), { title: 'password fix', lead: 'Verify signatures' });
  appendFileSync(index, lines([{ id: 'root-1', thread_name: 'Renamed' }]));
  assert.equal(caller(job('codex', 'root-1')).lead, 'Renamed');
  // A job from before threads has no thread record: its first line, and its bridge's host session.
  assert.deepEqual(caller({ host: 'claude', record: { thread: 'x', hostSessionId: 'missing', text: 'Task' } }), { title: 'Task', lead: null });
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

test("one Claude session's threads for the pane: each thread's newest job, running first, capped, and the ids of the rest", t => {
  const f = uiFixture(t);
  // A follow-up's earlier job on the same thread, days before.
  write(join(f.states.claude, 'jobs/old-0.json'), { jobId: 'old-0', thread: 'th-old', hostSessionId: 'lead-1', companion: 'codex',
    cwd: f.root, text: 'Earlier scenario', startedAt: f.NOW - 3 * 86_400_000, state: 'closed' });
  write(join(f.states.claude, 'results/old-0.json'), { jobId: 'old-0', outcome: 'completed', finishedAt: f.NOW - 3 * 86_400_000 + 1000 });
  const jobs = (sessionId, limit = 9) => sessionJobs({ dir: f.states.claude, sessionId, limit, env: f.env, alive: () => true });

  const all = jobs('lead-1');
  assert.deepEqual(all.jobs.map(job => [job.record.jobId, job.thread, job.status, job.title]), [
    ['op-1', 'th-op', 'running', 'Restore spec triage'],
    ['run-1', 'th-run', 'running', 'Step 1b-2: digest on demand'],
    ['old-1', 'th-old', 'completed', 'Antigravity scenario']]);
  assert.equal(all.jobs[2].result.outcome, 'completed');
  assert.equal(all.jobs[0].result, null);
  assert.deepEqual(all.older, ['old-0'], "the thread's earlier job is an older one");
  assert.deepEqual(jobs('lead-1', 2).jobs.map(job => job.record.jobId), ['op-1', 'run-1']);
  assert.deepEqual(jobs('lead-1', 2).older, ['old-1', 'old-0']);
  // Another session's threads, one before a /clear included, are never listed.
  assert.deepEqual(jobs('lead-2').jobs.map(job => job.record.jobId), ['done-1']);
  assert.deepEqual(jobs('nobody'), { jobs: [], older: [] });
});

test('through launch-ui.sh: jobs prints one JSON line without the UI packages and refuses bad arguments', t => {
  const f = uiFixture(t);
  const run = args => spawnSync('/bin/bash', [LAUNCH, 'jobs', ...args], { env: { PATH: process.env.PATH, ...f.env }, encoding: 'utf8', timeout: 20_000 });
  const ok = run([f.states.claude, 'lead-2', '9']);
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.split('\n');
  assert.deepEqual(lines.slice(1), ['']);
  const out = JSON.parse(lines[0]);
  assert.deepEqual(out.jobs.map(job => [job.thread, job.title, job.status]), [['th-done', 'Review auth middleware', 'completed']]);
  assert.deepEqual(out.older, []);
  for (const bad of [['relative', 'lead-2', '9'], [f.states.claude, 'lead-2'], [f.states.claude, 'lead-2', '0'], [f.states.claude, 'lead-2', '9', 'x']]) {
    const refused = run(bad);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /^usage: agent-companion jobs <state dir> <session id> <limit>/);
  }
});
