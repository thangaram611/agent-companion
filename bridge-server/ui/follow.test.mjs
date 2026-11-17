import '../../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFollow } from './follow.mjs';
import { codexItem, uiFixture } from '../../test/ui-fixture.mjs';

const LAUNCH = fileURLToPath(new URL('../../hooks/launch-ui.sh', import.meta.url));
const follow = (f, executionId) => createFollow({ dir: f.states.claude, executionId, env: f.env, now: () => f.NOW, alive: () => true });
const lines = out => out.lines.map(line => JSON.parse(line));

test('a running job: its records with the branch, then its own turn with labels; nothing again until something changes', t => {
  const f = uiFixture(t), job = follow(f, 'run-1');
  const out = job.tick();
  assert.equal(out.ended, false);
  const [first, second, ...rest] = lines(out);
  assert.deepEqual(rest, []);
  assert.equal(first.job.status, 'running');
  assert.equal(first.job.branch, 'main');
  assert.equal(first.job.execution.executionId, 'run-1');
  assert.equal(first.job.result, null);
  // turn-1 is an earlier job's turn; the session's base instructions are preamble.
  assert.deepEqual(second.items.map(item => item.kind), ['user', 'reasoning', 'command', 'edit', 'command', 'assistant']);
  assert.deepEqual(second.turn, { ids: second.items.map(item => item.id), earlier: 0, labels: { [second.items[0].id]: 'task' }, taken: [],
    located: true, format: { version: '0.169.0', detail: 'native transcript' } });
  assert.deepEqual(job.tick(), { lines: [], ended: false });

  f.append([codexItem('turn-2', { type: 'AgentMessage', id: 'a2', content: [{ type: 'text', text: 'Fixed.' }] })]);
  const [next] = lines(job.tick());
  assert.equal(next.turn.ids.length, 7);
  assert.deepEqual(next.items.map(item => item.text), ['Fixed.'], 'only the new item is sent again');
});

test("a recorded message the transcript shows is taken and labelled by its sender; the record's change is sent", t => {
  const f = uiFixture(t), job = follow(f, 'run-1');
  job.tick();
  f.setExecution('run-1', () => ({ interventions: [
    { id: 'l0', from: 'caller', mode: 'steer', text: 'Lead steer.', at: f.NOW, state: 'joined' },
    { id: 'u1', from: 'user', mode: 'queue', text: 'Then the logout route.', at: f.NOW, state: 'accepted' }] }));
  f.append([codexItem('turn-2', { type: 'UserMessage', id: 'x1', content: [{ type: 'text', text: 'Lead steer.' }] })]);
  const [changed, turn] = lines(job.tick());
  assert.equal(changed.job.execution.interventions.length, 2);
  assert.deepEqual(turn.turn.taken, ['l0']);
  assert.equal(turn.turn.labels[turn.items[0].id], 'lead');
});

test('only the last 100 items travel, with the count before them', t => {
  const f = uiFixture(t);
  f.append(Array.from({ length: 120 }, (_, i) => codexItem('turn-2', { type: 'AgentMessage', id: `m${i}`, content: [{ type: 'text', text: `step ${i}` }] })));
  const [, { turn, items }] = lines(follow(f, 'run-1').tick());
  assert.equal(turn.ids.length, 100);
  assert.equal(turn.earlier, 26);
  assert.equal(items.at(-1).text, 'step 119');
  assert.deepEqual(turn.labels, {}, 'the task is before the tail');
});

test('a finished job is read once with its result, then the follow ends', t => {
  const f = uiFixture(t);
  const out = follow(f, 'done-1').tick();
  assert.equal(out.ended, true);
  const [{ job }, { turn, items }] = lines(out);
  assert.equal(job.status, 'completed');
  assert.equal(job.result.outcome, 'completed');
  assert.equal(job.branch, 'auth-guard');
  assert.equal(turn.located, true);
  assert.equal(items[0].kind, 'user');
  assert.equal(items.at(-1).kind, 'assistant');
});

test('a job whose transcript is not found yet says so, and a missing record is an error', t => {
  const f = uiFixture(t);
  const [, { turn, items }] = lines(follow(f, 'op-1').tick());
  assert.deepEqual(items, []);
  assert.equal(turn.located, false);
  assert.throws(() => follow(f, 'gone').tick(), /no execution record gone/);
  assert.throws(() => follow(f, '../x'), /invalid record id/);
});

test('through launch-ui.sh: follow needs no UI packages, prints JSON lines and exits after a finished job', t => {
  const f = uiFixture(t);
  const env = { PATH: process.env.PATH, ...f.env, AGENT_COMPANION_HOME: f.states.claude };
  const done = spawnSync('/bin/bash', [LAUNCH, 'follow', f.states.claude, 'done-1'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(done.status, 0, done.stderr);
  const out = done.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(out[0].job.result.outcome, 'completed');
  assert.ok(out[1].turn.ids.length > 0);

  const bad = spawnSync('/bin/bash', [LAUNCH, 'follow', 'relative', 'done-1'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage: agent-companion follow <state dir> <execution id>/);
  const gone = spawnSync('/bin/bash', [LAUNCH, 'follow', join(f.root, 'nowhere'), 'done-1'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /agent-companion follow: no execution record done-1/);
});
