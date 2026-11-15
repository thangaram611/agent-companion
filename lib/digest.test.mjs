import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDigest } from './digest.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'digest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'rollout-x-thread.jsonl');
  const item = (item) => ({ timestamp: '2026-11-15T00:00:01.000Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item } });
  writeFileSync(path, [
    { timestamp: '2026-11-15T00:00:00.000Z', type: 'session_meta', payload: { id: 'thread', cli_version: '0.169.0' } },
    item({ type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'task' }] }),
    item({ type: 'CommandExecution', id: 'c', command: ['/bin/zsh', '-lc', 'ls missing'], cwd: '/tmp/work', status: 'failed', exit_code: 1, aggregated_output: 'ls: missing: No such file' }),
    item({ type: 'FileChange', id: 'f', changes: { '/tmp/work/notes.txt': { type: 'add', content: 'alpha\n' } }, status: 'completed' }),
  ].map(JSON.stringify).join('\n') + '\n');
  return path;
}

test('the digest shows models, commands and edits as readable text, not raw objects', t => {
  const path = fixture(t);
  const model = { source: 'selected', providerID: 'opencode', id: 'flint-40b-free', variant: 'default' };
  const execution = { executionId: 'e1', provider: 'codex', historyId: 'thread', nativeTurnId: 'turn-1', startedAt: 0, text: 'task',
    state: 'closed', transcript: { companion: 'codex', kind: 'jsonl', path, sessionId: 'thread' }, effectiveModel: model };
  const result = { outcome: 'completed', text: 'answer', finishedAt: 1, effectiveModel: model };
  const md = renderDigest(execution, result, {});
  assert.match(md, /effective opencode\/flint-40b-free/);
  assert.doesNotMatch(md, /\[object Object\]/);
  const command = md.split('### command:')[1].split('###')[0];
  assert.match(command, /cwd: \/tmp\/work/);
  assert.match(command, /ls: missing: No such file/);
  assert.doesNotMatch(command, /"exitCode"|"output"/, 'the title already carries the command and exit code');
  const edit = md.split('### edit')[1];
  assert.match(edit, /add \/tmp\/work\/notes\.txt/);
});

test('digest selects all turns of an intervened job and excludes other session turns', t => {
  const path = fixture(t);
  for (const turn of ['turn-2', 'another-job']) appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: {
    type: 'item_completed', turn_id: turn, item: { type: 'CommandExecution', id: turn, command: [turn], status: 'completed', exit_code: 0 },
  } }) + '\n');
  const execution = { executionId: 'e', provider: 'codex', historyId: 'thread', nativeTurnId: 'turn-1', nativeTurnIds: ['turn-1', 'turn-2'],
    startedAt: 0, text: 'task', transcript: { companion: 'codex', kind: 'jsonl', path, sessionId: 'thread' } };
  const md = renderDigest(execution, { outcome: 'completed', text: 'two answers', finishedAt: 1 }, {});
  assert.match(md, /Commands: 2/); assert.match(md, /### command: turn-2/); assert.doesNotMatch(md, /another-job/);
});
