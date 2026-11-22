import '../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readTranscript } from './transcripts.mjs';
import { selectTurnItems, summarizeWork } from './work-summary.mjs';
const root = new URL('../test/fixtures/transcripts/', import.meta.url);
const unavailable = { available: false, reason: 'not_git_worktree' };
function fixture(t, companion) {
  const dir = mkdtempSync(join(tmpdir(), 'summary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'transcript');
  if (companion === 'opencode') {
    const db = new DatabaseSync(path);
    db.exec(readFileSync(new URL('opencode/opencode.sql', root), 'utf8')); db.close();
  } else {
    const folder = new URL(`${companion}/`, root);
    writeFileSync(path, readdirSync(folder).filter(n => n.startsWith(companion === 'copilot' ? 'failure' : 'transcript')).sort().map(n => readFileSync(new URL(n, folder), 'utf8')).join(''));
  }
  return { companion, path, kind: companion === 'opencode' ? 'sqlite' : 'jsonl', sessionId: companion === 'opencode' ? 'ses_e229ce437ffeBST2EZW9xCg9Wa' : companion };
}
for (const companion of ['codex', 'claude', 'opencode', 'copilot']) test(`${companion}: fixture summary and turn isolation`, t => {
  const locator = fixture(t, companion), transcript = readTranscript(locator);
  const first = transcript.items.find(i => i.kind === 'user');
  const items = selectTurnItems(transcript.items, { companion, nativeTurnId: first.turnId });
  const summary = summarizeWork({ locator, transcript, items, worktree: unavailable });
  assert.equal(summary.transcript.recognized, true);
  if (companion === 'copilot') {
    assert.equal(summary.errors[0].type, 'rate_limit');
    assert.match(summary.errors[0].message, /429/);
  } else {
    for (const [command, code] of [['echo FIXTURE-OK', 0], ['ls /nonexistent-fixture-path', 1]]) assert.ok(summary.commands.some(c => (Array.isArray(c.command) ? c.command.includes(command) : c.command === command) && c.exitCode === code));
    assert.equal(summary.edits.filter(e => e.path.endsWith('notes.txt')).length, 1);
    assert.equal(summary.edits.find(e => e.path.endsWith('notes.txt')).change, 'add');
    assert.deepEqual(summary.errors, []);
    const next = transcript.items.find(i => i.kind === 'user' && /AGAIN/.test(i.text));
    assert.ok(next);
    const followup = summarizeWork({ locator, transcript, items: selectTurnItems(transcript.items, { companion, nativeTurnId: next.turnId }), worktree: unavailable });
    assert.deepEqual(followup.commands, []);
    assert.deepEqual(followup.edits, []);
    assert.deepEqual(selectTurnItems(transcript.items, { companion, nativeTurnId: null }), []);
  }
});
test('Antigravity selects by creation time, Copilot by session; summaries bound lists and text', () => {
  const items = [{ at: '2026-11-15T00:00:00Z' }, { at: '2026-11-15T00:00:01Z' }, { at: null }];
  assert.deepEqual(selectTurnItems(items, { companion: 'antigravity', startedAt: Date.parse('2026-11-15T00:00:01Z') }), [items[1]]);
  assert.deepEqual(selectTurnItems(items, { companion: 'copilot' }), items);
  const summary = summarizeWork({ items: Array.from({ length: 60 }, (_, i) => [
    { kind: 'command', command: 'x'.repeat(3000), exitCode: 0, status: 'completed' },
    { kind: 'edit', paths: [{ path: `${i}.txt`, change: 'add' }] },
    { kind: 'error', error: { type: 'test', message: 'x'.repeat(3000) } },
  ]).flat(), worktree: { available: true, files: Array.from({ length: 60 }, (_, i) => ({ path: `${i}` })) } });
  assert.equal(summary.commands.length, 20); assert.equal(summary.commandsOmitted, 40);
  assert.equal(summary.edits.length, 50); assert.equal(summary.editsOmitted, 10);
  assert.equal(summary.worktree.files.length, 50); assert.equal(summary.worktree.filesOmitted, 10);
  assert.ok(summary.errors.length <= 20); assert.ok(summary.errors[0].message.length <= 500);
  assert.ok(summary.commands[0].command.length <= 2000);
  assert.match(summary.worktree.note, /any writer/); assert.match(summary.worktree.note, /excludes ignored files/);
});

test('once a job has ended, items the native store still shows running are reported unfinished', () => {
  const items = [{ kind: 'command', command: 'sleep 30', status: 'running', exitCode: null }, { kind: 'command', command: 'echo ok', status: 'completed', exitCode: 0 }];
  assert.deepEqual(summarizeWork({ items, ended: true }).commands.map(c => c.status), ['unfinished', 'completed']);
  assert.deepEqual(summarizeWork({ items }).commands.map(c => c.status), ['running', 'completed']);
});

test('a refused command carries its refusal reason into the summary', () => {
  const items = [{ kind: 'command', command: 'echo no', status: 'failed', exitCode: null, denied: 'Denied by user (*).' }];
  assert.deepEqual(summarizeWork({ items, ended: true }).commands, [{ command: 'echo no', exitCode: null, status: 'failed', denied: 'Denied by user (*).' }]);
});

for (const companion of ['codex', 'claude']) test(`${companion}: selects every job turn once, excluding earlier session work`, () => {
  const items = ['earlier', 'first', 'joined', 'next'].map(turnId => ({ turnId, kind: 'command', command: turnId, exitCode: 0 }));
  const selected = selectTurnItems(items, { companion, nativeTurnId: 'first',
    nativeTurnIds: companion === 'claude' ? ['first', 'next'] : ['first', 'joined', 'next', 'first'], interventions: [{ id: 'joined' }] });
  assert.deepEqual(summarizeWork({ items: selected }).commands.map(c => c.command), ['first', 'joined', 'next']);
});

test('Antigravity selects the execution time window on a resumed trajectory, including its retry errors', t => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.db'), db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('../test/controller/antigravity.sql', import.meta.url), 'utf8')); t.after(() => db.close());
  const locator = { companion: 'antigravity', kind: 'sqlite', path, sessionId: 'native-history' };
  const transcript = readTranscript(locator);
  const items = selectTurnItems(transcript.items, { companion: 'antigravity', startedAt: 1800000013123, finishedAt: 1800000016123 });
  assert.deepEqual(items.map(i => i.kind), ['user', 'error', 'error', 'assistant']);
  assert.deepEqual(summarizeWork({ locator, transcript, items }).errors.map(e => e.type), ['UNAVAILABLE', 'UNAVAILABLE']);
  // An earlier execution ended on its second retry; a later prompt followed.
  db.exec('DELETE FROM steps WHERE idx IN (16,18)');
  const resumed = readTranscript(locator).items;
  const previous = selectTurnItems(resumed, { companion: 'antigravity', startedAt: 1800000013123, finishedAt: 1800000016123 });
  assert.equal(previous.at(-1).error.type, 'UNAVAILABLE');
  assert.equal(previous.at(-1).terminal, true);
  const bothTurns = selectTurnItems(resumed, { companion: 'antigravity', startedAt: 1800000013123 });
  assert.ok(bothTurns.every(i => !i.terminal), 'an earlier native turn cannot decide a multi-turn execution');
});
