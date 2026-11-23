import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupController, diskSnapshot } from '../test/controller/helpers.mjs';
import { listDigestResources, listDigestResourceTemplates, readDigestResource } from '../bridge-server/tools.mjs';
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
  const job = { jobId: 'e1', companion: 'codex', historyId: 'thread', nativeTurnId: 'turn-1', startedAt: 0, text: 'task',
    state: 'closed', transcript: { companion: 'codex', kind: 'jsonl', path, sessionId: 'thread' }, effectiveModel: model };
  const result = { outcome: 'completed', text: 'answer', finishedAt: 1, effectiveModel: model };
  const md = renderDigest(job, result, {});
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
  const job = { jobId: 'e', companion: 'codex', historyId: 'thread', nativeTurnId: 'turn-1', nativeTurnIds: ['turn-1', 'turn-2'],
    startedAt: 0, text: 'task', transcript: { companion: 'codex', kind: 'jsonl', path, sessionId: 'thread' } };
  const md = renderDigest(job, { outcome: 'completed', text: 'two answers', finishedAt: 1 }, {});
  assert.match(md, /Commands: 2/); assert.match(md, /### command: turn-2/); assert.doesNotMatch(md, /another-job/);
});

function nativeDigestFixture(h, id) {
  const path = join(h.dir, 'native.jsonl');
  const event = (type, fields = {}) => ({ type: 'event_msg', payload: { type, turn_id: 'turn-1', ...fields } });
  const item = (type, fields = {}) => event('item_completed', { item: { type, id: type, ...fields } });
  const rows = [
    { type: 'session_meta', payload: { id: 'native-history', cli_version: 'fixture', base_instructions: { text: 'hidden system instructions' } } },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'previous-turn', item: { type: 'AgentMessage', id: 'old', content: 'previous answer excluded' } } },
    event('task_started'),
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: 'hidden developer instructions' } },
    item('UserMessage', { content: 'Run checks' }),
    item('Reasoning', { summary_text: 'Check the tests first' }),
    item('CommandExecution', { command: 'npm test', exit_code: 2, aggregated_output: 'failure output ' + 'x'.repeat(4000) + 'OUTPUT_END' }),
    item('FileChange', { changes: { 'src/fix.mjs': { type: 'update', diff: '+fixed' } } }),
    item('McpToolCall', { tool: 'inspect', arguments: { path: 'src/fix.mjs' }, result: { content: 'tool output' } }),
    event('task_complete', { error: { message: 'native failure', codex_error_info: 'fixture_error' } }),
    item('AgentMessage', { content: 'native answer' }),
  ];
  writeFileSync(path, rows.map(JSON.stringify).join('\n') + '\n');
  const job = h.records.readJob(id);
  h.records._write('jobs', id, { ...job, nativeRefs: { ...job.nativeRefs, transcriptPath: path } });
  return path;
}

for (const terminal of [false, true]) {
  test(`on-demand digest renders the ${terminal ? 'terminal' : 'running'} native turn with summary and bounded items`, async t => {
    const h = setupController({ companion: 'codex' });
    const { jobId: id } = await h.send({ model: 'a', effort: 'high', text: 'Run checks' });
    h.adapters[0].progress({ partialText: 'partial answer', activeCommand: 'npm test' });
    if (terminal) {
      await h.finish(id, { outcome: 'completed', text: 'final answer', effectiveModel: 'resolved' });
      const result = h.records.readResult(id);
      h.records._write('results', id, { ...result, workSummary: { ...result.workSummary,
        commands: [{ command: 'npm test', exitCode: 2 }],
        edits: [{ path: 'src/fix.mjs', change: 'update' }],
        worktree: { available: true, files: [{ path: 'src/fix.mjs', added: 1, deleted: 1 }], note: 'Includes changes by any writer between turn start and end; excludes ignored files.' } } });
    }
    const path = nativeDigestFixture(h, id);
    const before = [diskSnapshot(h.dir), diskSnapshot(process.env.AGENT_RUNTIME_DIR)];
    const read = () => readDigestResource(`job-digest://${id}`, h.controller).contents[0].text;
    const rendered = read();
    for (const pattern of [/codex/i, /high/, /Run checks/, /native answer/, /## Work summary/, /Commands: 1/, /npm test.*exit 2/, /Preamble: 2 items collapsed/, /\[truncated/, /src\/fix.mjs/, /inspect/, /native failure/]) assert.match(rendered, pattern);
    assert.match(rendered, terminal ? /final answer/ : /partial answer/);
    assert.match(rendered, terminal ? /any writer/ : /In flight: running npm test/);
    assert.ok(rendered.includes(path));
    assert.doesNotMatch(rendered, /hidden system|hidden developer|previous answer excluded|OUTPUT_END/);
    const transcript = rendered.split('## Transcript')[1];
    assert.ok(transcript.indexOf('user') < transcript.indexOf('reasoning'));
    assert.ok(transcript.indexOf('reasoning') < transcript.indexOf('command'));
    assert.ok(transcript.indexOf('command') < transcript.indexOf('edit'));
    assert.ok(transcript.indexOf('edit') < transcript.indexOf('tool'));
    assert.ok(transcript.indexOf('tool') < transcript.indexOf('error'));
    const command = transcript.split('### command:')[1].split('### edit')[0];
    assert.ok(Buffer.byteLength(command) < 2300, 'command output is bounded near 2 KB');
    if (terminal) t.diagnostic('Rendered excerpt:\n' + rendered.slice(rendered.indexOf('## Final answer'), rendered.indexOf('Worktree diff-stat')) +
      '…\n' + transcript.match(/Preamble:.*\n/)[0] + transcript.match(/### command:.*\n/)[0]);
    assert.deepEqual([diskSnapshot(h.dir), diskSnapshot(process.env.AGENT_RUNTIME_DIR)], before);
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'AgentMessage', id: 'later', content: 'appended since last read' } } }) + '\n');
    assert.match(read(), /appended since last read/);
  });
}

test('digest lists job records without a digest directory and explains missing or unrecognized transcripts', async t => {
  const h = setupController({ companion: 'codex' });
  const e = h.records.begin({ thread: 'child', companion: 'codex', cwd: h.dir, text: 'task', jobId: 'record-only', now: Date.now() }, 0);
  assert.equal(existsSync(join(process.env.AGENT_RUNTIME_DIR, 'digests')), false);
  assert.deepEqual(listDigestResources(h.controller).map(r => r.uri), ['job-digest://record-only']);
  assert.equal(listDigestResourceTemplates()[0].uriTemplate, 'job-digest://{job_id}');
  assert.throws(() => readDigestResource('file:///invalid', h.controller), /unknown digest/);
  const read = () => readDigestResource('job-digest://record-only', h.controller).contents[0].text;
  assert.match(read(), /Transcript unavailable: transcript_not_found/);
  const path = nativeDigestFixture(h, e.jobId);
  appendFileSync(path, '{"type":"future.record"}\n');
  assert.match(read(), /Transcript format unrecognized/);
  rmSync(path);
  assert.match(read(), /Transcript unavailable/);
  assert.equal(existsSync(join(process.env.AGENT_RUNTIME_DIR, 'digests')), false);
});
